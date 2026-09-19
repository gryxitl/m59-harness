#!/usr/bin/env node
// m59-landing-gate-probe.mjs — adjudicate the root cause of the pocket.
//
// Build a fresh geo for a room, enumerate intersection squares (walkable && fineWalkable),
// and count one-way edges, isolating the gate's contribution:
//   1. traceOneWay: the trace itself is one-way (ab !== ba)
//   2. absGateMakesOneWay: trace two-way, but Math.abs gate makes it one-way
//   3. signedGateMakesOneWay: trace two-way, but signed gate makes it one-way
//
// If absGateMakesOneWay is large and signedGateMakesOneWay is small, the absolute-value
// gate is the root cause, and Phase 2 (the unidirectional climb gate) is the fix.

import { RoomGeometry } from './m59-roo.mjs';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const MAP = arg('map', 'substrate/m59-map.json');
const roomNum = Number(arg('room'));
if (!Number.isFinite(roomNum)) {
  console.error('usage: node tools/m59-landing-gate-probe.mjs --room NUM');
  process.exit(2);
}

const db = JSON.parse(readFileSync(MAP, 'utf8'));
const rooms = Array.isArray(db.rooms) ? db.rooms : Object.values(db.rooms);
const room = rooms.find((r) => r.num === roomNum);
if (!room?.roo?.cols) { console.error(`room ${roomNum} not in ${MAP} (or has no baked roo)`); process.exit(1); }

const geo = RoomGeometry.fromJSON(room.roo);
const C = geo.cols, R = geo.rows;
const MAX_STEP_HEIGHT = 192; // the repo's constant

console.log(`room ${roomNum}  ${room.name ?? ''}  ${C}x${R} = ${C * R} squares`);
console.log('');

const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];

let totalEdges = 0;
let traceOneWay = 0;
let absGateMakesOneWay = 0;
let signedGateMakesOneWay = 0;

for (let r = 1; r < R - 1; r++) {
  for (let c = 1; c < C - 1; c++) {
    if (!geo.walkable(r, c) || !geo.fineWalkable(r, c)) continue;
    for (const [dr, dc] of dirs) {
      const r2 = r + dr, c2 = c + dc;
      if (r2 < 0 || r2 >= R || c2 < 0 || c2 >= C) continue;
      if (!geo.walkable(r2, c2) || !geo.fineWalkable(r2, c2)) continue;
      totalEdges++;

      const standFrom = geo.standPoint(r, c);
      const standTo = geo.standPoint(r2, c2);
      if (!standFrom || !standTo) continue;

      const fromX = standFrom.x, fromY = standFrom.y;
      const toX = standTo.x, toY = standTo.y;

      let ab = false, ba = false;
      try {
        const t = geo.traceFineMoveClient(fromX, fromY, toX, toY, { slide: true });
        ab = t.arrived === true;
      } catch {}
      try {
        const t = geo.traceFineMoveClient(toX, toY, fromX, fromY, { slide: true });
        ba = t.arrived === true;
      } catch {}

      if (ab !== ba) traceOneWay++;

      let landedFloorAB = NaN, landedFloorBA = NaN;
      try {
        const t = geo.traceFineMoveClient(fromX, fromY, toX, toY, { slide: true });
        if (t.arrived) landedFloorAB = geo.floorBaseAtClient(t.x, t.y);
      } catch {}
      try {
        const t = geo.traceFineMoveClient(toX, toY, fromX, fromY, { slide: true });
        if (t.arrived) landedFloorBA = geo.floorBaseAtClient(t.x, t.y);
      } catch {}

      const aimFloorAB = geo.floorBaseAtClient(toX, toY);
      const aimFloorBA = geo.floorBaseAtClient(fromX, fromY);

      if (ab === ba) {
        const abRefused = Number.isFinite(landedFloorAB) && Number.isFinite(aimFloorAB)
          && Math.abs(landedFloorAB - aimFloorAB) > MAX_STEP_HEIGHT;
        const baRefused = Number.isFinite(landedFloorBA) && Number.isFinite(aimFloorBA)
          && Math.abs(landedFloorBA - aimFloorBA) > MAX_STEP_HEIGHT;
        if (ab && !abRefused !== ba && !baRefused) absGateMakesOneWay++;

        const abRefusedSigned = Number.isFinite(landedFloorAB) && Number.isFinite(aimFloorAB)
          && (landedFloorAB - aimFloorAB) > MAX_STEP_HEIGHT;
        const baRefusedSigned = Number.isFinite(landedFloorBA) && Number.isFinite(aimFloorBA)
          && (landedFloorBA - aimFloorBA) > MAX_STEP_HEIGHT;
        if (ab && !abRefusedSigned !== ba && !baRefusedSigned) signedGateMakesOneWay++;
      }
    }
  }
}

console.log(`intersection edges: ${totalEdges}`);
console.log(`trace one-way (ab !== ba):           ${traceOneWay}  (${(100 * traceOneWay / totalEdges).toFixed(1)}%)`);
console.log(`Math.abs gate makes two-way one-way: ${absGateMakesOneWay}  (${(100 * absGateMakesOneWay / totalEdges).toFixed(1)}%)`);
console.log(`signed gate makes two-way one-way:   ${signedGateMakesOneWay}  (${(100 * signedGateMakesOneWay / totalEdges).toFixed(1)}%)`);
console.log('');

if (absGateMakesOneWay > signedGateMakesOneWay) {
  console.log(`CONCLUSION: the Math.abs gate makes ${absGateMakesOneWay} edges one-way, the signed gate makes ${signedGateMakesOneWay}. The absolute-value gate is the root cause. Phase 2 (the unidirectional climb gate) is the fix.`);
} else {
  console.log(`CONCLUSION: the Math.abs gate makes ${absGateMakesOneWay} edges one-way, the signed gate makes ${signedGateMakesOneWay}. The absolute-value gate is NOT the root cause (the trace itself is one-way for ${traceOneWay} edges).`);
}
