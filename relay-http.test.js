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
    const configuredBlockHeight = Number.isInteger(options.blockHeight) && options.blockHeight >= 0
      ? options.blockHeight
      : 12345;
    const serializedStore = JSON.stringify(initialStore).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const ownedNames = Array.isArray(options.ownedNames) ? options.ownedNames : [];
    const serializedOwnedNames = JSON.stringify(ownedNames).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const relayPath = path.join(__dirname, "leaderboard-relay.js").replace(/\\/g, "\\\\");
    const wrapperCode = `
      const initialEntries = JSON.parse('${serializedStore}');
      const state = new Map(Object.entries(initialEntries));
      const ownedNames = new Set(JSON.parse('${serializedOwnedNames}'));

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
          return buildJsonResponse({ result: ${configuredBlockHeight} });
        }

        if (rpcRequest.method === 'name_show') {
          const targetName = params[0];
          if (!state.has(targetName)) {
            return buildJsonResponse({ error: { code: -4, message: 'name not found' } });
          }
          return buildJsonResponse({ result: { name: targetName, value: state.get(targetName), ismine: ownedNames.has(targetName) } });
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

async function withRelayAtHeight(initialStore, blockHeight, testBlock) {
  await startRelay(initialStore, { blockHeight });
  await waitForRelay();
  try {
    await testBlock();
  } finally {
    stopRelay();
  }
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

  section("integrity mode - warn owner bootstrap allows full access when hash names are missing");
  await startRelay({
    "g/voidrunner3d/gamehash": "bootstrap-pending",
    "g/voidrunner3d/relayhash": "bootstrap-pending"
  }, {
    integrityMode: "warn",
    ownedNames: ["g/voidrunner3d/gamehash", "g/voidrunner3d/relayhash"]
  });
  await waitForRelay();
  try {
    const healthResponse = await request("GET", "/health");
    assert("warn owner bootstrap health returns 200", healthResponse.status === 200, `got ${healthResponse.status}`);
    assert("warn owner bootstrap reports skipped-owner-bootstrap", healthResponse.body?.integrity?.status === "skipped-owner-bootstrap", JSON.stringify(healthResponse.body?.integrity));
    assert("warn owner bootstrap keeps readOnly=false", healthResponse.body?.integrity?.readOnly === false, JSON.stringify(healthResponse.body?.integrity));

    const registerResponse = await request("POST", "/player/register", { handle: "ownerboot01" });
    assert("warn owner bootstrap allows mutating routes", registerResponse.status === 200, `got ${registerResponse.status}`);
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

  section("GET /api/player/status with release state");
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
    assert("unregistered handle includes release eligibility block", typeof unregisteredStatusResponse.body?.player?.release?.eligibility?.eligible === "boolean", JSON.stringify(unregisteredStatusResponse.body?.player?.release));

    const registeredStatusResponse = await request("GET", "/player/status?handle=pilot02");
    assert("registered handle status returns 200", registeredStatusResponse.status === 200, `got ${registeredStatusResponse.status}`);
    assert("registered handle reports identityRegistered true", registeredStatusResponse.body?.player?.identityRegistered === true, JSON.stringify(registeredStatusResponse.body));
    assert("registered handle reports recordRegistered true", registeredStatusResponse.body?.player?.recordRegistered === true, JSON.stringify(registeredStatusResponse.body));
    assert("registered handle can submit", registeredStatusResponse.body?.player?.canSubmit === true, JSON.stringify(registeredStatusResponse.body));
    assert("registered handle exposes linked record name", registeredStatusResponse.body?.player?.recordName === "g/voidrunner3d/pilot02/record", JSON.stringify(registeredStatusResponse.body));
    assert("registered handle exposes stored easy score", registeredStatusResponse.body?.player?.scores?.easy?.score === 18.5, JSON.stringify(registeredStatusResponse.body?.player?.scores));
    assert("registered handle release state reports current leg id", Number.isInteger(registeredStatusResponse.body?.player?.release?.currentLegId), JSON.stringify(registeredStatusResponse.body?.player?.release));
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

  section("GET /api/leaderboard/rank - featured normal rank context");
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

  section("GET /api/leaderboard/rank - empty and unranked behavior");
  await withRelay({}, async () => {
    const emptyRankResponse = await request("GET", "/leaderboard/rank?handle=ghost01");
    assert("empty rank request returns 200", emptyRankResponse.status === 200, `got ${emptyRankResponse.status}`);
    assert("empty rank response returns empty top list", Array.isArray(emptyRankResponse.body?.top) && emptyRankResponse.body.top.length === 0, JSON.stringify(emptyRankResponse.body));
    assert("empty rank response sets player rank null", emptyRankResponse.body?.player?.rank === null, JSON.stringify(emptyRankResponse.body?.player));
    assert("empty rank response sets player score null", emptyRankResponse.body?.player?.score === null, JSON.stringify(emptyRankResponse.body?.player));
    assert("empty rank response keeps delta values null", emptyRankResponse.body?.deltas?.toLeader === null && emptyRankResponse.body?.deltas?.toNextRank === null && emptyRankResponse.body?.deltas?.toTopList === null, JSON.stringify(emptyRankResponse.body?.deltas));
  });

  section("legacy MVP economy endpoints removed from public relay");
  await withRelay({}, async () => {
    const legacyLatestResponse = await request("GET", "/prizes/latest?type=hourly");
    assert("legacy /prizes/latest now returns 404", legacyLatestResponse.status === 404, `got ${legacyLatestResponse.status}`);

    const legacyWindowResponse = await request("GET", "/prize-window/status?type=hourly");
    assert("legacy /prize-window/status now returns 404", legacyWindowResponse.status === 404, `got ${legacyWindowResponse.status}`);

    const legacyWriteResponse = await request("POST", "/prizes", { type: "hourly" });
    assert("legacy /prizes write route remains unavailable", legacyWriteResponse.status === 404, `got ${legacyWriteResponse.status}`);
  });

  section("GET /api/pot/status removed from public MVP relay");
  await withRelay({}, async () => {
    const removedEndpointResponse = await request("GET", "/pot/status");
    assert("public pot status endpoint returns 404", removedEndpointResponse.status === 404, `got ${removedEndpointResponse.status}`);
  });

  section("release current round and current leg endpoints");
  await withRelay({
    "p/pilot01": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "pilot01", recordName: "g/voidrunner3d/pilot01/record" }),
    "g/voidrunner3d/pilot01/record": createRecordValue("pilot01", {
      normal: { score: 25, updatedAt: 1000 }
    })
  }, async () => {
    const currentRoundResponse = await request("GET", "/release/current-round");
    assert("current round endpoint returns 200", currentRoundResponse.status === 200, `got ${currentRoundResponse.status}`);
    assert("current round id derived from height", currentRoundResponse.body?.round?.id === 102, JSON.stringify(currentRoundResponse.body?.round));
    assert("current round block start is deterministic", currentRoundResponse.body?.round?.blockStart === 12240, JSON.stringify(currentRoundResponse.body?.round));
    assert("current round block end is deterministic", currentRoundResponse.body?.round?.blockEnd === 12359, JSON.stringify(currentRoundResponse.body?.round));

    const currentLegResponse = await request("GET", "/release/current-leg");
    assert("current leg endpoint returns 200", currentLegResponse.status === 200, `got ${currentLegResponse.status}`);
    assert("current leg id derived from height", currentLegResponse.body?.leg?.id === 8, JSON.stringify(currentLegResponse.body?.leg));
    assert("current leg block start is deterministic", currentLegResponse.body?.leg?.blockStart === 11520, JSON.stringify(currentLegResponse.body?.leg));
    assert("current leg block end is deterministic", currentLegResponse.body?.leg?.blockEnd === 12959, JSON.stringify(currentLegResponse.body?.leg));
  });

  section("release round and leg boundary behavior");
  await withRelay({}, async () => {
    const currentRoundResponse = await request("GET", "/release/current-round");
    const currentLegResponse = await request("GET", "/release/current-leg");

    assert("current round reports blocksRemaining relative to current block", currentRoundResponse.body?.round?.blocksRemaining === 14, JSON.stringify(currentRoundResponse.body?.round));
    assert("current leg reports blocksRemaining relative to current block", currentLegResponse.body?.leg?.blocksRemaining === 614, JSON.stringify(currentLegResponse.body?.leg));
    assert("current round reports leg id aligned with current leg endpoint", currentRoundResponse.body?.round?.legId === currentLegResponse.body?.leg?.id, JSON.stringify({ round: currentRoundResponse.body?.round, leg: currentLegResponse.body?.leg }));
  });

  section("release derivation at exact round and leg boundaries");
  await withRelayAtHeight({}, 119, async () => {
    const currentRoundResponse = await request("GET", "/release/current-round");
    const currentLegResponse = await request("GET", "/release/current-leg");
    assert("block 119 remains in round 0", currentRoundResponse.body?.round?.id === 0, JSON.stringify(currentRoundResponse.body?.round));
    assert("block 119 remains in leg 0", currentLegResponse.body?.leg?.id === 0, JSON.stringify(currentLegResponse.body?.leg));
  });

  await withRelayAtHeight({}, 120, async () => {
    const currentRoundResponse = await request("GET", "/release/current-round");
    assert("block 120 advances to round 1", currentRoundResponse.body?.round?.id === 1, JSON.stringify(currentRoundResponse.body?.round));
    assert("round start at transition is deterministic", currentRoundResponse.body?.round?.blockStart === 120, JSON.stringify(currentRoundResponse.body?.round));
  });

  await withRelayAtHeight({}, 1439, async () => {
    const currentLegResponse = await request("GET", "/release/current-leg");
    assert("block 1439 remains in leg 0", currentLegResponse.body?.leg?.id === 0, JSON.stringify(currentLegResponse.body?.leg));
  });

  await withRelayAtHeight({}, 1440, async () => {
    const currentRoundResponse = await request("GET", "/release/current-round");
    const currentLegResponse = await request("GET", "/release/current-leg");
    assert("block 1440 advances to leg 1", currentLegResponse.body?.leg?.id === 1, JSON.stringify(currentLegResponse.body?.leg));
    assert("block 1440 round/leg relationship stays aligned", currentRoundResponse.body?.round?.legId === 1, JSON.stringify(currentRoundResponse.body?.round));
  });

  section("release standings, settlement, eligibility, obligations, and recent rounds");
  await withRelay({
    "p/p00": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p00", recordName: "g/voidrunner3d/p00/record" }),
    "g/voidrunner3d/p00/record": createRecordValue("p00", { easy: { score: 15, updatedAt: 200 }, normal: { score: 50, updatedAt: 100 }, hard: { score: 60, updatedAt: 300 } }),
    "p/p01": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p01", recordName: "g/voidrunner3d/p01/record" }),
    "g/voidrunner3d/p01/record": createRecordValue("p01", { easy: { score: 14, updatedAt: 201 }, normal: { score: 49, updatedAt: 101 }, hard: { score: 59, updatedAt: 301 } }),
    "p/p02": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p02", recordName: "g/voidrunner3d/p02/record" }),
    "g/voidrunner3d/p02/record": createRecordValue("p02", { easy: { score: 13, updatedAt: 202 }, normal: { score: 48, updatedAt: 102 }, hard: { score: 58, updatedAt: 302 } }),
    "p/p03": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p03", recordName: "g/voidrunner3d/p03/record" }),
    "g/voidrunner3d/p03/record": createRecordValue("p03", { easy: { score: 12, updatedAt: 203 }, normal: { score: 47, updatedAt: 103 }, hard: { score: 57, updatedAt: 303 } }),
    "p/p04": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p04", recordName: "g/voidrunner3d/p04/record" }),
    "g/voidrunner3d/p04/record": createRecordValue("p04", { easy: { score: 11, updatedAt: 204 }, normal: { score: 46, updatedAt: 104 }, hard: { score: 56, updatedAt: 304 } }),
    "p/p05": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p05", recordName: "g/voidrunner3d/p05/record" }),
    "g/voidrunner3d/p05/record": createRecordValue("p05", { easy: { score: 10, updatedAt: 205 }, normal: { score: 45, updatedAt: 105 }, hard: { score: 55, updatedAt: 305 } }),
    "p/p06": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p06", recordName: "g/voidrunner3d/p06/record" }),
    "g/voidrunner3d/p06/record": createRecordValue("p06", { easy: { score: 9, updatedAt: 206 }, normal: { score: 44, updatedAt: 106 }, hard: { score: 54, updatedAt: 306 } }),
    "p/p07": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p07", recordName: "g/voidrunner3d/p07/record" }),
    "g/voidrunner3d/p07/record": createRecordValue("p07", { easy: { score: 8, updatedAt: 207 }, normal: { score: 43, updatedAt: 107 }, hard: { score: 53, updatedAt: 307 } }),
    "p/p08": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p08", recordName: "g/voidrunner3d/p08/record" }),
    "g/voidrunner3d/p08/record": createRecordValue("p08", { easy: { score: 7, updatedAt: 208 }, normal: { score: 42, updatedAt: 108 }, hard: { score: 52, updatedAt: 308 } }),
    "p/p09": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "p09", recordName: "g/voidrunner3d/p09/record" }),
    "g/voidrunner3d/p09/record": createRecordValue("p09", { easy: { score: 6, updatedAt: 209 }, normal: { score: 41, updatedAt: 109 }, hard: { score: 51, updatedAt: 309 } })
  }, async () => {
    const standingsResponse = await request("GET", "/release/current-standings");
    assert("current standings endpoint returns 200", standingsResponse.status === 200, `got ${standingsResponse.status}`);
    assert("current standings returns up to top 10", standingsResponse.body?.standings?.entries?.length === 10, JSON.stringify(standingsResponse.body?.standings));
    assert("current standings remain normal-only for release scope", standingsResponse.body?.standings?.difficulty === "normal", JSON.stringify(standingsResponse.body?.standings));

    const settlementResponse = await request("GET", "/release/round-settlement?roundId=101");
    assert("round settlement endpoint returns 200 for closed round", settlementResponse.status === 200, `got ${settlementResponse.status}`);
    assert("round settlement status is settled", settlementResponse.body?.settlement?.status === "settled", JSON.stringify(settlementResponse.body?.settlement));
    assert("round settlement winners has top-4 payouts per eligible difficulty", settlementResponse.body?.settlement?.winners?.length === 12, JSON.stringify(settlementResponse.body?.settlement));
    assert("round settlement liabilities has bottom-6 obligations", settlementResponse.body?.settlement?.liabilities?.length === 6, JSON.stringify(settlementResponse.body?.settlement));
    assert(
      "round settlement payout schedule matches difficulty-tiered release plan",
      settlementResponse.body?.settlement?.winners?.map((winner) => `${winner.difficulty}:${winner.amount}`).join(",")
        === "normal:100,normal:70,normal:20,normal:10,easy:20,easy:14,easy:4,easy:2,hard:2000,hard:1400,hard:400,hard:200",
      JSON.stringify(settlementResponse.body?.settlement?.winners)
    );
    assert("round settlement liability schedule matches release plan", settlementResponse.body?.settlement?.liabilities?.map((entry) => entry.amount).join(",") === "28,30,33,35,36,38", JSON.stringify(settlementResponse.body?.settlement?.liabilities));

    const eligibilityResponse = await request("GET", "/release/player-eligibility?handle=p09");
    assert("player eligibility endpoint returns 200", eligibilityResponse.status === 200, `got ${eligibilityResponse.status}`);
    assert("liability player is blocked after settlement", eligibilityResponse.body?.eligibility?.eligible === false, JSON.stringify(eligibilityResponse.body?.eligibility));
    assert("eligibility exposes blocked and unpaid reasons", eligibilityResponse.body?.eligibility?.reasons?.blockedUntilLegEnd === true && eligibilityResponse.body?.eligibility?.reasons?.unpaid === true, JSON.stringify(eligibilityResponse.body?.eligibility));

    const obligationsResponse = await request("GET", "/release/player-obligations?handle=p09");
    assert("player obligations endpoint returns 200", obligationsResponse.status === 200, `got ${obligationsResponse.status}`);
    assert("player obligations exposes due records", obligationsResponse.body?.obligations?.outstanding?.length >= 1, JSON.stringify(obligationsResponse.body?.obligations));
    assert("player obligations expose blocked current-leg status", obligationsResponse.body?.obligations?.blockedUntilLegEnd === true && obligationsResponse.body?.obligations?.unpaid === true, JSON.stringify(obligationsResponse.body?.obligations));

    const recentSettledResponse = await request("GET", "/release/recent-settled-rounds?limit=2");
    assert("recent settled rounds endpoint returns 200", recentSettledResponse.status === 200, `got ${recentSettledResponse.status}`);
    assert("recent settled rounds returns bounded list", recentSettledResponse.body?.rounds?.length <= 2, JSON.stringify(recentSettledResponse.body?.rounds));
    assert("recent settled rounds include the finalized prior round", recentSettledResponse.body?.rounds?.[0]?.roundId === 101, JSON.stringify(recentSettledResponse.body?.rounds));
  });

  section("release settlement marks insufficient participants explicitly");
  await withRelay({
    "p/small1": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "small1", recordName: "g/voidrunner3d/small1/record" }),
    "g/voidrunner3d/small1/record": createRecordValue("small1", { normal: { score: 10, updatedAt: 100 } }),
    "p/small2": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "small2", recordName: "g/voidrunner3d/small2/record" }),
    "g/voidrunner3d/small2/record": createRecordValue("small2", { normal: { score: 9, updatedAt: 101 } }),
    "p/small3": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "small3", recordName: "g/voidrunner3d/small3/record" }),
    "g/voidrunner3d/small3/record": createRecordValue("small3", { normal: { score: 8, updatedAt: 102 } })
  }, async () => {
    const settlementResponse = await request("GET", "/release/round-settlement?roundId=101");
    assert("insufficient participants still returns settlement record", settlementResponse.status === 200, `got ${settlementResponse.status}`);
    assert("insufficient participants uses closed-no-settlement", settlementResponse.body?.settlement?.status === "closed-no-settlement", JSON.stringify(settlementResponse.body?.settlement));
    assert("insufficient participants provides explicit reason", settlementResponse.body?.settlement?.reason === "insufficient-qualified-participants", JSON.stringify(settlementResponse.body?.settlement));
    assert("insufficient participants exposes minimum required participants", settlementResponse.body?.settlement?.minimumRequiredParticipants === 10, JSON.stringify(settlementResponse.body?.settlement));
  });

  section("release standings tie-break behavior remains deterministic");
  await withRelay({
    "p/alpha": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "alpha", recordName: "g/voidrunner3d/alpha/record" }),
    "g/voidrunner3d/alpha/record": createRecordValue("alpha", { normal: { score: 50, updatedAt: 2000 } }),
    "p/bravo": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "bravo", recordName: "g/voidrunner3d/bravo/record" }),
    "g/voidrunner3d/bravo/record": createRecordValue("bravo", { normal: { score: 50, updatedAt: 2000 } }),
    "p/charlie": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "charlie", recordName: "g/voidrunner3d/charlie/record" }),
    "g/voidrunner3d/charlie/record": createRecordValue("charlie", { normal: { score: 50, updatedAt: 1500 } })
  }, async () => {
    const standingsResponse = await request("GET", "/release/current-standings");
    assert("tie-break standings endpoint returns 200", standingsResponse.status === 200, `got ${standingsResponse.status}`);
    const topEntries = standingsResponse.body?.standings?.entries || [];
    assert("older updatedAt wins first tie-break", topEntries[0]?.handle === "charlie", JSON.stringify(topEntries));
    assert("handle lexical order breaks exact score+timestamp ties", topEntries[1]?.handle === "alpha" && topEntries[2]?.handle === "bravo", JSON.stringify(topEntries));
  });

  section("eligibility clears previous-leg liabilities after leg transition");
  await withRelayAtHeight({
    "p/debtpilot": JSON.stringify({ version: 1, game: "voidrunner3d", handle: "debtpilot", recordName: "g/voidrunner3d/debtpilot/record" }),
    "g/voidrunner3d/debtpilot/record": createRecordValue("debtpilot", { normal: { score: 25, updatedAt: 1000 } })
  }, 1440, async () => {
    const eligibilityResponse = await request("GET", "/release/player-eligibility?handle=debtpilot");
    const obligationsResponse = await request("GET", "/release/player-obligations?handle=debtpilot");

    assert("new leg eligibility endpoint returns 200", eligibilityResponse.status === 200, `got ${eligibilityResponse.status}`);
    assert("new leg obligations endpoint returns 200", obligationsResponse.status === 200, `got ${obligationsResponse.status}`);
    assert("previous-leg liabilities do not block in new leg", eligibilityResponse.body?.eligibility?.reasons?.blockedUntilLegEnd === false, JSON.stringify(eligibilityResponse.body?.eligibility));
    assert("previous-leg liabilities are absent from outstanding list", Array.isArray(obligationsResponse.body?.obligations?.outstanding) && obligationsResponse.body.obligations.outstanding.length === 0, JSON.stringify(obligationsResponse.body?.obligations));
  });

  section("release validation and visibility edge cases");
  await withRelay({}, async () => {
    const invalidSettlementResponse = await request("GET", "/release/round-settlement?roundId=bad");
    assert("invalid release settlement round id returns 400", invalidSettlementResponse.status === 400, `got ${invalidSettlementResponse.status}`);

    const invalidEligibilityResponse = await request("GET", "/release/player-eligibility?handle=!!");
    assert("invalid release eligibility handle returns 400", invalidEligibilityResponse.status === 400, `got ${invalidEligibilityResponse.status}`);

    const defaultObligationsResponse = await request("GET", "/release/player-obligations?handle=ghost01");
    assert("unknown player obligations still return 200", defaultObligationsResponse.status === 200, `got ${defaultObligationsResponse.status}`);
    assert("unknown player obligations default to no outstanding items", Array.isArray(defaultObligationsResponse.body?.obligations?.outstanding) && defaultObligationsResponse.body.obligations.outstanding.length === 0, JSON.stringify(defaultObligationsResponse.body?.obligations));

    const cappedRecentRoundsResponse = await request("GET", "/release/recent-settled-rounds?limit=999");
    assert("recent settled rounds still return 200 for oversized limit", cappedRecentRoundsResponse.status === 200, `got ${cappedRecentRoundsResponse.status}`);
    assert("recent settled rounds cap oversized limit to available data", Array.isArray(cappedRecentRoundsResponse.body?.rounds), JSON.stringify(cappedRecentRoundsResponse.body?.rounds));
  });

  section("POST /api/prizes/close-window removed from public relay");
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
    assert("public close-window route returns 404", missingAdminKeyResponse.status === 404, `got ${missingAdminKeyResponse.status}`);
  });

  section("POST /api/prizes/close-window payout path removed from public relay");
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
    assert("public close-window remains unavailable", closeWindowResponse.status === 404, `got ${closeWindowResponse.status}`);
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
