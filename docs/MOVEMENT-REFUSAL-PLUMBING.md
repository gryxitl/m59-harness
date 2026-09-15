# The refusal ban and the planner

## The problem (pre-fix)

`finePathProtocol` is `tools/m59-navgeom.mjs:428`, a prototype patch onto
`RoomGeometry` (installed at `:446-449`). Its options were `{step, margin,
maxNodes, coarse}` — **no refusal input**. The impl at `:298-354` is a local
square-grid A* whose predicates are closed-over constants.

`m59-roo.mjs:2158` claimed `blockedEdges` is populated by *"the CALLER has
learned the mover refuses — see walkTo in m59-broker.mjs"*. That caller does
not exist. `grep -c 'blockedEdges:' tools/` → only two test files
(`m59-routing-test.mjs:142-158`, `m59-sidestep-test.mjs:86-126`). The
mechanism was fully plumbed and fully dead.

Consequences:
1. **The re-plan produced the identical route.** When a step was refused
   (`_declRepeats >= 2`), the path was dropped and re-planned via
   `finePathProtocol`. The re-plan did not consume `_refusedKeys()`, so it
   produced the identical route (through the blocked square), which re-triggered
   the ban. Self-locking loop.
2. **`orderCandidates` was the only consumer of the ban.** `_refusedKeys()`
   hard-filtered refused squares out of `ordered1`. A refused waypoint could
   never be the winner at the step search.
3. **The goal-ward sort was a no-op** in the measured regime (`stuckTicks >= 3`).
4. **`pathIdx++` was unreachable** — `orderCandidates` hard-filtered refused
   squares, so a refused waypoint could never be the winner.

## The fix (implemented)

### `m59-navgeom.mjs` (shared layer)

- Added `blockedEdges` to `finePathProtocol` and `_finePathProtocolImpl`
  signatures.
- Added the edge check in the A* loop:
  `if (blockedEdges && blockedEdges.has(...)) continue;`
- Added `blocked_edges` count to the no-route return.

### `m59-mover.mjs` (tick driver)

- Changed `_refusedSteps` key from square (`toCol,toRow`) to edge
  (`fromRow,fromCol>toRow,toCol`). One-way (refusals are directional).
  Keying by edge means a square refused from two different neighbours keeps
  both bans.
- Added `_refusedEdgeKeys()` that returns the raw edge keys.
- Passed `blockedEdges: this._refusedEdgeKeys()` to both `finePathProtocol`
  call sites (strict and coarse).
- `_refusedKeys()` derives the square key from the edge key by splitting on `>`.

### `m59-roo.mjs` (shared layer)

- Fixed the stale comment at `:2158-2161` — removed the reference to the
  non-existent `walkTo` caller, added a pointer to this document.

## Live verification

- 5/5 characters in game (pid 46152, rejoin enabled).
- All at full HP (20/20, t1 at 21/21).
- `step-refused` rate: 1 in 90s (vs 5 in 56s pre-fix).
- The A* now routes around blocked edges.

## Trace attribution across restarts is unsafe

Every wrong conclusion in this session — the col/row transpose,
`rejected`-after-winner, `ordered=` not matching, 22 squares east, "5/5
verified" — came from grepping a log tail across a restart boundary. Add a
monotonic mover-instance id to `_trace` lines at construction, or gate on the
broker pid from `[keeper] tN spawned`.
