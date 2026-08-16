#!/usr/bin/env node
// m59-bt-atomics.mjs -- atomic BT action nodes for the Meridian 59 keeper.
//
// Each factory returns an Action with two extra properties:
//
//   .pre     string[]   world-state keys that must be true before this runs
//   .effects string[]   world-state keys this action sets (or clears with "!")
//
// These are used by the GOAP planner to build plans without running anything.
// The Action itself can be ticked directly by a BT executor.
//
// World-state keys (bb.ws):
//   armed               bool   — weapon in plUsing
//   resting             bool   — character is seated/resting
//   in_sanctuary        bool   — current room is an inn / safe zone
//   item_on_floor(id)   bool   — item with that id is in the room
//   holding(id)         bool   — item is in inventory
//   equipped(id)        bool   — item is in plUsing
//   at_square(col,row)  bool   — character stands on that grid square
//   has_target          bool   — a valid attackable foe is selected
//   target_dead         bool   — selected foe is no longer in the room

import { Action, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import * as skills from './m59-skills.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _ws(bb) {
  if (!bb.ws) bb.ws = {};
  return bb.ws;
}

function _client(bb) { return bb.client ?? bb.session?.s?.client ?? null; }
function _session(bb) { return bb.session?.s ?? null; }

// ---------------------------------------------------------------------------
// EquipWeaponAction
//
// Picks the best weapon from inventory and wields it via skills.equipBest.
// Pre:  character has at least one weapon in pack
// Post: armed = true
// ---------------------------------------------------------------------------
export function EquipWeaponAction(opts = {}) {
  const key = 'at_equip_weapon';
  const priority = opts.priority ?? null;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          if (!skills.weaponsOf(c).length) return false;
          const eq = await skills.equipBest(s, { priority }).catch(() => null);
          return !!eq?.wielding;
        })
        .then(ok => {
          _ws(bb).armed = ok;
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
  }, { key, name: 'equip_weapon' });

  node.pre     = [];              // caller should gate on weaponsOf(c).length via Condition
  node.effects = ['armed'];
  return node;
}
EquipWeaponAction._key = 'at_equip_weapon';

// ---------------------------------------------------------------------------
// WearArmourAction
//
// Puts on the best available armour from inventory for each slot.
// Pre:  armour in inventory that is not yet equipped
// Post: equipped(armourId) for each piece worn
// ---------------------------------------------------------------------------
export function WearArmourAction(opts = {}) {
  const key = 'at_wear_armour';
  const slots = opts.slots ?? undefined;   // undefined → all ARMOUR_SLOTS

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      if (!s) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const r = await skills.wearBest(s, slots ? { slots } : {}).catch(() => null);
          return !!(r?.worn?.length);
        })
        .then(ok => { slot.ok = ok; slot.done = true; })
        .catch(() => { slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'wear_armour' });

  node.pre     = [];
  node.effects = ['armour_worn'];
  return node;
}
WearArmourAction._key = 'at_wear_armour';

// ---------------------------------------------------------------------------
// PickUpAction
//
// Picks up a specific item by id from the room floor.
// Pre:  item_on_floor(id)
// Post: holding(id), !item_on_floor(id)
// ---------------------------------------------------------------------------
export function PickUpAction(itemId) {
  const key = `at_pick_up_${itemId}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      const before = c.inventory?.length ?? 0;
      Promise.resolve()
        .then(async () => {
          // Fire the get, then wait for an inventory change or timeout.
          const evSeq = c.evSeq ?? 0;
          await s.pacer.submit('get', () => c.get(itemId), 500);
          const r = await c.waitFor({ since: evSeq, kinds: ['inventory'], timeoutMs: 3000 })
            .catch(() => ({ timedOut: true }));
          if (r.timedOut) return false;
          // Confirm item is now in inventory.
          return (c.inventory || []).some(o => o.id === itemId);
        })
        .then(ok => {
          if (ok) {
            const ws = _ws(bb);
            ws[`item_on_floor_${itemId}`] = false;
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
  }, { key, name: 'pick_up' });

  node.pre     = [`item_on_floor_${itemId}`];
  node.effects = [`holding_${itemId}`, `!item_on_floor_${itemId}`];
  return node;
}

// ---------------------------------------------------------------------------
// DropAction
//
// Drops a specific item by id from inventory.
// Pre:  holding(id)
// Post: !holding(id), item_on_floor(id)
// ---------------------------------------------------------------------------
export function DropAction(itemId, dropSpec) {
  const key = `at_drop_${itemId}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      const spec = dropSpec ?? { id: itemId };
      Promise.resolve()
        .then(async () => {
          const evSeq = c.evSeq ?? 0;
          await s.pacer.submit('drop', () => c.drop([spec]), 500);
          await c.waitFor({ since: evSeq, kinds: ['inventory'], timeoutMs: 3000 })
            .catch(() => ({ timedOut: true }));
          return !(c.inventory || []).some(o => o.id === itemId);
        })
        .then(ok => {
          if (ok) {
            const ws = _ws(bb);
            ws[`holding_${itemId}`] = false;
            ws[`item_on_floor_${itemId}`] = true;
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
  }, { key, name: 'drop' });

  node.pre     = [`holding_${itemId}`];
  node.effects = [`!holding_${itemId}`, `item_on_floor_${itemId}`];
  return node;
}

// ---------------------------------------------------------------------------
// MoveToSquareAction
//
// Walks to a specific grid square using s.walkTo.
// Pre:  none
// Post: at_square(col,row)
// ---------------------------------------------------------------------------
export function MoveToSquareAction(col, row, opts = {}) {
  const key = `at_move_${col}_${row}`;
  const maxSteps = opts.maxSteps ?? 40;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      if (!s) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const r = await s.walkTo(col, row, { maxSteps }).catch(() => null);
          return !!(r?.arrived);
        })
        .then(ok => {
          if (ok) _ws(bb)[`at_square_${col}_${row}`] = true;
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
  }, { key, name: 'move_to_square' });

  node.pre     = [];
  node.effects = [`at_square_${col}_${row}`];
  return node;
}

// ---------------------------------------------------------------------------
// AttackAction
//
// Sends a single attack swing at a target id.
// Pre:  armed, has_target
// Post: (damage dealt — server-side; no local world-state change until the
//        foe disappears from room.objects)
// ---------------------------------------------------------------------------
export function AttackAction(targetId) {
  const key = `at_attack_${targetId}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const evSeq = c.evSeq ?? 0;
          await s.pacer.submit('attack', () => c.attack(targetId), 1050);
          // Wait for a hit event or target removal. Not strictly necessary for
          // the atomic to succeed — the swing was sent. SUCCESS means "sent".
          await c.waitFor({ since: evSeq, kinds: ['hit', 'room-contents'], timeoutMs: 2000 })
            .catch(() => {});
          // Target dead if no longer in room objects.
          const alive = c.room?.objects?.has?.(targetId);
          if (!alive) _ws(bb).target_dead = true;
          return true;   // sending the swing is sufficient for SUCCESS
        })
        .then(ok => { slot.ok = ok; slot.done = true; })
        .catch(() => { slot.done = true; });
      return RUNNING;
    }
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'attack' });

  node.pre     = ['armed', 'has_target'];
  node.effects = ['!has_target'];   // optimistic: planner assumes one swing kills
  return node;
}
AttackAction._key = (id) => `at_attack_${id}`;

// ---------------------------------------------------------------------------
// RestAction
//
// Sends the rest command and waits for health to tick up.
// Pre:  in_sanctuary
// Post: resting = true
// ---------------------------------------------------------------------------
export function RestAction() {
  const key = 'at_rest';

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const evSeq = c.evSeq ?? 0;
          await s.pacer.submit('rest', () => c.rest()).catch(() => {});
          await c.waitFor({ since: evSeq, kinds: ['vitals', 'stat'], timeoutMs: 3000 })
            .catch(() => {});
          return true;
        })
        .then(ok => {
          _ws(bb).resting = ok;
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
  }, { key, name: 'rest' });

  node.pre     = ['in_sanctuary'];
  node.effects = ['resting'];
  return node;
}
RestAction._key = 'at_rest';

// ---------------------------------------------------------------------------
// StandAction
//
// Sends the stand command (stops resting).
// Pre:  resting
// Post: !resting
// ---------------------------------------------------------------------------
export function StandAction() {
  const key = 'at_stand';

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const evSeq = c.evSeq ?? 0;
          await s.pacer.submit('stand', () => c.stand()).catch(() => {});
          await c.waitFor({ since: evSeq, kinds: ['vitals'], timeoutMs: 2000 })
            .catch(() => {});
          return true;
        })
        .then(ok => {
          if (ok) _ws(bb).resting = false;
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
  }, { key, name: 'stand' });

  node.pre     = ['resting'];
  node.effects = ['!resting'];
  return node;
}
StandAction._key = 'at_stand';

// ---------------------------------------------------------------------------
// CastAction
//
// Casts a spell by id against zero or more target ids.
// Pre:  knows_spell(id), mana_available
// Post: spell_cast(id)
// ---------------------------------------------------------------------------
export function CastAction(spellId, targetIds = []) {
  const key = `at_cast_${spellId}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;
      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const evSeq = c.evSeq ?? 0;
          await s.pacer.submit('cast', () => c.cast(spellId, targetIds), 1050);
          const r = await c.waitFor({
            since: evSeq, kinds: ['message', 'inventory'], timeoutMs: 4000,
          }).catch(() => ({ timedOut: true }));
          return !r.timedOut;
        })
        .then(ok => {
          if (ok) _ws(bb)[`spell_cast_${spellId}`] = true;
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
  }, { key, name: 'cast' });

  node.pre     = [`knows_spell_${spellId}`, 'mana_available'];
  node.effects = [`spell_cast_${spellId}`];
  return node;
}
CastAction._key = (id) => `at_cast_${id}`;

// ---------------------------------------------------------------------------
// WorldState helpers: read current game state into bb.ws from the client.
// Call this at the top of each tick to keep the planner's view fresh.
// ---------------------------------------------------------------------------

export function syncWorldState(bb) {
  const c = _client(bb);
  const s = _session(bb);
  if (!c) return;

  const ws = _ws(bb);
  const eq = skills.equippedNow(c) ?? new Set();
  const v  = c.vitals?.() ?? {};

  ws.armed        = eq.size > 0 && skills.weaponsOf(c).some(w => eq.has(w.o?.id));
  ws.resting      = !!(c.me?.flags & 0x0010);           // OF_RESTING, player.kod
  ws.in_sanctuary = !!(s?.world?.room && _isSanctuary(s.world.room));
  ws.mana_available = (v.mana?.value ?? 0) > 0;
  ws.has_target   = ws.has_target ?? false;             // set externally by combat logic
}

function _isSanctuary(room) {
  // Inns are identified by room flags on the autopilot side; expose a hook.
  // The keeper sets this on bb if it calls syncWorldState after resolveRoom.
  return room?.isSanctuary ?? false;
}
