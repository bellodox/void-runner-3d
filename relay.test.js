"use strict";

const crypto = require("crypto");

const GAME_PREFIX = "g/voidrunner3d/";
const MAX_ENTRIES = 10;
const MIN_HANDLE_LENGTH = 3;
const MAX_HANDLE_LENGTH = 24;
const MAX_SCORE_SECONDS = 86400;
const PRIZE_PREFIX = `${GAME_PREFIX}prizes/`;
const RECORD_ENVELOPE_VERSION = 2;
const RECORD_ENVELOPE_ALGORITHM = "sha256";
const RELEASE_ROUND_BLOCK_SIZE = 120;
const RELEASE_LEG_BLOCK_SIZE = 1440;
const RELEASE_ROUNDS_PER_LEG = 12;
const RELEASE_PAYOUTS = Object.freeze([100, 70, 20, 10]);
const RELEASE_LIABILITIES = Object.freeze([28, 30, 33, 35, 36, 38]);
const RELEASE_MIN_ELIGIBLE_SETTLEMENT_PLAYERS = 10;

const difficultyKeys = Object.freeze({
  easy: true,
  normal: true,
  hard: true
});

const prizeTypeKeys = Object.freeze({
  hourly: true,
  daily: true,
  weekly: true
});

const PRIZE_WINDOW_BLOCK_SIZES = Object.freeze({
  hourly: 120,
  daily: 2880,
  weekly: 20160
});

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

function sanitizeDifficulty(difficulty) {
  return Object.prototype.hasOwnProperty.call(difficultyKeys, difficulty) ? difficulty : null;
}

function sanitizePrizeType(prizeType) {
  return Object.prototype.hasOwnProperty.call(prizeTypeKeys, prizeType) ? prizeType : null;
}

function getPrizeWindowSize(prizeType) {
  return PRIZE_WINDOW_BLOCK_SIZES[prizeType] || null;
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

function buildPrizeWindowStatus(prizeType, currentBlockHeight) {
  const windowSize = getPrizeWindowSize(prizeType);
  if (!windowSize || !Number.isInteger(currentBlockHeight) || currentBlockHeight < 0) return null;

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

function getRoundIdFromBlockHeight(blockHeight) {
  return Math.floor(blockHeight / RELEASE_ROUND_BLOCK_SIZE);
}

function getLegIdFromBlockHeight(blockHeight) {
  return Math.floor(blockHeight / RELEASE_LEG_BLOCK_SIZE);
}

function getRoundBlockRange(roundId) {
  const blockStart = roundId * RELEASE_ROUND_BLOCK_SIZE;
  return {
    blockStart,
    blockEnd: blockStart + RELEASE_ROUND_BLOCK_SIZE - 1
  };
}

function getLegBlockRange(legId) {
  const blockStart = legId * RELEASE_LEG_BLOCK_SIZE;
  return {
    blockStart,
    blockEnd: blockStart + RELEASE_LEG_BLOCK_SIZE - 1
  };
}

function buildSettlementFromStandings(standingsPayload, currentBlockHeight) {
  const topEntries = standingsPayload.entries;
  if (topEntries.length < RELEASE_MIN_ELIGIBLE_SETTLEMENT_PLAYERS) {
    return {
      version: 1,
      game: "voidrunner3d",
      roundId: standingsPayload.roundId,
      legId: standingsPayload.legId,
      roundStart: standingsPayload.roundStart,
      roundEnd: standingsPayload.roundEnd,
      status: "closed-no-settlement",
      reason: "insufficient-qualified-participants",
      qualifiedParticipants: topEntries.length,
      minimumRequiredParticipants: RELEASE_MIN_ELIGIBLE_SETTLEMENT_PLAYERS,
      generatedAtBlock: currentBlockHeight,
      winners: [],
      liabilities: []
    };
  }

  return {
    version: 1,
    game: "voidrunner3d",
    roundId: standingsPayload.roundId,
    legId: standingsPayload.legId,
    roundStart: standingsPayload.roundStart,
    roundEnd: standingsPayload.roundEnd,
    status: "settled",
    reason: null,
    qualifiedParticipants: topEntries.length,
    minimumRequiredParticipants: RELEASE_MIN_ELIGIBLE_SETTLEMENT_PLAYERS,
    generatedAtBlock: currentBlockHeight,
    winners: topEntries.slice(0, RELEASE_PAYOUTS.length).map((entry, index) => ({
      rank: entry.rank,
      handle: entry.handle,
      score: entry.score,
      amount: RELEASE_PAYOUTS[index]
    })),
    liabilities: topEntries.slice(RELEASE_PAYOUTS.length, RELEASE_PAYOUTS.length + RELEASE_LIABILITIES.length).map((entry, index) => ({
      rank: entry.rank,
      handle: entry.handle,
      score: entry.score,
      amount: RELEASE_LIABILITIES[index],
      amountPaid: 0,
      status: "due"
    }))
  };
}

function parseRoundSettlementValue(value, expectedRoundId) {
  if (typeof value !== "string" || !value) return null;
  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsedValue || typeof parsedValue !== "object") return null;
  if (parsedValue.version !== 1 || parsedValue.game !== "voidrunner3d") return null;
  const roundId = Number(parsedValue.roundId);
  if (!Number.isInteger(roundId) || roundId < 0 || roundId !== expectedRoundId) return null;
  if (typeof parsedValue.status !== "string") return null;
  return parsedValue;
}

function serializeRoundSettlementValue(settlementPayload) {
  return JSON.stringify(settlementPayload);
}

function applyScoreSubmission(existingRecord, handle, difficulty, score, timestamp) {
  const parsedRecord = existingRecord || {
    handle,
    scores: { easy: null, normal: null, hard: null }
  };

  const nextScores = {
    easy: parsedRecord.scores.easy,
    normal: parsedRecord.scores.normal,
    hard: parsedRecord.scores.hard
  };

  const existingDifficultyScore = nextScores[difficulty];
    if (!existingDifficultyScore || score >= existingDifficultyScore.score) {
      nextScores[difficulty] = {
        score,
        updatedAt: timestamp
      };
    }

  return {
    handle,
    scores: nextScores
  };
}

function aggregateLeaderboardRows(scannedRows, difficulty) {
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

let passed = 0;
let failed = 0;

function assert(description, condition, extra = "") {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}${extra ? " | " + extra : ""}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

section("player identity and record naming");
assert("identity names use p/<handle>", getIdentityNameForHandle("pilot01") === "p/pilot01");
assert(
  "record names use g/voidrunner3d/<handle>/record",
  getRecordNameForHandle("pilot01") === "g/voidrunner3d/pilot01/record"
);
assert("prize record names use g/voidrunner3d/prizes/<type>/<index>", getPrizeRecordName("hourly", 7) === "g/voidrunner3d/prizes/hourly/7");
assert("prize latest pointer uses g/voidrunner3d/prizes/<type>/latest", getPrizeLatestPointerName("daily") === "g/voidrunner3d/prizes/daily/latest");

section("sanitizeHandle");
assert("accepts lowercase handles", sanitizeHandle("pilot01") === "pilot01");
assert("normalizes uppercase and trims whitespace", sanitizeHandle("  Pilot_01  ") === "pilot_01");
assert("rejects handles shorter than 3 chars", sanitizeHandle("ab") === null);
assert("rejects handles longer than 24 chars", sanitizeHandle("abcdefghijklmnopqrstuvwxyz") === null);
assert("removes unsupported characters", sanitizeHandle("pilot!@#-01") === "pilot-01");

section("parseRecordValue");
{
  const rawRecord = serializeRecordValue("pilot01", {
    easy: { score: 12.3456, updatedAt: 100 },
    normal: { score: 15, updatedAt: 200 },
    hard: { score: -1, updatedAt: 300 }
  });

  const parsedRecord = parseRecordValue(rawRecord, "pilot01");
  assert("parses the expected handle", parsedRecord?.handle === "pilot01", JSON.stringify(parsedRecord));
  assert(
    "rounds and keeps valid easy score",
    parsedRecord?.scores.easy?.score === 12.346,
    JSON.stringify(parsedRecord?.scores.easy)
  );
  assert(
    "keeps timestamps intact when parsing",
    parsedRecord?.scores.normal?.updatedAt === 200,
    JSON.stringify(parsedRecord?.scores.normal)
  );
  assert("invalid difficulty score becomes null instead of breaking parsing", parsedRecord?.scores.hard === null);
}
assert("returns null for malformed JSON", parseRecordValue("{bad json}", "pilot01") === null);
assert(
  "returns null when stored handle does not match expected handle",
  parseRecordValue(serializeRecordValue("other", {}), "pilot01") === null
);
{
  const parsedRecord = parseRecordValue(serializeRecordValue("pilot01", {
    easy: { score: 11, updatedAt: 42 }
  }), "pilot01");
  assert(
    "retains normalized scores even without display names",
    parsedRecord?.scores.easy?.score === 11,
    JSON.stringify(parsedRecord?.scores.easy)
  );
}
{
  const encodedRecord = JSON.parse(serializeRecordValue("pilot01", {
    easy: { score: 11, updatedAt: 42 }
  }));
  encodedRecord.payload = Buffer.from(JSON.stringify({
    handle: "pilot01",
    scores: { easy: { score: 999, updatedAt: 42 } }
  }), "utf8").toString("base64");
  const tamperedRecord = JSON.stringify(encodedRecord);
  assert("returns null for tampered encoded payload digest mismatch", parseRecordValue(tamperedRecord, "pilot01") === null);
}

section("serializeRecordValue");
{
  const serializedRecord = serializeRecordValue("pilot01", {
    easy: { score: 20, updatedAt: 100 },
    normal: null,
    hard: { score: 30, updatedAt: 200 }
  });
  const roundTripRecord = JSON.parse(serializedRecord);
  const decodedPayload = JSON.parse(Buffer.from(roundTripRecord.payload, "base64").toString("utf8"));
  assert("stores the handle in serialized records", roundTripRecord.handle === "pilot01", serializedRecord);
  assert("stores only populated difficulty scores inside encoded payload", !decodedPayload.scores.normal, serializedRecord);
  assert("keeps hard score values during serialization", decodedPayload.scores.hard.score === 30, serializedRecord);
  assert("adds deterministic envelope metadata", roundTripRecord.version === 2 && roundTripRecord.algorithm === "sha256", serializedRecord);
}

section("best-score-only submission model");
{
  const currentRecord = parseRecordValue(serializeRecordValue("pilot01", {
    easy: { score: 10, updatedAt: 100 },
    normal: { score: 22, updatedAt: 200 }
  }), "pilot01");

  const lowerScoreUpdate = applyScoreSubmission(currentRecord, "pilot01", "easy", 9, 300);
  assert(
    "lower score does not replace an existing best score",
    lowerScoreUpdate.scores.easy?.score === 10,
    JSON.stringify(lowerScoreUpdate.scores.easy)
  );
  assert(
    "submitting one difficulty preserves other difficulty values",
    lowerScoreUpdate.scores.normal?.score === 22,
    JSON.stringify(lowerScoreUpdate.scores)
  );

  const higherScoreUpdate = applyScoreSubmission(currentRecord, "pilot01", "easy", 25, 400);
  assert(
    "higher score replaces the existing best score",
    higherScoreUpdate.scores.easy?.score === 25,
    JSON.stringify(higherScoreUpdate.scores.easy)
  );
  assert(
    "higher score also updates the timestamp for that difficulty",
    higherScoreUpdate.scores.easy?.updatedAt === 400,
    JSON.stringify(higherScoreUpdate.scores.easy)
  );
}

section("leaderboard aggregation from scanned player records");
{
  const scannedRows = [
    {
      name: "g/voidrunner3d/pilot01/record",
      value: serializeRecordValue("pilot01", {
        easy: { score: 10, updatedAt: 100 },
        normal: null,
        hard: null
      })
    },
    {
      name: "g/voidrunner3d/pilot02/record",
      value: serializeRecordValue("pilot02", {
        easy: { score: 15, updatedAt: 150 },
        normal: null,
        hard: null
      })
    },
    {
      name: "g/voidrunner3d/easy",
      value: JSON.stringify({ entries: [["OLD", 999, 1]] })
    },
    {
      name: "g/voidrunner3d/pilot03/record",
      value: "{broken json}"
    },
    {
      name: "g/voidrunner3d/pilot04/record",
      value: serializeRecordValue("different-handle", {
        easy: { score: 999, updatedAt: 999 }
      })
    },
    {
      name: "g/voidrunner3d/pilot05/profile",
      value: serializeRecordValue("pilot05", {
        easy: { score: 999, updatedAt: 999 },
        normal: null,
        hard: null
      })
    }
  ];

  const entries = aggregateLeaderboardRows(scannedRows, "easy");
  assert("aggregates entries from player-owned /record names only", entries.length === 2, JSON.stringify(entries));
  assert("ignores old shared snapshot names without /record suffix", !entries.some((entry) => entry.handle === "OLD"), JSON.stringify(entries));
  assert("sorts by score descending", entries[0]?.handle === "pilot02", JSON.stringify(entries));
  assert("keeps rank numbering after sorting", entries[0]?.rank === 1 && entries[1]?.rank === 2, JSON.stringify(entries));
}
{
  const scannedRows = Array.from({ length: 12 }, (_, index) => ({
    name: `g/voidrunner3d/p${String(index).padStart(2, "0")}/record`,
    value: serializeRecordValue(`p${String(index).padStart(2, "0")}`, {
      easy: { score: index + 1, updatedAt: index },
      normal: null,
      hard: null
    })
  }));

  const entries = aggregateLeaderboardRows(scannedRows, "easy");
  assert("limits aggregated leaderboard results to top 10", entries.length === 10, JSON.stringify(entries));
  assert("keeps the highest score at rank 1", entries[0]?.score === 12, JSON.stringify(entries[0]));
  assert("drops lower-ranked entries beyond the top 10", entries[9]?.score === 3, JSON.stringify(entries[9]));
}
{
  const tiedRows = [
    {
      name: "g/voidrunner3d/alpha/record",
      value: serializeRecordValue("alpha", {
        easy: { score: 50, updatedAt: 100 },
        normal: null,
        hard: null
      })
    },
    {
      name: "g/voidrunner3d/bravo/record",
      value: serializeRecordValue("bravo", {
        easy: { score: 50, updatedAt: 200 },
        normal: null,
        hard: null
      })
    }
  ];

  const entries = aggregateLeaderboardRows(tiedRows, "easy");
  assert("uses updatedAt to break score ties", entries[0]?.handle === "bravo", JSON.stringify(entries));
}

section("release round and leg derivation");
{
  const roundAtBoundary = getRoundIdFromBlockHeight(120);
  const legAtBoundary = getLegIdFromBlockHeight(1440);
  const roundBeforeBoundary = getRoundIdFromBlockHeight(119);
  const legBeforeBoundary = getLegIdFromBlockHeight(1439);
  const roundRange = getRoundBlockRange(102);
  const legRange = getLegBlockRange(8);

  assert("round id stays in round 0 through block 119", roundBeforeBoundary === 0, String(roundBeforeBoundary));
  assert("round id advances at block 120", roundAtBoundary === 1, String(roundAtBoundary));
  assert("leg id stays in leg 0 through block 1439", legBeforeBoundary === 0, String(legBeforeBoundary));
  assert("leg id advances at block 1440", legAtBoundary === 1, String(legAtBoundary));
  assert("release rounds per leg remains 12", RELEASE_ROUNDS_PER_LEG === 12, String(RELEASE_ROUNDS_PER_LEG));
  assert("round block range spans exactly 120 blocks", roundRange.blockStart === 12240 && roundRange.blockEnd === 12359, JSON.stringify(roundRange));
  assert("leg block range spans exactly 1440 blocks", legRange.blockStart === 11520 && legRange.blockEnd === 12959, JSON.stringify(legRange));
}

section("release settlement derivation");
{
  const insufficientSettlement = buildSettlementFromStandings({
    roundId: 101,
    legId: 8,
    roundStart: 12120,
    roundEnd: 12239,
    entries: Array.from({ length: 3 }, (_, index) => ({
      rank: index + 1,
      handle: `p0${index + 1}`,
      score: 50 - index
    }))
  }, 12345);

  assert("insufficient participants produce closed-no-settlement", insufficientSettlement.status === "closed-no-settlement", JSON.stringify(insufficientSettlement));
  assert("insufficient participants expose explicit reason", insufficientSettlement.reason === "insufficient-qualified-participants", JSON.stringify(insufficientSettlement));
  assert("insufficient participants produce no winners or liabilities", insufficientSettlement.winners.length === 0 && insufficientSettlement.liabilities.length === 0, JSON.stringify(insufficientSettlement));
}
{
  const settledPayload = buildSettlementFromStandings({
    roundId: 101,
    legId: 8,
    roundStart: 12120,
    roundEnd: 12239,
    entries: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      handle: `p${String(index).padStart(2, "0")}`,
      score: 100 - index
    }))
  }, 12345);

  const serializedSettlement = serializeRoundSettlementValue(settledPayload);
  const parsedSettlement = parseRoundSettlementValue(serializedSettlement, 101);
  assert("round settlement serialization preserves settled status", parsedSettlement?.status === "settled", JSON.stringify(parsedSettlement));
  assert("round settlement serialization preserves winner count", Array.isArray(parsedSettlement?.winners) && parsedSettlement.winners.length === 4, JSON.stringify(parsedSettlement?.winners));
  assert("round settlement parser rejects mismatched round ids", parseRoundSettlementValue(serializedSettlement, 102) === null);
}
{
  const settledPayload = buildSettlementFromStandings({
    roundId: 101,
    legId: 8,
    roundStart: 12120,
    roundEnd: 12239,
    entries: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      handle: `p${String(index).padStart(2, "0")}`,
      score: 100 - index
    }))
  }, 12345);

  assert("qualified round produces settled status", settledPayload.status === "settled", JSON.stringify(settledPayload));
  assert("qualified round awards top 4 winners", settledPayload.winners.length === 4, JSON.stringify(settledPayload.winners));
  assert("qualified round assigns bottom 6 liabilities", settledPayload.liabilities.length === 6, JSON.stringify(settledPayload.liabilities));
  assert("winner payouts match release amounts", settledPayload.winners.map((entry) => entry.amount).join(",") === RELEASE_PAYOUTS.join(","), JSON.stringify(settledPayload.winners));
  assert("liability amounts match release schedule", settledPayload.liabilities.map((entry) => entry.amount).join(",") === RELEASE_LIABILITIES.join(","), JSON.stringify(settledPayload.liabilities));
  assert("liabilities start as due with zero amountPaid", settledPayload.liabilities.every((entry) => entry.status === "due" && entry.amountPaid === 0), JSON.stringify(settledPayload.liabilities));
}

console.log(`\n════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
