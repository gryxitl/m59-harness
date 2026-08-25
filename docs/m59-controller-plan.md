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
