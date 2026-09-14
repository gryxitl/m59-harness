# Glossary

> The jargon used in this repo. When you see a term you don't know, start here.

## Movement

| Term | Definition |
|------|-----------|
| **Airlock** | On room change, ALL movement stops until the server confirms the new position via `BP_ROOM_CONTENTS`. Prevents stale position bugs. |
| **Room stamp** | Every path/position is stamped with the room it was created in (`_roomStamp`). If the room changes, stale paths are dropped. |
| **Force-adopt** | After airlock release, explicitly `syncFrom(_me)` to adopt the server's position. Necessary because `ctl.clear()` doesn't clear `ctl.x`. |
| **Bad arrival** | Server places the character in a position with no floor (inside a wall). Detected after airlock release; triggers `walkTo` recovery. |
| **Stuck** | Character hasn't moved in `STUCK_TICKS` (30 ticks = 3s). Triggers `escape_pocket`. |
| **Pocket** | A position with 0 open directions (surrounded by walls). Escaped via blink (not reconnect). |
| **Safe spot** | A wall corner, away from monsters. Used for resting. |
| **Safe wall** | A wall the character can rest against without being attacked. |
| **Staging square** | The square a character walks to before crossing a go-exit. |
| **Exit anchor** | The specific square that triggers a go-exit when the character stands on it. |
| **`setRun`** | Enables running (speed 36) vs. walking (speed 18). Called for travel/hunt/flee, not for combat/rest. |
| **`walkTo`** | Legacy mover's recovery mechanism. Walks to the nearest walkable square. |
| **`confirmPosition`** | The only way to know where the character is (server doesn't push position). Sends `roomContents()` and waits up to 8s. |

## Combat

| Term | Definition |
|------|-----------|
| **Hunt band** | The range of monster levels the character can safely fight. Armed: `floor(level/2)`. Unarmed: `floor(level/4)`. Ceiling = level + band. |
| **Flee threshold** | `fleeBelow` policy. When health drops below this, the character flees. |
| **Rest threshold** | `restBelow` policy. When health drops below this, the character rests. |
| **Death spiral** | Each death drops max HP by 1-2. Lower max HP → harder to survive → more deaths. |
| **Caster build** | A character with no weapon (uses spells instead of melee). May need to cast "create weapon" to get a melee weapon. |
| **Disengage** | Breaking off from combat (when health < flee threshold). |
| **Pile-on** | Multiple characters attacking the same target. Coordinated to avoid. |

## Map & Routes

| Term | Definition |
|------|-----------|
| **Go-exit** | An exit that teleports the character to another room when they stand on the exit anchor. |
| **Edge exit** | An exit at the edge of a room (walk forward into the spur). |
| **Code exit** | A region-based exit (e.g., Marion→534). Defined in `m59-codeexits.json` with a `when` condition and `trigger_targets`. |
| **`trigger_targets`** | The position to walk to for a code exit. Computed from the `when` condition. |
| **`.roo` file** | Room geometry file (collision data). Parsed by `m59-roo.mjs`. Needs `M59_ROOT`. |
| **Collision model** | The fine-grained grid that determines which squares are walkable. Baked into `substrate/`. |
| **A\* pathfinding** | The algorithm used to find the shortest path between two rooms. Used by `m59-routebake.mjs`. |
| **Baked routes** | Pre-computed routes between all pairs of rooms. Stored in `m59-routes.json`. |

## Fleet & Policy

| Term | Definition |
|------|-----------|
| **Fleet** | A named roster of characters, one per server. |
| **Roster** | `substrate/fleet-state.json`. The only record of the account passwords. Gitignored. |
| **Loadout** | `substrate/loadouts/<char>.json`. Per-character standing preferences (POLICY_KEYS). Source of truth for policy. |
| **POLICY_KEYS** | The keys stored in the loadout: `hunt`, `assignedRoom`, `fightRounds`, `restBelow`, `fleeBelow`, `bankAbove`, `buyFood`, `roam`, `partner`, `threatCeiling`. |
| **`autopilot set`** | The command that writes policy to BOTH the loadout and the roster. Prevents drift. |
| **Rejoin** | The broker's 45s cycle that re-logs dropped characters. Does NOT undo a `leave`. |
| **`leave`** | Logs out a character on purpose. Honored by the rejoin logic (not rejoined). |
| **BLIND** | A false alarm. The character always has a position (`you.col`/`you.row`). The state endpoint was checking the wrong field (`pos`). |

## Protocol

| Term | Definition |
|------|-----------|
| **`BP_PLAYER`** | Packet that carries the room ID and object ID (but NOT the position — sends old position). |
| **`BP_ROOM_CONTENTS`** | Packet that carries all objects in the room, including the character's new position. |
| **`BP_MOVE`** | Packet that carries a position update. May arrive for the character's position, but is not reliable. |
| **`BP_STAT`** | Packet that carries vitals (health, vigor, mana). Pushed by the server. |
| **`REQ_MOVE`** | Command to move to a position. |
| **`REQ_ATTACK`** | Command to attack a target. |
| **`REQ_CAST`** | Command to cast a spell. Fire-and-forget (returns `undefined`). |
| **Pacer** | Rate-limits actions to ~5/second to avoid overwhelming the server. |
| **Event ring** | 500 entries for combat, 300 for chat (separate, so speech survives a busy fight). |

## Architecture

| Term | Definition |
|------|-----------|
| **Tick keeper** | The real-time 10Hz loop (`m59-tick.mjs` + `m59-decide.mjs`). Our innovation. |
| **Legacy keeper** | The blocking `pass()` loop (`m59-autopilot.mjs`). Upstream default. Used by other fleets. |
| **ControllerMover** | The movement system (`m59-controller-mover.mjs`). Airlock, room stamp, force-adopt. |
| **CharacterController** | The fine-grained movement (`m59-controller.mjs`). Walk/run, square-by-square. |
| **Sensor** | Reads the client state (free, no network). Never sends. |
| **Actuator** | Enqueues a command (walk, attack, cast, equip). Does not await. |
| **Watchdog** | Independent 500ms timer. Reads health live. Can interrupt a blocked tick. |
| **`M59_ROOT`** | Path to the Meridian 59 source tree. Needed for `.roo` files. Must be set in the broker's startup environment. |
| **`M59_MAP`** | Path to `m59-map.json`. |
| **`M59_HOST`** | The server host. Default: `127.0.0.1`. |
| **`M59_FLEET`** | The fleet name. Default: `substrate/fleet-default`. |

## Links

- [[ARCHITECTURE]] — the big picture
- [[MOVEMENT]] — movement terms in context
- [[COMBAT]] — combat terms in context
- [[MAP-ROUTES]] — map/route terms in context
- [[PROTOCOL]] — protocol terms in context
