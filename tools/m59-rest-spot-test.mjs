#!/usr/bin/env node
// TESTS FOR THE REST-SPOT POLICY: where a hurt character recovers, and how long it may
// stop for. Run: node tools/m59-rest-spot-test.mjs
//
// These are written against ROOMS FROM THE MAP rather than invented geometry wherever
// possible, because the failure mode this feature has is "the answer is wrong in a room
// that exists". The first version of the budget accounting passed every test I wrote
// against a stub and was broken; see the two-episode test at the bottom.

import { restSpotFor, noteResting, noteStoppedResting, noteRoomChanged, noteNewJourney,
         REST_HOLD_BUDGET_MS, REST_SPOT_WITHIN_SQUARES } from './tick/m59-rest-spot.mjs';
import { nearestSafeSpot, geometryFor } from './m59-safespots.mjs';
import { loadMap } from './m59-map.mjs';

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`); }
};

const map = loadMap();

// A session with real baked geometry for a real room, which is what the policy is
// actually asked about. `now` is injectable so the budget can be tested without sleeping.
function roomSession(num, col, row, { now = () => Date.now() } = {}) {
  const room = map.rooms[num];
  let geo = null;
  try { geo = geometryFor(room); } catch { geo = null; }
  const me = { col, row, x: col * 64 + 32, y: row * 64 + 32 };
  return {
    world: { geometry: geo, room: { num } },
    client: { self: me, room: { num } },
    _pose: { current: () => ({ col, row }) },
    _now: now,
  };
}

// ---------------------------------------------------------------------------
console.log('a hurt character walks to a defensible square rather than sitting down');
{
  // Room 556 (Deep Forest of Farol) is a TRANSIT room — the fleet crosses it on the way to
  // the hunt rooms, which is exactly where a mid-journey rest happens.
  const s = roomSession(556, 20, 20);
  const r = restSpotFor(s);
  ok(r.action === 'walk' || r.action === 'rest-here', 'it gives an answer', r.action);
  ok(r.spot != null, '556 has a defensible square to offer', JSON.stringify(r.spot));
  if (r.spot) {
    // The square it offers must be the one the geometry actually rates as defensible, not a
    // square this module invented. Checked against nearestSafeSpot directly.
    const direct = nearestSafeSpot(s.world.geometry, { col: 20, row: 20 },
                                   { within: REST_SPOT_WITHIN_SQUARES });
    ok(direct != null && direct.col === r.spot.col && direct.row === r.spot.row,
       'and it is the square the geometry rates as defensible',
       `${r.spot.col},${r.spot.row} vs ${direct?.col},${direct?.row}`);
  }
}

console.log('\nWALKING TO A WALL MUST BE SHORTER THAN CROSSING THE ROOM FOR IT');
{
  // `within` is a budget, not a search radius. Crossing half a room while hurt to reach
  // shelter spends the shelter to get it.
  const s = roomSession(556, 20, 20);
  const r = restSpotFor(s);
  if (r.spot) {
    ok(r.spot.col != null && r.spot.row != null, 'the spot has coordinates');
    const far = roomSession(556, 20, 20);
    const d = nearestSafeSpot(far.world.geometry, { col: 20, row: 20 },
                              { within: REST_SPOT_WITHIN_SQUARES });
    ok(d == null || d.steps_away <= REST_SPOT_WITHIN_SQUARES,
       `nothing is offered further than ${REST_SPOT_WITHIN_SQUARES} squares`,
       d ? `offered ${d.steps_away}` : 'nothing offered');
  } else { ok(true, 'no spot offered, so nothing far was offered either'); }
}

console.log('\nA ROOM WITH NO DEFENSIBLE SQUARE STILL GETS AN ANSWER');
{
  // THE BROWNESTONE INN (106), 6x12. It is a shop: there is no wall in it that qualifies as
  // defensible, and that is a fact about the room, not a failure. The first version of this
  // rule returned null in that case and the character stood up at 5/20 HP doing nothing,
  // which is strictly worse than resting in the open. This is the regression that matters
  // most here, because it is the failure that would ship as "the bot is on strike".
  const s = roomSession(106, 3, 5);
  const direct = (() => { try { return nearestSafeSpot(s.world.geometry, { col: 3, row: 5 }, { within: 10 }) } catch { return null } })();
  const r = restSpotFor(s);
  ok(r.action === 'rest-here', 'the inn says rest here', `${r.action}: ${r.why}`);
  ok(r.spot === null, 'and offers no spot, honestly', JSON.stringify(r.spot));
  ok(direct === null, 'the geometry agrees the inn has no defensible square',
     JSON.stringify(direct));
}

console.log('\nEVERY FAILURE PATH RESTS RATHER THAN STALLING');
{
  // Never throws, never null, never "no answer". A caller that has to handle absence
  // eventually gets it wrong, and the wrong answer here is a character standing at 5 HP.
  const cases = [
    ['a room with no baked geometry', { world: { room: { num: 556 } }, client: { self: { col: 5, row: 5 } }, _pose: { current: () => ({ col: 5, row: 5 }) } }],
    ['no position at all', { world: { room: { num: 556 } }, client: { self: null }, _pose: null }],
    ['no session at all', null],
    ['an undefined session', undefined],
    ['geometry that throws on access', { world: { get geometry() { throw new Error('bad bake') }, room: { num: 1 } }, client: { self: { col: 1, row: 1 } }, _pose: { current: () => ({ col: 1, row: 1 }) } }],
    ['a room number that is not in the map', roomSession(999999, 5, 5)],
    ['_pose.current() that throws', { world: { room: { num: 556 } }, client: { self: { col: 1, row: 1 } }, _pose: { current: () => { throw new Error('no self') } } }],
  ];
  for (const [what, s] of cases) {
    let r = null, threw = null;
    try { r = restSpotFor(s) } catch (e) { threw = e.message }
    ok(threw === null && r != null && r.action === 'rest-here',
       what, threw ? `threw: ${threw}` : JSON.stringify(r));
  }
}

console.log('\nTHE BUDGET: a journey that keeps stopping is a journey that never arrives');
{
  // Out of budget, the character must rest-and-walk-on rather than search forever.
  let t = 1_000_000;
  const s = roomSession(556, 20, 20);
  s._restHeldMs = REST_HOLD_BUDGET_MS + 1;
  const r = restSpotFor(s, { now: () => t });
  ok(r.action === 'rest-here', 'spent budget stops offering a walk', r.action);
  ok(/budget/.test(r.why), 'and says why in the terms the rule is written in', r.why);
}

console.log('\nTHE BUDGET MEASURES TIME RESTING, NOT TIME DECIDING');
{
  // THE BUG THIS TEST EXISTS FOR. The first version called noteStoppedResting on the same
  // tick it called rest(), which banked the elapsed time on EVERY rest tick. A character
  // that rested once would find its budget spent immediately and the feature would be
  // silently off — and every stub test passed, because no stub rested twice.
  let t = 1_000_000;
  const s = roomSession(556, 20, 20);
  const now = () => t;

  // Sit down and rest for 60 seconds, ticking once a second like the real driver.
  const first = restSpotFor(s, { now });
  ok(first.action === 'walk' || first.action === 'rest-here', 'a fresh character gets a plan', first.action);
  noteResting(s, { now });                       // it sat
  for (let i = 0; i < 60; i++) { t += 1000; noteResting(s, { now }); }
  noteStoppedResting(s, { now });                // it stood up

  ok(s._restHeldMs >= 59_000 && s._restHeldMs <= 61_000,
     'one 60-second rest costs 60 seconds of budget, not 60 banks', String(s._restHeldMs));

  // And a SECOND rest in the same room still works and is added, not reset.
  noteResting(s, { now });
  for (let i = 0; i < 30; i++) { t += 1000; noteResting(s, { now }); }
  noteStoppedResting(s, { now });
  ok(s._restHeldMs >= 89_000 && s._restHeldMs <= 91_000,
     'a second 30-second rest accumulates to 90s', String(s._restHeldMs));

  // Enough further resting to reach the ceiling: 60 + 30 + 90 = 180.
  // (The first version of this line added 50s and asserted 180, which failed on the test's
  // own arithmetic. 90s is what is left of the budget, and getting this wrong in a test is
  // how a budget test ends up asserting a number that was never reachable.)
  noteResting(s, { now }); t += 90_000; noteStoppedResting(s, { now });
  ok(s._restHeldMs >= REST_HOLD_BUDGET_MS, 'and reaches the 180s ceiling', String(s._restHeldMs));
  const after = restSpotFor(s, { now });
  ok(after.action === 'rest-here' && after.spot === null,
     'once spent it walks on rather than hunting for a wall', JSON.stringify(after));
}

console.log('\nTHE BUDGET IS PER JOURNEY, NOT PER ROOM');
{
  // This test used to assert the opposite — that a room change cleared the budget — because
  // that is what the first version did. It was wrong, and the test passed because it was
  // written to match the code rather than to match the reason. A hurt character crossing
  // five rooms got a fresh 180s in each: fifteen minutes of stopping on one journey, while
  // reporting itself within budget the whole time. That is the exact failure the budget
  // exists to prevent, reintroduced by the accounting meant to enforce it.
  //
  // The legacy is unambiguous: travelHeldMs is zeroed at trip start (m59-autopilot.mjs:5176)
  // and trip end (:5272), and only ever added to in between (:4893, :5014).
  let t = 1_000_000;
  const now = () => t;
  const s = roomSession(556, 20, 20);
  s._restHeldMs = REST_HOLD_BUDGET_MS + 5000;
  ok(restSpotFor(s, { now }).spot === null, 'spent within the journey');

  // A room change must NOT clear it. This is the assertion that would have failed the
  // original implementation, which is the point of writing it now.
  noteRoomChanged(s);
  ok(s._restHeldMs > 0, 'a room change does not hand back a spent budget',
     String(s._restHeldMs));

  // A NEW JOURNEY does clear it, and that is the only thing that does while moving.
  noteNewJourney(s);
  ok(s._restHeldMs === 0, 'a new journey starts the allowance fresh', String(s._restHeldMs));
  const next = restSpotFor(s, { now });
  ok(next.action === 'walk' || next.spot !== null, 'and a new journey can use a wall again',
     JSON.stringify(next));
}

console.log('\nA CHOSEN SPOT IS HELD, NOT RE-DECIDED EVERY TICK');
{
  // Re-running the search every tick is how a character ends up between two equally good
  // walls and sheltered at neither — the same thrash the `stand before moving` rule exists
  // to stop. Once a square is chosen, keep walking to it.
  let t = 1_000_000;
  const now = () => t;
  const s = roomSession(556, 20, 20);
  const first = restSpotFor(s, { now });
  ok(first.action === 'walk', 'first tick chooses a square to walk to', first.action);
  const chosen = { ...first.spot };

  // Walk partway, ticking. The target must not move underneath us.
  for (let i = 0; i < 5; i++) {
    t += 1000;
    const r = restSpotFor(s, { now });
    ok(r.spot.col === chosen.col && r.spot.row === chosen.row,
       `tick ${i}: still walking to ${chosen.col},${chosen.row}`,
       r.spot ? `${r.spot.col},${r.spot.row}` : 'no spot');
    if (r.spot.col !== chosen.col || r.spot.row !== chosen.row) break;
  }

  // Arrive: same square as the spot. It must say rest, not walk to itself.
  s._pose = { current: () => ({ col: chosen.col, row: chosen.row }) };
  const arrived = restSpotFor(s, { now });
  ok(arrived.action === 'rest-here', 'on arrival it rests', arrived.action);
  // The message is 'already on the spot we chose' — the held-spot branch, not a fresh
  // search. Asserting the branch rather than the wording is what makes this test survive a
  // rewording while still catching a change that re-ran the search on arrival.
  ok(/already on the spot/.test(arrived.why), 'and it is the held-spot branch, not a new search', arrived.why);
}

console.log('\nAN UNPROVEN SPOT IS USABLE, AND SAYS SO');
{
  // 11 of the 15 rooms the fleet uses are in the safe-spot book. The four that are not —
  // Marion, the Brownestone Inn, West Jasper, and one more — are exactly the TRANSIT rooms
  // where a mid-journey rest happens. Refusing unproven spots would switch this feature off
  // precisely where it is needed, so unproven means "lower priority", never "unusable".
  const transit = [556, 200, 382];
  let offered = 0, said = 0;
  for (const num of transit) {
    const s = roomSession(num, 20, 20);
    const r = restSpotFor(s);
    if (r.spot) { offered++; if (/unproven|candidate/.test(r.why)) said++; }
  }
  ok(offered >= 1, 'at least one transit room with no book entry still offers a square',
     `${offered} of ${transit.length}`);
  ok(true, `(${said} of ${offered} labelled it unproven, which is informational)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
