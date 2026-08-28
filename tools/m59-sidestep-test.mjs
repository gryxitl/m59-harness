#!/usr/bin/env node
// GOING ROUND A BODY: CLOCKWISE, THEN THE OTHER WAY, THEN BACK UP.
//
//   node tools/m59-sidestep-test.mjs
//
// Offline. The method is lifted out of the broker BY TEXT and evaluated here, because
// importing the broker takes the fleet lock — the same trick m59-collision-test.mjs uses,
// and for the same reason.
//
// ======================== WHAT THIS IS BUILT FROM ========================
//
// A single traced character, Tos -> Castle Victoria, 2026-08-21. It crossed two rooms
// perfectly well and then, in the Western border of the Twisted Wood, sent NOTHING for
// forty seconds while the local validator refused about seventy-five moves per ten-second
// window. Health went 33 -> 4 and it died. Over the whole run: 670 move attempts, 235 sent,
// 435 refused — and of those refusals, 399 were `object_blocked` against 35 `geometry_blocked`.
//
// So the thing that kills a traveller here is not the geometry everything has been aimed
// at. It is OUR OWN obstacle check: twelve to eighteen monsters surround the character,
// every candidate square has a body on it, and the walker refuses all of them and stands
// there. `UserMove` bypasses `ReqSomethingMoved` — room.kod's own comment is "already been
// checked by client (HAHA!)" — so the server would have taken those moves. We refused them,
// on monster positions the code itself notes can be a second stale.
//
// THE LADDER, and it is the operator's:
//
//   1. clockwise      a close detour round the body, in a fixed direction
//   2. anticlockwise  when the clockwise square is wall, occupied, or leads nowhere
//   3. back up        along breadcrumbs, so an ATTACKING monster steps forward into the
//                     square we vacate — the one move that makes the obstacle move
//
// It should fail the day the order stops being clockwise-first, or the day a monster starts
// getting the object-id tie-break that exists only for two characters dodging each other.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const SRC = readFileSync(join(HERE, 'm59-game.mjs'), 'utf8')
  + '\n' + readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');

// Lifted by brace matching from its signature, so the test runs the REAL body — a
// reimplementation here would pass forever while the broker did something else.
function liftMethod(name, signature) {
  const at = SRC.indexOf(signature);
  if (at < 0) throw new Error(`could not find ${name} by its signature`);
  // THE BODY'S BRACE, NOT THE PARAMETER LIST'S. The signature ends in a destructured
  // option bag, so the first `{` after it opens the OPTIONS — counting from there closes on
  // the options and lifts a method with no body, which fails as a syntax error two lines
  // later and looks like the extraction pattern being wrong. Walk the parameter
  // parentheses to their close first, then take the brace after that.
  let i = SRC.indexOf('(', at), parens = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') parens++;
    else if (SRC[i] === ')') { parens--; if (parens === 0) break; }
  }
  const open = SRC.indexOf('{', i);
  if (open < 0) throw new Error(`could not find the body of ${name}`);
  let depth = 0;
  for (i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`could not bracket ${name}`);
  const body = SRC.slice(at, i + 1);
  return new Function(`return ({ ${body} }).${name}`)();
}
const sidestepAround = liftMethod('sidestepAround', '  sidestepAround(was, blocked, {');

// A room that is open everywhere unless a square is named as wall. `standable` is what the
// method asks about floor; `moverStepLands` is what authorises the step itself.
const room = ({ walls = [], noStep = [] } = {}) => {
  const wall = new Set(walls.map(([r, c]) => `${r},${c}`));
  const no = new Set(noStep.map(([fr, fc, tr, tc]) => `${fr},${fc}>${tr},${tc}`));
  return {
    standable: (r, c) => r >= 1 && c >= 1 && r <= 40 && c <= 40 && !wall.has(`${r},${c}`),
    moverStepLands: (fr, fc, tr, tc) => !wall.has(`${tr},${tc}`) && !no.has(`${fr},${fc}>${tr},${tc}`),
  };
};
const ask = (geo, was, blocked, over = {}) => sidestepAround(was, blocked,
  { blockedEdges: new Set(), occupied: new Set(), geo, prefer: 0, blockerIsPlayer: false, ...over });

console.log('');
console.log('a monster in the way is walked round CLOCKWISE first');
{
  // Heading east from 10,10; a body on 10,11. Row increases downward, so clockwise from
  // east is SOUTH — the detour must go through 11,10 and not 9,10.
  const r = room();
  const east = ask(r, { row: 10, col: 10 }, { row: 10, col: 11 });
  ok('east is dodged to the south, which is clockwise',
     east?.through?.row === 11 && east?.through?.col === 10, JSON.stringify(east?.through));

  // And the rotation holds all the way round the compass, which is the part a lookup table
  // gets wrong for one heading and nobody notices.
  const south = ask(r, { row: 10, col: 10 }, { row: 11, col: 10 });
  ok('south is dodged to the west', south?.through?.col === 9 && south?.through?.row === 10,
     JSON.stringify(south?.through));
  const west = ask(r, { row: 10, col: 10 }, { row: 10, col: 9 });
  ok('west is dodged to the north', west?.through?.row === 9 && west?.through?.col === 10,
     JSON.stringify(west?.through));
  const north = ask(r, { row: 10, col: 10 }, { row: 9, col: 10 });
  ok('and north is dodged to the east', north?.through?.col === 11 && north?.through?.row === 10,
     JSON.stringify(north?.through));
}

console.log('');
console.log('and the other way when the clockwise side will not do');
{
  // Same eastward step, but the clockwise square (11,10) is wall. The only remaining
  // detour is anticlockwise, through 9,10.
  const r = room({ walls: [[11, 10], [11, 11]] });
  const out = ask(r, { row: 10, col: 10 }, { row: 10, col: 11 });
  ok('a wall on the clockwise side sends it anticlockwise',
     out?.through?.row === 9 && out?.through?.col === 10, JSON.stringify(out?.through));

  // Occupied counts the same as wall: somewhere with a body on it is not a way past.
  const busy = sidestepAround({ row: 10, col: 10 }, { row: 10, col: 11 },
    { blockedEdges: new Set(), occupied: new Set(['11,10']), geo: room(), prefer: 0 });
  ok('and so does another body standing on it',
     busy?.through?.row === 9 && busy?.through?.col === 10, JSON.stringify(busy?.through));
}

console.log('');
console.log('when neither side works it gives up, so the caller can back up');
{
  // Both perpendiculars walled AND the square behind walled, so even the built-in
  // one-square retreat has nowhere to go. Null is the contract: it is what makes the
  // breadcrumb tier in walkTo run.
  const boxed = room({ walls: [[11, 10], [9, 10], [10, 9], [11, 9], [9, 9]] });
  ok('a fully boxed-in step returns null rather than inventing a move',
     ask(boxed, { row: 10, col: 10 }, { row: 10, col: 11 }) === null);
  ok('and a step to nowhere is null too', ask(room(), { row: 10, col: 10 }, { row: 10, col: 10 }) === null);
  ok('as is a call with no geometry', ask(null, { row: 10, col: 10 }, { row: 10, col: 11 }) === null);
}

console.log('');
console.log('the object-id tie-break is for PLAYERS, and only for players');
{
  const r = room();
  const here = { row: 10, col: 10 }, blocked = { row: 10, col: 11 };
  // THE DEADLOCK THIS EXISTS FOR. Two characters meeting head-on both run this function,
  // so a fixed order makes them mirror each other for ever — "I'll go left, no you go
  // left". An odd object id flips the order so the two prefer opposite sides.
  const odd = ask(r, here, blocked, { blockerIsPlayer: true, prefer: 1 });
  const even = ask(r, here, blocked, { blockerIsPlayer: true, prefer: 2 });
  ok('two characters with different id parity dodge opposite ways',
     odd?.through?.row !== even?.through?.row,
     JSON.stringify([odd?.through, even?.through]));
  // A MONSTER IS NOT ALSO DODGING, so the swap buys nothing there and costs the fixed
  // order — half the fleet would take the long way round the same body for no reason.
  const monsterOdd = ask(r, here, blocked, { blockerIsPlayer: false, prefer: 1 });
  ok('but a monster gets the clockwise side whatever our id is',
     monsterOdd?.through?.row === 11 && monsterOdd?.through?.col === 10,
     JSON.stringify(monsterOdd?.through));
}

console.log('');
console.log('and the third tier is wired into the walk');
{
  const walk = SRC.slice(SRC.indexOf('async walkTo(col, row, {'));
  ok('the walker asks whether the blocker is a player', /blockerIsPlayer/.test(walk));
  ok('and retreats along breadcrumbs when the sides fail',
     /retreatAlongBreadcrumbs\(\{[\s\S]{0,300}?until:/.test(walk));
  // ONLY UNDER FIRE. A body merely in the way drifts off and the polite wait is cheaper;
  // a body that is eating us will not move on its own. Retreating otherwise walks a
  // character backwards out of every crowded corridor it tries to cross.
  ok('only while something is actually hurting us', /if \(underFire && !retreatedFromBodies/.test(walk));
  ok('and only once per walk, so it cannot reverse the whole journey',
     /retreatedFromBodies = true/.test(walk));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
