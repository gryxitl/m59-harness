# Rebuilding the keeper: GOAP over honest atomics

A plan to replace `m59-autopilot.mjs` as the decision-maker, in a way that can be
verified at every step and abandoned at any step without losing a fleet.

This supersedes `docs/bt-goap-handoff.md`, which documents `m59-bt-farming.mjs`
as the path forward. That module is orphaned and has a live bug; see §0.

---

## 0. Where we actually are

Measured, not estimated:

| | |
|---|---|
| `m59-autopilot.mjs` before the BT effort (`ae350a2`) | 11,909 lines |
| `m59-autopilot.mjs` now | **13,353** |
| BT/GOAP modules added | 12,941 lines |
| calls from BT modules back into the keeper | **141** (`m59-bt-delegation-test.mjs`) |
| distinct legacy methods those calls reach | 71, of which 56 have exactly one caller |
| `_bt*` shim methods added *to the monolith* to feed the trees | 17 |
| BT/GOAP test assertions passing | 613 |

The decomposition moved **control flow** into trees and left **behaviour** in the
monolith. `provisionNode` is the shape of nearly all of it:

```javascript
export function provisionNode(keeper) {
  return asyncAction(async (bb) => {
    const plan   = keeper._btFarmStrategy();
    const result = await keeper.provision(plan, vitals(bb));
    if (result === 'ate' || result === 'waiting') return SUCCESS;
    return FAILURE;
  });
}
```

Three lines translating a legacy return value into a BT status. Delete
`Autopilot.provision()` and the node stops working — the delegation *is* the
dependency, which is why the monolith grew while being "decomposed".

### Two live bugs, same root cause

Both are BT code calling a **keeper** method on the **client** object. Both fail
silently in the always-false direction, and both passed their tests because the
fixtures faked the method the real code never calls.

1. **`m59-bt-farming.mjs:78` and `m59-bt-combat.mjs:393`** —
   `new Set([...(c.equipment?.keys?.() ?? [])])`. `equipment()` is a *method
   returning an object* (`m59-client.mjs:380`), not a Map. `c.equipment.keys` is
   `undefined`, so the set is **always empty**. `GearBrokenCondition` therefore
   always reports broken gear, and `CombatTree`'s `canFight` is always false — a
   fully-armed character would always flee. Proven against a real-shaped client.
2. **`m59-bt-nodes.mjs:100` and `m59-autopilot.mjs:6928`** — `client.armed()`,
   which has never existed. The `wielding_weapon` condition has answered false for
   every character since it shipped, and the `useBT` get-armed branch, guarded on
   `typeof c.armed === 'function'`, **has never executed at all**. Partially fixed
   in `f4b7c9e` (the predicate is now `skills.isArmed(client)`); the dead branch is
   deliberately left dead pending a decision to activate it deliberately.

### The orphans

`m59-bt-atomics.mjs` — 10 reusable leaf nodes, 479 lines, 56 passing tests — is
imported by exactly one module (`m59-bt-shop.mjs`). None of the five trees wired
into the live keeper import it. There is an atomic library and it is not used.

`m59-bt-farming.mjs` (`FarmingLoopTree`) is imported by nothing but its own test.
It also has a memoryless-Sequence livelock: `killLoop` deletes its slot on
SUCCESS and resets `killCount`, so after clearing a room the farm branch fails
forever and never reaches eat-or-sell.

### And a fork problem

`origin/main` and `upstream/main` diverged at `ae350a2` (2026-08-14): 60 commits
ours, 37 theirs, **16 `tools/` files we do not have**, including four test suites
CLAUDE.md documents as load-bearing — `m59-localpolicy-test.mjs` (71),
`m59-handoff-test.mjs` (112), `m59-travel-test.mjs` (24),
`m59-testbed-test.mjs` (104). We are running without those guards.

---

## 1. The facts that must survive

**The structure is disposable. These are not.** Every one was paid for in dead
characters or in hours of debugging, and a rebuild that does not carry them
forward will re-earn them. Port each with its citation.

### Space and reach
- **Melee reach is a disc of radius 2–3 on SQUARE coordinates.** Both sides run
  `SquaredDistanceTo <= GetAttackRange^2` (`nomoveon.kod:121`,
  `monster.kod:1682`, `weapon.kod:52`). Up to 28 squares can hit you, not 8.
- **Fine coordinates are read by nothing that matters.** `piFine_row`/`piFine_col`
  exist; the only consumer in the tree is `MonsterOrient`, choosing the angle a
  monster is *drawn* facing (`monster.kod:2189`). Sub-square positioning is inert.
- **The safe wall is an asymmetry in who checks line of sight.**
  `Monster.CanReach` calls `Room.LineOfSight` (`monster.kod:1782`);
  `Player.TargetWithinSightAndRange` (`player.kod:4115`) does not. That gap is
  `free_shots`. Only lich and revenant ignore walls (`AI_FIGHT_THROUGH_WALLS`).
- **EXITS ARE NOT 1:1.** Walking A→B does not put you where the return edge is.
  A route that worked outbound failing on the return leg is the NORMAL case, not
  a one-way door. Do not conclude "sealed area" from a failed return trip.

### Time and evidence
- **`SETTLE_GRACE_MS` is 250ms**, measured from the later of "stopped moving" and
  "claimed the square". A blow already in the air can land after we report
  standing on the spot, and a failure is **permanent** (`discredited()`), so one
  bad reading retires a good square forever. Discard, don't forgive.
- **`WATCH_MS` 8s** is "could the keeper have acted"; **`TRUST_MS` 30s** is "does
  this reading still place a death". Different questions, do not merge.
- **`ms_since_moved` measures the KEEPER, not the character.** It climbs while an
  errand walks the character perfectly well.
- **A counter on the keeper is not a rate** — keepers restart about once a minute.
  Kills come from the ledger (`countKills`), never from `tally.kills`.

### The server lies by omission
- **A merchant refusal is a sentence spoken to the room, never an error on the
  wire.** No error has never meant success. Measure the purse.
- **Object ids are not stable** — renumbered on every save, every 15 minutes.
  Resolve names in the same batch that uses them; never cache across a call.
- **A `send` reply names its receiver before its answer**, so a bare
  `/OBJECT (\d+)/` reads the wrong number.
- **Equipment is `plUsing`, not the inventory.** `client.equipment()` is the only
  authority. Wielding what you already wield is *refused*.
- **`BP_USERCOMMAND` arrives as well as departs.** A packet nobody parses is
  indistinguishable from a packet nobody sends — the trap behind both live bugs.

### Survival arithmetic
- **Level is not danger.** `GetAttackAbility = 3*viLevel + 60*viDifficulty`. A
  fungus beast (50/1) rates 210; a centipede (30/4) rates 390.
- **Hit chance is `offense * 55 / defence` bounded to [10,95]** (`battler.kod:331`).
  Against anything that pins us at 95, extra defence buys nothing and only
  absorption works.
- **Bare is worse than bad armour.** Expected damage/swing at this fleet's stats:
  bare 1.34, chain 1.18, leather 1.17, scale 0.71. Keep the floor.
- **Threat ceiling is a proportion and fails CLOSED.** Unknown max health returns
  null and every caller reads null as refuse. Default `{percent, 150}`.
- **Faction soldiers are level 70–145**, not 50. `SetEquipment` overwrites the
  declared numbers at creation (`troop.kod:215`). Never fightable by this fleet.
- **Vigor**: `REST_VIGOR_CAP` 80, `MIN_FIGHT_VIGOR` 100, `VIGOR_MAX` 200.
  Everything above 80 must be eaten. `create food` = 2 elderberry AND 2 herbs, so
  castings are `min(elder, herb)/2` — read the per-character minimum, never the sum.

### Doctrine
- **A planned trip accepts the risk of death; the way out is always through.**
  This is about *who may cancel* (survival only, never an errand), not about how
  many hops fit in one await. The two were tangled, which is why both previous
  "fixes" were reverted.
- **The four protected faculties** — identity, mortality, survival, recovery —
  decide at 1s and stay in this repository. A bot gets them only with roster
  consent (`PROTECTED_FACULTIES`, `may_yield`). `m59-unattended-test.mjs` is the
  guard and **should fail the day somebody moves a survival decision out**.
- **Selling is an allowlist, not a check.** Skivlat takes what you hand him and
  gives nothing back, and nothing on the wire distinguishes it from a sale.

---

## 2. Target architecture

Three layers, separated by **clock**, which is the split CLAUDE.md already
documents and the one F.E.A.R. used (squad behaviours issued goals; agents
planned; damage reactions ran outside the planner entirely).

| clock | layer | owns | mechanism |
|---|---|---|---|
| **~1s** | **reflexes** | doomed, flee, watchdog interrupt, Underworld, death | fixed reactive ladder. **Not planned.** Small and auditable. |
| **seconds** | **GOAP over atomics** | fight, move, provision, restock, bank, loot, role execution | continuous replanning, A\* over ~20 atomics and a closed world-state vocabulary |
| **minutes** | **squad / intent** | role assignment, per-character goals, fleet concert | declarative end states + claims. Not a planner. |

### Why GOAP can own the seconds layer

Planning cost is not the obstacle — F.E.A.R. replanned continuously over a couple
dozen actions in microseconds, and this domain is smaller. The obstacle is that
**the state you would plan over is currently stale and the actions lie**: 82% of
deaths had the keeper blind (median 18s, p90 219s), and `travel` can run 900
seconds inside one `await`. Plan over that and you get fast, confident plans about
a world from three minutes ago.

So GOAP's viability is a *consequence* of the atomic layer being bounded,
interruptible and honest. That is why §4 comes before §6.

### Why the reflex layer is not planned

Same reason F.E.A.R. kept flinches and deaths out of the planner. A plan is a
claim that the world will hold still; being at 4 health with something adjacent is
exactly when it will not. This layer is deliberately small, fixed, and reads only
pushed state (`client.vitals()` is live whatever the call stack is blocked on).

### Why concert is not GOAP either

Twenty-one agents planning independently toward their own goals is what produced
the documented failure where the herb-rich stood next to the elderberry-rich and
20 of 21 characters could cast zero times. Concert comes from **declarative shared
end states**, the pattern this repo already proved with guild wants:

> A guild want is an END STATE, NOT AN ERRAND, and that is what makes it safe to
> give to twenty-one characters… the shortfall shrinks as others contribute,
> nobody owns the errand, it cannot double-count, and a satisfied plan produces no
> work and no walk.

Generalise that, don't invent a multi-agent planner.

---

## 3. The world-state vocabulary

GOAP is fast **because** the state is small. F.E.A.R. packed its world state into
a fixed struct of about a dozen symbols. Today `ws` keys are invented ad hoc per
module — `vigor_ok`, `loot_sold`, `gear_ok`, `armed`, `safe_spot_taken`,
`at_mausoleum` — with no registry, so nothing can verify a plan is connectable.

**Deliverable: `tools/m59-worldstate.mjs`** — one closed vocabulary, validated.

```javascript
export const SYMBOLS = {
  // body
  armed:            'a weapon is in the use list (skills.isArmed)',
  healthy:          'hp >= safety().engageAt',
  hurt:             'hp <  restBelow',
  doomed:           'hp <  doomedInSpotBelow with something in reach',
  vigor_ok:         'vigor >= fightFloor()',
  // position
  in_prey_room:     'current room is the assigned/valid prey room',
  on_safe_square:   'holding a square whose hold is proven',
  in_reach:         'selected target within threatCeiling-adjusted reach',
  // target
  has_target:       'a target is selected and still in room contents',
  target_in_band:   'refuseEngagement() says yes',
  // pack + money
  pack_room:        'inventory below maxCarry AND under the binding ceiling',
  has_reagents:     'min(elderberry, herbs) >= 2',
  has_food:         'something edible in the pack',
  funded:           'purse >= the current errand cost',
  // party
  mate_present:     'partner in this room',
  mate_hurt:        'partner below partyHealBelow',
  // role (assigned by the squad layer, never inferred)
  role:             'melee | ranged | healer | cc',
};
```

Rules, each enforced by test:

- **Closed set.** An atomic declaring a `pre` or `effect` outside `SYMBOLS` is a
  test failure, not a runtime surprise. This is the `purpose`-not-in-schema bug —
  a setting that silently does nothing — made impossible.
- **Every symbol has exactly one producer**, a pure function over client/party
  state. A symbol with two definitions is the "quantity with two homes" failure
  this repo keeps rediscovering.
- **Unknown fails closed.** A symbol that cannot be evaluated is `false` for
  preconditions that permit danger and `true` for those that prevent it — the same
  asymmetry as `threatCeiling()` returning null.

---

## 4. The atomic layer

**Deliverable: `tools/m59-act/*.mjs`** — a new namespace, so the rebuild does not
inherit `m59-bt-atomics.mjs`'s assumptions (it was written by the same effort that
produced both always-false conditions and has never run against a real client).

### The contract

Every atomic satisfies all five, and a conformance test checks each mechanically:

1. **Signature `(client, session, args)`.** Never the keeper. Enforced by the
   delegation ratchet.
2. **Bounded.** No unbounded await. One atomic does one thing with a hard step or
   time cap. Looping is the caller's job.
3. **Interruptible.** Returns `RUNNING`; may be abandoned between ticks with no
   cleanup debt.
4. **Honest.** Reports what *happened*, verified against re-read state (purse
   delta, use-list re-read, room contents), never what was requested. A trade that
   handshakes and moves nothing reports moving nothing.
5. **Declares `pre` and `effects`** drawn from `SYMBOLS`.

### The set

| group | atomics |
|---|---|
| move | `StepHop(hop)` · `MoveWithin(target, range)` · `TakeSquare(col,row)` · `LeaveVia(exit)` |
| fight | `Attack(id)` · `Cast(spell, target)` · `Equip(id)` · `Unequip(id)` |
| body | `Rest()` · `Stand()` |
| goods | `PickUp` · `Drop` · `Give` · `Buy` · `Sell` · `Deposit` · `Withdraw` |

Conditions are pure reads of §3 symbols and cost nothing at runtime — health,
stats and the use list are **pushed**, so a condition is a cache read.

### The test harness that would have caught both live bugs

**`tools/m59-act/fake-client.mjs`** — one fake, shaped from `m59-client.mjs`, used
by every atomic test. It must expose `equipment()` as a *method returning
`{known, equipped[]}`* and must **not** have an `armed()`. A conformance test
asserts the fake's surface matches the real client's:

```javascript
for (const m of ['equipment','vitals','inventory','room','rsc','waitFor'])
  ok(`fake client has ${m} with the real shape`, sameShape(real, fake, m));
ok('the fake has no armed() — that is skills.isArmed', !('armed' in fake));
```

Both live bugs are fixture bugs. Fix the fixture once, centrally, or they recur.

---

## 5. First vertical slice: navigation

Chosen because it is the **largest killer in the record** (203 deaths while
travelling, mean 183s blind, worst 909s), it is self-contained, and it is the
clearest demonstration of the pure/impure split.

Today `travel(room, {maxHops:14})` is one call, up to 25 hops, one `await`, no
observation inside. `Autopilot.travel` brackets it with 'setting off' and
'arrived' frames — which tells you when the blindness *started*, not what happened
in it. Camilla's last frame reads `why: "setting off"` 17.8s before she died.

Rebuilt as three pieces:

```
route(map, from, to) -> [hop]     PURE. no I/O. offline-testable. all the hard part.
StepHop(hop)                      ONE edge. re-observes on arrival. bounded.
NavigateTree(dest)                Sequence: AtDest? -> route -> StepHop -> loop
```

Three properties that the current design cannot have:

- **Every hop is an interruption point.** Health crosses the flee line at hop 6 of
  14 and hop 7 simply is not ticked. No `cancelMovement()` reaching into twelve
  places inside paced step loops.
- **"Exits are not 1:1" stops being a trap.** Each hop re-observes and re-routes
  from where it actually landed, so a far-from-the-edge arrival is the normal case
  rather than the bug every routing session rediscovers.
- **Most of it is testable with no server** — `route()` is a graph function.

The travel doctrine is preserved exactly: only the reflex layer may cancel a
journey; an errand may not. That is a rule about *authority*, and it survives the
restructure untouched.

**Done when:** `route()` has offline graph tests including the return-leg
asymmetry; one character runs on `NavigateTree` for a day with kills/minute from
the ledger no worse than the fleet median; `Autopilot.travel` is **deleted**.

---

## 6. Phases

Each phase has a **gate** — a measurable condition, not a judgement — and each
must leave `m59-autopilot.mjs` shorter than it found it.

### Phase 0 — Stop the bleeding *(days)*
- Fix or delete `m59-bt-farming.mjs` and `m59-bt-combat.mjs`. Recommend **delete**:
  `bt-farm` is the wired one, `bt-farming` is superseded, orphaned and livelocked.
- Decide the dead `useBT` get-armed branch: activate against one character and
  watch, or remove it. Not both, not neither.
- Wire `m59-bt-delegation-test.mjs` into whatever runs tests. **No new shims.**
- Reconcile the fork, or consciously accept running without four guard suites.
- **Gate:** ratchet green; zero modules with a known always-false condition.

### Phase 1 — Vocabulary and harness *(1 week)*
- `m59-worldstate.mjs` (§3), closed set, one producer per symbol.
- `m59-act/fake-client.mjs` (§4) + the shape-conformance test.
- Atomic conformance test: bounded, interruptible, honest, declared, no keeper.
- **Gate:** conformance test exists and fails loudly for a deliberately bad atomic.

### Phase 2 — Navigation *(1–2 weeks)*
- `route()`, `StepHop`, `NavigateTree` per §5.
- **Gate:** `Autopilot.travel` deleted; monolith net −N hundred lines; one
  character on the new path for 24h at or above fleet-median kills/minute.

### Phase 3 — Combat atomics + the melee role *(2 weeks)*
- `Attack`, `MoveWithin`, `TakeSquare`, `Rest`, `Stand`, with §1 facts ported.
- Melee role tree over them. Safe-spot logic moves as a **unit**, not re-expressed.
- **Gate:** `passFightRounds` and `_btFarmFight` deleted; `m59-combat-test.mjs`
  (472) still green; one character farming for 24h.

### Phase 4 — GOAP over the atomics *(2 weeks)*
- Planner reads `SYMBOLS`, plans over `m59-act/*`, replans continuously.
- Retire the 17 `_bt*` shims — they exist only to feed trees.
- Replace `substrate/goap-gear-dispatch.json` + its 10-minute window with a
  `busy` lease (`m59-commitment.mjs`, 71 assertions, already tested, fails back to
  the keeper when the holder dies).
- **Gate:** delegation ratchet ≤ 40; no two drivers claiming one character.

### Phase 5 — Roles *(2–3 weeks)*
- Widen `m59-party.mjs` from two roles to four. It already has `pair`, `mateOf`,
  `together`, `declareTarget`/`agreedTarget` (focus fire, 20s staleness),
  `mayShareSpot`, `mateNeeds`, `roleFor` — this is the most honest module here and
  should be extended, not replaced.
- Role trees over one leaf set: healer, ranged, melee, CC.
- **Survival variance goes through `may_yield` on the roster, never by forking the
  ladder.** A CC deliberately takes hits; a healer must not flee while its partner
  dies. A character whose bot dies falls back to plain self-preservation, which for
  a CC is the correct failure mode.
- **Gate:** `m59-unattended-test.mjs` still green; a four-role party clears a room
  no worse than four solo characters.

### Phase 6 — Concert *(2 weeks)*
- Generalise the guild-wants end-state pattern to fleet intent: "this room should
  have 3 farmers", "the fleet needs 6 more castings".
- Assignment via claims so two characters cannot take one job.
- **Gate:** the per-character reagent minimum stops going to zero while the fleet
  total looks healthy — the exact documented failure.

### Phase 7 — Delete the ladder *(1 week)*
- `BTKeeper`'s fallback to `pass()` is the definition of done. Instrument
  `_delegatedThisPass` as a **rate on status** from Phase 1 onward.
- **Gate:** fallback rate 0 across the fleet for a week → delete the sequential
  ladder, `passFarm`, `passFleeAndRest`, `passErrand`.

---

## 7. Migration safety

- **Per-character opt-in**, the existing strangler seam. One character on the new
  path beside twenty on the old.
- **The ledger is the referee.** Kills/minute from `countKills`, never a keeper's
  own tally. Deaths from `m59-postmortems.mjs`. A rebuild that reads better and
  kills less has failed.
- **Nothing merges while the monolith is longer than it was at phase start.**
- **`m59-service.mjs` restart logs out the fleet** — batch cutovers, don't drip.
- **Back up the rosters before each phase.** `node tools/m59-backup.mjs
  --credentials-only` takes seconds and the rosters are the only record of the
  account passwords.

---

## 8. Risks

| risk | how it shows up | detection |
|---|---|---|
| Rebuilt atomics repeat the fixture bug | tests green, fleet idle | one shared fake, shape-conformance test (§4) |
| Survival facts lost in the port | deaths rise, no error anywhere | `m59-combat-test` (472) + `m59-safespot-test` (141) run against new code unchanged |
| GOAP thrashes on stale state | plans churn, nothing completes | plan-changes-per-minute on status; alert above a threshold |
| Roles deadlock (healer waits, CC holds, nobody kills) | party alive, zero kills | kills/minute per party vs four solos |
| Two drivers claim one character | silent double-drive | `busy` lease replaces the dispatch file (Phase 4) |
| The rebuild stalls half-done | two systems forever | the ratchet + fallback rate; **any phase that does not shrink the monolith is not that phase** |

---

## 9. Definition of done

```
m59-autopilot.mjs        < 3,000 lines   (session/socket/pacer/journal host only)
delegation ratchet       0
BTKeeper fallback rate   0
_bt* shims               0
world-state symbols      one registry, one producer each
kills/minute             >= pre-rebuild fleet median
deaths/1000 obs          <= pre-rebuild
```

The first and last lines together are the whole point: the monolith stops being
the decision-maker, and the fleet plays at least as well as it did.
