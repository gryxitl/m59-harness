// m59-keeper-process.mjs — One process per character. Runs the GOAP loop
// and a small HTTP API.
//
// Usage:
//   node tools/m59-keeper-process.mjs --agent t1 --port 8911 --fleet substrate/fleet-state.json
process.env.M59_KEEPER = '1';
//
// The process:
//   1. Reads its agent ID, port, and fleet file from argv
//   2. Loads credentials from the fleet file
//   3. Creates a Session (imported from the broker module)
//   4. Joins the game
//   5. Starts the GOAP autopilot
//   6. Serves a small HTTP API on its port
//   7. Saves state periodically
//   8. Handles SIGTERM gracefully

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { Session, Pacer } from './m59-session.mjs';
import { autopilotFor, dropAutopilot, autopilotIfAny } from './m59-autopilot.mjs';
import { TickLoop } from './m59-tick.mjs';
import { makeDecider, DEFAULT_GOALS, intend, INTENTS } from './m59-decide.mjs';
import { Router, routeIntent } from './m59-route.mjs';
import { protocolToClient, clientToProtocol, buildAllRoomGeometry } from './m59-roo.mjs';
import { loadMap, buildReverseEdges } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import * as watchdog from './m59-watchdog.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

// ---------------------------------------------------------------- args

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const agent = arg('--agent');
const port = Number(arg('--port') || 0);
const fleetName = arg('--fleet') || process.env.M59_FLEET || 'default';
const host = arg('--host') || process.env.M59_HOST || '127.0.0.1';
const serverPort = Number(arg('--server-port') || process.env.M59_PORT || 8899);

if (!agent || !port) {
  console.error('usage: m59-keeper-process.mjs --agent <id> --port <port> [--fleet <name>]');
  process.exit(1);
}

console.error(`[keeper] ${agent} starting on port ${port} (fleet: ${fleetName})`);

// ---------------------------------------------------------------- load credentials

// Resolve the fleet name to a file path, same as the broker does.
// The default fleet is substrate/fleet-state.json.
// Named fleets are substrate/fleet-<name>.json.
const fleetPath = fleetName === 'default' || fleetName === '-'
  ? 'substrate/fleet-state.json'
  : `substrate/fleet-${fleetName}.json`;

let fleet;
try {
  fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
} catch (e) {
  console.error(`[keeper] ${agent} cannot read fleet file ${fleetPath}: ${e.message}`);
  process.exit(1);
}

const entry = fleet[agent];
if (!entry?.credentials) {
  console.error(`[keeper] ${agent} not found in ${fleetPath} or has no credentials`);
  process.exit(1);
}

const { account, password, character } = entry.credentials;
const credHost = entry.credentials.host || host;
const credPort = entry.credentials.port || serverPort;
const policy = entry.autopilot?.policy || {};

// THE LOADOUT IS THE STANDING PLAN, AND THE TICK KEEPER WAS NOT READING IT.
//
// `applyLoadoutPolicyOverlay` lives on the survive keeper (m59-autopilot.mjs) and nothing
// else called it, so a character on `mode: tick` got its orders from the roster alone — and
// the roster is the wrong place to put them: edits there were silently reverted on every
// restart, three times in a row, while the loadout file sat unread.
//
// `substrate/loadouts/<character>.json` is the documented home for per-character orders
// (CLAUDE.md, "AND NEITHER DO ORDERS"), it is reapplied on every load by design, and
// POLICY_KEYS is the declared overridable surface. So the tick keeper reads it too.
//
// Applied at startup rather than per-tick: this process is restarted about once a minute by
// the supervisor, so the file is re-read often enough, and a stat() on the tick path is a
// cost with no reader.
try {
  const { loadoutFor, POLICY_KEYS } = await import('./m59-loadout.mjs');
  const lp = loadoutFor(character)?.policy;
  if (lp && Object.keys(lp).length) {
    const applied = {};
    for (const [key, spec] of Object.entries(POLICY_KEYS)) {
      if (lp[key] === null || lp[key] === undefined) continue;
      if (policy[spec.as] !== lp[key]) applied[spec.as] = lp[key];
      policy[spec.as] = lp[key];
    }
    if (Object.keys(applied).length)
      console.error(`[keeper] ${agent} took policy from ${character}'s loadout: ${JSON.stringify(applied)}`);
  }
  // AND THE SELL LIST, which is an order about what to do with the pack and had no reader
  // in the tick keeper at all. `has_loot` classifies by category and hard-excludes
  // reagents, so a loadout saying `sell: [elderberry, herb, mushroom, ...]` was contradicted
  // by the predicate that decides whether a sell trip is worth making: the character looted
  // reagents all day, `has_loot` answered false, `sell_loot` never fired, and nothing was
  // ever converted into money. Naming an item here is the operator saying it is loot.
  const sellList = loadoutFor(character)?.sell;
  if (Array.isArray(sellList) && sellList.length) {
    policy.sellList = sellList;
    console.error(`[keeper] ${agent} sell list from ${character}'s loadout: ${sellList.join(', ')}`);
  }
} catch (e) {
  console.error(`[keeper] ${agent} could not read the loadout (${e.message}); using the roster policy alone`);
}
const mode = entry.autopilot?.mode || 'goap';
// Log the mode source so a silent revert to 'survive' is visible. This is the value this
// process read from the fleet file at startup. If the broker later rewrites the file, the
// /mode endpoint's file_now field will differ from this.
console.error(`[keeper] ${agent} mode from file at startup: ${JSON.stringify(mode)} (entry.autopilot.mode=${JSON.stringify(entry.autopilot?.mode ?? 'MISSING')})`);

// ---------------------------------------------------------------- session

const session = new Session(agent);
session.pacer; // exists from constructor

let autopilot = null;
let inGame = false;
let startedAt = Date.now();

// ---------------------------------------------------------------- join

async function join() {
  try {
    await session.joinOnce({
      account, password, character,
      host: credHost, port: credPort,
    });
    inGame = true;
    console.error(`[keeper] ${agent} joined as ${session.client?.me?.name ?? character}`);

    // Start the autopilot: GOAP (default) or tick driver
    if (mode === 'tick') {
      // WARM THE MAP THIS KEEPER'S ROUTER WILL USE, before the Router loads it.
      // loadMap() is cached per process, so calling it here (and building on the SAME map
      // object) means the Router's own loadMap() gets the warmed instance. Without this,
      // the first findPath the router runs pays a ~13s reverse-edge/geometry build on the
      // FIRST tick, stalling the loop. See m59-broker.mjs / m59-game.mjs for the rationale.
      // A keeper lives one login session; a single ~12s warm at startup is acceptable (it is
      // not repeated per rejoin in a way that matters, and it is off the tick path).
      try {
        const _wt0 = Date.now();
        const _wmap = loadMap();
        attachStepMasks(_wmap);
        buildReverseEdges(_wmap);   // no-ops if already built (idempotent)
        buildAllRoomGeometry(_wmap);
        console.error(`[keeper] ${agent} map warmed at startup in ${Date.now() - _wt0}ms` +
                      ` (reverse=${_wmap.__reverse?.size ?? 0} rooms)`);
      } catch (e) {
        console.error(`[keeper] ${agent} map warm failed (${e.message}); will build lazily on first use`);
      }
      const router = new Router({ session });
      // COMBAT MOVES THROUGH session._mover; TRAVEL MOVES THROUGH router.mover.
      //
      // Both get the controller, and both get the SAME INSTANCE. Two ControllerMovers on one
      // session would each integrate their own believed position and quietly fight over the
      // body — the controller owns the position, so there has to be exactly one of it.
      //
      // Travel was left on the legacy mover at first, out of caution. That was the wrong
      // caution: travel is where it fails worst. JayB spent eighteen minutes in room 1012
      // oscillating (33,11) <-> (32,11), 257 walkTo calls all returning arrived:true, while
      // the exit to the Mausoleum sat at (44,8) in the same region with a 58-waypoint grid
      // path to it. The controller walks that path in 6.4s with zero blocked ticks.
      session._mover = router.mover;
      // WHICH MOVER IS DRIVING THIS CHARACTER IS ALWAYS ANSWERABLE FROM THE LOG.
      //
      // This was `env.M59_TICK_CONTROLLER === '1'`: off unless asked for, and SILENT when
      // off — the banner simply did not print, which reads exactly like a log you have not
      // scrolled far enough back in. An environment variable also cannot survive a restart,
      // and that is precisely how it was lost: two restarts to pick up an unrelated change
      // dropped JayB onto the legacy mover with nothing anywhere saying so. Twenty minutes
      // of oscillation were diagnosed against the wrong mover, and he died in the Deep
      // Forest of Farol before the missing banner was noticed.
      //
      // So: the controller is the default, opting OUT is explicit, and a line is printed
      // either way. A silent default is the one thing this must never be again — the same
      // failure as `purpose` missing from a schema, which switched every keeper's audit off
      // for a year without a word.
      session._moverKind = 'legacy';
      const controllerOff = process.env.M59_TICK_CONTROLLER === '0';
      if (controllerOff) {
        console.error(`[keeper] ${agent} movement on the LEGACY MOVER`
          + ` — M59_TICK_CONTROLLER=0 asked for it explicitly`);
      } else {
        try {
          const { ControllerMover } = await import('./m59-controller-mover.mjs');
          const cm = new ControllerMover(session, router.mover);
          router.mover = cm;
          session._mover = cm;
          session._moverKind = 'controller';
          console.error(`[keeper] ${agent} movement on the CHARACTER CONTROLLER — combat AND travel`
            + ` (planner=${process.env.M59_NAV_TRACE || 'on'})`);
        } catch (e) {
          // A FAILED IMPORT IS NOT A CONFIGURATION CHOICE, so it does not get to be quiet.
          console.error(`[keeper] ${agent} movement on the LEGACY MOVER — the controller FAILED to load`
            + ` (${e.message}). This is a fault, not a setting.`);
        }
      }
      session._router = router;
      INTENTS.travel = routeIntent(router);

      // THE DECIDER TAKES A POLICY AND NOBODY WAS GIVING IT ONE.
      //
      // makeDecider declares `policy = {}` as a default parameter, and this call omitted it —
      // so every policy read inside the tick decider saw an empty object, for the life of the
      // keeper. `policy?.threatBand` (the one field it reads directly) was always undefined,
      // and so was `policy?.assignedRoom`, which is why Lee kept routing to 557 for
      // centipedes with baby spiders ordered in 575 and an assignment sitting in his roster.
      //
      // This is the same shape as the loadout gap and the recordKill gap: the tick keeper is
      // its own implementation, and what the survive keeper wires up by hand simply is not
      // wired here until somebody notices.
      const plannerDecide = makeDecider({ session, policy, goals: DEFAULT_GOALS,
        onDecision: (d) => {
          // WHAT THIS CHARACTER IS DOING, WHERE THE DASHBOARD CAN SEE IT.
          //
          // The /health goap block reads autopilot._goapKeeper.state().goal and
          // autopilot._currentAction — survive-keeper machinery the tick driver never fills —
          // so KeeperProxy.activity() fell through to 'idle' and the fleet page showed "idle"
          // for a character that was travelling, buying and fighting. The same class of bug
          // was already fixed one field above for `running`, with a comment about the
          // dashboard saying nothing was driving JayB while the tick driver swung at mummies.
          session._tickDecision = { goal: d.goal ?? null, action: d.action ?? null,
                                    what: d.what ?? null, why: d.why ?? null, at: Date.now() };
          // WHERE THE TICKS GO. A character sending 0.33 packets a second cannot hunt
          // however good its decisions are, and the per-goal counters are the only way to
          // tell "held by a guard" from "never asked to move" from "asked and refused".
          // Cheap: two integers per goal, no allocation on the hot path after the first
          // tick of each kind.
          const ts = (session._tickStats ??= { since: Date.now(), n: 0, sent: 0, byGoal: {} });
          ts.n++;
          if (d.sent) ts.sent++;
          const g = d.goal ?? 'none';
          const b = (ts.byGoal[g] ??= { n: 0, sent: 0, actions: {} });
          b.n++;
          if (d.sent) b.sent++;
          if (d.action) {
            const a = (b.actions[d.action] ??= { n: 0, sent: 0 });
            a.n++;
            if (d.sent) a.sent++;
          }
          // Log decisions that change, not every tick.
          const line = `${d.goal ?? 'idle'}${d.action ? ' -> ' + d.action : ''}${d.what ? ' (' + d.what + ')' : ''}${d.why ? ' — ' + d.why : ''}`;
          if (line !== lastTickLog) {
            lastTickLog = line;
            console.error(`[tick] ${agent} ${line}`);
          }
        }
      });
      let lastTickLog = '';
      let decideTimes = [];  // rolling window of decide durations
      let lastMetricsLog = 0;
      session._tickDecide = plannerDecide;  // expose for state/3D target
      // A JOURNEY IS NOT AN ERRAND, AND THIS MADE EVERY JOURNEY ONE.
      //
      // This used to short-circuit: if the router had a destination it called the travel
      // intent and RETURNED, so `plannerDecide` never ran. Whenever a character was going
      // anywhere it had no survival ladder, no combat, no flee, no rest — it only walked.
      //
      // Measured 2026-08-27: Gountrug's loop ticked 1,976 times and the decider was entered
      // ELEVEN. `frozen`, `skipped`, `errors`, `not_in_game` were all zero, so every counter
      // the loop kept said it was healthy. The travel intent was answering `sent` on 99.4%
      // of ticks and swallowing them.
      //
      // It also explains where this fleet dies. Sasquatch took SEVEN of his thirteen deaths
      // on roads, gates and outskirts rather than in a hunting room — which is exactly what
      // a character with no decision loop while travelling looks like. `docs/m59-boundary.md`
      // makes the same argument about the survive keeper and names the character it killed:
      // a journey may only STEER, it must never hold the ladder off.
      //
      // The short-circuit was redundant as well as dangerous: the `hunt` goal already
      // steers an active `router.dest` through `routeIntent`, and `INTENTS.travel` is
      // registered for the planner. Removing it costs nothing and returns eleven goals to
      // a travelling character.
      const decide = (frame, act, loop) => {
        const t0 = Date.now();
        plannerDecide(frame, act, loop);
        decideTimes.push(Date.now() - t0);
        _maybeLogMetrics();
      };
      function _maybeLogMetrics() {
        const now = Date.now();
        if (now - lastMetricsLog < 30000) return; // every 30s
        if (decideTimes.length < 10) return;
        lastMetricsLog = now;
        const sorted = [...decideTimes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];
        const max = sorted[sorted.length - 1];
        const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
        console.error(`[tick-metrics] ${agent} n=${decideTimes.length} median=${median}ms p99=${p99}ms max=${max}ms avg=${avg}ms`);
        decideTimes = []; // reset window
      }

      const loop = new TickLoop({
        session, decide, hz: 10,
        // READ THE HAND EVERY 20s. `armed` is a whenUnknown:true fact and equipment() stays
        // known:false until a BP_USE_LIST arrives, which any inventory request brings
        // (user.kod:955). Nothing in the tick path asked, so an unread hand read as ARMED for
        // the life of the session, the `armed` goal never fired, and the character fought
        // bare-handed with a pack full of maces. The loop stays silent by default; this is the
        // keeper deciding to ask.
        inventoryEveryMs: 20000,
        onSessionDead: ({ staleMs }) => {
          // The session is a ghost: no server data for staleMs while we believed
          // we were in game. The client is replaying stale in-memory state — the
          // character is invisible to anyone actually on the server (this is what
          // happened to JayB in the Mausoleum: 0% CPU, "fighting" a frozen
          // position). The fix is a fresh login, not a local reset — the in-memory
          // world is wrong, so we must let the broker rejoin us. Stop the loop and
          // exit; the broker's reconcile (45s) restarts a clean keeper.
          console.error(`[keeper] ${agent} LIVENESS: session stale (${Math.round(staleMs/1000)}s no server data) — exiting for rejoin`);
          try { loop.stop(); } catch {}
          // Give the log a beat to flush, then exit non-zero so it is distinguishable
          // from a crash. process.exitCode is set, not process.exit, so any pending
          // writes get a chance to flush on the natural tick end.
          setTimeout(() => process.exit(42), 500);
        },
      });
      loop.start();
      // Expose the loop on the session so the /action cast override can freeze it
      // (hold the character still) while a spell is casting — movement breaks
      // concentration and fails the cast.
      session._tickLoop = loop;
      // The survival floor: watchdog over the tick driver.
      const { safetyFor } = await import('./m59-skills.mjs');
      const wdHost = {
        s: session, watch: null, inert: false, hold: null,
        doing: router.dest != null ? 'travelling' : null,
        passes: 0, passStartedAt: null, lastFrameAt: 0, tally: {},
        safety: () => safetyFor(session.client, {}),
        recordFrame() { this.lastFrameAt = Date.now(); },
        note: (what, d) => console.error(`[keeper] ${agent} ! ${what}${d?.why ? ' — ' + d.why : ''}`),
        progress: () => {},
      };
      watchdog.start(wdHost);
      autopilot = { start: () => {}, stop: () => { loop.stop(); watchdog.stop(wdHost); }, mode, policy,
                    _tickLoop: loop, _router: router, _wdHost: wdHost };
      console.error(`[keeper] ${agent} tick driver started (10hz, watchdog on)`);
    } else {
      autopilot = autopilotFor(session);
      autopilot.mode = mode;
      Object.assign(autopilot.policy, policy);
      autopilot.start();
      console.error(`[keeper] ${agent} autopilot started (mode=${mode}, hunt=${policy.hunt ?? 'none'})`);
    }
  } catch (e) {
    console.error(`[keeper] ${agent} join failed: ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------- state

function state() {
  const c = session.client;
  const me = c?.me;
  const room = session.world?.room;
  const v = c?.vitals?.() || {};
  return {
    agent,
    character: me?.name ?? character,
    in_game: inGame,
    room: room ? { name: c?.rsc?.get?.(room.nameRsc) ?? room.name, num: room.num } : null,
    hp: v.health ? { value: v.health.value, max: v.health.max } : null,
    vigor: v.vigor ? { value: v.vigor.value, max: v.vigor.max } : null,
    mana: v.mana ? { value: v.mana.value, max: v.mana.max } : null,
    gold: me?.gold ?? null,
    // WHICH MOVER IS DRIVING, WITHOUT READING THE LOG. "controller" or "legacy" — the
    // question that took a death to ask, because the only record of it was one startup
    // line that did not print in the case that mattered.
    mover: session._moverKind ?? 'unknown',
    // WHAT YOU ARE WEARING IS NOT A FLAG ON WHAT YOU CARRY. This filtered the pack on
    // flags & 0x04 and reported [] for a character who was demonstrably wielding a mace —
    // /probe, asking client.equipment(), said {known:true, equipped:["mace"]} at the same
    // moment. An hour was spent chasing a bare-handed character who was armed the whole
    // time. `client.equipment()` is the only answer: it is the server's own plUsing list,
    // and it says known:false rather than [] when no use-list has arrived, which is the
    // distinction that matters and the one a flag filter cannot make.
    equipment: (() => {
      try {
        const e = c?.equipment?.();
        if (!e) return [];
        return e.known === false ? { known: false, equipped: [] }
                                 : e.equipped.map(o => o.name).filter(Boolean);
      } catch { return []; }
    })(),
    pack: c?.inventory ? c.inventory
      .filter(o => !(o.flags & 0x04))
      .map(o => {
        const name = c.rsc?.get?.(o.nameRsc) ?? '';
        return o.amount > 1 ? `${name} (x${o.amount})` : name;
      })
      .filter(Boolean) : [],
    skills: (c?.skills ?? []).map(s => ({
      name: c.rsc?.get?.(s.nameRsc) ?? '',
    })).filter(s => s.name),
    spells: (c?.spells ?? []).map(s => ({
      name: c.rsc?.get?.(s.nameRsc) ?? '',
      school: s.school,
      mana: s.mana,
    })).filter(s => s.name),
    goap: autopilot ? {
      // In tick mode the decision comes from the tick decider, not the GOAP keeper.
      goal: (autopilot.mode === 'tick' ? session._tickDecision?.goal : null)
            ?? autopilot._goapKeeper?.state()?.goal ?? null,
      action: (autopilot.mode === 'tick' ? session._tickDecision?.action : null)
            ?? autopilot._currentAction ?? null,
      // The human-readable half — "close gap", "assigned room 575 — heading there" — so the
      // dashboard can say what the character is doing rather than only which goal won.
      doing: autopilot.mode === 'tick' ? (session._tickDecision?.what ?? null) : null,
      decided_ms_ago: session._tickDecision?.at ? Date.now() - session._tickDecision.at : null,
      // In tick mode the driver is session._tickDecide, NOT autopilot.running
      // (which stays false because the autopilot's own loop isn't the driver).
      // Report running=true when EITHER is active, or the broker's proxy sees
      // goap.running undefined and reports "no keeper" for a character that is
      // actually being driven — the dashboard then says nothing is driving JayB
      // while the tick driver is swinging at mummies.
      running: autopilot.running || !!(session._tickDecide),
      mode: autopilot.mode,
      useGOAP: autopilot.policy?.useGOAP ?? false,
      plan: autopilot._goapKeeper?.state() ?? null,
      // Tick driver target (for the 3D viewer).
      target: (autopilot.mode === 'tick' && session._tickDecide)
        ? (() => {
            const tid = session._tickDecide.state?.()?.targetId ?? null;
            if (tid == null) return null;
            const t = c?.room?.objects?.get?.(tid);
            if (!t) return null;
            return { id: tid, col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) ?? '', in_band: true };
          })()
        : null,
    } : null,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
  };
}

// ---------------------------------------------------------------- HTTP API

const logLines = [];
function log(line) {
  logLines.push(line);
  if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  console.error(line);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  const json = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    if (req.method === 'GET' && path === '/health') {
      // Use cached state to avoid blocking on the live session
      const s = cachedState || state();
      json({ ok: inGame, agent, ...s });
      return;
    }

    if (req.method === 'GET' && path === '/state') {
      // Use cached state to avoid blocking on the live session
      json(cachedState || state());
      return;
    }

    // WHERE DID THE TICKS GO, and how fast is the loop really running. See the note by
    // `_tickStats`. `?reset=1` zeroes the window so two readings can be compared.
    if (req.method === 'GET' && path === '/tickstats') {
      const ts = session._tickStats;
      if (!ts) { json({ error: 'no ticks recorded yet' }); return; }
      const elapsed = Math.max(1, Date.now() - ts.since) / 1000;
      // The loop's own numbers: asked-for period against the measured one.
      const L = session._tickLoop ?? autopilot?._tickLoop ?? null;
      const g = L?.stats?.gaps ?? null;
      const loop = L ? {
        hz_configured: L.intervalMs ? +(1000 / L.intervalMs).toFixed(2) : null,
        interval_ms_configured: L.intervalMs ?? null,
        interval_ms_measured: g && g.n ? +(g.sum / g.n).toFixed(1) : null,
        hz_measured: g && g.n ? +(1000 / (g.sum / g.n)).toFixed(2) : null,
        worst_gap_ms: g?.max ?? null,
        gaps_over_2x: g?.over2x ?? null,
        ticks: L.stats?.ticks ?? null, skipped: L.stats?.skipped ?? null,
        errors: L.stats?.errors ?? null, longest_decide_ms: L.stats?.longest_decide_ms ?? null,
        // THE FREEZE IS THE THING THAT MAKES A LOOP TICK AND DECIDE NOTHING. `skipped`
        // only counts re-entry while busy; a frozen tick increments neither that nor the
        // decision count, so a keeper can look perfectly healthy at 9.8Hz while its
        // decider is reached once every couple of hundred ticks.
        frozen_ticks: L.stats?.frozen_ticks ?? null,
        not_in_game: L.stats?.not_in_game ?? null,
        not_in_game_why: session._notInGame ?? null,
        stale_returns: L.stats?.stale_returns ?? null,
        frozen_why: L._frozenWhy ?? null,
        frozen_for_ms: L._frozenUntil ? Math.max(0, L._frozenUntil - Date.now()) : 0,
      } : null;
      const rows = Object.entries(ts.byGoal)
        .map(([goal, b]) => ({ goal, ticks: b.n, sent: b.sent,
                               pct: +(100 * b.n / ts.n).toFixed(1),
                               actions: b.actions }))
        .sort((a, b) => b.ticks - a.ticks);
      json({ window_s: +elapsed.toFixed(1), ticks: ts.n,
             ticks_per_sec: +(ts.n / elapsed).toFixed(2),
             sent: ts.sent, sent_per_sec: +(ts.sent / elapsed).toFixed(2),
             sent_pct: +(100 * ts.sent / Math.max(1, ts.n)).toFixed(1),
             loop, decide: session._decideStats ?? null, by_goal: rows });
      if (new URL(req.url, 'http://x').searchParams.get('reset') === '1')
        session._tickStats = { since: Date.now(), n: 0, sent: 0, byGoal: {} };
      return;
    }

    if (req.method === 'GET' && path === '/pacerstats') {
      // Ground-truth packet rates for the server's 5/s throttle (user.kod:50).
      // prodRate = what the tick loop SUBMITS per second; sentRate = what actually
      // leaves the socket per second (what the server counts toward bSpam).
      const p = session.pacer;
      json({
        in_game: inGame,
        prod_per_sec: p ? +(p.prodRate()).toFixed(2) : null,
        sent_per_sec: p ? +(p.sentRate()).toFixed(2) : null,
        prod_by_kind: p ? p.prodByKindRate() : {},
        queue_depth: p ? p.depth : null,
        // WHAT THE BACKLOG IS MADE OF, not just how deep it is. 313 deep at 1/s is five
        // minutes of stale packets, and which KIND they are decides whether that is merely
        // slow or actively harmful — a stale `move` is an absolute position, so sending it
        // late drags the body back to where it was.
        queued_by_kind: (() => {
          if (!p?.q) return null;
          const by = {};
          for (const j of p.q) by[j.kind] = (by[j.kind] ?? 0) + 1;
          return by;
        })(),
        oldest_queued_ms: p?.q?.length ? Date.now() - (p.q[0].queuedAt ?? Date.now()) : 0,
        coalesced: p?.coalesced ?? 0,
        shed: p?.shed ?? 0,
        min_gap_ms: p ? p.minGapMs : null,
        note: 'server drops packets when sent_per_sec > 5 (INCOMING_PACKET_THROTTLE). prod > sent means a backlog.',
      });
      return;
    }

    if (req.method === 'GET' && path === '/mode') {
      // WHERE IS THIS KEEPER'S MODE COMING FROM? The mode silently reverting to 'survive'
      // was undiagnosable because nothing said which value won. This reports, in priority
      // order, every source of the mode so the winning one is visible:
      //   1. `running`   - what the autopilot object actually has NOW (ground truth).
      //   2. `from_file` - what THIS process read from the fleet file at startup (line 74).
      //   3. `file_now`  - what the fleet file says RIGHT NOW (re-read live). If this differs
      //                    from `from_file`, the broker overwrote it after we started.
      //   4. `tick_running` - is the tick driver actually up (session._tickDecide) and driving?
      let fileNow = null, fileNowErr = null;
      try {
        const { readFileSync: rfs } = await import('node:fs');
        const fp = process.argv.includes('--fleet')
          ? null : 'substrate/fleet-state.json';
        // Resolve the same file the startup read. --fleet is passed to us; reuse the
        // fleetpath resolution so we read the identical file.
        const { resolveFleet } = await import('./m59-fleetpath.mjs');
        const rf = resolveFleet(process.argv.slice(2));
        const now = JSON.parse(rfs(rf.stateFile, 'utf8'));
        fileNow = now?.[agent]?.autopilot?.mode ?? null;
      } catch (e) { fileNowErr = e.message; }
      json({
        agent,
        running: autopilot?.mode ?? null,
        from_file: mode,
        file_now: fileNow,
        file_now_error: fileNowErr,
        tick_running: !!(session._tickDecide),
        in_game: inGame,
        note: 'running is ground truth. If file_now !== from_file, the broker rewrote the roster after this keeper started.',
      });
      return;
    }

    if (req.method === 'GET' && path === '/rxstats') {
      // Is the client actually RECEIVING server data? rxBytes/rxPackets are updated on
      // every socket chunk. If these aren't growing, the connection is dead/stale and
      // no command (attack, move, look) is reaching the server or getting a reply.
      const c = session.client;
      const lastRx = c?.lastRxAt ?? 0;
      json({
        in_game: inGame,
        rxBytes: c?.rxBytes ?? 0,
        rxPackets: c?.rxPackets ?? 0,
        lastRxAgo_ms: lastRx ? Date.now() - lastRx : null,
        totalSwingsSent: c?.attackLog?.length ?? 0,
      });
      return;
    }

    if (req.method === 'GET' && path === '/swingstats') {
      // Ground-truth swing rate: the timestamps of every REQ_ATTACK packet the
      // client actually sent (this.client.attackLog). This is the real rate,
      // independent of what the decider "decided" or what the log (which dedups
      // repeated lines) shows. Report the count, the rate over the last N, and
      // the gaps between consecutive swings so a stall or a too-slow cadence is
      // visible.
      const log = session.client?.attackLog ?? [];
      const now = Date.now();
      // Rate over the trailing 15s window.
      const recent = log.filter(e => now - e.at <= 15000);
      const n = recent.length;
      let gaps = null;
      if (n >= 2) {
        gaps = [];
        for (let i = 1; i < recent.length; i++) gaps.push(recent[i].at - recent[i-1].at);
        const avg = Math.round(gaps.reduce((a,b)=>a+b,0) / gaps.length);
        const min = Math.min(...gaps);
        const max = Math.max(...gaps);
        gaps = { avg, min, max };
      }
      json({
        in_game: inGame,
        total_swings: log.length,
        swings_last_15s: n,
        rate_per_sec: n ? +(n / 15).toFixed(3) : 0,
        one_every_ms: n >= 2 ? Math.round(15000 / n) : null,
        gaps_ms: gaps,
        last_swing_ago_ms: log.length ? now - log[log.length-1].at : null,
      });
      return;
    }

    if (req.method === 'GET' && path === '/combatstats') {
      // Ground-truth combat outcomes: the server's own prose for each swing
      // (hit / miss / out of range), classified and timestamped by the client
      // (this.client.combatLog). This tells us whether swings are actually
      // LANDING or silently whiffing — the question we kept assuming.
      const log = session.client?.combatLog ?? [];
      const now = Date.now();
      const count = (k, winMs) => log.filter(e => e.kind === k && (!winMs || now - e.at <= winMs)).length;
      const recent = log.filter(e => now - e.at <= 60000);
      const hits = recent.filter(e => e.kind === 'hit').length;
      const misses = recent.filter(e => e.kind === 'miss').length;
      const outOfRange = recent.filter(e => e.kind === 'out_of_range').length;
      const total = hits + misses + outOfRange;
      json({
        in_game: inGame,
        last_60s: { hits, misses, out_of_range: outOfRange, total,
                    hit_rate: total ? +(hits / total).toFixed(3) : null },
        all_time: { hits: count('hit'), misses: count('miss'), out_of_range: count('out_of_range') },
        recent: recent.slice(-12).map(e => ({ at: e.at, kind: e.kind, text: e.text })),
      });
      return;
    }

    if (req.method === 'GET' && path === '/room-view') {
      // Live room view for the 3D map. Reads directly from the session's client.
      const c = session.client;
      const me = c?.self;
      const room = c?.room;
      if (!room?.objects) return json({ error: 'no room data', in_game: inGame });
      const objects = [];
      for (const o of room.objects.values()) {
        objects.push({
          id: o.id, col: o.col, row: o.row,
          name: c?.rsc?.get?.(o.nameRsc) ?? '',
          is_self: o.id === c?.selfId,
          // OF.PLAYER is 0x0004 (m59-parse.mjs). The old 0x01 check was part of
          // NOMOVEON_MASK and mislabelled every NPC (mummies etc.) as a player,
          // which made the combat controller skip all of them.
          is_player: !!(o.flags & 0x0004),
          can_attack: !!(o.flags & 0x0008),
        });
      }
      json({
        cols: room.cols ?? 50,
        rows: room.rows ?? 48,
        self: me ? { col: me.col, row: me.row, degrees: me.degrees ?? null } : null,
        objects,
        room_name: c?.rsc?.get?.(c.roomNameRsc) ?? null,
        // The MAP room number (session.world.room.num), NOT the runtime room id
        // (c.room.id). The runtime id does not match the world map's numbering:
        // c.room.id is 2000 for "Raza Inn", but the map's room 2000 is a different
        // room (Ko'catan). The geometry lookup is by map number / name, so sending the
        // runtime id made the 3D view + geometry load the WRONG room's .roo — which is
        // why the character "spun in circles": the fine geometry model was for a
        // different room than the one the server had, so every validated step landed
        // somewhere unexpected and the walk re-planned in a loop. session.world.room.num
        // is the same source the /health endpoint uses (1011 for Raza Inn).
        room_num: session.world?.room?.num ?? c?.room?.id ?? null,
        // The decider's current target, for the 3D viewer.
        target: (() => {
          const tid = session._tickDecide?.state?.()?.targetId ?? null;
          if (tid == null) return null;
          const t = room.objects.get(tid);
          if (!t) return null;
          return { col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) ?? '' };
        })(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/grid') {
      // Debug: render the fine-walkable grid as ASCII around the character.
      // # = fine-blocked, . = fine-open, @ = self, T = target.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      const wroom = session?.world?.room ?? null;
      if (!me) return json({ error: 'no self' });
      // Diagnostics: which room did the World resolve, and does its size match the .roo?
      const gridHeader = `self=(${me.col},${me.row}) worldRoom=${wroom ? wroom.name+' num='+wroom.num : 'null'} rooDims=${wroom?.roo ? wroom.roo.cols+'x'+wroom.roo.rows : '?'} clientRoomId=${c?.room?.id ?? '?'} `;
      const R = 8; // radius in squares
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      const lines = [];
      lines.push(gridHeader);
      lines.push(`self=(${me.col},${me.row}) target=${t ? `(${t.col},${t.row})` : 'none'} fineHeightAt self=${geo?.fineHeightAt ? geo.fineHeightAt(me.col * 64 + 32, me.row * 64 + 32) : '?'} `);
      for (let r = me.row - R; r <= me.row + R; r++) {
        let line = '';
        for (let col = me.col - R; col <= me.col + R; col++) {
          if (col === me.col && r === me.row) { line += '@'; continue; }
          if (t && col === t.col && r === t.row) { line += 'T'; continue; }
          const f = geo?.fineWalkable ? geo.fineWalkable(r, col) : undefined;
          line += (f === false) ? '#' : '.';
        }
        lines.push(line);
      }
      json({ grid: lines.join('\n') });
      return;
    }
    if (req.method === 'GET' && path === '/raycast') {
      // Debug: trace the direct line from self to the target. Reports whether it's
      // clear, and if blocked, WHERE (the first collision point in client coords) +
      // the reason. This tells us if a wall/ledge is between them.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      if (!t || t.col == null) return json({ error: 'no target', pos: { col: me.col, row: me.row } });
      const sx = me.col * 64 + 32, sy = me.row * 64 + 32;
      const tx = t.col * 64 + 32, ty = t.row * 64 + 32;
      const trace = geo?.traceFineMoveClient ? geo.traceFineMoveClient(
        protocolToClient(sx), protocolToClient(sy),
        protocolToClient(tx), protocolToClient(ty), { slide: false }) : null;
      json({
        self: { col: me.col, row: me.row },
        target: { col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) },
        trace: trace ? {
          available: trace.available, moved: trace.moved, blocked: trace.blocked,
          reason: trace.reason ?? null,
          // Convert the client stop point back to viewer col/row (1-indexed game squares).
          stopProtocolX: trace.x != null ? clientToProtocol(trace.x) : null,
          stopProtocolY: trace.y != null ? clientToProtocol(trace.y) : null,
          stopSquare: trace.x != null
            ? { col: Math.floor(clientToProtocol(trace.x) / 64), row: Math.floor(clientToProtocol(trace.y) / 64) }
            : null,
        } : 'no trace fn',
      });
      return;
    }
    if (req.method === 'GET' && path === '/edgecheck') {
      // Debug: trace the edge between two squares (?c1=&r1=&c2=&r2=) at several
      // radius/slide combos, so we can see what distinguishes a ledge wall
      // (must be rejected) from a corridor (must be allowed).
      const geo = session?.world?.geometry;
      if (!geo?.traceFineMoveClient) return json({ error: 'no geometry' });
      const u = new URL(req.url, 'http://x');
      const g = (k, d) => { const v = parseInt(u.searchParams.get(k), 10); return Number.isInteger(v) ? v : d; };
      const c1 = g('c1'), r1 = g('r1'), c2 = g('c2'), r2 = g('r2');
      const CF = 1024, HF = 512;
      const a = { x: (c1 - 1) * CF + HF, y: (r1 - 1) * CF + HF };
      const b = { x: (c2 - 1) * CF + HF, y: (r2 - 1) * CF + HF };
      const R = 248; // PLAYER_RADIUS
      const combos = [
        ['r1 nslide', { slide: false, playerRadius: 1 }],
        ['r1 slide',  { slide: true,  playerRadius: 1 }],
        ['R  nslide', { slide: false, playerRadius: R }],
        ['R  slide',  { slide: true,  playerRadius: R }],
      ];
      const out = combos.map(([name, opt]) => {
        const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y, opt);
        return { name, arrived: t.arrived, blocked: t.blocked, reason: t.reason ?? null };
      });
      return json({ from: [c1, r1], to: [c2, r2], results: out });
    }
    if (req.method === 'GET' && path === '/findpath') {
      // Debug: compute the fine A* from self to an arbitrary square (?c=&r=).
      // Used to diagnose "why is the mover oscillating" — shows exactly what
      // the A* finds (or doesn't) for a destination the router is targeting.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const u = new URL(req.url, 'http://x');
      const dc = parseInt(u.searchParams.get('c'), 10);
      const dr = parseInt(u.searchParams.get('r'), 10);
      if (!Number.isInteger(dc) || !Number.isInteger(dr)) return json({ error: 'need ?c=<col>&r=<row>' });
      const F = 64, H = 32;
      const t0 = Date.now();
      const p = geo?.finePathProtocol
        ? geo.finePathProtocol(me.col * F + H, me.row * F + H, dc * F + H, dr * F + H, { step: 8, margin: 12 * F, maxNodes: 20000 })
        : { found: false, reason: 'no finePathProtocol' };
      return json({
        self: { col: me.col, row: me.row },
        to: { col: dc, row: dr },
        targetFineWalkable: geo?.fineWalkable ? geo.fineWalkable(dr, dc) : undefined,
        found: p.found,
        reason: p.reason ?? null,
        waypoints: (p.waypoints ?? []).map(w => ({ col: Math.round((w.x - H) / F) + 1, row: Math.round((w.y - H) / F) + 1 })),
        wpCount: p.waypoints?.length ?? 0,
        expanded: p.expanded ?? null,
        ms: Date.now() - t0,
      });
    }
    if (req.method === 'GET' && path === '/path3d') {
      // Debug: compute the fine path from self to the current target, plus a
      // raycast of the DIRECT line, for the 3D viewer. Waypoints are in
      // 0-indexed viewer coords (col/row, same as objects/self).
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const F = 64, H = 32; // KOD_FINENESS, half — needed by both the travel and combat legs
      // THE TRAVEL LEG, ALONGSIDE THE COMBAT ONE.
      //
      // This endpoint only ever showed the path to the current QUARRY, so everything a
      // character does between fights — the part that has gone wrong most often — was
      // invisible in the viewer. The travel destination lives on the mover (ControllerMover
      // keeps `dest`) and the router's current leg keeps the staging square it is walking to.
      // Both are useful: the leg says where the next step is aimed, the room says why.
      let travel = null;
      try {
        const mover = session._mover;
        const leg = session._router?.leg ?? null;
        const aim = leg?.standOn ?? (mover?.dest ?? null);
        if (aim && Number.isFinite(aim.col) && Number.isFinite(aim.row)) {
          // DRAW THE PLAN THE MOVER IS ACTUALLY FOLLOWING.
          //
          // This asked finePathProtocol while the controller steers on navPath, so the overlay
          // showed a second opinion rather than the truth. They disagree exactly where it
          // matters: a staging square one or two from the map edge cannot hold a body of
          // radius 248, so finePathProtocol refuses it, while the grid planner routes there
          // happily. JayB in the Sweet Grass Prairies — navPath FOUND 152 waypoints to (20,2)
          // and the overlay drew nothing, which reads as "he has no way there" when he does.
          //
          // navPath works in CLIENT units; the viewer wants 0-indexed squares.
          let tpath = [];
          try {
            const { navPath } = await import('./m59-navgrid.mjs');
            const toClient = (col, row) => ({ x: (col - 0.5) * 1024, y: (row - 0.5) * 1024 });
            const np = navPath(geo, toClient(me.col, me.row), toClient(aim.col, aim.row));
            if (np?.found) tpath = (np.waypoints ?? []).map(w => ({
              x: w.x / 1024 - 0.5, z: w.y / 1024 - 0.5,
            }));
          } catch { /* diagnostic only */ }
          travel = {
            path: tpath,
            to: { x: aim.col - 1, z: aim.row - 1 },
            next_room: leg?.next ?? null,
            kind: leg?.kind ?? null,
            found: tpath.length > 0,
          };
        }
      } catch { /* the overlay is diagnostic; never let it break the poll */ }

      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      if (!t || t.col == null) return json({ path: [], direct: null, travel, self: { x: me.col - 1, z: me.row - 1 } });
      const sx = me.col * F + H, sy = me.row * F + H;
      const tx = t.col * F + H, ty = t.row * F + H;
      // The fine path (waypoints in protocol coords -> viewer col/row).
      let path = [];
      if (geo?.finePathProtocol) {
        try {
          const p = geo.finePathProtocol(sx, sy, tx, ty, { step: 8, margin: 12 * F, maxNodes: 4000 });
          if (p.found) {
            path = (p.waypoints ?? []).map(w => ({
              x: Math.round((w.x - H) / F) - 1, z: Math.round((w.y - H) / F) - 1,
            }));
          }
        } catch {}
      }
      // Raycast the DIRECT line (client coords for traceFineMoveClient).
      let direct = null;
      if (geo?.traceFineMoveClient) {
        try {
          const trace = geo.traceFineMoveClient(protocolToClient(sx), protocolToClient(sy), protocolToClient(tx), protocolToClient(ty), { slide: false });
          direct = {
            blocked: !!trace.blocked,
            moved: !!trace.moved,
            reason: trace.reason ?? null,
            // Where the direct line stops, in viewer col/row (0-indexed).
            stopX: trace.x != null ? Math.floor(clientToProtocol(trace.x) / 64) - 1 : null,
            stopZ: trace.y != null ? Math.floor(clientToProtocol(trace.y) / 64) - 1 : null,
          };
        } catch (e) { direct = { blocked: false, error: e.message }; }
      }
      json({ path, direct, travel, self: { x: me.col - 1, z: me.row - 1 }, target: { x: t.col - 1, z: t.row - 1 } });
      return;
    }
    if (req.method === 'GET' && path === '/wire') {
      // WHAT WE WOULD ACTUALLY PUT ON THE WIRE for a move. `replicate` sends
      // client.moveTo(px, py, speed, client.room?.id) directly — not through the pacer —
      // so a null room id there is a malformed packet the server can simply ignore, and
      // nothing anywhere would say so.
      try {
        const c = session.client;
        json({ room_id: c?.room?.id ?? null,
               room_num: session.world?.room?.num ?? null,
               self: c?.self ? { col: c.self.col, row: c.self.row, x: c.self.x, y: c.self.y } : null,
               believed: (() => { try { return session._mover?.ctl?.square?.() ?? null; } catch { return null; } })(),
               believed_xy: (() => { const k = session._mover?.ctl; return k && k.x != null ? { x: k.x, y: k.y } : null; })(),
               ctl_stats: session._mover?.ctl?.stats ?? null });
      } catch (e) { json({ error: e.message }); }
      return;
    }

    if (req.method === 'GET' && path === '/exits') {
      // WHAT THE LIVE ROOM OFFERS, as against what the baked map believes. The two can
      // disagree — the map carries inferred reverse edges that are not doors, and it can
      // also simply be missing one — and there was no way to ask from outside.
      try {
        const exits = session.world?.exits?.() ?? [];
        json({ room: session.world?.room?.num ?? null,
               count: exits.length,
               exits: exits.map(e => ({ to: e.to, to_name: e.to_name ?? null, kind: e.kind ?? null,
                                        direction: e.direction ?? null, stand_on: e.stand_on ?? null,
                                        reachable: e.reachable ?? null, steps_away: e.steps_away ?? null })) });
      } catch (e) { json({ error: e.message }); }
      return;
    }

    if (req.method === 'GET' && path === '/probe') {
      // Debug: report the character's position, neighbor walkability,
      // and the geometry state. Used to diagnose stuck-on-a-ledge.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const neighbors = {};
      const dirs = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
      for (const [dir, [dc, dr]] of Object.entries(dirs)) {
        const nc = me.col + dc, nr = me.row + dr;
        const f = geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
        const s = geo?.standable ? geo.standable(nr, nc) : undefined;
        neighbors[dir] = { col: nc, row: nr, fine: f, coarse: s };
      }
      // The target and the engage square
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      // Reachability from me to the target
      let reach = null;
      if (t && geo?.finePathProtocol) {
        const p = geo.finePathProtocol(
          me.col * 64 + 32, me.row * 64 + 32,
          t.col * 64 + 32, t.row * 64 + 32,
          { step: 8, margin: 12 * 64, maxNodes: 20000 });
        reach = { found: p.found, waypoints: p.waypoints?.length ?? 0, expanded: p.expanded ?? null, reason: p.reason ?? null };
      }
      json({
        pos: { col: me.col, row: me.row },
        myHeight: geo?.fineHeightAt ? geo.fineHeightAt(me.col * 64 + 32, me.row * 64 + 32) : null,
        neighbors,
        target: t ? { col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) } : null,
        reach,
        geoReady: !!geo?.collisionReady,
        // THE ROUTER'S OWN STATE. Without this, a route that stops advancing is invisible:
        // the mover reports ARRIVED every tick and the position never changes, and there is
        // no way from outside to tell whether the chain is stale, exhausted, or never moved.
        // JayB stood on (13,49) in the Sweet Grass Prairies for 760 arrivals with the leg
        // still aiming (20,2) and nothing to say which of the two was wrong.
        route: (() => {
          try {
            const r = session._router;
            if (!r) return null;
            return {
              dest: r.dest ?? null,
              state: r.lastState ?? null,
              leg: r.leg ? { next: r.leg.next, kind: r.leg.kind,
                             standOn: r.leg.standOn ?? null,
                             edgeTarget: r.leg.edgeTarget ?? null,
                             direction: r.leg.direction ?? null } : null,
              subWp: r.subWp ? r.subWp.length : 0,
              subHead: r.subWp?.[0] ?? null,
              subReplans: r._subWpReplans ?? null,
              mark: r.mark ?? null,
            };
          } catch { return 'err'; }
        })(),
        // Equipment + inventory + spells, for debugging the caster combat.
        equipment: (() => { try { const e = c.equipment?.(); return e ? { known: e.known, equipped: e.equipped.map(o => o.name) } : null; } catch { return 'err'; } })(),
        inventory: (() => { try { const inv = c.inventory ?? []; return inv.map(o => ({ n: c.rsc?.get?.(o.nameRsc) ?? o.name ?? '', id: o.id ?? null, count: o.count ?? o.amount ?? 1, flags: o.flags ?? null, rarity: o.rarity ?? null })); } catch { return 'err'; } })(),
        spells: (c.spells ?? []).map(s => ({ name: s.name, id: s.id })),
        // Any active effects / enchantments the client tracks.
        effects: (c.effects && typeof c.effects === 'function') ? c.effects() : (c.activeEffects ?? null),
        abilities: (c.abilities && typeof c.abilities === 'function') ? c.abilities() : (c.abilities ?? null),
      });
      return;
    }

    if (req.method === 'GET' && path === '/stepmask') {
      // Debug: for each of the 8 neighbors of self, report fineWalkable, standable,
      // AND moverStepLands (the actual step validator walkTo uses). This distinguishes
      // "the square is walkable" from "you can actually STEP to it from where you are."
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = me.row + dr, nc = me.col + dc;
          out.push({
            dir: [dr, dc],
            to: { col: nc, row: nr },
            fine: geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined,
            standable: geo?.standable ? geo.standable(nr, nc) : undefined,
            stepLands: geo?.moverStepLands ? geo.moverStepLands(me.row, me.col, nr, nc) : undefined,
          });
        }
      }
      json({ self: { col: me.col, row: me.row }, hasStepMask: !!geo?._stepMask, cols: geo?.cols, rows: geo?.rows, neighbors: out });
      return;
    }

    if (req.method === 'GET' && path === '/traceline') {
      // Debug: sample fineWalkable along the direct line from self to a target square,
      // showing which square along the path the fine grid says is NOT walkable. This is
      // the exact thing the per-microstep check in traceFineMoveClient blocks on.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me || !geo) return json({ error: 'no self or geometry' });
      const url2 = new URL(req.url, 'http://x');
      const tcol = Number(url2.searchParams.get('col') ?? me.col + 1);
      const trow = Number(url2.searchParams.get('row') ?? me.row);
      const x0 = me.col * 64 + 32, y0 = me.row * 64 + 32;  // protocol center
      const x1 = tcol * 64 + 32, y1 = trow * 64 + 32;
      const samples = [];
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(2, Math.ceil(dist / 8));  // sample every ~8 protocol units
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const sx = x0 + (x1 - x0) * t, sy = y0 + (y1 - y0) * t;
        const sc = Math.floor(sx / 64), sr = Math.floor(sy / 64);
        const fw = geo.fineWalkable ? geo.fineWalkable(sr, sc) : undefined;
        const st = geo.standable ? geo.standable(sr, sc) : undefined;
        samples.push({ t: +t.toFixed(2), sq: [sc, sr], fineWalkable: fw, standable: st });
      }
      // Collapse consecutive same-square samples
      const collapsed = [];
      for (const s of samples) {
        const last = collapsed[collapsed.length - 1];
        if (!last || last.sq[0] !== s.sq[0] || last.sq[1] !== s.sq[1]) collapsed.push(s);
      }
      json({ from: { col: me.col, row: me.row }, to: { col: tcol, row: trow }, path: collapsed });
      return;
    }

    if (req.method === 'GET' && path === '/movecheck') {
      // Debug: run validateFineTarget for the 4 cardinal neighbors and report the
      // exact refusal reason (room_security_unknown, geometry_blocked, etc.). This
      // distinguishes "the step mask says ok" from "validateFineTarget refuses the move."
      const c = session.client;
      const me = c?.self;
      if (!me) return json({ error: 'no self' });
      const geo = session?.world?.geometry;
      const out = {
        self: { col: me.col, row: me.row, x: me.x, y: me.y },
        roomSecurity: c?.room?.security,
        geoSecurity: geo?.security,
        collisionInvalidated: c?.room?.collisionInvalidated ?? null,
        inGame: c?.state,
      };
      const half = 32;
      out.neighbors = [];
      for (const [dir, dc, dr] of [['E',1,0],['W',-1,0],['N',0,-1],['S',0,1]]) {
        const nc = me.col + dc, nr = me.row + dr;
        const tx = nc * 64 + half, ty = nr * 64 + half;
        let v = null;
        try { v = session.validateFineTarget?.(tx, ty, { slide: true }); } catch (e) { v = { error: e.message }; }
        out.neighbors.push({ dir, to: { col: nc, row: nr },
          validation: v ? { available: v.available, moved: v.moved, blocked: v.blocked, reason: v.reason, note: v.note } : null });
      }
      json(out);
      return;
    }

    if (req.method === 'GET' && path === '/log') {
      const n = Number(url.searchParams.get('n') || 50);
      json({ lines: logLines.slice(-n) });
      return;
    }

    if (req.method === 'POST' && path === '/join') {
      await join();
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/leave') {
      if (autopilot) autopilot.stop('keeper leave');
      if (session.client) {
        try { session.client.close(); } catch {}
      }
      inGame = false;
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/rejoin') {
      if (autopilot) autopilot.stop('rejoin');
      if (session.client) {
        try { session.client.close(); } catch {}
      }
      inGame = false;
      await new Promise(r => setTimeout(r, 1000));
      await join();
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/pass') {
      if (autopilot?.running) {
        log(`[keeper] ${agent} forced pass`);
        // Force a pass by stopping and restarting
        autopilot.stop('forced pass');
        await new Promise(r => setTimeout(r, 500));
        autopilot.start();
      }
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/policy') {
      const body = JSON.parse(await readBody(req));
      if (autopilot) {
        Object.assign(autopilot.policy, body);
        log(`[keeper] ${agent} policy updated: ${JSON.stringify(body)}`);
      }
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/pause') {
      log(`[keeper] ${agent} pause requested`);
      if (autopilot) autopilot.stop('paused for testing');
      json({ ok: true, paused: true });
      return;
    }

    if (req.method === 'POST' && path === '/resume') {
      log(`[keeper] ${agent} resume requested`);
      if (autopilot && !autopilot.running) {
        autopilot.start();
        json({ ok: true, resumed: true });
      } else {
        json({ ok: true, already_running: true });
      }
      return;
    }

    if (req.method === 'POST' && path === '/stop') {
      log(`[keeper] ${agent} stop requested`);
      if (autopilot) autopilot.stop('keeper stop');
      if (session.client) {
        try { session.client.close(); } catch {}
      }
      saveState();
      process.exit(0);
      return;
    }

    if (req.method === 'POST' && path === '/cancel') {
      session.movementGeneration++;
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/action') {
      const body = JSON.parse(await readBody(req));
      const { name, args } = body;
      try {
        let result;
        switch (name) {
          case 'walk':
            result = await session.walkTo(args.col, args.row, args);
            break;
          case 'travel': {
            // EVERY NAME THE PROXY HAS USED, AND A LOUD REFUSAL WHEN THERE IS NONE.
            //
            // The broker's KeeperProxy sent `toRoomNum` and this read `to ?? room`, so
            // `dest` was undefined and session.travel(undefined) answered "no route from
            // 586 to undefined in the graph" -- a sentence that looks exactly like a
            // routing failure and is actually a wiring failure. Every travel through the
            // broker went nowhere from the day the keeper split landed, and the fleet
            // reported it as bad terrain.
            const dest = args.to ?? args.room ?? args.toRoomNum;
            if (dest == null) {
              result = { error: 'travel: no destination given (expected to/room/toRoomNum)',
                         args_seen: Object.keys(args ?? {}) };
              break;
            }
            const maxHops = args.maxHops ?? 5;
            result = await session.travel(dest, { maxHops });
            break;
          }
          case 'go': {
            const dest = args.to ?? args.room;
            const exits = session.world?.exits?.() ?? [];
            const candidates = dest != null ? exits.filter(e => e.to === Number(dest)) : exits;
            if (!candidates.length) {
              result = { error: `no exit to ${dest}`, exits: exits.map(e => ({ kind: e.kind, to: e.to, col: e.stand_on?.col, row: e.stand_on?.row })) };
            } else {
              result = await session.leaveViaAny(candidates);
            }
            break;
          }
          case 'attack': {
            const targetId = args.target ?? args.id;
            if (!targetId) {
              result = { error: 'no target id' };
            } else {
              const c = session.need();
              const tgt = c.room?.objects?.get?.(targetId);
              if (!tgt) {
                result = { error: `target ${targetId} not in room` };
              } else {
                const me = c.self;
                if (!me) {
                  result = { error: 'position unknown' };
                } else {
                  // Face the target
                  const deg = Math.atan2(tgt.row - me.row, tgt.col - me.col) * 180 / Math.PI;
                  await c.face(deg);
                  // Attack
                  c.attack(targetId);
                  await new Promise(r => setTimeout(r, 500));
                  // Check if it died
                  const after = c.room?.objects?.get?.(targetId);
                  result = { sent: true, killed: !after, target: tgt.nameRsc ? c.rsc?.get?.(tgt.nameRsc) : String(targetId) };
                }
              }
            }
            break;
          }
          case 'face': {
            const c = session.need();
            c.face(args.degrees ?? 0);
            result = { sent: true };
            break;
          }
          case 'cast': {
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const spellName = String(args.spell ?? '').toLowerCase();
            const spell = (c.spells ?? []).find(sp => {
              const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
              return n.toLowerCase() === spellName;
            });
            if (!spell) {
              result = { error: `spell not found: ${spellName}` };
            } else {
              // A cast needs CONCENTRATION: any move or turn packet we send while the
              // spell is charging interrupts it and the cast fails. The tick driver
              // sends move/turn at 10Hz, so it would break the cast instantly. Freeze
              // the loop (hold the character perfectly still) and wait for the cast
              // to actually resolve — blink takes SEVERAL seconds, not the ~1s a
              // simple attack does. We wait for the `moved` event (the server confirms
              // the character relocated) or a max timeout, rather than a fixed short
              // hold that would unfreeze too early and let the next move packet kill
              // the cast.
              const loop = session._tickLoop;
              if (loop) {
                const since = c.evSeq;  // events after this are from the cast
                const maxMs = Number(args.holdMs) || 15000;  // blink can take several s
                // THE CLEAR USED TO BE THE LINE AFTER THE AWAIT, AND THAT IS THE BUG. A
                // `waitFor` that rejects skipped it, and the character stayed frozen for the
                // life of the process — 165 keeper respawns against 6-9 for the agents with
                // no tick loop. `freeze` carries a deadline and `finally` returns it early.
                loop.freeze(maxMs + 1000, 'cast ' + spellName);
                try {
                  c.cast(spell.id, []);
                  const w = await c.waitFor({ since, kinds: ['moved'], timeoutMs: maxMs });
                  const moved = w.events.filter(e => e.kind === 'moved');
                  // TELL THE CONTROLLER, OR IT WILL UNDO THIS. Movement is
                  // client-authoritative: a controller still believing the old square keeps
                  // replicating it and the server -- which validates nothing -- drags the
                  // body straight back. Five blinks in room 535 each succeeded and each was
                  // reverted onto (47,13) within the tick, fifteen mana for no distance.
                  const last = moved[moved.length - 1];
                  if (last && Number.isFinite(last.col))
                    try { session._mover?.relocated?.(last.col, last.row); } catch { /* best effort */ }
                  result = { sent: true, spell: spellName, frozenMs: Date.now() - since,
                             relocated: moved.length > 0, timedOut: w.timedOut };
                } finally { loop.thaw(); }
              } else {
                c.cast(spell.id, []);
                result = { sent: true, spell: spellName };
              }
            }
            break;
          }
          case 'rest':
            result = { note: 'use goap instead' };
            break;
          case 'stand':
            // Use the pacer (the same path the tick driver's actuator uses), not
            // session.client.stand() directly — the pacer paces the packet and
            // handles the socket state. session.client can be undefined early in
            // the join, but the pacer is always present.
            await session.pacer.submit('stand', () => session.client?.stand?.()).catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true };
            break;
          case 'rawmove': {
            // DEBUG: client-authoritative move, no geometry check. The server does NOT
            // validate movement against geometry (it's all client-side), so this places
            // the character directly. Use when the mover's cached geometry is stale
            // (e.g. the Raza Blacksmith is 50x48 on the live server but 10x10 in the
            // local map, so the mover thinks the character is out of bounds and won't
            // path).
            // Use session.client directly (not need()) — need() throws when
            // client.state !== 'game', but the client can be fully functional (the
            // tick driver drives it fine) while the state field lags after a rejoin.
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const col = Number(args.col), row = Number(args.row);
            if (Number.isNaN(col) || Number.isNaN(row)) { result = { error: 'no col/row' }; break; }
            const { KOD_FINENESS } = await import('./m59-parse.mjs');
            const half = KOD_FINENESS / 2;
            await session.pacer.submit('move', () => c.moveTo(col * KOD_FINENESS + half, row * KOD_FINENESS + half, 18, c.room?.id ?? 0), 100).catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true, col, row };
            break;
          }
          case 'movetest': {
            // DEBUG: attempt a one-square move and return the SERVER'S REPLY.
            // Discriminates the stuck-state hypotheses: a blind/held character gets
            // "You are unable to go anywhere" (user_cant_go); a character wedged in
            // geometry gets a different reply (or the move just doesn't confirm).
            // Uses session.client directly (not need()).
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const me = c.self;
            const col = Number(args.col ?? (me ? me.col + 1 : 0));
            const row = Number(args.row ?? (me ? me.row : 0));
            const { KOD_FINENESS } = await import('./m59-parse.mjs');
            const half = KOD_FINENESS / 2;
            const since = c.evSeq ?? 0;
            await session.pacer.submit('move', () => c.moveTo(col * KOD_FINENESS + half, row * KOD_FINENESS + half, 18, c.room?.id ?? 0), 100).catch(e => { result = { error: e.message }; });
            let reply = null, confirmed = null;
            try {
              const ev = await c.waitFor({ since, kinds: ['message', 'moved'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events) {
                const m = ev.events.find(e => e.kind === 'message');
                if (m) reply = m.text ?? m.what;
                const mv = ev.events.find(e => e.kind === 'moved');
                if (mv) confirmed = { col: mv.col, row: mv.row };
              }
            } catch {}
            const after = c.self;
            result = { sent: true, from: { col: me?.col, row: me?.row }, to: { col, row },
                       reply, confirmed, now: { col: after?.col, row: after?.row } };
            break;
          }
          case 'shop': {
            // DEBUG: open a shop directly by object id, with the loop frozen so the
            // tick driver's move/turn packets don't interrupt the shop interaction.
            // This is the manual override for when the buy atomic's approach can't
            // position the character (stale geometry).
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const targetId = Number(args.id ?? args.object);
            if (!targetId) { result = { error: 'no object id' }; break; }
            const obj = c.room?.objects?.get(targetId);
            if (!obj) { result = { error: `object ${targetId} not in room` }; break; }
            const loop = session._tickLoop;
            const thaw = loop ? loop.freeze(6000, 'shop') : () => {};
            try {
            const sinceEv = c.evSeq ?? 0;
            await session.pacer.submit('buy', () => c.buy(targetId)).catch(e => { result = { error: e.message }; });
            let shopItems = null, msg = null;
            try {
              const ev = await c.waitFor({ since: sinceEv, kinds: ['shop', 'message'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events) {
                const s = ev.events.find(e => e.kind === 'shop');
                if (s) shopItems = (s.items ?? []).map(i => ({ name: c.rsc?.get?.(i.nameRsc) ?? i.name, id: i.id, cost: i.cost }));
                const m = ev.events.find(e => e.kind === 'message');
                if (m) msg = m.text ?? m.what;
              }
            } catch {}
            result = { sent: true, targetId, name: c.rsc?.get?.(obj.nameRsc) ?? '', shopItems, msg };
            } finally { thaw(); }
            break;
          }
          case 'buyitem': {
            // DEBUG: buy an item directly. sellerId + itemId. Opens the shop first (to
            // activate the seller), then sends the real purchase packet (buyItems).
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const sellerId = Number(args.seller ?? args.id);
            const itemId = Number(args.itemId ?? args.item);
            if (!sellerId || !itemId) { result = { error: 'need seller and itemId' }; break; }
            const loop = session._tickLoop;
            const thaw = loop ? loop.freeze(8000, 'buyitem') : () => {};
            const sinceEv = c.evSeq ?? 0;
            try {
              // Open the shop to activate the seller.
              await session.pacer.submit('buy', () => c.buy(sellerId), 300).catch(() => {});
              await new Promise(r => setTimeout(r, 600));
              const before = c.evSeq ?? 0;
              // The real purchase packet.
              await session.pacer.submit('buy', () => c.buyItems(sellerId, [itemId]), 300).catch(() => {});
              const ev = await c.waitFor({ since: before, kinds: ['message', 'inventory', 'shop'], timeoutMs: 2500 }).catch(() => null);
              const msgs = (ev?.events ?? []).filter(e => e.text).map(e => e.text);
              result = { sent: true, sellerId, itemId, msgs, allEvents: (ev?.events ?? []).map(e => e.kind) };
            } catch (e) { result = { error: e.message }; }
            finally { thaw(); }
            break;
          }
          case 'use':
          case 'equip': {
            const id = args.id ?? args.item;
            if (!id) { result = { error: 'no item id' }; break; }
            // Equip/use an item by id. Bypasses the decider so we can test whether
            // the server accepts the equip at all (diagnose the mace-not-equipping
            // case: is the item broken, is the character seated, is the id stale?).
            // Stand first (a seated character cannot equip), then use.
            await session.pacer.submit('stand', () => session.client?.stand?.()).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
            const before = session.client.equipment?.()?.equipped?.map(o => o.id) ?? [];
            const sinceEv = session.client.evSeq ?? 0;
            await session.pacer.submit('use', () => session.client?.use?.(id)).catch(e => { result = { error: e.message }; });
            // Wait for the server's response — a broken weapon says so in prose
            // (player.kod:127 "You can't use X--it's broken"). Capture any message.
            let serverSaid = null;
            try {
              const ev = await session.client.waitFor({ since: sinceEv, kinds: ['equipment', 'message'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events?.length) {
                serverSaid = ev.events.map(e => e.text ?? e.what ?? e.kind).join(' | ');
              }
            } catch {}
            const after = session.client.equipment?.()?.equipped?.map(o => o.id) ?? [];
            result = result ?? { sent: true, id, before, after, equipped: after.includes(id), serverSaid };
            break;
          }
          case 'look': {
            const id = args.id ?? args.item;
            if (!id) { result = { error: 'no item id' }; break; }
            // Read the item's description (condition is in the description, weapon.kod:87-92).
            const sinceEv = session.client.evSeq ?? 0;
            await session.pacer.submit('look', () => session.client?.look?.(id)).catch(e => { result = { error: e.message }; });
            let desc = null;
            try {
              const ev = await session.client.waitFor({ since: sinceEv, kinds: ['look', 'message'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events?.length) desc = ev.events.map(e => e.text ?? e.description ?? e.what ?? e.kind).join('\n');
            } catch {}
            result = result ?? { sent: true, id, description: desc };
            break;
          }
          default:
            result = { error: `unknown action: ${name}` };
        }
        json(result);
      } catch (e) {
        json({ error: e.message }, 500);
      }
      return;
    }

    // --- reroll: replace the character with a new one ---
    if (req.method === 'POST' && path === '/reroll') {
      const body = JSON.parse(await readBody(req));
      const { planCharacter } = await import('./m59-newchar.mjs');
      const plan = planCharacter({
        name: body.name || 'JayB',
        stats: body.stats || 'caster',
        loadout: body.loadout || 'selfSufficient',
        skills: body.skills || [],
      });
      if (!plan.ok) {
        json({ done: false, problems: plan.problems }, 400);
        return;
      }
      if (!body.confirm) {
        json({ done: false, note: 'pass confirm:true to proceed — this deletes the existing character' });
        return;
      }
      try {
        const c = session.client;
        if (!c) {
          json({ done: false, error: 'no game client — not in game' });
          return;
        }
        // Suicide the current character to set IsFirstTime
        console.error(`[keeper] ${agent} rerolling: suiciding current character`);
        c.suicide();
        await new Promise(r => setTimeout(r, 2000));
        // Join as new character
        console.error(`[keeper] ${agent} rerolling: creating new character ${plan.name} with stats ${JSON.stringify(plan.stats)}`);
        const made = await session.joinAsNewCharacter(plan, { userField: null });
        if (!made?.created) {
          json({ done: false, created: false, error: made?.error || 'character was not created', plan_summary: { name: plan.name, stats: plan.stats } });
          return;
        }
        // Verify stats
        const got = {};
        for (const [k, v] of (c.statsById ?? new Map()))
          if (!/^\d+\.\d+$/.test(k)) got[k] = v?.text !== undefined ? v.text : v.value;
        const asked = plan.stats;
        const STAT_ORDER = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];
        const haveReadings = STAT_ORDER.every(k => got[k] != null);
        const matched = haveReadings && STAT_ORDER.every(k => Number(got[k]) === asked[k]);
        const junk = haveReadings && STAT_ORDER.map(k => Number(got[k])).join('/') === '3/1/4/1/5/9';
        json({
          done: true, created: true,
          stats_now: got,
          max_health_now: c.vitals?.()?.health?.max ?? null,
          stats_as_asked: matched,
          stats_readable: haveReadings,
          looks_like_the_junk_default: junk,
          verdict: !haveReadings ? 'INCONCLUSIVE' : junk ? 'JUNK DEFAULT' : matched ? 'OK' : 'MISMATCH',
          plan_summary: { name: plan.name, stats: asked, ceiling: plan.max_health_ceiling, spells: plan.spells.map(s => s.name) },
        });
      } catch (e) {
        json({ done: false, error: e.message }, 500);
      }
      return;
    }

    json({ error: `unknown endpoint: ${req.method} ${path}` }, 404);
  } catch (e) {
    json({ error: e.message }, 500);
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- state caching
//
// The HTTP server shares the event loop with the GOAP loop. When the GOAP
// loop is doing a long walk (paced I/O), the HTTP server can't respond.
// So we cache the state after each GOAP pass and serve the cache from
// the HTTP endpoints. The cache is at most one pass stale.

let cachedState = null;
let cachedStateAt = 0;

function refreshCache() {
  try {
    cachedState = state();
    cachedStateAt = Date.now();
  } catch { /* never fatal */ }
}

// Refresh the cache every 2 seconds (independent of GOAP pass timing)
const cacheTimer = setInterval(refreshCache, 2000);
cacheTimer.unref();

// ---------------------------------------------------------------- state persistence

const statePath = `substrate/keeper-${agent}.json`;

function saveState() {
  try {
    const s = cachedState || state();
    mkdirSync('substrate', { recursive: true });
    writeFileSync(statePath, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error(`[keeper] ${agent} state save failed: ${e.message}`);
  }
}

const saveTimer = setInterval(saveState, 30000);
saveTimer.unref();

// ---------------------------------------------------------------- signal handling

process.on('SIGTERM', () => {
  log(`[keeper] ${agent} SIGTERM received`);
  if (autopilot) autopilot.stop('SIGTERM');
  saveState();
  if (session.client) {
    try { session.client.close(); } catch {}
  }
  process.exit(0);
  setTimeout(() => process.exit(1), 5000);
});

process.on('SIGINT', () => process.kill(process.pid, 'SIGTERM'));

process.on('exit', () => {
  saveState();
});

// ---------------------------------------------------------------- start

server.listen(port, '127.0.0.1', () => {
  log(`[keeper] ${agent} HTTP API on port ${port}`);
  join().catch(e => {
    log(`[keeper] ${agent} initial join failed: ${e.message}`);
    // Stay alive so the broker can retry
    setInterval(() => {
      join().catch(() => {});
    }, 30000);
  });
});
