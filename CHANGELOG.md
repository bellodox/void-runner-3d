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
