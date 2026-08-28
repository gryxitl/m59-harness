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

- [ ] Express the goal as a world state (`has_target`), not a procedure.
- [ ] Actions: `travel_to_room` (pre: `route_reachable`), `acquire_target` (pre:
      `target_in_room`).
- [ ] Delete the hand-written branch; let `planFor` produce the sequence.
- [ ] Keep `nearestHuntRoom` as the thing that CHOOSES a room — that is a policy
      question, not a planning one.

**Done when:** `hunt` has no early return, and `/tickstats` shows it planning rather than
handling.

### Phase 3 — migrate `_fight`

- [ ] Actions: `approach` (pre: `target_reachable`), `swing` (pre: `in_reach`,
      `vigor_floor`), `disengage`.
- [ ] The combat controller stays as the thing that executes a swing; the planner decides
      whether swinging is what should happen.
- [ ] Preserve the fix already recorded at m59-decide.mjs:1995 — cooldowns and facing are
      NOT failures. Under GOAP that stops being a special case: a cooldown means the swing
      action's precondition is briefly false, which the planner handles natively.

**Done when:** the 3.5s swing gap that motivated the original widening cannot recur,
because nothing is counting failures any more.

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
