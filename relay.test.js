"use strict";

// ---- Inline the pure functions from leaderboard-relay.js ----

const MAX_ENTRIES = 10;
const MAX_NAME_LENGTH = 6;
const MAX_SCORE_SECONDS = 86400;

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
  try { parsedValue = JSON.parse(value); } catch { return []; }
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
  normalizedEntries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[2] - a[2];
  });
  return normalizedEntries.slice(0, MAX_ENTRIES);
}

function serializeOnChainEntries(entries) {
  return JSON.stringify(entries.map((e) => [e[0], e[1], e[2]]));
}

function mergeEntries(existingEntries, newName, newScore) {
  const merged = (Array.isArray(existingEntries) ? existingEntries : [])
    .filter((e) => e[0] !== newName);
  merged.push([newName, newScore, Date.now()]);
  merged.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[2] - a[2];
  });
  return merged.slice(0, MAX_ENTRIES);
}

function entryExists(entries, expectedName, expectedScore) {
  return entries.some((e) => e[0] === expectedName && Math.abs(e[1] - expectedScore) < 0.0005);
}

// ---- Mini test runner ----

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

// ---- sanitizePlayerName ----
section("sanitizePlayerName");
assert("accepts simple letters",          sanitizePlayerName("ABC") === "ABC");
assert("uppercases lowercase",             sanitizePlayerName("abc") === "ABC");
assert("strips non-alphanumeric",          sanitizePlayerName("a@#b!") === "AB");
assert("trims to MAX_NAME_LENGTH (6)",     sanitizePlayerName("ABCDEFGH") === "ABCDEF");
assert("returns null for non-string",      sanitizePlayerName(123) === null);
assert("returns null for empty result",    sanitizePlayerName("!!!") === null);
assert("returns null for empty string",    sanitizePlayerName("") === null);
assert("accepts digits",                   sanitizePlayerName("A1B2C3") === "A1B2C3");
assert("strips spaces",                    sanitizePlayerName("A B C") === "ABC");
assert("accepts exactly 6 chars",          sanitizePlayerName("ABCDEF") === "ABCDEF");

// ---- sanitizeScore ----
section("sanitizeScore");
assert("accepts valid integer",            sanitizeScore(120) === 120);
assert("accepts valid float",              sanitizeScore(3.5) === 3.5);
assert("accepts zero",                     sanitizeScore(0) === 0);
assert("accepts max boundary",             sanitizeScore(86400) === 86400);
assert("rejects above max",                sanitizeScore(86401) === null);
assert("rejects negative",                 sanitizeScore(-1) === null);
assert("rejects NaN string",              sanitizeScore("abc") === null);
assert("rejects Infinity",                 sanitizeScore(Infinity) === null);
assert("accepts numeric string",           sanitizeScore("42") === 42);
assert("rounds to 3 decimal places",      sanitizeScore(1.23456789) === 1.235);

// ---- parseOnChainEntries ----
section("parseOnChainEntries");
assert("returns [] for empty string",      parseOnChainEntries("").length === 0);
assert("returns [] for invalid JSON",      parseOnChainEntries("{bad}").length === 0);
assert("returns [] for non-string",        parseOnChainEntries(null).length === 0);
{
  const entries = parseOnChainEntries(JSON.stringify([["AAA", 100, 1000], ["BBB", 200, 2000]]));
  assert("parses array format",            entries.length === 2);
  assert("sorts descending by score",      entries[0][0] === "BBB" && entries[1][0] === "AAA",
    JSON.stringify(entries));
}
{
  const objFormat = JSON.stringify({ entries: [["AAA", 50, 0], ["CCC", 75, 0]] });
  const entries = parseOnChainEntries(objFormat);
  assert("parses object with entries key", entries.length === 2);
  assert("object format sorted correctly", entries[0][0] === "CCC");
}
{
  const many = Array.from({ length: 12 }, (_, i) => [`P${i}`, i + 1, i]);
  const entries = parseOnChainEntries(JSON.stringify(many));
  assert("caps at MAX_ENTRIES=10",         entries.length === 10, `got ${entries.length}`);
  assert("top 10 have highest scores",     entries[0][1] === 12);
}
{
  const bad = parseOnChainEntries(JSON.stringify([["@@@", 10, 0], [null, 5, 0], ["OK", -1, 0]]));
  assert("filters invalid names/scores",   bad.length === 0, JSON.stringify(bad));
}
{
  const tied = JSON.stringify([["AAA", 100, 1000], ["BBB", 100, 2000]]);
  const entries = parseOnChainEntries(tied);
  assert("tie-breaks by timestamp desc",   entries[0][0] === "BBB", JSON.stringify(entries));
}

// ---- serializeOnChainEntries ----
section("serializeOnChainEntries");
{
  const serialized = serializeOnChainEntries([["AAA", 100, 1000]]);
  const back = JSON.parse(serialized);
  assert("roundtrips correctly",           back[0][0] === "AAA" && back[0][1] === 100 && back[0][2] === 1000);
}
assert("empty array serializes to []",    serializeOnChainEntries([]) === "[]");

// ---- mergeEntries ----
section("mergeEntries");
{
  const existing = [["AAA", 100, 1000], ["BBB", 80, 900]];
  const result = mergeEntries(existing, "CCC", 90);
  assert("inserts new entry",              result.some(e => e[0] === "CCC"));
  assert("sorted descending after insert", result[0][1] >= result[1][1] && result[1][1] >= result[2][1]);
}
{
  const existing = [["AAA", 100, 1000]];
  const result = mergeEntries(existing, "AAA", 120);
  assert("replaces existing same-name entry", result.filter(e => e[0] === "AAA").length === 1,
    JSON.stringify(result));
  assert("updated score is used",          result[0][1] === 120, `score=${result[0][1]}`);
}
{
  const full = Array.from({ length: 10 }, (_, i) => [`P${i}`, 100 - i, i]);
  const result = mergeEntries(full, "NEW", 1);
  assert("caps at 10 entries after merge", result.length === 10, `got ${result.length}`);
  assert("lowest score is excluded",       !result.some(e => e[0] === "NEW"), JSON.stringify(result.map(e => e[0])));
}
{
  const result = mergeEntries(null, "AAA", 50);
  assert("handles null existing gracefully", result.length === 1 && result[0][0] === "AAA");
}
{
  const existing = [["ZZZ", 500, 1000], ["AAA", 100, 900]];
  const result = mergeEntries(existing, "AAA", 600);
  assert("updated entry rises to correct rank", result[0][0] === "AAA", JSON.stringify(result));
}

// ---- entryExists ----
section("entryExists");
{
  const entries = [["AAA", 100.0, 0], ["BBB", 50.0, 0]];
  assert("finds exact match",              entryExists(entries, "AAA", 100.0));
  assert("within tolerance match",         entryExists(entries, "AAA", 100.0004));
  assert("outside tolerance no match",     !entryExists(entries, "AAA", 100.001));
  assert("wrong name no match",            !entryExists(entries, "CCC", 100.0));
  assert("empty list returns false",       !entryExists([], "AAA", 100));
}

// ---- Summary ----
console.log(`\n════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
