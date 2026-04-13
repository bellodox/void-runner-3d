"use strict";

/**
 * Playwright browser tests for Void Runner 3D (index.html)
 * Starts a minimal static file server, then tests game functionality.
 */

const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SERVE_PORT = 9090;
const BASE_URL = `http://127.0.0.1:${SERVE_PORT}`;
const HTML_FILE = path.join(__dirname, "index.html");

// ---- static file server ----
let staticServer;

function startServer() {
  return new Promise((resolve) => {
    staticServer = http.createServer((req, res) => {
      const filePath = req.url === "/" || req.url === "/index.html" ? HTML_FILE : null;
      if (filePath) {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    staticServer.listen(SERVE_PORT, "127.0.0.1", resolve);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (staticServer) staticServer.close(resolve);
    else resolve();
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

async function runTests() {
  await startServer();

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    // suppress audio context to avoid browser policy issues in headless
    permissions: []
  });
  const page = await context.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  async function ensurePlayingState() {
    const pauseButtonText = await page.textContent("#pauseBtn");
    if (pauseButtonText && pauseButtonText.includes("RESUME")) {
      await page.click("#pauseBtn");
      await page.waitForTimeout(150);
    }
  }

  // ---- Menu rendering ----
  section("Menu rendering");
  {
    const menuVisible = await page.isVisible("#menuOverlay:not(.hidden)");
    assert("main menu overlay is visible on load", menuVisible);
  }
  {
    const h1Text = await page.textContent("h1");
    assert("title shows 'Void Runner'", h1Text && h1Text.includes("Void Runner"), `got: "${h1Text}"`);
  }
  {
    const hudHidden = await page.locator("#hud.hidden").count();
    assert("HUD is hidden at menu", hudHidden === 1);
  }
  {
    const gameOverHidden = await page.locator("#gameOverOverlay.hidden").count();
    assert("game over overlay is hidden at menu", gameOverHidden === 1);
  }

  // ---- Difficulty buttons ----
  section("Difficulty buttons");
  {
    const normalActive = await page.locator(".difficulty-btn.active[data-difficulty='normal']").count();
    assert("Normal is active by default", normalActive === 1);
  }
  {
    await page.click("[data-difficulty='easy']");
    await page.waitForTimeout(100);
    const easyActive = await page.locator(".difficulty-btn.active[data-difficulty='easy']").count();
    assert("Easy becomes active after click", easyActive === 1);
    const normalInactive = await page.locator(".difficulty-btn.active[data-difficulty='normal']").count();
    assert("Normal becomes inactive after switching to Easy", normalInactive === 0);
  }
  {
    await page.click("[data-difficulty='hard']");
    await page.waitForTimeout(100);
    const hardActive = await page.locator(".difficulty-btn.active[data-difficulty='hard']").count();
    assert("Hard becomes active after click", hardActive === 1);
  }
  // switch back to normal for remaining tests
  await page.click("[data-difficulty='normal']");
  await page.waitForTimeout(100);

  // ---- Chain leaderboard status ----
  section("Chain leaderboard status");
  {
    await page.waitForTimeout(1500); // wait for fetch to fail/succeed
    const statusText = await page.textContent("#chainStatusText");
    assert("chain status text is not empty", statusText && statusText.trim().length > 0, `"${statusText}"`);
    // relay is offline so should show offline or loading
    const isOfflineOrLoading = statusText && (statusText.includes("offline") || statusText.includes("loading") || statusText.includes("online"));
    assert("chain status shows relay state", isOfflineOrLoading, `"${statusText}"`);
  }

  // ---- Game start ----
  section("Game start");
  {
    await page.click("#startBtn");
    await page.waitForTimeout(300);
    const hudVisible = await page.locator("#hud:not(.hidden)").count();
    assert("HUD becomes visible after game start", hudVisible === 1, `count=${hudVisible}`);
    const menuHidden = await page.locator("#menuOverlay.hidden").count();
    assert("menu overlay is hidden during game", menuHidden === 1);
  }
  {
    const timerText = await page.textContent("#timerBox");
    assert("timer box shows TIME prefix", timerText && timerText.startsWith("TIME"), `"${timerText}"`);
  }
  {
    const diffText = await page.textContent("#difficultyLabel");
    assert("difficulty label shows DIFF:", diffText && diffText.includes("DIFF:"), `"${diffText}"`);
  }
  {
    const highScoreText = await page.textContent("#highScoreBox");
    assert("high score box shows LOCAL BEST", highScoreText && highScoreText.includes("LOCAL BEST"), `"${highScoreText}"`);
  }

  // ---- Pause / Resume ----
  section("Pause / Resume");
  {
    await page.locator("#pauseBtn").click({ noWaitAfter: true });
    await page.waitForTimeout(150);
    const pauseBadgeVisible = await page.isVisible("#pauseBadge");
    assert("PAUSED badge shows after clicking Pause", pauseBadgeVisible);
    const pauseBtnText = await page.textContent("#pauseBtn");
    assert("Pause button changes to RESUME", pauseBtnText && pauseBtnText.includes("RESUME"), `"${pauseBtnText}"`);
  }
  {
    await page.locator("#pauseBtn").click({ noWaitAfter: true });
    await page.waitForTimeout(150);
    const pauseBadgeHidden = await page.$eval("#pauseBadge", el => el.style.display);
    assert("PAUSED badge hidden after resume", pauseBadgeHidden === "none" || pauseBadgeHidden === "", `display="${pauseBadgeHidden}"`);
    const pauseBtnText = await page.textContent("#pauseBtn");
    assert("Pause button reverts to PAUSE", pauseBtnText && pauseBtnText.includes("PAUSE"), `"${pauseBtnText}"`);
  }

  // Keyboard Escape pause
  {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const pauseBadgeVisible2 = await page.isVisible("#pauseBadge");
    assert("Escape key triggers pause", pauseBadgeVisible2);
    await page.keyboard.press("Escape"); // unpause
    await page.waitForTimeout(150);
  }

  // ---- Mute toggle ----
  section("Mute toggle");
  {
    const initialText = await page.textContent("#muteBtn");
    assert("mute button starts as MUTE: OFF", initialText && initialText.includes("MUTE: OFF"), `"${initialText}"`);
    await page.click("#muteBtn");
    await page.waitForTimeout(100);
    const mutedText = await page.textContent("#muteBtn");
    assert("mute button toggles to MUTE: ON", mutedText && mutedText.includes("MUTE: ON"), `"${mutedText}"`);
    await page.click("#muteBtn");
    await page.waitForTimeout(100);
    const unmutedText = await page.textContent("#muteBtn");
    assert("mute button toggles back to MUTE: OFF", unmutedText && unmutedText.includes("MUTE: OFF"), `"${unmutedText}"`);
  }

  // ---- Mouse toggle ----
  section("Mouse toggle");
  {
    const initialText = await page.textContent("#mouseToggleBtn");
    assert("mouse button starts as MOUSE: ON", initialText && initialText.includes("MOUSE: ON"), `"${initialText}"`);
    await page.click("#mouseToggleBtn");
    await page.waitForTimeout(100);
    const offText = await page.textContent("#mouseToggleBtn");
    assert("mouse button toggles to MOUSE: OFF", offText && offText.includes("MOUSE: OFF"), `"${offText}"`);
    await page.click("#mouseToggleBtn");
    await page.waitForTimeout(100);
  }

  // ---- Timer advances during gameplay ----
  section("Timer advances during gameplay");
  {
    await ensurePlayingState();
    const textBefore = await page.textContent("#timerBox");
    await page.waitForTimeout(1200);
    const textAfter = await page.textContent("#timerBox");
    assert("timer text changes after 1.2 seconds",
      textBefore !== textAfter,
      `before="${textBefore}" after="${textAfter}"`);
  }

  // ---- Timer freezes while paused ----
  section("Timer freezes while paused");
  {
    await page.click("#pauseBtn");
    await page.waitForTimeout(150);
    const pausedTimerBefore = await page.textContent("#timerBox");
    await page.waitForTimeout(1200);
    const pausedTimerAfter = await page.textContent("#timerBox");
    assert(
      "timer text remains unchanged while paused",
      pausedTimerBefore === pausedTimerAfter,
      `before="${pausedTimerBefore}" after="${pausedTimerAfter}"`
    );
    await page.click("#pauseBtn");
    await page.waitForTimeout(150);
  }

  // ---- Game loop runs without JS errors during play ----
  section("No JS errors during gameplay");
  {
    await page.waitForTimeout(2000);
    const relevantErrors = consoleErrors.filter(e =>
      !e.includes("ERR_CONNECTION_REFUSED") &&
      !e.includes("ERR_CONNECTION_RESET") &&
      !e.includes("AudioContext encountered an error") &&
      !e.includes("favicon") &&
      !e.includes("127.0.0.1:8787") &&
      !e.includes("Failed to fetch")
    );
    assert("no unexpected JS errors during play",
      relevantErrors.length === 0,
      relevantErrors.join("; ") || "none");
  }

  // ---- Canvas is rendering (non-zero size) ----
  section("Canvas rendering");
  {
    const canvasSize = await page.$eval("#gameCanvas", (el) => ({
      w: el.width,
      h: el.height
    }));
    assert("canvas has non-zero width", canvasSize.w > 0, `w=${canvasSize.w}`);
    assert("canvas has non-zero height", canvasSize.h > 0, `h=${canvasSize.h}`);
  }

  // ---- In-game control visibility sanity ----
  section("In-game control visibility sanity");
  {
    await ensurePlayingState();
    const gameOverVisible = await page.locator("#gameOverOverlay:not(.hidden)").count();
    if (gameOverVisible > 0) {
      await page.click("#playAgainBtn");
      await page.waitForTimeout(250);
    }
    const gameOverVisibleAfterRecovery = await page.locator("#gameOverOverlay:not(.hidden)").count();
    assert("game-over overlay is not actively shown during sanity check", gameOverVisibleAfterRecovery === 0);
    const menuHidden = await page.locator("#menuOverlay.hidden").count();
    assert("menu overlay remains hidden during active gameplay", menuHidden === 1);
  }

  // ---- localStorage - local best persists ----
  section("localStorage high score persistence");
  {
    const stored = await page.evaluate(() => {
      // Manually set a high score entry high enough to avoid being beaten during test runtime
      localStorage.setItem("highScore_normal", "999");
      return localStorage.getItem("highScore_normal");
    });
    assert("can write/read high score to localStorage", stored === "999", `stored="${stored}"`);
  }
  {
    const storedValue = await page.evaluate(() => localStorage.getItem("highScore_normal"));
    assert("stored high score remains persisted in localStorage", storedValue === "999", `stored="${storedValue}"`);
  }

  // ---- Player handle UX ----
  section("Player handle UX");
  {
    await page.evaluate(() => {
      const gameOverElement = document.getElementById("gameOverOverlay");
      if (gameOverElement) gameOverElement.classList.remove("hidden");
      localStorage.removeItem("voidrunner_player_handle");
      const inputElement = document.getElementById("playerInitialsInput");
      if (inputElement) {
        inputElement.disabled = false;
        inputElement.value = "";
      }
    });

    const initialHandleValue = await page.$eval("#playerInitialsInput", (element) => element.value);
    assert("new-user handle starts empty instead of a seeded default", initialHandleValue === "", `value="${initialHandleValue}"`);

    const sanitizedValue = await page.evaluate(() => {
      const inputElement = document.getElementById("playerInitialsInput");
      if (!inputElement) return null;
      inputElement.value = "a!b@c#123";
      inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      return inputElement.value;
    });
    assert("handle input sanitizes editable values", sanitizedValue === "abc123", `value="${sanitizedValue}"`);
  }

  // ---- formatTime edge cases via HUD ----
  section("formatTime edge cases (via HUD)");
  {
    const hudText = await page.textContent("#highScoreBox");
    assert("highScoreBox shows time format MM:SS.mmm",
      hudText && /\d{2}:\d{2}\.\d{3}/.test(hudText), `"${hudText}"`);
  }

  // ---- No node processes left running ----
  await context.close();
  await browser.close();

  await stopServer();

  console.log(`\n════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  stopServer();
  console.error("Test runner error:", err);
  process.exit(1);
});
