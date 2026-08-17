#!/usr/bin/env node
// ONE TRAVEL CALL IS THE WHOLE JOURNEY — the contract test for the resume loop.
//
//   node tools/m59-travel-test.mjs
//
// Offline. It drives the real `Session.travel` loop against a fake world and a fake
// walker, because the thing under test is the CONTROL FLOW — when a failed hop is retried,
// when it is given up on, and what the budgets mean — and that needs a room graph that can
// be told to fail on demand, not a live server two towns away.
//
// The four properties, each of which is a real failure this replaces:
//
//   1. A TRANSIENT HOP FAILURE IS RETRIED, not returned. Every caller used to need its own
//      retry loop; one that forgot got a character stranded halfway across the world with
//      the trip reported as finished.
//   2. A STUMBLE IS NOT A HOP. Re-settling in one sticky doorway must not consume the
//      budget for crossing rooms.
//   3. PATIENCE IS BOUNDED. A room that will never let us out has to end the journey
//      rather than spin.
//   4. A REAL DEAD END STILL REPORTS ITSELF. Retrying must not turn "no route" into
//      silence — the reason survives to the caller.
import { strict as assert } from 'node:assert';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a Session: a chain of rooms 1..N, a
// scripted list of hop outcomes, and the two helpers travel() reaches for.
// ---------------------------------------------------------------------------
function fakeSession({ rooms = [1, 2, 3, 4], script = [], startAt = 0 } = {}) {
  const s = {
    name: 'test',
    at: startAt,
    movementGeneration: 0,
    reads: 0,
    noteTransit: () => {},
    pacer: { submit: async (_k, fn) => fn() },
    client: {
      roomContents: async () => { s.reads++; },
      waitFor: async () => {},
    },
    movementWasCancelled: () => false,
    cancelledMovement: ({ log }) => ({ arrived: false, cancelled: true, log }),
    world: {
      get room() {
        const n = rooms[s.at];
        return n == null ? null : { num: n, name: `room ${n}` };
      },
      route(to) {
        const here = rooms[s.at];
        if (here == null) return { found: false, reason: 'start is outside the room grid' };
        const idx = rooms.indexOf(to);
        if (idx < 0) return { found: false, reason: 'no route' };
        if (idx === s.at) return { found: true, hops: [] };
        const next = rooms[s.at + (idx > s.at ? 1 : -1)];
        return { found: true, hops: [{ to: next, to_name: `room ${next}` }] };
      },
      exits: () => {
        const next = rooms[s.at + 1];
        return next == null ? [] : [{ to: next, kind: 'edge', stand_on: { col: 1, row: 1 } }];
      },
    },
    // Each call consumes one scripted outcome; `true` moves us on, `false` refuses.
    async leaveViaAny() {
      const outcome = script.length ? script.shift() : true;
      if (outcome === 'vanish') { s.at = null; return { left: false, reason: 'coordinates went off grid' }; }
      if (outcome) { s.at += 1; return { left: true, used_exit: { stand_on: { col: 1, row: 1 } } }; }
      return { left: false, reason: 'no floor anywhere on the north boundary' };
    },
  };
  return s;
}

// BORROW THE REAL IMPLEMENTATION, NEVER A COPY. A test against a reimplementation of this
// loop tests the reimplementation. `m59-broker.mjs` cannot be imported — importing it takes
// the fleet lock and starts rejoin timers — so the method is lifted out of the source by
// BRACE MATCHING, which is exact, rather than by hunting for a closing line that also
// appears inside the body.
const src = await import('node:fs').then(m => m.readFileSync('tools/m59-broker.mjs', 'utf8'));
const start = src.indexOf('  async travel(toRoomNum, {');
ok('the travel method was located', start > 0);
// Start matching at the BODY brace, not at the destructured options object in the
// signature — that one balances on its own and closes the match before the loop begins.
const SIG_END = '} = {}) {';
const sigAt = src.indexOf(SIG_END, start);
ok('the signature end was located', sigAt > start);
let depth = 0, i = sigAt + SIG_END.length - 1, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const travelSrc = src.slice(start, end);
ok('it is the version with the resume loop', travelSrc.includes('maxStumbles'));
ok('and it is a whole method', travelSrc.trim().endsWith('}'));
const travel = new Function('orderExits', `return ({ ${travelSrc} }).travel`)((c) => c);


// ---------------------------------------------------------------------------
console.log('a clean journey arrives, and counts its hops');
{
  const s = fakeSession({ rooms: [1, 2, 3, 4] });
  const r = await travel.call(s, 4, {});
  ok('arrived', r.arrived === true);
  ok('three hops', r.hops === 3);
  ok('no stumbles', r.stumbles === 0);
  ok('already there is instant', (await travel.call(fakeSession({ startAt: 3 }), 4, {})).hops === 0);
}

// ---------------------------------------------------------------------------
console.log('a transient hop failure is retried rather than returned');
{
  // Refuse the first doorway twice, then let it through. This is the case that used to
  // return arrived:false and strand the character in room 1.
  const s = fakeSession({ rooms: [1, 2, 3], script: [false, false, true, true] });
  const r = await travel.call(s, 3, {});
  ok('the journey still completes', r.arrived === true);
  ok('and says how much it stumbled', r.stumbles >= 1);
  ok('the room was re-read before retrying', s.reads > 0);
  ok('the stumbles are in the log', r.log.some(l => l.stumble));
}

{
  // The classic: coordinates read as off-grid for an instant. `world.room` is null and
  // `route` reports "start is outside the room grid" — both must be survivable.
  const s = fakeSession({ rooms: [1, 2], script: ['vanish'] });
  s.at = 0;
  const r = await travel.call(s, 2, { maxStumbles: 3 });
  ok('an off-grid instant does not end the journey by itself', r.log.some(l => l.stumble));
}

// ---------------------------------------------------------------------------
console.log('a stumble is not a hop');
{
  // One sticky doorway, then a clean run. With stumbles counted as hops, a maxHops of 3
  // would run out before crossing three rooms.
  const s = fakeSession({ rooms: [1, 2, 3, 4], script: [false, false, true, true, true] });
  const r = await travel.call(s, 4, { maxHops: 3 });
  ok('the hop budget still buys three rooms', r.arrived === true);
  ok('and the hops counted are rooms crossed, not attempts', r.hops === 3);
}

// ---------------------------------------------------------------------------
console.log('patience is bounded, and the reason survives');
{
  const s = fakeSession({ rooms: [1, 2], script: [false, false, false, false, false, false, false, false, false] });
  const r = await travel.call(s, 2, { maxStumbles: 3 });
  ok('a doorway that never opens ends the journey', r.arrived === false);
  ok('it does not spin past its patience', r.stumbles === 4);
  ok('and it still says WHY, not just that it failed',
     /no floor anywhere on the north boundary/.test(r.reason));
}

{
  const s = fakeSession({ rooms: [1, 2, 3] });
  const r = await travel.call(s, 99, { maxStumbles: 2 });
  ok('a destination not in the graph is refused', r.arrived === false);
  ok('and reports no route rather than a doorway problem', /no route/.test(r.reason));
}

{
  const s = fakeSession({ rooms: [1, 2, 3, 4, 5, 6] });
  const r = await travel.call(s, 6, { maxHops: 2 });
  ok('the hop budget is still honoured', r.arrived === false);
  ok('and says so plainly', /gave up after 2 hops/.test(r.reason));
}

// ---------------------------------------------------------------------------
console.log('cancellation still wins, because it is the survival path');
{
  const s = fakeSession({ rooms: [1, 2, 3] });
  s.movementWasCancelled = () => true;
  const r = await travel.call(s, 3, {});
  ok('a cancelled movement stops the journey', r.cancelled === true);
  ok('and it does not report arrival', r.arrived !== true);
}

console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
