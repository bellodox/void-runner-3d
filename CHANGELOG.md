# Changelog — 2026-04-13

## [High] Admin relay governs prize writes and telemetry
- Added `admin-relay.js` to isolate prize window, pot, and sendtoname controls behind `ADMIN=true`, `PRIZE_POT_ADDRESS`, and a dedicated admin port while keeping the public relay read-only for those routes.
- Documented the new public `GET /api/prizes/latest` endpoint along with on-chain storage at `g/voidrunner3d/prizes/{type}/{index}`, so prize metadata and featured winners stay discoverable without exposing sensitive writes.
- Reinforced the release cadence by linking the README, changelog, and memory bank guidance to the new admin workflow and reward validation telemetry.

## [High] Validation workflow and documentation refresh
- Introduced `npm run validate:mvp` to run `relay.test.js`, `relay-http.test.js`, `admin-relay.test.js`, and `game.test.js` in a single guardrail, ensuring both relay and client suites stay synced with the MVP behavior.
- Updated README operations, installation, and usage guidance to highlight the admin relay, prize workflows, and the new validation script so operators and QA teams know where to look for telemetry and controls.

# Changelog — 2026-04-12

## [High] Focus-loss timer anti-cheat fix
- Fixed gameplay timing so survival score no longer advances when the browser loses focus or the tab is hidden/minimized. Added automatic pause on blur/visibility loss, switched timer accounting to active-play accumulation, and added regression coverage verifying timer freeze while paused.

## [High] Player-owned leaderboard rollout
- Documented the new registration-aware relay API, namespace naming (`p/<handle>` / `g/voidrunner3d/<handle>/record`), per-player record submission, and derived leaderboard aggregation over `g/voidrunner3d/` entries.
## [High] Handle-only leaderboard refinement
- Clarified that registrations treat `handle` as the sole identifier, that duplicate-handle attempts return HTTP 409, and that registered handles lock in the UI. Added Game Over flow guidance: unregistered players see Register, registered players see Submit, and Submit only enables once a valid score is available.
## [High] New-user handle UX fix
- Removed the seeded default handle from the Game Over registration flow, restored a true empty first-run state, prevented unrelated registered handles from locking the input, and clarified duplicate-handle errors in the UI.
## [High] Register/submit flow regression coverage
- Added regression coverage for empty first-run handle state, editable handle sanitization, and unregistered status handling so the register/submit UX no longer regresses silently.
