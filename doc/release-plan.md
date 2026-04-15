# Void Runner 3D — Implementation Plan (Block-Based, On-Chain Only)

## Core Principles

* All reward, round, leg, settlement, and penalty state is stored **on-chain only**.
* The system is **deterministic** and derived from **block height**, not wall-clock time.
* No admin intervention is required for round progression, settlement visibility, or penalty enforcement.
* The relay acts as a **stateless interpreter** of on-chain data.

---

## Time and Structure

### Block-Based Timing

* 1 Round = **120 blocks**
* 1 Leg = **1440 blocks**
* 1 Leg = **12 rounds**

### Derived State

* Current round index is derived from block height
* Current leg index is derived from block height
* Round start/end and leg start/end are computed deterministically

No timers, cron jobs, or wall-clock dependencies exist.

---

## Game Economy Rules

### Round Format

* 10 players per round
* Top 4 players receive rewards
* Bottom 6 players are responsible for funding rewards

### Reward Distribution

* 1st place: **100 ROD**
* 2nd place: **70 ROD**
* 3rd place: **20 ROD**
* 4th place: **10 ROD**

### Contribution Structure (Bottom 6)

* 5th: 28 ROD
* 6th: 30 ROD
* 7th: 33 ROD
* 8th: 35 ROD
* 9th: 36 ROD
* 10th: 38 ROD

### Penalty Rule

* Players who do not fulfill payment obligations are marked as **unpaid**
* Unpaid players are **blocked from reward participation**
* Penalty persists **until the end of the current leg only**
* Penalty is automatically cleared when a new leg begins

---

## On-Chain Data Model

### Leg Records

Store:

* leg id
* block start
* block end
* active status

### Round Records

Store:

* round id
* leg id
* block start
* block end
* status (open / closed / settled)

### Standings

Store:

* ranked top 10 players
* final scores
* tie resolution outcome

### Settlement Records

Store:

* winners (top 4) and reward amounts
* losers (bottom 6) and obligations
* settlement status (pending / partial / complete)

### Player Leg Status

Store:

* unpaid flag
* blocked status
* associated leg id

### Payment Records

Store:

* payer
* required amount
* confirmed amount
* tx references
* payment status

All records must be independently reconstructible from chain data.

---

## Round Lifecycle

1. Round is active while block height is within its range
2. Round closes when block height exceeds round end
3. Final standings are determined
4. Settlement record is written on-chain
5. Player obligations are published
6. Players settle payments directly
7. Payment records are written on-chain
8. Player penalty status is updated if unpaid

---

## Relay Responsibilities

The relay:

* Reads current block height
* Derives current round and leg
* Reads player records
* Computes leaderboard rankings
* Exposes round, leg, and settlement state
* Validates and writes deterministic on-chain records

The relay does NOT:

* Store off-chain economy state
* Maintain hidden state
* Run scheduled jobs

---

## Eligibility Rules

A player can participate in reward rounds only if:

* Handle is registered
* Player has no unpaid penalty for the current leg
* Player meets difficulty requirements

Unpaid players:

* Can still play the game
* Cannot participate in reward rounds

---

## User Experience

### Menu

* Current round (block-based countdown)
* Current leg (block-based countdown)
* Reward distribution
* Player eligibility status
* Recent settled rounds

### Game Over Screen

* Player rank for the round
* Reward or penalty outcome
* Outstanding obligations (if any)
* Penalty/block status
* Time until next leg reset (in blocks)

### Gameplay

* No reward UI elements shown
* Gameplay remains clean and uninterrupted

---

## Trust and Transparency

* All rounds are derived from block height
* All results are stored on-chain
* All payments are publicly verifiable
* All penalties are publicly visible

The system is fully auditable without relying on any centralized authority.

---

## Edge Case Handling

* Relay restart: state reconstructed from chain
* Partial payments: tracked and reflected in player status
* Ties: resolved deterministically
* Missing submissions: treated as lowest rank
* Leg rollover: clears penalties automatically
* Duplicate or invalid payment proofs: ignored or rejected

Optional:

* Settlement confirmation buffer (N blocks) before finalization

---

## Validation Requirements

* Verify correct round and leg derivation from block height
* Verify settlement correctness across multiple rounds
* Verify penalty assignment and clearing at leg boundaries
* Verify player eligibility logic
* Verify full system reconstruction from on-chain data only

---

## Outcome

A deterministic, block-based, on-chain reward system where:

* Rounds and legs are automatically governed by the blockchain
* Rewards and penalties are transparent and verifiable
* No admin intervention is required
* The system is simple, scalable, and fully aligned with the game loop
