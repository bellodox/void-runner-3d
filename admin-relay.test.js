"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const TEST_PORT = 8791;
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
      res.on("data", (chunk) => {
        raw += chunk;
      });
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

async function startAdminRelay(options = {}) {
  return new Promise((resolve) => {
    const relayPath = path.join(__dirname, "admin-relay.js").replace(/\\/g, "\\\\");
    const wrapperCode = `
      function buildJsonResponse(payload, status = 200) {
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() { return payload; }
        };
      }

      global.fetch = async (_url, rpcOptions = {}) => {
        const rpcRequest = JSON.parse(rpcOptions.body || '{}');
        if (rpcRequest.method === 'getblockcount') {
          return buildJsonResponse({ result: 12345 });
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
        ADMIN: options.adminEnabled ? "true" : "false",
        ADMIN_RELAY_PORT: String(TEST_PORT)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let resolved = false;
    relayProc.stdout.on("data", (data) => {
      const text = data.toString();
      if (!resolved && (text.includes("listening") || text.includes("disabled"))) {
        resolved = true;
        resolve();
      }
    });
    relayProc.stderr.on("data", () => {});

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, 1000);
  });
}

function stopAdminRelay() {
  if (relayProc) {
    relayProc.kill();
    relayProc = null;
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
  section("admin relay disabled by ADMIN=false");
  await startAdminRelay({ adminEnabled: false });
  const disabledProbe = await new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: TEST_PORT, path: "/api/health", method: "GET" }, (res) => {
      resolve({ status: res.statusCode });
    });
    req.on("error", (error) => resolve({ status: -1, error: error.code || error.message }));
    req.end();
  });
  assert("admin relay does not expose endpoints when disabled", disabledProbe.status === -1, JSON.stringify(disabledProbe));
  stopAdminRelay();

  section("admin relay health when ADMIN=true");
  await startAdminRelay({ adminEnabled: true });
  const healthResponse = await request("GET", "/health");
  assert("admin relay health returns 200", healthResponse.status === 200, `got ${healthResponse.status}`);
  assert("admin relay health marks admin=true", healthResponse.body?.admin === true, JSON.stringify(healthResponse.body));
  stopAdminRelay();

  console.log("\n════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  stopAdminRelay();
  console.error("Test runner error:", error);
  process.exit(1);
});

