// THE ESCAPE THAT WORKS WHEN BLINK CANNOT.
//
// A character can be perfectly mobile and still unable to LEAVE: the region it can walk in
// contains no exit. Blink does not fix that — it asks the room to relocate the body to "a
// central location" (blink.kod:21), and in a pocket that location is inside the pocket.
// JayB proved it in room 50: repeated casts, mana spent, never moved off (2,48).
//
// A reconnect does fix it. `session.rejoin()` drops the connection and comes back, which
// the server treats as a fresh entry — the same mechanism `breakOut()` uses to escape a
// crowd, which is gated on a monster count and so could never fire for a geometry pocket.
//
// Deliberately expensive: it costs the session, the entry grace period and several seconds
// of play, so the planner reaches for it only when nothing cheaper achieves `can_leave`.
export async function escapePocket(client, session) {
  if (typeof session?.rejoin !== 'function') {
    return { sent: false, reason: 'this session cannot rejoin' };
  }
  try {
    await session.rejoin();
    return { sent: true, what: 'reconnected to escape a room with no reachable exit' };
  } catch (e) {
    return { sent: false, reason: `rejoin failed: ${e?.message ?? e}` };
  }
}
escapePocket.pre     = [];
escapePocket.effects = ['can_leave'];
escapePocket.atomic  = 'escape_pocket';
// Much dearer than a blink: this one costs the connection.
escapePocket.cost    = 20;
