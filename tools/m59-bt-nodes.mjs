#!/usr/bin/env node
// m59-bt-nodes.mjs -- behavior tree node factories wired from keeper internals.
//
// The primitives in m59-bt.mjs are pure tree mechanics. This file is where the
// trees become meaningful: each leaf here reads the live Meridian 59 client /
// session on every tick, and each action delegates to an existing keeper
// method so the policy surface stays in one place.
//
// Factories return BT nodes (Condition / Action / Sequence / Selector from
// m59-bt.mjs). Each factory takes the minimal references it needs:
//
//   - Conditions read from bb.client (the live MeridianClient). The blackboard
//     is the contract: trees see the world through it and never reach behind
//     it for live state.
//   - Actions call keeper methods, with the keeper passed in explicitly so
//     these nodes are testable against a mock keeper in unit tests.
//
// THE GET-ARMED SUBTREE (proof of concept -- see docs/BT-PLAN.md).
//
// The previous keeper loop waited forever for mana to cast create_weapon even
// when the character did not know the spell. The selector below falls through
// to travel_and_buy immediately in that case:
//
//     Selector
//       Condition: wielding_weapon           (bb.client.armed())
//       Sequence:   equip_from_pack
//                   Condition: weapon_in_inventory
//                   Action:    equip_best
//       Sequence:   conjure_weapon
//                   Condition: knows_create_weapon   <-- fails fast if absent
//                   Condition: mana >= 15
//                   Action:    cast_create_weapon
//       Action:     travel_and_buy                  (walks to nearest smith)
//
// The conjure_weapon sequence fails on its first tick when knows_create_weapon
// is false. That failure propagates up through its parent sequence and into
// the outer selector, which advances to travel_and_buy. No waiting, no loop.

import {
  Condition, Action, Sequence, Selector,
  selector, sequence,
  SUCCESS, FAILURE, RUNNING,
} from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Pull a numeric mana reading off the blackboard, returning 0 when unknown.
// The keeper logs vitals as {value, max}; while the broker is reconnecting
// that object is null and any defensive code that treats null as "no mana"
// would loop the whole fleet through conjure_weapon until it burned out.
function _mana(bb) {
  const v = bb?.client?.vitals?.()?.mana?.value;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
}

// True when the live client's spell list contains "create weapon". Names are
// resolved through the rsc table the same way the keeper does it; the lookup
// is case-insensitive to mirror the existing behaviour in m59-autopilot.mjs.
function _knowsCreateWeapon(bb) {
  const c = bb?.client;
  if (!c) return false;
  return !!(c.spells || []).find(
    sp => (c.rsc?.get?.(sp.nameRsc) || '').toLowerCase() === 'create weapon');
}

// True when the inventory carries at least one weapon. Matches the shape of
// skills.weaponsOf(c) but is duplicated here so this file is self-contained
// and does not import m59-skills.mjs at module load time (skills pulls in
// m59-client and a lot of network code, which would defeat offline tests).
export function _hasWeaponInInventory(bb) {
  const c = bb?.client;
  if (!c) return false;
  const inv = c.inventory || [];
  for (const o of inv) {
    const name = (c.rsc?.get?.(o.nameRsc) || '').toLowerCase();
    // Any of these classes is enough to swing at a monster. The list mirrors
    // the weapon-name regex set the keeper uses elsewhere; if a new weapon
    // class is added it should land in both places in the same commit.
    if (/(mace|sword|axe|hammer|staff|bow|dagger|spear|halberd|scimitar|wand|fang|claws|talisman)/i
          .test(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Condition factories
// ---------------------------------------------------------------------------

// wielding_weapon: true when the live client reports it is already armed.
// Reads bb.client.armed() -- the same predicate the keeper has used for years
// to decide whether the empty hand needs filling. Pass-through on the use
// list's "cannot answer" case (armed() returns true then), which is the
// right default for a fight reflex but would be wrong for leaving safety;
// the BT here is only ticked after a hibernate_until_whole sequence, by
// which time the use list is populated.
export function wieldingWeaponCondition() {
  return new Condition(bb => !!(bb.client && bb.client.armed && bb.client.armed()));
}

// weapon_in_inventory: true when the pack contains something wieldable.
// Used inside the equip_from_pack sequence to skip the cast when we already
// have the weapon we need on us.
export function weaponInInventoryCondition() {
  return new Condition(bb => _hasWeaponInInventory(bb));
}

// knows_create_weapon: true when the spell is in the live spell list. THIS
// is the predicate whose absence caused the overnight failure. When it is
// false, conjure_weapon must fail immediately -- on the very first tick --
// so the outer selector falls through to travel_and_buy. A condition that
// ever returns RUNNING here, or one that tries to wait for mana first, would
// recreate the original bug at a higher level of abstraction.
export function knowsCreateWeaponCondition() {
  return new Condition(bb => _knowsCreateWeapon(bb));
}

// mana >= 15: mirrors the hard floor on create_weapon in m59-autopilot.mjs
// (the spell refuses silently below 15, so the check is on mana BEFORE the
// cast, not on the absence of an item after it). Returns SUCCESS when mana
// is at least the floor, FAILURE otherwise. Never RUNNING -- a character
// that cannot yet cast will simply fail this tick and be reticked later by
// the surrounding sequence, at which point the predicate is re-read.
export function manaAtLeastCondition(threshold = 15) {
  return new Condition(bb => _mana(bb) >= threshold);
}

// ---------------------------------------------------------------------------
// Action factories
// ---------------------------------------------------------------------------

// equip_best: wraps keeper.armSelf or, failing that, skills.equipBest. The
// factory accepts the keeper so unit tests can pass a mock that records calls
// and resolves with a fixed result. The action is synchronous from the BT's
// point of view: on the first tick it kicks off the equip and returns RUNNING.
// The promise's eventual status is stored on the slot so the next tick can resolve
// to SUCCESS or FAILURE.
//
// IMPORTANT: the fn returns RUNNING synchronously. If it returned the promise
// directly, m59-bt.mjs's Action.tick would intercept the promise and replace
// our slot with `{promise: out}`, breaking the "read slot.done next tick"
// pattern. Run fire-and-forget side effects via .then() instead.
export function equipBestAction(keeper) {
  const key = 'bt_equip_best';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false, error: null };
      bb._bt[key] = slot;
      Promise.resolve()
        .then(() => (typeof keeper.armSelf === 'function'
                       ? keeper.armSelf('BT: equip from pack')
                       : (typeof keeper.equipBest === 'function'
                            ? keeper.equipBest()
                            : Promise.resolve(false))))
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(err => { slot.error = err; slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    // Subsequent tick: report what happened. Clear the slot so a retry of the
    // surrounding sequence (via Retry, etc.) starts clean.
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'equip_best' });
}
// Hoist the action key onto the factory so tests can find / clear the slot
// without holding a reference to the constructed action.
equipBestAction._key = 'bt_equip_best';

// cast_create_weapon: wraps keeper.makeWeapon (which stands the character up,
// checks mana, requests the spell list, casts, and verifies the weapon landed
// before equipBest runs). Returns RUNNING while the cast is in flight, then
// SUCCESS if a weapon appeared in the inventory, FAILURE otherwise. The
// keeper already does the mana and spell checks; the BT only guards against
// the case the keeper's "wait for mana" branch used to spin on forever, and
// that guard lives in the conjure_weapon SEQUENCE's conditions.
export function castCreateWeaponAction(keeper) {
  const key = 'bt_cast_create_weapon';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false, error: null };
      bb._bt[key] = slot;
      Promise.resolve()
        .then(() => (typeof keeper.makeWeapon === 'function'
                       ? keeper.makeWeapon('BT: conjure weapon')
                       : Promise.resolve(false)))
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(err => { slot.error = err; slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'cast_create_weapon' });
}
castCreateWeaponAction._key = 'bt_cast_create_weapon';

// travel_and_buy: walks the character to the nearest smith and buys the
// cheapest weapon the smith has in stock. Delegates to keeper.buyWeaponsAtNearestSmith,
// which spawns m59-outfit.mjs as a child process — the same mechanism the broker
// uses for ability buying. The outfit script stops the keeper, walks to the smith,
// buys, then restarts the keeper. Returns SUCCESS when the character is armed afterwards.
export function travelAndBuyAction(keeper) {
  const key = 'bt_travel_and_buy';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false, error: null };
      bb._bt[key] = slot;
      Promise.resolve()
        .then(() => {
          if (typeof keeper.buyWeaponsAtNearestSmith === 'function')
            return keeper.buyWeaponsAtNearestSmith({ why: 'BT: travel and buy' });
          return false;
        })
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(err => { slot.error = err; slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'travel_and_buy' });
}
travelAndBuyAction._key = 'bt_travel_and_buy';

// ---------------------------------------------------------------------------
// Subtree factories
// ---------------------------------------------------------------------------

// equip_from_pack: a sequence that only succeeds when the pack contains a
// weapon AND we can equip it. The two-step gate keeps the BT honest: a pack
// with no weapons falls through to the next selector arm, and a pack with a
// broken weapon that equipBest refuses falls through too.
export function equipFromPackSequence(keeper) {
  return sequence(
    weaponInInventoryCondition(),
    equipBestAction(keeper),
  );
}

// conjure_weapon: a sequence whose FIRST condition is knows_create_weapon.
// This is the fix: a character that does not know the spell fails this
// sequence on its very first tick, which propagates up through the outer
// selector and lands on travel_and_buy. There is no "wait for mana" branch
// here, because the previous bug was the wait branch itself.
export function conjureWeaponSequence(keeper) {
  return sequence(
    knowsCreateWeaponCondition(),
    manaAtLeastCondition(15),
    castCreateWeaponAction(keeper),
  );
}

// get_armed: the proof-of-concept subtree. Tries each arm in priority order:
//
//   1. Already wielding a weapon -> SUCCESS, nothing to do.
//   2. A weapon in the pack -> equip it.
//   3. Knows create weapon AND has 15 mana -> conjure one.
//   4. Otherwise -> walk to a smith and buy the cheapest one.
//
// arms 2 and 3 are sequences, so they fail (and fall through) the moment any
// one of their conditions is false. Arm 4 is unconditional -- it is the
// thing that was missing overnight, when characters without the spell sat
// forever waiting for mana to arrive.
//
// Pass `{ keeper }` (or both `{ session, keeper }` if the keeper is reached
// via a session object) and tick the returned tree against a blackboard
// shaped like `{ client, session }`.
export function getArmedTree(opts = {}) {
  const keeper = opts.keeper || opts.session?.keeper;
  if (!keeper) {
    throw new Error('getArmedTree requires opts.keeper (or opts.session.keeper)');
  }
  return selector(
    wieldingWeaponCondition(),
    equipFromPackSequence(keeper),
    conjureWeaponSequence(keeper),
    travelAndBuyAction(keeper),
  );
}

// ---------------------------------------------------------------------------
// THREAT / SURVIVAL SUBTREE
//
// Covers the same ground as passFleeAndRest() in m59-autopilot.mjs. The BT
// version adds no new logic — it delegates every decision to the existing
// keeper methods so the proven combat code stays in one place and is tested
// by the same 383 m59-combat-test.mjs cases.
//
// Shape:
//
//   handleThreat
//     Selector
//       Condition: not_in_danger          (nothing adjacent and hp fine)
//       Sequence: doomed_response
//           Condition: is_doomed          (at doomedAt threshold with threats adjacent)
//           Action:    handle_doom        (playDead or townTripIfCornered, per keeper)
//       Sequence: flee_response
//           Condition: should_flee        (hp < fleeBelow with threats near)
//           Action:    do_flee            (retreatToSafety or break-off-in-spot)
//       Action: rest_and_recover          (passFleeAndRest rest branch, always runs)
//
// The last arm always returns SUCCESS so the tree does not fall through into
// the farm path while the character is recovering. SUCCESS here means "threat
// situation handled for this tick" — which for the rest branch means "resting
// or nothing needs doing right now."
//
// The whole tree is synchronous from the caller's perspective. Each action
// fires keeper async methods as fire-and-forget (via the slot pattern) and
// returns RUNNING while they complete, identical to how getArmedTree works.
// ---------------------------------------------------------------------------

import { OF } from './m59-parse.mjs';

// -- Condition helpers -------------------------------------------------------

// Read the live threat picture off the blackboard the same way passFleeAndRest
// does: adjacent attackable non-player objects. The bb.client is the live
// MeridianClient; bb.session is the keeper (an Autopilot instance).
function _nearThreats(bb) {
  const c = bb?.client;
  const me = c?.self;
  if (!c || !me) return [];
  return [...(c.room?.objects?.values?.() ?? [])].filter(o =>
    o.id !== c.selfId &&
    (o.flags & OF.ATTACKABLE) &&
    !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 2);
}

function _healthPct(bb) {
  const v = bb?.client?.vitals?.();
  if (!v?.health?.max) return null;
  return v.health.value / v.health.max;
}

function _isDoomedAt(bb) {
  const keeper = bb?.session;
  const c = bb?.client;
  const v = c?.vitals?.();
  const near = _nearThreats(bb);
  if (!near.length || !v?.health?.value) return false;
  const max = v.health.max ?? 0;
  const sheltered = keeper?.holdWorks?.() ?? false;
  const doomedAt = keeper?.hold
    ? Math.round(max * ((keeper.policy?.doomedInSpotBelow ?? 0.35)))
    : Math.min(30, Math.floor((max + 2) / 3)) * 2;
  return v.health.value <= doomedAt;
}

// -- Condition factories -----------------------------------------------------

// not_in_danger: SUCCESS when hp is fine AND nothing attackable is adjacent.
// When this succeeds the whole handleThreat selector returns SUCCESS immediately
// and the pass carries on to farm/errand.
export function notInDangerCondition() {
  return new Condition(bb => {
    const hp = _healthPct(bb);
    const keeper = bb?.session;
    if (hp === null) return true;              // can't read vitals: assume safe
    const fleeBelow = keeper?.policy?.fleeBelow ?? 0.5;
    const near = _nearThreats(bb);
    return hp >= fleeBelow && !near.length;
  });
}

// is_doomed: SUCCESS when below the doom threshold with threats adjacent.
export function isDoomedCondition() {
  return new Condition(bb => _isDoomedAt(bb));
}

// should_flee: SUCCESS when hp < fleeBelow AND threats are adjacent.
// Gated AFTER is_doomed so the flee branch only runs when not already doomed.
export function shouldFleeCondition() {
  return new Condition(bb => {
    const hp = _healthPct(bb);
    if (hp === null) return false;
    const keeper = bb?.session;
    const fleeBelow = keeper?.policy?.fleeBelow ?? 0.5;
    return hp < fleeBelow && _nearThreats(bb).length > 0;
  });
}

// -- Action factories --------------------------------------------------------

// handle_doom: delegates to keeper.playDead (if sheltered) or
// keeper.townTripIfCornered. The keeper methods already contain the full
// decision tree about which is appropriate. Returns SUCCESS when the keeper
// handled the doom (returned true), FAILURE if it could not.
export function handleDoomAction(keeper) {
  const key = 'bt_handle_doom';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const k = keeper ?? bb?.session;
      const c = bb?.client;
      const v = c?.vitals?.() ?? {};
      const near = _nearThreats(bb);
      const sheltered = k?.holdWorks?.() ?? false;
      Promise.resolve()
        .then(() => {
          if (!k) return false;
          if (sheltered) {
            const label = 'at ' + (v.health?.value ?? '?') + ' health with ' +
                          near.length + ' adjacent, behind a wall that holds';
            return typeof k.playDead === 'function' ? k.playDead(label) : false;
          }
          if (typeof k.townTripIfCornered === 'function') {
            k.note?.('hurt in the open — running for a town rather than playing dead', {
              health: v.health?.value, adjacent: near.length,
              why: 'a freeze recovers no health and leaves us exactly where we were' });
            k.doing = 'travelling';
            return k.townTripIfCornered().catch(() => false);
          }
          return false;
        })
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(() => { slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'handle_doom' });
}
handleDoomAction._key = 'bt_handle_doom';

// do_flee: delegates to keeper.retreatToSafety (open floor) or records a
// mulligan and breaks off without moving (sheltered). Mirrors the two branches
// in passFleeAndRest exactly.
export function doFleeAction(keeper) {
  const key = 'bt_do_flee';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const k = keeper ?? bb?.session;
      const c = bb?.client;
      const v = c?.vitals?.() ?? {};
      const near = _nearThreats(bb);
      const hp = _healthPct(bb);
      const sheltered = k?.holdWorks?.() ?? false;
      Promise.resolve()
        .then(() => {
          if (!k) return false;
          if (sheltered) {
            k.tally.mulligans = (k.tally.mulligans || 0) + 1;
            k.note?.('breaking off without moving', {
              health: hp === null ? null : Math.round(hp * 100) + '%',
              crowd: near.length,
              where: k.hold ? { col: k.hold.col, row: k.hold.row } : null,
              why: 'we are in a spot that has held under attack, so nothing can hit us unless we ' +
                   'swing first. Stopping is the whole withdrawal.' });
            return true;
          }
          k.tally.withdrawals = (k.tally.withdrawals || 0) + 1;
          k.note?.('running for safety', {
            health: hp === null ? null : Math.round(hp * 100) + '%',
            from: near.map(o => c.rsc?.get?.(o.nameRsc)),
            why: 'below the flee threshold in the open' });
          return typeof k.retreatToSafety === 'function'
            ? k.retreatToSafety({
                because: 'below the flee threshold in the open',
                from: near.map(o => c.rsc?.get?.(o.nameRsc)),
              })
            : false;
        })
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(() => { slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'do_flee' });
}
doFleeAction._key = 'bt_do_flee';

// rest_and_recover: delegates passFleeAndRest's rest + settle + safe-spot-seek
// to the keeper. This is the always-runs arm — it handles settle-on-entry,
// safe-spot seeking when hurt, and actual resting. Always returns SUCCESS to
// signal "threat tick consumed" so the pass does not fall through to farm.
// When the keeper has nothing to do it returns quickly.
export function restAndRecoverAction(keeper) {
  const key = 'bt_rest_and_recover';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false };
      bb._bt[key] = slot;
      const k = keeper ?? bb?.session;
      const c = bb?.client;
      const s = k?.s;
      const room = s?.world?.room ?? null;
      const v = c?.vitals?.() ?? {};
      const hp = _healthPct(bb);
      Promise.resolve()
        .then(() => {
          if (!k || typeof k.passFleeAndRest !== 'function') return;
          // Delegate only the rest/settle half — flee/doom are handled above.
          // We pass the same args passFleeAndRest receives; it will return early
          // on the flee/doom branches because those conditions are no longer met
          // (the arms above handled them).
          return k.passFleeAndRest(s, c, room, v, hp);
        })
        .then(() => { slot.done = true; })
        .catch(() => { slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    delete bb._bt[key];
    return SUCCESS;   // always: "we handled the threat pass for this tick"
  }, { key, name: 'rest_and_recover' });
}
restAndRecoverAction._key = 'bt_rest_and_recover';

// -- Subtree factory ---------------------------------------------------------

// handleThreatTree: the threat/survival subtree.
//
// Pass `{ keeper }` (the Autopilot instance). Tick against a blackboard shaped
// like { client, session } where session IS the keeper.
//
// Returns:
//   SUCCESS  — no threat, or threat handled (character is resting / fleeing)
//   RUNNING  — an async keeper method is in flight (flee, doom, rest)
//   FAILURE  — should never happen; the rest_and_recover arm always succeeds
export function handleThreatTree(opts = {}) {
  const keeper = opts.keeper ?? opts.session?.keeper;
  if (!keeper) {
    throw new Error('handleThreatTree requires opts.keeper (or opts.session.keeper)');
  }
  return selector(
    notInDangerCondition(),
    sequence(
      isDoomedCondition(),
      handleDoomAction(keeper),
    ),
    sequence(
      shouldFleeCondition(),
      doFleeAction(keeper),
    ),
    restAndRecoverAction(keeper),
  );
}

// ---------------------------------------------------------------------------
// FARM NAVIGATION SUBTREE
//
// Covers the "navigate to the right prey room" decision extracted from
// passFarm() into keeper.navigateToPreyRoom(). The BT version is a single
// Action that delegates entirely to that method — no routing logic lives here.
//
// Shape:
//
//   farmNavigation
//     Selector
//       Condition: in_prey_room      (prey spawns here AND on assignment)
//       Action:    navigate_to_prey  (calls keeper.navigateToPreyRoom)
//
// The selector's first arm short-circuits when we are already in a good room
// so the action is not called on every pass. The action returns:
//   SUCCESS  — travel completed (arrived at the target room)
//   RUNNING  — travel is in flight
//   FAILURE  — no known room generates the prey (no known path)
// ---------------------------------------------------------------------------

// navigate_to_prey: delegates to keeper.navigateToPreyRoom(room).
// Returns SUCCESS when travel arrived, FAILURE when no room is reachable,
// RUNNING while travelling.
export function navigateToPreyAction(keeper) {
  const key = 'bt_navigate_to_prey';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, travelled: false, arrived: false };
      bb._bt[key] = slot;
      const k = keeper ?? bb?.session;
      const room = k?.s?.world?.room ?? null;
      Promise.resolve()
        .then(() => {
          if (!k || typeof k.navigateToPreyRoom !== 'function') return { consumed: false };
          return k.navigateToPreyRoom(room).then(consumed => ({ consumed }));
        })
        .then(({ consumed }) => {
          slot.consumed = consumed;
          slot.done = true;
        })
        .catch(() => { slot.consumed = false; slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const consumed = slot.consumed;
    delete bb._bt[key];
    // consumed=true: the method handled this pass (travelling or blocked). Map to SUCCESS
    // so the farm loop does not also try to fight this tick.
    // consumed=false: already in the right room. Map to FAILURE so the selector falls
    // through and the fight branch runs.
    return consumed ? SUCCESS : FAILURE;
  }, { key, name: 'navigate_to_prey' });
}
navigateToPreyAction._key = 'bt_navigate_to_prey';

// farmNavigationTree: the room-navigation subtree.
//
// Returns SUCCESS when a travel pass was consumed (moving to the right room).
// Returns FAILURE when we are already in a suitable room (caller should fight).
// Returns RUNNING while travel is in flight.
//
// The navigateToPreyAction encodes both outcomes: it delegates to
// keeper.navigateToPreyRoom() which returns false when the room is already
// right (→ FAILURE here, meaning "no navigation needed, proceed") and true
// when it consumed the pass (→ SUCCESS, meaning "this tick was spent travelling").
export function farmNavigationTree(opts = {}) {
  const keeper = opts.keeper ?? opts.session?.keeper;
  if (!keeper) {
    throw new Error('farmNavigationTree requires opts.keeper (or opts.session.keeper)');
  }
  return navigateToPreyAction(keeper);
}

// ---------------------------------------------------------------------------
// FIGHT SUBTREE
//
// Wraps keeper.passFightRounds() as a BT action. The fight loop is deeply
// stateful — it maintains this.hold, this.foeId, this.pendingPull, quarry
// claims, the vigor/health gates, safe-spot probing, pull-and-wait sequences,
// and party coordination. All of that state lives on the keeper where it is
// proven by the 471 combat tests. The BT node fires it fire-and-forget,
// returns RUNNING while it runs, and maps its completion to SUCCESS (fight
// pass consumed) or FAILURE (nothing to do — no hunt named).
//
// Shape:
//   fight_rounds (Action)
//     → delegates to keeper.passFightRounds(s, c, room, v, hp)
//     → returns RUNNING while in flight
//     → returns SUCCESS when the pass was consumed (found prey, cleared bags,
//       rested, probed wall, swung, etc.)
//     → returns FAILURE when no hunt is named (idling)
// ---------------------------------------------------------------------------

// fight_rounds: wraps keeper.passFightRounds. The keeper receives the
// session + client from its own fields (s, s.client); this node pulls them
// off `bb.session` (which IS the keeper / Autopilot instance).
export function fightRoundsAction(keeper) {
  const key = 'bt_fight_rounds';
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const k = keeper ?? bb?.session;
      Promise.resolve()
        .then(async () => {
          if (!k || typeof k.passFightRounds !== 'function') return false;
          const s = k.s;
          const c = s?.client;
          if (!s || !c) return false;
          const v = c.vitals?.() ?? {};
          const hp = (v.health?.max ? v.health.value / v.health.max : null);
          const room = s.world?.room ?? null;
          await k.passFightRounds(s, c, room, v, hp);
          // passFightRounds returns undefined; success is "we ran it"
          return !!(k.policy?.hunt);
        })
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(() => { slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'fight_rounds' });
}
fightRoundsAction._key = 'bt_fight_rounds';

// updateBlackboard: a thin convenience that snapshots the live client into a
// plain blackboard object before each tick. Trees should never reach behind
// `bb.client` for state, but GOAP writes strategic fields (assigned_room,
// purpose, etc.) here so a single helper can rebuild the snapshot in one
// place.
export function updateBlackboard(bb, { client, session, policy } = {}) {
  if (!bb) return bb;
  if (client !== undefined) bb.client = client;
  if (session !== undefined) bb.session = session;
  if (policy !== undefined) bb.policy = policy;
  if (!bb._bt) bb._bt = {};
  return bb;
}
