"use strict";

const GAME_PREFIX = "g/voidrunner3d/";
const MAX_ENTRIES = 10;
const MIN_HANDLE_LENGTH = 3;
const MAX_HANDLE_LENGTH = 24;
const MAX_SCORE_SECONDS = 86400;

const difficultyKeys = Object.freeze({
  easy: true,
  normal: true,
  hard: true
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

section("sanitizeHandle");
assert("accepts lowercase handles", sanitizeHandle("pilot01") === "pilot01");
assert("normalizes uppercase and trims whitespace", sanitizeHandle("  Pilot_01  ") === "pilot_01");
assert("rejects handles shorter than 3 chars", sanitizeHandle("ab") === null);
assert("rejects handles longer than 24 chars", sanitizeHandle("abcdefghijklmnopqrstuvwxyz") === null);
assert("removes unsupported characters", sanitizeHandle("pilot!@#-01") === "pilot-01");

section("parseRecordValue");
{
  const rawRecord = JSON.stringify({
    version: 1,
    game: "voidrunner3d",
    handle: "pilot01",
    scores: {
      easy: { score: 12.3456, updatedAt: 100 },
      normal: { score: 15, updatedAt: 200 },
      hard: { score: -1, updatedAt: 300 }
    }
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
  parseRecordValue(JSON.stringify({ handle: "other", scores: {} }), "pilot01") === null
);
{
  const parsedRecord = parseRecordValue(
    JSON.stringify({
    handle: "pilot01",
    scores: { easy: { score: 11, updatedAt: 42 } }
  }),
    "pilot01"
  );
  assert(
    "retains normalized scores even without display names",
    parsedRecord?.scores.easy?.score === 11,
    JSON.stringify(parsedRecord?.scores.easy)
  );
}

section("serializeRecordValue");
{
  const serializedRecord = serializeRecordValue("pilot01", {
    easy: { score: 20, updatedAt: 100 },
    normal: null,
    hard: { score: 30, updatedAt: 200 }
  });
  const roundTripRecord = JSON.parse(serializedRecord);
  assert("stores the handle in serialized records", roundTripRecord.handle === "pilot01", serializedRecord);
  assert("stores only populated difficulty scores", !roundTripRecord.scores.normal, serializedRecord);
  assert("keeps hard score values during serialization", roundTripRecord.scores.hard.score === 30, serializedRecord);
}

section("best-score-only submission model");
{
  const currentRecord = parseRecordValue(
    JSON.stringify({
      handle: "pilot01",
      scores: {
        easy: { score: 10, updatedAt: 100 },
        normal: { score: 22, updatedAt: 200 }
      }
    }),
    "pilot01"
  );

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
      value: JSON.stringify({
        handle: "different-handle",
        scores: { easy: { score: 999, updatedAt: 999 } }
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

console.log(`\n════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
