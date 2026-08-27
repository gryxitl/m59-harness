#!/usr/bin/env node
// WHICH CHARACTER IS THE PERSON AT THIS MACHINE PLAYING — worked out, not declared.
//
// The pilot claim is what promotes speech to instruction, and it used to have to be made
// by hand or through the terminal's launch key. The commonest way in is neither: a
// click-to-play shortcut straight from Steam. That drops you into the world, bumps the
// broker off the character, and tells the broker nothing — so the operator stands in the
// room with privileges the broker does not know to grant. It cost one session twice, most
// visibly as five "safe spot here"s that every character in the room heard and none acted
// on.
//
// The command line carries the answer. m59-shortcuts.mjs writes, and Steam launches:
//
//   Meridian.exe /H:76.214.42.186 /P:5959 /U:t5 /W:<password> /Q /S
//
// so /U: IS the agent name. Read it rather than guessing.
//
// This lives in its own file for one reason: the broker cannot be imported to test it.
// Importing m59-broker.mjs RUNS it — it takes the fleet lock and starts rejoin timers —
// so anything that wants a unit test has to live outside it. The parsing and the matching
// are exactly the parts that can be wrong in a way nothing notices, which is why they are
// here and the claiming is not.
//
// EVERYTHING FAILS CLOSED. Any doubt returns no agent, which leaves the manual
// `pilot claim` path exactly as it was.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';

const run = promisify(execFile);

// The flags off a client command line. Quoted values are unwrapped, because a Windows
// path with a space in it arrives quoted and /W: passwords may too.
export function parseClientCommand(cmd) {
  const flag = (n) => {
    const m = new RegExp(`/${n}:("[^"]*"|[^\\s]+)`, 'i').exec(String(cmd || ''));
    return m ? m[1].replace(/^"|"$/g, '') : null;
  };
  const port = flag('P');
  return { account: flag('U'), host: flag('H'), port: port ? Number(port) : null };
}

// ONE CLIENT, OR NONE.
//
// Two running clients is not a puzzle to solve, it is a question only the person can
// answer, so it refuses rather than picking. The previous behaviour took the first pid
// tasklist reported and claimed whichever character happened to be rejoining at the time,
// with no check that the two had anything to do with each other — right by luck with one
// client open, and with two it hands instruction privileges to a process that is playing
// somebody else.
//
// `isKnownAgent` is asked rather than assumed so this file needs to know nothing about
// rosters or sessions.
export function soleClientAgent(clients, isKnownAgent) {
  const list = (clients || []).filter(c => c && c.pid);
  if (!list.length) return { agent: null, why: 'no Meridian client is running on this machine' };
  if (list.length > 1)
    return { agent: null, why: `${list.length} Meridian clients are running — refusing to guess ` +
                               'which character the person is playing' };
  const c = list[0];
  if (!c.account)
    return { agent: null, why: 'the client was launched without /U:, so it does not say who it is' };
  if (!isKnownAgent(c.account))
    return { agent: null, why: `/U:${c.account} is not a character in this fleet` };
  return { agent: c.account, pid: c.pid, host: c.host ?? null, port: c.port ?? null };
}

// Windows-only by inspection, and silent everywhere else — a missing answer just means
// the manual path.
//
// tasklist first because it is cheap and answers the common case (no client at all)
// without spawning PowerShell. The command line costs a CIM query, so it is only paid
// when there is exactly one process to ask about — and when there are two, the count
// alone is enough to refuse.
//
// ASYNCHRONOUS, AND WINDOWLESS. Both of those were wrong here, and both were visible
// from outside the process:
//
//   * execFileSync BLOCKED THE BROKER'S EVENT LOOP. Every keeper, every MCP call and
//     every dashboard request runs on that one loop, and this sat on it for the length
//     of a process spawn every 8 seconds — and for the length of a PowerShell COLD
//     START, 300-700ms, whenever a client was actually running, which is precisely when
//     somebody is watching the fleet. Nothing about a poll needs to be synchronous.
//
//   * WITHOUT `windowsHide` THE SCAN FLASHED A TERMINAL WINDOW ON THE DESKTOP. A broker
//     started as a service has no console of its own, so Windows allocated one per
//     spawn; with the default terminal left at "let Windows decide" that hand-off opens
//     a real Windows Terminal window. Measured from a console-less parent over three
//     seconds: 13 windows without the flag, 0 with it.
// ------------------------------------------------------------------- the POSIX scan
//
// THE SAME QUESTION, AND ON THIS SIDE IT IS CHEAPER THAN ON WINDOWS. `/proc/<pid>/cmdline`
// is the command line, NUL-separated, readable without spawning anything — so there is no
// tasklist, no PowerShell cold start, and none of the window-flashing the Windows branch
// had to be taught to avoid. The parsing is shared: Proton passes our arguments through
// unchanged, so `/U:t5` reaches the host process exactly as m59-shortcuts.mjs wrote it.
//
// WHY THIS DOES NOT SIMPLY COUNT PROCESSES, which is what the Windows branch can afford
// to do. A Proton launch is a CHAIN — the Steam wrapper, `proton waitforexitandrun`, the
// wine preloader and the client itself can all carry the same command line — so counting
// matches would report four clients where a person started one, and `soleClientAgent`
// would refuse to claim on the grounds that it cannot tell which character is being
// played. It can: they all say the same `/U:`. So the identity is the ACCOUNT and the
// processes are grouped by it, which keeps the real refusal intact — two accounts really
// are two people's characters — while a single launch answers with one client.
//
// Anything without a `/U:` is dropped when something else did name an account, because a
// wine helper in the same chain is not a second, anonymous client. When NOTHING names an
// account the unnamed matches are returned as they are, so the caller still says "launched
// without /U:" rather than "nothing is running". Fails closed exactly as before.
// AN ARGUMENT, NOT A SUBSTRING. Matching `meridian.exe` anywhere in the command line
// also matches every process that merely MENTIONS it — a grep, an editor, this repository's
// own tooling, a shell running `m59-shortcuts.mjs --show`. Those carry other people's
// flags as text, so a shell whose command string happens to contain `/U:t7` would be read
// as somebody playing t7 and could claim a character nobody launched. So the test is that
// some argv element IS the executable: it ends in `meridian.exe`, after a path separator
// or on its own. `/proc/<pid>/cmdline` is NUL-separated, which is what makes that
// distinction available here at all — the separators are the whole point, so split on them
// before doing anything else.
const CLIENT_ARG_RE = /(^|[\\/])meridian\.exe"?$/i;

// THE CAP COUNTS CLIENTS, NOT PROCESSES, AND ON THIS PLATFORM THOSE DIFFER BY SIX.
// The Windows cap could be a process count because one client is one process there. Here a
// single Steam launch is six — reaper, srt-bwrap, pv-adverb, proton, steam.exe, the game —
// so a cap of 8 raw matches is exceeded by the SECOND person's client, and the truncation
// lands mid-chain: the accounts that survive are whichever /proc happened to list first.
// That is the failure this file exists to prevent, silently. So the scan is bounded
// generously, and the cap is applied to distinct accounts after grouping.
const MAX_SCAN = 400;

// NOT EVERY UNIX HAS /proc, AND THE ONE THIS FLEET RUNS ON DOES NOT.
//
// This read /proc and returned [] when it could not — which on macOS is always, because
// /proc does not exist there. So `localClients()` reported "nobody is playing" on every
// scan, and everything built on that answer quietly stopped working: `heldByLocalClients`
// is the guard that stops the broker logging in a character somebody is at the keyboard
// for, and an empty list means it resumes everything, every time.
//
// The failure is silent in the worst way — no error, no warning, just a confident "no
// clients found" — and it is invisible to a reader because /proc is genuinely where this
// lives on Linux. m59-localclient-test was reporting it as nine failures.
//
// `ps` is the portable answer. Linux keeps the /proc path because it is cheaper and exact
// (an argv NUL-split cannot be confused by a space in a path); this is the fallback.
async function bsdClients() {
  let stdout = '';
  try { ({ stdout } = await run('ps', ['-Ao', 'pid=,command='], { timeout: 3000 })); }
  catch { return []; }
  const found = [];
  for (const line of stdout.split('\n')) {
    if (found.length >= MAX_SCAN) break;
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), command = m[2];
    if (pid === process.pid) continue;
    // Split on whitespace only to ASK THE QUESTION; the account is parsed from the whole
    // command string, so a path containing a space costs us the argv[0] test and nothing
    // more. Being wrong about `isClient` only reorders equals; being wrong about `account`
    // would name the wrong character.
    const argv = command.split(/\s+/).filter(Boolean);
    if (!argv.some(a => CLIENT_ARG_RE.test(a))) continue;
    found.push({ pid, isClient: CLIENT_ARG_RE.test(argv[0]), ...parseClientCommand(command) });
  }
  return found;
}

async function posixClients({ max = 32 } = {}) {
  let entries = null;
  try { entries = await readdir('/proc'); } catch { entries = null; }
  const found = entries ? [] : await bsdClients();
  const pids = entries ? entries.filter(n => /^\d+$/.test(n)).map(Number) : [];
  for (const pid of pids) {
    if (found.length >= MAX_SCAN) break;
    if (pid === process.pid) continue;
    let raw;
    // A pid can exit between the listing and the read; that is ordinary, not an error.
    try { raw = await readFile(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!raw) continue;
    const argv = raw.split('\0').filter(Boolean);
    if (!argv.some(a => CLIENT_ARG_RE.test(a))) continue;
    // IS THIS THE CLIENT, OR SOMETHING CARRYING IT? Measured on a real Steam Deck launch,
    // one client is six processes: reaper, srt-bwrap, pv-adverb, proton (python3),
    // steam.exe, and the game. The first five name Meridian.exe as an ARGUMENT they are
    // about to run; only the last one IS it, with the executable at argv[0].
    found.push({ pid, isClient: CLIENT_ARG_RE.test(argv[0]), ...parseClientCommand(argv.join(' ')) });
  }
  const named = found.filter(c => c.account);
  if (!named.length) return found.slice(0, max);
  // One entry per distinct account. THE PID IS THE GAME, NOT THE WRAPPER THAT SPAWNED IT:
  // a claim is bound to a pid and released when it exits, so it has to name the process
  // whose life IS the person's session. The launch chain's wrappers do exit together with
  // the game today, which is exactly why picking the wrong one would go unnoticed — until
  // some future Proton keeps a helper alive and the character stays claimed by nobody.
  // Lowest pid is the tie-break only among equals, never a substitute for the test.
  const byAccount = new Map();
  for (const c of named.sort((a, b) => (b.isClient - a.isClient) || (a.pid - b.pid))) {
    if (!byAccount.has(c.account)) byAccount.set(c.account, c);
  }
  return [...byAccount.values()].slice(0, max).map(({ isClient, ...rest }) => rest);
}

let scanCache = { at: 0, clients: [] };
export async function localClients({ ttlMs = 8000 } = {}) {
  if (Date.now() - scanCache.at < ttlMs) return scanCache.clients;
  if (process.platform !== 'win32') {
    const clients = await posixClients();
    scanCache = { at: Date.now(), clients };
    return clients;
  }
  let clients = [];
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq meridian.exe', '/FO', 'CSV', '/NH'],
                                 { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const pids = [...stdout.matchAll(/^"[^"]+","(\d+)"/gm)].map(m => Number(m[1]));
    if (pids.length === 1) {
      let cmd = '';
      try {
        const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pids[0]}").CommandLine`],
          { encoding: 'utf8', timeout: 6000, windowsHide: true });
        cmd = r.stdout.trim();
      } catch { /* no PowerShell, or the process went away between the two calls */ }
      clients = [{ pid: pids[0], ...parseClientCommand(cmd) }];
    } else {
      clients = pids.map(pid => ({ pid, account: null, host: null, port: null }));
    }
  } catch { /* no tasklist, or none running */ }
  scanCache = { at: Date.now(), clients };
  return clients;
}

// EVERY CLIENT, NAMED — for the one moment when refusing to guess is the wrong answer.
//
// `localClients` reads a command line only when there is exactly one process, because the
// question it serves is "who may speak as an operator", and with two clients open that
// question has no safe answer. Startup asks a DIFFERENT question: "which of our characters
// would logging in bump a person out of". That one has to be answered for all of them,
// because a broker that logs in a character somebody is playing has already done the harm
// — there is nothing to be cautious about afterwards.
//
// So this reads the command line of every client, and the caller decides what each is
// worth. Bounded, because this spawns a PowerShell per process and is only ever run once
// per broker start; more clients than this on one desktop is not a real configuration.
const MAX_IDENTIFY = 8;
export async function identifyClients() {
  // The POSIX scan already reads every command line — there is no cheap-count-then-ask
  // split to make, because nothing is spawned either way. Grouping by account is right
  // here too: startup is asking which of OUR characters a login would bump somebody out
  // of, and one person playing one character is one answer however many wine processes
  // the launch chain left behind.
  if (process.platform !== 'win32') return posixClients({ max: MAX_IDENTIFY });
  let pids = [];
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq meridian.exe', '/FO', 'CSV', '/NH'],
                                 { encoding: 'utf8', timeout: 3000, windowsHide: true });
    pids = [...stdout.matchAll(/^"[^"]+","(\d+)"/gm)].map(m => Number(m[1]));
  } catch { return []; }                          // no tasklist, or none running
  const asked = pids.slice(0, MAX_IDENTIFY);
  const out = await Promise.all(asked.map(async (pid) => {
    try {
      const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 6000, windowsHide: true });
      return { pid, ...parseClientCommand(r.stdout.trim()) };
    } catch { return { pid, account: null, host: null, port: null }; }
  }));
  // A client we could not identify is still worth reporting: the caller can say "something
  // is running that I could not name" rather than "nothing is running".
  return out.concat(pids.slice(MAX_IDENTIFY).map(pid => ({ pid, account: null, host: null, port: null })));
}

// WHICH ROSTER CHARACTERS A PERSON IS ALREADY HOLDING. Pure, so the matching can be
// tested without spawning anything.
//
// The host check is the same one the claim path makes and for the same reason: another
// checkout playing the same account against a different server is not our operator, and
// standing down for it would leave a character out of this fleet for no reason. A client
// that gave no /H: is trusted, because that is what a hand-typed launch looks like.
export function clientsHoldingRoster(clients, rosterHost) {
  const held = [], unknown = [];
  for (const c of (clients || [])) {
    if (!c?.pid) continue;
    if (!c.account) { unknown.push({ pid: c.pid, why: 'no /U: on its command line' }); continue; }
    const want = rosterHost(c.account);
    if (want === undefined) { unknown.push({ pid: c.pid, account: c.account, why: 'not in this roster' }); continue; }
    if (want && c.host && want !== c.host) {
      unknown.push({ pid: c.pid, account: c.account,
                     why: `pointed at ${c.host}, this fleet is on ${want}` });
      continue;
    }
    held.push({ agent: c.account, pid: c.pid, host: c.host ?? null });
  }
  return { held, unknown };
}

// WHEN TO LOOK AT ALL — and the answer is "hardly ever".
//
// The pilot watch ticks every 4 seconds for the life of the broker, and behind it this
// scan ran every 8, for ever, on a machine where no client had been launched all day.
// That is a process spawn every 8 seconds to answer a question whose answer only
// changes when a person starts a game.
//
// So the scan is ARMED rather than periodic. It is armed at boot, because a client may
// already be running when the broker comes up, and THE FIRST LOOK THAT FINDS NOTHING
// DISARMS IT. Nothing re-arms it but an event that could plausibly have produced a
// client: the terminal's launch key, or a claim ending because the client it was bound
// to exited — which is very often somebody relaunching one.
//
// A client started some other way, a Steam shortcut straight from the library, is not
// seen by this, and that is the deliberate cost of not polling. It is still caught,
// later and by another route: the character the person took over starts losing its
// session, and the reconciler's contention branch scans directly and re-arms this. See
// m59-broker.mjs.
//
// `scan` is injectable so the gate can be tested without spawning anything.
export function createClientWatch({ scan = localClients } = {}) {
  let armed = true;
  let why = 'the broker has just started, and a client may already be running';
  return {
    get armed() { return armed; },
    why: () => why,
    arm(reason) { armed = true; why = reason; },
    disarm(reason) { armed = false; why = reason; },
    // THE ONLY THING HERE THAT SPAWNS A PROCESS. A disarmed watch reports
    // `scanned: false` rather than an empty list, because "we did not look" and "we
    // looked and there was nobody" are different answers — and a caller that confused
    // them would report no client with the same confidence either way.
    async look() {
      if (!armed) return { scanned: false, clients: [] };
      const clients = await scan();
      if (!clients.length) {
        armed = false;
        why = 'nothing was running at the last look — not scanning again until a client ' +
              'is launched from the terminal';
      }
      return { scanned: true, clients };
    },
  };
}

// For tests and for anything that wants a fresh answer after launching a client.
export function forgetLocalClients() { scanCache = { at: 0, clients: [] }; }
