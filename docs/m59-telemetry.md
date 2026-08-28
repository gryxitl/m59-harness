# Telemetry: finding out why a character is not doing anything

Written 2026-08-28, after a day spent guessing. Every number here exists because
something was invisible and cost hours. **Read a counter before you change a line** —
most of what looked like a decision bug turned out to be a character that was never
asked to decide.

The short version: a keeper can report a healthy 10Hz tick loop, zero errors, zero
skipped ticks and a sensible goal, while sending **0.33 packets a second** and running
its decision logic **once every 195 ticks**. None of the pre-existing counters showed
that. These do.

---

## Where to look first

Every keeper is its own process with its own HTTP port. `t1` is 8911, `t2` 8912, and so
on — port = `8910 + N`. All of these are GET and safe to hit at any time.

| endpoint | answers |
|---|---|
| `/tickstats` | **start here.** Is the loop running, is the decider being reached, what is it deciding, and is anything reaching the wire |
| `/pacerstats` | what actually went out on the socket, and whether a queue is building |
| `/state` | room, vitals, goal, equipment, pack — the character as the keeper sees it |
| `/probe` | route, leg, target, neighbours — the navigation view |
| `/movecheck` | per-direction step validation with the refusal reason |
| `/stepmask` | the same neighbours through `moverStepLands`, the mover's own predicate |
| `/grid` | an ASCII map around the character, with the room identity |
| `/rxstats`, `/swingstats` | bytes and swings actually sent — ground truth |

```bash
curl -s localhost:8913/tickstats | node -e 'let s="";process.stdin.on("data",d=>s+=d)
  .on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,1)))'
```

---

## /tickstats, field by field

### `loop`

```
hz_configured / interval_ms_configured    what was asked for (10Hz, 100ms)
hz_measured   / interval_ms_measured      what actually happened
worst_gap_ms, gaps_over_2x                the tail
ticks, skipped, errors, longest_decide_ms
frozen_ticks, frozen_why, frozen_for_ms
not_in_game, stale_returns
slow_ticks                                {goal/action: {n, worst, total}}
```

**`hz_measured` versus `hz_configured` is the first question.** The pre-existing counters
only ever measured how long a tick *took* (`longest_decide_ms`, the `[tick-metrics]`
line). Neither says how *often* one happens, and a loop asked for 10Hz that runs at 2Hz
caps every packet rate downstream.

**`skipped` is not the whole story.** It only counts re-entry while `busy`. A tick that
blocks the thread for four seconds queues *one* timer callback, so `skipped` stays 0 and
the damage shows only in `worst_gap_ms` and `gaps_over_2x`.

**`frozen_ticks`** is a legitimate hold — a cast in flight needs concentration, so the
loop deliberately does nothing. `frozen_why` names it. A frozen loop is alive; it is not
a stall.

**`not_in_game` / `stale_returns`** are the two silent early exits inside the tick, after
`busy = true`. Both used to increment nothing.

### `decide`

```
entries    how many times the decider was actually called
emitted    how many times it produced a decision
exits      {label: n} — where it left when it produced nothing
```

**`loop.ticks` versus `decide.entries` is the single most valuable comparison in here.**
If the loop ticked 1,976 times and the decider was entered 11, the fault is *between*
them and no amount of goal-tuning will help. That gap was a wrapper in
`m59-keeper-process.mjs` that short-circuited to the travel intent and returned, so a
travelling character had no survival ladder, no combat and no rest — it only walked.

If `entries` is healthy but `emitted` is low, read `exits`.

### `by_goal`

```
[{ goal, ticks, pct, sent, actions: { name: {n, sent} } }]
```

What the character spent its ticks *deciding*, and how much of it reached the wire.
`_fight` at 45% with `sent=0` looks damning — check `/rxstats` `totalSwingsSent` before
believing it, because a handler that omits the `sent` field reports zero while swinging
perfectly well. That exact mistake cost an hour.

`?reset=1` zeroes the window so two readings can be compared.

---

## Reading it: the four shapes

**1. The loop is fine, the decider is starved.**
`hz_measured ≈ hz_configured`, `frozen=0`, `skipped=0`, and `decide.entries ≪ loop.ticks`.
Something between the timer and the decider is returning. Check the wrapper in
`m59-keeper-process.mjs` and the two counted early exits.

**2. The decider runs, nothing reaches the wire.**
`decide.emitted ≈ entries` but `/pacerstats sent_per_sec` near zero. Look at `by_goal`:
a goal that decides every tick and sends nothing is a stalled errand. Cross-check
`prod_per_sec` — if `prod` exceeds `sent` there is a backlog and the pacer is the limit
(it caps at 5/s, the server's `INCOMING_PACKET_THROTTLE`); if they are equal and low,
nothing is being produced.

**3. Packets go out, the body does not move.**
This is the mover's department. The `[ctlmover]` line every 20s in
`substrate/keeper-<agent>.log` carries the whole picture:

```
ticks moving arrived stuck noRoute planFail blocked delegated held resync
rock rockOff stale restQuiet
ctl sent slid ctlBlocked reconciled drift roomResyncs
ctlAt=<x,y> stranded fineAdopted fineRejected offRoom sideSteps
traceBlocked fellback rescued
path=<len>@<idx> aim=<x,y>
```

- `arrived=0` with a large `ticks` is the headline failure.
- `ctlBlocked ≈ ticks` means every step is refused.
- `stranded` counts ticks where the body's own point has no floor under it.
- `sideSteps` in the tens of thousands means it is shaking against a wall.
- **`ctlAt` and `aim` are the two numbers people forget.** `at=(col,row)` is a *square*,
  and a square is exactly the resolution at which this class of bug hides: a square
  centre with no floor and a body with floor share one square number. An `aim` two units
  from `ctlAt` is a plan aiming at where the body already stands.
- `held` is the lead guard: the belief running more than `MAX_LEAD_SQUARES` (4) ahead of
  the server's echo. A high `held` is the stutter — five squares, twenty seconds of
  nothing, four more squares.

**4. The body moves and achieves nothing.**
Read `/probe` for the route and leg, then check the leg's `standOn` is actually reachable:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { sharedRoomGeometry, buildAllRoomGeometry } from "./tools/m59-roo.mjs";
const map = JSON.parse(readFileSync("substrate/m59-map.json","utf8"));
buildAllRoomGeometry(map);
const geo = sharedRoomGeometry(map.rooms[50]);
console.log(geo.path(48, 2, 57, 3, { collision: true }));   // from (2,48) to (3,57)
'
```

`found: false` means the router has sent the character at a square it cannot reach, and
every planner will keep refusing. That is a routing fault, not a movement one.

---

## Ground truth, when a counter looks wrong

Counters are written by the same code you are debugging. When one surprises you, check
the wire:

- `/rxstats` — `rxBytes`, `rxPackets`, `lastRxAgo_ms`, `totalSwingsSent`
- `/swingstats` — swing rate and the gaps between them
- `/movecheck` — the actual refusal reason per direction (`geometry_blocked`,
  `start_has_no_floor`, `object_blocked`, `recovered_from_no_floor`)
- `/stepmask` — the same neighbours through `moverStepLands`

**`/movecheck` and `/stepmask` disagreeing is information, not noise.** The fine tracer
and the square-level validator are different models, and a body standing where they
disagree is the commonest hard stall in this repository. `roomSecurity` and `geoSecurity`
in `/movecheck` must match — if they do not, the collision map is not the room.

---

## Offline reproduction

Everything above can be replayed with no server. Take `ctlAt` from the log and the room
number from `/state`:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { sharedRoomGeometry, buildAllRoomGeometry } from "./tools/m59-roo.mjs";
const map = JSON.parse(readFileSync("substrate/m59-map.json","utf8"));
buildAllRoomGeometry(map);
const geo = sharedRoomGeometry(map.rooms[556]);
const X = 25088, Y = 34304;                       // ctlAt from the log
console.log("floor here:", geo.leafAtClient(X, Y) == null ? "NONE" : "ok");
for (const [c, r] of [[24,33],[25,33],[26,33],[26,34]]) {
  console.log(c, r,
    "stepLands", geo.moverStepLands(34, 25, r, c),
    "destLeaf", geo.leafAtClient((c-0.5)*1024, (r-0.5)*1024) != null,
    "trace", geo.traceFineMoveClient(X, Y, (c-0.5)*1024, (r-0.5)*1024,
                                     { slide: true, allowNoStartFloor: true })?.moved);
}
'
```

That three-way comparison — has floor, mover approves, tracer approves — is what
localises a stall to one of the two models rather than to "pathing".

Coordinates: protocol to client is `(v - 64) * 16`; a square is 1024 client units; the
centre of `(col,row)` is `((col-0.5)*1024, (row-0.5)*1024)`; `square = floor(x/1024)+1`.

---

## Comparing two windows

The counters are cumulative from process start, so a single reading tells you about the
character's whole life, not about now. Two ways to get a window:

```bash
curl -s "localhost:8913/tickstats?reset=1" >/dev/null   # zero it
sleep 120
curl -s localhost:8913/tickstats                        # two minutes of behaviour
```

Or plant a marker in the ledger and compare either side of it:

```bash
node tools/m59-mark.mjs --note "what changed"
node tools/m59-mark.mjs --since
```

**And restart every keeper after a code change, not just the one you are watching.**
Node reads modules at process start, so a keeper you did not restart is running the old
code — and comparing it against one you did produces a difference that has nothing to do
with the character. A day was lost to exactly that.

---

## What this will not tell you

- Whether a decision was *right*. `by_goal` says a character rested; it does not say it
  should have been fighting.
- Whether the server agreed. Movement is client-authoritative — the server accepts
  whatever coordinates it is sent — so "we sent it" and "it happened" are the same thing
  for movement and very much not for anything else. A merchant refusal is a sentence
  spoken to the room, not an error on the wire.
- Anything about a keeper that is not running. Check the process list first:
  `ps -ax | grep m59-keeper-process`.
