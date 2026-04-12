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

## Usage Guidelines
- At launch, navigate the menu to select Easy, Normal, or Hard difficulty, then tap Start to begin the asteroid-dodging run.
- During gameplay, collect shield and speed boost power-ups, survive waves of asteroids spawned via the delta-time loop, and monitor HUD elements such as timer, difficulty, and local best time.
- When the run ends, the overlay displays final score details and allows submitting results to the chain leaderboard through the relay, which keeps localStorage-based bests separate from on-chain top-ten data.
- Touch-friendly controls (keyboard, mouse, mobile touch) are supported, and the local relay reports statuses for chain and health endpoints to keep players informed of backend availability .
- Upon Game Over, unregistered players are guided to Register before submitting, while registered players see a Submit action that only enables once a valid score exists; once a handle is registered it is locked in the UI with messaging that prevents further edits.

-## Technical Details
- The browser client remains a single self-contained file (`index.html`) with inline markup, styling, and script so no build system is required; developers can open it directly or through any static host.
- Blockchain leaderboard handling runs through `leaderboard-relay.js`, which now implements a player-owned leaderboard architecture rather than the old shared leaderboard table.
- The relay/API surface exposes health, registration, and per-player scoring endpoints: `GET /api/health`, `GET /api/player/status`, `POST /api/player/register`, `GET /api/leaderboard`, and `POST /api/leaderboard/submit`.
- Players must register before submitting scores; registration associates a handle namespace (`p/<handle>`) that the relay enforces for subsequent submissions, and each submitted score updates only that player’s own `g/voidrunner3d/<handle>/record` entry.
- Registration treats `handle` as the sole identifier, rejects duplicate handles with HTTP 409 to preserve uniqueness, and leaves registered handles immutable within the UI so leaderboard submissions remain tied to the same `p/<handle>` record.
- Difficulty support remains `easy`, `normal`, and `hard`, and top-ten standings are derived by scanning/querying every `g/voidrunner3d/` record on-chain, aggregating the best scores per difficulty from registered players.
- The relay depends on Node.js 18+, forwards requests to the SpaceXpanse ROD JSON-RPC node, and preserves localStorage bests independently while writing top-ten data on-chain.
- Procedural audio uses Web Audio API, and Three.js r128 renders the 3D scene; local performance patterns follow a MENU → PLAYING → GAME_OVER → PAUSED state machine with object pooling for efficiency.

## Contribution Guidelines
- Document all project changes in the `CHANGELOG.md`, describing new features, bugs, or next steps so future collaborators know the current state and documentation cadence.
- After each set of updates, add a timestamped, priority-aware entry to `CHANGELOG.md` so auditors can track modifications (`CHANGELOG.md`:1-8).
- Preserve the single-file nature of `index.html` unless a breaking change absolutely requires extra assets; keep gameplay and HUD logic tightly coupled and mention any external dependencies you introduce in both the tech and architecture memory bank files.
- Use described scripts and versions, and run `node leaderboard-relay.js` to verify the leaderboard relay before publishing any client-side changes (`package.json`:1-11).

## Changelog
- [`CHANGELOG.md`](CHANGELOG.md:1-8) describes the latest documentation-focused updates, including the refreshed memory bank context and the new changelog process.

## License
- No license file currently exists. Use this repository under the default rights granted by the owner until an explicit license is provided.
