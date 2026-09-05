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
import { evaluate } from '../m59-worldstate.mjs';
import { KOD_FINENESS } from '../m59-roo.mjs';
import { planFor } from '../m59-plan.mjs';
import { pickWeapon } from '../m59-act/equip.mjs';
import { pickFood } from '../m59-act/eat.mjs';
import { knownSpells } from '../m59-act/cast.mjs';
import { affordances } from '../m59-parse.mjs';
import { knownLevel } from './m59-levels.mjs';
import '../m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

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
function scanBrokenFromEvents(client, session = null) {
  if (!client?.events) return;
  const set = brokenSetFor(session, client);
  const inv = client.inventory ?? [];
  // Build a name -> id map for the current pack (the refusal names the weapon).
  const nameToId = new Map();
  for (const o of inv) {
    const n = String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
    if (n && o?.id != null) nameToId.set(n, o.id);
  }
  for (const ev of client.events) {
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
import { nearestHuntRoom, huntRoomsAtOrBelow } from '../m59-hunt-room.mjs';
import { loadSpawns } from '../m59-spawns.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPAWNS_FILE = join(__dirname, '..', '..', 'compendium', 'data', 'spawns.json');
// Mob-name normalization: game names have spaces ('giant rat'), compendium
// keys don't ('GiantRat'). Lowercasing alone never matches multi-word mobs,
// which blinded the decider to every rat, orc, and skeleton (single-word
// 'mummy' worked, hiding the bug). Strip non-letters on both sides.
export function normMobName(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

// Mob-identity key: token SET, sorted and joined. Game names have spaces
// ('baby spider'), compendium keys are CamelCase ('SpiderBaby') — plain
// normalization matches neither direction for multi-word names, which blinded
// the decider to every spider, orc and skeleton. Token sets match regardless
// of separation or order ('baby spider' == 'SpiderBaby'), while still
// distinguishing 'spider' from 'baby spider' (different sets).
export function mobNameKey(s) {
  const spaced = String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.toLowerCase().split(/[^a-z]+/).filter(Boolean).sort().join(' ');
}

// PROHIBITED KINDS: never HUNT these unless specialized. Spiders (most
// badly outclass an unspecialized character; baby spiders exempt — good
// eating) and centipedes (venomous, nasty at-level). Prohibited is about
// hunting, not presence: danger-close still flees them in melee.
export function prohibitedKind(name, policy) {
  const key = mobNameKey(name);
  if (key.split(' ').includes('spider') && key !== 'baby spider'
      && policy?.huntSpiders !== true) return true;
  if (key.split(' ').includes('centipede') && policy?.huntCentipedes !== true) return true;
  return false;
}
// Spiders are excluded from targeting unless the character is explicitly
// specialized (policy.huntSpiders === true): most spiders badly outclass an
// unspecialized character. Baby spiders are exempt (good eating).
export function spiderProhibited(name, policy) {
  if (policy?.huntSpiders === true) return false;
  const key = mobNameKey(name);
  return key.split(' ').includes('spider') && key !== 'baby spider';
}

// NEARBY-HOSTILE SCAN (pure — unit tested). Any hostile-ish object within
// maxD2 (squared) of the character: recognized mobs of any kind (spiders
// included — this is about WHO IS HERE, not what we chose to fight), plus
// attack-flagged players. Used to refuse sitting down mid-mauling.
export function anyMobNear({ meCol, meRow, objects, maxD2 = 10, mobNames, nameOf }) {
  for (const o of (objects?.values?.() ?? [])) {
    if (o.is_self) continue;
    if (o.col == null || o.row == null) continue;
    const objName = mobNameKey(nameOf ? nameOf(o) : (o.name ?? ''));
    const isMob = (o.is_player && o.can_attack) || (mobNames?.size > 0 && mobNames.has(objName));
    if (!isMob) continue;
    const d2 = (o.col - meCol) ** 2 + (o.row - meRow) ** 2;
    if (d2 <= maxD2) return o;
  }
  return null;
}
export function fightEnvelopeOk({ traveling, targetD2, rangeSq = 64 }) {
  if (traveling !== true) return true;
  return (targetD2 ?? 99) <= rangeSq;
}
// DANGER-CLOSE DECISION (pure — unit tested). Returns the threatening mob or
// null: nearest hostile in melee range that is EITHER a prohibited spider
// (never fightable, but very much able to eat us) or known over the threat
// ceiling. Unknown non-spiders default open (consistent with target_in_band).
export function findDangerClose({ meCol, meRow, objects, ceiling, allowSpiders, allowCentipedes, mobNames, nameOf }) {
  const meleeD2 = 5;
  let best = null, bestD2 = Infinity;
  for (const o of (objects?.values?.() ?? [])) {
    if (o.is_self) continue;
    if (o.col == null || o.row == null) continue;
    const objName = mobNameKey(nameOf ? nameOf(o) : (o.name ?? ''));
    const isMob = (o.is_player && o.can_attack) || (mobNames?.size > 0 && mobNames.has(objName));
    if (!isMob) continue;
    const d2 = (o.col - meCol) ** 2 + (o.row - meRow) ** 2;
    if (d2 > meleeD2) continue;
    const aLevel = knownLevel(nameOf ? nameOf(o) : (o.name ?? ''), mobNameKey) ?? o.max_health ?? o.health ?? null;
    const spider = objName.split(' ').includes('spider') && objName !== 'baby spider' && !allowSpiders;
    const pede = objName.split(' ').includes('centipede') && !allowCentipedes;
    if (!spider && !pede && (aLevel == null || aLevel <= ceiling)) continue;
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  return best;
}
// ATTACKER-SWITCH DECISION (pure — unit tested). Returns the mob to switch to,
// or null to hold the sticky target. The ONLY sanctioned switch: we have not
// yet reached the current target (still traveling to it), a different in-band
// mob is in melee range, and we have the health to take it (hpPct >= 50).
// One focused fight is safer than collecting 2-3. Never abandon a joined
// fight (targetDist2 <= 4), never switch while hurt, never collect out-of-band.
export function findAttackerSwitch({ meCol, meRow, objects, currentId, blacklist,
                                     ceiling, hpPct, targetDist2, mobNames, nameOf }) {  if (targetDist2 <= 4) return null;   // already joined: finish it
  if (hpPct < 50) return null;         // too hurt to collect a second fight
  const meleeD2 = 5;                   // MELEE_REACH=2, squared=4, small margin
  let attacker = null, attackerD2 = Infinity;
  for (const o of (objects?.values?.() ?? [])) {
    if (o.is_self) continue;
    if (o.col == null || o.row == null) continue;
    const oId = o.id ?? o.obj_id;
    if (oId != null && (oId === currentId || blacklist?.has(oId))) continue;
    const objName = mobNameKey(nameOf ? nameOf(o) : (o.name ?? ''));
    const isMob = (o.is_player && o.can_attack) || (mobNames?.size > 0 && mobNames.has(objName));
    if (!isMob) continue;
    const d2 = (o.col - meCol) ** 2 + (o.row - meRow) ** 2;
    if (d2 > meleeD2) continue;
    const aLevel = o.max_health ?? o.health ?? null;
    if (aLevel != null && aLevel > ceiling) continue; // out of band: don't collect it
    if (d2 < attackerD2) { attackerD2 = d2; attacker = o; }
  }
  return attacker;
}
import { loadMap, findPath } from '../m59-map.mjs';
import { loadoutFor } from '../m59-loadout.mjs';
import { resolveRoomNum, routeIntent } from './m59-route.mjs';
import { isGrounded, nearestGrounded } from './m59-ground.mjs';
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
    // PHASE 0a fix: mark the mover as sitting so the sitting-trap
    // check fires and stands the character before the next move.
    if (ctx.session?._mover?.markSitting) ctx.session._mover.markSitting();
    // PRODUCTION GATE: rest is idempotent state, and the Pacer spaces sends
    // but never drops — submitting every tick floods the queue with stale
    // rests (watched live: rest 4/s, depth 80). Submit at most 1/s.
    const now7 = Date.now();
    if (now7 - (ctx.session?._lastRestStep ?? 0) >= 1000) {
      if (ctx.session) ctx.session._lastRestStep = now7;
      return { sent: !!act.rest(),  what: 'rest' };
    }
    return { sent: true, what: 'rest (holding)' };
  },
  stand: (f, act) => ({ sent: !!act.stand(), what: 'stand' }),

  equip: (f, act, ctx) => {
    // Scan the event ring for a recent "it's broken" refusal so a shattered weapon
    // gets condemned BEFORE we retry it (prevents the use-flood on a broken mace).
    scanBrokenFromEvents(ctx.client, ctx.session);
    // Success clears attempts: anything currently equipped worked, so a later
    // re-equip of the same id starts fresh instead of inheriting stale counts.
    try {
      const eq = ctx.client?.equipment?.();
      const held = new Set((eq && eq.known !== false ? eq.equipped || [] : []).map(o => o.id));
      const atts0 = ctx.session?._equipAttempts;
      if (atts0) for (const id of Object.keys(atts0)) if (held.has(Number(id))) delete atts0[id];
    } catch {}
    const item = pickWieldableWeapon(ctx.client, ctx.session);
    if (!item) {
      // No wieldable weapon in the pack (the only one is broken, or there is none).
      // The `armed` goal should now plan `buy` instead of retrying the broken weapon.
      // "no weapon" in the message is what the refusal contract expects (the test
      // matches /no weapon/) — a refusal, not a success.
      return { sent: false, why: 'no weapon to equip (broken or absent)' };
    }
    // SILENT-REFUSAL CONDEMN: the server sometimes refuses `use` with no prose
    // (watched live: equip 13752 retried indefinitely, never equipped, never
    // condemned). If this id was already tried 3+ times without ending up
    // equipped, condemn it — the fallthrough routes to conjure/buy next pass.
    // Gated to 1/s: three attempts span ~3s, long enough for a slow server to
    // process a legitimate equip, and it caps the use-packet rate as a bonus.
    const s = ctx.session;
    const atts = (s ? (s._equipAttempts ??= {}) : {});
    const rec = atts[item.id] ?? { n: 0 };
    if (rec.n >= 3) {
      delete atts[item.id];
      const set = brokenSetFor(s, ctx.client);
      if (!set.has(item.id)) {
        set.add(item.id);
        console.error(`[broken] ${s?.name ?? 'keeper'}: equip ${item.id} failed 3x with no equip; condemned as silent-broken`);
      }
      return { sent: false, why: `equip ${item.id} failed repeatedly; condemned` };
    }
    const now8 = Date.now();
    if (now8 - (rec.at ?? 0) < 1000) {
      return { sent: false, why: 'equip coalesced (1/s)' };
    }
    rec.n++; rec.at = now8;
    atts[item.id] = rec;
    act.use(item.id);
    ctx.session._lastEquipId = item.id;  // condemned on the next broken refusal (see scanBrokenFromEvents)
    return { sent: true, what: `equip ${item.name ?? item.id}` };
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
      // the smith sells weapons. Set _buyingRoute so hunt yields for the whole
      // journey (it only runs when the router is idle, i.e. exactly when it
      // would otherwise steal the destination back).
      if (s?._router) {
        const dest = 1013;  // Raza Blacksmith — where the smith sells weapons
        // Cooldown after an abandoned trip: without it, set/abandon alternates
        // every tick and `armed` still starves hunt. Hunt unarmed meanwhile;
        // a later room may have a route.
        if (s?._smithUnreachableUntil && Date.now() < s._smithUnreachableUntil) {
          return { sent: false, why: 'smith unreachable recently; hunting unarmed' };
        }
        if (s) s._buyingRoute = dest;
        const curDest = s._router.dest;
        if (curDest == null) {
          // Claim an idle router for the smith trip.
          s._router.to(dest);
          return { sent: true, what: `travel to the smith (room ${dest})` };
        }
        if (curDest !== dest) {
          // Owned by someone else (hunt/explicit travel): yield, do not
          // steal. Stealing forces a full replan every flap.
          return { sent: false, why: `router busy (dest=${curDest}); buy yields` };
        }
        // Already bound for the smith: abandon the trip if the router cannot
        // plan it (e.g. deep wilderness with no graph path to town) instead
        // of stalling on sent:false forever — fall back to hunting unarmed.
        // status() is cached fields, no replan.
        const st = s._router.status?.();
        if (st && st.state === 'no-route') {
          s._buyingRoute = null;
          s._router.clear();
          s._smithUnreachableUntil = Date.now() + 300000;
          return { sent: false, why: 'no route to the smith; hunting unarmed' };
        }
        const r = routeIntent(s._router)(frame, act);
        return { sent: r.sent, what: r.what ?? `traveling to the smith (room ${dest})` };
      }
      return { sent: false, why: 'no merchant in room' };
    }
    // A merchant is present. But neither the Raza Inn (1011, innkeeper Marcus, no
    // weapons) nor the Raza field (1012, no merchant) has a weapon for sale. If we're
// TOWN -> SMITH SHOP. Buy routes here when the current room has no weapon
// seller (pure — unit tested via TOWN_SMITH). Marion's Colhorr is in 201
// (Ye Olde Slasher Salesman), reached by the go-door at (43,31) — the
// buy-affordance object at (37,80) in Marion opens no shop list.
export const TOWN_SMITH = { 200: 201, 202: 201, 50: 374, 1011: 1013, 1012: 1013 };
    // in either, route to the Raza Blacksmith (1013) where the smith sells weapons.
    // Same if a cached list has no weapon.
    const roomNum = c.room?.num ?? s?.world?.room?.num;
    const buyList = c.buyList;
    const listHasWeapon = buyList?.items?.length
      ? buyList.items.some(i => /mace|sword|axe|club|hammer|dagger|staff|spear|blade|knife/i.test(String(c.rsc?.get?.(i.nameRsc) ?? i.name ?? '')))
      : null;  // null = list not cached yet
    // Route to the town smith when the current room sells no weapons: known
    // towns (unless already at the smith shop), or anywhere whose cached
    // list has no weapon. Destination falls back to Raza off the map towns.
    const smithHere = TOWN_SMITH[roomNum];
    if ((smithHere != null && roomNum !== smithHere && listHasWeapon !== true) || listHasWeapon === false) {
      // Inn or field (no weapons here) or a cached list with no weapon: go to the smith.
      if (s?._router) {
        const dest = TOWN_SMITH[roomNum] ?? 1013;  // town smith shop (Raza fallback)
        if (s) s._buyingRoute = dest;
        const curDest = s._router.dest;
        if (curDest == null) {
          // Claim an idle router for the smith trip.
          s._router.to(dest);
          // Drive the router on the same tick so the character starts moving
          // immediately, rather than waiting for the next tick's "already routing"
          // branch. Without this, the destination is set but nothing moves the
          // character, and it sits in the inn.
          const r = routeIntent(s._router)(frame, act);
          return { sent: r.sent, what: `travel to the smith (room ${dest}) — no weapon here` };
        }
        if (curDest !== dest) {
          // Owned by someone else (hunt/explicit travel): yield, do not
          // steal. Stealing forces a full replan every flap.
          return { sent: false, why: `router busy (dest=${curDest}); buy yields` };
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
      const me = ctx.session?._pose?.current?.() ?? c.self;
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
          mv.to(target.col, target.row, { by: 'buy' });
          // Drive the mover this tick so it actually steps toward the merchant (the
          // router is not involved — same-room approach, and the tick loop does not
          // call mover.tick on its own; the intent must).
          mv.tick({ col: me.col, row: me.row, x: me.x, y: me.y });
        }
        return { sent: true, what: `approach ${target.name ?? 'merchant'} at (${target.col},${target.row})` };
      }
    }
    if (s) { s._buyInFlight = true; s._buyingActive = true; }
    import('../m59-act/buy.mjs').then(({ buy }) => {
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
    const me = ctx.session?._pose?.current?.() ?? c.self;
    if (!me) return { sent: false, why: 'no position' };
    const now3 = Date.now();
    // Collect every portal match, nearest first. A name-match is not proof
    // of an exit: watched live, Lee stood centered on the nearest one with
    // no transition. Squares that already failed get skipped (10min expiry).
    let matches = [];
    if (objects instanceof Map) {
      for (const o of objects.values()) {
        const name = c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
        if (/portal/i.test(name) && o.col != null && o.row != null) matches.push(o);
      }
    }
    if (!matches.length) return { sent: false, why: 'no portal in room' };
    const dead = (ctx.session?._deadPortals ?? []).filter(d => now3 - (d.at ?? 0) < 600000);
    if (ctx.session) ctx.session._deadPortals = dead;
    const isDead = (o) => dead.some(d => d.col === o.col && d.row === o.row);
    matches.sort((a, b) => (Math.hypot(a.col - me.col, a.row - me.row) - Math.hypot(b.col - me.col, b.row - me.row)));
    const portal = matches.find(o => !isDead(o)) ?? matches[0];
    // Standing on the chosen portal with no transition for 15s = dead portal:
    // blacklist the square so the next tick walks to the next candidate.
    if (me.col === portal.col && me.row === portal.row) {
      const key = `${portal.col},${portal.row}`;
      if (ctx.session) {
        if (ctx.session._portalStoodKey !== key) {
          ctx.session._portalStoodKey = key;
          ctx.session._portalStoodAt = now3;
        } else if (now3 - (ctx.session._portalStoodAt ?? now3) > 15000 && !isDead(portal)) {
          dead.push({ col: portal.col, row: portal.row, at: now3 });
          ctx.session._deadPortals = dead;
          ctx.session._portalStoodKey = null;
        }
      }
    } else if (ctx.session) {
      ctx.session._portalStoodKey = null;
    }
    // Walk toward the portal (one step per SEND LAW via the actuator —
    // act.step defaults to 250ms gaps (4/s) which trips speedhack detection
    // (threshold ~2/s averaged); the escape runs every tick, so gate it to
    // the 1/s law explicitly.
    // PRODUCTION GATE (not just send spacing): the Pacer spaces sends but
    // never drops, so submitting every tick (10Hz) builds an unbounded queue
    // of stale positions (watched live: 1491 deep). Submit at most 1/s; the
    // newest target supersedes, so dropped calls lose nothing.
    if (now3 - (ctx.session?._lastEscapeStep ?? 0) >= 1000) {
      if (ctx.session) ctx.session._lastEscapeStep = now3;
      // allowVoid: stepping onto a portal square is deliberate (the server
      // transitions on entry); portals may read floorless by design.
      act.step(portal.col, portal.row, { minGapMs: 1000, allowVoid: true });
    }
    const portalName = c.rsc?.get?.(portal.nameRsc) ?? portal.name ?? '?';
    const portalIdx = matches.indexOf(portal) + 1;
    return { sent: true, what: `escape: walk to portal at (${portal.col},${portal.row}) [${portalName} candidate ${portalIdx}/${matches.length} dead=${dead.length}]` };
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
  let _patrolTarget = null;     // the patrol nudge target (for 3D debug)
  let _recoveryTarget = null;   // sticky void-recovery target (cleared when grounded)
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
          if (_resting) {
            // Resting: not stuck, just not moving.
          } else if ((_fighting && !targetOutOfReach) || (mobNearby && !targetOutOfReach)) {
            // Genuinely engaged: fighting a target in reach, or a hostile mob
            // is within 4 squares. Not stuck — just holding position. A "fight"
            // frozen against a far target (or no mob nearby) is stuck-on-a-ledge,
            // so fall through and let the stuck-detector blink/walk out.
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
            // NOTE: session._roomGeo was never assigned anywhere, so this
            // always fell through to blink. Use the live world geometry.
            const geo = session?.world?.geometry ?? null;
            const dirs = [[0,-1],[0,1],[-1,0],[1,0]]; // N,S,W,E
            let escape = null;
            if (geo) {
              for (const [dc, dr] of dirs) {
                const nc = me.col + dc, nr = me.row + dr;
                const f = geo.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
                const s = geo.standable ? geo.standable(nr, nc) : undefined;
                // Valid if either says true, or no data — but never a square the
                // BSP says has no floor (a dumb server would accept the walk).
                if ((f === true || s === true || (f === undefined && s === undefined)) && isGrounded(geo, nr, nc) !== false) {
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
              // STAND BEFORE BLINK: a resting character has PFLAG_NO_MAGIC set
              // (player.kod:1166) and the server refuses the cast whole. UC_STAND ->
              // StopResting() -> ResetPlayerFlagList() clears the flag; wait 2s for
              // the server to process it before the cast begins. This is a sync context
              // (the decider's tick handler), so we can't await — send the stand packet
              // and delay the cast via the freeze window below (the loop is frozen for
              // BLINK_MS, which includes the 2s stand delay).
              try { session.pacer?.submit?.('stand', () => c.stand?.()); } catch {}
              const loop = session?._tickLoop;
              if (loop) {
                loop._frozen = true;
                const BLINK_MS = 13000;  // blink casts ~10s + 2s stand delay; hold a beat past it
                // Unfreeze when the relocation lands OR after the cast window, whichever
                // first. The moved-event path is the reliable one (the server confirms the
                // teleport); the timeout is the backstop so a failed cast can't hold the
                // character frozen for ever.
                const since = c.evSeq;
                let unfrozen = false;
                const unfreeze = () => { if (!unfrozen) { unfrozen = true; loop._frozen = false; } };
                // c.cast() is a fire-and-forget send that returns undefined, not a
                // promise. Promise.resolve() wraps it so .then() is safe. The
                // moved-event path is the reliable one (the server confirms the
                // teleport); the timeout is the backstop so a failed cast can't
                // hold the character frozen for ever.
                Promise.resolve(c.cast(blink.id, []))
                  .then(() => { try { c.waitFor?.({ since, kinds: ['moved'], timeoutMs: BLINK_MS }).then(() => unfreeze()).catch(() => unfreeze()); } catch { unfreeze(); } })
                  .catch(() => unfreeze());
                setTimeout(unfreeze, BLINK_MS);  // backstop
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
    // Expose room number and max HP for the hunt goal's Raza check.
    ws._roomNum = session?.world?.room?.num ?? client?.room?.num ?? null;
    // UNDERWORLD GROUND TRUTH (tick-owned): the shared in_underworld symbol
    // is name-rsc/id based and flaps across room changes (stale name reads
    // as Underworld in the inn, so escape and travel yank the destination
    // opposite ways every few ticks — self-inflicted rubber-banding). Room
    // NUMBER 1 is The Underworld and is the stable identity: authoritative
    // both ways.
    if (ws._roomNum != null) ws.in_underworld = ws._roomNum === 1;
    ws._maxHp = client?.vitals?.()?.health?.max ?? null;
    // Expose whether the character is moving (the router has a destination).
    // The vigor_low goal yields when the character is moving — resting would
    // stop the movement.
    ws._moving = session?._router?.dest != null;
    // Expose whether the character is at a boundary (the router is in the
    // crossing state). The vigor_low goal yields when the character is at a
    // boundary — resting would prevent the crossing.
    ws._crossing = session?._router?.lastState === 'crossing';

    // CASTER GATE (decorated here, NOT in worldstate: the loadout is a file read and
    // worldstate producers are pure by contract — see its header). A caster is a
    // character whose loadout plans SCHOOLS but no weaponcraft track
    // (plan.weapon_level == null and no weaponcraft row in the learning queue).
    // For such a build the `armed` goal is a livelock: there is no weapon to equip,
    // the broken-weapon fallthrough refuses to escalate to `buy` on an empty pack,
    // and `armed` sits above `hunt` in the ladder so travel is preempted every tick
    // (Kage, a pure Shal'ille caster, stood in Marion for an hour on exactly this).
    // Unarmed combat is legal — the threat band just halves (the game's own rule) —
    // so the safe default is `false` (NOT a caster), preserving the old behavior for
    // every character without an explicit caster loadout.
    ws.is_caster = (() => {
      try {
        const who = client?.me?.name;
        if (!who) return false;
        const l = loadoutFor(who);
        if (!l) return false;
        const plan = l.plan ?? {};
        const hasWeaponTrack = Number(plan.weapon_level) > 0
          || (Array.isArray(plan.learning_queue) && plan.learning_queue.some(
            q => String(q?.track ?? '').toLowerCase().startsWith('weaponcraft')));
        const hasSchools = Object.keys(plan.schools ?? {}).length > 0;
        return hasSchools && !hasWeaponTrack;
      } catch { return false; }
    })();

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
      const me = session._pose?.current?.() ?? client?.self;
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
        // SPIDERS: never hold one (unless specialized). A spider picked up
        // before this rule (or before the policy) is dropped here so the
        // picker below looks for anything else. Baby spiders are exempt.
        if (target) {
          const tName = client.rsc?.get?.(target.nameRsc) ?? target.name ?? '';
          if (prohibitedKind(tName, session?.policy ?? policy)) {
            _lastTargetId = null;
            target = null;
          }
        }
        // ATTACKER-SWITCH (the ONLY sanctioned switch): otherwise HOLD the
        // sticky target. Every switch resets the mover's path, so switching
        // per-hit is how 1 rat becomes 3-4: nobody ever gets finished. Switch
        // only when ALL of these hold:
        //   (1) we have NOT yet reached the current target (still traveling
        //       to it — never abandon a fight already joined),
        //   (2) a DIFFERENT in-band mob is in melee range hitting us (the game
        //       sends no "hit by X"; the mob on top of us is the attacker),
        //   (3) we have the health to take it (hp >= 50%).
        // One focused fight is safer than collecting attackers.
        if (target && ws._justDamaged && now() - retargetCheckAt > 2000) {
          retargetCheckAt = now();
          const tD2 = (target.col - me.col) ** 2 + (target.row - me.row) ** 2;
          const hpNow = client.vitals?.()?.health;
          const hpPct = hpNow && hpNow.max ? (hpNow.value / hpNow.max) * 100 : 100;
          // Threat ceiling (same formula as target selection below).
          const maxHp = client.vitals?.()?.health?.max ?? 20;
          const lvl = maxHp;
          const isArmed = ws.armed === true;
          const fullBand = policy?.threatBand ?? Math.floor(lvl / 2);
          const ceiling = lvl + (isArmed ? fullBand : Math.floor(fullBand / 2));
          // Creature names (same as the if(!target) block below).
          let cNames = new Set();
          try {
            const spawns = loadSpawns(SPAWNS_FILE);
            if (spawns?.byMonster) for (const name of Object.keys(spawns.byMonster)) {
              if (!prohibitedKind(name, session?.policy ?? policy)) cNames.add(mobNameKey(name));
            }
          } catch { /* compendium unavailable */ }
          const attacker = findAttackerSwitch({
            meCol: me.col, meRow: me.row, objects,
            currentId: _lastTargetId, blacklist: _blacklist, ceiling,
            hpPct, targetDist2: tD2, mobNames: cNames,
            nameOf: (o) => client.rsc?.get?.(o.nameRsc) ?? o.name ?? '',
          });
          if (attacker) {
            // Switch: point every layer at the attacker. The else-branch
            // below re-derives in_reach/has_target from `target`, so assign
            // it (and the ids) here rather than dropping to the picker.
            const aId = attacker.id ?? attacker.obj_id;
            target = attacker;
            if (aId != null) {
              _lastTargetId = aId;
              ws._targetId = aId;
              _currentTargetId = aId;
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
          let creatureNames = new Set();
          try {
            const spawns = loadSpawns(SPAWNS_FILE);
            if (spawns?.byMonster) {
              for (const name of Object.keys(spawns.byMonster)) {
                if (!prohibitedKind(name, session?.policy ?? policy)) creatureNames.add(mobNameKey(name));
              }
            }
          } catch { /* compendium unavailable */ }

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
            // Resolve the name from nameRsc (token-set key: 'baby spider' == 'SpiderBaby').
            const objName = mobNameKey(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
            // A mob is either: flagged as a player with
            // can_attack (enriched object), OR its name
            // exactly matches a compendium creature.
            // Exact match only: "baby spider" != "spider".
            const isMob = (o.is_player && o.can_attack)
              || (creatureNames.size > 0 && creatureNames.has(objName));
            if (!isMob) continue;
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
          const needPathCheck = true;
          if (needPathCheck) {
            // Rank candidates by traversal distance (path length), not Euclidean.
            // Bound the A* to the nearest 8 by Euclidean to limit cost.
            const toCheck = candidates.slice(0, 8);
            for (const { o, d2 } of toCheck) {
              if (o.id != null && _blacklist.has(o.id)) continue;
              const plen = pathLen(o);
              // plen === Infinity means unreachable (no fine path). Skip it.
              // plen === null means no geometry (fallback to Euclidean).
              if (plen === Infinity) continue;
              const rank = plen ?? d2;  // use path length if available, else Euclidean
              if (rank < bestD2) { bestD2 = rank; best = o; }
            }
            // Fallback: if no candidate had a valid path length (all unreachable
            // or no geometry), pick the nearest by Euclidean as before.
            if (!best) {
              for (const { o, d2 } of candidates) {
                if (o.id != null && _blacklist.has(o.id)) continue;
                if (d2 < bestD2) { bestD2 = d2; best = o; }
              }
            }
          } else {
            // Throttled: keep the previous target if it's still valid, else nearest by Euclidean.
            for (const { o, d2 } of candidates) {
              if (o.id != null && _blacklist.has(o.id)) continue;
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
            // Level: TRUE kod level first, HP proxy only as fallback.
            let targetLevel = knownLevel(client.rsc?.get?.(best.nameRsc) ?? best.name ?? '', mobNameKey)
              ?? best.max_health ?? best.health ?? null;
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
            ws._targetD2 = bestD2;
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
          ws._targetD2 = d2;
          ws.has_target = true;
          const tLevel = knownLevel(client.rsc?.get?.(target.nameRsc) ?? target.name ?? '', mobNameKey)
            ?? target.max_health ?? target.health ?? null;
          ws.target_in_band = tLevel == null ? true : tLevel <= (ws._threatCeiling ?? Infinity);
        }
      }
    }

    // DANGER-CLOSE: a hostile in melee range that must make us leave, even
    // though it is NOT our target (spiders are unselectable by policy, and an
    // out-of-band mob near us is danger whether or not we chose it). Without
    // this, an unselectable attacker chews us while every has_target-gated
    // goal (fight, flee) sees nothing. Nearest dangerous mob or null.
    ws._dangerClose = null;
    const dObjs = client?.room?.objects;
    const dMe = session._pose?.current?.() ?? client?.self;
    if (dObjs instanceof Map && dMe?.col != null) {
      try {
        const maxHp = client.vitals?.()?.health?.max ?? 20;
        const lvl = maxHp;
        const isArmed = ws.armed === true;
        const fullBand = policy?.threatBand ?? Math.floor(lvl / 2);
        const ceiling = lvl + (isArmed ? fullBand : Math.floor(fullBand / 2));
        let allNames = new Set();
        try {
          const spawns = loadSpawns(SPAWNS_FILE);
          if (spawns?.byMonster) for (const name of Object.keys(spawns.byMonster)) allNames.add(mobNameKey(name));
        } catch { /* compendium unavailable */ }
        const danger = findDangerClose({
          meCol: dMe.col, meRow: dMe.row, objects: dObjs, ceiling,
          allowSpiders: (session?.policy ?? policy)?.huntSpiders === true,
          allowCentipedes: (session?.policy ?? policy)?.huntCentipedes === true,
          mobNames: allNames,
          nameOf: (o) => client.rsc?.get?.(o.nameRsc) ?? o.name ?? '',
        });
        if (danger) ws._dangerClose = { id: danger.id ?? danger.obj_id ?? null, col: danger.col, row: danger.row };
      } catch { ws._dangerClose = null; }
    }

    // MOB-NEAR (unfiltered): any hostile-ish within melee+1, for the
    // stand-under-fire rule below. Unlike target selection this includes
    // spiders and ignores band — it answers WHO IS HERE, not whom to fight.
    ws._mobNear = null;
    {
      const dObjs = client?.room?.objects;
      const dMe = session._pose?.current?.() ?? client?.self;
      if (dObjs instanceof Map && dMe?.col != null) {
        try {
          let allNames = new Set();
          try {
            const spawns = loadSpawns(SPAWNS_FILE);
            if (spawns?.byMonster) for (const name of Object.keys(spawns.byMonster)) allNames.add(mobNameKey(name));
          } catch { /* compendium unavailable */ }
          ws._mobNear = anyMobNear({
            meCol: dMe.col, meRow: dMe.row, objects: dObjs, maxD2: 10,
            mobNames: allNames,
            nameOf: (o) => client.rsc?.get?.(o.nameRsc) ?? o.name ?? '',
          });
        } catch { ws._mobNear = null; }
      }
    }

    ws._traveling = (session._router?.dest ?? null) != null;
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
    if (_wasResting && !_resting && active && (active.goal === 'hunt' || active.goal === 'flee_danger' || active.goal === 'flee_hurt' || active.goal === 'travel' || active.goal === '_fight' || active.goal === 'armed' || active.goal === '!in_underworld' || active.goal === 'unstuck' || active.goal === 'leave_raza')) {
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
      // STAND UNDER FIRE: never sit down while taking damage with a hostile
      // near — sitting through a mauling is how characters rest to death.
      // Stand (fight/flee engage on following ticks); sit only when safe.
      if (ws._justDamaged && ws._mobNear) {
        act.stand?.();
        onDecision?.({ ticks, goal: 'healthy', action: 'stand',
          sent: true, what: 'taking damage with a hostile near — standing, not sitting' });
        return;
      }
      const hp = client.vitals?.()?.health?.value ?? 0;
      const maxHp = client.vitals?.()?.health?.max ?? 20;
      const now2 = now();
      if (hp < maxHp && now2 - _hpPokeAt > 30000) {
        _hpPokeAt = now2;
        const me = session._pose?.current?.() ?? client.self;
        if (me && me.col != null) {
          // Find the nearest walkable neighbor to step to (N, S, E, W).
          const geo = session.world?.geometry;
          const canStep = (r, c) => {
            const f = geo?.fineWalkable ? geo.fineWalkable(r, c) : undefined;
            const w = geo?.walkable ? geo.walkable(r, c) : undefined;
            if (f === false) return false;
            if (f === undefined && w === false) return false;
            if (isGrounded(geo, r, c) === false) return false; // never poke into a void
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

    // 2a2. VIGOR LOW: rest to recover vigor. The character
    // can't fight effectively below vigor 20. Resting
    // recovers vigor over time (faster at an inn).
    if (active?.goal === 'vigor_low') {
      // STAND UNDER FIRE (same rule as healthy above).
      if (ws._justDamaged && ws._mobNear) {
        act.stand?.();
        onDecision?.({ ticks, goal: 'vigor_low', action: 'stand',
          sent: true, what: 'taking damage with a hostile near — standing, not sitting' });
        return;
      }
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
            const exit = exits[0]; // nearest exit
            if (router.dest !== exit.to) {
              router.to(exit.to);
              onDecision?.({ ticks, goal: 'flee_danger', action: 'travel',
                what: `flee to room ${exit.to} via ${exit.direction}`, sent: true });
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
            const exit = exits[0];
            if (router.dest !== exit.to) {
              router.to(exit.to);
              onDecision?.({ ticks, goal: 'flee_hurt', action: 'travel',
                what: `flee (hurt) to room ${exit.to} via ${exit.direction}`, sent: true });
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
          // RE-LOOT LATER: corpse drops often appear AFTER lootFloor's
          // room-contents snapshot, so one pass misses them. Schedule a
          // second pass; same-room gated below.
          session._relootAt = now + 8000;
          session._relootRoom = frame?.room?.num ?? frame?.room?.id ?? null;
          session.lootFloor?.({ maxItems: 12 }).then(res => {
            const taken = res?.taken?.length ?? 0;
            if (taken) console.error(`[tick] ${agentName} looted ${taken} item(s) after kill`);
            // Refusals are the diagnosable half (why drops stay on the floor).
            const refused = res?.refused ?? [];
            if (refused.length) console.error(`[tick] ${agentName} loot refused: ${refused.slice(0, 4).map(r => `${r.name ?? r.id} (${r.why ?? '?'})`).join('; ')}${refused.length > 4 ? ` +${refused.length - 4} more` : ''}`);
          }).catch(e => console.error(`[tick] ${agentName} loot err: ${e.message}`));
        }
      }
      // RE-LOOT DUE: second pass for late-appearing drops. Staying put (no
      // legacy-walk hijack of the tick mover) and same-room only.
      if (session._relootAt && now() >= session._relootAt) {
        const roomNow = frame?.room?.num ?? frame?.room?.id ?? null;
        session._relootAt = 0;
        if (roomNow != null && roomNow === session._relootRoom) {
          session._lastLootAt = Date.now();
          const agentName = session.name;
          session.lootFloor?.({ maxItems: 12, stayPut: true }).then(res => {
            const taken = res?.taken?.length ?? 0;
            if (taken) console.error(`[tick] ${agentName} re-looted ${taken} item(s) (late drops)`);
          }).catch(() => {});
        }
      }
      return;
    }

    // 2c2. LEAVE RAZA: route to the Grand Museum (1018) where the
    // portal out is. The portal is one-way: step on it twice and
    // you're out. This goal just sets the router's destination; the
    // operator (or a future intent) steps on the portal.
    if (active?.goal === 'leave_raza') {
      const router = session._router;
      if (router) {
        // If the character is already in the Grand Museum (1018), walk to
        // the portal (col 11, row 2) and hold. The portal is a floor tile
        // that triggers a teleport when stepped on. The location is from
        // the go action's exit list (kind: 'portal', col: 11, row: 2).
        // TODO: query dynamically from session.world.exits() once the
        // cache is reliable.
        const roomNum = session?.world?.room?.num;
        if (roomNum === 1018) {
          const pc = 11, pr = 2; // portal location (from go action exit list)
          const c = session.client;
          const me = session._pose?.current?.() ?? c?.self;
          const atPortal = me && Math.abs(me.col - pc) <= 1 && Math.abs(me.row - pr) <= 1;
          if (!atPortal) {
            // Route to the portal.
            act.walk?.(pc, pr) ?? c?.moveToSquare?.(pc, pr, 18);
            onDecision?.({ ticks, goal: 'leave_raza', action: 'travel',
              what: `walking to the portal (${pc}, ${pr})`, sent: true });
            return;
          }
          // At the portal — hold and wait for the teleport to trigger.
          onDecision?.({ ticks, goal: 'leave_raza', action: null,
            what: `at the portal (${pc}, ${pr}) — waiting for the teleport`, sent: false });
          return;
        }
        if (router.dest !== 1018) {
          router.to(1018);
          onDecision?.({ ticks, goal: 'leave_raza', action: 'travel',
            what: 'route to the Grand Museum (1018) for the portal out', sent: true });
          return;
        }
        const r = routeIntent(router)(frame, act);
        onDecision?.({ ticks, goal: 'leave_raza', action: 'travel',
          what: r.what ?? r.why, sent: r.sent });
        return;
      }
      onDecision?.({ ticks, goal: 'leave_raza', action: null, why: 'no router' });
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
        // bounce between 1012 (smith) and 1016 (Mausoleum) without buying. Resume the
        // smith route instead (the destination was cleared by arrival/oscillation
        // handling, not by choice). Cleared on success: armed=true clears
        // _buyingRoute. NOTE the old check compared the flag to router.dest,
        // which is always null inside this guard — dead code that never held.
        if (session._buyingRoute != null) {
          router.to(session._buyingRoute);
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
          // ASSIGNED ROOM (session.policy.assignedRoom — makeDecider's
          // closure policy is {} in production; the keeper puts the fleet
          // policy on session.policy): when set, it IS the destination and
          // nearestHuntRoom is only the fallback. The assigned room must
          // still qualify — same in-band candidate list (band + spider
          // exclusions) and a real route — otherwise fall back with a
          // message instead of marching somewhere unsurvivable or
          // unreachable.
          const pol = session?.policy ?? policy;
          let hunt = null;
          const assigned = Number(pol?.assignedRoom);
          if (Number.isFinite(assigned)) {
            const cands = huntRoomsAtOrBelow(level, ceiling);
            const match = cands.find(c => Number(c.room) === assigned);
            if (match && Number(resolved) === assigned) {
              hunt = { ...match, hops: 0, path: [] };
            } else if (match) {
              try {
                const r = findPath(map, resolved, match.room, { danger: false });
                if (r?.found) hunt = { ...match, hops: r.hops.length, path: r.hops.map(h => h.to) };
                else onDecision?.({ ticks, goal: 'hunt', action: null,
                  what: `assigned room ${assigned} unreachable; falling back to nearest`, sent: false });
              } catch { /* fall through to nearest below */ }
            } else {
              onDecision?.({ ticks, goal: 'hunt', action: null,
                what: `assigned room ${assigned} has nothing in band (ceiling ${ceiling}); falling back to nearest`, sent: false });
            }
          }
          if (!hunt) hunt = nearestHuntRoom(resolved, ceiling);
          // MAX LEVEL DELTA: the mob's level should not be more than 12 above
          // the character's level. This matches the original ceiling formula
          // (level + floor(level/2)): for a lv24 character, the ceiling is
          // 24 + 12 = 36, so a lv35 mob is in band (35 ≤ 36). The max delta
          // of 12 allows the character to hunt mobs up to 12 levels above
          // their own, which is the game's own rule.
          const MAX_LEVEL_DELTA = 12;
          if (hunt && hunt.level > level + MAX_LEVEL_DELTA) {
            onDecision?.({ ticks, goal: 'hunt', action: null,
              what: `hunt ${hunt.creature} lv${hunt.level} is too far above level ${level} (max delta ${MAX_LEVEL_DELTA}); not entering`, sent: false });
            return;
          }
          if (hunt && hunt.room !== resolved) {
            // YIELD when the router's destination is set and it's not the
            // hunt room. The hunt goal only sets the dest to the hunt room,
            // so if the dest is different, it was set by the travel command.
            const router = session?._router;
            if (router?.dest != null && router.dest !== hunt.room) {
              onDecision?.({ ticks, goal: 'hunt', action: null,
                what: `yielding to travel (dest=${router.dest}, not routing to hunt room ${hunt.room})`, sent: false });
              return;
            }
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
          // PATROL: if the character has been standing still for a while
          // (no movement for 30+ ticks = 3 seconds), nudge him a few squares
          // in a random direction to break the stuck state and increase the
          // chance of a target spawning.
          if (hunt && hunt.room === resolved) {
            // YIELD when the router's destination is set and it's not the
            // current room. The hunt goal only sets the dest to the hunt
            // room (which is the current room), so if the dest is different,
            // it was set by the travel command.
            const router = session?._router;
            if (router?.dest != null && router.dest !== resolved) {
              onDecision?.({ ticks, goal: 'hunt', action: null,
                what: `in hunt room, yielding to travel (dest=${router.dest})`, sent: false });
              return;
            }
            const me = session._pose?.current?.() ?? client?.self;
            const now = Date.now();
            // PATROL: nudge every 5 seconds (or on the first tick if
            // _lastHuntNudge is unset). Drive the tick Mover DIRECTLY with
            // a fine-validated target — never the legacy walkTo, whose raw
            // fallback walks through walls (that is how characters end up
            // inside them). The router is idle in-room, so the mover is ours.
            const mv = session?._mover;
            const pos = me ? { col: me.col, row: me.row, x: me.x, y: me.y } : undefined;
            const geoAll = session?.world?.geometry;
            // VOID RECOVERY (sticky): the server accepts any declared position,
            // so the character can end up on a square with no BSP floor. Random
            // patrol nudges would re-target every 5s and reset the mover's
            // escape each time. Instead, commit to ONE grounded target until the
            // server position is grounded again. Uses server truth (not the sim).
            const srv = session?._pose?.server ?? me;
            const meVoid = !!(srv && srv.col != null && isGrounded(geoAll, srv.row, srv.col) === false);
            if (meVoid) {
              const recOk = _recoveryTarget && isGrounded(geoAll, _recoveryTarget.row, _recoveryTarget.col) === true;
              if (!recOk) {
                _recoveryTarget = nearestGrounded(geoAll, srv.col, srv.row, { maxRadius: 40 });
                if (_recoveryTarget) _patrolTarget = { ..._recoveryTarget };
              }
              if (_recoveryTarget && mv) {
                if (!mv.active || mv.dest?.col !== _recoveryTarget.col || mv.dest?.row !== _recoveryTarget.row) {
                  mv.to(_recoveryTarget.col, _recoveryTarget.row, { by: 'recovery' });
                }
                const mr = mv.tick(pos);
                onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                  what: `void recovery (mover ${mr.state} to ${_recoveryTarget.col},${_recoveryTarget.row})`,
                  sent: mr.state === 'moving' || mr.state === 'raw-move' || mr.state === 'crossing' });
                return;
              }
              // No grounded square in radius: hold still rather than wander
              // deeper into the void; the mover's fan/blink owns the escape.
              onDecision?.({ ticks, goal: 'hunt', action: null,
                what: 'in void with no grounded target in radius; holding', sent: false });
              return;
            }
            _recoveryTarget = null; // grounded again: resume normal patrol
            if (me && mv && (session._lastHuntNudge == null || now - session._lastHuntNudge > 5000)) {
              // Nudge: a few squares in a random direction, retried until
              // the TARGET square is fine-walkable (the mover validates
              // each step, but starting toward a wall square is pointless).
              const geo = session?.world?.geometry;
              let nc = null, nr = null;
              for (let tries = 0; tries < 6; tries++) {
                const dx = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
                const dy = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
                const tc = Math.max(1, Math.min(20, me.col + dx));
                const tr = Math.max(1, Math.min(15, me.row + dy));
                const f = geo?.fineWalkable ? geo.fineWalkable(tr, tc) : undefined;
                // Never patrol into a void: require BSP ground when the geometry
                // can answer (a dumb server accepts any declared position).
                if (f !== false && isGrounded(geo, tr, tc) !== false) { nc = tc; nr = tr; break; }
              }
              if (nc != null) {
                _patrolTarget = { col: nc, row: nr };
                mv.to(nc, nr, { by: 'patrol' });
                const mr = mv.tick(pos);
                session._lastHuntNudge = now;
                onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                  what: `patrolling hunt room (mover ${mr.state} to ${nc},${nr})`, sent: true });
                return;
              }
              // No walkable nudge found: wait for a target without moving.
            }
            // Keep driving an active patrol nudge every tick (one mover.tick
            // per nudge is not enough — the mover needs all 10 ticks/s).
            // Only when the mover's destination is ours (another driver such
            // as combat may own it; driving the tick is still correct, but
            // don't claim its destination in the log).
            if (mv?.active && me) {
              const preDest = mv.dest ? { col: mv.dest.col, row: mv.dest.row } : null;
              const mr = mv.tick(pos);
              const ours = _patrolTarget && preDest?.col === _patrolTarget.col && preDest?.row === _patrolTarget.row;
              onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                what: ours ? `patrolling hunt room (mover ${mr.state} -> ${_patrolTarget?.col},${_patrolTarget?.row})`
                            : `keeping mover ticking (dest ${preDest?.col},${preDest?.row} owned elsewhere)`,
                sent: mr.state === 'moving' || mr.state === 'raw-move' || mr.state === 'crossing' });
              return;
            }
            if (me && (session._lastHuntNudge == null || now - session._lastHuntNudge > 5000)) {
              // No tick mover (shouldn't happen): legacy fallback. Still never
              // nudge into a void the geometry can see.
              const dx = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
              const dy = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
              const nc = Math.max(1, Math.min(20, me.col + dx));
              const nr = Math.max(1, Math.min(15, me.row + dy));
              const geoFb = session?.world?.geometry;
              if (isGrounded(geoFb, nr, nc) === false) {
                onDecision?.({ ticks, goal: 'hunt', action: null,
                  what: `patrol nudge (${nc},${nr}) has no floor; waiting`, sent: false });
                return;
              }
              _patrolTarget = { col: nc, row: nr };
              act.walk?.(nc, nr) ?? client?.moveToSquare?.(nc, nr, 18);
              session._lastHuntNudge = now;
              onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                what: `patrolling hunt room (nudge to ${nc},${nr})`, sent: true });
              return;
            }
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
    // BROKEN/EMPTY-PACK FALLTHROUGH. If the plan is `equip` but there is
    // nothing wieldable — the only weapon is broken (pickWeapon finds one,
    // but pickWieldableWeapon, which excludes the broken set, returns null)
    // or the pack holds no weapon at all — `equip` would refuse every tick
    // (the shattered-mace loop) and `armed` would preempt travel forever.
    // Swap to `buy`: the buy intent routes to the smith from anywhere and
    // purchases there. Gated on buyWeapons so a character that must never
    // shop keeps the refusal. (Casters never reach here: the `armed` goal
    // doesn't fire for them.) Policy lives on session.policy (see hunt).
    if (active.goal === 'armed' && first === 'equip'
        && !pickWieldableWeapon(client, session)
        && (session?.policy ?? policy)?.buyWeapons !== false) {
      // CONJURE FIRST: a free conjured weapon beats a shopping trip. If the
      // character knows `create weapon` and hasn't tried recently, cast it;
      // the created weapon lands in the pack and equip picks it up next pass.
      // Cooldown so a slow conjuration doesn't cast every tick.
      const now5 = now();
      const canConjure = knownSpells(client).some(sp =>
        String(client.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '').toLowerCase() === 'create weapon');
      if (canConjure && now5 - (session?._lastCreateWeaponAt ?? 0) > 30000) {
        if (session) session._lastCreateWeaponAt = now5;
        actionName = 'cast create weapon';
      } else {
        actionName = 'buy';
      }
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
                          targetId: _currentTargetId,
                          patrolTarget: _patrolTarget });
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
  { goal: 'flee_danger', when: ws => (ws.has_target === true && ws.target_in_band === false && ws.in_reach === true) || ws._dangerClose != null },
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
      // YIELD when the character is moving (the router has a destination).
      // Resting would stop the movement. The character can rest when he
      // arrives (the router clears the destination).
      if (ws._moving) return false;
      // YIELD when the character is at a boundary (the router is in the
      // crossing state). Resting would prevent the crossing.
      if (ws._crossing) return false;
      return v != null && v < 60 && ws.in_reach !== true;
    } },
  // LEAVE RAZA: in the newbie zone at level >= 25, route to the Grand
  // Museum (1018) where the portal out is. This takes priority over
  // _fight: Raza generates only level-25 mummies; from 25 onward the
  // entire zone pays nothing. The character should leave, not fight.
  { goal: 'leave_raza', when: ws => {
      const roomNum = ws._roomNum;
      if (roomNum == null) return false;
      if (roomNum < 1011 || roomNum > 1018) return false;
      const maxHp = ws._maxHp;
      return maxHp != null && maxHp >= 25;
    } },
  { goal: '_fight',   when: ws => ws.has_target === true && ws.target_in_band === true
                                 && ws.critical !== true
                                 && (ws.hurt === true || ws.vigor_floor !== false)
                                 // Don't fight if the target is on a
                                 // different elevation (unreachable).
                                 && ws._targetElevated !== true
                                 && fightEnvelopeOk({ traveling: ws._traveling, targetD2: ws._targetD2 }) },
  { goal: 'armed',    when: ws => ws.armed === false && ws.is_caster !== true },
  // HUNT before eating: the character should go find work (a mob to fight)
  // rather than sitting in town eating. Vigor management matters during
  // combat, not while idle. If vigor is truly too low to fight, the
  // _fight goal's vigor_floor check prevents engagement, and vigor_low
  // (above) handles resting. Eating while idle just delays the hunt.
  // DO NOT HUNT WHEN THE CHARACTER IS IN THE RAZA CLUSTER AT LEVEL >= 25.
  // Raza generates only level-25 mummies; from 25 onward the entire
  // newbie zone pays nothing. The character should leave, not hunt.
  { goal: 'hunt',     when: ws => {
      const roomNum = ws._roomNum;
      if (roomNum != null && roomNum >= 1011 && roomNum <= 1018) {
        const maxHp = ws._maxHp;
        if (maxHp != null && maxHp >= 25) return false;
      }
      return ws.has_target === false || ws.target_in_band === false;
    } },
  { goal: 'vigor_ok', when: ws => ws.vigor_ok === false && ws.has_food === true
                                 && ws.has_target !== true },
  { goal: 'has_food', when: ws => ws.has_food === false && ws.has_reagents === true },
];
