# Key Constants

> The magic numbers. When you need to know a threshold, a timeout, or a speed, start here.

## Movement

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| `USER_WALKING_SPEED` | 18 units/s | `user.kod:46` | Walking speed |
| `USER_RUNNING_SPEED` | 36 units/s | `user.kod` | Running speed |
| `MOVEUNITS` | 256 client units (0.25 squares) per 100ms | `m59-controller.mjs` | Movement granularity |
| `MOVE_INTERVAL_MS` | 1000ms (1Hz) | `m59-controller.mjs` | Position report rate (server throttle) |
| `STUCK_TICKS` | 30 ticks (3s) | `m59-controller.mjs` | No progress before "stuck" |
| `CONFIRM_DEADLINE_MS` | 8000ms (8s) | `m59-client.mjs` | `confirmPosition()` timeout |

## Watchdog

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| `WATCH_MS` | 8000ms (8s) | `m59-watchdog.mjs` | Blind threshold (keeper's own `resyncMs` default) |
| `TRUST_MS` | 30000ms (30s) | `m59-postmortems.mjs` | Whether a reading still places a death |
| Watchdog interval | 500ms | `m59-watchdog.mjs` | How often the watchdog checks health |

## Combat

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| `fleeBelow` (default) | 30% health | Policy | Flee threshold |
| `restBelow` (default) | 60% health | Policy | Rest threshold |
| `bankAbove` (default) | 500 gold | Policy | Bank threshold |
| Melee range | 2-3 squares | `m59-combat.mjs` | Combat range disc |

## Hunt Bands

| Level | Armed band | Unarmed band | Ceiling |
|-------|-----------|-------------|---------|
| 20 | 10 | 5 | 30 |
| 21 | 10 | 5 | 31 |
| 25 | 12 | 6 | 37 |

**Safe targets:**
- lv20-24: Baby spiders (lv25) in Deep Woods
- lv25+: Giant rats (lv30) in Sewers

## Escape

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| Escape cooldown | 120s | `m59-decide.mjs` | Minimum time between escape attempts |
| Blink mana cost | Varies by room | `blink.kod` | Mana required to blink |

## Broker

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| Rejoin interval | 45s | `m59-broker.mjs` | How often the broker re-logs dropped characters |
| Rejoin backoff | 90s → 15min cap | `m59-broker.mjs` | If a character drops again within 90s of being rejoined, the wait doubles |
| Pacer rate | ~5 actions/s | `m59-client.mjs` | Rate-limit to avoid overwhelming the server |
| Event ring (combat) | 500 entries | `m59-client.mjs` | Combat event history |
| Event ring (chat) | 300 entries | `m59-client.mjs` | Chat event history (separate, so speech survives a busy fight) |

## Map & Routes

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| Rooms in map | 264 | `m59-map.json` | Total rooms |
| Directed exits | 982 | `m59-map.json` | Total exits |
| Baked routes | 16,494 | `m59-routes.json` | Total routes |
| `.roo` files | 256 | `M59_ROOT/resource/rooms/` | Total room geometry files |
| Admin socket resolution | 26/256 | `m59-map.mjs` | Only 26 `.roo` filenames resolved by the admin socket (fallback to existing map) |

## Tick Loop

| Constant | Value | Where | What it controls |
|----------|-------|-------|-----------------|
| Tick interval | 100ms (10Hz) | `m59-tick.mjs` | How often the tick loop runs |
| `decideMs` (legacy) | ~1000ms (1Hz) | `m59-autopilot.mjs` | Legacy keeper pass interval |

## Links

- [[MOVEMENT]] — movement constants in context
- [[COMBAT]] — combat constants in context
- [[FLEET-OPS]] — broker constants in context
- [[MAP-ROUTES]] — map/route constants in context
