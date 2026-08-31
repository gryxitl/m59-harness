# m59-harness architecture refactor plan

Written 2026-08-31 after a day of debugging room transitions, stuck
characters, and policy that lives in three places. The goal is not to
rewrite the game client — it is to make the failure modes we hit today
impossible by construction.

## STOP: read this first — tpeppers/m59-harness is the real-time one

Checked 2026-08-31. Our `upstream` remote is `tpeppers/m59-harness`.
It is **140 commits ahead** of us (43,504 insertions across 187 files),
and we are 247 ahead of it. The merge base is `502c627`.

**The two forks are different driver models, and upstream is the
real-time one.**

- **Upstream (`tpeppers`)** runs `m59-tick.mjs`: a fixed 10Hz
  sense→decide→actuate loop. The sensor reads pushed state (never
  sends, never blocks). A tick never awaits an actuation. Effects are
  observed by the next tick, not returned. A slow decide skips, it
  does not queue. Their header names our model as the bug: "the keeper
  is a blocking RPC script... `await stepPlan` BLOCKS, seconds at a
  time... 82% of deaths had the keeper blind at the moment of death."
- **Ours (`gryxitl`)** is that blocking model: `loop { sense; decide;
  await stepPlan }`. The actuation blocks the next sense, so the
  character acts on a stale snapshot. Everything we built today — the
  airlock, the room stamps, the resync-wait, the force-adopt — is
  patching that staleness. The `m59-controller-mover.mjs` (1,204
  lines, added by us after the split, never on their side) is the
  blocking model's position authority.

Upstream has already solved, more rigorously than we did today, most
of the exact failure modes in this document — *because their driver
model does not have the staleness our patches are fighting*:

- **The mover stack is already collapsed.** No controller-mover.
  `m59-mover.mjs` (809 lines) + `m59-movement.mjs` (terminal-reason
  contract), driven by the tick loop.
- **"a stuck character says so, and can bring you to it"** (`3657303`):
  a `stuck` flag on every fleet row, plus `m59-stuckwatch.mjs`.
- **"arrived is a fact about the world, and c.self is a belief about
  it"** (`a34cb74`): the stale-belief bug we hit, root-caused.
- **"mover: escape a safe-wall pocket before travel gives up"**
  (`471b1ba`): pocket escape via proven exit anchors.
- **"ask a private strategy before reporting a boundary shut, and cast
  blink if it says so"** (`535f37a`): `Session.blinkOut` primitive,
  concentration freeze solved.
- **"the bake chose a door by scan order, and 33 of them were in a
  wall"** (`1596f75`): bad exit anchors fixed at the bake.
- **`start_has_no_floor` / `position_outside_room_geometry`** split
  out as terminal reasons, 1,535 shadow-fleet failures analysed.
- Fall-jumps, lanes, gutters, rails, one-square corridors,
  players-as-queues: an entire body of movement work we do not have.

**The refactor is: adopt upstream's tick driver + mover stack as the
base, and port our genuinely new work on top** — the airlock-on-
BP_ROOM_CONTENTS idea (re-expressed as "position is always the latest
pushed state"), the `util.kod` user-position finding, and the
loadout-only policy rule. Our controller-mover, room stamps,
resync-wait, and force-adopt are the blocking model's band-aids and
should be dropped, not ported.

The separate-project question becomes: **fork from
`tpeppers/m59-harness` main, not from our `main`.**

---

## The failure modes that motivated this

1. **Stale position across a room transition.** The controller kept
   the old room's coordinates after a crossing and followed a motion
   path computed from them in the new room. Characters ended up
   "inside walls", on staging squares of other rooms, or outside the
   grid. Fixed with an airlock + room stamps + force-adopt, but the
   fix is six mechanisms doing what the official client does with
   three lines — and what upstream's tick model does for free, because
   the position is always the latest pushed state.

2. **Reconnect loops.** `escape_pocket` reconnected the character to
   escape a geometry pocket. The server places a reconnecting user at
   their saved position without checking geometry (util.kod skips
   `ReqSomethingMoved` for `&User`), so the body came back wedged. The
   reconnect also tripped the broker's rejoin loop, which respawned
   the keeper and re-joined the character at the same spot, over and
   over.

3. **Policy in three places.** Loadout file, roster, and broker
   in-memory cache. The broker's cache wins on keeper respawn, so
   changing a character's hunt room took four steps and a restart, and
   the "wrong" value kept coming back.

4. **No visibility.** A stuck character looked identical to a
   resting one. The only way to see what was wrong was reading keeper
   logs and reconstructing state. Position, path, and destination were
   not exposed anywhere. (Upstream has the `stuck` flag +
   `m59-stuckwatch.mjs` already.)

5. **Server does not validate user positions.** `util.kod:
   UtilGoToSquare` short-circuits `ReqSomethingMoved` for `&User`, so
   any position the client sends is accepted, including positions
   inside walls. The official client never hits this because it
   validates every step against the BSP before sending.

## The refactor

### 1. Adopt the tick driver (the big one)

Replace the blocking `loop { sense; decide; await stepPlan }` keeper
with upstream's `m59-tick.mjs` model: a fixed 10Hz loop where the
sensor reads pushed state (free, synchronous, sends nothing), a tick
never awaits an actuation, effects are observed by the next tick, and
a slow decide skips rather than queues. This is what makes the
room-transition staleness bugs impossible: there is no blocking
actuation to leave the position stale, so the airlock, room stamps,
resync-wait, and force-adopt all become unnecessary.

### 2. One mover

Upstream already has this: `m59-mover.mjs` (809 lines) +
`m59-movement.mjs` (terminal-reason contract), driven by the tick
loop. No controller-mover. Our 1,204-line `m59-controller-mover.mjs`
is dropped.

### 3. Broker goes back to being a pipe

Today the broker holds the roster, caches policy, spawns/respawns
keepers, runs the rejoin loop, serves the dashboard, and does MCP.

Target: broker = connection + MCP + dashboard + "process died, start
it again". No policy. No rejoin decisions. The rejoin loop moves into
the keeper: a keeper knows best when its own connection dropped and
what re-joining should mean for its character (including the
"don't rejoin into the same pocket" rule).

### 4. Policy: one file, read once

`substrate/loadouts/<Character>.json` is the only source of truth.
The keeper reads it at startup. A change is: edit file, restart that
keeper (one command, visible in the log). No roster copy, no broker
cache, no `POST /policy` mutating a live object nobody re-reads.

### 5. Validate moves before sending

The official client checks `BSPFindLeafByPoint` before every step and
refuses to send a move into no-floor. Upstream's `m59-movement.mjs`
terminal-reason contract (`start_has_no_floor`,
`position_outside_room_geometry`, `invalid_move_target`) is the
structural form of this. Adopt it.

### 6. Stuck is a first-class state

Upstream has the `stuck` flag on every fleet row and
`m59-stuckwatch.mjs`. Adopt it, and keep the escape ladder we built:
stand → blink (if mana ≥ cost) → walkTo recovery → stay put.
Reconnect is NOT in the ladder. Re-roll is the terminal step and is
**manual confirmation only, never automatic** — it deletes the
character.

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
  loose without) is complicated but correct.
- **The decider's goal ladder** — ugly, but it is where the
  character's behaviour lives and it is total by construction.
- **Zero-dependency `.mjs` tools** — the constraint is worth keeping.

## Shape of the result

- `m59-keeper` — one process per character: tick driver + single
  mover + decider + policy (read once from the loadout file). Owns
  its own rejoin.
- `m59-broker` — thin: MCP + dashboard + process supervision
  (spawn on death, nothing else).
- Movement/decide/parse modules as upstream has them, with our
  genuinely-new additions ported on top.

## Migration order (if done in this repo first)

1. **Port the tick driver** from upstream — the foundation everything
   else depends on. Do it behind a flag (`M59_TICK=1`) and run one
   character on it before the rest.
2. **Adopt upstream's mover + movement contract** — drop our
   controller-mover.
3. **Adopt the `stuck` flag + stuckwatch** — visibility.
4. **Policy: loadout file only, read at startup**; delete the
   broker's policy cache and `POST /policy`.
5. **Rejoin moves into the keeper**; broker stops making rejoin
   decisions.
6. **Delete the dead code**: our controller-mover, room stamps,
   `_lastMoveRoom`, `_lastContentsRoom`, resync-wait, force-adopt,
   the delegation path.

## What is genuinely ours to port (not in upstream)

- The `util.kod` user-position finding (server skips
  `ReqSomethingMoved` for `&User`) — documented, may inform the send
  gate.
- The loadout-only policy rule (if upstream still has the broker
  policy cache — verify before assuming).
- The airlock idea, re-expressed: in the tick model it is simply
  "position is always the latest pushed state; after a room change,
  the first room-contents for the new room is the position." No
  separate mechanism needed.
