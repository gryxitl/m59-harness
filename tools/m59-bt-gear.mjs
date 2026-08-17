#!/usr/bin/env node
// m59-bt-gear.mjs -- behavior-tree node for gear upgrades (loadout-driven).
//
// WHY THIS EXISTS
//
// The outfit process (m59-outfit.mjs) is a one-shot errand: it stops the keeper,
// walks to a smith, buys, and returns. That shape is wrong for a character that
// is actively farming — it fights for control, can be interrupted, and has no
// memory of partial progress. The BT keeper ticks every second and can interleave
// gear purchases with fighting, resting, and banking.
//
// This node is the gear half of the BT keeper's town business. It runs in the
// farm tree, before fighting, and does:
//
//   1. Read the character's loadout (substrate/loadouts/<name>.json).
//   2. Check the inventory for what's missing.
//   3. If nothing missing → FAILURE (fall through to the next node).
//   4. If missing + in a town → find a seller here, buy what we can afford.
//   5. If missing + not in a town → defer (FAILURE, farm until we reach a town).
//   6. If missing + can't afford → FAILURE (farm to earn more, retry next pass).
//
// It is deliberately conservative: it only buys when the character is in a town
// (where a smith is likely), it respects the walking-money floor, and it never
// stops the keeper or takes over control. The node returns RUNNING only when it
// is mid-purchase (a short async buy), never for multi-minute travel.
//
// Travel to a town is the GOAP's job, not this node's. This node handles the
// "we are in town, let's buy the gear" half. The GOAP handles "we need gear,
// travel to a town" — once we arrive, this node picks up the purchase.
//
// No broker, no I/O at the node level — the nodes call keeper methods that do
// the I/O (sellerHere, buyItems, travel).

import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import { loadoutFor } from './m59-loadout.mjs';
import { wearBest, isArmed } from './m59-skills.mjs';

// AsyncAction (same pattern as m59-bt-farm.mjs / m59-bt-flee.mjs)
class AsyncAction {
  constructor(fn, opts = {}) {
    this.fn = fn;
    this.key = opts.key || `aa_${Math.random().toString(36).slice(2, 10)}`;
  }
  tick() { return FAILURE; }   // sync tick is a no-op; use tickAsync
  async tickAsync(bb) {
    try {
      const r = await this.fn(bb);
      return r === undefined ? SUCCESS : r;
    } catch (e) {
      return FAILURE;
    }
  }
}
const asyncAction = (fn, opts) => new AsyncAction(fn, opts);

// The room-name town check, same heuristic the provision() refill uses.
const TOWN_RE = /Raza|Mausoleum|Museum|Marion|Tos|Barloque|Jasper|Cornoth|Roq|inn|Weapon Master|Smith/i;

// Slot order: defence first, same as the outfit process.
const SLOT_ORDER = { armour: 0, shield: 1, weapon: 2 };

// Convert a loadout's gear section to the same wants shape the outfit process uses.
// Returns an array of { slot, re, fallback, what }.
function wantsFromLoadout(loadout) {
  if (!loadout?.gear) return null;
  const out = [];
  const rx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const add = (slot, list) => {
    if (!list?.length) return;
    out.push({ slot, re: new RegExp(rx(list[0]), 'i'),
               fallback: new RegExp(list.map(n => rx(n)).join('|'), 'i'),
               what: list[0] });
  };
  add('weapon', loadout.gear.weapon);
  for (const [slot, list] of Object.entries(loadout.gear.slots ?? {})) add(slot, list);
  return out.length ? out : null;
}

// What is this character missing? Read the inventory for what it owns.
// A broken piece is not stock. Returns an array of { slot, what } for each
// want that the inventory does not satisfy.
function missingGear(items, wants) {
  const have = (items || []).filter(i => {
    const n = String(i?.name ?? '');
    // A broken piece is not stock. The inventory tool carries `broken` on the row.
    if (i.broken) return false;
    return true;
  });
  const carries = (list, re) => list.some(i => re.test(String(i?.name ?? '')));
  return wants.filter(w => !carries(have, w.re) && !carries(have, w.fallback));
}

// Is the character in a town (where a smith is likely)?
function inTown(room) {
  return TOWN_RE.test(String(room?.name || ''));
}

// ---------------------------------------------------------------------------
// Node: gear_upgrade (buy missing loadout gear when in a town)
// ---------------------------------------------------------------------------

/**
 * Build the gear upgrade node.
 *
 * @param {object} keeper - the legacy keeper instance (has .s, .policy, .note, .purseNow)
 * @returns {object} a BT node with tickAsync
 */
export function gearUpgradeNode(keeper) {
  return asyncAction(async (bb) => {
    // 0. No loadout → nothing to do.
    const character = keeper.s?.client?.me?.name ?? keeper.s?.credentials?.character ?? null;
    if (!character) return FAILURE;
    const loadout = loadoutFor(character);
    if (!loadout) return FAILURE;
    const wants = wantsFromLoadout(loadout);
    if (!wants) return FAILURE;

    // DESPERATE WEAPON: if the character is completely unarmed, add a generic
    // weapon want (any weapon, cheapest first) to the end of the list. This is
    // not the loadout weapon — it is "something to hold". A 100-shilling mace
    // is better than no weapon, even if the loadout says long sword. The
    // loadout weapons come first (higher priority); the generic weapon is the
    // fallback for when the character is fighting with fists.
    const c = keeper.s?.client;
    if (!c) return FAILURE;
    const isUnarmed = !isArmed(keeper.s.client);
    const effectiveWants = isUnarmed
      ? [...wants, { slot: 'weapon', re: /sword|mace|axe|hammer|dagger|knife|spear|club|cudgel/i, fallback: /sword|mace|axe|hammer|dagger|knife|spear|club|cudgel/i, what: 'any weapon' }]
      : wants;
    // 1. What am I missing?
    const inv = await keeper.s.pacer.submit('read', () => c.requestInventory())
      .catch(() => null);
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 2000 }).catch(() => {});
    const items = c.inventory || [];
    if (!items.length) return FAILURE;   // can't read inventory, skip

    const missing = missingGear(items, effectiveWants);
    if (!missing.length) return FAILURE;   // fully stocked

    // 2. Am I in a town?
    const room = bb.room ?? keeper.s?.world?.room;
    if (!inTown(room)) {
      // Not in a town: defer. The GOAP handles "travel to a town for gear".
      // This node only handles "we are in town, buy the gear".
      // Throttle the note so it doesn't spam every second.
      if (!keeper._gearDeferNotedAt || Date.now() - keeper._gearDeferNotedAt > 60_000) {
        keeper._gearDeferNotedAt = Date.now();
        keeper.note('missing gear, but not in a town', {
          missing: missing.map(m => m.what),
          room: room?.name ?? null,
          hint: 'GOAP should route to a town; this node buys when we arrive',
        });
      }
      return FAILURE;
    }

    // 3. Can I afford it? The threshold is DYNAMIC: floor + cost of the cheapest
    // missing item. This means a character with 124 shillings and a 100-shilling mace
    // can buy the mace (124 >= 400 + 100? No. But we also check per-item below).
    //
    // Actually, the right design is: don't gate on a flat threshold here. Instead,
    // check affordability PER ITEM when we find a seller. The floor (walkingMoney) is
    // the hard floor: we never drop below it. If the cheapest missing item costs more
    // than (purse - floor), we can't buy anything and return FAILURE.
    //
    // This is what makes the threshold dynamic: a character saving for an 800-shilling
    // scale armor needs purse >= 1200 (floor + 800), but a character who just needs
    // a 100-shilling mace only needs purse >= 500 (floor + 100). And an UNARMED
    // character in a town with 124 shillings and a 100-shilling mace on the shelf
    // can buy it: 124 - 100 = 24, which is below the floor, so we DON'T buy it.
    // But if the floor is lower (say 100), we do.
    //
    // The key insight: the per-item check `cost > purse - floor` is the real gate.
    // The flat threshold here is just an early-out to avoid calling sellerHere
    // when we know we can't afford anything. To make it dynamic, we need to know
    // the cheapest missing item's price. But we don't know that until we ask a seller.
    //
    // So: remove the flat threshold. Let the per-item check do the work. If no item
    // is affordable, the loop finishes with boughtAny=false and we return FAILURE
    // with a "not enough money" note.
    let purse = keeper.purseNow?.() ?? 0;
    const floor = keeper.policy?.walkingMoney ?? 400;
    // EMERGENCY FLOOR: an unarmed character is in a survival emergency. They
    // should be allowed to drop below the normal walking floor to buy a basic
    // weapon. The emergency floor is 100 shillings — enough to buy a round of
    // stout or a small snack on the road, but not a comfortable reserve. An
    // armed character uses the normal floor.
    const effectiveFloor = isUnarmed ? Math.min(floor, 100) : floor;
    // EARLY OUT: if the purse is so low that even a 1-shilling item would drop us
    // below the effective floor, check whether the character has money in the bank.
    // If they do and they are in a town, withdraw enough to buy a weapon, then
    // continue with the purchase. This breaks the "unarmed + broke in purse + rich
    // in bank" spiral that left Lee looping between the inn and 563 for hours.
    if (purse <= effectiveFloor) {
      const bankBalance = await keeper.bankBalance?.().catch(() => null) ?? null;
      const needs = 300; // enough for a basic weapon + small buffer
      if (isUnarmed && bankBalance != null && bankBalance >= needs) {
        keeper.note('unarmed, broke in purse, withdrawing from bank', {
          purse, bank: bankBalance, withdrawing: needs,
        });
        const ok = await keeper.bankWithdraw?.(needs).catch(() => false);
        if (ok) {
          purse = keeper.purseNow?.() ?? purse;
          if (purse > effectiveFloor) {
            // Successfully withdrew, fall through to the seller search below.
          } else {
            keeper.note('bank withdraw failed or insufficient', { purse });
            if (!keeper._gearPoorNotedAt || Date.now() - keeper._gearPoorNotedAt > 120_000) {
              keeper._gearPoorNotedAt = Date.now();
              keeper.note('missing gear, but not enough money after withdraw', {
                missing: missing.map(m => m.what), purse, bank: bankBalance,
              });
            }
            return FAILURE;
          }
        } else {
          keeper.note('bank withdraw failed', { purse, bank: bankBalance });
          if (!keeper._gearPoorNotedAt || Date.now() - keeper._gearPoorNotedAt > 120_000) {
            keeper._gearPoorNotedAt = Date.now();
            keeper.note('missing gear, but not enough money', {
              missing: missing.map(m => m.what), purse, floor: effectiveFloor,
              bank: bankBalance, hint: 'could not withdraw from bank',
            });
          }
          return FAILURE;
        }
      } else {
        if (!keeper._gearPoorNotedAt || Date.now() - keeper._gearPoorNotedAt > 120_000) {
          keeper._gearPoorNotedAt = Date.now();
          keeper.note('missing gear, but not enough money', {
            missing: missing.map(m => m.what),
            purse, floor: effectiveFloor, normal_floor: floor, unarmed: isUnarmed,
            bank: bankBalance,
            hint: isUnarmed
              ? 'unarmed — emergency floor allows buying a basic weapon'
              : 'farm and bank until the purse covers the gear + walking float',
          });
        }
        return FAILURE;
      }
    }

    // 4. Find a seller here.
    // Sort missing by defence-first (armour, shield, weapon).
    const sorted = [...missing].sort((a, b) =>
      (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9));

    // BANK BEFORE BUY: calculate the total cost of everything we can afford, and
    // bank the surplus before walking to the shop. This prevents the "carrying a
    // ton of money into a death" problem. We only want to carry: (total gear cost)
    // + (walking floor). Anything above that goes in the bank first.
    if (typeof keeper.bankSurplus === 'function') {
      // Estimate the total cost of the missing items we can afford.
      let totalCost = 0;
      for (const want of sorted) {
        const pick = await keeper.sellerHere({ want: want.re }).catch(() => null);
        if (!pick) continue;
        const entry = (pick.items || []).find(i => want.re.test(String(i?.name ?? '')));
        if (!entry) continue;
        const cost = entry.cost ?? 0;
        if (cost <= purse - effectiveFloor) totalCost += cost;
      }
      const maxCarry = totalCost + effectiveFloor;
      if (purse > maxCarry && maxCarry > 0) {
        const surplus = purse - maxCarry;
        keeper.note('banking before gear purchase', {
          purse, total_cost: totalCost, floor: effectiveFloor,
          banking: surplus, keeping: maxCarry,
        });
        await keeper.bankSurplus().catch(() => {});
        purse = keeper.purseNow?.() ?? purse - surplus;
      }
    }

    // Try each missing item in priority order. Ask a seller here for each.
    let boughtAny = false;
    for (const want of sorted) {
      const re = want.re;
      const pick = await keeper.sellerHere({ want: re }).catch(() => null);
      if (!pick) continue;   // no seller here with this item, try next

      const entry = (pick.items || []).find(i => re.test(String(i?.name ?? '')));
      if (!entry) continue;
      const cost = entry.cost ?? 0;
      if (cost > purse - effectiveFloor) continue;   // can't afford this one

      // Buy it.
      try {
        const start = c.evSeq;
        await keeper.s.pacer.submit('buy', () => c.buyItems(pick.seller.id, [{ id: entry.id, amount: 1 }]));
        await c.waitFor({ since: start, timeoutMs: 4000 }).catch(() => ({ events: [] }));
        purse -= cost;
        boughtAny = true;
        keeper.note('bought gear', {
          item: entry.name, cost: entry.cost, slot: want.slot,
          missing_still: sorted.filter(m => m !== want).map(m => m.what),
        });
      } catch (e) {
        // Buy failed; try the next item.
        keeper.note('gear purchase failed', { item: entry.name, why: e.message });
      }
    }

    if (!boughtAny) {
      // In a town, have some money, but either no seller here stocks what we need,
      // or nothing is affordable. Distinguish the two for the note.
      const anySeller = await keeper.sellerHere({}).catch(() => null);
      if (!anySeller) {
        if (!keeper._gearNoSellerNotedAt || Date.now() - keeper._gearNoSellerNotedAt > 120_000) {
          keeper._gearNoSellerNotedAt = Date.now();
          keeper.note('missing gear, no seller here', {
            missing: sorted.map(m => m.what),
            room: room?.name ?? null,
            hint: 'the GOAP should route to a town that stocks these items',
          });
        }
      } else {
        if (!keeper._gearPoorNotedAt || Date.now() - keeper._gearPoorNotedAt > 120_000) {
          keeper._gearPoorNotedAt = Date.now();
          keeper.note('missing gear, but nothing affordable here', {
            missing: sorted.map(m => m.what),
            purse, floor,
            hint: 'farm and bank until the purse covers the cheapest missing item + walking float',
          });
        }
      }
      return FAILURE;
    }

    // Refresh inventory after buying so the next pass sees the new item.
    await keeper.s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 2000 }).catch(() => {});
    // Wear it.
    await wearBest(keeper.s).catch(() => {});

    keeper.note('gear upgrade pass done', {
      bought: true,
      still_missing: (() => {
        const items2 = c.inventory || [];
        return missingGear(items2, effectiveWants).map(m => m.what);
      })(),
    });

    return SUCCESS;   // bought something; the pass is spent
  });
}
