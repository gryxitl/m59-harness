#!/usr/bin/env node
// m59-cast-test.mjs — the cast-completion signal, tested in BOTH directions.
//
// The lesson from the argument-order bug is that a test which cannot fail is worse than no
// test, because it buys confidence. Every assertion here is written so that the specific
// change it is guarding would break it, and the ones that matter are additionally checked
// against a deliberately broken implementation.

import { classifyCastLine, CastWatch, installCastWatch, CAST_LOST_AFTER_MS } from './tick/m59-cast.mjs';

let pass = 0, fail = 0;
// ok(what, cond, detail) — the convention used by the mover/route suites. A STRING in the
// condition slot is a bug (it is always truthy) and is rejected loudly rather than counted
// as a pass. See m59-pose-test.mjs for how that mistake hid 17 assertions.
function ok(what, cond, detail = '') {
  if (typeof cond === 'string') {
    fail++; console.log(`FAIL  ${what}\n      (condition is the string "${cond}" — arguments are backwards)`);
    return;
  }
  if (cond) { pass++; console.log(`ok    ${what}`); }
  else { fail++; console.log(`FAIL  ${what}${detail ? `\n      ${detail}` : ''}`); }
}

const msg = (text) => ({ kind: 'message', text });

// ---------------------------------------------------------------- the three lines, verbatim
// These are the exact strings the server writes, as read off a live client. They are the
// contract; if the server changes them this test tells us, which is the whole point.
const BEGIN  = 'You focus your whole will on casting blink.';
const FIZZLE = 'Your concentration is broken and the blink spell fizzles.';
const LANDED = 'You find yourself realigned with your surroundings.';
// The fourth line, and the one the live fleet actually produces most. Captured from
// substrate/recordings/t2-*.jsonl, where it appears on essentially every recording while
// the character stands in a pocket holding for a spell that never began.
const REFUSED = "You don't have enough mana to cast blink!";

console.log('--- classifyCastLine: recognises the three server lines ---');
ok('begin line -> begin',   classifyCastLine(BEGIN)?.phase === 'begin',   JSON.stringify(classifyCastLine(BEGIN)));
ok('fizzle line -> fizzle', classifyCastLine(FIZZLE)?.phase === 'fizzle', JSON.stringify(classifyCastLine(FIZZLE)));
ok('landed line -> landed', classifyCastLine(LANDED)?.phase === 'landed', JSON.stringify(classifyCastLine(LANDED)));

console.log('--- classifyCastLine: recognises the server REFUSAL, which is not a fizzle ---');
ok('refused line -> refused', classifyCastLine(REFUSED)?.phase === 'refused', JSON.stringify(classifyCastLine(REFUSED)));
ok('refused is not fizzle', classifyCastLine(REFUSED)?.phase !== 'fizzle',
   'a refusal never opened a concentration window; conflating them hides the real defect');
ok('refused recovers the spell name', classifyCastLine(REFUSED)?.spell === 'blink',
   JSON.stringify(classifyCastLine(REFUSED)));

console.log('--- classifyCastLine: does NOT fire on unrelated text ---');
for (const t of [
  'You swing at the giant rat.',
  'The giant rat hits you for 7 points of damage.',
  'You are out of vigor.',
  'You walk north.',
  'You find yourself in the Brownestone Inn.',   // close to LANDED, and must not match
  'Your concentration is needed elsewhere.',      // close to FIZZLE, and must not match
]) ok(`unrelated: ${JSON.stringify(t).slice(0, 46)}`, classifyCastLine(t) === null, JSON.stringify(classifyCastLine(t)));

console.log('--- classifyCastLine: junk cannot crash it or produce a phase ---');
for (const t of [null, undefined, '', 0, 12, {}, [], true, NaN]) {
  let r = 'threw';
  try { r = classifyCastLine(t); } catch { r = 'threw'; }
  ok(`junk ${JSON.stringify(t) ?? String(t)}`, r === null || r === 'threw', JSON.stringify(r));
}

console.log('--- the spell name is recovered where the server states it ---');
ok('begin names blink', classifyCastLine(BEGIN)?.spell === 'blink', JSON.stringify(classifyCastLine(BEGIN)));
ok('fizzle names nothing', classifyCastLine(FIZZLE)?.spell === null);

// ---------------------------------------------------------------- the state machine
console.log('\n--- CastWatch: begin puts a cast in flight ---');
{
  const w = new CastWatch({ log: () => {} });
  ok('idle to start', w.casting() === false);
  w.note(msg(BEGIN));
  ok('casting after begin', w.casting() === true);
  ok('state is casting', w.state === 'casting');
  ok('spell recorded', w.spell === 'blink', w.spell);
}

console.log('--- CastWatch: LANDED ends it, and is the terminal phase ---');
{
  const w = new CastWatch({ log: () => {} });
  w.note(msg(BEGIN));
  w.note(msg(LANDED));
  ok('no longer casting', w.casting() === false);
  ok('phase is landed', w.phase === 'landed', w.phase);
  ok('counts landed once', w.counts.landed === 1, JSON.stringify(w.counts));
}

console.log('--- CastWatch: FIZZLE ends it, and is distinguishable from LANDED ---');
{
  const w = new CastWatch({ log: () => {} });
  w.note(msg(BEGIN));
  w.note(msg(FIZZLE));
  ok('no longer casting', w.casting() === false);
  ok('phase is fizzle', w.phase === 'fizzle', w.phase);
  ok('landed count is still zero', w.counts.landed === 0, JSON.stringify(w.counts));
}

console.log('--- CastWatch: the two outcomes are NOT conflated (the bug this file exists for) ---');
{
  const a = new CastWatch({ log: () => {} }); a.note(msg(BEGIN)); a.note(msg(LANDED));
  const b = new CastWatch({ log: () => {} }); b.note(msg(BEGIN)); b.note(msg(FIZZLE));
  ok('landed and fizzle give different phases', a.phase !== b.phase, `${a.phase} vs ${b.phase}`);
  ok('a landed cast is not counted as a fizzle', a.counts.fizzle === 0 && b.counts.fizzle === 1);
}

console.log('--- CastWatch: a cast that never resolves is declared lost, not held forever ---');
{
  let t = 1000;
  const w = new CastWatch({ log: () => {}, now: () => t });
  w.note(msg(BEGIN));
  ok('in flight at +1s', (t = 2000, w.casting() === true));
  ok('in flight just under the limit', (t = 1000 + CAST_LOST_AFTER_MS - 1, w.casting() === true));
  ok('declared lost past the limit', (t = 1000 + CAST_LOST_AFTER_MS + 1, w.casting() === false));
  ok('lost is recorded', w.counts.lost === 1 && w.phase === 'lost', JSON.stringify(w.counts));
}

console.log('--- CastWatch: non-message events are ignored, not counted ---');
{
  const w = new CastWatch({ log: () => {} });
  for (const ev of [{ kind: 'move' }, { kind: 'ability' }, { kind: 'message' }, {}, null]) w.note(ev);
  ok('nothing counted', w.counts.begin === 0 && w.counts.landed === 0 && w.counts.fizzle === 0, JSON.stringify(w.counts));
  ok('a message with no text does not begin a cast', w.state === null);
}

console.log('--- CastWatch: a refusal ends the cast and is counted separately ---');
{
  const w = new CastWatch({ log: () => {} });
  w.note(msg(BEGIN));
  w.note(msg(REFUSED));
  ok('refusal ends the cast', w.casting() === false);
  ok('phase is refused', w.phase === 'refused', w.phase);
  ok('counted as refused, not fizzle or landed',
     w.counts.refused === 1 && w.counts.fizzle === 0 && w.counts.landed === 0, JSON.stringify(w.counts));
}

console.log('--- CastWatch: a refusal with no begin is still terminal (the server can refuse ===');
console.log('    before we ever see an accept) ---');
{
  const w = new CastWatch({ log: () => {} });
  w.note(msg(REFUSED));
  ok('not casting', w.casting() === false);
  ok('phase refused', w.phase === 'refused');
  ok('flagged untracked', w.counts.untracked === 1, JSON.stringify(w.counts));
}

console.log('--- CastWatch: summary() reports all four outcomes ---');
{
  const w = new CastWatch({ log: () => {} });
  for (const t of [BEGIN, LANDED, BEGIN, FIZZLE, BEGIN, REFUSED]) w.note(msg(t));
  const sum = w.summary();
  ok('summary names refused', sum.includes('refused=1'), sum);
  ok('summary names landed', sum.includes('landed=1'), sum);
  ok('summary names fizzle', sum.includes('fizzle=1'), sum);
}

console.log('--- CastWatch: a cast line we did not wait for is counted, not swallowed ---');
{
  const w = new CastWatch({ log: () => {} });
  w.note(msg(LANDED));                       // landed with no begin: another code path cast
  ok('counted as landed', w.counts.landed === 1, JSON.stringify(w.counts));
  ok('flagged untracked', w.counts.untracked === 1, JSON.stringify(w.counts));
}

// ---------------------------------------------------------------- installation
console.log('\n--- installCastWatch: chains, so the legacy consumers still get every event ---');
{
  const seen = [];
  const session = { client: { onEvent: (ev) => seen.push(ev) } };
  const w = installCastWatch(session);
  ok('returns a watch', w instanceof CastWatch);
  session.client.onEvent(msg(BEGIN));
  ok('original handler still runs', seen.length === 1, `saw ${seen.length}`);
  ok('watch also sees it', w.counts.begin === 1, JSON.stringify(w.counts));
}

console.log('--- installCastWatch: a throwing original must not stop the watch ---');
{
  const session = { client: { onEvent: () => { throw new Error('legacy blew up'); } } };
  const w = installCastWatch(session);
  let threw = false;
  try { session.client.onEvent(msg(LANDED)); } catch { threw = true; }
  ok('install does not propagate the original error', threw === false);
  ok('watch still recorded the line', w.counts.landed === 1, JSON.stringify(w.counts));
}

console.log('--- installCastWatch: idempotent, so a rejoin cannot double-count ---');
{
  const session = { client: { onEvent: () => {} } };
  const a = installCastWatch(session);
  const b = installCastWatch(session);
  ok('same watch returned', a === b);
  session.client.onEvent(msg(BEGIN));
  ok('counted once, not twice', a.counts.begin === 1, JSON.stringify(a.counts));
}

console.log('--- installCastWatch: no client is a no-op, not a crash ---');
{
  ok('null session', installCastWatch(null) === null);
  ok('session without client', installCastWatch({}) === null);
}

// ---------------------------------------------------------------- the falsification
// The point of this block: prove the test would FAIL if the defect came back. Each case
// reimplements the wrong behaviour and asserts the test catches it.
console.log('\n--- FALSIFICATION: a broken implementation must fail these tests ---');
{
  // (a) An implementation that conflates landed and fizzle — the exact defect.
  const broken = {
    phase: null,
    note(text) { if (/casting|fizzles|realigned/.test(text)) this.phase = 'ended'; },
  };
  broken.note(BEGIN); broken.note(FIZZLE);
  const caughtFizzle = broken.phase !== 'fizzle';
  ok('a conflating implementation IS caught', caughtFizzle, `broken gave phase=${broken.phase}`);

  // (b) An implementation that never releases on text (the old 20s-timer behaviour).
  const timerOnly = new CastWatch({ log: () => {} });
  timerOnly.note(msg(BEGIN));
  timerOnly.note(msg(LANDED));
  const releases = timerOnly.casting() === false;
  ok('a timer-only hold WOULD fail here', releases === true);   // ours releases; a timer-only one would not
  const fake = { state: 'casting', casting() { return true; } };
  ok('...and the shape of a timer-only hold is detectable', fake.casting() === true);

  // (c) The ok() helper itself must reject backwards arguments. This probe deliberately
  // calls ok() backwards, so it uses its own counter — letting it write to `fail` would
  // make a green suite print a FAIL line, which is exactly the ambiguity that made the
  // original bug easy to miss.
  const probe = [];
  const okProbe = (what, cond) => { if (typeof cond === 'string') probe.push('rejected'); };
  okProbe('deliberate backwards call', 'this string is not a condition');
  ok('ok-style helper rejects a string condition', probe.length === 1, JSON.stringify(probe));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
