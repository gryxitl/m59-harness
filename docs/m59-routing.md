# Movement, collision and routing

Split out of [`CLAUDE.md`](../CLAUDE.md). Read this before touching `m59-movement.mjs`, `m59-routes.mjs`, `m59-roo.mjs`, `m59-routebake.mjs` or the mover inside `m59-broker.mjs`.

## The collision map is EVIDENCE ABOUT A SERVER, NEVER AUTHORITY OVER ONE

`substrate/m59-map.json` carries baked BSP, sidedefs, sector heights and wall chains, and
the broker validates every in-room move against them with the same rules the stock client
uses — because the server accepts whatever coordinates you send and expects the CLIENT to
enforce collision. Using the server as a collision oracle is how bots walked through walls.

**A move that cannot be validated is refused, not retried.** `TERMINAL_MOVEMENT_REASONS`
in `m59-movement.mjs` is the closed list of failures that no other heading can fix —
`collision_geometry_unavailable`, `room_geometry_mismatch`, `room_security_unknown` and the
rest. They propagate instead of looping, which is what stops a bad route being learned.

### THE ROUTER HAS TO PLAN ON THE MAP THE MOVER ENFORCES, AND THE TWO ARE NOT THE SAME MAP

The mover validates against the client's BSP; the router planned on the server's coarse
one-byte-a-square grid. A router planning on a different map from the one the mover
enforces does not produce a wrong route — **it produces a character sliding along a wall,
replanning into the same wall, and giving up.** The trail reads
`4,15->5,15=5,15` / `5,15->4,16=4,15`, over and over, eight times, then "kept ending up
somewhere other than the planned square". Measured offline against the twelve boundaries
`m59-exitgap.mjs` complains about most, **that killed 59% of all walks to an exit**; on
prod it killed characters, who bounced between two squares in the Western border of the
Twisted Wood with spiders on them.

**THE PREDICATE THAT LOOKS RIGHT AND IS NOT.** `stepAllowedByCollision` asks whether the
straight line between two square CENTRES arrives exactly, with no sliding. That is a fair
question about a line and the wrong one about a character: the player is a disc of radius
248 in a square of 1024, so a centre within a quarter-square of a wall is a place nobody
stands, and a person walking that corridor never tries to. Asked that way, room 150 comes
out in 159 disconnected pieces and room 578 in 214 — which is why collision-aware routing
was measured, disbelieved and switched off.

**`moverStepLands` is the question that decides anything**: what `validateFineTarget` will
actually do — aim at the centre, SLIDE, quantize toward the start, and land IN the target
square, because `walkTo` compares squares. Same rooms: 150 in 15 pieces with 96% in one,
578 in **two** with 99.4% in one. `protocolToward` is exported from `m59-roo.mjs` so the
planning half and the sending half cannot drift; the test compares them directly.

Three things hold this up and each fails in the dangerous direction if inverted:

- **The mask is what makes it affordable, and it is baked offline.** `buildStepMask` is one
  byte a square, one bit a direction, in `STEP_MASK_DIRS` order — which may never be
  reordered, because a mask read against a different order is a confident map of the wrong
  doors and nothing downstream can detect it. `node tools/m59-routebake.mjs` writes it,
  `attachStepMasks` in `m59-routes.mjs` hands it to the geometry at broker start, and
  `path()` then defaults to `collision: this.hasStepMask`. **No table means the coarse grid,
  exactly as before** — a checkout that has never run the bake behaves precisely as it did.
  Running the trace live is what caused the rejoin storm: 0.44ms a pair, tens of thousands
  of pairs, on the one event loop twenty-one sessions share.
- **`walkTo` learns the EDGES it is refused, not the squares.** A wall sits between two
  squares; blaming the square removes a good place to stand that other neighbours reach,
  and a step that SLID recorded nothing at all, which is what made the bounce eternal. The
  edge is attributed from where the step was ASKED, never from where it landed — a slid
  step ends at neither end of the step it requested, and blaming the landing square blames
  an edge nobody tried. `object_blocked` is treated as the opposite fact: **a monster moves
  and a wall does not**, so only the first is worth waiting 700ms for.
- **The mask may only ever PREFER.** It is a model of somebody else's server and it is
  stricter than the world — on room 579's north boundary it offers no reachable staging
  square at all from 19 of 35 starting squares. So `exits()` floods twice and falls back to
  the coarse answer, flagged `grid_only`, rather than dropping the exit; `walkTo` relaxes
  occupancy first, then refused edges, then the collision view. **A bake must never be the
  reason a doorway disappears.** Being wrong about a wall costs a walk; refusing costs the
  errand, silently.

**AN ANCHOR BELONGS TO A DESTINATION, NOT TO A DIRECTION — AND GETTING THAT WRONG DOES NOT
FAIL, IT ARRIVES SOMEWHERE ELSE.** One wall can carry two exits to two different rooms,
split by a row or column condition. Western border of the Twisted Wood declares
`east -> 586 row<19` **and** `east -> 597 row>20`: the same boundary, and which room you
reach depends on where along it you step off. `exitAnchors` asked
`edgeApproachCandidates(dir)` — the per-DIRECTION question — took the first square offered
and gave **both** exits the anchor `9,67`, which satisfies `row<19`. So a character asked
to walk to The Twisted Wood was routed to a square that puts it in Main gate to the city of
Tos. Every leg reported success. Nothing downstream compares where a walk MEANT to go with
where it went, so this is invisible from the trail, from the board and from the logs — it
shows up only as a character that is somehow in the wrong town, and then as a journey that
re-routes from there for ever.

The per-exit question already existed and the bake was reaching past it. `edgeCandidatesOf(room, e)`
runs `selectedEdgeAt`, which simulates `StandardLeaveDir`'s own ordered scan of
`plEdge_Exits` — and that scan is why testing the one condition in isolation is not enough:
a default entry is remembered but does **not** stop the scan, so a square can satisfy a
condition and still lose to a later unconditional edge. The world model had always used it.

Two things pin it, and the second is the one that is not derived from the same `.roo` the
anchors came from. `m59-routing-test.mjs` asserts that crossing AT an anchor fires the exit
it was baked FOR — **273 on-boundary anchors, and the assertion is about the destination
rather than about arriving**, because arriving was never the symptom. And
`substrate/m59-crossings.json` records where a real client actually crossed and what room it
turned up in: **25 recorded crossings, 25 agreements, 0 disagreements**. Ranking in
`exits()` is observation first, baked anchor second, derivation last, for that reason.

**AND THE BAKE IS NOT ABOUT PLANNING COST — MEASURE BEFORE BUILDING A TABLE TO AVOID ONE.**
The natural reading of "why should getting from one exit to another take any real-time
planning" is that planning is expensive. It is not: measured on this map with masks
attached, `path()` costs **0.28 ms in room 587, 0.46 ms in 545 and 1.06 ms in The King's
Way** — and that was while a full bake was saturating the CPU. A flow field per anchor
would have bought about a millisecond a room for several megabytes. What the table is
actually worth is **correctness** (the anchor above), **proof** (which exits the room's body
can genuinely reach, which `steps` only guesses at) and **a cost that can be compared** —
`transitCost` prices a room crossing in PIVOTS rather than squares, because a client reports
position about once a second, so pivots are packets are seconds. The same six routes in 587
are 311 squares and 66 pivots: charging squares overstates a trip 4.7x and does it
*unevenly*, so ranking routes on square count prefers exactly the rooms that walk slowest.

**A SAFE SPOT IS THE LAST THING WORTH ROUTING THROUGH, AND A* DOES NOT KNOW THAT.** With a
flat step cost the router is indifferent between the middle of a gap and the tight side of
it, so it threads characters along the wall — where a step SLIDES, the mover lands somewhere
the plan did not expect, and the walker starts the bounce above. `clearanceField` adds cost
by how much of a square's step ring the MOVER refuses, measured off the baked mask because
the coarse grid calls the tight side of a gap open and agreeing with it here is how the plan
and the walk come apart. Measured on this bake: mean blocked neighbours per step across
random routes goes **1.35 -> 0.72 in room 587**, 1.28 -> 0.49 in 597 and 0.23 -> 0.05 in 544,
for 6-8% more steps.

**AND IT IS OFF UNLESS THE CALLER ASKS, BECAUSE A SAFE WALL IS A TIGHT SQUARE BY
DEFINITION.** This is the one setting in the router that can quietly teach the fleet out of
the game's central defensive mechanic, and it did: `world.reach` measures how far a wall is
and `nearestSafeSpot` ranks candidates at **-0.5 a step**, so with the preference on
everywhere it became a penalty ON THE SPOT ITSELF. Measured against the recorded book,
**36.7% of walks to a held safe wall came back longer, worst case +9 steps — 4.5 points
against a proof bonus of 20** — and it fell hardest on the walls that are hardest to walk
into, which are the best ones. So `path` and `clearanceField` both default to weight zero,
`leaveVia` opts in at 0.6 because crossing a room to a boundary is the long routing where
the wedge happens, and every tactical question — `world.reach`, `approachSquare`, a pull, a
melee approach, a walk back to a held wall — plans exactly as it did before any of this
existed. Three further properties: it is **cost, never a prohibition**, so a route that only
exists through a tight gap is still taken; **the destination is exempt**, because walking to
a wall corner is the whole point; and **no mask means no field at all**.

**AND THE BAKE'S "REGIONS" ARE THE SAFE SPOTS.** They are strongly connected components
now, not a flood fill, and a room coming out in ninety pieces is one body of floor plus a
scatter of corners the BSP hems in — the same geometric fact the safe-spot book measures
from the other side. Do not smooth them away to make the count look tidy. What the old
flood could not say, and this can, is the difference between a pocket you can leave but not
enter and one you can enter but not leave; for routing one is a trap and the other a
detour, and for a safe spot only the second is worth walking to. **"Outside the main body"
is not "cannot be walked to"** — a doorway is a pocket by design, which is why an exit
anchor is chosen from a staging square the body can REACH rather than the first one the
boundary publishes, and why the report says "go and look before believing it".

**THE CRAGGED MOUNTAINS CLIFF, STATED AS THE MECHANIC RATHER THAN AS A DIRECTION.** Enter
578 from The King's Way and you are at the BOTTOM: the other exits cannot be walked to at
all. Casting **blink** inside the room puts you on TOP of the cliff, and from up there every
exit is freely reachable. So the one-way is **north to south**, and it is one-way only for a
character that cannot blink — which is what "joined only by blink" always meant.

Walked by the operator 2026-08-17, in both directions: from the southern exits you CAN walk
north; from the north exit you cannot walk south.

**CORRECTION, same day, to a correction: an earlier version of this paragraph said the blink
note was wrong. It was not** — blink up the cliff is exactly the mechanic. What was wrong
was the claim that this is **"the one place in the world"**: the operator also names Ukgoth,
Under the shadow of the Sentinel, the Cragged Mountains/Ukgoth border and the Underworld.

**AND IT IS A CAPABILITY, NOT ONLY A GEOMETRY.** A route through this room from the north
is passable for a character holding blink and impassable for one that is not, so "can this
fleet walk King's Way -> Cragged -> An ancient place" is a question about the CHARACTER.
Nothing in the router asks that today.

**WHY THE MODEL LETS A BOT CLIMB IT: `MAX_STEP_HEIGHT` HAS EXACTLY ONE ENFORCEMENT SITE AND
IT IS INSIDE THE WALL TEST.** `canCrossWallAt` returns TRUE immediately for a null sidedef,
and at this face there is no sidedef — the wall there begins at z 4800, the TOP of the drop,
and runs up to the ceiling, so nothing at all spans the 1600 units between the 3200 floor
and the 4800 one. It is a bare discontinuity between two sectors. No wall is crossed, so no
height is ever checked, and `moverStepLands` says yes to a 1600-unit climb against a limit
of 384.

`traceFineMoveClient` takes `enforceStepHeight`, **off by default**, which adds the missing
check per microstep. Switched on it gets 578 exactly right — north exit reaches nothing,
southern exits still walk to it, 13 regions. It is off because it also refuses SLOPES, which
are continuous legal climbs: 3 controls in `m59-collision-test` and 1 in
`m59-impossible-test` break, all of them legitimate moves, and 578's routing view fragments
to 146 pieces. Narrowing it to a sector CHANGE is the right idea and does not fire, because
the microstep resolver reports no transition at that face. **The consequence of leaving it
off is known and bounded**: the router offers a walking route out of the basin that only a
character with blink can take.

Measured, so a fix can be judged: across 235,701 legal steps in ten rooms, 98.34% rise no
more than `MAX_STEP_HEIGHT` in any microstep, 1.66% would be refused, and almost all of
those are in 578. And the Underworld — which climbs hundreds of units and is entirely
legitimate — profiles as many small steps (2176 -> 2560, 3360 -> 3680), while the Cragged
Mountains face profiles flat at 3200 for seven eighths of a step and then 1600 in one. That
contrast is the signal any real fix has to key on.

**ONE-WAY COMES IN TWO KINDS AND ONLY ONE OF THEM HAS A HOME.** A link between two ROOMS
is recorded in `substrate/m59-oneway.json` and honoured by `passableExits` in
`m59-map.mjs`. A one-way *inside* a room cannot be expressed there at all, and room 578 is
that second kind: `path()` plans straight down the cliff, 48 steps from the north exit to
the southern ones, on a route that contains a **+1600 climb and four 1600-unit drops
against a `MAX_STEP_HEIGHT` of 384**. Terraces, walked like stairs. That is a live routing
bug — a character sent that way gets a confident plan it cannot execute — and it predates
the standable/stand-point work, which only made the same wrong route shorter.

**THE TABLE IS COMMITTED, AND THE ARGUMENT FOR THAT IS THE MANIFEST.** It used to be
gitignored on the grounds that it is "regenerated in seconds, so it is build output" and
that "a committed copy is actively misleading the moment the map is rebaked". The first
half is simply false — it is **about thirteen minutes** on this machine — and the second
half is backwards: the table carries `geometryManifestSha256` and is **refused outright**
when it does not match, so a stale committed copy is inert and says so
(`[routes] planning on the coarse grid — the routing table was baked from different
geometry`). What is genuinely misleading is its ABSENCE, which is silent and puts a fresh
clone straight back into walking into walls. `substrate/m59-map.json` (27 MB), `m59-spawns.json`
and `m59-items.json` are all committed derived data already; this is 1.4 MB of the same kind,
and it is regenerated in the same breath as the map it comes from.

```bash
node tools/setup.mjs routes        # bake it; `all` runs this, before the broker
node tools/setup.mjs doctor        # says whether the table on disk carries masks
node tools/m59-routebake.mjs --resume    # after a killed bake: keeps what is on disk
node tools/m59-routes.mjs                # what is baked, and whether it matches the map
node tools/m59-routes.mjs --verify       # re-walk every baked route
```

**A STALE TABLE IS NOT ALWAYS A STALE MAP, AND THE MANIFEST CANNOT TELL YOU.** It hashes the
GEOMETRY. When the anchor-SELECTION code changes, a table baked by the older code passes
every check here and is confidently wrong about where a doorway is. That is not
hypothetical: Ukgoth's north anchor to Outside Castle Victoria was baked at row 1, col 62 —
five grid-walkable squares with no coarse-grid connection to the room's other 1,679 — while
the current code answers 2,26, the operator's real doorway. Rebake after touching
`exitAnchors`, `edgeCandidatesOf` or `neighbors`; nothing will remind you.

Three more offline tools, and each answers a question the others cannot:

```bash
node tools/m59-walksim.mjs --cycle       # will the WALKER get stuck — the mover, not the router
node tools/m59-clipsweep.mjs --anchors   # doorways only a clip can reach
node tools/m59-falljump.mjs              # the jumps somebody walked and wrote down
```

`m59-walktrial.mjs --plan-only` asks whether a ROUTE EXISTS and is essentially perfect from
ordinary squares — it said so for months while the fleet stood in corners.
**`m59-walksim.mjs` asks whether the WALKER ARRIVES**, by driving the real `path`,
`standPoint` and `traceFineMoveClient` with the fine position carried forward, and that is
where the failures are: the router validates centre-to-centre, the mover slides, and after
the first slide the body is never on a centre again. It reproduces the two-square bounce
offline, on demand, with no server:

```bash
node tools/m59-walksim.mjs --room 598 --from 19,8 --to 64,19 --trace
```

`m59-clipsweep.mjs` counts where the collision view is more permissive than the coarse grid
— the invariant running backwards, 30,878 steps and, before the bake learned to prefer a
coarse-connected staging square, 116 rooms of 264 with an exit anchor only a clip can reach
(96 after). `CLIP_STEP_COST` in `m59-roo.mjs` prices those steps rather than forbidding
them, because 137 of 2,164 recorded human positions are squares the coarse grid calls wall.

Three things about running it that are not obvious. **`--resume` adopts only what was baked
from the same geometry AND the same view** — a half-table stitched from two maps is the one
kind of wrong nothing downstream could detect. **The partial table is flushed every minute
and carries `complete: false`**, because the whole thing used to be a single write after the
loop and a Ctrl-C at room 250 of 264 produced nothing at all. And **`doctor` counts MASKS,
not rooms**: a table baked before masks existed has all 264 rooms, matches the manifest, and
leaves the broker on the coarse grid — counting rooms put a green tick over exactly the
failure that line exists to catch.

**AND `--verify` WAS ASKING THE WRONG MAP, WHICH IS THIS FILE'S OWN CENTRAL MISTAKE
COMMITTED BY THE TOOL THAT EXISTS TO CATCH IT.** The table is baked `view: collision` — the
mover's fine BSP view — and `--verify` re-walked every step against `walkable()`, the coarse
one-byte grid. Those two disagree *by design*: the disagreement IS what a safe wall is, and
there are 17,402 such squares. So it reported healthy routes as broken wherever the views
differ, which is precisely where the interesting geometry lives.

Measured on the table in play: **1358 of 16293 routes "invalid" by the coarse predicate and
ZERO by `moverStepLands`.** Every one of the 1358 was a false alarm, and they were not
harmless — they read as "we have baked routes that walk through solid rock", which is the
opposite of what the table says, and sent a live investigation into rewriting a bake that
was correct. **A verifier that checks the wrong predicate does not merely fail to find bugs;
it manufactures them.** `--coarse` still asks the old question, and the output now names
which predicate it used and the table's view.

**AND THE ANCHOR IS THE OTHER HALF: ONE SQUARE PER EXIT, AIMED AT BY EVERY WALK, NEVER
CHECKED AGAINST THE SERVER.** `exitAnchors` bakes one staging square per exit and
`m59-world.mjs` ranks it first, so a room's whole traffic converges on it. Our geometry has
an opinion about whether it is standable; only the server's counts.

```bash
node tools/m59-anchorprobe.mjs --who <character>      # every anchor, placed and read back
node tools/m59-anchorprobe.mjs --report               # the last run, no server needed
```

**THE MEASUREMENT IS THE DISPLACEMENT, NOT THE RETURN VALUE.** `UtilGoNearSquare` never says
no — handed a square it will not stand you on it searches OUTWARD, puts you somewhere else
and returns 1 — so the only evidence is reading `piRow`/`piCol` back afterwards and
comparing. `m59-dm.mjs relocate --verify` does **not** do this: it checks only that the
character is in the right ROOM and then reports the square it ASKED for, which reads as a
confirmed placement and is not one.

First full sweep, 2026-08-20: **1341 anchors, 1313 exact, 5 displaced by at most 6 squares
(rooms 853 and 702), 23 landing in another room** — the last are `go` anchors on portal
squares, where being moved is the point. So the monorail terminals are sound, and an anchor
is not where to look when a fleet stalls.

`node tools/m59-routing-test.mjs` (38) pins all of it, offline.

**AND THE SAME FACT THAT MAKES A SQUARE SAFE MAKES IT A TRAP: THE WAY OUT OF A POCKET IS
THE WAY IN, WALKED BACKWARDS.** A safe wall IS the coarse grid and the BSP disagreeing —
that is the mechanism, measured — and the fleet seeks those squares out. Since the router
plans on the collision view, a character standing on one frequently **cannot plan a route
to its own room's exits**: room 587 is 68 regions with both exits in region 0, and there
are 17,402 such pockets world-wide. It tries, is refused, replans, tries again, forever;
the keeper pass never returns, so the board reports `travelling` while the character
twitches in a corner. Watched in the client 2026-08-16 — *"like a person pretending to get
stuck trying to find their way out the door right next to it"*.

`queueValidatedMove` therefore keeps the last 64 moves it sent, and `retreatAlongBreadcrumbs`
replays them in reverse when `walkTo` finds no route. **Every step replayed was accepted by
the fine validator on the way in, so it cannot invent an impossible traversal — it can only
undo one.** That is the whole argument for breadcrumbs over the obvious alternative: a
coarse-grid escape hatch was **considered and rejected**, because falling back to the
server's grid relaxes collision precisely where the two views disagree most, which is the
mechanism that let bots climb cliffs and cross boundaries no client can. The concern was
never that a bot slips slightly too deep into a safe spot.

Four things it does that read backwards:

- **A broken trail is dropped whole, never skipped.** A crumb that does not START where the
  character is standing means something else moved it — a teleport, a knockback, a room
  change — and the crumbs below it are no better connected than that one.
- **It stops the moment the route reappears.** The goal is to leave the pocket, not to undo
  the journey, so `until` is asked after every crumb.
- **A refused reverse step ends the retreat and says so.** It is the same validator, so a
  step it will not authorise is not forced; the walk then fails honestly, carrying
  `retreated`, rather than silently.
- **It runs once per walk.** Undoing the trail twice unwinds the journey.

`node tools/m59-breadcrumb-test.mjs` (32) pins all of it against a scripted validator —
including the one-way ledge, which is the case that must stop rather than teleport.

**THE BAKE IS LOCAL AND THE SERVER IS NOT.** The map is generated from a source tree here;
`prod` is somebody else's machine and can be patched on a Tuesday without telling us. Two
consequences the design turns on:

- **A stale map is a WARNING at startup, not a refusal.** It used to `return 1` — no
  broker at all. But the per-move validator already fails closed one room at a time,
  against the server's own announced security value, so refusing to start adds no safety
  and enormous blast radius: a map that drifted in four rooms would cost twenty-one
  characters, every room, and everything that is not movement. `--require-map` (or
  `M59_REQUIRE_MAP=1`) restores the refusal for a machine that should not run a fleet it
  cannot fully validate. It is opt-in because the failure it prevents is smaller than the
  one it causes.
- **Drift is recorded and reported, not merely refused.** Every room whose live security
  disagrees with the bake is written down and surfaced on `/health` as `geometry_drift`
  and on `m59-service.mjs status`. A refusal says a character did not walk; the record is
  what says the WORLD changed, which is the half anyone can act on. Refresh with
  `node tools/setup.mjs server`.

**A LIVE ROOM ANIMATION BLOCKS MOVEMENT, AND THE BLOCK HAS TO EXPIRE.** `BP_SECTOR_MOVE`
and the two collision-bearing `BP_CHANGE_TEXTURE` forms set `room.collisionInvalidated`,
because the stock client mutates its in-memory BSP on those packets and we cannot. The
refusal is right. **Refusing for ever is a cage**: the flag is cleared in exactly one
place — `BP_PLAYER`, which arrives on a ROOM CHANGE — and changing rooms requires the
movement the flag refuses. Any room that animates a sector traps whoever is standing in
it until a restart, a death or a teleport.

That is not hypothetical: within ten minutes of shipping it, Bunsen and Rizzo were held in
North Barloque and Scooter in room 589, each reporting `could not reach the bank` six times
over. So the record carries `until` (`M59_COLLISION_ANIMATION_MS`, 8s) and the check honours
it — while a record with **no** `until` still blocks, because "we do not know when this ends"
is not "it has ended".

Two things to know before editing that path:

- **`validateFineTarget` and `queueValidatedMove` are LIFTED OUT OF `m59-broker.mjs` BY
  TEXT and evaluated** by `m59-collision-test.mjs`, because the broker cannot be imported
  without taking the fleet lock. So **any module-scope symbol either of them calls must be
  declared in that test's `dependencies` map** — a free identifier that is fine at runtime
  is a `ReferenceError` in the test, which is how this was caught. `validateFineTarget`
  stays PURE and returns its evidence; the caller writes it down.
- **The map costs real memory.** Measured on this machine: 26.8 MB on disk, **5.6 s and
  ~399 MB RSS** to load and validate 264/264 rooms at broker start. The PR that introduced
  it measured 3.2 s and 303 MB elsewhere, so budget for the machine rather than the number.

`node tools/m59-collision-test.mjs` (153) pins it, and **10 of those skip without the raw
`.roo` files** — set `M59_ROO_DIR` (or `M59_ROOT`) to a tree containing `resource/rooms`
or the suite quietly reports 137 and calls it a pass.

**AND ALL 153 OF THOSE ASSERTIONS ARE POSITIVE, WHICH MEANS THE SUITE PASSES CLEANLY ON THE
DAY THE WALLS STOP WORKING.** Brownestone's doorway, the Limping Toad's half-wall, Icky,
Farol, Ukgoth, Cor Noth, the Temple, the Fey precision cases — every one of them asserts
that a legitimate move REMAINS USABLE. That is the right thing to protect and it is half a
contract: a bake exists to REFUSE, and nothing was testing the refusing.
`node tools/m59-impossible-test.mjs` (126) is the other polarity — checked-in fine traces
across the King's Way, both Cragged Mountains, the Twisted Wood and its western border,
Ukgoth, the Sentinel, the Icky Cave and the four floors of Castle Victoria, each asserting
a refusal AND naming the wall index that refused it, so "still refused, for a completely
different reason" cannot pass as unchanged. It carries **controls in the same rooms out of
the same bake**, because a suite that only asserts refusals passes perfectly when
everything is refused, which is the fleet standing still. And **observation cannot be the
oracle here**: players legitimately appear to phase through walls from another client's
view — that is lag compensation — so "I watched it happen" proves nothing about legality.
Assert against our own validator, which is the only thing this repository controls.


## Exits, reach and the safe wall

- **EXITS ARE NOT DOORS, AND THEY ARE NOT 1:1.** Walking from room A to room B through
  an edge does NOT put you where the return trip starts. You arrive somewhere in B, and
  the edge back to A can be a long way from there — often most of a room away. There is
  no turning round and stepping back through the way you came.

  This breaks the intuition every routing bug in this repo has been debugged with. A
  route that worked outbound failing on the return leg is the NORMAL case, not evidence
  of a one-way door, a broken boundary, or an unmapped region. `no floor anywhere on the
  <dir> boundary` in particular means only that the boundary column the router chose has
  no standable square — the connection can still be perfectly traversable by walking to
  where the real exit actually is.

  Do not conclude "unidirectional travel" or "sealed area" from a failed return trip.
  The map graph records that A and B connect; it does not record that the two ends are
  in the same place, and they usually are not.

- **MELEE REACH IS A DISC OF RADIUS 2–3 SQUARES, AND FINE COORDINATES DO NOT EXIST TO IT.**
  Both sides run the same test: `SquaredDistanceTo <= GetAttackRange^2`, where the
  distance is `(piRow-row)^2 + (piCol-col)^2` on **square** coordinates
  (`nomoveon.kod:121`) and the range is `Bound(2 + viDifficulty/6, 2, 3)` for a monster
  (`monster.kod:1682`) or 2–3 by weapon type for us (`weapon.kod:52`). So up to 28
  squares can hit you, not the 8 that touch you.

  `piFine_row`/`piFine_col` exist on every object and **nothing about being hit reads
  them** — the only consumer in the whole tree is `MonsterOrient`, choosing the angle a
  monster is *drawn* facing (`monster.kod:2189`). Standing hard against a wall inside a
  square is therefore worth exactly nothing, and an earlier "hug the wall by 24 of 64
  fine units" change was inert by construction. Do not reach for sub-square positioning
  to explain a safe spot; the answer is always in the squares.

- **A SAFE WALL IS THE TWO GRIDS DISAGREEING, AND THAT IS MEASURABLE RATHER THAN POETIC.**
  This started as an operator's hunch — that safe spots turn up exactly where the coarse
  walkable grid and the client's BSP disagree — and the recorded book bears it out.

  "Disagree" means: the one-byte-a-square grid offers a neighbour that
  `traceFineMoveClient` refuses. Measured across every tested square in
  `substrate/m59-safespots.json`:

  | | at a disagreeing square |
  |---|---|
  | squares that HELD | **44.0%** (405/920) |
  | squares that FAILED | 34.5% (688/1997) |
  | ordinary floor, same rooms | **23.9%** (3249/13594) |

  And it is dose-responsive, which is what makes it a mechanism rather than a coincidence
  — by how many of the grid's neighbours the BSP refuses:

  | refused | held |
  |---|---|
  | 0 | 28.2% (515/1824) |
  | 1 | 26.6% (175/657) |
  | 2 | 49.1% (141/287) |
  | 3 | 55.2% (58/105) |
  | 4+ | **70.5% (31/44)** |

  Not a room-level confound: comparing high- against low-disagreement squares WITHIN each
  room, 12 rooms favour it, 3 go against and 2 tie.

  **The mechanism is the asymmetry below, seen from the other side.** A square the BSP
  hems in is a square whose lines to the surrounding floor are broken — and it is exactly
  those lines that `Room.LineOfSight` tests for the monster and nothing tests for us. The
  disagreement and the safe wall are one geometric fact.

  Two things follow. A safe spot is **predictable from geometry** rather than only
  discoverable by standing somewhere and being hit for it, which is what the book pays for
  today. And the routing fragmentation those same disagreements cause is mostly harmless —
  it is tiny dead corners, not severed halves of a room — so it is a poor reason to refuse
  a route and a good reason to rank a wall.

- **The safe wall is an asymmetry in who checks line of sight.** `Monster.CanReach`
  calls `Room.LineOfSight` (`monster.kod:1782`); `Player.TargetWithinSightAndRange`
  (`player.kod:4115`) checks range and a facing cone and **never calls it**. So a square
  whose line to a patch of floor is broken, while that floor is still inside your weapon
  range, lets you hit what stands there and take nothing back. `free_shots` in
  `m59-safespots.mjs` counts exactly those. Only lich and revenant ignore walls
  (`AI_FIGHT_THROUGH_WALLS`).

  **And a blow already in the air is not the wall's fault.** Being hit is resolved on the
  server and reaches us as a packet; our arrival travels the other way. So a blow resolved
  while we were still a square short can land after we have reported standing on the spot,
  and the reading blames the square. A failure is **permanent** (`discredited()`), so one
  such reading retires a good square for ever and nothing about it looks wrong afterwards.
  `SETTLE_GRACE_MS` (250ms, `m59-autopilot.mjs`) discards any window that opens before we
  have been settled that long, measured from the LATER of "stopped moving" and "claimed
  the square". Both clocks, because the walked-in path was already covered by accident —
  `takeSafeSpot` stamps `movedAt` on arrival, so the first window is thrown out for "we
  moved" — while `steps_away === 0`, claiming a square we were already standing on, walks
  nowhere, stamps nothing, and opened a countable window the instant the hold was taken.

  The window is **discarded, not forgiven**: the same packet delay that hides a hit until
  later is what would make the square look quiet now, so a reading we will not trust for
  damage is not one we may trust for proof. And the grace is deliberately narrower than
  the round trip can be, because the asymmetry runs the other way — being wrong about a
  bad square costs a character, being wrong about a good one costs a walk to the next
  corner. `settled_ms`/`min_settled_ms` are recorded on every real failure so the width
  can be argued from the record rather than from intuition; widen it only against those.

- **A PLANNED TRIP ACCEPTS THE RISK OF DEATH, AND ABANDONING ONE IS NOT AN OPTION. THE WAY
  OUT OF AN ATTACK DURING TRAVEL IS ALWAYS THROUGH.** When a journey is planned the risk is
  taken at that moment; a character being attacked on the way does not get to reconsider it.
  It completes the journey AS FAST AS POSSIBLE WHILE BEING ATTACKED. It does not stop to
  fight, it does not turn back, and nothing else may cancel the trip on its behalf.

  This is doctrine, not an optimisation, and it is written down because the obvious-looking
  fixes all violate it. Two were tried here on one afternoon and both were reverted: giving
  the character back to its keeper when health dropped below a threshold (that ends the
  trip), and putting a timeout on the errand's calls so a "hung" leg could be retried (that
  was a fix for a hang which, on inspection, had never happened). A trip that is abandoned
  costs the character its armour money AND leaves it wherever it stopped, which is usually
  worse than the room it was walking to.

  **AND `ms_since_moved` IS ABOUT THE KEEPER, NOT THE CHARACTER — it is what made both of
  those look justified.** A post-mortem showing `doing: "stalled"` with eight minutes since
  it last moved reads exactly like a character standing still being eaten. It was not: the
  frames put that character in three different rooms over the same span. The field measures
  when the KEEPER last moved it, and during an errand the keeper is inert by design, so the
  number climbs while the errand walks. `watchdog.stood_down_for` on the same record says so
  outright, and `pass_blocked_ms` was 5.6 seconds rather than the eight minutes the other
  field implied. Read those three together or the instrument will invent a stall for you.

  What actually happened is what the doctrine describes: an errand walked a character at 1
  of 49 health through rooms holding six to nine things, and it died going through. That is
  an accepted outcome of a planned trip, not a defect to engineer around.


## AN EDGE EXIT IS AN EDGE, AND THE BAKE PICKS ONE SQUARE OF IT

Lee, in The Sweet Grass Prairies (557), spent an afternoon reporting "stuck" and trying to
leave for a hunt room seventeen times. He was never trapped, and the room was never sealed.

Room 557 leaves by **edge exits** — there are no `goExits` at all:

    south -> 382  West Jasper          north -> 556  Deep Forest of Farol
    west  -> 547  Deep in the Forest of Farol

The bake records ONE anchor per exit: `{kind:"edge", dir:"south", to:382, row:49, col:12,
region:0}`. Lee's reachable ground is at columns 32-46. He touches the SAME south edge — a
slide-enabled flood from his position reaches (49,43), (49,44), (49,45) and (49,46), all
walkable — but the anchor is twenty columns west in a region he cannot reach, so the router
concludes there is no way out.

**A `go` exit is a doorway and genuinely is one square. An edge exit is the whole boundary,**
and any walkable square on it leaves the room. Baking one square of it turns a wide-open
border into a single door, and a character who cannot reach that door is reported stuck in a
room he could walk out of in ten steps.

The fix is to choose the crossing square at ROUTE TIME from the squares reachable by the
character, rather than at BAKE time from the room as a whole — for edge exits only, since a
`go` exit really is a point. `stranded_exits` in the baked table already counts anchors that
cannot be reached from the room's body (232 of 1,341 across the world); this is the same fact
seen from the character's side, and for an edge exit it is usually not a real obstruction.

Two secondary notes from the same investigation:

- The region grid is stricter than the body. `regions()` puts Lee in a 106-cell region that
  touches no edge square; the slide-enabled flood reaches 444 cells including four of them.
  `freeSpace` demands a full player radius of clearance from every solid wall, and the game
  does not — the file's own comment measures the cost at 10.55% of held pairs.
- The one-way walls around him (`posCross=false, negCross=true`, z1=0, z2=11200) are ledges,
  not bugs. He dropped down something he cannot climb, which is ordinary terrain.
