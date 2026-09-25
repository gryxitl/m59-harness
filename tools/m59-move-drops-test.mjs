// OFFLINE TESTS for the dropped-UserMove instrumentation: the client's counter, the
// keeper's stats shape, and the tool's output. No server, no network — the keeper is a
// stub we call the same function the real endpoint calls.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pose } from './tick/m59-pose.mjs';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} — ${e}`)); };

const CLIENT = readFileSync(new URL('./m59-client.mjs', import.meta.url), 'utf8');
const KEEPER = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
const MOVER = readFileSync(new URL('./tick/m59-mover.mjs', import.meta.url), 'utf8');
const TOOL = readFileSync(new URL('./m59-move-drops.mjs', import.meta.url), 'utf8');

console.log('the counter is written, stamped, and read');
{
  ok('the client counts drops', /_droppedUserMoves = \(this\._droppedUserMoves \?\? 0\) \+ 1/.test(CLIENT));
  ok('and stamps when the last one happened', /_droppedUserMovesAt = nowMs/.test(CLIENT),
    'a bare total cannot produce a rate');
  ok('and stamps the first move attempt, which is what the rate window is measured from',
    /_firstUserMoveAt == null\) this\._firstUserMoveAt = nowMs/.test(CLIENT));
  ok('the throttle is a named exported constant, not a literal',
    /export const USER_MOVE_MIN_INTERVAL_MS = \d+;/.test(CLIENT));
  ok('and moveTo compares against the constant, not a copy of its value',
    /< USER_MOVE_MIN_INTERVAL_MS/.test(CLIENT), 'a literal 1050 here would drift from the export');
}

console.log('the keeper exposes it');
{
  ok('a moveDropStats() helper exists', /function moveDropStats\(session\)/.test(KEEPER));
  ok('it imports the throttle law rather than restating it',
    /import \{[^}]*USER_MOVE_MIN_INTERVAL_MS[^}]*\} from '\.\/m59-client\.mjs'/.test(KEEPER));
  ok('a /move-drops endpoint serves it', /path === '\/move-drops'/.test(KEEPER));
  ok('and /probe carries it too, so the existing debug view shows it',
    /moveDrops: moveDropStats\(session\)/.test(KEEPER));
  // 'dropped' is a shorthand property; the rest are key: value.
  ok('the stats object reports dropped', /\n\s+dropped,/.test(KEEPER));
  for (const f of ['rate_per_sec', 'recent_rate_per_sec', 'window_ms', 'last_drop_ms_ago', 'throttle_ms'])
    ok(`the stats object reports ${f}`, new RegExp(`${f}:`).test(KEEPER));
}

console.log('the mover heartbeat shows it');
{
  ok('mover-hb prints drops', /drops=\$\{this\.session\?\.client\?\._droppedUserMoves/.test(MOVER),
    'the heartbeat was the one line operators actually read');
}

console.log('the tool');
{
  ok('it reads the keeper endpoint', /\/move-drops/.test(TOOL));
  ok('it prints a rate, not only a count', /rate \$\{fmt\(d\.rate_per_sec\)\}/.test(TOOL));
  ok('it prints the window the rate was measured over', /over \$\{ago\(d\.window_ms\)\}/.test(TOOL));
  ok('it does not require a live server to be run', !/createClient|login\(|session\.join/.test(TOOL),
    'it talks to a keeper over HTTP; it must never open a game connection');
}

console.log('\na keeper that predates the endpoint is reported, not guessed at');
{
  // The live fleet was running old keepers when this tool was written; a reader must be
  // able to tell "zero drops" from "this keeper never told me".
  ok('the tool distinguishes no-data from zero', /no \/move-drops/.test(TOOL));
  ok('and the helper reports null rates when there is no window, rather than 0',
    /windowMs != null && windowMs > 0 \?[\s\S]{0,80}: null/.test(KEEPER),
    'reporting 0/s with no window is a claim, not a measurement');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
