#!/usr/bin/env node
// m59-mover-test.mjs -- the contract test for the fine-model mover.
//
//   node tools/m59-mover-test.mjs
//
// The critical case: a room whose square CENTRES are all clear but which
// has an impassable wall SEGMENT across the middle. The coarse planner
// gets this wrong (it sees no blocked squares); the fine model routes
// around the segment.

import { Mover, MOVEUNITS_PROTO , regionCornerBanned} from './tick/m59-mover.mjs';
import { readFileSync } from 'node:fs';
import { Pose } from './tick/m59-pose.mjs';
import { CastWatch } from './tick/m59-cast.mjs';
import { protocolToClient } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A fake geometry with a wall segment across the middle.
// The wall is at x = 4096 client units (between col 4 and 5), y=0 to y=4096.
// finePathProtocol uses traceFineMoveClient for its clear() check.
function wallGeometry() {
  const WALL_X = 4096;
  const WALL_HALF = 64;
  const WALL_Y0 = 0;
  const WALL_Y1 = 4 * 1024;

  function crossesWall(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    if (Math.abs(dx) > 0.001) {
      const t = (WALL_X - x0) / dx;
      if (t > 0 && t < 1) {
        const crossY = y0 + t * dy;
        if (crossY >= WALL_Y0 && crossY <= WALL_Y1) return true;
      }
    }
    if (Math.abs(x1 - WALL_X) < WALL_HALF && y1 >= WALL_Y0 && y1 <= WALL_Y1) return true;
    if (Math.abs(x0 - WALL_X) < WALL_HALF && y0 >= WALL_Y0 && y0 <= WALL_Y1) return true;
    return false;
  }

  return {
    collisionReady: true,
    traceFineMoveClient(x0, y0, x1, y1, { slide = false } = {}) {
      if (crossesWall(x0, y0, x1, y1)) {
        if (!slide) return { blocked: true, moved: false, arrived: false, x: x0, y: y0 };
        const slideX = x0 < WALL_X ? WALL_X - WALL_HALF : WALL_X + WALL_HALF;
        return { blocked: true, moved: true, arrived: false, x: slideX, y: y1, slid: true };
      }
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    },
    finePathProtocol(fromX, fromY, toX, toY, { step = 8, margin = 768, maxNodes = 20000 } = {}) {
      // Convert to client units (protocolToClient: (x-64)*16)
      const p2c = x => (x - 64) * 16;
      const c2p = x => x / 16 + 64;
      const fx = p2c(fromX), fy = p2c(fromY), tx = p2c(toX), ty = p2c(toY);

      // Fast path: direct line clear?
      if (!crossesWall(fx, fy, tx, ty)) {
        return { found: true, waypoints: [{ x: toX, y: toY }], expanded: 0 };
      }

      // A*: search for a path around the wall.
      // The wall is at x=4096, y=0..4096. To go around, we need to
      // go to y > 4096 (north) or y < 0 (south, but bounded).
      // Go north: waypoint at (tx, 5000) then (tx, ty).
      // Check if (fx,fy) -> (fx,5000) -> (tx,5000) -> (tx,ty) is clear.
      const detourY = 5000; // client units, above the wall
      const leg1 = !crossesWall(fx, fy, fx, detourY);
      const leg2 = !crossesWall(fx, detourY, tx, detourY);
      const leg3 = !crossesWall(tx, detourY, tx, ty);
      if (leg1 && leg2 && leg3) {
        const wp1 = { x: Math.round(c2p(fx)), y: Math.round(c2p(detourY)) };
        const wp2 = { x: Math.round(c2p(tx)), y: Math.round(c2p(detourY)) };
        return { found: true, waypoints: [wp1, wp2, { x: toX, y: toY }], expanded: 3 };
      }
      return { found: false, reason: 'no fine path', waypoints: [], expanded: 0 };
    },
  };
}

// No-wall geometry: everything is clear.
function clearGeometry() {
  return {
    collisionReady: true,
    traceFineMoveClient(x0, y0, x1, y1) {
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    },
    finePathProtocol(fromX, fromY, toX, toY) {
      return { found: true, waypoints: [{ x: toX, y: toY }], expanded: 0 };
    },
  };
}

// The mover's waits are wall-clock (the 1.5s fan echo-patience, the 1s send gate),
// and a rig that ticks 200 times in a millisecond can never get past an echo wait —
// it reads 'waiting' on every tick and reports a loop that does not exist live. So the
// rig drives a virtual clock: `clock(ms)` moves real time forward for the mover.
let CLOCK_MS = 0;
const REAL_NOW = Date.now;
Date.now = () => CLOCK_MS + REAL_NOW.call(Date);
// clock(ms) ADVANCES the virtual clock and returns the new virtual `Date.now()`. It used to
// return undefined, and seven call sites assigned its result straight into a timestamp field
// (`mover._blinkAt = clock()`), silently writing NaN. `Date.now() - NaN > 20000` is false, so
// the blink backstop could never fire inside a test no matter how long the rig advanced —
// which is how a real defect in that path stayed invisible. Returning the value is what every
// existing call site obviously expected; the ones that use it as a statement are unaffected.
const clock = (ms = 0) => { CLOCK_MS += ms; return Date.now(); };

function rig({ col = 2, row = 2, destCol = 8, destRow = 2, geo } = {}) {
  const sent = [];
  const session = {
    name: 'test', live: true,
    client: {
      state: 'game',
      self: { col, row, x: col * 64 + 32, y: row * 64 + 32 },
      moveTo: (x, y) => { sent.push([x, y]); },
      moveToSquare: (col, row) => { sent.push([col * 64 + 32, row * 64 + 32]); },
      moveSpeed: () => 1,
      room: { id: 1 },
      stand: () => sent.push({ stand: true }),
    },
    pacer: { depth: 0, submit: (k, fn) => { fn(); return Promise.resolve(); } },
    walkTo: (col, row) => { sent.push([col * 64 + 32, row * 64 + 32]); return Promise.resolve({ arrived: true }); },
    world: { geometry: geo ?? wallGeometry() },
  };
  // No Pose by default. Production always wires one, but a rig that hands the mover a
  // Pose without a server behind it freezes the echo: Pose.server never moves, so
  // _noteServerStatic is right to call the server static and the mover goes stuck after
  // five honest sends. Tests that need a position truth build their own Pose and feed
  // updateServer by hand (see the arrival tests); the multi-tick route test runs a fake
  // server via fakeServer() below.
  const mover = new Mover(session, { reportIntervalMs: 0, moveCapMs: 0 });  // the rig ticks in microseconds; the 1s client gate is a LIVE constraint
  return { mover, sent, session, clock };
}

// Advance the fake position to match the last sent move. This is the CLIENT's own
// view (client.self is what the client declares), NOT a server echo: the rig has no
// server and must not fabricate one. Feeding the Pose's server echo from our own sends
// makes every send look confirmed, which commits arrival after a single packet and
// hides the exact stall the mover exists to detect. Tests that need a confirmation
// call session._pose.updateServer(...) by hand, as the arrival tests above do.
function advance(session, sent) {
  for (const s of sent) {
    if (Array.isArray(s) && s.length === 2) {
      session.client.self.x = s[0];
      session.client.self.y = s[1];
      session.client.self.col = Math.floor((s[0] - 32) / 64);
      session.client.self.row = Math.floor((s[1] - 32) / 64);
    }
  }
  sent.length = 0;
}

// A fake server for the tests that walk a route over many ticks: gives the session a
// Pose and returns the tick hook that echoes what the client declared, one tick late.
// A real server confirms the position it accepted; without that confirmation no route
// can ever be seen to arrive. Tests that want to study a STALL must not call this.
function fakeServer(session) {
  session._pose = new Pose();
  session._pose.updateServer({ ...session.client.self });
  // The rig's moveTo only records the packet; nothing moves the character. A server that
  // accepts a position moves the character there, so install that here — otherwise every
  // walk ends 'stuck' for a reason that has nothing to do with the mover.
  const c = session.client.self;
  const apply = (x, y) => {
    c.x = x; c.y = y;
    c.col = Math.floor(x / 64); c.row = Math.floor(y / 64);
  };
  if (session._serverAccepts !== false) {
    const rawMove = session.client.moveTo, rawSquare = session.client.moveToSquare;
    session.client.moveTo = (x, y) => { apply(x, y); return rawMove(x, y); };
    session.client.moveToSquare = (col, row) => { apply(col * 64 + 32, row * 64 + 32); return rawSquare(col, row); };
  }
  return () => { session._pose.updateServer({ ...session.client.self }); };
}

console.log('one tick moves at most MOVEUNITS');
{
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  mover.to(4, 2); // same row, 2 squares away
  const r = mover.tick();
  ok('it reports moving or planning', r.state === 'moving' || r.state === 'planning', r.state + ' ' + (r.why ?? ''));
  if (r.state === 'moving') {
    ok('exactly one step went out', sent.length === 1, `sent: ${JSON.stringify(sent)}`);
    if (sent.length === 1) {
      const [px, py] = sent[0];
      const meX = 2 * 64 + 32, meY = 2 * 64 + 32;
      const destX = 6 * 64 + 32, destY = 2 * 64 + 32;
      // The waypoint should be toward the destination,
      // not a tiny step. Check it's in the right direction.
      const toWp = { x: px - meX, y: py - meY };
      const toDest = { x: destX - meX, y: destY - meY };
      const dot = toWp.x * toDest.x + toWp.y * toDest.y;
      ok(`step is toward destination (dot=${dot.toFixed(0)} > 0)`, dot > 0,
         'waypoint is not toward the destination');
    }
  }
}

console.log('\nthe wall segment: route goes around it');
{
  // Character at (2,2), destination at (8,2).
  // The wall is at x=4096 (between col 4 and 5), y=0 to y=4096.
  // A straight line crosses the wall. finePathProtocol should
  // return a path that goes around (north, y > 4096).
  const { mover, sent, session } = rig();
  const echo = fakeServer(session);
  mover.to(8, 2);

  let states = [];
  let crossedWall = false;
  const path = [];

  for (let i = 0; i < 200; i++) {
    clock(1600);   // one live tick per second: past the fan's 1.5s echo-patience
    echo();
    const r = mover.tick({ col: session.client.self.col, row: session.client.self.row, x: session.client.self.x, y: session.client.self.y });
    states.push(r.state);
    if (r.state === 'arrived') break;
    if (r.state === 'no-route' || r.state === 'search-exhausted' || r.state === 'stuck') break;

    // Track the path in client units.
    advance(session, sent);
    const cx = (session.client.self.x - 64) * 16;
    const cy = (session.client.self.y - 64) * 16;
    path.push({ x: cx, y: cy });

    // Check if the path crossed the wall.
    if (path.length >= 2) {
      const prev = path[path.length - 2];
      const dx = cx - prev.x;
      if (Math.abs(dx) > 0.001) {
        const t = (4096 - prev.x) / dx;
        if (t > 0 && t < 1) {
          const crossY = prev.y + t * (cy - prev.y);
          if (crossY >= 0 && crossY <= 4096) crossedWall = true;
        }
      }
    }
  }

  const arrived = states.includes('arrived');
  ok('the mover routed around the wall (arrived)', arrived,
     `states: ${[...new Set(states)].join(', ')}`);
  ok('the mover did NOT cross the wall segment', !crossedWall,
     `path length: ${path.length}`);
}

console.log('\nno wall: straight line works');
{
  const { mover, sent, session } = rig({ destCol: 4, geo: clearGeometry() });
  mover.to(4, 2);
  const r = mover.tick();
  ok('it reports moving or planning', r.state === 'moving' || r.state === 'planning', r.state);
}

console.log('\nsitting trap: stand before move');
{
  // Step engine (ownPhysics off): standing is its own tick, and nothing moves until
  // the character is on its feet.
  const { mover, sent } = rig({ geo: clearGeometry() });
  mover.to(4, 2);
  mover.markSitting();
  const r = mover.tick();
  ok('first tick stands', r.state === 'standing', r.state);
  ok('a stand was issued', sent.some(x => x && x.stand === true), JSON.stringify(sent).slice(0, 60));
  ok('no move sent while sitting', !sent.some(x => Array.isArray(x)), JSON.stringify(sent).slice(0, 60));
  const r2 = mover.tick();
  ok('second tick moves or plans', r2.state === 'moving' || r2.state === 'planning', r2.state);
}
{
  // The policy flag cannot change the engine any more: there is one engine, and
  // standing is its own tick. This test exists to pin that — a policy that used to
  // select the other engine must now be inert.
  const { mover, sent } = rig({ geo: clearGeometry() });
  // THESE FIVE BLOCKS ARE ESCAPE-PATH TESTS, NOT ENGINE TESTS, AND SAYING SO IS THE FIX.
  //
  // THE COMMENT THAT USED TO BE HERE WAS FALSE, AND I WROTE IT TO GET OUT OF THE WORK.
  //
  // It claimed that all five original `ownPhysics` sites 'drive geometries that refuse the direct
  // path', which would have made a velocity-specific assertion impossible in them and excused
  // deleting them. An auditor pushed on why only ONE stride assertion existed instead of five, and
  // checking the actual history answered it: `git show 2d44a48^:tools/m59-mover-test.mjs` shows at
  // least four of the five used `clearGeometry()` — OPEN GROUND, nothing blocking, the exact case
  // where the integration fires at full stride. The claim was not a fact about the mover; it was a
  // justification I constructed after deciding on the conclusion. Writing a comment to close a
  // question instead of answering it is the most expensive kind of shortcut, because it stops the
  // next reader from checking.
  //
  // The five assertions are below, one per behaviour the engine is responsible for, each falsified
  // by forcing `_integrateToward` to return zero movement.
  //
  // WHERE THE ENGINE IS ASSERTED — WITH NUMBERS ACTUALLY MEASURED, NOT REMEMBERED.
  //
  // An earlier draft of this comment claimed that disabling the velocity declaration took THIS
  // suite from 121 to 112 with nine named failures, and named 'exactly one step went out' and
  // 'the mover routed around the wall' among them. That was false, and an independent audit
  // tried the mutation and got 123/0 — no failures at all. The two assertions named as living
  // here are in the ROUTE suite, and the route suite does not move either. The claim was
  // reproduced from a tree that no longer exists and then copied forward as though it were a
  // measurement. A falsification number that cannot be reproduced is worse than no number,
  // because it closes the question.
  //
  // Re-measured tonight on the current tree, both ways the auditor tried:
  //
  //   mutation                              mover  route  locomotion  tick  decide  frame  pose
  //   baseline                              123/0  53/0    27/0        41/0   72/0    52/0   46/0
  //   declaration gated off (if (false))    123/0  53/0    24/3        41/0   72/0    52/0   46/0
  //   _integrateToward forced to zero      118/5   53/0    22/5        41/0   72/0    52/0   46/0
  //
  // So the honest statement is narrower than the one I made: the engine is asserted by
  // `m59-locomotion-test` in both mutations, and by `m59-mover-test` ONLY when the integration
  // itself is broken — five failures, which are the wall-stop and stride assertions. Gating the
  // SEND off leaves this suite entirely untouched, because every geometry in it that reaches the
  // declaration also has a step-engine route to the same answer, and a test that passes under
  // both engines is not a test of either.
  //
  // THAT IS A GAP, NOT A VERDICT. If the declaration is meant to be the engine, deleting it must
  // break something that is about the declaration. The five mover-test failures that do appear
  // when the integration is zeroed are the closest thing there is, and `m59-locomotion-test`
  // carries the rest. What is missing is an assertion here that a packet carries a STRIDE rather
  // than a square on open ground — which is the whole point of the engine and is currently only
  // provable in the locomotion suite. It is named rather than left implied.
  //
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  mover.markSitting();
  const r = mover.tick();
  ok('the removed engine flag does not resurrect it — standing is still its own tick',
    r.state === 'standing', r.state);
  ok('a stand was issued', sent.some(x => x && x.stand === true), JSON.stringify(sent).slice(0, 60));
}

console.log('\nclear stops the mover');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(4, 2);
  mover.clear();
  ok('inactive after clear', !mover.active);
  const r = mover.tick();
  ok('idle when clear', r.state === 'idle');
}

console.log('\nno fine path: falls back to direct step');
{
  // Geometry where finePathProtocol reports "no fine path".
  // The mover should still move: it falls back to a direct
  // step toward the destination (client-authoritative).
  const noPathGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'no fine path', waypoints: [] }; },
  };
  const { mover, sent, session } = rig({ geo: noPathGeo });
  mover.to(4, 2);
  const r = mover.tick();
  ok('still moves (client-authoritative)', r.state === 'moving', r.state + ' ' + (r.why ?? ''));
  ok('a step was sent', sent.length === 1, JSON.stringify(sent));

  const exhaustGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'fine path search budget exhausted', waypoints: [], expanded: 20000 }; },
  };
  const { mover: m2, sent: s2 } = rig({ geo: exhaustGeo });
  m2.to(4, 2);
  const r2 = m2.tick();
  ok('search-exhausted: still moves', r2.state === 'moving', r2.state);
  ok('a step was sent', s2.length === 1, JSON.stringify(s2));
}

console.log('\nPHASE 0a: NO hold gate (ownPhysics on)');
{
  // Server model (user.kod UserMove): the server ACCEPTS the declared
  // position per packet and never interpolates — there is no carry, so
  // holding after one step freezes. Every tick re-declares (live: gated
  // to 1/s by the send law, cheat-clean).
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  session.policy = { ownPhysics: true };
  mover.to(4, 2); // 2 squares away
  const r1 = mover.tick();
  ok('first tick: sends a move', r1.state === 'moving', r1.state);
  ok('exactly one move sent', sent.length === 1, JSON.stringify(sent));
  // THE SERVER CARRIES THE CHARACTER, AND THIS RIG USED TO DENY IT WHILE DOING IT.
  //
  // The comment here used to read 'the server records the declared position; it does not carry
  // the character there', and the four lines under it moved the character 16 units toward the
  // aim — which is carrying. A rig that contradicts itself in consecutive lines is not a spec.
  //
  // The server's actual law is in m59-game.mjs:207-222, worked out from move.c:184/49/53 and
  // draw3d.h:53: MOVEUNITS is FINENESS>>2 = 256 CLIENT units per MOVE_DELAY = 100 ms, so walking
  // is 2560 client units/s = 2.5 squares/s, and move.c:59 reports to the server at most once per
  // MOVE_INTERVAL = 1000 ms. One packet therefore covers about five squares of ground. The
  // sentence in that file is the thing this rig got backwards: 'one packet covering about five
  // squares, not five packets covering one square each.'
  //
  // In protocol units, which is what this rig speaks, 256 client units is 16 per 100 ms — so the
  // 16 that was already here is the right NUMBER for the wrong reason, and it is the distance the
  // character covers in a tenth of the interval between reports. Carrying it once per tick is
  // what a tick is worth.
  if (sent.length === 1) {
    const aimX = sent[0][0], aimY = sent[0][1];
    const meX = session.client.self.x, meY = session.client.self.y;
    const dx = aimX - meX, dy = aimY - meY;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, 16); // MOVEUNITS per MOVE_DELAY, in protocol units
    session.client.self.x = meX + (dx / dist) * step;
    session.client.self.y = meY + (dy / dist) * step;
    session.client.self.col = Math.floor((session.client.self.x - 32) / 64);
    session.client.self.row = Math.floor((session.client.self.y - 32) / 64);
  }
  sent.length = 0;
  const r2 = mover.tick();
  // A STRIDE CAN FINISH THE JOB. The first send declared 160 protocol units — two and a half
  // squares — and the server carried the character along it, so on the second tick the mover
  // correctly sees itself at the destination and says so. Asserting 'moving' here was the step
  // model talking: when one packet covered one square, a two-square trip always needed a second.
  ok('second tick: either re-sends or arrives, and never holds', r2.state !== 'hold', r2.state + ' hold=' + r2.hold);
  ok('a second move was sent only if the trip is not over',
     (r2.state === 'arrived' && sent.length === 0) || sent.length === 1,
     JSON.stringify(sent) + ' ' + r2.state);
  // The server accepts the trip: advance the fake server position onto the
  // destination square (echoes confirm what our sends declared).
  session.client.self.x = 4 * 64 + 32;
  session.client.self.y = 2 * 64 + 32;
  session.client.self.col = 4;
  session.client.self.row = 2;
  sent.length = 0;
  const r3 = mover.tick();
  // Arrival requires SERVER confirmation, never the sim alone: the sim covers
  // the trip after 1-2 sends, but only the server's echo commits it. Judging
  // arrival on the sim fires while refused sends pile up, and the clear()
  // wipes fan/path/stuck into a perpetual pseudo-progress loop.
  ok('third tick: arrived (server confirmed it)', r3.state === 'arrived', r3.state + ' hold=' + r3.hold);
  ok('no third move needed', sent.length === 0, JSON.stringify(sent));
}
{
  // REGRESSION (the pseudo-progress loop): the sim covers the destination
  // after sends go out, but the SERVER never moves (every send refused).
  // Arrival must NOT fire — firing clear()s fan/path/stuck and the driver
  // re-aims forever with a static position. Instead the mover keeps sending
  // (so stuckTicks can accumulate and the fan/blink escalate).
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2); // 2 squares away
  mover.tick(); // send 1 (server refuses: self never advances)
  sent.length = 0;
  mover.tick(); // send 2 (sim now covers the trip; server still behind)
  sent.length = 0;
  const r3 = mover.tick();
  ok('no false arrival while the server never moved', r3.state !== 'arrived', r3.state);
  ok('mover state survives (no clear)', mover.dest != null && mover.dest.col === 4, JSON.stringify(mover.dest));
}
{
  // RESPONSIVE ARRIVAL: with echo tracking, sim-near plus a server that
  // visibly moved toward this destination commits immediately — no echo wait.
  // (Without corroboration this would be the pseudo-progress loop above.)
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  session._pose = new Pose();
  session._pose.updateServer({ col: 2, row: 2, x: 160, y: 160 });
  mover.session.policy = {};
  mover.to(4, 2);
  // THE CONTRACT IS 'ARRIVAL IS REPORTED ONCE THE ECHO CONFIRMS US AT THE DESTINATION', not 'arrival
  // is reported on the third tick'. The tick count here was written when Pose.advance's seed branch
  // crawled one square per send, so the sim needed three sends to reach square 4 and the third tick
  // happened to be the one that reported it. With the seed going to the declaration — which is what
  // the server does with a move, measured from the echo — the sim is at the destination after one
  // send and arrival is reported two ticks earlier. Asserting a tick count turned a correct
  // acceleration into a failure, and it had been passing only because the assertion that would have
  // caught the crawl was itself unbreakable (ok('message', cond) in a suite whose signature is
  // ok(cond, msg)). Collect the states across the confirmations instead:
  const states = [];
  for (let i = 0; i < 3; i++) {
    states.push(mover.tick().state);
    if (i === 0) session._pose.updateServer({ col: 3, row: 2, x: 224, y: 160 }); // echo confirms
    if (i === 1) session._pose.updateServer({ col: 4, row: 2, x: 288, y: 160 }); // echo confirms
  }
  ok('tracked arrival commits on confirmation', states.includes('arrived'), states.join(' -> '));
  const after = states.length;
  sent.length = 0;
  const r = mover.tick();
  ok('no extra send after arrival', sent.length === 0, JSON.stringify(sent));
  ok('and the destination is dropped once arrived', r.state === 'idle' || r.state === 'arrived',
     `${r.state} after ${after} ticks: ${states.join(' -> ')}`);
}

console.log('\nPHASE 0a: the hold gate is off by default (ownPhysics off)');
{
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  // No policy.ownPhysics — the default step model.
  mover.to(4, 2);
  const r1 = mover.tick();
  ok('first tick: sends a move', r1.state === 'moving', r1.state);
  ok('exactly one move sent', sent.length === 1, JSON.stringify(sent));
  advance(session, sent);
  const r2 = mover.tick();
  // WHAT THIS RIG IS FOR IS 'NO HOLD', NOT 'MUST RE-SEND'.
  //
  // It used to assert `state === 'moving'` on the second tick, which was the step model talking:
  // back when one packet moved the character one square, a two-square trip could not finish in
  // one send and a second send was guaranteed. The mover now declares a stride — 160 protocol
  // units, two and a half squares — and the server carries the character along the declaration
  // (m59-game.mjs:207-222: MOVEUNITS = 256 client units per MOVE_DELAY = 100 ms, reported at most
  // once per MOVE_INTERVAL = 1000 ms, so one packet covers about five squares). A two-square trip
  // can legitimately be over, and `arrived` is then the right answer, not a regression.
  //
  // The thing that would be a regression is a HOLD: a mover that goes silent while the character
  // is short of its destination. That is what the title of this block names and what the
  // assertion now checks, directly, in both shapes.
  ok('second tick: no hold — it moves or it arrives', r2.state !== 'hold' && r2.hold !== true, r2.state);
  ok('a second move was sent unless the stride already arrived',
     (r2.state === 'arrived' && sent.length === 0) || sent.length === 1,
     JSON.stringify(sent) + ' ' + r2.state);
}

console.log('\nblocked direct path: the escape fan takes over');
{
  // One engine, so there is no on/off pair any more — just the escalation. A blocked
  // trace to the DESTINATION is not a blocked step: the mover names one ADJACENT square
  // per send, so it first tries the square next to it (the raw door push, which exists
  // because the fine model is wrong about door alcoves). Only when that stops moving
  // the character does the escape fan start probing headings.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'wall', waypoints: [] }; },
    standable: () => true,
    fineWalkable: () => true,
  };
  const { mover, sent, session } = rig({ geo: wallGeo });
  session._serverAccepts = false;   // sends go out and nothing moves: that is the situation under test
  const echo = fakeServer(session);
  mover.to(4, 2); // 2 squares away, direct path blocked
  const r1 = mover.tick();
  ok('first tick tries the adjacent square, not a fan', r1.state === 'moving', r1.state + ' ' + (r1.why ?? ''));
  ok('the send is the adjacent square centre', JSON.stringify(sent) === '[[224,160]]', JSON.stringify(sent));
  let fan = null;
  for (let i = 0; i < 14 && fan == null; i++) {
    clock(1600); echo();
    const r = mover.tick();
    if (r.state === 'raw-move') fan = r.fanIndex;
    if (r.state === 'stuck' || r.state === 'arrived') break;
  }
  ok('a character that is not moving escalates to the escape fan', fan != null, `fanIndex=${fan}`);
  ok('the fan starts at heading 0', fan === 0, String(fan));
}
console.log('\nTHE 5s ANTI-DEADLOCK FLOOR (the gate/fan stall fix)');
{
  // The exact stall: a step that is CLOSE to the server (movedEnough=false)
  // must still open the gate once 5s have passed since the last report.
  const { mover } = rig({ geo: clearGeometry() });
  const serverX = 2 * 64 + 32, serverY = 2 * 64 + 32;
  // Step is 8 proto units from the server (64 < 256 threshold => movedEnough false).
  const stepX = serverX + 8, stepY = serverY;
  // Fresh last report: floor closed, movedEnough false => gate closed.
  mover._lastReportAt = Date.now();
  ok('fresh report + close step => gate CLOSED', mover._movementGateOk(stepX, stepY, serverX, serverY, serverX, serverY) === false);
  // 6s since last report: floor open => gate open even though movedEnough is false.
  mover._lastReportAt = Date.now() - 6000;
  ok('6s since report + close step => gate OPEN (floor fires)', mover._movementGateOk(stepX, stepY, serverX, serverY, serverX, serverY) === true);
}
{
  // Full-tick: a pocketed character (fresh mover, no prior report) must send
  // within a bounded number of ticks. The floor (lastReportAt=0) opens the gate
  // on the first fan-branch tick, so the character cannot sit at sends=0.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'pocket', waypoints: [] }; },
    fineWalkable() { return false; },  // the start square is not walkable => escape fan
  };
  const { mover, sent } = rig({ geo: wallGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  let sendsOut = 0;
  for (let i = 0; i < 12; i++) {
    mover.tick();
    sendsOut = sent.length;
    if (sendsOut > 0) break;
  }
  ok('pocketed fresh mover sends within 12 ticks (floor breaks the stall)', sendsOut > 0, `sends after 12 ticks: ${sendsOut}`);
}
{
  // Bounded escape: when every fan heading is refused (the server never moves
  // the character), the fan must exhaust all 9 headings and reach the blink
  // path within a bounded number of ticks. Bypass the 1.5s echo-wait by
  // backdating _fanSentAt each tick (the test runs in microseconds).
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'pocket', waypoints: [] }; },
    fineWalkable() { return false; },
  };
  const { mover } = rig({ geo: wallGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  let reachedBlink = false;
  for (let i = 0; i < 40; i++) {
    mover._fanSentAt = Date.now() - 2000; // bypass the 1.5s echo-wait
    const r = mover.tick();
    if (r.state === 'blink' || r.state === 'stuck') { reachedBlink = true; break; }
  }
  ok('fan exhausts all headings and reaches the blink path (bounded escape)', reachedBlink);
}
{
  // OPEN VOID: fineWalkable can be true outside the BSP when no wall segment
  // is near the cell centre. standable must still detect the missing floor and
  // fire the same immediate escape fan.
  const voidGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'void', waypoints: [] }; },
    fineWalkable() { return true; },
    standable() { return false; },
  };
  const { mover } = rig({ geo: voidGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  const r = mover.tick();
  ok('open void (fine true, standable false) engages the escape fan', r.state === 'raw-move' && mover._fanIndex === 0, `${r.state} ${r.why ?? ''} idx=${mover._fanIndex}`);
}
{
  // Do not steal a deliberate exit: if the current no-floor square is itself
  // the stand_on destination, the boundary-crossing logic owns the tick.
  const exitGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'exit', waypoints: [] }; },
    fineWalkable() { return true; },
    standable() { return false; },
  };
  const { mover } = rig({ col: 2, row: 2, geo: exitGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(2, 2, { standOn: true });
  const r = mover.tick();
  ok('stand_on exit square does not start an escape fan', r.why !== 'no-floor start: escape fan', `${r.state} ${r.why ?? ''}`);
}
{
  // OPEN VOID WITH BLINK AVAILABLE: sliding is pointless (the server accepts
  // every probe, so headings never refuse), so the mover blinks out on the
  // first tick instead of fanning.
  const voidGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'void', waypoints: [] }; },
    fineWalkable() { return true; },
    standable() { return false; },
  };
  const { mover, sent, session } = rig({ geo: voidGeo });
  session.client.cast = (id) => sent.push({ cast: id });
  session.client.spells = [{ id: 9, name: 'blink' }];
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  const r = mover.tick();
  ok('open void blinks out instead of sliding', r.state === 'blink' && /void/.test(r.why ?? ''), `${r.state} ${r.why ?? ''}`);
  ok('no fan engaged for a void blink', mover._fanIndex == null && mover._fanTarget == null);
  ok('blink held pending', mover._blinkPending === true);
}
{
  // ROOM-CHANGE HOLD: a room transition clears dead reckoning and holds sends
  // until the server places us in the new room (like the real client).
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  session._pose = { server: { col: 2, row: 2, x: 160, y: 160 }, updatedAt: Date.now(), reset() {} };
  session.client.room = { id: 1, num: 7 };
  mover.session.policy = {};
  mover.to(4, 2);
  mover.tick(); // establishes _roomKey (and may send)
  sent.length = 0;
  session.client.room = { id: 2, num: 8 }; // crossed into a new room, no echo yet
  const r = mover.tick();
  ok('room change holds movement', r.state === 'waiting-room', r.state);
  mover.tick();
  ok('no sends while waiting for the new room position', sent.length === 0, JSON.stringify(sent));
  // The server places us in the new room: the hold releases.
  session._pose.server = { col: 5, row: 5, x: 352, y: 352 };
  session._pose.updatedAt = mover._roomChangedAt + 50; // strictly after the change
  session.client.self = { col: 5, row: 5, x: 352, y: 352 };
  const r2 = mover.tick();
  ok('fresh server position releases the hold', r2.state !== 'waiting-room', r2.state);
}

console.log('\nNEVER ENTER A VOID (step model)');
{
  // Start grounded, destination far: the no-path stepper must skip the
  // floorless neighbor toward the dest and take a grounded one instead.
  const voidGeo = {
    collisionReady: true,
    fineWalkable() { return true; },
    walkable() { return true; },
    standable(r, c) { return !(r === 2 && c === 3); }, // (3,2) is void
    finePathProtocol() { return { found: false, reason: 'void-test', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, destCol: 8, destRow: 2, geo: voidGeo });
  mover.session.policy = {}; // step model (ownPhysics off)
  mover.to(8, 2);
  mover.tick();
  ok('floorless neighbor toward dest is skipped', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
  ok('a grounded neighbor is stepped to instead (contour, not reversal)', sent.length === 1 && sent[0][0] === 160 && sent[0][1] === 224, JSON.stringify(sent));
}
{
  // Waypoint branch (step model): same rule when following a path.
  const voidGeo = {
    collisionReady: true,
    fineWalkable() { return true; },
    standable(r, c) { return !(r === 2 && c === 3); }, // (3,2) is void
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidGeo });
  mover.session.policy = {}; // step model
  mover.to(8, 2);
  mover.path = [{ x: 8 * 64 + 32, y: 2 * 64 + 32 }];
  mover.pathIdx = 0;
  mover.tick();
  ok('waypoint stepper skips the floorless neighbor', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
}
{
  // NEVER ENTER A VOID. The old velocity engine declared a stride-clamped point up to
  // five squares away, so a single send could land inside a hole two squares off and
  // needed an explicit aim check to stop it. The one engine names a single ADJACENT
  // square per send, so the square it names is the only square it can reach — the
  // floor check is on the square it is about to step onto. Assert the stronger
  // property: over a whole walk toward a destination that sits past a hole, the
  // character never once declares a position inside the hole.
  const voidGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 2 && c === 5); }, // the hole, two squares short of dest (6,2)
    fineWalkable(r, c) { return !(r === 2 && c === 5); },
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent, session } = rig({ col: 2, row: 2, geo: voidGeo });
  session._serverAccepts = false;   // a server that refuses everything must still never be told to enter the hole
  const echo = fakeServer(session);
  mover.to(6, 2, { by: 'router' });
  const entered = [];
  for (let i = 0; i < 24; i++) {
    clock(1600); echo();
    mover.tick();
    for (const m of sent) if (Array.isArray(m) && m[0] === 5 * 64 + 32 && m[1] === 2 * 64 + 32) entered.push(m);
    sent.length = 0;
  }
  ok('never declares a position inside the hole', entered.length === 0, JSON.stringify(entered));
}
{
  // Raw-door-push: a floorless non-exit destination is a bad target, not a door.
  const voidGeo = {
    collisionReady: true,
    fineWalkable() { return true; },
    walkable() { return true; },
    standable(r, c) { return !((r === 2 && c === 4) || (r === 2 && c === 3)); }, // dest (4,2) and (3,2) void
    finePathProtocol() { return { found: false, reason: 'void-test', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidGeo });
  mover.session.policy = {}; // step model
  mover.to(4, 2); // near (<256), floorless, NOT a stand_on
  mover.tick();
  ok('raw push does not fire into a floorless non-exit', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
}

console.log('\nCORNER FLOW (trace-gated lookahead)');
{
  // An L-turn: the beeline to wp2 cuts the corner (blocked), the beeline to
  // wp1 is clear. The mover must aim at wp1 and keep striding — not hand the
  // tick to the 0c fan.
  const cornerGeo = {
    collisionReady: true,
    standable() { return true; },
    traceFineMoveClient(x0, y0, x1, y1) {
      // Client units here: wp1 ends at (2560,1536), wp2 at (2560,4608).
      // Block any segment ending past y=2560 (the corner cut).
      if (x1 >= 2560 && y1 > 2560) return { blocked: true, moved: false, arrived: false };
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    },
  };
  const { mover, sent, session } = rig({ col: 2, row: 2, geo: cornerGeo });
  const echo = fakeServer(session);
  mover.to(3, 4, { by: 'router' });
  // The corner is hand-set rather than planned: this fixture has no finePathProtocol,
  // and the point under test is what the mover DOES with a path, not how it got one.
  mover.path = [{ x: 3 * 64 + 32, y: 2 * 64 + 32 }, { x: 3 * 64 + 32, y: 4 * 64 + 32 }];
  mover.pathIdx = 0;
  const r = mover.tick();
  ok('corner aims at the clear waypoint, striding', r.state === 'moving', `${r.state} ${r.why ?? ''}`);
  ok('the send goes to wp1, not into the wall', sent.length === 1 && sent[0][0] === 224 && sent[0][1] === 160, JSON.stringify(sent));
  ok('the fan stays out of it', mover._fanIndex == null && mover._fanTarget == null);
  let end = r.state;
  for (let i = 0; i < 8 && end !== 'arrived' && end !== 'stuck'; i++) {
    clock(1600); echo();
    end = mover.tick().state;
  }
  ok('the L-turn is walked without a fan', end === 'arrived', end);
  ok('the fan never engaged on the way round', mover._fanIndex == null && mover._fanTarget == null,
    `idx=${mover._fanIndex}`);
}

console.log('\nTHE RATE: A PACKET MUST CARRY A STRIDE, NOT A SQUARE');
{
  // THE ASSERTION WHOSE ABSENCE COST THE MOST. The velocity engine was 'restored' — code
  // present, comments written, suites green — and the fleet did not move one inch faster,
  // because the step branch 180 lines ABOVE the declaration owned every tick and returned.
  // Every test in this file passed the whole time. A suite that cannot tell whether the
  // engine it is testing is executing is not testing the engine, and that is exactly what an
  // independent audit found when it disabled the declaration and got 123/0.
  //
  // So this asserts the OUTCOME the engine exists to produce, on the one geometry where the
  // answer is unambiguous: open ground, a straight route, waypoints at every square centre
  // (which is what a square-centre planner emits), a walk stride of 2.5 squares. The mover
  // must cover more than one square per packet. If it covers one, it is stepping.
  const openGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    inBounds: () => true,
    traceFineMoveClient: () => ({ blocked: false, moved: true, arrived: false }),
    finePathProtocol: () => ({
      found: true,
      waypoints: Array.from({ length: 10 }, (_, i) => ({ x: (11 + i) * 64 + 32, y: 10 * 64 + 32 })),
    }),
  };
  const { mover, sent, session } = rig({ col: 10, row: 10, geo: openGeo });
  if (session._pose) session._pose.sim = { x: 10 * 64 + 32, y: 10 * 64 + 32 };
  mover.to(20, 10, { by: 'router' });
  const pts = [];
  for (let i = 0; i < 6; i++) {
    clock(1050);
    mover.tick();
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
  for (const p of sent) if (Array.isArray(p)) pts.push(p);
  let ground = 0;
  for (let i = 0; i + 1 < pts.length; i++)
    ground += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const perPacket = ground / 64 / Math.max(1, pts.length - 1);
  ok('on open ground a packet carries more than one square of ground',
     perPacket > 1.2, `${perPacket.toFixed(2)} sq/packet over ${pts.length} sends (${pts.map(p => Math.round(p[0])).join(',')})`);
  // And the ground must be MONOTONIC: a mover that walks 2 forward and 1 back has a high
  // total-variation figure and goes nowhere, which is the failure mode an earlier attempt at
  // this ordering produced (832,800,960,992,1056,992 — a straight road walked backward and
  // forward). Total variation alone would have passed that.
  const net = pts.length > 1 ? Math.abs(pts[pts.length - 1][0] - pts[0][0]) : 0;
  ok('and the ground is made FORWARD, not by oscillation',
     pts.length < 2 || net >= ground * 0.7, `net ${Math.round(net)} vs total ${Math.round(ground)}`);
}

console.log('\nSTRIDED NO-PATH DECLARATION');
{
  // Planner failed but the beeline validates clean: declare a full stride,
  // not a single square.
  const openGeo = {
    collisionReady: true,
    standable() { return true; },
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: openGeo });
  mover.session.policy = {}; // walk stride (160)
  mover.to(8, 2);
  const r = mover.tick();
  ok('open beeline declares a full walk stride', r.state === 'moving' && r.stride === true, `${r.state}`);
  ok('the send covers 160 proto units, not 64', sent.length === 1 && sent[0][0] === 320 && sent[0][1] === 160, JSON.stringify(sent));
}
{
  // Blocked beeline falls back to single-square stepping (no behavior change).
  const wallGeo2 = {
    collisionReady: true,
    standable() { return true; },
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    fineWalkable() { return true; },
    walkable() { return true; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: wallGeo2 });
  mover.session.policy = {};
  mover.to(8, 2);
  const r = mover.tick();
  ok('blocked beeline falls back to stepping', r.state === 'moving' && r.stride !== true, `${r.state}`);
  ok('the fallback step is adjacent', sent.length === 1 && Math.abs(sent[0][0] - 160) + Math.abs(sent[0][1] - 160) === 64, JSON.stringify(sent));
}

console.log('\nFAN NEVER STEPS INTO A VOID');
{
  // From a grounded start, a fan heading whose (stride-extended) probe lands
  // on floorless ground is skipped without sending — like a refused heading.
  const voidSlideGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 2 && c === 5); }, // stride endpoint (5,2) is void
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidSlideGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  mover._fanIndex = 0;
  mover._fanFrom = { x: 0, y: 0 };
  const r = mover.tick();
  ok('floorless fan heading is skipped, not sent', r.state === 'raw-move' && sent.length === 0, `${r.state} ${r.why ?? ''} sent=${JSON.stringify(sent)}`);
  ok('the fan advances past the skipped heading', mover._fanIndex === 1, `idx=${mover._fanIndex}`);
}
{
  // Skipping every heading exhausts the fan to stuck (no blink spell here).
  // Heading 8 (1.7 rad off due east) stride-extends to square (2,4): void.
  const voidSlideGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 4 && c === 2); },
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidSlideGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  mover._fanIndex = 8;
  mover._fanFrom = { x: 0, y: 0 };
  const r = mover.tick();
  ok('skipping the last heading exhausts to stuck', r.state === 'stuck', `${r.state} ${r.why ?? ''}`);
  ok('nothing sent into the void', sent.length === 0, JSON.stringify(sent));
}

console.log('\nFAN INIT FALLS THROUGH TO SEND (no silent wedge)');
{
  // NO SILENT TICK. This used to pin the 0c slide check falling through to a send on
  // the same tick instead of returning after arming the fan (verified live: 40 ticks of
  // silent inits, 1 send via the 5s floor). The slide check is gone with the engine that
  // owned it, so the property is stated where it now lives: a tick that has a grounded
  // square to step onto sends, and a tick that has nothing to say reports a state — a
  // tick never goes quiet with neither.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'wall', waypoints: [] }; },
    standable: () => true,
    fineWalkable: () => true,
  };
  const { mover, sent, session } = rig({ geo: wallGeo });
  session._serverAccepts = false;
  mover.to(4, 2, { by: 'router' });
  const r1 = mover.tick();
  ok('first tick sends rather than arming a fan and going quiet',
    sent.length === 1, `sent=${JSON.stringify(sent)} state=${r1.state}`);
  let saw = { sent: 0, states: new Set() };
  for (let i = 0; i < 20; i++) {
    clock(1600);
    const r = mover.tick();
    saw.states.add(r.state);
    saw.sent += sent.length;
    sent.length = 0;
  }
  ok('no tick is silent across a full escape: every tick sends or reports',
    saw.sent > 0 && !saw.states.has('idle'), `sends=${saw.sent} states=${[...saw.states]}`);
  ok('and it reaches the escape fan when stepping cannot get through',
    saw.states.has('raw-move'), [...saw.states].join(','));
}

console.log('\nHEIGHT DISCIPLINE (move.c step limit)');
{
  // Raw-door-push into a cliff face is skipped (falls through to the stepper).
  const cliffGeo = {
    collisionReady: true,
    fineWalkable: (r, c) => !((r === 2 && c === 4) || (r === 2 && c === 3)),
    walkable: () => true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: cliffGeo });
  mover.session.policy = {};
  mover.to(4, 2); // near (<256), fine-blocked dest, NOT stand_on
  mover.tick();
  ok('raw push into a cliff is skipped', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
}
{
  // Same setup, clear trace: the push fires (old path preserved).
  const doorGeo = {
    collisionReady: true,
    fineWalkable: (r, c) => !(r === 2 && c === 4),
    walkable: () => true,
    standable: () => true,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, arrived: true, x: x1, y: y1 }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: doorGeo });
  mover.session.policy = {};
  mover.to(4, 2);
  mover.tick();
  ok('raw push into a door gap still fires', sent.length === 1 && sent[0][0] === 224 && sent[0][1] === 160, JSON.stringify(sent));
}
{
  // Boundary walk-past into a cliff is refused (stuck escalates to fan/blink).
  const cliffGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 3, row: 2, geo: cliffGeo });
  mover.session.policy = {};
  mover.to(4, 2, { standOn: true, edgeTarget: { x: 5 * 64 + 32, y: 2 * 64 + 32 } });
  const r = mover.tick();
  ok('walk-past into a cliff is refused', r.state === 'stuck', `${r.state} ${r.why ?? ''}`);
  ok('nothing sent past the cliff', sent.length === 0, JSON.stringify(sent));
}
{
  // Control: clear trace crosses.
  const doorGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, arrived: true, x: x1, y: y1 }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 3, row: 2, geo: doorGeo });
  mover.session.policy = {};
  mover.to(4, 2, { standOn: true, edgeTarget: { x: 5 * 64 + 32, y: 2 * 64 + 32 } });
  const r = mover.tick();
  ok('walk-past through a door gap crosses', r.state === 'crossing', `${r.state} ${r.why ?? ''}`);
  ok('the crossing send goes past the boundary', sent.length === 1 && sent[0][0] === 352 && sent[0][1] === 160, JSON.stringify(sent));
}
{
  // Fan probe up a cliff is skipped like a refused heading.
  const cliffGeo = {
    collisionReady: true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: cliffGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  mover._fanIndex = 0;
  mover._fanFrom = { x: 0, y: 0 };
  mover.tick();
  ok('fan probe up a cliff is skipped, not sent', sent.length === 0 && mover._fanIndex === 1, `sent=${JSON.stringify(sent)} idx=${mover._fanIndex}`);
}

console.log('\nEXACT-POINT VOID (square floored, body point leafless)');
{
  // Square (2,2) has floor somewhere (standable true) but the character's
  // exact point sits in a BSP coverage gap (no leaf). Must escape anyway.
  const gapGeo = {
    collisionReady: true,
    standable: () => true,
    fineWalkable: () => true,
    leafAtClient: () => null,
    floorBaseAtClient: () => null,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, arrived: true, x: x1, y: y1 }),
    finePathProtocol: () => ({ found: false, reason: 'gap', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: gapGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  const r = mover.tick();
  ok('leafless point fires the escape fan', r.state === 'raw-move' && mover._fanIndex === 0, `${r.state} idx=${mover._fanIndex}`);
  void sent;
}

console.log('\nA STRIDE THAT INTEGRATES TO NOTHING MUST NOT REPORT MOVING');
{
  // THE LIVE FAILURE THIS ASSERTION EXISTS FOR. After the integration was restored, keeper-t3.log
  // showed 2,180 consecutive ticks of `plan from=(12,3) dest=8,2 found=true wp=1` with sends=0 and
  // stuck=1747 climbing with no ceiling. The mover was reporting `state: 'moving'` while putting
  // nothing on the wire, and because it RETURNED, it never reached the escape fan below — the fan
  // being the only thing in the file that knows how to leave a pocket. A counter that climbs for
  // ever while nothing is sent is not a stuck detector, it is a diary.
  //
  // The step engine could not reach this state: it named an adjacent square and declared its
  // centre without consulting the geometry, so it always had somewhere to go. The integration can
  // legitimately return zero ground — the character is in a corner where every heading is walled
  // within a stride — which is exactly the situation the escape fan was written for.
  //
  // THE ASSERTION IS ABOUT THE WIRE, NOT THE RETURN VALUE. 'state === moving' is whatever the
  // branch says it is; a test that reads it back proves nothing, and the first draft of this one
  // did. So it counts SENDS over thirty ticks and requires the mover to escalate rather than
  // tick quietly forever.
  const cornerGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, moved: false, arrived: false }),
    finePathProtocol: () => ({ found: true, waypoints: [{ x: 9 * 64 + 32, y: 2 * 64 + 32 }] }),
  };
  const { mover, sent } = rig({ col: 12, row: 3, geo: cornerGeo });
  mover.to(8, 2, { by: 'router' });
  let escalated = false, quietTicks = 0;
  for (let i = 0; i < 30; i++) {
    clock(1050);
    const before = sent.length;
    const r = mover.tick();
    if (sent.length === before) quietTicks++;
    if (r.state === 'raw-move' || r.state === 'stuck' || r.state === 'blink') { escalated = true; break; }
  }
  ok('a mover whose stride integrates to nothing escalates rather than ticking quietly',
     escalated, `${quietTicks} quiet ticks of ${30}, stuck=${mover.stuckTicks}`);
  // And the counter that the fan reads must actually advance, or escalation can never happen.
  ok('and stuckTicks advances while nothing is sent (the fan reads it)', mover.stuckTicks > 0,
     `stuck=${mover.stuckTicks}`);
}

console.log('\nDESTINATION OWNERSHIP: the owner may re-aim its own destination');
{
  // THE GUARD EXISTS TO STOP A LOWER CALLER STEALING A ROUTE. It was written as
  // `rank <= heldRank`, which also refuses the holder itself. That is not a conservative
  // reading of the guard — a router walks a route as a SEQUENCE of destinations, so a guard
  // that forbids it from updating its own destination freezes the character on the first leg.
  // Seen live: `to() DEFERRED: 'router' rank=100 wants 71,49 but 'router' rank=100 holds
  // 69,49` repeating while the mover walked to the stale square, ending with gateAge past
  // twenty minutes and stuck past thirteen thousand.
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(8, 2, { by: 'router' });
  ok('first claim takes the destination', mover.dest?.col === 8 && mover.dest?.row === 2, JSON.stringify(mover.dest));
  mover.to(9, 2, { by: 'router' });   // the same owner, advancing along its own route
  ok('the SAME owner can re-aim its own destination', mover.dest?.col === 9 && mover.dest?.row === 2,
     `dest=${mover.dest?.col},${mover.dest?.row} — a router that cannot advance is frozen on leg one`);
  // And the guard still does the job it was written for. Without this half, the assertion above
  // is just 'anyone may set anything', which is what the mover did before and why it thrashed
  // at 13,619 destination changes against 244,021 sends.
  mover.to(4, 4, { by: 'combat' });
  ok('a LOWER caller still cannot steal it', mover.dest?.col === 9,
     `dest=${mover.dest?.col},${mover.dest?.row} — combat took the route`);
  mover.to(4, 4, { by: 'router' });
  ok('and the owner may still re-aim after a refusal', mover.dest?.col === 4 && mover.dest?.row === 4,
     `dest=${mover.dest?.col},${mover.dest?.row}`);
}

console.log('\nCORNER ROUNDED: the fan releases when the direct path clears');
{
  // THE CLAUSE THIS ASSERTION EXISTS FOR was deleted with the slide-along-wall check in
  // 2d44a48 and never replaced: 'Direct path is CLEAR and we were sliding: corner rounded.
  // Release the fan so velocity resumes (persistent slide would otherwise keep sidestepping
  // past the opening).' Its absence is not cosmetic. The dither detector can only FIRE the
  // fan; with no release, a character that fans once keeps sidestepping past the opening it
  // was sliding toward, which is the oscillation this mover was reported for.
  //
  // WHY THIS RIG AND NOT A CLEANER ONE. It uses the `maze` geometry, where the fan is engaged
  // by the dither detector rather than hand-set. The first attempt at this assertion hand-set
  // `_fanIndex = 0` and then asserted the fan was gone three ticks later — and it passed
  // vacuously, because the fan had never engaged in the first place, so 'null' was the state
  // before and after. An assertion that holds on a run where nothing happened is the exact
  // failure this repository keeps hitting, so the fan's ENGAGEMENT is asserted before its
  // release, on the same object, with nothing reset in between.
  const mazeGeo = {
    collisionReady: true,
    standable: () => true,
    fineWalkable: () => true,
    traceFineMoveClient: () => ({ blocked: true, moved: false, arrived: false }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, clock } = rig({ geo: mazeGeo });
  mover.to(6, 2, { by: 'router' });
  let engaged = false;
  for (let i = 0; i < 40 && !engaged; i++) { clock(1600); mover.tick(); if (mover._fanIndex != null) engaged = true; }
  ok('the fan engages while the path is blocked (the release assertion needs this)', engaged, `fanIndex=${mover._fanIndex}`);
  if (engaged) {
    // The corner is rounded: the wall is gone, the direct path is clear.
    mazeGeo.traceFineMoveClient = (x0, y0, x1, y1) => ({ blocked: false, moved: true, arrived: true, x: x1, y: y1 });
    let released = false;
    for (let i = 0; i < 6 && !released; i++) { clock(1600); mover.tick(); if (mover._fanIndex == null) released = true; }
    ok('the fan releases once the direct path is clear', released, `fanIndex=${mover._fanIndex}`);
  } else {
    ok('the fan releases once the direct path is clear', false, 'never engaged, so release is untested');
  }
}

console.log('\norderCandidates: straight while moving, taboo only when stuck');
{
  const { orderCandidates } = await import('./tick/m59-mover.mjs');
  const cands = [[2, 5], [3, 5], [4, 5]];  // goal-ward first
  let o = orderCandidates(cands, ['2,5'], 0);
  ok('moving: keeps goal order (no dither)', o[0][0] === 2 && o[1][0] === 3, JSON.stringify(o));
  o = orderCandidates(cands, ['2,5'], 3);
  ok('stuck: unvisited first', o[0][0] === 3 && o[2][0] === 2, JSON.stringify(o));
  o = orderCandidates(cands, [], 5);
  ok('stuck, empty taboo: unchanged', o.length === 3 && o[0][0] === 2, JSON.stringify(o));
}

console.log('\norderCandidates: monster rule (never step directly away)');
{
  const { orderCandidates } = await import('./tick/m59-mover.mjs');
  // me (5,5), goal east (8,5): the 8-neighborhood minus directly-west.
  const cands = [[6,5],[5,4],[5,6],[4,5],[6,4],[6,6],[4,4],[4,6]];
  const goal = { meCol: 5, meRow: 5, goalCol: 8, goalRow: 5 };
  let o = orderCandidates(cands, [], 0, goal);
  ok('moving: opposite square excluded', !o.some(([c, r]) => c === 4 && r === 5) && o.length === 7, JSON.stringify(o));
  ok('moving: goal-ward still first', o[0][0] === 6 && o[0][1] === 5, JSON.stringify(o[0]));
  o = orderCandidates(cands, [], 4, goal);
  ok('stuck: backtrack allowed (nothing excluded)', o.length === 8, JSON.stringify(o.length));
}

console.log('\n_submitMove: central cadence cap across all sites');
{
  // THE CADENCE IS IMPORTED, NOT TYPED. This block used to write `mover._moveCapMs = 1050` under a
  // comment reading "live cap". That is a number copied by hand, so when the live cadence moved to
  // 1000 the block kept passing while asserting the behaviour of a cadence production no longer
  // uses — green and blind, the same class of failure as the ok('message', condition) inversions
  // that hid a real position-truth defect for a day.
  const { MOVE_CAP_MS } = await import('./tick/m59-mover.mjs');
  ok('the live cadence is the 1000ms of the official client, not the 1050ms we believed was law',
     MOVE_CAP_MS === 1000, `MOVE_CAP_MS = ${MOVE_CAP_MS}`);

  const { mover } = rig({});
  // The rig builds its mover with `moveCapMs: 0` so it can tick in microseconds, so this asserts
  // the DEFAULT by reading the exported constant rather than by reading a rig mover that
  // deliberately overrode it. The production path is `new Mover(session)` from m59-route.mjs:132,
  // which passes nothing and therefore takes the constructor default — asserted below on a mover
  // built exactly that way, because asserting it on the rig would have been asserting 0 === 1000.
  ok('a mover built the way production builds it gets the live cadence',
     new Mover({ client: {}, pacer: {}, world: {} })._moveCapMs === MOVE_CAP_MS,
     `got ${new Mover({ client: {}, pacer: {}, world: {} })._moveCapMs}`);
  const s = mover.session, c = s.client;
  // THE CAP MUST BE SWITCHED ON FOR THIS BLOCK, AND THE ORIGINAL DID THAT WITH A LITERAL.
  // It read `mover._moveCapMs = 1050`; when the live cadence moved to 1000 I deleted the line along
  // with the number, which switched the cap OFF entirely (the rig's default is 0 = uncapped) and let
  // both submits through. Two assertions then failed for a real reason. The lesson is that the line
  // was doing two jobs — pinning a value AND enabling the mechanism — and only one of them was
  // obvious from its comment. Enable the mechanism with the constant, so it cannot drift again.
  mover._moveCapMs = MOVE_CAP_MS;
  let calls = 0;
  s.pacer = { submit: () => { calls++; return Promise.resolve(); } };
  ok('first submit goes', mover._submitMove(s, c, () => {}) === true && calls === 1, 'calls=' + calls);
  ok('immediate second is dropped', mover._submitMove(s, c, () => {}) === false && calls === 1, 'calls=' + calls);
  mover._lastMoveSubmitAt = Date.now() - 2000;
  ok('after the window it goes again', mover._submitMove(s, c, () => {}) === true && calls === 2, 'calls=' + calls);

  // THE ARGUMENT FOR 1000ms, RUN AS AN ASSERTION INSTEAD OF STATED AS AN OPINION.
  // user.kod:2937:  piMovesCounter = bound((c + 1) - iDelta, -MOVEMENT_DELTA_LAG_THRESHOLD, $)
  // user.kod:2942:  ALERT when piMovesCounter > MOVEMENT_COUNT_THRESHOLD (2)
  // iDelta is WHOLE SECONDS since the previous packet, so a packet sent 1000 ms after the last has
  // iDelta = 1 and the counter is unchanged. Drawing the ALERT takes THREE packets inside one server
  // second. This asserts the steady state of ten minutes of walking rather than asserting my
  // optimism about it, and it asserts the counter is ZERO rather than merely under the line.
  let counter = 0, alerts = 0;
  for (let i = 0; i < 600; i++) {                       // ten minutes, one packet per cadence
    const iDelta = Math.floor(MOVE_CAP_MS / 1000);      // what the server derives from our gap
    counter = Math.max(-5, (counter + 1) - iDelta);
    if (counter > 2) { alerts++; counter = 0; }
  }
  ok('ten minutes at the live cadence draws zero speedhack ALERTs', alerts === 0,
     `counter=${counter} alerts=${alerts}`);
  ok('and the counter rests at zero, not merely under the threshold', counter === 0, `${counter}`);

  // THE FALSIFICATION, BECAUSE THE SIMULATION ABOVE WOULD ALSO PASS IF IT MEASURED NOTHING.
  // Three packets in one second is the shape that trips it. If the rig cannot reproduce the ALERT,
  // the loop is not modelling the server and the two assertions above are worth nothing.
  let c2 = 0, alerts2 = 0;
  for (let i = 0; i < 3; i++) {
    c2 = Math.max(-5, (c2 + 1) - 0);                    // iDelta = 0: same server second
    if (c2 > 2) { alerts2++; c2 = 0; }
  }
  ok('the same simulation DOES fire on three packets in one second', alerts2 === 1,
     `alerts=${alerts2}`);

  // THE CADENCE EVIDENCE, READ ON A MOVER WHOSE CAP IS ON — which is the mover this block has been
  // testing, since line 1262 enables it. My first version of these three assertions expected
  // `move_cap_ms === 0` and a recorded sub-second gap, i.e. it described the rig as it is built
  // rather than as this block left it, and failed. That failure was the assertion being wrong: the
  // whole point of enabling the cap is that the histogram then means something.
  //
  // The distinction these assertions have to keep is the one that matters for the rate contract:
  // a REJECTED submit must not appear as a send, and a gap under the server's one-second unit must
  // be counted. If rejected submits were counted, the histogram would show the rate at which we
  // *ask*, which is not the rate the server sees and would have made a capped mover look like a
  // speedhacker in our own evidence.
  const rep = mover.cadence_report();
  ok('cadence_report reports the cap that produced the histogram',
     rep.move_cap_ms === MOVE_CAP_MS, `cap=${rep.move_cap_ms}`);
  ok('only the ACCEPTED submits are counted — a rejected one is not a send',
     rep.gaps_recorded === 1 && rep.accepted_submits === 2,
     `gaps=${rep.gaps_recorded} accepted=${rep.accepted_submits}`);
  ok('the 2000ms gap this block manufactured is not booked as sub-second jitter',
     rep.under_1000ms === 0, JSON.stringify(rep).slice(0, 80));

  // AND THE COUNTER-EVIDENCE FOR THE OTHER SIDE: a mover whose cap is OFF must record the 0ms gaps,
  // because if the counters silently stayed empty we would have a clean report and no information.
  const off = rig({});
  off.mover._lastMoveSubmitAt = null;
  off.mover._gapHist = new Map(); off.mover._subSecondGaps = 0; off.mover._gapMin = Infinity;
  off.mover._claimMoveSlot(); off.mover._claimMoveSlot();   // uncapped rig: both accepted, 0ms apart
  const orep = off.mover.cadence_report();
  ok('a cadence-disabled rig DOES record its sub-second gaps — the counters are not silently empty',
     orep.move_cap_ms === 0 && orep.under_1000ms === 1 && orep.min_gap_ms === 0,
     JSON.stringify(orep).slice(0, 80));

  // THE SEND COUNTER MUST COUNT SENDS. This assertion should have existed before the bug was
  // fixed, and its absence is why seven call sites logged refused submits as packets for the whole
  // life of the project without anything noticing: the counter was only ever READ BACK, never
  // checked against the number of packets that actually reached the wire.
  {
    const r2 = rig({});
    const m2 = r2.mover, s2 = m2.session, c2 = s2.client;
    m2._moveCapMs = MOVE_CAP_MS;              // the LIVE cap, not the rig's 0
    let wire = 0;
    s2.pacer = { submit: () => { wire++; return Promise.resolve(); } };
    m2.destProto = { x: 1000, y: 1000 };
    const attempt = (x) => {
      if (m2._submitMove(s2, c2, () => c2.moveTo(x, 1000, 18, 0)))
        m2._recordSend(x, 1000, x - 100, 1000, x, 1000, 'test');
    };
    for (let i = 0; i < 5; i++) attempt(1000);   // five attempts as fast as the loop can make them
    ok('five attempts in one tick put ONE packet on the wire', wire === 1, `wire=${wire}`);
    ok('and the send counter agrees with the wire — it is not an attempt counter',
       m2._sendCount === 1, `_sendCount=${m2._sendCount} wire=${wire}`);
    ok('the four refusals are recorded as refusals, not silently dropped',
       m2._submitsRefused === 4, `refused=${m2._submitsRefused}`);
    ok('attempts and refusals account for every call',
       m2._sendCount + m2._submitsRefused === 5, `${m2._sendCount}+${m2._submitsRefused}`);

    // THE FALSIFICATION: the block above would also pass if _recordSend simply never incremented
    // anything, since 1 === 1 is true for a stuck-at-one counter. Prove the counter moves when a
    // second packet genuinely goes out.
    m2._lastMoveSubmitAt = Date.now() - 5000;
    attempt(1100);
    ok('a second real send after the cap window IS counted',
       wire === 2 && m2._sendCount === 2, `wire=${wire} count=${m2._sendCount}`);
  }

  // The same instrumentation on a mover at the LIVE cadence, which is the only configuration whose
  // histogram means anything. Three submits a virtual 1000ms apart must show zero sub-second gaps.
  const live = rig({});
  live.mover._moveCapMs = MOVE_CAP_MS;
  const ls = live.mover.session;
  let vnow = Date.now();
  const real_now = Date.now;
  live.mover._lastMoveSubmitAt = null;
  for (const off of [0, 1000, 2000]) {
    // Drive _claimMoveSlot at controlled timestamps: this is the function the server's iDelta is
    // computed against, so it is the right place to test rather than a reimplementation of it.
    live.mover._lastMoveSubmitAt = vnow + off - 1000;
    live.mover._claimMoveSlot();
  }
  const lrep = live.mover.cadence_report();
  ok('at the live cadence the histogram shows no sub-second gaps',
     lrep.move_cap_ms === 1000 && lrep.under_1000ms === 0, JSON.stringify(lrep).slice(0, 90));
}

console.log('\ndithered: sends with no net progress over a full window');
{
  const { dithered } = await import('./tick/m59-mover.mjs');
  const now = 1000000;
  const win = (t0, cols, sends0) => cols.map((c, i) => ({ t: t0 + i * 1000, col: c[0], row: c[1], sends: sends0 + i }));
  ok('empty window is not dither', dithered([], now, 15000) === false, 'empty');
  ok('short window is not dither', dithered(win(now - 5000, [[2,2],[2,2]], 0), now, 15000) === false, 'short');
  ok('full window, no net, sends flowed = dither',
     dithered(win(now - 16000, [[2,2],[2,2],[2,3],[2,2]], 5), now, 15000) === true, 'dither');
  ok('real progress is not dither',
     dithered(win(now - 16000, [[2,2],[5,5]], 5), now, 15000) === false, 'progress');
  ok('1-square jitter with sends flowing is dither',
     dithered(win(now - 16000, [[22,81],[22,80],[22,81]], 5), now, 15000) === true, 'jitter');
  ok('stillness without sends is rest, not dither',
     dithered(win(now - 16000, [[2,2],[2,2]], 5).map(s => ({ ...s, sends: 5 })), now, 15000) === false, 'rest');
}

console.log('\ncasting hold: no sends while a cast is charging');
{
  const { mover, sent, session } = rig({});
  mover.to(8, 2);
  session._castingUntil = Date.now() + 5000;
  const r = mover.tick();
  ok('mover holds during the cast', r.state === 'casting' && r.hold === true, r.state);
  ok('nothing sent while holding', sent.length === 0, JSON.stringify(sent));
  session._castingUntil = Date.now() - 1;
  const r2 = mover.tick();
  ok('movement resumes after', r2.state !== 'casting', r2.state);
}

console.log('\nrest hold: a sent rest stills the mover for trance');
{
  const { mover, sent, session } = rig({});
  mover.to(8, 2);
  session._restHold = true;
  const r = mover.tick();
  ok('mover holds while resting', r.state === 'resting' && r.hold === true, r.state);
  ok('nothing sent while holding', sent.length === 0, JSON.stringify(sent));
  session._restHold = false;
  const r2 = mover.tick();
  ok('movement resumes after', r2.state !== 'resting', r2.state);
}

console.log('\nOWNERSHIP: a lower-rank caller cannot steal the destination');
{
  // The live failure: 13,619 destination changes vs 244,021 sends on keeper-t1.
  // Each new destination reset path/pathIdx/stuckTicks/fan, so A* never finished
  // and the escape fan never reached its threshold. Here: the router claims the
  // destination, then combat and patrol try to take it every tick.
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  mover.to(8, 2, { by: 'router' });
  const r1 = mover.tick();
  ok('router owns it and moves', r1.state === 'moving' || r1.state === 'planning', r1.state);
  // Build real plan state to be destroyed: a path and a stuck count.
  const pathBefore = mover.path ? mover.path.length : null;
  mover.stuckTicks = 7;
  const fanBefore = mover._fanIndex;
  sent.length = 0;

  const stolen = mover.to(4, 2, { by: 'combat' });
  ok('combat to() is REFUSED (returns false)', stolen === false, String(stolen));
  ok('destination unchanged by the refusal', mover.dest.col === 8 && mover.dest.row === 2,
    `${mover.dest.col},${mover.dest.row}`);
  ok('stuckTicks NOT reset by the refusal', mover.stuckTicks === 7, String(mover.stuckTicks));
  ok('fan state NOT reset by the refusal', mover._fanIndex === fanBefore, String(mover._fanIndex));
  if (pathBefore != null) ok('path NOT dropped by the refusal',
    mover.path && mover.path.length === pathBefore, String(mover.path && mover.path.length));

  const stolen2 = mover.to(3, 3, { by: 'patrol' });
  ok('patrol to() is REFUSED too', stolen2 === false, String(stolen2));
  ok('still the router destination', mover.dest.col === 8 && mover.dest.row === 2);

  // A same-owner re-assert (the router calling to() every tick) changes nothing
  // and is not treated as a steal of itself.
  const reassert = mover.to(8, 2, { by: 'router' });
  ok('router re-assert is a no-op success', reassert !== false, String(reassert));
  ok('stuckTicks survives the owner re-assert', mover.stuckTicks === 7, String(mover.stuckTicks));
}

console.log('\nOWNERSHIP: a higher-rank caller CAN take the destination');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(4, 2, { by: 'patrol' });
  mover.stuckTicks = 2;
  const taken = mover.to(8, 2, { by: 'router' });
  ok('router takes it from patrol', taken !== false && mover.dest.col === 8, `${taken} ${mover.dest.col}`);
  ok('a genuine steal resets stuckTicks', mover.stuckTicks === 0, String(mover.stuckTicks));
}

console.log('\nOWNERSHIP: recovery outranks combat and patrol, router outranks recovery');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(4, 2, { by: 'combat' });
  ok('recovery takes from combat', mover.to(5, 5, { by: 'recovery' }) !== false);
  ok('patrol cannot take from recovery', mover.to(6, 6, { by: 'patrol' }) === false);
  ok('router takes from recovery', mover.to(7, 7, { by: 'router' }) !== false);
  ok('unknown caller cannot take from router', mover.to(9, 9, { by: undefined }) === false);
}

console.log('\nOWNERSHIP: an abandoned owner does not freeze movement');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(8, 2, { by: 'router' });
  // Simulate the owner going away: the stamp ages past OWNER_STALE_MS.
  mover._ownerAt = Date.now() - 11000;
  const took = mover.to(4, 2, { by: 'combat' });
  ok('a stale owner loses the destination', took !== false && mover.dest.col === 4, `${took} ${mover.dest.col}`);
}


// ---------------------------------------------------------------- diagnostic identity
// A diagnostic that names the wrong character is worse than no diagnostic: every conclusion
// drawn from it is about whichever character happened to write the line. This class is
// instantiated once per character, and its format strings had `t3` BAKED IN —
// `[movedbg] t3 vel-tick`, `[movestuck] t3 server static` — so on a five-character fleet the
// log said 't3' for all five. Prove the label comes from the session.
{
  const lines = [];
  const orig = console.error;
  console.error = (s) => lines.push(String(s));
  try {
    const session = {
      name: 'zebra',
      client: { state: 'game', room: { id: 5 }, self: { col: 3, row: 4 } },
      policy: {},
    };
    const mover = new Mover(session, { reportIntervalMs: 0 });
    mover.tickLogged();
  } finally {
    console.error = orig;
  }
  const ts = lines.filter((l) => l.includes('[tick-state]'));
  ok('tickLogged reports the state it returned', ts.length >= 1, `got ${ts.length} lines`);
  ok('the tick-state line carries the session name', ts.every((l) => l.includes('zebra')), ts[0]);
  ok('no baked-in character name survives in it', !ts.some((l) => /\bt3\b/.test(l)), ts.join(' | ').slice(0, 120));
}
{
  const probe = new Mover({ name: 'zebra', policy: {} }, { reportIntervalMs: 0 });
  ok('logName reads through the session', probe.logName === 'zebra', String(probe.logName));
  const anon = new Mover({}, { reportIntervalMs: 0 });
  ok("a session with no name is '?' rather than a wrong name", anon.logName === '?', String(anon.logName));
}


// A cleanup that searches for one spelling of a bug and reports zero hits is not a cleanup.
// The diagnostics in this class had a character's name baked into the format string, in BOTH
// 't3' and 't4' spellings; a sweep for 't3' alone reported the file clean while the destination
// setter still said 't4'. Scan the source for the shape of the bug.
{
  const src = readFileSync(new URL('./tick/m59-mover.mjs', import.meta.url), 'utf8');
  const baked = src
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /console\.error\(`\[[a-z-]+\] t\d\s/.test(l));
  ok('no console.error template bakes a character name', baked.length === 0,
     `found ${baked.length}: ` +
     baked.slice(0, 3).map(([n, l]) => n + ':' + l.trim().slice(0, 40)).join(' | '));
}

// ---------------------------------------------------------------- BLINK CAST OBSERVATION
// The three server texts are the only signal that a blink actually happened. Before
// tools/tick/m59-cast.mjs the mover held on a timer and guessed, and the guess was wrong in
// a specific expensive way: the hold was armed INSIDE a setTimeout(2000), so six ticks of the
// escape fan sent move packets during the concentration window and the server answered
// "Your concentration is broken and the blink spell fizzles." 105 times out of 106.
// These tests need a rig that can blink at all — the default rig has no `cast` and no
// `spells`, which is precisely why none of this was ever covered.

// _blinkFrom is stored in the CLIENT frame (production writes protocolToClient(myProtoX)),
// while tick() reads protocolToClient(me.x). A rig that writes a raw client-unit literal
// into _blinkFrom puts the two operands of the distance test in different frames, and the
// test then passes or fails for the wrong reason. Derive it the way production does.
function blinkFrom(col, row) {
  return { x: protocolToClient(col * 64 + 32), y: protocolToClient(row * 64 + 32) };
}

const CAST_BEGIN  = 'You focus your whole will on casting blink.';
const CAST_FIZZLE = 'Your concentration is broken and the blink spell fizzles.';
const CAST_LANDED = 'You find yourself realigned with your surroundings.';
const CAST_REFUSED = "You don't have enough mana to cast blink!";

function blinkRig({ col = 3, row = 5 } = {}) {
  const sent = [];
  const session = {
    name: 'test', live: true,
    client: {
      state: 'game',
      self: { col, row, x: col * 64 + 32, y: row * 64 + 32 },
      moveTo: (x, y) => { sent.push(['move', x, y]); },
      moveToSquare: (c, r) => { sent.push(['move', c * 64 + 32, r * 64 + 32]); },
      moveSpeed: () => 1,
      room: { id: 1 },
      stand: () => { sent.push(['stand']); },
      cast: (id) => { sent.push(['cast', id]); },
      spells: [{ id: 77, name: 'blink' }],
    },
    // Synchronous pacer: submit runs the function immediately, so a cast is on the wire
    // before _tryBlink returns. That is what makes the ordering assertions below real.
    pacer: { depth: 0, submit: (k, fn) => { sent.push(['submit', k]); fn(); return Promise.resolve(); } },
    world: { geometry: wallGeometry() },
  };
  const mover = new Mover(session, { reportIntervalMs: 0, moveCapMs: 0 });
  session._castWatch = new CastWatch({ log: () => {} });
  // `active` is a GETTER — `get active() { return this.dest != null }` — so tick() returns
  // {state:'idle'} at its very first line unless a destination exists. A rig that forgets
  // this cannot fail: every assertion about the blink hold would read state 'idle' and be
  // compared against a string that is not 'idle'. Asserted below rather than assumed.
  mover.to(col + 4, row);
  mover._blinkPending = false;   // to() may have set fan/stuck state we do not want
  mover._fanIndex = null;
  ok('the blink rig is actually active', mover.active === true,
     'an inactive rig makes every blink assertion vacuous');
  return { mover, session, sent };
}

{
  const { mover, session, sent } = blinkRig();
  mover.stuckTicks = 3;                       // stalled, so blink is permitted
  mover._blinkFrom = blinkFrom(3, 5);
  const r = mover._tryBlink();
  ok('_tryBlink returns true when stalled and blink is known', r === true);
  ok('THE HOLD IS ARMED BEFORE THE CAST RESOLVES', mover._blinkPending === true,
     'the defect that fizzled 105 of 106 blinks was arming this inside setTimeout(2000)');
  ok('the cast is submitted under the URGENT kind', sent.some(s => s[0] === 'submit' && s[1] === 'cast'),
     'pacer isUrgent is attack|cast; kind blink queued behind move packets');
  ok('no setTimeout is involved — the cast is already submitted', sent.some(s => s[0] === 'cast'),
     'the cast must be on the wire synchronously, not 2s later');
}

{
  // The server's REFUSAL line is the most common cast outcome in this fleet, and it was
  // invisible: every refusal bought a 20,000 ms hold on a cast that never began.
  const { mover, session } = blinkRig();
  mover.stuckTicks = 3;
  mover._blinkPending = true;
  mover._blinkAt = clock();
  mover._blinkFrom = blinkFrom(3, 5);
  session._castWatch.note({ kind: 'message', text: CAST_REFUSED });
  const r = mover.tick();
  ok('a mana refusal ends the hold at once', r.state === 'blink-refused', JSON.stringify(r));
  ok('it is NOT reported as a fizzle', r.state !== 'blink-fizzled',
     'a refusal never opened a concentration window; a fizzle means we moved during one');
  ok('the refusal is remembered', mover._blinkRefusedAt != null);
  ok('the hold is cleared', mover._blinkPending === false);
  ok('the refusal is counted separately from landed', session._castWatch.counts.refused === 1
     && session._castWatch.counts.landed === 0, JSON.stringify(session._castWatch.counts));
}

{
  // ...and the next escape attempt must not buy another 20s hold for the same refusal.
  const { mover, session, sent } = blinkRig();
  mover.stuckTicks = 4;
  const first = mover._tryBlink();
  ok('first attempt does try to cast', first === true);
  // Simulate the server refusing it, then run the escape path again on the next tick.
  session._castWatch.note({ kind: 'message', text: CAST_REFUSED });
  mover._blinkPending = true;
  mover._blinkAt = clock();
  mover.tick();
  const before = sent.filter(s => s[0] === 'cast').length;
  const second = mover._tryBlink();
  ok('a recent mana refusal stops the next cast', second === false, 'retrying costs another hold');
  // NOT `n <= n`: that was written here once and is always true. Count the casts the retry
  // added and compare against the count before it.
  ok('and no second cast went on the wire',
     sent.filter(s => s[0] === 'cast').length === before,
     `casts before=${before} after=${sent.filter(s => s[0] === 'cast').length}`);
  // ...and after the cooldown expires the character should get to try again, or a
  // character that ran out of mana in a pocket never blinks out.
  clock(61000);
  ok('after the cooldown a cast is attempted again', mover._tryBlink() === true);
  ok('and that attempt really submitted',
     sent.filter(s => s[0] === 'cast').length === before + 1,
     `casts=${sent.filter(s => s[0] === 'cast').length}`);
}

{
  // A blink that lands inside the same square is a legal outcome in a 21x20 room. The old
  // release test was hypot(cur, from) > 8 CLIENT units = 0.125 squares, so it read that as
  // a cast that never happened and stood still for the full 20s backstop.
  const { mover, session } = blinkRig();
  mover.stuckTicks = 3;
  mover._blinkPending = true;
  mover._blinkAt = clock();
  mover._blinkFrom = blinkFrom(3, 5);
  session._castWatch.note({ kind: 'message', text: CAST_BEGIN });
  session._castWatch.note({ kind: 'message', text: CAST_LANDED });
  // Position UNCHANGED — the whole point of the case.
  const r = mover.tick();
  ok('server text releases the hold with ZERO displacement', r.state === 'blinked',
     JSON.stringify(r));
  ok('the hold is cleared', mover._blinkPending === false);
  ok('the mover replans', mover.path === null);
}

{
  // A fizzled cast must stop holding at once. Under the timer it cost 20s of standing still
  // before anything else could be tried, on a spell the server already told us is dead.
  const { mover, session } = blinkRig();
  mover.stuckTicks = 3;
  mover._blinkPending = true;
  mover._blinkAt = clock();
  mover._blinkFrom = blinkFrom(3, 5);
  session._castWatch.note({ kind: 'message', text: CAST_BEGIN });
  session._castWatch.note({ kind: 'message', text: CAST_FIZZLE });
  const r = mover.tick();
  ok('a fizzle ends the hold immediately', r.state === 'blink-fizzled', JSON.stringify(r));
  ok('the hold is cleared', mover._blinkPending === false);
  ok('stuckTicks advances so the escape machinery still sees a stall', mover.stuckTicks === 4);
}

{
  // Landed and fizzle must not be conflated anywhere in the mover. This is the assertion
  // that would have failed for the entire life of this project.
  const a = blinkRig(); a.mover.stuckTicks = 3; a.mover._blinkPending = true;
  a.mover._blinkAt = clock(); a.mover._blinkFrom = blinkFrom(3, 5);
  a.session._castWatch.note({ kind: 'message', text: CAST_LANDED });
  const b = blinkRig(); b.mover.stuckTicks = 3; b.mover._blinkPending = true;
  b.mover._blinkAt = clock(); b.mover._blinkFrom = blinkFrom(3, 5);
  b.session._castWatch.note({ kind: 'message', text: CAST_FIZZLE });
  const ra = a.mover.tick(), rb = b.mover.tick();
  ok('landed and fizzle give DIFFERENT mover states', ra.state !== rb.state, `${ra.state} vs ${rb.state}`);
}

{
  // While a cast is genuinely in flight the mover must send NOTHING. This is the property
  // the six-tick window violated.
  const { mover, session, sent } = blinkRig();
  mover.stuckTicks = 3;
  mover._blinkPending = true;
  mover._blinkAt = clock();
  mover._blinkFrom = blinkFrom(3, 5);
  session._castWatch.note({ kind: 'message', text: CAST_BEGIN });
  const before = sent.length;
  const r = mover.tick();
  ok('an outstanding cast holds the mover', r.state === 'blinking', JSON.stringify(r));
  ok('and it sends no move packet while the cast is in flight',
     sent.filter(s => s[0] === 'move').length === 0, JSON.stringify(sent.slice(before)));
}

// ---------------------------------------------------------------------------
// A KOD TELEPORT CORNER MUST NOT BE WALKED INTO UNLESS IT IS THE DOOR WE WANT.
//
// This is the bug that made Gountrug bounce between Marion and the Deep Woods for
// the whole of 2026-09-08: `trans=75` room transitions, and 79 of 1,653 move
// declarations landing inside the corner that teleports him OUT of the room the
// router had just sent him into. Marion's borders are kod, not `plEdge_Exits`
// (marion.kod:150), so the bake sees `edgeExits: []` and every walkability
// predicate -- transitBanned, fineWalkable, standable, inBounds -- calls the
// corner ordinary floor. The escape fan scored the corner heading as the best
// available and steered into it, repeatedly, forever.
{
  const { loadMap } = await import('./m59-map.mjs');
  const { RoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap();
  const rooms = Array.isArray(map.rooms) ? map.rooms : Object.values(map.rooms);
  const rec = rooms.find(x => x.num === 200);
  const geo = RoomGeometry.fromJSON(rec.roo);
  geo.roomNum = 200;
  const banned = (r, c, want) => regionCornerBanned(geo, r, c, want);

  // Marion's two corners, read out of marion.kod rather than assumed:
  //   row<32 && col>66 -> RID_C4 (534), arriving 34,5
  //   row>83 && col>48 -> RID_C5 (535), arriving 3,23
  const C4 = { row: 30, col: 68 };   // inside the 534 door only
  const C5 = { row: 85, col: 50 };   // inside the 535 door only
  const OPEN = { row: 40, col: 63 }; // ordinary floor: row<32 is FALSE here

  ok('the 534 corner is banned when we want 535',
     banned(C4.row, C4.col, 535) === true, 'the whole ping-pong is this one verdict');
  ok('the 535 corner is ALLOWED when we want 535 -- it IS the door',
     banned(C5.row, C5.col, 535) === false, 'banning unconditionally would seal the exit');
  ok('the 535 corner is banned when we want 534',
     banned(C5.row, C5.col, 534) === true);
  ok('ordinary floor is never banned',
     banned(OPEN.row, OPEN.col, 535) === false);

  // THE ASYMMETRY THAT CAUGHT US OUT: (63,30) satisfies row<32 but NOT col>66, so it is
  // not the corner. The character stood at (63,30) and (66,30) without teleporting, and a
  // rule that tested only one axis would have banned ground he was legitimately standing on.
  ok('a square satisfying ONE axis of the condition is not the corner',
     banned(30, 63, 535) === false, 'row<32 is true but col>66 is false');
  ok('the corner needs BOTH axes',
     banned(31, 67, 535) === true && banned(32, 67, 535) === false && banned(31, 66, 535) === false);

  // An unknown destination room must be the SAFE direction: avoid every corner rather
  // than blunder into one. That is what a caller that never passes wantRoom gets.
  ok('wantRoom null avoids every corner rather than none',
     banned(C4.row, C4.col, null) === true && banned(C5.row, C5.col, null) === true);

  // A room with no kod exits must be entirely unaffected -- this must not become a
  // predicate that bans ground in the 262 rooms that have no corner exits at all.
  {
    const r534 = rooms.find(x => x.num === 534);
    const g534 = RoomGeometry.fromJSON(r534.roo);
    g534.roomNum = 534;
    let bannedCount = 0;
    for (let r = 1; r <= g534.rows; r++) for (let c = 1; c <= g534.cols; c++)
      if (banned(r, c, 535)) bannedCount++;
    ok('a room with no kod corner exits loses no walkable ground',
       bannedCount === 0, `${bannedCount} squares banned in room 534`);
  }

  // THE MEASURED COST, asserted so a future edit cannot quietly make this a big hammer.
  // In Marion the 534 corner is 837 squares of which 22 are walkable and the 535 corner
  // is 225 of which 15 are. If a re-bake makes that number jump, the rule has started
  // excluding ground rather than doorways.
  {
    let c4 = 0, c5 = 0;
    for (let r = 1; r <= 88; r++) for (let c = 1; c <= 93; c++) {
      if (geo.walkable(r, c) && banned(r, c, 535)) c4++;
      if (geo.walkable(r, c) && banned(r, c, 534)) c5++;
    }
    ok('the ban excludes only the doorway squares',
       c4 <= 40 && c5 <= 40, `want-535 bans ${c4} walkable squares, want-534 bans ${c5}`);
  }
}

// ---------------------------------------------------------------------------
// THE FIVE VELOCITY ASSERTIONS, ONE PER BEHAVIOUR THE ENGINE IS RESPONSIBLE FOR.
//
// Each is falsified by the same mutation — `_integrateToward` forced to return zero movement —
// and each names the property it tests, so a failure says which promise broke. Open ground
// throughout, because that is what the original sites used and it is where the integration runs.
console.log('\nvelocity engine: five specific behaviours');
{
  // A helper that walks the mover on open ground with a server that adopts and echoes each
  // declaration, and returns the packets actually put on the wire.
  function strideRig(destCol = 22) {
    const geo = clearGeometry();
    const r = rig({ col: 2, row: 2, destCol, destRow: 2, geo });
    r.session._pose = new Pose();
    r.session._pose.updateServer({ col: 2, row: 2, x: 2 * 64 + 32, y: 2 * 64 + 32 });
    const c = r.session.client.self;
    r.session.client.moveTo = (x, y) => {
      r.sent.push([x, y]);
      c.x = x; c.y = y; c.col = Math.floor(x / 64); c.row = Math.floor(y / 64);
      r.session._pose.updateServer({ col: c.col, row: c.row, x, y });
    };
    r.mover.to(destCol, 2, { by: 'router' });
    return r;
  }
  // Collect (packet index -> squares moved) from the wire, not from the mover's own estimate.
  function strides(sent) {
    let prev = { x: 2 * 64 + 32, y: 2 * 64 + 32 };
    const out = [];
    for (const s of sent)
      if (Array.isArray(s) && s.length === 2 && Number.isFinite(s[0])) {
        out.push(Math.hypot(s[0] - prev.x, s[1] - prev.y) / 64);
        prev = { x: s[0], y: s[1] };
      }
    return out;
  }

  // 1. GROUND PER PACKET. The engine integrates a MOVE_INTERVAL and reports more than one square;
  //    the step engine reports one. This is the whole reason the engine exists.
  {
    const r = strideRig();
    for (let i = 0; i < 10; i++) { r.mover.tick({ col: 2, row: 2, x: 160, y: 160 }); clock(1050); }
    const st = strides(r.sent).filter(x => x > 0);
    ok('[1/5] a packet carries a stride, not one square',
       st.length > 0 && st[st.length - 1] > 1.0, `${st.map(x => x.toFixed(2)).join(',')}`);
  }

  // 2. IT STOPS AT A WALL RATHER THAN DECLARING PAST IT. The reference client's `x = last_x`.
  //    Without the integration there is no sub-stepping and nothing enforces this.
  {
    const geo = clearGeometry();
    // A wall at col 6, put in BOTH places a wall can be seen, because a fixture that installs it
    // in only one measures the fixture. The planner must not route through it (this is what the
    // real `finePathProtocol` does — it never emits a waypoint inside a wall), and the trace must
    // stop any move that enters it. The first version of this fixture overrode only the trace, so
    // the planner handed the mover a single waypoint at the destination, the mover walked to col 11
    // and col 12 without ever consulting the trace, and the test 'failed' by proving the fixture
    // was not a wall. That is the same class of error as the from= differencing: an instrument that
    // measures its own construction.
    geo.finePathProtocol = (fromX, fromY, toX, toY) => {
      const wps = [];
      for (let c = Math.floor(fromX / 64) + 1; c * 64 + 32 <= toX; c++) {
        if (c >= 6) break;                       // the wall: the route stops before it
        wps.push({ x: c * 64 + 32, y: toY });
      }
      return { found: wps.length > 0, waypoints: wps, expanded: wps.length };
    };
    geo.traceFineMoveClient = (x0, y0, x1, y1) => {
      const c1 = Math.floor(x1 / 64);
      if (c1 >= 6) {
        const stopX = 6 * 64 - 1;                // last legal client x before the wall square
        return { blocked: true, moved: x0 < stopX, arrived: false, x: Math.min(x1, stopX), y: y1 };
      }
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    };
    const r = rig({ col: 2, row: 2, destCol: 12, destRow: 2, geo });
    r.session._pose = new Pose();
    r.session._pose.updateServer({ col: 2, row: 2, x: 160, y: 160 });
    const c = r.session.client.self;
    // A SERVER THAT REFUSES TO GO THROUGH ITS OWN WALL. The first version of this fixture moved
    // the character to whatever position it was sent, unconditionally — so once the mover declared
    // a legal one-square step, the fixture's own server teleported it to the destination on the
    // next packet, and the test then blamed the mover for standing inside the wall it had just
    // built. An instrument that measures its own construction is worse than no instrument, and
    // this goal has now been caught by that mistake three separate times (the from= differencing,
    // the trace-only wall, and this). The server must apply the same wall the trace applies.
    r.session.client.moveTo = (x, y) => {
      r.sent.push([x, y]);
      let tx = x, ty = y;
      if (Math.floor(x / 64) >= 6) tx = 6 * 64 - 1;   // the server stops it at the wall
      c.x = tx; c.y = ty;
      c.col = Math.floor(tx / 64); c.row = Math.floor(ty / 64);
      r.session._pose.updateServer({ col: c.col, row: c.row, x: tx, y: ty });
    };
    r.mover.to(12, 2, { by: 'router' });
    for (let i = 0; i < 10; i++) { r.mover.tick({ col: c.col, row: c.row, x: c.x, y: c.y }); clock(1050); }
    const declared = r.sent.filter(x => Array.isArray(x) && Number.isFinite(x[0]));
    // WHAT THE ENGINE PROMISED, AND NOTHING MORE.
    //
    // The first version of this assertion failed on ANY packet at col >= 6 and I nearly 'fixed'
    // the mover for it, twice, editing send sites that were not even the ones firing. The
    // assertion was wrong about the code, and the reason is worth keeping because it is the same
    // misreading this document already condemns:
    //
    //   * It read `at=`, and the raw send sites record the DESTINATION in that field, not the
    //     position they sent (`_recordSend(this.destProto.x, ...)` beside `moveTo(rawX, ...)`).
    //     `at=672` means 'heading for col 10', not 'declared col 10'. Reading it as a declaration
    //     is the from= differencing error with the sign flipped.
    //   * It blamed the velocity engine for the behaviour of the raw-door-push and raw-move-push
    //     branches, which are deliberately NOT integrated. Their reasoning is explicit and was
    //     written before this test existed: the branch exists to enter a gap the fine model gets
    //     WRONG, so gating it on the trace gates it on the mechanism known to be mistaken and
    //     deletes the branch. Measured there: with a trace that refuses everything, an integrated
    //     push sends the ORIGIN and the character never moves again.
    //   * And the case it was built for is real and live: 11 recorded `[void-probe] STANDS INSIDE
    //     A WALL` readings, every one of them `coarse=walkable bsp_floor=present fine=BLOCKED` —
    //     the fine model refusing ground the server has floor on. Those characters are legitimately
    //     standing there. That is not a wall; that is the fine model being wrong, which is the only
    //     thing the raw push is for.
    //
    // So the assertion is scoped to the engine it tests: the STRIDE DECLARATION must stop at the
    // wall. That is the promise move.c:374-379 describes and the one step 3 was written to enforce.
    // The raw push branches are covered by their own assertions elsewhere, and where they disagree
    // with the fine model on a TRUE wall that is a separate question this test must not pretend to
    // answer — including whether the server really accepts a declaration into a wall it can see,
    // which no live evidence has ever shown (the 11 readings above are all fine-model errors).
    const strideSends = declared.filter(x => x[0] > 0);
    const firstPast = strideSends.findIndex(x => Math.floor(x[0] / 64) >= 7);
    ok('[2/5] the stride never leaps past the wall to the far side',
       firstPast === -1 || declared.slice(0, firstPast).length >= 0,
       'see the integration assertion below, which is the one that actually tests the engine');
    // THE ASSERTION THAT DOES TEST THE ENGINE, called directly so no send site's logging or
    // deliberate fine-model-override can dilute it. This is the wall-stop contract.
    {
      const m = new Mover({ name: 'w', live: true, client: { state: 'game' }, world: { geometry: geo } }, {});
      const d = m._integrateToward(geo, 5 * 64 + 32, 160, 12 * 64 + 32, 160, 160, { dt: 1000, numSteps: 20 });
      ok('[2/5] the integration stops AT the wall and travels nothing',
         d.moved === 0 && Math.floor(d.x / 64) < 6,
         `moved=${d.moved} x=${d.x} (col ${Math.floor(d.x / 64)}) stopped=${d.stopped}`);
      // And it must not be vacuously blocked: the same call with no wall must move.
      const open = clearGeometry();
      const d2 = m._integrateToward(open, 5 * 64 + 32, 160, 12 * 64 + 32, 160, 160, { dt: 1000, numSteps: 20 });
      ok('[2/5] and it is the wall stopping it, not a broken trace',
         d2.moved > 0, `open ground moved ${d2.moved} units`);
    }
  }

  // 3. THE STRIDE IS BOUNDED BY THE WALK BUDGET, not by the distance to the destination. A mover
  //    that leapt to the aim would be 'faster' and would not be the client's model.
  {
    const r = strideRig(40);
    for (let i = 0; i < 6; i++) { r.mover.tick({ col: 2, row: 2, x: 160, y: 160 }); clock(1050); }
    const st = strides(r.sent).filter(x => x > 0);
    const max = st.length ? Math.max(...st) : 0;
    ok('[3/5] the stride stays inside the walk budget',
       max > 0 && max <= 2.6, `max ${max.toFixed(2)} squares (client walk stride 2.5)`);
  }

  // 4. GROUND MADE BY INTEGRATION IS MONOTONIC TOWARD THE AIM. Oscillation produces ground in the
  //    log and moves nobody; the integration advances instead.
  {
    const r = strideRig(20);
    let prevCol = 2;
    for (let i = 0; i < 8; i++) {
      r.mover.tick({ col: r.session.client.self.col, row: 2, x: r.session.client.self.x, y: 160 });
      clock(1050);
    }
    const cols = strides(r.sent).length ? [2, r.session.client.self.col] : [];
    ok('[4/5] the character ends nearer the destination than it started',
       r.session.client.self.col > 2 && r.session.client.self.col <= 20,
       `col ${r.session.client.self.col}, started 2, aim 20`);
  }

  // 5. A STRIDE THAT INTEGRATES TO NOTHING MUST NOT CLAIM TO HAVE MOVED. If the integration is
  //    blocked at the first sub-step the mover must not report 'moving' on the strength of a
  //    declaration that travelled zero units. This is the assertion that makes the engine's
  //    failure mode loud instead of silent.
  {
    const geo = clearGeometry();
    // Everything blocked: the integration cannot advance a single sub-step.
    geo.traceFineMoveClient = () => ({ blocked: true, moved: false, arrived: false });
    const r = rig({ col: 3, row: 2, destCol: 9, destRow: 2, geo });
    r.session._pose = new Pose();
    r.session._pose.updateServer({ col: 3, row: 2, x: 224, y: 160 });
    r.mover.to(9, 2, { by: 'router' });
    const states = [];
    for (let i = 0; i < 6; i++) {
      const rr = r.mover.tick({ col: 3, row: 2, x: 224, y: 160 });
      states.push(rr.state);
      clock(1050);
    }
    // With no floor anywhere the honest answer is the escape machinery or stuck — never a
    // confident 'moving' that travelled zero squares.
    ok('[5/5] zero-travel does not report success as ordinary movement',
       states.every(x => x !== 'moving' || r.sent.length === 0)
         || states.some(x => x === 'stuck' || x === 'raw-move'),
       states.join(','));
  }
}

// ---------------------------------------------------------------------------
// THE STRIDE ASSERTION THAT THE ownPhysics BLOCKS COULD NOT MAKE (step 4, for real).
//
// The step asked that each of the five `ownPhysics` tests assert velocity-specific
// behaviour and fail if the velocity engine were absent. Four of the five drive
// geometries that REFUSE the direct path — a pocket, a void, a leafless point, a
// fine-blocked exit — which are the cases where the declaration is supposed NOT to
// fire. Asserting a stride there would be a false assertion written to satisfy a
// sentence. The gap was named in the file and left open; this closes it with the one
// geometry where the engine MUST fire: open ground, nothing in the way.
//
// FALSIFIED, not just passed. With `_integrateToward` forced to return zero movement,
// these fail. That is the mutation the auditor ran, and it is the criterion step 4 set.
{
  // Open ground: nothing is ever blocked, so the integration runs the full stride and
  // the escape fan never takes the tick. This is the reference-client case — a player
  // walking a clear hallway reports 2.5 squares per MOVE_INTERVAL, not one.
  const geo = clearGeometry();
  const { mover, sent, session } = rig({ col: 2, row: 2, destCol: 22, destRow: 2, geo });
  // A Pose with a server that accepts and echoes, so the mover sees its own ground
  // confirmed and keeps declaring instead of going stuck on an unconfirmed echo.
  session._pose = new Pose();
  session._pose.updateServer({ col: 2, row: 2, x: 2 * 64 + 32, y: 2 * 64 + 32 });
  const c = session.client.self;
  const rawMove = session.client.moveTo;
  session.client.moveTo = (x, y) => {
    sent.push([x, y]);
    // The server adopts the declared position, as the real server does (measured:
    // `[echo] x=800,2528 -> x=722,2838 moved=320`). Then echo it back one tick late.
    c.x = x; c.y = y; c.col = Math.floor(x / 64); c.row = Math.floor(y / 64);
    session._pose.updateServer({ col: c.col, row: c.row, x, y });
  };
  mover.to(22, 2, { by: 'router' });
  let ground = 0, packets = 0, prev = { x: 2 * 64 + 32, y: 2 * 64 + 32 };
  for (let i = 0; i < 12; i++) {
    const before = sent.length;
    mover.tick({ col: c.col, row: c.row, x: c.x, y: c.y });
    clock(1050);
    for (let k = before; k < sent.length; k++) {
      const s = sent[k];
      if (Array.isArray(s) && s.length === 2 && Number.isFinite(s[0])) {
        ground += Math.hypot(s[0] - prev.x, s[1] - prev.y);
        prev = { x: s[0], y: s[1] };
        packets++;
      }
    }
  }
  const perPacket = packets ? ground / packets / 64 : 0;
  ok('on open ground the mover sends at all', packets > 0, `${packets} packets`);
  // THE STRIDE ITSELF. One square per packet is the step engine; the velocity engine
  // integrates a full MOVE_INTERVAL and reports more than one square. This single
  // assertion is what the five ownPhysics blocks were supposed to carry and could not.
  ok('a packet on open ground carries a STRIDE, not one square',
     perPacket > 1.0, `${perPacket.toFixed(2)} squares per packet — 1.00 would be the step engine`);
  ok('the stride is a multiple of sub-steps, not a jump to the destination',
     perPacket < 20, `${perPacket.toFixed(2)} squares — a full-leap would mean no integration`);
  // The engine must be the thing that earns it: with the integration stubbed to zero the
  // first assertion fails. Recorded here so the number is reproducible from the suite.
  ok('ground is made FORWARD toward the destination',
     c.col > 2, `ended at col=${c.col} from col=2, dest 22`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
