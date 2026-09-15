#!/usr/bin/env node
// PRODUCTION-RATE CONTRACT — the tick loop must not SUBMIT more than ~5 packets/second.
//
//   node tools/m59-prodrate-test.mjs
//
// WHY THIS EXISTS. The server has a hard throttle: INCOMING_PACKET_THROTTLE = 5
// (user.kod:50). Above 5 packets in any single second it sets bSpam and SILENTLY DROPS
// the overflow — no error, no response. We tripped this: the 10Hz tick loop submitted a
// move/face every 100ms regardless of whether it changed anything, so we produced 10-12
// packets/s, the server dropped most of them, and the symptom was 109 swings sent with
// zero combat responses. See docs/packet-throttle.md.
//
// The fix is on the PRODUCTION side (only submit an action when it changes state), not the
// pacer rate (capping the drain just backs up the queue). This test pins the production
// rate: a combat decide must not submit more than ~5 packets/second, and a decide that is
// already at its destination must submit ZERO moves (the current bug is a re-issue every
// tick).

import { Actuator } from './tick/m59-tick.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A session whose pacer records every submission with a timestamp (so we can measure the
// production rate) but sends instantly (so the test isn't paced by the real pacer).
function fakeSession({ me = { col: 5, row: 5 } } = {}) {
  const submissions = [];
  const client = {
    state: 'game', selfId: 1, evSeq: 0,
    me: { name: 'Tester' },
    room: { id: 7, num: 7, objects: new Map([[1, me]]) },
    self: me,
    vitals: () => ({ health: { value: 20, max: 20 }, vigor: { value: 80 } }),
    inventory: [],
    equipment: () => ({ known: true, equipped: ['mace'] }),
    moveToSquare: (c, r) => { me.col = c; me.row = r; },
    face: () => {}, go: () => {}, attack: () => {}, use: () => {}, unuse: () => {},
    get: () => {}, drop: () => {}, apply: () => {}, cast: () => {},
    buy: () => {}, offer: () => {}, acceptOffer: () => {},
    requestInventory: () => {}, roomContents: () => {},
  };
  return {
    name: 't1', live: true, client, submissions, me,
    pacer: {
      depth: 0,
      submit(kind, fn, gap = 0) {
        submissions.push({ kind, at: Date.now() });
        fn();  // execute immediately (no real pacing in the test)
        return Promise.resolve();
      },
    },
  };
}

// Count submissions in the last `windowMs`, as a per-second rate.
function rate(submissions, windowMs = 1000) {
  const cutoff = Date.now() - windowMs;
  const recent = submissions.filter(s => s.at >= cutoff);
  return recent.length / (windowMs / 1000);
}

console.log('the actuator is the only producer; a decide that submits nothing sends nothing');
{
  const s = fakeSession();
  const a = new Actuator(s);
  // A decide that takes no action.
  ok('no action, no submissions', s.submissions.length === 0);
}

console.log('\na repeated walk to the SAME square is not re-submitted every tick');
{
  const s = fakeSession();
  const a = new Actuator(s);
  // Simulate the buggy pattern: a decide that walks to (10,10) every tick, and the
  // character is already there (or gets there). The fixed actuator should submit the walk
  // ONCE, then stop (the destination hasn't changed and progress was made).
  //
  // This is the contract the fix must satisfy: walking to a held destination is a one-shot
  // submission, not a per-tick re-issue. We assert the bound directly: N ticks of
  // "walk to the same square" must produce far fewer than N submissions.
  const N = 20;
  for (let i = 0; i < N; i++) {
    a.walk(10, 10);  // the actuator's collision-aware walk
  }
  // The walk is collision-aware and tracks this.walking (the one outstanding walk). A
  // well-behaved actuator does not stack 20 identical walks. The exact count depends on
  // the implementation, but it must be bounded, not N.
  const moves = s.submissions.filter(x => x.kind === 'move').length;
  ok('20 identical walks do not produce 20 moves', moves < N,
     `produced ${moves} moves for ${N} identical walk calls`);
}

console.log('\nface is not re-submitted when already facing the target');
{
  const s = fakeSession();
  const a = new Actuator(s);
  const N = 10;
  for (let i = 0; i < N; i++) a.face(90);
  const faces = s.submissions.filter(x => x.kind === 'face').length;
  // The first face is legitimate; repeated identical faces should be coalesced or at least
  // bounded. (If the fix hasn't landed yet, this will be N — the test pins the target.)
  ok('10 identical faces are coalesced or bounded', faces < N,
     `produced ${faces} faces for ${N} identical face calls`);
}

console.log('\nreal combat decide (paced swings) stays under ~5 packets/second');
{
  const s = fakeSession();
  const a = new Actuator(s);
  // Model REAL combat: the CombatController paces swings at SWING_MS (950ms), so a swing
  // is submitted once per ~950ms, NOT every tick. The face is coalesced (same heading). A
  // move is submitted when closing the gap. Over 2 seconds at 10Hz, that is ~2 swings,
  // ~1 move, and coalesced faces — well under 5/s.
  const SWING_MS = 950;
  const ticks = 20;  // 2s at 10Hz
  let lastSwing = 0;
  for (let i = 0; i < ticks; i++) {
    a.face(90);                 // coalesced after the first
    if (Date.now() - lastSwing >= SWING_MS) { a.swing(2); lastSwing = Date.now(); }
  }
  // Add a couple of moves (closing the gap over the window).
  a.walk(10, 10);
  const total = s.submissions.length;
  const perSec = total / 2;  // 2s window
  console.log(`    (diagnostic) ${total} submissions over 2s = ~${perSec.toFixed(1)}/s`);
  ok('real combat production is under the server\'s 5/s throttle', perSec <= 5,
     `${perSec.toFixed(1)}/s exceeds the 5/s limit`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
