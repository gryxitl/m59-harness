# Handoff — picking up the m59 harness

Written 2026-08-29, against `2749319`. For someone joining who has not seen this
repository before. It assumes you have read [`CLAUDE.md`](../CLAUDE.md) — that file is the
briefing and the index, and everything below is the *current situation* rather than a
second copy of it.

Read CLAUDE.md first. Then this. Then the one `docs/` page for whatever you are about to
touch — the table at the top of CLAUDE.md tells you which, and those pages are where the
traps are written down.

---

## 1. What you are actually looking at

An agent plays Meridian 59 as a real character, over the wire, with no game client
involved. Five characters (`t1`–`t5`) run as a "fleet". A **broker** holds the roster and
the sockets; each character gets a **keeper** — a 10Hz decision loop in its own process.

The single most important structural fact, because it is unusual: **the keeper never
awaits.** `evaluate()` reads pushed state, `planFor()` is A* over an in-memory action set,
`intend()` turns the plan's first step into one command, fired and not awaited. A tick that
blocks is a bug, and `m59-tick-test` enforces it. If you find yourself wanting `await` in a
decide path, you have misread the design.

The second: **behaviour is split across three repositories by CLOCK, not by importance.**
Anything that must be right within a second (am I dead, something is hitting me, get out of
the Underworld) lives here and may not be delegated. Minute-scale decisions (what to hunt,
where to go, when to bank) may belong to an attached bot. `docs/m59-boundary.md` argues it;
`m59-unattended-test` (55 assertions) is the guard and should fail the day someone moves a
survival decision out of this repository.

## 2. Getting it running

```bash
node tools/setup.mjs doctor      # read what it says before anything else
node tools/m59-which.mjs         # which fleet, which roster, what the broker holds
node tools/m59-fleets.mjs        # every roster on this machine
```

`m59-which.mjs` exits non-zero on a mismatch. If it does, **stop** — acting on the wrong
fleet is silent and has taken down a live broker before.

```bash
node tools/m59-service.mjs start   --fleet -     # detached, logs to substrate/
node tools/m59-service.mjs status  --fleet -
node tools/m59-service.mjs restart --fleet -
node tools/m59-service.mjs logs    --fleet - --follow
```

`--fleet -` is this checkout's unnamed fleet, which is the one in use. Every keeper runs
inside the broker; stopping it logs everybody out.

**Two environment facts that differ from what CLAUDE.md describes**, because they will
waste your afternoon otherwise:

- The `default` fleet plays against **`76.214.42.186:5959` — a remote server**, not the
  loopback one. Everything that refuses a non-loopback host (`m59-dm.mjs`,
  `m59-testbed.mjs`, `m59-traversal-test`) will refuse, correctly. That is not a bug and
  not something to work around.
- `node tools/m59-core-test.mjs` and `m59-perception-test` are **live** tests. `core-test`
  logs in as a real character, which bumps the broker off it (the 45s rejoin sweep gets it
  back). Do not put them in an "offline suite" loop.

## 3. Where the fleet stands today

Measured 2026-08-29, ~19:00 UTC, from `substrate/history/fleet-2026-08-29.jsonl`:

| | |
|---|---|
| kills / deaths today | **25 / 35** — net negative |
| kills by character | Lee 10, Kage 7, JayB 4, Gountrug 4, **Sasquatch 0** |
| deaths by character | Kage 16, Gountrug 10, Lee 5, JayB 4, **Sasquatch 0** |
| stalls recorded | 40 |
| keeper loops | ~7.4–9.8 Hz, 73–87% of ticks send a command |

**The fleet is losing ground, and movement is why.** Combat decisions are healthy — the
planner is picking fights and executing them. What is broken is getting anywhere. A
representative stall reason from the ledger:

```
no waypoint reached in 595s (moving=5376 blocked=269 sideSteps=14436)
```

Fourteen thousand sidesteps and no arrival, for ten minutes. `idle_rest` — the ladder's
floor — absorbs the largest share of every keeper's ticks, which is the floor doing its job
(nothing stalls silently any more) while nothing productive is available above it.

**Sasquatch (t5) has zero kills and zero deaths.** He is not participating at all. Yesterday
he could not plan a hunt (`exhausted N nodes without finding a plan`). He is the clearest
single thread to pull.

### Two reporting traps

- `substrate/deaths.jsonl` **is stale — last written 2026-08-19.** It belongs to the legacy
  `m59-autopilot.mjs`, which the fleet no longer runs. The live source is the ledger under
  `substrate/history/fleet-<date>.jsonl` (`kind: "died"` / `"killed"`). Any analysis reading
  `deaths.jsonl` is reading a fossil; I did exactly that and drew a wrong conclusion from it.
- Kills come from the ledger, never from a keeper's own tally — `Autopilot.tally.kills` is
  emptied in the constructor and keepers restart roughly once a minute.

## 4. What changed most recently

**Phase 3 of the GOAP repayment** (`4935c17` and the commits around it) — the full argument
is in [`m59-goap-repayment.md`](m59-goap-repayment.md), which is worth reading before
touching the decider.

`_fight` was the last goal with a hand-written handler. It is now an ordinary planned goal:

```
goal  _fight  ->  { '!has_target': true }        the quarry stops existing
plan  adjacent        : attack
      across the room : approach_target -> attack
```

`CombatController` still *executes* — it kept kill recording, the no-route blacklist, the
zap enchantment, re-equipping — but no longer *chooses*. Retreat moved out of it entirely;
`flee_hurt` and `flee_danger` sit above `_fight` in the ladder and always did.

The migration exposed four bugs that the offline tests could not, all the same shape:
**a hand-written handler was silently compensating for something the world state got wrong,
and a planner cannot.** `attack.pre` required `armed` (so a bare-handed character had no
plan at all); `_targetId` was never set on the sticky path (so `approach_target` refused
while `has_target` was true); the ladder had tri-state holes where *no goal matched*.

If you migrate anything else off a handler, the lesson is: **re-read every `pre` on every
action the goal can reach, and sweep the state space the ladder must now cover — do not read
it.** Both of the surprises were in corners two booleans wide.

The ladder is now a **total cover** by construction: the last rung takes no world state at
all. `m59-decide-test` asserts that, and sweeps 4,000 random tri-state worlds. If that test
fails, goal `none` is back and characters will stand still while every instrument reports
a healthy 10Hz loop.

## 4a. The engagement ceiling was off, and is now fixed (2026-08-29)

Worth its own section because it is probably the largest single cause of the death rate
in §3, and because of *how* it came back.

Target selection has two branches — choose a new quarry, or keep the one you have. Both
branches wrote `has_target`, `in_reach` and `target_in_band` **by hand**, and the keeping
branch read a `_threatCeiling` that only the choosing branch ever set. `levelInBand(level,
undefined)` returns `true`, so:

```
tick 1  _targetLevel=50  _threatCeiling=30     target_in_band=false   <- correct
tick 2  _targetLevel=und _threatCeiling=und    target_in_band=TRUE    <- ceiling gone
```

A level-20 character read a level-50 fungus beast as in band on every tick after the
first — which is nearly all of them. The comment on that line described this exact failure
as something it had **fixed** (it replaced a literal `// DEBUG: force in-band to test`) and
named the victim: *"Sasquatch, level 20 with a ceiling of 30, spent 2026-08-27 trading
blows with level-50 fungus beasts and died thirteen times."* The careful-looking
replacement reproduced the bug it documented.

**A one-tick test passes against both versions.** That is why it came back. The regression
test now runs four ticks, and the tick that matters is the second.

The fix is the structural one: the decider chooses a quarry and sets `_targetId`; it no
longer senses. In one place, for both branches, the ceiling and level are resolved and the
three symbols are *asked for* through the producers:

```js
Object.assign(ws, evaluate({ ...ctx, ws }, { only: TARGET_SYMBOLS }));
```

`evaluate(ctx, { only })` is the supported answer to the two-pass problem — the ceiling
needs `armed`, and `target_in_band` needs the ceiling, so the honest order is sense,
choose, re-sense the part choosing unlocked. **Going through the producers is the point.**
A driver that re-derives a symbol keeps a second private copy of the rule, and that is the
entire mechanism of this bug. There are no hand-written target symbols left in the decider.

If you take one habit from this repository, take that one: **a branch that decides is not
also allowed to sense.**

## 5. Open problems, in the order I would take them

1. **Movement.** The sidestep loop above. Roughly 25 of the last 40 commits are attempts at
   this and it is not fixed. Start with `docs/m59-routing.md`, then
   `m59-controller-mover.mjs`. Do not start by changing thresholds.
2. **Sasquatch does nothing.** Zero kills, zero deaths, one stall. Cheapest complete
   diagnosis available.
3. **The `escape_pocket` reconnect loop.** `unwedge` fires a full reconnect; there is an
   in-flight guard but **no cooldown after one completes**, so a character that lands still
   pocketed reconnects again immediately — measured at ~39 reconnects in three minutes per
   character. This is the "a trip that cannot fix the thing that opened it will run for
   ever" failure, and it hammers the server unattended. Needs a backoff.
4. **The three test regressions and the debug leftovers** in §6. None is fixed; all are
   reproduced there with the evidence, so they are cheap to pick up.

## 6. Code review findings (2026-08-29, `4935c17..HEAD`, 40 commits)

`4935c17` claimed the offline suites were green, and they were. Three have regressed since.
None is catastrophic; all are real.

### a. `m59-keeper-goap.mjs` — the goal-skip reset still does not work

`017af5e` added a 30-pass reset for goals skipped after 5 failures, with the comment *"was
documented but never implemented"*. It is still not implemented — **two** bugs, both
verified by direct reproduction:

```js
if (this._goalFailCount[g] >= 5 && (this._passCount - this._goalFailLastPass?.[g] ?? 0) >= 30)
```

1. **Operator precedence.** `??` binds looser than `-`, so this parses as
   `((passCount - lastPass) ?? 0) >= 30`. When `lastPass` is `undefined` the subtraction is
   `NaN`, and `NaN ?? 0` is `NaN` — `??` only replaces `null`/`undefined`, never `NaN`. The
   comparison is `false`. Intended: `(passCount - (lastPass ?? 0)) >= 30`.
2. **The delta can never grow.** The loop immediately below rewrites
   `_goalFailLastPass[g] = this._passCount` for every still-failing goal on *every* pass, so
   the elapsed-pass count resets to zero each pass and never reaches 30.

Simulated over 200 passes: the goal is **never** reset. A goal that fails five times is
still skipped for the lifetime of the keeper process, exactly as before the commit.

This is also why `m59-keeper-goap-test` fails — moving `armed` above `_fight` changed what
an unarmed character that *cannot* arm does (it now rests rather than reporting no plan).
Decide which behaviour you want, then fix the test to match; do not just delete it.

### b. `m59-controller-mover.mjs` — the teleport resync pre-empts the crossing drop

`m59-controller-mover-test`: *"once the room has changed the crossing is dropped"*. The
teleport/divergence correction added by `6a6fe7a`/`e4fa536` sits **before** the crossing
branch and returns `{ state: 'resync' }`, and **a room change always looks like a teleport**
(you land at a far edge — measured 56 tiles in the test).

Being precise about severity: the drop still happens on the *next* tick, and the drop check
runs before `_requestOffRoom`, so the documented double-traversal bug (JayB passed through
Farol into Faronath on one stale request) is **not** reintroduced. The guard is delayed one
tick, not defeated. But the ordering is now load-bearing and undocumented, and the comment
above the crossing branch — which is excellent, and explains why the guard exists — no
longer describes when it runs. Move the room-change check above the resync.

### c. `m59-tick.mjs` — a new periodic read breaks a strict count

`m59-tick-test`: *"latency changes when a command lands, never how often we look"* asserts
`submitted.length === ticks`. `017af5e` added a periodic inventory read, so it is now
`ticks + reads` (measured 11 ticks, 12 submissions, the extra one `kind: "read"`). The
property the test defends still holds. Update the assertion to count decide-issued commands.

### d. Debug code left in production hot paths

Nine unconditional appends to `/tmp` in `m59-controller-mover.mjs` and `m59-route.mjs`,
several gated on a **hardcoded agent name**:

```js
if (this._agent === 't4' && ...)          // m59-controller-mover.mjs:133, 781, 826
appendFileSync('/tmp/t4-moved.log', ...)  // and /tmp/t4-pocket.log, /tmp/plan-debug.log, ...
```

These are live and growing right now — `/tmp/t4-moved.log` was **5.1 MB**, written seconds
before this document. Per-character branches in shared code are the exact thing this project
already decided against once: the keeper is the same for every character, and a rule that
fires for one of them is a rule you cannot reason about.

One of them cannot ever work. `m59-route.mjs:193` references `frame`, which is not in scope
in `_planLeg(here)`:

```js
try { appendFileSync('/tmp/route-debug-t4.log', `... frame=${JSON.stringify(frame.position ?? null)}`); } catch {}
```

It throws `TypeError: Cannot read properties of undefined` on **every** call and its own
`catch {}` swallows it — a thrown exception per plan, forever, logging nothing. A silent
`catch {}` around a debug line is how that survives.

### e. Repository hygiene — 75 MB of run artifacts committed

`docs/soak-artifacts/` holds **75 MB**, including `keeper-t3-20260828-1325-master.log` at
**693,394 lines**. `.git` is now 113 MB. `.gitignore` already excludes
`/substrate/keeper-*.log`; these were committed by being copied into `docs/` first.

CLAUDE.md is explicit: *do not commit anything a running fleet writes.* Two or three
representative excerpts make the same argument as the whole log and can be read in a diff.
Removing them from history is a rewrite and probably not worth it — but stop adding more,
and consider `.gitignore`-ing `docs/soak-artifacts/*.log`.

## 7. Working here

- Every tool in `tools/` is standalone `.mjs`, zero dependencies: `node tools/<name>.mjs`.
- **The offline tests are safe to run any time** — they open no socket and touch no roster.
  `docs/m59-tests.md` lists each with what it pins, which is the part worth reading before
  changing the code it guards. Excluded because they need a live server or credentials:
  `m59-autopilot-test`, `m59-skills-test`, `m59-coop-test`, `m59-core-test`,
  `m59-perception-test`, `m59-traversal-test`.
- **Do not `import` `m59-broker.mjs` to check it** — importing runs it and it takes the
  fleet lock. Use `node --check`.
- **Restart every keeper together after a change.** Staggered restarts produce version skew
  across characters and you will spend the afternoon chasing a ghost.
- **A claim that contradicts what is written down needs a reproduction before anything is
  decided on it.** Measure the thing that must change if the claim is true, and repeat the
  call — "it stopped after one" and "I only asked once" produce identical evidence.
- **Orders are not code.** Loadouts, tuning, playbooks and guild plans live on the machine
  that owns the roster and are gitignored; git carries only the `.example` shape. A file
  that parses is a file a keeper acts on, so someone else's afternoon must not arrive
  through a commit.
- **Silence is the default failure mode of this game.** A merchant refusal is a sentence
  spoken to the room. A guild command you lack the bit for sends nothing at all. *No error
  has never meant success here* — verify by reading the world back.
