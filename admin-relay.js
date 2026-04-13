"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
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

const ADMIN_ENABLED = String(process.env.ADMIN || "").toLowerCase() === "true";
const RELAY_HOST = "127.0.0.1";
const RELAY_PORT = Number(process.env.ADMIN_RELAY_PORT || 8789);
const RPC_URL = "http://127.0.0.1:11999/";
const RPC_TIMEOUT_MS = 10000;
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 30;
const MAX_ENTRIES = 10;
const GAME_PREFIX = "g/voidrunner3d/";
const PRIZE_PREFIX = `${GAME_PREFIX}prizes/`;
const DEFAULT_MVP_PAYOUT_AMOUNT = 0.01;
const DEFAULT_MVP_ADMIN_KEY = "voidrunner3d-mvp-admin";
const PRIZE_POT_ADDRESS = String(process.env.PRIZE_POT_ADDRESS || "").trim();

const difficultyKeys = Object.freeze({ easy: true, normal: true, hard: true });
const prizeTypeKeys = Object.freeze({ hourly: true, daily: true, weekly: true });

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  setCors(response);
  response.end(JSON.stringify(payload));
}

async function callRpc(method, params) {
  const payload = { jsonrpc: "1.0", id: `admin-relay-${Date.now()}`, method, params };
  const headers = { "Content-Type": "application/json" };
  const rpcUser = process.env.ROD_RPC_USER;
  const rpcPassword = process.env.ROD_RPC_PASSWORD;
  if (rpcUser || rpcPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${rpcUser || ""}:${rpcPassword || ""}`).toString("base64")}`;
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
  } finally {
    clearTimeout(rpcTimeoutHandle);
  }
  if (!rpcResponse.ok) throw new Error(`RPC HTTP ${rpcResponse.status}`);
  const rpcBody = await rpcResponse.json();
  if (rpcBody.error) {
    const rpcError = new Error(rpcBody.error.message || "RPC error");
    rpcError.code = rpcBody.error.code;
    throw rpcError;
  }
  return rpcBody.result;
}

function sanitizeHandle(rawHandle) {
  if (typeof rawHandle !== "string") return null;
  const normalizedHandle = rawHandle.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  return normalizedHandle.length >= 3 && normalizedHandle.length <= 24 ? normalizedHandle : null;
}

function sanitizeScore(rawScore) {
  const parsedScore = Number(rawScore);
  if (!Number.isFinite(parsedScore) || parsedScore < 0 || parsedScore > 86400) return null;
  return Math.round(parsedScore * 1000) / 1000;
}

function sanitizeDifficulty(difficulty) {
  return Object.prototype.hasOwnProperty.call(difficultyKeys, difficulty) ? difficulty : null;
}

function sanitizePrizeType(prizeType) {
  return Object.prototype.hasOwnProperty.call(prizeTypeKeys, prizeType) ? prizeType : null;
}

function sanitizePrizeIndex(rawIndex) {
  const parsedIndex = Number(rawIndex);
  return Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : null;
}

function sanitizeBlockHeight(rawHeight) {
  const parsedHeight = Number(rawHeight);
  return Number.isInteger(parsedHeight) && parsedHeight >= 0 ? parsedHeight : null;
}

function sanitizeTimestampMs(rawTimestamp) {
  const parsedTimestamp = Number(rawTimestamp);
  return Number.isInteger(parsedTimestamp) && parsedTimestamp >= 0 ? parsedTimestamp : null;
}

function sanitizePayoutAmount(rawAmount) {
  const parsedAmount = Number(rawAmount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
  return Math.round(parsedAmount * 100000000) / 100000000;
}

function sanitizeTxid(rawTxid) {
  if (rawTxid === null || rawTxid === undefined) return null;
  if (typeof rawTxid !== "string") return null;
  const trimmedTxid = rawTxid.trim();
  return trimmedTxid || null;
}

function getPrizeRecordName(prizeType, prizeIndex) {
  return `${PRIZE_PREFIX}${prizeType}/${prizeIndex}`;
}

function getPrizeLatestPointerName(prizeType) {
  return `${PRIZE_PREFIX}${prizeType}/latest`;
}

function getIdentityNameForHandle(handle) {
  return `p/${handle}`;
}

function parseRecordValue(value, expectedHandle) {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsedEnvelope;
  try {
    parsedEnvelope = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsedEnvelope || typeof parsedEnvelope !== "object") return null;
  if (Number(parsedEnvelope.version) !== 2 || parsedEnvelope.game !== "voidrunner3d" || parsedEnvelope.algorithm !== "sha256") return null;
  const envelopeHandle = sanitizeHandle(parsedEnvelope.handle);
  if (!envelopeHandle || envelopeHandle !== expectedHandle) return null;
  const salt = typeof parsedEnvelope.salt === "string" ? parsedEnvelope.salt : "";
  const encodedPayload = typeof parsedEnvelope.payload === "string" ? parsedEnvelope.payload : "";
  const providedDigest = typeof parsedEnvelope.digest === "string" ? parsedEnvelope.digest : "";
  if (!salt || !encodedPayload || !providedDigest) return null;
  const expectedDigest = crypto.createHash("sha256").update(`${envelopeHandle}:${salt}:${encodedPayload}`).digest("hex");
  if (providedDigest !== expectedDigest) return null;
  let payloadObject;
  try {
    payloadObject = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!payloadObject || typeof payloadObject !== "object") return null;
  const scoresObject = payloadObject.scores && typeof payloadObject.scores === "object" ? payloadObject.scores : {};
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
    normalizedScores[difficulty] = { score: scoreValue, updatedAt: Number(rawScoreEntry.updatedAt) || 0 };
  }
  return { handle: envelopeHandle, scores: normalizedScores };
}

async function readName(name) {
  try {
    const result = await callRpc("name_show", [name]);
    return { exists: true, value: typeof result.value === "string" ? result.value : "" };
  } catch (error) {
    if (error && (error.code === -4 || error.code === -5 || error.code === -8)) return { exists: false, value: "" };
    throw error;
  }
}

async function ensureNameRegistered(name, fallbackValue) {
  const currentNameState = await readName(name);
  if (currentNameState.exists) return;
  await callRpc("name_register", [name, fallbackValue]);
}

function parsePrizeRecordValue(value, expectedType, expectedIndex) {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsedValue || typeof parsedValue !== "object") return null;
  const version = Number(parsedValue.version);
  if (!Number.isInteger(version) || version < 1) return null;
  const prizeType = sanitizePrizeType(String(parsedValue.type || "").toLowerCase());
  const prizeIndex = sanitizePrizeIndex(parsedValue.index);
  const winnerHandle = sanitizeHandle(parsedValue.winner);
  const score = sanitizeScore(parsedValue.score);
  const difficulty = sanitizeDifficulty(String(parsedValue.difficulty || "").toLowerCase());
  const blockStart = sanitizeBlockHeight(parsedValue.blockStart);
  const blockEnd = sanitizeBlockHeight(parsedValue.blockEnd);
  const paid = typeof parsedValue.paid === "boolean" ? parsedValue.paid : null;
  const paidAtHeight = parsedValue.paidAtHeight === null || parsedValue.paidAtHeight === undefined ? null : sanitizeBlockHeight(parsedValue.paidAtHeight);
  const timestamp = sanitizeTimestampMs(parsedValue.timestamp);
  const txid = parsedValue.txid === null || parsedValue.txid === undefined ? null : sanitizeTxid(parsedValue.txid);
  if (!prizeType || prizeType !== expectedType || prizeIndex === null || prizeIndex !== expectedIndex) return null;
  if (!winnerHandle || score === null || !difficulty || blockStart === null || blockEnd === null || paid === null || timestamp === null) return null;
  if (blockEnd < blockStart) return null;
  if (paidAtHeight !== null && paidAtHeight < blockEnd) return null;
  if (paid && !txid) return null;
  return {
    version,
    type: prizeType,
    index: prizeIndex,
    winner: winnerHandle,
    score,
    difficulty,
    blockStart,
    blockEnd,
    paid,
    txid,
    paidAtHeight,
    timestamp
  };
}

function normalizePrizeRecordInput(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object") return null;
  const prizeType = sanitizePrizeType(String(parsedBody.type || "").toLowerCase());
  const prizeIndex = sanitizePrizeIndex(parsedBody.index);
  if (!prizeType || prizeIndex === null) return null;
  return parsePrizeRecordValue(JSON.stringify({
    version: parsedBody.version,
    type: prizeType,
    index: prizeIndex,
    winner: parsedBody.winner,
    score: parsedBody.score,
    difficulty: parsedBody.difficulty,
    blockStart: parsedBody.blockStart,
    blockEnd: parsedBody.blockEnd,
    paid: parsedBody.paid,
    txid: parsedBody.txid,
    paidAtHeight: parsedBody.paidAtHeight,
    timestamp: parsedBody.timestamp
  }), prizeType, prizeIndex);
}

function serializePrizeRecordValue(prizeRecord) {
  return JSON.stringify(prizeRecord);
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
    candidateEntries.push({ handle: handleFromName, score: selectedDifficultyScore.score, updatedAt: selectedDifficultyScore.updatedAt || 0 });
  }
  candidateEntries.sort((leftEntry, rightEntry) => {
    if (rightEntry.score !== leftEntry.score) return rightEntry.score - leftEntry.score;
    return rightEntry.updatedAt - leftEntry.updatedAt;
  });
  return candidateEntries.slice(0, MAX_ENTRIES).map((entry, index) => ({ rank: index + 1, handle: entry.handle, score: entry.score }));
}

async function writePrizeRecord(prizeRecord) {
  const recordName = getPrizeRecordName(prizeRecord.type, prizeRecord.index);
  const recordValue = serializePrizeRecordValue(prizeRecord);
  await ensureNameRegistered(recordName, recordValue);
  await callRpc("name_update", [recordName, recordValue]);
  const latestPointerName = getPrizeLatestPointerName(prizeRecord.type);
  const latestPointerValue = JSON.stringify({ index: prizeRecord.index, updatedAt: Date.now() });
  await ensureNameRegistered(latestPointerName, latestPointerValue);
  await callRpc("name_update", [latestPointerName, latestPointerValue]);
  return { recordName, latestPointerName };
}

async function readLatestPrizeRecordByType(prizeType) {
  const latestPointerState = await readName(getPrizeLatestPointerName(prizeType));
  if (latestPointerState.exists) {
    try {
      const pointerBody = JSON.parse(latestPointerState.value);
      const pointedIndex = sanitizePrizeIndex(pointerBody?.index);
      if (pointedIndex !== null) {
        const pointedRecordState = await readName(getPrizeRecordName(prizeType, pointedIndex));
        if (pointedRecordState.exists) {
          const pointedRecord = parsePrizeRecordValue(pointedRecordState.value, prizeType, pointedIndex);
          if (pointedRecord) return { strategy: "pointer", prize: pointedRecord };
        }
      }
    } catch {
      // fallback below
    }
  }
  const scannedRows = await scanRecordNamesByPrefix(`${PRIZE_PREFIX}${prizeType}/`);
  let latestPrize = null;
  for (const row of scannedRows) {
    const onChainName = typeof row?.name === "string" ? row.name : "";
    if (onChainName === getPrizeLatestPointerName(prizeType)) continue;
    const index = sanitizePrizeIndex(onChainName.slice(`${PRIZE_PREFIX}${prizeType}/`.length));
    if (index === null) continue;
    const parsedPrize = parsePrizeRecordValue(typeof row?.value === "string" ? row.value : "", prizeType, index);
    if (!parsedPrize) continue;
    if (!latestPrize || parsedPrize.index > latestPrize.index) latestPrize = parsedPrize;
  }
  return { strategy: "scan-max-index", prize: latestPrize };
}

async function closeRoundWindowMvp({ prizeType, difficulty, blockStart, blockEnd, payoutAmount }) {
  const leaderboardEntries = await getLeaderboardEntriesForDifficulty(difficulty);
  if (!leaderboardEntries.length) {
    return { ok: false, reason: "no-winner", message: "No leaderboard entries available for selected difficulty" };
  }
  const winnerEntry = leaderboardEntries[0];
  const latestPrizeResult = await readLatestPrizeRecordByType(prizeType);
  const nextPrizeIndex = latestPrizeResult.prize ? latestPrizeResult.prize.index + 1 : 0;

  let paid = false;
  let txid = null;
  let paidAtHeight = null;
  let payoutError = null;
  try {
    const payoutTargetName = getIdentityNameForHandle(winnerEntry.handle);
    const payoutResult = await callRpc("sendtoname", [payoutTargetName, payoutAmount]);
    const normalizedTxid = sanitizeTxid(payoutResult);
    if (!normalizedTxid) throw new Error("Payout RPC did not return a valid txid");
    txid = normalizedTxid;
    paidAtHeight = await callRpc("getblockcount", []);
    paid = true;
  } catch (error) {
    payoutError = error && error.message ? String(error.message) : "Payout failed";
  }

  const prizeRecord = {
    version: 1,
    type: prizeType,
    index: nextPrizeIndex,
    winner: winnerEntry.handle,
    score: winnerEntry.score,
    difficulty,
    blockStart,
    blockEnd,
    paid,
    txid,
    paidAtHeight,
    timestamp: Date.now()
  };

  const writeResult = await writePrizeRecord(prizeRecord);
  return {
    ok: true,
    strategy: "manual-close-mvp",
    payoutAmount,
    prizePotAddress: PRIZE_POT_ADDRESS || null,
    winner: winnerEntry,
    payout: { paid, txid, paidAtHeight, error: payoutError },
    recordName: writeResult.recordName,
    latestPointerName: writeResult.latestPointerName,
    round: prizeRecord,
    prize: prizeRecord
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

if (!ADMIN_ENABLED) {
  console.log("Admin relay disabled: set ADMIN=true in .env to enable admin endpoints.");
  process.exitCode = 0;
} else {
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
        sendJson(response, 200, { ok: true, relay: "up", node: "up", admin: true, prizePotAddressConfigured: Boolean(PRIZE_POT_ADDRESS) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/prizes") {
        const rawBody = await readRequestBody(request);
        let parsedBody;
        try {
          parsedBody = JSON.parse(rawBody || "{}");
        } catch {
          sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        const providedAdminKey = typeof parsedBody.adminKey === "string" ? parsedBody.adminKey : "";
        const expectedAdminKey = process.env.MVP_ADMIN_KEY || DEFAULT_MVP_ADMIN_KEY;
        if (!providedAdminKey || providedAdminKey !== expectedAdminKey) {
          sendJson(response, 403, { ok: false, error: "Forbidden: invalid admin key" });
          return;
        }
        const normalizedPrizeRecord = normalizePrizeRecordInput(parsedBody);
        if (!normalizedPrizeRecord) {
          sendJson(response, 400, { ok: false, error: "Invalid prize record payload" });
          return;
        }
        const writeResult = await writePrizeRecord(normalizedPrizeRecord);
        sendJson(response, 200, {
          ok: true,
          strategy: "write-record-and-pointer",
          recordName: writeResult.recordName,
          latestPointerName: writeResult.latestPointerName,
          round: normalizedPrizeRecord,
          prize: normalizedPrizeRecord
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/prizes/close-window") {
        const rawBody = await readRequestBody(request);
        let parsedBody;
        try {
          parsedBody = JSON.parse(rawBody || "{}");
        } catch {
          sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        const providedAdminKey = typeof parsedBody.adminKey === "string" ? parsedBody.adminKey : "";
        const expectedAdminKey = process.env.MVP_ADMIN_KEY || DEFAULT_MVP_ADMIN_KEY;
        if (!providedAdminKey || providedAdminKey !== expectedAdminKey) {
          sendJson(response, 403, { ok: false, error: "Forbidden: invalid admin key" });
          return;
        }

        const prizeType = sanitizePrizeType(String(parsedBody.type || "").toLowerCase());
        const difficulty = sanitizeDifficulty(String(parsedBody.difficulty || "").toLowerCase());
        const blockStart = sanitizeBlockHeight(parsedBody.blockStart);
        const blockEnd = sanitizeBlockHeight(parsedBody.blockEnd);
        const payoutAmount = sanitizePayoutAmount(parsedBody.payoutAmount === undefined ? DEFAULT_MVP_PAYOUT_AMOUNT : parsedBody.payoutAmount);
        if (!prizeType || !difficulty || blockStart === null || blockEnd === null || blockEnd < blockStart || payoutAmount === null) {
          sendJson(response, 400, { ok: false, error: "Invalid close-window payload" });
          return;
        }

        const closeResult = await closeRoundWindowMvp({ prizeType, difficulty, blockStart, blockEnd, payoutAmount });
        if (!closeResult.ok) {
          sendJson(response, 409, { ok: false, error: closeResult.message, reason: closeResult.reason });
          return;
        }
        sendJson(response, 200, closeResult);
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(response, 502, { ok: false, error: error.message || "Admin relay error" });
    }
  });

  server.listen(RELAY_PORT, RELAY_HOST, () => {
    console.log(`Void Runner admin relay listening on http://${RELAY_HOST}:${RELAY_PORT}`);
  });
}

