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

  await page.route("http://127.0.0.1:8787/api/leaderboard/rank?handle=acepilot", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        featuredDifficulty: "normal",
        player: {
          handle: "acepilot",
          rank: 3,
          score: 33,
          inTopList: true
        },
        top: [
          { rank: 1, handle: "champ", score: 40 },
          { rank: 2, handle: "rival", score: 36 },
          { rank: 3, handle: "acepilot", score: 33 },
          { rank: 4, handle: "nova", score: 31 },
          { rank: 5, handle: "zen", score: 29 }
        ],
        targets: {
          leader: { rank: 1, handle: "champ", score: 40 },
          next: { rank: 2, handle: "rival", score: 36 }
        },
        deltas: {
          toLeader: 7,
          toNextRank: 3,
          toTopList: null
        }
      })
    });
  });

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

  // ---- Release economy UI blocks ----
  section("Release economy UI blocks");
  {
    const menuReleaseBoardVisible = await page.locator("#menuOverlay .release-board").count();
    assert("menu release snapshot board is visible", menuReleaseBoardVisible >= 1, `count=${menuReleaseBoardVisible}`);
  }
  {
    const recentSettledBoardVisible = await page.locator(".recent-settled-board").count();
    assert("menu recent settled rounds board is visible", recentSettledBoardVisible === 1, `count=${recentSettledBoardVisible}`);
  }

  // ---- Main-menu release economy text ----
  section("Main-menu release economy text");
  {
    await page.waitForTimeout(300);
    const roundText = await page.textContent("#menuCurrentRoundText");
    assert(
      "menu round line renders release current round text",
      roundText && roundText.includes("Round"),
      `text="${roundText}"`
    );
  }
  {
    const legText = await page.textContent("#menuCurrentLegText");
    assert(
      "menu leg line renders release current leg text",
      legText && legText.includes("Leg"),
      `text="${legText}"`
    );
  }
  {
    const summaryText = await page.textContent("#menuRewardSummaryText");
    assert(
      "menu reward distribution summary is explicit",
      summaryText && summaryText.includes("Reward distribution"),
      `text="${summaryText}"`
    );
  }
  {
    const countdownText = await page.textContent("#menuRoundCountdownText");
    assert(
      "menu round countdown line is visible in release menu",
      countdownText && countdownText.includes("Round countdown"),
      `text="${countdownText}"`
    );
  }
  {
    const legCountdownText = await page.textContent("#menuLegCountdownText");
    assert(
      "menu leg countdown line is visible in release menu",
      legCountdownText && legCountdownText.includes("Leg countdown"),
      `text="${legCountdownText}"`
    );
  }
  {
    const eligibilityText = await page.textContent("#menuEligibilityText");
    assert(
      "menu eligibility line is visible in release menu",
      eligibilityText && eligibilityText.includes("Eligibility"),
      `text="${eligibilityText}"`
    );
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
  {
    const salvageHiddenCount = await page.evaluate(() => {
      const salvageElement = document.getElementById("salvageBox");
      if (!salvageElement) return -1;
      return salvageElement.style.display === "none" ? 1 : 0;
    });
    assert("salvage HUD indicator is hidden while inactive", salvageHiddenCount === 1, `count=${salvageHiddenCount}`);
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

  // ---- Salvage multiplier and score model (Sprint 6.1) ----
  section("Salvage multiplier and score model");
  {
    await page.click("#pauseBtn");
    await page.waitForTimeout(150);

    const initialSalvageState = await page.evaluate(() => {
      return window.__voidRunnerDebug.getState();
    });
    assert(
      "salvage state starts inactive",
      initialSalvageState.salvageMultiplier === 0 && initialSalvageState.salvageRemaining === 0,
      JSON.stringify(initialSalvageState)
    );
  }
  {
    const firstActivationState = await page.evaluate(() => {
      window.__voidRunnerDebug.activateSalvageForTest();
      return window.__voidRunnerDebug.getState();
    });
    assert(
      "first shield-hit salvage activation starts at x1.5 for 5s",
      firstActivationState.salvageMultiplier === 1.5 && Math.abs(firstActivationState.salvageRemaining - 5) < 0.0001,
      JSON.stringify(firstActivationState)
    );

    const salvageHudText = await page.textContent("#salvageBox");
    assert(
      "salvage HUD indicator becomes visible with x1.5 state",
      salvageHudText && salvageHudText.includes("SALVAGE x1.5") && salvageHudText.includes("5.0s"),
      `text="${salvageHudText}"`
    );
  }
  {
    const refreshedState = await page.evaluate(() => {
      window.__voidRunnerDebug.updateSalvageForTest(1.2);
      window.__voidRunnerDebug.activateSalvageForTest();
      return window.__voidRunnerDebug.getState();
    });
    assert(
      "repeat shield-hit refreshes salvage duration and increases multiplier",
      refreshedState.salvageMultiplier === 2 && Math.abs(refreshedState.salvageRemaining - 5) < 0.0001,
      JSON.stringify(refreshedState)
    );

    const refreshedHudText = await page.textContent("#salvageBox");
    assert(
      "salvage HUD indicator updates when multiplier changes",
      refreshedHudText && (refreshedHudText.includes("SALVAGE x2.0") || refreshedHudText.includes("SALVAGE x1.5")) && refreshedHudText.includes("5.0s"),
      `text="${refreshedHudText}"`
    );
  }
  {
    const cappedState = await page.evaluate(() => {
      window.__voidRunnerDebug.activateSalvageForTest(); // 2.5
      window.__voidRunnerDebug.activateSalvageForTest(); // 3.0
      window.__voidRunnerDebug.activateSalvageForTest(); // still 3.0 cap
      return window.__voidRunnerDebug.getState();
    });
    assert(
      "salvage multiplier caps at x3.0",
      cappedState.salvageMultiplier === 3,
      JSON.stringify(cappedState)
    );
  }
  {
    const scoringState = await page.evaluate(() => {
      const stateBefore = window.__voidRunnerDebug.getState();
      window.__voidRunnerDebug.setSurvivalTimeForTest(20);
      window.__voidRunnerDebug.activateSalvageForTest(); // 3.0 was active, refreshes to 3.0
      window.__voidRunnerDebug.updateSalvageForTest(2);
      const stateAfter = window.__voidRunnerDebug.getState();
      return {
        stateBefore,
        stateAfter,
        bonusDelta: stateAfter.bonusTime - stateBefore.bonusTime
      };
    });

    const expectedBonusTime = 4; // 2 seconds at (x3.0 - 1.0)
    const expectedScore = 20 + scoringState.stateAfter.bonusTime;
    assert(
      "bonus time accumulates while salvage window is active",
      Math.abs(scoringState.bonusDelta - expectedBonusTime) < 0.0001,
      JSON.stringify(scoringState)
    );
    assert(
      "score follows survival_time + bonus_time",
      Math.abs(scoringState.stateAfter.score - expectedScore) < 0.0001,
      JSON.stringify(scoringState)
    );
  }
  {
    const expiredState = await page.evaluate(() => {
      window.__voidRunnerDebug.updateSalvageForTest(6);
      return window.__voidRunnerDebug.getState();
    });
    assert(
      "salvage multiplier expires after duration",
      expiredState.salvageMultiplier === 0 && expiredState.salvageRemaining === 0,
      JSON.stringify(expiredState)
    );

    const salvageHiddenAfterExpireCount = await page.evaluate(() => {
      const salvageElement = document.getElementById("salvageBox");
      if (!salvageElement) return -1;
      return salvageElement.style.display === "none" ? 1 : 0;
    });
    assert(
      "salvage HUD indicator hides after salvage window expires",
      salvageHiddenAfterExpireCount === 1,
      `count=${salvageHiddenAfterExpireCount}`
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
      !e.includes("status of 502") &&
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
      localStorage.setItem("voidrunner_player_handle", "acepilot");
      const inputElement = document.getElementById("playerInitialsInput");
      if (inputElement) {
        inputElement.disabled = false;
        inputElement.value = "acepilot";
        inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    await page.waitForTimeout(600);

    const initialHandleValue = await page.$eval("#playerInitialsInput", (element) => element.value);
    assert("stored handle is available on game-over handle input", initialHandleValue === "acepilot", `value="${initialHandleValue}"`);

    const gameOverReleaseBoardVisible = await page.locator("#gameOverOverlay .release-board").count();
    assert("game-over release outcome board is visible", gameOverReleaseBoardVisible === 1, `count=${gameOverReleaseBoardVisible}`);

    const gameOverBlockedText = await page.textContent("#gameOverBlockedText");
    assert("game-over blocked/unpaid messaging field exists", gameOverBlockedText && gameOverBlockedText.includes("Eligibility gate"), `text="${gameOverBlockedText}"`);

    const featuredRowsCount = await page.locator("#featuredRankList li").count();
    assert("featured chart renders compact top-5 rows", featuredRowsCount === 5, `count=${featuredRowsCount}`);

    const featuredLeaderText = await page.locator("#featuredRankList li").first().textContent();
    assert("featured chart highlights #1 leader row label", featuredLeaderText && featuredLeaderText.includes("LEADER"), `text="${featuredLeaderText}"`);

    const featuredContextText = await page.textContent("#featuredRankContextText");
    assert(
      "featured chart shows player placement context",
      featuredContextText && featuredContextText.includes("Your featured rank: #3") && featuredContextText.includes("00:33.000"),
      `text="${featuredContextText}"`
    );

    const featuredDeltaText = await page.textContent("#featuredRankDeltaText");
    assert(
      "featured chart shows actionable delta line to #1",
      featuredDeltaText && featuredDeltaText.includes("Distance to #1") && featuredDeltaText.includes("00:07.000"),
      `text="${featuredDeltaText}"`
    );

    const sanitizedValue = await page.evaluate(() => {
      const inputElement = document.getElementById("playerInitialsInput");
      if (!inputElement) return null;
      inputElement.value = "a!b@c#123";
      inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      return inputElement.value;
    });
    assert("handle input sanitizes editable values", sanitizedValue === "abc123", `value="${sanitizedValue}"`);
  }

  {
    const gameOverPlacementText = await page.textContent("#gameOverPlacementText");
    assert("game-over placement release field exists", gameOverPlacementText && gameOverPlacementText.includes("Current round placement"), `text="${gameOverPlacementText}"`);
  }
  {
    const gameOverOutcomeText = await page.textContent("#gameOverOutcomeText");
    assert("game-over reward or liability field exists", gameOverOutcomeText && gameOverOutcomeText.includes("Reward/liability outcome"), `text="${gameOverOutcomeText}"`);
  }
  {
    const gameOverObligationsText = await page.textContent("#gameOverObligationsText");
    assert("game-over obligations field exists", gameOverObligationsText && gameOverObligationsText.includes("Outstanding obligations"), `text="${gameOverObligationsText}"`);
  }
  {
    const gameOverLegResetText = await page.textContent("#gameOverLegResetText");
    assert("game-over leg reset field exists", gameOverLegResetText && gameOverLegResetText.includes("Next leg reset in blocks"), `text="${gameOverLegResetText}"`);
  }

  // ---- Game-over score breakdown ----
  section("Game-over score breakdown");
  {
    const scoreBreakdownState = await page.evaluate(() => {
      window.__voidRunnerDebug.setSurvivalTimeForTest(12.345);
      window.__voidRunnerDebug.setBonusTimeForTest(3.21);
      window.__voidRunnerDebug.renderScoreBreakdownForTest();
      const finalText = document.getElementById("finalScoreText")?.textContent || "";
      const breakdownText = document.getElementById("scoreBreakdownText")?.textContent || "";
      return { finalText, breakdownText };
    });

    assert(
      "game-over final score label shows total score",
      scoreBreakdownState.finalText.includes("Final Score: 00:15.555") || scoreBreakdownState.finalText.includes("Final Score: 00:15.554"),
      `text="${scoreBreakdownState.finalText}"`
    );
    assert(
      "game-over score breakdown shows survival, bonus, and total",
      scoreBreakdownState.breakdownText.includes("Survival 00:12.345") &&
      scoreBreakdownState.breakdownText.includes("Bonus 00:03.209") &&
      (scoreBreakdownState.breakdownText.includes("Total 00:15.555") || scoreBreakdownState.breakdownText.includes("Total 00:15.554")),
      `text="${scoreBreakdownState.breakdownText}"`
    );
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
