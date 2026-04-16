# Relay Release QA Test Plan

## Scope
This plan validates deterministic round/leg derivation, settlement generation/reuse, eligibility/obligation behavior, API integration, and UI integration tied to release economy behavior.

Primary implementation under test:
- [`leaderboard-relay.js`](leaderboard-relay.js)
- [`index.html`](index.html)

Primary automated suites:
- [`relay.test.js`](relay.test.js)
- [`relay-http.test.js`](relay-http.test.js)
- [`game.test.js`](game.test.js)
- [`admin-relay.test.js`](admin-relay.test.js)

## Requirement Cross-Checks
- Deterministic rounds/legs from README release model: [`README.md`](README.md:12)
- Settlement model schedules and minimum participants: [`README.md`](README.md:22)
- Final-release persistence and UI polish changes: [`CHANGELOG.md`](CHANGELOG.md:5)

## Test Matrix (Pass/Fail Criteria)

### 1) Round and leg boundary derivation
- Coverage source: boundary sections in [`relay-http.test.js`](relay-http.test.js:602)
- Added exact-boundary checks in [`relay-http.test.js`](relay-http.test.js:613)
- **Pass criteria**
  - Block 119 -> round 0
  - Block 120 -> round 1
  - Block 1439 -> leg 0
  - Block 1440 -> leg 1
  - Round/leg IDs remain aligned at transition
- **Fail criteria**
  - Any boundary mismatch or inconsistent round/leg relationship

### 2) Settlement generation and schedule integrity
- Coverage source: settlement sections in [`relay.test.js`](relay.test.js:682) and [`relay-http.test.js`](relay-http.test.js:612)
- **Pass criteria**
  - `< 10` participants => `closed-no-settlement`
  - `>= 10` participants => `settled`
  - Winners count = 4 with amounts `100,70,20,10`
  - Liabilities count = 6 with amounts `28,30,33,35,36,38`
- **Fail criteria**
  - Any payout/liability schedule drift or invalid status transition

### 3) Settlement persistence reuse
- Added persisted-record reuse checks in [`relay-http.test.js`](relay-http.test.js:680)
- **Pass criteria**
  - Existing settlement under release namespace is reused (no regeneration drift)
  - Persisted payload fields (e.g. `generatedAtBlock`) remain intact
- **Fail criteria**
  - Endpoint returns recomputed payload despite valid stored settlement

### 4) Eligibility and obligations lifecycle
- Coverage source: eligibility/obligations checks in [`relay-http.test.js`](relay-http.test.js:648)
- Added leg-transition clearing check in [`relay-http.test.js`](relay-http.test.js:715)
- **Pass criteria**
  - Liability in current leg => `blockedUntilLegEnd=true`, `unpaid=true`
  - Previous-leg liabilities do not block at new leg start
- **Fail criteria**
  - Blocked status persists incorrectly across leg rollover

### 5) Tie and ordering determinism
- Existing tie checks in [`relay.test.js`](relay.test.js:640)
- Added standings tie-break checks in [`relay-http.test.js`](relay-http.test.js:699)
- **Pass criteria**
  - Higher score ranks first
  - For equal score, earlier `updatedAt` wins
  - For exact score + timestamp tie, lexical handle order is stable
- **Fail criteria**
  - Non-deterministic ordering across repeated runs

### 6) Property-based invariant checks
- Added randomized invariant suites in [`relay.test.js`](relay.test.js:740)
- **Pass criteria**
  - 500 random round/leg samples satisfy containment and range-width invariants
  - 120 random settlement samples satisfy status and payout/liability invariants
- **Fail criteria**
  - Any invariant breach under randomized sample set

### 7) Frontend integration with relay model
- Coverage source: release widget and player-flow checks in [`game.test.js`](game.test.js:173)
- **Pass criteria**
  - Menu/game-over release widgets render expected text blocks
  - Featured rank context appears from relay-backed data
  - Relay/API failure noise does not trigger false JS-error test failures
- **Fail criteria**
  - Missing release widgets or uncaught runtime JS failures

## Critical Failure Modes Prioritized
- Invalid round/leg transition around exact boundaries
- Settlement schedule corruption
- Eligibility blocked-state corruption across leg transitions
- Persisted-settlement read path regressions
- Tie-break non-determinism

## Determinism and Mocking Strategy
- HTTP relay tests run with deterministic in-memory RPC stubs in [`startRelay()`](relay-http.test.js:50)
- Block height is controlled using `withRelayAtHeight` in [`relay-http.test.js`](relay-http.test.js:228)
- Browser tests mock rank API responses using Playwright routing in [`game.test.js`](game.test.js:69)

## Automation / CI
- Release suite command: [`validate:release`](package.json:13)
- Coverage commands: [`coverage:relay`](package.json:14), [`coverage:release`](package.json:15)
- CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
  - Runs release validation
  - Runs relay coverage
  - Uploads coverage HTML artifact

## Latest Execution Evidence
- `npm run validate:release` succeeded
- `npm run coverage:relay` succeeded
- Updated totals include:
  - [`relay.test.js`](relay.test.js): 54 passed
  - [`relay-http.test.js`](relay-http.test.js): 154 passed
  - [`admin-relay.test.js`](admin-relay.test.js): 9 passed
  - [`game.test.js`](game.test.js): 68 passed
