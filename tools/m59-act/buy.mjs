#!/usr/bin/env node
// m59-act/buy.mjs -- BUY ONE ITEM FROM A MERCHANT.
//
// The packet is BP_REQ_BUY {4,OBJECT} — the item id from the merchant's
// buy list. The server checks the purse, decrements it, and sends the item
// into the pack. No negotiation, no trade protocol — unlike selling, buying
// is a one-way street.
//
// WHAT THE ATOMIC CHECKS BEFORE SENDING:
//   THE ITEM IS IN THE MERCHANT'S BUY LIST. The client caches the buy list
//   when the merchant's BP_SELL_LIST arrives (the 'buy-list' event). Buying
//   an id that is not in the list is a packet the server drops.
//   THE PURSE COVERS THE COST. The server refuses when the purse is short,
//   and the refusal is a message. Checking locally is a courtesy — it saves
//   a round-trip and lets the planner reason about "can I afford this"
//   without executing. The check is a REFUSAL, not a confirmation: the
//   purse can change between the check and the send, and the server's
//   answer is the one that counts.
//
// WHAT IT DOES NOT DO:
//   IT DOES NOT SELL. Selling is the trade protocol (offer -> counter ->
//   accept) and has its own atomic.
//   IT DOES NOT WALK. The merchant must be in the room. A planner that
//   needs to travel to a shop plans the travel separately.
//   IT DOES NOT REFRESH THE INVENTORY. The caller re-reads when it needs to
//   confirm the item arrived.

import { FOOD_RE } from '../m59-worldstate.mjs';

import { affordances } from '../m59-parse.mjs';

/**
 * buy(client, session, { itemId, waitMs })
 *
 * Sends BP_REQ_BUY for one item. Returns { sent, bought, reason }.
 *
 * `bought` is the item name on success, null on refusal.
 */
const WEAPON_RE = /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow/i;

export async function buy(client, session, { itemId, waitMs = 1200, name: wantName } = {}) {
  if (!client || !session) return { sent: false, bought: null, reason: 'no client or session' };
  const c = client;

  // ONE INTERACTION PER CALL, and buying is really THREE of them: get near the
  // merchant, open the shop, hand over the money. This used to do all three in one
  // call, inside a `for (const seller of merchants)` loop that walked up to 20 steps
  // and waited 4s per merchant -- so a buy could hold the pass for tens of seconds
  // with nothing sampling health, and the sweep's no-loop-around-an-await rule exists
  // precisely to stop that.
  //
  // So each call advances exactly one phase and returns. The keeper calls again next
  // pass, which is a re-read of the world between every phase rather than a plan made
  // once and executed blind.
  let buyList = c.buyList;
  // STALE LIST: the cache is per-room (a Raza weapon list must not suppress
  // the Marion smith trip or offer Raza prices in Marion). Drop it when the
  // room changed since it was cached.
  try {
    const rn = session?.world?.room?.num ?? client?.room?.num ?? null;
    if (buyList?.room != null && rn != null && buyList.room !== rn) { buyList = null; c.buyList = null; }
  } catch { /* keep the list on lookup failure */ }
  let answered = null;  // hoisted: the purchase phase (outside the open-shop block) needs the seller

  if (!buyList?.items?.length) {
    const objects = c.room?.objects;
    const list = objects instanceof Map ? [...objects.values()]
               : Array.isArray(objects) ? objects : [];
    const merchants = list.filter(o => affordances(o.flags ?? 0).includes('buy'));
    if (!merchants.length)
      return { sent: false, bought: null, reason: 'no merchant in this room' };

    // THE AFFORDANCE IS NOT PROOF THE OBJECT TRADES. A shop room can hold several
    // `buy`-affordance objects — the merchant NPC, a "buying items" prompt, a bartender
    // who sells nothing — and only SOME of them actually open a shop list. The legacy
    // keeper (autopilot.sellerHere) learned this the hard way: a room with two `buy`
    // objects where the first (Parrin) "opens no shop list at all" made every character
    // ask the wrong one and file "the merchant never opened a shop list" — 87 times in a
    // day. The fix is to TRY EACH CANDIDATE IN TURN and take the first that answers with
    // a non-empty list. That is what we do here: freeze the tick driver (its move/turn
    // packets would interrupt the shop query), ask each candidate, and keep the first
    // that returns items.
    const loop = session._tickLoop;
    // Nearest-first so we ask the one we're standing at before touring the room.
    const me = c.self;
    const ranked = me
      ? [...merchants].sort((a, b) =>
          Math.hypot((a.col ?? 0) - me.col, (a.row ?? 0) - me.row)
        - Math.hypot((b.col ?? 0) - me.col, (b.row ?? 0) - me.row))
      : merchants;

    if (loop) loop._frozen = true;
    // WAIT UNTIL SETTLED before asking for the shop. The approach just sent a move to
    // get us adjacent to the merchant; if a position packet is still draining when we
    // fire `c.buy`, the server sees us mid-move and replies with movement messages
    // ("You walk...") instead of a shop list — the atomic then gets 4 messages, no shop,
    // and files "no reply". The manual /action shop override worked because it was
    // called while the character was already still. Watch the server-confirmed position
    // and wait until it has not moved for ~800ms (genuinely stopped), up to 3s.
    {
      const posKey = () => { const p = c.self; return p ? `${p.col},${p.row}` : 'none'; };
      const settledStart = Date.now();
      let lastKey = posKey(), lastChange = Date.now();
      const settledAt = await new Promise(resolve => {
        const iv = setInterval(() => {
          const k = posKey();
          if (k !== lastKey) { lastKey = k; lastChange = Date.now(); }
          const now = Date.now();
          if (now - lastChange > 800) { clearInterval(iv); resolve('settled'); }
          else if (now - settledStart > 3000) { clearInterval(iv); resolve('timeout'); }
        }, 150);
      });
      if (process.env.M59_BUY_DEBUG !== '0') console.error(`[buydbg] settled=${settledAt} at ${posKey()}`);
    }
    // ONE MERCHANT PER CALL — NOT A LOOP. The no-loop-around-an-await rule (the buy atomic
    // must be interruptible between iterations, the caller re-invokes each pass) forbids a
    // `for` over merchants with an await inside. A room can hold several `buy`-affordance
    // objects (the merchant, a "buying items" prompt, a bartender who sells nothing) and
    // only SOME open a shop list, so we remember the ids already tried this session in
    // session._buyTried and skip them; each call asks the next untried candidate, and a
    // failed one is recorded so the next call moves on. The caller (the buy intent) re-fires
    // every tick until one answers or the list is exhausted.
    const tried = (session._buyTried ??= new Set());
    // Reset the skip list if the character changed rooms (new room, new merchants).
    const roomNum = c.room?.num ?? c.room?.id ?? null;
    if (roomNum != null && session && session._buyTriedRoom !== roomNum) {
      tried.clear();
      session._buyTriedRoom = roomNum;
    }
    const candidate = ranked.find(o => o?.id != null && !tried.has(o.id)) ?? null;
    if (!candidate) {
      if (loop) loop._frozen = false;
      return { sent: true, bought: false, reason: 'no merchant in this room opened a shop list' };
    }
    if (process.env.M59_BUY_DEBUG !== '0') console.error(`[buydbg] trying merchant ${candidate.name ?? candidate.id} (id ${candidate.id}) flags=${candidate.flags}`);
    try {
      const before = c.evSeq;
      await session.pacer.submit('buy', () => c.buy(candidate.id), 300).catch(() => {});
      const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 })
                        .catch(() => ({ events: [] }));
      if (process.env.M59_BUY_DEBUG !== '0') console.error(`[buydbg] merchant ${candidate.id}: got ${ev.events?.length ?? 0} events: ${ev.events?.map(e=>e.kind).join(',') || 'none'}`);
      const shop = ev.events?.find(e => e.kind === 'shop');
      const items = shop?.items ?? [];
      if (items.length) answered = { seller: candidate, items };
      else tried.add(candidate.id);  // this one sold nothing; skip it next call
    } finally {
      if (loop) loop._frozen = false;
    }

    if (!answered) {
      // No candidate in the room opened a shop list. `bought: FALSE` (not null) so the
      // goal-skip counts it as a refusal after repeated failures.
      return { sent: true, bought: false, reason: 'no merchant in this room opened a shop list' };
    }
    buyList = { items: answered.items };
    try { buyList.room = session?.world?.room?.num ?? client?.room?.num ?? null; } catch {}
    c.buyList = buyList;  // cache so later passes skip the re-open
  }

  // PHASE 3 -- the purchase.
  const nameOf = (i) => c.rsc?.get?.(i.nameRsc) ?? i.name ?? '';
  let entry;
  if (itemId != null) {
    entry = buyList.items.find(i => i.id === itemId);
    if (!entry)
      return { sent: false, bought: null, reason: `item ${itemId} not in the buy list` };
  } else if (wantName) {
    entry = buyList.items.find(i => FOOD_RE.test(nameOf(i)));
    if (!entry)
      return { sent: false, bought: null, reason: `no food item in the buy list (wanted: ${wantName})` };
  } else {
    const eq = c.equipment?.();
    const isArmedNow = !eq || eq.known === false
      ? true
      : (eq.equipped || []).some(o => WEAPON_RE.test(o.name ?? c.rsc?.get?.(o.nameRsc) ?? ''));
    if (!isArmedNow) {
      entry = buyList.items
        .filter(i => WEAPON_RE.test(nameOf(i)))
        .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
    }
    entry ??= [...buyList.items].sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
    if (!entry) return { sent: false, bought: null, reason: 'buy list is empty' };
  }

  const name = nameOf(entry) || `item ${entry.id}`;
  const cost = entry.cost ?? 0;

  // THE PURSE CHECK. A courtesy -- the server's refusal is the real answer, but
  // planning a buy we cannot afford wastes the pass.
  const purse = (c.inventory ?? [])
    .filter(o => /shilling/i.test(c.rsc?.get?.(o.nameRsc) ?? ''))
    .reduce((sum, o) => sum + (o.amount ?? 1), 0);
  if (purse < cost)
    return { sent: false, bought: null, reason: `cannot afford: ${name} costs ${cost}, purse has ${purse}` };

  // BUY THE ENTRY WE CHOSE. The shop must be OPEN when the item request goes out —
  // the server tracks the "current seller" only briefly after we asked for the list,
  // and a 1200ms gap let it lapse so `c.buy(itemId)` produced nothing (0 events). Re-open
  // the seller's list, then buy the item a short beat later, so the purchase lands while
  // the shop is freshly active.
  const sellerId = (answered && answered.seller && answered.seller.id)
    || (c.self ? [...(c.room?.objects?.values?.() ?? [])]
         .filter(o => affordances(o.flags ?? 0).includes('buy'))
         .sort((a, b) => Math.hypot((a.col??0)-c.self.col,(a.row??0)-c.self.row) - Math.hypot((b.col??0)-c.self.col,(b.row??0)-c.self.row))[0]?.id : null);
  if (sellerId) {
    // Re-open the seller's list so the shop is freshly active, THEN buy the item.
    // The "bought" message must be read from AFTER this re-open, or the re-open's own
    // shop event masks it (waitFor returns on the first event, which would be the shop).
    await session.pacer.submit('buy', () => c.buy(sellerId), 300).catch(() => {});
    // Give the server a beat to register the (re)opened shop before the item request.
    await new Promise(r => setTimeout(r, 600));
  }
  const before = c.evSeq ?? 0;  // capture AFTER the re-open: the window holds only the item-buy's reply
  // THE PURCHASE IS A DIFFERENT PACKET FROM OPENING THE SHOP. The legacy client
  // (clientd3d/buy.c:342) buys with RequestBuyItems(seller_id, [itemId]) = BP_REQ_BUY_ITEMS,
  // which carries BOTH the seller and the item list. `c.buy(itemId)` (REQ_BUY) only opens
  // a shop — it does not purchase, which is why the item request produced 0 events.
  await session.pacer.submit('buy', () => c.buyItems(sellerId, [entry.id]), 300).catch(() => {});
  const ev = await c.waitFor({ since: before, kinds: ['message', 'inventory'], timeoutMs: waitMs + 1200 })
                .catch(() => ({ events: [] }));
  if (process.env.M59_BUY_DEBUG !== '0') console.error(`[buydbg] purchase ${entry.id} (${name}): got ${(ev.events??[]).length} events: ${(ev.events??[]).map(e=>e.kind).join(',') || 'none'}`);

  const msgs = (ev.events ?? []).filter(e => e.text).map(e => e.text);
  const success = msgs.some(m => /bought|purchased/i.test(m));
  if (success) return { sent: true, bought: name, reason: null };
  // Same rule as above: a purchase that did not happen is `false`, so the caller can
  // count it. "No error" has never meant success here.
  return { sent: true, bought: false, reason: msgs.join('; ') || 'no reply' };
}

buy.pre     = ['has_money', 'at_shop'];  // the planner only plans a buy when
                    // the character can afford something AND a merchant is
                    // in the room. The per-item cost check still runs inside
                    // the atomic; has_money is a coarse gate (walking floor),
                    // not an exact affordability test.
buy.effects = ['has_food', 'armed'];  // buying a weapon makes you armed;
                     // buying food feeds you. The atomic picks the right item
                     // based on what the character needs. The planner chains
                     // armed=false -> buy -> armed=true, or has_food=false ->
                     // buy -> has_food=true. The next pass re-evaluates from
                     // the actual inventory.
buy.atomic  = 'buy';
buy.mutates = true;  // sends a mutation packet (BP_REQ_BUY); effects are
                     // item-level, not vocabulary-level
