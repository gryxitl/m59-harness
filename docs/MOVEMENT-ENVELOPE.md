# The movement envelope — what the server actually allows

**Read this before touching mover rate, stride, or speed again.**

We fought this for weeks because we were looking for a bug in our locomotion when the governing
numbers were in the server, in a language nobody was reading. This file records what is *known by
measurement*, with the citation or the run that established it, and what was believed for weeks that
turned out to be false.

Everything here is about the **live shard** (`76.214.42.186:5959`), which the fleet actually plays.
The source tree used for citations is `/Users/costas/Documents/Projects/Meridian59`.

---

## 1. The two limits, and they are different limits

There are exactly two server-side constraints on how fast a player moves. Conflating them is what
produced most of the wrong conclusions.

### Limit A — packets per second. This one is real and hard.

`kod/object/active/holder/nomoveon/battler/player/user.kod:2907` `@UserMove`, verbatim from its own
comment:

```
% Speedhack works by sending a LOT of little moves very, very quickly.
% Normal players only send 1 movement packet per second, but
% speedhackers send more.
...
piMovesCounter = (piMovesCounter + 1) - iDelta;      % +1 per packet, -1 per second elapsed
piMovesCounter = bound(piMovesCounter, -MOVEMENT_DELTA_LAG_THRESHOLD, $);
if piMovesCounter > MOVEMENT_COUNT_THRESHOLD  ->  "is moving too fast. ... Possible speedhacker."
```

| constant | value | file:line |
|---|---|---|
| `MOVEMENT_COUNT_THRESHOLD` | **2** | user.kod:61 |
| `MOVEMENT_DELTA_LAG_THRESHOLD` | **5** | user.kod:58 |
| `USER_WALKING_SPEED` | **18** | user.kod:46 |
| `VIGOR_RUN_THRESHOLD` | **10** | user.kod:54 |
| `FINENESS` | **64** | kod/include/blakston.khd:1163 |

**Consequence: sending more than ~1 move packet per second buys nothing and risks an accusation.
Our `USER_MOVE_MIN_INTERVAL_MS = 1050` and the reference client's `MOVE_INTERVAL = 1000` are correct
and are not the problem.** Any future attempt to raise the fleet's rate by sending more often is
working against a hard server limit and should be abandoned on sight.

### Limit B — distance per packet. This one is LOOSE, and it is the only lever.

The distance check in the same function, at `iSquaredDistance >= 200` (about **14 squares**) with
`iDelta < 3`:

```
Debug("ALERT! ", ..., " moved ", iSquaredDistance, " with only ", iDelta, " seconds since last movement update.");
piCheaterLogs = piCheaterLogs + 1;
Send(self, @AddExertion, #amount=iSquaredDistance*EXERTION_PER_MOVE);
```

**It writes a log line and drains vigor. It does not `return FALSE`, does not move the player back,
and does not refuse anything.** There is no distance *refusal* in the move path at all.

Two more facts from the same path that matter:

- `kod/util.kod:109` `UtilGoToSquare` reads
  `if IsClass(what,&User) OR Send(where,@ReqSomethingMoved,...)` — for a **player** this
  short-circuits the room's walkability veto and returns TRUE. The server does not veto a player's
  target square on geometry here.
- `kod/util.kod:20` `UtilGoNearSquare` spirals outward from the declared square up to
  `max_distance = 50000` looking for a legal one. **A declaration at an illegal square does not fail
  — it lands somewhere nearby.** Which means "the character did not move" and "the declaration was
  refused" are *different* events, and only a position read tells them apart.

---

## 2. THE MEASURED ENVELOPE — 5 squares per packet, 284 of 284

`tools/m59-range-probe.mjs` (new, this session). It declares a position N squares away in each of the
eight directions and **asks the server where it actually put us**, settling by re-reading the position
until it is stationary rather than by guessing a duration. Run on t4 (Lee) with his mover idle so
nothing else was driving the character.

| declared | tries | arrived | moved | median ground | max ground |
|---|---|---|---|---|---|
| 1 | 24 | 24 | 24 | 1.41 | 1.41 |
| 2 | 18 | 18 | 18 | 2.00 | 2.83 |
| 3 | 18 | 18 | 18 | 3.00 | 4.24 |
| 4 | 18 | 18 | 18 | 4.00 | 5.66 |
| 5 | 18 | 18 | 18 | 5.00 | 7.07 |

Re-run twice more, same result: **284 declarations across the session, 284 arrived, zero refusals.**

**The server carries a player five squares in one packet, every time, including 7.07 on diagonals.**

**6+ was never attempted and that is NOT a ceiling** — the room was Brownestone Inn, 21x20, and the
probe skips out-of-bounds targets silently. Do not read the missing rows as a limit. To find the real
ceiling, run the probe in a large room (room 556 Deep Forest of Farol is 63x55).

### The gap this exposes in our own code

```
tools/tick/m59-mover.mjs:167   WALK_STRIDE_PROTO = 160    % = 2.5 squares
tools/tick/m59-mover.mjs:168   RUN_STRIDE_PROTO  = 320    % = 5.0 squares
```

**The walk stride is HALF the envelope the server grants, and the comment above it claims the value
is "verified: clientd3d/move.c + user.kod UserMove".** It is not verified against anything —
`UserMove` contains no stride constant at all. The 2.5 figure came from the client's local rendering
of a walk, not from what the server accepts.

---

## 3. Running below 10 vigor silently destroys movement — a live hazard

`@UserMove`, at `speed > USER_WALKING_SPEED`:

```
if Send(self,@GetVigor) < VIGOR_RUN_THRESHOLD
{
   % This person is cheating!  Stop them from moving, make a log note.
   Send(SYS,@UtilGoNearSquare, #what=self, #where=poOwner,
        #new_row=Send(self,@GetRow), #new_col=Send(self,@GetCol), ...);
```

**The server puts you back on the square you were already on and logs "was running with no vigor."**
From the client side that is *indistinguishable from a refused stride* — the position simply does not
change.

Our mover chooses `runNow ? 36 : 18` at the stride sites (`m59-mover.mjs:1699` and others), and 36 is
above `USER_WALKING_SPEED`. **It does not check vigor first.** When this fires it looks exactly like
the bug we spent weeks debugging. t3 was at `vigor=62` during this session so it was not the cause
*this time*, but it is unguarded and will fire.

**Rule: never send speed 36 unless vigor is above 10, and treat "declared and did not move" as
"check posture and vigor" before "check geometry".**

---

## 4. A monster is the only honest speedometer, and it says we are not slow because of the server

A server-driven monster has no client, no prediction, no rate limiter and nothing of ours involved.
Its motion is what the server itself considers normal.

Measured with `M59_WATCH_MONSTERS=1` (added this session, `tools/m59-client.mjs`), **keyed by object
id**, in game:

| monster | packets | moving | gap between moving packets | ground per moving packet | squares/s |
|---|---|---|---|---|---|
| spider | 224 | 111 | 1048 ms | 1.16 | **1.05** |
| spider | 178 | 88 | 1051 ms | 1.25 | **1.05** |
| centipede | 45 | 9 | 4109 ms | 1.00 | 0.25 |

A later sample, same tool, monsters wandering rather than transiting: 0.21 squares/s at 1.00
ground/packet on a ~4.8 s cadence — **wandering monsters stop and turn; only a monster walking a long
straight line measures a speed.**

**What this establishes:** the server's own locomotion is ~1 square per packet on a ~1 s cadence,
which is the same shape as ours. It does **not** establish that 1 square per packet is a limit —
the player range probe (§2) shows 5 is accepted. Monsters are simply not using the envelope.

---

## 5. Where the fleet actually stands, and it is not a locomotion problem

Measured from the heartbeat ground counters at the end of this session:

| agent | median moving rate | state |
|---|---|---|
| t2 | **0.07 squares/s** | `path=null`, 5,566 sends |
| t3 | **0.07 squares/s** | `path=null`, 3,319 sends |
| t4 | — | `sends=0`, not moving at all |
| t1, t5 | — | have paths, low send counts |

**3% of the client's walk rate.** The stride engine is installed and *is* declaring 4.24–5.00 squares
(`stride-declaration` 2,261 sends, `no-path-stride` 1,110 sends), and the fleet still does not go
anywhere.

**The blocker is upstream of locomotion.** `path=null` with thousands of sends, and positions that
move forward then back (`1632,992 -> 1775,1021 -> 1696,992`) — the decider cannot hold a destination.
Known contributing defects, none of them in the mover:

1. **`findPath` returns one indistinct failure for a safety refusal.** It correctly refuses to route
   through room 555 (The Forest Shrine, acid gas, kills outright), and the decider reads that *safety
   refusal* as *stuck* and retried 20,173 times. Needs a distinct reason code.
2. **`t3` predicate bug:** `!in_underworld -> escape_underworld` fires while `uwdbg` prints
   `in_underworld=true` (with `clientRoomNum=null`).
3. **Destination thrashing** — the original diagnosis in this file's history: 13,619 destination
   changes against 244,021 sends.

---

## 6. Things believed for weeks that are FALSE. Do not re-derive them.

Each of these cost real time. They are listed with what disproved them.

| belief | false because |
|---|---|
| "Delete the step engine, keep the velocity engine" — or the reverse | Both are capped at 1 packet/s by the server (§1A). The choice between them cannot change the rate. Only ground per packet can. |
| "The server rejects our 5-square stride" | **284/284 declarations arrived** (§2). It never rejected one. |
| "The server adopts any declared position" | Overclaim. It accepts *range*; specific refusals observed were other causes. |
| "`CanMoveInRoom`/`CanMoveInRoomFine` are not on the movement path" | **kod IS the movement path.** `game.c:524` dispatches every in-game packet through `default:` to `ClientToBlakodUser`; `BP_REQ_MOVE` is handled in `user.kod:895`. Grepping only C is what made that negative look conclusive. |
| "The move handler is missing from the source tree" | It is kod, not C: `user.kod:895` -> `@UserMove` (`:2907`). `blakserv` is a transport layer. |
| "Room 557 is 48 rows per the server but 49 per the .roo" | `/room-view` returned `room.rows ?? 48`. **The client's room object has no `rows` field at all** (`m59-client.mjs:259`), so it printed a constant as a measurement. Fixed in `dad7ff5` with `dims_source`. |
| "The character is standing in a void" | He was in a *wall*: `coarse=true fine=false bsp_floor=present`. The probe was testing only the void case. 221 such squares in room 557. |
| "Monsters move at 16 squares/second" | **My instrument.** The stream was keyed by monster *name*; every spider shares one name, so a "step" was the distance between two different spiders. Keyed by `id`: 1.05. |
| "The server refuses 99% of our sends" | Also my instrument: I compared `srv` against `from`, and `from` **is** the previous `srv`, so they are equal by construction whenever the echo is not refreshed. |
| "The bake is corrupt" | Fresh parse of `e7.roo` vs the baked collision agrees at **1,234/1,234** floored square centres, zero disagreement either way. |
| "`col 54` is out of bounds in room 556" | Room 556 is **63x55**. Asserted without looking it up. |
| "A 44-square move happened" | I was driving t3 with a probe while his keeper held the connection. One connection per character: the probe bumped him and the broker rejoined him. |

**The pattern in that table is the actual lesson: nine of the eleven were our own measurement being
wrong, not the game.** Before accepting any number here, ask what the instrument would have to be
doing to produce it.

---

## 7. Instrumentation that now exists — use it instead of reasoning

| tool | what it settles |
|---|---|
| `tools/m59-range-probe.mjs` | **How far the server will carry us in one packet.** The only tool that asks the server rather than a local model. `--agent t4 --i-mean-it --range 8 --reps 3` |
| `tools/m59-move-probe.mjs` | Compares two *local* collision models to each other. Cannot say what the server does — that is its limitation, not a bug. |
| `tools/m59-motion-probe.mjs` | Same, local models only. |
| `tools/m59-void-scan.mjs --room N --probe c,r` | Every walkability predicate at a square, in the frame each API uses. Now reports **VOID** and **IN A WALL** separately. |
| `tools/m59-rate-live.mjs <log>` | Median moving rate over contiguous walking windows. Session-wide averages are meaningless — the decider rests the character. |
| `M59_WATCH_MONSTERS=1` | Streams every monster move packet with `id=`. Off by default: a monster emits several per second and would evict the 500-entry event ring. |
| `[void-probe]` in the mover heartbeat | Fires when a character stands on a VOID square or an IN-A-WALL square. |

### Reproducing the envelope number

```bash
# t4's mover must be idle (sends=0 in its mover-hb) or you are fighting the decider for the body.
node tools/m59-range-probe.mjs --agent t4 --i-mean-it --range 5 --reps 2
```

---

## 8. What to do next, in order

1. **Fix the decider, not the mover.** `path=null` with thousands of sends is the fleet's actual
   state. Give `findPath` a distinct reason code for a safety refusal and stop the decider retrying
   a lethal route. Until a character can hold a destination, no stride change is measurable.
2. **Guard the run.** Do not send speed 36 below 10 vigor (§3). This is a silent, log-only failure
   that looks exactly like the bug we spent weeks on.
3. **Then** raise `WALK_STRIDE_PROTO` from 160 toward the measured envelope, and re-measure with
   `m59-rate-live.mjs`. Do not do this before step 1 — there is nothing to measure until the
   character travels.
4. **Find the real distance ceiling** by running the range probe in a large room (556 is 63x55).
   5 is proven; the limit is unknown.

### And one thing that cannot be fixed

**We cannot read the server's log.** The fleet plays `76.214.42.186:5959`; there is no local
`blakserv`, and the Docker daemon is down. The server writes an `ALERT!` line for every accusation it
makes, and that is the only direct evidence of a refusal. Every "why" in this file is inferred from
the source tree, and the live shard may not be built from it. If a question needs the server's reason,
say so instead of inferring one.
