# Policy management — the four places and the unification

## The four places policy is kept

1. **Loadout file** (`substrate/loadouts/<character>.json`)
   - Human-edited source of truth for gear/plan/policy overlay.
   - Applied as an OVERLAY at keeper startup: for each key in `POLICY_KEYS`,
     if the loadout has it, it **wins** over the roster policy
     (m59-keeper-process.mjs:97-108).
   - Reapplied on every load by design. "Roster edits were silently reverted on
     restart, three times in a row, while the loadout file sat unread."

2. **Fleet-state roster** (`substrate/fleet-state.json` → `entry.autopilot.policy`)
   - The broker's persisted copy. The hub.
   - Written by `autopilot set` (saveFleetState).
   - Read at keeper startup (→ place 4) and at broker Autopilot creation (→ place 3).

3. **Broker's Autopilot object** (`pilots` Map in m59-autopilot.mjs → `p.policy`)
   - In-memory, broker-side. One `Autopilot` per agent, held by the broker.
   - **Seeded from the roster** (place 2) at creation: `Object.assign(p.policy,
     autopilot.policy || {})` (m59-broker.mjs:1530).
   - **Mutated independently** by `autopilot set`: `p.policy.hunt = a.hunt` etc.
     (m59-broker.mjs:6813+).
   - This is the copy the broker's own logic reads (status, fleet rows, etc.).

4. **Keeper-process in-memory** (the object `makeDecider` holds in
   m59-keeper-process.mjs)
   - The LIVE copy the decider actually reads every tick.
   - **Derived at startup** from place 2 (roster) overlaid by place 1 (loadout).
   - **Mutated live** by `POST /policy` on the keeper's port (pushPolicyToKeeper).
   - NOT re-read from the roster after startup.

## The flows

**WRITE (`autopilot set`):**
- place 3 (broker Autopilot `.policy`) ← mutated directly
- place 2 (roster file) ← saveFleetState
- place 4 (keeper-process `/policy`) ← pushPolicyToKeeper (POST)
- place 1 (loadout) ← **NOT written**

**READ (keeper startup):**
- place 4 ← place 2 (roster) overlaid by place 1 (loadout)

**READ (broker Autopilot creation):**
- place 3 ← place 2 (roster) [Object.assign]

## The fragmentation

- place 1 (loadout) **wins on restart**, but `autopilot set` doesn't write it →
  a change via the tool is **lost on restart** if the loadout has that field.
- place 3 (broker Autopilot) is **seeded from** place 2 but **mutated
  independently** → it can drift from the roster file.
- place 4 (keeper-process) is the **live** one, pushed by the tool, but
  **re-derived** from place 1+2 on restart → the push is undone by a restart
  if the loadout disagrees.
- place 2 (roster) is the **persisted hub**, but place 1 **overrides** it on
  restart → the hub is not actually the source of truth.

The four places can disagree, and which one wins depends on *when* you look
(live vs. after restart), *which field* (loadout-present vs. loadout-absent),
and *who is reading* (broker logic reads place 3; the decider reads place 4).

## The 2026-08-27 incident (how this was discovered)

`autopilot set` wrote place 2 (roster) but NOT place 4 (in-memory). The tool
answered with the new policy, `status` echoed it (reading place 3, which WAS
updated), the roster showed it (place 2), but the decider kept reading place 4
(the values it was born with). Four characters re-assigned to room 534,
confirmed in roster + status, still hunting 575 an hour later.

The fix (`pushPolicyToKeeper`): `autopilot set` now ALSO POSTs to the
keeper's `/policy` (place 4). But place 1 (loadout) is still a separate
overlay that wins on restart, and place 3 (broker Autopilot) is still seeded
from place 2 but mutated independently.

## Unification options

### Option A: Loadout is the single source of truth
- `autopilot set` writes the LOADOUT file (not the roster), then pushes to
  place 4 (keeper-process) for the live effect, and updates place 3 (broker
  Autopilot) in memory.
- The roster's `autopilot.policy` (place 2) becomes a startup cache/derivative.
- Pro: one file to edit, one place to look. Matches the documented role.
- Con: the tool rewrites a human-edited JSON file (mitigate with
  read-modify-write).

### Option B: Roster is the single source of truth
- The loadout overlay (place 1) is removed or made additive-only (can ADD
  fields the roster lacks, cannot OVERRIDE).
- `autopilot set` writes the roster (place 2) + pushes to place 4 + updates
  place 3 (as now).
- Pro: the roster is already the persisted hub; the tool already writes it.
- Con: contradicts the documented design ("the loadout is reapplied on every
  load by design").

### Option C: Keep four places, make precedence explicit + logged
- Document: loadout > roster > (broker Autopilot, keeper-process) at startup;
  broker Autopilot and keeper-process are live-mutated by the tool.
- Log every overlay application (already done).
- Pro: no code change, just clarity.
- Con: doesn't actually unify; the four places can still disagree.

### Recommendation

**Option A** is the cleanest unification: the loadout is the single source of
truth for per-character orders (already its documented role), and `autopilot
set` becomes "write the loadout + update the two in-memory copies (place 3 and
place 4) for the live effect." The roster (place 2) becomes a startup cache.
This matches the operator's mental model and eliminates the "lost on restart"
surprise.

The one wrinkle: `autopilot set` rewriting a human-edited JSON file. Mitigate
by read-modify-write (preserve untouched fields) and treating the loadout as
canonical (if a human edit races the tool, the human's file wins on next
restart, which is the safe direction).
