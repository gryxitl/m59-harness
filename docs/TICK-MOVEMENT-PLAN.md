# Plan: give the tick driver its own movement path

## The problem, precisely

The tick driver was built as a new **decision** loop (10Hz `TickLoop` +
`makeDecider` goal ladder) that **delegates all movement to the legacy
session**. It has a real fine-model mover of its own — `m59-mover.mjs` (820
lines), used by the `Router` (`this.mover.tick()`) — but that mover is
**gated by the legacy geometry's floor check**, and several tick-driver
operations still route straight through the legacy `session.walkTo` /
`session.travel` / `session.leaveVia` in `m59-game.mjs`.

Concretely, the tick driver has **two movement paths that don't agree**:

| path | where | who owns it |
|---|---|---|
| fine-model `Mover` | `m59-mover.mjs`, driven by `Router.tick()` | **ours** |
| `session.walkTo` / `travel` / `leaveVia` | `m59-game.mjs` (the 7,300-line session) | **theirs (legacy)** |

The `Mover` delegates obstacle-sliding to `session.walkTo`, and `walkTo` runs
the coarse grid first, then the fine grid — and the fine grid is the one that
answers "goal square has no floor" (`m59-roo.mjs:2509`) for an exit square. So
our fine-model mover is **gated by their geometry's floor check**. That is the
whole Mausoleum trap: the `Router` (ours) plans the leg, hands the aim to the
`Mover` (ours), the `Mover` falls through to `session.walkTo` (theirs), and
their grid refuses the exit square.

## Why everything broke on the update

The tick driver and the legacy keeper **share** `m59-game.mjs`,
`m59-mover.mjs`, `m59-roo.mjs`, `m59-route.mjs`. When the shared
movement/geometry layer moved ("our navigation system moves off upstream's
geometry", Aug 23; the shared-map-per-process change), **both** moved — but
only the legacy keeper has the control flow to absorb the movement (the
`leaveVia` rail system, the `escape_pocket` blink escalation, the
stuck-detector's "route to a different room" fallback). The tick driver's
thinner `routeIntent` path hits the same "no floor" wall and stops, because
nothing in the new decision loop triggers those escape hatches.

Every breakage this session is a version of this:

- **Lee stuck in the Mausoleum** — geometry says "no floor" for the exit
  square; the legacy workarounds don't fire in the tick driver's thinner flow.
- **`/action travel` blocking** — the tick driver `await`-ed a legacy blocking
  method it should have fired-and-forgotten.
- **`c.cast().then()` crashing the loop** — a legacy "cast returns undefined"
  assumption the new sync loop didn't guard.
- **`leave_raza` broker tool failing** — it calls `travelExclusive`, a
  legacy-session method the tick driver's session stub doesn't have.
- **JayB "no weapon to equip (broken or absent)"** — the broken-weapon→buy
  fallthrough is legacy control flow the tick driver's `intend` doesn't
  replicate.
- **Legacy keeper passing through walls, can't navigate fences** — the step
  model (one step per tick) is broken in production. The character picks a
  walled neighbor, the step is refused, and the fallback sends it through the
  wall.

## The goal

**The tick driver owns its movement.** It should not delegate `walkTo` /
`travel` / `leaveVia` to the legacy session. When the shared geometry layer
updates, the tick driver's movement should move with *itself*, not silently
inherit a new refusal.

This is the honest "second generation" move: a new brain **and** a new body,
not a new brain on an old body.

## Phase 0: the continuous-motion physics model

### Why this is Phase 0

The current `Mover` model is "one step per tick" (10 steps/s). It is broken in
production: the legacy keeper (which uses the same step model via
`session.walkTo`) is **passing through walls and can't navigate around
fences**. The step model is the root cause, not a symptom. A
continuous-motion model with proper collision handling is the fix.

The server is **client-authoritative**: it records what we say and moves the
character at the speed we declare. The constraint is not movement — it's
**packets**. `INCOMING_PACKET_THROTTLE = 5` (`user.kod:50`): above 5 packets
in any single second, the server marks the client a spammer and **silently
drops** the overflow. The real client moves at `MOVEUNITS`/`MOVE_DELAY` (256
client units per 100ms = 16 protocol units/tick = 2.5 squares/s walking, 5.0
running) and reports position when (a) ≥ interval since last report AND (b)
moved > threshold.

### The model

The `Mover` becomes a **continuous-motion engine**:

1. **Declare a velocity** (direction + speed), not a sequence of steps. The
   server moves the character continuously at that speed. Walking = 18
   units/tick, running = 36.

2. **Report position at 5/s** (200ms interval), gated by BOTH interval AND
   distance-moved (the real client's two-condition gate, at 200ms not 1000ms —
   a bot moving at 5 squares/s needs a denser report rate than a human to stay
   within the throttle while giving the server enough data to extrapolate).

3. **Re-plan on deviation**: if the character's actual position (from the
   server's last confirmed position) deviates from the planned trajectory
   (collision, wall, stall), re-plan the velocity on the fine model's wall
   segments.

4. **No redundant re-issues**: a move is issued once per target; re-issued only
   on target change or stall detection. This is the production fix for the
   packet throttle — `prod_per_sec` at or under 5, `queue_depth` bounded.

### Wall and fence handling (the specific fix)

The fine model already has wall-segment handling (BSP sectors, step masks, wall
crossing detection in `m59-navgeom.mjs`). The step model breaks it: the
character picks a walled neighbor, the step is refused, and the fallback sends
it through the wall. The continuous-motion model fixes this:

- **Plan the velocity on the fine model's wall segments** (not the coarse
  grid, which is blind to wall segments — 0 non-standable squares in Raza, 280
  of 1792 fine cells blocked).
- **Slide along walls** when the velocity is blocked: a locally clipped step
  means the straight line touched a wall, not that the way is shut. Fanning
  the heading out to either side is what hugging the wall actually is. The
  `Mover`'s existing escape-fan logic (the `_fanIndex`/`_fanTarget` branch) is
  the slide; the continuous model makes it the primary behavior, not the
  fallback.
- **Fences are wall segments.** The fine model's `fineWalkable` + step masks
  already detect fence edges. The continuous model plans around them the same
  way it plans around walls — no special-casing.

### The state model change

The current `Mover` tracks `lastPos`, `pathIdx`, `path` — it *assumes* the
character follows the planned path. The continuous model **drops the
assumption**:

- **The server is the source of truth for position.** The `Mover` reads the
  character's actual position (from the server's last confirmed position) and
  plans the next velocity from there.
- **No internal position tracking.** The `Mover` doesn't track "where I sent
  the character to be"; it tracks "where the character actually is" and "what
  velocity I last declared."
- **Re-plan on every report.** When the 200ms report gate opens, the `Mover`
  reads the actual position, checks deviation from the planned trajectory, and
  re-plans if needed.

### The 5/s reporting gate

```
report if (now - lastReportAt >= 200ms) AND (distMoved > threshold)
```

- `200ms` = 5 reports/second, exactly at the throttle limit.
- `threshold` = the real client's `MOVE_THRESHOLD` = `(FINENESS/4)²` = 16
  protocol units = 0.25 squares (squared: compare `distMoved² > threshold²`).
- The gate is **real-time** (`Date.now()`), not tick-count. In tests,
  `advance()` must move the fake clock for the gate to open (the current
  tests' "relaxed to at least one step" assertion becomes a real assertion
  once the clock advances).

### Opt-in

`policy.ownPhysics` (default **off**). When on, the `Mover` uses the
continuous-motion model. When off, it uses the current step model. Prove it on
one character (Lee, stuck in the Mausoleum — the stand_on bypass + continuous
motion should get him out), then roll it out.

### Phases within Phase 0

#### 0a — the velocity declaration
- Replace "one step per tick" with "declare a velocity (direction + speed)."
- The `Mover` issues a `moveTo(x, y, speed, room)` once per target; the server
  moves the character at `speed`.
- **Gate:** `m59-mover-test.mjs` passes; a unit test shows the `Mover` issues
  exactly one `moveTo` per target (not one per tick).

#### 0b — the 5/s reporting gate
- Add the 200ms + distance-moved gate. Replace the current 1000ms gate.
- **Gate:** `m59-prodrate-test.mjs` passes; a unit test shows the `Mover`
  reports exactly 5×/second when moving continuously, and 0×/second when
  stationary.

#### 0c — the slide-along-wall primary behavior
- Make the escape-fan (slide) the primary behavior, not the fallback. When the
  velocity is blocked by a wall segment, fan the heading immediately.
- **Gate:** `m59-collision-test.mjs` passes; a unit test shows the `Mover`
  slides along a wall (not through it) when the direct velocity is blocked.

#### 0d — re-plan on deviation
- On each report, read the actual position, check deviation from the planned
  trajectory, re-plan if needed.
- **Gate:** `m59-route-test.mjs` passes; a unit test shows the `Mover`
  re-plans when the character's actual position deviates from the planned
  trajectory (collision).

#### 0e — the stand_on bypass (from current Phase 2)
- Re-express the stand_on bypass in the velocity model: when the target is a
  stand_on square, declare a velocity toward it and let the server carry the
  character onto it (the geometry's "no floor" is bypassed by the velocity
  declaration, not by a raw push).
- **Gate:** a unit test with a stand_on square the fine model marks "no floor"
  shows the `Mover` declares a velocity toward it and the character arrives.

### The end state of Phase 0

The `Mover` is a continuous-motion engine: it declares a velocity, reports at
5/s, slides along walls, and re-plans on deviation. The server moves the
character continuously at the declared speed. The packet throttle is satisfied
(`prod_per_sec` ≤ 5, `queue_depth` bounded). Walls and fences are handled by
the fine model's wall segments + the slide behavior. The step model is gone.

### The relationship to Phase 1-5

Phase 1 (un-gate from `session.walkTo`) is **subsumed** by Phase 0 — the
continuous model doesn't call `session.walkTo` at all; it declares a velocity
directly. Phase 2 (stand_on bypass) is re-expressed as 0e. Phase 3 (escape
hatches in `makeDecider`) is re-expressed as 0d (re-plan on deviation). Phase 4
(fire-and-forget travel) is unchanged. Phase 5 (broker-tool session interface)
is unchanged.

So Phase 0 **replaces** Phase 1-3 and **keeps** Phase 4-5. The plan becomes:
Phase 0 (a-e), then Phase 4, then Phase 5.

## The non-goals

- **Do not touch `m59-roo.mjs`'s floor check for the general case.** The "no
  floor" answer is correct for ordinary squares; it's only wrong for `stand_on`
  exit squares. The bypass belongs in the `Mover` (ours), keyed on the aim
  being a `stand_on`, not in the shared geometry (theirs).
- **Do not change the legacy keeper's behavior.** The legacy keeper stays a
  parallel effort. Every change in this plan is to `m59-mover.mjs`,
  `m59-route.mjs`, `m59-tick.mjs`, `m59-decide.mjs`,
  `m59-keeper-process.mjs` — the tick driver's own files. The shared
  `m59-game.mjs` / `m59-roo.mjs` are read, not modified.
- **Do not rewrite the `Mover` from scratch.** It's a real, tested fine-model
  mover. The fix is to replace the step model with the continuous-motion model,
  not to throw it away.

## Phases 4-5 (after Phase 0)

### Phase 4 — fire-and-forget travel/`go` (done, verify)
- Verify the `/action travel` and `/action go` fixes hold; confirm no
  tick-driver path `await`s a whole journey.
- **Gate:** a grep shows no `await session.travel` / `await session.leaveVia` /
  `await session.walkTo` in the tick driver's files; `m59-tick-test.mjs` (35)
  passes.

### Phase 5 — the broker-tool session interface
- The `leave_raza` broker tool calls `travelExclusive`, which the tick driver's
  session stub doesn't have. Either give the tick driver's session a
  `travelExclusive` that routes through the `Router` (fire-and-forget), or mark
  the broker tool as legacy-only.
- **Gate:** `leave_raza` works on a tick-mode character, or is explicitly
  documented as legacy-only and the tick driver has its own `leave_raza` goal
  (already added) that doesn't need it.

## The overall end state

The tick driver's movement is: `Router` (ours) → `Mover` (ours,
continuous-motion, 5/s reporting, slide-along-wall, re-plan-on-deviation) →
the server (client-authoritative, moves at the declared speed). The legacy
`session.walkTo` / `travel` / `leaveVia` are **not on the tick driver's
movement path**. When the shared geometry layer updates, the tick driver's
movement moves with itself. The legacy keeper is untouched and stays a parallel
effort.

## Open question for you

Phase 0 is the highest-risk change in the whole effort — it changes how the
character moves in production. The opt-in (`policy.ownPhysics`, default off)
lets you prove it on one character (Lee) before rolling it out. Do you want to
start with 0a (the velocity declaration) and prove it on Lee, or do you want to
build all of 0a-0e before turning it on?

---

# RETRACTED: "there is one movement engine, and it is the step engine"

*This section is kept in place, with its reasoning intact, because the mistake is
worth more than the correction. It records the decision made in commit `2d44a48`
and the argument that produced it. **That decision is wrong and has been reversed.**
The retraction is at the end of this file; read that before acting on anything
here. Nothing below this paragraph is a current statement of the design.*

*Recorded while removing `policy.ownPhysics`. This supersedes the "Open question
for you" above and the `policy.ownPhysics` opt-in in Phase 0.*

## What the two engines were

Both planned with the same A* over the same fine model. They differed in exactly
one thing — **what a send names**:

| | the send | reach of one packet |
|---|---|---|
| step engine | the centre of the **next adjacent square** | 1 square |
| velocity engine (`policy.ownPhysics`) | a **stride-clamped target** 160/320 units away | up to 5 squares |

## Why the step engine wins

`clientd3d/move.c` is the model, and it is unambiguous. `UserMovePlayer` computes
the next position **locally** — `FindOffsets(move_distance, angle, &dx, &dy)`, then
`num_steps = max(1, min(STEPS_PER_MOVE, ...))` sub-steps of `xinc = dx / num_steps`,
each one checked with `BSPFindLeafByPoint` and resolved by `SlideAlongWall`. Only
after that does `MoveUpdatePosition` speak to the server, and what it sends is
`player.x, player.y` — **where the client already is** — and only once it has moved
more than `MOVE_THRESHOLD` (FINENESS/4) and no more than once per `MOVE_INTERVAL`
(1000 ms).

So the real client moves itself and *reports a nearby position*. It never declares
a far target and waits for a server to integrate it. The step engine's shape —
name one adjacent square, often — is that model. The velocity engine invented a
server-side integration that the reference client does not have.

The same property makes the step engine **structurally safe** where the velocity
engine needed a pile of guards. A send that can only name an adjacent square cannot
land inside a hole two squares away, cannot skip over a cliff, and cannot cut a
corner into a wall. Every one of those had a dedicated check in the velocity block,
and the escape fan existed mostly to clean up after them.

## The proof, not the argument

Reproduced offline on a fixture with a wall between (2,2) and (8,2), a path around
it, and a server that echoes:

| engine | result |
|---|---|
| velocity, stride 160 | 120 sends, **never arrives**, ends in square (2,5) |
| velocity, stride 64 | 120 sends, **never arrives**, ends in square (2,5) |
| step | **arrives in 11 sends** |

Shortening the stride does not help, which is the useful part: the failure is not
"the stride is too long". It is this sequence, from the trace:

```
0 raw-move  idx=0/3 fan=0   <- slide check fires the fan at the wall
1 moving    idx=0/3         <- fan releases, declares toward waypoint (160,377)
2 moving    idx=1/3         <- waypoint consumed
3 raw-move  idx=1/3 fan=0   <- the next waypoint is 6 squares off; the direct
4 raw-move  idx=1/3 fan=0      trace to it crosses the wall
...                          <- forever: fan, one step, fan, one step
```

The velocity engine aims at a **waypoint**, which is far, so the wall between here
and there is always in the way, so the fan always fires. The step engine aims at
the **next square**, which is by construction never behind a wall, so the fan has
nothing to do. Deleting the velocity engine deletes the loop, not just the code.

## Live evidence, which also corrects the premise

The premise above was that `ownPhysics` is off in production. It is not, and the
correction matters because it is the whole reason this was invisible:

| character | `ownPhysics` | engine actually used | outcome |
|---|---|---|---|
| t1 | false | step | normal |
| t3 | **true** | velocity — 1587 `gateOK vel`, 0 `gateOK step` | **0 arrivals** |
| t4 | true | step — 0 `gateOK vel`, 37779 `gateOK step` | 170 arrivals |

t3 ran the velocity engine from start to finish and arrived nowhere, ever. t4 is
the puzzle: the flag was on, yet `vel-tick` never logged once, and the velocity
block's entry trace is unconditional and throttled to one line per 10s. Whatever
made t4 never enter that block, the point for the record is that **the two engines
were both live at the same time in one fleet**, on characters that looked identical
in the roster. That is what "choose one" is for.

## What was removed

`tools/tick/m59-mover.mjs`, 1965 → 1772 lines:

- the slide-along-wall check (34 lines) — existed to route a blocked *long* aim to
  the fan; an adjacent square is never blocked long
- the raycast-ahead check (40 lines) — same reason, one step ahead of a one-square
  step is the step itself
- the velocity declaration (133 lines), including its own waypoint-consume and its
  own copy of the aim clamp
- the `ownPhysics` flag, its heartbeat field, and the `standOnNear` exemption that
  only those three blocks consulted

Standing is its own tick again: the fall-through that skipped it existed so the
velocity declaration could fire on the same tick as the `stand()`.

Kept, because they were never velocity-only: the escape fan, the raw door push, the
stand_on boundary crossing, the server-static escalation, and `aimX`/`aimY` (the fan
probes around the aim and the boundary check tests it).

## Two defects found on the way, both still live in the code that remains

1. **The velocity send never called `_noteServerStatic`.** That function is the sole
   maintainer of `stuckTicks`. Sends flowed, the server never moved, `stuckTicks`
   stayed 0 forever, so the escalation could not fire and the wedge was invisible —
   which is exactly the shape of t3's 790 identical sends. The step site does call
   it. Anyone adding a new send site must call it too; a site that does not is a
   site that cannot be seen to fail.
2. **The void check guarded only the aim, and only when a path existed.** A send
   made with no path — the escape case, where the fine model has already said "no
   route" — was never floor-checked at all. The step engine is exposed to this far
   less, because the square it names is adjacent, but the check is on the square
   being *aimed at*, not the square being *stepped onto*.

## Corrected end state

`Router` (ours) → `Mover` (ours, **one engine**: A* on the fine model, one adjacent
square per send, at most one send per second, escape fan and raw door push for the
squares the fine model gets wrong) → the server. `policy.ownPhysics` is gone; a
roster that still carries it is ignored, not honoured.

---

# Retraction of the section above

*Recorded before any code, deliberately: the last engine decision was made on an
argument, and the argument was the thing that was wrong. Fixing the argument first
is the only part of this that could not be done afterwards.*

**The decision in `2d44a48` — delete the velocity declaration, keep the step engine
— is reversed.** The velocity engine is the engine, and it is being repaired rather
than removed.

## The reasoning error, named

The section above argues from `clientd3d/move.c` that the reference client *moves
itself and reports a nearby position*, and concludes that the step engine's shape
is that model while the velocity engine *"invented a server-side integration that
the reference client does not have."*

The first half is correct. The conclusion does not follow, because **our velocity
engine never did what the sentence objects to.** It did not declare a far target and
wait for the server to integrate it. Read the send site as it was written
(`git show 2d44a48^:tools/tick/m59-mover.mjs`, the re-clamp block):

```js
const adx = aimX - myProtoX, ady = aimY - myProtoY;
const ad = Math.hypot(adx, ady);
if (ad > strideNow) {
  aimX = myProtoX + (adx / ad) * strideNow;   // clamped FROM THE SIM
  aimY = myProtoY + (ady / ad) * strideNow;   // i.e. a locally integrated position
}
```

`aimX` is a position **we** integrated from our own simulated position, capped at one
stride, and then reported. That is precisely the shape the section above credits only
the step engine with having. The argument distinguishes nothing, because it was
directed at a velocity engine that does not exist in this repository.

So the observation that carried the decision — *velocity never arrives, step arrives
in 11 sends* — was real, and it was evidence about **a bug in our implementation**.
It was read as evidence about **the model**. A broken implementation was mistaken for
a wrong model, and the model was deleted instead of the bug.

## What the reference client actually does

All citations are `clientd3d/` in the Meridian 59 source tree.

**There is no velocity on the wire.** `protocol.h:74`:

```c
#define RequestMove(y, x, speed, room) \
ToServer(BP_REQ_MOVE, NULL, FinenessClientToKod(y) + KOD_FINENESS, \
	 FinenessClientToKod(x) + KOD_FINENESS, speed, room)
```

`BP_REQ_MOVE` carries a position, a speed byte and a room. No velocity vector, no
declared time, no target. "Velocity engine" and "step engine" were therefore never a
choice of *what we send*; both send a position. They differ only in **how far the
client integrated locally before reporting it** — one square, or one stride.

**The client integrates locally in sub-steps and stops at the first blocked one.**
`move.c:266` sets the resolution, `move.c:374-382` is the rule:

```c
num_steps = std::max(1, std::min(STEPS_PER_MOVE, NUM_STEPS_PER_SECOND * dt / 1000));
...
retval = MoveObjectAllowed(&current_room, last_x, last_y, &x, &y, z);

if (retval == MOVE_BLOCKED)
{
   x = last_x;
   y = last_y;
   z = last_z;
   bounce = false;
   break;
}
```

**This is the line the section above left out, and it is the whole retraction.** A
real client walking into a wall emits a position *stopped at the wall*. It never
declares a position past one. The identical `x = last_x; y = last_y; break;` appears
again at `move.c:288-296` for a sub-step with no floor (`BSPFindLeafByPoint` returning
NULL), so the stop-at-the-obstacle rule covers walls and voids alike.

`bounce` is not a send flag — `move.c:424` gates only `BounceUser(dt)`, the head-bob.
Nothing about being blocked changes what gets reported; being blocked changes only
*where the integration stopped*, and therefore what there is to report.

**Reporting is rate-limited, not event-driven.** `move.c:57` `MOVE_INTERVAL 1000`:
at most one position packet per second, and `MOVE_THRESHOLD (FINENESS / 4)` — only
report a move at least that large. Our `USER_MOVE_MIN_INTERVAL_MS = 1050` matches
this; the 5% slack is so the server's speedhack counter drains.

## The official rate, derived rather than assumed

`draw3d.h:53` `MOVEUNITS (FINENESS >> 2)` = 32 client units, `move.c:49`
`MOVE_DELAY 100` ms, `move.c:184/188` `move_distance = 2 * MOVEUNITS` for the `*FAST`
actions and `MOVEUNITS` otherwise. Client `FINENESS` is 128 and a server square is 64
protocol units, so one client unit is half a protocol unit:

| | protocol units/s | server squares/s |
|---|---|---|
| official walk | 160 | 2.5 |
| official run | 320 | 5.0 |
| our `WALK_STRIDE_PROTO` / `RUN_STRIDE_PROTO` | **160 / 320** | 2.5 / 5.0 |
| our step engine, 1 square per 1050 ms | 61.0 | 0.95 |

**The stride constants already match the official rate exactly.** The step engine runs
at **0.381 of official walk** and **0.190 of official run**. The ~40% figure quoted in
the goal is therefore derivable from source, and is confirmed; the step engine is not
slow by accident, it is slow by construction, because a send that may only name an
adjacent square cannot cover more than a square per second no matter what the stride
constants say.

## Why the step engine was never the answer

The section above is honest about the step engine's virtue and reads it as a design
property: *"A send that can only name an adjacent square cannot land inside a hole
two squares away, cannot skip over a cliff, and cannot cut a corner into a wall.
Every one of those had a dedicated check in the velocity block."*

That safety is not a design property. It is what you get by **refusing to integrate**.
The checks were deleted along with the integration they were compensating for, and
the price of that trade is two thirds of the character's speed, paid continuously, by
every character, forever, to avoid a bug that had a specific cause and a specific fix.

The trace in the section above says it plainly and was misread at the time:

```
3 raw-move  idx=1/3 fan=0   <- the next waypoint is 6 squares off; the direct
4 raw-move  idx=1/3 fan=0      trace to it crosses the wall
...                          <- forever: fan, one step, fan, one step
```

The fan fires forever because the aim is **inside the wall**. The reference client,
in the same situation, reports the position where its sub-stepping stopped — at the
wall. Our engine projected `myProto + stride * unit(aim)` past it, the fine model said
blocked, and the fan had nothing to resolve because the aim never changed. That is a
clamp that should have been a `last_x`, and it is fixable in the block that was deleted.

## Corrected end state

`Router` (ours) → `Mover` (ours, **one engine**: A* on the fine model, **one stride per
send** — 160 walking, 320 running, which is the official rate — with the reported
position clamped to the last legal sub-step exactly as `move.c:374-382` clamps it, at
most one send per second, escape fan and raw door push for the squares the fine model
gets wrong) → the server.

Kept from the earlier work, because both were real fixes and neither is the thing
that was being argued: the navgeom waypoint frame (square centre, not the `64c` edge)
and the `Pose` seed anchored on the last confirmed server echo.

They are not, however, *equivalent* under the two engines, and pretending otherwise
would repeat the error above in miniature. The edge frame put every aim on a square
boundary, which for the step engine is merely imprecise — it names a square and lets
the integration sort out the rest. For the velocity engine it was fatal: an aim on the
boundary of the square you are standing in *is* an aim at yourself, so the send gate
closed and the character froze with `idx=0/22` and 790 identical packets. The frame bug
was only ever visible in the engine that integrates.

Which is the pattern this whole section should have taught. The velocity engine was not
broken in the way the section above said it was, but it *was* broken, and two of the
three real defects were only ever observable in it — because it is the engine that
actually moves, and so the only one that can show you a movement bug.

## The player's clearance, and why it decides who owns a corridor

Step 3's integration asks the geometry whether a position is legal. The answer depends on one
number that is not in any protocol document: how big a player is. Getting it wrong is what took
most of this step, and the way it was wrong is worth writing down because it is invisible in the
code and only shows up as behaviour.

The trace takes its radius in **client units**, where a square is 1024. The mover works in
**protocol units**, where a square is 64. One protocol unit is sixteen client units
(`protocolToClient` is `(v - KOD_FINENESS) * 16`). Four drafts of the clearance, all wrong the
same way — a number copied between the two spaces:

| draft | what it was | what it did |
|---|---|---|
| 1 | a point | a point can be placed on a wall line and a player cannot; the mover parked with its nose one client unit from a wall and the test reported that as stopping *at* it |
| 48 | `move.c:100`'s `min_distance = 48` | `move.c:122` overwrites that two lines later with `player.width / 2`. The initialiser is not the value in force |
| 256 | a quarter square | right order of magnitude, wrong quantity, arrived at by coincidence with `PLAYER_HEIGHT / 3` |
| 248 | `m59-roo.mjs:145`'s `PLAYER_RADIUS` | the right quantity in the wrong space — 0.24 squares in the trace's units, 3.875 in the protocol units its own comment is written in |

**And the figure I wrote here first was wrong, which is worth more than the number.** The
paragraph above this one claimed the clearance was *3968 client units — exactly two squares*, and
that a four-square corridor was therefore not walkable by trace. Every step of that derivation was
arithmetically correct and the conclusion was false. The error is the same one the table above is
about, one level up: it converted a **length** as though it were a **coordinate**.

Settled from the reference client rather than from my arithmetic:

| | |
|---|---|
| `drawdefs.h:42` | `FINENESS = 1024` — a square, the client's own space |
| `drawdefs.h:52` | `KOD_FINENESS = 64` — a square, the wire's space |
| `bspload.c:448` | `wall->x0 = readValue(buf, room_version)` — loaded with **no** scale conversion, so BSP walls are in the 1024-space |
| `move.c:511` | `if ((newDistance > min_distance) ...)` — compared directly against a BSP plane distance |
| `move.c:580` | `if ((d1 < min_distance2) ...)` — compared directly against a BSP vertex distance² |
| `game.c:261` | `player.width = 31 * KOD_FINENESS / 4; // FINENESS >> 1` |

`min_distance` is compared *directly* against coordinates that are already in the 1024-space, so
the clearance is **248 in the 1024-space — a quarter of a square** — and no conversion applies.
The ×16 conversion is for moving a *coordinate* between spaces; a length written in the destination
space does not take it. `game.c:261`'s own trailing comment is the author annotating the FINENESS
figure (`FINENESS >> 1` = 512) beside the KOD one (496) — the two constants are a factor of sixteen
apart and easy to reach for, which is how the mistake was available to make in the first place.

The consequence of the wrong figure is not a rounding detail: 3968 client units is 3.875 squares of
dead zone on each side of every wall, so **no corridor in the game is walkable** and the mover
refuses rooms it walks perfectly well. That is the exact failure mode this whole goal started from,
reintroduced while fixing a bug of the same family — and the only thing that caught it was a test
that disagreed with the implementation, which is the reason the test was worth writing.

**Rounding has to know whether it stopped.** `_roundBackward` rounds away from the wall, because
the integration returns a fractional protocol position and the wire carries whole units
(`protocol.h:75`), and rounding to nearest does not know which side of a wall line it is on —
measured, an integration that stopped exactly on the clearance line returned 527.06, `Math.round`
gave 527, and 527 is fifteen client units *inside* the wall. But rounding away from a wall that
was never reached is a pure loss: a full 64-unit stride returns 223.9999999999998, which is
floating-point dust and not a near miss, and flooring it gives back a unit every packet — 22 units
over a 22-waypoint route, and a character that never quite reaches the middle of the squares it
stands in. Round away from the wall only when `stopped` is set.

**The raw door push must not be gated on the trace.** The obvious cleanup was to route it through
the integration like every other send. That deletes the branch: it exists to enter a gap the fine
model is *wrong* about — a door alcove — and gating it on the mechanism that is already mistaken
there means it can never fire. Measured, with a trace that refuses everything (the case the branch
was written for) the integrated push sends the origin and the character never moves again. Its
safety bound is the distance instead: one square, which is what the coarse graph has vouched for.

**What the reordering attempt taught.** Moving the velocity declaration above the raw push,
because its comment says it is primary, took the mover suite from 112/3 to 93/22. The reason is the
finding: 292 lines and 12 `return`s sit between them, and the code below assumes the declaration
has *not* yet run. The branch order in `tick()` is load-bearing and undocumented. Fixing the send
sites in place is the correct move; reordering is a restructuring that has to be its own task with
its own evidence, and it is the shape of the 1,300-line function that Step 6 should take on.

## Sends per square, measured (step 5)

The plan carried "~40% of the official walk rate" for the step engine since the retraction, taken
from the mover's own header. That header was wrong — see the speed-budget correction above — so the
figure was an assumption resting on a document that had divided the client's rate by ten. Measured
instead, both engines on one geometry (20 squares in a straight line, one waypoint per square,
`finePathProtocol` returning the same waypoints, same Pose, same 1050 ms tick):

| engine | ground declared per packet | squares per send | vs the client |
|---|---|---|---|
| official client (`move.c:49/57`, `draw3d.h:53`) | 160 protocol units | **2.50** | — |
| restored engine (current `m59-mover.mjs`) | 160 protocol units | **2.50** | **1.00x** |
| step engine (pre-fix mover, engine flag off) | 64 protocol units | **1.00** | **0.40x** |

The restored engine declares exactly the client's distance per packet. The step engine declares one
square, which is 40% of it — so the assumed figure turned out to be right, for a reason that was
not the one written down.

**How the first attempt at this measurement lied, because the method matters more than the number.**
The first rig drove both engines through a fake server that moved the character onto whatever
position had just been sent. Both engines then advanced 64 units per tick and reported 1.00 squares
per send, identically, and the run looked like proof that the restored engine was no faster. It was
proof about the rig. A server that adopts the declared position wholesale gives the mover credit
for ground it only asked for, so the rig measures its own clamping and not the mover. The number
that means something is the **distance the mover declares in one packet**, which is the only part
of the rate the mover controls; how fast the server covers it is the server's, and the client's own
answer to that is `MOVEUNITS` per `MOVE_DELAY`.

**What this does not settle.** It measures an unobstructed straight line, where the stride is never
cut short by a wall. In a maze the restored engine's stride is shortened by the integration, and
the honest expectation is that it will sometimes fall below the step engine's one square — a stride
that stops at a wall covers less than a stride that never tries. Step 6 is where that shows up, and
if the fleet is not faster in game, the straight-line number above is not a defence.
