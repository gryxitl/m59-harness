// THE ESCAPE FOR A CHARACTER STUCK IN A GEOMETRY POCKET.
//
// A character can be perfectly mobile and still unable to LEAVE: the region
// it can walk in contains no exit, or it is on a dead-end ledge, or it is
// inside a wall. The server placed it there (room transition, rejoin, edge
// exit arrival) and it cannot walk out.
//
// BLINK IS THE CURE. It asks the server to relocate the body to a reachable
// position in the room. For a character on a dead-end ledge or inside a wall,
// blink moves them to the main walkable area.
//
// A RECONNECT DOES NOT HELP. The server places a reconnecting character at
// their saved position without checking geometry, so a body on a dead-end
// ledge comes back on the same ledge. The reconnect is not a cure, it is a
// repetition — and it triggers the broker's rejoin loop, which respawns the
// keeper and rejoins the character at the same spot, over and over.
//
// The cast follows the same pattern as the decider's "unstuck" blink:
// freeze the tick loop (so move packets don't break concentration), cast,
// wait for the "moved" event, notify the mover of the new position.
export async function escapePocket(client, session) {
  console.error(`[escape_pocket] CALLED at ${Date.now()}`);
  const c = client;
  if (!c) return { sent: false, reason: 'no client' };

  // Find the blink spell.
  let blink = (c.spells ?? []).find(sp => {
    const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
    return n.toLowerCase() === 'blink';
  });
  // A fresh login may not have the spell list yet.
  if (!blink && !(c.spells ?? []).length) {
    try { await c.requestSpells?.(); await new Promise(r => setTimeout(r, 1200)); }
    catch { /* best effort */ }
    blink = (c.spells ?? []).find(sp => {
      const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
      return n.toLowerCase() === 'blink';
    });
  }
  if (!blink) return { sent: false, reason: 'blink not found in spell list' };

  // Check mana. Blink costs 15 (viMana = 15 in blink.kod).
  const mana = c.vitals?.()?.mana;
  const manaVal = mana?.value ?? 0;
  if (manaVal < 15) {
    return { sent: false, reason: `no mana for blink (${manaVal}/15); staying put` };
  }

  // A SITTING CHARACTER'S CAST IS REFUSED WHOLE: while resting the server
  // sets PFLAG_NO_MAGIC (player.kod:1166) and UserCast answers with an error.
  // Stand up before blinking. Use the pacer (same path as the tick driver) and
  // wait for the stand packet to land AND be processed by the server before casting.
  // The server processes UC_STAND -> StopResting() -> ResetPlayerFlagList() in
  // one tick; we need at least one full server tick (~150ms) after the packet
  // arrives for the flag reset to propagate. Wait 2s to be safe.
  try {
    if (session?.pacer) {
      await session.pacer.submit('stand', () => c.stand?.()).catch(() => {});
    } else {
      await c.stand?.();
    }
  } catch { /* best effort */ }
  await new Promise(r => setTimeout(r, 2000));  // let the stand packet land AND be processed

  // Freeze the tick loop so move packets don't break concentration.
  const loop = session?._tickLoop;
  let thaw = () => {};
  const BLINK_MS = 17000;  // viCast_time = 10000 ticks; server tick is ~150ms in practice → ~15s; wait 17s
  if (loop) {
    loop._frozen = true;
    console.error(`[escape_pocket] FROZEN at ${Date.now()}`);
    thaw = () => {
      loop._frozen = false;
      console.error(`[escape_pocket] THAWED at ${Date.now()}`);
    };
  }

  // Cast blink. Fire and forget — cast() returns undefined.
  const since = c.evSeq;
  try { c.cast(blink.id, []); } catch (e) { thaw(); return { sent: false, reason: `cast failed: ${e?.message ?? e}` }; }

  // Wait for the "moved" event (server confirms relocation) or timeout.
  // viCast_time = 10000 ticks × 100ms = 10s of casting. Wait 3s for the cast
  // to start resolving, then up to BLINK_MS - 3000 for the moved event.
  await new Promise(r => setTimeout(r, 3000));
  try {
    const w = await c.waitFor?.({ since, kinds: ['moved'], timeoutMs: BLINK_MS - 3000 });
    const mv = (w?.events ?? []).filter(e => e.kind === 'moved');
    const last = mv[mv.length - 1];
    if (last && Number.isFinite(last.col)) {
      try { session?._mover?.relocated?.(last.col, last.row); } catch { /* best effort */ }
      thaw();
      return { sent: true, what: `blink relocated to (${last.col},${last.row})` };
    }
    thaw();
    return { sent: false, reason: 'blink cast but no moved event (room may be no-blink)' };
  } catch {
    thaw();
    return { sent: false, reason: 'blink wait failed' };
  }
}
escapePocket.pre     = [];
escapePocket.effects = ['can_leave'];
escapePocket.atomic  = 'escape_pocket';
// Cheaper than a reconnect: blink costs 5 mana, not the connection.
escapePocket.cost    = 10;
