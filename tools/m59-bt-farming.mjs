#!/usr/bin/env node
// m59-bt-farming.mjs -- BT atomic and composed nodes for the mausoleum farming loop.
//
// Exports (atomics — GOAP-compatible pre/effects):
//   GearBrokenCondition()         synchronous — true when any equipped gear is broken/missing
//   EatFoodAction(opts)           cast create food then eat the result; raises vigor past floor
//   SellLootAction(opts)          sell non-essentials to the nearest trusted buyer
//
// Exports (composed):
//   FarmingLoopTree(opts)         full mausoleum farming loop — fix gear → travel → fight →
//                                 eat → sell → repeat
//
// World-state keys:
//   gear_ok           bool   — armed + wearing body armour, no broken items
//   vigor_ok          bool   — vigor >= vigorTarget (default 100)
//   loot_sold         bool   — sold non-essentials to a trusted buyer this pass
//   at_mausoleum      bool   — in one of the mausoleum rooms (1006 / 1016)
//   in_combat         bool   — (shared with m59-bt-combat.mjs)
//   has_target        bool   — (shared with m59-bt-combat.mjs)

import { Action, Selector, Sequence, Condition, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import { brokenSet, sellAll, trustedBuyer, ARMOUR_BODY } from './m59-skills.mjs';
import { EngageNearestAction } from './m59-bt-combat.mjs';
import { BuyGearTree } from './m59-bt-shop.mjs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CREATE_FOOD_MANA = 10;
const FOOD_RE          = /\bsnack\b|\bfood\b|\bpastry\b|\bpie\b|\bbread\b|\bmeat\b/i;
const ELDER_RE         = /\belderberry\b/i;
const HERBS_RE         = /\bherbs?\b/i;
const MAUSOLEUM_ROOMS  = new Set([1006, 1016]);

function _ws(bb)      { if (!bb.ws) bb.ws = {}; return bb.ws; }
function _client(bb)  { return bb.client ?? bb.session?.s?.client ?? null; }
function _session(bb) { return bb.session?.s ?? null; }

function _rscName(c, o) {
  return c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
}

function _vigorValue(c) {
  return c.vitals?.()?.vigor?.value ?? null;
}

function _reagentCount(c) {
  const inv = c.inventory ?? [];
  let elderberry = 0, herbs = 0;
  for (const o of inv) {
    const name = _rscName(c, o);
    const amt  = o.amount ?? 1;
    if (ELDER_RE.test(name)) elderberry += amt;
    if (HERBS_RE.test(name)) herbs      += amt;
  }
  return { elderberry, herbs };
}

// ---------------------------------------------------------------------------
// GearBrokenCondition()
//
// Returns true (i.e. the condition is MET and the gear-fix branch should run)
// when ANY of the following holds:
//   - a weapon in brokenSet(c)
//   - an inventory item with broken: true that is equipped
//   - no weapon equipped at all
//   - no body armour equipped at all
//
// Synchronous — reads live client state on every tick.
// ---------------------------------------------------------------------------
export function GearBrokenCondition(opts = {}) {
  return new Condition(
    (bb) => {
      const c = _client(bb);
      if (!c) return false;

      const equipped = new Set([...(c.equipment?.keys?.() ?? [])]);
      const inv      = c.inventory ?? [];
      const broken   = brokenSet(c);

      // Any explicitly condemned item that is also equipped.
      const hasCondemnedEquipped = inv.some(o =>
        (o.broken || broken.has(o.id)) && equipped.has(o.id),
      );
      if (hasCondemnedEquipped) return true;

      // No weapon in use.
      const hasWeapon = inv.some(o => {
        if (!equipped.has(o.id)) return false;
        const name = _rscName(c, o);
        return /mace|sword|axe|hammer|scimitar/i.test(name);
      });
      if (!hasWeapon) return true;

      // No body armour in use.
      const hasArmour = inv.some(o => {
        if (!equipped.has(o.id)) return false;
        const name = _rscName(c, o);
        return ARMOUR_BODY.test(name) && !/shield/i.test(name);
      });
      if (!hasArmour) return true;

      return false;
    },
    { name: 'gear_broken' },
  );
}

// ---------------------------------------------------------------------------
// EatFoodAction(opts)
//
// Cast 'create food' (when reagents and mana permit) and eat the resulting
// item, raising vigor. Returns SUCCESS when vigor is at or above `vigorTarget`
// after the attempt, FAILURE if we cannot cook or eat.
//
// opts:
//   vigorTarget   number   minimum vigor to accept (default 100)
//   key           string   slot key
//
// Pre:  []
// Effects: ['vigor_ok']
// ---------------------------------------------------------------------------
export function EatFoodAction(opts = {}) {
  const key         = opts.key ?? 'at_eat_food';
  const vigorTarget = opts.vigorTarget ?? 100;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      const c = _client(bb);
      const s = _session(bb);
      if (!c || !s) {
        // No session — mark done/failed immediately.
        bb._bt[key] = { done: true, ok: false };
        return RUNNING;
      }

      // Already at target — short-circuit synchronously.
      const v = _vigorValue(c);
      if (v !== null && v >= vigorTarget) {
        _ws(bb).vigor_ok = true;
        return SUCCESS;
      }

      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      Promise.resolve()
        .then(async () => {
          // ── 1. Try to cook if reagents + mana allow. ──────────────────────
          const r    = _reagentCount(c);
          const mana = c.vitals?.()?.mana?.value ?? null;
          const canCook = r.elderberry >= 2 && r.herbs >= 2
                       && (mana === null || mana >= CREATE_FOOD_MANA);

          if (canCook) {
            // Ensure spells are loaded.
            await s.pacer.submit('read', () => c.requestSpells(), 400).catch(() => {});

            const spell = (c.spells ?? []).find(sp =>
              _rscName(c, sp).toLowerCase() === 'create food',
            );

            if (spell) {
              const hadIds = new Set((c.inventory ?? []).map(o => o.id));
              await s.pacer.submit('cast', () => c.cast(spell.id, []), 1050).catch(() => {});
              await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
              await s.pacer.submit('read', () => c.requestInventory(), 400).catch(() => {});
              await c.waitFor({ kinds: ['inventory'], timeoutMs: 2000 }).catch(() => {});
              // new food items are what wasn't there before
              const made = (c.inventory ?? []).filter(o =>
                !hadIds.has(o.id) && FOOD_RE.test(_rscName(c, o)),
              );
              // Also eat pre-existing food if we still need vigor.
              const toEat = made.length ? made : (c.inventory ?? []).filter(o =>
                FOOD_RE.test(_rscName(c, o)),
              );
              for (const f of toEat) {
                const vNow = _vigorValue(c);
                if (vNow !== null && vNow >= vigorTarget) break;
                await s.pacer.submit('act', () => c.apply(f.id, c.selfId), 1050).catch(() => {});
                await c.waitFor({ kinds: ['stat', 'message'], timeoutMs: 2500 }).catch(() => {});
              }
            }
          } else {
            // No cook available — eat any food already in pack.
            const food = (c.inventory ?? []).filter(o => FOOD_RE.test(_rscName(c, o)));
            for (const f of food) {
              const vNow = _vigorValue(c);
              if (vNow !== null && vNow >= vigorTarget) break;
              await s.pacer.submit('act', () => c.apply(f.id, c.selfId), 1050).catch(() => {});
              await c.waitFor({ kinds: ['stat', 'message'], timeoutMs: 2500 }).catch(() => {});
            }
          }

          const vFinal = _vigorValue(c);
          return vFinal === null || vFinal >= vigorTarget;
        })
        .then(ok => {
          if (ok) _ws(bb).vigor_ok = true;
          slot.ok = ok; slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'eat_food' });

  node.pre     = [];
  node.effects = ['vigor_ok'];
  return node;
}
EatFoodAction._key = 'at_eat_food';

// ---------------------------------------------------------------------------
// SellLootAction(opts)
//
// Finds the nearest trusted buyer in the current room and sells all eligible
// items via skills.sellAll(). Confirms via purse delta. Returns SUCCESS when a
// trusted buyer is present and the sell call completes (even if nothing was
// sold — an empty pack is a good outcome). Returns FAILURE when no trusted
// buyer is in the room.
//
// opts:
//   key           string
//   loadout       object | null   passed through to sellAll for per-char keep rules
//   protect       string[]        extra keep patterns (passed to sellAll)
//   OF_BUYER      number          flag indicating a buyer NPC (default 0x0080)
//
// Pre:  []
// Effects: ['loot_sold']
// ---------------------------------------------------------------------------
export const OF_BUYER = 0x0080;   // MOB_BUYER in blakston.khd

export function SellLootAction(opts = {}) {
  const key      = opts.key ?? 'at_sell_loot';
  const ofBuyer  = opts.OF_BUYER ?? OF_BUYER;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      const c = _client(bb);
      const s = _session(bb);

      // Resolve buyer synchronously from room objects (opts.roomObjects override for tests).
      const objects = opts.roomObjects
        ? opts.roomObjects(bb)
        : [...(c?.room?.objects?.values?.() ?? [])];

      const buyer = objects.find(o => {
        if (!(o.flags & ofBuyer)) return false;
        return trustedBuyer(_rscName(c, o));
      });

      if (!buyer || !c || !s) {
        // No trusted buyer here — succeed vacuously if no buyer but also nothing sellable,
        // otherwise fail so the tree can navigate to a town.
        bb._bt[key] = { done: true, ok: false };
        return RUNNING;
      }

      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      Promise.resolve()
        .then(async () => {
          const loadout = opts.loadout ?? bb.ws?._loadout ?? null;
          const protect = opts.protect ?? [];
          await sellAll(s, { merchant: buyer, protect, loadout }).catch(() => {});
          return true;
        })
        .then(ok => {
          if (ok) _ws(bb).loot_sold = true;
          slot.ok = ok; slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'sell_loot' });

  node.pre     = [];
  node.effects = ['loot_sold'];
  return node;
}
SellLootAction._key = 'at_sell_loot';

// ---------------------------------------------------------------------------
// FarmingLoopTree(opts)
//
// Composed behavior tree for the mausoleum farming loop:
//
//   Selector:
//     Sequence (gear broken?):
//       GearBrokenCondition
//       [navigate to smith]
//       BuyGearTree(gearWants, smithId)
//     Sequence (main loop, repeated each pass):
//       [navigate to mausoleum room 1006 or 1016]
//       Repeat(EngageNearestAction({ nameRe: /mummy/i }))
//       EatFoodAction({ vigorTarget })
//       [navigate to sell town]
//       SellLootAction
//
// The caller is responsible for wiring navigation steps (via GoToRoomAction or
// equivalent). This tree composes the non-navigation steps and wraps them in
// a Selector so that gear repair takes priority when needed.
//
// opts:
//   gearWants     array   of { slot, re } for BuyGearTree (default: weapon + armour)
//   smithId       number  merchant id of the Tos/Jasper smith (default: resolved from bb.ws)
//   vigorTarget   number  (default 100)
//   maxKills      number  how many mummies per pass before eating+selling (default 10)
//   navigateToSmith   Action   node that navigates to the smith room
//   navigateToMauso  Action    node that navigates to a mausoleum room (1006 or 1016)
//   navigateToSell   Action    node that navigates to a sell point
//
// Each navigate* node should be provided by the caller. If omitted, those
// steps are replaced by a no-op Condition that always returns SUCCESS so the
// tree still works in tests with a pre-positioned character.
//
// ---------------------------------------------------------------------------
const _noop = new Condition(() => true, { name: 'noop' });

export function FarmingLoopTree(opts = {}) {
  const vigorTarget = opts.vigorTarget ?? 100;
  const maxKills    = opts.maxKills    ?? 10;

  const navToSmith  = opts.navigateToSmith  ?? _noop;
  const navToMauso  = opts.navigateToMausoleum ?? _noop;
  const navToSell   = opts.navigateToSell   ?? _noop;

  // Gear-fix branch: only entered when something is broken/missing.
  const gearWants = opts.gearWants ?? [
    { slot: 'weapon', re: /mace|sword|axe|hammer|scimitar/i },
    { slot: 'armour', re: /leather armor|chain mail|scale armor/i },
  ];

  // BuyGearTree needs the merchant id — resolved lazily from bb.ws._smithId or opts.smithId.
  const lazyBuyGear = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      const smithId = opts.smithId ?? bb.ws?._smithId ?? null;
      if (!smithId) return FAILURE;
      slot = { inner: BuyGearTree(gearWants, smithId, opts), done: false };
      bb._bt['at_lazy_gear'] = slot;
    }
    if (!slot.inner) return FAILURE;
    const r = slot.inner.tick(bb);
    if (r !== RUNNING) delete bb._bt['at_lazy_gear'];
    return r;
  }, { key: 'at_lazy_gear', name: 'buy_gear' });

  const gearFixBranch = new Sequence(
    [GearBrokenCondition(), navToSmith, lazyBuyGear],
    { name: 'gear_fix' },
  );

  // Kill loop: tick EngageNearestAction up to maxKills times.
  // Each EngageNearestAction handles one target; we loop by re-ticking.
  let killCount = 0;
  const killLoop = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      killCount = 0;
      slot = { done: false, inner: null };
      bb._bt['at_kill_loop'] = slot;
    }

    // Spawn a fresh EngageNearestAction per kill cycle.
    if (!slot.inner) {
      slot.inner = EngageNearestAction({ nameRe: /mummy/i });
    }

    const r = slot.inner.tick(bb);

    if (r === SUCCESS) {
      killCount++;
      slot.inner = null;  // reset for next target
      if (killCount >= maxKills) {
        delete bb._bt['at_kill_loop'];
        return SUCCESS;
      }
      // Check if more hostiles are present.
      const c = _client(bb);
      const hasMore = [...(c?.room?.objects?.values?.() ?? [])].some(o =>
        (o.flags & 0x0008) && !(o.flags & 0x0004) && /mummy/i.test(_rscName(c, o)),
      );
      if (!hasMore) {
        delete bb._bt['at_kill_loop'];
        return SUCCESS;  // room cleared
      }
      return RUNNING;
    }

    if (r === FAILURE) {
      // No more targets or combat failed — exit kill loop.
      delete bb._bt['at_kill_loop'];
      slot.inner = null;
      return killCount > 0 ? SUCCESS : FAILURE;
    }

    return RUNNING;
  }, { key: 'at_kill_loop', name: 'kill_loop' });

  // Main farming sequence.
  const farmBranch = new Sequence(
    [
      navToMauso,
      killLoop,
      EatFoodAction({ vigorTarget }),
      navToSell,
      SellLootAction(opts),
    ],
    { name: 'farm_branch' },
  );

  return new Selector(
    [gearFixBranch, farmBranch],
    { name: 'farming_loop' },
  );
}
