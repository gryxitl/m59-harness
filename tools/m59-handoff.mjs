#!/usr/bin/env node
// PASS THE SESSION ACROSS THE INTERNET WITHOUT PASSING THE PASSWORD.
//
//   node tools/m59-handoff.mjs mint --to "steamdeck" --agents t1,t2 --for 4h --scope orders
//   node tools/m59-handoff.mjs list
//   node tools/m59-handoff.mjs revoke <id>
//   node tools/m59-handoff.mjs revoke --all
//   node tools/m59-handoff.mjs show <id>
//
// WHAT IS ACTUALLY BEING PASSED, AND WHY IT CANNOT BE THE SESSION ITSELF.
//
// Meridian has no resume verb. `SynchedAcceptLogin` (blakserv/synched.c:321) is the whole
// of authentication — `a = AccountLoginByName(name); if (a == NULL || a->password !=
// password)` — an account name and one string, re-checked on every TCP connect. There is
// no token to hand anybody, and the AP verb table has no reconnect. The wire carries
// MD5(password) rather than the plaintext, but that digest IS the credential: whoever
// holds it logs in as that character, so shipping digests instead of passwords moves the
// same authority under a different name.
//
// Nor can the live connection be carried over. Each session holds anti-spoof state —
// `seeds[SEED_COUNT]`, `secure_token`, `sliding_token` — that advances on EVERY packet in
// lockstep with the server (blakserv/commcli.c:160-177); one step out of line sets
// `seeds_hacked` and the server drops you silently. Moving that means moving a live socket
// to a host the server's packets do not route to.
//
// So what moves is AUTHORITY, not credentials and not sockets. The broker stays here,
// holding the roster and the connections. A grant is a bearer capability that lets another
// machine drive some of this fleet, through the gateway, for a while. The password never
// leaves this disk, and the day the far machine is compromised you revoke a row rather
// than re-rolling twenty-one characters that cannot be re-rolled.
//
// FIVE PROPERTIES, and each is the mistake a static shared secret makes:
//
//   1. THE TOKEN IS NEVER STORED. Only a salted SHA-256 of it. A grant file that leaks
//      does not let anybody drive; it names what was granted and to whom, which is what
//      you want in an audit trail and is useless as a key.
//   2. IT EXPIRES, and expiry is checked on USE rather than trusted at mint. A clock that
//      only runs when somebody remembers to look is not a clock.
//   3. IT IS SCOPED. `read` cannot issue orders. An agent allowlist means handing over two
//      characters does not hand over twenty-one — the failure a single shared token cannot
//      express at all.
//   4. REVOCATION IS IMMEDIATE, checked per request off disk. Not "the token rotates
//      tomorrow".
//   5. IT IS AUDITED — use count, last use, last remote address — because "who moved this
//      character" is exactly the question you will ask afterwards.
//
// The grants live in `substrate/grants/`, which is gitignored for the same reason the
// roster is: it is this machine's authority, not the repository's.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GRANT_DIR = join(REPO, 'substrate', 'grants');

export const SCOPES = ['read', 'orders'];
// Long enough that guessing is hopeless, short enough to paste into a tunnel config.
const SECRET_BYTES = 32;
const ID_BYTES = 6;
// A grant with no end is a password with extra steps.
export const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days, hard ceiling
export const DEFAULT_LIFETIME_MS = 12 * 60 * 60 * 1000;    // 12 hours

const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = (secret, salt) => createHash('sha256').update(`${salt}:${secret}`).digest('hex');

/** `2h`, `45m`, `7d`, or a plain number of seconds. */
export function parseDuration(s) {
  if (s === undefined || s === null || s === '') return DEFAULT_LIFETIME_MS;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const ms = n * mult;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const ensureDir = () => { mkdirSync(GRANT_DIR, { recursive: true, mode: 0o700 }); };
const pathFor = (id, dir = GRANT_DIR) => join(dir, `${id}.json`);

export function loadGrant(id, dir = GRANT_DIR) {
  if (!/^[0-9a-f]{8,32}$/.test(String(id || ''))) return null;
  const p = pathFor(id, dir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function listGrants(dir = GRANT_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.issued_at ?? 0) - (a.issued_at ?? 0));
}

/**
 * Mint a grant. The secret is returned ONCE and never written down — the caller has to
 * deliver it, and if they lose it the answer is a new grant, not a lookup.
 */
export function mintGrant({
  to, fleet = null, agents = null, scope = 'orders', restricted = false,
  lifetimeMs = DEFAULT_LIFETIME_MS, note = '', dir = GRANT_DIR, now = Date.now(),
} = {}) {
  const label = String(to || '').trim();
  if (!label) throw new Error('a grant needs --to: who is being trusted, for the audit trail');
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) throw new Error('bad lifetime');
  if (lifetimeMs > MAX_LIFETIME_MS)
    throw new Error(`a grant may not outlive ${MAX_LIFETIME_MS / 86_400_000} days — ` +
                    `an endless grant is a password with extra steps`);

  // HEX, NOT base64url. The token is `m59g_<id>_<secret>` and base64url's alphabet
  // CONTAINS THE UNDERSCORE, so an id that happened to include one made the split point
  // ambiguous and the parser tore the token in the wrong place — intermittently, on about
  // a quarter of mints, which showed up as "sometimes the token just does not work".
  // Hex cannot collide with the separator.
  const id = randomBytes(ID_BYTES).toString('hex');
  const secret = b64u(randomBytes(SECRET_BYTES));
  const salt = b64u(randomBytes(12));

  const grant = {
    format: 'm59-handoff/1',
    id, label,
    fleet: fleet ? String(fleet) : null,
    // null means "the whole fleet". An EMPTY ARRAY means nothing, and is refused at mint
    // rather than silently behaving like null — the two readings differ by everything.
    agents: agents === null ? null : [...new Set(agents.map(String))],
    scope,
    // Full control unless somebody asked for a floor. See RESTRICTED_VERBS.
    restricted: !!restricted,
    issued_at: now,
    expires_at: now + lifetimeMs,
    revoked_at: null,
    note: String(note || '').slice(0, 500),
    salt,
    token_hash: hash(secret, salt),
    uses: 0, last_used_at: null, last_remote: null,
  };
  if (Array.isArray(grant.agents) && grant.agents.length === 0)
    throw new Error('--agents was empty: pass agents, or omit it to mean the whole fleet');

  ensureDir();
  writeFileSync(pathFor(id, dir), JSON.stringify(grant, null, 2), { mode: 0o600 });
  // `m59g_<id>_<secret>` — the id is in the clear so a check is one file read rather than
  // a scan of every grant, which is what would otherwise leak timing across grants.
  return { grant, token: `m59g_${id}_${secret}` };
}

// The id is hex and the secret is base64url, so the FIRST two underscores are the only
// possible separators and the split is unambiguous. Anchored on both ends: a token with
// anything trailing is not a token.
export function parseToken(token) {
  const m = String(token || '').match(/^m59g_([0-9a-f]{8,32})_([A-Za-z0-9_-]{16,})$/);
  return m ? { id: m[1], secret: m[2] } : null;
}

/**
 * Check a bearer token against the grant store.
 *
 * NEVER THROWS AND NEVER SAYS WHY TO THE CALLER'S FACE — it returns a reason for the
 * SERVER's log. A verifier that tells the far end "that grant expired" rather than "no"
 * is a verifier that helps somebody enumerate.
 *
 * `need` is the scope the operation requires; `agent` is the character it touches.
 */
export function verifyGrant(token, { need = 'read', agent = null, fleet = null,
                                     dir = GRANT_DIR, now = Date.now(), remote = null,
                                     record = true } = {}) {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, why: 'malformed token' };
  const grant = loadGrant(parsed.id, dir);
  if (!grant) return { ok: false, why: 'no such grant' };

  // Constant time, and length-guarded first because timingSafeEqual throws on a mismatch.
  const got = Buffer.from(hash(parsed.secret, grant.salt));
  const want = Buffer.from(String(grant.token_hash || ''));
  if (got.length !== want.length || !timingSafeEqual(got, want))
    return { ok: false, why: 'bad secret', id: grant.id };

  if (grant.revoked_at) return { ok: false, why: 'revoked', id: grant.id };
  // ON USE, not at mint. A grant minted for an hour and read six hours later is expired
  // now, whatever the file said when it was written.
  if (!(now < grant.expires_at)) return { ok: false, why: 'expired', id: grant.id };

  if (!SCOPES.includes(need)) return { ok: false, why: 'unknown scope required', id: grant.id };
  // `read` may not order. Ordering implies reading, so `orders` satisfies both.
  if (need === 'orders' && grant.scope !== 'orders')
    return { ok: false, why: 'grant is read-only', id: grant.id };

  if (fleet && grant.fleet && grant.fleet !== fleet)
    return { ok: false, why: 'grant is for another fleet', id: grant.id };

  // A null allowlist is the whole fleet; a list is exactly that list. An agent the grant
  // does not name is refused even when the grant is otherwise perfectly valid — this is
  // the property a single shared secret cannot express.
  if (agent !== null && Array.isArray(grant.agents) && !grant.agents.includes(String(agent)))
    return { ok: false, why: 'agent not in this grant', id: grant.id };

  if (record) {
    grant.uses = (grant.uses ?? 0) + 1;
    grant.last_used_at = now;
    if (remote) grant.last_remote = String(remote).slice(0, 64);
    try { writeFileSync(pathFor(grant.id, dir), JSON.stringify(grant, null, 2), { mode: 0o600 }); }
    catch { /* an audit write that fails must not deny a legitimate request */ }
  }
  return { ok: true, grant, id: grant.id };
}

// ---------------------------------------------------------------------------
// AN OPTIONAL VERB BOUNDARY. OFF BY DEFAULT: A GRANT IS FULL CONTROL.
//
// The default is deliberate and was the operator's call. A grant hands over the character,
// including the parts that cannot be taken back — if you lend somebody a character to run
// as a bot, half-lending it produces a bot that stalls on the verb you withheld, and you
// find out from a silence rather than an error.
//
// WHAT A GRANT STILL IS NOT, EVEN AT FULL CONTROL, and this is the whole reason it beats
// handing over the password: it is REVOCABLE in one command, it EXPIRES on its own, it is
// scoped to named characters rather than the account, every use is ATTRIBUTED, and the
// holder never learns the credential — so revoking actually ends it, which telling
// somebody a password never does.
//
// `--safe` opts into the list below for the cases where you do want a floor — a stranger
// rather than a guildmate, or an unattended bot you have not read the code of. Each entry
// is unrecoverable in a different way:
//
//   leave / forget   drops the roster entry, and THE ROSTER IS THE ONLY RECORD OF THE
//                    ACCOUNT PASSWORD. There is no reset and no email on the account, so a
//                    character forgotten is a character permanently unreachable. This is
//                    the single most destructive verb in the whole broker and it looks
//                    like an ordinary cleanup call.
//   reroll           the character's attributes are fixed at creation. Re-rolling is
//                    deleting a character that took weeks to raise.
//   guild disband, abandon_hall, set_password, exile
//                    guild property and membership. There is no way to RENAME a guild, so
//                    a disband is 5,000 shillings and every member's rank gone; a hall is
//                    25,000. One of these characters is the guildmaster.
//   describe         puts words in the character's mouth to every player who looks at it,
//                    on a shared server, under the owner's name.
//
// When it IS on, it is a deny list ON TOP OF SCOPE, never a replacement: the scope still
// has to say `orders`, the agent still has to be in the allowlist, and the grant still has
// to be live.
export const RESTRICTED_VERBS = Object.freeze({
  leave: null, forget: null, leave_raza: null, reroll: null, pilot: null,
  describe: null,
  guild: ['disband', 'abandon_hall', 'set_password', 'exile', 'abdicate'],
});

/**
 * May this grant call this tool with these arguments?
 *
 * UNRESTRICTED BY DEFAULT — a grant is full control, so this answers yes unless the grant
 * was minted `--safe`. The action check is per-tool: `guild` is not banned outright even
 * then, because reading the roster or inviting destroys nothing.
 */
export function toolAllowed(tool, args = {}, { restricted = false } = {}) {
  if (!restricted) return { ok: true };
  const name = String(tool || '');
  if (!Object.prototype.hasOwnProperty.call(RESTRICTED_VERBS, name)) return { ok: true };
  const banned = RESTRICTED_VERBS[name];
  // null means the whole tool is off limits.
  if (banned === null) return { ok: false, why: `${name} is withheld from this grant` };
  const action = String(args?.action ?? '');
  // AN ABSENT ACTION IS REFUSED, not waved through. A tool whose destructive verbs are
  // selected by an argument must not become available by omitting the argument.
  if (!action) return { ok: false, why: `${name} needs an explicit action under a restricted grant` };
  return banned.includes(action)
    ? { ok: false, why: `${name} ${action} is withheld from this grant` }
    : { ok: true };
}

export function revokeGrant(id, { dir = GRANT_DIR, now = Date.now() } = {}) {
  const grant = loadGrant(id, dir);
  if (!grant) return false;
  // MARKED, NOT DELETED. The audit trail is the point: a revoked grant that vanishes takes
  // "who had this, and what did they do with it" with it.
  grant.revoked_at = now;
  writeFileSync(pathFor(id, dir), JSON.stringify(grant, null, 2), { mode: 0o600 });
  return true;
}

// LIVE ONES ONLY, which is what the word means. An expired grant already carries no
// authority, so marking it revoked would inflate the count this reports and muddy an audit
// record that currently reads "this one ran out" rather than "somebody pulled it".
export function revokeAll({ dir = GRANT_DIR, now = Date.now() } = {}) {
  let n = 0;
  for (const g of listGrants(dir))
    if (grantStatus(g, now) === 'live' && revokeGrant(g.id, { dir, now })) n++;
  return n;
}

/** What a grant is right now, for `list` and for the fleet board. */
export function grantStatus(g, now = Date.now()) {
  if (g.revoked_at) return 'revoked';
  if (!(now < g.expires_at)) return 'expired';
  return 'live';
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const has = (n) => argv.includes(n);
  const when = (t) => t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—';

  if (cmd === 'mint') {
    const lifetimeMs = parseDuration(arg('--for'));
    if (lifetimeMs === null) { console.error('--for wants something like 45m, 4h, 7d'); process.exit(2); }
    const agentsRaw = arg('--agents');
    try {
      const { grant, token } = mintGrant({
        to: arg('--to'),
        fleet: arg('--fleet'),
        agents: agentsRaw ? agentsRaw.split(',').map(s => s.trim()).filter(Boolean) : null,
        scope: arg('--scope', 'orders'),
        restricted: has('--safe'),
        lifetimeMs,
        note: arg('--note', ''),
      });
      console.log(`granted ${grant.id} to "${grant.label}"`);
      console.log(`  scope    ${grant.scope}`);
      console.log(`  fleet    ${grant.fleet ?? '(any)'}`);
      console.log(`  agents   ${grant.agents ? grant.agents.join(',') : '(the whole fleet)'}`);
      console.log(`  control  ${grant.restricted
        ? 'restricted — leave/forget/reroll/pilot/describe and the destructive guild verbs withheld'
        : 'FULL — including what cannot be undone. --safe withholds the irreversible verbs'}`);
      console.log(`  expires  ${when(grant.expires_at)}  (${Math.round(lifetimeMs / 60000)} min)`);
      console.log(`\n  ${token}\n`);
      console.log('That token is shown ONCE and is not stored — only a salted hash of it is.');
      console.log('Send it over something already private, and give the far end the gateway');
      console.log('through a tunnel; the broker\'s own port must never face the internet.');
      console.log(`Revoke instantly with:  node tools/m59-handoff.mjs revoke ${grant.id}`);
    } catch (e) { console.error(`refused: ${e.message}`); process.exit(2); }

  } else if (cmd === 'revoke') {
    if (has('--all')) { console.log(`revoked ${revokeAll()} live grant(s)`); }
    else {
      const id = argv[1];
      if (!id) { console.error('revoke <id>, or --all'); process.exit(2); }
      console.log(revokeGrant(id) ? `revoked ${id}` : `no such grant ${id}`);
    }

  } else if (cmd === 'show') {
    const g = loadGrant(argv[1]);
    if (!g) { console.error('no such grant'); process.exit(2); }
    console.log(JSON.stringify({ ...g, token_hash: '(not shown)', salt: '(not shown)' }, null, 2));

  } else {
    const all = listGrants();
    if (!all.length) {
      console.log(`no grants in ${GRANT_DIR}`);
      console.log('Nothing on this machine may be driven from anywhere else.');
    } else {
      console.log('id        status   scope   to                 agents         expires           uses  last remote');
      for (const g of all) {
        console.log([
          g.id.padEnd(9), grantStatus(g).padEnd(8), String(g.scope).padEnd(7),
          String(g.label).slice(0, 18).padEnd(18),
          (g.agents ? g.agents.join(',') : 'all').slice(0, 14).padEnd(14),
          when(g.expires_at).padEnd(17), String(g.uses ?? 0).padEnd(5),
          g.last_remote ?? '—',
        ].join(' '));
      }
      const live = all.filter(g => grantStatus(g) === 'live');
      console.log(`\n${live.length} live of ${all.length}. Revoke one: ` +
                  `node tools/m59-handoff.mjs revoke <id>`);
    }
  }
}
