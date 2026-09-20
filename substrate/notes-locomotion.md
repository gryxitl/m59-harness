# Locomotion Findings — 2026-09-19

## Established Numbers

| Metric | Value | Source |
|--------|-------|--------|
| groundRate | 0.91 sq/s | mover-hb (601.6sq/662s) |
| sends/s | 0.24 (0.76 cumulative) | vel-tick 29/120s |
| plan from=/s | 6.4 (761/120s) | plan-from log |
| gateCLOSED/s | 0.73 (87/120s) | movedbg-gate |
| stride regime | 4.36 sq/s (21 sends/21s) | vel-tick gaps <1500ms |
| floor regime | 0.067 sq/s (8 sends/90s) | vel-tick gaps >5000ms |
| tick cadence | 10 Hz | TickLoop setInterval 100ms |
| Pacer cap | 5/s (200ms min gap) | PACKETS_PER_SECOND=5 |
| server cap | 1/s (1000ms) | USER_MOVE_MIN_INTERVAL_MS=1000 |
| stuckTicks threshold | >10 (1s at 10Hz) | :1515 |
| floorOk | 5s | :2979 |

## Root Cause: Destination Churn

The `to() -> … by=` log (always-on, self-attributing) shows:
- **by=router** oscillates between `67,28` (wantRoom=534) and `6,36` (wantRoom=200) every 1-3s
- **by=patrol** changes destination every 5-10s: `8,35 → 5,37 → 2,36 → 10,33 → 5,32`
- Character is in room 557 (Sweet Grass Prairies), not a hunt room
- `idx=` walks up to 51/57 then resets to 1/4, 0/6, 2/7, 0/5, 1/4, 2/6, 0/3
- `me=` jumps 63,33 → 5,32 → 11,35 → 6,32 → 7,34 → 5,32

The patrol/recovery micro-walks overwrite the router's journey. `docs/HANDOFF.md:76` logged this as "destination churn (goal/hunt repick)."

## What's NOT the Problem
## Updated Findings (23:00-23:01 window)

### The character is in room 200, not room 557
The `routedbg` lines show `here=200` — the character is in room 200, not room 557 (Sweet Grass Prairies). The `standOn=(67,28)` and `aim=(67,28)` mean the character is already at the destination.

### The character is in `hunt` mode the entire time
The `[tick]` lines show `hunt -> travel` the entire time — never resting, fighting, or critical-resting. The ~85s non-sending windows are NOT rest/fight — they're the character trying to travel to room 534/535 but not making progress (hitting walls).

### The stride is already auto-shortened
The `stopped=wall` rows show `ground=63/48/42/143` (≤1.5 squares) while `stride=320`. The `_integrateToward` function already auto-shortens the stride. The fix is NOT reducing the stride — it's finding a path that avoids the narrow corridors.

### The `heldRank` gate exists and is correct
`:506` `if (!stale && by !== held && rank <= heldRank) return false`. The `by=patrol` accepting means the hold went **stale** (`OWNER_STALE_MS`). The router is silent while `hunt`'s patrol nudge drives.

### The `to()` prints are rate-limited
`to()` prints only when `isNewDest && now-_toDbgAt > 5000` (:524). My 20 lines/120s is a rate-LIMITED ceiling on emissions, not a rate.
### The kod corner is working correctly
The `regionCornerBanned` function (:83-105) checks if the character is in a kod corner that is NOT the room they want. The C4 corner (row < 32, col > 66 → room 534) is NOT banned when the character wants to go to room 534. The character walks through the C4 corner, gets teleported to room 534, then the router re-sends the character to room 200. This is the `trans=36` in 662s.

### ROOT CAUSE: Policy loop, not movement failure
7 arrivals at 534 in 100s — nothing is blocked. The character arrives at room 534, the room holds nothing in band (prey absence: 534 = baby spider lv25 @60% vs lv50 living tree @40%), `no target 30s in room 534` triggers re-target to 535 (hops=2, farther), character bounces. `hops` is recomputed per tick: 534 is 1 hop via the corner while 535 is 2, so 534 wins → flung into 534 → holds nothing → 535 wins → go back.

### FIX: Hunt policy, not mover
1. Make the room just arrived at sticky for minutes (`_huntPickedAt` at m59-decide.mjs:2577-2600)
2. Require a candidate to be strictly nearer by the same hop function to steal a route from a held room
The mover needs nothing. The 0.91 sq/s is a duty-cycle number from the policy loop.
- Stride: 4.36 sq/s in stride regime (near full 5 sq/s)
- Geometry: server accepts full 320-unit stride in clear windows
- Planner: A* finds paths (found=true wp=7), 11 nodes, single-digit ms
- Pacer: 5/s cap, sends at 0.24/s — not Pacer-limited
- Gate: gateCLOSED 0.73/s matches 29 vel-tick — not starving sends

## The Fix

Add a `heldRank` gate so patrol/recovery micro-walks don't overwrite the router's journey. The `to()` call sites in m59-decide.mjs that pass `by='patrol'` (:2862) and `by='recovery'` (:2780) are per-tick-capable micro-walks that should be suppressed while the router holds a destination.

## Final State (2026-09-20)

### Commits shipped this session
| Commit | Fix |
|--------|-----|
| `b87a477` | 30s relocate checks `_huntPickedAt` (inert — cleared on arrival) |
| `666be1d` | `_huntTried` stamp on arrival + 30s relocate guard |
| `a01821b` | Exclude `_huntTried.room` from `nearestHuntRoom` re-pick |
| `9eacfba` | `_huntTried` stamp is one-shot per room |
| `6819c8a` | Bounded `_huntTriedSet` (max 10 rooms, 5-min TTL) |
| `61859ae` | `_huntTriedSet` only stamps when entry is absent/expired |

### Confirmed working
- `hunt room sticky` elapsed figure increases: 0s → 30s → 60s → ... → 270s (one-shot stamping confirmed)
- `no target 30s` is 0 post-restart (30s relocate suppressed)
- `m59-decide-test.mjs`: 105 passed, 0 failed
- Locomotion was never the problem: ~4.36 sq/s in clean windows, `cadence={under1s=0 minGap≈1000}` throughout

### Root Cause: Autopilot Constructor Null Overriding Roster

The `Autopilot` constructor (`m59-autopilot.mjs:1221`) defaults `assignedRoom` to `null`. When the `autopilot` tool handler spread `p.policy` into `rememberAutopilot`, the constructor's `null` overrode the roster value, erasing placement on every start call.

The `rememberAutopilot` merge (61ad36a) did NOT prevent this: `config.policy` carried the constructor's `null`, and `{...prevPolicy, ...config.policy}` let the `null` win.

### Fix (22e3298)
1. `rememberAutopilot` merges the new policy over the previous (absent keys preserved)
2. The `:7314` seed filters out null-valued keys from `p.policy` unless the caller explicitly set them
3. An explicit `assigned_room: null` still clears; the constructor's `null` does not

### Confirmed Working
- `assignedRoom` values stable: t1=534, t2=535, t3=575, t5=603
- Kills resumed: 00:53:49 and 01:03:35 (baby spider, West Merchant Way)
- Movement healthy: ground=1.40 sq/s, path non-null, stuck=0
- Two consecutive curl calls with `{mode:'tick', hunt:'giant rat', useGOAP:true}` leave 603 intact

### Open
- t4 (Lee) has no `assignedRoom` — never had one; will hunt wherever it stands
- `broker-default.log` is truncated on every broker start; crash stacks exist only in `/tmp/keep/`
- 2 cliff-guard test failures in `m59-mover-test.mjs` (pre-existing)
- `m59-hoptest.mjs` has never been run
- `unconfirmed=29` / `drops=108` climbing at last heartbeat (envelope-refusal pattern)
