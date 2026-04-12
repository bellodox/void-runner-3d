"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, "utf8");
  for (const rawLine of envContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const RELAY_HOST = "127.0.0.1";
const RELAY_PORT = 8787;
const RPC_URL = "http://127.0.0.1:11999/";
const MAX_ENTRIES = 10;
const MAX_RETRIES = 3;
const MIN_HANDLE_LENGTH = 3;
const MAX_HANDLE_LENGTH = 24;
const MAX_SCORE_SECONDS = 86400;
const RPC_TIMEOUT_MS = 10000;
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 30;
const GAME_PREFIX = "g/voidrunner3d/";

const difficultyKeys = Object.freeze({
  easy: true,
  normal: true,
  hard: true
});

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  setCors(response);
  response.end(body);
}

async function callRpc(method, params) {
  const payload = {
    jsonrpc: "1.0",
    id: `relay-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method,
    params
  };

  const headers = { "Content-Type": "application/json" };
  const rpcUser = process.env.ROD_RPC_USER;
  const rpcPassword = process.env.ROD_RPC_PASSWORD;
  if (rpcUser || rpcPassword) {
    const credentials = Buffer.from(`${rpcUser || ""}:${rpcPassword || ""}`).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  }

  const rpcTimeoutController = new AbortController();
  const rpcTimeoutHandle = setTimeout(() => rpcTimeoutController.abort(), RPC_TIMEOUT_MS);

  let rpcResponse;
  try {
    rpcResponse = await fetch(RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: rpcTimeoutController.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(rpcTimeoutHandle);
  }

  if (!rpcResponse.ok) {
    throw new Error(`RPC HTTP ${rpcResponse.status}`);
  }

  const rpcBody = await rpcResponse.json();
  if (rpcBody.error) {
    const rpcError = new Error(rpcBody.error.message || "RPC error");
    rpcError.code = rpcBody.error.code;
    throw rpcError;
  }

  return rpcBody.result;
}

function sanitizeDifficulty(difficulty) {
  return Object.prototype.hasOwnProperty.call(difficultyKeys, difficulty) ? difficulty : null;
}

function sanitizeHandle(rawHandle) {
  if (typeof rawHandle !== "string") return null;
  const normalizedHandle = rawHandle.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  if (normalizedHandle.length < MIN_HANDLE_LENGTH || normalizedHandle.length > MAX_HANDLE_LENGTH) return null;
  return normalizedHandle;
}

function getIdentityNameForHandle(handle) {
  return `p/${handle}`;
}

function getRecordNameForHandle(handle) {
  return `${GAME_PREFIX}${handle}/record`;
}

function sanitizeScore(rawScore) {
  const parsedScore = Number(rawScore);
  if (!Number.isFinite(parsedScore)) return null;
  if (parsedScore < 0 || parsedScore > MAX_SCORE_SECONDS) return null;
  return Math.round(parsedScore * 1000) / 1000;
}

function parseRecordValue(value, expectedHandle) {
  if (typeof value !== "string" || value.length === 0) return null;

  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsedValue || typeof parsedValue !== "object") return null;
  const storedHandle = sanitizeHandle(parsedValue.handle);
  if (!storedHandle || storedHandle !== expectedHandle) return null;

  const scoresObject = parsedValue.scores && typeof parsedValue.scores === "object" ? parsedValue.scores : {};
  const normalizedScores = {};

  for (const difficulty of Object.keys(difficultyKeys)) {
    const rawScoreEntry = scoresObject[difficulty];
    if (!rawScoreEntry || typeof rawScoreEntry !== "object") {
      normalizedScores[difficulty] = null;
      continue;
    }

    const scoreValue = sanitizeScore(rawScoreEntry.score);
    if (scoreValue === null) {
      normalizedScores[difficulty] = null;
      continue;
    }

    const timestampValue = Number(rawScoreEntry.updatedAt) || 0;
    normalizedScores[difficulty] = {
      score: scoreValue,
      updatedAt: timestampValue
    };
  }

  return {
    handle: storedHandle,
    scores: normalizedScores
  };
}

function serializeRecordValue(handle, scoresByDifficulty) {
  const persistedScores = {};
  for (const difficulty of Object.keys(difficultyKeys)) {
    const scoreEntry = scoresByDifficulty[difficulty];
    if (!scoreEntry) continue;
    persistedScores[difficulty] = {
      score: scoreEntry.score,
      updatedAt: scoreEntry.updatedAt
    };
  }

  return JSON.stringify({
    version: 1,
    game: "voidrunner3d",
    handle,
    scores: persistedScores
  });
}

async function readName(name) {
  try {
    const result = await callRpc("name_show", [name]);
    return { exists: true, value: typeof result.value === "string" ? result.value : "" };
  } catch (error) {
    if (error && (error.code === -4 || error.code === -5 || error.code === -8)) {
      return { exists: false, value: "" };
    }
    throw error;
  }
}

async function ensureNameRegistered(name, fallbackValue) {
  const currentNameState = await readName(name);
  if (currentNameState.exists) return;
  try {
    await callRpc("name_register", [name, fallbackValue]);
  } catch (error) {
    const rpcMessage = String(error && error.message ? error.message : "").toLowerCase();
    const alreadyPending = rpcMessage.includes("pending registration") || rpcMessage.includes("already exists");
    if (!alreadyPending) throw error;
  }
}

async function registerPlayerHandle(handle) {
  const identityName = getIdentityNameForHandle(handle);
  const recordName = getRecordNameForHandle(handle);

  const initialRecord = {
    easy: null,
    normal: null,
    hard: null
  };

  const identityValue = JSON.stringify({
    version: 1,
    game: "voidrunner3d",
    handle,
    recordName
  });

  await ensureNameRegistered(identityName, identityValue);
  await ensureNameRegistered(recordName, serializeRecordValue(handle, initialRecord));

  return {
    handle,
    identityName,
    recordName
  };
}

async function readPlayerStatus(handle) {
  const identityName = getIdentityNameForHandle(handle);
  const recordName = getRecordNameForHandle(handle);
  const identityState = await readName(identityName);
  const recordState = await readName(recordName);
  const parsedRecord = recordState.exists ? parseRecordValue(recordState.value, handle) : null;

  return {
    handle,
    identityName,
    recordName,
    identityRegistered: identityState.exists,
    recordRegistered: recordState.exists,
    canSubmit: identityState.exists && recordState.exists,
    record: parsedRecord
  };
}

async function submitLeaderboardScore(handle, difficulty, score) {
  const recordName = getRecordNameForHandle(handle);

  for (let attemptNumber = 0; attemptNumber < MAX_RETRIES; attemptNumber++) {
    const currentState = await readName(recordName);
    if (!currentState.exists) {
      throw new Error("Player record is not registered. Register first.");
    }

    const parsedRecord = parseRecordValue(currentState.value, handle) || {
      handle,
      scores: { easy: null, normal: null, hard: null }
    };

    const nextScores = {
      easy: parsedRecord.scores.easy,
      normal: parsedRecord.scores.normal,
      hard: parsedRecord.scores.hard
    };

    const existingDifficultyScore = nextScores[difficulty];
    const nowTimestamp = Date.now();

    if (!existingDifficultyScore || score >= existingDifficultyScore.score) {
      nextScores[difficulty] = {
        score,
        updatedAt: nowTimestamp
      };
    }

    const serializedValue = serializeRecordValue(handle, nextScores);

    try {
      await callRpc("name_update", [recordName, serializedValue]);
    } catch (error) {
      const rpcMessage = String(error && error.message ? error.message : "").toLowerCase();
      const isPendingNameState = rpcMessage.includes("pending update");
      if (isPendingNameState) {
        return nextScores;
      }
      if (attemptNumber >= MAX_RETRIES - 1) {
        throw error;
      }
      continue;
    }

    try {
      const verifyState = await readName(recordName);
      if (verifyState.exists) {
        const verifyRecord = parseRecordValue(verifyState.value, handle);
        if (verifyRecord) return verifyRecord.scores;
      }
    } catch {
      // Ignore transient verification errors and rely on write success fallback.
    }

    // Name operations can remain pending before becoming visible via name_show.
    // If write RPC call succeeded, report success immediately using computed scores.
    return nextScores;
  }

  throw new Error("Failed to persist leaderboard score after retries");
}

async function scanRecordNamesByPrefix(prefix) {
  const matchedNames = [];
  let cursor = prefix;

  for (let pageIndex = 0; pageIndex < SCAN_MAX_PAGES; pageIndex++) {
    const pageResult = await callRpc("name_scan", [cursor, SCAN_PAGE_SIZE]);
    const rows = Array.isArray(pageResult) ? pageResult : [];
    if (!rows.length) break;

    let sawOutOfPrefix = false;
    for (const row of rows) {
      const name = typeof row?.name === "string" ? row.name : "";
      if (!name.startsWith(prefix)) {
        sawOutOfPrefix = true;
        continue;
      }
      matchedNames.push(row);
    }

    if (rows.length < SCAN_PAGE_SIZE || sawOutOfPrefix) break;
    const lastName = typeof rows[rows.length - 1]?.name === "string" ? rows[rows.length - 1].name : "";
    if (!lastName || lastName < cursor) break;
    cursor = `${lastName}\u0000`;
  }

  return matchedNames;
}

async function getLeaderboardEntriesForDifficulty(difficulty) {
  const scannedRows = await scanRecordNamesByPrefix(GAME_PREFIX);
  const candidateEntries = [];

  for (const row of scannedRows) {
    const onChainName = typeof row?.name === "string" ? row.name : "";
    const onChainValue = typeof row?.value === "string" ? row.value : "";
    if (!onChainName.endsWith("/record")) continue;

    const handleFromName = sanitizeHandle(onChainName.slice(GAME_PREFIX.length, -"/record".length));
    if (!handleFromName) continue;

    const parsedRecord = parseRecordValue(onChainValue, handleFromName);
    if (!parsedRecord) continue;

    const selectedDifficultyScore = parsedRecord.scores[difficulty];
    if (!selectedDifficultyScore) continue;

    candidateEntries.push({
      handle: handleFromName,
      score: selectedDifficultyScore.score,
      updatedAt: selectedDifficultyScore.updatedAt || 0
    });
  }

  candidateEntries.sort((leftEntry, rightEntry) => {
    if (rightEntry.score !== leftEntry.score) return rightEntry.score - leftEntry.score;
    return rightEntry.updatedAt - leftEntry.updatedAt;
  });

  return candidateEntries.slice(0, MAX_ENTRIES).map((entry, index) => ({
    rank: index + 1,
    handle: entry.handle,
    score: entry.score
  }));
}

function toApiPlayerStatus(status) {
  const scores = {};
  for (const difficulty of Object.keys(difficultyKeys)) {
    const scoreEntry = status.record?.scores?.[difficulty] || null;
    scores[difficulty] = scoreEntry
      ? {
          score: scoreEntry.score,
          updatedAt: scoreEntry.updatedAt
        }
      : null;
  }

  return {
    handle: status.handle,
    identityName: status.identityName,
    recordName: status.recordName,
    identityRegistered: status.identityRegistered,
    recordRegistered: status.recordRegistered,
    canSubmit: status.canSubmit,
    scores
  };
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 16 * 1024) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(rawBody));
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${RELAY_HOST}:${RELAY_PORT}`);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    setCors(response);
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      await callRpc("getblockcount", []);
      sendJson(response, 200, { ok: true, relay: "up", node: "up" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/leaderboard") {
      const difficulty = sanitizeDifficulty((requestUrl.searchParams.get("difficulty") || "").toLowerCase());
      if (!difficulty) {
        sendJson(response, 400, { ok: false, error: "Invalid difficulty" });
        return;
      }

      const entries = await getLeaderboardEntriesForDifficulty(difficulty);
      sendJson(response, 200, {
        ok: true,
        difficulty,
        entries
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/player/status") {
      const handle = sanitizeHandle(requestUrl.searchParams.get("handle") || "");
      if (!handle) {
        sendJson(response, 400, { ok: false, error: "Invalid handle" });
        return;
      }

      const playerStatus = await readPlayerStatus(handle);
      sendJson(response, 200, {
        ok: true,
        player: toApiPlayerStatus(playerStatus)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/player/register") {
      const rawBody = await readRequestBody(request);
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody || "{}");
      } catch {
        sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const handle = sanitizeHandle(parsedBody.handle);
      if (!handle) {
        sendJson(response, 400, { ok: false, error: "Invalid handle" });
        return;
      }

      const existingStatus = await readPlayerStatus(handle);
      if (existingStatus.identityRegistered || existingStatus.recordRegistered) {
        sendJson(response, 409, {
          ok: false,
          error: "Handle already registered",
          player: toApiPlayerStatus(existingStatus)
        });
        return;
      }

      await registerPlayerHandle(handle);
      const playerStatus = await readPlayerStatus(handle);
      sendJson(response, 200, {
        ok: true,
        player: toApiPlayerStatus(playerStatus)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/leaderboard/submit") {
      const rawBody = await readRequestBody(request);
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody || "{}");
      } catch {
        sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const difficulty = sanitizeDifficulty(String(parsedBody.difficulty || "").toLowerCase());
      const handle = sanitizeHandle(parsedBody.handle);
      const score = sanitizeScore(parsedBody.score);

      if (!difficulty || !handle || score === null) {
        sendJson(response, 400, { ok: false, error: "Invalid difficulty, handle, or score" });
        return;
      }

      const playerStatus = await readPlayerStatus(handle);
      if (!playerStatus.canSubmit) {
        sendJson(response, 409, { ok: false, error: "Player is not fully registered" });
        return;
      }

      await submitLeaderboardScore(handle, difficulty, score);
      const updatedEntries = await getLeaderboardEntriesForDifficulty(difficulty);
      sendJson(response, 200, {
        ok: true,
        difficulty,
        entries: updatedEntries,
        player: toApiPlayerStatus(await readPlayerStatus(handle))
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(response, 502, { ok: false, error: error.message || "Relay error" });
  }
});

server.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(`Void Runner relay listening on http://${RELAY_HOST}:${RELAY_PORT}`);
});
