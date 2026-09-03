#!/usr/bin/env node
// m59-combat-test.mjs -- the contract test for the mob-first combat state machine.
//
// Design: engage the mob directly (no safe-spot-first). Retreat to cover only
// when HP is low. Phases: idle/close (approach), fight (swing), retreat (cover).
import { CombatController } from './tick/m59-combat.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

function rig({ meCol = 5, meRow = 5, targetCol = 8, targetRow = 5, targetId = 100, targetFlags = 0, hpPct = 100 } = {}) {
  const sent = [];
  const isWalkable = (r, c) => r >= 1 && c >= 1;
  const geo = { fineWalkable: (r, c) => isWalkable(r, c), standable: (r, c) => isWalkable(r, c) };
  const objects = new Map();
  if (targetId != null) {
    objects.set(targetId, { id: targetId, col: targetCol, row: targetRow, name: 'centipede', flags: targetFlags });
  }
  const session = {
    name: 'test', live: true,
    client: {
      state: 'game',
      self: { col: meCol, row: meRow, x: meCol * 64 + 32, y: meRow * 64 + 32 },
      room: { objects },
      rsc: { get: () => 'centipede' },
      moveTo: (x, y) => sent.push({ x, y }),
      moveSpeed: () => 1,
      vitals: () => ({ health: { value: hpPct, max: 100, pct: hpPct } }),
    },
    pacer: { depth: 0, submit: (k, fn) => { fn(); return Promise.resolve(); } },
    world: { geometry: geo },
  };
  const act = {
    step: (c, r) => sent.push({ step: [c, r] }),
    swing: (id) => sent.push({ swing: id }),
    face: (deg) => sent.push({ face: deg }),
  };
  const frame = () => ({
    position: { col: session.client.self.col, row: session.client.self.row },
    objects,
    vitals: { health: { value: hpPct, max: 100, pct: hpPct } },
  });
  const controller = new CombatController(session);
  return { controller, act, sent, session, frame };
}

console.log('mob-first: walks toward the mob (no safe spot first)');
{
  const { controller, act, sent, frame } = rig({ meCol: 5, meRow: 5, targetCol: 12, targetRow: 5 });
  const r = controller.tick(frame(), act);
  ok('phase is close (approaching the mob)', controller.phase === 'close', controller.phase);
  ok('walks toward the mob', r.kind === 'walk', r.kind);
  ok('no safe spot committed', controller.safeSpot == null, JSON.stringify(controller.safeSpot));
}

console.log('\nfights when the mob is in reach');
{
  const { controller, act, sent, frame } = rig({ meCol: 5, meRow: 5, targetCol: 6, targetRow: 5 });
  const r = controller.tick(frame(), act);
  ok('phase is fight', controller.phase === 'fight', controller.phase);
  ok('swings', r.kind === 'swing', r.kind);
  ok('swing was sent', sent.some(s => s.swing === 100));
}

console.log('\nfights from range: one swing per SWING_MS');
{
  const { controller, act, sent, frame } = rig({ meCol: 1, meRow: 1, targetCol: 2, targetRow: 1 });
  controller.phase = 'fight';
  controller.targetId = 100; controller.targetName = 'centipede';
  controller.lastSwing = 0;
  const r1 = controller.tick(frame(), act);
  ok('first tick swings', r1.kind === 'swing', r1.kind);
  const swings1 = sent.filter(s => s.swing).length;
  const r2 = controller.tick(frame(), act);
  ok('second tick is cooldown', r2.kind === 'idle', r2.kind);
  const swings2 = sent.filter(s => s.swing).length;
  ok('no second swing sent', swings2 === swings1);
}

console.log('\nretreats when HP is low');
{
  const { controller, act, sent, frame } = rig({ meCol: 1, meRow: 1, targetCol: 2, targetRow: 1, hpPct: 40 });
  const r = controller.tick(frame(), act);
  ok('phase is retreat', controller.phase === 'retreat', controller.phase);
  ok('backs off (walk or idle at cover)', r.kind === 'walk' || r.kind === 'idle', r.kind);
}

console.log('\nre-engages when HP recovers');
{
  const { controller, act, sent, frame } = rig({ meCol: 1, meRow: 1, targetCol: 6, targetRow: 1 });
  controller.phase = 'retreat';
  controller.targetId = 100; controller.targetName = 'centipede';
  controller._retreatStart = Date.now();
  // HP is full (100), so retreat should give up and re-engage.
  const r = controller.tick(frame(), act);
  ok('phase back to close', controller.phase === 'close', controller.phase);
}

console.log('\nretreat timeout: re-engages after 60s even if still low');
{
  const { controller, act, sent, frame } = rig({ meCol: 1, meRow: 1, targetCol: 6, targetRow: 1, hpPct: 40 });
  controller.phase = 'retreat';
  controller.targetId = 100; controller.targetName = 'centipede';
  controller._retreatStart = Date.now() - 61000; // 61s ago
  const r = controller.tick(frame(), act);
  ok('phase back to close (timeout)', controller.phase === 'close', controller.phase);
}

console.log('\ncasts zap when it has blue mushrooms and the enchantment is down');
{
  const events = [];
  const sent = [];
  const isWalkable = (r, c) => r >= 1 && c >= 1;
  const geo = { fineWalkable: (r, c) => isWalkable(r, c), standable: (r, c) => isWalkable(r, c) };
  const objects = new Map();
  objects.set(200, { id: 200, col: 6, row: 5, nameRsc: 'mummy', flags: 0 });
  const names = { zap: 'zap', blueMushroom: 'blue mushroom', mace: 'mace', mummy: 'mummy' };
  const session = {
    name: 'test', live: true,
    client: {
      state: 'game',
      self: { col: 5, row: 5 },
      room: { objects },
      rsc: { get: (id) => (id in names ? names[id] : undefined) },
      eventsSince: () => events,
      inventory: [{ nameRsc: 'blueMushroom', count: 3 }],
      equipment: () => ({ known: true, equipped: [{ id: 'mace', nameRsc: 'mace' }] }),
      spells: [{ id: 'zap', nameRsc: 'zap' }],
      cast: (spellId) => sent.push({ cast: spellId }),
      unuse: (id) => sent.push({ unuse: id }),
      use: (id) => sent.push({ use: id }),
      vitals: () => ({ health: { value: 100, max: 100, pct: 100 } }),
    },
    pacer: { depth: 0, submit: (k, fn) => { fn(); return Promise.resolve(); } },
    world: { geometry: geo },
  };
  const act = { face: () => {}, swing: () => {} };
  const frame = { position: { col: 5, row: 5 }, objects, vitals: { health: { value: 100, max: 100, pct: 100 } } };
  const { CombatController } = await import('./tick/m59-combat.mjs');
  const controller = new CombatController(session);
  const r = controller.tick(frame, act, { has_target: true });
  ok('casts zap (kind=zap-cast)', r.kind === 'zap-cast', r.kind + ' ' + (r.what ?? ''));
  ok('unequipped the mace', sent.some(s => s.unuse === 'mace'), JSON.stringify(sent));
  ok('cast the zap spell', sent.some(s => s.cast === 'zap'), JSON.stringify(sent));
}

console.log('\ndoes not cast zap when the enchantment is already active');
{
  const events = [{ seq: 1, kind: 'message', text: 'Sparks jump and crackle from your fingertips.', at: Date.now() - 1000 }];
  const sent = [];
  const isWalkable = (r, c) => r >= 1 && c >= 1;
  const geo = { fineWalkable: (r, c) => isWalkable(r, c), standable: (r, c) => isWalkable(r, c) };
  const objects = new Map();
  objects.set(200, { id: 200, col: 6, row: 5, nameRsc: 'mummy', flags: 0 });
  const names = { zap: 'zap', blueMushroom: 'blue mushroom', mace: 'mace', mummy: 'mummy' };
  const session = {
    name: 'test', live: true,
    client: {
      state: 'game',
      self: { col: 5, row: 5 },
      room: { objects },
      rsc: { get: (id) => (id in names ? names[id] : undefined) },
      eventsSince: () => events,
      inventory: [{ nameRsc: 'blueMushroom', count: 3 }],
      equipment: () => ({ known: true, equipped: [] }),
      spells: [{ id: 'zap', nameRsc: 'zap' }],
      cast: (spellId) => sent.push({ cast: spellId }),
      unuse: (id) => sent.push({ unuse: id }),
      use: (id) => sent.push({ use: id }),
      vitals: () => ({ health: { value: 100, max: 100, pct: 100 } }),
    },
    pacer: { depth: 0, submit: (k, fn) => { fn(); return Promise.resolve(); } },
    world: { geometry: geo },
  };
  const act = { face: () => {}, swing: (id) => sent.push({ swing: id }) };
  const frame = { position: { col: 5, row: 5 }, objects, vitals: { health: { value: 100, max: 100, pct: 100 } } };
  const { CombatController } = await import('./tick/m59-combat.mjs');
  const controller = new CombatController(session);
  const r = controller.tick(frame, act, { has_target: true });
  ok('does not cast (already active)', r.kind !== 'zap-cast', r.kind);
  ok('swings instead (zap-touched)', r.kind === 'swing', r.kind + ' ' + (r.what ?? ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

