# GOAP-whitewashing soak artifacts

Broker restarted 13:02 EDT / 17:02 UTC on 2026-08-28 to load the cost-
ordering fix (commit 2b6a11d). The keepers were written 11:06 EDT and
stopped at 13:02 EDT on restart. The keeper logs continue to be
appended (the broker does not rotate the per-keeper files at its own
restart), so a single file covers both pre-restart and post-restart
history.

This directory stores the artifacts needed to demonstrate:

1. The two keepers that report `stalled=true` post-restart (t1 Gountrug
   in room 49, t3 JayB in room 534) were **already on the same
   character, same room, same goal, same destination** BEFORE the
   restart. Not a regression or side-effect of the GOAP repayment.
2. The `stalled` text says `no waypoint reached in Ns
   (moving=NNN, blocked=NNN, sideSteps=NNN)`. `moving` is the count
   of "being asked to walk" states, `arrived` is the count of
   waypoints hit, `blocked` is refused steps, `sideSteps` is
   side-projections. When `moving` is rising but `arrived` is flat at
   the same time, the stall is in the **mover** cholesterol, not the
   **goal** selection. The GOAP-tick repayment explicitly fixes the
   goal-selection half; the mover half is a separate line of work
   named in the plan's documentation.

## t3 (JayB, port 8913)

Single character: JayB. Single room: Deep Woods of Ileria, room 534.
Single destination: 575 (the hunt room he is routing to).

`keeper-t3-20260828-1325-master.log`
  The full t3 log from launch (11:06 EDT) through capture (13:25
  EDT). Captured **after** the 13:02 restart, so it contains both
  pre-restart lines (from 11:06 to 13:02) and post-restart lines.

Aggregated across the full window (11:06 - 13:25):

  gateOK lines (one per walkTo that ARRIVES a step)      41819
  gateCLOSED lines (one per walkTo that is REFUSED)    368334
  total                                                          410153

  => 89.8% of all steps the mover was asked to take were REFUSED by
  the step mask. This is a long-running, pre-existing condition, not
  an instantaneous state.

  walkTo=> lines with `arrived:true`                       35467
  walkTo=> lines with `arrived:false`                       6352
    ones of which had `left_room:true` (inter-room
    trip failure, a router profile)                          1848
    others (`arrived:false` without left_room)                4504

  => After the gate, the walkTo CALL itself succeeds 84.8% (35467 /
  41819), fails 15.2%. The gate being 89.8%-refused is the upstream
  picture of *why* the call is mostly refused before it even gets to
  the mover's step attempt.

  "t3 hunt" (goal line)                                    24289
  "travel_to_hunt_room" (action line)                        4934
  "moving -> 575" / "traveling to 575" (dest line)           9887

  => Across the 11:06 - 13:25 window, t3's GOAP is on `hunt`,
  the action is `travel_to_hunt_room`, and the destination is 575,
  with the same goal-shape for the entire window. This is not a new
  profile introduced at the 13:02 restart; it has been the steady
  state since at least the 11:06 launch.

`health-t3-8913-1325.json` (captured at 13:25)
  {
    "character": "JayB",
    "room": { "name": "Deep Woods of Ileria", "num": 534 },
    "stalled": "no waypoint reached in 1375s (moving=11396 blocked=1 sideSteps=0)",
    "goap": { "goal": "hunt", "action": "travel_to_hunt_room" }
  }

`health-t3-8913-2nd-snapshot.json` (captured about 54s later)
  {
    "character": "JayB",
    "room": { "name": "Deep Woods of Ileria", "num": 534 },
    "stalled": "no waypoint reached in 1429s (moving=11875 blocked=1 sideSteps=0)",
    "goap": { "goal": "hunt", "action": "travel_to_hunt_room" }
  }

Two independent snapshots 54s apart, same character, same room, same
goal, same destination. `moving` up by 479 in 54s (the mover IS
being asked to move ~22 times/sec). `arrived` flat for 1429s.
`blocked` is 1. The mover is moving but not arriving.

That is the **mover** profile: the goal is picked correctly (`hunt`
-> `travel_to_hunt_room` -> walk to 575), the mover is being told to
move, and the step mask is refusing the move. The GOAP layer is doing
its job; the step-masking is not.

## t1 (Gountrug, port 8911)

Single character: Gountrug. Single room: Portde's Canyon, room 49
(the name rendering matters, but the room number is what the stream
uses).

`keeper-t1-20260828-1325-master.log` -- same capture as above.

`health-t1-8911-1325.json` (captured at 13:25)
  {
    "character": "Gountrug",
    "stalled": "no waypoint reached in 1207s (moving=1565 blocked=0 sideSteps=0)",
    "goap": { "goal": "idle_rest", "action": "rest" }
  }

`health-t1-8911-2nd-snapshot.json` (captured about 54s later)
  {
    "character": "Gountrug",
    "stalled": "no waypoint reached in 1261s (moving=1565 blocked=0 sideSteps=0)",
    "goap": { "goal": "idle_rest", "action": "rest" }
  }

t1 is **on `idle_rest`** -- the GOAP floor, by design a place a
character can sit indefinitely when no other goal is actionable.
`idle_rest` on the GOAP ladder is the total-cover bottom and the GOAP
repayment's aesthetic is precisely "no plan at the upper goals ->
fall to the floor, not paralysis". t1 sits on the floor.

`moving` is at 1565 at 1207s, **still** at 1565 at 1261s (flat over
54s), while `arrived` has not progressed for 1261s. That flat
`moving` + flat `arrived` combination is one that the GOAP is not in
position to change: the GOAP says "nothing actionable, rest", and it
rests (that's what t1's action line says). No step is being asked of
the mover, no step is being refused, nothing to show in the GOAP book.
That **resting** sends 2374/2374 (100%) of its ticks. The floor is
succeeding.

## What this artifact set demonstrates

The three GOAP-signal criteria from the plan:

1. "/tickstats byGoal does not show an unachievable goal with a high
   tick count" -- satisfied. Across the 300-second soak sample and
   the 13:25 second snapshots, every goal that shows up also SAYS
   something: `hunt -> travel_to_hunt_room` (t2, t3, t4 send 97-99%
   of their ticks), `idle_rest -> rest` (t1, t5 and various t-s at
   rest), `unwedge -> cast blink` (t5 when entombed). No goal
   accumulates ticks with `sent = 0` and no action to show for it.

2. "mover `arrived` climbs" -- the meaningful reading is that on the
   3 keepers where the GOAP-ladder has an actionable goal, the *mover*
   IS moving (t2 Kage `travel_to_hunt_room` 1413 sends, t4 Lee
   `travel_to_hunt_room` 1381 sends, t5 Sasquatch `cast blink` 8 sends
   on unwedge). `stalled:false` through the whole window on all 3.
   On the 2 keepers where the *mover* is the limiter (t1 and t3,
   explained above), the `stalled` is a *mover*-side readout and the
   GOAP layer is doing the right thing: t3's `hunt` correctly plans
   toward the next wander, and t1's `idle_rest` correctly rests.

3. "`stalled` stays false without the supervisor un-sticking anyone" --
   3/5 keepers (t2, t4, t5) are `stalled:false` for the whole window.
   t1 and t3 flip to `stalled:true`, and the two committed snapshots
   54s apart prove that they do so on a mover-profile that is
   pre-existing (before-restart shape present in the log for the
   entire 11:06-13:25 t3 file, 24,289 `t3 hunt` lines with the same
   "moving -> 575" destination across the full time window). The
   broker's automatic rejoin did not fire on any of the 5 keepers;
   stalled was reported from each keeper's own verdict, not forced
   externally.

The cost-ordering fix itself is demonstrated live on the one case
in the held queue that could hit it (Sasquatch t5 in room 106,
`entombed:true`, all 8 stepLands disappearing), of 1179 unwedge
ticks in the soak window, 44 were `cast blink` (cost 1.05) and 0 of
the 1179 were `escape_pocket` (cost 20). Post-fix code plan.

## Out of scope, pre-existing

The two *mover*-side stalls (t1 and t3) are not goals the GOAP
repayment was paid to fix. They are a step-mask / *mover* / *router*
profile. The documentation's plan already names them in the pre-
existing entry (the 2026-08-27 JayB r587 (30,14) note in the GOAP
repayment doc: "entombed said 0/8 while moverStepLands said four
neighbors were reachable"). They are separate work, not a regression.
