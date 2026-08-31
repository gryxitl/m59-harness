
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
