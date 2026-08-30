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
  // A RECONNECT DOES NOT ESCAPE A POCKET. The server places a reconnecting
  // character at their saved position without checking geometry for users,
  // so a body on a dead-end ledge comes back on the same ledge. The reconnect
  // is not a cure, it is a repetition — and it triggers the broker's rejoin
  // loop, which respawns the keeper and rejoins the character at the same
  // spot, over and over.
  //
  // The real fix is to move the character to a reachable position (blink, or
  // walk to the nearest floor that has a path to an exit). Until that is
  // implemented, do nothing: staying stuck is better than a reconnect loop.
  return { sent: false, reason: 'reconnect does not escape a pocket; staying put' };
}
escapePocket.pre     = [];
escapePocket.effects = ['can_leave'];
escapePocket.atomic  = 'escape_pocket';
// Much dearer than a blink: this one costs the connection.
escapePocket.cost    = 20;
