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
    world: { geometry: { collisionReady: true, walkable: () => true, fineWalkable: () => true,
                         rows: 57, cols: 52 } },   // room 535's real size, so off-map is off-map
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

console.log('\ncontroller mover: a relocation is adopted, not undone');
{
  // MOVEMENT HERE IS CLIENT-AUTHORITATIVE, which makes a stale belief ACTIVE rather than
  // merely wrong: the controller keeps replicating the square it still believes in, the
  // server validates nothing and accepts it, and the body is dragged back out of wherever
  // it was moved to. JayB's keeper cast blink five times against an entombed square in
  // room 535; every cast succeeded, and the controller returned him to (47,13) each time.
  // Fifteen mana for no distance, and from outside it read as "blink does not work".
  const { cm } = rig({ believed: { col: 47, row: 13 }, server: { col: 47, row: 13 } });
  cm._plannedFor = '30,30';
  const ok1 = cm.relocated(42, 13);
  ok('a relocation is adopted', ok1 && cm.ctl.adopted.some(([c, r]) => c === 42 && r === 13),
     JSON.stringify(cm.ctl.adopted));
  ok('and the plan drawn from the old place is dropped', cm._plannedFor === null,
     String(cm._plannedFor));
  ok('a relocation to nowhere is refused rather than believed',
     cm.relocated(undefined, 13) === false);
}

console.log('\ncontroller mover: a crossing is spent the moment the room changes');
{
  // AN OFF-ROOM REQUEST NAMES A SQUARE OUTSIDE THE ROOM, and which edge that is depends on
  // which room you are standing in. Re-sending one after arriving asks the NEW room to
  // throw you out of whichever edge those coordinates fall past -- so one crossing becomes
  // two, and the second one is not a route anybody planned.
  //
  // JayB left Ilerian Woods by its south edge, landed in the Forest of Farol at (row 4,
  // col 6), and was in Faronath moments later at (row 4, col 34) -- exactly where Farol's
  // own south exit lands you, forty-five rows from where he arrived. The exit tables were
  // suspected first; they were right, and c5.kod/c6.kod both check out.
  const { cm, session } = rig({ believed: { col: 24, row: 57 }, server: { col: 24, row: 57 } });
  const sent = [];
  session.client.moveTo = (x, y, speed) => sent.push({ x, y, speed });
  session.client.room = { id: 1365, num: 535 };
  cm.to(24, 58);                       // off the south edge: a crossing, not a destination
  ok('an off-map destination is recorded as a crossing', !!cm.crossing,
     JSON.stringify(cm.crossing));
  ok('and it remembers which room it is leaving', cm.crossing?.room === 1365,
     String(cm.crossing?.room));

  cm.tick({ col: 24, row: 57 });
  const afterFirst = sent.length;
  ok('while still in the room, the request goes out', afterFirst >= 1, `sent=${afterFirst}`);

  // The server performs the transition: we are now in a DIFFERENT room.
  session.client.room = { id: 1366, num: 536 };
  session.client.self = { col: 6, row: 4 };
  cm._offRoomAt = 0;                   // the rate limit must not be what saves us
  cm.tick({ col: 6, row: 4 });
  ok('once the room has changed the crossing is dropped', cm.crossing === null,
     JSON.stringify(cm.crossing));
  ok('and no further off-room request is sent into the new room',
     sent.length === afterFirst, `sent=${sent.length} was=${afterFirst}`);
}

console.log('\ncontroller: walking is not how a room is left');
{
  // move.c refuses an off-room destination LOCALLY (x = last_x; y = last_y; break) and sends
  // a separate speed-0 request. We did not, and movement is client-authoritative -- so the
  // belief stepped past the boundary, replicated, and the server read the coordinates
  // against the room's own bounds and fired that edge's exit.
  //
  // JayB at the Main gate to the city of Tos (58x44) with a leg planned NORTH: the north
  // staging square and the west boundary meet at the same corner. He drifted past column 1,
  // left by the WEST exit into the Western border of the Twisted Wood, and was two rooms
  // down the wrong road. The route he wanted was 586 -> 585 -> 584 -> ...
  const { CharacterController, CLIENT_PER_SQUARE } = await import('./m59-controller.mjs');
  // A room with no walls at all: every refusal here is the bounds test, nothing else.
  const geo = {
    collisionReady: true, rows: 58, cols: 44,
    leafAtClient: () => ({}), floorBaseAtClient: () => 0,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ available: true, x: x1, y: y1, slid: false, blocked: false }),
  };
  const at = (col, row) => ({ x: (col - 0.5) * CLIENT_PER_SQUARE, y: (row - 0.5) * CLIENT_PER_SQUARE });

  // Heading west from column 2, with open floor all the way: without the bounds test the
  // body walks straight out of the room.
  const c = new CharacterController();
  c.syncFrom({ col: 2, row: 30 });
  c.path = [at(-4, 30)];  c.pathIdx = 0;
  for (let i = 0; i < 40; i++) c.step(100, { geo, client: null });
  const col = Math.floor(c.x / CLIENT_PER_SQUARE) + 1;
  ok('the body does not walk out through the west boundary', col >= 1, `col=${col}`);
  ok('and the refusal is counted rather than silent', (c.stats.offRoomRefused ?? 0) > 0,
     String(c.stats.offRoomRefused));

  // The same room, a destination well inside it: ordinary movement is untouched.
  const d = new CharacterController();
  d.syncFrom({ col: 20, row: 30 });
  d.path = [at(30, 30)]; d.pathIdx = 0;
  const startX = d.x;
  for (let i = 0; i < 20; i++) d.step(100, { geo, client: null });
  ok('a move that stays inside the room still happens', d.x > startX,
     `x ${startX} -> ${d.x}`);

  // Bounds we could not read must mean no opinion, never a room nobody can move in.
  const e = new CharacterController();
  e.syncFrom({ col: 2, row: 30 });
  e.path = [at(-4, 30)]; e.pathIdx = 0;
  const noBounds = { ...geo, rows: undefined, cols: undefined };
  for (let i = 0; i < 10; i++) e.step(100, { geo: noBounds, client: null });
  ok('unknown room bounds grant permission rather than refusing',
     (e.stats.offRoomRefused ?? 0) === 0, String(e.stats.offRoomRefused));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
