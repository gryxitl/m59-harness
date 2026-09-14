# Traps

> The traps that can break the system. When something breaks and you don't know why, start here.

## The big ones (from AGENTS.md)

### `create automated` makes a character with ZERO in every attribute
They are fixed at creation and never move. Stamina *is* the max-health ceiling
(`101 + stamina`), so it's capped at 102 max health for ever. Unrepairable; only
re-rollable. Use `m59-makefleet.mjs` rather than creating characters by hand.

### The server never says no
A malformed or over-budget character request is silently replaced with
`3/1/4/1/5/9`. Never report a character as created without checking
`stats_as_asked` in the `reroll` result.

### Attach to the broker, never spawn a second
`m59-broker.mjs` with no arguments serves stdio MCP *and* resumes a fleet; a
second one is refused the lock, comes up healthy and **empty**, and answers
about a fleet of nobody while the real one plays on. Use `m59-mcp-attach.mjs`.

### Never call `leave` on a fleet anyone cares about
It drops the roster, and the roster is the only record of the passwords.

### `substrate/fleet-accounts.json` is the only copy of the account passwords
Gitignored. Never commit it, never print it into a shared transcript, never delete it.

### `[Channel] Flush` defaults to `No`
With it off, every server log stays at 0 bytes for ever — which looks exactly
like a hook not firing. The container turns it on; a native build may not.

### Hunt bands are scaled by level
`floor(level/2)` when armed, `floor(level/4)` when unarmed. Ceiling = level + band.
A lv21 character has ceiling 31, so lv30 giant rats are "in band" — but they're
still too tough, and each death drops max HP by 1–2, starting a death spiral.

## Fixed traps (this session)

### Airlock: stale position after room change
**Symptom**: Characters end up in "bizarre spaces" (inside walls, outside grids,
or at staging squares of other rooms) after crossing go-exits.

**Cause**: `BP_PLAYER` updates room ID but not position. `BP_MOVE` (position)
arrives later. The ControllerMover was adopting the stale position (old room
coords) in the new room before `BP_MOVE` arrived.

**Fix**: Airlock in `m59-controller-mover.mjs`. On room change, ALL movement
stops. The airlock holds until `_lastContentsRoom === this._room` (confirmed by
`BP_ROOM_CONTENTS`, NOT `BP_MOVE`).

**Status**: FIXED

### Force-adopt after airlock release
**Symptom**: After the airlock releases, the character still uses the old room's
position for pathfinding.

**Cause**: `ctl.clear()` does not clear `ctl.x` (position). The adoption block
(`if ctl.x == null`) was skipped after room changes.

**Fix**: Explicit `syncFrom(_me)` after airlock release to force-adopt the
server's position.

**Status**: FIXED

### Bad arrival (character placed in a wall)
**Symptom**: Character is in-game but at a position with no floor.

**Cause**: Server does not validate user positions against room geometry
(`util.kod` skips `ReqSomethingMoved` for `&User`).

**Fix**: Check after airlock release: if position has no floor, delegate to
legacy mover with destination (nearest walkable square) to trigger `walkTo`
recovery.

**Status**: FIXED

### `setRun` never called
**Symptom**: Character walks (speed 18) instead of runs (speed 36) during travel.

**Cause**: `setRun(true)` was defined in `ControllerMover` but never called.

**Fix**: Call `setRun(true)` in `m59-decide.mjs` for all goals except `_fight`,
`healthy`, `vigor_low`, `idle_rest`.

**Status**: FIXED

### `M59_ROOT` not set in broker env
**Symptom**: `.roo` files not found → map build fails → only 26/256 resolved.

**Cause**: `M59_ROOT` was not set in the broker's startup environment.

**Fix**: Added `M59_ROOT` to the broker's startup environment in
`m59-service.mjs`.

**Status**: FIXED

### Code exits missing `trigger_targets`
**Symptom**: Character doesn't know where to walk for region-based exits
(e.g., Marion→534).

**Cause**: Code exits have a `when` condition but no `trigger_targets`.

**Fix**: `codeExits` in `m59-map.mjs` computes `trigger_targets` from the
`when` condition.

**Status**: FIXED

### Policy fragmentation
**Symptom**: Policy kept in 4 places (loadout, roster, broker Autopilot,
keeper-process) that drifted.

**Cause**: No single source of truth for policy.

**Fix**: `autopilot set` writes the loadout (for `POLICY_KEYS`) in addition to
the roster. Loadout is source of truth for standing preferences.

**Status**: FIXED

### `c.cast()` returns undefined
**Symptom**: Tick loop silent — "Cannot read properties of undefined (reading 'then')".

**Cause**: `c.cast()` is fire-and-forget (returns `undefined`), but the code
was chaining `.then()` on it.

**Fix**: Removed the `.then()` chain. Use `waitFor` + `setTimeout` backstop.

**Status**: FIXED

### `escape_pocket` reconnect loop
**Symptom**: Character in a pocket triggers reconnect, which places them in the
same pocket, which triggers reconnect again.

**Cause**: Reconnect does not escape a pocket (server places character at same
saved position).

**Fix**: Changed `escape_pocket` to cast blink (if mana allows) instead of
reconnect. Added 120s cooldown. Reset cooldown if blink didn't relocate.

**Status**: FIXED

## Open / known issues

### Pathfinding: fine model allows paths into geometry
**Symptom**: Character walks into a wall. The fine collision model says a square
is walkable, but the server rejects it ("could not step back onto solid ground").

**Cause**: The fine model and the server's BSP check disagree on some squares.

**Status**: OPEN — needs investigation of `m59-world.mjs` geometry loading and
`traceFineMoveClient`.

### `passFightBack` port
**Symptom**: Upstream has a `passFightBack` ladder stage (operator fight-back
edict) that we don't have.

**Cause**: It requires a subsystem (`fightBackAfterMs` policy, `fightBackDue`
state, `refuseEngagement` helper). Not a drop-in.

**Status**: OPEN — needs scoping as a separate feature port.

## Links

- [[MOVEMENT]] — movement-related traps in context
- [[COMBAT]] — combat-related traps in context
- [[MAP-ROUTES]] — map-related traps in context
- [[FLEET-OPS]] — fleet-related traps in context
