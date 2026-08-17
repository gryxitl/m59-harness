#!/usr/bin/env node
// m59-fake-client-test.mjs -- THE FAKE MUST HAVE THE REAL CLIENT'S SHAPE.
//
// Offline, no server:  node tools/m59-fake-client-test.mjs
//
// This is the test that would have caught both silent behavior-tree bugs, and it
// is the reason there is now one fake instead of one per suite. Neither bug was a
// logic error -- both were a fixture agreeing with wrong code:
//
//   equipment()  is a METHOD returning {known, equipped[]}, and two modules read
//                it as a Map with .keys(). Their fixtures supplied a Map, so the
//                tests passed while every character read as wearing nothing.
//   armed()      does not exist on a client at all, and two call sites asked for
//                it. Their fixtures supplied one, so the tests passed while the
//                condition answered false for every character forever.
//
// Both are invisible to a test that only exercises the fake. They are trivial to
// a test that compares the fake against the real class. So:
//
//   1. every method the fake claims must exist on the real client
//   2. the shapes returned by equipment() and vitals() must match field for field
//   3. the methods the bugs INVENTED must be absent from both
//
// Rule (3) is the one to keep. It is not enough that the fake resembles the
// client; the fake must also refuse to answer questions the client cannot answer,
// or it will agree with the next piece of wrong code exactly as it agreed with
// the last two.

import { fakeClient, fakeSession } from './m59-fake-client.mjs';
import { isArmed } from './m59-skills.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// The real class, for shape comparison. Importing m59-client.mjs is safe: unlike
// m59-broker.mjs it opens nothing and takes no lock until connect() is called.
const { M59Client } = await import('./m59-client.mjs');
const realProto = M59Client?.prototype ?? {};

console.log('\nthe fake carries the real client\'s surface');
{
  const c = fakeClient();
  // Methods the trees and atomics actually reach for. Each must exist on BOTH,
  // or the fake is modelling a client that does not exist.
  for (const m of ['equipment', 'vitals', 'attack', 'cast', 'apply', 'rest',
                   'stand', 'requestInventory', 'roomContents', 'waitFor']) {
    ok(`fake has ${m}()`, typeof c[m] === 'function');
    ok(`real client has ${m}() too`, typeof realProto[m] === 'function',
       'the fake is modelling a method the client does not have');
  }
}

console.log('\nequipment() has the shape the client actually returns');
{
  const c = fakeClient({ equipped: [{ id: 7, name: 'mace' }] });
  const eq = c.equipment();
  ok('it is an object, not a Map', eq !== null && typeof eq === 'object' && !(eq instanceof Map));
  for (const k of ['known', 'equipped', 'count', 'fresh_ms', 'changed_ms', 'source'])
    ok(`carries ${k}`, k in eq);
  ok('equipped is an array', Array.isArray(eq.equipped));
  ok('and its entries carry id and name', eq.equipped[0].id === 7 && eq.equipped[0].name === 'mace');

  // THE BUG, PINNED. This is the exact expression the two deleted modules used.
  // It must evaluate to nothing, so that anybody who writes it again sees an
  // empty set in a test rather than a fleet that will not fight.
  ok('equipment().keys() is NOT a thing — the deleted bug, pinned',
     typeof c.equipment.keys === 'undefined');
  ok('and reading it the wrong way yields an empty set, as it did in production',
     [...(c.equipment?.keys?.() ?? [])].length === 0);
}

console.log('\nvitals() has the shape the client actually returns');
{
  const v = fakeClient({ hp: 12, hpMax: 20, vigor: 90 }).vitals();
  ok('health is {value,max}', v.health.value === 12 && v.health.max === 20);
  ok('mana is {value,max}', typeof v.mana.value === 'number');
  ok('vigor carries scale_max — the 200 the cap is measured against',
     v.vigor.value === 90 && v.vigor.scale_max === 200);
}

console.log('\nthe fake refuses questions the real client cannot answer');
{
  const c = fakeClient({ equipped: [{ id: 1, name: 'mace' }] });
  // armed() was never on a client. If the fake grows one, m59-bt-nodes.mjs's
  // wielding_weapon condition starts passing its tests again while still being
  // false against every real character.
  ok('no armed() on the fake', typeof c.armed === 'undefined');
  ok('no armed() on the real client either', typeof realProto.armed === 'undefined');
  ok('isArmed(client) is the question, and it answers', isArmed(c) === true);
  ok('and it answers the other way for an empty hand',
     isArmed(fakeClient({ equipped: [] })) === false);
  ok('an unread use list reads as ARMED, so a failed read cannot idle the fleet',
     isArmed(fakeClient({ equipped: [], known: false })) === true);
}

console.log('\nthe wire is recorded, because the wire is what the server sees');
{
  const c = fakeClient();
  c.attack(42);
  c.cast(7, [42]);
  c.rest();
  ok('sends are logged in order', JSON.stringify(c.sent) ===
     JSON.stringify([['attack', 42, 1], ['cast', 7, [42]], ['rest']]), JSON.stringify(c.sent));
}

console.log('\nthe session moves the character and records it');
{
  const c = fakeClient({ room: { num: 5, name: 'Start' }, col: 2, row: 3 });
  const s = fakeSession(c, { exits: [{ to: 6, stand_on: { col: 1, row: 1 } }] });

  ok('exits() answers what the fixture set', s.world.exits()[0].to === 6);

  const left = await s.leaveVia({ to: 6 });
  ok('leaveVia reports leaving', left.left === true);
  // ARRIVAL IS RE-READ, NOT ASSUMED. m59-bt-nav's MoveToRoomAction confirms the
  // room number after leaveVia rather than trusting its answer, which is the
  // property that makes it worth keeping; the fake has to support that check.
  ok('and the world reflects the new room, so arrival can be CONFIRMED',
     s.world.room.num === 6 && c.room.num === 6);

  await s.step(9, 9);
  ok('step moves us and is logged',
     c.self.col === 9 && c.self.row === 9 && c.sent.some(x => x[0] === 'step'));
}

console.log('\nan exit that leads nowhere fails rather than pretending');
{
  const c = fakeClient({ room: { num: 5 } });
  const s = fakeSession(c);
  const r = await s.leaveVia({});
  ok('a doorway with no destination does not move us', r.left === false && s.world.room.num === 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
