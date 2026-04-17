# Changelog

## [Unreleased]

### Planned
- Added a documentation todo for Nostr-based notifications covering new-leg start alerts, beaten-record alerts, and bottom-of-leaderboard alerts in [`doc/sprint-map.md`](doc/sprint-map.md).

## [0.2.1] - 2026-04-17

### Release economy
- Clarified the shipped `v0.2.1` release model around [`buildSettlementFromStandings()`](leaderboard-relay.js:1087), including independent Easy/Normal/Hard qualification, per-difficulty winners, per-difficulty liabilities, and aggregated same-round obligations in [`derivePlayerLegStatus()`](leaderboard-relay.js:1018).
- Documented the authoritative tiered payout and liability schedules from [`RELEASE_TIERED_PAYOUTS`](leaderboard-relay.js:63) and [`RELEASE_TIERED_LIABILITIES`](leaderboard-relay.js:70), including the whole-pot interpretation for Easy `2 ROD` and Hard `2000 ROD`.
- Updated the release design reference in [`doc/release-plan.md`](doc/release-plan.md) so it matches the shipped on-demand settlement flow instead of older persisted-settlement assumptions.

### Frontend and UX
- Documented the shipped estimated-duration countdown presentation backed by [`formatBlocksRemaining()`](index.html:1032), which now explains remaining blocks as both block counts and approximate wall-clock durations in the browser UI.
- Documented the shipped UI affordances in [`index.html`](index.html), including the difficulty-aware featured chart, tiered reward summaries, mode summary board, expandable help panels, player handle badge, and the centered project repository footer link.

### Documentation
- Updated [`README.md`](README.md), [`doc/game-description.md`](doc/game-description.md), and [`doc/relay-release-test-plan.md`](doc/relay-release-test-plan.md) so the shipped release documentation aligns with the current `v0.2.1` runtime and test expectations.
- Updated release version references in [`package.json`](package.json:4) and release-facing docs to ship as `v0.2.1`.
- Confirmed recent release-scope changes from git history on the `v0.2` line, including the project footer link, tiered settlement support, tiered reward display updates, difficulty-aware documentation refresh, estimated duration countdowns, and the final proportional settlement/liability implementation.

### Validation
- Recorded the latest validated results aligned with the shipped release runtime: [`relay.test.js`](relay.test.js) `58` passed, `0` failed; [`relay-http.test.js`](relay-http.test.js) `166` passed, `0` failed; [`admin-relay.test.js`](admin-relay.test.js) `9` passed, `0` failed; [`game.test.js`](game.test.js) `71` passed, `0` failed.
- Kept the release validation workflow in [`validate:release`](package.json:13) as the canonical pre-ship command for the public relay, admin relay, HTTP integration, and browser gameplay coverage.

## [0.2.0] - 2026-04-17

### Release settlement model
- Removed settlement-name generation and reuse from [`ensureRoundFinalized()`](leaderboard-relay.js:1186), so the public relay no longer writes or trusts `g/voidrunner3d/release/v1/settlements/*` records.
- Shipped `v0.2.0` round settlements as fully derived responses built on demand from participant-owned `g/voidrunner3d/<handle>/record` names, current block height, and the deterministic payout/liability rules in [`buildSettlementFromStandings()`](leaderboard-relay.js:1087).
- Simplified the release model documentation and tests so settlement behavior now reflects the actual source of truth: participant score records plus deterministic round math.

### Frontend and UX
- Added expandable details sections to the game-over release summary in [`index.html`](index.html) so post-run release data is easier to inspect without overloading the default game-over layout.
- Improved the release board layout in [`index.html`](index.html) for clearer leaderboard and release-economy presentation during the shipped `v0.2.0` flow.
- Added a player handle badge to the in-game corner controls in [`index.html`](index.html) so the active registered handle remains visible during play sessions.
- Preserved the relay mode status pill behavior surfaced in the chain panel and game-over state from the late `v0.1.0` UI updates in [`index.html`](index.html).

### Validation and release packaging
- Shipped package version `0.2.0` in [`package.json`](package.json:4).
- Continued to use the release validation workflow in [`validate:release`](package.json:13) for relay, HTTP, admin, and gameplay coverage before shipping.
- Latest relay-focused validation for the shipped `v0.2.0` state: [`relay.test.js`](relay.test.js) `55` passed, `0` failed; [`relay-http.test.js`](relay-http.test.js) `155` passed, `0` failed.

## [0.1.0] - 2026-04-14

### Final release polish
- Updated [`index.html`](index.html) so the chain panel shows relay mode/status to players, refreshes that mode during leaderboard loads and submit-failure recovery, and surfaces clearer relay API error messages for registration and submission failures when available.
- Updated [`leaderboard-relay.js`](leaderboard-relay.js) so round finalization persists settlement records on-chain and later settlement reads reuse stored records when present.
- Added targeted settlement serialization/parsing coverage in [`relay.test.js`](relay.test.js) for the persisted settlement format.

### Backend
- Shipped the public release relay in [`leaderboard-relay.js`](leaderboard-relay.js) as the authoritative runtime for health, leaderboard reads, player registration, player-owned score storage, encoded record envelopes, and chain-scan leaderboard reconstruction.
- Shipped deterministic release-economy support in [`leaderboard-relay.js`](leaderboard-relay.js:57) with block-derived rounds and legs, current round and current leg pointers, current standings, round settlement, player eligibility, player obligations, and recent settled rounds.
- Shipped settlement generation in [`ensureRoundFinalized()`](leaderboard-relay.js:1186) with the `v0.1.0` payout schedule of `100`, `70`, `20`, and `10` ROD plus liability amounts of `28`, `30`, `33`, `35`, `36`, and `38` ROD.
- Preserved integrity verification of [`index.html`](index.html) and [`leaderboard-relay.exe`](leaderboard-relay.exe) through [`initializeIntegrityVerification()`](leaderboard-relay.js:210), including read-only degradation for failed integrity checks.

### Frontend
- Shipped release-phase economy widgets in the menu overlay in [`index.html`](index.html) for current round, round countdown, current leg, leg countdown, player eligibility, and reward distribution.
- Shipped recent settled-round visibility in [`index.html`](index.html) and game-over release outcome widgets in [`index.html`](index.html) for placement, reward or liability result, obligations, blocked status, and leg reset countdown.
- Kept the gameplay HUD in [`index.html`](index.html) focused on run-time gameplay state instead of release-economy panels.
- Preserved the shipped registration and submit-to-chain flow in [`index.html`](index.html) and [`index.html`](index.html), including handle locking after successful registration in [`applyPlayerStatus()`](index.html:1929).

### Runtime and admin model
- Reduced [`admin-relay.js`](admin-relay.js) to diagnostics-only scope with health reporting and explicit non-authoritative status for the release economy.
- Deprecated and disabled legacy MVP admin routes `POST /api/prizes` and `POST /api/prizes/close-window` in [`admin-relay.js`](admin-relay.js:37) and [`admin-relay.js`](admin-relay.js:131).
- Removed public MVP prize-window and pot-status behavior from the shipped release relay, as covered by [`relay-http.test.js`](relay-http.test.js:564) and [`relay-http.test.js`](relay-http.test.js:576).

### Validation
- Shipped package version `0.1.0` and the release validation command [`validate:release`](package.json:13).
- Validated the release runtime with passing results in [`relay.test.js`](relay.test.js), [`relay-http.test.js`](relay-http.test.js), [`admin-relay.test.js`](admin-relay.test.js), and [`game.test.js`](game.test.js).
- Latest validated totals: `49 + 137 + 9 + 68 = 261` passing tests, `0` failures.
