#!/usr/bin/env node
// m59-bt-shop.mjs -- BT atomic nodes for buying gear from merchants.
//
// Exports:
//   BrowseShopAction(merchantId)       open shop list, store items in bb.ws.shop[merchantId]
//   BuyItemAction(merchantId, itemId)  buy one item; pre: shop_browsed_{merchantId}
//   FindMerchantForSlot(slot, opts)    resolve nearest merchant → store id in bb.ws
//   BuyGearTree(slot, opts)            composed Selector: browse → buy matching item
//
// World-state keys (extensions of m59-bt-atomics):
//   shop_browsed_{merchantId}  bool   — shop list fetched successfully
//   bought_{itemId}            bool   — item purchased and in inventory
//   merchant_for_{slot}        bool   — bb.ws._merchantFor[slot] is set

import { Action, Selector, Sequence, Condition, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import { EquipWeaponAction, WearArmourAction } from './m59-bt-atomics.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _ws(bb) {
  if (!bb.ws) bb.ws = {};
  return bb.ws;
}

function _client(bb) { return bb.client ?? bb.session?.s?.client ?? null; }
function _session(bb) { return bb.session?.s ?? null; }

// ---------------------------------------------------------------------------
// BrowseShopAction(merchantId)
//
// Opens the shop list for a merchant standing in the current room.
// Sends c.buy(merchantId) (which requests BP_FOR_SALE), then waits for the
// 'shop' event. Stores the full item list in bb.ws._shop[merchantId].
//
// Pre:  []   (merchant must be nearby — caller should ensure this via navigation)
// Effects: ['shop_browsed_{merchantId}']
// ---------------------------------------------------------------------------
export function BrowseShopAction(merchantId) {
  const key = `at_browse_${merchantId}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const since = c.evSeq ?? 0;
          // Open the shop — this sends BP_REQ_BUY with the merchant's id,
          // which causes the server to push BP_FOR_SALE back.
          await s.pacer.submit('buy', () => c.buy(merchantId), 500)
            .catch(() => {});
          // Wait for the shop event.
          const ev = await c.waitFor({
            since, kinds: ['shop', 'message'], timeoutMs: 4000,
          }).catch(() => ({ events: [] }));
          const shopEv = (ev.events ?? []).find(e => e.kind === 'shop');
          if (!shopEv) return null;
          return { sellerId: shopEv.sellerId ?? merchantId, items: shopEv.items ?? [] };
        })
        .then(shop => {
          if (shop) {
            const ws = _ws(bb);
            if (!ws._shop) ws._shop = {};
            ws._shop[merchantId] = shop;
            ws[`shop_browsed_${merchantId}`] = true;
          }
          slot.ok = !!shop;
          slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: `browse_shop_${merchantId}` });

  node.pre     = [];
  node.effects = [`shop_browsed_${merchantId}`];
  return node;
}

// ---------------------------------------------------------------------------
// BuyItemAction(merchantId, itemId)
//
// Buys a specific item by id using c.buyItems, then waits for the item to
// appear in inventory. The shop must already be open (shop_browsed key set).
//
// Pre:  ['shop_browsed_{merchantId}']
// Effects: ['bought_{itemId}', 'holding_{itemId}']
// ---------------------------------------------------------------------------
export function BuyItemAction(merchantId, itemId) {
  const key = `at_buy_${itemId}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const since = c.evSeq ?? 0;
          const invBefore = (c.inventory ?? []).map(o => o.id);

          // c.buyItems sends BP_REQ_BUY with the item list.
          await s.pacer.submit('buy', () =>
            c.buyItems(merchantId, [{ id: itemId }]),
          500).catch(() => {});

          // Wait for inventory change or message.
          const r = await c.waitFor({
            since, kinds: ['inventory', 'message'], timeoutMs: 5000,
          }).catch(() => ({ timedOut: true }));

          if (r.timedOut) return false;
          // Confirm the item landed in inventory.
          return (c.inventory ?? []).some(o => o.id === itemId && !invBefore.includes(o.id));
        })
        .then(ok => {
          if (ok) {
            const ws = _ws(bb);
            ws[`bought_${itemId}`]  = true;
            ws[`holding_${itemId}`] = true;
          }
          slot.ok = ok;
          slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: `buy_item_${itemId}` });

  node.pre     = [`shop_browsed_${merchantId}`];
  node.effects = [`bought_${itemId}`, `holding_${itemId}`];
  return node;
}

// ---------------------------------------------------------------------------
// FindMerchantForSlot(slot, itemRe, opts)
//
// Scans the current room for a merchant whose shop list contains an item
// matching `itemRe` (a RegExp or string). Stores the merchant's id and the
// matching item id in bb.ws._merchantFor[slot].
//
// This is a synchronous Condition-style node — it succeeds if any matching
// merchant is in the room right now, or fails immediately so the caller can
// navigate to one.
//
// opts.roomObjects  fn(bb) → iterable of { id, name, flags }   (for testing)
// opts.OF_MERCHANT  number                                      (default 0x0040)
//
// Pre:  []
// Effects: ['merchant_for_{slot}']
// ---------------------------------------------------------------------------
export const OF_MERCHANT = 0x0040;   // Meridian 59 object flag for merchants

export function FindMerchantForSlot(slotName, itemRe, opts = {}) {
  const key    = `at_find_merchant_${slotName}`;
  const reTest = typeof itemRe === 'string'
    ? new RegExp(itemRe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    : itemRe;
  const ofMerchant = opts.OF_MERCHANT ?? OF_MERCHANT;

  // This action is synchronous — no async I/O. It reads bb from the live
  // client's room.objects. Returns immediately.
  const node = new Action((bb) => {
    const objects = opts.roomObjects
      ? opts.roomObjects(bb)
      : (() => {
          const c = _client(bb);
          return c ? [...(c.room?.objects?.values?.() ?? [])] : [];
        })();

    // Look for any NPC with MOB_SELLER flag.
    for (const obj of objects) {
      if (!(obj.flags & ofMerchant)) continue;
      // We need the shop list to know what it sells. Check bb._shop cache first.
      const ws = _ws(bb);
      const cached = ws._shop?.[obj.id];
      if (cached) {
        const match = cached.items.find(i => reTest.test(String(i.name ?? '')));
        if (match) {
          if (!ws._merchantFor) ws._merchantFor = {};
          ws._merchantFor[slotName] = { merchantId: obj.id, itemId: match.id, itemName: match.name };
          ws[`merchant_for_${slotName}`] = true;
          return SUCCESS;
        }
      }
      // No cache — store the merchant id so BrowseShopAction can open it.
      if (!ws._candidateMerchants) ws._candidateMerchants = [];
      if (!ws._candidateMerchants.includes(obj.id)) ws._candidateMerchants.push(obj.id);
    }

    return FAILURE;
  }, { key, name: `find_merchant_${slotName}` });

  node.pre     = [];
  node.effects = [`merchant_for_${slotName}`];
  return node;
}

// ---------------------------------------------------------------------------
// BuyAndEquipItem(slotName, itemRe, merchantId, opts)
//
// Composed Sequence that:
//   1. Browses the merchant's shop (BrowseShopAction)
//   2. Finds the matching item in the cached list
//   3. Buys it (BuyItemAction)
//   4. Equips it (EquipWeaponAction or WearArmourAction depending on slot)
//
// Returns a Sequence node ready to be ticked by a GoapExecutor or directly.
//
// opts.slot  'weapon' | 'armour' | 'shield' | string   (default: infer from itemRe)
// ---------------------------------------------------------------------------
export function BuyAndEquipItem(slotName, itemRe, merchantId, opts = {}) {
  const reTest = typeof itemRe === 'string'
    ? new RegExp(itemRe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    : itemRe;

  const browse = BrowseShopAction(merchantId);

  // Resolve: after browsing, find the item id and build a BuyItemAction.
  // Because itemId is only known after browsing, we use a lazy Action that
  // reads from bb.ws._shop on its first tick.
  const lazyBuyKey = `at_lazy_buy_${merchantId}_${slotName}`;
  const lazyBuy = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      const ws = _ws(bb);
      const shopData = ws._shop?.[merchantId];
      if (!shopData) return FAILURE;  // shop not browsed yet

      const match = shopData.items.find(i => reTest.test(String(i.name ?? '')));
      if (!match) return FAILURE;  // item not sold here

      // Store resolved item info.
      if (!ws._merchantFor) ws._merchantFor = {};
      ws._merchantFor[slotName] = { merchantId, itemId: match.id, itemName: match.name };

      slot = { itemId: match.id, done: false, ok: false };
      bb._bt[lazyBuyKey] = slot;

      const inner = BuyItemAction(merchantId, match.id);
      slot._inner = inner;
      // Fire first tick on inner immediately.
      const r = inner.tick(bb);
      if (r === SUCCESS) { slot.ok = true; slot.done = true; }
      else if (r === FAILURE) { slot.done = true; }
      return RUNNING;
    }

    if (!slot.done) {
      const r = slot._inner?.tick(bb);
      if (r === SUCCESS) { slot.ok = true; slot.done = true; return RUNNING; }
      if (r === FAILURE) { slot.done = true; }
      return RUNNING;
    }

    const ok = slot.ok;
    if (ok) {
      const ws = _ws(bb);
      const itemId = slot.itemId;
      ws[`bought_${itemId}`]  = true;
      ws[`holding_${itemId}`] = true;
    }
    delete bb._bt[lazyBuyKey];
    return ok ? SUCCESS : FAILURE;
  }, { key: lazyBuyKey, name: `lazy_buy_${slotName}` });

  lazyBuy.pre     = [`shop_browsed_${merchantId}`];
  lazyBuy.effects = [`holding_${slotName}_item`];

  // Equip step — picks the right action by slot.
  const equip = slotName === 'weapon'
    ? EquipWeaponAction()
    : WearArmourAction({ slots: slotName !== 'weapon' ? [slotName] : undefined });

  return new Sequence([browse, lazyBuy, equip],
    { name: `buy_and_equip_${slotName}` });
}

// ---------------------------------------------------------------------------
// BuyGearTree(wants, merchantId, opts)
//
// Top-level composed tree: for each item slot in `wants`, run a BuyAndEquipItem
// sequence. Uses a Selector so that already-satisfied slots are skipped by the
// Condition guards below.
//
// wants: array of { slot, re, what }   (same shape as m59-outfit.mjs wantsFor())
//
// Returns a Selector node (tries each slot's Sequence in order).
// ---------------------------------------------------------------------------
export function BuyGearTree(wants, merchantId, opts = {}) {
  const branches = wants.map(w => {
    const alreadyOwned = new Condition(
      bb => {
        const c = _client(bb);
        if (!c) return false;
        const inv = c.inventory ?? [];
        const using = new Set([...(c.equipment?.values?.() ?? [])].map(o => o.id));
        return inv.some(i => w.re.test(String(i.name ?? '')) && !i.broken)
            || [...using].some(id => {
                 const obj = c.room?.objects?.get?.(id) ?? c.inventory?.find?.(i => i.id === id);
                 return obj && w.re.test(String(obj.name ?? ''));
               });
      },
      { name: `already_has_${w.slot}` },
    );

    const buy = BuyAndEquipItem(w.slot, w.re, merchantId, opts);

    // Sequence: skip if already owned, otherwise buy.
    return new Selector([alreadyOwned, buy], { name: `gear_slot_${w.slot}` });
  });

  return new Sequence(branches, { name: 'buy_gear_tree' });
}
