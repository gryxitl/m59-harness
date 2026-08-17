#!/usr/bin/env node
// m59-passorder-test.mjs — THE ORDER THE KEEPER DECIDES IN, AND THE RULE THAT STOPS IT
// DECIDING TWICE IN ONE TICK.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// IF WE WANT TO CHANGE THE ORDERING, THIS TEST WILL NEED TO UPDATE ALONG WITH THAT.
// It is not here to say the current order is the right one. It is here to stop the order
// changing by ACCIDENT — because when it does, nothing errors, nothing stalls, and every
// row on the fleet board still reads healthy while a hurt character goes hunting.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// What it is guarding against, specifically. `pass()` used to be one enormous function in
// which `return;` meant "this tick is over". Splitting it into named stages changed that
// contract silently: a bare `return;` yields `undefined`, and the first cut of the caller
// read `undefined` as "carry on to the next stage". The stages that fell through included
//
//   * passUnderworld, having just walked somewhere safe to recover after a death
//   * passFleeAndRest, having just had a rest interrupted by damage
//   * passErrand, having just completed a bank run
//
// all of which continued into passFarm and went hunting in the same tick. Three of the
// four protected faculties, defeated by a falsy return value.
//
// So the verdict is a Symbol now, and this file pins both halves: the ORDER (the array)
// and the SHORT-CIRCUIT (that HANDLED ends the tick and CONTINUE does not). It drives the
// REAL `Autopilot.prototype.runPassLadder` — the method `pass()` actually calls — with the
// stage methods swapped for recorders. Not a copy of the ladder: a test that reimplements
// the thing it is testing would have passed against the broken version.
//
// Offline. Opens no socket, joins nobody, and needs no broker.

import { Autopilot, PASS_STAGES, HANDLED, CONTINUE } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

// ------------------------------------------------------------------ the order itself

console.log('\nthe order the keeper decides in');
{
  // Urgency descending. Each line is a claim about what outranks what, and the comment is
  // the reason — change the array and you are changing one of these claims.
  ok('there are seven stages', PASS_STAGES.length === 7);
  ok('being dead is decided first — the Underworld has no graph exits, so a character ' +
     'left there stays there',
     PASS_STAGES[0] === 'passUnderworld');
  ok('then being unarmed, because nothing below this may walk out to hunt without a weapon',
     PASS_STAGES[1] === 'passArm');
  ok('then the playbook, because a player attacking us is the one case the keeper is ' +
     'structurally blind to and the fleet director may have an opinion about',
     PASS_STAGES[2] === 'passPlaybook');
  ok('then danger and being hurt — the survival ladder',
     PASS_STAGES[3] === 'passFleeAndRest');
  ok('then whoever else is driving, which owns everything directional from there down',
     PASS_STAGES[4] === 'passOutside');
  ok('then an errand, which outranks farming and is outranked by everything above it',
     PASS_STAGES[5] === 'passErrand');
  ok('and the actual job is last', PASS_STAGES[6] === 'passFarm');

  ok('every stage names a real method on the keeper',
     PASS_STAGES.every(n => typeof Autopilot.prototype[n] === 'function'));
  ok('and no stage is listed twice', new Set(PASS_STAGES).size === PASS_STAGES.length);
}

// ------------------------------------------------------------------ the short circuit

// A keeper stripped to exactly what `pass()` touches before the ladder. Everything the
// preamble does — posting position, reading vitals, the self-missing check — is stubbed to
// something inert, so what this exercises is the ladder and nothing else.
function harness({ verdicts = {} } = {}) {
  const calls = [];
  const notes = [];
  const ap = Object.create(Autopilot.prototype);

  for (const stage of PASS_STAGES) {
    ap[stage] = async () => {
      calls.push(stage);
      return stage in verdicts ? verdicts[stage] : CONTINUE;
    };
  }
  ap.note = (what, detail) => notes.push({ what, detail });
  return { ap, calls, notes };
}

// THE REAL LADDER, NOT A COPY OF IT. `runPassLadder` is the actual method `pass()` calls;
// it was split out of `pass()` for exactly this reason, so that asserting the order does
// not require standing up a live session — and so that this file cannot drift into
// testing its own reimplementation, which would have passed against the broken version.
const runLadder = (ap) =>
  Autopilot.prototype.runPassLadder.call(ap, { s: null, c: null, room: null, v: null, hp: null });

console.log('\nCONTINUE falls through, HANDLED stops the tick');
{
  const { ap, calls, notes } = harness({});
  await runLadder(ap);
  ok('with every stage returning CONTINUE, all seven run in order',
     JSON.stringify(calls) === JSON.stringify(PASS_STAGES));
  ok('and nothing is reported as missing a verdict', notes.length === 0);
}
{
  const { ap, calls, notes } = harness({ verdicts: { passFleeAndRest: HANDLED } });
  const stopped = await runLadder(ap);
  ok('a stage that returns HANDLED ends the tick', stopped === 'passFleeAndRest');
  ok('nothing after it runs',
     JSON.stringify(calls) ===
     JSON.stringify(['passUnderworld', 'passArm', 'passPlaybook', 'passFleeAndRest']));
  ok('and it is not reported as a fault', notes.length === 0);
}

// ------------------------------------------------------------------ the actual bug

console.log('\nthe fall-through this exists to prevent');
{
  // THE REGRESSION, WRITTEN AS A TEST. A stage that does `return;` yields undefined.
  // Before the sentinel, undefined was falsy and the ladder carried on — so a character
  // that had just dealt with a death, a broken rest or a completed bank run went on to
  // farm in the same tick. Now it ends the tick AND says so.
  const { ap, calls, notes } = harness({ verdicts: { passUnderworld: undefined } });
  const stopped = await runLadder(ap);
  ok('a bare `return;` (undefined) ends the tick rather than falling through',
     stopped === 'passUnderworld');
  ok('so recovering after a death cannot continue into farming in the same tick',
     !calls.includes('passFarm'));
  ok('and the stage that did it is named, because being silent is what let this survive',
     notes.length === 1 && notes[0].detail.stage === 'passUnderworld');
}
{
  // The other half of the same rule: `true` and `false` are no longer verdicts. They were
  // the first refactor's contract, so anything left over from it must be loud rather than
  // half-working — `false` in particular used to mean "carry on", and now does not.
  const { ap, calls, notes } = harness({ verdicts: { passErrand: false } });
  const stopped = await runLadder(ap);
  ok('a leftover `return false;` no longer silently means "carry on"',
     stopped === 'passErrand' && !calls.includes('passFarm'));
  ok('and it is reported', notes.length === 1 && notes[0].detail.got === 'false');
}
{
  const { ap, calls, notes } = harness({ verdicts: { passArm: true } });
  await runLadder(ap);
  ok('a leftover `return true;` stops the tick and is reported too',
     !calls.includes('passFarm') && notes.length === 1 && notes[0].detail.got === 'true');
}

// ------------------------------------------------------------------ the sentinels

console.log('\nthe sentinels themselves');
{
  ok('HANDLED and CONTINUE are Symbols, so nothing can arrive as one by accident',
     typeof HANDLED === 'symbol' && typeof CONTINUE === 'symbol');
  ok('and they are not each other', HANDLED !== CONTINUE);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
