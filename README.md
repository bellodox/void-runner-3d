# Void Runner 3D v0.2.1

## Overview
- [`index.html`](index.html) is the shipped single-file browser client.
- [`leaderboard-relay.js`](leaderboard-relay.js) is the authoritative public relay for leaderboard reads, player registration, player-owned score submission, integrity enforcement, and release economy views.
- [`admin-relay.js`](admin-relay.js) is limited to diagnostics-only health reporting when `ADMIN=true`; it is not an authoritative economy service in `v0.2.1`.

The shipped `v0.2.1` runtime keeps the `v0.2.0` release-track model and folds in the latest round-economy clarifications, tiered settlement behavior, estimated block-duration UI, and release-documentation alignment.

## Shipped release model

### Deterministic rounds and legs
The release economy is derived from block height in [`leaderboard-relay.js`](leaderboard-relay.js:57):
- release namespace: `g/voidrunner3d/release/v1/`
- round size: 20 blocks
- leg size: 120 blocks
- rounds per leg: 6
- featured release difficulty: Normal

Round and leg IDs, block ranges, and remaining blocks are derived by the relay at runtime through [`getRoundIdFromBlockHeight()`](leaderboard-relay.js:406), [`getLegIdFromBlockHeight()`](leaderboard-relay.js:410), [`getRoundBlockRange()`](leaderboard-relay.js:414), and [`getLegBlockRange()`](leaderboard-relay.js:422).

### Settlement model
The public relay derives release settlements from current block height and player-owned records via [`ensureRoundFinalized()`](leaderboard-relay.js:1186).

Settlement eligibility is evaluated per difficulty in [`buildSettlementFromStandings()`](leaderboard-relay.js:1087):
- the relay counts qualified participants independently for Easy, Normal, and Hard
- settlement proceeds when at least one difficulty has `>= 10` qualified participants
- winners are paid only for difficulties that independently qualify
- liabilities are derived per eligible difficulty using the same bottom-six schedule shape

The payout and liability ladders are tiered per difficulty, with each difficulty's bottom six liabilities summing exactly to that difficulty's top four reward pot:
- **Normal**: rewards `100, 70, 20, 10` / liabilities `28, 30, 33, 35, 36, 38` | total pot `200 ROD`
- **Easy**: rewards `1, 0.7, 0.2, 0.1` / liabilities `0.28, 0.3, 0.33, 0.35, 0.36, 0.38` | total pot `2 ROD`
- **Hard**: rewards `1000, 700, 200, 100` / liabilities `280, 300, 330, 350, 360, 380` | total pot `2000 ROD`

The proportional distribution is identical across all three difficulties; only the scale changes.

Settlement payloads include per-difficulty counts in `qualifiedParticipantsByDifficulty` while preserving `qualifiedParticipants` for compatibility. Player obligations are aggregated per handle across eligible difficulties within the round by [`derivePlayerLegStatus()`](leaderboard-relay.js:1018). The relay reuses a shared leaderboard-candidate scan across supported payout difficulties in [`deriveSettlementForRound()`](leaderboard-relay.js:990).

If a round closes without enough qualified players, the settlement is returned as `closed-no-settlement` by [`buildSettlementFromStandings()`](leaderboard-relay.js:1107).

In the shipped `v0.2.1` runtime, settlements are not persisted or reused from `g/voidrunner3d/release/v1/settlements/*`. They are derived on demand from participant-owned `g/voidrunner3d/<handle>/record` names and the deterministic round rules.

### Player state model
The shipped runtime keeps the player-owned leaderboard model:
- identity record: `p/<handle>` via [`getIdentityNameForHandle()`](leaderboard-relay.js:365)
- owned game record: `g/voidrunner3d/<handle>/record` via [`getRecordNameForHandle()`](leaderboard-relay.js:369)
- encoded score envelopes: [`parseRecordValue()`](leaderboard-relay.js:567) and [`serializeRecordValue()`](leaderboard-relay.js:638)

Release economy responses are derived at request time from block height and scanned player records through:
- round and leg derivation via [`getCurrentRoundAndLegPayload()`](leaderboard-relay.js:1195)
- standings derivation via [`getCurrentStandingsPayload()`](leaderboard-relay.js:1221)
- settlement derivation via [`getRoundSettlementPayload()`](leaderboard-relay.js:1227)
- eligibility and obligations derivation via [`getPlayerEligibilityPayload()`](leaderboard-relay.js:1231) and [`getPlayerOutstandingObligationsPayload()`](leaderboard-relay.js:1250)
- recent settled-round derivation via [`getRecentSettledRoundsPayload()`](leaderboard-relay.js:1261)

No derived release-economy pointers, standings, settlements, or player-leg statuses are written on-chain by the public relay.

## Public relay API

The public relay listens on `127.0.0.1:8787` and exposes the following shipped endpoints from [`leaderboard-relay.js`](leaderboard-relay.js:1313).

### Core endpoints
- `GET /api/health` — relay and node health plus integrity status via [`/api/health`](leaderboard-relay.js:1333)
- `GET /api/leaderboard?difficulty=easy|normal|hard` — top 10 leaderboard reconstruction via [`/api/leaderboard`](leaderboard-relay.js:1353)
- `GET /api/player/status?handle=<handle>` — registration, owned record, and release status via [`/api/player/status`](leaderboard-relay.js:1369)
- `GET /api/leaderboard/rank?handle=<handle>` — featured normal-rank context via [`/api/leaderboard/rank`](leaderboard-relay.js:1394)
- `POST /api/player/register` — create `p/<handle>` and owned record via [`/api/player/register`](leaderboard-relay.js:1419)
- `POST /api/leaderboard/submit` — submit a score into the player-owned record via [`/api/leaderboard/submit`](leaderboard-relay.js:1454)

### Release endpoints
- `GET /api/release/current-round` via [`/api/release/current-round`](leaderboard-relay.js:1490)
- `GET /api/release/current-leg` via [`/api/release/current-leg`](leaderboard-relay.js:1497)
- `GET /api/release/current-standings` via [`/api/release/current-standings`](leaderboard-relay.js:1504)
- `GET /api/release/round-settlement?roundId=<id>` via [`/api/release/round-settlement`](leaderboard-relay.js:1511)
- `GET /api/release/player-eligibility?handle=<handle>` via [`/api/release/player-eligibility`](leaderboard-relay.js:1530)
- `GET /api/release/player-obligations?handle=<handle>` via [`/api/release/player-obligations`](leaderboard-relay.js:1542)
- `GET /api/release/recent-settled-rounds?limit=<n>` via [`/api/release/recent-settled-rounds`](leaderboard-relay.js:1554)

Legacy public MVP endpoints are removed from the shipped relay. The behavior is covered in [`relay-http.test.js`](relay-http.test.js:564) and [`relay-http.test.js`](relay-http.test.js:576).

## Integrity verification

Integrity checking remains part of the shipped release runtime.

At startup, the relay hashes:
- [`index.html`](index.html)
- [`leaderboard-relay.exe`](leaderboard-relay.exe)

and compares them against the expected on-chain values in [`initializeIntegrityVerification()`](leaderboard-relay.js:210).

Supported integrity modes:
- `dev`
- `warn`
- `strict`

When integrity fails in `warn` or `strict`, mutating API requests are blocked by the read-only guard in [`isMutatingRequest()`](leaderboard-relay.js:206) and the request gate in [`server.createServer()`](leaderboard-relay.js:1313).

## Frontend behavior in v0.2.1

### Menu overlay
The menu continues to show release-economy data rather than MVP prize windows.

Shipped widgets in [`index.html`](index.html:788):
- current round text
- round countdown with estimated real-time duration
- current leg text
- leg countdown with estimated real-time duration
- player eligibility status
- reward distribution summary
- tiered Easy/Normal/Hard reward summary

The menu also shows recent settled rounds in [`index.html`](index.html:801), a difficulty-aware mode summary in [`index.html`](index.html:769), round-economy help in [`index.html`](index.html:809), power-up help in [`index.html`](index.html:821), and the chain leaderboard by selected difficulty in [`index.html`](index.html:781).

Release overview data is loaded by [`loadReleaseOverview()`](index.html:1766), while block countdown formatting now includes estimated durations through [`formatBlocksRemaining()`](index.html:1032).

### Game-over overlay
The game-over panel shows release outcome data in [`index.html`](index.html:834):
- current round placement
- reward or liability outcome
- outstanding obligations
- eligibility gate / blocked status
- next leg reset countdown with estimated real-time duration
- tiered Easy/Normal/Hard reward summary
- featured chart title and payload that follow the active run difficulty on the game-over overlay
- expandable details sections for inspecting release summary data with less default clutter

That state is loaded through [`loadGameOverReleaseSummary()`](index.html:1836).

### Gameplay HUD
The active-run HUD remains focused on gameplay only in [`index.html`](index.html:753):
- difficulty
- timer
- local best
- salvage state
- power-up state

Release economy widgets stay on the menu and game-over overlays instead of the gameplay HUD.

### Registration and submission flow
The browser client keeps the shipped registration and player-owned submission workflow:
- handle input and register / submit buttons in [`index.html`](index.html:844)
- registration flow in [`registerPlayerForChain()`](index.html:2279)
- score submission flow in [`submitScoreToChain()`](index.html:2344)
- player status refresh in [`refreshPlayerStatus()`](index.html:2227)
- active handle visibility through the player badge in [`index.html`](index.html:879)
- project repository footer link in [`index.html`](index.html:886)

Registered handles are locked in the UI after successful registration in [`applyPlayerStatus()`](index.html:1929).

## Diagnostics-only admin relay

[`admin-relay.js`](admin-relay.js) is intentionally reduced in `v0.2.1`.

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
- Node.js 18+ per [`package.json`](package.json:17)
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
- [`relay-http.test.js`](relay-http.test.js): 166 passed, 0 failed
- [`admin-relay.test.js`](admin-relay.test.js): 9 passed, 0 failed
- [`game.test.js`](game.test.js): 71 passed, 0 failed
- combined release validation: 304 passed, 0 failed

## Planned follow-up
- Nostr-based notifications are planned for future release work, covering new-leg start alerts, beaten-record alerts, and bottom-of-leaderboard alerts for registered players, with the roadmap tracked in [`doc/sprint-map.md`](doc/sprint-map.md:126).

## Project files
- [`index.html`](index.html) — shipped browser client
- [`leaderboard-relay.js`](leaderboard-relay.js) — public release relay
- [`admin-relay.js`](admin-relay.js) — diagnostics-only admin relay
- [`leaderboard-relay.exe`](leaderboard-relay.exe) — integrity-tracked relay binary
- [`doc/release-plan.md`](doc/release-plan.md) — release design reference
- [`doc/sprint-map.md`](doc/sprint-map.md) — release sequencing reference

## License
No license file currently exists. Repository usage remains subject to the owner’s default rights until an explicit license is added.
