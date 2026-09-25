#!/usr/bin/env node
// DESTINATION-TO-SEND RATIO, PER CHARACTER, FROM THE LOG.
//
// This tool exists because a completion claim quoted "21 destination changes / 129,709 sends"
// and an independent auditor could not reproduce it from any artifact. They were right not to:
// the number came from an ad-hoc one-liner whose send regex matched a line format that had
// already changed, run against a log containing 399 MB of superseded code. A number that only
// one throwaway script on one machine can produce is not a measurement.
//
// Both sides are now counted from lines the mover itself emits:
//   [to-accepted] ... by=<owner> -> (col,row)   an ACCEPTED destination change (the only place
//                                               this is ever logged, so it cannot undercount)
//   [move-sent] / stride-declaration lines      an actual move packet on the wire
//
// A character with ZERO accepted destinations is reported as such and is NOT assigned a ratio.
// Dividing sends by nothing, or treating "0 destinations" as a sane ratio, is exactly the error
// the auditor caught: t4 and t5 are in game and sending packets but were never given anywhere to
// go, so their ratio measures the decider's silence, not the mover's behaviour.
import fs from 'node:fs';
import readline from 'node:readline';

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['t1', 't2', 't3', 't4', 't5'];

async function count(name) {
  const f = `substrate/keeper-${name}.log`;
  if (!fs.existsSync(f)) return { name, missing: true };
  const rl = readline.createInterface({ input: fs.createReadStream(f) });
  let dest = 0, sends = 0, firstDest = null, lastDest = null;
  for await (const l of rl) {
    if (l.includes('[to-accepted]')) {
      dest++;
      const t = l.slice(0, 24);
      if (!firstDest) firstDest = t;
      lastDest = t;
    }
    // A move packet actually put on the wire. Matched on the mover's own send log, which is
    // emitted once per accepted send and does not depend on a debug flag being on.
    if (/\[move-sent\]|moveTo sent|\[move\].*sent/.test(l)) sends++;
  }
  rl.close();
  return { name, dest, sends, firstDest, lastDest };
}

const rows = [];
for (const n of names) rows.push(await count(n));
console.log('character  destinations   sends    dest/send    note');
for (const r of rows) {
  if (r.missing) { console.log(`${r.name.padEnd(11)} (no log)`); continue; }
  const ratio = r.dest ? (r.dest / r.sends).toFixed(5) : '   n/a';
  const note = r.dest ? '' : 'NEVER GIVEN A DESTINATION — ratio is meaningless, not "sane"';
  console.log(`${r.name.padEnd(11)} ${String(r.dest).padStart(10)} ${String(r.sends).padStart(8)} ${ratio.padStart(11)}  ${note}`);
}
console.log('\npathology baseline (substrate/keeper-t1.log, original): 13,619 destinations / 244,021 sends = 0.0558');
console.log('A LOW ratio is only good if destinations are non-zero: 0 destinations with 68,059 sends');
console.log('is a character walking in circles with nowhere to go, not a fixed destination churn.');
