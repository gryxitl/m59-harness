# The real-time bot: a tick loop over pushed state

**Status: the tick keeper is now the live path for this fleet.** (Updated 2026-09-01.) The legacy keeper (`m59-autopilot.mjs`) is still in the codebase and is used by other fleets in parallel. See `docs/architecture.md` for the current architecture.
This is the plan for the next iteration. Read `docs/HANDOFF.md` first for the GOAP
layer it reuses, and `CLAUDE.md` for the rules that outrank everything here.

---

## 0. Where we are

Three drivers now exist in the tree. Only the first runs the fleet.

| | file | state |
|---|---|---|
| the ladder | `m59-autopilot.mjs` | **drives every character today.** 13,196 lines |
| GOAP-in-the-ladder | `m59-keeper-goap.mjs` | opt-in via `policy.useGOAP`, a branch INSIDE `pass()` |
| the tick loop | `m59-tick.mjs` + `m59-decide.mjs` + `m59-route.mjs` | **the live path for the fleet** |

The first two share a defect that is architectural rather than a bug:

```
loop { ws = evaluate(client); plan = planFor(ws); await stepPlan(...) }
```

Sensing happens only at the top of a pass and the act phase blocks the next one, so **how
often the agent looks at the world is decided by how long it spent not looking**.
Measured across 11,854 GOAP passes on this fleet: median 80ms, p99 16.6s, worst 207s.
82% of deaths had the keeper blind at the moment of death.

---

## 1. The facts this rests on — each verified, not assumed

- **THE SERVER DOES NOT PUSH OUR OWN POSITION. MEASURED 2026-08-20, AND IT BREAKS THE
  ORIGINAL PREMISE OF THIS DOCUMENT.** An earlier draft said "`BP_MOVE` writes our own
  position into `room.objects` with `predicted` cleared", on the strength of READING the
  handler in `m59-client.mjs`. The handler exists. The packet does not arrive.

  Three consecutive raw moves on JayB, each one landing:

  ```
  before   40,25    sent moveTo    after 1.2s: self 40,25 UNCHANGED, events: []
  confirmPosition() -> 40,26       the move HAD landed; nothing was pushed
  ```

  Repeated three times, zero events each time. The client learns its own position only by
  ASKING. Consequences, all of which invalidate something written above:

  - **`confirmPosition()` is not redundant polling — it is the only way to know where we
    are.** Its `CONFIRM_DEADLINE_MS` (8s) is the price of a real requirement, not a
    mistake, and the "stopgap" reverted earlier (waiting for a pushed `moved` event) would
    have waited for a packet that never comes.
  - **`Sensor.read()` returns a STALE position** unless something polls. The tick loop as
    built senses position that can be arbitrarily old.
  - **The watchdog's position pulse is reading that stale value**, which is why it fired
    `! NOT MOVING — travelling` during the live tick run on a character that was in fact
    moving. That alarm was FALSE and the instrument was measuring nothing.
  - `predicted: true` exists on objects for exactly this reason: the codebase already does
    dead reckoning, and it has to.

  **What is still true:** health/vitals and equipment are pushed (the watchdog has worked
  off `client.vitals()` for a long time), and `evaluate()`/`planFor()` remain synchronous.
  It is POSITION specifically that must be polled or predicted. A test that tried to
  confirm the vitals half of this was inconclusive — vigor was already at its cap, so
  there was nothing to push — and is not claimed either way here.
- **The sense and decide halves were ALREADY synchronous.** `Session.snapshot()`,
  `view()` and `perception()` are not even declared `async`. `evaluate()` and `planFor()`
  are synchronous. Nothing in sense-or-decide ever needed to block.
- **Only actuation blocked**, and mostly for nothing: `confirmPosition()` sends
  `roomContents()` and waits up to `CONFIRM_DEADLINE_MS` (8s) to learn a position the
  server had already pushed. Live, one step cost 7.2 seconds that way.
- **The collision model is baked into `substrate/`.** With `M59_ROOT` explicitly unset:
  `sharedRoomGeometry(map.rooms[1012])` returns geometry with `collisionReady: true` and
  a step mask attached. **Motion planning needs no game install and no server** — but see
  §4a: which planner to use is NOT settled, and the offline models have not been checked
  against the server at all.
- **`M59_ROOT` is on this machine** at `/Users/costas/Documents/Projects/Meridian59`
  (265 `.roo`, 1,232 `.kod`). Worth exporting for kod citations and the compendium; it
  is NOT required for routing.

---

## 2. The model

```
every 100ms, never blocking:
  frame  = sensor.read()        // free -- but POSITION IN IT MAY BE STALE, see §1
  intent = decide(frame)        // pure, synchronous, no awaits
  actuate(intent)               // enqueue one command; do not await
```

### The five rules (enforced by `m59-tick-test.mjs`, 29 assertions)

1. **A tick never awaits an actuation.** A `decide()` returning a promise is reported and
   NOT awaited — awaiting it restores the blocking loop while every counter still reads
   "tick".
2. **The sensor never sends.** Built on `snapshot()`/`perception()`, never `view()`,
   which runs A* per object: a sensor that slowed as the room got busier would put us
   back where we started.
3. **Effects are observed, not returned.** The actuator reports what it SENT. Whether it
   worked is the next frame's question. This makes *"no error has never meant success"*
   structural rather than remembered — there is no return value left to misread.
4. **The tick rate is fixed.** Latency changes when a command lands, never how often we
   look.
5. **A slow decide skips.** A backlog of decisions is a backlog of decisions about a
   world that is gone.

### Ticks are a sampling cadence, not a simulation step

**We do not integrate.** A game engine needs `dt` because it carries state forward
(`position += velocity * dt`). We carry nothing: the server owns position and pushes the
result. A dead-reckoned copy would be a second, wrong world.

**Therefore every duration is WALL CLOCK, never a tick count.** Ticks coalesce under
load — measured, a 60ms decide at 100hz yields ~4 ticks in 250ms, not 25 — so anything
counted in ticks stretches exactly when the loop is already struggling. This rule was
broken once already (`skipFor = 30` ticks in the decider) and is now `skipForMs`.

The frame carries `dt_ms` anyway, for observability: a frame 2s after the last means we
were blind for 2s, and some decisions deserve to know.

---

## 3. What is built and green

| file | assertions | what it is |
|---|---|---|
| `m59-tick.mjs` | 29 | `Sensor`, `Actuator`, `TickLoop` |
| `m59-decide.mjs` | 19 | `evaluate` → `planFor` → `intend`, synchronous |
| `m59-route.mjs` | 20 | a route as STATE: destination + leg, one step per tick |
| `m59-watchdog.mjs` | 16 | the out-of-band guard, hosted by either driver |
| `m59-tick-run.mjs` | — | run one character; **ran JayB at 9.8 ticks/s, longest decide 4ms** |

The live run is the number that matters: **737 ticks in 75s, 0 skipped, 0 errors, longest
decide 4ms**, against the old model's p99 of 16.6s.

---

## 4. What is missing, in order

### 4a. MOTION PLANNING — MEASURED, AND THE FIRST TWO DESIGNS WERE WRONG

**Everything below is reproducible: `node tools/m59-motion-probe.mjs`.** Offline, no
server, no `M59_ROOT`. It was written because the argument in earlier drafts of this
section rested on numbers QUOTED FROM CLAUDE.md rather than measured here, and two of
them do not survive being checked.

**40 random walkable pairs across 5 rooms:**

```
coarse (geo.path over squares)     found a route  29  (72.5%)
fine   (finePathProtocol)          found a route  16  (40.0%)   fine-only: 0
coarse plans containing >=1 step the mover refuses   6 of 29  (20.7%)
refused steps / all coarse steps                     6 of 726  (0.8%)
fine planner cost: median 168ms, p90 1278ms, max 1296ms, node cap hit 4x
hybrid (coarse corridor, string-pulled): 22.0 points, 178 UNVERIFIED legs, <1ms
```

**WHAT THIS OVERTURNS**

- **"Fine planning beats coarse" is FALSE.** Fine finds routes in 40% of cases against
  coarse's 72.5%, and `fine-only: 0` — it never finds a route coarse cannot. It exhausts
  its 20,000-node budget on room-crossing distances and returns "not found", which is
  indistinguishable from genuinely unreachable. An earlier draft of this document claimed
  the opposite on the strength of ONE short route in ONE room.
- **"218 of 311 centre-to-centre steps fail" DOES NOT REPRODUCE.** In this checkout, with
  baked step masks, **0.8%** of coarse steps are refused by the mover's own trace.
  Whatever that upstream figure measured, it is not this build. It should not be cited as
  a reason for anything here until somebody reproduces it.
- **The hybrid is not verified either.** Coarse corridor + `stringPull` gave 2.0 points
  and ZERO unverified legs in Raza, and 22.0 points with **178 unverified legs** across
  five rooms. Raza was a lucky room. Same error as the first bullet, one layer along.

**THE LIMIT ON ALL OF IT, AND IT IS THE IMPORTANT PART**

`moverStepLands` and `traceFineMoveClient` are BOTH OUR CODE. This probe compares two
local models to each other; it cannot say what the SERVER does, and the server is the
only authority on whether a move lands. The single piece of real evidence about the
server is a character standing at a fence re-sending a refused move.

**THE SERVER HAS NOW BEEN MEASURED — `node tools/m59-move-probe.mjs`.**

70 single-square moves on JayB in Raza, each one sent and then CONFIRMED (the server does
not push our position, see §1):

```
arrived 70    moved-but-not-arrived 0    did not move 0

moverStepLands       said LANDS 64 -> 64 arrived     said NO  6 -> ALL 6 ARRIVED
  false confidence  0/64    0.0%
  false caution     6/6   100.0%

traceFineMoveClient  said LANDS 60 -> 60 arrived     said NO 10 -> ALL 10 ARRIVED
  false confidence  0/60    0.0%
  false caution    10/10  100.0%
```

**The server accepted every move, including every one both models refused.**

- **Neither model produced a single false positive.** Nothing they approved failed, so
  planning on them is safe in the direction that matters.
- **Every rejection either model made was wrong.** In this room their refusals are pure
  loss: they would route a character the long way round, or report "no route", for moves
  the server takes without complaint. That is the failure that makes a route look
  impossible and leaves a character standing.
- It also explains why the coarse planner found routes in only 72.5% of pairs offline: it
  is refusing ground the server allows.

**AND THE REASON IS THAT MOVEMENT IS CLIENT-AUTHORITATIVE.** Measured, in the same room:

```
non-standable squares in Raza: 0 of 1980

asked 41,23 -> 41,19   ( 4 squares)   landed 41,19   1393ms
asked 41,19 -> 41,29   (10 squares)   landed 41,29   1288ms
asked 41,29 -> 65,29   (24 squares)   landed 65,29   1283ms
```

A position 24 squares away, claimed in ONE packet, granted exactly, in the same time as a
four-square move. A server that validated movement would not allow that. `stepFine`'s own
comment says so and I did not believe it until this: *"VALIDATE BEFORE SENDING. The server
accepts player coordinates; a room read is confirmation of state, never a collision
oracle."*

**THIS REVERSES THE MEANING OF THE NUMBERS ABOVE.** "100% false caution" is the wrong
name for it. The server never checks, so **our models ARE the collision rule** — a
rejection is not a bad prediction, it is the client declining to walk through its own
geometry. The measurement does not show the models are wrong; it shows nothing is
enforcing them but us.

Four consequences, and they change the design more than anything else in this document:

- **COLLISION IS ENTIRELY OUR RESPONSIBILITY.** There is no oracle to defer to and no
  refusal to learn from. `blockedEdges`-style learning from "the server refused" cannot
  work, because the server never refuses. That whole idea in an earlier draft is dead.
- **WE COULD MOVE IN LONG JUMPS, AND WE MUST NOT.** The server would take a 2-packet
  journey, but that is cheating — see the speed budget below. What the simplification
  really buys is that a waypoint need not be a square: we walk TOWARD it at the legal
  rate, and the path between waypoints does not have to be enumerated.
- **BEING TOO PERMISSIVE IS NOT FREE.** The server will happily put a character inside
  geometry. What that costs — stuck bodies, rooms that cannot be left, something the
  server does notice later — is UNKNOWN and is the next thing worth measuring.
- **AND THE WALL TEST IS DONE. RAZA IS FULL OF WALLS; I WAS MEASURING THE WRONG THING.**
  I searched for non-standable SQUARES and found 0 of 1980, and concluded the room was
  open ground. A fence is not a square — it is a wall SEGMENT between squares, and the
  coarse grid is blind to it:

  ```
  Raza wall segments:            760   impassable: 466
  non-standable squares:           0   <- what I searched for
  cells fineWalkable() == false: 280 of 1792   (15.6%)
  ```

  `standable()` reads the coarse grid, which `moverStepLands`'s own comment calls "a
  SERVER artifact". Only the fine model — `fineWalkable`, `traceFineMoveClient` — knows
  about wall segments. **Anything planning on `standable()` is blind to 15.6% of this
  room**, which is a large part of why the coarse planner's routes contain steps that go
  nowhere.

  The wall test itself, run against a cell with `fineWalkable = false`:

  ```
  moved INTO the wall     -> accepted, the server placed us there
  moved back OUT again    -> accepted, one move, no struggle
  ```

  **Movement into geometry is accepted and is not a trap** — at least here, at least for
  one wall. So the cost of being too permissive is lower than feared, though "he got out
  of one wall" is not "no wall is a trap".

  **And it caught my own error:** the 24-square jump in the distance test above parked
  JayB INSIDE a wall at 65,29 and I did not notice, because I was checking `standable()`,
  which said the square was fine. He stood there through two subsequent test runs.

### THE TWO OBLIGATIONS THAT FOLLOW FROM CLIENT AUTHORITY

Nothing on the server enforces movement, so both of these are ours or they do not happen.

**1. WE ARE THE COLLISION SYSTEM.** Not a predictor of one — the only one. And it must be
the FINE model: `standable()` reads the coarse grid and is blind to 280 of 1792 cells in
Raza (15.6%), because a fence is a wall SEGMENT and not a blocked square. Planning on
`standable()`, which `geo.path()` and `moverStepLands()` both do, is planning on a map
that does not have the walls in it.

**2. WE MUST MOVE AT A LEGITIMATE SPEED.** The server will accept a 24-square jump in one
packet — I sent one — and that is cheating, whoever is watching. The real client's own
numbers, from the source on this machine:

```c
FINENESS   = 1024            // clientd3d/drawdefs.h:42   client units per square
MOVEUNITS  = FINENESS >> 2   // clientd3d/draw3d.h:53     = 256 units
MOVE_DELAY = 100             // clientd3d/move.c:49       ms between MOVEUNITS
move_distance = MOVEUNITS        // walking
move_distance = 2 * MOVEUNITS    // running   (move.c:184)
```

Which gives the budget, exactly:

| | per 100ms | per second |
|---|---|---|
| walking | 0.25 squares (16 protocol units) | **2.5 squares** |
| running | 0.50 squares (32 protocol units) | **5 squares** |

and wading scales it by 3/4, 1/2 or 1/4 with depth (`move.c:196-201`).

**`MOVE_DELAY` IS 100ms, SO THE REAL CLIENT'S MOVEMENT LOOP IS A 10hz TICK.** The cadence
chosen for `TickLoop` is the game's own, which means one tick maps exactly to one legal
move step. That is a coincidence worth keeping: **one tick, at most one MOVEUNITS of
movement** is both the rate limit and the loop's natural shape, and it needs no extra
budget-tracking machinery to enforce.

This also retires the "long jumps" idea from the previous section. We CAN send a
string-pulled 2-waypoint path as 2 packets — the server allows it — and we must not.
A waypoint is a destination to walk toward at 16 units per tick, not a place to appear.

**WHAT THIS SAMPLE DOES NOT SHOW, and must not be over-read:**

- **One room, and an open one.** Raza is largely clear ground. A room with real walls
  would certainly produce refusals; this sample contains almost no genuine obstacle.
- **The character wandered locally**, so the ground covered is biased toward wherever it
  happened to start.
- **Single-square moves only.** Nothing here says anything about long legs.
- 6 and 10 rejections is a thin denominator for "100%".

**The sample that would settle it is the fence** — the one place we have independent
evidence of a real obstacle, because a person watched a character fail at it. Running this
probe in that specific spot is the next measurement, and it is cheap.

**So the next step is not to pick a planner. It is to measure the server.**

A probe that, on the live server, sends a move and records whether the pushed position
changed — over a few hundred moves, tagged with what each local model PREDICTED. That
gives, for the first time in this repository:

- how often the server refuses a move `moverStepLands` approved (false confidence)
- how often it accepts one the trace rejected (false caution)
- whether either model is worth planning on at all

Cheap to run (one character, no fighting), safe, and it is the only thing that can settle
the design. **Nothing else in 4a should be built before it.**

**What is already known and does not need re-testing:**

- The collision model is baked into `substrate/` — geometry, `collisionReady: true` and
  step masks for 264 rooms, with `M59_ROOT` unset. Planning needs no game install.
- `moveToSquare` aims at a square's CENTRE, and the client collides a CIRCLE OF RADIUS
  256 FINE UNITS against wall segments (`fineWalkable`), not a point against a grid. So
  square centres are the wrong thing to aim at even if the coarse path is the right
  corridor — whatever plans the route, the MOVES should be fine coordinates via
  `client.moveTo(x, y)`, which is what `client.self.x/.y` already are.
- `finePathProtocol` short-circuits to 1ms when the straight line is clear, which is most
  short legs. Its expensive case is the one to avoid, not its normal case.
- **EXITS ARE NOT 1:1** — a leg is recomputed on every room change, never reversed.
- **`exits()` runs flood fills** — room change only, cached as the leg.

### 4b. THE HUNT GOAL — "why do I have to assign a destination?"

Right now `m59-tick-run.mjs --to 1016` is a **test harness**, not the design. The decider's
`DEFAULT_GOALS` are survival-shaped only (healthy / armed / vigor / food), so a healthy
armed character correctly reports `idle — nothing to do`.

The automatic half is a goal that picks a hunt room from the spawn index and hands it to
the router — the job `m59-keeper-goap.mjs` does with its hunt-room selection. Port it as
a goal whose `when` is "nothing better to do" and whose action is a destination.

### 4c. THE SURVIVAL FLOOR ON THE TICK DRIVER

`m59-watchdog.mjs` already takes a host interface and `m59-tick-run.mjs` already starts
it. What is missing is the rest of the first row of CLAUDE.md's split — **mortality and
recovery**: death, the Underworld, and `passPlaybook`'s three moments. None may be left
behind when a character moves to this driver.

### 4d. WIRING, ONE CHARACTER, BEHIND A FLAG

`m59-keeper-process.mjs` constructs `autopilotFor(session)`. Add a mode that constructs
the tick driver instead, per character, opt-in. The legacy keeper stays the default and
the fallback.

### 4e. ONLY THEN: DELETE FROM THE MONOLITH

`m59-autopilot.mjs` has gone 13,355 → 13,196 (the watchdog extraction). Until a concern
is **removed** from it, this is a parallel implementation rather than a migration — the
repo's own working agreement. The first honest deletion is whichever lifecycle concern
the tick driver covers end to end.

---

## 5. What is unproven

Stated plainly, because "the design is coherent" and "the design works" are different
claims and only the first is fully supported.

- **The tick driver has never fought anything.** It has sensed, planned and idled live at
  9.8hz. It has never swung, eaten, fled or died.
- **The router has never completed a journey.** It planned, and it walked into a fence.
- **One tick of staleness is accepted, not measured.** The collision validator reads the
  latest pushed position, which may be one tick old. The server is the authority and
  refuses illegal moves silently, so the cost of being wrong is a tick — but nobody has
  counted how often it is wrong.
- **No character has run on this for an hour.** Every number above is minutes.

---

## 6. Live bugs found on the way, still open

- **`FOOD_RE` matches `\bmushroom\b`**, so `pickFood` feeds the fleet its farmed loot.
  Policy question, not an atomic bug — left for a decision.
- **`m59-backup.mjs --credentials-only` cannot run on this machine.** It defaults to
  `C:\m59\backups` and `D:\m59\backups`, which are treated as relative paths inside the
  repo and refused. One tool also defaults `M59_ROOT` to `'C:/code/meridian59'`. Same
  family: Windows defaults on a darwin machine, failing at the moment they are needed.
- **`m59-keeper-goap.mjs:resolveMapRoom` trusts a colliding room number.** It returns
  the live id whenever it happens to be a map key, without checking the name — and live
  ids collide with unrelated map numbers (JayB in "Raza", live id 2013, which is map room
  "The East Tower"). `m59-route.mjs:resolveRoomNum` does it correctly: objId table, then
  name, then the raw number last.
- **~10 orphaned suites** from the discarded BT keeper still fail, and the delegation
  ratchet is red because of them.

---

## 7. Definition of done for this iteration

1. `geo.path`-based motion planning, tested against synthetic geometry, that routes
   around an obstacle and records what it learns.
2. JayB completes a journey to the Raza Mausoleum on the tick driver, watched.
3. A hunt goal, so no destination has to be assigned by hand.
4. The survival floor complete on this driver.
5. One character running it for an hour, with the pass-duration distribution measured
   the same way as the baseline in §0.
