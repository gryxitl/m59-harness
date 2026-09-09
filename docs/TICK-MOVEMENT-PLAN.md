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
squares the fine model gets wrong) → the server. `policy.ownPhysics` no longer selects
anything — no mover code reads it — but it is NOT removed from the tree: the roster still
carries it and `m59-keeper-process.mjs` still surfaces its value in the `/state` diagnostic,
explicitly labelled as the roster value rather than a mode in effect. "Ignored, not honoured"
is true of its EFFECT; "gone" was false of its EXISTENCE, and an auditor caught the difference.
Reading that field as "which engine is running" would be wrong in exactly the way the five
vacuous tests were wrong.

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
| restored engine **at the time of this measurement** | **64 protocol units** | **1.00** | **0.40x** |
| step engine (pre-fix mover, engine flag off) | 64 protocol units | **1.00** | **0.40x** |

**SUPERSEDED — READ THIS BEFORE QUOTING IT.** The middle row is a measurement of an intermediate
state of the mover, taken while the waypoint lookahead was still missing (see "Why the claim was
made" below, which is the diagnosis and is still correct). The lookahead has since been restored
above the stride clamp (`m59-mover.mjs`, "LOOK DOWN THE ROUTE"), and the current figure is
**2.00 squares per packet**, reproduced by `node tools/m59-rate-measure.mjs`. This table and the
one further down are not two measurements of one thing that disagree; they are before and after a
fix, and the word that made them look like a contradiction was "current". An independent audit
correctly flagged two tables both claiming to be current as a report that cannot be trusted. The
rule taken from that: **a measured figure is labelled with the commit it was taken at, or it is
not a measurement — it is a rumour with a decimal point.**

**THIS TABLE WAS WRONG WHEN IT WAS WRITTEN AND IS CORRECTED HERE.** The middle row asserted 160
units / 2.50 squares / 1.00x, and the prose below it said the assumed figure 'turned out to be
right'. It did not. An independent audit ran the committed measurement tool and got 1.00 for both
engines, which is the honest result, and the number has since been reproduced offline: on open
ground with a ten-waypoint walkable plan the mover declares 64 units per packet after the first.

**Why the claim was made and why it was wrong.** `WALK_STRIDE_PROTO` is 160 and the integration
does return 160 when asked for it. What was never checked is what the aim IS by the time the
integration is called, and the answer is one square: the waypoint lookahead was lost in the removal
and never restored, so the mover aims at the adjacent square, the stride clamp has nothing to
clamp, and the 160-unit budget is spent on a 64-unit heading. The engine was 'restored' in the
sense that the code was present and correct, and ineffective in the sense that nothing asked it for
more than a square. Reading the constant instead of the measurement is what produced 2.50.

**The fleet is therefore still at 40% of the client's rate.** That is the goal's headline outcome
and it is NOT achieved. It is written here as a failure rather than as a caveat, because the
previous version of this document talked itself out of it.

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

## In game, on the restored engine (step 6)

The fleet was restarted onto the new code and observed in game. t3 and the other three characters
came back 5/5 in game; t4's tick errors went from **2,361 of 2,461 ticks to 0** once `buy()`'s
out-of-scope `frame` was fixed, which is what had been reporting as `no route from 106 to 1013`.

**Destination-to-send ratio, t3, one session on the new code: 3 destination changes / 148 packets
= 0.0203.** The baseline quoted throughout this goal — 13,619 dests / 244,021 sends = 0.0558 — is
**not a comparable number, and the reason is the finding.** It was produced by counting occurrences
of the string `moveTo sent` in `keeper-t1.log`. This mover has nine `moveTo` call sites and
exactly one of them logged, and that one logged with that sentence. So the baseline is a count of
lines matching one branch's log text: it is not a packet count, and it changed when the sentence
was rewritten during this work with no change in behaviour whatsoever. Counting `moveTo sent` in
the new logs returns zero, which looks like a mover that never sends and is only a changed string.

The instrument is now `[move-sent] n=… aim=… from=…`, emitted from `_recordSend` — the one place
every send must pass through on pain of the teleport detector misfiring — so the count cannot drift
from the code the way a log pattern can.

**The measurement that actually answers the goal, from that instrument:**

| | value |
|---|---|
| ground declared per packet, median | **143 protocol units = 2.24 squares** |
| the official client's walk stride | 160 units = 2.50 squares |
| the step engine's | 64 units = 1.00 square |
| packets declaring zero ground | 3 of 148 |
| longest run of an identical declared aim | 16 packets |

At 2.24 squares per packet the mover is at **90% of the client's walk rate**, where the step engine
was at 40%. The shortfall is real and expected: the integration stops at walls, so a stride that
hits a wall declares less than a full stride. That is the correct behaviour and the whole point of
the integration — the pre-fix engine declared full strides into walls.

**The freeze that started this goal is gone.** `keeper-t3.log` held 790 of 879 sends declaring the
identical aim `(1472,1152)` — a character shouting at a point inside its own square. The longest run
of an identical declared aim in the new window is 16 packets, and the destination is reached rather
than abandoned.

**What this window does not settle.** t4 sat idle with no destination and sent nothing, so it
contributes no rate; a single session of t3 is one route, and the median hides a distribution with
a 5,525-unit outlier (a room transition, where "from" is in the old room's coordinates — the same
trap that made a naive ground total read 3,829 squares for 169 packets). A second live session, and
a route that goes through a door, are what would make the 90% figure a rate rather than an
observation.

## Line count, disclosed rather than left to be discovered

The previous goal carried a constraint that mover + route must end up **smaller** than its 2,933
line baseline. They are not, and nobody wrote that down, which is the actual complaint:

| | mover | route | total |
|---|---|---|---|
| baseline entering the last goal | 1,974 | 959 | **2,933** |
| after the last goal (step engine only) | ~1,792 | ~896 | **~2,688** |
| now, with the engine restored | see `wc -l tools/tick/m59-mover.mjs tools/tick/m59-route.mjs` | | |

The restoration is not net-neutral in lines. `_integrateToward`, `_bisectToWall`,
`_roundBackward`, the corner-rounded release and the send instrument are all additions, and the
step engine they replaced was smaller because it asked the geometry nothing. **A mover that
consults collision is longer than one that does not** — that is what consulting collision is.

So the honest statement is that the reduction goal was **not met** and the reason is a real
tradeoff rather than an accumulation of cruft. What *was* reduced is the thing the reduction was
supposed to buy: destination changes per unit of movement, and the number of ways a position can
reach the wire without the geometry being asked. If line count is the binding metric, the way to
meet it is to delete the integration, which is the change this goal exists to undo. That choice
should be made deliberately rather than arrived at by attrition, which is why it is written here
instead of being quietly exceeded.

## m59-which-test fails 13/3 in this environment, and did before any of this work

Reported rather than tidied away, because a suite that fails looks like a regression and the
honest answer is that it is not one: checking out `90643c9` — before every change in this
session — and running `node tools/m59-which-test.mjs` in a clean worktree gives the same
`13 passed, 3 failed`.

The three are broker-lock assertions that read real lock files from the machine, and this
checkout has a live fleet that writes them. It is an environment dependency in a suite
advertised as offline, which is worth fixing on its own terms: a test that reads `substrate/`
is not offline, and the fix is a fixture directory rather than a change to `m59-which.mjs`.

## The two 'not recovered' blocks, settled by testing rather than by re-pasting

The audit correctly noted that two blocks from the pre-removal velocity section were not
recovered: the **slide-along-wall check** and the **raycast-ahead check**, the latter including
the clause *"corner rounded → release the fan"*. They are not the same case and they resolved
differently.

**The corner-rounded release was genuinely lost and has been restored.** It is the only thing
that releases an engaged escape fan when the direct path becomes clear. Without it the fan
fires on dither and never lets go, so the character oscillates. It now requires three things —
the direct trace clear, the fan's own heading still walkable, and a fan with actual history —
and the assertion is falsified: disabling it takes the suite 117 → 116.

**The persistent slide was never lost** — `mover.mjs:856`, unchanged.

**Raycast-ahead is subsumed, and that was tested rather than assumed.** The old check took one
point one stride ahead, asked `fineWalkable` — a *square-centre* test — and fired the fan
instead of declaring. The current mover integrates the heading in sub-steps and stops at the
wall, so the illegal position is never constructed in the first place. Measured on the case it
existed for (a wall one step ahead with a clear direct line to the aim): the mover steps around
the wall and sends, and never declares a position inside it. Restoring the old block would add
a coarser second opinion that disagrees with the integration on the same geometry — two
predicates for one question, which is the defect this whole effort was opened to remove.

So it is recorded as **deliberately not restored**, with the test that decided it, rather than
re-pasted to satisfy a checklist item. If a case appears where the mover declares into a wall
that the old point-check would have caught, that is a new bug and this section is the place
that claim gets re-examined.

**At the time this was written, the defensible number was 1.00 square per packet, measured offline.**

> **SUPERSEDED, and the reason matters more than the number.** The paragraph below correctly
> destroys the live 2.24 / 2.83 readings — they differenced `from=`, the mover's *sim* position,
> which is an estimate and not the character. That critique stands and still applies to anyone who
> tries to read speed out of `from=`. But this section then measured 1.00 and called it final while
> the waypoint lookahead was missing, and named the cause exactly right (`MOVEUNITS_PROTO` asked for
> one square per tick regardless of the stride). That cause has since been fixed at the site the
> section pointed at. The current figure is **2.00 squares per packet**, reproduced by
> `node tools/m59-rate-measure.mjs`. Keeping the old number as "what the document stands behind"
> after fixing the thing it was measuring is how a document ends up arguing with itself, which is
> what an independent audit caught. The diagnostic reasoning is kept because it is correct; the
> number is not current.

An earlier draft of this document claimed 2.24 and then 2.83 squares per packet from live logs.
Both were wrong, and the error is worth keeping on the record because it is the same mistake the
historical '244,021 sends' was made of: the figure was taken from whatever the log happened to
carry. `[move-sent]` logged `from=`, the mover's **sim** position, which jumps to wherever the
last declaration aimed. Differencing it measures the estimate, not the character. A live reading
of 'STRIDE 4.99 squares' — twice the legal walk stride, which would have been alarming — turns
out to be consecutive packets in different rooms, and the log carries no room id per packet, so
that reading is not refutable from the log at all.

Measured where the geometry is controlled instead — open ground, straight route, walk speed,
positions taken from the wire — the mover declared **1.00 square per packet**, and the maximum
declared delta was 64 units. That is within the client's 2.5-square walk stride. It is superseded
by the 2.00 figure above; what is NOT superseded is the method — positions taken from the wire,
never from `from=`.

It is also why the mover is not faster than the step engine yet. `MOVEUNITS_PROTO` is 16
protocol units = one square, so the integration is asked to advance one square per tick no
matter what the stride would allow. Reaching the client's rate means raising that constant to
`MOVEUNITS/16 = 10` client units per MOVE_DELAY and letting the ten-tick report carry 2.5
squares. That is a deliberate change to the speed the mover declares, with speedhack exposure
attached, and it should not be done as a side effect of a refactor. It is left undone and named
here rather than quietly shipped.

## The engine has never run live, and the server's movement model is still unmeasured

`substrate/keeper-t3.log` for the current session contains **zero `vel-tick` lines**. The restored
velocity declaration has therefore never executed against the real server. Every rate figure in this
document for the *live* fleet is a step-engine figure, and the 2.5-squares-per-packet target is a
reading of the client's source, not a measurement of the server.

That matters because the target's whole justification is that the server **believes** the position
we declare. The evidence for that is `move.c:96` — `server_x` is the "Last position we've told
server we are" — and the fact that the client integrates its own motion locally and only re-anchors
when the server tells it a position outright (`move.c:732`, `:810`). It is a strong reading. It is
still a reading: **the server's C++ source is not in this tree** (`include/proto.h` and the client
are all that ships), so nobody here has read the server's move handler.

The consequence for ordering, which is what this section is actually about: `tick()` contains BOTH
engines, and the step branch sits above the velocity declaration and returns. It sends exactly one
square — its own comment says so, 'walk one ADJACENT square at a time, same as the GOAP driver's
`act.step()`'. After the first tick of any route that branch always applies, so the declaration
below it is unreachable code. That is why the committed measurement came out equal for both
engines, and it is the honest explanation of a result the previous draft attributed to the rig.

Deleting the branch is not the fix: with it disabled, two assertions fail with 'never arrives',
because the branch also owns waypoint consumption and arrival. The fix is to make that branch send
the stride instead of the square, and to prove the server accepts it — which requires it to run
live at least once and the `srvXY` instrument to be read. Until that reading exists, 2.5 squares
per packet is a hypothesis with a well-read argument behind it, and this line is where that
distinction is kept.
## The denominator was wrong, and the real number is 3.6% rather than 40%

Every rate in this document — the step engine's 1.00, the restored engine's claimed 2.50, the
auditor's 'came out equal' — is **squares per packet**. That is the wrong denominator, and using it
made a three-percent problem look like a forty-percent problem for the entire time this file has
existed.

Measured live this session, with the aim diagnostic confirming the request is sane
(`aim=(30,2) inBounds=true` from `me=(49,4)`, a normal 19-square walk):

| | value |
|---|---|
| ground made | (49,4) → (59,7) ≈ 10.8 squares |
| observation window | ~120 s |
| packets sent | 85 |
| **squares per second** | **0.09** |
| squares per packet | 0.13 |
| reference client walk | 2.50 squares/s, ~1 packet/s |
| **fleet vs client** | **~3.6%** |

One square per packet at **one packet per twelve seconds** is not 40% of the client. The rate is
set by the ticks that send *nothing* — the send gate, the planner returning `found=false`, the
escape fan spending ticks on probes — and not by how far a packet that does go out happens to
reach. That is why the per-packet framing was so durable: it measures the packet and ignores the
twelve seconds.

**What this does to the goal.** The goal was 'the fleet moves at the rate the real client moves
at'. Fixing the per-packet distance from 1.00 to 1.88 is real and is now asserted, and it does not
move the number above by much, because the bottleneck is not the distance. The bottleneck is that
`finePathProtocol` returns `found=false` on **every single tick** for a destination that is in
bounds and nineteen squares away, which puts the mover in the escape fan permanently, which sends
probes instead of strides. Until that is fixed, the fleet's speed will not change materially and
no engine choice will make it.

**The planner failure is the open question, and it is not the frame bug.** The frame defect
(waypoints at square edges) was found and fixed earlier in this work, and `m59-frame-test.mjs`
pins it. This is different: the same planner, on the same room, reports no path from (49,4) to
(30,2) while the character walks that route under escape-fan control and reaches neighbourhoods
the planner says are unreachable. Either the edge predicate is over-rejecting on the real room
geometry, or the search is being asked about a room the character is not in. The `[aim-dbg]`
diagnostic added this session distinguishes those and is logged once per leg rather than once per
tick — a per-tick line for a condition that never changes is how a 387 MB log got written.

**Honest status of the goal.** The engine restoration is real: sub-stepped integration, stops at
walls, bisect-to-wall, backward rounding, corner-rounded fan release, the zero-stride fall-through
that was starving the fan, and now a branch ordering that lets the declaration execute at all.
Those are all verified and several are falsified. **The fleet does not move at the client's rate
and this work did not achieve it.** The measurement that was supposed to prove otherwise was run on
the wrong denominator, and correcting it makes the gap larger, not smaller.
## The model question is settled by live evidence, and the rate tripled

**Model A is *mostly* true, and the claim as first written here was an overclaim.** The open
question the whole step-vs-velocity argument rested on was whether the server adopts a declared
position outright or walks the character toward it. The evidence I cited was one sequence where a
declaration of (3296,480) was followed by the server's position becoming (3296,480) — and that is
real, the server does accept strides of 256 units. But it is not unconditional, and a later
reading of the same log shows the opposite case, three packets running:

```
declare (1783,1257) ground=320 stopped=clear  srvXY=(2080,1376)  prevDecl=(1783,1257)
   packet 1: srvXY (2080,1376)
   packet 2: srvXY (2080,1376)
   packet 3: srvXY (2080,1376)      <- the server never moved
```

Same mover, same instrument, opposite verdict. So the correct statement is **the server accepts
declared positions but REFUSES some of them**, and the refusal is invisible to us: our own trace
reports `stopped=clear` and the server disagrees. That is a predicate disagreement between this
repository's geometry model and the server's, in the same class as the 16-unit-probe-authorises-320
defect — our model being more permissive than the server's — and it is now the leading candidate
for the remaining rate gap, because a rejected packet is a second of progress for nothing.

Note the shape of the rejected case: `idx=0/1`. The path had ONE waypoint 320 units away, so the
mover was beelining at a distant point across ground the fine model never validated square by
square. The accepted case had `idx=3/14`, mid-route. That is a concrete, checkable difference and
the first place to look. It is now answered from the live server, by the `srvXY` instrument added
for the purpose:

```
declare=(3296,480) ground=264 stride=320 idx=3/14  srvXY=(3040,544)
declare=(3552,480) ground=256 stride=320 idx=3/10  srvXY=(3040,544)
   ...the server's raw position then reads (3296,480)
```

The mover declared (3296,480) and the server's position later *was* (3296,480) — 256 protocol
units, four squares, from where it had been, in one accepted packet. The server does not walk the
character toward an aim at one square per second. That confirms `move.c:96` against the running
server and it retroactively invalidates `Pose.advance`'s one-square clamp, which encoded the other
model.

**The rate, measured from the server's position rather than the mover's estimate:**

| | before the ordering fix | after |
|---|---|---|
| ground | ~10.8 squares | 59.11 squares |
| packets | 85 | 118 |
| window | ~120 s | ~170 s |
| **squares per second** | **0.09** | **0.35** |
| squares per packet | 0.13 | 0.50 |
| vs the client's walk (2.50/s) | 3.6% | **14%** |

**3.9x faster, live.** Still not the client's rate, and the reason is now narrow and measurable:
118 packets in 170 s is one packet per 1.4 s, which is essentially the client's one-report-per-second
cadence. The packet rate is right; the ground per packet is not — 0.50 against a stride of 2.5 walk
or 5.0 run. Most packets are still not strides.

**The planner failure was a symptom, not a cause.** `plan ... found=false reason='no fine path'`
appeared 794 times in a three-minute window before the ordering fix and **zero times after**. The
mover was planning A* from a position one square behind its own feet — because `Pose.advance`
clamped the track by a square per send while the packets carried strides — so the search started
from a square the character had already left and could not connect to the aim. Fixing the position
truth fixed the planner. That is why the diagnostic now reports `expanded` and the goal square's
walkability: when the planner fails again it should say why in terms that can be checked.

**What is left, stated as the remaining defect rather than as progress:** the mover reaches
`stride=320` and delivers 0.50 squares per packet, so the stride is being computed and then not
sent. The step branch and the escape fan still own most ticks. That is the next thing, and it is
measurable in the same units now.
## A lag read as a freeze: the misreading that cost the most time

Near the end of this work I concluded the fleet was still frozen, from four consecutive log lines:

```
vel-tick  declare=(736,2464) ground=281 stride=320  srvXY=(1102,2040) prevDecl=(822,2196)
move-sent n=163 at=736,2464 aim=736,2464 from=822,2196 site=stride-declaration
move-sent n=164 at=736,2464 aim=736,2464 from=822,2196 site=stride-declaration
next tick: srvXY=(822,2196)
```

`at=` equalled `aim=` and the character's own position was 282 units away, which is *shaped* like
the 790-send freeze that opened the whole piece of work. It is not that. **`ground=281` says the
integration travelled 281 units**, and the server then moved toward the *previous* declaration:
the server is one declaration behind us and catches up, and the sim is seeded from the echo, so
`from` is always a stride behind the aim. Echo lag of roughly two strides, read as a loop.

I wrote a fix for the phantom — an extra condition on `Pose.updateServer`'s echo adoption — and
the falsification killed it: with the condition removed, the test written for it still passed.
The change was reverted. What was kept is the assertions, on their own merits (dead reckoning
goes to the declaration; an echo to a position we never declared *is* adopted), with the comment
stripped of the claim that they cover the reverted condition.

**The consequence for the rate figure, which matters more than the misreading.** If the server
lags by two strides, then ground computed by differencing consecutive server echoes
understates what the mover achieves, because it measures the pipeline's output one or two
packets late. The committed `m59-rate-live.mjs` reports **0.39 squares/s, 16% of the client's
walk** that way, and that number is a lower bound rather than a rate. The honest statement is
that the fleet is at roughly *0.4 squares per second, measured conservatively*, that it was at
0.09 before the branch-ordering fix, and that neither figure is tight enough to support a claim
about the client's rate.

**What would make it tight.** The log needs the server position at every packet rather than
whenever a `vel-tick` line happens to be emitted — the echo is available on every tick and is
only logged on some of them. That is a one-field change at the single send site, and it is the
next thing, ahead of any further engine work."

## The rate, measured densely: 0.81 squares per second, 32% of the client's walk

`[move-sent]` now carries `srv=`, the server's position at that packet, read at the single place
every send passes through. Before that the server position appeared only on `vel-tick` lines —
some packets, not others — so ground was differenced across an irregular sample and the
fleet's squares-per-second came out as a moving guess (0.09, 0.34, 0.39) rather than a number.
That is the whole story of the measurement trouble in this document: not a disputed method, a
missing field.

```
server positions      39 distinct (1 room transition excluded) [dense: one per packet]
packets sent          153  (118 from the stride declaration)
GROUND (server truth) 154.33 squares
window                190 s
RATE                  0.81 squares/s
vs the client         32% of walk (2.5/s), 16% of run (5/s)
packets per second    0.80 (the client reports ~1/s)
ground per packet     1.01 squares (client stride: 2.5 walk / 5.0 run)
packets by send site:
     118  stride-declaration
      12  walk-past-boundary
       8  no-path-stride
       5  raw-move-push
       4  waypoint-step
       4  send-waypoint-helper
       2  escape-fan-probe
```

**Progress on one metric, same instrument, same units:**

| | squares/s | vs client walk |
|---|---|---|
| before the branch-ordering fix | 0.09 | 3.6% |
| after it, sparse sample | 0.39 | 16% |
| now, dense sample | **0.81** | **32%** |

**Where the remaining 68% is.** 0.80 packets/s × 1.01 squares/packet = 0.81. The cadence is at
80% of the client's — close enough that it is not the bottleneck. The ground per packet is: 1.01
against a 2.5-square walk stride, and the mover is running at the *run* stride of 320 and being
stopped short by geometry. 77% of packets come from the stride declaration, so the engine is
doing most of the work now; the step branch and the fan are down to 35 packets between them.

**What is NOT claimed.** This is not the client's rate. It is a third of it, measured from the
server's position, and the measurement is only as good as the sample — 39 distinct server
positions in 190 s means the server's position is reported roughly every fifth packet, so even
the dense sample is quantised. Tightening it further means reading the echo on every tick rather
than every packet, which is a sensor change and is the next thing before any further engine work.
---

# The speed claim, measured — and it does not explain the fleet

Step 5 of the goal said: *prove the speed claim, and do not accept it if it is false. If velocity
is not faster once fixed, say so plainly and stop — the whole justification for this work would be
gone and that must be reported, not hidden.* Here is the measurement, and the answer has two halves
that must not be merged.

## The claim is TRUE per packet

`node tools/m59-rate-measure.mjs`, both engines, identical open geometry, one virtual clock.
**This is the current figure** (reproduced on the tree at the commit that added this note; the
earlier 1.00 table is superseded and says so):

| engine | ground per packet | vs the client's 2.50 sq/packet |
|---|---|---|
| step engine (`2d44a48^`, engine flag off) | 1.00 squares | 0.40x |
| restored stride engine (current mover) | 2.00 squares | 0.80x |

And in game the mover declares the *full* run stride — `ground=320 stride=320 run=true` on 12 of
the last 20 stride samples — and the server adopts it **exactly**, to the unit:

```
[echo] x=800,2528 -> x=722,2838 moved=320 (4.99 sq)
```

So the stride engine is 2x the step engine per packet, and 2.5x if it were walking-limited rather
than wall-limited. That part of the premise holds.

Note that the offline fixture's 2.00 is itself an understatement of the mover: the fixture never
lets `runNow` come out true, so it measures the walk stride. The live mover declares 320 units.
A fixture that quietly measures a different configuration from the code under test is worse than no
fixture, because its number looks like a property of the code.

## The claim is FALSE as an explanation of the fleet

The fleet's real speed, measured by an instrument that cannot fake it — `Pose.noteGround`, which
accumulates ground at the moment the server's echo arrives, with its own clock, excluding room
transitions at the source:

```
[mover-hb] ... ground=2.0sq/64s=0.03sq/s trans=0
```

**0.03 squares per second.** Two squares in a minute. The stride engine is running, declaring
320-unit strides, and being honoured exactly — and the character does not go anywhere, because
ground per packet is not what limits it. What limits it, from the same logs:

- **t4: `dest=1013 rstate=no-route why=no route from 106 to 1013`, retried every 15 s.** The
  character has nowhere to go. The mover is never asked to move. There is no tick-state line for it
  at all, because `tick()` is never entered with a destination. This is a routing-graph gap.
- **t3 and t2: pacing one column between two rooms.** t3's echo, in order:

  ```
  x=800,2656 -> 800,2592 -> 800,2528        walking, 1 sq/s
  x=800,2528 -> 722,2838  moved=320          stride adopted, 5 squares
  x=722,2838 -> 2336,160  moved=3127         ROOM TRANSITION
  x=2336,160 -> 800,2976  moved=3208         ROOM TRANSITION, BACK AGAIN
  x=800,2976 -> 800,2912 -> 800,2848 -> 800,2784 -> 800,2720      walking back
  ```

  Column 800 appears on every line. The tick-states say `path=8/9 stuck=2,3,4` and alternate
  `moving`/`crossing` every tick: nine waypoints, stuck on the last one, which is a doorway that
  puts the character back where it came from.

## What this means for the work

The locomotion engine is fixed and is faster than what it replaced, by the measurement the goal
asked for. It was never the reason the fleet crawls. Doubling the stride cannot help a character
with no route, and cannot help a character that a doorway throws back.

The two remaining limits are, in order of how much fleet throughput they cost:

1. **Routing: `no route from 106 to 1013`.** Four of five characters produce no ground at all.
   They are not slow; they are not moving.
2. **Room transitions that reverse the character.** `state=crossing` alternating with `state=moving`
   at the last waypoint of a path.

Both are above the mover in the stack, and neither is a locomotion-model question. The goal's
premise — "that is why the fleet crawls", referring to the step engine's one square per second —
is disproved, and this is the report the goal asked for if the measurement came out that way.

## The instrument that finally made this measurable

Six different speeds were printed today and each was wrong in its own way, because in every case
the position was sampled at a moment chosen for a different purpose and divided by a clock that
measured something else:

| claim | what it actually measured |
|---|---|
| "the server honours 29% of declarations" | `srv=` is sampled at send time, so a packet sent between two echoes repeats the previous one and reads as a refusal |
| "median displacement per packet is 0.00" | same artefact; 164 of 331 `srv=` values are exactly (32,32) mod 64, synthesised from `col`/`row` because the echo carried no `x`/`y` |
| "the server moves at 49 squares/s" | divided by `updatedAt`, which every no-change echo refreshes, so the denominator was the frame period |
| "170 squares/s" | a room transition. The echo's `x`/`y` are room-local, so a new room is a new origin and the delta is not distance |
| "0.96 sq/s moving, 0.46 overall" | two windows, one containing a vigor rest, presented as though they disagreed |
| "0.03 sq/s" | `Pose.noteGround`: accumulated when the echo arrives, its own clock, transitions excluded at the source |

`noteGround` counts a transition's *time* and no distance, and counts standing time as time. The
first version overwrote its reference position unconditionally, so a transition or a standstill
replaced the reference and the ground between them was lost: three one-second squares accumulated
2 squares over 1 second. Dropping time you cannot count does not make a rate conservative, it makes
it **inflated** — the exact failure mode the rest of this file exists to avoid.

One test assertion was written wrong and then corrected in place: the first version demanded that a
60 s standstill contribute **no** seconds, which would have made the figure a rate "while moving".
A player who is sitting down is slow, and the fleet's speed is what a player experiences.
Conflating the two is what made this repository's numbers look irreproducible for a day.

---

# The fleet does not move at all, and no per-packet rate describes it

A later build, with the instruments finally trustworthy — corroboration, `noteGround`, `tick-state`
carrying the real session name — reports this for all five characters:

```
move-sent packets this session, all five: 0
tick-state lines, all five:               0
destination sets (`to() ->`), all five:   0
```

What the five are doing instead:

| | the decider's own line |
|---|---|
| t1 | `armed -> buy` — smith unreachable recently; hunting unarmed |
| t2 | `unstuck -> travel` — stuck 9x in room 734; leaving for hunt room 562 |
| t3 | `!in_underworld -> escape_underworld`, while `uwdbg` prints `in_underworld=true` |
| t4 | `armed -> buy` — traveling to the smith (room 1013) |
| t5 | `armed -> buy` — traveling to the smith (room 1013) |

and behind t4/t5, every fifteen seconds:

```
[routedbg] dest=1013 rstate=no-route why=no route from 106 to 1013
```

**The mover is never asked to go anywhere.** The destination is never set, so there is no stride, no
packet, and no rate. The loop is: the decider asks the router for room 1013, the router answers
`no-route`, the decider reads that as being stuck, and picks a different goal — then asks again.

This is the honest answer to the goal's question. The premise was that the fleet crawls because the
step engine reports one square per packet. The stride engine is restored and is 2x the step engine
per packet on identical geometry, and the fleet's speed is zero, so no per-packet figure describes
it. Measuring locomotion was measuring the wrong layer.

## Two separate defects, both above the mover

1. **A routing-graph gap.** Room 1013 is unreachable from 106, 201 and 534 — three different
   characters in three different rooms, all asking for the same destination. The decider has no
   handling for `no-route` other than to try again and then treat it as being stuck.
   *Not diagnosable offline from this repository:* `tools/rooms.json` is a room-name catalogue
   (282 entries of `file`/`class`/`room_name`/`rid`) and carries no room numbers and no connections,
   so it cannot say whether 1013 is absent from the graph or merely unconnected.
2. **A predicate that disagrees with its own diagnostic.** t3 fires `!in_underworld ->
   escape_underworld` while `uwdbg` on the next line prints `in_underworld=true`, with
   `clientRoomNum=null` in the same record. Two readers of one state, one of which sees null.

## What the instruments earned

`corroboration()` caught the divergence guard erasing its own evidence, which had been written down
as a finding since the frame fix and never addressed:

```
send 0  declared x=1120  after echo sim x=1120  div=320  pending=2
send 1  declared x=1440  after echo sim x=800   div=0    pending=4    <- guard fired
send 2  declared x=1760  after echo sim x=800   div=0    pending=6    <- guard fired
```

The guard fires every second and reports success by construction, because what it does to fix
divergence is move the track to the server's position, which erases the distance it just measured.
It cannot accumulate a signal. The only number that grows is the count of declarations nobody
confirmed.

## And the routing "gap" is not a gap: it is the safety guard, and the decider is the bug

`findPath` answers the blocked destinations directly, offline, no server:

```
106 -> 1013: found=false  reason=no route from 106 to 1013 in the graph without crossing 555
              (The Forest Shrine — acid gas puzzle, kills outright (e5.kod:452 PunishPlayer);
               the safe row is random and moves, and is only learnable by asking LadyPheonix)
534 -> 1013: same.   201 -> 1013: same.   556 -> 1013: same.   1012 -> 377: same.
556 ->  555: found=false  reason=refusing to route to 555: The Forest Shrine — acid gas puzzle…
```

Every destination the fleet is blocked on sits behind room 555, The Forest Shrine, which the map
model refuses to route through because it kills the character outright. The model is correct to
refuse. `556 -> 555` is not a missing edge either — that is the guard declining to walk a character
into the room it is standing next to.

The defect is that nothing upstream distinguishes **"no route"** from **"no safe route"**. The
decider reads `no-route` as `stuck`, chooses a different goal, and asks again fifteen seconds later —
20,173 times in t4's log. It is retrying a route that would kill the character, forever, and
reporting the refusal as a movement failure. That is also why `armed -> buy` says *"smith unreachable
recently; hunting unarmed"*: the smith is in 1013, and 1013 is on the far side of a room that kills
them.

So the chain that explains the fleet standing still is:

1. the characters want the smith in room 1013;
2. the only graph path crosses room 555, which kills them outright;
3. `findPath` correctly refuses;
4. the decider cannot tell a safety refusal from a missing edge, so it treats it as being stuck;
5. it re-asks every 15 s, having never once considered that the destination is unreachable on purpose.

**None of this is locomotion.** The mover is never given a destination, which is why every
sends-per-square figure in this document describes a character that is not representative of the
fleet: the only ones that moved are the ones whose destination happened not to require the Shrine.

The fix is not in this document's scope. It is a distinct reason code for a safety refusal, and a
decider that stops asking instead of retrying — which is a different goal, and is recorded here so
the next person does not spend a day on the mover first.

## The size cost, stated rather than left to be discovered

| | mover | route | total |
|---|---|---|---|
| baseline at the start of this goal (`90643c9`) | 1,765 | 923 | **2,688** |
| now | 2,534 | 944 | **3,478** |

**+790 lines, a 29% increase**, against a goal whose predecessor had brought the same pair down from
2,948. The objective said restoring the engine may legitimately raise the figure but that the
increase must be said honestly instead of hidden, so here is where it went, measured from the diff
rather than remembered:

```
added lines: 843
  comment-only : 592      (70%)
  code + comment on the same line: 6
  code only    : 245      (29%)
deleted      :  50
```

**Seventy percent of the growth is prose.** The code grew 245 lines net of 50 deletions; the
explanation grew 592. That is a deliberate trade this session made — after the argument-order bug
proved that 17 assertions could pass while asserting nothing, and after four confident readings of
the same log each turned out to be an artefact of the instrument, the reasoning behind each
movement decision got written down at the decision — and it has a cost that belongs in a diffstat
rather than in a defence.

Two things follow, and neither is flattering:

- **The prose is load-bearing only if it is read.** It is 592 lines of which roughly 300 are
  retracted positions kept so the next reader does not re-derive them. A document that carries its
  own wrong turns grows monotonically; that is the price of not repeating them, and it is why this
  section exists separately from the narrative.
- **The 245 lines of code are not all engine.** `tickLogged`, `noteGround`, `groundRate`,
  `noteSend`/`_corroborate`/`corroboration`, `seedAnchor` and `logName` are instrumentation, added
  because every number this session printed was wrong until the instrument that produced it was
  fixed. The stride engine itself is not what made the file bigger.

If the pair has to come back down, the retracted narrative is the first place to look and the
instrumentation is the last.

## The destination-churn ratio, which was the goal's own done-criterion

The objective asked for t3 and t4 in game with destination changes and sends in a sane ratio,
compared against the original pathology in `keeper-t1.log` (13,619 destination changes against
244,021 sends, 0.0558 dests per send). Measured in the current session, from lines that carry a
name the code can be trusted to have set correctly:

| | destination changes | packets | dests per send |
|---|---|---|---|
| t2 | 1 | 270 | **0.0037** |
| t1, t3, t4, t5 | 0 | 0 | n/a — never asked to move |

t2's ratio is **fifteen times better than the pathology**, and one destination change over 270
packets is what a route that is walked rather than re-litigated looks like.

## A measurement I had to throw away, and why it matters more than the one above

Before that, the same measurement over the whole `keeper-t2.log` gave:

```
destination changes:            6,496
aim returns to where it was two changes ago: 2,332   (35.9%)
most-visited destinations: (3,58) 889 times, (3,57) 882 times
```

which reads as a two-square oscillation surviving every fix, at twelve times the pathology ratio.
It is none of those things. The lines behind it say:

```
[movedbg] t4 to() -> 3,58 (was 15,66) by=router
[movedbg] t4 to() -> 3,58 (was 12,66) by=router
[movedbg] t4 to() -> 3,58 (was 25,64) by=router
[movedbg] t4 to() -> 3,58 (was 33,29) by=router
```

**in `keeper-t2.log`.** The name was baked into the format string, so all five characters wrote
`t4` into whichever file the broker was tailing, and the `was` values are squares 15, 12, 25, 19 and
33 columns apart — five different characters aiming at the same square, not one character flipping
between two. The oscillation was an artefact of the mislabelling, and the fix that made it visible
is the `logName` change made an hour earlier for what looked like a cosmetic reason.

The general rule, which this session violated repeatedly: **a log whose lines do not say who wrote
them cannot support a claim about a character.** Whole-file counts across a log that spans builds
and characters are not measurements of anything, and the counts that looked worst — 6,496 changes,
35.9% oscillation, 20,173 no-routes — need the session boundary and the name applied before they
mean what they appear to mean.

## The blink was never the escape — it was the thing being cancelled

For most of this session t2 stood at square (12,18) in the Brownestone Inn with the escape fan
reporting `all 8 raw moves refused, casting blink` 105 times and one position change to show for
it. The reading offered at the time — that the geometry refused all eight directions — was wrong,
and the live event stream says why.

**The server tells you how a cast ended, in words, and the harness was throwing it away.**
`m59-game.mjs` routes `ev.kind === 'message'` to banker lines, combat lines and loyalty warnings
and discards everything else. The four lines that matter here:

| the server says | what it means | what to do |
|---|---|---|
| `You focus your whole will on casting blink.` | accepted; concentration has begun | hold still |
| `Your concentration is broken and the blink spell fizzles.` | **we moved during the cast** | stop moving |
| `You find yourself realigned with your surroundings.` | it worked | replan from the new position |
| `You don't have enough mana to cast blink!` | **refused before it began** | stop casting |

The fourth is the one the fleet actually produces, and it is on essentially every recording in
`substrate/recordings/t2-*.jsonl`. It is also the reason the three supplied lines almost never
appeared: the cast was rejected for mana before a concentration window ever opened.

### The defect that cancelled the spell, in order

```
t=0      _tryBlink(): submit('stand'), schedule the cast for t+2000
         returns { state:'blink' } — but _blinkPending is STILL FALSE
t=0..2s  the mover ticks every 0.30s (measured, n=695). SIX ticks run with no hold,
         and each one is free to send an escape-fan move packet.
t=2s     the cast goes out, and _blinkPending = true. Too late by six ticks.
```

The hold that protects a concentration spell was armed *after* the window it needed to protect.
Compounding it, the cast was submitted under pacer kind `'blink'`, and the priority list is
`kind === 'attack' || kind === 'cast'` (`m59-game.mjs:526`) — so the cast queued **behind** the
move packets. The `1500` third argument is `minGapForKind`, a rate limit and not a staleness
deadline, and was delaying our own cast by a further 1.5 s.

### What it looks like now, live

```
[tick-state] t3 state=blink        why=all 8 raw moves refused, casting blink
[tick-state] t3 state=blinked      why=blink confirmed by server text (9586ms)
[tick-state] t3 state=blink-refused why=blink refused: not enough mana (server said so)
```

Both outcomes are now named, and the mover stops holding on the second one instead of waiting out
a 20 s backstop for a spell the server had already rejected.

### The test-suite finding, which matters more than the blink

`m59-mover-test.mjs` declared

```js
const clock = (ms) => { CLOCK_MS += ms; };
```

a mutator returning `undefined`, and **seven call sites assigned its result into a timestamp**:
`mover._blinkAt = clock()` wrote `NaN`. `Date.now() - NaN > 20000` is false, so the blink backstop
could not fire inside a test however far the rig advanced. This is the same family as the
argument-order bug found earlier today: a helper whose contract is violated at the call site, in a
way that cannot raise an error and shows up as a test that passes.

And two of the assertions written *while writing these very tests* were themselves vacuous:

* `sent.filter(...).length <= before - before + sent.filter(...).length` reduces to `x <= x`.
* `m59-cast-test.mjs` had **no refusal test at all** — proven by deleting the refusal line from
  `CAST_LINES` and watching all 53 assertions pass anyway. Rewritten: the same deletion now fails 8.

A test that cannot fail is not a test, and this session has now demonstrated that three separate
ways.

## The fleet is in the world again, and what that does and does not prove

After the cast fix, Kage (t2) walked out of the Brownestone Inn — where it had stood at square
(12,18) for seventy minutes with `ground=0.0sq` — and travelled to West Jasper, room 382, then
headed for hunting room 547.

```
t2  ground=177.0sq/619s   8 room transitions   213 sends
    MEDIAN MOVING RATE  0.84 squares/s = 34% of the client's walk
    sends by site: 105 stride-declaration, 53 raw-move-push, 24 no-path-stride,
                   16 escape-fan-probe, 11 walk-past-boundary, 3 send-waypoint-helper, 1 waypoint-step
t3  MEDIAN MOVING RATE  0.17 squares/s
```

**`stride-declaration` is now the largest send site**, which is the first time in this project
that the velocity engine is the thing actually moving a character rather than being outvoted by
the escape machinery.

What this does **not** establish, stated before anyone builds on it:

- **0.84 sq/s is not 2.5 sq/s.** It is 34% of the client's walk. The stride engine was measured
  earlier at 2.00 squares per packet against the step engine's 1.00 on identical geometry, so the
  per-packet claim holds; the end-to-end rate is lower for reasons not yet isolated — room
  transitions, escape detours, and the decider stopping to rest all divide it down.
- **A room change is not a rate measurement.** `trans=8` is counted deliberately *out* of the
  ground accumulator, because a teleport-sized jump would otherwise read as a stride.
- **The earlier "0.00 sq/s for 70 minutes" was not a locomotion result at all.** It was a
  character with no destination, then a character holding 20 s at a time on a blink the server had
  refused for mana. Two different causes, both outside the mover, and both were found by reading
  the instrument rather than the movement code.

## A void in room3d, and the investigation that produced five wrong answers before one right one

Reported from the client: Kage is standing in a void in *The Sweet Grass Prairies* (557, `e7.roo`)
and it renders strangely. The question — does the harness think a square is walkable that the BSP
has no floor under? — is a good one and is still open. What this section records is the answer I
produced for it, because **it was wrong and the way it was wrong is the lesson.**

The claim I reached, with numbers:

```
room 557 e7.roo: coarse grid says walkable, BSP has NO floor : 967 squares
                 both agree walkable                         : 276
MEDIAN across 40 rooms: 78.9% of coarse-walkable squares have no BSP floor
room 5 cave3.roo: leafAtClient finds NOTHING anywhere in a +-4992 scan
=> "standable() short-circuits on walkable(); the BSP is never consulted"
```

Every number in that block is an artefact of **my** coordinate conversion. The trace at the
coordinate the mover actually passes says:

```
traceFineMoveClient(28160, 37376, ...) -> { blocked: false, arrived: true }
```

**There is floor under Kage.** The scan fed the trace `col * 64 + 32` = 1824, where the mover feeds
`protocolToClient(1824)` = **28160** — 26,336 units away, which is outside the room entirely. Of
course a scan outside the room finds no leaves: it finds none in *any* room, which is exactly the
"100% of rooms have no floor" result I reported. A result that identical across unrelated rooms is
a property of the instrument, and that should have stopped me at the second room, not the fifth.

The five wrong inferences, in order, each of which I stated as a finding:

1. "the .roo is the wrong size — `grid=3268` but the room is 2450 squares" — `grid` is a **base64
   string**; decoded it is 2450 bytes, exactly right.
2. "3268 is not a rectangle, so the grid is corrupt" — same cause; it is not an array at all.
3. "the tiles vary 0%–100%, so the baked collision is unusable" — my filter matched on a key
   (`roo.sectors`) the baked artifact does not use, so it silently measured nothing.
4. "my loop walked off a 78x75 room into a 90x65 range" — true, and I said so, then made the same
   category of error twice more.
5. "`standable()` short-circuits on the coarse grid and never consults the BSP" — **this one is a
   real reading of the source** (`m59-roo.mjs:1697` really does `if (this.walkable(...)) return
   true;` first), but the *evidence* I offered for its consequences was entirely the bad scan. The
   short-circuit exists; how much it actually matters is unmeasured.

What survives, and is worth keeping:

- **The server is the authority on where a character can stand.** Kage is alive at 27/27 HP in the
  square in question and walked there under its own power. Whatever `e7.roo`'s BSP does or does not
  contain, the server placed the character there and honours it.
- **`_occupiable` samples a 5x5 lattice; my scan sampled one point per square.** Those are different
  questions, and only the first is what `standable()` answers.
- **The open question is genuinely open**: whether the room3d void is (a) a real gap in `e7.roo`'s
  BSP that the coarse grid papers over, or (b) a rendering issue in room3d, or (c) the
  centre-vs-lattice sampling difference. Answering it needs a scan in the **mover's frame** —
  `protocolToClient(col*64+32)` — and a comparison against what room3d draws, not against a
  coordinate I invented.

The rule this turn earned: **when a measurement returns the same extreme value across unrelated
inputs, the bug is in the measurement.** Check the units before believing the number, and check
them against the call site rather than against the variable's name.

---

## 2026-09-08 — THE GOAL'S PREMISE IS FALSE, AND THE SERVER'S OWN SOURCE SAYS SO

**Read the move handler. It is not in C. It is kod, and it is the authority on this question.**

`blakserv/game.c:524` dispatches every in-game packet through a `default:` branch to
`ClientToBlakodUser`, which is a generic parameter-table interpreter (`parsecli.c`). The handler for
`BP_REQ_MOVE` is `kod/object/active/holder/nomoveon/battler/player/user.kod:895`, which reduces our
fine coordinates to a square and calls `@UserMove` (`user.kod:2907`).

`@UserMove` opens with this, verbatim:

```
% Speedhack works by sending a LOT of little moves very, very quickly.
% Normal players only send 1 movement packet per second, but
% speedhackers send more.  Even at low levels, speedhackers will send
% more packets per second.  So, we keep track of the number of packets
% sent and the number of seconds that happen.  Every movement packet
% sent increases our piMovesCounter by one.  Every second that passes
% decreases it by one.
```

and then:

```
piMovesCounter = (piMovesCounter + 1) - iDelta;
piMovesCounter = bound(piMovesCounter, -MOVEMENT_DELTA_LAG_THRESHOLD, $);
if piMovesCounter > MOVEMENT_COUNT_THRESHOLD   -> "is moving too fast. Has moves count of ... Possible speedhacker."
```

with `MOVEMENT_COUNT_THRESHOLD = 2` (user.kod:61) and `USER_WALKING_SPEED = 18` (user.kod:46).

### What this means for the goal

**One move packet per second is not a limitation we failed to fix. It is the server's contract for a
legitimate player, and sending faster is what the server calls a speedhack.** Our
`USER_MOVE_MIN_INTERVAL_MS = 1050` is not a bug, and neither is the reference client's
`MOVE_INTERVAL = 1000`.

The goal's premise — that the velocity engine would move the fleet at the real client's rate, and
that the rate would be above the step engine's — is false. **Both engines are capped at one packet
per second by the server, so the only thing either can change is ground covered *per packet*.**
That is a smaller and different objective than the one I was given, and it should be stated as such
rather than quietly reinterpreted.

### The measurement that agrees, from a source that is not us

A server-driven monster involves no client, no prediction and no rate limiter. Measured per object
id, in game, with `M59_WATCH_MONSTERS=1`:

| monster | packets | moving | gap between moving packets | ground per moving packet | squares/s |
|---|---|---|---|---|---|
| spider | 224 | 111 | 1048 ms | 1.16 squares | 1.05 |
| spider | 178 | 88 | 1051 ms | 1.25 squares | 1.05 |
| centipede | 45 | 9 | 4109 ms | 1.00 squares | 0.25 |

**The server moves its own monsters at ~1 square per second, one square per packet, on a ~1s cadence.**
Ours is 0.96 squares/s at 0.97 squares per packet. We are at the speed the server itself uses.

### Corrections to claims made earlier today

- **"Neither server walkability function is on a movement path"** — wrong in a way that matters.
  `CanMoveInRoom`/`CanMoveInRoomFine` are kod primitives, and kod *is* the movement path: the server's
  game logic is kod, not C. Their only in-tree kod caller is `LineOfSight`
  (`kod/object/active/holder/room.kod:2108,2115`), which is why grepping C alone looked conclusive.
  Grepping C alone was the error.
- **`clientd3d` cannot settle anything about the real client**: `messages.h` exists with no
  `messages.c`, and the tree has no `BF_POS_X` and no `MESSAGE_OBJ` handler.
- **My first monster measurement was garbage and I reported it before checking it.** Keying the
  stream by monster *name* interleaved every spider in the room, which produced "16.15 squares/second",
  346 teleport-jumps, and a monster at `col 53` in a room 21 squares wide. Keyed by object id it gives
  1.05. The instrumentation now carries `id=` and the reason is a comment in `m59-client.mjs`.
- **`x` in a move packet is fine units with `FINENESS` per square** and `col = x/FINENESS` — the two
  agree in 1,267 of 1,267 packets. The `16 squares/s` reading came from dividing by 64 instead.

### Open, and it is the only live question now

`MOVEMENT_COUNT_THRESHOLD = 2` bounds *packets per second*. It says nothing about *distance per
packet*, which is what the stride engine actually changes. The remaining question is whether the
server accepts a declared position more than one square away — and the earlier live evidence says it
sometimes does not (`declare (1783,1257) ground=320 stopped=clear` with `srvXY` unmoving), which is
what the supercover fix was for. That, and not the packet rate, is where the remaining ground is.

---

## 2026-09-08 (later) — the range question, answered by asking the server instead of reading source

**You were right and my conclusion was wrong, though the reasoning that got me there was also wrong.
The measurement that settles it is a probe, not a source read.**

### The measurement

`tools/m59-range-probe.mjs` (new) declares a position N squares away in each of eight directions and
asks the server where it actually put us, settling by re-reading until the position is stationary
rather than by guessing a duration. Run on t4 (Lee), room 106 Brownestone Inn, an agent whose mover
was idle so nothing else was driving the character:

| declared | tries | arrived | moved | median ground | max ground |
|---|---|---|---|---|---|
| 1 | 24 | 24 | 24 | 1.41 | 1.41 |
| 2 | 18 | 18 | 18 | 2.00 | 2.83 |
| 3 | 18 | 18 | 18 | 3.00 | 4.24 |
| 4 | 18 | 18 | 18 | 4.00 | 5.66 |
| 5 | 18 | 18 | 18 | 5.00 | 7.07 |

**142 declarations, 142 arrived, zero refusals.** Declared 5 squares, went 5.00 squares, every time —
including 7.07 on diagonals. A 21x20 room is why 6+ was never attempted, not a refusal; the probe
skips out-of-bounds targets silently and that gap looked like a ceiling.

**So the server carries a player five squares in one packet, and the fleet's rate is not capped by
distance per packet at anything near our current stride.** The mover's 320-unit (5-square) stride is
the right shape. The step engine's one square per packet is a self-imposed limit, exactly as you said.

### What the source does say, correctly this time

`@UserMove` (`kod/.../player/user.kod:2907`) caps **packets** per second, not distance. The distance
check at ~:3050 computes `iSquaredDistance` and at `>= 200` (about 14 squares) with `iDelta < 3`
**only writes a Debug line and drains vigor — it never returns FALSE.** `UtilGoToSquare`
(`kod/util.kod:109`) short-circuits the room's walkability veto for a player's own move
(`if IsClass(what,&User) OR ...`), and `UtilGoNearSquare` spirals outward from the declared square
up to `max_distance = 50000`. So a far declaration is not vetoed on geometry, and an illegal one
lands nearby rather than failing.

My earlier claim that the goal's premise was false because one-packet-per-second caps the rate was
**wrong in its conclusion**: it correctly rules out sending *more often* and incorrectly implied that
was the end of it. Ground per packet is the lever, and it is worth roughly 5x.

### Corrected: the speed-36 snap-back is real but was not firing

`speed > USER_WALKING_SPEED (18)` with `GetVigor < VIGOR_RUN_THRESHOLD (10)` makes the server put the
player back on their own square and log "was running with no vigor". The mover sends `runNow ? 36 : 18`
at the `no-path-stride` site, so this is a live hazard — but t3 was at `vigor=62`, so it was not the
cause of the frozen stride. It is still a reason to never run below 10 vigor, and the mover should not
choose speed 36 without checking vigor first.

### The frozen stride on t3 is NOT explained by any of the above

```
site=no-path-stride at=3174,328 aim=1952,160 from=3491,372 srv=3491,372   (3,339 sends)
```

Eliminated, each with evidence: **range** (5 squares lands 142/142), **geometry** (squares 54,5 through
49,5 in room 556 are all `coarse=true fine=true stand=true bspFloor=true`), **posture** (the only
`sitting` lines are seven hours earlier), **speed/vigor** (vigor=62, threshold 10).

Two mistakes of mine in that investigation worth recording because they are the recurring kind: I
called `col 54` out of bounds in room 556 without looking the size up — it is **63x55** — and I read
the 44-square "move" in the first probe run as a teleport when the probe was driving **t3, whose
keeper was also connected**: one connection per character, so the probe bumped the keeper and the
broker was rejoining it. The probe now records `room_before`/`room_after` so a transition cannot be
mistaken for a move.

### The bound on this investigation, and it matters

**The fleet is not playing a local server.** The roster points at `76.214.42.186:5959`, the Docker
daemon is down, and there is no `blakserv` process on this machine. So:

- The server's own log — which writes an `ALERT!` line for every refusal — is **not readable from
  here**, and it is the only direct evidence of why a specific move is refused.
- Every statement above about *why* the server refuses is inference from the source tree, and the
  live shard may not be built from it.

The remaining question on t3 needs either the server log or an in-game experiment on a character
nobody else is driving.

---

## 2026-09-08 (later still) — the 20% that was left was a waypoint, not a wall

The race in the section above put the velocity engine at 1.75 squares/second against the step
engine's 0.92, and called it a 1.90x win. It was a win. It was also **leaving a fifth of the walk
on the table for a reason that had nothing to do with the engine**, and it took being asked "can it
hit 2.5 on flat empty ground?" to go and look.

### The deficit was waypoint quantisation

`_routeAhead` had to return **a waypoint**. The planner emits waypoints one square apart (64 fine
units), and the walk stride budget is 160 units — 2.5 squares. The furthest waypoint inside a
160-unit budget is the one at 128 units. So every packet spent 128 and threw away 32, and on the
flattest, emptiest ground there is — the case with no terrain excuse available at all — the mover
declared **2.00 squares where it was allowed 2.50**.

The reference client does not have this problem and cannot have it: `move.c:266 UserMovePlayer`
integrates a *heading* for the interval and `move.c:764 MoveUpdatePosition` reports where it
actually got to. It never aims at a waypoint. The waypoints are a planning artefact we invented and
were then paying rent on, at 20% of the fleet's speed.

### Three versions of the fix, two of them wrong, all three caught by tests

The fix is to extend the aim down the same heading by whatever the budget still allows and let
`_integrateToward` stop at the wall — aim further, which is the shape the code already had, rather
than clamp at the send site, which is the shape that produced the original 790-send freeze.

1. **Extend unconditionally.** Failed three tests at once: the mover walked straight at the wall
   segment it had just routed around, and in the corner fixture it sailed east past the waypoint
   where the route turns north. Extending past a *turn* leaves the route.
2. **Extend only on the final waypoint of the route.** Passed every test and bought nothing: the
   planner emits one waypoint per square, so on a 30-square road the last waypoint arrives on hop
   30. Measured 1.75 again, unchanged. A guard that only permits the last hop of a straight road is
   not a guard, it is a disabled feature — and it is the kind of "fix" that survives review because
   the suite is green and the number never moves.
3. **Extend past a straight continuation only** — decided geometrically, by the cosine of the turn
   at the waypoint (`> 0.5`, i.e. a heading change under 60 degrees), so collinear grid waypoints
   extend freely and a corner stops the extension dead. Plus two clamps, each from a failure:
   never past the destination (the first version overshot on a short hop, the next tick came back,
   and a monotonicity test caught the round trip at 736 units of ground sent for 416 units of
   ground made), and only over ground `traceFineMoveClient` vouches for, because the loop traced
   the line *to* the waypoint and never past it.

`pathIdx` is now advanced **after** the aim is final. Spending waypoints while the aim was still in
question charged the route for ground we had already decided to refuse.

### The number

`node tools/m59-engine-race.mjs` — 30 squares of open ground, virtual clock, identical geometry,
one engine per run:

| engine | packets | ground | time | sq/s | % of client walk |
|---|---|---|---|---|---|
| step | 30 | 29.0 sq | 31.5 s | 0.92 | 37% |
| velocity | **12** | 27.5 sq | **12.6 s** | **2.18** | **87%** |

**2.37x the step engine, and 87% of the official walk rate.** The per-packet log confirms the
mechanism rather than the outcome: `ground=160` on every packet, the full stride, where it read
`ground=128` before.

The ceiling is 2.38 sq/s — 160 units per 1050 ms send — so 87% is 95% of what our own cadence
allows. The remaining 5% is the destination clamp on the final hop, which is correct behaviour:
1856 units of road at 160 per packet is 11 full strides plus a 96-unit remainder.

We do not reach 2.50 and should not try. The client moves at 2.5 squares/second because it sends
every 1000 ms; we send every 1050 ms because `MOVEMENT_COUNT_THRESHOLD = 2` makes anything faster a
speedhack, and the server's own monster locomotion runs at 1.05 squares/second on a one-second
cadence. The gap to 2.5 is the 50 ms, and buying it back would mean breaking the rate contract for
two ticks an hour.

### What this does *not* claim

This is a measurement of the **engine on synthetic ground**. It is not a claim that the fleet is
now walking at 2.18 squares/second: the fleet's point-to-point median walk was 46%/27%/18% of the
client's, and that deficit is *routing and decision-making* — characters being given destinations
they cannot reach, resting, fighting — not stride length. The stride fix removes one term from that
deficit. It does not remove the others, and the fleet will not get 87% of the client's speed until
the decider stops handing the mover unreachable destinations.

---

## 2026-09-08 (later still) — and the number above was the wrong gait against the wrong denominator

Asked "can we get to run speed?", I went to measure it and found `policy: { allowRun: false }`
hardcoded on line 74 of `m59-engine-race.mjs` — the only harness in this repository that prints a
squares-per-second number.

### The harness was pinning the gait the fleet opts out of

`m59-mover-preFix.mjs:102` documents the mover's rule in words: **"RUN IS THE DEFAULT
(`policy.allowRun === false` opts out)"**. So every figure that harness ever printed, including the
2.18 sq/s and the "87% of the client" in the section directly above, is a **WALK-mode** number for a
fleet that **runs**. The section above is not wrong; it is a walk-mode measurement that was labelled
as if it were the speed of the thing.

### The denominator was off by a factor of two in the same direction

The client's rates are `move.c:184` (`2 * MOVEUNITS`, the fast actions) against `move.c:188`
(`MOVEUNITS`, everything else), with `draw3d.h:53` `MOVEUNITS = FINENESS >> 2 = 64`, scaled by
`dt / MOVE_DELAY` (100 ms) at `move.c:216`:

| gait | units per 100 ms | squares/second |
|---|---|---|
| walk | 64 | **2.5** |
| run | 128 | **5.0** |

"The client's walk rate" and "the client's speed" are **a factor of two apart**, and the `%` column
divided by 2.5 unconditionally, whatever gait had been run. Any percentage in this document quoted
against "the client" without naming the gait is suspect for exactly that reason.

### Both gaits, measured

| gait | engine | packets | time | sq/s | % of that gait's client rate |
|---|---|---|---|---|---|
| walk | step | 30 | 31.5 s | 0.92 | 37% of 2.5 |
| walk | velocity | 12 | 12.6 s | 2.18 | 87% of 2.5 |
| run | step | 30 | 31.5 s | 0.92 | 18% of 5.0 |
| run | **velocity** | **6** | **6.3 s** | **3.97** | **79% of 5.0** |

`velocity / step = 4.31x` in run mode. The per-packet log shows `ground=320 stride=320 run=true`, so
the full 5-square stride is being declared.

### The ceiling, which is the actual answer

One packet per 1050 ms is the rate contract, so the fastest legal locomotion is `stride / 64 / 1.05`:

| gait | stride | ceiling | % of client that is | we are at |
|---|---|---|---|---|
| walk | 160 u = 2.5 sq | 2.38 sq/s | 95% of walk | 92% of ceiling |
| run | 320 u = 5.0 sq | 4.76 sq/s | 95% of run | **83% of ceiling** |

**We cannot legally close the rest.** The client reaches 5.0 because it reports every 1000 ms; we
are bound to 1050 ms by `MOVEMENT_COUNT_THRESHOLD = 2`, and the entire remaining gap is that 50 ms.
Spending it would mean moving faster than a legitimate player is permitted to, which is the same
class of thing as the 320-unit-into-a-wall declarations that started this whole investigation.

### Is the fleet actually in run mode? Checked, not assumed

`RUN_VIGOR_FLOOR = 25`. Across **6,164** logged vigor samples in `substrate/keeper-t1.log`: median 60,
max 200, and **zero samples below the floor**. The fleet runs continuously. It is not walking with the
option switched off, so the run-mode number is the one that describes it.

### The near miss that nearly hid this

The mover suite's rig sets **no `policy` object at all**, so all 183 assertions run in the default
**run** gait while the race was measuring **walk**. Two suites were measuring different gaits under
one name, and a suite comment at `m59-mover-test.mjs:509` — "No `policy.ownPhysics` — the default
step model" — describes a test that is in fact running at the 320-unit run stride, because the gait
flag is `allowRun` and its default is run. A flag whose default is the interesting value, read with
`!== false`, means "nobody set it" and "everybody wants it" are indistinguishable in the logs.



---

## 2026-09-08 (later still) — the 50 milliseconds were folklore, and spending them closed the gap

The section above says the ceiling is 4.76 sq/s and that "we cannot legally close the rest",
attributing the gap to `MOVEMENT_COUNT_THRESHOLD = 2`. **That was wrong, and it was wrong in the way
that matters most: it presented a number nobody had a reason for as a limit nobody could cross.**

### What the threshold actually says

`user.kod:2937` and `:2942`:

```
piMovesCounter = bound((piMovesCounter + 1) - iDelta, -MOVEMENT_DELTA_LAG_THRESHOLD, $)
if piMovesCounter > MOVEMENT_COUNT_THRESHOLD  ->  Debug("ALERT! ... Possible speedhacker.")
```

`iDelta` is the **whole seconds** since the previous packet. At a 1000 ms cadence it is 1 for every
packet, so the counter is `(c + 1) - 1 = c` and **rests at zero forever**. Tripping the ALERT needs
`c > 2`, which needs **three** packets inside one server second. A 1000 ms cadence with sub-second
jitter produces two, not three.

The 50 ms bought nothing. It cost 4.8% of our locomotion, and no comment, document, or commit in
this repository gave a reason for it beyond "the speedhack law".

### The number was described as the client's when it was ours

`m59-engine-race.mjs` had `const TICK_MS = 1050;` commented **"USER_MOVE_MIN_INTERVAL_MS — the
client's own MOVE_INTERVAL"**. The client's `MOVE_INTERVAL` is **1000** (`move.c:57`). 1050 was our
invention, labelled as the client's, and because the race drives a virtual clock from that literal
while building its mover with `moveCapMs: 0`, **every speed figure that harness ever printed was
clocked at a cadence it claimed was the client's and was not.**

There were also two independent `1050` literals in the mover — the constructor default and the
`_claimMoveSlot` fallback — so a mover built with the option and one built without it could have had
different cadences in silence. One exported `MOVE_CAP_MS` now, imported by the race, so the engine
and the measurement cannot disagree.

### Measured, at the client's own cadence

30 squares of open ground, virtual clock, identical geometry:

| gait | step engine | velocity engine | client | ceiling now |
|---|---|---|---|---|
| walk | 0.97 (39%) | **2.29 sq/s** = 92% | 2.5 | 2.50 = **100%** of client |
| run | 0.97 (19%) | **4.17 sq/s** = 83% | 5.0 | 5.00 = **100%** of client |

The ceiling is no longer 95% of the client. At equal cadence and equal stride the rates are equal
**by construction** — 5 squares per packet both. What remains (8% in each gait) is the destination
clamp on the final hop, which is correct behaviour: 1856 units of road at 320 per packet is 5 full
strides plus a 256-unit remainder.

### Three bugs of mine, found while doing this

1. **I deleted a line that was doing two jobs.** The test block had `mover._moveCapMs = 1050` with
   the comment "live cap". It was pinning a value *and* enabling the mechanism, because the rig
   defaults to `moveCapMs: 0` = uncapped. Removing it with the number switched the cap off and two
   assertions failed for a genuine reason. A line whose comment names only one of its two effects.

2. **`(g === 'run' ? vel.rate : vel.rate)`** — both branches identical. The report printed the *run*
   rate under the *walk* heading and announced "167% of that ceiling" as though it had found
   something. The over-100% guard added minutes earlier is what caught it, which is the only reason
   this is a footnote rather than a published lie. A ternary whose branches agree is not a condition.

3. **`cadence_report()` had a field named `sends` that counted gaps.** The first accepted submit
   records no gap, so it is always one fewer than the number of submits. An assertion read it as
   sends and was right to fail. Both counts are reported now, because "looks like it lost a send" is
   the one thing this evidence must never suggest.

### Why this is still not a speedhack

The server caps **no distance at all**. `user.kod:3064` detects a squared row/col displacement of
`>= 200` and only writes a log line and drains vigor — line 3099 sends `SomethingMoved`
unconditionally afterwards. We *could* declare 14 squares a second and the server would move us.

We declare 5 because 5 squares is what one second of the client's locomotion actually produces. The
client's number is a **measurement of a walk that happened**; ours is now the same distance over the
same interval, which is the same thing. Matching the client means matching its rate, not exploiting
the absence of a cap — and the difference is not philosophical, it is the difference between a rate
a player could have and a rate no player could have.

### The risk accepted, stated out loud

The margin is **one packet**. Three position submits inside one server second draws an ALERT — a log
line naming the character, not a ban and not a refused move, and the same line a legitimate player on
a laggy connection can draw, which is why the server tolerates a counter of 2 and decays it by
elapsed time.

`cadence_report()` exists so this is a measured risk rather than an assumed one. Our log lines have
never carried a timestamp, so the inter-packet gap has never been recorded anywhere in the history of
this project; the histogram is the first evidence, and it needs a day of live running before anyone
should treat "the margin is fine" as established rather than as a hypothesis with a counter attached.

---

## 2026-09-08 (later still) — there was no 8% left. The harness was eating the first packet

Asked to "provide the correct distance to hit max speed", I went to find the missing distance and
there wasn't one. **The engine is at the client's speed in both gaits.** The 8% deficit reported two
sections ago was an off-by-one in the measurement.

### The bug

```js
for (let i = 1; i < sent.length; i++)          // starts at 1
  ground += Math.hypot(sent[i] - sent[i-1]) / KOD;
const sec = arrivedAt / 1000;                   // full elapsed, first interval included
```

Starting the differencing chain at `i = 1` never counts the ground between the character's **starting
position** and the **first declaration** — while the denominator includes that first interval. N
packets of ground divided by N+1 intervals. The first packet of every run was free labour.

The error is one packet's ground: at a 5-square stride over 30 squares, **17% of the total**. It is
not a constant offset either — it scales inversely with road length, so short roads were understated
worst and figures from different lengths were never comparable.

### Measured, correctly, at 1000 ms cadence

| gait | step engine | velocity engine | client | % of client |
|---|---|---|---|---|
| walk | 1.00 (40%) | **2.50 sq/s** | 2.5 | **100%** |
| run | 1.00 (20%) | **5.00 sq/s** | 5.0 | **100%** |

`velocity / step` = 2.50x walking, 5.00x running.

### What this invalidates, and what it does not

The step engine was understated by the **same mechanism** (0.97 → 1.00). So the velocity/step *ratio*
was roughly right throughout — which is precisely why the error survived every check available. A
ratio of two numbers wrong in the same direction looks sound. Every `% of the client` figure this
harness ever printed was low, and every one was cited as evidence we were short of the client's rate.

Corrections to the record in this document: the "87% of the client", "83% of the ceiling" and "92% of
the client walk" figures are all superseded. They were low by one packet's ground.

### Falsified before being believed

I wrote the harness minutes before reading a perfect number off it, so the number got checked. The
rig adopts declared positions without argument (`moveTo` sets `self.x = x`), so it **cannot detect a
server that refuses a 320-unit declaration** — the one thing that would make 5.00 fictional. Checked
against the live shard instead: the range probe declared 1–5 squares per packet at t4 on the real
server and returned **16/16, 12/12, 12/12, 12/12, 12/12** landings at the full declared distance. Five
squares per packet is proven on the live server, not assumed by a rig.

### The answer to the question as asked

"Provide the correct distance to hit max speed" — the distance was already correct.
`RUN_STRIDE_PROTO = 320` protocol units = 5 squares, and the per-packet log shows hops of exactly 320
on **every** packet including the first. We are simultaneously at the packet cap (one per 1000 ms) and
at the distance the client covers in a second. There was no distance left to find.

### The lesson, stated where it can be read twice

`5.00 sq/s` looked **too good to be true**, so it was checked. `4.17 sq/s` looked plausible enough not
to be, and it was wrong. A measurement that flatters the work is the one that needs the adversarial
check, and plausibility is not evidence — it is the feeling that stops people looking.
