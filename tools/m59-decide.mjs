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
import { nearestHuntRoom } from './m59-hunt-room.mjs';
import { loadSpawns } from './m59-spawns.mjs';
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
        const dest = 1013;  // Raza Blacksmith — where the smith sells weapons
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
    let portal = null, bestDist = Infinity;
    if (objects instanceof Map) {
      for (const o of objects.values()) {
        const name = c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
        if (/portal/i.test(name) && o.col != null) {
          const d = Math.hypot(o.col - me.col, o.row - me.row);
          if (d < bestDist) { bestDist = d; portal = o; }
        }
      }
    }
    if (!portal) return { sent: false, why: 'no portal in room' };
    // Walk toward the portal (one step per tick via the actuator).
    act.step(portal.col, portal.row);
    return { sent: true, what: `escape: walk to portal at (${portal.col},${portal.row})` };
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
                c.cast(blink.id, [])
                  .then?.(() => { try { c.waitFor?.({ since, kinds: ['moved'], timeoutMs: BLINK_MS }).then(() => unfreeze()).catch(() => unfreeze()); } catch { unfreeze(); } })
                  .catch?.(() => unfreeze());
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
          let creatureNames = new Set();
          try {
            const spawns = loadSpawns(SPAWNS_FILE);
            if (spawns?.byMonster) {
              for (const name of Object.keys(spawns.byMonster)) {
                creatureNames.add(name.toLowerCase());
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
            // Resolve the name from nameRsc
            const objName = String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
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
          session.lootFloor?.({ maxItems: 12 }).then(res => {
            const taken = res?.taken?.length ?? 0;
            if (taken) console.error(`[tick] ${agentName} looted ${taken} item(s) after kill`);
          }).catch(e => console.error(`[tick] ${agentName} loot err: ${e.message}`));
        }
      }
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
    if (active.goal === 'armed' && first === 'equip'
        && pickWeapon(client) != null && !pickWieldableWeapon(client, session)) {
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
  { goal: '_fight',   when: ws => ws.has_target === true && ws.target_in_band === true
                                 && ws.critical !== true
                                 && (ws.hurt === true || ws.vigor_floor !== false)
                                 // Don't fight if the target is on a
                                 // different elevation (unreachable).
                                 && ws._targetElevated !== true },
  { goal: 'armed',    when: ws => ws.armed === false },
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
