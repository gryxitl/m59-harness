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
