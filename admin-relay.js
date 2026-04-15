"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const rawLine of envContent.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const ADMIN_ENABLED = String(process.env.ADMIN || "").toLowerCase() === "true";
const RELAY_HOST = "127.0.0.1";
const RELAY_PORT = Number(process.env.ADMIN_RELAY_PORT || 8789);
const RPC_URL = "http://127.0.0.1:11999/";
const RPC_TIMEOUT_MS = 10000;
const PRIZE_POT_ADDRESS = String(process.env.PRIZE_POT_ADDRESS || "").trim();

const DEPRECATED_ROUTES = Object.freeze([
  { method: "POST", path: "/api/prizes" },
  { method: "POST", path: "/api/prizes/close-window" }
]);

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  setCors(response);
  response.end(JSON.stringify(payload));
}

async function callRpc(method, params) {
  const payload = {
    jsonrpc: "1.0",
    id: `admin-relay-${Date.now()}`,
    method,
    params
  };
  const headers = { "Content-Type": "application/json" };
  const rpcUser = process.env.ROD_RPC_USER;
  const rpcPassword = process.env.ROD_RPC_PASSWORD;
  if (rpcUser || rpcPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${rpcUser || ""}:${rpcPassword || ""}`).toString("base64")}`;
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

function findDeprecatedRoute(requestMethod, requestPath) {
  return DEPRECATED_ROUTES.find((route) => route.method === requestMethod && route.path === requestPath) || null;
}

if (!ADMIN_ENABLED) {
  console.log("Admin relay disabled: set ADMIN=true in .env to enable diagnostics endpoints.");
  process.exitCode = 0;
} else {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${RELAY_HOST}:${RELAY_PORT}`);

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      setCors(response);
      response.end();
      return;
    }

    try {
      if (request.method === "GET" && requestUrl.pathname === "/api/health") {
        await callRpc("getblockcount", []);
        sendJson(response, 200, {
          ok: true,
          relay: "up",
          node: "up",
          admin: true,
          scope: "diagnostics-only",
          authoritativeEconomySource: "leaderboard-relay",
          prizePotAddressConfigured: Boolean(PRIZE_POT_ADDRESS),
          deprecatedRoutes: DEPRECATED_ROUTES
        });
        return;
      }

      const matchedDeprecatedRoute = findDeprecatedRoute(request.method || "", requestUrl.pathname);
      if (matchedDeprecatedRoute) {
        sendJson(response, 410, {
          ok: false,
          error: "Deprecated admin endpoint",
          scope: "diagnostics-only",
          route: matchedDeprecatedRoute,
          message: "Manual MVP prize and close-window flows are retired in v0.1.0. Release economy state is derived from leaderboard-relay release endpoints."
        });
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(response, 502, { ok: false, error: error.message || "Admin relay error" });
    }
  });

  server.listen(RELAY_PORT, RELAY_HOST, () => {
    console.log(`Void Runner admin relay listening on http://${RELAY_HOST}:${RELAY_PORT}`);
  });
}
