# m59 Speed Fix — Session Report

Date: 2026-08-29
Goal: Bring the m59 fleet to normal player movement speed and sustained hunting activity.

## Final Fleet State (end of session)

| Agent | Room | GOAP Goal | Movement |
|-------|------|-----------|----------|
| t1/Gountrug | Brownestone Inn (106) | travel_to_hunt_room (room 106→101 door at 12,17) | **STUCK** (4-tile drift) |
| t2/Kage | The Underworld | escape: way out | **STUCK** (25-tile drift) |
| t3/JayB | Marion (town) | idle_rest | ✅ In transit / resting |
| t4/Lee | Off the beaten path (deep woods) | idle_rest | ✅ Completed hunt, resting |
| t5/Sasquatch | Brownestone Inn (106) | unwedge/rest | ✅ In transit / resting |

## Commits Made This Session

1. `e4fa536` — controller: detect session rejoin and reset state
   - Added `_seenClient` reference check in `ControllerMover.tick()`
   - When session.client is a different object (rejoin), clears controller internals: `this.ctl.clear()`, `this._room = null`, `_plannedFor = null`, `_noProgress = 0`, `_handedBack = false`
   - Prevents the controller from carrying stale geometry data (old room, old waypoints) into a new session
   - **THIS IS THE CRITICAL FIX TURN** — allows the GOAP keeper to send movement after a rejoin

2. `fe4c574` (previous session, applied here) — m59-travel-time.mjs: correct tile-speed model
   - changed match-move from 9 → 4 → 3 → 1.87 tiles/min to use KOD_FINENESS for the controller-hopping component
   - All 7 pre-existing geo-runs test cases pass

## Movement Speed Verification (from keeper wire probes)

| Agent | Clean test (open room) | Speed |
|-------|-----------------------|-------|
| t4/Lee | 45 tiles in 12s | **3.75 tiles/sec** ✅ |
| t3/JayB | 26 tiles in 13s | **2.0 tiles/sec** ✅ |

These are at the "normal" walk speed the user asked for. Before `d793731` (previous session), t4 was capping at ~0.2 tiles/sec.

## Root Cause Investigation: t1/t2 Position Drift

Both stuck characters share the same failure mode: the controller's fine position (in `this.ctl.x/y`, "believed") is several tiles away from where the character actually is (`c.self`, the position from BP_MOVE server echo).

- **t1/Gountrug:** fine position says he's at tile (10,14); server says (11,10). Gap = 4.12 tiles. `DIVERGENCE_SQUARES = 6` → below threshold → no correction. Fine trace cannot find a path from (10,14) to the destination because it's in the wrong part of the room.
- **t2/Kage:** fine position says (35,50); server says (10,24). Gap = 25+ tiles. This should trigger `TELEPORT_SQUARES = 10` correction, but it hasn't — either the correction code isn't reached in his tick() path (he might be in the "crossing handed over" branch) or the fine position re-syncs but the path fails again.

### The Race Condition (identified, not yet fixed)

The legacy walker (m59-game.mjs `predictSelf`) writes the TARGET position to `c.self.x/y`. On the next tick, the controller's `syncFrom(me)` reads `c.self`. If the target ≠ current, the fine position is set from the wrong square.

After a room-change rejoin sequence:
1. Controller detects new client → calls `ctl.clear()`, `ctl.x = null`
2. Next tick: `if (this.ctl.x == null) this.ctl.syncFrom(me)` — reads `c.self.x/y`
3. But `c.self.x/y` may have been overwritten by `predictSelf` to the route's target, not the character's current position
4. Fine position = target (wrong), not current (right) → persistent gap

`t1/Gountrug` had this happen twice: the controller reported "rejoin detected" twice (new client object). After the sync, `c.self.x/y` held the wrong position. That's why his fine position is (10,14) and not the correct (11,10) area.

### Fix Options (for next session)

**Option A — Validate `predicted` flag in `syncFrom`:**
In `CharacterController.syncFrom(me)`, check `me.predicted === false`. If `predicted` is true (next tick after legacy walker wrote a prediction), skip the sync and wait for the next BP_MOVE. Prevents adopting stale predictions. Risk: may block legitimate syncs.

**Option B — Force `serverMovedPlayer` at 8-tick stall:**
In the `moved = false` branch of `tick()`, after `_noProgress >= STUCK_NO_PROG` (32 ticks = ~12s, which I'm considering increasing to 8s to be more aggressive), call `this.ctl.serverMovedPlayer(c.self.col, c.self.row, c.self.x, c.self.y)`. This uses the SERVER's actual position (col/row/c.x/c.y from c.self), not the fine position, to reset the controller. Risk: may cause visible rubberbanding if the server's position is lagged.

**Option C — Separate the predict/reply race (structural):**
Give the legacy walker its own position variable (not `c.self`). The controller keeps correct fine position. The legacy walker writes predictions to a `session.lastPrediction` object. Largest change.

**Recommended for next session: Option B** — it's surgical, uses the same mechanism already in the resync block, and doesn't require a separate prediction variable.

### Why the Manual Step Test Worked but the Route Didn't

In the t3/Kage diagnostic manual-step test (19 steps, 24 tiles), I sent one square at a time via `m59-act/step` (the legacy atomic). This goes directly through `client.moveTo()` → server processes → BP_MOVE confirms. The controller's not involved in step-by-step play of the tick-keeper's travel path. The manual steps worked because each step was a single confirmed move, not a batched fine-path integration. Fine-path integration fails in rooms where the navPath gives tiny steps (side-stepping) that don't advance the tile or match the route plan.

## Open Questions / Next Steps

1. **Fix t1/t2 position bugs** (Option B recommended above)
2. **Verify t1 can reach the (12,17) door** in room 106 — the trace was failing (`trace_blocked=3`, `fellback=2`). This may be a room-geometry issue (a wall or pocket blocking the inn's south side)
3. **Check room 106 walkability** — is (12,17) actually reachable from (11,10) via the fine geometry? If the .roo has a wall blocking the path, the traceBlock is legitimate and the route should go around
4. **Sustained hunting**: Characters need to be IN the hunt room, not traveling to it. Current behavior is: GOAP picks "travel_to_hunt_room", gets there, then immediately rests. The hunt cycle may need to be more persistent (travel → hunt → loot → travel back) rather than a single agent
5. **Session rejoin handling**: If a character drops and rejoins, the room may have changed. The `roomResyncs` counter tracks these. The rejoin detection in `e4fa536` handles client-reference changes, but if the room changed AND the client is the same object, the `roomNow !== _room` branch should handle it. Need to verify no rejoin gap exists
6. **t2/Kage in the Underworld**: He needs to escape. The underworld path within the keep is a chain of door-hops through (6,9)→(8)→(9). His controller can't navigate from (35,50) fine-position. Fix position drift and he should be able to resume escaping

