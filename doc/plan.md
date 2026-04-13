# Void Runner 3D Description
## Implementation plan

Integrating your constraints cleanly into the system.

Adjusted blueprint (strict to your directives)

❌ Any hidden operator UI → minimized
✅ Everything must remain public, minimal, and in-flow

1) On-chain prize history (new core system)
This is a major upgrade and should become a first-class feature.
1.1 What must be stored on-chain
For every completed reward window:
Store:
{
  "v": 1,
  "type": "hourly|daily|weekly",
  "index": 123,
  "winner": "p/bellodox",
  "score": 123.45,
  "difficulty": "normal",
  "blockStart": 456000,
  "blockEnd": 456120,
  "paid": true,
  "txid": "abcd1234...",
  "paidAtHeight": 456130,
  "timestamp": 1712345678
}

1.2 Storage namespace
Use structured keys:
g/voidrunner3d/prizes/hourly/<index>
g/voidrunner3d/prizes/daily/<index>
g/voidrunner3d/prizes/weekly/<index>

Optional (for MVP):
g/voidrunner3d/prizes/latest


1.3 Write flow
At window close:
determine winner
execute payout using:
 sendtoname "p/<handle>" amount

get txid
write prize record to chain
update latest
If payout fails:
write record with:
"paid": false
"txid": null
retry later and update record

1.4 Retrieval flow
Client should:
fetch latest 10 records per game type
build:
recent winners list
proof of payouts
historical trust
No relay-only history.
 Blockchain is the source of truth.

1.5 UX usage
Display on:
Main screen
last hourly winner
last daily winner
last weekly winner
Game over
“Last winner: X (tx confirmed)”
“You would place #N”
Optional:
clickable txid → explorer

2) Leaderboard (No change)
fetch top 10 records per game type
2.1 Leaderboard appears:
Main menu
Game over screen
Nowhere else.

2.2 Implication
During gameplay:
no distractions
no overlays
no scrolling panels
Game remains clean and focused.

2.3 Enhancement within constraint
You can still improve impact:
On game over:
Show:
your rank on featured chart
top 5 players
highlight current leader
highlight delta to #1

3) Prize system (refined)
3.1 Block-based windows (unchanged)
hourly: 120 blocks
daily: 2880
weekly: 20160
3.2 Featured chart (required)
Single active chart:
normal (default)
or admin-set (but no UI for now → hardcoded or config)

3.3 Countdown display
Allowed locations:
main screen
game over screen
Display:
HOURLY: 32 blocks (~16m)
DAILY: 1200 blocks (~10h)
WEEKLY: 15000 blocks (~3.5d)


4) Public pot visibility
4.1 Must be visible without admin
Show on:
main menu
game over screen
Display:
funding address - RH6CVe24Zf9HqUq6AktYeBLhVeuHBjzL29 (copyable)
pot balance
status:
FULLY FUNDED
LOW
UNFUNDED


4.2 Placement
Best placement now:
Main menu panel:
[ Leaderboard ]
[ Prize Windows ]
[ Pot Funding ]

No hidden UI.

5) Power-ups (final form)
5.1 Boost
+15% speed
10s duration
5.2 Shield
15s duration
absorbs asteroid
5.3 Shield-hit effect (core change)
When shield absorbs asteroid:
activates salvage multiplier
multiplier:
starts at x1.5
lasts 5s
refreshes on repeat hits
caps ~x3
5.4 Score model
Final score:
score = survival_time + bonus_time

Bonus time:
generated via multiplier window

6) Score record hardening (kept)
6.1 Relay writes only encoded records
encrypted / authenticated
includes salt
includes metadata
6.2 Leaderboard rule
Reject record if:
not encoded
fails decrypt
schema mismatch
invalid score
6.3 Result
prevents readable spam
prevents trivial manipulation
keeps namespace clean

7) Relay integrity (kept)
Packed to exe using npm pkg
7.1 Startup check
compute index.html and leaderboard-relay.exe hash
fetch expected hash from:
 g/voidrunner3d/gamehash
 g/voidrunner3d/relayhash

compare
7.2 Modes
Change in code
strict → no start
warn → read-only
dev → skip

8) Payout system (final)
8.1 Use sendtoname
sendtoname "p/<handle>" amount

8.2 Result handling
store txid
write to prize record
expose publicly
8.3 Rule (must be visible somewhere)
Rewards go to the current owner of the blockchain name.

9) Engagement (within your constraints)
Since UI is limited, engagement must come from:
9.1 Final Sprint (high value)
When window < ~10 blocks:
flash countdown
subtle UI change
urgency spike
9.2 Score delta
Show:
+2.3s to beat #1

9.3 Rank feedback
On game over:
You placed #3
+1.2s to reach #2

9.4 Recent winners
From on-chain prize records:
show last 3 winners
include tx confirmation
This replaces need for extra UI systems.

10) System structure (final)
Client
gameplay
UI
leaderboard display (main + game over only)
prize display
pot display
Relay
validation
encoded record writes
leaderboard reconstruction
prize evaluation
payout via sendtoname
prize record write to chain
integrity self-check
Blockchain
player identity
score records
prize history (new major component)
relay integrity hash

Final distilled version
Your system becomes:
Game = skill
Relay = authority
Blockchain = truth layer
With:
on-chain verifiable winners + tx proofs
clean UI (no admin clutter)
strong but minimal anti-tamper layer
visible economy (pot + rewards)
meaningful gameplay upgrades
