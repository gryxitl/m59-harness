# Repaying the GOAP drift

Opened 2026-08-28. A plan for removing the reason this fleet can stall at all, rather
than adding a fourth mechanism for noticing that it has.

## The diagnosis

The decider is described as GOAP and is mostly not. Measured:

```
17  goal entries in a hardcoded priority ladder (first match wins)
 1  planFor() call site
 9  goals with hand-written branches that return BEFORE reaching the planner:
    _fight  flee_danger  flee_hurt  healthy  hunt  leave_raza  unstuck  unwedge  vigor_low
```

The planner only gets the leftovers — `armed`, `sell_loot`, `bank_money`, `vigor_ok`,
`has_food`. The two goals that consume nearly all of the fleet's time, `hunt` and
`_fight`, never reach it.

**That is why a stall is possible in a loop that re-decides ten times a second.** In GOAP
an action whose preconditions cannot be met is unplannable: A* routes around it or
reports no plan, and the fall-through is free because "no plan" is a first-class outcome.
A hand-written handler has no precondition and no plan — `hunt` calls `router.to(575)`
and returns `sent`, for ever, and nothing can express that it is impossible because
nothing is asking.

Three mechanisms currently try to infer that failure from outside, and all three ask
about activity rather than outcome:

| guard | measures | why it cannot see a livelock |
|---|---|---|
| `note()` / `skipAfter` | a packet was sent | sending is what a livelock does best |
| stillness stall detection | the character moved | side-stepping is movement |
| `stalled` on the fleet board | the keeper's port answers | a livelock is maximally alive |

The worked example, 2026-08-28: JayB in room 50 at (2,48). His leg staged on (3,57),
which is not in the 340-square pocket he was standing in — `geo.path(collision)` answers
`found: false`, and every planner correctly refuses. Over seven hours:

```
ticks=231,626   arrived=0   ctlBlocked=358,787   sideSteps=938,856
```

with `stalled_count: 0` on the board throughout. The fact that made it impossible was
computable the whole time and nothing consulted it.

## The principle

**A goal that cannot be achieved must become unplannable, not merely unsuccessful.**
Then the ladder falls through on its own, and because the bottom of the ladder is
resting, there is always something to do.

Corollary: stall detection becomes a backstop that should never fire, rather than the
thing holding the fleet up. Keep it, do not rely on it.

## Phases

### Phase 1 — the missing preconditions (small, testable, fixes the live bug)

The facts that make an action impossible already exist and are not consulted.

- [x] `route_reachable` — the current leg's `standOn` is in the fine-reachable set from
      where the body stands. Reuses the router's cached BFS, so no new cost. Abstains
      (null) with no leg, no geometry or no answer, so it only ever refuses on a positive
      finding.
- [x] `travel.pre` gains it, so a leg to an unreachable staging square is unplannable.
- [x] `hunt` declines while the fact holds, and DROPS the stale leg so the router
      re-plans rather than steering at it again.
- [x] **A floor: `idle_rest`.** Found while doing this — the goals below `hunt` were only
      `vigor_ok` and `has_food`, so a healthy character with an unreachable route matched
      NOTHING and idled, which is indistinguishable from the stall being fixed. Declining
      is only safe if something always accepts. `idle_rest` is last, always available,
      gated on the same two things `healthy` uses.
- [x] Verified: (2,48) in room 50 with `standOn (3,57)` now yields to `idle_rest`.

**Phase 1 done, 2026-08-28.** +14 assertions in m59-decide-test. unattended (55) and
travelling (90) stayed green, so the boundary is intact.

**Done when:** a character whose route is impossible rests instead of side-stepping, and
the goal below `hunt` gets the tick. No new timers, no failure counting.

### Phase 2 — migrate `hunt` off its handler

`hunt` is the largest consumer of ticks and the commonest livelock.

- [x] Express the goal as a world state (`has_target`), not a procedure. `GOAL_STATE` maps
      the behaviour name to the state it actually wants.
- [x] Actions: `travel_to_hunt_room` (pre: `route_reachable`, effect: `in_hunt_room`) and
      `acquire_target` (pre: `in_hunt_room`, effect: `has_target`), in
      `tools/m59-act/hunt-room.mjs`.
- [x] New symbol `in_hunt_room` — the intermediate state, because travelling does not
      produce a target, it produces the room targets live in.
- [x] Deleted the hand-written branch: 111 lines.
- [x] `huntRoomFor` keeps the room CHOICE as policy, computed once a tick into
      `_huntRoomWanted`. Assigned room wins, else nearest within the ceiling.

**Phase 2 done, 2026-08-28.** Verified: a reachable hunt room plans
`[travel_to_hunt_room, acquire_target]`; an unreachable one plans NOTHING, and the ladder
falls to `idle_rest`. +13 assertions. Thirteen suites green including both boundary ones.

**Done when:** `hunt` has no early return, and `/tickstats` shows it planning rather than
handling.

### Phase 3 — migrate `_fight` — **DONE 2026-08-28**

- [x] `_fight` maps to the world state `{'!has_target': true}` — the quarry stops
      existing. `attack` already declared that effect and `in_reach` as its precondition;
      what was missing was an action that ACHIEVES `in_reach`.
- [x] `approach_target` (`tools/m59-act/approach.mjs`), pre `has_target`, effects
      `in_reach`. NOT gated on reachability: whether a path exists is the mover's finding
      and arrives as `session._moverNoRoute` after an attempt. Gating on a symbol the
      planner cannot produce before trying is what deadlocked `hunt` in phase 1.
- [x] The controller stays as the thing that executes, and keeps every piece of
      bookkeeping it had — kill recording (the ledger is the only true source of kills),
      the no-route blacklist, the zap enchantment, re-equipping, the unpathable-square
      retarget, `_standStill`. `tick()` takes a `decision` and carries it out instead of
      choosing. With `decision` null it still runs its own phase machine, for the legacy
      driver and the offline suite.
- [x] Cooldowns are not failures: `combatStep` treats swing/walk/cast/loot/stand/idle/
      reequip as engagement. Kept explicitly rather than relied upon.

**Two things the plan did not anticipate, both load-bearing:**

**1. There were two reach rules, and migrating would have livelocked on them.**
`in_reach` tested a EUCLIDEAN disc of radius 3 (the server's bound) while the controller
swung on MANHATTAN <= 2 (deliberately conservative, bought by a measurement: JayB, 331
swings in nine minutes, zero kills). A target three squares NSEW read in-reach to the
planner and out of reach to the mover — pick `attack`, get refused for range, pick it
again, ten times a second. The decision now has one home (`attackReachFor` /
`targetInReach` in `m59-combat.mjs`) and the atomic, the planner and the controller all
read it. It is also mode-aware now, which fixed two live wrongs: a bare-handed character
stood two squares off and punched air (bare hands reach one, not two), and a caster walked
into melee before using a bolt that travels eight.

**2. Removing the controller's retreat made the ladder's coverage load-bearing, and the
ladder had a hole.** The controller checked health at the top of its `close` phase and
backed off below 55%. That quietly covered a gap in `flee_hurt`, which required
`in_reach`: a character at 30% health with the mob one square outside melee selected
`_fight` — and `_fight` now plans `approach_target`, so it would WALK TOWARDS the thing
that hurt it and only become allowed to flee once it arrived and got hit again. The
identical mistake is described and fixed one rung higher, beside `flee_danger`/`critical`
("`in_reach` is a fact about this instant and a chasing mob is in and out of it every
second"); the argument had never been carried down. `flee_hurt` no longer asks about
reach. Swept exhaustively rather than sampled, because the hole was not at a threshold —
it was in a corner two booleans wide.

**Done when:** the 3.5s swing gap cannot recur, because nothing is counting failures any
more. — Met. And the survival sweep is pinned in `m59-decide-test.mjs`; reintroducing the
`in_reach` gate on `flee_hurt` fails it with the exact holes named.

### Phase 4 — the survival goals

`flee_danger`, `flee_hurt`, `healthy`, `vigor_low`, `unwedge`, `leave_raza`.

Deliberately last, and possibly never. These are the four protected faculties on a
one-second clock (`docs/m59-boundary.md`), they are simple, and they do not livelock —
resting always works. **Do not migrate them for symmetry.** If a phase-4 change cannot
name a failure it prevents, do not make it.

## What must not break

- The priority ORDER. Survival outranks work; that ordering is argued in
  `docs/m59-boundary.md` and is not what is wrong here.
- The four protected faculties stay in this repository on their one-second clock.
- `m59-unattended-test` (55) and `m59-travelling-test` (90) pin the boundary. Both must
  stay green through every phase.
- Cooldowns and facing must not read as failures (m59-decide.mjs:1995).
- Silence means the behaviour that was already there — a goal with no plan falls to the
  next goal, never to paralysis.

## How to tell it is working

Not by kills, which move for many reasons. By these:

- `/tickstats` `by_goal`: a goal that cannot achieve anything should stop appearing,
  rather than appearing with a high tick count and nothing to show.
- The mover's `arrived` climbs. `arrived=0` over a long window is the signature this
  whole plan exists to make impossible.
- `stalled` stays false without the supervisor having to do anything.
- `m59-supervise.mjs` unsticks nobody, because there is nobody to unstick.

## Known suboptimality, not a blocker

With `can_leave` as the goal, an ENTOMBED character is planned `escape_pocket` (a
reconnect, cost 20) rather than `cast blink` (cost 1.05) even though blink's preconditions
are all satisfied and it is nineteen times cheaper. Both free the character, so this is a
cost-ordering question in `m59-goap-planner.mjs`, not a modelling error — the actions and
their preconditions are right. Worth chasing when the planner is next opened; not worth
blocking a character's escape on.

## Log

- 2026-08-28 — opened.
- 2026-08-28 — phase 1, first attempt gated the `hunt` GOAL on `route_reachable`. That
  DEADLOCKED: the code that drops the stale leg lives inside the hunt handler, so gating
  the goal meant the leg was never dropped and three characters rested for ever
  (idle_rest 3,096 ticks against hunt 2). The lesson generalises to phases 2 and 3 —
  refusing at the SELECTION point strands whatever cleanup lives in the handler. Refuse at
  source instead: the router now declines to hand out a leg whose staging square is
  outside the body's reachable set, marks the hop doorless so `findPath` routes around it,
  and `hunt` stays ungated.
- 2026-08-28 — phase 1 landed. The floor (`idle_rest`) was not in the original plan and
  turned out to be the load-bearing half: without something that always accepts, making a
  goal decline just moves the stall one rung down. Worth remembering for phases 2 and 3 —
  every goal made declinable needs the floor underneath it, and the floor is now there.
- 2026-08-28 — phase 3 landed. Two surprises, both recorded above: the two reach rules
  (which would have livelocked the migration on its first tick) and the `flee_hurt` hole
  (which the controller's own retreat had been hiding). The general lesson for phase 4, if
  it is ever taken: **removing a hand-written handler removes whatever ELSE it was quietly
  deciding.** The retreat was not in the plan's list of what `_fight` did, and it was the
  most important of them. Before deleting a handler, sweep the space the ladder must now
  cover — do not read it.
- 2026-08-28 — offline suite: 16 suites fail, and the same 16 fail on a stashed baseline.
  No regressions from phase 3. Pre-existing and NOT investigated here: `m59-travelguard-test`
  (`s.startJob is not a function` — harness drift; `startJob` is live in the broker and
  `m59-travelling-test` passes at 90), `m59-region-exit-test` (3), one `m59-act-test` spell
  assertion, and a dozen routing/travel suites. Worth a separate pass.
- 2026-08-28 — two live findings from the first hour on the migrated code, both fixed.
  **(a) `attack.pre` required `armed`.** Harmless while `_fight` was hand-written — the
  controller punched, and `PUNCH_REACH` exists for it — but the moment the goal became
  PLANNED it made the whole thing unplannable bare-handed: goal selected, no plan, the
  character standing in front of the quarry. Lee, 40 ticks of "exhausted 13 nodes".
  Dropped: arming is the rung ABOVE `_fight`, not a precondition of swinging, so a
  character that can arm still does and one that cannot punches for the price of a mace.
  **(b) A tri-state hole meant NO goal at all.** `_fight` asked `target_in_band === true`
  and `hunt` asked `=== false`, so an unresolved creature level matched neither, and
  `idle_rest` excludes a character holding a target. Lee again, 192 ticks of `none`.
  `hunt` is now the exact complement of `_fight` (`!== true` on both symbols), which is
  also the convention the symbol documents: a ceiling that cannot be read is a refusal.
  Both are swept exhaustively in `m59-decide-test.mjs` rather than sampled.

  The general lesson, and the one worth carrying into any phase 4: **a precondition that
  was decoration under a handler becomes load-bearing under a planner.** A handler that
  cannot satisfy a condition improvises; a planner returns no plan and the goal goes
  quiet. Every `pre` on an action reachable from a migrated goal is worth re-reading in
  that light before the migration, not after.
- 2026-08-28 — two more from the second hour, and the second one is the important one.
  **(c) `_targetId` was never set on the sticky path.** The decider overrides
  `ws.has_target = true` after selecting a quarry, but only assigned `ws._targetId` on the
  branch that chose a NEW one — so on every tick after the first, the world state claimed
  a target and carried no id for it. The hand-written handler survived that because the
  CombatController falls back to scanning the room; a planner action cannot, and
  `approach_target` refused with "no target in the world state" while `_fight` was
  selected on `has_target === true`. Lee, 180 ticks planning an approach and sending
  nothing. The same block also carried a THIRD hardcoded copy of the melee bound
  (`bestD2 <= 4`, Euclidean, mode-blind) which OVERRODE the `in_reach` symbol on the
  common path — so consolidating the reach rule would have had no effect on a live fight
  until this was found. Both now call `targetInReach`.
  **(d) The ladder was not a total cover, and closing corners one at a time was making
  more of them.** Three separate tri-state combinations selected NO goal — no action, no
  error, a stall invisible to every liveness check because the loop ticks at 10Hz and
  reports zero failures. The bottom two rungs are now a total cover (`flee_danger` when
  something is hitting us, `idle_rest` unconditionally), so the invariant no longer
  depends on a dozen conditions above staying mutually exhaustive as they are edited.
  `m59-decide-test.mjs` asserts the last rung takes no world state at all.

  Both (c) and (d) are the same shape as (a): **the handler was compensating for something
  the world state got wrong, silently, and the planner cannot.** That is the real cost of
  the migration and the real value of it — the compensations are now visible as refusals
  instead of invisible as improvisation.

## Live soak status (2026-08-28)

Tasks 1 and 2 are landed and committed:
- 4935c17 offline suites green
- 2b6a11d blink cost-ordering

Task 3 (live soak + telemetry) requires a broker restart to load the fix, then an
observation window (5+ minutes) where the fleet owner can confirm:
  - /tickstats by_goal shows no unachievable goal with a high tick count
  - mover.arrived climbing over the window
  - stalled stays false with the supervisor not un-sticking anyone

Restart command (from the AGENTS.md):
  node tools/m59-service.mjs stop --fleet <fleet>
  node tools/m59-service.mjs start --fleet <fleet>

Then observe:
  curl "http://127.0.0.1:<keeper-port>/tickstats?reset=1"
  sleep 300   # 5 minutes
  curl "http://127.0.0.1:<keeper-port>/tickstats" | jq

Precondition verification should include:
- `idle_rest` still bottom-of-ladder (the floor is total-cover)
- No `unwedge` goal with plan-fall-through holding more than a second
- `arrived` climbing from 0 to some number over the window

