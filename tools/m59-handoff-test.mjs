#!/usr/bin/env node
// THE CONTRACT TEST FOR HANDING THE FLEET TO ANOTHER MACHINE.
//
//   node tools/m59-handoff-test.mjs
//
// Offline, against scratch directories. It never touches substrate/grants/, which is this
// machine's real authority.
//
// This is auth code, so the assertions worth having are the ones that fail OPEN if
// somebody inverts them — every one of these, wrong, hands a stranger twenty-one
// characters whose passwords cannot be reset:
//
//   - the secret is never on disk, so a leaked grant file is an audit record and not a key
//   - expiry is evaluated on USE, not trusted from mint
//   - revocation takes effect on the next request, off disk
//   - `read` cannot issue orders
//   - an agent allowlist actually excludes, which is the whole reason this exists rather
//     than a shared secret in an env var
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintGrant, verifyGrant, revokeGrant, revokeAll, listGrants, loadGrant,
  parseToken, parseDuration, grantStatus, SCOPES, MAX_LIFETIME_MS, toolAllowed, RESTRICTED_VERBS,
} from './m59-handoff.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };
const dir = mkdtempSync(join(tmpdir(), 'm59-handoff-'));
const mint = (o = {}) => mintGrant({ to: 'deck', dir, ...o });

// ---------------------------------------------------------------------------
console.log('the secret never reaches the disk');
{
  const { grant, token } = mint();
  const onDisk = readFileSync(join(dir, `${grant.id}.json`), 'utf8');
  const secret = parseToken(token).secret;
  ok('the token is not in the grant file', !onDisk.includes(secret));
  ok('nor is the whole token', !onDisk.includes(token));
  ok('a hash is', /token_hash/.test(onDisk));
  ok('the returned grant object carries no secret either',
     !JSON.stringify(grant).includes(secret));
  // The file is the audit record. It SHOULD name who and what.
  ok('but it does say who it was for', onDisk.includes('deck'));
  ok('and the token still verifies', verifyGrant(token, { dir }).ok);
}

{
  // Two grants must not collide, and one token must not open another.
  const a = mint({ to: 'alpha' }), b = mint({ to: 'bravo' });
  ok('ids differ', a.grant.id !== b.grant.id);
  ok('tokens differ', a.token !== b.token);
  ok("alpha's token does not open bravo",
     verifyGrant(a.token, { dir }).id !== b.grant.id);
  // Same secret, other id — the id is public, so this is the obvious forgery.
  const forged = `m59g_${b.grant.id}_${parseToken(a.token).secret}`;
  ok('a secret pasted onto another id is refused', !verifyGrant(forged, { dir }).ok);
}

// ---------------------------------------------------------------------------
console.log('a malformed or unknown token is refused, and says nothing useful');
{
  for (const bad of ['', 'x', 'Bearer hello', 'm59g_', 'm59g_abc', 'm59g_abc_short',
                     null, undefined, 'm59g_../../etc_passwd_aaaaaaaaaaaaaaaa']) {
    ok(`refused: ${JSON.stringify(bad)}`, !verifyGrant(bad, { dir }).ok);
  }
  // A path-shaped id must not reach the filesystem.
  ok('a traversal id cannot load a file', loadGrant('../../secret', dir) === null);
  ok('a non-hex id cannot load a file', loadGrant('AbC_-xyz', dir) === null);
}

// ---------------------------------------------------------------------------
console.log('expiry is decided on use, not at mint');
{
  const t0 = 1_000_000;
  const { token } = mint({ lifetimeMs: 60_000, now: t0 });
  ok('valid inside the window', verifyGrant(token, { dir, now: t0 + 59_000 }).ok);
  ok('refused on the boundary', !verifyGrant(token, { dir, now: t0 + 60_000 }).ok);
  ok('refused after', !verifyGrant(token, { dir, now: t0 + 60_001 }).ok);
  ok('and the reason is expiry', verifyGrant(token, { dir, now: t0 + 99_999 }).why === 'expired');
  // The file said nothing about being expired when it was written; the clock decides.
  ok('a long-dead grant is still refused', !verifyGrant(token, { dir, now: t0 + 1e12 }).ok);
}

{
  let threw = false;
  try { mint({ lifetimeMs: MAX_LIFETIME_MS + 1 }); } catch { threw = true; }
  ok('a grant may not outlive the ceiling', threw);
  ok('the ceiling itself is allowed', mint({ lifetimeMs: MAX_LIFETIME_MS }).grant.id.length > 0);
}

// ---------------------------------------------------------------------------
console.log('revocation is immediate and off disk');
{
  const { grant, token } = mint();
  ok('live first', verifyGrant(token, { dir }).ok);
  ok('revoke reports success', revokeGrant(grant.id, { dir }) === true);
  ok('the very next request is refused', !verifyGrant(token, { dir }).ok);
  ok('and says revoked', verifyGrant(token, { dir }).why === 'revoked');
  // MARKED, NOT DELETED — the audit trail outlives the authority.
  ok('the record survives revocation', loadGrant(grant.id, dir) !== null);
  ok('and is marked', typeof loadGrant(grant.id, dir).revoked_at === 'number');
  ok('grantStatus agrees', grantStatus(loadGrant(grant.id, dir)) === 'revoked');
  ok('revoking a stranger is not an error', revokeGrant('nope', { dir }) === false);
}

{
  const before = listGrants(dir).filter(g => grantStatus(g) === 'live').length;
  const n = revokeAll({ dir });
  ok('revoke --all revokes every live grant', n === before);
  ok('and leaves none live', listGrants(dir).every(g => grantStatus(g) !== 'live'));
}

// ---------------------------------------------------------------------------
console.log('scope: read cannot order');
{
  const r = mint({ scope: 'read' }).token;
  const o = mint({ scope: 'orders' }).token;
  ok('a read grant reads', verifyGrant(r, { dir, need: 'read' }).ok);
  ok('a read grant may NOT order', !verifyGrant(r, { dir, need: 'orders' }).ok);
  ok('and says why', verifyGrant(r, { dir, need: 'orders' }).why === 'grant is read-only');
  ok('an orders grant orders', verifyGrant(o, { dir, need: 'orders' }).ok);
  ok('an orders grant also reads', verifyGrant(o, { dir, need: 'read' }).ok);
  let threw = false;
  try { mint({ scope: 'admin' }); } catch { threw = true; }
  ok('an unknown scope is refused at mint', threw);
  ok('and an unknown scope is refused at use',
     !verifyGrant(o, { dir, need: 'everything' }).ok);
}

// ---------------------------------------------------------------------------
console.log('scope: an agent allowlist excludes');
{
  const { token } = mint({ agents: ['t1', 't2'] });
  ok('a named agent is allowed', verifyGrant(token, { dir, agent: 't1' }).ok);
  ok('the other named agent too', verifyGrant(token, { dir, agent: 't2' }).ok);
  ok('AN UNNAMED AGENT IS REFUSED', !verifyGrant(token, { dir, agent: 't3' }).ok);
  ok('even though the grant is otherwise perfectly valid',
     verifyGrant(token, { dir, agent: 't3' }).why === 'agent not in this grant');
  ok('a request naming no agent still passes the allowlist',
     verifyGrant(token, { dir, agent: null }).ok);

  const whole = mint({ agents: null }).token;
  ok('a null allowlist is the whole fleet', verifyGrant(whole, { dir, agent: 't19' }).ok);

  // The distinction that matters: EMPTY is not the same as ALL, and reading it as all is
  // the direction that hands over everything.
  let threw = false;
  try { mint({ agents: [] }); } catch { threw = true; }
  ok('an empty allowlist is refused rather than read as "everything"', threw);
}

{
  const { token } = mint({ fleet: 'prod' });
  ok('the right fleet passes', verifyGrant(token, { dir, fleet: 'prod' }).ok);
  ok('another fleet is refused', !verifyGrant(token, { dir, fleet: 'arena' }).ok);
  const any = mint({ fleet: null }).token;
  ok('a grant with no fleet named works against any', verifyGrant(any, { dir, fleet: 'prod' }).ok);
}

// ---------------------------------------------------------------------------
console.log('every use is audited');
{
  const { grant, token } = mint();
  verifyGrant(token, { dir, remote: '203.0.113.9' });
  verifyGrant(token, { dir, remote: '203.0.113.9' });
  const g = loadGrant(grant.id, dir);
  ok('uses are counted', g.uses === 2);
  ok('the last use is stamped', typeof g.last_used_at === 'number');
  ok('the remote address is recorded', g.last_remote === '203.0.113.9');

  // A REFUSED request must not be recorded as a use — otherwise the count means
  // "attempts" and cannot answer "did they actually drive anything".
  // The refusal has to be a refusal OF THIS GRANT. The first version used an agent name
  // against a grant whose allowlist was null — which means "the whole fleet", so it was
  // allowed, counted, and the assertion was testing nothing.
  const scoped = mint({ agents: ['t1'] });
  verifyGrant(scoped.token, { dir, remote: '198.51.100.4' });
  const before = loadGrant(scoped.grant.id, dir).uses;
  verifyGrant(scoped.token, { dir, agent: 'nobody', remote: '198.51.100.4' });
  verifyGrant(scoped.token, { dir, need: 'orders', agent: 'nobody', remote: '198.51.100.4' });
  ok('a refusal is not counted as a use', loadGrant(scoped.grant.id, dir).uses === before);

  // And a caller can check without leaving a mark, for a dry run.
  const q = mint().token;
  const gid = parseToken(q).id;
  verifyGrant(q, { dir, record: false });
  ok('record:false leaves no trace', (loadGrant(gid, dir).uses ?? 0) === 0);
}

// ---------------------------------------------------------------------------
console.log('a broken store never grants access');
{
  writeFileSync(join(dir, 'junk.json'), '{ not json');
  ok('an unparseable grant file does not throw the listing', Array.isArray(listGrants(dir)));
  ok('and does not grant anything', !verifyGrant('m59g_junk_aaaaaaaaaaaaaaaaaaaa', { dir }).ok);
  ok('a grant file with no hash is refused',
     (() => { writeFileSync(join(dir, 'empty1.json'), JSON.stringify({ id: 'empty1', salt: 's' }));
              return !verifyGrant('m59g_empty1_aaaaaaaaaaaaaaaaaaaa', { dir }).ok; })());
}

// ---------------------------------------------------------------------------
console.log('durations');
{
  ok('45m', parseDuration('45m') === 45 * 60_000);
  ok('4h', parseDuration('4h') === 4 * 3_600_000);
  ok('7d', parseDuration('7d') === 7 * 86_400_000);
  ok('bare seconds', parseDuration('90') === 90_000);
  ok('default when absent', parseDuration(undefined) > 0);
  for (const bad of ['', 'soon', '-1h', '0h', '4 years'])
    ok(`rejected: ${JSON.stringify(bad)}`, parseDuration(bad) === null || bad === '');
}

// ---------------------------------------------------------------------------
console.log('a grant is FULL CONTROL by default; --safe is opt-in');
{
  // THE DEFAULT IS THE OPERATOR'S CALL AND THIS PINS IT. Half-lending a character
  // produces a bot that stalls on the verb you withheld, and you find out from a silence
  // rather than an error — so an unrestricted grant may do everything, including what
  // cannot be undone.
  for (const t of ['leave', 'forget', 'reroll', 'pilot', 'describe'])
    ok(`${t} is allowed by default`, toolAllowed(t).ok);
  ok('guild disband is allowed by default', toolAllowed('guild', { action: 'disband' }).ok);
  ok('a default grant records itself as unrestricted', mint().grant.restricted === false);

  // What a grant is NOT, even at full control, is the reason it beats the password:
  // it is revocable, it expires, it is scoped, and the holder never learns the credential.
  const { grant, token } = mint({ agents: ['t1'] });
  ok('still scoped at full control', !verifyGrant(token, { dir, agent: 't9' }).ok);
  revokeGrant(grant.id, { dir });
  ok('still revocable at full control', !verifyGrant(token, { dir }).ok);
}

console.log('--safe withholds the irreversible verbs');
{
  const R = { restricted: true };
  ok('leave is withheld', !toolAllowed('leave', {}, R).ok);
  ok('forget is withheld', !toolAllowed('forget', {}, R).ok);
  ok('reroll is withheld', !toolAllowed('reroll', {}, R).ok);
  ok('pilot is withheld', !toolAllowed('pilot', {}, R).ok);
  ok('describe is withheld', !toolAllowed('describe', {}, R).ok);
  ok('and it says so', /withheld/.test(toolAllowed('leave', {}, R).why));

  // Ordinary driving is untouched — a deny list, not an allowlist.
  for (const t of ['travel', 'fight', 'rest_up', 'shop', 'sell', 'autopilot', 'look',
                   'inventory', 'equip_best', 'bank', 'say', 'supply'])
    ok(`${t} still works under --safe`, toolAllowed(t, { action: 'x' }, R).ok);

  ok('guild disband withheld', !toolAllowed('guild', { action: 'disband' }, R).ok);
  ok('guild abandon_hall withheld', !toolAllowed('guild', { action: 'abandon_hall' }, R).ok);
  ok('guild set_password withheld', !toolAllowed('guild', { action: 'set_password' }, R).ok);
  ok('guild status allowed', toolAllowed('guild', { action: 'status' }, R).ok);
  ok('guild invite allowed', toolAllowed('guild', { action: 'invite' }, R).ok);

  // THE OMISSION CASE — a tool whose dangerous verbs are chosen by an argument must not
  // become available by leaving the argument out.
  for (const a of [{}, { action: '' }, { action: null }, undefined])
    ok(`guild with ${JSON.stringify(a)} is refused`, !toolAllowed('guild', a, R).ok);

  ok('the grant carries the flag', mint({ restricted: true }).grant.restricted === true);
  ok('every entry is null or a list',
     Object.values(RESTRICTED_VERBS).every(v => v === null || Array.isArray(v)));

  // A floor on verbs is not a substitute for scope.
  const r = mint({ scope: 'read', restricted: true }).token;
  ok('--safe does not replace scope', !verifyGrant(r, { dir, need: 'orders' }).ok);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
