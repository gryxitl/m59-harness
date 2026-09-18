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
import { knownSpells, spellNamed } from '../m59-act/cast.mjs';
import { affordances } from '../m59-parse.mjs';
import { knownLevel } from './m59-levels.mjs';
import '../m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry
import { trustedBuyer } from '../m59-skills.mjs';

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
    // Only condemn on RECENT broken events (within 60s). The event ring is a
    // ring buffer — old "it's broken" events from previous sessions keep
    // condemning the mace forever. A mace that broke 5 minutes ago is not
    // the same mace the character is trying to equip now.
    if (ev.at && Date.now() - ev.at > 60000) continue;
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
  if (!broken.has(best.id) && !held.has(best.id)) return best;
  // Best is broken: find the next-best that isn't.
  const candidates = inv
    .filter(o => o?.id != null && !held.has(o.id) && !broken.has(o.id)
      && WEAPON.test(String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '')));
  return candidates.sort((a, b) => String(client.rsc?.get?.(b.nameRsc) ?? b.name ?? '').localeCompare(String(client.rsc?.get?.(a.nameRsc) ?? a.name ?? '')))[0] ?? null;
}
import { nearestHuntRoom, huntRoomsAtOrBelow } from '../m59-hunt-room.mjs';
import { loadSpawns, characterBand } from '../m59-spawns.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPAWNS_FILE = join(__dirname, '..', '..', 'compendium', 'data', 'spawns.json');
// RSC -> ROOM NUMBER (stable across saves and boundary straddles, unlike
// object ids). Built once; resolves the room number when world/client have
// not caught up yet (the post-transition ticks where in_underworld flapped).
let _rscRoomTable = null;
function roomNumByRsc(rsc) {
  if (rsc == null) return null;
  try {
    if (!_rscRoomTable) {
      _rscRoomTable = new Map();
      const map = loadMap();
      for (const r of Object.values(map?.rooms ?? {})) {
        if (r?.roomRsc != null) _rscRoomTable.set(r.roomRsc, r.num);
        if (r?.nameRsc != null) _rscRoomTable.set(r.nameRsc, r.num);
      }
    }
    return _rscRoomTable.get(rsc) ?? null;
  } catch { return null; }
}
// TOWN -> SMITH SHOP. Buy routes here when the current room has no weapon
// seller (pure — unit tested via TOWN_SMITH). Marion's Colhorr is in 201
// (Ye Olde Slasher Salesman), reached by the go-door at (43,31) — the
// buy-affordance object at (37,80) in Marion opens no shop list.
export const TOWN_SMITH = { 200: 201, 202: 201, 50: 374, 1011: 1013, 1012: 1013 };
// SMITH CANDIDATES: weapon-selling rooms from the merchant catalogue,
// excluding special cases:
//   - Ko'catan (2003, 2101, 2100, 2014, 2002): requires dispel illusion to enter
//   - Hazar (1003, 1013): one-way trip, unreachable after leaving Raza
//   - Izzio (593): wanders, inconsistent stock
// Falls back to TOWN_SMITH values if the catalogue is unavailable.
const _SMITH_EXCLUDE = new Set([593, 1003, 1013, 2002, 2003, 2014, 2100, 2101]);
function _loadSmithCandidates() {
  try {
    const cat = JSON.parse(readFileSync(join(__dirname, '..', '..', 'substrate', 'm59-merchants.json'), 'utf8'));
    const weaponRe = /sword|mace|axe|staff|dagger|bow|crossbow/i;
    const rooms = new Set();
    for (const m of (cat.merchants ?? [])) {
      if (m.room == null || m.wanders) continue;
      if (_SMITH_EXCLUDE.has(m.room)) continue;
      if ((m.sells ?? []).some(s => weaponRe.test(s.cls ?? ''))) rooms.add(m.room);
    }
    if (rooms.size) return [...rooms];
    console.error(`[decide] _loadSmithCandidates: catalogue loaded but no weapon sellers found`);
  } catch (e) {
    console.error(`[decide] _loadSmithCandidates failed: ${e.message}`);
  }
  return [...new Set(Object.values(TOWN_SMITH))];
}
const SMITH_CANDIDATES = _loadSmithCandidates();
const RAZA_CLUSTER = new Set([1011, 1012, 1013]);
// Pick the nearest smith by findPath hop count from the current room.
// Memoized on the session: recomputed only when the room changes or
// _smithUnreachableUntil expires. findPath is not free (6.4s for an
// unreachable pair), so per-tick recomputation is not an option.
function nearestSmith(session, fromRoom, map) {
  const key = `${fromRoom}`;
  const cached = session?._smithDest;
  if (cached && cached.room === key && Date.now() - (cached.at ?? 0) < 300000) return cached.dest;
  const candidates = SMITH_CANDIDATES.filter(r => r !== 1013 || RAZA_CLUSTER.has(fromRoom));
  let best = null, bestHops = Infinity;
  for (const r of candidates) {
    const res = findPath(map, fromRoom, r);
    if (res.found && res.hops.length < bestHops) { bestHops = res.hops.length; best = r; }
  }
  if (session) session._smithDest = { room: key, dest: best, at: Date.now() };
  return best;
}
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

// Target level: TRUE kod level only. No HP proxy — a wounded mob's
// live HP reading is not its level, and using it flips
// target_in_band mid-fight as the mob loses HP.
export function targetLevelOf(obj, nameOf) {
  const name = nameOf ? nameOf(obj) : (obj.name ?? '');
  return knownLevel(name, mobNameKey) ?? null;
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
// Computed from _targetLevel and _threatCeiling (not ws.target_in_band, which
// the GOAP keeper overwrites). Returns null when either is unknown.
function targetInBand(ws) {
  if (ws?._targetLevel == null || ws?._threatCeiling == null) return null;
  return ws._targetLevel <= ws._threatCeiling;
}
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
    const aLevel = targetLevelOf(o, nameOf);
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
                                     ceiling, hpPct, targetDist2, mobNames, nameOf, allowPlayers = false }) {  if (targetDist2 <= 4) return null;   // already joined: finish it
  if (hpPct < 50) return null;         // too hurt to collect a second fight
  const meleeD2 = 5;                   // MELEE_REACH=2, squared=4, small margin
  let attacker = null, attackerD2 = Infinity;
  for (const o of (objects?.values?.() ?? [])) {
    if (o.is_self) continue;
    if (o.col == null || o.row == null) continue;
    const oId = o.id ?? o.obj_id;
    if (oId != null && (oId === currentId || blacklist?.has(oId))) continue;
    const objName = mobNameKey(nameOf ? nameOf(o) : (o.name ?? ''));
    // Players only when explicitly allowed (defendAgainstPlayers policy).
    // Presence/danger still see them (stand/flee), but we never TARGET them.
    const isMob = (allowPlayers && o.is_player && o.can_attack) || (mobNames?.size > 0 && mobNames.has(objName));
    if (!isMob) continue;
    const d2 = (o.col - meCol) ** 2 + (o.row - meRow) ** 2;
    if (d2 > meleeD2) continue;
    const aLevel = targetLevelOf(o, nameOf);
    if (aLevel != null && aLevel > ceiling) continue; // out of band: don't collect it
    if (d2 < attackerD2) { attackerD2 = d2; attacker = o; }
  }
  return attacker;
}
import { loadMap, findPath, hazardReason } from '../m59-map.mjs';
import { tickEdgeExits } from './m59-exits.mjs';
import { loadoutFor } from '../m59-loadout.mjs';
import { resolveRoomNum, routeIntent } from './m59-route.mjs';
import { isGrounded, nearestGrounded } from './m59-ground.mjs';
import { restSpotFor, noteResting, noteStoppedResting, noteRoomChanged } from './m59-rest-spot.mjs';
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
    // Clear any stale smith route: the character has a weapon, so the buy
    // journey is over. A persisted router dest from a previous session pins
    // the character on a far room (observed: 10-hop route to room 201 when
    // room 113 was 4 hops away).
    if (item && ctx.session?._buyingRoute != null) {
      ctx.session._buyingRoute = null;
      ctx.session._smithDest = null;
      if (ctx.session?._router?.dest != null && SMITH_CANDIDATES.includes(ctx.session._router.dest)) {
        ctx.session._router.clear();
      }
    }
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
    // CONFIRMATION: if a previous use() was sent and the 2s confirm window
    // has passed, check if the server put the item in the using list. If
    // not, the equip failed silently — increment the per-id counter.
    // Do NOT mark the item broken on silent refusal: the server may be slow,
    // or the item id may not match the server's inventory (stale cache).
    // Only explicit "it's broken" events (scanBrokenFromEvents) condemn an item.
    if (s?._equipConfirmAt && Date.now() >= s._equipConfirmAt) {
      const confirmId = s._equipConfirmId;
      s._equipConfirmAt = null;
      s._equipConfirmId = null;
      const equipped = ctx.client.equipment?.()?.equipped ?? [];
      const confirmed = equipped.some(o => o.id === confirmId);
      if (confirmed && confirmId != null) {
        const rec = atts[confirmId];
        if (rec) rec.n = 0;
      } else if (!confirmed && confirmId != null) {
        const rec = atts[confirmId] ?? { n: 0, at: Date.now() };
        rec.n++;
        rec.at = Date.now();
        atts[confirmId] = rec;
      }
    }
    // INFLIGHT GUARD: if a confirm is outstanding for this id, don't send
    // another use — one send per round trip. The confirm resolves in 2s.
    if (s?._equipConfirmId === item.id && s?._equipConfirmAt && Date.now() < s._equipConfirmAt) {
      return { sent: false, why: 'equip inflight (confirm outstanding)' };
    }
    const rec = atts[item.id] ?? { n: 0 };
    const now8 = Date.now();
    if (now8 - (rec.at ?? 0) < 1000) {
      return { sent: false, why: 'equip coalesced (1/s)' };
    }
    if (!(ctx.session?._resting ?? false)) {
      if (rec.n === 0) rec.firstAt = now8;
      rec.n++;
    }
    rec.at = now8;
    atts[item.id] = rec;
    const useResult = act.use(item.id);
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
  // THE PARAMETER IS `frame`, NOT `f`. Every intent in INTENTS takes `frame` and
  // intend() calls them as `fn(frame, act, ctx)`; `buy` alone named its first
  // parameter `f` while its body called `routeIntent(s._router)(frame, act)` in
  // three places. `frame` is not in scope there, so every tick that reached a
  // merchant threw `ReferenceError: frame is not defined` out of decide() —
  // which the tick loop counted as a tick error and skipped the rest of the
  // tick, including movement. On t4 that was 2,361 of 2,461 ticks: the
  // character was not lost, it was crashing on its way to the shop.
  buy: (frame, act, ctx) => {
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
        const roomNum = c.room?.num ?? s?.world?.room?.num;
        // The "stale smith route" check at the top of decide() handles
        // the case where the nearest smith has changed — it re-routes
        // without clearing the oscillation counters.
        const dest = nearestSmith(s, roomNum, s?._map ?? loadMap());
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
          // If the current dest is a smith room (stale candidate), re-route
          // to the new nearest smith. Otherwise (hunt/explicit travel): yield.
          if (SMITH_CANDIDATES.includes(curDest)) {
            s._router.to(dest);
            return { sent: true, what: `travel to the smith (room ${dest}) — re-routed from ${curDest}` };
          }
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
    // in either, route to the town smith where the smith sells weapons.
    // Same if a cached list has no weapon.
    const roomNum = c.room?.num ?? s?.world?.room?.num;
    // Ignore a shop list cached in another room (see buy.mjs stale-list guard).
    const buyList = (c.buyList?.room == null || c.buyList.room === roomNum) ? c.buyList : null;
    const listHasWeapon = buyList?.items?.length
      ? buyList.items.some(i => /mace|sword|axe|club|hammer|dagger|staff|spear|blade|knife/i.test(String(c.rsc?.get?.(i.nameRsc) ?? i.name ?? '')))
      : null;  // null = list not cached yet
    // Route to the town smith when the current room sells no weapons: known
    // towns (unless already at the smith shop), or anywhere whose cached
    // list has no weapon. Destination falls back to Raza off the map towns.
    const smithHere = TOWN_SMITH[roomNum];
    const atSmith = SMITH_CANDIDATES.includes(roomNum);
    if (!atSmith && ((smithHere != null && listHasWeapon !== true) || listHasWeapon === false)) {
      // Inn or field (no weapons here) or a cached list with no weapon: go to the smith.
      if (s?._router) {
        const dest = nearestSmith(s, roomNum, s?._map ?? loadMap());
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
    // BROKE CHECK: gate on the observation (s._brokeUntil), not the inference
    // (absent shilling stack). The server sends nothing for an unaffordable
    // buy (silent refuse). A no-reply on a weapon buy means broke. The
    // _brokeUntil flag is stamped in the buy .then() when the result is
    // "no reply" or "cannot afford". This is evidence, not inference.
    if (Date.now() < (s?._brokeUntil ?? 0) && s?._router) {
      // NO-REAGENT GATE: if the character has nothing to sell, skip the
      // buyer route — let the hunt goal send them to fight baby spiders
      // for loot. A broke character with an empty pack cannot sell, so
      // routing to a buyer is a dead loop. Clear the broke flag so the
      // hunt goal can route them to a hunt room.
      const _hasReagents = (c.inventory ?? []).some(o =>
        /herb|mushroom|elderberry|root|leaf|seed/i.test(
          String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '')));
      if (!_hasReagents) {
        // Do NOT delete _brokeUntil — the armed goal demotion depends
        // on it being active. Just suppress the buyer route.
        return { sent: false, why: 'broke but nothing to sell; hunting for loot' };
      }
      const roomNum2 = c.room?.num ?? s?.world?.room?.num;
      const buyerRoom = 202;  // Limping Toad Inn, Marion — Morrigan buys reagents
      if (roomNum2 !== buyerRoom) {
        if (s) s._buyingRoute = buyerRoom;
        const curDest = s._router.dest;
        if (curDest == null) {
          s._router.to(buyerRoom);
          return { sent: true, what: `travel to buyer (room ${buyerRoom}) — broke, sell to earn gold` };
        }
        if (curDest !== buyerRoom) {
          return { sent: false, why: `router busy (dest=${curDest}); buy yields` };
        }
        const r = routeIntent(s._router)(frame, act);
        return { sent: r.sent, what: r.what ?? `traveling to buyer (room ${buyerRoom})` };
      }
      // Already at the buyer room: sell (the sell goal handles this).
      return { sent: false, why: 'broke; at buyer room; sell goal handles' };
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
          // tickLogged, not tick: tick() is 1,430 lines with 29 exits that log nothing, so a
          // character standing still for three minutes is undiagnosable. This is the site the live
          // keeper actually drives (m59-keeper-process calls intend('travel')), which is why the
          // wrapper added on the Router/Combat sites produced zero output.
          mv.tickLogged({ col: me.col, row: me.row, x: me.x, y: me.y });
        }
        return { sent: true, what: `approach ${target.name ?? 'merchant'} at (${target.col},${target.row})` };
      }
    }
    if (s) { s._buyInFlight = true; s._buyingActive = true; }
    import('../m59-act/buy.mjs').then(({ buy }) => {
      return buy(c, s, {});   // no itemId/wantName: the atomic picks a weapon if unarmed
    }).then(res => {
      console.error(`[buy] ${s?.name ?? 'keeper'}: ${res?.bought ? 'bought ' + res.bought : 'no buy (' + (res?.reason ?? 'unknown') + ')'}`);
      // BACKOFF ON NO REPLY: the server sends nothing for an unaffordable buy
      // (silent refuse, like create food). A no-reply on a weapon buy means
      // broke. Stamp a cooldown so the buy path doesn't hammer the server
      // every ~3.5 s. The sell goal (above armed) handles the economics.
      if (res && !res.bought && /no reply|cannot afford/i.test(res.reason ?? '')) {
        // Always stamp the broke flag — the armed goal demotion
        // (decide.mjs:2853) handles the "nothing to sell" case by
        // suppressing the armed goal while broke with no reagents.
        if (s) { s._brokeUntil = Date.now() + 1800000; console.error(`[buy] ${s?.name ?? 'keeper'}: STAMPED _brokeUntil for 30m`); }
      }
      // CLEAR THE BROKE FLAG ON SUCCESS: a confirmed purchase means the
      // character has coin. Stop the sell goal within one tick.
      if (res?.bought) {
        if (s) delete s._brokeUntil;
      }
    }).catch(e => console.error(`[buy] ${s?.name ?? 'keeper'} err: ${e.message}`))
      .finally(() => { if (s) s._buyInFlight = false; });
    return { sent: true, what: 'buy weapon (one phase)' };
  },

  sell: (f, act, ctx) => {
    const c = ctx.client;
    const s = ctx.session;
    // In-flight guard: the sell atomic is async and multi-phase.
    if (s && s._sellInFlight) return { sent: false, why: 'sell in flight' };
    // Find a trusted buyer in the room.
    const objects = c.room?.objects;
    const list = objects instanceof Map ? [...objects.values()]
               : Array.isArray(objects) ? objects : [];
    const buyer = list.find(o => {
      const name = c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
      return trustedBuyer(name);
    });
    if (!buyer) return { sent: false, why: 'no trusted buyer in room' };
    // Pick an item to sell: prefer reagents (herbs, mushrooms, elderberry).
    // RESERVE RULE: create food needs 2 ElderBerry + 2 Herbs (m59-skills.mjs:1225
    // — without them vigor is hard-capped at the resting 80). Do not sell the
    // last 2+2.
    const pack = c.inventory ?? [];
    const countOf = (re) => pack.filter(i => re.test(
      String(c.rsc?.get?.(i.nameRsc) ?? i.name ?? ''))).reduce((n, i) => n + (i.amount ?? 1), 0);
    const herbs = countOf(/^herb/i);
    const elderberry = countOf(/^elderberry/i);
    // Skip items that would break the reserve.
    const item = pack.find(i => {
      const name = String(c.rsc?.get?.(i.nameRsc) ?? i.name ?? '');
      if (!/herb|mushroom|elderberry|root|leaf|seed/i.test(name)) return false;
      // Don't sell the last 2 herbs or the last 2 elderberries.
      if (/^herb/i.test(name) && herbs <= 2) return false;
      if (/^elderberry/i.test(name) && elderberry <= 2) return false;
      return true;
    });
    if (!item) return { sent: false, why: 'nothing sellable in pack (reserve rule)' };
    if (s) s._sellInFlight = true;
    import('../m59-act/sell.mjs').then(({ sell }) => {
      return sell(c, s, { merchantId: buyer.id, itemId: item.id });
    }).then(res => {
      console.error(`[sell] ${s?.name ?? 'keeper'}: ${res?.sold ? 'sold ' + res.sold + ' for ' + res.price : 'no sell (' + (res?.reason ?? 'unknown') + ')'}`);
      // CLEAR THE BROKE FLAG ON A SUCCESSFUL SALE: coin in the pack is the
      // observation that distinguishes broke from not-broke. A character who
      // just received coin should not run the sell goal for the rest of the
      // flag's TTL.
      if (res?.sold) {
        if (s) delete s._brokeUntil;
      }
    }).catch(e => console.error(`[sell] ${s?.name ?? 'keeper'} err: ${e.message}`))
      .finally(() => { if (s) s._sellInFlight = false; });
    return { sent: true, what: `sell ${c.rsc?.get?.(item.nameRsc) ?? item.name ?? 'item'} to ${c.rsc?.get?.(buyer.nameRsc) ?? buyer.name ?? 'buyer'}` };
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
    const targetObj = f.objects.get(id);
    const targetName = targetObj?.name ?? targetObj?.nameRsc ?? 'unknown';
    const usingBefore = ctx.client?.using ? [...ctx.client.using] : null;
    act.swing(id);
    const usingAfter = ctx.client?.using ? [...ctx.client.using] : null;
    if (Date.now() - (ctx.session?._lastSwingDiagAt ?? 0) > 10000) {
      ctx.session._lastSwingDiagAt = Date.now();
      console.error(`[swing-diag] ${ctx.session?.name ?? 'keeper'}: target=${targetName} id=${id} using_before=${JSON.stringify(usingBefore)} using_after=${JSON.stringify(usingAfter)}`);
    }
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
        if (/portal|rip/i.test(name) && o.col != null && o.row != null) matches.push(o);
      }
    }
    if (!matches.length) return { sent: false, why: 'no portal in room' };
    const dead = (ctx.session?._deadPortals ?? []).filter(d => now3 - (d.at ?? 0) < 600000);
    if (ctx.session) ctx.session._deadPortals = dead;
    const isDead = (o) => dead.some(d => d.col === o.col && d.row === o.row);
    matches.sort((a, b) => (Math.hypot(a.col - me.col, a.row - me.row) - Math.hypot(b.col - me.col, b.row - me.row)));
    const portal = matches.find(o => !isDead(o)) ?? matches[0];
    // READ-ONLY DIAG (C): the off-by-one premise was falsified by 40 dead=[1-9]
    // hits in the pre-change logs, but the "no portal in room" thrash still needs
    // a live sample. Print me.col/row beside the matched object's col/row + objId
    // and matches.length so the restart yields evidence instead of a guess.
    try {
      console.error(`[portal-dbg] me=(${me.col},${me.row}) portal=(${portal.col},${portal.row}) objId=${portal.id ?? '?'} matches=${matches.length} dead=${dead.length}`);
    } catch {}
    // Per-candidate attempt counter: N escape ticks aimed at a candidate with
    // no room change in M seconds ⇒ mark it dead. The old exact-square test
    // (me.col === portal.col) never fired for a character 8 squares from the
    // portal, so _goAt was reset every tick and the 10s dead verdict was
    // unreachable. The attempt counter works regardless of distance.
    const _attempts = ctx.session?._portalAttempts ?? {};
    if (ctx.session) ctx.session._portalAttempts = _attempts;
    const _pid = portal.id ?? `${portal.col},${portal.row}`;
    const _att = _attempts[_pid] ?? { at: now3, count: 0, near: 0 };
    _att.count += 1;
    // Count ticks only when within 1.5 squares of the candidate. This
    // distinguishes "we never got there" (wants a repath) from "it
    // didn't work" (wants a blacklist).
    if (Math.hypot(portal.col - me.col, portal.row - me.row) <= 1.5) _att.near = (_att.near ?? 0) + 1;
    _attempts[_pid] = _att;
    // Room number: if it changed, the escape worked — clear the counter.
    const _curRoomNum = c.room?.num ?? ctx.session?.world?.room?.num;
    if (_att.roomNum != null && _att.roomNum !== _curRoomNum) {
      delete _attempts[_pid];
    } else {
      _att.roomNum = _curRoomNum;
    }
    // Standing on the chosen portal: send BP_REQ_GO (gated to 1/s).
    if (me.col === portal.col && me.row === portal.row) {
      if (ctx.session && !ctx.session._goAt) {
        ctx.session._goAt = now3;
        ctx.session._goRoomNum = _curRoomNum;
      }
      if (now3 - (ctx.session?._lastGoAt ?? 0) >= 1000) {
        if (ctx.session) ctx.session._lastGoAt = now3;
        c.go?.();
        try {
          console.error(`[go-dbg] go sent, room=${_curRoomNum} portal=(${portal.col},${portal.row})`);
        } catch {}
      }
    } else if (ctx.session) {
      ctx.session._goAt = 0;
    }
    // Attempt-counter dead verdict: 30 ticks (≈27s of real walking at
    // ~1/s mover pace) aimed at a candidate, with at least 3 ticks
    // within 1.5 squares of it, and no room change ⇒ mark it dead.
    // The `near` requirement distinguishes "we never got there" (wants
    // a repath) from "it didn't work" (wants a blacklist).
    if (_att.count >= 30 && (_att.near ?? 0) >= 3 && _att.roomNum === _curRoomNum && !isDead(portal)) {
      dead.push({ col: portal.col, row: portal.row, at: now3 });
      ctx.session._deadPortals = dead;
      delete _attempts[_pid];
      try {
        console.error(`[portal-dbg] candidate ${_pid} marked dead after ${_att.count} attempts (${_att.near} near, no room change)`);
      } catch {}
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
  // Stillness for the cast-time: movement breaks concentration (see the
  // mover's casting hold). 5s covers ordinary cast times.
  try { if (ctx?.session) ctx.session._castingUntil = Date.now() + 5000; } catch {}
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
  // GOAP REPORTING (B4): tick mode has no _goapKeeper, so /state's goap.goal/
  // action/plan are structurally null. Stamp the last decision on the session so
  // /state can report the LIVE goal/action in tick mode. Single wrap here rather
  // than editing the ~30 call sites.
  const _rawOnDecision = onDecision;
  if (_rawOnDecision) {
    onDecision = (d) => {
      try { session._lastDecision = { goal: d?.goal ?? null, action: d?.action ?? null, what: d?.what ?? null, at: Date.now() }; } catch {}
      return _rawOnDecision(d);
    };
  }
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
  let _ws = null;               // last tick's world state (for state() access)
  let retargetCheckAt = 0;       // wall-clock ms of last re-target check (throttle)
  let _uwDbgAt = 0;               // wall-clock ms of last underworld-identity diagnostic
  let _stuckDbgAt = 0;            // wall-clock ms of last stuck-gate diagnostic
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

    // CLEAR STALE SMITH ROUTE: if the router's dest is a smith room from
    // the old candidate list and the nearest smith has changed, clear it.
    // This fixes the 10-hop route to room 201 when room 113 was 4 hops away.
    if (session?._router?.dest != null && SMITH_CANDIDATES.includes(session._router.dest)) {
      const roomNum = client?.room?.num ?? session?.world?.room?.num;
      if (roomNum != null) {
        const nearest = nearestSmith(session, roomNum, session?._map ?? loadMap());
        if (nearest != null && nearest !== session._router.dest) {
          // Gate on stability: nearestSmith derives from the current room,
          // which changes on every room transition. Only re-route after 3
          // consecutive ticks agree on the same new target.
          if (session._smithRerouteCandidate === nearest) {
            session._smithRerouteCount = (session._smithRerouteCount ?? 0) + 1;
          } else {
            session._smithRerouteCandidate = nearest;
            session._smithRerouteCount = 1;
          }
          if (session._smithRerouteCount >= 3) {
            console.error(`[decide] ${session.name} stale smith route: ${session._router.dest} -> ${nearest}; re-routing`);
            session._smithDest = null;
            session._buyingRoute = null;
            session._router.to(nearest);
            session._smithRerouteCandidate = null;
            session._smithRerouteCount = 0;
          }
        } else {
          session._smithRerouteCandidate = null;
          session._smithRerouteCount = 0;
        }
      }
    }
    // escapes return early and would otherwise starve the setter below).
    // ABSOLUTE thresholds, deliberately: rest recovers only to ~80
    // regardless of max vigor (food carries it to max, 200 for JayB),
    // so scaling to max would put the clear-point above the rest ceiling
    // and latch critical-rest on for life.
    try {
      const vv = client?.vitals?.()?.vigor?.value ?? null;
      if (vv != null && vv < 30) session._criticalRest = true;
      else if (vv != null && vv >= 60) session._criticalRest = false;
    } catch {}

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
          // intentionally not moving: resting, critically
          // exhausted, or fighting. The _fighting/_resting
          // flags are from the previous tick.
          const c2 = client;
          const objs = c2?.room?.objects;
          if (_resting) {
            // Resting: not stuck, just not moving.
          } else if (session?._criticalRest === true) {
            // Critically exhausted (<30, recovering to 60): intentional
            // stillness. Suppress detection (reset the timer) and do NOT
            // walk — walking it dry starts the drain spiral, and the escape
            // would steal a manual destination for a hunt room.
            // EXCEPTION: if stuck > 60s during critical rest, allow the
            // blink escape (blink doesn't require vigor — it's a safe
            // escape from a geometry pocket that rest alone can't fix).
            const _critHeld = now() - _lastPosAt;
            if (_critHeld < 60000) {
              _lastPosAt = now();
            }
          } else if (_fighting) {
            // Genuinely engaged: the decider's own goal is _fight.
            // Reset the timer so post-combat doesn't trip STUCK_MS.
            _lastPosAt = now();
          } else {
            const held = now() - _lastPosAt;

            // DIAG (permanent, rate-limited): critical-rest gating. (ws
            // doesn't exist yet in section 0 — read vitals directly.)
            if (Date.now() - (_stuckDbgAt ?? 0) > 30000) {
              _stuckDbgAt = Date.now();
              try {
                const vv = client?.vitals?.()?.vigor?.value ?? null;
                console.error(`[stuckdbg] vigor=${vv} crit=${session?._criticalRest ?? 'null'} resting=${_resting} held=${Math.round(held / 1000)}s`);
              } catch {}
            }
            // Critical rest covers micro-walks AND travel-escapes: an
            // exhausted character neither walks dry nor gets shipped to a
            // hunt room. It rests to 60 first (then escapes normally if
            // still stuck).
            if (session?._criticalRest === true) { _lastPosAt = now(); }
            else if (held > STUCK_MS) {
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
                  const hunt = nearestHuntRoom(resolved, maxHp, ceiling, maxHp - 2);
                  // Don't steal an operator-ordered destination (travel
                  // command): it was set on purpose within the last 15 min.
                  // If the router dropped it (oscillation/arrival), REASSERT
                  // it instead of wandering to a hunt room.
                  const man = session?._manualDest;
                  const manualFresh = man != null && Date.now() - (man.at ?? 0) < 900000;
                  if (manualFresh && Number(man.dest) !== Number(router?.dest)) {
                    router.to(Number(man.dest));
                    onDecision?.({ ticks, goal: 'unstuck', action: 'travel',
                      what: `stuck ${_stuckEscapes}x; reasserting manual dest ${man.dest}`, sent: true });
                    _lastPosAt = now();
                    return;
                  }
                  if (manualFresh) { _lastPosAt = now(); return; }
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
              // The tick walk REFUSES while the router holds a destination
              // (the mover owns stepping — walk() returns ok:false), and the
              // raw moveToSquare fallback would bypass the 1/s move cap and
              // trip speedhack detection. With a live dest there is nothing
              // for the decider to step: hold for the mover instead of
              // logging a walk that never sends (watched: 'walking to open
              // square' every stuck tick, zero packets, timer reset each
              // time so real escalation never progresses).
              if (session?._router?.dest != null) {
                onDecision?.({ ticks, goal: 'unstuck', action: 'hold',
                  what: `stuck at (${me.col},${me.row}), mover owns stepping (router dest ${session._router.dest}) — holding`, sent: false });
                _lastPosAt = now(); // reset timer
                return;
              }
              // Walk to the open neighbor.
              act.walk?.(escape.col, escape.row) ?? c.moveToSquare?.(escape.col, escape.row, 18);
              onDecision?.({ ticks, goal: 'unstuck', action: 'walk',
                what: `stuck at (${me.col},${me.row}), walking to open square (${escape.col},${escape.row})`, sent: true });
              _lastPosAt = now(); // reset timer
              return;
            }
            // No open neighbor: blink as last resort — unless travel mode
            // (motion-only proving): a random teleport destroys the run.
            // Name the pocket and hold for the operator instead. (ws does
            // not exist yet here — stuck detection runs before evaluate —
            // so read the manual dest directly from session.)
            try {
              const _man0 = session?._manualDest;
              if (_man0 != null && Date.now() - (_man0.at ?? 0) < 900000) {
                onDecision?.({ ticks, goal: 'unstuck', action: 'hold',
                  what: `travel-mode pocket at (${me.col},${me.row}): no open neighbor, blink parked — holding`, sent: false });
                _lastPosAt = now();
                return;
              }
            } catch {}
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
    _ws = ws;
    ws._pokeFailCount = session._hpPokeFailCount ?? 0;
    // Reset the poke fail counter on room change or HP rise — a latched
    // counter would permanently disable the healthy goal for this session.
    const _roomNum = session?.world?.room?.num ?? client?.room?.num ?? null;
    if (_roomNum != null && session._lastRoomNum != null && _roomNum !== session._lastRoomNum) {
      session._hpPokeFailCount = 0;
      session._pokeRelocate = false;
    }
    session._lastRoomNum = _roomNum;
    const _hpNow = client?.vitals?.()?.health?.value ?? null;
    if (_hpNow != null && session._lastHp != null && _hpNow > session._lastHp) {
      session._hpPokeFailCount = 0;
      session._pokeRelocate = false;
    }
    session._lastHp = _hpNow;
    ws._vigor = client?.vitals?.()?.vigor?.value ?? null;
    // Max vigor (informational/diagnostics only). The rest thresholds stay
    // ABSOLUTE: rest recovers only to ~80 whatever the max — food carries
    // vigor the rest of the way to max (200 for JayB) — so a max-relative
    // clear-point (120 for a 200-max) would be unreachable by resting and
    // would latch critical-rest on for the character's life.
    ws._vigorMax = client?.vitals?.()?.vigor?.max ?? null;
    // CRITICAL HYSTERESIS (maintained here so every consumer — stuck
    // detector, goals — sees it even when a higher goal preempts rest).
    // Mirrored to ws: the module-scope goal lambdas can't see `session`.
    try {
      if (ws._vigor != null && ws._vigor < 30) session._criticalRest = true;
      else if (ws._vigor != null && ws._vigor >= 60) session._criticalRest = false;
      ws._criticalRest = session._criticalRest === true;
    } catch {}
    // LIVE MELEE READ: "something can hit me right now" — per-tick,
    // not the CombatController's sticky targetId (which latches true
    // through the post-fight loot window and permanently disables blink).
    try { session._inMelee = ws.has_target === true && ws.in_reach === true; } catch {}
    // TRAVEL MODE (motion-only proving): a fresh operator travel order
    // (<15min) parks every non-motion goal — hurt-rest, vigor-rest, fight
    // engagement, blink escapes — so a crossing run measures the mover, not
    // the circus. Flee stays (survival, and it re-routes along the manual
    // dest). The fan stays (server-confirmed probes). Blink goes (a random
    // teleport destroys the run; a real wall becomes a named stuck instead
    // of a scatter). Mirrored to ws: the module-scope goal lambdas can't
    // see `session`. The mover reads session._manualDest itself (same
    // source; skew on a 15-min flag is irrelevant).
    try {
      const _man = session?._manualDest;
      const _manFresh = _man != null && Date.now() - (_man.at ?? 0) < 900000;
      const _op = session?._operatorDest;
      const _opFresh = _op != null && Date.now() - (_op.at ?? 0) < 900000;
      const _hunt = session?._huntDest;
      const _huntFresh = _hunt != null && Date.now() - (_hunt.at ?? 0) < 600000
        && Number(session?.world?.room?.num ?? client?.room?.num) !== Number(_hunt.dest);
      // _travelMode suppresses rest (healthy, vigor_low) for both manual and hunt
      // journeys. _fight is gated on _manualMode (operator-ordered only), so a
      // hunt-bound character can still engage in-band targets mid-corridor.
      // ROUTE-DROP (B3): when the oscillation breaker dropped a route (B1), the
      // character is holding in place. _travelMode must be false so _fight is
      // not suppressed — a held character must defend itself instead of being
      // eaten mid-corridor.
      const _droppedFresh = session?._routeDrop && Date.now() - (session._routeDrop.at ?? 0) < 120000;
      const _inHuntRoom = _hunt != null && Number(session?.world?.room?.num ?? client?.room?.num) === Number(_hunt.dest);
      ws._travelMode = ((_manFresh || _huntFresh || (session?._buyingRoute != null)) && !_droppedFresh) && !_inHuntRoom;
      ws._manualMode = _opFresh;
    } catch { ws._travelMode = false; ws._manualMode = false; }
    // Expose room number and max HP for the hunt goal's Raza check.
    ws._roomNum = session?.world?.room?.num ?? client?.room?.num
      ?? roomNumByRsc(client?.roomNameRsc) ?? roomNumByRsc(client?.roomRsc) ?? null;
    ws._packWeapon = (client?.inventory ?? []).some(o => {
      const name = String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
      if (!/mace|sword|axe|club|dagger|staff|bow|spear|hammer|flail|war hammer|warhammer/.test(name)) return false;
      if (o?.id != null && brokenSetFor(session, client).has(o.id)) return false;
      return true;
    });
    // Expose the broke observation for the sell goal (evidence, not inference).
    ws._brokeUntil = Date.now() < (session?._brokeUntil ?? 0);
    ws._equipCooldown = Date.now() < (session?._equipCooldownUntil ?? 0);
    // Expose the character's gold for the armed goal (no gold = can't buy).
    ws._gold = (client?.inventory ?? [])
      .filter(o => /shilling/i.test(client?.rsc?.get?.(o.nameRsc) ?? ''))
      .reduce((sum, o) => sum + (o.amount ?? 1), 0);
    ws._canConjureWeapon = knownSpells(client).some(sp =>
      sp.name.toLowerCase() === 'create weapon');
    // Expose whether the character has reagents to sell (for the sell goal).
    ws._hasReagents = (client?.inventory ?? []).some(o =>
      /herb|mushroom|elderberry|root|leaf|seed/i.test(
        String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '')));
    // UNDERWORLD GROUND TRUTH (tick-owned): the shared in_underworld symbol
    // is name-rsc/id based and flaps across room changes (stale name reads
    // as Underworld in the inn, so escape and travel yank the destination
    // opposite ways every few ticks — self-inflicted rubber-banding). Room
    // NUMBER 1 is The Underworld and is the stable identity: authoritative
    // both ways.
    if (ws._roomNum != null) ws.in_underworld = ws._roomNum === 1;
    // STAMP DEATH: when the character is in the Underworld, record the time.
    // Used by the post_death_rest goal to gate hunting until full HP + vigor 80.
    if (ws.in_underworld === true) {
      // Log on the rising edge only (first tick in the Underworld).
      if (session._lastUnderworldAt == null) {
        try { console.error(`[death-stamp] entered Underworld at ${Date.now()}`); } catch {}
      }
      // Stamp every tick so the 5-min window opens at the last Underworld tick.
      session._lastUnderworldAt = Date.now();
    }
    ws._lastUnderworldAt = session._lastUnderworldAt ?? null;
    // Log the room identity inputs whenever the symbol is true.
    if (ws.in_underworld === true && Date.now() - (_uwDbgAt ?? 0) > 30000) {
      _uwDbgAt = Date.now();
      try {
        console.error(`[uwdbg] in_underworld=true roomNum=${ws._roomNum} worldRoom=${session?.world?.room?.num ?? 'null'} clientRoomNum=${client?.room?.num ?? 'null'} clientRoomId=${client?.room?.id ?? 'null'} nameRsc=${client?.roomNameRsc ?? 'null'}`);
      } catch {}
    }
    ws._maxHp = client?.vitals?.()?.health?.max ?? null;
    ws._hp = client?.vitals?.()?.health?.value ?? null;
    // LEVEL-UP HOLD RESET: when maxHp increases, clear the hunt hold so the
    // character immediately re-evaluates its hunt target. The ceiling rises,
    // so the old destination may no longer be in band.
    if (ws._maxHp != null && session?._lastMaxHp != null && ws._maxHp > session._lastMaxHp) {
      if (session._huntDestHold) delete session._huntDestHold;
      if (session._huntPickedAt) delete session._huntPickedAt;
      try { console.error(`[level-up] maxHp ${session._lastMaxHp} -> ${ws._maxHp}; hunt hold cleared`); } catch {}
    }
    if (ws._maxHp != null) session._lastMaxHp = ws._maxHp;
    // Expose whether the character is moving (the router has a destination).
    // The vigor_low goal yields when the character is moving — resting would
    // stop the movement.
    ws._moving = session?._router?.dest != null;
    // Expose whether the character is at a boundary (the router is in the
    // crossing state). The vigor_low goal yields when the character is at a
    // boundary — resting would prevent the crossing. Freshness-gated (5s):
    // idle ticks don't run the router, so a fossilized 'crossing' from an
    // old leg would otherwise yield rest forever.
    ws._crossing = session?._router?.lastState === 'crossing'
      && (Date.now() - (session?._router?._stateAt ?? 0) < 5000);

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
          const charLevel = maxHp;
          const isArmed = ws.armed === true;
          const fullBand = policy?.threatBand ?? Math.floor(charLevel / 4);
          const ceiling = charLevel + (isArmed ? fullBand : Math.floor(fullBand / 2));
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
            allowPlayers: (session?.policy ?? policy)?.defendAgainstPlayers === true,
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
        // AGGRO-SWITCH: if a DIFFERENT mob has is_enemy set (targeted us) and
        // we haven't yet reached the current target, switch to it. This is
        // safer than the attacker-switch (which requires damage) because the
        // aggro flag is set before the first hit lands.
        if (target && now() - retargetCheckAt > 2000) {
          const tD2 = (target.col - me.col) ** 2 + (target.row - me.row) ** 2;
          // Only switch if we're still traveling (not in melee range of current target).
          if (tD2 > 4) {
            for (const o of objects.values()) {
              if (o.is_self) continue;
              if (!o.is_enemy) continue;
              const oId = o.id ?? o.obj_id;
              if (oId === _lastTargetId) continue;  // same target, no switch
              if (oId != null && _blacklist.has(oId)) continue;
              // Switch to the aggro'd mob.
              retargetCheckAt = now();
              target = o;
              if (oId != null) {
                _lastTargetId = oId;
                ws._targetId = oId;
                _currentTargetId = oId;
              }
              try { console.error(`[aggro-switch] switched to aggro'd mob ${oId}`); } catch {}
              break;
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
                const entries = spawns.byMonster[name];
                if (!Array.isArray(entries) || !entries.some(e => e.how === 'generator')) continue;
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

          // THREAT CEILING: compute the same formula as the attacker-switch
          // block. Mobs above the ceiling are too dangerous to target — the
          // character will die. Skip them.
          const maxHp = client.vitals?.()?.health?.max ?? 20;
          const charLevel = maxHp;
          const isArmed = ws.armed === true;
          const fullBand = (session?.policy ?? policy)?.threatBand ?? Math.floor(charLevel / 4);
          const ceiling = charLevel + (isArmed ? fullBand : Math.floor(fullBand / 2));
          // Build a level map from the compendium (creature name -> level).
          let creatureLevels = new Map();
          try {
            const spawns = loadSpawns(SPAWNS_FILE);
            if (spawns?.byMonster) {
              for (const [name, entries] of Object.entries(spawns.byMonster)) {
                if (!Array.isArray(entries)) continue;
                const lvl = entries[0]?.level;
                if (lvl != null) creatureLevels.set(mobNameKey(name), lvl);
              }
            }
          } catch { /* compendium unavailable */ }

          for (const o of objects.values()) {
            if (o.is_self) continue;
            if (o.col == null || o.row == null) continue;
            // Skip blacklisted (unreachable) mobs.
            const oId = o.id ?? o.obj_id;
            if (oId != null && _blacklist.has(oId)) continue;
            // Resolve the name from nameRsc (token-set key: 'baby spider' == 'SpiderBaby').
            const objName = mobNameKey(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
            // A mob is either: flagged as a player with
            // can_attack (enriched object, only when defendAgainstPlayers
            // policy allows targeting players), OR its name
            // exactly matches a compendium creature.
            // Exact match only: "baby spider" != "spider".
            const isMob = ((session?.policy ?? policy)?.defendAgainstPlayers === true && o.is_player && o.can_attack)
              || (o.is_player === false && creatureNames.size > 0 && creatureNames.has(objName));
            if (!isMob) continue;
            // THREAT CEILING FILTER: skip mobs above the character's ceiling.
            // An ant (lv40) in a room with a level-25 character (ceiling 37)
            // is too dangerous to target — the character will die.
            const mobLvl = creatureLevels.get(objName);
            if (mobLvl != null && mobLvl > ceiling) continue;
            const d2 = (o.col - me.col) ** 2 + (o.row - me.row) ** 2;
            candidates.push({ o, d2 });
          }
          // AGGRO PRIORITY: if any candidate has is_enemy set (the server set
          // PLAYER_IS_ENEMY on our object — a mob has targeted us), prioritize
          // it over the nearest mob. This prevents the character from fighting
          // a passive mob while the aggro'd one attacks from the side.
          candidates.sort((a, b) => {
            const aAggro = a.o.is_enemy ? 0 : 1;
            const bAggro = b.o.is_enemy ? 0 : 1;
            if (aAggro !== bAggro) return aAggro - bAggro;
            return a.d2 - b.d2;
          });
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
            const charLevel = maxHp;
            const isArmed = ws.armed === true;
            const fullBand = policy?.threatBand ?? Math.floor(charLevel / 4);
            const band = isArmed ? fullBand : Math.floor(fullBand / 2);
            const targetLevel = targetLevelOf(best, (o) => client.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
            ws._targetLevel = targetLevel;
            ws._threatCeiling = charLevel + band;
            // Re-derive the target-dependent symbols.
            ws.has_target = true;
            ws._targetD2 = bestD2;
            ws.in_reach = bestD2 <= 4; // MELEE_REACH = 2, squared = 4
          }
        } else {
          // this sticky path previously set has_target=true but NOT ws._targetId —
          // it relied on _lastTargetId (module-level) for stickiness. The combat
          // layer reads ws._targetId (m59-combat.mjs:251), so with it null the
          // combat layer could only fight a target it had ALREADY bound (this.targetId);
          // a character that arrived in a fresh room (this.targetId null) could never
          // START the fight, even though has_target=true and goap.target showed the
          // mob. Setting ws._targetId every tick (not just on a new pick) makes the
          // decider's sticky target visible to the combat layer.
          ws._targetId = target.id ?? target.obj_id;
          const d2 = (target.col - me.col) ** 2 + (target.row - me.row) ** 2;
          ws.in_reach = d2 <= 4;
          ws._targetD2 = d2;
          ws.has_target = true;
          const tLevel = targetLevelOf(target, (o) => client.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
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
          // OUTNUMBERED COUNT: hostile-ish within melee+1 (same predicate).
          // A pack is fled, not fought (the 545 rat nest proved it).
          let n = 0;
          try {
            const nm = (o) => mobNameKey(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
            for (const o of dObjs.values()) {
              if (o.is_self || o.col == null || o.row == null) continue;
              if (!((o.is_player && o.can_attack) || (allNames.size > 0 && allNames.has(nm(o))))) continue;
              if ((o.col - dMe.col) ** 2 + (o.row - dMe.row) ** 2 <= 10) n++;
            }
          } catch {}
          ws._mobCount = n;
        } catch { ws._mobNear = null; }
      }
    }

    ws._traveling = (session._router?.dest ?? null) != null && Number(session?.world?.room?.num ?? client?.room?.num) !== Number(session._router?.dest);
    // IN HUNT ROOM: true when the character is standing in the room the hunt
    // goal is routing to, OR when no route is in progress (idle). Used to gate
    // flee_danger: a character in a hunt room with mobs is hunting, not fleeing.
    // The mobs are the target, not a danger. The idle case is included because
    // _say('arrived') clears the dest at route.mjs:690 the same tick, so the
    // flag would be true for at most one tick and then false again.
    const _d = session._router?.dest;
    ws._inHuntRoom = _d == null || (ws._roomNum != null && Number(_d) === Number(ws._roomNum));
    // Fire a confirm at a fixed cadence (the mover rate-limits internally).
    // This is fire-and-forget: the tick continues with dead reckoning
    // until the confirm resolves and syncs the mover.
    if (session._mover?.maybeConfirm) session._mover.maybeConfirm();

    // 2. GOAL. Committed-goal hysteresis: if the previous tick's goal is
    // still valid (its `when` is true), keep it — skip lower-priority goals.
    // Only supersede when a HIGHER-priority goal (earlier in the array) fires.
    // This prevents the armed<->hunt oscillation: once armed is selected, it
    // stays selected until the character is armed (ws.armed === true) or a
    // higher-priority goal (!in_underworld, flee_danger) fires.
    const committedIdx = session?._committedGoalIdx ?? 0;
    const committedGoal = goals[committedIdx];
    const committedValid = committedGoal?.when?.(ws) === true
      && (skipped.get(committedGoal.goal) ?? 0) <= now();
    // Always check from the top (highest priority). Skip only LOWER-priority
    // goals (higher index) when the committed goal is still valid.
    const active = goals.find((g, idx) => {
      if (committedValid && idx > committedIdx) return false;
      if (!g?.goal || !g.when?.(ws)) return false;
      const until = skipped.get(g.goal) ?? 0;
      return now() >= until;
    });
    if (active) {
      session._committedGoalIdx = goals.indexOf(active);
    }

    // Track whether we're resting or fighting (suppress
    // stuck detection). A character that's swinging at a
    // mummy or resting at an inn is intentionally not
    // moving — it's not stuck.
    _resting = active?.goal === 'healthy' || active?.goal === 'vigor_low';
    try { session._resting = _resting; } catch {}
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
    // STUCK-STAND: sends flowing with a static server usually means seated
    // server-side while the mover believes standing (no goal transition to
    // trigger the stand above) — stand so the next steps land.
    // STUCK-STAND gating: at most every 5s (stands are posture packets, but
    // 10Hz spam helps nothing and can break other flows).
    const stuckStale = (session?._mover?.stuckTicks ?? 0) > 5
      && Date.now() - (session?._lastStuckStandAt ?? 0) > 5000;
    if ((_wasResting && !_resting && active && (active.goal === 'hunt' || active.goal === 'flee_danger' || active.goal === 'flee_hurt' || active.goal === 'travel' || active.goal === '_fight' || active.goal === 'armed' || active.goal === '!in_underworld' || active.goal === 'unstuck' || active.goal === 'leave_raza'))
        || (stuckStale && active && (active.goal === 'hunt' || active.goal === 'travel' || active.goal === 'flee_danger' || active.goal === 'flee_hurt' || active.goal === '_fight'))) {
      if (stuckStale && !(_wasResting && !_resting)) { try { session._lastStuckStandAt = Date.now(); } catch {} }
      try { act.stand?.(); } catch { /* best effort */ }
      onDecision?.({ ticks, goal: active.goal, action: 'stand', sent: true, what: 'stand before ' + (active.goal === 'armed' ? 'equipping' : 'moving') });
      _wasResting = false;
      return;
    }
    // THE REST BUDGET IS BANKED HERE, at the transition that already knows a rest ended.
    //
    // `restSpotFor` caps how long a character may stop for, so the time has to be measured
    // somewhere. The first version banked it inside the healthy branch, on the same tick it
    // also called rest() — which added the elapsed time on every single rest tick and made
    // the budget look spent the moment a character sat down. That would have switched the
    // whole feature off after one rest, and it passed every test I had, because no test
    // rested for two separate episodes.
    //
    // `_wasResting && !_resting` is the tick where the goal STOPPED being a rest goal, which
    // is exactly when the clock should stop. It already existed for the stand-before-moving
    // rule, so this adds no new state machine — it reuses the transition that is already
    // correct and already tested.
    if (_wasResting && !_resting) { try { noteStoppedResting(session, { now }); } catch {} }
    // THE REST BUDGET IS PER ROOM, NOT PER SESSION.
    //
    // THE HOLDING BUDGET IS PER JOURNEY, NOT PER ROOM: cleared when a journey begins and
    // when one ends, never while one is in progress.
    //
    // This corrects my own first version, which keyed the reset on the room and was wrong in
    // a way that reintroduced the exact failure the budget exists to prevent. A hurt
    // character crossing five rooms got a fresh 180 seconds in each — fifteen minutes of
    // stopping on one journey — while reporting itself within budget the whole time. The
    // legacy is unambiguous: `travelHeldMs` is zeroed at trip start (m59-autopilot.mjs:5176)
    // and at trip end (:5272), and is only ever ADDED TO in between (:4893, :5014). Nothing
    // in it resets per room.
    //
    // So the key is the DESTINATION, not the room. A room change clears nothing. Keyed on
    // the router's dest because there is no reliable arrival event to hook: the router's
    // state cycles moving/crossing/waiting and the decider has no trusted "arrived" callback.
    const destNow = session._router?.dest ?? null;
    if (destNow !== session._restDestKey) {
      session._restDestKey = destNow;
      if (destNow != null) { try { noteNewJourney(session); } catch {} }   // journey began
    }
    _wasResting = _resting;

    // REST HOLD (default off): a rest that sends holds the mover (stillness)
    // so micro-steps stop breaking trance — vigor needs 2.5s of continuous
    // rest per point and never recovers while arrival-dithers land. Rest
    // handlers opt back in below when their rest actually sends.
    try { session._restHold = false; } catch {}

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
      if (ws._justDamaged && ws._mobNear && !ws._moving) {
        act.stand?.();
        onDecision?.({ ticks, goal: 'healthy', action: 'stand',
          sent: true, what: 'taking damage with a hostile near — standing, not sitting' });
        return;
      }
      const hp = client.vitals?.()?.health?.value ?? 0;
      const maxHp = client.vitals?.()?.health?.max ?? 20;
      const now2 = now();
      // WALK TO SHELTER BEFORE THE REGEN POKE, and this ordering is the reason the
      // rest-spot decision sits HERE rather than next to `intend('rest')` where it was
      // first written.
      //
      // The poke below is a real behaviour with a real reason: the server's HP-regen flag
      // is not set by sitting still, so the first rest in a room stands, steps one square
      // and sits back down to set it. It `return`s. With the rest-spot decision after it,
      // the first rest in every room poked, returned, and sat down on the spot the character
      // was hurt on — and the walk to a defensible square never happened, ever, in
      // production. It showed up only as a test that asserted `rest` was not sent and got
      // an empty command list, which is the shape a wrong assertion and a real bug share.
      //
      // Shelter first is also the correct order of operations, not merely the order that
      // makes a test pass: poking one square and sitting is only sensible once we have
      // decided WHERE to sit. Deciding that afterwards means the poke has already committed
      // us to the square we are on.
      const spot = restSpotFor(session, { now });
      {
        if (spot.action === 'walk' && spot.spot) {
          try { act.stand?.(); } catch { /* best effort */ }
          let stepped = false;
          try {
            const rec = act.step?.(spot.spot.col, spot.spot.row, { minGapMs: 0 });
            // `act.step` returns an object on every path: synchronous refusals
            // (ok:false) and async sends (ok:null, resolved later by the pacer).
            // The old check `!== false` was a tautology — the return value is
            // always a truthy object, so `walk` was returned unconditionally.
            // Check `ok` directly: if the send was refused synchronously, rest.
            stepped = rec?.ok !== false;
          }
          catch { stepped = false; }
          if (stepped) {
            // Resting is deferred, not cancelled: a later tick arrives or gives up.
            // `_restHold` stays false so the mover keeps driving its own feet.
            //
            // The budget is NOT consumed here. It measures time spent resting, and it is
            // banked on the resting -> not-resting transition above; counting walking time
            // toward a resting budget would spend the allowance getting to shelter and leave
            // none for recovering once we were there.
            onDecision?.({ ticks, goal: 'healthy', action: 'walk', what: spot.why, sent: true });
            return;
          }
          // Cannot walk there — blocked or unreachable. Sit down here rather than pace
          // toward a wall we cannot reach.
        }
        session._restSpotChoice = spot;
      }
      if (hp < maxHp && now2 - (session._hpPokeAt ?? 0) > 30000) {
        session._hpPokeAt = now2;
        const me = session._pose?.current?.() ?? client.self;
        if (me && me.col != null) {
          // Find the nearest walkable neighbor to step to (N, S, E, W).
          const geo = session.world?.geometry;
          const canStep = (r, c) => {
            const f = geo?.fineWalkable ? geo.fineWalkable(r, c) : undefined;
            const w = geo?.walkable ? geo.walkable(r, c) : undefined;
            if (f === false) return false;
            if (f === undefined && w === false) return false;
            if (isGrounded(geo, r, c) === false) return false;
            return true;
          };
          let poked = false;
          let anyWalkable = false;
          for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
            const nr = me.row + dr, nc = me.col + dc;
            if (!canStep(nr, nc)) continue;
            anyWalkable = true;
            try {
              act.stand?.();
              act.step?.(nc, nr, { minGapMs: 0 });
              act.rest?.();
              poked = true;
              break;
            } catch { /* try the next direction */ }
          }
          if (poked) {
            session._hpPokeFailCount = 0;
            onDecision?.({ ticks, goal: 'healthy', action: 'poke+rest', sent: true,
              what: 'poke to unlock HP regen, then rest' });
            return;
          }
          if (!anyWalkable) {
            session._hpPokeFailCount = (session._hpPokeFailCount ?? 0) + 1;
            if (session._hpPokeFailCount >= 5) {
              session._pokeRelocate = true;
              onDecision?.({ ticks, goal: 'healthy', action: null, sent: false,
                what: `poke failed ${session._hpPokeFailCount}x; flagging for hunt relocation`,
                why: 'no walkable neighbor for regen poke; hunt will exclude this room' });
              return;
            }
            onDecision?.({ ticks, goal: 'healthy', action: 'rest', sent: false,
              what: 'no walkable neighbor to poke; resting anyway',
              why: 'the regen poke needs a square to step into and there is none here' });
          } else {
            onDecision?.({ ticks, goal: 'healthy', action: 'rest', sent: false,
              what: 'poke refused (walkable neighbor exists); resting anyway',
              why: 'step was refused despite a walkable neighbor' });
          }
          // deliberately no return — fall through to the rest below
        }
      }
      // Already poked (flag should be set): just rest. The server regens on its own.
      // The rest-spot decision has already run above, before the regen poke.
      const r = intend('rest', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      if (r.sent === true) {
        try { session._restHold = true; noteResting(session, { now }); } catch {}
      }
      onDecision?.({ ticks, goal: 'healthy', action: 'rest',
        sent: r.sent, what: `${spot.why}${spot.spot ? ` [${spot.spot.col},${spot.spot.row}]` : ''}`
                           ?? null, why: r.why ?? null });
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
    if (active?.goal === 'vigor_low' || active?.goal === 'post_death_rest') {
      // STAND UNDER FIRE (same rule as healthy above). Only stand if
      // NOT moving — a traveling character that stops moving stands
      // still and gets hit repeatedly. Continue moving if in motion.
      if (ws._justDamaged && ws._mobNear && !ws._moving) {
        act.stand?.();
        onDecision?.({ ticks, goal: active.goal, action: 'stand',
          sent: true, what: 'taking damage with a hostile near — standing, not sitting' });
        return;
      }
      // INN CHECK: if post_death_rest and not in an inn, travel to the
      // nearest inn first. Resting in a wilderness room recovers vigor
      // much slower than at an inn.
      if (active?.goal === 'post_death_rest') {
        const roomCls = client?.room?.cls ?? '';
        const inInn = /Inn/i.test(roomCls);
        if (!inInn) {
          // Find the nearest inn from the map.
          const map = loadMap();
          const me = session._pose?.current?.() ?? client?.self;
          const meNum = client?.room?.num ?? session?.world?.room?.num;
          if (map && meNum != null) {
            let bestInn = null, bestD = Infinity;
            for (const [num, r] of Object.entries(map)) {
              if (!/Inn/i.test(r.cls ?? '')) continue;
              const d = Math.abs(Number(num) - Number(meNum));
              if (d < bestD) { bestD = d; bestInn = Number(num); }
            }
            if (bestInn != null) {
              const router = session._router;
              if (router) {
                const ok = router.to(bestInn);
                if (ok) {
                  onDecision?.({ ticks, goal: 'post_death_rest', action: 'travel',
                    sent: true, what: `travel to inn ${bestInn} (not in an inn — resting there is faster)` });
                  return;
                }
              }
            }
          }
        }
      }
      const r = intend('rest', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      if (r.sent === true) { try { session._restHold = true; } catch {} }
      // DISARM post_death_rest when fully rested: clear the stamp so the
      // gate doesn't stay armed forever.
      if (active?.goal === 'post_death_rest') {
        const hp = ws._hp, maxHp = ws._maxHp;
        const vigor = ws._vigor;
        const fullyRested = hp != null && maxHp != null && hp >= maxHp && vigor != null && vigor >= 80;
        if (fullyRested) {
          try { delete session._lastUnderworldAt; } catch {}
          try { console.error(`[post_death_rest] disarmed — fully rested (hp=${hp}/${maxHp} vigor=${vigor})`); } catch {}
        }
      }
      onDecision?.({ ticks, goal: active.goal, action: 'rest',
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
        // FLEE FORWARD when traveling: if the router is driving a route,
        // run toward its next hop, not the nearest exit behind us. Fleeing
        // backwards out of a gauntlet room means re-entering it; fleeing
        // forwards exits sooner (the 556 spider gauntlet proved this: flee
        // south = 50 squares chased, flee north = 20 to the door).
        // MANUAL LOCK: under an operator travel order, never retarget —
        // drive the manual route through (retargeting locks onto itself:
        // hop follows the flee, re-flees, loop). The mob may chew while
        // passing; direction holds regardless.
        try {
          const man = session?._manualDest;
          if (man != null && Date.now() - (man.at ?? 0) < 900000) {
            // HONOR THE MANUAL DEST EVEN IF THE FLEE RE-ROUTED IT. The old
            // check (man.dest === router.dest) only locked when they matched,
            // but the flee re-routes the router to the nearest exit (557) the
            // instant it fires, so the match never held and the manual order
            // (545) was silently abandoned. Re-route back to the manual dest
            // and drive it through; the mob may chew while passing.
            if (Number(router?.dest) !== Number(man.dest)) {
              router.to(Number(man.dest));
            }
            const r = routeIntent(router)(frame, act);
            onDecision?.({ ticks, goal: 'flee_danger', action: 'travel',
              what: `flee along manual route -> ${man.dest} (${r.what ?? r.why})`, sent: r.sent });
            return;
          }
          const exits = fleeExits(session, ws);
          // Never flee into a never-enter room (acid-gas shrine et al).
          // Prefer the route's next hop when traveling (flee forward).
          const hop = router?.leg?.next ?? null;
          const exit = (hop != null ? exits.find(e => e.to === hop && !hazardReason(e.to)) : null)
            ?? exits.find(e => !hazardReason(e.to)) ?? null;
          if (exit) {
            // FLEE/HUNT ALTERNATION FIX: if the router is already routing to a
            // destination that is NOT an exit (i.e., a hunt room), let the hunt
            // route survive. The character is already moving toward a safe room;
            // retargeting to an exit would overwrite the hunt route and cause
            // the flee→hunt→flee oscillation.
            const curDest = Number(router?.dest);
            const isExitDest = exits.some(e => e.to === curDest);
            if (!isExitDest && curDest !== 0) {
              // Already routing to a non-exit (hunt) destination: keep going.
              const r = routeIntent(router)(frame, act);
              onDecision?.({ ticks, goal: 'flee_danger', action: 'travel',
                what: `flee along existing route -> ${curDest} (${r.what ?? r.why})`, sent: r.sent });
              return;
            }
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

// FLEE EXITS (merged): live world.exits() drops real doors (watched: 382
// north, 557 north), which stranded flee-forward on the fallback. Gap-fill
// with the tick edge provider (map topology + baked approaches + witnessed
// crossings), deduped by destination. Pure-ish (reads session/world).
function fleeExits(session, ws) {
  let live = [];
  try { live = session?.world?.exits?.() ?? []; } catch {}
  let extra = [];
  try {
    extra = tickEdgeExits({
      map: session?._router?.map ?? loadMap(),
      roomNum: ws?._roomNum ?? session?.world?.room?.num ?? null,
      geo: session?.world?.geometry ?? null,
    }) ?? [];
  } catch {}
  if (!extra.length) return live;
  const seen = new Set(live.map(e => Number(e.to)));
  const out = [...live];
  for (const x of extra) {
    const to = Number(x.to);
    if (!Number.isFinite(to) || seen.has(to)) continue;
    seen.add(to);
    out.push({ to, direction: x.direction ?? x.leaveName ?? '?', stand_on: x.stand_on ?? null });
  }
  return out;
}
    // 2b2. FLEE HURT: hurt with a target in the room. Same
    // behavior as flee_danger: run for the nearest exit (route hop first).
    if (active?.goal === 'flee_hurt') {
      const router = session._router;
      if (router) {
        // MANUAL LOCK (same as flee_danger above): drive through.
        try {
          const man = session?._manualDest;
          if (man != null && Date.now() - (man.at ?? 0) < 900000) {
            if (Number(router?.dest) !== Number(man.dest)) {
              router.to(Number(man.dest));
            }
            const r = routeIntent(router)(frame, act);
            onDecision?.({ ticks, goal: 'flee_hurt', action: 'travel',
              what: `flee (hurt) along manual route -> ${man.dest} (${r.what ?? r.why})`, sent: r.sent });
            return;
          }
        } catch { /* fall through to exit flee */ }
        try {
          const exits = fleeExits(session, ws);
          const hop = router?.leg?.next ?? null;
          const exit = (hop != null ? exits.find(e => e.to === hop && !hazardReason(e.to)) : null)
            ?? exits.find(e => !hazardReason(e.to)) ?? null;
          if (exit) {
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
          const charLevel = maxHp;
          // Same formula as the GOAP keeper: policy.threatBand ?? floor(charLevel/2),
          // halved when unarmed. The ceiling is charLevel + band.
          const isArmed = ws.armed === true;
          const fullBand = policy?.threatBand ?? Math.floor(charLevel / 4);
          const band = isArmed ? fullBand : Math.floor(fullBand / 2);
          const ceiling = charLevel + band;
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
          const assigned = pol?.assignedRoom != null ? Number(pol.assignedRoom) : NaN;
          if (Number.isFinite(assigned) && assigned > 0) {
            const cands = huntRoomsAtOrBelow(charLevel, ceiling, charLevel - 2);
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
          // HOLD THE CHOSEN HUNT ROOM. If we previously picked a hunt room and the
          // character is still traveling to it (not yet arrived), don't re-pick —
          // re-picking every 2-5s is what causes the "moving and stopping, getting
          // eaten" behavior. The hold expires when the character arrives at the room
          // (hops=0) or after 10 minutes (stale hold).
          const held = session?._huntDestHold;
          if (held && Date.now() - held.at < 600000 && held.room !== resolved) {
            const heldCands = huntRoomsAtOrBelow(charLevel, ceiling, charLevel - 2).find(c => Number(c.room) === held.room);
            if (heldCands) {
              try {
                const r = findPath(map, resolved, heldCands.room, { danger: false });
                if (r?.found) {
                  hunt = { ...heldCands, hops: r.hops.length, path: r.hops.map(h => h.to), held: true };
                } else {
                  delete session._huntDestHold;
                }
              } catch {
                delete session._huntDestHold;
              }
            } else {
              delete session._huntDestHold;
            }
          }
          // HUNT RE-PICK FLOOR (B2): in addition to the 10-minute _huntDestHold
          // (cleared on arrival), do not re-pick a NEW hunt room for 2 minutes
          // after one was picked, as long as the previous room still qualifies.
          // Reuse the previous room if the floor has not elapsed; otherwise allow
          // the nearestHuntRoom re-pick and stamp _huntPickedAt.
          if (!hunt) {
            const _picked = session?._huntPickedAt;
            if (_picked && Date.now() - _picked.at < 600000) {
              const _pickedCands = huntRoomsAtOrBelow(charLevel, ceiling, charLevel - 2).find(c => Number(c.room) === _picked.room);
              if (_pickedCands) {
                try {
                  const r = findPath(map, resolved, _pickedCands.room, { danger: false });
                  if (r?.found) {
                    hunt = { ..._pickedCands, hops: r.hops.length, path: r.hops.map(h => h.to), held: true };
                  } else {
                    delete session._huntPickedAt;
                  }
                } catch {
                  delete session._huntPickedAt;
                }
              } else {
                delete session._huntPickedAt;
              }
            }
            if (!hunt) {
              hunt = nearestHuntRoom(resolved, charLevel, ceiling, charLevel - 2, session._pokeRelocate ? roomNum : undefined);
              if (session._pokeRelocate) session._pokeRelocate = false;
              // Stamp the re-pick floor when a NEW hunt room is picked (the
              // nearestHuntRoom path and the assigned fallback path, not the held
              // path). Only stamp when the room actually changed (or is first set)
              // so the floor starts when a new room is picked, not every tick.
              if (hunt) {
                const _prevPicked = session?._huntPickedAt;
                if (!_prevPicked || _prevPicked.room !== Number(hunt.room)) {
                  session._huntPickedAt = { room: Number(hunt.room), at: Date.now() };
                }
              }
            }
          }
          // ROUTE-DROP MEMORY (B1): the oscillation breaker (A2) dropped a route
          // between a room pair. While the drop is fresh (< 2 min) and the hunt
          // room or the current room is one of the ping-pong rooms, do not
          // re-march the same pair — it would just oscillate again. Find a hunt
          // room that avoids the pair; if none, hold in place (fight stays
          // enabled, B3).
          const rd = session?._routeDrop;
          if (rd && Date.now() - (rd.at ?? 0) < 120000 && Array.isArray(rd.rooms) && rd.rooms.length >= 2) {
            const rdRooms = rd.rooms.map(Number);
            const inPair = rdRooms.includes(Number(resolved)) || (hunt && rdRooms.includes(Number(hunt.room)));
            if (inPair) {
              const cands = huntRoomsAtOrBelow(charLevel, ceiling, charLevel - 2);
              const avoid = cands.find(c => !rdRooms.includes(Number(c.room)));
              if (!avoid) {
                onDecision?.({ ticks, goal: 'hunt', action: null,
                  what: `route dropped by oscillation breaker (${rdRooms.join('/')}); holding`, sent: false });
                return;
              }
              let altOk = false;
              try {
                const r = findPath(map, resolved, avoid.room, { danger: false });
                if (r?.found) { hunt = { ...avoid, hops: r.hops.length, path: r.hops.map(h => h.to) }; altOk = true; }
              } catch { /* alt unreachable: hold below */ }
              if (!altOk) {
                onDecision?.({ ticks, goal: 'hunt', action: null,
                  what: `route dropped (${rdRooms.join('/')}); alt hunt room ${avoid.room} unreachable; holding`, sent: false });
                return;
              }
            }
          }
          // MAX LEVEL DELTA: the mob's level should not be more than 12 above
          // the character's level. This matches the original ceiling formula
          // (level + floor(level/2)): for a lv24 character, the ceiling is
          // 24 + 12 = 36, so a lv35 mob is in band (35 ≤ 36). The max delta
          // of 12 allows the character to hunt mobs up to 12 levels above
          // their own, which is the game's own rule.
          const MAX_LEVEL_DELTA = 12;
          if (hunt && hunt.level > charLevel + MAX_LEVEL_DELTA) {
            onDecision?.({ ticks, goal: 'hunt', action: null,
              what: `hunt ${hunt.creature} lv${hunt.level} is too far above level ${charLevel} (max delta ${MAX_LEVEL_DELTA}); not entering`, sent: false });
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
            // Stamp the hunt-destination hold BEFORE the manual guard so it
            // survives re-picks. Without this, the manual guard returns
            // before the stamp, and the hold is never re-written.
            try {
              session._huntDestHold = { room: Number(hunt.room), at: Date.now() };
            } catch { /* a hold we cannot stamp is still a dest the router holds */ }
            // MANUAL LOCK: an operator travel order beats hunt-routing.
            // Only intercept when the operator's dest differs from the hunt room —
            // a matching dest means the operator confirmed the hunt destination, so
            // fall through to router.to + routeIntent (which actually sends packets).
            try {
              const man = session?._manualDest;
              if (man != null && Date.now() - (man.at ?? 0) < 900000
                  && Number(man.dest) !== Number(hunt.room)) {
                router.to(Number(man.dest));
                const r = routeIntent(router)(frame, act);
                onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                  what: `holding manual dest ${man.dest} (not routing to hunt room ${hunt.room})`, sent: r.sent });
                return;
              }
            } catch { /* fall through to hunt routing */ }
            router.to(hunt.room);
            // A HUNT JOURNEY IS A JOURNEY. Stamp it so travel mode covers it.
            //
            // `session._manualDest` is what puts a character in travel mode, and travel mode
            // is what stops `healthy` and `vigor_low` from sitting the character down mid-
            // crossing (see the two goal lambdas: `ws._travelMode === true ? false : ...`).
            // It was stamped ONLY by the operator's /action travel handler, so it described
            // "somebody told this character to go somewhere" and not "this character is on a
            // journey". A character hunting on its own initiative — which is every character,
            // every day — was never in travel mode, and so rested like one.
            //
            // Measured on one keeper process: `healthy->rest` was 369 of 595 decisions, the
            // single most-taken action in the whole decider. Twelve rest episodes, median 30
            // seconds each, 286 seconds sitting still while the router held a destination
            // three rooms away. The fleet's "moves, then pauses, then moves" is this.
            //
            // WHY THIS IS SAFE RATHER THAN MERELY FASTER. The yield was written so that a
            // hurt-rest stop mid-crossing is not mistaken for a stall (the comment on the
            // `healthy` goal says exactly that) — it was never a claim that resting is wrong.
            // Resting is still available: the goal ladder keeps `healthy` and `vigor_low`
            // below, and both fire the moment the character is IN its hunt room and not
            // traveling, which is where resting actually belongs. What changes is only that a
            // character does not sit down in the middle of a corridor between rooms.
            //
            // And the danger case is already handled by a different goal: `flee_hurt` fires
            // when HP is below the flee threshold WITH A TARGET IN REACH, and travel mode does
            // not suppress it (it is a motion goal). A character at 30% HP with a mob on top of
            // it still runs away. This only removes the reflex to sit down at 50% HP in an
            // empty room because the next room is two hops away.
            //
            // Same 15-minute freshness window the operator path uses, re-stamped on every
            // travel decision, so it cannot go stale while a journey is genuinely in progress
            // and does expire once the character stops asking to go anywhere.
            try {
              session._huntDest = { dest: Number(hunt.room), at: Date.now() };
            } catch { /* a dest we cannot stamp is still a dest the router holds */ }
            onDecision?.({ ticks, goal: 'hunt', action: 'travel',
              what: `hunt ${hunt.creature} lv${hunt.level} in room ${hunt.room} (hops=${hunt.hops})${hunt.held ? ' (held)' : ''}`,
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
            // Arrived at the hunt room: clear the hold so the next re-pick is free.
            if (session?._huntDestHold) delete session._huntDestHold;
            if (session?._huntDest) delete session._huntDest;
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
                const mr = mv.tickLogged(pos);
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
            // LOOT GROUND ITEMS WHILE PATROLLING: if the character has been
            // patrolling for a while without finding a valid target, check for
            // ground items (mushrooms, elderberries, etc.) and pick them up.
            // The existing lootFloor action is fire-and-forget with a 5s cooldown.
            if (session._lastPatrolLootAt == null || now - session._lastPatrolLootAt > 5000) {
              const roomNum = frame?.room?.num ?? frame?.room?.id ?? null;
              if (roomNum != null) {
                session._lastPatrolLootAt = now;
                session.lootFloor?.({ maxItems: 12 }).then(res => {
                  const taken = res?.taken?.length ?? 0;
                  if (taken) console.error(`[tick] ${session.name} looted ${taken} ground item(s) while patrolling`);
                }).catch(() => {});
              }
            }
            // NO TARGET FOR 30s: move to a different hunt room. The current
            // room may have stopped spawning valid targets (e.g. only living
            // trees, which are out of band). Leave so the room can reset,
            // or find a different room with valid targets.
            const _roomNum = resolveRoomNum(frame?.room ?? {}, session?.world?.map ?? null) ?? frame?.room?.num ?? frame?.room?.id ?? null;
            if (session._huntWaitRoom != null && _roomNum != null && session._huntWaitRoom !== _roomNum) {
              session._huntWaitStart = now; // reset on room change
              session._huntWaitRoom = _roomNum;
            }
            if (session._huntWaitStart == null) session._huntWaitStart = now;
            if (session._huntWaitRoom == null) session._huntWaitRoom = _roomNum;
            const waitMs = now - session._huntWaitStart;
            if (waitMs > 30000) {
              session._huntWaitStart = now; // reset the timer
              const roomNum = resolveRoomNum(frame?.room ?? {}, session?.world?.map ?? null) ?? frame?.room?.num ?? frame?.room?.id ?? null;
              if (roomNum != null) {
                const _cb = characterBand(client, session?.policy ?? policy, ws.armed === true);
                if (_cb == null) return; // vitals not ready
                const { charLevel, band: _band, ceiling: _ceiling } = _cb;
                const alt = nearestHuntRoom(roomNum, charLevel, _ceiling, charLevel - 2, roomNum);
                if (alt && alt.room !== roomNum) {
                  session._huntWaitStart = now;
                  if (router && router.dest == null) {
                    router.to(alt.room);
                    onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                      what: `no target 30s in room ${roomNum}; moving to ${alt.room} (${alt.creature} lv${alt.level})`, sent: true });
                    return;
                  }
                }
              }
            }
            if (me && mv && (session._lastHuntNudge == null || now - session._lastHuntNudge > 5000)) {
              // Nudge: a few squares in a random direction, retried until
              // the TARGET square is grounded (BSP floor present). The fine grid
              // marks wall squares as blocked even when the BSP floor is present,
              // which pins the character in a wait loop (observed for t1 at (11,34)).
              const geo = session?.world?.geometry;
              let nc = null, nr = null;
              const maxC = geo?.cols ?? 20;  // 1-based inclusive: room cols
              const maxR = geo?.rows ?? 15;  // 1-based inclusive: room rows
              for (let tries = 0; tries < 6; tries++) {
                const dx = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
                const dy = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
                const tc = Math.max(1, Math.min(maxC, me.col + dx));
                const tr = Math.max(1, Math.min(maxR, me.row + dy));
                // Use isGrounded (BSP floor) only, not fineWalkable (fine grid).
                // The fine grid marks wall squares as blocked even when the BSP
                // floor is present, which pins the character in a wait loop when
                // it is standing inside a wall (observed for t1 at (11,34)).
                if (isGrounded(geo, tr, tc) !== false) { nc = tc; nr = tr; break; }
              }
              if (nc != null) {
                _patrolTarget = { col: nc, row: nr };
                mv.to(nc, nr, { by: 'patrol' });
                const mr = mv.tickLogged(pos);
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
              const mr = mv.tickLogged(pos);
              const ours = _patrolTarget && preDest?.col === _patrolTarget.col && preDest?.row === _patrolTarget.row;
              onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                what: ours ? `patrolling hunt room (mover ${mr.state} -> ${_patrolTarget?.col},${_patrolTarget?.row})`
                            : `keeping mover ticking (dest ${preDest?.col},${preDest?.row} owned elsewhere)`,
                sent: mr.state === 'moving' || mr.state === 'raw-move' || mr.state === 'crossing' });
              return;
            }
            if (me && (session._lastHuntNudge == null || now - session._lastHuntNudge > 5000)) {
              // No tick mover (shouldn't happen): legacy fallback. Still never
              // nudge into a void the geometry can see. Try multiple squares
              // (same as the main path) so a single no-floor square does not
              // pin the character in a wait loop.
              const geoFb = session?.world?.geometry;
              const maxC = geoFb?.cols ?? 20;  // 1-based inclusive: room cols
              const maxR = geoFb?.rows ?? 15;  // 1-based inclusive: room rows
              let nc = null, nr = null;
              for (let tries = 0; tries < 6; tries++) {
                const dx = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
                const dy = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.floor(Math.random() * 3));
                const tc = Math.max(1, Math.min(maxC, me.col + dx));
                const tr = Math.max(1, Math.min(maxR, me.row + dy));
                // Use isGrounded (BSP floor) only, not fineWalkable (fine grid).
                // The fine grid marks wall squares as blocked even when the BSP
                // floor is present, which pins the character in a wait loop when
                // it is standing inside a wall (observed for t1 at (11,34)).
                if (isGrounded(geoFb, tr, tc) !== false) { nc = tc; nr = tr; break; }
              }
              if (nc != null) {
                _patrolTarget = { col: nc, row: nr };
                act.walk?.(nc, nr) ?? client?.moveToSquare?.(nc, nr, 18);
                session._lastHuntNudge = now;
                onDecision?.({ ticks, goal: 'hunt', action: 'travel',
                  what: `patrolling hunt room (nudge to ${nc},${nr})`, sent: true });
                return;
              }
              // No walkable nudge found: wait for a target without moving.
              onDecision?.({ ticks, goal: 'hunt', action: null,
                what: `patrol nudge: no walkable square in 6 tries; waiting`, sent: false });
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
      // or there's none in range. Return early — do NOT fall
      // through to the GOAP planner (it will be exhausted and
      // the goal will fail, which is what produces "exhausted
      // 115 nodes" every tick).
      onDecision?.({ ticks, goal: 'hunt', action: null,
        what: 'no hunt room in range; holding', sent: false });
      return;
    }

    if (!active) {
      try { console.error(`[goaldebug] idle: has_target=${ws.has_target} tib=${targetInBand(ws)} in_reach=${ws.in_reach} armed=${ws.armed} below_flee=${ws.below_flee} critical=${ws.critical} vigor_floor=${ws.vigor_floor} _travelMode=${ws._travelMode} _targetElevated=${ws._targetElevated} _traveling=${ws._traveling} _roomNum=${ws._roomNum} _maxHp=${ws._maxHp}`); } catch {}
      onDecision?.({ ticks, goal: null, why: 'nothing to do' }); return;
    }

    // 3. PLAN. Synchronous A* over an action set built from what this character has.
    // SELL BYPASS: the `sell` goal is not in the GOAP action set (the planner
    // can't plan it). Dispatch the `sell` intent directly, bypassing the
    // planner. The `sell` intent finds a trusted buyer in the room and sells
    // an item.
    if (active.goal === 'sell') {
      const res = INTENTS.sell(frame, act, { client: session._client ?? client, session });
      onDecision?.({ ticks, goal: 'sell', action: 'sell', what: res.what ?? null, why: res.why ?? null });
      return;
    }
    if (active.goal === 'armed' && ws._packWeapon === true) {
      const canConjure = spellNamed(client, 'create weapon') != null;
      if (Date.now() - (session?._lastConjureLogAt ?? 0) > 30000) {
        session._lastConjureLogAt = Date.now();
        console.error(`[conjure-check] ${session?.name ?? 'keeper'}: canConjure=${canConjure} spells=${JSON.stringify(knownSpells(client).map(s => s.name))}`);
      }
      if (Date.now() - (session?._lastArmedDiagAt ?? 0) > 10000) {
        session._lastArmedDiagAt = Date.now();
        const eq = client?.equipment?.();
        console.error(`[armed-diag] ${session?.name ?? 'keeper'}: ws.armed=${ws.armed} eq_count=${eq?.count ?? 'null'} eq_known=${eq?.known ?? 'null'}`);
      }
      const wieldable = pickWieldableWeapon(client, session);
      if (wieldable) {
        const res = INTENTS.equip(frame, act, { client: session._client ?? client, session, ws });
        onDecision?.({ ticks, goal: 'armed', action: 'equip', what: res.what ?? null, why: res.why ?? null });
        return;
      }
      // No wieldable weapon (broken or absent): fall through to conjure/buy.
      const now5 = now();
      if (canConjure && ws.has_mana === true && now5 - (session?._lastCreateWeaponAt ?? 0) > 30000) {
        if (session) session._lastCreateWeaponAt = now5;
        try { if (session) session._castingUntil = now5 + 5000; } catch {}
        const r = intend('cast create weapon', frame, act, { client, session, ws });
        note(active.goal, r.sent);
        onDecision?.({ ticks, goal: 'armed', action: 'cast create weapon', sent: r.sent,
                       what: r.what ?? null, why: r.why ?? null });
        return;
      }
      const r = intend('buy', frame, act, { client, session, ws });
      note(active.goal, r.sent);
      onDecision?.({ ticks, goal: 'armed', action: 'buy', sent: r.sent,
                     what: r.what ?? null, why: r.why ?? null });
      return;
    }
    const p = planFor(client, { [active.goal]: true }, { session, policy, ws });
    const first = p.found ? (p.names?.[0] ?? null) : null;

    // A GOAL THAT CANNOT BE PLANNED IS A FAILURE AND MUST COUNT AS ONE. The old keeper
    // returned before its failure counter on exactly this path, so the one outcome that
    // most clearly means "unreachable" was the only thing that could never retire a goal,
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
      const canConjure = spellNamed(client, 'create weapon') != null;
      if (canConjure && now5 - (session?._lastCreateWeaponAt ?? 0) > 30000) {
        if (session) session._lastCreateWeaponAt = now5;
        // Stamp the casting hold HERE (before any mover driving this tick),
        // not in castIntent after the move already broke concentration.
        try { if (session) session._castingUntil = now5 + 5000; } catch {}
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
                          patrolTarget: _patrolTarget,
                          ws: _ws });
  return decide;
}

// The fleet's ordinary ladder, as a default. Survival first, and every one of these is
// a REFUSAL-shaped condition rather than a weight: a cost can be outbid and a
// precondition cannot, which is the one rule docs/HANDOFF.md says must not be broken.
export const DEFAULT_GOALS = [
  { goal: '!in_underworld', when: ws => ws.in_underworld === true },
  { goal: 'armed',    when: ws => ws.armed === false && ws.is_caster !== true
                                 && (ws.has_wieldable_weapon === true || ws._gold > 0 || ws._canConjureWeapon === true) && ws._equipCooldown !== true },
  // FLEE first: if an out-of-band mob is IN REACH (actually threatening us), run before
  // anything else. The old condition fired on ANY out-of-band target (has_target &&
  // !target_in_band), which made the character FLEE from a passive mummy just because it
  // was out of the threat band — even when the mummy was far away and not attacking. That
  // broke basic movement: the character would "flee" (travel to another room) instead of
  // walking, and the flee conflicted with the stuck-detector, causing a blink loop. Now:
  // only flee when the out-of-band threat is in reach (actually a danger). An out-of-band
  // target that is NOT in reach is handled by the hunt goal (route to a better target or
  // approach it), not by fleeing.
  { goal: 'flee_danger', when: ws => ((ws.has_target === true && targetInBand(ws) === false && ws.in_reach === true) || ws._dangerClose != null || (ws._traveling === true && (ws._mobCount ?? 0) >= 3)) && ws._inHuntRoom !== true },
  // FLEE when hurt AND mobs are present — whether the target is in
  // reach (attacking you) or out of reach (chasing you). The old
  // `in_reach === true` requirement left a gap: low HP + chasing mob
  // out of reach matched no goal, so the character walked toward what
  // was killing it. Six characters died this way.
  { goal: 'flee_hurt', when: ws => ws.below_flee === true && (ws.has_target === true || (ws._mobCount ?? 0) > 0) },
  // POST-DEATH REST: after escaping the Underworld, rest until full HP and
  // vigor >= 80 before re-engaging. No time window — the gate stays active
  // until the character is fully rested. Placed below flee_danger/flee_hurt
  { goal: 'post_death_rest', when: ws => {
      const uw = ws._lastUnderworldAt;
      if (uw == null) return false;
      const hp = ws._hp, maxHp = ws._maxHp;
      const vigor = ws._vigor;
      if (hp != null && maxHp != null && hp < maxHp) return true;
      if (vigor != null && vigor < 80) return true;
      return false;
    } },
  // Rest when hurt, but only when there's no target in
  // the room. If a target is in reach, the flee_hurt or
  // _fight goal handles it. Parked in travel mode (motion-only: a
  { goal: 'healthy',  when: ws => {
      const hp = ws._hp, maxHp = ws._maxHp;
      const criticallyLow = hp != null && maxHp != null && (hp / maxHp) < 0.4;
      if (ws._travelMode === true && !criticallyLow) return false;
      return ws.hurt === true && ws.has_target !== true && (ws._pokeFailCount ?? 0) < 5;
    } },
  // Rest when vigor is low. Vigor IS health regeneration —
  // keeping it high keeps HP topping up. Rest below 60 to
  // maintain a buffer, but this is lower priority than
  // _fight so a character will still engage a target that's
  // in reach even at 40 vigor.
  { goal: 'vigor_low', when: ws => {
      // walks at speed 18 below RUN_VIGOR_FLOOR, so travel continues at
      // any vigor; rest happens on arrival. (Without this, the
      // rest/stand/step flap both stalls the run AND trips the stuck
      // detector into abandoning it.)
      if (ws._travelMode === true) return false;
      const v = ws._vigor;
      // ABSOLUTE thresholds, deliberately: rest recovers only to ~80
      // regardless of max vigor (food carries it to the max — 200 for
      // JayB), so a max-relative clear-point would sit above the rest
      // ceiling and latch critical-rest on for the character's life.
      // CRITICAL HYSTERESIS: once exhaustion (<30) forces rest, hold it
      // until 60 — otherwise rest exits at 30, moving resumes, drains to
      // 29, and the character flaps at the boundary forever (watched).
      // NOTE: this lambda runs at module scope (DEFAULT_GOALS) — `session`
      // is NOT visible here (ReferenceError kills the whole tick). The
      // flag is maintained on session in section 1 and mirrored to ws.
      const crit = ws?._criticalRest === true;
      // YIELD when the character is moving (the router has a destination).
      // Resting would stop the movement. The character can rest when he
      // arrives (the router clears the destination). EXCEPT below the
      // critical floor (30): an exhausted character that keeps walking never
      // recovers (rest starves) and crawls forever — rest preempts travel by
      // ladder order (vigor_low sits above hunt). Crossing/in-reach yields
      // stay even when critical (never sit in a doorway or under an attacker).
      if (ws._moving && !crit && (v == null || v >= 30)) return false;
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
  { goal: '_fight',   when: ws => ws._travelMode !== true
                                 && ws.has_target === true && targetInBand(ws) === true
                                 && ws.critical !== true
                                && (ws.hurt === true || ws.vigor_floor !== false)
                                && ws.below_flee !== true
                                 // different elevation (unreachable).
                                 && ws._targetElevated !== true
                                 && (ws._traveling !== true || ws.in_reach === true) },
  { goal: 'sell',     when: ws => {
      // gold. Gated on the observation (evidence), not on holdings (inference).
      // Requires ws.armed === false so a rich armed character in the buyer
      // room is not compelled to sell.
      const roomNum = ws._roomNum;
      if (roomNum != null && roomNum === 202
          && ws._brokeUntil === true
          && ws._hasReagents === true) {
      return false;
      }
      return false;
    } },
  { goal: 'armed',    when: ws => ws.armed === false && ws.is_caster !== true
                                 && (ws.has_wieldable_weapon === true || ws._gold > 0 || ws._canConjureWeapon === true) && ws._equipCooldown !== true },
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
      // Fire when: no target (find one), target over-level (find better),
      // OR target in-band but not in reach (approach it).
      return ws.has_target === false || targetInBand(ws) === false
        || (ws.has_target === true && targetInBand(ws) === true && ws.in_reach === false);
    } },
  { goal: 'vigor_ok', when: ws => ws.vigor_ok === false && ws.has_food === true
                                 && ws.has_target !== true },
  { goal: 'has_food', when: ws => ws.has_food === false && ws.has_reagents === true },
];
