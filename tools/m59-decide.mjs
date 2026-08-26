#!/usr/bin/env node
// m59-decide.mjs -- THE DECIDE HALF, as a pure synchronous function.
//
// One tick is sense -> decide -> actuate. m59-tick.mjs owns the first and third; this
// is the middle, and it is deliberately the SAME decision the old keeper made, taken
// the same way, from the same vocabulary:
//
//     evaluate()  m59-worldstate.mjs   frame -> the 20-odd closed symbols
//     planFor()   m59-plan.mjs         symbols + goal -> a plan
//     intend()    here                 the plan's first step -> one command
//
// BOTH OF THOSE ARE ALREADY SYNCHRONOUS. `evaluate` reads pushed client state and
// `planFor` is A* over an in-memory action set -- neither is even declared async. So
// the decide half NEVER NEEDED TO BLOCK, and the only thing standing between the old
// model and this one was that execution went through `stepPlan`, which awaits an atomic.
//
// ---------------------------------------------------------------------------
// WHY THIS DOES NOT CALL THE ATOMICS
// ---------------------------------------------------------------------------
//
// The m59-act/ atomics are `async (client, session, args)` and every one of them awaits
// -- a pacer slot, a confirmation, a bounded wait for a reply. Calling one from a tick
// would break rule 1 immediately, and no amount of care would keep it fixed.
//
// So the plan is read for its DECISION and the decision is turned into a command here.
// The atomics stay exactly where they are, for the legacy driver and for the offline
// suite, and this is a second reader of the same plan rather than a rewrite of them.
//
// The cost is honest and worth stating: the binding an atomic does at execution time
// (which weapon, which food, which target) has to be done here too. Rather than a second
// copy of that judgement -- the shape this repository keeps paying for -- it imports the
// SAME pure helpers the atomics bind with: pickWeapon, pickFood, knownSpells. Those are
// synchronous by construction, which is why they can be shared at all.
import { evaluate } from './m59-worldstate.mjs';
import { KOD_FINENESS } from './m59-roo.mjs';
import { planFor } from './m59-plan.mjs';
import { pickWeapon } from './m59-act/equip.mjs';
import { pickFood } from './m59-act/eat.mjs';
import { knownSpells } from './m59-act/cast.mjs';
import { affordances } from './m59-parse.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry
import { sameRegion } from './m59-navgrid.mjs';

// BROKEN-WEAPON TRACKING (the fix for the shattered-mace loop).
//
// A weapon the server refuses with "You can't use X--it's broken" (player.kod:127)
// cannot be wielded, ever, on this session. The old behaviour kept the weapon in the
// candidate list and retried `use` on it every tick (JayB, Raza Inn: `use` at 9.67/s,
// equipment stuck at [], the `armed` goal never satisfied). The legacy equipBest
// (m59-skills.mjs) condemned the weapon the moment it read the refusal and stopped
// offering it. We do the same: the `equip` intent, before sending `use`, scans the
// client's event ring for a recent "it's broken" refusal and marks the weapon broken.
// The tick driver is synchronous, so this is a ring scan (cheap, off the wire), not a
// push listener (the client has no EventEmitter; it keeps an event ring + a single
// onEvent callback, so `client.on(...)` does not exist).
const brokenBySession = new WeakMap();  // session -> Set of broken weapon ids
const BROKEN_TEXT = /can'?t use .*--it'?s broken/i;  // player.kod:127

// The set of broken weapon ids for a session (created on first use).
function brokenSetFor(session = null, client = null) {
  const key = session ?? client;
  let set = brokenBySession.get(key);
  if (!set) { set = new Set(); brokenBySession.set(key, set); }
  return set;
}

// Scan the client's event ring for "it's broken" refusals and add the named weapon's
// id to the broken set. Called by the `equip` intent before sending `use`, so a
// weapon the server just refused gets condemned before it's retried. Cheap: a linear
// scan of the last ~500 events, only on ticks where `armed` is the active goal.
// ONLY EVENTS WE HAVE NOT ALREADY READ.
//
// This used to walk the whole event ring on every call. The ring keeps hundreds of messages,
// so ONE genuine "it's broken" refusal stayed in it and was re-read on every subsequent equip
// — condemning whatever `_lastEquipId` happened to be that time. Watched on JayB: thirteen
// condemnations marching straight down the pack, ids 7666, 7667, 7668 ... 8185, until every
// mace he owned was marked broken and `armed` could only answer "no weapon to equip". He then
// fought a level-25 mummy bare-handed for 212 swings and killed nothing, and kept buying more
// maces to condemn — fourteen of them in the pack by the time this was found.
//
// `eventsSince` exists precisely for this: e.seq is monotonic, so a watermark reads each
// refusal exactly once. Without it the scanner cannot tell a fresh refusal from the memory of
// an old one, and that distinction is the whole of its job.
function scanBrokenFromEvents(client, session = null) {
  if (!client?.events) return;
  const set = brokenSetFor(session, client);
  const inv = client.inventory ?? [];
  const holder = session ?? client;
  const since = holder._brokenScanSeq ?? 0;
  const fresh = client.eventsSince ? client.eventsSince(since) : client.events;
  // Advance the watermark even when nothing matches, or a quiet ring replays for ever.
  if (fresh.length) holder._brokenScanSeq = fresh[fresh.length - 1].seq ?? since;
  // Build a name -> id map for the current pack (the refusal names the weapon).
  const nameToId = new Map();
  for (const o of inv) {
    const n = String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
    if (n && o?.id != null) nameToId.set(n, o.id);
  }
  for (const ev of fresh) {
    if (ev.kind !== 'message') continue;
    const t = String(ev.text ?? '');
    if (!BROKEN_TEXT.test(t)) continue;
    // "You can't use the mace--it's broken" — extract the weapon name (after "use the").
    const m = t.match(/use (?:the )?(.+?)--it'?s broken/i);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    // THE ID IS THE ONE WE JUST TRIED, NOT THE NAME. A pack can hold NINE maces (JayB
    // accumulated broken ones); the refusal says "the mace" and a name->id map can only
    // hold one of them, so name-matching condemned the wrong id and the equip retried
    // the one it was actually refused. The equip intent records the id it just used in
    // session._lastEquipId — condemn THAT on a fresh broken refusal.
    if (session && session._lastEquipId != null && !set.has(session._lastEquipId)) {
      set.add(session._lastEquipId);
      console.error(`[broken] ${session?.name ?? 'keeper'}: ${name} is broken (id ${session._lastEquipId}) — condemned, will not retry`);
    }
    const id = nameToId.get(name);
    if (id != null && !set.has(id)) {
      set.add(id);
      console.error(`[broken] ${session?.name ?? client.me?.name ?? 'keeper'}: ${name} is broken (id ${id}) — condemned, will not retry`);
    }
  }
}

// A weapon in the pack that is NOT known-broken. Returns null when there is no
// wieldable weapon (the pack is empty, or the only weapon is broken) — the caller
// then knows to buy, not to retry the broken one.
function pickWieldableWeapon(client, session = null) {
  const broken = brokenSetFor(session, client);
  const inv = client?.inventory ?? [];
  const eq = client.equipment?.();
  const held = new Set((eq && eq.known !== false ? eq.equipped || [] : []).map(o => o.id));
  const WEAPON = /mace|sword|axe|club|hammer|dagger|staff|spear|blade|knife/i;
  // Reuse pickWeapon's scoring for the first pick, then fall back to a scan if the
  // best is broken.
  const best = pickWeapon(client);
  if (!best) return null;
  if (!broken.has(best.id)) return best;
  // Best is broken: find the next-best that isn't.
  const candidates = inv
    .filter(o => o?.id != null && !held.has(o.id) && !broken.has(o.id)
      && WEAPON.test(String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '')));
  return candidates.sort((a, b) => String(client.rsc?.get?.(b.nameRsc) ?? b.name ?? '').localeCompare(String(client.rsc?.get?.(a.nameRsc) ?? a.name ?? '')))[0] ?? null;
}
import { nearestHuntRoom } from './m59-hunt-room.mjs';
import { loadSpawns } from './m59-spawns.mjs';
import * as skills from './m59-skills.mjs';
import { trustedBuyer } from './m59-skills.mjs';

// WHERE THE TOWN BUSINESS HAPPENS. Both verified against substrate/m59-merchants.json and
// trustedBuyer(): Quintor the Jasper Blacksmith passes the allowlist, Yevitan the Jasper
// Banker does NOT — he is on NEVER_SELL_TO, which is exactly the distinction that keeps a
// pack from being handed to a banker for nothing.
// How long to stand on an Underworld portal before deciding it is unlit and trying another.
const UNLIT_PORTAL_MS = Number(process.env.M59_UNLIT_PORTAL_MS || 12000);

// The most dangerous thing a character will take on, as GetAttackAbility (monster.kod:
// 3*viLevel + 60*viDifficulty). 250 sits above the mummy (195) and giant rat (150) this fleet
// survives on and below the baby spider (315) and centipede (390) it dies to. Overridable per
// character with policy.maxAttackAbility; null disables the check entirely.
const DEFAULT_ATTACK_ABILITY_CAP = Number(process.env.M59_MAX_ATTACK_ABILITY || 250);

// Attack ability by creature name, from the spawn table's level and difficulty. Built once.
let _aa = null;
function attackAbility(name) {
  if (!_aa) {
    _aa = new Map();
    try {
      const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
                                               'substrate', 'm59-spawns.json'), 'utf8'));
      for (const list of Object.values(raw?.rooms ?? {})) {
        for (const e of list ?? []) {
          if (!e?.creature || e.level == null || e.difficulty == null) continue;
          _aa.set(creatureKey(e.creature), 3 * e.level + 60 * e.difficulty);
        }
      }
    } catch { /* no table: the cap simply cannot be applied */ }
  }
  return _aa.get(creatureKey(name)) ?? null;
}

// Where a graduated character buys a weapon. Quintor, the Jasper Blacksmith, whose sell list
// in the merchant index carries Mace and ShortSword.
const SMITH_ROOM = Number(process.env.M59_SMITH_ROOM || 374);

const SELL_ROOM = Number(process.env.M59_SELL_ROOM || 374);   // Quintor, Jasper Blacksmith
const BANK_ROOM = Number(process.env.M59_BANK_ROOM || 376);   // Yevitan, Jasper Banker
import { creatureKey, preyNames } from './m59-combat.mjs';
import { recordEvent } from './m59-ledger.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPAWNS_FILE = join(__dirname, '..', 'compendium', 'data', 'spawns.json');
import { loadMap } from './m59-map.mjs';
import { resolveRoomNum, routeIntent } from './m59-route.mjs';
import { CombatController } from './m59-combat.mjs';

// ---------------------------------------------------------------------------
// INTENT -- one planned action, turned into one command
// ---------------------------------------------------------------------------
//
// EVERY ENTRY SENDS AT MOST ONE THING AND RETURNS. An entry that wanted to send two
// commands in sequence, waiting for the first, would be a loop around an await with the
// awaits removed -- which is worse, because it would look fine.
//
// An action with no entry is REFUSED BY NAME, never guessed at. A silent fallthrough
// here would be a plan the tick believes it executed and did not, which is the failure
// this whole design is arranged against.
export const INTENTS = {
  rest:  (f, act, ctx) => {
    // Resting recovers HP and vigor. At an inn it's fast;
    // outside an inn it's slower but still works. The GOAP
    // driver rests outside inns all the time. Always allow.
    return { sent: !!act.rest(),  what: 'rest' };
  },
  stand: (f, act) => ({ sent: !!act.stand(), what: 'stand' }),

  // THE ONE WAY OUT OF THE NEWBIE ZONE: the portal in the Grand Museum at (11,2), touched
  // TWICE. The first touch only warns and bounces you back off it, and the bounce does not
  // reliably return you to the square you left — so this steps off and on again rather than
  // assuming position. One-way; there is no walking back in.
  //
  // Two phases, one command per tick, like every other intent here: route to 1018 while
  // outside it, then alternate (11,2) and (11,3) once inside.
  leave_raza: (f, act, ctx) => {
    // The MAP number again — client.room.id is the room object's id. Same trap the in_raza
    // fact fell into: this resolved to NaN, NaN never equals 1018, and the intent routed to
    // the museum for ever while standing inside it.
    const room = Number(ctx.session?.world?.room?.num ?? f?.room?.num);
    const MUSEUM = 1018;
    if (room !== MUSEUM) {
      const r = ctx.session?._router;
      if (!r) return { sent: false, why: 'no router to reach the Grand Museum' };
      r.to(MUSEUM);
      return { sent: true, what: `route to the Grand Museum (${MUSEUM}) for the portal out` };
    }
    // Inside the museum: walk onto the portal, and alternate with the square below it so a
    // bounce is followed by a fresh approach rather than a re-touch of a square we are no
    // longer standing on. The portal's own position is read from the room when it is visible
    // — it is object 2179 at (11,2) — and (11,2) is the documented fallback.
    let px = 11, py = 2;
    const objs = ctx.client?.room?.objects;
    if (objs?.values) {
      for (const o of objs.values()) {
        const nm = String(o.name ?? ctx.client?.rsc?.get?.(o.nameRsc) ?? '').toLowerCase();
        if (nm === 'portal' && Number.isFinite(o.col) && Number.isFinite(o.row)) { px = o.col; py = o.row; break; }
      }
    }
    const n = (ctx.session._razaTouch = (ctx.session._razaTouch ?? 0) + 1);
    const [col, row] = (n % 2) ? [px, py] : [px, py + 1];
    const sent = !!act.walk?.(col, row, { maxSteps: 40 });
    return { sent, what: `portal at (${px},${py}): step to (${col},${row}) — touch ${Math.ceil(n / 2)} of 2+` };
  },

  equip: (f, act, ctx) => {
    // Scan the event ring for a recent "it's broken" refusal so a shattered weapon
    // gets condemned BEFORE we retry it (prevents the use-flood on a broken mace).
    scanBrokenFromEvents(ctx.client, ctx.session);
    const item = pickWieldableWeapon(ctx.client, ctx.session);
    if (!item) {
      // No wieldable weapon in the pack (the only one is broken, or there is none).
      // The `armed` goal should now plan `buy` instead of retrying the broken weapon.
      // "no weapon" in the message is what the refusal contract expects (the test
      // matches /no weapon/) — a refusal, not a success.
      return { sent: false, why: 'no weapon to equip (broken or absent)' };
    }
    act.use(item.id);
    ctx.session._lastEquipId = item.id;  // condemned on the next broken refusal (see scanBrokenFromEvents)
    return { sent: true, what: `equip ${item.name ?? item.id}` };
  },

  // SELL THE SURPLUS. Routes to a TRUSTED buyer and hands the pack to skills.sellAll, which
  // reads the server's own use list so nothing worn or wielded can go.
  //
  // THE BUYER IS AN ALLOWLIST, NEVER A CHECK. `buys_anything` is true for the bankers and it
  // is a robbery: Skivlat takes what you hand him, says thank you, and gives nothing back,
  // and nothing on the wire tells that from a sale. So the merchant here must pass
  // trustedBuyer() — verified for this route: Quintor (Jasper Blacksmith, room 374) passes,
  // Yevitan (Jasper Banker, room 376) does not.
  sell_loot: (f, act, ctx) => {
    const s = ctx.session, c = ctx.client;
    if (s?._sellInFlight) return { sent: false, why: 'a sale is already in flight' };
    const list = c?.room?.objects instanceof Map ? [...c.room.objects.values()] : [];
    const buyer = list.find(o => trustedBuyer(String(c?.rsc?.get?.(o.nameRsc) ?? o.name ?? '')));
    if (!buyer) {
      const dest = SELL_ROOM;
      if (!s?._router) return { sent: false, why: 'no router to reach a buyer' };
      if (s._router.dest !== dest) { s._router.to(dest); return { sent: true, what: `travel to Quintor (room ${dest}) to sell` }; }
      const r = routeIntent(s._router)(f, act);
      return { sent: r.sent, what: r.what ?? `on the way to the smith (room ${dest})` };
    }
    s._sellInFlight = true;
    const name = String(c?.rsc?.get?.(buyer.nameRsc) ?? buyer.name ?? 'the merchant');
    skills.sellAll(s, { merchant: buyer.id, maxWeapons: ctx.policy?.maxWeapons ?? 2,
                        loadout: null, keep: [], protect: ctx.policy?.protectedItems ?? [] })
      .then(r => console.error(`[sell] ${s.name}: sold ${r?.sold?.length ?? 0} item(s) to ${name}`))
      .catch(e => console.error(`[sell] ${s.name}: ${e?.message}`))
      .finally(() => { s._sellInFlight = false; });
    return { sent: true, what: `selling the surplus to ${name}` };
  },

  // BANK THE EXCESS. Deposit everything above the walking-money floor, so a death costs the
  // purse rather than the earnings — a vault balance is the only thing in this game that
  // survives dying.
  bank_money: (f, act, ctx) => {
    const s = ctx.session, c = ctx.client;
    if (s?._bankInFlight) return { sent: false, why: 'a deposit is already in flight' };
    const list = c?.room?.objects instanceof Map ? [...c.room.objects.values()] : [];
    const banker = list.find(o => /banker|yevitan|skivlat|setag|huital/i.test(
      String(c?.rsc?.get?.(o.nameRsc) ?? o.name ?? '')));
    if (!banker) {
      const dest = BANK_ROOM;
      if (!s?._router) return { sent: false, why: 'no router to reach a bank' };
      if (s._router.dest !== dest) { s._router.to(dest); return { sent: true, what: `travel to the bank (room ${dest})` }; }
      const r = routeIntent(s._router)(f, act);
      return { sent: r.sent, what: r.what ?? `on the way to the bank (room ${dest})` };
    }
    const purse = (c?.inventory ?? [])
      .filter(o => /shilling/i.test(String(c?.rsc?.get?.(o.nameRsc) ?? o.name ?? '')))
      .reduce((t, o) => t + (o.amount || 1), 0);
    const keep = ctx.policy?.walkingMoney ?? 400;
    const amount = Math.floor(purse - keep);
    if (amount <= 0) return { sent: false, why: `purse ${purse} is not above the walking floor ${keep}` };
    s._bankInFlight = true;
    Promise.resolve(s.pacer.submit('bank', () => c.deposit(amount)))
      .then(() => console.error(`[bank] ${s.name}: deposited ${amount}, keeping ${keep}`))
      .catch(e => console.error(`[bank] ${s.name}: ${e?.message}`))
      .finally(() => { s._bankInFlight = false; });
    return { sent: true, what: `deposit ${amount}, keeping ${keep} for the road` };
  },

  // BUY a weapon (or food) from the nearest merchant. The tick driver is synchronous,
  // so this KICKS OFF the async buy atomic (m59-act/buy.mjs) — which advances ONE
  // PHASE PER CALL (approach → open shop → buy → verify), returning after each. The
  // `armed` goal keeps firing (until the character is armed), so each tick calls the
  // atomic, advancing the next phase, until the purchase completes and the inventory
  // updates. A single in-flight guard prevents racing: we don't start a new phase
  // while the previous one is still resolving.
  //
  // This is the fallback when the only weapon in the pack is broken (the shattered-
  // mace case): the character buys a replacement instead of retrying the broken one
  // forever.
  buy: (f, act, ctx) => {
    const c = ctx.client;
    const s = ctx.session;
    // In-flight guard: the atomic is async and multi-phase. If a phase is still
    // resolving, don't start another (they'd race on the same shop state). The next
    // tick (100ms later) will try again once this one settles.
    if (s && s._buyInFlight) {
      return { sent: false, why: 'buy in flight' };
    }
    // Confirm a merchant is present so we don't kick off a pointless buy phase.
    // Use the `buy` AFFORDANCE (the object's flags), not the name — a shopkeeper like
    // "Marcus" has no role word in the name, but its flags carry the buy affordance.
    // This is the same detection the buy atomic (m59-act/buy.mjs) uses.
    const objects = c.room?.objects;
    const list = objects instanceof Map ? [...objects.values()]
               : Array.isArray(objects) ? objects : [];
    const merchants = list.filter(o => affordances(o.flags ?? 0).includes('buy'));
    if (!merchants.length) {
      // No merchant in this room. Route to the main town (the Raza, room 1012) where
      // the smith sells weapons.
      if (s?._router) {
        // WHICH SMITH. 1013 is the Raza Blacksmith and it was hardcoded — but leaving Raza is
        // ONE-WAY, so for any graduated character that destination is unreachable for ever and
        // the buy errand can never complete. Pick by where we are: inside the newbie zone the
        // Raza smith is the only one; outside it, Quintor in Jasper (374), who sells Mace and
        // ShortSword per the merchant index and passes trustedBuyer().
        const here = Number(s.world?.room?.num ?? NaN);
        const inRaza = Number.isFinite(here) && here >= 1011 && here <= 1018;
        const dest = inRaza ? 1013 : SMITH_ROOM;
        if (s._router.dest !== dest) {
          s._router.to(dest);
          return { sent: true, what: `travel to the smith (room ${dest})` };
        }
        const r = routeIntent(s._router)(frame, act);
        return { sent: r.sent, what: r.what ?? `traveling to the smith (room ${dest})` };
      }
      return { sent: false, why: 'no merchant in room' };
    }
    // A merchant is present. But neither the Raza Inn (1011, innkeeper Marcus, no
    // weapons) nor the Raza field (1012, no merchant) has a weapon for sale. If we're
    // in either, route to the Raza Blacksmith (1013) where the smith sells weapons.
    // Same if a cached list has no weapon.
    const roomNum = c.room?.num ?? s?.world?.room?.num;
    const buyList = c.buyList;
    const listHasWeapon = buyList?.items?.length
      ? buyList.items.some(i => /mace|sword|axe|club|hammer|dagger|staff|spear|blade|knife/i.test(String(c.rsc?.get?.(i.nameRsc) ?? i.name ?? '')))
      : null;  // null = list not cached yet
    if (roomNum === 1011 || roomNum === 1012 || listHasWeapon === false) {
      // Inn or field (no weapons here) or a cached list with no weapon: go to the smith.
      if (s?._router) {
        const dest = 1013;  // Raza Blacksmith
        if (s) s._buyingRoute = dest;
        if (s._router.dest !== dest) {
          s._router.to(dest);
          // Drive the router on the same tick so the character starts moving
          // immediately, rather than waiting for the next tick's "already routing"
          // branch. Without this, the destination is set but nothing moves the
          // character, and it sits in the inn.
          const r = routeIntent(s._router)(frame, act);
          return { sent: r.sent, what: `travel to the smith (room ${dest}) — no weapon here` };
        }
        const r = routeIntent(s._router)(frame, act);
        return { sent: r.sent, what: r.what ?? `traveling to the smith (room ${dest})` };
      }
      return { sent: false, why: 'no weapon for sale in this room' };
    }
    // APPROACH PHASE (synchronous, one command per tick): opening a shop requires being
    // near the merchant (within ~2 squares) — the server opens the list only in reach.
    // JayB sat in the Raza Blacksmith for hours on exactly this: 6 squares from the
    // smith, the async buy atomic asked `c.buy(tomas.id)` from across the room, got
    // nothing, and the `armed -> buy` goal (top priority, mace broken) preempted
    // `hunt -> travel` every tick so he never moved. Do the distance check HERE, on
    // this tick, and route toward the merchant with the mover. When we are near, the
    // next pass fires the actual (async) shop-open + purchase.
    {
      const me = c.self;
      const distToNearest = me
        ? Math.min(...merchants.map(o => Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row)))
        : Infinity;
      if (distToNearest > 1.5) {
        const target = [...merchants].sort((a, b) =>
          Math.hypot((a.col ?? 0) - me.col, (a.row ?? 0) - me.row)
          - Math.hypot((b.col ?? 0) - me.col, (b.row ?? 0) - me.row))[0];
        // Mark the buy as active so the hunt goal yields for the whole approach (not just
        // the async phase). Without this, `hunt -> travel` resets the mover's destination
        // to the hunt room on its ticks, fighting the approach and leaving JayB bouncing
        // in place in the blacksmith.
        if (s) s._buyingActive = true;
        const mv = s._mover;
        if (mv) {
          mv.to(target.col, target.row);
          // Drive the mover this tick so it actually steps toward the merchant (the
          // router is not involved — same-room approach, and the tick loop does not
          // call mover.tick on its own; the intent must).
          mv.tick({ col: me.col, row: me.row, x: me.x, y: me.y });
        }
        return { sent: true, what: `approach ${target.name ?? 'merchant'} at (${target.col},${target.row})` };
      }
    }
    if (s) { s._buyInFlight = true; s._buyingActive = true; }
    import('./m59-act/buy.mjs').then(({ buy }) => {
      return buy(c, s, {});   // no itemId/wantName: the atomic picks a weapon if unarmed
    }).then(res => {
      console.error(`[buy] ${s?.name ?? 'keeper'}: ${res?.bought ? 'bought ' + res.bought : 'no buy (' + (res?.reason ?? 'unknown') + ')'}`);
    }).catch(e => console.error(`[buy] ${s?.name ?? 'keeper'} err: ${e.message}`))
      .finally(() => { if (s) s._buyInFlight = false; });
    return { sent: true, what: 'buy weapon (one phase)' };
  },

  eat: (f, act, ctx) => {
    const item = pickFood(ctx.client);
    if (!item) return { sent: false, why: 'nothing edible in the pack' };
    act.eat(item.id);
    return { sent: true, what: `eat ${item.name ?? item.id}` };
  },

  // THE TARGET COMES FROM THE WORLD STATE, not from a second search. `has_target`,
  // `in_reach` and `target_in_band` are all produced from ws._targetId, so choosing a
  // different creature here would let the ceiling be checked against one and the swing
  // land on another -- the engagement ceiling failing open.
  attack: (f, act, ctx) => {
    const id = ctx.ws?._targetId;
    if (id == null) return { sent: false, why: 'no target in the world state' };
    if (!f.objects?.get?.(id)) return { sent: false, why: 'the target has left the room' };
    act.swing(id);
    return { sent: true, what: `attack ${id}` };
  },

  // Underworld escape: walk to the nearest portal and step on it.
  // Fire-and-forget: the escapeUnderworld skill is async, but we
  // don't await it. The next tick will see the character in a
  // new room (or still in the underworld, and try again).
  escape_underworld: (f, act, ctx) => {
    const c = ctx.client;
    const objects = c.room?.objects;
    // Find the nearest portal.
    const me = c.self;
    if (!me) return { sent: false, why: 'no position' };
    // EVERY WAY OUT, AND THE RIP GOES FIRST.
    //
    // The Underworld holds five portals AND a "rip in space" — one of it, at (6,10) in the
    // room read while both characters were stuck. The portals are the ones that go unlit; the
    // rip is a way out that does not, so it is tried before any of them rather than being
    // ignored, which it was: this matched /portal/ only.
    //
    // (Each portal also has a brazier beside it — (2,20) next to the portal at (2,21), (15,31)
    // next to (16,32) — which is very likely the lit/unlit tell, and a better answer than
    // waiting twelve seconds on each. Not used yet; noted because the pairing is exact.)
    const portals = [];
    const rips = [];
    if (objects instanceof Map) {
      for (const o of objects.values()) {
        if (o.col == null) continue;
        const name = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
        if (/rip in space|\brip\b/i.test(name)) rips.push(o);
        else if (/portal/i.test(name)) portals.push(o);
      }
    }
    const byNear = (a, b) => Math.hypot(a.col - me.col, a.row - me.row)
                           - Math.hypot(b.col - me.col, b.row - me.row);
    rips.sort(byNear); portals.sort(byNear);
    portals.unshift(...rips);
    if (!portals.length) return { sent: false, why: 'no portal in room' };

    // AN UNLIT PORTAL IS SILENT, SO STANDING ON ONE FOR EVER IS THE FAILURE MODE.
    //
    // One or two of the five Underworld portals are unlit at any moment and an unlit one gives
    // no sign at all — you simply stand on it. This walked to the NEAREST portal and then kept
    // walking to it, so a character that drew a dead one never left: JayB stood on (2,21) and
    // Lee on (16,32), both exactly on their portal, for minutes, with the escape decision
    // logged and the tick loop healthy.
    //
    // So: give a portal a fair trial, then try the next one. `_uwPortal` is the index we are
    // committed to and `_uwSince` is when we committed; both reset the moment we are out.
    const s = ctx.session;
    const now = Date.now();
    const onIt = (p) => Math.hypot(p.col - me.col, p.row - me.row) <= 1;
    if (s._uwPortal == null || s._uwSince == null) { s._uwPortal = 0; s._uwSince = now; }
    let portal = portals[s._uwPortal % portals.length];
    // Only start the clock once we have actually reached it — a long walk is not a dead portal.
    if (!onIt(portal)) s._uwSince = now;
    else if (now - s._uwSince > UNLIT_PORTAL_MS) {
      s._uwPortal = (s._uwPortal + 1) % portals.length;
      s._uwSince = now;
      portal = portals[s._uwPortal];
      console.error(`[underworld] ${s.name}: that way out looks dead — trying the next at (${portal.col},${portal.row})`);
    }
    act.step(portal.col, portal.row);
    return { sent: true,
             what: `escape: way out ${s._uwPortal + 1}/${portals.length} at (${portal.col},${portal.row})` };
  },
};

// `cast <name>` is one action per known spell, so it is matched by prefix rather than
// listed. The spell id is resolved from the client's own list, which is pushed.
function castIntent(name, f, act, ctx) {
  const want = name.slice('cast '.length).toLowerCase();
  const spell = knownSpells(ctx.client).find(sp => String(sp.name).toLowerCase() === want);
  if (!spell) return { sent: false, why: `does not know ${want}` };
  act.cast(spell.id, []);
  return { sent: true, what: name };
}

// THE NEAREST EXIT, ACTUALLY MEASURED.
//
// Both flee branches took `exits[0]` under a comment that called it "nearest exit". Nothing
// sorted them, so a character running for its life aimed at whichever exit the world happened
// to list first — which can be across the room, and can be PAST the thing hitting it. At 27
// max health and fleeBelow 0.4 the decision is made around 11 HP, where the walk you choose is
// the whole of your survival.
//
// Sorted by the staging square when the exit has one, and an exit we cannot locate sorts last
// rather than being dropped: an unmeasurable exit is still a way out.
function nearestExit(exits, me) {
  if (!Array.isArray(exits) || !exits.length) return null;
  if (!me || me.col == null) return exits[0];
  const d = (e) => {
    const p = e?.stand_on ?? e?.standOn ?? null;
    if (!p || !Number.isFinite(p.col) || !Number.isFinite(p.row)) return Infinity;
    return Math.hypot(p.col - me.col, p.row - me.row);
  };
  return exits.slice().sort((a, b) => d(a) - d(b))[0];
}

export function intend(actionName, frame, act, ctx) {
  if (!actionName) return { sent: false, why: 'no action' };
  if (actionName.startsWith('cast ')) return castIntent(actionName, frame, act, ctx);
  const fn = INTENTS[actionName];
  if (!fn) return { sent: false, why: `no intent for "${actionName}"` };
  return fn(frame, act, ctx);
}

// ---------------------------------------------------------------------------
// THE DECIDER
// ---------------------------------------------------------------------------
//
// Returns a `decide(frame, act, loop)` for TickLoop. SYNCHRONOUS, by contract and in
// fact: nothing in the call graph below awaits.
//
// `goals` is an ordered list of { goal, when(ws) }. The first whose `when` holds and
// which is not currently skipped is pursued. It is the caller's, not this file's,
// because what a character is FOR is a directional decision and belongs to whoever is
// steering -- the same split CLAUDE.md draws between the keeper and a bot.
// TIME IS WALL CLOCK, NEVER A TICK COUNT.
//
// `skipForMs` was `skipFor = 30` in TICKS, and that is wrong in the direction that hurts:
// ticks coalesce when the loop is under load, so a goal "skipped for 30 ticks" is three
// seconds on a healthy loop and half a minute on a struggling one. The pause would grow
// exactly when things were going worst. A tick is a sampling cadence, not a clock.
export function makeDecider({ session, policy = {}, goals = [], onDecision = null,
                              skipAfter = 5, skipForMs = 3000, now = () => Date.now() } = {}) {
  if (!session) throw new Error('makeDecider: no session');
  const fails = new Map();       // goal -> consecutive failures
  const skipped = new Map();     // goal -> wall-clock ms to resume at
  let ticks = 0;
  let _lastPos = null;           // for stuck detection
  let _lastPosAt = 0;            // wall-clock ms of last position change
  let _stuckEscapes = 0;         // how many times we've escaped being stuck in this room
  let _stuckRoomKey = null;      // the room the escape count applies to
  let _resting = false;          // suppress stuck detection while resting
  let _wasResting = false;       // was resting last tick (to send stand before moving)
  let _fighting = false;         // suppress stuck detection while fighting
  let _blacklist = new Set();    // unreachable target IDs
  let _blacklistRoom = null;     // room the blacklist applies to
  let _blacklistAt = 0;          // wall-clock ms of last blacklist update
  let _reachCheckAt = 0;         // wall-clock ms of last reachability A* (throttle)
  let _lastTargetId = null;      // previous tick's target (for stuck-detection, which runs before evaluate)
  let retargetCheckAt = 0;       // wall-clock ms of last re-target check (throttle)
  let _hpPokeAt = 0;             // wall-clock ms of last first-move poke (HP-regen unlock)
  let lastSeenHp = null;         // last HP value (to detect "we just took damage")
  let lastDamagedAt = 0;         // wall-clock ms when we last dropped HP
  let _currentTargetId = null;   // the decider's current target (for 3D debug)
  const STUCK_MS = 30000;        // 30s of no movement = stuck (was 10s, too
                                  // short: with 1.3s ticks + 2s position
                                  // confirms a slow walk moves ~1 square per
                                  // 3-5s, so 10s derails a legitimate walk)

  const decide = (frame, act, loop) => {
    ticks++;
    const client = session.client;
    if (!client) return;

    // 0. STUCK DETECTION. If the character hasn't moved in
    // STUCK_MS, escape the geometry pocket. Blink teleports
    // in the facing direction, so if the character is facing
    // a wall it does nothing. Instead: find an open
    // neighbor square and walk there. Fall back to blink if
    // no neighbor is open. Suppressed while resting: a
    // resting character is intentionally not moving.
    {
      const me = frame?.position;
      if (me?.col != null) {
        if (_lastPos && me.col === _lastPos.col && me.row === _lastPos.row) {
          // Suppress stuck detection when the character is
          // intentionally not moving: resting, fighting,
          // or a hostile mob is in reach. The _fighting/
          // _resting flags are from the previous tick, so
          // also check the room directly for a nearby mob.
          const c2 = client;
          const objs = c2?.room?.objects;
          // Is the current target out of reach? A "fight" frozen against a
          // far target is stuck-on-a-ledge, not combat — allow the stuck
          // detector to fire in that case.
          let targetOutOfReach = false;
          if (_lastTargetId != null && objs instanceof Map) {
            const t2 = objs.get(_lastTargetId);
            if (t2?.col != null) {
              // "Out of reach" means the swing cannot connect. Melee is a disc
              // of radius ~4 squares (MELEE_REACH), so use d2 > 16. The old
              // threshold (d2 > 4, i.e. dist > 2) treated an in-range target as
              // out-of-reach, which kept the stuck-detector firing while the
              // character was actually in melee range and swinging.
              targetOutOfReach = (t2.col - me.col) ** 2 + (t2.row - me.row) ** 2 > 16;
            }
          }
          const mobNearby = objs instanceof Map && me?.col != null &&
            [...objs.values()].some(o => {
              if (o.is_self || o.col == null || o.row == null) return false;
              if (o.is_player && o.can_attack) return Math.hypot(o.col - me.col, o.row - me.row) <= 4;
              const nm = String(c2.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
              if (nm && !/shilling|gold|mace|sword|food|mushroom|bone|skull|lever|brazier|target|jump|look|fight/.test(nm)) {
                return Math.hypot(o.col - me.col, o.row - me.row) <= 4;
              }
              return false;
            });
          // THE EXEMPTIONS MUST RESET THE CLOCK, NOT MERELY SKIP THE BLINK.
          //
          // `_lastPosAt` only advances when the position CHANGES (below), so a character
          // standing still for a legitimate reason ages the stuck timer the whole time it is
          // exempt. The moment the exemption lapses — the target dies, or reads out of reach
          // for one pass — `held` is ALREADY past STUCK_MS and it blinks on the spot, then
          // again every STUCK_MS after.
          //
          // Watched live on JayB: seven blinks from (12,31), every one reporting "stuck for
          // 30s", while the same window logged 194 swings at a mummy in reach. He was never
          // stuck; he was fighting, and the timer was counting the fight. 62 blinks in the
          // previous run have the same shape.
          //
          // So being exempt means the clock starts WHEN THE EXEMPTION ENDS. A character that
          // stops fighting and then stands still for STUCK_MS is stuck; one that just spent
          // four minutes swinging is not.
          if (_resting) {
            _lastPosAt = now();          // resting is not moving, and not stuck either
          } else if ((_fighting && !targetOutOfReach) || (mobNearby && !targetOutOfReach)) {
            // Genuinely engaged: fighting a target in reach, or a hostile mob
            // is within 4 squares. Not stuck — just holding position. A "fight"
            // frozen against a far target (or no mob nearby) is stuck-on-a-ledge,
            // so fall through and let the stuck-detector blink/walk out.
            _lastPosAt = now();
          } else {
            const held = now() - _lastPosAt;
            if (held > STUCK_MS) {
            const c = client;
            // Track how many times we've been stuck in THIS room. If we've
            // tried to escape several times and are still stuck, the room
            // itself is the problem (a ledge with no path to the mobs) —
            // leave it via the router rather than blinking/re-targeting
            // in place. Blink goes to a fixed spot, so it cannot escape.
            const roomKeyNow = `${frame?.room?.num}:${frame?.room?.name}`;
            if (roomKeyNow !== _stuckRoomKey) { _stuckRoomKey = roomKeyNow; _stuckEscapes = 0; }
            _stuckEscapes++;
            if (_stuckEscapes >= 3) {
              // Give up on this room. Route to a different hunt room.
              const router = session._router;
              if (router) {
                try {
                  const roomNum = frame?.room?.num ?? frame?.room?.id;
                  const roomName = frame?.room?.name ?? null;
                  const map = loadMap();
                  const resolved = resolveRoomNum({ id: roomNum, num: roomNum, name: roomName }, map) ?? roomNum;
                  const maxHp = client.vitals?.()?.health?.max ?? 20;
                  const isArmed = !!(client.equipment?.()?.primary?.name);
                  const fullBand = policy?.threatBand ?? Math.floor(maxHp / 2);
                  const band = isArmed ? fullBand : Math.floor(fullBand / 2);
                  const ceiling = maxHp + band;
                  const hunt = nearestHuntRoom(resolved, ceiling);
                  if (hunt && hunt.room !== resolved) {
                    router.to(hunt.room);
                    onDecision?.({ ticks, goal: 'unstuck', action: 'travel',
                      what: `stuck ${_stuckEscapes}x in room ${roomNum}; leaving for hunt room ${hunt.room}`, sent: true });
                    _lastPosAt = now();
                    return;
                  }
                } catch {}
              }
              // No other hunt room reachable: reset the count and fall
              // through to the walk/blink escape below.
              _stuckEscapes = 0;
            }
            // Do NOT blacklist the target just because we're stuck. "Stuck"
            // often means the walk is slow (1.3s ticks) or the character is
            // re-targeting, not that the target is unreachable. Blacklisting
            // on a momentary stall caused a re-target loop: blacklist -> new
            // target -> stuck -> blacklist -> ... The target is blacklisted
            // only when the mover reports a definitive no-route (it cannot
            // find any path), which is handled elsewhere. Here we just try
            // to escape the stall (walk to an open neighbor / blink) and keep
            // the same target.
            // Check the 4 neighbors for an open square.
            const geo = session._roomGeo ?? null;
            const dirs = [[0,-1],[0,1],[-1,0],[1,0]]; // N,S,W,E
            let escape = null;
            if (geo) {
              for (const [dc, dr] of dirs) {
                const nc = me.col + dc, nr = me.row + dr;
                const f = geo.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
                const s = geo.standable ? geo.standable(nr, nc) : undefined;
                // Valid if either says true, or no data.
                if (f === true || s === true || (f === undefined && s === undefined)) {
                  escape = { col: nc, row: nr };
                  break;
                }
              }
            }
            if (escape) {
              // Walk to the open neighbor.
              act.walk?.(escape.col, escape.row) ?? c.moveToSquare?.(escape.col, escape.row, 18);
              onDecision?.({ ticks, goal: 'unstuck', action: 'walk',
                what: `stuck at (${me.col},${me.row}), walking to open square (${escape.col},${escape.row})`, sent: true });
              _lastPosAt = now(); // reset timer
              return;
            }
            // No open neighbor: blink as last resort.
            const blink = (c.spells ?? []).find(sp => {
              const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
              return n.toLowerCase() === 'blink';
            }) ?? (c.skills ?? []).find(sp => {
              const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
              return n.toLowerCase() === 'blink';
            });
            if (blink) {
              // Blink AWAY from the target, not into it. A fixed
              // direction (east) re-blinked the character into the
              // same stuck spot. Face opposite the target so the
              // teleport goes toward open space. If there is no
              // target, fall back to east.
              let faceDeg = 0;
              const t = _lastTargetId != null && objs instanceof Map ? objs.get(_lastTargetId) : null;
              if (t?.col != null) {
                faceDeg = (Math.atan2(t.row - me.row, t.col - me.col) * 180 / Math.PI + 180 + 360) % 360;
              }
              // A blink needs CONCENTRATION: any move or turn packet we send while it
              // charges interrupts it and it fails. The tick driver sends move/turn at
              // 10Hz, so a fire-and-forget cast (the old behavior) was broken by the very
              // next tick — the character blinked, the cast was interrupted, and it sat
              // stuck forever re-blinking (JayB at (38,29) in the Mausoleum). Freeze the
              // loop (hold the character perfectly still) for the cast duration, the same
              // way the /action cast override does. The face turn is sent FIRST, then we
              // freeze, so the turn lands before the cast begins and no further turn/move
              // packets go out to break it.
              c.turn?.(faceDeg);
              const loop = session?._tickLoop;
              if (loop) {
                const BLINK_MS = 11000;  // blink casts ~10s; hold a beat past it
                // A DEADLINE, NOT A FLAG. This path always had a setTimeout backstop, which
                // is why it was not the one that froze JayB for ever — but the backstop was
                // a second mechanism guarding a boolean. freeze() carries the deadline
                // itself, so there is one thing to get right instead of two.
                loop.freeze(BLINK_MS, 'blink');
                // Unfreeze when the relocation lands OR after the cast window, whichever
                // first. The moved-event path is the reliable one (the server confirms the
                // teleport); the timeout is the backstop so a failed cast can't hold the
                // character frozen for ever.
                const since = c.evSeq;
                let unfrozen = false;
                const unfreeze = () => { if (!unfrozen) { unfrozen = true; loop.thaw(); } };
                // `cast` IS FIRE AND FORGET AND RETURNS UNDEFINED — it writes a packet
                // (m59-client.mjs: `cast(spellId, targets)` calls `this.send` and returns).
                // This used to read `c.cast(...).then?.(...)`, and `?.` guards CALLING a
                // method, not READING one off undefined, so it threw
                // `Cannot read properties of undefined (reading 'then')` on every blink.
                //
                // That throw is what made the freeze permanent: it escaped decide() between
                // setting the flag and clearing it, so the character never unfroze, the tick
                // loop returned early for ever, and the watchdog spun every three seconds.
                // One missing await-shaped assumption cost 165 keeper respawns.
                try { c.cast(blink.id, []); } catch { unfreeze(); }
                try {
                  c.waitFor?.({ since, kinds: ['moved'], timeoutMs: BLINK_MS })
                    ?.then(() => unfreeze())?.catch(() => unfreeze());
                } catch { unfreeze(); }
                setTimeout(unfreeze, BLINK_MS);  // backstop; freeze() also has its own deadline
              } else {
                // No tick loop to freeze (shouldn't happen in the tick driver, but the
                // decider is shared): plain cast, no concentration protection.
                c.cast(blink.id, []);
              }
              onDecision?.({ ticks, goal: 'unstuck', action: 'blink',
                what: `stuck at (${me.col},${me.row}) for ${Math.round(held/1000)}s, blinking away (face ${Math.round(faceDeg)}°)`, sent: true });
              _lastPosAt = now(); // reset timer
              return;
            }
            }
          }
        } else {
          _lastPos = { col: me.col, row: me.row };
          _lastPosAt = now();
        }
      }
    }

    // 1. SENSE -> VOCABULARY. Free: every producer reads pushed state.
    const ws = evaluate({ client, session, policy, agent: session.name });
    // Expose the raw vigor value for the vigor_low goal.
    ws._vigor = client?.vitals?.()?.vigor?.value ?? null;

    // ── DEATH WATCH ──────────────────────────────────────────────────────────────────
    //
    // The only death record a tick-keeper character produced was the ledger's fallback,
    // written by a SAMPLER that noticed the room had become the Underworld between two polls:
    // `{was_in, level, note:"inferred from sampling"}`. When, roughly where, and max health —
    // nothing about what killed us. Every one of today's three deaths looks like that, and a
    // death-and-revive between samples is missed entirely, so even the count is a floor.
    //
    // The postmortem that carries killer, HP trail and company lives in m59-autopilot.mjs and
    // this keeper never runs it. So keep a rolling snapshot of the last moment we were ALIVE —
    // by the time the Underworld is observable the room that killed us is gone — and write it
    // down on the transition.
    try {
      const inUw = ws.in_underworld === true;
      if (!inUw) {
        const v = client?.vitals?.()?.health;
        const hp = v?.value ?? null, maxHp = v?.max ?? null;
        const trail = session._hpTrail ?? (session._hpTrail = []);
        if (hp != null && (trail.length === 0 || trail[trail.length - 1] !== hp)) {
          trail.push(hp);
          if (trail.length > 12) trail.shift();
        }
        // WHO WAS ON US. Creatures only — the prey list already excludes shopkeepers — and
        // counted twice over: everything close enough to matter, and the subset the server
        // has flagged ENEMY, which is the difference between "a crowded room" and "a gang".
        const objs = client?.room?.objects;
        const me = frame?.position ?? client?.self;
        let near = 0, aggro = 0; const names = [];
        if (objs instanceof Map && me?.col != null) {
          for (const o of objs.values()) {
            if (o.is_self || o.col == null) continue;
            const nm = String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
            if (!preyNames().has(creatureKey(nm))) continue;
            if (Math.hypot(o.col - me.col, o.row - me.row) > 5) continue;
            near++;
            if (o.flags & 0x02000000) { aggro++; names.push(nm); }   // OF.ENEMY
          }
        }
        session._preDeath = {
          at: now(), hp, max: maxHp, hp_trail: trail.slice(-8),
          room: frame?.room?.name ?? null, room_num: session.world?.room?.num ?? null,
          // The world state carries only the id; resolve it while the room still exists.
          target: (() => {
            const id = ws._targetId;
            if (id == null || !(objs instanceof Map)) return null;
            const o = objs.get(id);
            return o ? String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? id) : null;
          })(),
          engaged_by: aggro, creatures_within_5: near,
          attackers: [...new Set(names)].slice(0, 6),
          in_safe_spot: !!session._holdingSafeSpot,
          vigor: ws._vigor ?? null,
        };
        session._deathWritten = false;
      } else if (!session._deathWritten) {
        session._deathWritten = true;
        session._hpTrail = [];
        const d = session._preDeath ?? {};
        const who = client?.me?.name ?? session.credentials?.character ?? session.name;
        if (who) {
          recordEvent(who, 'died', {
            agent: session.name, observed: true, keeper: 'tick',
            died_in: d.room ?? null, room_num: d.room_num ?? null,
            level: d.max ?? null, hp_trail: d.hp_trail ?? null,
            last_target: d.target ?? null,
            engaged_by: d.engaged_by ?? null,
            creatures_within_5: d.creatures_within_5 ?? null,
            attackers: d.attackers?.length ? d.attackers : undefined,
            in_safe_spot: d.in_safe_spot ?? null,
            vigor: d.vigor ?? null,
            note: 'observed by the tick keeper at the moment of death',
          });
          console.error(`[death] ${who} died in ${d.room ?? '?'} — engaged by ${d.engaged_by ?? '?'}`
            + ` (${d.creatures_within_5 ?? '?'} within 5), hp trail ${JSON.stringify(d.hp_trail ?? [])}`
            + `, last target ${d.target ?? '?'}`);
        }
      }
    } catch (e) { /* a record must never break the play it records */ }

    // CLEAR THE BUY-ROUTE FLAG ONCE ARMED. The `armed` goal set _buyingRoute while
    // routing to the smith to buy a weapon. Once the character is armed (the buy
    // succeeded, or the mace re-equipped), clear the flag so the hunt goal can grab
    // the router again and re-route to a hunt room. Without this, _buyingRoute would
    // stay set and the hunt goal would hold the route to the shop forever.
    if (ws.armed === true && session._buyingRoute != null) {
      session._buyingRoute = null;
    }
    // Also clear the buy-ACTIVE flag once armed, so the hunt goal resumes.
    if (ws.armed === true && session._buyingActive) {
      session._buyingActive = false;
    }

    // DETECT DAMAGE. If our HP just dropped (vs lastSeenHp), we took damage. The
    // attacker is the nearest mob in melee range — the game doesn't send an explicit
    // "hit by X" message, but melee range is ~2 squares, so whoever is on top of us
    // is the one hitting us. We record this so target selection can re-target to the
    // actual attacker instead of sticking with a passive mummy that isn't fighting us.
    {
      const curHp = client?.vitals?.()?.health?.value ?? null;
      if (curHp != null && lastSeenHp != null && curHp < lastSeenHp) {
        lastDamagedAt = now();
      }
      if (curHp != null) lastSeenHp = curHp;
      ws._justDamaged = (now() - lastDamagedAt) < 3000;  // "took damage within the last 3s"
    }

    // 1a. TARGET SELECTION. The world state's has_target/in_reach/
    // target_in_band are all produced from ws._targetId. In the GOAP
    // keeper, the planner sets _targetId when it picks a target. In
    // the tick driver, we do it here: pick the nearest hostile in
    // the room and set _targetId, _targetLevel, _threatCeiling.
    {
      const objects = client?.room?.objects;
      const me = client?.self;
      // Reset each tick: the target-selection block sets has_target true
      // only when a target exists. Without this, a dropped target (killed,
      // left the room, blacklisted) leaves has_target stale-true and the
      // character keeps "fighting" a ghost.
      ws.has_target = false;
      if (objects instanceof Map && me?.col != null) {
        // If we already have a target and it's still in the room, keep it.
        // STICKY: use _lastTargetId (the PERSISTENT module-level target), not ws._targetId
        // (which is fresh each tick from evaluate() and always null here). The old code
        // checked ws._targetId, which was always null, so the stickiness never worked and
        // the decider re-picked a target every cycle — the character kept switching mummies
        // and resetting its path, never making progress. Now: keep the current target until
        // it is killed, leaves the room, is blacklisted as unreachable, OR a MUCH closer
        // target appears (less than 50% of the current distance), OR we just took damage
        // and a mob is in melee range (the attacker — fight the one hitting us).
        let target = _lastTargetId != null ? objects.get(_lastTargetId) : null;
        // UNREACHABLE STICKY TARGET. The combat controller reports _moverNoRoute
        // when the fine A* finds no path to the current target (it moved behind a
        // wall/ledge, or was never reachable to begin with). The _moverNoRoute
        // blacklist at the bottom of the if(!target) block only runs when there is
        // NO current target, so a STICKY unreachable target is never blacklisted and
        // the character fights it forever, oscillating in place (JayB, Mausoleum:
        // targeting an mummy 12 squares away with no fine path, stuck detector
        // suppressed by the _fight goal). Drop the sticky target here, after it has
        // been reported no-route for >=1.5s, so the if(!target) block re-runs and
        // picks the next-closest REACHABLE mob. 1.5s matches the selector's own
        // persistence threshold so a momentary geometry blip doesn't churn the target.
        if (target) {
          const nr = session?._moverNoRoute;
          if (nr?.targetId != null && nr.targetId === target.id && now() - nr.at < 15000 && now() - nr.at >= 1500) {
            const oId = target.id ?? target.obj_id;
            if (oId != null) {
              _blacklist.add(oId);
              _blacklistAt = now();
              _lastTargetId = null;
              session._moverNoRoute = null;
              target = null;  // drop it; if(!target) below picks a reachable one
            }
          }
        }
        // Re-target if a MUCH closer candidate exists. Only run this check occasionally
        // (throttled) so it doesn't add cost to every tick.
        if (target && now() - retargetCheckAt > 2000) {
          retargetCheckAt = now();
          const tD2 = (target.col - me.col) ** 2 + (target.row - me.row) ** 2;
          let closestD2 = Infinity;
          // Build creature names (same as the if(!target) block below).
          let cNames = new Set();
          try {
            const spawns = loadSpawns(SPAWNS_FILE);
            if (spawns?.byMonster) for (const name of Object.keys(spawns.byMonster)) cNames.add(name.toLowerCase());
          } catch { /* compendium unavailable */ }
          for (const o of objects.values()) {
            if (o.is_self) continue;
            if (o.col == null || o.row == null) continue;
            const oId = o.id ?? o.obj_id;
            if (oId != null && (oId === _lastTargetId || _blacklist.has(oId))) continue;
            const objName = String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
            const isMob = (o.is_player && o.can_attack) || (cNames.size > 0 && cNames.has(objName));
            if (!isMob) continue;
            const d2 = (o.col - me.col) ** 2 + (o.row - me.row) ** 2;
            if (d2 < closestD2) closestD2 = d2;
          }
          // Re-target if a candidate is less than 50% of the current distance (squared: 25%).
          if (closestD2 < tD2 * 0.25) {
            target = null;  // drop the sticky target; the if(!target) block will pick the closer one
          }
          // Re-target if we just took damage and a mob is in melee range (the attacker).
          // The game doesn't send "hit by X"; melee range is ~2 squares, so the mob on top
          // of us is the one hitting us. If our current target is NOT that mob, drop it so
          // we fight the actual attacker instead of a passive mummy that's ignoring us.
          if (target && ws._justDamaged) {
            const meleeD2 = 5;  // MELEE_REACH=2, squared=4, use 5 for a small margin
            let attackerInMelee = false;
            for (const o of objects.values()) {
              if (o.is_self) continue;
              if (o.col == null || o.row == null) continue;
              const oId = o.id ?? o.obj_id;
              if (oId != null && (oId === _lastTargetId || _blacklist.has(oId))) continue;
              const d2 = (o.col - me.col) ** 2 + (o.row - me.row) ** 2;
              if (d2 <= meleeD2) { attackerInMelee = true; break; }
            }
            if (attackerInMelee) {
              target = null;  // drop the sticky target; pick the attacker (nearest in melee)
            }
          }
        }
        // DEBUG (temporary): trace the sticky target + has_target
        if (!target) {
          // Pick the nearest non-player, non-self object that looks like a mob.
          // Throttled: the reachability A* is expensive (20k nodes). Re-run it
          // only when the character has moved >1 square OR >2s since the last
          // check, reusing the last result otherwise. This keeps the event
          // loop unblocked (a full re-scan was causing 5s ticks and starving
          // the keeper's HTTP server).
          let best = null, bestD2 = Infinity;
          let bestElev = null, bestElevD2 = Infinity;  // vestigial; kept for the fallback below
          let candidateCount = 0;
          const candidates = [];
          // Build a set of known creature names from the
          // compendium (spawns data). An object whose name
          // matches a compendium creature is a mob.
          // ONE PREY LIST, SHARED WITH THE COMBAT CONTROLLER.
          //
          // This built its own set from loadSpawns and so carried its own bugs: it compared
          // the compendium's CLASS names against the wire's DISPLAY names (so "giant rat"
          // never matched GiantRat), and it had no idea byMonster is full of shopkeepers.
          // preyNames() keys both sides the same way and subtracts the merchant index.
          const creatureNames = preyNames();
          const dangerCap = Number.isFinite(policy?.maxAttackAbility)
            ? policy.maxAttackAbility : DEFAULT_ATTACK_ABILITY_CAP;

          // Reset blacklist when the room changes or
          // after 60s (mobs may have moved).
          const roomNum = client?.room?.num ?? client?.room?.id ?? null;
          if (roomNum !== _blacklistRoom || now() - _blacklistAt > 60000) {
            _blacklist = new Set();
            _blacklistRoom = roomNum;
            _blacklistAt = now();
          }
          // BLACKLIST A DEFINITIVELY UNREACHABLE TARGET. The mover reports 'no-route' when
          // the fine grid has no walkable path to the current target (a wall, a locked door,
          // a ledge). The decider itself skips the reachability A* for performance, so this
          // is the ONLY place an unreachable target gets dropped. Without it, the character
          // chased a walled-off mummy for minutes (the 'targeting an unreachable mummy' loop).
          // Require it to persist for 3s so a momentary geometry blip doesn't blacklist a
          // target that's actually reachable.
          const nr = session?._moverNoRoute;
          if (nr?.targetId != null && now() - nr.at < 15000) {
            // Blacklist after 1.5s of persistent no-route (the mover reports no-route every
            // tick while it can't reach the target). This must fire BEFORE the stuck detector
            // (30s) so the character drops the walled-off target and picks the next-closest
            // reachable one, instead of blinking away in a loop.
            if (now() - nr.at >= 1500 || nr._repeated) {
              _blacklist.add(nr.targetId);
              _blacklistAt = now();
              session._moverNoRoute = null;
            } else {
              nr._repeated = true;
            }
          }

          for (const o of objects.values()) {
            if (o.is_self) continue;
            if (o.col == null || o.row == null) continue;
            // Skip blacklisted (unreachable) mobs.
            const oId = o.id ?? o.obj_id;
            if (oId != null && _blacklist.has(oId)) continue;
            // Resolve the name from nameRsc
            const objName = String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
            // A mob is either: flagged as a player with
            // can_attack (enriched object), OR its name
            // exactly matches a compendium creature.
            // Exact match only: "baby spider" != "spider".
            const isMob = (o.is_player && o.can_attack)
              || (creatureNames.size > 0 && creatureNames.has(creatureKey(objName)));
            if (!isMob) continue;
            // LEVEL IS NOT DANGER. ATTACK ABILITY IS.
            //
            //   GetAttackAbility = 3*viLevel + 60*viDifficulty      (monster.kod)
            //
            //     giant rat    lv30 d1 = 150      mummy       lv25 d2 = 195
            //     baby spider  lv25 d4 = 315      centipede   lv30 d5 = 390
            //     fungus beast lv50 d1 = 210      spider      lv50 d4 = 390
            //
            // A level-30 centipede is exactly as dangerous as a level-50 spider, and a baby
            // spider is 2.1x a giant rat that outranks it. Banding on level alone calls all of
            // them prey, which is how JayB killed seventeen giant rats without trouble and then
            // died five times in a row: every death was in a room holding a centipede, with no
            // target and nothing flagged, health walked down over six to eight samples.
            //
            // So refuse a quarry that hits harder than the character can take. The default is
            // read from what this fleet has survived rather than invented: rats (150) and
            // mummies (195) are sustainable at 21-27 max health; baby spiders (315) and
            // centipedes (390) are not.
            if (dangerCap != null) {
              const aa = attackAbility(objName);
              if (aa != null && aa > dangerCap) continue;
            }
            const d2 = (o.col - me.col) ** 2 + (o.row - me.row) ** 2;
            candidates.push({ o, d2 });
          }
          // Sort by 2D distance FIRST (cheap) to bound the candidate set, then rank by
          // TRVERSAL DISTANCE (path length), not Euclidean. A mummy 6 squares away in a
          // straight line but behind a wall has a much longer path than a mummy 10 squares
          // away in the open. The user's point: pick the closest by traversal distance.
          //
          // We compute the path for the NEAREST ~5 by Euclidean (bounding the A* cost),
          // and rank those by path length. The A* is bounded (maxNodes 20000) and throttled
          // by _reachCheckAt, so it does not run on every 10Hz tick.
          candidates.sort((a, b) => a.d2 - b.d2);
          const geo = session?.world?.geometry;
          const pathLen = (o) => {
            if (!geo?.finePathProtocol || me.col == null) return null; // no geometry
            // maxNodes capped at 4000 (not 20000): this runs on the tick hot path. A 20000-node
            // A* with per-segment physics traces can take SECONDS, which starved the event loop
            // and dropped the session. 4000 nodes bounds the worst case to ~100ms. If the search
            // is exhausted before 4000, finePathProtocol returns found:false (treated as
            // unreachable), which is the safe answer — we'd rather re-evaluate next cycle than
            // block the loop.
            const r = geo.finePathProtocol(
              me.col * 64 + 32, me.row * 64 + 32,
              o.col * 64 + 32, o.row * 64 + 32,
              { step: 8, margin: 12 * 64, maxNodes: 4000 });
            if (!r.found) return Infinity; // unreachable (or search exhausted)
            const wps = r.waypoints ?? [];
            if (wps.length === 0) return 0;
            let len = 0;
            let px = me.col * 64 + 32, py = me.row * 64 + 32;
            for (const wp of wps) {
              len += Math.hypot(wp.x - px, wp.y - py);
              px = wp.x; py = wp.y;
            }
            return len;
          };
          // Throttle: re-rank by path length at most once per 1.5s, or when the current
          // target is missing/dropped.
          // STICKY TARGET. If we already have a target and it's still in the room, keep it.
          // Do NOT re-rank by path length while a target is active — that caused a
          // re-targeting loop where the character switched mummies every 1.5s (the path
          // length re-check ran, picked a different mummy with a marginally shorter path,
          // reset the mover's path, and the character turned and started heading the other
          // way). The target is dropped only when it is killed, leaves the room, or is
          // blacklisted as unreachable.
          // Only re-rank by path length when there's NO active (sticky) target. The path-length
          // block is inside `if (!target)`, which only runs when the persistent target (_lastTargetId)
          // is gone (killed/left/blacklisted). So this is belt-and-suspenders: re-rank at most
          // once per 1.5s, and only when we don't already have a target to keep.
          //
          // ENABLED for new target selection: when picking a brand-new target (after a
          // blacklist or kill), run the A* path-length check to avoid picking an
          // unreachable mummy. The A* is bounded (maxNodes 4000, ~100ms) and only
          // runs when there's no sticky target — not every tick. This prevents the
          // "cycle through 5 unreachable mummies at 1.5s each" loop.
          // IS THE QUARRY EVEN IN THE SAME PIECE OF THE ROOM?
          //
          // Prey does not spawn where a character can walk. Room 1016's free space falls into
          // EIGHT disconnected pieces — a body of 9,582 cells and seven sealed pockets, the
          // largest 378 and 184 — because 88.6% of its tiles are crossed by a solid wall. A
          // mummy in one of those cannot be reached by any route at any quality of
          // pathfinding, and watched live that is a keeper picking it, failing to path,
          // blinking, and sitting still.
          //
          // This is a different question from "how far is it". Region membership is one array
          // lookup against a flood of free space, and it is exact: two points are mutually
          // reachable exactly when their labels match.
          //
          // NULL MEANS PERMISSION. A room with no collision data cannot answer, and refusing
          // every target there would cost the character its whole day — so only an explicit
          // false excludes.
          const reachable = (o) => {
            if (!geo || me.col == null || o.col == null) return null;
            return sameRegion(geo,
              { x: me.col * 1024 + 512, y: me.row * 1024 + 512 },
              { x: o.col * 1024 + 512, y: o.row * 1024 + 512 });
          };
          const sealedOff = new Set();
          for (const { o } of candidates) if (reachable(o) === false && o.id != null) sealedOff.add(o.id);

          const needPathCheck = true;
          if (needPathCheck) {
            // Rank candidates by traversal distance (path length), not Euclidean.
            // Bound the A* to the nearest 8 by Euclidean to limit cost.
            const toCheck = candidates.slice(0, 8);
            for (const { o, d2 } of toCheck) {
              if (o.id != null && _blacklist.has(o.id)) continue;
              if (o.id != null && sealedOff.has(o.id)) continue;   // another piece of the room
              const plen = pathLen(o);
              // plen === Infinity means unreachable (no fine path). Skip it.
              // plen === null means no geometry (fallback to Euclidean).
              if (plen === Infinity) continue;
              const rank = plen ?? d2;  // use path length if available, else Euclidean
              if (rank < bestD2) { bestD2 = rank; best = o; }
            }
            // Fallback: if no candidate had a valid path length (all unreachable
            // or no geometry), pick the nearest by Euclidean as before.
            // THE FALLBACK IS WHERE THIS WENT WRONG. It used to pick the nearest by
            // straight-line distance whenever no candidate produced a path length — which is
            // exactly the case when every candidate is UNREACHABLE, so "all sealed off" chose
            // one anyway. A target known to be in another piece of the room is excluded here
            // too; only "cannot say" falls through.
            if (!best) {
              for (const { o, d2 } of candidates) {
                if (o.id != null && _blacklist.has(o.id)) continue;
                if (o.id != null && sealedOff.has(o.id)) continue;
                if (d2 < bestD2) { bestD2 = d2; best = o; }
              }
            }
          } else {
            // Throttled: keep the previous target if it's still valid, else nearest by Euclidean.
            for (const { o, d2 } of candidates) {
              if (o.id != null && _blacklist.has(o.id)) continue;
              if (o.id != null && sealedOff.has(o.id)) continue;
              if (d2 < bestD2) { bestD2 = d2; best = o; }
            }
          }
          _reachCheckAt = now();
          // Track the nearest unreachable-when-checked mob for the
          // "whole room walled off" case. Without the A* we can't tell
          // reachability here, so bestElev stays null and the hunt goal
          // only fires when there are NO candidates at all (or all are
          // blacklisted).
          // Fallback: if no reachable target was found, leave has_target
          // false so the hunt goal can route to a different room. The
          // individually-unreachable mobs were already blacklisted by the
          // scan loop above, so the next scan skips them and tries the
          // next-closest. Don't blacklist the whole room here — other
          // mummies (or the same mummy after a geometry change) may be
          // reachable later.
          if (!best && bestElev) {
            ws._targetElevated = true;
          } else {
            ws._targetElevated = false;
          }
          // DEBUG (temporary): why is has_target false?
          if (best && !ws._targetElevated) {
            target = best;
            ws._targetId = best.id ?? best.obj_id;
            _lastTargetId = ws._targetId;
            _currentTargetId = ws._targetId;
            // Level: from the object's max_health or health, or the
            // compendium. The threat ceiling: same formula as the
            // GOAP keeper (level + band, halved when unarmed).
            const maxHp = client.vitals?.()?.health?.max ?? 20;
            const level = maxHp;
            const isArmed = ws.armed === true;
            const fullBand = policy?.threatBand ?? Math.floor(level / 2);
            const band = isArmed ? fullBand : Math.floor(fullBand / 2);
            ws._threatCeiling = level + band;
            // Level: from the object's max_health, or the
            // compendium (spawns data) for this room+creature.
            let targetLevel = best.max_health ?? best.health ?? null;
            if (targetLevel == null) {
              try {
                const spawns = loadSpawns(SPAWNS_FILE);
                if (spawns?.byMonster) {
                  const mobName = String(client.rsc?.get?.(best.nameRsc) ?? best.name ?? '').toLowerCase();
                  // Look up the monster in byMonster to find its level
                  // from any room it appears in.
                  for (const [monName, entries] of Object.entries(spawns.byMonster)) {
                    if (monName.toLowerCase() === mobName) {
                      // The level is typically in the room's spawn data.
                      // For now, use the creature name match as confirmation
                      // that this is a mob. The level will be set from the
                      // compendium's room data if available.
                      targetLevel = null; // will be set below
                      break;
                    }
                  }
                }
              } catch { /* compendium lookup failed */ }
            }
            ws._targetLevel = targetLevel;
            // Re-derive the target-dependent symbols.
            ws.has_target = true;
            ws.in_reach = bestD2 <= 4; // MELEE_REACH = 2, squared = 4
            // If the level is unknown, treat as in-band (the
            // GOAP keeper's default: a ceiling that defaults
            // open is the one that kills somebody, but a
            // target with unknown level is probably a common
            // mob in a room we already chose to hunt in).
            ws.target_in_band = targetLevel == null ? true : targetLevel <= ws._threatCeiling;
          }
        } else {
          // Target still in room: re-derive in_reach.
          const d2 = (target.col - me.col) ** 2 + (target.row - me.row) ** 2;
          ws.in_reach = d2 <= 4;
          ws.has_target = true;
          ws.target_in_band = true;  // DEBUG: force in-band to test
        }
      }
    }

    // 1b. POSITION CONFIRMATION. The server does not push our position.
    // Fire a confirm at a fixed cadence (the mover rate-limits internally).
    // This is fire-and-forget: the tick continues with dead reckoning
    // until the confirm resolves and syncs the mover.
    if (session._mover?.maybeConfirm) session._mover.maybeConfirm();

    // 2. GOAL. The first that applies and is not serving a skip.
    const active = goals.find(g => {
      if (!g?.goal || !g.when?.(ws)) return false;
      const until = skipped.get(g.goal) ?? 0;
      return now() >= until;
    });

    // Track whether we're resting or fighting (suppress
    // stuck detection). A character that's swinging at a
    // mummy or resting at an inn is intentionally not
    // moving — it's not stuck.
    _resting = active?.goal === 'healthy' || active?.goal === 'vigor_low';
    _fighting = active?.goal === '_fight';

    // STAND BEFORE MOVING (OR EQUIPPING). Resting sits the character down, and a
    // sitting character cannot move OR equip — the server silently refuses steps and
    // `use` while seated. When we transition from a rest goal to a movement goal OR
    // the `armed` goal (equip), send stand() first so the character is upright.
    // This is the fix for the respawn-at-inn case: JayB died, respawned sitting at Raza
    // Inn, and could not walk to the Mausoleum because he was still seated. The same
    // posture trap blocks equip: JayB, Raza Inn, full HP, mace in pack, `armed` goal
    // firing every tick with `use` at 10/s but equipment stuck at [] because he was
    // still sitting from the rest. `armed` is in the list so the stand goes out before
    // the plan/intend path tries to equip.
    if (_wasResting && !_resting && active && (active.goal === 'hunt' || active.goal === 'flee_danger' || active.goal === 'flee_hurt' || active.goal === 'travel' || active.goal === '_fight' || active.goal === 'armed')) {
      try { act.stand?.(); } catch { /* best effort */ }
      onDecision?.({ ticks, goal: active.goal, action: 'stand', sent: true, what: 'stand before ' + (active.goal === 'armed' ? 'equipping' : 'moving') });
      _wasResting = false;
      return;
    }
    _wasResting = _resting;

    // 2a1. HEALTHY (rest to recover HP) — but HP REGEN IS GATED BEHIND THE
    // FIRST-MOVE FLAG. The server's HealthTimer only gains a point when
    // (piFlags & PFLAG_MOVED_SINCE_ENTRY) is set (player.kod:2645), and that
    // flag is reset to FALSE on entering a safe room like an inn
    // (player.kod:1871). A character that rests without ever moving in the
    // room is frozen: HealthTimer keeps rescheduling (NewHealth) and never
    // gains a point. Watched live: JayB sat at Raza Inn at HP 3 for hours —
    // not stale data, the server genuinely never ran the regen because he
    // never moved. The fix: do a one-square POKE (stand, step a walkable
    // neighbor, sit back down) the first time we rest for HP in a room, to
    // set the flag. After that the server regens on its own and we just rest.
    // Throttled to 30s so a botched poke (blocked step) retries without spamming.
    if (active?.goal === 'healthy' && ws.hurt === true) {
      const hp = client.vitals?.()?.health?.value ?? 0;
      const maxHp = client.vitals?.()?.health?.max ?? 20;
      const now2 = now();
      if (hp < maxHp && now2 - _hpPokeAt > 30000) {
        _hpPokeAt = now2;
        const me = client.self;
        if (me && me.col != null) {
          // Find the nearest walkable neighbor to step to (N, S, E, W).
          const geo = session.world?.geometry;
          const canStep = (r, c) => {
            const f = geo?.fineWalkable ? geo.fineWalkable(r, c) : undefined;
            const w = geo?.walkable ? geo.walkable(r, c) : undefined;
            if (f === false) return false;
            if (f === undefined && w === false) return false;
            return true;
          };
          let poked = false;
          for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
            const nr = me.row + dr, nc = me.col + dc;
            if (!canStep(nr, nc)) continue;
            try {
              act.stand?.();
              act.step?.(nc, nr, { minGapMs: 0 });
              // Sit back down so we rest. The step sets PFLAG_MOVED_SINCE_ENTRY.
              act.rest?.();
              poked = true;
              break;
            } catch { /* try the next direction */ }
          }
          onDecision?.({ ticks, goal: 'healthy', action: poked ? 'poke+rest' : 'rest',
            sent: poked, what: poked ? 'poke to unlock HP regen, then rest' : 'no walkable neighbor to poke' });
          return;
        }
      }
      // Already poked (flag should be set): just rest. The server regens on its own.
      const r = intend('rest', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      onDecision?.({ ticks, goal: 'healthy', action: 'rest',
        sent: r.sent, what: r.what ?? null, why: r.why ?? null });
      return;
    }

    // 2a. UNDERWORLD: escape is a special case. Walk toward the
    // nearest portal. This is not a world-state transition the
    // planner handles; it's a directional decision.
    if (active?.goal === '!in_underworld') {
      const r = intend('escape_underworld', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      onDecision?.({ ticks, goal: '!in_underworld', action: 'escape_underworld',
        sent: r.sent, what: r.what ?? null, why: r.why ?? null });
      return;
    }

    // 2a1. GRADUATE OUT OF RAZA. Same shape as the Underworld escape above: a directional
    // decision the planner has no transition for, and the only way out of the zone.
    if (active?.goal === 'leave_raza') {
      const r = intend('leave_raza', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      onDecision?.({ ticks, goal: 'leave_raza', action: 'leave_raza',
        sent: r.sent, what: r.what ?? null, why: r.why ?? null });
      return;
    }

    // 2a2. VIGOR LOW: rest to recover vigor. The character
    // can't fight effectively below vigor 20. Resting
    // recovers vigor over time (faster at an inn).
    if (active?.goal === 'vigor_low') {
      const r = intend('rest', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      onDecision?.({ ticks, goal: 'vigor_low', action: 'rest',
        sent: r.sent, what: r.what ?? null, why: r.why ?? null });
      return;
    }

    // 2b. FLEE DANGER: out-of-band aggroed mob. Run for the exit.
    // Set the router's destination to the nearest exit room.
    if (active?.goal === 'flee_danger') {
      const router = session._router;
      if (router) {
        // Walk toward the nearest exit. The router's leg planner
        // will find the exit staging square. We just need to give
        // it a destination: the room beyond the nearest exit.
        try {
          const exits = session.world?.exits?.() ?? [];
          if (exits.length > 0) {
            const exit = nearestExit(exits, frame?.position ?? client?.self);
            if (router.dest !== exit.to) {
              router.to(exit.to);
              onDecision?.({ ticks, goal: 'flee_danger', action: 'travel',
                what: `flee to room ${exit.to} via ${exit.direction ?? exit.kind ?? 'the nearest way out'}`, sent: true });
              return;
            }
          }
        } catch { /* fall through */ }
        // Already routing to an exit: keep going.
        const r = routeIntent(router)(frame, act);
        onDecision?.({ ticks, goal: 'flee_danger', action: 'travel',
          what: r.what ?? r.why, sent: r.sent });
        return;
      }
      // No router: idle (can't flee without a path).
      onDecision?.({ ticks, goal: 'flee_danger', action: null, why: 'no router' });
      return;
    }

    // 2b2. FLEE HURT: hurt with a target in the room. Same
    // behavior as flee_danger: run for the nearest exit.
    if (active?.goal === 'flee_hurt') {
      const router = session._router;
      if (router) {
        try {
          const exits = session.world?.exits?.() ?? [];
          if (exits.length > 0) {
            const exit = nearestExit(exits, frame?.position ?? client?.self);
            if (exit && router.dest !== exit.to) {
              router.to(exit.to);
              onDecision?.({ ticks, goal: 'flee_hurt', action: 'travel',
                what: `flee (hurt) to room ${exit.to} via ${exit.direction ?? exit.kind ?? 'the nearest way out'}`, sent: true });
              return;
            }
          }
        } catch { /* fall through */ }
        const r = routeIntent(router)(frame, act);
        onDecision?.({ ticks, goal: 'flee_hurt', action: 'travel',
          what: r.what ?? r.why, sent: r.sent });
        return;
      }
      onDecision?.({ ticks, goal: 'flee_hurt', action: null, why: 'no router' });
      return;
    }

    // 2c. FIGHT: delegate to the CombatController which handles
    // the full safe-wall combat state machine (approach, hold,
    // pull, fight, close). One action per tick.
    if (active?.goal === '_fight') {
      let combat = session._combat;
      if (!combat) {
        combat = new CombatController(session);
        session._combat = combat;
      }
      const r = combat.tick(frame, act, ws);
      // A combat tick is NOT a failure just because it's a cooldown or facing
      // the target. The old `note(goal, kind==='swing'||'walk')` counted every
      // "attack cooldown" and "facing target" tick as a failure, and after 5 of
      // them (skipAfter) it SKIPPED the _fight goal for 3000ms (skipForMs). The
      // cycle: swing -> 5 cooldowns (500ms) -> _fight skipped 3000ms -> swing
      // again = a 3.5s swing gap (measured 3570ms, 0.28/s instead of 1/s).
      // Only a genuine "no progress possible" (the target is unreachable/stuck
      // with no path) is a failure. All normal combat states (swing, walk,
      // idle-cooldown, facing, retreat, cast, stand, loot) are engagement, not
      // failure. The reachability problem is handled separately by
      // session._moverNoRoute (blacklist) and the stuck detector, not by
      // pausing the fight goal.
      const fighting = r.kind === 'swing' || r.kind === 'walk' || r.kind === 'cast'
        || r.kind === 'loot' || r.kind === 'stand' || r.kind === 'idle';
      note(active.goal, fighting);
      onDecision?.({ ticks, goal: '_fight', action: r.kind,
        what: r.what ?? null, why: r.why ?? null });
      // Loot after a kill: the target died, its drops are on the floor.
      // lootFloor is async and multi-second, so kick it off
      // fire-and-forget (it has its own pacer queue and won't block the
      // tick). A cooldown prevents re-looting every tick while the floor
      // is still being picked up.
      if (r.kind === 'loot') {
        const now = Date.now();
        const agentName = session.name;
        if (!session._lastLootAt || now - session._lastLootAt > 5000) {
          session._lastLootAt = now;
          session.lootFloor?.({ maxItems: 12 }).then(res => {
            const taken = res?.taken?.length ?? 0;
            if (taken) console.error(`[tick] ${agentName} looted ${taken} item(s) after kill`);
          }).catch(e => console.error(`[tick] ${agentName} loot err: ${e.message}`));
        }
      }
      return;
    }

    // 2c2. TOWN BUSINESS: sell the surplus, bank the excess.
    if (active?.goal === 'sell_loot' || active?.goal === 'bank_money') {
      const r = intend(active.goal, frame, act, { client, session, ws, policy });
      note(active.goal, r.sent);
      onDecision?.({ ticks, goal: active.goal, action: active.goal,
        sent: r.sent, what: r.what ?? null, why: r.why ?? null });
      return;
    }

    // 2d. HUNT GOAL: if nothing better to do and no target in band,
    // pick a hunt room and set the router's destination. This is a
    // directional decision, not a world-state transition — it sets
    // the router's destination rather than sending a command.
    if (active?.goal === 'hunt' || (!active && ws.has_target === false)) {
      // YIELD WHOLESALE WHILE THE BUY IS ACTIVE (approaching the merchant or the async
      // shop-open/purchase in flight). The buy goal drives the mover itself during the
      // same-room approach, so the hunt goal must not touch the router or mover at all —
      // otherwise it resets the destination to the hunt room and the character bounces
      // in place. `_buyingActive` is set by the buy intent and cleared when the character
      // becomes armed (or the buy is abandoned).
      if (session._buyingActive) {
        return;
      }
      const router = session._router;
      if (router && router.dest == null) {
        // No active route: pick a hunt room. BUT if the character is actively routing
        // to a shop to buy a weapon (the `armed` goal set _buyingRoute), don't grab the
        // router — that's how hunt would override the smith-bound route and JayB would
        // bounce between 1012 (smith) and 1016 (Mausoleum) without buying. The hunt
        // goal resumes once the buy succeeds (armed=true clears _buyingRoute) or the
        // route is abandoned.
        if (session._buyingRoute != null && session._buyingRoute === router.dest) {
          // Let the armed goal keep driving the route.
          const r = routeIntent(router)(frame, act);
          onDecision?.({ ticks, goal: 'hunt', action: 'travel',
            what: r.what ?? `holding route to shop (room ${session._buyingRoute})`, sent: r.sent });
          return;
        }
        try {
          const roomNum = frame?.room?.num ?? frame?.room?.id;
          const roomName = frame?.room?.name ?? null;
          const map = loadMap();
          const resolved = resolveRoomNum({ id: roomNum, num: roomNum, name: roomName }, map) ?? roomNum;
          const maxHp = client.vitals?.()?.health?.max ?? 20;
          const level = maxHp;
          // Same formula as the GOAP keeper: policy.threatBand ?? floor(level/2),
          // halved when unarmed. The ceiling is level + band.
          const isArmed = ws.armed === true;
          const fullBand = policy?.threatBand ?? Math.floor(level / 2);
          const band = isArmed ? fullBand : Math.floor(fullBand / 2);
          const ceiling = level + band;
          // AN ASSIGNED ROOM IS AN ORDER, AND THIS IGNORED IT.
          //
          // nearestHuntRoom picks purely by level ceiling, so a character with
          // policy.assignedRoom set went wherever the ceiling pointed — Lee to 557 for
          // centipedes with baby spiders ordered in 575, JayB to whatever was nearest with
          // giant rats ordered in 535. assigned_room is also what stops the whole fleet
          // stacking into one top-ranked room, which is the reason it exists.
          //
          // So an assignment wins outright while the character is not in it. Nothing else
          // changes: once there, the ordinary in-room hunt takes over.
          const assigned = Number(policy?.assignedRoom);
          if (Number.isFinite(assigned) && assigned !== resolved) {
            router.to(assigned);
            onDecision?.({ ticks, goal: 'hunt', action: 'travel',
              what: `assigned room ${assigned} — heading there`, sent: true });
            return;
          }
          const hunt = nearestHuntRoom(resolved, ceiling);
          if (hunt && hunt.room !== resolved) {
            router.to(hunt.room);
            onDecision?.({ ticks, goal: 'hunt', action: 'travel',
              what: `hunt ${hunt.creature} lv${hunt.level} in room ${hunt.room} (hops=${hunt.hops})`,
              sent: true });
            return;
          }
          // Already in the hunt room (hops=0). Do NOT try to plan a travel
          // (there is none) — that produced "exhausted 5 nodes" every tick.
          // The character is in the right room; it waits for a target (mobs
          // respawn, or the target-selection picks one up next tick).
          if (hunt && hunt.room === resolved) {
            onDecision?.({ ticks, goal: 'hunt', action: null,
              what: `in hunt room (${hunt.creature} lv${hunt.level}); waiting for a target`, sent: false });
            return;
          }
        } catch (e) {
          // Hunt room lookup failed; fall through to idle.
        }
      }
      // If the router already has a destination, let it travel.
      if (router?.dest != null) {
        const r = routeIntent(router)(frame, act);
        onDecision?.({ ticks, goal: 'hunt', action: 'travel',
          what: r.what ?? r.why, sent: r.sent, why: r.why ?? null });
        return;
      }
      // No hunt room to travel to: we may already be in one,
      // or there's none in range. Fall through to the normal
      // goal stack so _fight, has_food, etc. can fire.
    }

    if (!active) { onDecision?.({ ticks, goal: null, why: 'nothing to do' }); return; }

    // 3. PLAN. Synchronous A* over an action set built from what this character has.
    const p = planFor(client, { [active.goal]: true }, { session, policy, ws });
    const first = p.found ? (p.names?.[0] ?? null) : null;

    // A GOAL THAT CANNOT BE PLANNED IS A FAILURE AND MUST COUNT AS ONE. The old keeper
    // returned before its failure counter on exactly this path, so the one outcome that
    // most clearly means "unreachable" was the only one that could never retire a goal,
    // and a character re-selected it for ever. Watched live: JayB, goal has_food,
    // "exhausted 13 nodes", every pass, not moving.
    if (!first) { note(active.goal, false); 
      onDecision?.({ ticks, goal: active.goal, action: null, why: p.reason ?? 'no plan' });
      return; }

    // 4. ACT. One command, fired, not awaited.
    //
    // BROKEN-WEAPON FALLTHROUGH. If the plan is `equip` but the only weapon in the pack
    // is broken (pickWieldableWeapon returns null), `equip` would send `use` on the
    // broken weapon and the server would refuse it every tick (the shattered-mace loop).
    // Instead, fall through to `buy`: the character is at a shop (the `armed` goal is
    // only actionable there in practice) and needs a replacement. This is the case the
    // planner can't see — `equip`'s precondition is empty, so it always looks viable,
    // and the broken-weapon state is tracked outside the world-state symbols. We check
    // it here, at the moment of acting, and swap the action.
    let actionName = first;
    // BROKEN-WEAPON FALLTHROUGH. If the plan is `equip` but the only weapon in the
    // pack is broken (pickWeapon finds one, but pickWieldableWeapon — which excludes
    // the broken set — returns null), `equip` would send `use` on the broken weapon
    // and the server would refuse it every tick (the shattered-mace loop). Swap to
    // `buy`: the character needs a replacement. This only fires when there IS a weapon
    // in the pack and it's broken — with an empty pack, `equip`'s "no weapon" refusal
    // stands (there's nothing to buy the character into; the refusal is the truth).
    // AN EMPTY PACK IS EXACTLY WHEN YOU NEED TO BUY.
    //
    // This required a weapon to already be IN the pack (`pickWeapon(client) != null`), on the
    // reasoning that with an empty pack "there's nothing to buy the character into; the refusal
    // is the truth". That is backwards, and it strands anyone who DIES: death drops everything
    // carried, so the survivor wakes with an empty pack, `equip` answers "no weapon to equip"
    // for ever, and nothing ever plans a purchase. Lee sat unarmed through 25 of those
    // refusals and could not kill anything at all.
    //
    // The condition that matters is the same in both cases: nothing wieldable. Broken or
    // absent, the answer is to go and buy one.
    if (active.goal === 'armed' && first === 'equip'
        && !pickWieldableWeapon(client, session)) {
      actionName = 'buy';
    }
    const r = intend(actionName, frame, act, { client, session, ws });
    note(active.goal, r.sent);
    onDecision?.({ ticks, goal: active.goal, action: actionName, sent: r.sent,
                   what: r.what ?? null, why: r.why ?? null });
  };

  function note(goal, ok) {
    if (ok) { fails.set(goal, 0); return; }
    const n = (fails.get(goal) ?? 0) + 1;
    fails.set(goal, n);
    if (n >= skipAfter) { skipped.set(goal, now() + skipForMs); fails.set(goal, 0); }
  }

  decide.state = () => ({ ticks, fails: Object.fromEntries(fails),
                          skipped: Object.fromEntries(skipped),
                          targetId: _currentTargetId });
  return decide;
}

// The fleet's ordinary ladder, as a default. Survival first, and every one of these is
// a REFUSAL-shaped condition rather than a weight: a cost can be outbid and a
// precondition cannot, which is the one rule docs/HANDOFF.md says must not be broken.
export const DEFAULT_GOALS = [
  { goal: '!in_underworld', when: ws => ws.in_underworld === true },
  // FLEE first: if an out-of-band mob is IN REACH (actually threatening us), run before
  // anything else. The old condition fired on ANY out-of-band target (has_target &&
  // !target_in_band), which made the character FLEE from a passive mummy just because it
  // was out of the threat band — even when the mummy was far away and not attacking. That
  // broke basic movement: the character would "flee" (travel to another room) instead of
  // walking, and the flee conflicted with the stuck-detector, causing a blink loop. Now:
  // only flee when the out-of-band threat is in reach (actually a danger). An out-of-band
  // target that is NOT in reach is handled by the hunt goal (route to a better target or
  // approach it), not by fleeing.
  // CRITICAL: RUN, WHETHER OR NOT IT IS TOUCHING YOU RIGHT NOW.
  //
  // Both flee goals below require in_reach, and `_fight` already refuses at critical. So a
  // character under criticalHp with the mob one step outside melee satisfied NOTHING: it would
  // not fight, would not flee, and fell through to hunt — standing in the open at 30% health
  // next to the thing that put it there, waiting to be hit again so that fleeing could become
  // legal. `in_reach` is a fact about this instant and a chasing mob is in and out of it every
  // second; below the critical line the answer is the same either way.
  { goal: 'flee_danger', when: ws => ws.critical === true && ws.has_target === true },
  // OUTNUMBERED: LEAVE. Two or more aggroed creatures on us is not the fight the thresholds
  // below were calibrated for — the incoming rate doubles while the outgoing does not, and a
  // character that stands its ground works down to a flee threshold it will cross with two of
  // them still swinging. It goes ABOVE flee_hurt because the decision has to be made while
  // there is still health to spend on the walk out, not after.
  //
  // Deliberately the same action as flee_danger: run for the nearest exit and leave the room.
  // Holding a safe spot is the answer to ONE attacker — a wall at your back stops a single
  // creature flanking you and stops nothing about being surrounded.
  { goal: 'flee_danger', when: ws => ws.outnumbered === true },
  // AND FLEE WHEN WE ARE LOSING HEALTH AND ALREADY HURT, whether or not anything is flagged
  // as an enemy and whether or not we hold a target. This is the rule that would have saved
  // JayB: hurt, health falling over eight samples, and every other flee condition false.
  { goal: 'flee_danger', when: ws => ws.under_attack === true && ws.hurt === true },
  { goal: 'flee_danger', when: ws => ws.has_target === true && ws.target_in_band === false && ws.in_reach === true },
  // FLEE when hurt AND a target is actively in reach
  // (attacking you). If the target is in the room but
  // not in reach, fight it instead of fleeing.
  { goal: 'flee_hurt', when: ws => ws.below_flee === true && ws.has_target === true && ws.in_reach === true },
  // Rest when hurt, but only when there's no target in
  // the room. If a target is in reach, the flee_hurt or
  // _fight goal handles it.
  { goal: 'healthy',  when: ws => ws.hurt === true && ws.has_target !== true },
  // Rest when vigor is low. Vigor IS health regeneration —
  // keeping it high keeps HP topping up. Rest below 60 to
  // maintain a buffer, but this is lower priority than
  // _fight so a character will still engage a target that's
  // in reach even at 40 vigor.
  { goal: 'vigor_low', when: ws => {
      const v = ws._vigor;
      return v != null && v < 60 && ws.in_reach !== true;
    } },
  // ARMED BEFORE FIGHT. This sat BELOW _fight, and in a room that always has a mummy in it
  // the armed goal therefore never got a turn: JayB fought bare-handed for 212 swings and
  // killed nothing, while fourteen maces sat in his pack. Being armed is a PRECONDITION of
  // fighting, not a competing use of the tick — the hunt band itself is halved when unarmed
  // (floor(level/4) against floor(level/2)), which is the same judgement expressed in the
  // policy. Equipping costs one tick and the fight resumes on the next.
  //
  // The failure mode this ordering used to protect against — equip refused for ever, so the
  // character never fights — is handled where it belongs: `equip` returns a refusal when
  // every weapon is broken, and `armed` then plans `buy` instead of retrying.
  // Only while it is achievable — see `can_arm`. An unarmed, penniless character must be
  // allowed to fight with its fists, because that is the only way it ever earns a weapon.
  { goal: 'armed',    when: ws => ws.armed === false && ws.can_arm !== false },
  // GRADUATE OUT OF RAZA — below survival and below being armed, above all work.
  //
  // BELOW SURVIVAL because this repository owns mortality on a one-second clock and a
  // character at 1 HP must run, not walk to a museum. Placing it second, above flee_danger
  // and flee_hurt, was my mistake and would have got somebody killed.
  //
  // BELOW `armed` because the trip is ONE-WAY and the smith is inside Raza (1013). Leaving
  // unarmed strands a character in the world with no weapon and no way back.
  //
  // ABOVE `_fight` and `hunt` because everything they can earn here is nothing: from max
  // health 25 the only creature Raza generates is a level-25 mummy, and advancement needs
  // monster_level > base_max_health. JayB farmed it for days.
  { goal: 'leave_raza', when: ws => ws.in_raza === true && ws.raza_outgrown === true },
  { goal: '_fight',   when: ws => ws.has_target === true && ws.target_in_band === true
                                 && ws.critical !== true
                                 && (ws.hurt === true || ws.vigor_floor !== false)
                                 // Don't fight if the target is on a
                                 // different elevation (unreachable).
                                 && ws._targetElevated !== true },
  // SHED THE SURPLUS BEFORE LOOKING FOR MORE WORK.
  //
  // Below `_fight` on purpose: finish the fight in front of you rather than walking off
  // mid-swing. Above `hunt`, because a pack that cannot receive cannot loot, and hunting with
  // a full pack earns nothing but risk. JayB was carrying seventeen maces and 1,020 shillings
  // while still looking for the next rat.
  { goal: 'sell_loot',  when: ws => ws.over_weapons === true
                                 || (ws.has_loot === true && ws.pack_room === false) },
  { goal: 'bank_money', when: ws => ws.purse_heavy === true },
  // HUNT before eating: the character should go find work (a mob to fight)
  // rather than sitting in town eating. Vigor management matters during
  // combat, not while idle. If vigor is truly too low to fight, the
  // _fight goal's vigor_floor check prevents engagement, and vigor_low
  // (above) handles resting. Eating while idle just delays the hunt.
  { goal: 'hunt',     when: ws => ws.has_target === false || ws.target_in_band === false },
  { goal: 'vigor_ok', when: ws => ws.vigor_ok === false && ws.has_food === true
                                 && ws.has_target !== true },
  { goal: 'has_food', when: ws => ws.has_food === false && ws.has_reagents === true },
];
