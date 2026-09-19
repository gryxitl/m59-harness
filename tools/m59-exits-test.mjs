#!/usr/bin/env node
// m59-exits-test.mjs -- unit tests for the tick-owned edge-exit provider.
// Offline, no network. Run: node tools/m59-exits-test.mjs

import { tickEdgeExits } from './tick/m59-exits.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// Fake map: room 382 with a north edge to 557 and baked approaches.
function fakeMap() {
  return {
    rooms: {
      382: {
        num: 382, name: 'West Jasper', cols: 67, rows: 76,
        exits: [{ leave: 2, leaveName: 'north', to: 557 }],
        roo: {
          file: 'jas-west.roo',
          edgeApproaches: {
            north: [[3856, 96, 3856, 63, [[60, 1], [61, 1], [60, 2], [61, 2]], 1]],
          },
        },
      },
      557: { num: 557, name: 'Sweet Grass', cols: 10, rows: 10 },
    },
  };
}

function fakeGeo({ standable = () => true, fineWalkable = () => true } = {}) {
  return { collisionReady: true, standable, fineWalkable };
}

{
  const exits = tickEdgeExits({ map: fakeMap(), roomNum: 382, geo: fakeGeo() });
  ok(exits.length === 1, 'one edge exit offered');
  const e = exits[0];
  ok(e.to === 557, 'to the mapped room');
  ok(e.kind === 'edge' && e.direction === 'north', 'edge kind + direction');
  ok(e.stand_on && Number.isFinite(e.stand_on.col), 'has a stand_on square');
  ok(e.edge_target && e.edge_target.row === e.stand_on.row - 1, 'edge target one square past (north)');
}

{
  // A baked approach square with provably no BSP floor is dropped.
  const geo = fakeGeo({ standable: (r, c) => !(r === 1 && c === 60) });
  const exits = tickEdgeExits({ map: fakeMap(), roomNum: 382, geo });
  const sqs = [exits[0]?.stand_on, ...(exits[0]?.alternates ?? []).map(a => a.stand_on)];
  ok(!sqs.some(s => s && s.col === 60 && s.row === 1), 'floorless baked square dropped');
  ok(sqs.some(s => s && s.col === 61 && s.row === 1), 'other baked squares kept');
}

{
  // No map room, no exits (never throws).
  ok(tickEdgeExits({ map: fakeMap(), roomNum: 999, geo: fakeGeo() }).length === 0, 'unknown room yields nothing');
  ok(tickEdgeExits({}).length === 0, 'empty input yields nothing');
  ok(tickEdgeExits({ map: fakeMap(), roomNum: 382, geo: null }).length === 1, 'no geometry still offers (unverified)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
