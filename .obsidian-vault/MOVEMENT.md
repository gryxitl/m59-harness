# Movement

> How characters move. When a character is stuck, in a wall, or in the wrong room, start here.

## The movement stack

```
m59-decide.mjs          → decides WHERE to go (goal: travel, hunt, flee)
  └─ m59-controller-mover.mjs  → plans the path, handles room transitions
       └─ m59-controller.mjs    → walks/runs square-by-square (CharacterController)
            └─ m59-client.mjs   → sends REQ_MOVE packets to the server
```

## Speeds

| Mode | Speed | When |
|------|-------|------|
| Walk | 18 units/s | Combat, precision, resting |
| Run | 36 units/s | Travel, hunt, flee |

`setRun(true)` is called in `m59-decide.mjs` for all goals **except** `_fight`,
`healthy`, `vigor_low`, `idle_rest`.

## The airlock (room transitions)

When a character crosses a go-exit, the server teleports them to a new room.
The airlock prevents the character from moving with stale position data.

### The sequence

```
1. Character walks to the staging square (exit anchor)
2. Server teleports to the new room
3. Server sends BP_PLAYER (new room ID, OLD position)
4. ★ AIRLOCK ENGAGES: all movement stops
5. Server sends BP_ROOM_CONTENTS (new position)
6. Client sets _lastContentsRoom = new room
7. ★ AIRLOCK RELEASES: ControllerMover force-adopts new position (syncFrom)
8. Movement resumes in the new room
```

### Why it's needed

`BP_PLAYER` updates the room ID but NOT the position. `BP_MOVE` (position)
arrives later. Without the airlock, the ControllerMover would adopt the stale
position (old room coords) in the new room, causing paths to be calculated
from wrong coordinates.

### Key fields

| Field | Where | Set when |
|-------|-------|----------|
| `_lastContentsRoom` | `m59-client.mjs` | `BP_ROOM_CONTENTS` includes our character |
| `_lastMoveRoom` | `m59-client.mjs` | `BP_MOVE` updates our position |
| `_roomStamp` | `m59-client.mjs` | Increments on every `BP_PLAYER` |

The airlock checks `_lastContentsRoom === this._room` (not `_lastMoveRoom`).

## Room stamp guard

Every path and position is stamped with the room it was created in
(`_roomStamp`). If the room changes, stale paths/positions are dropped/refused
at send time. This prevents a path calculated in room A from being executed
in room B.

## Force-adopt

After the airlock releases, the ControllerMover explicitly calls `syncFrom(_me)`
to adopt the server's position. This is necessary because `ctl.clear()` does
NOT clear `ctl.x` (the position), so the adoption block (`if ctl.x == null`)
would be skipped.

## Bad arrival detection

The server does NOT validate user positions against room geometry
(`util.kod` skips `ReqSomethingMoved` for `&User`). A character can be placed
inside a wall.

After the airlock releases, the ControllerMover checks if the position has a
floor. If not, it delegates to the legacy mover with a destination (nearest
walkable square) to trigger `walkTo` recovery.

## Stuck detection

| Mechanism | Where | Threshold | Action |
|-----------|-------|-----------|--------|
| `STUCK_TICKS` | `m59-controller.mjs` | 30 ticks (3s) no progress | Report "stuck" to keeper |
| `escape_pocket` | `m59-decide.mjs` | Stuck + 0 open dirs | Cast blink (if mana allows) |
| `walkTo` recovery | `m59-mover.mjs` | Legacy fallback | Walk to nearest walkable square |

### Escape pocket

When a character is stuck in a pocket (0 open directions):
1. `stand()` (to avoid `PFLAG_NO_MAGIC` while resting)
2. Cast blink (relocates body to a reachable position)
3. If blink doesn't relocate, reset the cooldown and try again later

**Blink does NOT work in all rooms.** Some rooms (e.g., certain pockets) don't
have blink access. In those cases, the character is truly stuck and needs a
re-roll (manual only).

## The legacy mover (fallback)

`m59-mover.mjs` is the legacy step-by-step mover. It's used as a fallback when:
- The ControllerMover detects a bad arrival (no floor)
- The character needs `walkTo` recovery
- The legacy keeper is running (other fleets)

## Debugging movement

```bash
# Where are all the characters?
node tools/m59-check-positions.mjs

# Check the broker's view of the fleet
curl -s http://127.0.0.1:8901/fleet | python3 -m json.tool

# Check the broker log for airlock messages
grep -i "airlock\|BAD ARRIVAL\|blink" substrate/broker-prod.log | tail -20
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Character in a wall | Bad arrival (server placed them there) | Airlock release → bad arrival check |
| Character in wrong room | Airlock didn't engage | `_lastContentsRoom` not set |
| Character not moving | Stuck (0 open dirs) | Stuck detection → escape_pocket |
| Character walking slowly | `setRun` not called | `m59-decide.mjs` setRun logic |
| Character oscillating | Path calculated from stale position | Room stamp guard |

## Links

- [[ARCHITECTURE]] — the big picture
- [[TRAPS]] — movement-related traps
- [[PROTOCOL]] — BP_PLAYER, BP_MOVE, BP_ROOM_CONTENTS
