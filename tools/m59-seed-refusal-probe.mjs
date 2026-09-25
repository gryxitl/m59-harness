#!/usr/bin/env node
// m59-seed-refusal-probe.mjs — instrumented call for a specific room and start square.
//
// Prints each neighbour's moverStepLands value, and the walkable/fineWalkable/standable
// for the origin and each neighbour. This adjudicates whether the strict tier's
// expanded=1 is geometry (moverStepLands refuses) or blockedEdges poisoning.
//
// Usage: node tools/m59-seed-refusal-probe.mjs --room 556 --start 55,7

import { RoomGeometry } from './m59-roo.mjs';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const MAP = arg('map', 'substrate/m59-map.json');
const roomNum = Number(arg('room'));
const startArg = arg('start');
if (!Number.isFinite(roomNum) || !startArg) {
  console.error('usage: node tools/m59-seed-refusal-probe.mjs --room NUM --start COL,ROW');
  process.exit(2);
}
const [startC, startR] = startArg.split(',').map(Number);

const db = JSON.parse(readFileSync(MAP, 'utf8'));
const rooms = Array.isArray(db.rooms) ? db.rooms : Object.values(db.rooms);
const room = rooms.find((r) => r.num === roomNum);
if (!room?.roo?.cols) { console.error(`room ${roomNum} not in ${MAP} (or has no baked roo)`); process.exit(1); }

const geo = RoomGeometry.fromJSON(room.roo);
const C = geo.cols, R = geo.rows;

console.log(`room ${roomNum}  ${room.name ?? ''}  ${C}x${R} = ${C * R} squares`);
console.log(`start: (${startC},${startR})`);
console.log('');

// Origin predicates
const originWalkable = geo.walkable(startR, startC);
const originFine = geo.fineWalkable(startR, startC);
const originStand = geo.standable(startR, startC);
console.log(`origin (${startC},${startR}):`);
console.log(`  walkable: ${originWalkable}`);
console.log(`  fineWalkable: ${originFine}`);
console.log(`  standable: ${originStand}`);
console.log('');

// Neighbour predicates
const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
const dirNames = ['N','S','W','E','NW','NE','SW','SE'];
let refusedCount = 0;
for (let i = 0; i < dirs.length; i++) {
  const [dr, dc] = dirs[i];
  const r2 = startR + dr, c2 = startC + dc;
  if (r2 < 0 || r2 >= R || c2 < 0 || c2 >= C) {
    console.log(`${dirNames[i]} (${c2},${r2}): out of bounds`);
    continue;
  }
  const nWalkable = geo.walkable(r2, c2);
  const nFine = geo.fineWalkable(r2, c2);
  const nStand = geo.standable(r2, c2);
  const msl = geo.moverStepLands(startR, startC, r2, c2);
  const mslRev = geo.moverStepLands(r2, c2, startR, startC);
  if (!msl) refusedCount++;
  console.log(`${dirNames[i]} (${c2},${r2}):`);
  console.log(`  walkable: ${nWalkable}  fineWalkable: ${nFine}  standable: ${nStand}`);
  console.log(`  moverStepLands(origin->n): ${msl}  (reverse: ${mslRev})`);
}

console.log('');
console.log(`refused: ${refusedCount}/8 neighbours`);
if (refusedCount === 8) {
  console.log('CONCLUSION: all 8 neighbours refused. The strict tier\'s expanded=1 is confirmed.');
  console.log('If the neighbours are walkable && fineWalkable, the refusal is moverStepLands (geometry or blockedEdges).');
} else if (refusedCount === 0) {
  console.log('CONCLUSION: no neighbours refused. The strict tier should not exhaust at expanded=1.');
} else {
  console.log(`CONCLUSION: ${refusedCount}/8 neighbours refused. Partial refusal.`);
}
