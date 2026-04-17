## Sprint 0 — Freeze rules

* Lock round size to **120 blocks**
* Lock leg size to **1440 blocks**
* Lock **12 rounds per leg**
* Lock payout to **100 / 70 / 20 / 10**
* Lock bottom-6 liabilities to **28 / 30 / 33 / 35 / 36 / 38**
* Lock penalty rule: unpaid players are blocked **until leg end**
* Lock scope: prize mode on **Normal** first only
* Lock rule that **all prize, round, leg, payment, and penalty state lives on-chain only**  

## Sprint 1 — On-chain schema

* Define on-chain records for:

  * current leg
  * leg metadata
  * current round
  * round metadata
  * round standings
  * round settlement
  * player leg status
  * player unpaid penalty status
  * payment receipts
  * recent settled rounds
* Define exact namespaces for each record
* Define JSON payload structure and validation rules for each record
* Define versioning for future schema upgrades  

## Sprint 2 — Block-based round and leg engine

* Make **block height** the only time source
* Derive current round from block height
* Derive current leg from block height
* Derive round start/end block
* Derive leg start/end block
* Remove wall-clock assumptions for economy logic
* Define round rollover behavior
* Define leg rollover behavior
* Define tie-break rules
* Define behavior for missing or late submissions 

## Sprint 3 — Settlement design

* Define how a round becomes final
* Define how top 4 awards are written on-chain
* Define how bottom 6 obligations are written on-chain
* Define per-player outstanding payment records
* Define what counts as valid payment proof on-chain
* Define partial payment handling
* Define duplicate payment handling
* Define settlement states: open, due, partial, complete, expired
* Define how unpaid status is attached to the player for the current leg only

## Sprint 4 — Public relay economy support

* Add public read endpoints for:

  * current round
  * current leg
  * current standings
  * round settlement
  * player eligibility
  * player outstanding obligations
  * recent settled rounds
* Add relay write flows for deterministic on-chain round and settlement records
* Remove dependence on admin-only prize state for read paths
* Make relay reconstruct economy state from chain only after restart
* Ensure no hidden local storage is used for round economy truth  

## Sprint 5 — Penalty and eligibility enforcement

* Add on-chain player leg penalty record
* Block unpaid players from prize participation until leg end
* Auto-clear penalties when a new leg starts
* Define eligibility checks before prize entry
* Define visibility of blocked status to the player
* Define visibility of blocked status to public ranking/settlement views 

## Sprint 6 — UI wiring

* Re-enable round widgets in menu and game-over screens
* Show current round block countdown
* Show current leg block countdown
* Show last settled round
* Show top 4 awards
* Show bottom-6 liability if player finished there
* Show unpaid warning and blocked-until-leg-end status
* Show recent winners from on-chain settlement records
* Remove or repurpose pot UI that no longer matches the no-pool model
* Keep active gameplay screen free of economy clutter  

## Sprint 7 — Trust and history

* Add public views for recent settled rounds
* Add public views for payout proof / receipt status
* Add player history for current leg obligations and payment status
* Show exact round id and leg id in UI
* Show exact block ranges for each round
* Make all trust views reconstructible from on-chain records only 

## Sprint 8 — Edge cases and hardening

* Handle relay restart during round
* Handle relay restart during settlement
* Handle partially paid rounds
* Handle leg rollover with unpaid players
* Handle tied scores
* Handle missing standings records
* Handle duplicate tx proofs
* Handle stale settlement attempts
* Handle chain lag / delayed reads
* Define optional confirmation buffer before finalizing round settlement

## Sprint 9 — Validation and rollout

* Test full 12-round leg flow end to end
* Test round rollover at block boundaries
* Test leg rollover at block boundaries
* Test unpaid penalty assignment and clearing
* Test player eligibility reads
* Test recent history reconstruction from chain only
* Update README and ops docs for the new block-based on-chain-only prize system
* Run internal dry-run legs before public rollout  

## Sprint 10 — Nostr notifications

* Add Nostr-based player notifications for new leg start events
* Add Nostr notifications when another player beats a registered player’s record
* Add Nostr notifications when a registered player drops to the bottom of the leaderboard
* Define notification delivery model, relay selection, subscription/auth flow, and player opt-in requirements
* Document trigger conditions so notifications stay consistent with chain-derived round and leaderboard state
