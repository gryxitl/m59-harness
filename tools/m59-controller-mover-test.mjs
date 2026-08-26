#!/usr/bin/env node
// THE CONTROLLER MOVER'S RECOVERIES — offline contract tests.
//
//   node tools/m59-controller-mover-test.mjs
//
// The controller OWNS the believed position: it integrates it, collides it against the
// room, and replicates it to the server. That is the whole design, and it has one failure
// mode nothing else has — a belief that lands somewhere the collision model will not let
// it leave. Then every trace refuses, it re-plans, it re-blocks, and it never sends a
// packet. There is no correction loop to save it, on purpose (see the long note in
// tick()), so the recoveries here are the only way out.
import { ControllerMover } from './m59-controller-mover.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A controller stub: it believes what we tell it and refuses to move.
function stubCtl(believed, stepState = 'blocked') {
  return {
    x: (believed.col - 0.5) * 1024,
    y: (believed.row - 0.5) * 1024,
    path: [{ x: 0, y: 0 }],
    stats: {},
    adopted: [],
    square: () => ({ ...believed }),
    step() {
      // A 'moving' step that ADVANCES: this is what real progress looks like, and it is
      // the case that must never lose its position to the resync.
      if (stepState === 'advancing') { believed = { col: believed.col + 1, row: believed.row }; return { state: 'moving' }; }
      // A 'sliding' step reports moving and gets nowhere -- sub-square motion against a
      // wall. This is the shape that fooled the first version of the guard.
      return { state: stepState === 'sliding' ? 'moving' : stepState };
    },
    serverMovedPlayer(col, row) { this.adopted.push([col, row]); believed = { col, row }; return true; },
    replicate() {},
    clear() {},
    syncFrom() {},
    // The planner is not what these tests are about: answer every destination with a plan
    // so tick() reaches the step, which is where the recoveries live.
    setDestination: () => ({ ok: true }),
  };
}

function rig({ believed, server, stepState = 'blocked' }) {
  const session = {
    agent: 't-test',
    client: { state: 'game', self: { ...server }, room: { id: 1, num: 106 } },
    world: { geometry: { collisionReady: true, walkable: () => true, fineWalkable: () => true } },
  };
  const fallback = { to() {}, tick: () => ({ state: 'moving' }), cancel() {} };
  const cm = new ControllerMover(session, fallback);
  cm.ctl = stubCtl(believed, stepState);
  cm.to(30, 30);
  cm._plannedFor = '30,30';          // a plan already exists; do not re-plan in the test
  cm._room = 1;          // matches client.room.id, so no room-change resync fires
  return { cm, session };
}

console.log('controller mover: a belief the model cannot leave is abandoned for the server\'s word');
{
  // THE CASE THIS EXISTS FOR. JayB in Brownestone Inn: the belief on (5,6), a square that
  // is not standable and has no legal step in any of the eight directions, while the
  // SERVER had him on (5,5), which is fine. ctlBlocked=3255 with ctl sent=0 — not one
  // packet in the whole window. The divergence check never fires because one square is
  // nothing; it is the BLOCKAGE, not the distance, that makes a belief worth abandoning.
  const { cm } = rig({ believed: { col: 5, row: 6 }, server: { col: 5, row: 5 } });
  let resynced = false;
  for (let i = 0; i < 60 && !resynced; i++) {
    cm._lastTickAt = Date.now() - 100;                 // a non-zero dt every tick
    const r = cm.tick({ col: 5, row: 5, x: 4608, y: 4608 });
    if (r?.resynced) resynced = true;
  }
  ok('a persistently blocked belief adopts the server square', resynced,
     `adopted=${JSON.stringify(cm.ctl.adopted)}`);
  ok('and it adopts the square the server actually named',
     cm.ctl.adopted.some(([c, r]) => c === 5 && r === 5),
     JSON.stringify(cm.ctl.adopted));
  ok('the plan is dropped, because it was made from somewhere we are not',
     cm._plannedFor === null, String(cm._plannedFor));
}

console.log('\ncontroller mover: agreement is not a reason to resync');
{
  // The belief and the server agree. Being blocked here says something about the GEOMETRY,
  // not about the belief, and adopting a position we already hold would be a no-op that
  // hides a real stall behind a counter that looks like it is doing something.
  const { cm } = rig({ believed: { col: 5, row: 5 }, server: { col: 5, row: 5 } });
  for (let i = 0; i < 60; i++) {
    cm._lastTickAt = Date.now() - 100;
    cm.tick({ col: 5, row: 5, x: 4608, y: 4608 });
  }
  ok('a blocked belief that MATCHES the server is never adopted over itself',
     cm.ctl.adopted.length === 0, JSON.stringify(cm.ctl.adopted));
}

console.log('\ncontroller mover: a body that is getting somewhere keeps its own position');
{
  // Progress is the thing that earns the belief. The counter must clear on real movement,
  // or the first wall anyone brushes past costs them their position.
  const { cm } = rig({ believed: { col: 5, row: 6 }, server: { col: 5, row: 5 },
                       stepState: 'advancing' });
  for (let i = 0; i < 60; i++) {
    cm._lastTickAt = Date.now() - 100;
    cm.tick({ col: 5, row: 5, x: 4608, y: 4608 });
  }
  ok('an advancing body keeps its own position', cm.ctl.adopted.length === 0,
     JSON.stringify(cm.ctl.adopted));
}

console.log('\ncontroller mover: SLIDING is not progress, however much it reports moving');
{
  // THE CASE THE FIRST VERSION OF THIS GUARD MISSED ENTIRELY. A body pressed against a
  // wall slides; the slide is sub-square motion; sub-square motion reports `moving`. So a
  // guard that asked whether the step came back `blocked` never fired once, while JayB sat
  // in Brownestone Inn with slid=5489 and ctl sent=6.
  const { cm } = rig({ believed: { col: 5, row: 4 }, server: { col: 6, row: 4 },
                       stepState: 'sliding' });
  let resynced = false;
  for (let i = 0; i < 60 && !resynced; i++) {
    cm._lastTickAt = Date.now() - 100;
    const r = cm.tick({ col: 6, row: 4, x: 5632, y: 3584 });
    if (r?.resynced) resynced = true;
  }
  ok('a sliding body with no square progress adopts the server square', resynced,
     `adopted=${JSON.stringify(cm.ctl.adopted)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
