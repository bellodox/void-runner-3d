# Relay Release QA Test Plan

## Scope
This plan validates deterministic round/leg derivation, settlement generation, eligibility/obligation behavior, API integration, and UI integration tied to release economy behavior.

Primary implementation under test:
- [`leaderboard-relay.js`](../leaderboard-relay.js)
- [`index.html`](../index.html)

Primary automated suites:
- [`relay.test.js`](../relay.test.js)
- [`relay-http.test.js`](../relay-http.test.js)
- [`game.test.js`](../game.test.js)
- [`admin-relay.test.js`](../admin-relay.test.js)

## Requirement Cross-Checks
- Deterministic rounds/legs from [`README.md`](../README.md:12)
- Settlement model schedules, minimum participants, and on-demand derivation from [`README.md`](../README.md:22)
- `v0.2.1` release packaging and documentation alignment from [`CHANGELOG.md`](../CHANGELOG.md:3)

## Test Matrix (Pass/Fail Criteria)

### 1) Round and leg boundary derivation
- Coverage source: boundary sections in [`relay-http.test.js`](../relay-http.test.js:602)
- Added exact-boundary checks in [`relay-http.test.js`](../relay-http.test.js:613)
- **Pass criteria**
  - Block 19 -> round 0
  - Block 20 -> round 1
  - Block 119 -> leg 0
  - Block 120 -> leg 1
  - Round/leg IDs remain aligned at transition
- **Fail criteria**
  - Any boundary mismatch or inconsistent round/leg relationship

### 2) Settlement generation and schedule integrity
- Coverage source: settlement sections in [`relay.test.js`](../relay.test.js:682) and [`relay-http.test.js`](../relay-http.test.js:612)
- **Pass criteria**
  - `qualifiedParticipantsByDifficulty` is exposed and matches per-difficulty participant counts
  - If all difficulties are `< 10` participants => `closed-no-settlement`
  - If any difficulty is `>= 10` participants => `settled`
  - Winners are emitted only for difficulties that independently qualify
  - Normal winners include amounts `100,70,20,10` when Normal qualifies
  - Easy winners include amounts `1,0.7,0.2,0.1` when Easy qualifies
  - Hard winners include amounts `1000,700,200,100` when Hard qualifies
  - Liabilities are emitted per eligible difficulty with matching tiered amounts
    * Normal: `28,30,33,35,36,38`
    * Easy: `0.28,0.3,0.33,0.35,0.36,0.38`
    * Hard: `280,300,330,350,360,380`
  - `qualifiedParticipants` remains present for compatibility
- **Fail criteria**
  - Any payout/liability schedule drift or invalid status transition

### 3) Eligibility and obligations lifecycle
- Coverage source: eligibility/obligations checks in [`relay-http.test.js`](../relay-http.test.js:648)
- Added leg-transition clearing check in [`relay-http.test.js`](../relay-http.test.js:715)
- **Pass criteria**
  - Liability in current leg => `blockedUntilLegEnd=true`, `unpaid=true`
  - Previous-leg liabilities do not block at new leg start
  - Multi-difficulty liabilities aggregate per handle inside the same round
- **Fail criteria**
  - Blocked status persists incorrectly across leg rollover
  - Aggregated obligations undercount or overcount same-round liabilities

### 4) Tie and ordering determinism
- Existing tie checks in [`relay.test.js`](../relay.test.js:640)
- Added standings tie-break checks in [`relay-http.test.js`](../relay-http.test.js:699)
- **Pass criteria**
  - Higher score ranks first
  - For equal score, earlier `updatedAt` wins
  - For exact score + timestamp tie, lexical handle order is stable
- **Fail criteria**
  - Non-deterministic ordering across repeated runs

### 5) Property-based invariant checks
- Added randomized invariant suites in [`relay.test.js`](../relay.test.js:740)
- **Pass criteria**
  - 500 random round/leg samples satisfy containment and range-width invariants
  - 120 random settlement samples satisfy status and payout/liability invariants
- **Fail criteria**
  - Any invariant breach under randomized sample set

### 6) Frontend integration with relay model
- Coverage source: release widget and player-flow checks in [`game.test.js`](../game.test.js:173)
- **Pass criteria**
  - Menu/game-over release widgets render expected text blocks
  - Menu/game-over tiered reward summaries render for Easy, Normal, and Hard settlement data
  - Round and leg countdown text includes estimated duration output alongside block counts through [`formatBlocksRemaining()`](../index.html:1032)
  - Expandable game-over details and improved release board layout preserve readable release context
  - Player handle badge remains visible in the active UI
  - Project footer link remains visible in the live interface
  - Featured rank context appears from relay-backed data, and the game-over featured chart follows the active run difficulty
  - Relay/API failure noise does not trigger false JS-error test failures
- **Fail criteria**
  - Missing release widgets, broken details sections, missing handle visibility, missing project footer, or uncaught runtime JS failures

## Critical Failure Modes Prioritized
- Invalid round/leg transition around exact boundaries
- Settlement schedule corruption
- Eligibility blocked-state corruption across leg transitions
- Tie-break non-determinism
- Frontend countdown copy drifting away from authoritative block-derived timing

## Determinism and Mocking Strategy
- HTTP relay tests run with deterministic in-memory RPC stubs in [`startRelay()`](../relay-http.test.js:50)
- Block height is controlled using `withRelayAtHeight` in [`relay-http.test.js`](../relay-http.test.js:228)
- Browser tests mock rank API responses using Playwright routing in [`game.test.js`](../game.test.js:69)

## Automation / CI
- Release suite command: [`validate:release`](../package.json:13)
- Coverage commands: [`coverage:relay`](../package.json:14), [`coverage:release`](../package.json:15)
- CI workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
  - Runs release validation
  - Runs relay coverage
  - Uploads coverage HTML artifact

## Latest Execution Evidence
- `npm run validate:release` succeeded for the shipped `v0.2.1` release candidate
- `npm run coverage:relay` remains available for relay-focused inspection
- Updated totals include:
  - [`relay.test.js`](../relay.test.js): 58 passed
  - [`relay-http.test.js`](../relay-http.test.js): 166 passed
  - [`admin-relay.test.js`](../admin-relay.test.js): 9 passed
  - [`game.test.js`](../game.test.js): 71 passed
  - combined release validation: 304 passed
