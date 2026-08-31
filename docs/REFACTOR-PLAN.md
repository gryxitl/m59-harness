# m59-harness architecture refactor plan

Written 2026-08-31 after a day of debugging room transitions, stuck
characters, and policy that lives in three places. The goal is not to
rewrite the game client — it is to make the failure modes we hit today
impossible by construction.

## The failure modes that motivated this

1. **Stale position across a room transition.** The controller kept the
   old room's coordinates after a crossing and followed a motion path
   computed from them in the new room. Characters ended up "inside
   walls", on staging squares of other rooms, or outside the grid.
   Fixed with an airlock + room stamps + force-adopt, but the fix is
   six mechanisms doing what the official client does with three lines.

2. **Reconnect loops.** `escape_pocket` reconnected the character to
   escape a geometry pocket. The server places a reconnecting user at
   their saved position without checking geometry (util.kod skips
   `ReqSomethingMoved` for `&User`), so the body came back wedged. The
   reconnect also tripped the broker's rejoin loop, which respawned the
   keeper and re-joined the character at the same spot, over and over.

3. **Policy in three places.** Loadout file, roster, and broker
   in-memory cache. The broker's cache wins on keeper respawn, so
   changing a character's hunt room took four steps and a restart, and
   the "wrong" value kept coming back.

4. **No visibility.** A stuck character looked identical to a resting
   one. The only way to see what was wrong was reading keeper logs and
   reconstructing state. Position, path, and destination were not
   exposed anywhere.

5. **Server does not validate user positions.** `util.kod:
   UtilGoToSquare` short-circuits `ReqSomethingMoved` for `&User`, so
   any position the client sends is accepted, including positions
   inside walls. The official client never hits this because it
   validates every step against the BSP before sending.

## The refactor

### 1. One mover

Today: ControllerMover → (delegates) → legacy Mover → (calls)
`walkTo` in m59-game.mjs. Three layers, each with its own position
belief, room-change handling, and stuck detection. The delegation
boundaries are where most of the room-transition bugs lived.

Target: the controller is the only position authority. The legacy
mover's good ideas — the `walkTo` no-floor three-stage recovery
(stepFine → walkFine → give up), the fan-out raw moves — become
functions the controller calls, not a parallel state machine. No
delegation, no "handing back", no two beliefs to reconcile.

### 2. Broker goes back to being a pipe

Today the broker holds the roster, caches policy, spawns/respawns
keepers, runs the rejoin loop, serves the dashboard, and does MCP.

Target: broker = connection + MCP + dashboard + "process died, start
it again". No policy. No rejoin decisions. The rejoin loop moves into
the keeper: a keeper knows best when its own connection dropped and
what re-joining should mean for its character (including the
"don't rejoin into the same pocket" rule).

### 3. Policy: one file, read once

`substrate/loadouts/<Character>.json` is the only source of truth.
The keeper reads it at startup. A change is: edit file, restart that
keeper (one command, visible in the log). No roster copy, no broker
cache, no `POST /policy` mutating a live object nobody re-reads.

### 4. Room transition: copy the official client

The official client (clientd3d/move.c) does the whole transition in
three steps:

1. Next step lands outside the room → send `RequestMove(y, x, 0,
   room_id)` (speed 0), do NOT move locally, wait.
2. Server performs the transition, sends BP_PLAYER + BP_ROOM_CONTENTS.
3. Adopt the server's position from the room contents. Done.

Target: one state, `transitioning`. Entry: off-room request sent.
Exit: room contents for the new room received. Position source: the
object map, full stop. No `_lastMoveRoom`, no `_lastContentsRoom`, no
room stamps, no resync-wait, no divergence-skip-on-room-change.

### 5. Validate moves before sending

The official client checks `BSPFindLeafByPoint` before every step and
refuses to send a move into no-floor. We send, the server accepts
(it skips validation for users), and we end up in walls.

Target: a send gate in the single mover — if the target square has no
floor (coarse grid) or no BSP leaf (fine model), the move is not
sent. This makes self-caused "server put me in a wall" impossible and
shrinks the bad-arrival case to the server's edge-exit table only.
For those, the `walkTo` recovery (nearest walkable square, stepFine,
walkFine) is the safety net.

### 6. Stuck is a first-class state

What was built ad hoc on 2026-08-31 should exist from day one:

- Fleet status exposes `pos`, `path` (current leg), `dest` per
  character. One call shows who is stuck and why.
- Bad-arrival detection: after a transition, if the arrival square
  has no floor, recover immediately (nearest walkable + raw move).
- Escape ladder, in order: stand → blink (if mana ≥ cost) → walkTo
  recovery → stay put. Reconnect is NOT in the ladder (it does not
  escape a pocket and triggers rejoin loops).
- Hard rule: a character stuck for N seconds escalates automatically.
  Re-roll is the terminal step and is **manual confirmation only,
  never automatic** — it deletes the character.

### 7. Coordinate convention: decide once

The server sends 1-based kod coordinates (row first, then col, each
`square * FINENESS + fine`). The official client subtracts
KOD_FINENESS to get 0-based client coordinates. The harness keeps
1-based. Both are internally consistent, but the convention should be
written down in one place (m59-parse.mjs) and every consumer should
go through it, so a future reader never has to re-derive it from
server.c and user.kod.

## What we do NOT touch

- **m59-parse.mjs** — exactness-checked, correct, the one part of the
  stack that has never lied.
- **m59-map.mjs** — the two-pass findPath (strict with blockedHops,
  loose without) is complicated but correct. The `transit_unverified`
  fallback is a known soft spot (it returns routes through condemned
  hops) but it is the right trade: a long route is better than no
  route.
- **The decider's goal ladder** — ugly, but it is where the
  character's behaviour lives and it is total by construction.
- **Zero-dependency `.mjs` tools** — the constraint is worth keeping.
  Every tool must stay runnable with bare node.

## Shape of the result

- `m59-keeper` — one process per character: protocol client + single
  mover + decider + policy (read once from the loadout file). Owns
  its own rejoin.
- `m59-broker` — thin: MCP + dashboard + process supervision
  (spawn on death, nothing else).
- Movement/decide/parse modules as they are, with the mover stack
  collapsed and the send gate added.

Roughly half the current code. The failure modes from 2026-08-31 —
stale positions across rooms, reconnect loops, policy in three
places, invisible stuck characters — do not exist by construction.

## Migration order (if done in this repo first)

1. Send gate (validate before send) — smallest change, kills the
   biggest class of bugs immediately.
2. Fleet status pos/path/dest + bad-arrival detection — visibility.
3. Collapse the mover stack — the big one; do it behind a flag
   (`M59_SINGLE_MOVER=1`) and run one character on it before the rest.
4. Policy: loadout file only, read at startup; delete the broker's
   policy cache and `POST /policy`.
5. Rejoin moves into the keeper; broker stops making rejoin
   decisions.
6. Delete the dead code: room stamps, `_lastMoveRoom`,
   `_lastContentsRoom`, resync-wait, the delegation path.
