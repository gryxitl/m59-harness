# Files

> What each file does. Focused on the files you'll actually touch.

## The 5 files you'll touch most

| File | What it does | When you'll edit it |
|------|-------------|---------------------|
| `m59-decide.mjs` | The decision logic (pure, synchronous). Goals: hunt, flee, travel, rest, fight. Stuck detection. setRun. | Character is doing the wrong thing |
| `m59-controller-mover.mjs` | Movement. Airlock, room stamp, force-adopt, bad arrival detection. | Character is stuck, in a wall, or in the wrong room |
| `m59-client.mjs` | The protocol client. TCP socket, packet parsing, state, events. `_lastContentsRoom`, `_roomStamp`. | Character doesn't know where it is |
| `m59-broker.mjs` | Fleet management. Sessions, policy, rejoin, HTTP API. | Character is logged out, policy is wrong |
| `m59-map.mjs` | The map builder. Builds `m59-map.json` from admin socket + .roo + code exits. | Room is missing, exit is wrong |

## Core (Tick Keeper)

| File | What it does |
|------|-------------|
| `m59-tick.mjs` | The 10Hz tick loop: sense → decide → actuate |
| `m59-decide.mjs` | The decide half (pure, synchronous) |
| `m59-controller-mover.mjs` | The controller mover (airlock, room stamp, force-adopt) |
| `m59-controller.mjs` | The CharacterController (walk/run, fine-grained movement) |
| `m59-client.mjs` | The protocol client |
| `m59-keeper-process.mjs` | The tick keeper (starts the tick loop, manages the client) |
| `m59-game.mjs` | The game session (shared between legacy and tick) |
| `m59-world.mjs` | The world (room geometry, exits, objects, collision) |
| `m59-mover.mjs` | The legacy mover (step-by-step, fallback/recovery) |

## Legacy (other fleets)

| File | What it does |
|------|-------------|
| `m59-autopilot.mjs` | The legacy keeper (13,196 lines, blocking `pass()`) |
| `m59-keeper.mjs` | The legacy keeper wrapper |

## Map & Routes

| File | What it does |
|------|-------------|
| `m59-map.mjs` | The map builder (admin socket + .roo + code exits → m59-map.json) |
| `m59-routebake.mjs` | The route baker (map + .roo → m59-routes.json, A* pathfinding) |
| `m59-roo.mjs` | The .roo file parser (collision geometry) |
| `m59-safespots.mjs` | The safe spot finder (wall corners, away from monsters) |
| `m59-route.mjs` | Route lookup at runtime (m59-routes.json) |
| `m59-finepath.mjs` | Fine-grained pathfinding (within a room) |

## Broker & Service

| File | What it does |
|------|-------------|
| `m59-broker.mjs` | The broker (fleet management, sessions, policy, rejoin, HTTP API) |
| `m59-service.mjs` | The service (start/stop/restart the broker, sets M59_ROOT) |
| `m59-shutdown.mjs` | Safe shutdown (snapshot + stop broker + stop server) |
| `m59-which.mjs` | Fleet checker (what fleet, what roster, what broker holds) |
| `m59-check-positions.mjs` | Position checker (where are all the characters) |
| `m59-mcp-attach.mjs` | MCP attach (attach to the broker, never spawn a second) |

## Action Primitives (`m59-act/`)

| File | What it does |
|------|-------------|
| `attack.mjs` | Attack a target |
| `cast.mjs` | Cast a spell (fire-and-forget, returns undefined) |
| `equip.mjs` | Equip an item |
| `flee.mjs` | Flee from a threat |
| `rest.mjs` | Rest (recover health/vigor) |
| `step.mjs` | Step in a direction (walk/run) |
| `travel-to.mjs` | Travel to a room (multi-hop) |
| `escape-pocket.mjs` | Escape a pocket (blink, not reconnect) |
| `escape-underworld.mjs` | Escape the Underworld (portals) |
| `bank.mjs` | Bank gold |
| `buy.mjs` | Buy an item |
| `sell.mjs` | Sell an item |
| `eat.mjs` | Eat food |
| `drop.mjs` | Drop an item |
| `pickup.mjs` | Pick up an item |
| `scavenge.mjs` | Scavenge (loot) |
| `take-safe-spot.mjs` | Take a safe spot |

## Behavior Tree (`m59-bt-*.mjs`)

| File | What it does |
|------|-------------|
| `m59-bt.mjs` | The behavior tree main (Selector, Sequence, Condition, Action) |
| `m59-bt-combat.mjs` | Combat nodes |
| `m59-bt-nav.mjs` | Navigation nodes |
| `m59-bt-flee.mjs` | Flee nodes |
| `m59-bt-farm.mjs` | Farming nodes |
| `m59-bt-gear.mjs` | Gear/equipment nodes |
| `m59-bt-recover.mjs` | Recovery nodes |
| `m59-bt-retreat.mjs` | Retreat nodes |
| `m59-bt-shop.mjs` | Shop nodes |
| `m59-bt-town.mjs` | Town nodes |
| `m59-bt-walk.mjs` | Walk nodes |
| `m59-bt-nodes.mjs` | Shared BT nodes |
| `m59-bt-provision.mjs` | Provisioning nodes |

## Economy

| File | What it does |
|------|-------------|
| `m59-economy.mjs` | Economy tracking (purse, bank, spending) |
| `m59-merchants.mjs` | Merchant data |
| `m59-selling.mjs` | Selling logic |
| `m59-sellrun.mjs` | Selling runs |
| `m59-treasury.mjs` | Treasury management |
| `m59-tithe.mjs` | Tithe (guild tax) |
| `m59-guild.mjs` | Guild management |
| `m59-guildwants.mjs` | Guild wants (what the guild needs) |

## Progression

| File | What it does |
|------|-------------|
| `m59-progression.mjs` | Progression tracking (levels, skills) |
| `m59-skills.mjs` | Skill levels |
| `m59-abilities.mjs` | Ability levels |
| `m59-spells.mjs` | Spell data |
| `m59-reagents.mjs` | Reagent data |
| `m59-items.mjs` | Item data |
| `m59-loadout.mjs` | Per-character loadout management |

## Observation & Reporting

| File | What it does |
|------|-------------|
| `m59-observability-page.mjs` | Observability dashboard |
| `m59-stats-page.mjs` | Stats dashboard |
| `m59-deaths-page.mjs` | Deaths dashboard |
| `m59-postmortems.mjs` | Death postmortems |
| `m59-uptime.mjs` | Uptime tracking |
| `m59-pulse.mjs` | Pulse (health checks) |
| `m59-watchdog.mjs` | Watchdog (independent 500ms timer) |
| `m59-deathstream.mjs` | Death stream |
| `m59-death-tally.mjs` | Death tally |
| `m59-death-patterns.mjs` | Death patterns |
| `m59-lastwords.mjs` | Last words (final messages before death) |

## Fleet Management

| File | What it does |
|------|-------------|
| `m59-fleet.mjs` | Fleet management |
| `m59-fleets.mjs` | Multi-fleet management |
| `m59-fleetscope.mjs` | Fleet scope (what the fleet can see) |
| `m59-fleeline.mjs` | Fleet line (formation) |
| `m59-makefleet.mjs` | Make a fleet (create characters) |
| `m59-newchar.mjs` | Create a new character |
| `m59-rearm.mjs` | Rearm (refill equipment) |
| `m59-outfit.mjs` | Outfit (equip gear) |
| `m59-feed.mjs` | Feed (give food) |
| `m59-almoner.mjs` | Almoner (charity/donations) |

## Safety & Recovery

| File | What it does |
|------|-------------|
| `m59-safespots.mjs` | Safe spot finder |
| `m59-safewalk.mjs` | Safe walk (avoid monsters) |
| `m59-safewall.mjs` | Safe wall (find a wall to rest against) |
| `m59-sanctuary.mjs` | Sanctuary (inn/safe room) |
| `m59-shelter.mjs` | Shelter (emergency cover) |
| `m59-escape.mjs` | Escape (general) |
| `m59-escapable.mjs` | Is this room escapable? |
| `m59-selfheal.mjs` | Self-heal (rebind selfId) |
| `m59-stuckwatch.mjs` | Stuck watch (detect stuck characters) |
| `m59-reclaim.mjs` | Reclaim (recover lost items) |
| `m59-restore.mjs` | Restore (restore from backup) |
| `m59-backup.mjs` | Backup (save state) |

## AI & Planning

| File | What it does |
|------|-------------|
| `m59-ai-director.mjs` | AI director (high-level planning) |
| `m59-goap.mjs` | GOAP (Goal-Oriented Action Planning) |
| `m59-goap-planner.mjs` | GOAP planner |
| `m59-plan.mjs` | Plan (multi-step tasks) |
| `m59-playbook.mjs` | Playbook (pre-defined strategies) |
| `m59-strategies.mjs` | Strategies (travel, combat) |
| `m59-commitment.mjs` | Commitment (stick to a plan) |
| `m59-errandstate.mjs` | Errand state (multi-hop tasks) |

## Communication

| File | What it does |
|------|-------------|
| `m59-chat.mjs` | Chat (send/receive messages) |
| `m59-respond.mjs` | Respond (auto-respond to chat) |
| `m59-autorespond.mjs` | Auto-respond (rules-based) |
| `m59-inbox.mjs` | Inbox (received messages) |
| `m59-tell.mjs` | Tell (private message) |
| `m59-signal.mjs` | Signal (F9 window marking) |
| `m59-intel.mjs` | Intel (intelligence sharing) |
| `m59-lore.mjs` | Lore (world knowledge) |

## Setup & Service

| File | What it does |
|------|-------------|
| `setup.mjs` | Setup (clone + build + run server, start broker, make fleet) |
| `m59-service.mjs` | Service (start/stop/restart the broker) |
| `m59-shutdown.mjs` | Shutdown (safe server shutdown) |
| `m59-which.mjs` | Which fleet? |
| `m59-check-positions.mjs` | Check positions |

## Tests

190 test files (`m59-*-test.mjs`). Run them with:
```bash
node tools/m59-safespot-test.mjs   # 91 assertions
node tools/m59-chat-test.mjs       # 102 assertions
node tools/m59-rest-test.mjs       # 6 assertions
node tools/m59-ledger-test.mjs     # 15 assertions
node tools/m59-escape-test.mjs     # 29 assertions
```

## Links

- [[ARCHITECTURE]] — the big picture
- [[MOVEMENT]] — movement files in context
- [[COMBAT]] — combat files in context
- [[MAP-ROUTES]] — map/route files in context
- [[FLEET-OPS]] — fleet ops files in context
