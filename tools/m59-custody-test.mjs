#!/usr/bin/env node
// THE CONTRACT TEST FOR SHARING ONE FLEET BETWEEN TWO MACHINES.
//
//   node tools/m59-custody-test.mjs
//
// Offline and clock-driven. `decide()` is the whole of the safety argument — it is the
// function that says whether this machine may connect to the game — so it is deliberately
// pure, and every case below is a way two machines end up both holding the fleet.
//
// Double-holding is not a crash. Meridian allows one connection per character and has no
// idea who owns an account, so two holders bump each other silently and for ever, each
// one's rejoin sweep reading the other's takeover as a dropped session. Measured on this
// setup before the lease existed: 21 claimed sessions against 13 live sockets, and no
// error anywhere. Every assertion here fails in that direction if inverted.
import {
  decide, LEASE_MS, RENEW_MS, GRACE_MS, makeLease,
} from './m59-custody.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

const ME = 'home#1', OTHER = 'deck#2';
const T = 1_000_000;
const lease = (holder, expiresAt, extra = {}) => ({
  format: 'm59-custody/1', fleet: 'prod', holder, machine: holder.split('#')[0],
  claimed_at: expiresAt - LEASE_MS, renewed_at: expiresAt - LEASE_MS,
  expires_at: expiresAt, released: false, ...extra,
});

// ---------------------------------------------------------------------------
console.log('nobody holds it');
{
  ok('no lease at all means claim', decide(null, ME, T).action === 'claim');
  ok('and says why', /no lease/.test(decide(null, ME, T).why));
}

// ---------------------------------------------------------------------------
console.log('somebody else holds it — the standby must not connect');
{
  const live = lease(OTHER, T + 60_000);
  const d = decide(live, ME, T);
  ok('a live lease held by another machine means STAND BY', d.action === 'standby');
  ok('and names the holder', d.why.includes(OTHER));
  // The moment before expiry is still theirs. Off-by-one here is a double-hold.
  ok('one millisecond before expiry is still theirs',
     decide(lease(OTHER, T + 1), ME, T).action === 'standby');
}

// ---------------------------------------------------------------------------
console.log('an expired lease is taken over — but not instantly');
{
  const dead = lease(OTHER, T - 1);
  // GRACE. A holder whose renewal was merely slow should win the race rather than being
  // displaced mid-fight, so expiry alone is not enough.
  ok('just expired: wait out the grace', decide(dead, ME, T).action === 'standby');
  ok('and says it is waiting', /grace/.test(decide(dead, ME, T).why));
  ok('inside the grace, still standing by',
     decide(lease(OTHER, T), ME, T + GRACE_MS - 1).action === 'standby');
  ok('past the grace, claim',
     decide(lease(OTHER, T), ME, T + GRACE_MS + 1).action === 'claim');
  ok('and says how long ago it lapsed',
     /expired \d+s ago/.test(decide(lease(OTHER, T), ME, T + GRACE_MS + 1000).why));
}

{
  // A DELIBERATE HANDOVER SKIPS THE WAIT. This is the "I am shutting down, you take it"
  // path, and it is the difference between seamless and five minutes of an idle fleet.
  const released = lease(OTHER, T + 60_000, { released: true });
  const d = decide(released, ME, T);
  ok('a released lease is claimable immediately, even though it has not expired',
     d.action === 'claim');
  ok('and says it was released', /released/.test(d.why));
}

// ---------------------------------------------------------------------------
console.log('our own lease: hold, then renew');
{
  const fresh = lease(ME, T + LEASE_MS);
  ok('freshly ours: just hold', decide(fresh, ME, T).action === 'hold');
  // Renew at a third of the lease, so two consecutive failures are survivable.
  const due = lease(ME, T + (LEASE_MS - RENEW_MS));
  ok('due for renewal', decide(due, ME, T).action === 'renew');
  ok('well before renewal, hold', decide(lease(ME, T + LEASE_MS), ME, T).action === 'hold');
}

{
  // OURS BUT LAPSED IS NOT STILL OURS. Somebody may have taken it in the gap, so it has
  // to go back through the compare-and-swap rather than being assumed.
  const lapsed = lease(ME, T - 1);
  const d = decide(lapsed, ME, T);
  ok('our own expired lease is re-claimed, not assumed', d.action === 'claim');
  ok('and says so', /lapsed/.test(d.why));
}

// ---------------------------------------------------------------------------
console.log('an unreachable store: the holder fences itself');
{
  // THE UNCOMFORTABLE BRANCH, AND THE ONE THAT MAKES THIS SAFE. Our lease expires in real
  // time whether or not we can see the store, and the other machine will act on that. A
  // holder that keeps playing through a partition IS the double-holder.
  const ours = lease(ME, T + LEASE_MS);
  const d = decide(ours, ME, T, { storeReadable: false });
  ok('a holder that cannot reach the store FENCES', d.action === 'fence');
  ok('and explains that the lease expires regardless', /expires whether or not/.test(d.why));

  // The standby fails the other way: never claim on evidence you could not read.
  ok('a standby that cannot reach the store stands by',
     decide(lease(OTHER, T - LEASE_MS), ME, T, { storeReadable: false }).action === 'standby');
  ok('even with no lease at all',
     decide(null, ME, T, { storeReadable: false }).action === 'standby');
  ok('and never claims blind',
     /never claim blind/.test(decide(null, ME, T, { storeReadable: false }).why));
}

// ---------------------------------------------------------------------------
console.log('--standby-only never takes the fleet');
{
  const o = { standbyOnly: true };
  ok('will not claim a free fleet', decide(null, ME, T, o).action === 'standby');
  ok('will not claim an expired one',
     decide(lease(OTHER, T - LEASE_MS), ME, T, o).action === 'standby');
  ok('will not claim a released one',
     decide(lease(OTHER, T + 1000, { released: true }), ME, T, o).action === 'standby');
  ok('and says why', /standby-only/.test(decide(null, ME, T, o).why));
  // But it still keeps a lease it already holds, or a spectator that once held the fleet
  // would drop it the moment somebody passed --standby-only.
  ok('still holds one it already has', decide(lease(ME, T + LEASE_MS), ME, T, o).action === 'hold');
  ok('and still renews it', decide(lease(ME, T + (LEASE_MS - RENEW_MS)), ME, T, o).action === 'renew');
}

// ---------------------------------------------------------------------------
console.log('two machines can never both be told to hold');
{
  // THE PROPERTY IS ABOUT `hold`/`renew`, NOT ABOUT `claim`, and the first version of this
  // test got that wrong. Two machines BOTH claiming an expired lease is correct and
  // expected: `claim` is not "connect now", it is "attempt to take, arbitrated by the
  // store" — and the git push is the compare-and-swap that lets exactly one of them win.
  // The loser's push is rejected, it stops its broker, and it stands by. Asserting that
  // two machines never both reach `claim` would have been asserting that the race cannot
  // happen, when the whole design is that the race is SAFE.
  //
  // What must never happen is two machines both believing they ALREADY hold it, because
  // that is the state in which both are connected and bumping each other.
  const CONNECTED = new Set(['hold', 'renew']);
  const l = lease(OTHER, T + LEASE_MS);
  let both = 0, sawClaimRace = 0;
  for (let t = T - LEASE_MS; t < T + 2 * LEASE_MS; t += 5_000) {
    const a = decide(l, OTHER, t);            // the holder's view
    const b = decide(l, ME, t);               // the other machine's view
    if (CONNECTED.has(a.action) && CONNECTED.has(b.action)) both++;
    if (a.action === 'claim' && b.action === 'claim') sawClaimRace++;
  }
  ok('across the whole lease lifetime, never both CONNECTED', both === 0);
  // And the race does occur, so the assertion above is not vacuous.
  ok('a claim race does happen once the lease is long dead', sawClaimRace > 0);
}

{
  // And the same for a released lease: the releaser must not still be holding.
  const CONNECTS = new Set(['hold', 'renew', 'claim']);
  const rel = lease(OTHER, T + LEASE_MS, { released: true });
  const a = decide(rel, OTHER, T), b = decide(rel, ME, T);
  ok('after a release the releaser does not hold', !CONNECTS.has(a.action) || a.action === 'claim');
  ok('and the other machine claims', b.action === 'claim');
}

// ---------------------------------------------------------------------------
console.log('the lease shape');
{
  const l = makeLease('prod', ME, T);
  ok('carries the fleet', l.fleet === 'prod');
  ok('carries the holder', l.holder === ME);
  ok('expires a lease-length out', l.expires_at === T + LEASE_MS);
  ok('is not born released', l.released === false);
  ok('renew is well inside the lease', RENEW_MS < LEASE_MS);
  ok('two failures are survivable before expiry', RENEW_MS * 2 < LEASE_MS);
  ok('the grace is shorter than the lease', GRACE_MS < LEASE_MS);
}

console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
