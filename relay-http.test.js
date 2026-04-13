"use strict";

/**
 * HTTP endpoint tests for leaderboard-relay.js.
 * Runs the relay on a test port and replaces RPC fetch calls with an
 * in-memory name service so endpoint behavior can be tested deterministically.
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const TEST_PORT = 8788;
const BASE = `http://127.0.0.1:${TEST_PORT}/api`;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

let relayProc = null;

function computeFileHash(fileName) {
  const filePath = path.join(__dirname, fileName);
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function startRelay(initialStore = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const serializedStore = JSON.stringify(initialStore).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const relayPath = path.join(__dirname, "leaderboard-relay.js").replace(/\\/g, "\\\\");
    const wrapperCode = `
      const initialEntries = JSON.parse('${serializedStore}');
      const state = new Map(Object.entries(initialEntries));

      function buildJsonResponse(payload, status = 200) {
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() {
            return payload;
          }
        };
      }

      global.fetch = async (_url, options = {}) => {
        const rpcRequest = JSON.parse(options.body || '{}');
        const params = Array.isArray(rpcRequest.params) ? rpcRequest.params : [];

        if (rpcRequest.method === 'getblockcount') {
          return buildJsonResponse({ result: 12345 });
        }

        if (rpcRequest.method === 'name_show') {
          const targetName = params[0];
          if (!state.has(targetName)) {
            return buildJsonResponse({ error: { code: -4, message: 'name not found' } });
          }
          return buildJsonResponse({ result: { name: targetName, value: state.get(targetName) } });
        }

        if (rpcRequest.method === 'name_register') {
          const targetName = params[0];
          const targetValue = params[1];
          if (!state.has(targetName)) {
            state.set(targetName, targetValue);
          }
          return buildJsonResponse({ result: 'registered' });
        }

        if (rpcRequest.method === 'name_update') {
          const targetName = params[0];
          const targetValue = params[1];
          if (!state.has(targetName)) {
            return buildJsonResponse({ error: { code: -4, message: 'name not found' } });
          }
          state.set(targetName, targetValue);
          return buildJsonResponse({ result: 'updated' });
        }

        if (rpcRequest.method === 'name_scan') {
          const cursor = String(params[0] || '');
          const pageSize = Number(params[1]) || 100;
          const rows = Array.from(state.entries())
            .map(([name, value]) => ({ name, value }))
            .sort((leftRow, rightRow) => leftRow.name.localeCompare(rightRow.name))
            .filter((row) => row.name >= cursor)
            .slice(0, pageSize);
          return buildJsonResponse({ result: rows });
        }

        if (rpcRequest.method === 'sendtoname') {
          const targetName = String(params[0] || '');
          const amount = Number(params[1]);
          if (!targetName.startsWith('p/')) {
            return buildJsonResponse({ error: { code: -8, message: 'invalid destination name' } });
          }
          if (!Number.isFinite(amount) || amount <= 0) {
            return buildJsonResponse({ error: { code: -8, message: 'invalid amount' } });
          }
          if (targetName === 'p/payoutfail') {
            return buildJsonResponse({ error: { code: -6, message: 'insufficient funds' } });
          }
          return buildJsonResponse({ result: 'txid-' + targetName.slice(2) });
        }

        if (rpcRequest.method === 'getaddressbalance') {
          const targetAddress = String(params[0] || '');
          if (targetAddress !== 'RH6CVe24Zf9HqUq6AktYeBLhVeuHBjzL29') {
            return buildJsonResponse({ error: { code: -5, message: 'invalid address' } });
          }
          if (state.has('__potBalanceRaw')) {
            return buildJsonResponse({ result: state.get('__potBalanceRaw') });
          }
          const configuredBalance = Number(state.get('__potBalance') || 0);
          return buildJsonResponse({ result: { balance: configuredBalance } });
        }

        return buildJsonResponse({ error: { code: -32601, message: 'Unknown RPC method' } });
      };

      const origHttp = require('http');
      const origCreate = origHttp.createServer.bind(origHttp);
      origHttp.createServer = (...args) => {
        const srv = origCreate(...args);
        const origListen = srv.listen.bind(srv);
        srv.listen = (_port, _host, cb) => origListen(${TEST_PORT}, _host, cb);
        return srv;
      };

      require('${relayPath}');
    `;

    relayProc = spawn(process.execPath, ["-e", wrapperCode], {
      env: {
        ...process.env,
        RELAY_INTEGRITY_MODE: options.integrityMode || "dev"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let started = false;
    relayProc.stdout.on("data", (data) => {
      if (!started && data.toString().includes("listening")) {
        started = true;
        resolve();
      }
    });
    relayProc.stderr.on("data", () => {});
    relayProc.on("error", reject);

    setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 1500);
  });
}

function stopRelay() {
  if (relayProc) {
    relayProc.kill();
    relayProc = null;
  }
}

async function waitForRelay(maxMs = 3000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxMs) {
    try {
      await request("GET", "/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

function createRecordValue(handle, scoresByDifficulty) {
  const payloadObject = {
    handle,
    scores: scoresByDifficulty
  };
  const encodedPayload = Buffer.from(JSON.stringify(payloadObject), "utf8").toString("base64");
  const salt = crypto
    .createHash("sha256")
    .update(`voidrunner3d:${handle}:${JSON.stringify(scoresByDifficulty)}`)
    .digest("hex")
    .slice(0, 16);
  const digest = crypto
    .createHash("sha256")
    .update(`${handle}:${salt}:${encodedPayload}`)
    .digest("hex");

  return JSON.stringify({
    version: 2,
    game: "voidrunner3d",
    algorithm: "sha256",
    handle,
    salt,
    payload: encodedPayload,
    digest
  });
}

async function withRelay(initialStore, testBlock) {
  await startRelay(initialStore);
  await waitForRelay();
  try {
    await testBlock();
  } finally {
    stopRelay();
  }
}

let passed = 0;
let failed = 0;

function assert(desc, condition, extra = "") {
  if (condition) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${desc}${extra ? " | " + extra : ""}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

async function runTests() {
  section("integrity mode - dev skip verification");
  await withRelay({}, async () => {
    const healthResponse = await request("GET", "/health");
    assert("dev mode health returns 200", healthResponse.status === 200, `got ${healthResponse.status}`);
    assert("dev mode marks integrity as skipped", healthResponse.body?.integrity?.status === "skipped", JSON.stringify(healthResponse.body?.integrity));
    assert("dev mode keeps full write access", healthResponse.body?.integrity?.readOnly === false, JSON.stringify(healthResponse.body?.integrity));

    const registerResponse = await request("POST", "/player/register", { handle: "devmode01" });
    assert("dev mode allows mutating routes", registerResponse.status === 200, `got ${registerResponse.status}`);
  });

  section("integrity mode - warn mismatch enforces read-only");
  await startRelay({}, { integrityMode: "warn" });
  await waitForRelay();
  try {
    const healthResponse = await request("GET", "/health");
    assert("warn mismatch health returns 200", healthResponse.status === 200, `got ${healthResponse.status}`);
    assert("warn mismatch reports degraded read-only", healthResponse.body?.integrity?.status === "degraded-read-only", JSON.stringify(healthResponse.body?.integrity));
    assert("warn mismatch sets readOnly=true", healthResponse.body?.integrity?.readOnly === true, JSON.stringify(healthResponse.body?.integrity));

    const registerResponse = await request("POST", "/player/register", { handle: "warnmode01" });
    assert("warn mismatch blocks mutating routes", registerResponse.status === 503, `got ${registerResponse.status}`);
  } finally {
    stopRelay();
  }

  section("integrity mode - warn verification success keeps full access");
  await startRelay({
    "g/voidrunner3d/gamehash": computeFileHash("index.html"),
    "g/voidrunner3d/relayhash": computeFileHash("leaderboard-relay.exe")
  }, { integrityMode: "warn" });
  await waitForRelay();
  try {
    const healthResponse = await request("GET", "/health");
    assert("warn success health returns 200", healthResponse.status === 200, `got ${healthResponse.status}`);
    assert("warn success reports verified", healthResponse.body?.integrity?.status === "verified", JSON.stringify(healthResponse.body?.integrity));
    assert("warn success keeps readOnly=false", healthResponse.body?.integrity?.readOnly === false, JSON.stringify(healthResponse.body?.integrity));

    const registerResponse = await request("POST", "/player/register", { handle: "warnok01" });
    assert("warn success allows mutating routes", registerResponse.status === 200, `got ${registerResponse.status}`);
  } finally {
    stopRelay();
  }

  section("integrity mode - strict failure blocks startup");
  await startRelay({}, { integrityMode: "strict" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const strictProbe = await new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: "/api/health",
      method: "GET"
    }, (res) => resolve({ status: res.statusCode }));
    req.on("error", (error) => resolve({ status: -1, error: error.code || error.message }));
    req.end();
  });
  assert("strict failure keeps relay unavailable", strictProbe.status === -1, JSON.stringify(strictProbe));
  stopRelay();

  section("CORS preflight OPTIONS");
  await withRelay({}, async () => {
    const res = await request("OPTIONS", "/health");
    assert("OPTIONS /api/health returns 204", res.status === 204, `got ${res.status}`);
  });

  section("GET /api/health");
  await withRelay({}, async () => {
    const res = await request("GET", "/health");
    assert("health returns 200 when RPC probe succeeds", res.status === 200, `got ${res.status}`);
    assert("health body ok is true", res.body?.ok === true, JSON.stringify(res.body));
    assert("health reports relay up", res.body?.relay === "up", JSON.stringify(res.body));
    assert("health reports node up", res.body?.node === "up", JSON.stringify(res.body));
  });

  section("GET /api/leaderboard - validation");
  await withRelay({}, async () => {
    const missingDifficultyResponse = await request("GET", "/leaderboard");
    assert("missing difficulty returns 400", missingDifficultyResponse.status === 400, `got ${missingDifficultyResponse.status}`);
    assert("missing difficulty returns explicit error text", typeof missingDifficultyResponse.body?.error === "string");

    const invalidDifficultyResponse = await request("GET", "/leaderboard?difficulty=ultra");
    assert("invalid difficulty returns 400", invalidDifficultyResponse.status === 400, `got ${invalidDifficultyResponse.status}`);
  });

  section("player registration flow");
  await withRelay({}, async () => {
    const invalidHandleResponse = await request("POST", "/player/register", { handle: "!!" });
    assert("invalid register handle returns 400", invalidHandleResponse.status === 400, `got ${invalidHandleResponse.status}`);
    assert("invalid register handle returns explicit error text", invalidHandleResponse.body?.error === "Invalid handle", JSON.stringify(invalidHandleResponse.body));

    const registerResponse = await request("POST", "/player/register", { handle: "pilot01" });
    assert("valid registration returns 200", registerResponse.status === 200, `got ${registerResponse.status}`);
    assert("registration marks identity as registered", registerResponse.body?.player?.identityRegistered === true, JSON.stringify(registerResponse.body));
    assert("registration marks record as registered", registerResponse.body?.player?.recordRegistered === true, JSON.stringify(registerResponse.body));
    assert("registration allows future submissions", registerResponse.body?.player?.canSubmit === true, JSON.stringify(registerResponse.body));
    assert("registration returns p/<handle> identity name", registerResponse.body?.player?.identityName === "p/pilot01", JSON.stringify(registerResponse.body));
    assert("registration returns player-owned record name", registerResponse.body?.player?.recordName === "g/voidrunner3d/pilot01/record", JSON.stringify(registerResponse.body));
    assert("newly registered player starts with no easy score", registerResponse.body?.player?.scores?.easy === null, JSON.stringify(registerResponse.body?.player?.scores));

    const repeatRegisterResponse = await request("POST", "/player/register", { handle: "pilot01" });
    assert("duplicate handle registration returns 409", repeatRegisterResponse.status === 409, `got ${repeatRegisterResponse.status}`);
    assert("re-registering preserves record linkage", repeatRegisterResponse.body?.player?.recordName === "g/voidrunner3d/pilot01/record", JSON.stringify(repeatRegisterResponse.body));
  });

  section("GET /api/player/status");
  await withRelay({
    "p/pilot02": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "pilot02", recordName: "g/voidrunner3d/pilot02/record" }),
    "g/voidrunner3d/pilot02/record": createRecordValue("pilot02", {
      easy: { score: 18.5, updatedAt: 1200 }
    })
  }, async () => {
    const invalidHandleResponse = await request("GET", "/player/status?handle=!!");
    assert("invalid status handle returns 400", invalidHandleResponse.status === 400, `got ${invalidHandleResponse.status}`);

    const unregisteredStatusResponse = await request("GET", "/player/status?handle=ghost01");
    assert("unregistered handle status returns 200", unregisteredStatusResponse.status === 200, `got ${unregisteredStatusResponse.status}`);
    assert("unregistered handle reports identityRegistered false", unregisteredStatusResponse.body?.player?.identityRegistered === false, JSON.stringify(unregisteredStatusResponse.body));
    assert("unregistered handle reports recordRegistered false", unregisteredStatusResponse.body?.player?.recordRegistered === false, JSON.stringify(unregisteredStatusResponse.body));
    assert("unregistered handle cannot submit", unregisteredStatusResponse.body?.player?.canSubmit === false, JSON.stringify(unregisteredStatusResponse.body));
    assert("unregistered handle still returns derived record name", unregisteredStatusResponse.body?.player?.recordName === "g/voidrunner3d/ghost01/record", JSON.stringify(unregisteredStatusResponse.body));
    assert("unregistered handle keeps requested handle in response", unregisteredStatusResponse.body?.player?.handle === "ghost01", JSON.stringify(unregisteredStatusResponse.body));

    const registeredStatusResponse = await request("GET", "/player/status?handle=pilot02");
    assert("registered handle status returns 200", registeredStatusResponse.status === 200, `got ${registeredStatusResponse.status}`);
    assert("registered handle reports identityRegistered true", registeredStatusResponse.body?.player?.identityRegistered === true, JSON.stringify(registeredStatusResponse.body));
    assert("registered handle reports recordRegistered true", registeredStatusResponse.body?.player?.recordRegistered === true, JSON.stringify(registeredStatusResponse.body));
    assert("registered handle can submit", registeredStatusResponse.body?.player?.canSubmit === true, JSON.stringify(registeredStatusResponse.body));
    assert("registered handle exposes linked record name", registeredStatusResponse.body?.player?.recordName === "g/voidrunner3d/pilot02/record", JSON.stringify(registeredStatusResponse.body));
    assert("registered handle exposes stored easy score", registeredStatusResponse.body?.player?.scores?.easy?.score === 18.5, JSON.stringify(registeredStatusResponse.body?.player?.scores));
  });

  section("POST /api/leaderboard/submit - validation and registration guard");
  await withRelay({}, async () => {
    const emptyBodyResponse = await request("POST", "/leaderboard/submit", {});
    assert("empty submit body returns 400", emptyBodyResponse.status === 400, `got ${emptyBodyResponse.status}`);
    assert("empty submit body returns explicit error text", typeof emptyBodyResponse.body?.error === "string");

    const invalidHandleResponse = await request("POST", "/leaderboard/submit", {
      handle: "!!",
      difficulty: "normal",
      score: 10
    });
    assert("invalid submit handle returns 400", invalidHandleResponse.status === 400, `got ${invalidHandleResponse.status}`);

    const negativeScoreResponse = await request("POST", "/leaderboard/submit", {
      handle: "pilot01",
      difficulty: "normal",
      score: -5
    });
    assert("negative submit score returns 400", negativeScoreResponse.status === 400, `got ${negativeScoreResponse.status}`);

    const invalidDifficultyResponse = await request("POST", "/leaderboard/submit", {
      handle: "pilot01",
      difficulty: "invalid",
      score: 50
    });
    assert("invalid submit difficulty returns 400", invalidDifficultyResponse.status === 400, `got ${invalidDifficultyResponse.status}`);

    const oversizedScoreResponse = await request("POST", "/leaderboard/submit", {
      handle: "pilot01",
      difficulty: "normal",
      score: 99999
    });
    assert("submit score above max returns 400", oversizedScoreResponse.status === 400, `got ${oversizedScoreResponse.status}`);

    const unregisteredSubmitResponse = await request("POST", "/leaderboard/submit", {
      handle: "pilot01",
      difficulty: "hard",
      score: 123.5
    });
    assert("unregistered submit returns 409", unregisteredSubmitResponse.status === 409, `got ${unregisteredSubmitResponse.status}`);
    assert("unregistered submit returns explicit registration error", unregisteredSubmitResponse.body?.error === "Player is not fully registered", JSON.stringify(unregisteredSubmitResponse.body));
  });

  section("POST /api/leaderboard/submit - player-owned record updates");
  await withRelay({
    "p/pilot01": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "pilot01", recordName: "g/voidrunner3d/pilot01/record" }),
    "g/voidrunner3d/pilot01/record": createRecordValue("pilot01", {
      easy: { score: 10, updatedAt: 1000 },
      normal: { score: 8, updatedAt: 900 }
    }),
    "p/pilot02": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "pilot02", recordName: "g/voidrunner3d/pilot02/record" }),
    "g/voidrunner3d/pilot02/record": createRecordValue("pilot02", {
      easy: { score: 16, updatedAt: 1100 },
      normal: { score: 14, updatedAt: 1200 }
    })
  }, async () => {
    const higherScoreResponse = await request("POST", "/leaderboard/submit", {
      handle: "pilot01",
      difficulty: "easy",
      score: 20
    });
    assert("registered submit returns 200", higherScoreResponse.status === 200, `got ${higherScoreResponse.status}`);
    assert("submit response includes updated player easy score", higherScoreResponse.body?.player?.scores?.easy?.score === 20, JSON.stringify(higherScoreResponse.body));
    assert("submit response preserves another difficulty on same record", higherScoreResponse.body?.player?.scores?.normal?.score === 8, JSON.stringify(higherScoreResponse.body?.player?.scores));
    assert("submit response leaderboard includes the submitting player", higherScoreResponse.body?.entries?.some((entry) => entry.handle === "pilot01" && entry.score === 20), JSON.stringify(higherScoreResponse.body?.entries));

    const lowerScoreResponse = await request("POST", "/leaderboard/submit", {
      handle: "pilot01",
      difficulty: "easy",
      score: 19
    });
    assert("lower follow-up score still returns 200", lowerScoreResponse.status === 200, `got ${lowerScoreResponse.status}`);
    assert("lower follow-up score does not replace the best easy score", lowerScoreResponse.body?.player?.scores?.easy?.score === 20, JSON.stringify(lowerScoreResponse.body?.player?.scores));

    const otherPlayerStatusResponse = await request("GET", "/player/status?handle=pilot02");
    assert("other player's status still returns 200", otherPlayerStatusResponse.status === 200, `got ${otherPlayerStatusResponse.status}`);
    assert("other player's easy score remains unchanged", otherPlayerStatusResponse.body?.player?.scores?.easy?.score === 16, JSON.stringify(otherPlayerStatusResponse.body?.player?.scores));
    assert("other player's normal score remains unchanged", otherPlayerStatusResponse.body?.player?.scores?.normal?.score === 14, JSON.stringify(otherPlayerStatusResponse.body?.player?.scores));
  });

  section("GET /api/leaderboard - aggregation from scanned player records");
  await withRelay({
    "g/voidrunner3d/easy": JSON.stringify({ entries: [["OLD", 999, 1]] }),
    "p/p00": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p00", recordName: "g/voidrunner3d/p00/record" }),
    "g/voidrunner3d/p00/record": createRecordValue("p00", { easy: { score: 5, updatedAt: 100 } }),
    "p/p01": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p01", recordName: "g/voidrunner3d/p01/record" }),
    "g/voidrunner3d/p01/record": createRecordValue("p01", { easy: { score: 12, updatedAt: 101 } }),
    "p/p02": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p02", recordName: "g/voidrunner3d/p02/record" }),
    "g/voidrunner3d/p02/record": createRecordValue("p02", { easy: { score: 18, updatedAt: 102 } }),
    "p/p03": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p03", recordName: "g/voidrunner3d/p03/record" }),
    "g/voidrunner3d/p03/record": createRecordValue("p03", { easy: { score: 11, updatedAt: 103 } }),
    "p/p04": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p04", recordName: "g/voidrunner3d/p04/record" }),
    "g/voidrunner3d/p04/record": createRecordValue("p04", { easy: { score: 17, updatedAt: 104 } }),
    "p/p05": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p05", recordName: "g/voidrunner3d/p05/record" }),
    "g/voidrunner3d/p05/record": createRecordValue("p05", { easy: { score: 7, updatedAt: 105 } }),
    "p/p06": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p06", recordName: "g/voidrunner3d/p06/record" }),
    "g/voidrunner3d/p06/record": createRecordValue("p06", { easy: { score: 19, updatedAt: 106 } }),
    "p/p07": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p07", recordName: "g/voidrunner3d/p07/record" }),
    "g/voidrunner3d/p07/record": createRecordValue("p07", { easy: { score: 13, updatedAt: 107 } }),
    "p/p08": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p08", recordName: "g/voidrunner3d/p08/record" }),
    "g/voidrunner3d/p08/record": createRecordValue("p08", { easy: { score: 9, updatedAt: 108 } }),
    "p/p09": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p09", recordName: "g/voidrunner3d/p09/record" }),
    "g/voidrunner3d/p09/record": createRecordValue("p09", { easy: { score: 16, updatedAt: 109 } }),
    "p/p10": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p10", recordName: "g/voidrunner3d/p10/record" }),
    "g/voidrunner3d/p10/record": createRecordValue("p10", { easy: { score: 14, updatedAt: 110 } }),
    "p/p11": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p11", recordName: "g/voidrunner3d/p11/record" }),
    "g/voidrunner3d/p11/record": createRecordValue("p11", { easy: { score: 8, updatedAt: 111 } }),
    "g/voidrunner3d/badjson/record": "{broken json}",
    "g/voidrunner3d/mismatch/record": createRecordValue("other", { easy: { score: 999, updatedAt: 999 } }),
    "g/voidrunner3d/missing-score/record": createRecordValue("missing-score", { easy: { updatedAt: 500 } }),
    "g/voidrunner3d/tampered/record": (() => {
      const encodedRecord = JSON.parse(createRecordValue("tampered", { easy: { score: 4, updatedAt: 112 } }));
      encodedRecord.payload = Buffer.from(JSON.stringify({
        handle: "tampered",
        scores: { easy: { score: 999, updatedAt: 112 } }
      }), "utf8").toString("base64");
      return JSON.stringify(encodedRecord);
    })(),
    "g/voidrunner3d/not-a-record/profile": createRecordValue("not-a-record", { easy: { score: 777, updatedAt: 777 } })
  }, async () => {
    const leaderboardResponse = await request("GET", "/leaderboard?difficulty=easy");
    assert("leaderboard request returns 200", leaderboardResponse.status === 200, `got ${leaderboardResponse.status}`);
    assert("leaderboard response ok is true", leaderboardResponse.body?.ok === true, JSON.stringify(leaderboardResponse.body));
    assert("leaderboard response difficulty echoes easy", leaderboardResponse.body?.difficulty === "easy", JSON.stringify(leaderboardResponse.body));
    assert("leaderboard response returns exactly 10 entries", leaderboardResponse.body?.entries?.length === 10, JSON.stringify(leaderboardResponse.body?.entries));
    assert("leaderboard ignores removed shared snapshot names", !leaderboardResponse.body?.entries?.some((entry) => entry.name === "OLD"), JSON.stringify(leaderboardResponse.body?.entries));
    assert("leaderboard rank 1 is the highest scanned player score", leaderboardResponse.body?.entries?.[0]?.handle === "p06", JSON.stringify(leaderboardResponse.body?.entries));
    assert("leaderboard rank 10 keeps the lowest surviving top-10 score", leaderboardResponse.body?.entries?.[9]?.score === 8, JSON.stringify(leaderboardResponse.body?.entries?.[9]));
    assert("leaderboard safely ignores malformed or incomplete scanned records", !leaderboardResponse.body?.entries?.some((entry) => entry.handle === "badjson" || entry.handle === "mismatch" || entry.handle === "missing-score" || entry.handle === "tampered"), JSON.stringify(leaderboardResponse.body?.entries));
  });

  section("GET /api/leaderboard/rank - featured normal rank context MVP");
  await withRelay({
    "p/p00": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p00", recordName: "g/voidrunner3d/p00/record" }),
    "g/voidrunner3d/p00/record": createRecordValue("p00", { normal: { score: 40, updatedAt: 100 } }),
    "p/p01": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p01", recordName: "g/voidrunner3d/p01/record" }),
    "g/voidrunner3d/p01/record": createRecordValue("p01", { normal: { score: 35, updatedAt: 101 } }),
    "p/p02": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p02", recordName: "g/voidrunner3d/p02/record" }),
    "g/voidrunner3d/p02/record": createRecordValue("p02", { normal: { score: 30, updatedAt: 102 } }),
    "p/p03": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p03", recordName: "g/voidrunner3d/p03/record" }),
    "g/voidrunner3d/p03/record": createRecordValue("p03", { normal: { score: 25, updatedAt: 103 } }),
    "p/p04": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p04", recordName: "g/voidrunner3d/p04/record" }),
    "g/voidrunner3d/p04/record": createRecordValue("p04", { normal: { score: 20, updatedAt: 104 } }),
    "p/p05": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p05", recordName: "g/voidrunner3d/p05/record" }),
    "g/voidrunner3d/p05/record": createRecordValue("p05", { normal: { score: 19, updatedAt: 105 } }),
    "p/p06": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p06", recordName: "g/voidrunner3d/p06/record" }),
    "g/voidrunner3d/p06/record": createRecordValue("p06", { normal: { score: 18, updatedAt: 106 } }),
    "p/p07": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p07", recordName: "g/voidrunner3d/p07/record" }),
    "g/voidrunner3d/p07/record": createRecordValue("p07", { normal: { score: 17, updatedAt: 107 } }),
    "p/p08": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p08", recordName: "g/voidrunner3d/p08/record" }),
    "g/voidrunner3d/p08/record": createRecordValue("p08", { normal: { score: 16, updatedAt: 108 } }),
    "p/p09": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p09", recordName: "g/voidrunner3d/p09/record" }),
    "g/voidrunner3d/p09/record": createRecordValue("p09", { normal: { score: 15, updatedAt: 109 } }),
    "p/p10": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p10", recordName: "g/voidrunner3d/p10/record" }),
    "g/voidrunner3d/p10/record": createRecordValue("p10", { normal: { score: 14, updatedAt: 110 } }),
    "p/pilot01": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "pilot01", recordName: "g/voidrunner3d/pilot01/record" }),
    "g/voidrunner3d/pilot01/record": createRecordValue("pilot01", { normal: { score: 10, updatedAt: 111 } })
  }, async () => {
    const invalidHandleResponse = await request("GET", "/leaderboard/rank?handle=!!");
    assert("invalid rank handle returns 400", invalidHandleResponse.status === 400, `got ${invalidHandleResponse.status}`);

    const rankedResponse = await request("GET", "/leaderboard/rank?handle=p01");
    assert("rank endpoint returns 200 for ranked handle", rankedResponse.status === 200, `got ${rankedResponse.status}`);
    assert("rank endpoint uses normal as featured difficulty", rankedResponse.body?.featuredDifficulty === "normal", JSON.stringify(rankedResponse.body));
    assert("rank endpoint returns ranked player position", rankedResponse.body?.player?.rank === 2, JSON.stringify(rankedResponse.body?.player));
    assert("rank endpoint returns delta to next rank", rankedResponse.body?.deltas?.toNextRank === 5, JSON.stringify(rankedResponse.body?.deltas));
    assert("rank endpoint returns leader target", rankedResponse.body?.targets?.leader?.handle === "p00", JSON.stringify(rankedResponse.body?.targets));
    assert("rank endpoint returns compact top list of 10", rankedResponse.body?.top?.length === 10, JSON.stringify(rankedResponse.body?.top));

    const outsideTopResponse = await request("GET", "/leaderboard/rank?handle=pilot01");
    assert("outside-top player still receives global rank", outsideTopResponse.body?.player?.rank === 12, JSON.stringify(outsideTopResponse.body?.player));
    assert("outside-top player is flagged as not in top list", outsideTopResponse.body?.player?.inTopList === false, JSON.stringify(outsideTopResponse.body?.player));
    assert("outside-top player gets delta to enter top list", outsideTopResponse.body?.deltas?.toTopList === 5, JSON.stringify(outsideTopResponse.body?.deltas));
  });

  section("GET /api/leaderboard/rank - empty and unranked behavior MVP");
  await withRelay({}, async () => {
    const emptyRankResponse = await request("GET", "/leaderboard/rank?handle=ghost01");
    assert("empty rank request returns 200", emptyRankResponse.status === 200, `got ${emptyRankResponse.status}`);
    assert("empty rank response returns empty top list", Array.isArray(emptyRankResponse.body?.top) && emptyRankResponse.body.top.length === 0, JSON.stringify(emptyRankResponse.body));
    assert("empty rank response sets player rank null", emptyRankResponse.body?.player?.rank === null, JSON.stringify(emptyRankResponse.body?.player));
    assert("empty rank response sets player score null", emptyRankResponse.body?.player?.score === null, JSON.stringify(emptyRankResponse.body?.player));
    assert("empty rank response keeps delta values null", emptyRankResponse.body?.deltas?.toLeader === null && emptyRankResponse.body?.deltas?.toNextRank === null && emptyRankResponse.body?.deltas?.toTopList === null, JSON.stringify(emptyRankResponse.body?.deltas));
  });

  section("POST /api/prizes and GET /api/prizes/latest - MVP prize history");
  await withRelay({}, async () => {
    const invalidTypeResponse = await request("GET", "/prizes/latest?type=monthly");
    assert("invalid prize type returns 400", invalidTypeResponse.status === 400, `got ${invalidTypeResponse.status}`);

    const missingPrizeResponse = await request("GET", "/prizes/latest?type=hourly");
    assert("missing latest prize returns 404", missingPrizeResponse.status === 404, `got ${missingPrizeResponse.status}`);
    assert("missing latest prize reports scan fallback strategy", missingPrizeResponse.body?.strategy === "scan-max-index", JSON.stringify(missingPrizeResponse.body));

    const invalidPrizePayloadResponse = await request("POST", "/prizes", {
      version: 1,
      type: "hourly",
      index: 0,
      winner: "pilot01",
      score: 10,
      difficulty: "easy",
      blockStart: 1,
      blockEnd: 2,
      paid: true,
      timestamp: 1000
    });
    assert("invalid paid prize payload without txid returns 400", invalidPrizePayloadResponse.status === 400, `got ${invalidPrizePayloadResponse.status}`);

    const writeFirstPrizeResponse = await request("POST", "/prizes", {
      version: 1,
      type: "hourly",
      index: 0,
      winner: "Pilot01",
      score: 20.5,
      difficulty: "normal",
      blockStart: 100,
      blockEnd: 110,
      paid: false,
      txid: null,
      paidAtHeight: null,
      timestamp: 1710000000000
    });
    assert("valid prize write returns 200", writeFirstPrizeResponse.status === 200, `got ${writeFirstPrizeResponse.status}`);
    assert("prize write returns write strategy", writeFirstPrizeResponse.body?.strategy === "write-record-and-pointer", JSON.stringify(writeFirstPrizeResponse.body));
    assert("prize write normalizes winner handle", writeFirstPrizeResponse.body?.prize?.winner === "pilot01", JSON.stringify(writeFirstPrizeResponse.body?.prize));

    const readLatestAfterFirstWriteResponse = await request("GET", "/prizes/latest?type=hourly");
    assert("latest prize read after first write returns 200", readLatestAfterFirstWriteResponse.status === 200, `got ${readLatestAfterFirstWriteResponse.status}`);
    assert("latest prize read uses pointer strategy", readLatestAfterFirstWriteResponse.body?.strategy === "pointer", JSON.stringify(readLatestAfterFirstWriteResponse.body));
    assert("latest prize index is 0", readLatestAfterFirstWriteResponse.body?.prize?.index === 0, JSON.stringify(readLatestAfterFirstWriteResponse.body?.prize));

    const writeSecondPrizeResponse = await request("POST", "/prizes", {
      version: 1,
      type: "hourly",
      index: 1,
      winner: "pilot02",
      score: 30,
      difficulty: "hard",
      blockStart: 111,
      blockEnd: 120,
      paid: true,
      txid: "tx-123",
      paidAtHeight: 121,
      timestamp: 1710000010000
    });
    assert("second prize write returns 200", writeSecondPrizeResponse.status === 200, `got ${writeSecondPrizeResponse.status}`);

    const readLatestAfterSecondWriteResponse = await request("GET", "/prizes/latest?type=hourly");
    assert("latest prize index follows latest pointer update", readLatestAfterSecondWriteResponse.body?.prize?.index === 1, JSON.stringify(readLatestAfterSecondWriteResponse.body?.prize));
    assert("latest prize returns paid txid", readLatestAfterSecondWriteResponse.body?.prize?.txid === "tx-123", JSON.stringify(readLatestAfterSecondWriteResponse.body?.prize));
  });

  section("GET /api/prize-window/status - block countdown MVP");
  await withRelay({}, async () => {
    const invalidPrizeTypeResponse = await request("GET", "/prize-window/status?type=monthly");
    assert("invalid prize window type returns 400", invalidPrizeTypeResponse.status === 400, `got ${invalidPrizeTypeResponse.status}`);
    assert("invalid prize window type returns explicit error", invalidPrizeTypeResponse.body?.error === "Invalid prize type", JSON.stringify(invalidPrizeTypeResponse.body));

    const hourlyStatusResponse = await request("GET", "/prize-window/status?type=hourly");
    assert("hourly prize window status returns 200", hourlyStatusResponse.status === 200, `got ${hourlyStatusResponse.status}`);
    assert("hourly status echoes type", hourlyStatusResponse.body?.type === "hourly", JSON.stringify(hourlyStatusResponse.body));
    assert("hourly status includes mocked current block height", hourlyStatusResponse.body?.currentBlockHeight === 12345, JSON.stringify(hourlyStatusResponse.body));
    assert("hourly status window index is derived from block height", hourlyStatusResponse.body?.currentWindowIndex === 102, JSON.stringify(hourlyStatusResponse.body));
    assert("hourly status window size is 120", hourlyStatusResponse.body?.windowSize === 120, JSON.stringify(hourlyStatusResponse.body));
    assert("hourly status blocksRemaining is 14", hourlyStatusResponse.body?.blocksRemaining === 14, JSON.stringify(hourlyStatusResponse.body));
    assert("hourly status percentComplete is rounded to 3 decimals", hourlyStatusResponse.body?.percentComplete === 88.333, JSON.stringify(hourlyStatusResponse.body));
  });

  section("GET /api/pot/status - MVP funding address balance visibility");
  await withRelay({
    __potBalance: 1.25
  }, async () => {
    const fundedResponse = await request("GET", "/pot/status");
    assert("pot status returns 200", fundedResponse.status === 200, `got ${fundedResponse.status}`);
    assert("pot status includes fixed funding address", fundedResponse.body?.address === "RH6CVe24Zf9HqUq6AktYeBLhVeuHBjzL29", JSON.stringify(fundedResponse.body));
    assert("pot status returns configured balance", fundedResponse.body?.balance === 1.25, JSON.stringify(fundedResponse.body));
    assert("pot status is FULLY_FUNDED when balance >= 1", fundedResponse.body?.status === "FULLY_FUNDED", JSON.stringify(fundedResponse.body));
    assert("pot status reports zero missing amount when fully funded", fundedResponse.body?.missingToTarget === 0, JSON.stringify(fundedResponse.body));
  });

  await withRelay({
    __potBalance: 0.4
  }, async () => {
    const lowResponse = await request("GET", "/pot/status");
    assert("pot status is LOW when balance is between 0 and 1", lowResponse.body?.status === "LOW", JSON.stringify(lowResponse.body));
    assert("pot status exposes missing amount to full funding threshold", lowResponse.body?.missingToTarget === 0.6, JSON.stringify(lowResponse.body));
  });

  await withRelay({
    __potBalance: 0
  }, async () => {
    const unfundedResponse = await request("GET", "/pot/status");
    assert("pot status is UNFUNDED when balance is 0", unfundedResponse.body?.status === "UNFUNDED", JSON.stringify(unfundedResponse.body));
  });

  await withRelay({
    __potBalanceRaw: "NaN"
  }, async () => {
    const invalidBalanceResponse = await request("GET", "/pot/status");
    assert("invalid RPC pot balance keeps endpoint online", invalidBalanceResponse.status === 200, `got ${invalidBalanceResponse.status}`);
    assert("invalid RPC pot balance still exposes funding address", invalidBalanceResponse.body?.address === "RH6CVe24Zf9HqUq6AktYeBLhVeuHBjzL29", JSON.stringify(invalidBalanceResponse.body));
    assert("invalid RPC pot balance marks status UNKNOWN", invalidBalanceResponse.body?.status === "UNKNOWN", JSON.stringify(invalidBalanceResponse.body));
    assert("invalid RPC pot balance marks rpcAvailable false", invalidBalanceResponse.body?.rpcAvailable === false, JSON.stringify(invalidBalanceResponse.body));
    assert("invalid RPC pot balance returns warning message", invalidBalanceResponse.body?.warning === "Invalid pot balance returned by RPC", JSON.stringify(invalidBalanceResponse.body));
  });

  section("GET /api/prizes/latest - scan fallback when latest pointer is stale");
  await withRelay({
    "g/voidrunner3d/prizes/daily/latest": JSON.stringify({ index: 99, updatedAt: 1710001000000 }),
    "g/voidrunner3d/prizes/daily/3": JSON.stringify({
      version: 1,
      type: "daily",
      index: 3,
      winner: "pilot03",
      score: 41,
      difficulty: "easy",
      blockStart: 200,
      blockEnd: 220,
      paid: false,
      txid: null,
      paidAtHeight: null,
      timestamp: 1710000100000
    }),
    "g/voidrunner3d/prizes/daily/4": JSON.stringify({
      version: 1,
      type: "daily",
      index: 4,
      winner: "pilot04",
      score: 51,
      difficulty: "normal",
      blockStart: 221,
      blockEnd: 240,
      paid: true,
      txid: "tx-456",
      paidAtHeight: 241,
      timestamp: 1710000200000
    })
  }, async () => {
    const fallbackReadResponse = await request("GET", "/prizes/latest?type=daily");
    assert("scan fallback read returns 200", fallbackReadResponse.status === 200, `got ${fallbackReadResponse.status}`);
    assert("scan fallback strategy is explicit", fallbackReadResponse.body?.strategy === "scan-max-index", JSON.stringify(fallbackReadResponse.body));
    assert("scan fallback chooses highest prize index", fallbackReadResponse.body?.prize?.index === 4, JSON.stringify(fallbackReadResponse.body?.prize));
  });

  section("POST /api/prizes/close-window - MVP manual payout");
  await withRelay({
    "p/alpha": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "alpha", recordName: "g/voidrunner3d/alpha/record" }),
    "g/voidrunner3d/alpha/record": createRecordValue("alpha", {
      normal: { score: 22, updatedAt: 1001 }
    }),
    "p/bravo": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "bravo", recordName: "g/voidrunner3d/bravo/record" }),
    "g/voidrunner3d/bravo/record": createRecordValue("bravo", {
      normal: { score: 30, updatedAt: 1002 }
    })
  }, async () => {
    const missingAdminKeyResponse = await request("POST", "/prizes/close-window", {
      type: "hourly",
      difficulty: "normal",
      blockStart: 100,
      blockEnd: 110
    });
    assert("close-window without admin key returns 403", missingAdminKeyResponse.status === 403, `got ${missingAdminKeyResponse.status}`);

    const invalidPayloadResponse = await request("POST", "/prizes/close-window", {
      adminKey: "voidrunner3d-mvp-admin",
      type: "monthly",
      difficulty: "normal",
      blockStart: 100,
      blockEnd: 110
    });
    assert("close-window with invalid type returns 400", invalidPayloadResponse.status === 400, `got ${invalidPayloadResponse.status}`);

    const closeWindowResponse = await request("POST", "/prizes/close-window", {
      adminKey: "voidrunner3d-mvp-admin",
      type: "hourly",
      difficulty: "normal",
      blockStart: 100,
      blockEnd: 110,
      payoutAmount: 0.015
    });

    assert("close-window success returns 200", closeWindowResponse.status === 200, `got ${closeWindowResponse.status}`);
    assert("close-window marks payout as paid", closeWindowResponse.body?.payout?.paid === true, JSON.stringify(closeWindowResponse.body));
    assert("close-window winner is top leaderboard handle", closeWindowResponse.body?.prize?.winner === "bravo", JSON.stringify(closeWindowResponse.body?.prize));
    assert("close-window stores txid from sendtoname", closeWindowResponse.body?.prize?.txid === "txid-bravo", JSON.stringify(closeWindowResponse.body?.prize));

    const latestPrizeResponse = await request("GET", "/prizes/latest?type=hourly");
    assert("latest prize after close-window returns 200", latestPrizeResponse.status === 200, `got ${latestPrizeResponse.status}`);
    assert("latest prize reflects successful payout", latestPrizeResponse.body?.prize?.paid === true && latestPrizeResponse.body?.prize?.txid === "txid-bravo", JSON.stringify(latestPrizeResponse.body?.prize));
  });

  section("POST /api/prizes/close-window - payout failure still writes failed prize record");
  await withRelay({
    "p/payoutfail": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "payoutfail", recordName: "g/voidrunner3d/payoutfail/record" }),
    "g/voidrunner3d/payoutfail/record": createRecordValue("payoutfail", {
      hard: { score: 77, updatedAt: 2001 }
    }),
    "p/runnerup": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "runnerup", recordName: "g/voidrunner3d/runnerup/record" }),
    "g/voidrunner3d/runnerup/record": createRecordValue("runnerup", {
      hard: { score: 70, updatedAt: 2000 }
    })
  }, async () => {
    const closeWindowResponse = await request("POST", "/prizes/close-window", {
      adminKey: "voidrunner3d-mvp-admin",
      type: "daily",
      difficulty: "hard",
      blockStart: 300,
      blockEnd: 320
    });

    assert("close-window with payout failure still returns 200", closeWindowResponse.status === 200, `got ${closeWindowResponse.status}`);
    assert("failed payout prize has paid=false", closeWindowResponse.body?.prize?.paid === false, JSON.stringify(closeWindowResponse.body?.prize));
    assert("failed payout prize stores txid=null", closeWindowResponse.body?.prize?.txid === null, JSON.stringify(closeWindowResponse.body?.prize));
    assert("failed payout response includes payout error", typeof closeWindowResponse.body?.payout?.error === "string", JSON.stringify(closeWindowResponse.body?.payout));

    const latestPrizeResponse = await request("GET", "/prizes/latest?type=daily");
    assert("latest daily prize is written after payout failure", latestPrizeResponse.status === 200, `got ${latestPrizeResponse.status}`);
    assert("latest daily prize keeps failed payout fields", latestPrizeResponse.body?.prize?.paid === false && latestPrizeResponse.body?.prize?.txid === null, JSON.stringify(latestPrizeResponse.body?.prize));
  });

  section("404 for unknown routes");
  await withRelay({}, async () => {
    const unknownRouteResponse = await request("GET", "/unknown");
    assert("unknown route returns 404", unknownRouteResponse.status === 404, `got ${unknownRouteResponse.status}`);
    assert("unknown route response ok is false", unknownRouteResponse.body?.ok === false, JSON.stringify(unknownRouteResponse.body));

    const wrongMethodResponse = await request("POST", "/health");
    assert("POST /health returns 404", wrongMethodResponse.status === 404, `got ${wrongMethodResponse.status}`);
  });

  section("POST with invalid JSON body");
  await withRelay({}, async () => {
    const result = await new Promise((resolve) => {
      const options = {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: "/api/leaderboard/submit",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      };
      const req = http.request(options, (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on("error", resolve);
      req.write("{not valid json}");
      req.end();
    });
    assert("malformed JSON body returns 400", result.status === 400, `got ${result.status}`);
    assert("malformed JSON body returns explicit error text", result.body?.error === "Invalid JSON body", JSON.stringify(result.body));
  });

  console.log(`\n════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  stopRelay();
  console.error("Test runner error:", err);
  process.exit(1);
});
