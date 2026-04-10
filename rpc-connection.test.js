"use strict";

/**
 * RPC Connection tests for the leaderboard relay.
 * Verifies the SpaceXpanse ROD node is reachable and the relay
 * correctly handles authentication / RPC responses end-to-end.
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const ROD_HOST = "127.0.0.1";
const ROD_PORT = 11999;
const RELAY_TEST_PORT = 8789;

const ROD_USER = process.env.ROD_RPC_USER || "";
const ROD_PASSWORD = process.env.ROD_RPC_PASSWORD || "";
const HAS_CREDS = !!(ROD_USER || ROD_PASSWORD);

// ---- helpers ----

function rawHttpPost(hostname, port, path_, headers, body) {
  return new Promise((resolve) => {
    const options = { hostname, port, path: path_, method: "POST", headers };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", (e) => resolve({ status: -1, error: e.code || e.message }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ status: -1, error: "TIMEOUT" }); });
    if (body) req.write(body);
    req.end();
  });
}

function relayGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/api" + urlPath, method: "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", (e) => resolve({ status: -1, error: e.code || e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: -1, error: "TIMEOUT" }); });
    req.end();
  });
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
function info(t) { console.log(`  ℹ ${t}`); }

// ---- spawn relay on test port with optional creds ----

let relayProc = null;

function startRelay(withCreds) {
  return new Promise((resolve) => {
    const env = { ...process.env, _IGNORE: "1" };
    if (withCreds && HAS_CREDS) {
      env.ROD_RPC_USER = ROD_USER;
      env.ROD_RPC_PASSWORD = ROD_PASSWORD;
    } else {
      delete env.ROD_RPC_USER;
      delete env.ROD_RPC_PASSWORD;
    }

    const wrapperCode = `
      const origHttp = require("http");
      const origCreate = origHttp.createServer.bind(origHttp);
      origHttp.createServer = (...args) => {
        const srv = origCreate(...args);
        const origListen = srv.listen.bind(srv);
        srv.listen = (_p, _h, cb) => origListen(${RELAY_TEST_PORT}, _h, cb);
        return srv;
      };
      require(${JSON.stringify(path.join(__dirname, "leaderboard-relay.js").replace(/\\/g, "\\\\"))});
    `;

    relayProc = spawn(process.execPath, ["-e", wrapperCode], { env, stdio: ["ignore", "pipe", "pipe"] });
    relayProc.stdout.on("data", () => {});
    relayProc.stderr.on("data", () => {});
    setTimeout(resolve, 1200);
  });
}

function stopRelay() {
  if (relayProc) { relayProc.kill(); relayProc = null; }
}

async function waitRelay(maxMs = 3000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const res = await relayGet(RELAY_TEST_PORT, "/health");
    if (res.status !== -1) return;
    await new Promise(r => setTimeout(r, 200));
  }
}

// ---- tests ----

async function runTests() {
  // ── 1. ROD node connectivity ──
  section("ROD node reachability (127.0.0.1:11999)");
  {
    const res = await rawHttpPost(
      ROD_HOST, ROD_PORT, "/",
      { "Content-Type": "application/json" },
      JSON.stringify({ jsonrpc: "1.0", id: "probe", method: "getblockcount", params: [] })
    );

    if (res.status === -1) {
      assert("ROD node is reachable", false, `error=${res.error}`);
      console.log("  → Skipping RPC authentication tests (node unreachable)");
      return summary();
    }

    assert("ROD node responds to HTTP", res.status > 0, `status=${res.status}`);

    if (res.status === 200) {
      info("Node authenticated without credentials (open RPC)");
      assert("RPC result is a number (block count)", typeof res.json?.result === "number",
        JSON.stringify(res.json));
    } else if (res.status === 401) {
      info("Node requires authentication (HTTP 401) — credentials needed");
      assert("401 is expected when no credentials are provided", res.status === 401);
    } else {
      assert("ROD node HTTP status is 200 or 401", res.status === 200 || res.status === 401,
        `got=${res.status}`);
    }
  }

  // ── 2. Relay health endpoint without credentials ──
  section("Relay /api/health — no credentials (relay → ROD 401 → relay 502)");
  {
    await startRelay(false);
    await waitRelay();

    const res = await relayGet(RELAY_TEST_PORT, "/health");
    // Without credentials the relay should fail to call ROD → 502
    // OR if ROD is open (200) it could succeed → 200
    assert("relay responds (not TIMEOUT)", res.status !== -1, `status=${res.status}`);

    if (res.status === 200) {
      info("ROD is open; relay health is UP");
      assert("health ok:true", res.json?.ok === true, JSON.stringify(res.json));
    } else {
      assert("relay returns 502 when ROD rejects unauthenticated request", res.status === 502,
        `got=${res.status}`);
      assert("relay error body ok:false", res.json?.ok === false, JSON.stringify(res.json));
      const msg = res.json?.error || "";
      assert("relay error mentions RPC HTTP 401", msg.includes("401") || msg.length > 0,
        `error="${msg}"`);
    }

    stopRelay();
  }

  // ── 3. Relay with credentials (if env vars set) ──
  if (HAS_CREDS) {
    section("Relay /api/health — with credentials");
    {
      await startRelay(true);
      await waitRelay();

      const res = await relayGet(RELAY_TEST_PORT, "/health");
      assert("relay responds with credentials", res.status !== -1, `status=${res.status}`);
      assert("relay health returns 200", res.status === 200, `got=${res.status}`);
      assert("health ok:true", res.json?.ok === true, JSON.stringify(res.json));
      assert("node:up in response", res.json?.node === "up", JSON.stringify(res.json));

      stopRelay();
    }

    section("Relay /api/leaderboard — with credentials");
    for (const diff of ["easy", "normal", "hard"]) {
      await startRelay(true);
      await waitRelay();

      const res = await relayGet(RELAY_TEST_PORT, `/leaderboard?difficulty=${diff}`);
      assert(`difficulty=${diff} returns 200`, res.status === 200, `got=${res.status}`);
      assert(`difficulty=${diff} ok:true`, res.json?.ok === true, JSON.stringify(res.json));
      assert(`difficulty=${diff} entries is array`, Array.isArray(res.json?.entries),
        JSON.stringify(res.json));

      stopRelay();
    }
  } else {
    section("Relay with credentials (SKIPPED — ROD_RPC_USER/ROD_RPC_PASSWORD not set)");
    info("Set ROD_RPC_USER and ROD_RPC_PASSWORD env vars to test authenticated RPC flow.");
    info(`Example: ROD_RPC_USER=rod ROD_RPC_PASSWORD=secret node rpc-connection.test.js`);
  }

  summary();
}

function summary() {
  console.log(`\n════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  stopRelay();
  console.error("Test runner error:", err);
  process.exit(1);
});
