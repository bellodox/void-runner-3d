# Changelog — 2026-04-12

## [High] Player-owned leaderboard rollout
- Documented the new registration-aware relay API, namespace naming (`p/<handle>` / `g/voidrunner3d/<handle>/record`), per-player record submission, and derived leaderboard aggregation over `g/voidrunner3d/` entries.
## [High] Handle-only leaderboard refinement
- Clarified that registrations treat `handle` as the sole identifier, that duplicate-handle attempts return HTTP 409, and that registered handles lock in the UI. Added Game Over flow guidance: unregistered players see Register, registered players see Submit, and Submit only enables once a valid score is available.
