
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
