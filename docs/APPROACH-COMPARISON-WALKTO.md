
---

# Port status (2026-08-31)

## walkTo — PORTED to main (branch `port/upstream-movement`)

Self-contained. Ported their `walkTo` + `QUEUE_PATIENCE` +
`laneAroundBody` + `lanePastBodies` + `gapAlongLine`. Updated the two
tests to the stricter arrival contract. 1,844 assertions green across
the movement suite. Committed.

Verified the port is on the live path: the tick keeper's default
movement is `Actuator.walk` → `session.walkTo` (the controller is
opt-in via `M59_TICK_CONTROLLER=1`, off by default). So the tick
keeper runs the improved `walkTo` with no other change.

## passFightBack — NOT ported (scoped as a separate follow-up)

Their `passFightBack` ladder stage is **not a drop-in** — it is the tip
of an operator-fight-back subsystem we do not have:

- `passFightBack` method (90 lines)
- watchdog state: `fightBackDue` (4 refs)
- policy field: `fightBackAfterMs` (9 refs, in the broker schema)
- constant: `FIGHT_BACK_STALE_MS` (2 refs)
- helpers: `refuseEngagement` (10 refs), `weaponPriorityNow` (13 refs)

Porting just the method would leave it calling `this.fightBackDue`
(undefined) — a landmine. The correct port is the whole subsystem,
which is a feature, not a seam fix. Left as an explicit follow-up so
it is scoped and reviewed on its own rather than smuggled in behind
the walkTo port.

## The pattern, confirmed by the port

"Take the best of both worlds" for the movement code = take their code
(it is ours-plus-measured-fixes) and update our tests to the stricter
contract it enforces. The walkTo port was exactly that: the mover got
stricter and more capable, and the work was in the test fixtures
(confirmPosition, QUEUE_PATIENCE, laneAroundBody stubs), not in
weakening the code.

---

# CORRECTION (2026-08-31): we over-ported. Their fixes 1-3 are a blindness patch.

The first port took all five of their walkTo fixes. On reflection (and on the
operator's point that "they made it because they are blind mid-function"),
three of the five are **compensation for a blindness our architecture does not
have**, and were reverted.

Their `walkTo` has 39 position reads *inside the function* because in the
blocking keeper, `await walkTo(...)` is the only thing awake while the walk
runs — the function must re-read to learn the body moved. Our tick keeper does
not have that problem: `Actuator.walk` fires `walkTo` and does not await it,
and the tick loop re-senses pushed state every 100ms regardless. A false
"arrived" from dead-reckoning is corrected by the next tick's sensor read,
without `walkTo` having to `confirmPosition` itself.

The five fixes, reclassified:

| Fix | Kind | Ported? |
|---|---|---|
| 1. already-there confirmed | blindness comp (re-read) | **NO** — reverted |
| 2. timed-out-confirm-is-not-a-confirm | blindness comp (re-read) | **NO** — reverted |
| 3. arrived-is-a-fact final confirm | blindness comp (re-read) | **NO** — reverted |
| 4. QUEUE_PATIENCE for players | a policy, not a read | **YES** |
| 5. laneAroundBody corridor thread | a capability, not a read | **YES** |

The corrected port keeps our `walkTo` body and our simpler arrival check
(`const arrived = !!me && me.col === col && me.row === row` — the tick loop
corrects it), and adds only:
- `QUEUE_PATIENCE` — a player blocker buys 6 laps instead of escalating after
  1 (one-square-corridor poisoning fix). `blockerIsPlayer` moved above the
  branch so `patience` can be computed.
- `laneAroundBody` + `lanedPast` — when neither side works, thread past the
  body at a different fine-y inside the same square, tried once per square
  before the square is written off.

Still ported (unchanged, self-contained): `QUEUE_PATIENCE` const,
`Session.laneAroundBody`, `lanePastBodies` + `gapAlongLine` in m59-roo.mjs.

1,844 assertions green. The port is now *for* our architecture rather than a
transplant of theirs: we take the two things that are wins regardless of
driver model, and leave the three that only exist to patch a blindness we do
not have.

---

# blinkOut (theirs) vs. escapePocket (ours) — the mirror image

Applying the same lens, this one resolves the **opposite** way from walkTo.
Ours is better on 3 of 4 dimensions; theirs has one nice-to-have that
depends on a subsystem we don't have.

| Dimension | Ours (escapePocket) | Theirs (blinkOut) | Verdict |
|---|---|---|---|
| **Freeze mechanism** | `loop.freeze(ms)` — a *deadline* (self-thaws; a lost thaw costs at most `ms`) | `loop._frozen = true` — a *boolean* (must be cleared in `finally`) | **Ours.** Their own tick.mjs comment mocks the boolean: "A FREEZE IS A DEADLINE, NEVER A FLAG. A boolean here is how the tick loop came to sit frozen for the life of the process." |
| **Mana check** | checks `mana >= 5` before casting | does not check | **Ours.** Casting blink with <5 mana is a wasted cast the server refuses. |
| **Stand first** | stands before casting (a resting character has `PFLAG_NO_MAGIC`, player.kod:1166 — the cast is refused whole) | does not stand | **Ours.** A resting character cannot cast; standing is required. |
| **`expect`/`arrived`** | reports `relocated` + new position | takes an `expect` square, reports whether it arrived *there* | **Theirs, but only with their strategies system.** `expect` comes from `stuckAnswer.answer.expect` — a *private strategy* that directs the blink to a specific square, with a `settled` callback. We have no strategies system, so `expect` has no caller here; porting it in isolation is dead code. |

## Why this is the mirror image of walkTo

walkTo: their code was ours-plus-measured-fixes, and the "fixes" were mostly
blindness compensation (re-reads) for a blocking model we don't have. Port the
policies/capabilities, skip the re-reads.

blinkOut: **our** code is the more complete one. We already solved the three
things their version gets wrong (deadline-freeze, mana check, stand-first) —
because we built `escapePocket` *for the tick keeper*, where a resting
character and a lost thaw are live failure modes. Their `blinkOut` is the
simpler, earlier version. The one thing they have (`expect`) is real but is the
tip of their private-strategies subsystem, not a drop-in.

## Verdict

**Keep ours. Do not port `blinkOut`.** If we later adopt their private
strategies system, the `expect`/`arrived` param (and the `settled` callback)
come along with it — at which point we add it to `escapePocket` as a small,
self-contained extension. Until then, porting it would be adding a parameter
nothing calls.

## The lens, stated generally

When comparing their code to ours, ask two questions in order:
1. **Does the difference compensate for a limitation of *their* driver model
   (blocking/blind) that ours (tick/real-time) doesn't have?** If so, it's a
   patch for a problem we already solved — skip it (walkTo fixes 1-3).
2. **Is it a policy or capability that wins regardless of driver model?** If
   so, port it (walkTo fixes 4-5).
3. **Is it *our* code that is already the more complete version?** If so, keep
   ours and only take the piece that depends on a subsystem we'd adopt anyway
   (blinkOut `expect`).

The direction is not always "take theirs." The lens tells you which way each
specific difference points.

---

# stuck flag (theirs) vs. stallVerdict (ours) — a genuine complement

This one resolves as **take both, in their right roles** — the cleanest
"best of both worlds" of the three.

## The detection: ours is better (for the tick keeper)

| | Ours (stallVerdict) | Theirs (stuck) |
|---|---|---|
| **Source** | `session._mover.stats` — the mover's `arrived` counter, `moving`, `blockedTicks`, `sideSteps` | `autopilot.stalledSince` — set after **5 idle passes** |
| **Model** | **outcome-based**: has the mover reached *any* waypoint recently? | **pass-based**: did anything happen in the last 5 passes? |
| **Catches a livelock?** | **Yes** — "no waypoint reached in Ns while moving" is exactly the JayB case (231,626 ticks, 938,856 side-steps, arrived ZERO times) | **No** — the passes aren't idle, they're deciding the same impossible action; "5 idle passes" never fires |

Theirs is a **blindness-comp for their driver model**: in the blocking
keeper, a *pass* is the unit of time — the only thing that ticks — so "5 idle
passes" is their way of saying "nothing happened for a while" because their
model has no finer clock. Our tick keeper *has* a finer clock (100ms ticks +
the mover's arrival counter), so we detect by outcome, which is more precise
and model-independent. **Keep our detection.**

## The output shape: theirs is better

| | Ours | Theirs |
|---|---|---|
| **Shape** | `false` \| `'no waypoint reached in Ns (moving=.. blocked=.. sideSteps=..)'` — a sentence | `{ since, seconds, why }` \| `null` — a structured flag |

A structured flag is what a fleet board can render and a watcher can branch
on. Our string is human-readable but not machine-branchable. **Take their
shape.**

## The consumer: theirs is a whole tool we lack

`m59-stuckwatch.mjs` — a watcher that polls the `stuck` flag and acts (shouts
"show me" on the maintenance port, once an hour unless the character got free
first). It is deliberately *outside* the keeper so it cannot throw inside a
pass that must not throw. We don't have this. **Take it** — but it reads the
`stuck` flag, so it needs the structured shape first.

## Verdict: combine them

- **Detection**: keep our `stallVerdict` (outcome-based, catches livelocks).
- **Shape**: change `stallVerdict` to return their structured form —
  `{ since, seconds, why }` instead of a bare string — so a board/watcher can
  branch on it. This is a small, self-contained change to our existing
  function (wrap the string in `{ since: _lastArrivedAt, seconds, why: <the
  sentence> }`).
- **Consumer**: port `m59-stuckwatch.mjs` (it is loopback-guarded, so it is
  safe to add; it only shouts on a test server).

This is the cleanest win of the three: our detection is the better one, their
shape is the better one, and their watcher is a capability we simply don't
have. None of it is a blindness-comp — the structured shape and the watcher
are genuine, model-independent improvements.

## The lens, applied three times

| Candidate | Resolution | Why |
|---|---|---|
| walkTo | take theirs (partially) | theirs = ours + measured fixes; port the policies/capabilities (4-5), skip the blindness re-reads (1-3) |
| blinkOut | keep ours | ours is already the more complete version; their `expect` needs their strategies subsystem |
| stuck flag | **take both, in their right roles** | our detection (outcome) + their shape (structured) + their consumer (stuckwatch) |

The lens does not always point the same way. It points where the evidence is.

---

# Two more candidates through the lens

## Terminal-reason send-gate (theirs m59-movement.mjs) — already ours

We already have `tools/m59-movement.mjs` with `isTerminalMovementReason`, and
`m59-game.mjs` already references `TERMINAL_MOVEMENT_REASONS` (lines 3534,
3541, 6425) and returns `position_outside_room_geometry` as a terminal
reason. **Not a port — already ours.** Nothing to do.

## Exit-anchor fallback (theirs world.mjs) — a genuine win, different subsystem

Their `m59-world.mjs` has a fallback we lack: when the **live flood** cannot
reach an exit anchor the **offline bake** proved walkable (`from_body: true`),
offer the anchor's own crossing square anyway — *unless* the room has a
declared one-way drop jump (`oneWayInHere`), because a fall makes a room
directed and the fallback would send a body to walk at a cliff face for ever.

| Lens question | Answer |
|---|---|
| Blindness-comp for their driver model? | **No.** It is a bake-time fix in `m59-world.mjs` (runs at room load, not during a walk). Nothing to do with blocking vs tick. |
| Do we have the same bug? | **Yes.** We have the anchor *ranking* (witness > anchored > grid_only > steps) but not the *fallback*. If the live flood misses an anchor the bake proved walkable, we don't offer it — the exit vanishes for that character. This is the "346 anchors the bake cannot reach" class. |
| Genuine win? | **Yes.** A capability (offer a proven-walkable exit the live flood missed), not a read, not a blindness-comp. The `oneWayInHere` guard is the safety condition. |
| Self-contained? | **Mostly.** We already have `from_body` (routes.mjs:205), `anchorFor`, `anchorReach`, `edgeCandidatesOf`. We lack `roomHasDeclaredFallJump` (a small helper) and the fallback block itself (~50 lines in world.mjs). |

**Verdict: a genuine port, but a different subsystem** (routing/bake-time, not
movement). It is the right kind of win (capability, not blindness-comp) and
fixes a real bug class (exits vanishing). It is *not* part of the walkTo
movement port — it belongs in a routing/exit-offering pass.

## The lens, applied five times

| Candidate | Resolution | Why |
|---|---|---|
| walkTo | take theirs (partially) | theirs = ours + measured fixes; port policies/capabilities (4-5), skip blindness re-reads (1-3) |
| blinkOut | keep ours | ours already more complete; their `expect` needs their strategies subsystem |
| stuck flag | take both, in their right roles | our detection (outcome) + their shape (structured) + their consumer (stuckwatch) |
| terminal-reason send-gate | already ours | we have m59-movement.mjs + the terminal reasons |
| exit-anchor fallback | genuine win, different subsystem | a capability (offer proven-walkable exits the live flood missed), bake-time, not movement |
