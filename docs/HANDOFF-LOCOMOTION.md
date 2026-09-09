# HANDOFF — m59-harness locomotion work

Written 2026-09-09 ~18:10 EDT, for someone picking this up cold.

Everything below was measured rather than guessed. Where I got something wrong I say so
and give the measurement that corrected it — that is most of the value in this document,
because I was wrong seven times on one question and each wrong answer would have produced
a plausible, shippable bug.

**One caveat up front, because it changes how to use this document:** several of the
headline figures below are no longer reproducible. I restarted the broker four times and
the keeper logs are truncated in place, with no archive — which destroyed the evidence
behind two of the three fixes. **§10 is a table marking, figure by figure, what you can
still check and what you have to take on trust.** The claims that are fully reproducible
offline — the pathfinding tables in §5.4, the suite counts in §7, the LOC in §5.1 — are
the ones to build on. If you disagree with a conclusion, re-measure it from those rather
than arguing with a number I can no longer produce.

**Read first, in this order:** `AGENTS.md` (traps, fleet invocation, shutdown),
`docs/MOVEMENT-ENVELOPE.md` (the server's actual movement rules + the probing traps
below), then this file.

---

## 1. State in five lines

- The mover sends **5.00 squares per packet** (median of 29,541 live packets) = **100% of
  the client's run rate**. Locomotion is not the bottleneck and was never the bottleneck.
  *(That figure is not reproducible — §10 — but the conclusion survives it, because the
  refusal fix in §3 changed a character from zero net movement to 1.30 sq/s without
  touching the locomotion model at all.)*
- The goal this work was framed around — "restore the velocity engine so the fleet moves
  at client speed" — **rests on a false premise.** The crawl was the *decider* and
  *retry loops*, both now fixed. See §3.
- **1,113 assertions pass** across 14 suites (§7). Four suites fail identically at
  `HEAD` and are pre-existing (§8).
- **The LOC reduction target is NOT met: 4,377 lines against a 2,933 baseline.** All of
  the growth is mine. This is the main open item (§5).
- Fleet is UP: broker pid 93426, 5/5 in game, fleet `default`. Four of five characters
  are travelling; t1 is still parked in a shop (§6).

---

## 2. What is live and working right now

| | |
|---|---|
| Broker | pid 93426, rpc `127.0.0.1:8901`, dashboard `:8902/fleet`, fleet **`default`** |
| Roster | `substrate/fleet-state.json` — 5 characters. **This file holds the only copy of the passwords.** |
| Keeper ports | 8911–8915, one per character, `GET /room-view` on loopback |
| Shard | `76.214.42.186:5959` — a **remote** shard. There is no local server to checkpoint. |

**Roster keys are not the in-game names.** t1=Gountrug, t2=Kage, t3=JayB, t4=Lee,
t5=Sasquatch. `is_self` in `/room-view` is correct and refers to our own character. I
lost significant time concluding "another player is blocking us" when it was us.

Invoke everything with `--fleet -` or after checking `node tools/m59-which.mjs`.
Restarting the broker **logs all five characters out and back in** — there is no
per-keeper restart; `/control/restart` spawns `m59-service.mjs restart` for the whole
service. I did this four times in this session; it is safe but slow (~80s to rejoin).

---

## 3. The premise was wrong, and what was actually wrong

The objective said: the fleet moves at ~40% of client walk rate because the step engine
integrates one square per packet, whereas the velocity engine would integrate five.

**Measured:** median **5.00 squares per same-room moving packet** across 29,541 packets
on the live shard. The engine already achieves 100% of the client's *run* rate. The
step-vs-velocity distinction was never a wire-format question either — `protocol.h:74`
`BP_REQ_MOVE` carries only `y, x, speed, room`. There is no velocity vector and no
declared time on the wire. Both engines send a position; they differ only in how far the
client integrated locally before reporting it.

Two real causes, both fixed:

**1. Rest share (`6811d2c`).** The travel-mode yield in the `healthy` and `vigor_low`
goals was dead code — a hunt journey never stamped `session._manualDest`, so the check
never fired and characters sat down mid-corridor. **Rest share 62% → 3%.**

**2. Retry loops with no memory (`9c35e82`).** A character spent 20+ minutes between two
adjacent squares while looking completely healthy on every instrument: perfect 1000ms
cadence, 111 sends in two minutes, 30 squares of ground covered, **net displacement
zero**. It declared the same refused step four times, the server refused four times, the
mover re-planned, the A* chose the same square again (it is the shortest route and every
predicate says it is walkable), and it walked back. Result:

```
n=746 at=480,480 srv=480,416  wp=7,7 stuck=0    declares (7,7), server at (7,6)
n=747 at=480,480 srv=480,416  wp=7,7 stuck=11   same declaration, no movement
n=748 at=480,480 srv=480,416  wp=7,7 stuck=22
n=749 at=480,480 srv=480,416  wp=7,7 stuck=33
n=750 at=480,416 srv=480,480  wp=8,8 stuck=0    gives up, walks back
```

After the fix, t3 walked from room 106 to room 593 — out of the inn and across the map —
48 distinct squares and 1.30 sq/s in the following four minutes, having managed zero
before.

**What the refusal fix does *not* do: explain the refusal.** Every predicate in the bake
said the step was legal — `fineWalkable`, `walkable`, `standable`, `moverStepLands`,
`stepAllowedByCollision`, `heightStepOk`, floor height 2048 on both squares — and an
adjacent square was legal in both grids. A neighbouring square existed that would have
taken the character around; it now takes it. But I could not identify *why* the server
refused. Candidates: a player standing there, a kod-driven fixture, a bake/live
disagreement. Nothing reachable distinguishes them. **I am reporting the mechanism as
unidentified rather than inventing an explanation.** If the contractor can get a
controlled repro (see §5.2), that is genuinely new information.

---

## 4. Commits in this session

Newest first. All are mine (`Costas Frost`), all on 2026-09-09. **100 commits since the
`e70dd99` baseline**; these are the ones that matter:

| | |
|---|---|
`cf5fb1f` | docs: the fleet crawls because of retry loops and rest share, not the locomotion model |
`9c35e82` | **fix(mover): remember a step the server refused** — refusal memory, +194 LOC |
`7426eaf` | **fix(decider): walk to a defensible square before sitting** — rest-spot policy |
`6811d2c` | **fix(decider): hunt journeys never entered travel mode** — the 62%→3% rest fix |
`e2c128a` | fix(mover): escape fan's probe was 16 units and could never leave its square |
`492bc63` | fix(mover): `_routeAhead` must not offer the square we are standing in |
`0ab0995` | instrument: `M59_SIM_TRACE=1` prints Pose track around the send |
`d78e615` | tool: `m59-continuity.mjs` — measures PAUSES, which every speed number here was blind to |
`acd78ab` | fix(broker): `KeeperProxy.recorder` null — successful travel reported an error |
`b77bafa` | fix(travel): `KeeperProxy.travelJob` — the tool was broken for every keeper-backed agent |
`b857a05` | docs: the rosters hold the passwords, not `fleet-accounts.json` — two docs said otherwise |
`69f7779` | ignore `substrate/credential-backup/` — a password backup was one `git add` from the remote |

Earlier, also mine and load-bearing: `6631bb8` (the mover only ever asked for the STRICT
pathfinding tier — the coarse-tier fallback), `5ab0e26` (Marion ping-pong / kod teleport
corners), `5375d1e` (`[to-accepted]` logging), `81b1559` (waypoint quantization,
1.75→2.18 sq/s), `092b8c9` (cadence 1050→1000ms), `0c6d23f` (`[move-sent]` counted
ATTEMPTS not sends — every rate taken from the logs before that commit was wrong).

Two bugs found *inside my own change* and fixed in the same commit, worth knowing about
because both are the kind that pass review:

- **The regen poke returned without resting** when no adjacent square was steppable.
  **8,254 occurrences on one keeper log.** A hurt character standing in a doorway not
  healing, forever, with the decider reporting no action at all — which is why the
  dashboard showed idle characters at low HP with no explanation.
- **My per-room budget reset handed back the whole allowance in every room**, so a hurt
  character crossing five rooms could stop 180s in each = 15 minutes on one journey,
  while every individual stop reported itself within budget. The legacy zeroes only at
  trip start (`m59-autopilot.mjs:5176`) and end (`:5272`).

---

## 5. OPEN WORK — in priority order

### 5.1 LOC reduction: 4,377 against a 2,933 target — NOT MET

`tools/tick/m59-mover.mjs` + `tools/tick/m59-route.mjs`:

| commit | mover | route | total |
|---|---|---|---|
`e70dd99` (baseline) | 2,012 | 936 | **2,948** |
`2546016` | 2,471 | 941 | 3,412 |
`6811d2c` | 3,228 | 955 | 4,183 |
`9c35e82` (HEAD) | 3,422 | 955 | **4,377** |

**Where the mass actually is, measured:** `m59-mover.mjs` is 3,423 lines =
**1,410 code + 1,939 comment + 74 blank**. At the baseline it was 2,013 = 1,067 code +
895 comment. So the comment:code ratio went **0.84:1 → 1.38:1**. Code grew +343 lines;
comments grew +1,044.

This matters for how to approach the target, and I want to be direct about the tension:
the comments are deliberately long because this codebase has a specific failure mode —
every trap in it is a *silent wrong answer* (see §9), and the comments exist to stop the
next person re-deriving what I spent a day on. Stripping them to hit a number would
destroy the thing that makes this file safe to work in. **I have not attempted the
reduction and I did not want to leave it looking done.**

What I would actually recommend, in order:

1. **Delete instrumentation, not comments.** `[movedbg]` alone is **647,259 lines** in
   one keeper log and `[movestuck]` 633,237. There are ~15 debug emitters in the mover.
   Several were diagnostic scaffolding for questions that are now answered (the
   `simSrc=` field, `[geo-id]`, `[aim-dbg]`, `[path3d]`, `[routedbg]`, `M59_SIM_TRACE`).
   That is real, safe line reduction and it also reduces the log volume that is currently
   making the logs hard to read.
2. **The two engines.** The step engine and the velocity engine both still exist. If the
   velocity engine is the only model the real client has (it is — `move.c:374` stops at
   the wall and reports), the step engine may be dead weight. Verify with tests before
   deleting; do not repeat my original mistake, which was deleting the *velocity* engine
   on the reasoning that the step engine "arrives in 11 sends". That reasoning was wrong
   and it was corrected.
3. **Then** consider comment compression, keeping every "why", cutting every "what".

**Do not** count comment deletion as a win without re-running §7. Several tests assert
on log substrings.

One concrete lead: **13 distinct debug emitters** live in `m59-mover.mjs` (`movedbg`,
`movedbg-gate`, `movestuck`, `move-sent`, `path-null`, `path-install`, `aim-dbg`,
`path3d`, `routedbg`, `coarse-tier`, `geo-id`, `geo-mismatch`, `void-probe`, `mover-hb`,
`tick-state`, `step-refused`). Of these, `step-refused` and `move-sent` are load-bearing
— `step-refused` is the only thing that proves refusal memory is working, and `move-sent`
is the only faithful speed instrument. The rest were scaffolding for questions that are
now answered. Removing the scaffolding is the cheapest honest reduction available.

### 5.2 Controlled repro for a refusal

The refusal fix cures the ping-pong but not the mystery. To identify the cause you need
to send a move and observe the server while knowing exactly what is in the room —
`/room-view` gives you the object list, `M59_MOVE_DEBUG` gives you the declares. Best
target: t1 (Gountrug), which has been parked in room 201 for the whole session and is
the least disturbed character. Note `m59-range-probe.mjs` **refuses to drive a live
character without `--i-mean-it`**, and doing so needs its own connection, which **bumps
the keeper off** (one connection per character). That guard is correct; do not fight it
— use a character nobody minds.

### 5.3 goExits routing — 135 of 264 rooms (51%) are unreachable

**Confirmed, still completely undone.** `grep -c "goExits\|arriveRow" tools/tick/m59-route.mjs`
returns **0**. The router never reads door exits at all.

Room 106 (Brownestone Inn) is the example: `edgeExits: []`, and its only way out is a
door at 1-based `(row 17, col 12)` → room 101, `arriveRow 18, arriveCol 26`,
`angleChange 12`. Ten other doors in that room are `locked: true, to: -1` (cupboards).
**A router that cannot read doors will route a character into a room it cannot leave.**
This is very likely the upstream cause of "the decider gives unreachable destinations",
which was diagnosed earlier as a decider fault and is at least partly a router fault.

### 5.4 The strict pathfinding tier is unusable as a default

`finePathProtocol` with `coarse: false` requires **both** squares of every edge to be
coarse-walkable. Measured, in every room the fleet uses:

| room | dims | fine-walkable | of which NOT coarse-walkable |
|---|---|---|---|
| 106 | 20x21 | 373 | 208 = **56%** |
| 534 | 54x56 | 2,808 | 2,317 = **83%** |
| 556 | 55x63 | 3,201 | 2,432 = **76%** |
| 557 | 49x50 | 2,097 | 1,036 = 49% |
| 382 | 76x67 | 4,937 | 2,426 = 49% |

From where t3 stood in 106, the strict tier reaches **2 squares**. It reports
`no fine path, expanded=116` — a constant, because the search is deterministic and
always exhausts the same pocket.

My fix was a **coarse-tier fallback** (`6631bb8`), which works: strict fails, coarse
finds 11–12 waypoints, and the character navigates. But the fallback runs **on every
plan** in these rooms — 8,347 coarse re-plans in 13 minutes on one keeper. Given the
table above, **the coarse tier should probably be the primary tier and strict the
opt-in**, which would delete a whole re-plan cycle. Worth a decision from someone who
knows why strict was the default; I could not find a reason that survives this data.

### 5.5 Current HP is not observable

`hp=` appears in keeper logs **only** as `max_hp=` at level-up. `[tick-alive]` carries
no vitals. The `status` MCP tool returns **`error: keeper-backed: pacer is in the keeper
process`** for all five characters. Consequence: **I could not prove that any character's
HP recovers**, which is the whole point of the rest-spot feature. I verified the
*decisions* are correct (walk to spot → arrive → rest) and the budget arithmetic, but
not the outcome. If you can only do one thing from this list, consider this: without
vitals in the log, every recovery claim is unverifiable.

### 5.6 Two suites test private methods that no longer exist

`m59-takeSafeSpot-test.mjs` (8 failures, `_takeSafeSpotCheckNoWall`,
`_takeSafeSpotAllBarren`) and `m59-roam-test.mjs` (11 failures, `_roamShouldGoHome`).
Pre-existing, failing identically at `HEAD`. Also `m59-goap-test` and `m59-travel-test`
throw on load. Stale, not regressions, not mine, and I left them alone deliberately.

---

## 6. Live fleet state at handoff

```
t1 Gountrug  port 8911  room 201 Ye Olde Slasher Salesman   at 4,7    <- parked all session
t2 Kage      port 8915  room 382 West Jasper                at 25,37
t3 JayB      port 8912  room 382 West Jasper                at 25,40
t4 Lee       port 8914  room 557 The Sweet Grass Prairies   at 26,31
t5 Sasquatch port 8913  room 382 West Jasper                at 56,7
```

Three characters in room 382 = they are travelling together, which is normal. t1 has not
moved all session and is the natural test subject.

Keeper ports are assigned per process and **will change on the next restart** — do not
hard-code them. Re-read them from `lsof -nP -iTCP -sTCP:LISTEN | grep node` (they are
8911..8915 while broker pid 93426 is up), and confirm which character is which from
`/room-view`'s `room_name` plus the `is_self` object's `name`, not from the port number.

The keeper's `/room-view` is the only live view of a character that works. The MCP
`status` tool does **not**: it returns `error: keeper-backed: pacer is in the keeper
process` for all five. See §5.5.

**Untracked files I created** (all verified credential-free, left in place):
`substrate/range-probe.json`, `substrate/void-556.txt`,
`substrate/m59-safespots.before-retest.json`. `.obsidian-vault/` and `buy` are not mine.

---

## 7. Test suites — run these

```
node tools/m59-mover-test.mjs         207      node tools/m59-safespot-test.mjs      183
node tools/m59-decide-test.mjs         98      node tools/m59-cast-test.mjs           65
node tools/m59-escape-test.mjs         87      node tools/m59-travelguard-test.mjs    33
node tools/m59-rest-test.mjs           51      node tools/m59-rest-spot-test.mjs      36
node tools/m59-pose-test.mjs           74      node tools/m59-locomotion-test.mjs     27
node tools/m59-route-test.mjs          53      node tools/m59-ledger-test.mjs         30
node tools/m59-tick-test.mjs           41      node tools/m59-chat-test.mjs          128
                                              TOTAL                              1,113
```

All offline, no live server needed, safe any time. There are **154** `tools/*test*.mjs`
files in total; the above are the ones this work touches.

---

## 8. Pre-existing failures — do not blame yourself

`m59-takeSafeSpot-test` (8), `m59-roam-test` (11), `m59-goap-test` (throws),
`m59-travel-test` (throws). **Verified failing identically at `HEAD`** via a clean
worktree. I did not touch them.

---

## 9. How to not fool yourself here

This is the section I would write if I only got to write one. Six of my seven
hypotheses about one two-square pin were disproved by **my own probing errors**, each of
which produced a confident, wrong, shippable answer.

**Coordinate traps.** All four of these bit me:

- `fineWalkable` / `walkable` / `standable` take **`(row, col)`**, not `(col, row)`.
  Reversed arguments return a real boolean **about a different square** — no error, no
  undefined, just wrong. This is the easiest mistake in the codebase because everything
  on the wire is `(x, y)`.
- `client.self.col/.row` are **ZERO-based**; the geometry API is **ONE-based**. The mover
  compensates with `_c1 = _me.col + 1`. Forgetting it shifts every answer one square on
  both axes.
- `heightStepOk(r0, c0, r1, c1)` takes **FOUR SCALARS**. With two `{row,col}` objects it
  reads `h1 == null` and returns `false` — which looks exactly like "the height refuses
  this step". It was an arity error.
- `traceFineMoveClient` is **CLIENT UNITS (1024/square)**, not KOD units (64/square).
  Passing KOD coordinates asks about square 0. I produced a map showing 250 of 373
  squares as "void" this way. It was nonsense.

**Predicate traps.**

- `slide` **defaults to TRUE** in `traceFineMoveClient`. With it on, a legal step returns
  `blocked: true, slid: true` because the trace slid along the wall instead of entering.
  The mover passes `slide: false` at all four call sites; a probe that doesn't is
  measuring a different thing.
- `geometryFor` **exists twice**. `m59-safespots.mjs`'s returns a geometry with **no
  `roomNum`**; `m59-roo.mjs`'s `sharedRoomGeometry` sets `roomNum` from the map record.
  Offline probes importing the first cannot reproduce the live process, and will print
  `roomNum: undefined` for a room the log prints a number for.
- **`aim=` in `[move-sent]` is NOT the declared position.** It is `destProto` — the route
  destination — at three of the four `_recordSend` call sites. Reading it as a packet
  makes every send look like a 12-square lunge past the envelope limit. **Read `at=`.**
  I made this error and "proved" the mover was over the speed limit.

### Reference sources, with exact paths so you can check my work

I cite these by short name throughout and in `AGENTS.md`, which is not kind to whoever
comes next. The real paths, all verified by opening the file at the cited line:

| short name | actual path | what is there |
|---|---|---|
| `protocol.h:74` | `clientd3d/protocol.h` | `ToServer(BP_REQ_MOVE, …)` — carries **only** y, x, speed, room. No velocity vector, no declared time. This is why "velocity vs step" was never a wire-format question. |
| `move.c:374` | `clientd3d/move.c` | on `MOVE_BLOCKED`: `x = last_x; y = last_y; z = last_z; bounce = false; break;` — **the real client stops at the wall and reports that position.** It never declares past one. |
| `move.c:49-57` | `clientd3d/move.c` | `MOVE_DELAY 100`, `NUM_STEPS_PER_SECOND 200`, `STEPS_PER_MOVE 20`, `MOVE_INTERVAL 1000`. Our `MOVE_CAP_MS = 1000` matches `MOVE_INTERVAL`; the old 1050 was folklore. |
| `user.kod:2907` | `kod/object/active/holder/nomoveon/battler/player/user.kod` | `@UserMove`. **Not** `server/blakserv/user.kod` — that path does not exist. |
| same file, `:61` | as above | `MOVEMENT_COUNT_THRESHOLD = 2` — "If piMovesCount goes over this, we have a suspected speedhacker." This is why one packet/second is the contract and 1000ms cadence is safe (the counter stays at 0). |

**And the one that cost the most: a green test count is not evidence that anything ran.**

Twice in one session a suite reported success while skipping tests entirely:

1. `m59-decide-test.mjs` passed unchanged across **three different versions** of my
   change, because its rig has no `world.geometry` — so `restSpotFor` always took its
   no-geometry path. A suite that cannot see a change cannot review it.
2. `m59-mover-test.mjs` had a **premature `process.exit` at line 2083**. I appended 8
   tests, ran the suite, got `199 passed`, and **the tests were not in the output.**

**When you add a test, grep for its name in the output.** Do not trust the count.

## 10. Which numbers in this document you can still check, and which you cannot

**I overwrote my own evidence.** The keeper logs are written in place, and I restarted
the broker four times during this session. There is no rotation, no archive, and no
saved copy — I checked. So several headline figures below were measured honestly and
**can no longer be reproduced**. Treat them as reported observations, not as
verifiable claims, and do not build on them without re-measuring.

| figure in this doc | status |
|---|---|
| `healthy->rest` was **369 of 595 decisions** | **NOT REPRODUCIBLE.** Same log, now: 3072 of 71,388 = **4%**. That is the *post*-fix number, and it is the strongest evidence the travel-mode fix worked — but the 369/595 measurement itself is gone. |
| regen-poke bug: **8,254 occurrences** | **NOT REPRODUCIBLE.** Now 9 in the current log. The bug is fixed, so a low count is expected and proves nothing either way. |
| `movedbg` **647,259 lines** | **STILL CHECKABLE, and growing:** 649,627 now. `grep -c '\[movedbg\]' substrate/keeper-t3.log` |
| median **5.00 squares per packet**, 29,541 packets | **NOT REPRODUCIBLE from logs.** Re-measurable on the live shard with `tools/m59-range-probe.mjs` (needs `--i-mean-it`, and see §5.2 on the connection conflict). |
| refusal fix: t3 room 106 → 593, **48 squares, 1.30 sq/s** | **PARTIALLY CHECKABLE.** `step-refused` appears 4 times in the current log, and `curl 127.0.0.1:<keeper-port>/room-view` shows the character travelling. The 4-minute window itself is gone. |
| strict-tier pocket tables (§5.4) | **FULLY REPRODUCIBLE offline** — computed from the baked map, no live server, no logs. This is the most trustworthy data in the document. |
| suite counts (§7) | **FULLY REPRODUCIBLE.** Run them. |
| engine LOC (§5.1) | **FULLY REPRODUCIBLE** from git. |

**Practical advice for whoever picks this up: save your evidence before restarting.**
`cp substrate/keeper-*.log /tmp/` before `m59-service.mjs restart`. One restart cost me
the primary evidence for two of the three fixes in this handoff, and I only noticed when
writing this section. Consider it a standing trap: **the keeper logs are the only record
of what the fleet actually did, and a restart destroys them silently.**

### One thing worth adding while you are here

The logs are also the reason the two-square pin took so long to read: 649,627 `[movedbg]`
lines against 40,643 `[move-sent]` lines in the same file, so the signal is 6% of the
volume and `grep` on a large log gets slow. `movedbg` is per-tick and per-candidate;
`move-sent` is per-packet. If you reduce LOC per §5.1, `movedbg` is the first thing to
go and it improves both problems at once.

---

## 11. Constraints I was given, and which ones held

One constraint needs more than a checkmark, because a bare "held" would be misleading
and the way it was actually satisfied is a warning.

**`m59-game.mjs` and `m59-autopilot.mjs` were both modified, then reverted.**

```
ddf41a8  +72 m59-game.mjs      +5  m59-autopilot.mjs
0705306   -72 m59-game.mjs      -5  m59-autopilot.mjs
```

Net across the range is zero and both files are **byte-identical to the baseline**
(`git hash-object` on `e70dd99:` vs `HEAD:` agrees for each). So the constraint holds at
handoff — but it did not hold on the first attempt, and the reason it came back is worth
knowing: the work in `ddf41a8` put destination-ownership logic into the legacy keeper,
and `0705306` found that the guard **refused the owner its own re-aim, which froze the
fleet**. The fix belongs in `tools/tick/`, which is where it now lives. If you are tempted
to add behaviour to the legacy files again, that experiment has been run and it froze
every character.

The useful thing I got from reading them, without changing them: the legacy already
names the failure mode I spent hours chasing. `m59-game.mjs:3417` returns
`position_outside_room_geometry` with the note that the character is "standing outside
the bounds of the room geometry loaded for it — the two are almost certainly different
rooms, which is a room-change race and not a hole in the map". It turned out **not** to be
our bug here (the geometry matched; `geo-id` in the log proves it), but the vocabulary
already existed and I had not read it.

| constraint | status |
|---|---|
| `m59-mover.mjs` + `m59-route.mjs` smaller than 2,933 LOC | **NOT MET — 4,377.** §5.1 |
| Do not modify `m59-game.mjs` or `m59-autopilot.mjs` | **HELD IN NET, NOT ON FIRST ATTEMPT — read the note below.** Both files are byte-identical to the baseline right now, and I verified that by hash, not by hoping. |
| Never commit fleet-written state | **HELD.** Verified no commit contains `fleet-state`, `fleet-accounts`, `credential*`, `history/`, `recordings/`, `commissions/`. |
| Prefer offline tests | **HELD.** All 1,113 assertions are offline. |
| Live characters are the test harness | **HELD.** t3 is the character that proved the refusal fix. |
| One move packet/second is the server's contract | **HELD.** Cadence 1000ms, `MOVE_CAP_MS`. Distance per packet is the only lever (5 squares proven). Sending faster is logged as a speedhack (`user.kod:2907`). |
| Speed measured point-to-point, not session-wide | **HELD**, and it was the correction that reframed this whole goal. Session-wide averages include combat and resting and told us the engine was 3× slower than it is. |
| Travel mode active for *any* journey | **HELD** (`6811d2c`). |
| Rest budget per journey, not per room | **HELD** — after I wrote it per-room and a test caught the consequence. |

---

## 12. If you want one number to beat

**1.30 sq/s net** is what t3 achieved after the refusal fix. The client's run rate is
**5.00 squares/packet × 1 packet/s = 5.0 sq/s** of *declared* ground, but net progress
across a real journey is bounded by turns, room transitions, and the decider. Getting
sustained net rate up is now a **routing and decider** problem (§5.3, §5.4), not a
movement problem.
