# Void Runner 3D Relay & Browser Experience

## Overview
- Void Runner 3D is a browser-friendly, 3D space dodging experience that runs entirely inside a single HTML file using Three.js, procedural audio, and localStorage for high-score persistence, while targeting smooth 60 FPS gameplay across desktop and mobile browsers.
- Players survive asteroid fields across three difficulty tiers, collect power-ups, and interact with a player-owned leaderboard so that the previous shared leaderboard model is no longer the live design and every score is tied to a registered handle.

## Table of Contents
1. [Installation](#installation)
2. [Usage Guidelines](#usage-guidelines)
3. [Technical Details](#technical-details)
4. [Contribution Guidelines](#contribution-guidelines)
5. [Changelog](#changelog)
6. [License](#license)

## Installation
1. Ensure you have Node.js **18+** installed as the relay requires a modern runtime (`package.json`: [`node`](package.json:8-10)).
2. Install dependencies if present (the project currently has no external npm packages), so `npm install` is optional but safe in future updates.
3. Start the relay with `node leaderboard-relay.js` to expose the blockchain leaderboard endpoints on `127.0.0.1:8787` (`package.json:5-8`).
4. Open `index.html` in a current browser (Chrome, Firefox, Safari, Edge, or mobile equivalents) served through a static host or `file://` URI to experience the game client.
5. Make sure you have a local SpaceXpanse ROD node running at `127.0.0.1:11999`, so the relay can fulfill leaderboard requests via JSON-RPC.
6. Ensure the relay has access to the SpaceXpanse ROD node through the JSON-RPC server at `127.0.0.1:11999` with proper credentials configured in `spacexpanse.conf` and the .env file.

## Beta Launch Checklist

### Minimum operational steps
1. Confirm Node.js 18+ (`node -v`) and a SpaceXpanse ROD node listening on `127.0.0.1:11999` before starting anything else.
2. Seed `ROD_RPC_USER`/`ROD_RPC_PASSWORD` in `.env` (see `.env`: [`ROD_RPC_USER`](.env:1) and [`ROD_RPC_PASSWORD`](.env:2)) if the RPC node enforces basic auth, and optionally define `MVP_ADMIN_KEY` and `MVP_PAYOUT_AMOUNT` before running the relay.
3. Launch the ROD node (`rodd` or your preferred service) so `127.0.0.1:11999` is reachable, then start the relay via `npm run relay` or `node leaderboard-relay.js` ([`leaderboard-relay.js`](leaderboard-relay.js)).
4. Verify `GET /api/health` reports `relay: "up"`, `node: "up"`, and an `integrity` payload that matches expectations.
5. Exercise the browser client (`index.html`) through a static host and complete a registration/submit cycle to ensure leaderboard writes succeed and the manual prize close flow can see real data.

### Runtime dependencies & startup order
- **Node.js 18+** drives the relay account service; no npm dependencies are bundled, but `npm install` future-proofs the project.
- **SpaceXpanse ROD JSON-RPC node** must be running on `127.0.0.1:11999` before the relay boots so the relay can issue `name_show`, `name_update`, `getblockcount`, and payout RPC calls.
- **Relay startup**: `npm run relay` (or `node leaderboard-relay.js`) → `initializeIntegrityVerification` → listen on `127.0.0.1:8787`; the relay fails fast if `RELAY_INTEGRITY_MODE` is `strict` and hashes do not match.
- **Game client** (`index.html`) can follow after the relay reports a healthy status; it talks to the relay for registration, leaderboard, and prize flows.

### Runtime environment variables (defaults lean on current MVP behavior)
- `RELAY_INTEGRITY_MODE` – `dev` (default), `warn`, or `strict`; non-`dev` modes hash `index.html` and `leaderboard-relay.exe` against on-chain values, with `warn` flipping to degraded read-only and `strict` blocking writes.
- `ROD_RPC_USER` / `ROD_RPC_PASSWORD` – optional but required when your ROD node enforces RPC authentication (`.env`: [`ROD_RPC_USER`](.env:1), [`ROD_RPC_PASSWORD`](.env:2)).
- `MVP_ADMIN_KEY` – defaults to `voidrunner3d-mvp-admin`; this key gates `POST /api/prizes/close-window` and should be kept secret in beta.
- `MVP_PAYOUT_AMOUNT` – defaults to `0.01`; used as the fallback payout amount when closing prize windows manually (adjust only after funding the MVP pot).
- The relay also references fixed on-chain constants such as `MVP_POT_FUNDING_ADDRESS` (`RH6CVe24Zf9HqUq6AktYeBLhVeuHBjzL29`), prize window sizes, and the player/record namespace schema, so keep that on-chain structure untouched for beta.

### Key operational flows
- **Starting the relay**: ensure the RPC node is active → set env vars → `npm run relay` / `node leaderboard-relay.js`. Watch console logs for `Void Runner relay listening on http://127.0.0.1:8787` and that integrity verification does not exit with `strict failure`.
- **Running tests**: run `npm run validate:mvp` from the repo root as the unified MVP validation workflow; it executes `relay.test.js`, `relay-http.test.js`, and the deterministic frontend suite in `game.test.js` in one repeatable pass.
- **Checking health & integrity**: hit `curl http://127.0.0.1:8787/api/health`; the JSON body bundles `relay`, `node`, and `integrity` states so you can monitor verified/read-only mode and reason messages.
- **Closing a prize window manually**: issue `POST /api/prizes/close-window` with the admin key, prize type (`hourly|daily|weekly`), difficulty (`easy|normal|hard`), block start/end heights, and optional `payoutAmount`; the relay selects the current leaderboard winner, attempts `sendtoname`, and writes prize records/pointers even if the payout fails (check returned `payout` object for `error`).
- **Read-only behavior**: when `integrity` reports `status: "degraded-read-only"` or `status: "blocked"`, all mutating endpoints respond with `503` and a payload explaining the mode; resolve hash mismatches or set `RELAY_INTEGRITY_MODE=dev` for beta testing to allow writes again.

## Usage Guidelines
- At launch, navigate the menu to select Easy, Normal, or Hard difficulty, then tap Start to begin the asteroid-dodging run.
- During gameplay, collect shield and speed boost power-ups, survive waves of asteroids spawned via the delta-time loop, and monitor HUD elements such as timer, difficulty, and local best time.
- When the run ends, the overlay displays final score details and allows submitting results to the chain leaderboard through the relay, which keeps localStorage-based bests separate from on-chain top-ten data.
- Touch-friendly controls (keyboard, mouse, mobile touch) are supported, and the local relay reports statuses for chain and health endpoints to keep players informed of backend availability.
- Anti-cheat timer handling now auto-pauses gameplay when the tab loses focus or becomes hidden, and survival time no longer advances while paused/backgrounded.
- First-run users now start with an empty handle field instead of inheriting a seeded default name.
- During Game Over, unregistered players see an editable handle field plus Register guidance, while registered players see their locked handle and a Submit action.
- Submit only becomes available when the player is registered and the latest run beats that player's existing chain best for the selected difficulty.
- Duplicate handle attempts now return a clear “already taken” path so players can immediately choose another handle.

## Technical Details
- The browser client remains a single self-contained file ([`index.html`](index.html)) with inline markup, styling, and script so no build system is required; developers can open it directly or through any static host.
- Blockchain leaderboard handling runs through [`leaderboard-relay.js`](leaderboard-relay.js), which implements the player-owned leaderboard architecture rather than the old shared leaderboard table.
- The relay/API surface exposes health, registration, and per-player scoring endpoints: `GET /api/health`, `GET /api/player/status`, `POST /api/player/register`, `GET /api/leaderboard`, and `POST /api/leaderboard/submit`.
- Players must register before submitting scores; registration associates a handle namespace (`p/<handle>`) that the relay enforces for subsequent submissions, and each submitted score updates only that player’s own `g/voidrunner3d/<handle>/record` entry.
- Registration treats `handle` as the sole identifier, rejects duplicate handles with HTTP 409 to preserve uniqueness, and the UI only locks a handle after that exact handle is successfully registered.
- The client no longer auto-assumes a default player handle on first run, and failed status/register checks reset the UI back to an editable state instead of leaving stale lock state behind.
- Difficulty support remains `easy`, `normal`, and `hard`, and top-ten standings are derived by scanning/querying every `g/voidrunner3d/` record on-chain, aggregating the best scores per difficulty from registered players.
- The relay depends on Node.js 18+, forwards requests to the SpaceXpanse ROD JSON-RPC node, and preserves localStorage bests independently while writing top-ten data on-chain.
- Procedural audio uses Web Audio API, and Three.js r128 renders the 3D scene; local performance patterns follow a MENU → PLAYING → GAME_OVER → PAUSED state machine with object pooling for efficiency.
- Timer accounting uses active-play accumulation instead of a single wall-clock origin, so paused time and background-tab time are excluded from score progression.

## Contribution Guidelines
- Document all project changes in the `CHANGELOG.md`, describing new features, bugs, or next steps so future collaborators know the current state and documentation cadence.
- After each set of updates, add a timestamped, priority-aware entry to `CHANGELOG.md` so auditors can track modifications (`CHANGELOG.md`:1-8).
- Preserve the single-file nature of `index.html` unless a breaking change absolutely requires extra assets; keep gameplay and HUD logic tightly coupled and mention any external dependencies you introduce in both the tech and architecture memory bank files.
- Use described scripts and versions, and run `node leaderboard-relay.js` to verify the leaderboard relay before publishing any client-side changes (`package.json`:1-11).

## Changelog
- [`CHANGELOG.md`](CHANGELOG.md:1-8) describes the latest documentation-focused updates, including the refreshed memory bank context and the new changelog process.

## License
- No license file currently exists. Use this repository under the default rights granted by the owner until an explicit license is provided.
