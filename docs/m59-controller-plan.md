# The tick keeper is a character controller, and currently it is not one

## The goal

The tick keeper is a real-time driver. It should move a body the way a game engine moves
one: own the position, integrate it on a fixed timestep, collide-and-slide against static
geometry, and replicate to the network on a separate cadence.

`clientd3d/move.c` is the reference implementation and it is in this repository's own
source tree. `UserMovePlayer` is a fixed-timestep character controller:

```c
num_steps = max(1, min(STEPS_PER_MOVE, NUM_STEPS_PER_SECOND * dt / 1000));
xinc = dx / num_steps;
for (i = 0; i < num_steps; i++) {
   x = last_x + xinc;  y = last_y + yinc;
   leaf = BSPFindLeafByPoint(...);              // no floor: stop
   wall = IntersectNode(lastBlockingNode, ...); // one-element broadphase cache
   if (wall) SlideAlongWall(wall, ...);
}
```

and `MoveUpdateServer` replicates at `MOVE_INTERVAL` — a separate concern that never
decides how far the body moves.

## What is actually there

`m59-tick.mjs` is a real loop and enforces it: `decide()` may not return a promise
(`m59-tick.mjs:500`). That half holds.

`m59-mover.mjs` is not a controller. It has the fields for one — `path`, `pathIdx`,
`drX`, `drY` — and then throws the important one away every tick:

```js
// Keep DR in sync with current position for the fine model's collision checks.
this.drX = protocolToClient(myProtoX);
this.drY = protocolToClient(myProtoY);
```

Position is re-read from the last server report rather than advanced. It is named dead
reckoning and never reckons.

That matters because **the server does not push our own position** — measured, and the
reason `confirmPosition()` exists. With `confirmInterval` at 2000ms the mover is steering
from a position up to two seconds old and cannot believe it has moved in between.

Three symptoms follow, and they are all the same cause:

- **One square per step.** A square is the smallest displacement it can confirm afterwards,
  so it cannot commit to a continuous path.
- **The gate reads as a brake.** `MOVE_INTERVAL_MS` is a faithful copy of the client's
  replication interval, but with no local integration behind it, one report per second
  becomes one *square* per second — a tenth of walking pace. See `m59-movement-parity.md`,
  which measured this for the async mover and named stride as the remaining gap.
- **`stuckTicks` cannot distinguish "did not move" from "have not re-read".** Position
  cannot change between confirmations, so the two observations are identical. Same family
  as `ms_since_moved` measuring the keeper rather than the character.

And it actuates through `Session.walkTo(col, row, {steps:1})` — the async, tile-granular
mover — so the tick keeper plans in one system and steps in another.

## The shape

Per tick, at fixed dt:

1. **Reconcile.** If a confirmation arrived, correct position and record drift. The server
   is a correction, never the source.
2. **Steer.** Desired displacement toward the next waypoint, clamped to `MOVEUNITS` per
   tick (256 client units walking, 512 running — already declared as `MOVEUNITS_PROTO` and
   `RUNUNITS_PROTO`).
3. **Collide and slide.** `traceFineMoveClient(pos -> desired, { slide: true })`, and take
   where it LANDS. Affordable now: 3us per query after the BSP descent prune, so it is free
   at 10Hz. It was 76us, which is why nobody put it on the tick path.
4. **Commit** the landing to the controller's own position.
5. **Advance** the waypoint when within arrival threshold.
6. **Replicate** when `MOVE_INTERVAL` has elapsed AND displacement exceeds
   `MOVE_THRESHOLD`. The existing gate already implements this correctly — it stops being a
   movement brake and becomes what it was written to be.

Pathing stays `navPath` (free space, ~1ms, synchronous). Tiles go back to being a coarse
graph for the path; the body moves continuously and never asks whether a tile is one place.

## Why this deletes several open problems

- **Stride** stops existing: displacement is speed x dt, not one square per packet.
- **The tile abstraction** stops mattering for locomotion. 44.6% of Raza's tiles and 88.6%
  of the Mausoleum's are crossed by a wall, so a tile is rarely one place — but a continuous
  body never has to answer that question.
- **The bake** stops being load-bearing for movement. A controller asks the geometry
  directly, so a collision fix takes effect immediately instead of after a re-bake.

## The two risks, stated before building

- **The server bounds-checks the grid and NOT the geometry.** `room.kod:2050` refuses a row
  or column outside the room; nothing checks walls, because `server_validate` is false for
  user moves ("already been checked by client (HAHA!)", `room.kod:2046`). So a controller
  bug does not get refused — it puts a character inside a wall. Every committed position
  must come from a fine trace, never from arithmetic.
- **`INCOMING_PACKET_THROTTLE = 5`** (user.kod:50). Replication stays at 1Hz however fast
  the body moves. Sending per-tick is what got the fleet marked a spammer; see
  `docs/packet-throttle.md`.

## How it ships

A new step function beside the existing one, selected by a flag, so the old path stays
intact and a character can be switched back. Measured the same way for both: squares per
second sustained, and whether the body ends up somewhere `moverStepLands` refuses.

## Why walks still fail, measured — and the fix that does not work

Arrival sat at 14-16 of 25 in room 1016 while the other rooms managed 19-23. Four
hypotheses were tested and all were wrong: clearance radius (no effect between 248 and
160), `navPath` returning the start cell (a real bug, fixed, and arrival got slightly
WORSE), the blocked policy (marginal), and replan cadence (no effect between every tick
and never).

Instrumenting a single failing walk found it in one tick. The body sat at y=33018 while
every waypoint marched north — 32640, 32384, 32128, 31872 — and each trace stopped after
15-18 units with `geometry_blocked`. The wall responsible is 250 units away, one unit
outside the 248 player radius:

    passable = true    z1 = 3392  z2 = 4416
    canCrossWallAt  pos = false   neg = true

**A one-way wall.** `freeSpace` filters obstacles with `w.passable === false`, so it treats
the `WF_PASSABLE` flag as the whole answer and does not see this wall at all. The planner
routes through it, the mover correctly refuses, and the body grinds against something the
plan says is not there — 77 blocked ticks against 16 replans.

`m59-roo.mjs` already carries this exact lesson about `canCrossWallAt`: *"We treated
`passable` as the whole answer, and it is only the third of three."* Step height, headroom,
and the flag, evaluated PER SIDE. The planner reintroduced the mistake one file away from
the comment describing it.

It also explains the three dead hypotheses: the wall is not in the clearance set at ANY
radius, so sweeping the radius could not move it, and every replan produced a route through
the same invisible wall, so cadence could not either.

**And asking `canCrossWallAt` instead of the flag does not fix it.** Blocking a cell when
either side refuses was tried and measured:

    room 1016 region 0        9,582 cells (94%)  ->  960 cells (11%)
    false refusals on held    1.80%              ->  2.69%

The Mausoleum is built of one-way ledges and tomb rails, and treating each as a wall
shatters it. Arrival appeared to rise to 23/25 only because the test then drew its random
pairs from a 960-cell fragment: shorter walks, not better walking. Reverted.

So the dilemma is structural, and it is the same shape as the tile problem one level down:

- block when EITHER side refuses -> over-blocks; 1016 collapses
- block only when BOTH refuse    -> under-blocks; back to planning through the one-way wall

**A cell grid cannot express side-dependent passability**, because freedom is a property of
the cell and crossability is a property of the EDGE and the direction taken.

## Planning without the bake, and what it uncovered

**Corrected below.** The section above is right about the one-way wall and wrong to present it
as the whole cause. The obvious next move — since the descent prune made a trace cheap — is to
delete the intermediate representation and let A* expand a node by TRACING THE STEP, which
takes a from and a to and therefore carries the direction a grid cannot hold. `m59-navtrace.mjs`
does that. It is affordable: a 256-unit expansion is **6.1us**, a whole plan **9-15ms** over
about 1,400 nodes, against **61-144ms** for the bake it replaces — and the bake pays for every
cell in the room while the search pays only for what it examines.

Cost was never the obstacle. Measuring it was, and the first two versions of this file were
both wrong in the same way, which is worth recording:

- Snapping nodes to **cell centres** put the start and goal inside walls on 100 of 891 pairs —
  the 15.7%-of-Raza-centres bug, reintroduced at a finer resolution. A centre is not a proxy
  for the space around it at ANY cell size. Fixed by making a node's position the point a trace
  actually landed on, so every node is reachable by construction and the lattice survives only
  as the visited set's key.
- Re-testing clearance at each node, as `freeSpace` must, refuses gaps the game allows, because
  the trace that arrived already enforced the radius with the mover's own geometry.

With both fixed the planner still refused 87% of held pairs, and chasing that is what found the
real thing.

### The two collision models in this repository disagree, and the permissive one has been hiding it

`moverStepLands` and `traceFineMoveClient` trace the same geometry live — no step mask is
attached to any of these rooms — and they do not agree:

    room    steps moverStepLands allows    the fine trace agrees
      38                          1,813                    83.1%
    1016                          1,269                    46.2%
     587                          2,800                    66.9%

Substepping is not the cause: all 683 of room 1016's refusals refuse identically as one
full-tile trace. The largest single reason is `start_has_no_floor`, and behind it is a much
blunter fact — **36.2% of the squares room 1016's coarse grid calls walkable have no floor
under their centre in the BSP**, and nudging the query up to 64 units off the plane recovers
none of them, so this is not the on-plane splitter bug. The two grids simply disagree, which
`docs/m59-routing.md` already says they do.

**Ground truth settles which one to believe.** Of the 944 squares the fleet has actually stood
on, **940 have a floor — 99.6%**. The floorless regions are not a hole in the BSP; they are
places the game never let anybody stand, and the coarse walkable grid is the party that is
wrong about them. So those refusals are harmless — no real path begins in the void — and the
comparison has to exclude them. Restricted to steps between two floored squares:

    room      floored steps    trace agrees    residual
      38              1,777           84.8%    geometry_blocked 267
    1016                696           84.2%    geometry_blocked 106
     587              2,046           91.6%    geometry_blocked 172
    1012              3,044           74.8%    geometry_blocked 757

That residual — 8 to 25 per cent, all of it `geometry_blocked` — is the honest open question,
and one-way walls are part of it rather than all of it. It is also enough on its own to explain
the 87%: a 15% edge refusal rate distributed at random barely dents connectivity, but these
cluster at doorways, and a planner that loses a doorway loses everything past it.

### Where that leaves it

The controller moves with the strict model and the fleet's router plans with the permissive
one, so the controller refuses steps the rest of the fleet makes all day. That gap is the bug
to close, and it is a question about `traceFineMoveClient` and `moverStepLands` — not about
navmeshes, and not something a better planner can paper over. Real-time planning is built,
cheap, and ready; it should be wired in AFTER the two models agree, because until then it
faithfully reports a disagreement as an impossible walk.


## Wiring it to a live character, and the seam that was wrong

`M59_TICK_CONTROLLER=1` routes `Actuator.walk()` through the controller, and the loop
integrates one tick of physics in `driveTick()` before `decide()` runs. That works, it is
tested both ways, and on a live JayB it produced **zero** controller activity across 877
ticks and nine walk decisions.

**Because the tick keeper does not move through `Actuator.walk()`.** Combat movement goes
`m59-combat.mjs:_walkTo` -> `session._mover` -> `m59-mover.mjs`, which is a third mover with
its own A*, its own fine stepping, and its own `to()`/`tick()` contract. So the count is:

| mover | driven by |
|---|---|
| `session._mover` (`m59-mover.mjs`) | the tick keeper, in combat — the one that carries the fleet |
| `session.walkTo` | `Actuator.walk()`, and the travel/errand paths |
| `CharacterController` | still nothing |

`_mover.tick()` already has the controller's shape — a per-tick call returning `moving`,
`arrived`, `blocked`, `stuck`, `no-route`, `raw-move`, `blinked` — which is why it is the
seam that matters and `walkTo` is not. Wiring the controller in means satisfying THAT
contract, including the states the keeper acts on: `no-route` sets `_moverNoRoute` and
blacklists a target, and `stuck` is what escalates to a blink.

Until that is done the controller remains unexercised on a live character, and the flag is
honest but inert for combat movement.


## What the live run actually showed, and why the controller would not have fixed it

JayB, tick keeper, Mausoleum, one run:

    1,658 swings   49 walk attempts   62 blinks
    stuck at (38,28) x24   (38,26) x18   (23,20) x8   ...
    30s median stuck before each blink, 92s worst

So he is NOT reaching his destinations. He walks, grinds for thirty seconds, blinks away,
and does it again — 42 of the 62 blinks from two adjacent squares near the east wall.

**And it is not a sealed pocket.** Every stuck square is walkable, has a floor, and sits in
region 0 — the main 9,582-cell body — with the mummy he is chasing in the same region.
`sameRegion` says the route exists. The mover simply cannot execute it. That is precisely the
failure the controller was written for.

**But the controller would not have fixed it.** On those five exact walks:

    (38,28) -> (22,30)    grid OK 157 wp    trace REFUSED  (3,737 nodes)
    (38,26) -> (22,30)    grid OK 149 wp    trace REFUSED
    (23,20) -> (22,30)    grid OK  40 wp    trace REFUSED
    (38,28) -> (20,34)    grid OK 175 wp    trace REFUSED
    (26,24) -> (22,30)    grid OK  32 wp    trace REFUSED

The grid finds a route every time and the mover cannot walk it; the trace planner refuses
every one. Both are wrong, in opposite directions, and wiring the controller to `_mover`
today would trade "walks and gets stuck" for "never sets off".

The 84.2% step agreement in this room is not a small discrepancy to tidy up later — a 16%
refusal rate concentrated at doorways is exactly enough to disconnect the room, and these
five walks are what that looks like from the character's side.

**So the blocker is `traceFineMoveClient`, and nothing downstream of it can compensate.**
The place to work is room 1012: 757 `geometry_blocked` disagreements, zero floorless squares,
so nothing else is mixed in. Take those steps one at a time and establish which model is
wrong about each — that is the question everything else has been waiting on.

**And `m59-navgrid.mjs` stays.** Sealed-pocket detection is what stops a keeper chasing a
walled-off mummy, and `sameRegion` is a flood over `freeSpace`. An earlier note in this file
called the grid disposable if trace planning worked; that was wrong on two counts — trace
planning does not work yet, and the region flood is load-bearing regardless of who plans.


## Where it got to: the real-time keeper, running

Combat movement is on the controller (`M59_TICK_CONTROLLER=1`), planning on the grid.
Measured on JayB in the Mausoleum, same room and same character throughout:

| | baseline (legacy mover) | controller |
|---|---|---|
| blinks | 62 | 0 |
| blinks per 100 swings | 3.7 | 0 |
| stuck-and-blink loops | 30s median, 92s worst | none |
| arrivals | n/a | 18 in one 14-minute run |
| tick errors | 0 | 0 (8,142 ticks) |

Four bugs had to be fixed before any of it showed, and only one was in the controller:

1. **The stuck clock counted the fight.** `_lastPosAt` advances only when the position
   changes, and the fighting/resting exemptions skipped the blink without resetting it — so
   the moment a target died the character was already "stuck for 30s" and blinked on the
   spot. Seven blinks from (12,31) in a window logging 194 swings at a mummy in reach.

2. **Reconcile compared against a snapshot taken when we last SENT**, which freezes the
   instant a blocked body stops sending. Drift reached 3,254 units — three squares — while
   reconcile fired seven times and corrected nothing. A ring of recent beliefs fixes it.

3. **`scanBrokenFromEvents` re-read the whole event ring every call**, so one genuine "it's
   broken" refusal condemned a different good weapon on every subsequent equip: thirteen
   condemnations marching down the pack until `armed` could only answer "no weapon to
   equip". `eventsSince` and a watermark exist for exactly this.

4. **Nothing in the tick path ever called `requestInventory`.** `client.equipment()` stays
   `known:false` until a `BP_USE_LIST` arrives, and `armed` is a `whenUnknown:true` fact —
   so an unread hand read as ARMED for the life of the session. The survive keeper asks in
   six places; this loop asked nowhere.

**And a false reading cost an hour.** `/health` reported `equipment` by filtering the pack on
`flags & 0x04` and returned `[]` for a character `/probe` showed wielding a mace. What you
carry and what you are wearing are two different lists, `client.equipment()` is the only
answer, and it distinguishes `known:false` from empty — which a flag filter cannot.

### What it still cannot do, and why that is not an adapter problem

From (3,17) the controller walks to (22,30) in 12.4s. The same planner's 76-waypoint route to
(2,35) — where the mummies are — is refused on the ninth tick and the body never leaves the
square. Both points are region 0, so it is not a pocket: it is the 8-25% step disagreement
between `moverStepLands` and `traceFineMoveClient`, and no amount of adapter work closes it.

So a destination the controller cannot make progress on after twelve ticks is **handed back**
to the legacy mover, which already has verified escape fans, raw server-confirmed moves and
blink. The controller keeps what it is better at and returns what it is worse at. Live, that
is 87 swings, 0 blinks and 11 handbacks in an eight-minute run.

**`kills/min` cannot measure any of this.** `recordKill` is called only from
`m59-autopilot.mjs`; the tick keeper never writes to the ledger, so `m59-minimal.mjs` reports
0.00 for a tick-keeper character no matter what it kills. That is the next thing to fix if the
question is "is it earning", and it is a reporting gap rather than a keeper one.


## CORRECTION: the coordinate convention, and what it invalidates

**`standPoint(row, col)` is `(col - 0.5) * 1024`, not `(col + 0.5) * 1024`.** Every
`moverStepLands` vs `traceFineMoveClient` comparison recorded above used the second form and
therefore compared TWO DIFFERENT SQUARES, one tile apart. The safe-spot work in this file is
unaffected — it converts held squares with `(col - .5)`, which is correct — but the model
comparisons are not.

Re-measured with `standPoint` on both sides, which is the point the mover actually uses:

    room 1012   3,044 steps   91.2% agree   geometry_blocked 267
    room 1016   1,269         91.7%                         105
    room  587   2,800         84.8%                         427
    room   38   1,813         91.2%                         159

So the disagreement is **8-15%, not 17-54%**, and every case is `geometry_blocked`.

**And the floorless-squares finding was entirely an artifact.** "36.2% of the squares room 1016
calls walkable have no floor under their centre" becomes **2.1%** at `standPoint`, and room 587
goes from 20.7% to **0.0%**. There is no hole in the BSP and there never was; there was a
one-tile offset in the query. The ground-truth check that appeared to corroborate it — 99.6% of
held squares have a floor — was measured with the CORRECT convention, which is exactly why it
disagreed with the broken one and should have been the tell.

What survives:

- The controller executes routes the legacy mover grinds on. That was measured with plans and
  traces on the same points, and the live runs bear it out.
- The four keeper bugs (stuck clock, reconcile snapshot, broken-weapon cascade, unread hand).
- The travel oscillation and its fix.
- A real 8-15% `geometry_blocked` disagreement, which is the thing still worth chasing.

What does not:

- Every "17-54%" or "46.2%" agreement figure.
- The floorless-square finding and everything argued from it.
- The claim that the coarse grid is "wrong about the void" — there is no void.


## AND THERE IS NO DISAGREEMENT. The whole premise was a slide.

Of the 958 steps across four rooms where `moverStepLands` says yes and a strict trace says no:

    room 1012   267 strict refusals  ->  267 land INSIDE the target square when sliding
    room 1016   105                      105
    room  587   427                      427
    room   38   159                      159

**Every one. Not a single step went nowhere.** The two collision models agree completely. The
"8-25% disagreement" — and the 17-54% before the coordinate fix — was never a disagreement
between models; it was the difference between `slide:false` and `slide:true`, and `slide:false`
is the wrong question to ask about walking.

The body is a DISC and a path is a line through points. Clipping a corner and sliding along it
is HOW a disc crosses a square — `move.c` does it every frame, and `CharacterController.step`
already does it. Demanding a clean straight line refuses ordinary walking.

So `m59-navtrace.mjs` refused all five of JayB's failing walks because IT traced with
`slide:false`. Fixing that took its false-refusal rate from 86.98% to 52.08% against held
pairs — better, and still far worse than the grid's 1.80%, because sliding also makes the
lattice drift and the search wander (347 waypoints where the grid uses 40).

**Which settles the planner question: use the grid.** `navPath` refuses 1.80% of pairs the
fleet has demonstrably walked, the controller executes its plans — all five failing walks
arrive offline, 3.4s to 18.9s, zero blocked ticks — and that combination is what is deployed
(`M59_NAV_TRACE=off`). `m59-navtrace.mjs` stays in the tree as a measured dead end, not as a
fallback: it was written to solve a problem that does not exist.

**The remaining movement question is the controller's handbacks** — 270 in a 30-minute arm —
and it is NOT about planning. The plans are good and the collision models agree. It is about
what happens between a good plan and a body that stops moving.
