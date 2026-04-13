"use strict";

/**
 * HTTP endpoint tests for leaderboard-relay.js.
 * Runs the relay on a test port and replaces RPC fetch calls with an
 * in-memory name service so endpoint behavior can be tested deterministically.
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

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

async function startRelay(initialStore = {}) {
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
  return JSON.stringify({
    version: 1,
    game: "voidrunner3d",
    handle,
    scores: scoresByDifficulty
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
    "g/voidrunner3d/mismatch/record": JSON.stringify({ handle: "other", scores: { easy: { score: 999, updatedAt: 999 } } }),
    "g/voidrunner3d/missing-score/record": JSON.stringify({ handle: "missing-score", scores: { easy: { updatedAt: 500 } } }),
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
    assert("leaderboard safely ignores malformed or incomplete scanned records", !leaderboardResponse.body?.entries?.some((entry) => entry.handle === "badjson" || entry.handle === "mismatch" || entry.handle === "missing-score"), JSON.stringify(leaderboardResponse.body?.entries));
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
