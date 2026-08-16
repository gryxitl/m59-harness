# BT / GOAP keeper — handoff document

## What this is

A new keeper module being built alongside (not yet replacing) the 12,000-line
`m59-autopilot.mjs` monolith. The goal is a composable, testable behavior-tree
+ GOAP controller that can be wired into `pass()` incrementally, subtree by
subtree, behind the existing `policy.useBT` opt-in.

This document is the hand-off: what exists, how it fits together, what the
immediate next steps are, and what the known blockers are. Read this before
touching any `m59-bt-*.mjs` file.

---

## File map

| file | what it is |
|---|---|
| `tools/m59-bt.mjs` | BT primitives: `Selector`, `Sequence`, `Condition`, `Action`, `Inverter`, `Timeout`, `Retry` + `SUCCESS`/`FAILURE`/`RUNNING` constants |
| `tools/m59-goap.mjs` | GOAP planner: `plan(actions, initial, goal)` — returns ordered action list or null |
| `tools/m59-goap-planner.mjs` | Higher-level planner wrapper; chains GOAP with BT execution |
| `tools/m59-bt-atomics.mjs` | Low-level shared atomics used by multiple trees |
| `tools/m59-bt-combat.mjs` | Combat atomics + composed trees |
| `tools/m59-bt-shop.mjs` | Shopping / gear-buying atomics + `BuyGearTree` |
| `tools/m59-bt-farming.mjs` | Farming loop: `GearBrokenCondition`, `EatFoodAction`, `SellLootAction`, `FarmingLoopTree` |
| `tools/m59-bt-nav.mjs` | Navigation: `GoToRoomAction` |
| `tools/m59-bt-walk.mjs` | Walk helpers |
| `tools/m59-bt-nodes.mjs` | Glue between the BT trees and the existing autopilot: `fightRoundsAction`, `handleThreatTree`, `farmNavigationTree`, `outsideAction`, `errandAction`, `updateBlackboard` |

Tests (all offline, all passing):

| test file | count |
|---|---|
| `m59-bt-test.mjs` | 30 |
| `m59-bt-combat-test.mjs` | 75 |
| `m59-bt-shop-test.mjs` | 46 |
| `m59-bt-farming-test.mjs` | 23 |
| `m59-bt-atomics-test.mjs` | (varies) |
| `m59-bt-wiring-test.mjs` | (varies) |
| `m59-bt-equip-e2e-test.mjs` | (varies) |
| `m59-goap-nav-test.mjs` | (varies) |
| `m59-goap-walk-test.mjs` | (varies) |

---

## The blackboard

Every node receives a `bb` (blackboard) object. It is created once per pass
and shared across the whole tree. The shape is:

```javascript
{
  client:   c,          // live m59-client.mjs instance
  session:  this,       // the Autopilot keeper instance (has .s, .policy, etc.)
  policy:   this.policy,
  ws: {},               // GOAP world-state: plain key→bool/number facts
  _bt: {},              // BT slot storage: one key per in-flight Action
}
```

`updateBlackboard(bb, { client, session, policy })` is the canonical way to
refresh it at the top of each pass. It is in `m59-bt-nodes.mjs`.

---

## The slot pattern

Every async `Action` follows the same three-tick structure to avoid blocking
the pass:

```javascript
new Action((bb, slot) => {
  if (!slot || slot.done === undefined) {
    // Tick 1: fire the Promise, stash slot, return RUNNING immediately.
    slot = { done: false, ok: false };
    bb._bt[key] = slot;
    Promise.resolve().then(async () => {
      // ... real async work ...
      slot.ok = true; slot.done = true;
    }).catch(() => { slot.done = true; });
    return RUNNING;
  }
  if (!slot.done) return RUNNING;   // Tick 2…N: still waiting
  const ok = slot.ok;               // Tick N+1: resolved
  delete bb._bt[key];
  return ok ? SUCCESS : FAILURE;
}, { key: 'at_my_action', name: 'my_action' });
```

The key (`at_*`) is the slot's address in `bb._bt`. It persists across passes
via the shared `_btBlackboard` on the keeper.

---

## GOAP-compatible action metadata

Each atomic Action node carries `pre` and `effects` arrays so the GOAP planner
can chain them:

```javascript
node.pre     = ['armed', 'has_target'];     // world-state facts required before
node.effects = ['target_dead', '!in_combat']; // facts produced (! = set to false)
```

The planner in `m59-goap.mjs` reads these to find a sequence of actions whose
effects satisfy the goal from the current `ws`. A `!key` effect sets `ws[key]
= false`.

---

## World-state keys (ws)

Defined by the atomics that set them. Current set:

| key | type | set by |
|---|---|---|
| `armed` | bool | `getArmedTree` / `ConjureWeaponAction` |
| `has_target` | bool | `SelectTargetAction` |
| `target_dead` | bool | `FightUntilDeadAction` |
| `in_combat` | bool | `SelectTargetAction` (true), `FightUntilDeadAction` (false) |
| `safe_spot_taken` | bool | `TakeSafeSpotAction` |
| `fled_room` | bool | `FleeRoomAction` |
| `gear_ok` | bool | inverse of `GearBrokenCondition` |
| `vigor_ok` | bool | `EatFoodAction` |
| `loot_sold` | bool | `SellLootAction` |
| `at_mausoleum` | bool | (set by navigation node, not yet wired) |
| `_targetId` | number | `SelectTargetAction` |
| `_safeSpots` | array | populated by the keeper before ticking |
| `_smithId` | number | set by caller before ticking `FarmingLoopTree` |
| `_loadout` | object | set by caller before ticking `SellLootAction` |
| `_threatCeiling` | number | set by `updateBlackboard` from policy |

---

## Key atomics — what they do, what they need

### `SelectTargetAction(opts)`
- **Synchronous.** Scans `c.room.objects` for the nearest non-player attackable
  object matching `opts.nameRe` and within `opts.radius`.
- Idempotent: if `bb.ws.has_target && bb.ws._targetId != null` already set,
  returns SUCCESS immediately (does not re-pick).
- Sets `ws.has_target`, `ws._targetId`, `ws.in_combat = true`.

### `TakeSafeSpotAction(opts)`
- **Async.** Walks to the best entry in `bb.ws._safeSpots` (scored by
  `free_shots` then `steps_away`). Falls back to standing in place (SUCCESS)
  when no scored spots exist.
- Uses `s.walkTo(col, row, { maxSteps: 20 })` when available.
- Sets `ws.safe_spot_taken`.

### `FightUntilDeadAction(opts)`
- **Async.** Swings at `bb.ws._targetId` via `s.pacer.submit('attack', ...)`.
  Returns RUNNING while target is alive in `c.room.objects`, SUCCESS when gone.
- Cap: `opts.maxSwings` (default 60).
- **Pre: `['armed', 'has_target', 'safe_spot_taken']`** — the planner enforces
  this; the spot step is not skippable.

### `EngageNearestAction(opts)` (composed)
- Sequence: `SelectTargetAction → TakeSafeSpotAction → FightUntilDeadAction`.
- Pass `opts.nameRe` to filter by creature name.

### `GearBrokenCondition()`
- **Synchronous Condition** (not an Action).
- Returns **SUCCESS** (meaning: gear IS broken) when any of:
  - A weapon in `brokenSet(c)` is equipped
  - An item with `broken: true` is equipped
  - No weapon matching `/mace|sword|axe|hammer|scimitar/i` is equipped
  - No body armour matching `ARMOUR_BODY` (excl. shields) is equipped
- Use with `Inverter` to get "gear is ok" as a pre-condition.

### `EatFoodAction(opts)`
- **Async.** Short-circuits synchronously if `vigor >= opts.vigorTarget`
  (default 100).
- Cooks with `create food` when `elderberry >= 2 && herbs >= 2 && mana >= 10`.
  Note: the item name is `'herbs'` (plural) — the regex is `/\bherbs?\b/i`.
- Falls back to eating existing food matching
  `/\bsnack\b|\bfood\b|\bpastry\b|\bpie\b|\bbread\b|\bmeat\b/i`.
- Sets `ws.vigor_ok = true` on success.

### `SellLootAction(opts)`
- **Async.** Finds the nearest `OF_BUYER`-flagged (`0x0080`) object in the room
  that passes `trustedBuyer(name)`, then calls `sellAll(s, { merchant, loadout,
  protect })`.
- Returns FAILURE if no trusted buyer is present (caller should navigate to a
  town first).
- Sets `ws.loot_sold = true` on success.

### `FarmingLoopTree(opts)`
- **Composed Selector.** Two branches:
  1. Gear-fix: `GearBrokenCondition → navToSmith → BuyGearTree(gearWants, smithId)`
  2. Farm: `navToMausoleum → killLoop(maxKills) → EatFood → navToSell → SellLoot`
- Navigation nodes are **no-ops** when not provided (so the tree works with a
  pre-positioned character in tests).
- `smithId` is resolved lazily from `opts.smithId ?? bb.ws._smithId`.
- `killLoop` ticks `EngageNearestAction({ nameRe: /mummy/i })` up to
  `opts.maxKills` times (default 10), stopping early when the room is cleared.

### `BuyGearTree(wants, merchantId, opts)` (from `m59-bt-shop.mjs`)
- Composed tree: walk to merchant → buy missing gear items → verify equipped.
- `wants` is `[{ slot: 'weapon'|'armour', re: /regex/ }]`.

---

## How it plugs into the existing keeper

The existing `pass()` in `m59-autopilot.mjs` has this block when
`policy.useBT === true` (around line 6376):

```javascript
if (this.policy?.useBT === true) {
  const bb = updateBlackboard(this._btBlackboard || (this._btBlackboard = {}), ...);
  await handleThreatTree({ keeper: this }).tick(bb);    // doom/flee/rest
  await outsideAction(this).tick(bb);                   // busy/parked
  await errandAction(this).tick(bb);                    // bank/delivery
  await fightRoundsAction(this).tick(bb);               // → passFarm → passFightRounds
  return;
}
```

`fightRoundsAction` currently delegates to `keeper.passFarm()` — it is a thin
wrapper that bridges the BT slot pattern to the existing monolith method. This
is intentional: the farming loop from `m59-bt-farming.mjs` is **not yet wired
here**. It is standalone and tested but not plumbed into a live keeper.

---

## Live test state — Sasquatch (t5)

Sasquatch has `useBT: true` and is assigned to the Mausoleum (room 1006).
It is physically in room 1016 (a second Mausoleum room), has 23 mummies
present and one adjacent, 20/20 HP, vigor 92, no reagents, no food.

**It has been stalled 18+ minutes with zero kills.**

The deadlock, traced:

1. `monsters_awake = (max(swungAt, movedAt, turnedAt) > rejoinedAt)` is
   **false** — the keeper has never issued a move or swing since the last
   rejoin (all movement was via external MCP `walk_to` which does not touch
   `this.movedAt`).
2. `requireSafeWall: true` is set, so the keeper refuses to fight without a
   proven safe spot.
3. Every safe-spot trial is discarded with `"not holding a spot — nothing to
   test"` because `this.hold` is not set when `observe()` runs.
4. The `requireSafeWall` probe fires once, the walk either succeeds at
   steps_away=0 (no movedAt stamp) or fails (no spot), and the result cycles
   without ever making `monsters_awake` true.

**The fix is NOT to fight the `requireSafeWall` logic in the monolith.** The
BT farming tree (`FarmingLoopTree`) bypasses this entirely — `FightUntilDeadAction`
does not gate on `requireSafeWall` and `TakeSafeSpotAction` falls back to
standing in place rather than refusing. The path forward is to wire
`FarmingLoopTree` into the `useBT` pass directly instead of routing through
`fightRoundsAction → passFarm`.

---

## Immediate next steps

### 1. Wire `FarmingLoopTree` into the `useBT` pass

Replace the `fightRoundsAction` call in `pass()` with a direct tick of
`FarmingLoopTree` when the keeper is in farm mode:

```javascript
// In the useBT block, replace fightRoundsAction with:
if (this.mode === 'farm' && this.policy.hunt) {
  const farmTree = this._farmTree || (this._farmTree = FarmingLoopTree({
    vigorTarget: 100,
    navigateToMausoleum: GoToRoomAction({ rooms: [1006, 1016], keeper: this }),
    navigateToSell: GoToRoomAction({ rooms: [586], keeper: this }),  // Barloque
  }));
  await farmTree.tick(bb);
  return;
}
await fightRoundsAction(this).tick(bb);  // fallback for other modes
```

The tree is created once and persists — `_farmTree` on the keeper — so the
slot state in `bb._bt` survives across passes correctly.

### 2. Populate `bb.ws._safeSpots` from the keeper

`TakeSafeSpotAction` reads `bb.ws._safeSpots`. The keeper has `this.book`
(the safe-spot book) and `this.searchSafeSpot()`. Add to `updateBlackboard`:

```javascript
if (keeper._safeSpotBook) {
  bb.ws._safeSpots = keeper.searchSafeSpot(...).map(...);
}
```

Or pass them as an override: `FarmingLoopTree({ safeSpots: ... })`.

### 3. Populate `bb.ws._smithId`

`FarmingLoopTree`'s gear-fix branch needs the smith's object id. Resolve it
via `m59-merchants.mjs` / the broker's room-objects for the nearest smith, and
stash it in `bb.ws._smithId` at the start of the pass.

### 4. GOAP planner integration

The atomics already carry `pre` and `effects`. The next step is to feed these
into `m59-goap-planner.mjs` to have it auto-sequence actions rather than
hand-composing Sequences. Current planner is in `m59-goap.mjs`; the wiring
test is `m59-goap-nav-test.mjs`.

---

## What NOT to do

- **Do not import `m59-broker.mjs`** — importing runs it, takes the fleet lock,
  starts rejoin timers.
- **Do not call `leave` on any fleet character** — it drops the roster entry,
  the only record of the account password.
- **Do not restart Sasquatch's keeper to fix the deadlock** — a restart resets
  `rejoinedAt`, making `monsters_awake` false again immediately. The lock needs
  to be broken by the BT tree swinging, not by the monolith probe path.
- **Do not fight the `requireSafeWall` logic in the monolith** — that is the
  wrong layer. The BT tree is the right fix; the monolith logic is correct for
  the monolith's own contract.
- **Do not cache object ids across calls** — the server renumbers on every
  save (every 15 min). Resolve merchant/creature ids in the same batch that
  uses them.

---

## Running the tests

All tests are offline (no broker needed):

```bash
node tools/m59-bt-test.mjs
node tools/m59-bt-combat-test.mjs
node tools/m59-bt-shop-test.mjs
node tools/m59-bt-farming-test.mjs
```

The farming tests cover `GearBrokenCondition`, `EatFoodAction`, `SellLootAction`,
and `FarmingLoopTree` composition — 23 tests, all green.
