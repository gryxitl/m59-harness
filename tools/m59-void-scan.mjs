#!/usr/bin/env node
// m59-void-scan.mjs — dump, per square, every walkability predicate the harness holds,
// as an ASCII map that can be held next to what room3d draws for the same room.
//
// ## Why this file exists
//
// A character was observed standing in what the 3D client renders as a void, and the question
// — does the harness call a square walkable that has no floor? — could not be answered. It was
// instead answered WRONG, loudly: a scan reported 967 "no floor" squares in one room, a 78.9%
// median across forty rooms, and several rooms at 100%. All of it was the scan's own coordinate
// conversion. See docs/TICK-MOVEMENT-PLAN.md, "A void in room3d". The rule it earned:
//
//   A measurement that returns the same extreme value across unrelated inputs is a property of
//   the instrument, not of the thing measured.
//
// So this file does not invent a frame. It uses the SAME calls the running code uses, and it
// calibrates them against a character the server has placed in the room — a square a live
// character is standing on and alive is, by definition, standable as far as the server cares.
//
// ## The frames, written down because getting this wrong is the whole failure mode
//
//   kod square      (row, col) 1-based. walkable/standable/fineWalkable take these.
//                   This is what the keeper's /grid endpoint renders, so it is the frame the
//                   existing diagnostics are in.
//   protocol       proto = col*64 + 32 at a square centre. What the WIRE carries and what the
//                   mover keeps as myProtoX/myProtoY.
//   client         client = (proto - 64) * 16, i.e. protocolToClient(proto). What
//                   traceFineMoveClient takes. NOTE THE -64: this is an OFFSET conversion, not
//                   a scale, and treating it as identity is what produced the false result.
//                   A room of C columns spans protocolToClient(0) = -1024 to
//                   protocolToClient(C*64) = (C*64-64)*16, so client coordinates are NOT
//                   0..C*64 and a scan that assumes that samples outside the room.
//
// Usage:
//   node tools/m59-void-scan.mjs --room 557 [--self COL,ROW] [--out FILE]
//   node tools/m59-void-scan.mjs --room 557 --legend
import { RoomGeometry, protocolToClient, loadRoo } from './m59-roo.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const MAP = arg('map', 'substrate/m59-map.json');
const roomNum = Number(arg('room'));
if (!Number.isFinite(roomNum)) {
  console.error('usage: node tools/m59-void-scan.mjs --room NUM [--self COL,ROW] [--out FILE]');
  process.exit(2);
}

const db = JSON.parse(readFileSync(MAP, 'utf8'));
const rooms = Array.isArray(db.rooms) ? db.rooms : Object.values(db.rooms);
const room = rooms.find((r) => r.num === roomNum);
if (!room?.roo?.cols) { console.error(`room ${roomNum} not in ${MAP} (or has no baked roo)`); process.exit(1); }

const geo = RoomGeometry.fromJSON(room.roo);
const C = geo.cols, R = geo.rows;

// The live character, if given. Used ONLY as a calibration point: whatever square the server has
// put a living character on must read standable, and if it does not, the scan is wrong and not
// the room. This is the check that was missing when the last attempt went wrong.
let self = null;
const selfArg = arg('self');
if (selfArg) {
  const [c, r] = selfArg.split(',').map(Number);
  if (Number.isFinite(c) && Number.isFinite(r)) self = { col: c, row: r };
}

// Per-square predicates, each in the frame its own API expects.
//   coarse  walkable(row,col)        -- the server's one-byte grid
//   fine    fineWalkable(row,col)    -- the fine wall grid
//   stand   standable(row,col)       -- coarse OR any of a 5x5 lattice of BSP-floor points
//   floor   the BSP question on its own: is ANY point of that same 5x5 lattice occupiable.
//           standable() short-circuits on the coarse grid (m59-roo.mjs:1697), so `floor` is
//           what standable would answer if it did not. coarse=true with floor=false is the
//           disagreement worth looking at; it is a square the server's grid puts a body on
//           that the BSP has no floor polygon for anywhere on the square.
// THE FRAME THIS MUST BE ASKED IN, AND THE EVIDENCE FOR IT.
//
// `_occupiable` -> `leafAtClient` walks the baked BSP, and the baked BSP is stored in the
// CONVERTED client frame: a separator of {a:0,b:1024,c:-33030144} puts its line at
// y = -c/b = 32256, which is outside a room whose protocol extent is 0..3200 and inside the
// converted extent -1024..50176. That is not our bake inventing a frame -- the raw e7.roo on
// disk carries the same constant, and the sectors in the same file give ceilingHeight 4800,
// which is plain client units. The .roo format itself mixes the two scales.
//
// Measured on room 557, squares that resolve to a leaf at all:
//   raw (col-1)*64+32     366/2450   and the LIVE SQUARE DOES NOT RESOLVE
//   converted (v-64)*16  1234/2450   live square resolves
//   v*16                 1270/2450   live square resolves
//
// The runtime frame is settled by the code that actually moves characters, not by which of
// those two numbers is bigger: m59-ground.mjs:35, isEmbedded(), asks
// `traceFineMoveClient(protocolToClient(protoX), ...)` with protoX = col*64+32. So the frame
// is (v - 64) * 16, and a scan in the raw frame samples a region most of which is not the room.
//
// This is the exact error that produced the retracted "967 void squares" finding: the same
// lattice asked in the raw frame returns false for 998 of 1,282 squares, and asked here
// returns false for 169 of them.
function anyFloor(col, row) {
  let found = false;
  const x0 = (col - 1) * 64, y0 = (row - 1) * 64;
  for (let sy = 0; sy < 5 && !found; sy++) {
    for (let sx = 0; sx < 5; sx++) {
      const x = protocolToClient(x0 + Math.round((sx + 0.5) * 64 / 5));
      const y = protocolToClient(y0 + Math.round((sy + 0.5) * 64 / 5));
      if (geo._occupiable?.(x, y)) { found = true; break; }
    }
  }
  return found;
}

const cells = [];
for (let row = 1; row <= R; row++) {
  for (let col = 1; col <= C; col++) {
    const coarse = geo.walkable(row, col) === true;
    const fine = geo.fineWalkable(row, col) === true;
    const stand = geo.standable(row, col) === true;
    const floor = anyFloor(col, row);
    cells.push({ row, col, coarse, fine, stand, floor });
  }
}

// ---- calibration, before any conclusion ----
let calib = null;
if (self) {
  const c1 = self.col + 1, r1 = self.row + 1;      // /grid prints 0-based; the API is 1-based
  const cell = cells.find((x) => x.col === c1 && x.row === r1);
  const protoX = self.col * 64 + 32, protoY = self.row * 64 + 32;
  const tr = geo.traceFineMoveClient?.(protocolToClient(protoX), protocolToClient(protoY),
    protocolToClient(protoX), protocolToClient(protoY), { slide: false, playerRadius: 32 });
  calib = { self, one: { col: c1, row: r1 }, cell: cell ?? null, trace: tr ?? null };
}

// ---- summary ----
const n = (f) => cells.filter(f).length;
const coarseNoFloor = n((c) => c.coarse && !c.floor);
const coarseYes = n((c) => c.coarse);
const floorNoCoarse = n((c) => !c.coarse && c.floor);
const both = n((c) => c.coarse && c.floor);
const neither = n((c) => !c.coarse && !c.floor);
const fineVsCoarse = n((c) => c.coarse && !c.fine);

const out = [];
const P = (s = '') => { out.push(s); console.log(s); };
P(`room ${room.num}  ${room.name}  (${room.rooFile})  ${C}x${R} = ${C * R} squares`);
P(`collisionVersion ${room.roo.collisionVersion}  roo version ${room.roo.version}`);
P('');
P('predicates (each asked in the frame its own API uses):');
P(`  coarse walkable (server one-byte grid) : ${coarseYes}`);
P(`  BSP floor anywhere on the square       : ${n((c) => c.floor)}`);
P(`  both                                 : ${both}`);
P(`  coarse YES, BSP floor NO               : ${coarseNoFloor}${coarseYes ? `  (${(100 * coarseNoFloor / coarseYes).toFixed(1)}% of coarse-walkable)` : ''}`);
P(`  coarse NO,  BSP floor YES              : ${floorNoCoarse}`);
P(`  neither                                : ${neither}`);
P(`  coarse walkable but fine-blocked       : ${fineVsCoarse}`);
P('');
if (calib) {
  const t = calib.trace;
  P(`CALIBRATION -- the live character at (col,row)=${calib.self.col},${calib.self.row}  [1-based ${calib.one.col},${calib.one.row}]`);
  P(`  coarse=${calib.cell?.coarse} fine=${calib.cell?.fine} stand=${calib.cell?.stand} floor=${calib.cell?.floor}`);
  P(`  trace at protocolToClient(${calib.self.col * 64 + 32},${calib.self.row * 64 + 32}) = `
    + `blocked=${t?.blocked} arrived=${t?.arrived} reason=${t?.reason ?? 'none'}`);
  // The check that would have caught the last attempt: a scan that says the square a living
  // character is standing on has no floor is a broken scan. Refuse to report a verdict then.
  if (calib.cell && calib.cell.stand && !calib.cell.floor) {
    P('');
    P('  NOTE: the live square has coarse=stand but no BSP floor on the 5x5 lattice. That is');
    P('  either the disagreement being looked for, or the lattice/trace disagree with each');
    P('  other. Both are answerable from the map below by looking at the marked square.');
  }
  P('');
}

// ---- the map ----
// Legend, one character per square, four predicates in two rows of the same glyph set:
//   ' ' coarse-blocked, no floor      '.' coarse walkable WITH floor      '<' THE DISAGREEMENT
//   '#' coarse walkable, fine-blocked with floor
P('map  ( . = coarse+floor   < = coarse walkable but NO BSP floor   , = floor but coarse blocked   space = neither ):');
const rowsOut = [];
for (let row = 1; row <= R; row++) {
  let line = '';
  for (let col = 1; col <= C; col++) {
    const c = cells[(row - 1) * C + (col - 1)];
    let g = ' ';
    if (c.coarse && c.floor) g = '.';
    else if (c.coarse && !c.floor) g = '<';
    else if (!c.coarse && c.floor) g = ',';
    if (calib && c.col === calib.one.col && c.row === calib.one.row) g = '@';
    line += g;
  }
  rowsOut.push(line);
}
// room3d and /grid both read top-to-bottom; print with row 1 at the top and label every 5th.
for (let i = rowsOut.length - 1; i >= 0; i--) {
  const rowNo = i + 1;
  P((rowNo % 5 === 0 ? String(rowNo).padStart(3) : '   ') + ' ' + rowsOut[i]);
}
P('    +' + '-'.repeat(C));
const colAxis = Array.from({ length: C }, (_, i) => ((i + 1) % 5 === 0 ? String(((i + 1) / 5) % 10) : ' ')).join('');
P('     ' + colAxis);
P('      (col: each digit marks a multiple of 5)');

// ---- refuse to report a verdict the live character disproves ----
if (calib?.cell && !calib.trace?.blocked && !calib.cell.floor) {
  P('');
  P('*** SCAN IS WRONG, NOT THE ROOM: the live character is standing on this square and the');
  P("    trace at the mover's own coordinate reports blocked=false, but the lattice says no");
  P('    floor. A scan that disagrees with a living character is in the wrong frame. Fix the');
  P('    frame before believing any number above. ***');
}
if (arg('out')) { writeFileSync(arg('out'), out.join('\n') + '\n'); console.error(`written: ${arg('out')}`); }
