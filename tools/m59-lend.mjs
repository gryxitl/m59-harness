#!/usr/bin/env node
// LEND CHARACTERS TO ANOTHER FLEET, OVER THE INTERNET, WITHOUT SHARING A PASSWORD.
//
//   node tools/m59-lend.mjs --port 8931                 # loopback; put a tunnel in front
//   node tools/m59-lend.mjs --port 8931 --bind 0.0.0.0  # only behind a VPN you trust
//
// This is the far half of `m59-handoff.mjs`. That mints the capability; this is the door
// it opens. The broker keeps the roster and the live sockets and never moves; a borrower
// points their own tooling at this port with a grant token, and the characters that grant
// names appear in THEIR fleet as ordinary MCP tools.
//
//   owner   node tools/m59-handoff.mjs mint --to "a friend" --agents t1,t2 --for 4h
//   friend  node tools/m59-mcp-attach.mjs --host <tunnel> --port 8931 --token m59g_...
//
// The friend's agent then drives t1 and t2 exactly as if they were its own. Nothing about
// the password, the roster, or the MD5 digest crosses the wire — the only thing that
// travels is a revocable, expiring capability and the tool calls it authorises.
//
// WHY THIS IS A SEPARATE PROCESS FROM THE BROKER, AND MUST STAY ONE.
//
// The broker's own HTTP port has no authentication at all: the fleet page renders its
// controls only for 127.0.0.1 and the POST behind them is refused at the socket for
// anything else. That is the right design for something holding twenty-one accounts whose
// passwords cannot be reset, and the wrong thing to bolt an internet-facing auth layer
// onto — a bug in this file must not be able to become a bug in the thing holding the
// sessions. So this owns no sessions, holds no roster, takes no lock, and forwards.
//
// THREE THINGS IT ENFORCES, and the first is the one that makes lending different from
// giving somebody your password:
//
//   SCOPE     a grant naming t1,t2 may drive t1 and t2. A call naming any other agent is
//             refused, and `fleet` comes back FILTERED to those characters rather than
//             refused — a borrower needs a board, and a board of somebody else's
//             nineteen characters is both a leak and a distraction.
//   VERBS     if the grant was minted `--safe`, the irreversible verbs are withheld.
//             Grants are full control by default; this only bites when asked for.
//   EVIDENCE  every call is logged with the grant id, the agent, the tool and the remote
//             address, because "who moved my character" is the question that gets asked.
//
// It never speaks to the game server. It speaks to the broker on loopback, exactly as
// m59-mcp-attach.mjs does, and it cannot do anything a local operator could not.
import http from 'node:http';
import process from 'node:process';
import { verifyGrant, toolAllowed } from './m59-handoff.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 8931));
const BIND = arg('--bind', '127.0.0.1');
const BROKER = Number(arg('--broker-port', process.env.M59_BROKER_PORT || 8901));
const FLEET = arg('--fleet', null);
const QUIET = argv.includes('--quiet');

// Tools that answer about the fleet rather than one character. A scoped grant may call
// these, and `fleet` is filtered on the way back.
const ROSTER_WIDE = new Set(['fleet', 'who', 'map', 'travel_estimate', 'merchants',
                             'hunting_grounds', 'safe_spots', 'prey', 'spells']);
// Anything that changes the world needs `orders`; everything else needs `read`. Being
// wrong in the safe direction here means a read grant is refused something harmless,
// which is a complaint. Being wrong the other way is a stranger issuing orders.
const READ_ONLY = new Set(['fleet', 'status', 'look', 'look_at', 'inventory', 'equipment',
                           'map', 'who', 'abilities', 'bank', 'progress', 'history',
                           'travel_estimate', 'merchants', 'hunting_grounds', 'safe_spots',
                           'prey', 'spells', 'post_mortem', 'loadout', 'container',
                           'resolve_item_names', 'drop_sources', 'commerce_catalog',
                           'commerce_status', 'faction_status', 'guild', 'inbox']);

const log = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); };

// ---------------------------------------------------------------------------
// TAKING THE WHEEL, AND GIVING IT BACK WITHOUT BEING ASKED.
//
// This is the whole point of driving through a proxy rather than moving the fleet. The
// broker never moves, so "who holds the fleet" is never a question and there is nothing to
// arbitrate — no lock, no lease file, no second machine that has to be told anything. The
// only question is whether somebody is driving REMOTELY right now, and the answer is
// whether calls are still arriving.
//
// So a borrower's first order CLAIMS the directional faculties for the characters their
// grant covers, and every order after that renews the claim. Then the operator closes the
// laptop, or the train goes into a tunnel, or the power cuts — and nothing has to notice.
// The claim simply stops being renewed, the lease lapses, and the keeper takes the
// character back on its own. `lease_ms` is documented as exactly this: "taken back by the
// keeper this long after the last heartbeat. Leases fail BACK to the keeper, never open."
//
// WHAT IS NEVER HANDED OVER, and this is what makes it safe to give to somebody who is not
// going to be watching: `PROTECTED_FACULTIES` — identity, mortality, survival, recovery —
// stay with the keeper at home no matter what. A borrowed character still runs from a
// fight it is losing, still rests when hurt, still climbs out of the Underworld, even
// while its driver is asleep or gone. The borrower gets work, movement, economy and
// social: what to hunt, where to stand, what to buy, what to say.
const CONTROL_FACULTIES = ['work', 'movement', 'economy', 'social'];
// Long enough that a borrower thinking between orders does not lose the wheel; short
// enough that a vanished one hands it back before the fleet notices. Two minutes is the
// broker's own default for the same reason.
const CONTROL_LEASE_MS = Number(arg('--lease-ms', 120_000));
// Renew at a third of the lease, so one missed call does not drop control.
const RENEW_AFTER_MS = CONTROL_LEASE_MS / 3;

const lastClaim = new Map();          // agent -> when we last renewed for it

async function takeWheel(agent, grant) {
  const now = Date.now();
  const prev = lastClaim.get(agent) ?? 0;
  if (now - prev < RENEW_AFTER_MS) return;         // still comfortably held
  lastClaim.set(agent, now);
  const by = `lend:${grant.id}/${grant.label}`.slice(0, 80);
  try {
    const r = await brokerTool('autopilot', {
      agent, action: 'claim', faculties: CONTROL_FACULTIES,
      by, lease_ms: CONTROL_LEASE_MS,
    });
    if (prev === 0) log(`  ${agent}: wheel taken by ${by} (lease ${CONTROL_LEASE_MS / 1000}s, ` +
                        `survival stays home)${r?.refused?.length ? ' refused=' + JSON.stringify(r.refused) : ''}`);
  } catch (e) {
    // A claim that fails must not block the order. Worst case the keeper and the borrower
    // both steer for a moment, which is the ordinary pre-claim behaviour and self-corrects.
    log(`  ${agent}: claim failed (${e.message}) — forwarding anyway`);
  }
}

// A small typed call to the local broker, for our own bookkeeping rather than the
// borrower's traffic.
function brokerTool(name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: BROKER, method: 'POST', path: '/',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.setEncoding('utf8');
        res.on('data', c => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(JSON.parse(d).result.content[0].text)); }
                              catch { resolve({}); } }); });
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function forward(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: BROKER, method: 'POST', path: '/',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.setEncoding('utf8');
        res.on('data', c => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    // No timeout: a tool call can be a long walk across the world, and cutting it off
    // leaves the borrowed character mid-errand. Same reasoning as m59-mcp-attach.mjs.
    req.setTimeout(0);
    req.on('error', reject);
    req.end(body);
  });
}

const rpcError = (id, code, message) => JSON.stringify({
  jsonrpc: '2.0', id: id ?? null, error: { code, message },
});

/** A tool result is MCP-shaped: content[0].text holding JSON. Rewrite that text in place. */
function rewriteToolText(payload, fn) {
  try {
    const j = JSON.parse(payload);
    const t = j?.result?.content?.[0]?.text;
    if (typeof t !== 'string') return payload;
    const inner = JSON.parse(t);
    const out = fn(inner);
    if (out === undefined) return payload;
    j.result.content[0].text = JSON.stringify(out, null, 2);
    return JSON.stringify(j);
  } catch { return payload; }
}

const server = http.createServer((req, res) => {
  const remote = req.socket.remoteAddress;
  let raw = '';
  req.setEncoding('utf8');
  // A borrower is not trusted to send a sane body.
  req.on('data', (c) => { raw += c; if (raw.length > 512 * 1024) req.destroy(); });
  req.on('end', async () => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body);
    };
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return send(400, rpcError(null, -32700, 'bad JSON')); }
    const id = msg?.id ?? null;

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return send(401, rpcError(id, -32001, 'a grant token is required'));

    const method = String(msg?.method || '');
    const tool = method === 'tools/call' ? String(msg?.params?.name || '') : null;
    const args = msg?.params?.arguments ?? {};
    const agent = typeof args?.agent === 'string' ? args.agent : null;
    const need = tool && !READ_ONLY.has(tool) ? 'orders' : 'read';

    // A grant scoped to specific agents may only touch those. A call that names no agent
    // is allowed ONLY for the roster-wide reads, and `fleet` is filtered below — anything
    // else without an agent is refused rather than guessed at.
    const v = verifyGrant(token, { need, agent, fleet: FLEET, remote });
    if (!v.ok) {
      log(`REFUSED ${remote} ${tool ?? method} agent=${agent ?? '-'} :: ${v.why}`);
      // The borrower is told no, not why. The reason is for this log.
      return send(403, rpcError(id, -32002, 'refused'));
    }
    const grant = v.grant;
    const scoped = Array.isArray(grant.agents);

    if (tool && !agent && scoped && !ROSTER_WIDE.has(tool)) {
      log(`REFUSED ${remote} ${tool} :: scoped grant, no agent named`);
      return send(403, rpcError(id, -32002, 'this grant covers named characters; name one'));
    }
    if (tool) {
      const verdict = toolAllowed(tool, args, { restricted: !!grant.restricted });
      if (!verdict.ok) {
        log(`REFUSED ${remote} grant=${grant.id} ${tool} :: ${verdict.why}`);
        return send(403, rpcError(id, -32003, verdict.why));
      }
    }

    // TAKE THE WHEEL BEFORE THE ORDER, not after: the claim is what stops the local keeper
    // steering into the same character on the pass that this order is about to change.
    if (tool && agent && need === 'orders') await takeWheel(agent, grant);

    let out;
    try { out = await forward(raw); }
    catch (e) { return send(502, rpcError(id, -32000, `broker unreachable: ${e.message}`)); }

    let body = out.body;
    // FILTER THE BOARD. A borrower of two characters gets a board of two characters —
    // otherwise every lend leaks the whole roster's positions, health and money.
    if (tool === 'fleet' && scoped) {
      body = rewriteToolText(body, (f) => {
        if (!Array.isArray(f?.fleet)) return undefined;
        const keep = f.fleet.filter(r => grant.agents.includes(r.agent));
        return { ...f, fleet: keep, agents: keep.length,
                 lent: { grant: grant.id, to: grant.label, of: f.fleet.length,
                         note: 'filtered to the characters this grant covers' },
                 needs_attention: (f.needs_attention ?? []).filter(a => grant.agents.includes(a)) };
      });
    }
    log(`ok ${remote} grant=${grant.id}(${grant.label}) ${tool ?? method} agent=${agent ?? '-'}`);
    send(out.status || 200, body);
  });
});

server.listen(PORT, BIND, () => {
  console.log(`m59-lend on ${BIND}:${PORT} -> broker 127.0.0.1:${BROKER}`);
  console.log(`  fleet filter : ${FLEET ?? '(any fleet a grant names)'}`);
  if (BIND !== '127.0.0.1')
    console.log('  WARNING: bound off loopback. There is no TLS here — put this behind a\n' +
                '           VPN or an SSH tunnel, never straight onto the internet.');
  console.log('  mint a grant : node tools/m59-handoff.mjs mint --to "<who>" --agents t1,t2 --for 4h');
  console.log('  revoke it    : node tools/m59-handoff.mjs revoke <id>');
});
