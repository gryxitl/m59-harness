# Navigation fix: stop the pocket, replace the escape fan

## Root cause (grounded in this session's findings)

The pocket is **not** caused by the intersection size. Room 557's count (via `m59-void-scan.mjs --room 557`):
- Coarse walkable (server one-byte grid): 1282
- BSP floor anywhere on the square: 1410
- Both (intersection): 1113 — **78.9% of fine-reachable, 86.8% of coarse-walkable**

The intersection is large, so the strict tier *should* be able to see routes. The pocket is caused by:

1. **The asymmetric-predicate-under-symmetric-key bug** (most likely). `m59-navgeom.mjs:210-211` canonicalizes the `_edgeOk` key to `min(r1,c1)→max(r1,c2)` (symmetric), but the value it caches is `moverStepLands(r1,c1,r2,c2)` (`:234`), which is **directional** — `FALL_MAX_SQUARES` and `MAX_STEP_HEIGHT` ARE the asymmetry (confirmed: 156 such triples in room 598, `m59-roo.mjs:1900-1912`). The first traversal of a cliff edge in the up-direction caches `false`, and every later query of that edge, including the down-direction one the mover would take, reads `false`. The coarse tier is immune (it returns at `:208` before reaching the cache) — which is exactly why the trace shows strict `expanded=274 → no fine path` while coarse finds 47 waypoints in the same room at the same moment.

2. **The symmetric climb gate** (secondary). `_traceMoverStep` (`m59-roo.mjs:2104-2107`) uses `Math.abs(landedFloor - aimFloor) > MAX_STEP_HEIGHT`, which refuses drop-landings. A fall is not a climb (`m59-falljump.mjs:15-17`), so the gate severs routes humans take by falling. Measured over 235,701 legal steps in ten rooms, 1.66% would be refused, almost all in 578 — so this is low-risk to fix but cannot by itself explain a fleet-wide pocket.

3. **The mask is NOT baked for room 557** (`_stepMask` is NULL), so the trace path is live and the memo-key question is real. The cold-vs-warm probe is a tautology only if the mask is baked; for 557 it is not.

## The fix (priority order)

### Phase 1 — The asymmetric-predicate fix (one line, most likely cause)

**File:** `tools/m59-navgeom.mjs`

**Change:** make the `_edgeOk` key directional at `:210-211`:

```js
// BEFORE (symmetric key, directional value):
const ek = r1 < r2 || (r1 === r2 && c1 < c2)
  ? `${r1},${c1},${r2},${c2}` : `${r2},${c2},${r1},${c1}`;

// AFTER (directional key):
const ek = `${r1},${c1},${r2},${c2}`;
```

This is a one-line change. It makes the cache key match the predicate's directionality, so the up-direction `false` no longer poisons the down-direction query.

**Verification:** the three-layer probe — query `_edgeOk` (navgeom memo), `moverStepLands` (mask-or-trace), and `freshRoomGeometry.moverStepLands` (cold) for the same edge, and print which of the three refuses. For a cliff edge, `moverStepLands(A,B)` (up) should be `false` and `moverStepLands(B,A)` (down) should be `true`. After the fix, `_edgeOk` should serve `false` for `A→B` and `true` for `B→A` (separate entries).

### Phase 2 — The unidirectional climb gate + carriedZ

**File:** `tools/m59-roo.mjs`

**Change 1:** drop the `Math.abs` in `_traceMoverStep` at `:2107`:

```js
// BEFORE (symmetric, refuses drops):
if (Number.isFinite(landedFloor) && Number.isFinite(aimFloor)
    && Math.abs(landedFloor - aimFloor) > MAX_STEP_HEIGHT) return false;

// AFTER (unidirectional: block climbs, allow drops):
if (Number.isFinite(landedFloor) && Number.isFinite(aimFloor)
    && (landedFloor - aimFloor) > MAX_STEP_HEIGHT) return false;
```

This allows drop-landings (a fall is not a climb) while still blocking climbs that exceed `MAX_STEP_HEIGHT`.

**Change 2:** stop the next step at `carriedZ = max(landedFloor, pose.z)` — the same `z = std::max(player_obj->motion.z, GetFloorBase(last_x, last_y))` that `move.c:286` uses. The repo already has a hook for this (`carriedMotionZ?.max`, `m59-roo.mjs:1189-1195`). This prevents the 1600-unit phantom step-off that the `Math.abs` was preventing (the mover stops on a straddling square's LOW half, `walkTo` compares squares and calls it arrived, and the next step is planned from the square's stand point 1600 units higher than the character actually stood).

**Verification:** the drop-landing test — a fall is not a climb. A step that drops (landedFloor < aimFloor) should be allowed; a step that climbs more than `MAX_STEP_HEIGHT` (landedFloor - aimFloor > MAX_STEP_HEIGHT) should be refused. The next step should be planned from `carriedZ = max(landedFloor, pose.z)`, not from `standPoint(to)`.

### Phase 3 — The angle-control law (the missing layer)

**File:** `tools/tick/m59-mover.mjs`

**Change:** replace the escape fan with the client's angle-control law:

```js
// The missing layer: the client has no target-seeking code. A_FORWARD moves along
// player.angle (move.c:226-229); aiming is the human's turning (UserTurnPlayer :816).
// The port needs an explicit angle-control law the game never had:
angle = Math.atan2(waypointY - actualPoseY, waypointX - actualPoseX);
// with hysteresis and a square-granularity deadzone (reuse MOVE_THRESHOLD = FINENESS/4)
// so it doesn't thrash turn packets against the MOVE_INTERVAL budget.
```

This replaces the escape fan (8 headings, one per second) with the client's three-probe cascade (three 64-unit probes inside a single 256-unit move, resolved locally with zero packets). The probes cost BSP traces, not the ~1 pkt/s budget, so the 66%-fan send saturation becomes a BSP cost you can memoize like `_edgeOk` already does.

**Verification:** the escape fan is replaced by the client's three-probe cascade. The 66%-fan send saturation should drop to a BSP cost. The character should move toward the waypoint without thrashing turn packets.

### Phase 4 — Move A*'s search space off the pose-dependent graph

**File:** `tools/tick/m59-mover.mjs`

**Change:** use `walkable && fineWalkable` (the server's own per-square grid, justified as "both grids agree this square is floor") for the route. That's `finePathProtocol(..., { coarse: true })` with the fine-grid veto. The A* loop already refuses those on the strict path (`:354`, `if (!coarse && fineWalkable(nr,nc) === false) continue;`) and skips that test in coarse mode — make coarse mode mean `walkable && fineWalkable`.

**Verification:** the route is a subset of what the server accepts (both grids agree this square is floor). The character should follow the route to completion instead of reaching a square the planner promised but the mover refuses.

## The reason we've been having trouble with a 1995 game

We've been running A* on a pose-dependent graph (the precomputed `moverStepLands` from a drifted simulated pose, with a symmetric climb gate that refuses drop-landings, **and** an asymmetric predicate memoized under a symmetric key), which the game doesn't use for navigation. The game uses a pose-independent grid for the route, a local trace cascade for the next step, and a human for heading. We should do the same — with the angle-control law replacing the human, the unidirectional climb gate + carriedZ making the mask a usable connectivity graph, and directional keys for the navgeom `_edgeOk` memo (the most likely cause of the pocket, given the 557 findings).

## Verification (before any of the above gets built)

Three probes, all cheap:

1. **The three-layer asymmetry probe:** query `_edgeOk` (navgeom memo), `moverStepLands` (mask-or-trace), and `freshRoomGeometry.moverStepLands` (cold) for the same edge, and print which of the three refuses. Distinguishes "poisoned navgeom memo" from "baked mask bit" in one run.

2. **The pose probe:** one probe from t4's live pose in the heading the coarse path wants, compared against the strict tier's verdict for the same edge. If the probe arrives and the strict tier says `arrived=false`, the pose-equality theory is confirmed.

3. **The 557 intersection count:** already done. The intersection is 78.9% of fine-reachable, 86.8% of coarse-walkable. Rules out the "intersection too small" theory.
