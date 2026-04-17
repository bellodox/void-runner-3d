# Void Runner 3D v0.2.0

## Overview
- [`index.html`](index.html) is the shipped single-file browser client.
- [`leaderboard-relay.js`](leaderboard-relay.js) is the authoritative public relay for leaderboard reads, player registration, player-owned score submission, integrity enforcement, and release economy views.
- [`admin-relay.js`](admin-relay.js) is limited to diagnostics-only health reporting when `ADMIN=true`; it is not an authoritative economy service in `v0.2.0`.

The shipped `v0.2.0` runtime keeps the release-track implementation from `v0.1.0` and adds UI polish for player visibility and post-run inspection while simplifying settlement handling to pure on-demand derivation.

## Shipped release model

### Deterministic rounds and legs
The release economy is derived from block height in [`leaderboard-relay.js`](leaderboard-relay.js:55):
- release namespace: `g/voidrunner3d/release/v1/`
- round size: 120 blocks
- leg size: 1440 blocks
- rounds per leg: 12
- featured release difficulty: Normal

Round and leg IDs, block ranges, and remaining blocks are derived by the relay at runtime through [`getRoundIdFromBlockHeight()`](leaderboard-relay.js:360), [`getLegIdFromBlockHeight()`](leaderboard-relay.js:364), [`getRoundBlockRange()`](leaderboard-relay.js:368), and [`getLegBlockRange()`](leaderboard-relay.js:376).

### Settlement model
The public relay derives release settlements from current block height and player-owned records via [`ensureRoundFinalized()`](leaderboard-relay.js:1089).

If a closed round has at least 10 qualified Normal participants, the relay derives:
- top 4 Normal winner payouts: 100, 70, 20, 10 ROD via [`RELEASE_PAYOUTS`](leaderboard-relay.js:62)
- top 4 Easy winner payouts from a 2 ROD total pot: 1, 0.7, 0.2, 0.1 via [`RELEASE_TIERED_PAYOUTS`](leaderboard-relay.js:63)
- top 4 Hard winner payouts from a 2000 ROD total pot: 1000, 700, 200, 100 via [`RELEASE_TIERED_PAYOUTS`](leaderboard-relay.js:63)
- bottom 6 liabilities anchored to the Normal standings slice: 28, 30, 33, 35, 36, 38 ROD via [`RELEASE_LIABILITIES`](leaderboard-relay.js:69)

Easy and Hard payout tiers follow the same proportional split as Normal, while liabilities and eligibility blocking remain Normal-anchored in [`buildSettlementFromStandings()`](leaderboard-relay.js:1076). The relay reuses a shared leaderboard-candidate scan across supported payout difficulties in [`deriveSettlementForRound()`](leaderboard-relay.js:985).

If a round closes without enough qualified players, the settlement is returned as `closed-no-settlement` by [`buildSettlementFromStandings()`](leaderboard-relay.js:1076).

In the shipped `v0.2.0` runtime, settlements are not persisted or reused from `g/voidrunner3d/release/v1/settlements/*`. They are derived on demand from the participant-owned `g/voidrunner3d/<handle>/record` names and the deterministic round rules.

### Player state model
The shipped runtime keeps the player-owned leaderboard model:
- identity record: `p/<handle>` via [`getIdentityNameForHandle()`](leaderboard-relay.js:295)
- owned game record: `g/voidrunner3d/<handle>/record` via [`getRecordNameForHandle()`](leaderboard-relay.js:299)
- encoded score envelopes: [`parseRecordValue()`](leaderboard-relay.js:421) and [`serializeRecordValue()`](leaderboard-relay.js:492)

Release economy responses are derived at request time from block height and scanned player records through:
- round and leg derivation via [`getCurrentRoundAndLegPayload()`](leaderboard-relay.js:992)
- standings derivation via [`getCurrentStandingsPayload()`](leaderboard-relay.js:1015)
- settlement derivation via [`getRoundSettlementPayload()`](leaderboard-relay.js:1021)
- eligibility and obligations derivation via [`getPlayerEligibilityPayload()`](leaderboard-relay.js:1025) and [`getPlayerOutstandingObligationsPayload()`](leaderboard-relay.js:1045)
- recent settled-round derivation via [`getRecentSettledRoundsPayload()`](leaderboard-relay.js:1056)

No derived release-economy pointers, standings, settlements, or player-leg statuses are written on-chain by the public relay.

## Public relay API

The public relay listens on `127.0.0.1:8787` and exposes the following shipped endpoints from [`leaderboard-relay.js`](leaderboard-relay.js:1203).

### Core endpoints
- `GET /api/health` — relay and node health plus integrity status via [`/api/health`](leaderboard-relay.js:1223)
- `GET /api/leaderboard?difficulty=easy|normal|hard` — top 10 leaderboard reconstruction via [`/api/leaderboard`](leaderboard-relay.js:1234)
- `GET /api/player/status?handle=<handle>` — registration, owned record, and release status via [`/api/player/status`](leaderboard-relay.js:1250)
- `GET /api/leaderboard/rank?handle=<handle>` — featured normal-rank context via [`/api/leaderboard/rank`](leaderboard-relay.js:1275)
- `POST /api/player/register` — create `p/<handle>` and owned record via [`/api/player/register`](leaderboard-relay.js:1300)
- `POST /api/leaderboard/submit` — submit a score into the player-owned record via [`/api/leaderboard/submit`](leaderboard-relay.js:1335)

### Release endpoints
- `GET /api/release/current-round` via [`/api/release/current-round`](leaderboard-relay.js:1371)
- `GET /api/release/current-leg` via [`/api/release/current-leg`](leaderboard-relay.js:1378)
- `GET /api/release/current-standings` via [`/api/release/current-standings`](leaderboard-relay.js:1385)
- `GET /api/release/round-settlement?roundId=<id>` via [`/api/release/round-settlement`](leaderboard-relay.js:1392)
- `GET /api/release/player-eligibility?handle=<handle>` via [`/api/release/player-eligibility`](leaderboard-relay.js:1411)
- `GET /api/release/player-obligations?handle=<handle>` via [`/api/release/player-obligations`](leaderboard-relay.js:1423)
- `GET /api/release/recent-settled-rounds?limit=<n>` via [`/api/release/recent-settled-rounds`](leaderboard-relay.js:1435)

Legacy public MVP endpoints are removed from the shipped relay. The behavior is covered in [`relay-http.test.js`](relay-http.test.js:564) and [`relay-http.test.js`](relay-http.test.js:576).

## Integrity verification

Integrity checking remains part of the shipped release runtime.

At startup, the relay hashes:
- [`index.html`](index.html)
- [`leaderboard-relay.exe`](leaderboard-relay.exe)

and compares them against the expected on-chain values in [`initializeIntegrityVerification()`](leaderboard-relay.js:163).

Supported integrity modes:
- `dev`
- `warn`
- `strict`

When integrity fails in `warn` or `strict`, mutating API requests are blocked by the read-only guard in [`isMutatingRequest()`](leaderboard-relay.js:159) and the request gate in [`server.createServer()`](leaderboard-relay.js:1214).

## Frontend behavior in v0.2.0

### Menu overlay
The menu continues to show release-economy data rather than MVP prize windows.

Shipped widgets in [`index.html`](index.html:572):
- current round text
- round countdown
- current leg text
- leg countdown
- player eligibility status
- reward distribution summary
- tiered Easy/Normal/Hard reward summary

The menu also shows recent settled rounds in [`index.html`](index.html:584) and the chain leaderboard by selected difficulty in [`index.html`](index.html:590).

Release overview data is loaded by [`loadReleaseOverview()`](index.html:1353).

### Game-over overlay
The game-over panel shows release outcome data in [`index.html`](index.html):
- current round placement
- reward or liability outcome
- outstanding obligations
- eligibility gate / blocked status
- next leg reset countdown
- tiered Easy/Normal/Hard reward summary
- featured chart title and payload that follow the active run difficulty on the game-over overlay
- expandable details sections for inspecting release summary data with less default clutter

That state is loaded through [`loadGameOverReleaseSummary()`](index.html:1411).

### Gameplay HUD
The active-run HUD remains focused on gameplay only in [`index.html`](index.html:549):
- difficulty
- timer
- local best
- salvage state
- power-up state

Release economy widgets stay on the menu and game-over overlays instead of the gameplay HUD.

### Registration and submission flow
The browser client keeps the shipped registration and player-owned submission workflow:
- handle input and register / submit buttons in [`index.html`](index.html:620)
- registration flow in [`registerPlayerForChain()`](index.html:1720)
- score submission flow in [`submitScoreToChain()`](index.html:1781)
- player status refresh in [`refreshPlayerStatus()`](index.html:1676)
- active handle visibility through the player badge in the corner controls in [`index.html`](index.html)

Registered handles are locked in the UI after successful registration in [`applyPlayerStatus()`](index.html:1489).

## Diagnostics-only admin relay

[`admin-relay.js`](admin-relay.js) is intentionally reduced in `v0.2.0`.

When `ADMIN=true`, it exposes:
- `GET /api/health` with `scope: "diagnostics-only"` via [`/api/health`](admin-relay.js:116)

It explicitly marks [`leaderboard-relay.js`](leaderboard-relay.js) as the authoritative economy source via [`authoritativeEconomySource`](admin-relay.js:124).

Deprecated manual MVP routes:
- `POST /api/prizes`
- `POST /api/prizes/close-window`

These routes return HTTP 410 and a release deprecation message through [`findDeprecatedRoute()`](admin-relay.js:97) and the deprecated-route handler in [`admin-relay.js`](admin-relay.js:131).

They must not be treated as normal release operations.

## Local development

### Requirements
- Node.js 18+ per [`package.json`](package.json:15)
- SpaceXpanse ROD JSON-RPC node at `127.0.0.1:11999`

### Run the relays
- Public relay: `npm run relay`
- Diagnostics admin relay: `npm run relay:admin`

### Validation
The shipped validation command is [`validate:release`](package.json:13):

`npm run validate:release`

It runs:
- [`relay.test.js`](relay.test.js)
- [`relay-http.test.js`](relay-http.test.js)
- [`admin-relay.test.js`](admin-relay.test.js)
- [`game.test.js`](game.test.js)

Latest validated results for the shipped release state:
- [`relay.test.js`](relay.test.js): 58 passed, 0 failed
- [`relay-http.test.js`](relay-http.test.js): 155 passed, 0 failed
- [`admin-relay.test.js`](admin-relay.test.js): 9 passed, 0 failed
- [`game.test.js`](game.test.js): 71 passed, 0 failed
- combined release validation: 293 passed, 0 failed

## Planned follow-up
- Nostr-based notifications are planned for future release work, covering new-leg start alerts, beaten-record alerts, and bottom-of-leaderboard alerts for registered players, with the roadmap tracked in [`doc/sprint-map.md`](doc/sprint-map.md:126).

## Project files
- [`index.html`](index.html) — shipped browser client
- [`leaderboard-relay.js`](leaderboard-relay.js) — public release relay
- [`admin-relay.js`](admin-relay.js) — diagnostics-only admin relay
- [`leaderboard-relay.exe`](leaderboard-relay.exe) — integrity-tracked relay binary
- [`doc/release-plan.md`](doc/release-plan.md:1) — release design reference
- [`doc/sprint-map.md`](doc/sprint-map.md:1) — release sequencing reference

## License
No license file currently exists. Repository usage remains subject to the owner’s default rights until an explicit license is added.
