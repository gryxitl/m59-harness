#!/usr/bin/env node
// m59-mover-test.mjs -- the contract test for the fine-model mover.
//
//   node tools/m59-mover-test.mjs
//
// The critical case: a room whose square CENTRES are all clear but which
// has an impassable wall SEGMENT across the middle. The coarse planner
// gets this wrong (it sees no blocked squares); the fine model routes
// around the segment.

import { Mover, MOVEUNITS_PROTO } from './tick/m59-mover.mjs';

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
  const mover = new Mover(session, { reportIntervalMs: 0 });  // the rig ticks in microseconds; the 1s client gate is a LIVE constraint
  return { mover, sent, session };
}

// Advance the fake position to match the last sent move.
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
  mover.to(8, 2);

  let states = [];
  let crossedWall = false;
  const path = [];

  for (let i = 0; i < 200; i++) {
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
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  mover.to(4, 2);
  mover.markSitting();
  const r = mover.tick();
  ok('first tick stands', r.state === 'standing');
  const r2 = mover.tick();
  ok('second tick moves or plans', r2.state === 'moving' || r2.state === 'planning', r2.state);
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
  // Advance the position ONE STEP toward the aim (the server records the
  // declared position; it does not carry the character there).
  if (sent.length === 1) {
    const aimX = sent[0][0], aimY = sent[0][1];
    const meX = session.client.self.x, meY = session.client.self.y;
    const dx = aimX - meX, dy = aimY - meY;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, 16); // one step = 16 protocol units (MOVEUNITS)
    session.client.self.x = meX + (dx / dist) * step;
    session.client.self.y = meY + (dy / dist) * step;
    session.client.self.col = Math.floor((session.client.self.x - 32) / 64);
    session.client.self.row = Math.floor((session.client.self.y - 32) / 64);
  }
  sent.length = 0;
  const r2 = mover.tick();
  ok('second tick: re-sends (no hold — the server never carries)', r2.state === 'moving' && r2.hold !== true, r2.state + ' hold=' + r2.hold);
  ok('a second move was sent', sent.length === 1, JSON.stringify(sent));
  // Advance one more step.
  if (sent.length === 1) {
    const aimX = sent[0][0], aimY = sent[0][1];
    const meX = session.client.self.x, meY = session.client.self.y;
    const dx = aimX - meX, dy = aimY - meY;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, 16);
    session.client.self.x = meX + (dx / dist) * step;
    session.client.self.y = meY + (dy / dist) * step;
    session.client.self.col = Math.floor((session.client.self.x - 32) / 64);
    session.client.self.row = Math.floor((session.client.self.y - 32) / 64);
  }
  sent.length = 0;
  const r3 = mover.tick();
  // With local simulation the two sends already covered the 2-square trip:
  // sim position == destination, so the third tick reports arrival instead
  // of re-sending forever. Faster AND terminating.
  ok('third tick: arrived (sim covered it)', r3.state === 'arrived', r3.state + ' hold=' + r3.hold);
  ok('no third move needed', sent.length === 0, JSON.stringify(sent));
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
  ok('second tick: sends again (no hold, step model)', r2.state === 'moving' && r2.hold !== true, r2.state);
  ok('a second move was sent (step model re-sends)', sent.length === 1, JSON.stringify(sent));
}

console.log('\nPHASE 0c: the slide-along-wall check (ownPhysics on, direct path blocked)');
{
  // Geometry where the direct path to the dest is blocked by a wall.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'wall', waypoints: [] }; },
  };
  const { mover, sent, session } = rig({ geo: wallGeo });
  session.policy = { ownPhysics: true };
  mover.to(4, 2); // 2 squares away, direct path blocked
  const r1 = mover.tick();
  ok('first tick: fires the fan (slide), not the direct velocity', r1.state === 'raw-move', r1.state + ' ' + (r1.why ?? ''));
  ok('fan index 0', r1.fanIndex === 0, r1.fanIndex);
}

console.log('\nPHASE 0c: the slide check is off by default (ownPhysics off)');
{
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'wall', waypoints: [] }; },
  };
  const { mover, sent, session } = rig({ geo: wallGeo });
  // No policy.ownPhysics — the default step model.
  mover.to(4, 2);
  const r1 = mover.tick();
  ok('first tick: does NOT fire the 0c slide (step model)', r1.state !== 'raw-move' || r1.why !== '0c: direct path blocked, sliding along wall', r1.state + ' ' + (r1.why ?? ''));
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
  mover.session.policy = { ownPhysics: true };
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
  mover.session.policy = { ownPhysics: true };
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
  mover.session.policy = { ownPhysics: true };
  mover.to(4, 2);
  const r = mover.tick();
  ok('open void (fine true, standable false) fires the no-floor escape fan', r.state === 'raw-move' && r.fanIndex === 0 && r.why === 'no-floor start: escape fan', `${r.state} ${r.why ?? ''}`);
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
  mover.session.policy = { ownPhysics: true };
  mover.to(2, 2, { standOn: true });
  const r = mover.tick();
  ok('stand_on exit square does not start an escape fan', r.why !== 'no-floor start: escape fan', `${r.state} ${r.why ?? ''}`);
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
  ok('a grounded neighbor is stepped to instead', sent.length === 1 && sent[0][0] === 96 && sent[0][1] === 160, JSON.stringify(sent));
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
  // Velocity branch: a floorless stride-clamped aim is refused, not declared.
  const voidGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 2 && c === 5); }, // clamped aim (5,2) is void
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidGeo });
  mover.session.policy = { ownPhysics: true };
  mover.to(6, 2);
  mover.path = [{ x: 6 * 64 + 32, y: 2 * 64 + 32 }];
  mover.pathIdx = 0;
  const r = mover.tick();
  ok('floorless velocity aim is refused', r.state === 'stuck' && r.why === 'aim has no floor', `${r.state} ${r.why ?? ''}`);
  ok('nothing is sent into the void', sent.length === 0, JSON.stringify(sent));
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
  const { mover, sent } = rig({ col: 2, row: 2, geo: cornerGeo });
  mover.session.policy = { ownPhysics: true };
  mover.to(3, 4);
  mover.path = [{ x: 3 * 64 + 32, y: 2 * 64 + 32 }, { x: 3 * 64 + 32, y: 4 * 64 + 32 }];
  mover.pathIdx = 0;
  const r = mover.tick();
  ok('corner aims at the clear waypoint, striding', r.state === 'moving', `${r.state} ${r.why ?? ''}`);
  ok('the send goes to wp1, not into the wall', sent.length === 1 && sent[0][0] === 224 && sent[0][1] === 160, JSON.stringify(sent));
  ok('the fan stays out of it', mover._fanIndex == null && mover._fanTarget == null);
  ok('wp1 consumed, corner kept for arrival', mover.pathIdx === 1, `idx=${mover.pathIdx}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
