#!/usr/bin/env node
// m59-asymmetry-probe.mjs — three-layer asymmetry probe for a specific room.
//
// Distinguishes "poisoned navgeom memo" (the symmetric-key cache) from "baked mask bit"
// in one run. For a room where the mask is NOT baked (_stepMask == null), the trace path
// is live and the memo-key question is real.
//
// Usage: node tools/m59-asymmetry-probe.mjs --room 557
//
// The test:
// 1. Find an asymmetric edge (moverStepLands(A,B) !== moverStepLands(B,A)).
// 2. Call finePathProtocol from A to B (which populates _edgeOk with moverStepLands(A,B)
//    under the symmetric key).
// 3. Check if _edgeOk serves the same value for A→B and B→A (the symmetric-key bug).
// 4. Compare _edgeOk's value to moverStepLands(B,A) (the cold trace).
//
// If _edgeOk serves moverStepLands(A,B) for both directions (the symmetric-key bug), but
// moverStepLands(B,A) differs, the memo is poisoned.

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
  console.error('usage: node tools/m59-asymmetry-probe.mjs --room NUM');
  process.exit(2);
}

const db = JSON.parse(readFileSync(MAP, 'utf8'));
const rooms = Array.isArray(db.rooms) ? db.rooms : Object.values(db.rooms);
const room = rooms.find((r) => r.num === roomNum);
if (!room?.roo?.cols) { console.error(`room ${roomNum} not in ${MAP} (or has no baked roo)`); process.exit(1); }

const geo = RoomGeometry.fromJSON(room.roo);
const freshGeo = RoomGeometry.fromJSON(room.roo); // cold geometry
const C = geo.cols, R = geo.rows;

console.log(`room ${roomNum}  ${room.name ?? ''}  ${C}x${R} = ${C * R} squares`);
console.log(`_stepMask: ${geo._stepMask == null ? 'NULL (trace path live, memo-key question real)' : 'BAKED (cold-vs-warm probe is a tautology)'}`);
console.log('');

// Find asymmetric edges: moverStepLands(A,B) !== moverStepLands(B,A)
const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
let asymmetricCount = 0;
let examples = [];

for (let r = 1; r < R - 1; r++) {
  for (let c = 1; c < C - 1; c++) {
    for (const [dr, dc] of dirs) {
      const r2 = r + dr, c2 = c + dc;
      if (r2 < 0 || r2 >= R || c2 < 0 || c2 >= C) continue;
      const ab = freshGeo.moverStepLands(r, c, r2, c2);
      const ba = freshGeo.moverStepLands(r2, c2, r, c);
      if (ab !== ba) {
        asymmetricCount++;
        if (examples.length < 5) {
          // Call finePathProtocol from A to B to populate _edgeOk
          // (the edgeWalkable function is only called during a path search)
          try { geo.finePathProtocol(r, c, r2, c2, { step: 8, margin: 12 }); } catch {}
          // Now check if _edgeOk is populated and serves the symmetric-key bug
          const ekSym = (r < r2 || (r === r2 && c < c2)) ? `${r},${c},${r2},${c2}` : `${r2},${c2},${r},${c}`;
          const edgeOkVal = geo._edgeOk?.get(ekSym) ?? 'n/a (not populated)';
          const layer2AB = geo.moverStepLands(r, c, r2, c2);
          const layer2BA = geo.moverStepLands(r2, c2, r, c);
          const layer3AB = freshGeo.moverStepLands(r, c, r2, c2);
          const layer3BA = freshGeo.moverStepLands(r2, c2, r, c);
          // The symmetric-key bug: _edgeOk serves the FIRST traversal's value for BOTH directions
          const memoPoisoned = edgeOkVal !== 'n/a (not populated)'
            && edgeOkVal === layer2AB  // _edgeOk serves the first traversal (A→B)
            && layer2AB !== layer2BA;  // but A→B and B→A differ
          examples.push({
            A: [r, c], B: [r2, c2],
            edgeOkVal,
            layer2AB, layer2BA,
            layer3AB, layer3BA,
            memoPoisoned,
          });
        }
      }
    }
  }
}

console.log(`asymmetric edges: ${asymmetricCount}`);
console.log('');

for (const ex of examples) {
  console.log(`edge A(${ex.A[0]},${ex.A[1]}) -> B(${ex.B[0]},${ex.B[1]})`);
  console.log(`  _edgeOk (symmetric key):       ${ex.edgeOkVal}`);
  console.log(`  layer 2 (moverStepLands, live):  A→B=${ex.layer2AB}  B→A=${ex.layer2BA}`);
  console.log(`  layer 3 (freshGeo, cold):        A→B=${ex.layer3AB}  B→A=${ex.layer3BA}`);
  console.log(`  memo poisoned: ${ex.memoPoisoned ? 'YES (_edgeOk serves A→B value for both, but A→B !== B→A)' : 'no'}`);
  console.log('');
}

if (asymmetricCount === 0) {
  console.log('no asymmetric edges found — the asymmetric-predicate bug is not the cause of the pocket in this room');
} else {
  const poisoned = examples.filter(e => e.memoPoisoned).length;
  console.log(`summary: ${poisoned}/${examples.length} examples show memo poisoning (_edgeOk serves the first traversal's value for both directions, but the directions differ)`);
}
