"use strict";

/**
 * HTTP endpoint tests for leaderboard-relay.js
 * Starts the relay server on a different port to avoid conflicts,
 * then tests all endpoints.  Since there is no ROD node running,
 * RPC-dependent routes should return 502; routing/validation errors
 * should return 400/404 with the correct JSON shapes.
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const TEST_PORT = 8788; // separate from the real relay port 8787
const BASE = `http://127.0.0.1:${TEST_PORT}/api`;

// ---- helpers ----

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

// ---- start a patched relay on TEST_PORT via env var ----

let relayProc = null;

async function startRelay() {
  return new Promise((resolve, reject) => {
    // We patch port via a tiny wrapper script written inline
    const wrapperCode = `
      process.env._RELAY_PORT_OVERRIDE = "${TEST_PORT}";
      // Monkey-patch http.createServer to listen on TEST_PORT
      const origHttp = require("http");
      const origCreate = origHttp.createServer.bind(origHttp);
      origHttp.createServer = (...args) => {
        const srv = origCreate(...args);
        const origListen = srv.listen.bind(srv);
        srv.listen = (_port, _host, cb) => origListen(${TEST_PORT}, _host, cb);
        return srv;
      };
      require("${path.join(__dirname, "leaderboard-relay.js").replace(/\\/g, "\\\\")}");
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
        // Give it a moment in case stdout buffered
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

// ---- test runner ----

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
function section(t) { console.log(`\n── ${t}`); }

// ---- wait for relay to be ready ----
async function waitForRelay(maxMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await request("GET", "/health");
      return;
    } catch {
      await new Promise(r => setTimeout(r, 150));
    }
  }
}

// ---- tests ----

async function runTests() {
  await startRelay();
  await waitForRelay();

  // OPTIONS preflight
  section("CORS preflight OPTIONS");
  {
    const res = await request("OPTIONS", "/health");
    assert("OPTIONS /api/health returns 204", res.status === 204, `got ${res.status}`);
  }

  // GET /api/health — ROD node is not running, should be 502
  section("GET /api/health");
  {
    const res = await request("GET", "/health");
    assert("returns 502 when ROD node unavailable", res.status === 502, `got ${res.status}`);
    assert("body has ok:false", res.body && res.body.ok === false, JSON.stringify(res.body));
    assert("body has error string", typeof res.body?.error === "string");
  }

  // GET /api/leaderboard — validation
  section("GET /api/leaderboard - validation");
  {
    const res = await request("GET", "/leaderboard");
    assert("missing difficulty → 400", res.status === 400, `got ${res.status}`);
    assert("error message present", typeof res.body?.error === "string");
  }
  {
    const res = await request("GET", "/leaderboard?difficulty=ultra");
    assert("invalid difficulty → 400", res.status === 400, `got ${res.status}`);
  }

  // GET /api/leaderboard — valid difficulty (no ROD → 502)
  section("GET /api/leaderboard - valid difficulty, no ROD");
  for (const diff of ["easy", "normal", "hard"]) {
    const res = await request("GET", `/leaderboard?difficulty=${diff}`);
    assert(`difficulty=${diff} → 502 (no ROD)`, res.status === 502, `got ${res.status} for ${diff}`);
    assert(`difficulty=${diff} body.ok false`, res.body?.ok === false);
  }

  // POST /api/leaderboard/submit — validation
  section("POST /api/leaderboard/submit - validation");
  {
    const res = await request("POST", "/leaderboard/submit", {});
    assert("empty body → 400", res.status === 400, `got ${res.status}`);
    assert("error message present", typeof res.body?.error === "string");
  }
  {
    const res = await request("POST", "/leaderboard/submit", { difficulty: "normal", name: "!!!", score: 10 });
    assert("invalid name → 400", res.status === 400, `got ${res.status}`);
  }
  {
    const res = await request("POST", "/leaderboard/submit", { difficulty: "normal", name: "AAA", score: -5 });
    assert("negative score → 400", res.status === 400, `got ${res.status}`);
  }
  {
    const res = await request("POST", "/leaderboard/submit", { difficulty: "invalid", name: "AAA", score: 50 });
    assert("invalid difficulty → 400", res.status === 400, `got ${res.status}`);
  }
  {
    const res = await request("POST", "/leaderboard/submit", { difficulty: "normal", name: "AAA", score: 99999 });
    assert("score > MAX_SCORE_SECONDS → 400", res.status === 400, `got ${res.status}`);
  }

  // POST /api/leaderboard/submit — valid payload (no ROD → 502)
  section("POST /api/leaderboard/submit - valid payload, no ROD");
  {
    const res = await request("POST", "/leaderboard/submit", { difficulty: "hard", name: "TST", score: 123.5 });
    assert("valid submit → 502 (no ROD)", res.status === 502, `got ${res.status}`);
    assert("body.ok false", res.body?.ok === false);
  }

  // 404 for unknown routes
  section("404 for unknown routes");
  {
    const res = await request("GET", "/unknown");
    assert("unknown route → 404", res.status === 404, `got ${res.status}`);
    assert("body.ok false", res.body?.ok === false);
  }
  {
    const res = await request("POST", "/health");
    assert("POST /health → 404", res.status === 404, `got ${res.status}`);
  }

  // Invalid JSON body
  section("POST with invalid JSON body");
  {
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
        res.on("data", c => { raw += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on("error", resolve);
      req.write("{not valid json}");
      req.end();
    });
    assert("malformed JSON body → 400", result.status === 400, `got ${result.status}`);
  }

  stopRelay();

  console.log(`\n════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  stopRelay();
  console.error("Test runner error:", err);
  process.exit(1);
});
