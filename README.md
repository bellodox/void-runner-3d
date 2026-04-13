# Void Runner 3D Relay & Browser Experience

## Overview
- Void Runner 3D is a browser-friendly 3D space dodging game that runs inside a single [`index.html`](index.html) client using Three.js, procedural audio, and localStorage while targeting smooth 60 FPS play across desktop and mobile browsers.
- The current MVP uses a split relay architecture: the public [`leaderboard-relay.js`](leaderboard-relay.js) serves health, leaderboard, registration, and prize-read telemetry, while the admin-only [`admin-relay.js`](admin-relay.js) handles prize window writes, sendtoname payouts, and other protected operations.
- Players survive asteroid fields across three difficulty tiers, collect power-ups, register a unique handle, and submit player-owned on-chain records instead of writing into a shared leaderboard namespace.

## Table of Contents
1. [Installation](#installation)
2. [Beta Launch Checklist](#beta-launch-checklist)
3. [Usage Guidelines](#usage-guidelines)
4. [Technical Details](#technical-details)
5. [Contribution Guidelines](#contribution-guidelines)
6. [Changelog](#changelog)
7. [License](#license)

## Installation
1. Ensure you have Node.js **18+** installed as required by [`package.json`](package.json:15-17).
2. Run `npm install` if needed. The project currently has no external npm packages, but the command remains safe for future updates.
3. Start the public relay with `npm run relay` or `node leaderboard-relay.js` to expose leaderboard, health, registration, and public prize telemetry on `127.0.0.1:8787` through [`relay`](package.json:7).
4. Start the admin relay with `npm run relay:admin` or `node admin-relay.js` after configuring `ADMIN=true`, `PRIZE_POT_ADDRESS`, and `MVP_ADMIN_KEY`; this uses [`relay:admin`](package.json:8) and keeps prize and payout writes isolated from public traffic.
5. Open [`index.html`](index.html) in a current browser (Chrome, Firefox, Safari, Edge, or mobile equivalents) through a static host or `file://` URI to play the game.
6. Make sure a local SpaceXpanse ROD node is available at `127.0.0.1:11999` so both relays can fulfill JSON-RPC requests.
7. Ensure RPC credentials in [`.env`](.env) and `spacexpanse.conf` match your local node settings.

## Beta Launch Checklist

### Minimum operational steps
1. Confirm Node.js 18+ (`node -v`) and a SpaceXpanse ROD node listening on `127.0.0.1:11999`.
2. Set `ROD_RPC_USER` and `ROD_RPC_PASSWORD` in [`.env`](.env) if your RPC node enforces authentication.
3. Optionally define `MVP_ADMIN_KEY`, `MVP_PAYOUT_AMOUNT`, `ADMIN=true`, and `PRIZE_POT_ADDRESS` before starting relays.
4. Start the public relay with `npm run relay` or `node leaderboard-relay.js`.
5. Start the admin relay with `npm run relay:admin` or `node admin-relay.js`.
6. Verify `GET /api/health` reports `relay: "up"`, `node: "up"`, and an `integrity` payload that matches expectations.
7. Exercise the browser client through [`index.html`](index.html) and complete a registration plus submit flow.

### Runtime dependencies and startup order
- **Node.js 18+** drives both relays and the validation scripts declared in [`package.json`](package.json:6-14).
- **SpaceXpanse ROD JSON-RPC node** must be running on `127.0.0.1:11999` before either relay boots so they can issue `name_show`, `name_update`, `getblockcount`, and payout RPC calls.
- **Public relay startup**: `npm run relay` → integrity initialization → listen on `127.0.0.1:8787`.
- **Admin relay startup**: `npm run relay:admin` with `ADMIN=true`, `PRIZE_POT_ADDRESS`, and `MVP_ADMIN_KEY` on its dedicated admin port.
- **Game client startup**: open [`index.html`](index.html) after the public relay is healthy.

### Runtime environment variables
- `RELAY_INTEGRITY_MODE` — `dev` (default), `warn`, or `strict`; non-`dev` modes hash [`index.html`](index.html) and [`leaderboard-relay.exe`](leaderboard-relay.exe) against on-chain values and can downgrade or block writes.
- `ROD_RPC_USER` / `ROD_RPC_PASSWORD` — optional unless your ROD node requires RPC auth.
- `MVP_ADMIN_KEY` — defaults to `voidrunner3d-mvp-admin`; used by protected prize-close flows.
- `MVP_PAYOUT_AMOUNT` — defaults to `0.01`; fallback payout amount for manual close-window actions.
- `PRIZE_POT_ADDRESS` — required by the admin relay for prize and payout controls.
- `ADMIN=true` — required to enable admin-only behavior in [`admin-relay.js`](admin-relay.js).

### Key operational flows
- **Starting the public relay**: run `npm run relay` or `node leaderboard-relay.js` and confirm the listener on `http://127.0.0.1:8787` starts cleanly.
- **Starting the admin relay**: run `npm run relay:admin` or `node admin-relay.js` with admin env vars so prize writes, sendtoname payouts, and prize-window controls stay on the admin port only.
- **Running tests**: run `npm run validate:mvp` via [`validate:mvp`](package.json:13) to execute [`relay.test.js`](relay.test.js), [`relay-http.test.js`](relay-http.test.js), [`admin-relay.test.js`](admin-relay.test.js), and [`game.test.js`](game.test.js) in one pass.
- **Checking health and integrity**: query `GET /api/health` on the public relay to inspect `relay`, `node`, and `integrity` state.
- **Reading prize telemetry**: use public `GET /api/prizes/latest` to surface the latest prize metadata and featured winner context without exposing admin writes.
- **Closing a prize window manually**: send `POST /api/prizes/close-window` to the admin relay with the admin key, prize type (`hourly|daily|weekly`), difficulty (`easy|normal|hard`), block heights, and optional payout amount.
- **Read-only behavior**: when integrity enters degraded or blocked mode, mutating routes return `503` until the mismatch is resolved or `RELAY_INTEGRITY_MODE` is relaxed.

## Usage Guidelines
- At launch, choose Easy, Normal, or Hard and start a run from the main menu.
- During gameplay, collect shield and speed boost power-ups, dodge asteroid waves, and watch the HUD for timer, difficulty, local best, salvage multiplier, score breakdown, pot funding, and featured rank context.
- On Game Over, unregistered players see an editable handle field and Register guidance; registered players see a locked handle and a Submit action.
- Submit only becomes available when the player is registered and the latest run beats that player’s current chain best for the selected difficulty.
- Duplicate-handle registrations return a clear conflict path so players can choose another handle immediately.
- Anti-cheat timing now auto-pauses when the tab loses focus or becomes hidden, so survival time no longer advances in the background.
- Round-specific hourly countdown and recent-winner widgets remain hidden in the public client until the admin-ready telemetry path is fully restored.

## Technical Details
- The browser client remains a single self-contained [`index.html`](index.html) file with inline markup, styling, and script.
- The public [`leaderboard-relay.js`](leaderboard-relay.js) exposes `GET /api/health`, `GET /api/player/status`, `POST /api/player/register`, `GET /api/leaderboard`, `POST /api/leaderboard/submit`, and public prize-read telemetry including `GET /api/prizes/latest`.
- The admin [`admin-relay.js`](admin-relay.js) owns admin-only prize and payout operations including protected prize window writes and `POST /api/prizes/close-window`.
- Player identity uses the `p/<handle>` namespace, while score records use `g/voidrunner3d/<handle>/record` and update only the owning player’s record.
- Prize metadata uses `g/voidrunner3d/prizes/{type}/{index}` with latest pointers so clients can read recent prize outcomes without exposing write routes publicly.
- Difficulty support remains `easy`, `normal`, and `hard`, and top-ten standings are derived by scanning `g/voidrunner3d/` records and aggregating best scores per difficulty.
- localStorage bests remain independent from on-chain leaderboard standings.
- Gameplay state still follows the MENU → PLAYING → GAME_OVER → PAUSED flow with object pooling and active-play timer accumulation.
- [`leaderboard-relay.exe`](leaderboard-relay.exe) mirrors the relay’s read-only verification behavior when integrity warnings are active.

## Contribution Guidelines
- Document every user-facing change in [`CHANGELOG.md`](CHANGELOG.md).
- Keep README operational guidance aligned with the current relay split, endpoint behavior, and testing workflow.
- Preserve the single-file nature of [`index.html`](index.html) unless a breaking architectural change requires otherwise.
- Use the scripts declared in [`package.json`](package.json:6-14) when verifying relay or game behavior before publishing documentation updates.

## Changelog
- The latest documented changes are tracked in [`CHANGELOG.md`](CHANGELOG.md:1).

## License
- No license file currently exists. Use this repository under the default rights granted by the owner until an explicit license is provided.
