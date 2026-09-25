#!/usr/bin/env node
// m59-tick-run.mjs -- RUN ONE CHARACTER ON THE REAL-TIME DRIVER.
//
//   node tools/m59-tick-run.mjs --agent t3 --seconds 120 --i-mean-it
//   node tools/m59-tick-run.mjs --agent t3 --to 1016 --i-mean-it     # and go somewhere
//
// The counterpart to m59-goap-run.mjs, for the other driver. It logs in, runs a
// TickLoop at a fixed rate, and prints what it decided and what actually changed.
//
// NOT A KEEPER, and not the fleet's driver. m59-autopilot.mjs is untouched and this does
// not restart, replace or interfere with it.
//
// IT OPENS ITS OWN CONNECTION, so Meridian's one-connection-per-character rule applies:
// IF THE BROKER IS HOLDING THIS CHARACTER, RUNNING THIS BUMPS IT OFF. That is the point
// for a controlled reading -- nothing else is steering while it runs -- and it is why
// the broker's rejoin sweep will take the character back afterwards.
//
// THE SURVIVAL FLOOR RUNS. m59-watchdog.mjs is started over this driver, because a
// character on an experimental loop is exactly the one that should not be the first to
// go without a guard. It decides nothing; it cancels movement if health crosses the
// withdraw line while a tick is somehow blocked.
import { readFileSync, existsSync } from 'node:fs';
import { Session } from './m59-session.mjs';
import { TickLoop } from './tick/m59-tick.mjs';
import { makeDecider, DEFAULT_GOALS, intend, INTENTS } from './tick/m59-decide.mjs';
import { Router, routeIntent } from './tick/m59-route.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import * as watchdog from './m59-watchdog.mjs';
import { safetyFor } from './m59-skills.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : d;
};
const flag = (n) => argv.includes('--' + n);

const FLEET   = fleetName(argv) || null;
const AGENT   = arg('agent', 't1');
const SECONDS = Number(arg('seconds', 60));
const HZ      = Number(arg('hz', 10));
const DEST    = arg('to', null);
const FORCE   = flag('i-mean-it');
const LOOPBACK = /^(127\.0\.0\.1|::1|localhost)$/i;

function loadRoster() {
  const p = stateFileFor(FLEET);
  if (!existsSync(p)) throw new Error(`no roster at ${p}`);
  return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
}

async function main() {
  const { path, data } = loadRoster();
  const entry = data[AGENT] ?? data.agents?.[AGENT];
  if (!entry) throw new Error(`no agent "${AGENT}" in ${path} (have: ${Object.keys(data).join(', ')})`);
  const cred = entry.credentials ?? entry;

  if (!LOOPBACK.test(String(cred.host)) && !FORCE)
    throw new Error(`refusing to drive ${AGENT} on ${cred.host}: that is not this machine.\n` +
                    '  Pass --i-mean-it if you have genuinely decided otherwise.');

  console.log(`fleet ${FLEET ?? '(unnamed)'}  roster ${path}`);
  console.log(`agent ${AGENT}  character ${cred.character}  host ${cred.host}:${cred.port}  ` +
              `${HZ}hz for ${SECONDS}s${DEST ? `  ->  room ${DEST}` : ''}`);

  const session = new Session(AGENT);
  await session.join({ account: cred.account, password: cred.password,
                       character: cred.character, host: cred.host, port: Number(cred.port) });
  // `live` is a GETTER on Session, derived from client.state === 'game'. Assigning it
  // throws, and would have been wrong anyway: liveness is the connection's fact.
  console.log(`in game as ${session.client?.me?.name ?? '?'}\n`);

  const router = new Router({ session });
  if (DEST) router.to(Number(DEST));

  // Attach the mover and router to the session so the decider
  // can fire confirmPosition and pick hunt rooms.
  session._mover = router.mover;
  session._router = router;

  // The route is a COMMITMENT that outlives one decision, so the router is held here
  // and handed to the intent table rather than rebuilt every tick.
  INTENTS.travel = routeIntent(router);

  // `travel` is not a world-state symbol, so it is planned by hand rather than by A*:
  // the decider plans over the vocabulary, and a destination is a directional decision
  // the caller made. Handled ahead of the planner, and reported the same way.
  // ONE LINE PER TICK, printed only when it changes. Two reporters sharing one "last"
  // string made them alternate and both print every tick, which is a log that looks like
  // activity and is one decision repeated.
  let last = '';
  const say = (line) => {
    if (line === last) return;
    last = line;
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`);
  };

  const plannerDecide = makeDecider({ session, goals: DEFAULT_GOALS,
    onDecision: d => say(`${d.goal ?? 'idle'}${d.action ? ` -> ${d.action}` : ''}` +
                         `${d.what ? ` (${d.what})` : ''}${d.why ? ` — ${d.why}` : ''}`) });

  const decide = (frame, act, loop) => {
    if (router.dest != null) {
      const r = intend('travel', frame, act, { client: session.client, session, ws: {} });
      say(`travel -> ${r.what ?? r.why}`);
      if (r.sent) return;            // travelling takes the tick
      // A route that cannot be walked must not silently become "idle": say so, and let
      // the planner have the tick rather than spinning on a dead destination.
    }
    plannerDecide(frame, act, loop);
  };

  const loop = new TickLoop({ session, decide, hz: HZ,
                              onError: e => console.error(`  ! decide threw: ${e.message}`) });

  // The survival floor, over this driver. `doing` is what the position pulse reads.
  const host = {
    s: session, watch: null, inert: false, hold: null, doing: null,
    passes: 0, passStartedAt: null, lastFrameAt: 0, tally: {},
    safety: () => safetyFor(session.client, {}),
    recordFrame() { this.lastFrameAt = Date.now(); },
    note: (what, d) => console.log(`  ! ${what}${d?.why ? ` — ${d.why}` : ''}`),
    progress: () => {},
  };
  watchdog.start(host);
  const doingTimer = setInterval(() => {
    host.doing = router.dest != null ? 'travelling' : null;
    host.passes = loop.stats.ticks;
  }, 250);
  doingTimer.unref?.();

  const t0 = Date.now();
  loop.start();
  await new Promise(r => setTimeout(r, SECONDS * 1000));
  loop.stop();
  watchdog.stop(host);
  clearInterval(doingTimer);

  const secs = (Date.now() - t0) / 1000;
  const s = loop.stats;
  console.log(`\n--- ${secs.toFixed(0)}s ---`);
  console.log(`ticks ${s.ticks}  (${(s.ticks / secs).toFixed(1)}/s of ${HZ} asked)  ` +
              `skipped ${s.skipped}  errors ${s.errors}  awaited ${s.awaited}`);
  console.log(`longest decide ${s.longest_decide_ms}ms      commands sent ${loop.actuator.sent.length}`);
  console.log(`watchdog: ${host.watch?.ticks ?? 0} ticks, ${host.watch?.interrupts ?? 0} interrupts`);
  console.log(`route: ${JSON.stringify(router.status())}`);
  if (s.lastError) console.log(`last error: ${s.lastError}`);
  process.exit(0);
}

main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
