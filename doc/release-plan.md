# Void Runner 3D — Release Design Reference for v0.2.1

## Core Principles

* All reward, round, leg, settlement, and penalty state is derived from authoritative on-chain player records and deterministic relay rules.
* The system is **deterministic** and derived from **block height**, not wall-clock time.
* No admin intervention is required for round progression, settlement visibility, or penalty enforcement.
* The relay acts as the **authoritative interpreter** of chain-visible data for the shipped public release flow.
* In `v0.2.1`, release documentation matches the on-demand settlement model rather than the older persisted-settlement design.

---

## Time and Structure

### Block-Based Timing

* 1 Round = **20 blocks**
* 1 Leg = **120 blocks**
* 1 Leg = **6 rounds**

### Derived State

* Current round index is derived from block height
* Current leg index is derived from block height
* Round start/end and leg start/end are computed deterministically
* Browser countdowns may show estimated duration text, but block height remains the only source of truth

No timers, cron jobs, or wall-clock dependencies exist in the release economy.

---

## Game Economy Rules

### Round Format

* Up to 10 visible leaderboard positions per difficulty are used for settlement consideration
* Top 4 players in each eligible difficulty receive rewards
* Bottom 6 players in each independently eligible difficulty are responsible for funding rewards

Settlement qualification is evaluated independently for Easy, Normal, and Hard. If any difficulty reaches the eligibility threshold, settlement is produced and includes winners plus liabilities for each difficulty that qualifies.

### Reward Distribution

#### Normal total pot: **200 ROD**

* 1st place: **100 ROD**
* 2nd place: **70 ROD**
* 3rd place: **20 ROD**
* 4th place: **10 ROD**

#### Easy total pot: **2 ROD**

* 1st place: **1 ROD**
* 2nd place: **0.7 ROD**
* 3rd place: **0.2 ROD**
* 4th place: **0.1 ROD**

#### Hard total pot: **2000 ROD**

* 1st place: **1000 ROD**
* 2nd place: **700 ROD**
* 3rd place: **200 ROD**
* 4th place: **100 ROD**

Easy intentionally uses fractional payouts so the total pot stays exactly `2 ROD` while preserving the same proportional split used by Normal.

### Contribution Structure (Bottom 6)

Liabilities are tiered per difficulty, with each difficulty's contribution pool matching exactly that difficulty's reward pool:

| Position | Easy | Normal | Hard |
|----------|------|--------|------|
| 5th | 0.28 | 28 | 280 |
| 6th | 0.30 | 30 | 300 |
| 7th | 0.33 | 33 | 330 |
| 8th | 0.35 | 35 | 350 |
| 9th | 0.36 | 36 | 360 |
| 10th | 0.38 | 38 | 380 |
| **Total** | **2.0** | **200** | **2000** |

Proportional distribution is identical across all difficulties.

### Penalty Rule

* Players who do not fulfill round payment obligations are marked as **unpaid**
* Unpaid players are **blocked from reward participation** across the release flow
* Penalty persists **until the end of the current leg only**
* Penalty is automatically cleared when a new leg begins
* For players appearing in liabilities in multiple eligible difficulties in the same round, obligations are aggregated per handle before status derivation

---

## On-Chain Data Model

### Player-Owned Identity and Score Records
Store and read:

* identity record `p/<handle>`
* owned score record `g/voidrunner3d/<handle>/record`
* per-difficulty score payloads for Easy, Normal, and Hard
* encoded envelope metadata for record verification

### Derived Round and Leg Concepts
Derived by the relay from block height:

* round id
* leg id
* block start
* block end
* remaining blocks

### Standings
Derived from scanned player-owned records:

* ranked top 10 players per difficulty
* final scores
* tie resolution outcome

### Settlement Views
Derived on demand:

* winners (top 4) and reward amounts per eligible difficulty
* losers (bottom 6) and obligations per eligible difficulty
* settlement status (`settled` or `closed-no-settlement`)
* compatibility fields including `qualifiedParticipants` and `qualifiedParticipantsByDifficulty`

### Player Leg Status
Derived on demand:

* unpaid flag
* blocked status
* associated leg id
* aggregated outstanding obligations for the current leg

### Payment Records
Reserved for future direct payment-proof workflows:

* payer
* required amount
* confirmed amount
* tx references
* payment status

All release views must be reconstructible from chain-visible player records plus deterministic relay logic.

---

## Round Lifecycle

1. Round is active while block height is within its range
2. Round closes when block height exceeds round end
3. Final standings are derived from player-owned records
4. Settlement view is generated on demand for each independently eligible difficulty
5. Player obligations are derived from settlement liabilities
6. Eligibility reflects unresolved same-leg obligations
7. New leg rollover clears prior-leg blocking automatically

---

## Relay Responsibilities

The relay:

* Reads current block height
* Derives current round and leg
* Reads player records
* Computes leaderboard rankings
* Exposes round, leg, standings, settlement, eligibility, obligations, and recent-settlement views
* Reuses a shared leaderboard scan when deriving tiered settlements across Easy, Normal, and Hard
* Validates and writes player-owned score records for submissions

The relay does NOT:

* Store hidden off-chain economy truth
* Maintain a separate prize-window control plane
* Depend on admin relay writes for public release reads
* Require persisted settlement records for shipped settlement responses

---

## Eligibility Rules

A player can participate in reward rounds only if:

* Handle is registered
* Player has no unpaid penalty for the current leg
* Player has a valid player-owned score record

Unpaid players:

* Can still play the game
* Can still view release state
* Cannot participate in reward rounds until leg reset or future settlement/payment support clears the debt state

---

## User Experience

### Menu

* Current round (block-based countdown)
* Current leg (block-based countdown)
* Estimated duration text alongside block countdowns
* Reward distribution summary
* Tiered Easy/Normal/Hard reward summary sourced from settlement data
* Player eligibility status
* Recent settled rounds
* Difficulty-aware gameplay/economy mode summary
* Expandable help for round economy and power-ups
* Improved release board layout for clearer reading in the shipped `v0.2.1` UI

### Game Over Screen

* Player rank for the round
* Reward or penalty outcome
* Outstanding obligations (if any)
* Penalty/block status
* Time until next leg reset in blocks with estimated duration text
* Tiered Easy/Normal/Hard reward summary sourced from settlement data
* Difficulty-aware featured chart title and payload matching the active run difficulty
* Expandable details sections so additional release context stays available without crowding the default summary

### Gameplay

* No reward UI elements shown
* Gameplay remains clean and uninterrupted
* The active registered handle stays visible through the player badge in the corner controls
* The shipped browser client also exposes a centered project repository footer link outside the active gameplay HUD

---

## Trust and Transparency

* All rounds are derived from block height
* All standings are derived from player-owned chain records
* All visible payout/liability rules are deterministic and documented
* All penalties are publicly derivable from settlement liabilities

The system is auditable without relying on a hidden admin authority.

---

## Edge Case Handling

* Relay restart: state reconstructed from chain-visible player records
* Missing settlement participants: returns `closed-no-settlement`
* Ties: resolved deterministically
* Missing submissions: treated as absent from standings
* Leg rollover: clears penalties automatically
* Integrity warning mode: relay becomes read-only for mutating requests
* Relay offline in browser: UI falls back to unavailable messaging without breaking gameplay

Optional future extension:

* Settlement confirmation buffer before finalization
* Direct on-chain payment proof handling

---

## Validation Requirements

* Verify correct round and leg derivation from block height
* Verify settlement correctness across multiple difficulties
* Verify payout/liability totals remain balanced per difficulty
* Verify penalty assignment and clearing at leg boundaries
* Verify player eligibility logic
* Verify full system reconstruction from on-chain player records and deterministic relay logic only
* Verify browser countdown text remains aligned with authoritative block-derived remaining counts

---

## Planned notification extension

A future notification layer may use Nostr for opt-in player alerts tied to chain-derived release state. The planned alert set covers:

* new leg start notifications
* notifications when another player beats a registered player's record
* notifications when a registered player drops to the bottom of the leaderboard

This notification layer must remain secondary to the authoritative relay model and should reflect only deterministic relay-visible state rather than introducing hidden timing or off-chain economy truth. The roadmap entry lives in [`doc/sprint-map.md`](doc/sprint-map.md:126).

---

## Outcome

A deterministic, block-based release system where:

* Rounds and legs are automatically governed by the blockchain
* Rewards and liabilities are transparent and verifiable
* No admin intervention is required for public release views
* The relay remains the authoritative interpreter for the shipped browser experience
* The system stays simple, scalable, and tightly aligned with the game loop
