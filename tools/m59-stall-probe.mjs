#!/usr/bin/env node
// WHY IS THIS BODY NOT MOVING? Asked offline, of one room and one trip.
//
//   node tools/m59-stall-probe.mjs --room 150 --from 68,29 --to 69,31
//
// A stalled character produces the same symptom from four different causes, and telling
// them apart from outside took most of a day: the square is rock, the destination cannot be
// entered, the planner has no route, or — the one nobody was looking for — the planner has a
// route the PHYSICS cannot follow. This walks all four, in order, against the same geometry
// the mover enforces, and needs no live fleet.
//
// THE CASE IT WAS WRITTEN FOR. Lee and Kage, arriving separately, both stopped on (68,29) in
// Cor Noth and stayed there for hours, under BOTH the tick keeper and the survive keeper. The
// square was fine: five of eight directions move a clean full square from its centre. The
// destination was fine: (69,31) can be entered from five of its eight neighbours. navPath
// found an eight-waypoint route. And the body could not walk it, because the first waypoint
// is 543 units away — a SUB-SQUARE hop — and steering at something that close slides the body
// along the wall it is already against and leaves it in the same square. No square progress
// means the stall detector re-centres it, from where it slides into the same spot again.
//
// Aiming further along the same path escapes: waypoint 2 and beyond move it into (69,29).
// That is a lookahead, and it is not the whole fix — it buys one square and stops — but it
// localises the problem to steering rather than to the map, the planner or the room.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sharedRoomGeometry, buildAllRoomGeometry } from './m59-roo.mjs';
import { navPath, regions, labelAt } from './m59-navgrid.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const pair = (s) => (s ?? '').split(',').map(Number);

const C = (c, r) => ({ x: (c - 0.5) * 1024, y: (r - 0.5) * 1024 });
const sq = (x, y) => `${Math.floor(x / 1024) + 1},${Math.floor(y / 1024) + 1}`;

export function probe(geo, from, to, { log = console.log } = {}) {
  const out = { verdict: null, notes: [] };
  const say = (s) => { log(s); };

  // 1. IS THE SQUARE ITSELF ROCK? Ask the tracer, not a grid: the coarse grid refuses a
  //    third of ordinary terrain and the fine one refuses a tenth.
  const f = C(from[0], from[1]);
  const S = 1024;
  const dirs = [['N',0,-S],['S',0,S],['E',S,0],['W',-S,0],['NE',S,-S],['NW',-S,-S],['SE',S,S],['SW',-S,S]];
  let clean = 0;
  for (const [, dx, dy] of dirs) {
    try {
      const t = geo.traceFineMoveClient(f.x, f.y, f.x + dx, f.y + dy, { slide: true });
      if (t?.moved && Math.hypot((t.x ?? f.x) - f.x, (t.y ?? f.y) - f.y) >= 512) clean++;
    } catch { /* a throwing direction is not a passable one */ }
  }
  say(`  start (${from})  walkable=${geo.walkable?.(from[1], from[0])}`
    + ` fine=${geo.fineWalkable?.(from[1], from[0])} standable=${geo.standable?.(from[1], from[0])}`
    + `  clean full-square exits ${clean}/8`);
  if (!clean) { out.verdict = 'the body is in rock — no direction moves it a useful distance'; return out; }

  // 2. CAN THE DESTINATION BE ENTERED AT ALL? A target nothing can step into is a target
  //    the mover will chase for ever.
  const t2 = C(to[0], to[1]);
  let enters = 0;
  for (const [dc, dr] of [[0,-1],[0,1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    const c = to[0] + dc, r = to[1] + dr;
    if (!geo.inBounds?.(r, c)) continue;
    const s = C(c, r);
    try {
      const t = geo.traceFineMoveClient(s.x, s.y, t2.x, t2.y, { slide: false });
      if (t?.arrived && !t?.blocked) enters++;
    } catch { /* ignore */ }
  }
  say(`  goal  (${to})  enterable from ${enters}/8 neighbours`);
  if (!enters) { out.verdict = 'the destination cannot be entered from anywhere — the target is the bug'; return out; }

  // 3. IS THERE A PLAN? And is the body in the same piece of free space as the goal?
  const g = regions(geo);
  const rf = labelAt(geo, f.x, f.y), rt = labelAt(geo, t2.x, t2.y);
  const p = navPath(geo, f, t2);
  say(`  free-space region ${rf} -> ${rt}   navPath ${p.found ? p.waypoints.length + ' waypoints' : 'NO ROUTE (' + p.reason + ')'}`);
  if (!p.found) { out.verdict = 'no plan — the planner and the mover agree there is no way'; return out; }

  // 4. CAN THE PHYSICS FOLLOW THE PLAN? This is the one that hides. Steering at the next
  //    waypoint is what the mover does; a lookahead is the same path aimed further ahead.
  const follow = (minAim) => {
    let x = f.x, y = f.y, idx = 0, stalls = 0;
    for (let step = 0; step < 80; step++) {
      let j = idx;
      while (j < p.waypoints.length - 1 &&
             Math.hypot(p.waypoints[j].x - x, p.waypoints[j].y - y) < minAim) j++;
      const w = p.waypoints[j];
      let t = null;
      try { t = geo.traceFineMoveClient(x, y, w.x, w.y, { slide: true }); } catch { /* ignore */ }
      const nx = t?.x ?? x, ny = t?.y ?? y;
      if (Math.hypot(nx - x, ny - y) < 1) { if (++stalls > 2) return { arrived: false, at: sq(x, y), step }; }
      else stalls = 0;
      x = nx; y = ny;
      while (idx < p.waypoints.length &&
             Math.hypot(p.waypoints[idx].x - x, p.waypoints[idx].y - y) < 200) idx++;
      if (Math.hypot(x - t2.x, y - t2.y) < 400) return { arrived: true, at: sq(x, y), step };
    }
    return { arrived: false, at: sq(x, y), step: 80 };
  };
  const now = follow(1), ahead = follow(1024);
  say(`  following the plan, aiming at the NEXT waypoint : ${now.arrived ? 'arrives' : 'STOPS at (' + now.at + ')'}`);
  say(`  following the plan, aiming a square AHEAD       : ${ahead.arrived ? 'arrives' : 'stops at (' + ahead.at + ')'}`);
  if (!now.arrived && ahead.arrived) out.verdict = 'the plan is walkable but only with a lookahead — steering, not the map';
  else if (!now.arrived && !ahead.arrived && ahead.at !== now.at)
    out.verdict = 'the physics cannot follow the plan; a lookahead helps but does not finish it';
  else if (!now.arrived) out.verdict = 'the physics cannot follow the plan at all';
  else out.verdict = 'the trip is walkable — the stall is not in this room';
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const roomNum = Number(arg('--room'));
  const from = pair(arg('--from')), to = pair(arg('--to'));
  if (!Number.isFinite(roomNum) || from.length !== 2 || to.length !== 2) {
    console.error('usage: node tools/m59-stall-probe.mjs --room <num> --from <col,row> --to <col,row>');
    process.exit(2);
  }
  const map = JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'm59-map.json'), 'utf8'));
  buildAllRoomGeometry(map);
  const room = map.rooms[roomNum];
  const geo = room && sharedRoomGeometry(room);
  if (!geo?.collisionReady) { console.error(`room ${roomNum} has no collision geometry`); process.exit(1); }
  console.log(`room ${roomNum} "${room.name}" ${geo.rows}x${geo.cols}`);
  const r = probe(geo, from, to);
  console.log(`\n  VERDICT: ${r.verdict}`);
}
