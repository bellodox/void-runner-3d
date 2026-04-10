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
const MAX_NAME_LENGTH = 6;
const MAX_SCORE_SECONDS = 86400;
const RPC_TIMEOUT_MS = 10000;

const nameByDifficulty = Object.freeze({
  easy: "d/voidrunner3d/easy",
  normal: "d/voidrunner3d/normal",
  hard: "d/voidrunner3d/hard"
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
  return Object.prototype.hasOwnProperty.call(nameByDifficulty, difficulty) ? difficulty : null;
}

function sanitizePlayerName(rawName) {
  if (typeof rawName !== "string") return null;
  const normalizedName = rawName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, MAX_NAME_LENGTH);
  if (!normalizedName || normalizedName.length > MAX_NAME_LENGTH) return null;
  return normalizedName;
}

function sanitizeScore(rawScore) {
  const parsedScore = Number(rawScore);
  if (!Number.isFinite(parsedScore)) return null;
  if (parsedScore < 0 || parsedScore > MAX_SCORE_SECONDS) return null;
  return Math.round(parsedScore * 1000) / 1000;
}

function parseOnChainEntries(value) {
  if (typeof value !== "string" || value.length === 0) return [];

  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    return [];
  }

  const rawEntries = Array.isArray(parsedValue)
    ? parsedValue
    : (parsedValue && Array.isArray(parsedValue.entries) ? parsedValue.entries : []);

  const normalizedEntries = [];
  for (const candidateEntry of rawEntries) {
    if (!Array.isArray(candidateEntry) || candidateEntry.length < 2) continue;
    const entryName = sanitizePlayerName(candidateEntry[0]);
    const entryScore = sanitizeScore(candidateEntry[1]);
    const entryTimestamp = Number(candidateEntry[2]) || 0;
    if (!entryName || entryScore === null) continue;
    normalizedEntries.push([entryName, entryScore, entryTimestamp]);
  }

  normalizedEntries.sort((leftEntry, rightEntry) => {
    if (rightEntry[1] !== leftEntry[1]) return rightEntry[1] - leftEntry[1];
    return rightEntry[2] - leftEntry[2];
  });

  return normalizedEntries.slice(0, MAX_ENTRIES);
}

function serializeOnChainEntries(entries) {
  return JSON.stringify({
    entries: entries.map((entry) => [entry[0], entry[1], entry[2]])
  });
}

async function readLeaderboardState(difficulty) {
  const onChainName = nameByDifficulty[difficulty];
  try {
    const result = await callRpc("name_show", [onChainName]);
    const parsedEntries = parseOnChainEntries(result.value || "");
    return { exists: true, onChainName, entries: parsedEntries };
  } catch (error) {
    if (error && (error.code === -4 || error.code === -5 || error.code === -8)) {
      return { exists: false, onChainName, entries: [] };
    }
    throw error;
  }
}

function mergeEntries(existingEntries, newName, newScore) {
  const mergedEntries = (Array.isArray(existingEntries) ? existingEntries : []).filter((entry) => entry[0] !== newName);
  mergedEntries.push([newName, newScore, Date.now()]);
  mergedEntries.sort((leftEntry, rightEntry) => {
    if (rightEntry[1] !== leftEntry[1]) return rightEntry[1] - leftEntry[1];
    return rightEntry[2] - leftEntry[2];
  });
  return mergedEntries.slice(0, MAX_ENTRIES);
}

function entryExists(entries, expectedName, expectedScore) {
  return entries.some((entry) => entry[0] === expectedName && Math.abs(entry[1] - expectedScore) < 0.0005);
}

async function submitLeaderboardScore(difficulty, playerName, score) {
  for (let attemptNumber = 0; attemptNumber < MAX_RETRIES; attemptNumber++) {
    const currentState = await readLeaderboardState(difficulty);
    const mergedEntries = mergeEntries(currentState.entries, playerName, score);
    const serializedValue = serializeOnChainEntries(mergedEntries);

    try {
      if (currentState.exists) {
        await callRpc("name_update", [currentState.onChainName, serializedValue]);
      } else {
        await callRpc("name_register", [currentState.onChainName, serializedValue]);
      }
    } catch (error) {
      const rpcMessage = String(error && error.message ? error.message : "").toLowerCase();
      const isPendingNameState = rpcMessage.includes("pending registration") || rpcMessage.includes("pending update");
      if (isPendingNameState) {
        return mergedEntries;
      }
      if (attemptNumber >= MAX_RETRIES - 1) {
        throw error;
      }
      continue;
    }

    try {
      const verifyState = await readLeaderboardState(difficulty);
      if (entryExists(verifyState.entries, playerName, score)) {
        return verifyState.entries;
      }
    } catch {
      // Ignore transient verification errors and rely on write success fallback.
    }

    // Name operations can remain pending before becoming visible via name_show.
    // If write RPC call succeeded, report success immediately using merged entries.
    return mergedEntries;
  }

  throw new Error("Failed to persist leaderboard score after retries");
}

function toApiEntries(entries) {
  return entries.map((entry, index) => ({
    rank: index + 1,
    name: entry[0],
    score: entry[1]
  }));
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

      const state = await readLeaderboardState(difficulty);
      sendJson(response, 200, {
        ok: true,
        difficulty,
        entries: toApiEntries(state.entries)
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
      const playerName = sanitizePlayerName(parsedBody.name);
      const score = sanitizeScore(parsedBody.score);

      if (!difficulty || !playerName || score === null) {
        sendJson(response, 400, { ok: false, error: "Invalid difficulty, name, or score" });
        return;
      }

      const updatedEntries = await submitLeaderboardScore(difficulty, playerName, score);
      sendJson(response, 200, {
        ok: true,
        difficulty,
        entries: toApiEntries(updatedEntries)
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
