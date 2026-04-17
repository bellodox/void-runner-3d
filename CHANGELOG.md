# Changelog

## [0.2.0] - 2026-04-17

### Release settlement model
- Removed settlement-name generation and reuse from [`ensureRoundFinalized()`](leaderboard-relay.js:1034), so the public relay no longer writes or trusts `g/voidrunner3d/release/v1/settlements/*` records.
- Shipped `v0.2.0` round settlements as fully derived responses built on demand from participant-owned `g/voidrunner3d/<handle>/record` names, current block height, and the deterministic payout/liability rules in [`buildSettlementFromStandings()`](leaderboard-relay.js:982).
- Simplified the release model documentation and tests so settlement behavior now reflects the actual source of truth: participant score records plus deterministic round math.

### Frontend and UX
- Added expandable details sections to the game-over release summary in [`index.html`](index.html) so post-run release data is easier to inspect without overloading the default game-over layout.
- Improved the release board layout in [`index.html`](index.html) for clearer leaderboard and release-economy presentation during the shipped `v0.2.0` flow.
- Added a player handle badge to the in-game corner controls in [`index.html`](index.html) so the active registered handle remains visible during play sessions.
- Preserved the relay mode status pill behavior surfaced in the chain panel and game-over state from the late `v0.1.0` UI updates in [`index.html`](index.html).

### Validation and release packaging
- Shipped package version `0.2.0` in [`package.json`](package.json:4).
- Continued to use the release validation workflow in [`validate:release`](package.json:13) for relay, HTTP, admin, and gameplay coverage before shipping.
- Latest relay-focused validation for the shipped `v0.2.0` state: [`relay.test.js`](relay.test.js) 55 passed, 0 failed; [`relay-http.test.js`](relay-http.test.js) 155 passed, 0 failed.

## [0.1.0] - 2026-04-14

### Final release polish
- Updated [`index.html`](index.html) so the chain panel shows relay mode/status to players, refreshes that mode during leaderboard loads and submit-failure recovery, and surfaces clearer relay API error messages for registration and submission failures when available.
- Updated [`leaderboard-relay.js`](leaderboard-relay.js) so round finalization persists settlement records on-chain and later settlement reads reuse stored records when present.
- Added targeted settlement serialization/parsing coverage in [`relay.test.js`](relay.test.js) for the persisted settlement format.

### Backend
- Shipped the public release relay in [`leaderboard-relay.js`](leaderboard-relay.js) as the authoritative runtime for health, leaderboard reads, player registration, player-owned score storage, encoded record envelopes, and chain-scan leaderboard reconstruction.
- Shipped deterministic release-economy support in [`leaderboard-relay.js`](leaderboard-relay.js:55) with block-derived rounds and legs, current round and current leg pointers, current standings, round settlement, player eligibility, player obligations, and recent settled rounds.
- Shipped settlement generation in [`ensureRoundFinalized()`](leaderboard-relay.js:996) with the `v0.1.0` payout schedule of 100, 70, 20, and 10 ROD plus liability amounts of 28, 30, 33, 35, 36, and 38 ROD.
- Preserved integrity verification of [`index.html`](index.html) and [`leaderboard-relay.exe`](leaderboard-relay.exe) through [`initializeIntegrityVerification()`](leaderboard-relay.js:163), including read-only degradation for failed integrity checks.

### Frontend
- Shipped release-phase economy widgets in the menu overlay in [`index.html`](index.html:572) for current round, round countdown, current leg, leg countdown, player eligibility, and reward distribution.
- Shipped recent settled-round visibility in [`index.html`](index.html:584) and game-over release outcome widgets in [`index.html`](index.html:604) for placement, reward or liability result, obligations, blocked status, and leg reset countdown.
- Kept the gameplay HUD in [`index.html`](index.html:549) focused on run-time gameplay state instead of release-economy panels.
- Preserved the shipped registration and submit-to-chain flow in [`index.html`](index.html:1720) and [`index.html`](index.html:1781), including handle locking after successful registration in [`applyPlayerStatus()`](index.html:1489).

### Runtime and admin model
- Reduced [`admin-relay.js`](admin-relay.js) to diagnostics-only scope with health reporting and explicit non-authoritative status for the release economy.
- Deprecated and disabled legacy MVP admin routes `POST /api/prizes` and `POST /api/prizes/close-window` in [`admin-relay.js`](admin-relay.js:37) and [`admin-relay.js`](admin-relay.js:131).
- Removed public MVP prize-window and pot-status behavior from the shipped release relay, as covered by [`relay-http.test.js`](relay-http.test.js:564) and [`relay-http.test.js`](relay-http.test.js:576).

### Validation
- Shipped package version `0.1.0` and the release validation command [`validate:release`](package.json:13).
- Validated the release runtime with passing results in [`relay.test.js`](relay.test.js), [`relay-http.test.js`](relay-http.test.js), [`admin-relay.test.js`](admin-relay.test.js), and [`game.test.js`](game.test.js).
- Latest validated totals: 49 + 137 + 9 + 68 = 261 passing tests, 0 failures.
