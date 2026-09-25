# Protocol

> The Meridian 59 wire protocol. When you need to understand what packets the server sends, start here.

## The connection

- **Transport**: TCP to `<host>:5959` (set `M59_HOST`)
- **Protocol**: M59 binary protocol
- **Login**: `AP_*` frames (authentication, profile)
- **Game**: `BP_*` frames (game state, commands)

## Key BP_* packets (server → client)

| Packet | What it carries | When it arrives |
|--------|----------------|-----------------|
| `BP_PLAYER` | Room ID, object ID, **old position** | On room change, login |
| `BP_ROOM_CONTENTS` | All objects in the room, **new position** | On room change, periodically |
| `BP_MOVE` | Position update (col, row) | When an object moves |
| `BP_STAT` | Health, vigor, mana, etc. | When vitals change |
| `BP_USE` / `BP_UNUSE` | Equipment changes | When equipping/unequipping |
| `BP_SAY` | Chat messages | When someone speaks |
| `BP_ATTACK` | Attack results (damage, kills) | When an attack lands |
| `BP_CAST` | Spell results | When a spell is cast |
| `BP_KILL` | Death announcement | When a character dies |

## The critical insight: position is NOT pushed

**The server does NOT push our own position via `BP_MOVE`.**

This was measured (2026-08-20): three consecutive raw moves, each landing, but
zero `BP_MOVE` events for our own character. The client learns its own position
only by **asking** (`confirmPosition()` → `roomContents()`).

### Consequences

- `BP_PLAYER` updates the room ID but NOT the position (sends old position)
- `BP_ROOM_CONTENTS` includes our position (this is how we get the new position)
- `BP_MOVE` may arrive for our position, but it's not reliable
- The airlock waits for `BP_ROOM_CONTENTS` (not `BP_MOVE`) to confirm position

## Key BP_* packets (client → server)

| Packet | What it does |
|--------|-------------|
| `REQ_MOVE` | Move to a position (col, row) |
| `REQ_ATTACK` | Attack a target |
| `REQ_CAST` | Cast a spell |
| `REQ_USE` / `REQ_UNUSE` | Equip/unequip an item |
| `REQ_SAY` | Send a chat message |
| `REQ_PICKUP` | Pick up an item from the floor |
| `REQ_DROP` | Drop an item |
| `REQ_REST` | Rest (recover health/vigor) |

## The client state

`m59-client.mjs` maintains:

| Field | What | Set by |
|-------|------|--------|
| `self` | Our character object (col, row, hp, vigor, etc.) | `BP_STAT`, `BP_ROOM_CONTENTS` |
| `room.objects` | All objects in the current room | `BP_ROOM_CONTENTS` |
| `room.exits` | Exits from the current room | `BP_ROOM_CONTENTS` |
| `_lastContentsRoom` | Room ID from last `BP_ROOM_CONTENTS` that included us | `BP_ROOM_CONTENTS` |
| `_lastMoveRoom` | Room ID from last `BP_MOVE` that updated us | `BP_MOVE` |
| `_roomStamp` | Incremented on every `BP_PLAYER` | `BP_PLAYER` |
| `vitals` | Health, vigor, mana (pushed by server) | `BP_STAT` |

## The pacer

The client rate-limits actions to ~5/second to avoid overwhelming the server.
Queues: `read`, `use`, `move`, `cast`, `drop`.

## The event ring

- 500 entries for combat events
- 300 entries for chat (separate, so speech survives a busy fight)

## Links

- [[MOVEMENT]] — how position is used in movement
- [[ARCHITECTURE]] — the big picture
- [[TRAPS]] — protocol-related traps
