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
const GAME_HASH_NAME = `${GAME_PREFIX}gamehash`;
const RELAY_HASH_NAME = `${GAME_PREFIX}relayhash`;
const HASH_ALGORITHM = "sha256";
const PRIZE_PREFIX = `${GAME_PREFIX}prizes/`;
const RECORD_ENVELOPE_VERSION = 2;
const RECORD_ENVELOPE_ALGORITHM = "sha256";
const FEATURED_LEADERBOARD_DIFFICULTY = "normal";
const DEFAULT_MVP_PAYOUT_AMOUNT = 0.01;
const DEFAULT_MVP_ADMIN_KEY = "voidrunner3d-mvp-admin";
const MVP_POT_FUNDING_ADDRESS = "RH6CVe24Zf9HqUq6AktYeBLhVeuHBjzL29";
const MVP_POT_FULLY_FUNDED_THRESHOLD = 1;
const MVP_POT_LOW_THRESHOLD = 0;
const PRIZE_WINDOW_BLOCK_SIZES = Object.freeze({
  hourly: 120,
  daily: 2880,
  weekly: 20160
});

const prizeTypeKeys = Object.freeze({
  hourly: true,
  daily: true,
  weekly: true
});

const integrityModeKeys = Object.freeze({
  strict: true,
  warn: true,
  dev: true
});

const integrityState = {
  mode: "dev",
  algorithm: HASH_ALGORITHM,
  checkedAt: null,
  skipped: false,
  verified: false,
  readOnly: false,
  status: "pending",
  reason: null,
  strictFailure: false,
  files: {
    game: {
      path: "index.html",
      chainName: GAME_HASH_NAME,
      actual: null,
      expected: null,
      match: null,
      error: null
    },
    relay: {
      path: "leaderboard-relay.exe",
      chainName: RELAY_HASH_NAME,
      actual: null,
      expected: null,
      match: null,
      error: null
    }
  }
};

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

function sanitizeIntegrityMode(rawMode) {
  const normalizedMode = String(rawMode || "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(integrityModeKeys, normalizedMode) ? normalizedMode : "dev";
}

function normalizeChainHash(rawValue) {
  if (typeof rawValue !== "string") return null;
  const normalizedHash = rawValue.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalizedHash) ? normalizedHash : null;
}

function computeFileHash(fileName) {
  const filePath = path.join(__dirname, fileName);
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash(HASH_ALGORITHM).update(fileBuffer).digest("hex");
}

async function readExpectedHashFromChain(name) {
  const nameState = await readName(name);
  if (!nameState.exists) return null;
  return normalizeChainHash(nameState.value);
}

function buildIntegrityStatusPayload() {
  return {
    mode: integrityState.mode,
    algorithm: integrityState.algorithm,
    checkedAt: integrityState.checkedAt,
    skipped: integrityState.skipped,
    verified: integrityState.verified,
    readOnly: integrityState.readOnly,
    status: integrityState.status,
    reason: integrityState.reason,
    files: integrityState.files
  };
}

function isMutatingRequest(requestMethod, requestPathname) {
  return requestMethod === "POST" && requestPathname.startsWith("/api/");
}

async function initializeIntegrityVerification() {
  const configuredMode = sanitizeIntegrityMode(process.env.RELAY_INTEGRITY_MODE || "dev");
  integrityState.mode = configuredMode;
  integrityState.checkedAt = new Date().toISOString();

  if (configuredMode === "dev") {
    integrityState.skipped = true;
    integrityState.verified = true;
    integrityState.readOnly = false;
    integrityState.status = "skipped";
    integrityState.reason = "Integrity verification skipped in dev mode";
    return;
  }

  integrityState.skipped = false;

  try {
    integrityState.files.game.actual = computeFileHash("index.html");
  } catch (error) {
    integrityState.files.game.error = error.message || "Failed to hash index.html";
  }

  try {
    integrityState.files.relay.actual = computeFileHash("leaderboard-relay.exe");
  } catch (error) {
    integrityState.files.relay.error = error.message || "Failed to hash leaderboard-relay.exe";
  }

  try {
    integrityState.files.game.expected = await readExpectedHashFromChain(GAME_HASH_NAME);
  } catch (error) {
    integrityState.files.game.error = error.message || "Failed to read game hash from chain";
  }

  try {
    integrityState.files.relay.expected = await readExpectedHashFromChain(RELAY_HASH_NAME);
  } catch (error) {
    integrityState.files.relay.error = error.message || "Failed to read relay hash from chain";
  }

  integrityState.files.game.match =
    !!integrityState.files.game.actual &&
    !!integrityState.files.game.expected &&
    integrityState.files.game.actual === integrityState.files.game.expected;
  integrityState.files.relay.match =
    !!integrityState.files.relay.actual &&
    !!integrityState.files.relay.expected &&
    integrityState.files.relay.actual === integrityState.files.relay.expected;

  const verificationPassed = integrityState.files.game.match && integrityState.files.relay.match;
  integrityState.verified = verificationPassed;

  if (verificationPassed) {
    integrityState.readOnly = false;
    integrityState.status = "verified";
    integrityState.reason = null;
    return;
  }

  integrityState.reason = "Integrity verification failed or expected chain hash unavailable";
  if (configuredMode === "warn") {
    integrityState.readOnly = true;
    integrityState.status = "degraded-read-only";
    return;
  }

  integrityState.readOnly = true;
  integrityState.strictFailure = true;
  integrityState.status = "blocked";
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

function sanitizePrizeType(prizeType) {
  return Object.prototype.hasOwnProperty.call(prizeTypeKeys, prizeType) ? prizeType : null;
}

function getPrizeWindowSize(prizeType) {
  return PRIZE_WINDOW_BLOCK_SIZES[prizeType] || null;
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

function sanitizePrizeIndex(rawIndex) {
  const parsedIndex = Number(rawIndex);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) return null;
  return parsedIndex;
}

function sanitizeBlockHeight(rawHeight) {
  const parsedHeight = Number(rawHeight);
  if (!Number.isInteger(parsedHeight) || parsedHeight < 0) return null;
  return parsedHeight;
}

function sanitizeTimestampMs(rawTimestamp) {
  const parsedTimestamp = Number(rawTimestamp);
  if (!Number.isInteger(parsedTimestamp) || parsedTimestamp < 0) return null;
  return parsedTimestamp;
}

function sanitizePayoutAmount(rawAmount) {
  const parsedAmount = Number(rawAmount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
  return Math.round(parsedAmount * 100000000) / 100000000;
}

function sanitizePotBalance(rawBalance) {
  const parsedBalance = Number(rawBalance);
  if (!Number.isFinite(parsedBalance) || parsedBalance < 0) return null;
  return Math.round(parsedBalance * 100000000) / 100000000;
}

function getMvpFundingStatus(balance) {
  if (balance >= MVP_POT_FULLY_FUNDED_THRESHOLD) return "FULLY_FUNDED";
  if (balance > MVP_POT_LOW_THRESHOLD) return "LOW";
  return "UNFUNDED";
}

async function readMvpPotBalance() {
  const rpcResult = await callRpc("getaddressbalance", [MVP_POT_FUNDING_ADDRESS]);
  const rawBalance = rpcResult && typeof rpcResult === "object" ? rpcResult.balance : rpcResult;
  const balance = sanitizePotBalance(rawBalance);
  if (balance === null) {
    throw new Error("Invalid pot balance returned by RPC");
  }
  return balance;
}

function sanitizeTxid(rawTxid) {
  if (rawTxid === null || rawTxid === undefined) return null;
  if (typeof rawTxid !== "string") return null;
  const trimmedTxid = rawTxid.trim();
  if (!trimmedTxid) return null;
  return trimmedTxid;
}

function getPrizeRecordName(prizeType, prizeIndex) {
  return `${PRIZE_PREFIX}${prizeType}/${prizeIndex}`;
}

function getPrizeLatestPointerName(prizeType) {
  return `${PRIZE_PREFIX}${prizeType}/latest`;
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
  if (!prizeType || prizeType !== expectedType) return null;

  const prizeIndex = sanitizePrizeIndex(parsedValue.index);
  if (prizeIndex === null || prizeIndex !== expectedIndex) return null;

  const winnerHandle = sanitizeHandle(parsedValue.winner);
  const score = sanitizeScore(parsedValue.score);
  const difficulty = sanitizeDifficulty(String(parsedValue.difficulty || "").toLowerCase());
  const blockStart = sanitizeBlockHeight(parsedValue.blockStart);
  const blockEnd = sanitizeBlockHeight(parsedValue.blockEnd);
  const paid = typeof parsedValue.paid === "boolean" ? parsedValue.paid : null;
  const paidAtHeight = parsedValue.paidAtHeight === null || parsedValue.paidAtHeight === undefined
    ? null
    : sanitizeBlockHeight(parsedValue.paidAtHeight);
  const timestamp = sanitizeTimestampMs(parsedValue.timestamp);
  const txid = parsedValue.txid === null || parsedValue.txid === undefined ? null : sanitizeTxid(parsedValue.txid);

  if (!winnerHandle || score === null || !difficulty || blockStart === null || blockEnd === null || paid === null || timestamp === null) {
    return null;
  }

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

function serializePrizeRecordValue(prizeRecord) {
  return JSON.stringify({
    version: prizeRecord.version,
    type: prizeRecord.type,
    index: prizeRecord.index,
    winner: prizeRecord.winner,
    score: prizeRecord.score,
    difficulty: prizeRecord.difficulty,
    blockStart: prizeRecord.blockStart,
    blockEnd: prizeRecord.blockEnd,
    paid: prizeRecord.paid,
    txid: prizeRecord.txid,
    paidAtHeight: prizeRecord.paidAtHeight,
    timestamp: prizeRecord.timestamp
  });
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

function parseRecordValue(value, expectedHandle) {
  if (typeof value !== "string" || value.length === 0) return null;

  let parsedEnvelope;
  try {
    parsedEnvelope = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsedEnvelope || typeof parsedEnvelope !== "object") return null;

  const envelopeVersion = Number(parsedEnvelope.version);
  if (!Number.isInteger(envelopeVersion) || envelopeVersion !== RECORD_ENVELOPE_VERSION) return null;
  if (parsedEnvelope.game !== "voidrunner3d") return null;
  if (parsedEnvelope.algorithm !== RECORD_ENVELOPE_ALGORITHM) return null;

  const envelopeHandle = sanitizeHandle(parsedEnvelope.handle);
  if (!envelopeHandle || envelopeHandle !== expectedHandle) return null;

  const salt = typeof parsedEnvelope.salt === "string" ? parsedEnvelope.salt : "";
  const encodedPayload = typeof parsedEnvelope.payload === "string" ? parsedEnvelope.payload : "";
  const providedDigest = typeof parsedEnvelope.digest === "string" ? parsedEnvelope.digest : "";
  if (!salt || !encodedPayload || !providedDigest) return null;

  const expectedDigest = crypto
    .createHash(RECORD_ENVELOPE_ALGORITHM)
    .update(`${envelopeHandle}:${salt}:${encodedPayload}`)
    .digest("hex");
  if (providedDigest !== expectedDigest) return null;

  let payloadObject;
  try {
    payloadObject = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!payloadObject || typeof payloadObject !== "object") return null;

  const payloadHandle = sanitizeHandle(payloadObject.handle);
  if (!payloadHandle || payloadHandle !== envelopeHandle) return null;

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

    const timestampValue = Number(rawScoreEntry.updatedAt) || 0;
    normalizedScores[difficulty] = {
      score: scoreValue,
      updatedAt: timestampValue
    };
  }

  return {
    handle: envelopeHandle,
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

  const payloadObject = {
    handle,
    scores: persistedScores
  };

  const encodedPayload = Buffer.from(JSON.stringify(payloadObject), "utf8").toString("base64");
  const salt = crypto
    .createHash(RECORD_ENVELOPE_ALGORITHM)
    .update(`voidrunner3d:${handle}:${JSON.stringify(persistedScores)}`)
    .digest("hex")
    .slice(0, 16);
  const digest = crypto
    .createHash(RECORD_ENVELOPE_ALGORITHM)
    .update(`${handle}:${salt}:${encodedPayload}`)
    .digest("hex");

  return JSON.stringify({
    version: RECORD_ENVELOPE_VERSION,
    game: "voidrunner3d",
    algorithm: RECORD_ENVELOPE_ALGORITHM,
    handle,
    salt,
    payload: encodedPayload,
    digest
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

async function getCurrentBlockHeight() {
  const currentBlockHeight = sanitizeBlockHeight(await callRpc("getblockcount", []));
  if (currentBlockHeight === null) {
    throw new Error("Invalid block height returned by RPC");
  }
  return currentBlockHeight;
}

function buildPrizeWindowStatus(prizeType, currentBlockHeight) {
  const windowSize = getPrizeWindowSize(prizeType);
  if (!windowSize) return null;

  const currentWindowIndex = Math.floor(currentBlockHeight / windowSize);
  const currentWindowStartHeight = currentWindowIndex * windowSize;
  const blocksIntoWindow = currentBlockHeight - currentWindowStartHeight;
  const blocksRemaining = Math.max(0, windowSize - (blocksIntoWindow + 1));
  const percentComplete = Math.round((((blocksIntoWindow + 1) / windowSize) * 100) * 1000) / 1000;

  return {
    type: prizeType,
    currentBlockHeight,
    currentWindowIndex,
    windowSize,
    blocksRemaining,
    percentComplete
  };
}

async function getLeaderboardEntriesForDifficulty(difficulty) {
  const leaderboardCandidates = await getLeaderboardCandidatesForDifficulty(difficulty);
  return leaderboardCandidates.slice(0, MAX_ENTRIES).map((entry, index) => ({
    rank: index + 1,
    handle: entry.handle,
    score: entry.score
  }));
}

function collectLeaderboardCandidates(scannedRows, difficulty) {
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

  return candidateEntries;
}

async function getLeaderboardCandidatesForDifficulty(difficulty) {
  const scannedRows = await scanRecordNamesByPrefix(GAME_PREFIX);
  return collectLeaderboardCandidates(scannedRows, difficulty);
}

function roundScoreDelta(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function buildLeaderboardRankPayload({ handle, difficulty, leaderboardCandidates, fallbackPlayerScore }) {
  const topEntries = leaderboardCandidates.slice(0, MAX_ENTRIES).map((entry, index) => ({
    rank: index + 1,
    handle: entry.handle,
    score: entry.score
  }));

  const leaderEntry = topEntries[0] || null;
  const topListCutoffEntry = topEntries.length === MAX_ENTRIES ? topEntries[MAX_ENTRIES - 1] : null;
  const rankedPlayerIndex = leaderboardCandidates.findIndex((entry) => entry.handle === handle);
  const rankedPlayerEntry = rankedPlayerIndex >= 0 ? leaderboardCandidates[rankedPlayerIndex] : null;
  const playerScore = rankedPlayerEntry ? rankedPlayerEntry.score : fallbackPlayerScore;
  const playerRank = rankedPlayerEntry ? rankedPlayerIndex + 1 : null;
  const playerInTopList = playerRank !== null && playerRank <= MAX_ENTRIES;

  const nextRankCandidate = rankedPlayerIndex > 0 ? leaderboardCandidates[rankedPlayerIndex - 1] : null;
  const nextRankEntry = nextRankCandidate
    ? {
        rank: rankedPlayerIndex,
        handle: nextRankCandidate.handle,
        score: nextRankCandidate.score
      }
    : null;

  const deltaToNextRank = nextRankCandidate && playerScore !== null
    ? roundScoreDelta(nextRankCandidate.score - playerScore)
    : null;
  const deltaToLeader = leaderEntry && playerScore !== null
    ? roundScoreDelta(leaderEntry.score - playerScore)
    : null;
  const deltaToTopList = topListCutoffEntry && playerScore !== null && !playerInTopList
    ? roundScoreDelta(topListCutoffEntry.score - playerScore)
    : null;

  return {
    ok: true,
    featuredDifficulty: difficulty,
    player: {
      handle,
      rank: playerRank,
      score: playerScore,
      inTopList: playerInTopList
    },
    deltas: {
      toNextRank: deltaToNextRank,
      toLeader: deltaToLeader,
      toTopList: deltaToTopList
    },
    targets: {
      leader: leaderEntry,
      nextRank: nextRankEntry,
      topListCutoff: topListCutoffEntry
    },
    top: topEntries
  };
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

  return {
    recordName,
    latestPointerName
  };
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
          if (pointedRecord) {
            return {
              strategy: "pointer",
              prize: pointedRecord
            };
          }
        }
      }
    } catch {
      // Fallback to scan strategy below.
    }
  }

  const scannedRows = await scanRecordNamesByPrefix(`${PRIZE_PREFIX}${prizeType}/`);
  let latestPrize = null;

  for (const row of scannedRows) {
    const onChainName = typeof row?.name === "string" ? row.name : "";
    const onChainValue = typeof row?.value === "string" ? row.value : "";
    if (onChainName === getPrizeLatestPointerName(prizeType)) continue;

    const indexText = onChainName.slice(`${PRIZE_PREFIX}${prizeType}/`.length);
    const index = sanitizePrizeIndex(indexText);
    if (index === null) continue;

    const parsedPrize = parsePrizeRecordValue(onChainValue, prizeType, index);
    if (!parsedPrize) continue;

    if (!latestPrize || parsedPrize.index > latestPrize.index) {
      latestPrize = parsedPrize;
    }
  }

  return {
    strategy: "scan-max-index",
    prize: latestPrize
  };
}

async function closePrizeWindowMvp({ prizeType, difficulty, blockStart, blockEnd, payoutAmount }) {
  const leaderboardEntries = await getLeaderboardEntriesForDifficulty(difficulty);
  if (!leaderboardEntries.length) {
    return {
      ok: false,
      reason: "no-winner",
      message: "No leaderboard entries available for selected difficulty"
    };
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
    if (!normalizedTxid) {
      throw new Error("Payout RPC did not return a valid txid");
    }
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
    winner: winnerEntry,
    payout: {
      paid,
      txid,
      paidAtHeight,
      error: payoutError
    },
    recordName: writeResult.recordName,
    latestPointerName: writeResult.latestPointerName,
    prize: prizeRecord
  };
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
    if (integrityState.readOnly && isMutatingRequest(request.method, requestUrl.pathname)) {
      sendJson(response, 503, {
        ok: false,
        error: "Relay is in read-only mode due to integrity verification",
        integrity: buildIntegrityStatusPayload()
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      await callRpc("getblockcount", []);
      sendJson(response, 200, {
        ok: true,
        relay: "up",
        node: "up",
        integrity: buildIntegrityStatusPayload()
      });
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

    if (request.method === "GET" && requestUrl.pathname === "/api/leaderboard/rank") {
      const handle = sanitizeHandle(requestUrl.searchParams.get("handle") || "");
      if (!handle) {
        sendJson(response, 400, { ok: false, error: "Invalid handle" });
        return;
      }

      const featuredDifficulty = FEATURED_LEADERBOARD_DIFFICULTY;
      const [leaderboardCandidates, playerStatus] = await Promise.all([
        getLeaderboardCandidatesForDifficulty(featuredDifficulty),
        readPlayerStatus(handle)
      ]);

      const featuredScoreEntry = playerStatus.record?.scores?.[featuredDifficulty] || null;
      const rankPayload = buildLeaderboardRankPayload({
        handle,
        difficulty: featuredDifficulty,
        leaderboardCandidates,
        fallbackPlayerScore: featuredScoreEntry ? featuredScoreEntry.score : null
      });

      sendJson(response, 200, rankPayload);
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

    if (request.method === "POST" && requestUrl.pathname === "/api/prizes") {
      const rawBody = await readRequestBody(request);
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody || "{}");
      } catch {
        sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
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
        prize: normalizedPrizeRecord
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/prizes/latest") {
      const prizeType = sanitizePrizeType(String(requestUrl.searchParams.get("type") || "").toLowerCase());
      if (!prizeType) {
        sendJson(response, 400, { ok: false, error: "Invalid prize type" });
        return;
      }

      const latestPrizeResult = await readLatestPrizeRecordByType(prizeType);
      if (!latestPrizeResult.prize) {
        sendJson(response, 404, {
          ok: false,
          error: "No prize record found",
          type: prizeType,
          strategy: latestPrizeResult.strategy
        });
        return;
      }

      sendJson(response, 200, {
        ok: true,
        type: prizeType,
        strategy: latestPrizeResult.strategy,
        prize: latestPrizeResult.prize
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/prize-window/status") {
      const prizeType = sanitizePrizeType(String(requestUrl.searchParams.get("type") || "").toLowerCase());
      if (!prizeType) {
        sendJson(response, 400, { ok: false, error: "Invalid prize type" });
        return;
      }

      const currentBlockHeight = await getCurrentBlockHeight();
      const prizeWindowStatus = buildPrizeWindowStatus(prizeType, currentBlockHeight);
      if (!prizeWindowStatus) {
        sendJson(response, 400, { ok: false, error: "Invalid prize type" });
        return;
      }

      sendJson(response, 200, {
        ok: true,
        ...prizeWindowStatus
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/pot/status") {
      try {
        const balance = await readMvpPotBalance();
        const missingToFullyFunded = Math.max(0, Math.round((MVP_POT_FULLY_FUNDED_THRESHOLD - balance) * 100000000) / 100000000);
        sendJson(response, 200, {
          ok: true,
          address: MVP_POT_FUNDING_ADDRESS,
          balance,
          status: getMvpFundingStatus(balance),
          rpcAvailable: true,
          targetBalance: MVP_POT_FULLY_FUNDED_THRESHOLD,
          missingToTarget: missingToFullyFunded
        });
      } catch (potError) {
        sendJson(response, 200, {
          ok: true,
          address: MVP_POT_FUNDING_ADDRESS,
          status: "UNKNOWN",
          rpcAvailable: false,
          targetBalance: MVP_POT_FULLY_FUNDED_THRESHOLD,
          missingToTarget: null,
          warning: potError && potError.message ? String(potError.message) : "Pot balance unavailable"
        });
      }
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
      const payoutAmount = sanitizePayoutAmount(
        parsedBody.payoutAmount === undefined ? DEFAULT_MVP_PAYOUT_AMOUNT : parsedBody.payoutAmount
      );

      if (!prizeType || !difficulty || blockStart === null || blockEnd === null || blockEnd < blockStart || payoutAmount === null) {
        sendJson(response, 400, { ok: false, error: "Invalid close-window payload" });
        return;
      }

      const closeResult = await closePrizeWindowMvp({
        prizeType,
        difficulty,
        blockStart,
        blockEnd,
        payoutAmount
      });

      if (!closeResult.ok) {
        sendJson(response, 409, {
          ok: false,
          error: closeResult.message,
          reason: closeResult.reason
        });
        return;
      }

      sendJson(response, 200, closeResult);
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(response, 502, { ok: false, error: error.message || "Relay error" });
  }
});

async function bootstrapRelayServer() {
  await initializeIntegrityVerification();

  if (integrityState.strictFailure) {
    console.error("Relay startup blocked: strict integrity verification failed");
    process.exitCode = 1;
    return;
  }

  server.listen(RELAY_PORT, RELAY_HOST, () => {
    console.log(`Void Runner relay listening on http://${RELAY_HOST}:${RELAY_PORT}`);
  });
}

bootstrapRelayServer().catch((error) => {
  console.error(`Relay bootstrap error: ${error.message || error}`);
  process.exitCode = 1;
});
