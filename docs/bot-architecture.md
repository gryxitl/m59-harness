# Bot Architecture — Meridian 59 Autonomous Fleet

## What we are working with

A Meridian 59 server speaks a binary framing protocol on one TCP port (5959).
Every player — human or bot — holds an ordinary session on that port. The server
makes no distinction. An admin socket exists on port 9998 but has no password
and must not be used remotely; everything a bot does goes through the game port.

---

## Layer 0 — TCP + framing (`m59-client.mjs`)

```
Frame: [len u16le] [crc16 u16le] [len u16le] [seqno u8] [payload]
       HEADER = 7 bytes

Payload: [opcode u8] [body...]
```

The epoch byte (seqno) must be echoed from the most recent inbound frame or the
server silently drops all outbound messages.

CRC is `crc32(payload) & 0xffff`.

Framing is the same for login-phase (AP_*) and game-phase (BP_*) packets.
Opcodes overlap numerically between the two phases — dispatch on connection
state, never on the byte alone.

---

## Layer 1 — Login handshake

```
server → AP_GETLOGIN
client → AP_LOGIN  [major=7, minor=37, sysinfo(36 bytes), MD5(password)]
server → AP_LOGINOK
client → AP_REQ_GAME  [seed_a, seed_b, hostname]
server → AP_GETCHOICE [5 × u32 security seeds]  ← must capture these
server → AP_GAME                                 ← now in game mode
```

Password is MD5 digest with every `0x00` byte replaced by `0x01` before
sending (the server's own C string handling would truncate at null).

The security seeds from AP_GETCHOICE are required. If missed, every subsequent
game-mode message is rejected silently.

---

## Layer 2 — Game mode: outbound commands

All of these call `client.send(opcode, ...payloadParts)`.

### Movement

```js
client.moveTo(x, y, speed, roomId)
// x = col * 64 + 32, y = row * 64 + 32  (fine units, 64 per square)
// speed: 18 = walk, 36 = run (run costs vigor quadratically)
// roomId must match the room the server says we're in or it's rejected silently
// Y goes first on the wire: REQ_MOVE sends [y u16] [x u16] [speed u8] [room u32]
```

```js
client.turn(angle)       // REQ_TURN: angle 0..4095, 0=N, clockwise
client.go()              // REQ_GO: activate the exit/door under our feet (exact square)
```

The server does NOT validate player movement against room geometry.
`UserMove` in `user.kod` calls `Room.SomethingMoved` directly, bypassing
`ReqSomethingMoved` (which checks walls for monsters and items only). Walking
through visual walls is legal. Teleporting is logged as cheating if the distance
exceeds ~200 squares in under 3 seconds.

The server does NOT confirm our own moves back to us. It notifies other players
only (`room.kod:2325`). We must re-read position if we need to verify it.

### Combat

```js
client.attack(targetId, info=1)  // REQ_ATTACK: one swing. Rate-limited to 1/sec silently.
```

Attack checks (in order, first failure is the only message):
1. Not self (refused with message)
2. Attack timer — 1/sec (SILENT)
3. Same room (SILENT)
4. Not holding a Token (SILENT)
5. Can pay skill costs
6. Range — squared distance (refused with message naming the target)
7. Facing — target must not be behind you (refused with message about "view")
8. Monster willing / PK rules

An empty-handed character attacks with punch (SKID_PUNCH). Never truly helpless.
Resting sets PFLAG_NO_FIGHT — must stand up before swinging.

### Equipment

```js
client.use(id)     // REQ_USE: equip/wield/interact
client.unuse(id)   // REQ_UNUSE: unequip
```

Wielding something already wielded is refused ("your hands are too full").
What is actually equipped is in `client.using` (a Set of ids), filled by
`BP_USE_LIST` from the server. Never infer equipment state from what was sent —
read `client.equipment()` which asks the server's own list.

### Items

```js
client.get(id)                    // REQ_GET: pick up (range = Manhattan ≤7 squares)
client.drop(ids)                  // REQ_DROP: drop from pack (list of ids)
client.loot = () => ...           // get everything on the floor (handled in m59-skills.mjs)
client.put(what, container)       // REQ_PUT: put item in container
```

Loot lands on the floor beside the monster. There is no corpse to open.
`CreateTreasure` drops `1 + level/55 + random(0, difficulty/3)` items, capped at 6.

### Shopping / trading

```js
client.buy(id)                    // REQ_BUY: buy one item from a merchant
client.buyItems(sellerId, ids)    // REQ_BUY_ITEMS: buy multiple items
client.offer(toId, items)         // REQ_OFFER: start trade / sell to merchant
client.counterOffer(items)        // REQ_COUNTEROFFER: accept gift or name price
client.acceptOffer()              // ACCEPT_OFFER: complete trade
client.cancelOffer()              // CANCEL_OFFER
```

Selling is the trade protocol — you offer items, merchant counteroffers with
money, you accept. There is no sell command. Refusals arrive as the merchant
speaking, not as an error packet. BP_REQ_GIVE is in the opcode space but has no
dispatch table entry — all transfers go through offer/counteroffer/accept.

### Banking / vault

```js
client.depositItems(vaultmanId, items)  // REQ_DEPOSIT: one-shot, no counteroffer
client.userCommand(UC.WITHDRAW, ...)    // withdraw from bank
client.userCommand(UC.BALANCE)          // ask banker for balance (they say it aloud)
```

Bank balance is prose sent once by the banker NPC — it is never a stat packet.
Must be caught from the event stream and stored.

### Spells

```js
client.cast(spellId, targets)  // REQ_CAST: cast by id, targets as id list
```

A successful cast is often silent — `create weapon` puts a sword in your pack
and says nothing. Compare inventory before and after.

### Speech

```js
client.say(text, type=1)   // SAY_TO: 1=room, 2=yell, 3=broadcast, 6=emote, 10=guild
client.sayGroup(ids, text) // SAY_GROUP: tell/send to player object ids (not names)
client.tell(id, text)      // sayGroup with one id
```

All speech refusals arrive as prose, never errors. Echo back to self confirms it
went out.

### Perception requests (no-argument polls)

```js
client.roomContents()       // SEND_ROOM_CONTENTS: full object list with ids and flags
client.requestInventory()   // REQ_INVENTORY: pack contents (also triggers BP_USE_LIST)
client.requestSpells()      // SEND_SPELLS
client.requestSkills()      // SEND_SKILLS
client.stats(group)         // SEND_STATS: 1=vitals, 2=attributes, 3=spells, 4=skills
client.players()            // SEND_PLAYERS: who is online
```

### Other

```js
client.look(id)             // REQ_LOOK: examine an object (description)
client.activate(id)         // REQ_ACTIVATE: toggle a portal brazier etc.
client.action(n)            // BP_ACTION: raw action byte
client.apply(what, onWhat)  // REQ_APPLY: use one item on another
client.contents(id)         // SEND_OBJECT_CONTENTS: contents of a container
client.userCommand(uc, ...) // BP_USERCOMMAND: rest, stand, safety, banking, guild
```

BP_USERCOMMAND UC sub-opcodes:
- UC.REST (5), UC.STAND (6), UC.SAFETY (7)
- UC.DEPOSIT (35), UC.WITHDRAW (36), UC.BALANCE (37)
- UC.INVITE (12), UC.EXILE (13), UC.SET_RANK (17), UC.DISBAND (20), ...

---

## Layer 2 — Game mode: inbound events

The server pushes state changes. Nothing arrives unrequested except updates
to objects already known. `M59Client` parses every packet and emits named events
into a 500-entry ring (`client.events`).

### Key inbound packets and the events they produce

| packet | event emitted | what it contains |
|---|---|---|
| BP_PLAYER (130) | `room-entered` | our object id, room id, position, vitals |
| BP_STAT (131) | `stat` | one stat update: name, value, max |
| BP_STAT_GROUP (132) | `stat` (many) | bulk stats for one group |
| BP_ROOM_CONTENTS (134) | `room-contents` | all objects in the room with ids, flags, positions |
| BP_CREATE (217) | `create` | new object appeared (monster spawned, item dropped) |
| BP_REMOVE (218) | `remove` | object gone |
| BP_MOVE (200) | `move` | object changed position |
| BP_TURN (201) | `turn` | object rotated |
| BP_SAID (206) | `said` + chat ring | speech: who, what, channel |
| BP_USE_LIST (205) | `equipment` | complete list of what the server says we're wearing |
| BP_USE (203) | `equipment` | one item equipped |
| BP_UNUSE (204) | `equipment` | one item unequipped |
| BP_INVENTORY (208) | `inventory` | pack contents |
| BP_INVENTORY_ADD (209) | `inventory-add` | one item added to pack |
| BP_INVENTORY_REMOVE (210) | `inventory-remove` | one item removed from pack |
| BP_SPELLS (141) | `spells` | spell list |
| BP_SKILLS (144) | `skills` | skill list |
| BP_STAT groups 3/4 | `ability` | skill or spell level changed (PUSHED on every change) |
| BP_BUY_LIST (216) | `buy-list` | merchant's for-sale list after shop request |
| BP_OFFER (211) | `offer` | trade offered to us |
| BP_OFFER_CANCELED (212) | `offer-canceled` | trade done (also on success) |
| BP_OFFERED (213) | `offered` | confirmation we offered successfully |
| BP_COUNTEROFFER (214) | `counteroffer` | merchant/player named their price |
| BP_COUNTEROFFERED (215) | `counteroffered` | they received our counter |
| BP_PLAYER_ADD (137) | `player-add` | someone logged in |
| BP_PLAYER_REMOVE (138) | `player-remove` | someone left |
| BP_PLAYERS (136) | `players` | full who-list |
| BP_LIGHT_AMBIENT (220) | `light` | ambient light level changed (day/night) |
| BP_ADD_BG_OVERLAY (152) | `sky` | sun or moon position pushed every game hour |
| BP_CHANGE_RESOURCE (30) | (internal) | dynamic resource string (NPC names, etc.) |
| BP_SYS_MESSAGE (31) | `message` | system text (announcements) |
| BP_MESSAGE (32) | `message` | server message |
| BP_WITHDRAWAL_LIST (231) | `withdrawal-list` | vault contents |

### Listening

```js
// Long poll — resolves when any matching event arrives, or at timeout
const { events, seq, timedOut } = await client.waitFor({
  since: lastSeq,     // only events after this sequence number
  kinds: ['stat', 'said'],  // filter by kind (null = all)
  timeoutMs: 30000,
});
```

Speech has its own separate 300-entry ring (`client.chat`) and sequence,
independent of the main event ring. Use `client.chatSince(seq)` to read it.
The main ring can be evicted by combat; chat cannot.

---

## Layer 3 — Rate limits (all silent)

| limit | value | drops |
|---|---|---|
| Packets per second | 5 | attack, cast, use, unuse, get, activate, look, rest, stand, go |
| Attack/cast interval | 1 per second | the swing itself |
| Movement | ~1/sec above threshold | logs as speedhacker, no message |
| Session inactivity | 30 seconds | server hangs up silently |

The broker paces outbound calls to 4/sec. The keepalive sends `REQ_INVENTORY`
every 20 seconds (deliberately not BP_PING — a ping changes the server's XOR
stream, which this client does not implement).

The practical rule: **act, then confirm by reading what changed.** Never batch
calls and assume all succeeded.

---

## Layer 4 — World model maintained by M59Client

```js
client.room.id           // current room id
client.room.objects      // Map<id, object>: everything in the room
client.inventory         // array: pack contents
client.using             // Set<id>: what the server says we're wearing
client.spells            // array: spells we know
client.skills            // array: skills we know
client.abilities         // Map<id, {name, ability, kind, at}>: proficiency levels
client.statsById         // Map: 'health', 'mana', 'vigor', '1.1', '2.3', etc.
client.playersOnline     // Map<id, {name, flags}>: who is logged in
client.sky               // Map<id, {angle, height}>: sun and moon
client.me                // {id, name}: our character
client.selfId            // our object id in the room
```

Key methods:
```js
client.vitals()          // {health, mana, vigor} with pct and max
client.equipment()       // what is equipped (from server's plUsing)
client.abilityOf(name)   // proficiency 0-100 for a named skill or spell
client.find(needle)      // objects in room matching a name substring
client.describeRoom()    // structured room state for an agent
client.self              // our own room object
```

Object flags (`OF.*`):
- `OF_PLAYER`: is a player character
- `OF_ATTACKABLE`: can be attacked
- `OF_GETTABLE`: can be picked up
- `OF_BUYABLE`: can be bought
- `OF_NOEXAMINE`: look_at refused
- `OF_ENEMY`, `OF_FRIEND`, `OF_GUILDMATE`: relationship flags

---

## Layer 5 — Composite operations (`m59-skills.mjs`)

These wrap raw client calls into game-correct sequences:

```js
fight(session, opts)
// - findCreature() — scans room, filters OF_PLAYER, respects karma/threat ceiling
// - claimQuarry() — coordinates with fleet, avoids pile-ons
// - equipBest() / wearBest() — equip weapon + armour from pack
// - approach to within 2-3 squares (disc, not adjacent)
// - swing loop: rounds × swings, watch health, break at disengageAt
// - loot on kill: picks up drops from floor
// - preferId: lock onto one creature id across rounds

travel(session, roomId)
// - A* path via room graph (m59-map.mjs)
// - Three exit mechanisms per hop: walk off edge, REQ_GO on exact square, region trigger
// - Bracketed with "setting off" / "arrived" frames for post-mortem
// - Cancellation token: watchdog can interrupt mid-hop

eat()          // consume food from pack
rest()         // sit, wait for vigor to recover
healUp()       // rest until health full
bank()         // travel to bank, deposit excess money
buy()          // buy specific item from merchant
sell()         // sell items to merchant (via offer/counteroffer/accept)
cast()         // cast spell with affordability pre-check
```

---

## Layer 6 — The broker (`m59-broker.mjs`)

One Node.js process, N sessions (one M59Client per character).

```
HTTP :8901  ← JSON-RPC MCP tools (83 tools)
HTTP :8902  ← fleet dashboard (browser)
```

Per-session:
- **Pacer**: queues outbound calls at 4/sec across five priority lanes
  (read, use, move, cast, drop)
- **Session**: wraps M59Client, mediates access, records health drops, transit times
- **Autopilot** (Keeper): runs `pass()` every ~1s
- **Watchdog**: independent 500ms timer, watches pushed vitals, cancels movement
  if health crosses flee line while pass is blocked >3s

Fleet state persists to `substrate/fleet-state.json`. Credentials (account +
password) live only there and in `substrate/fleet-accounts.json`.

---

## Layer 7 — The keeper decision ladder

`pass()` in `m59-autopilot.mjs` is the autonomous loop. Every ~1s:

```
1. Post position + interests to coordination board
2. Resync every 8s: roomContents() + stats() to correct drift
3. observe(): is current safe spot still working?
4. recordFrame(): health/doing/room snapshot

Decision ladder (first match wins):
  panicking (too many deaths)  → logoff
  in Underworld                → escape via portals
  health < fleeBelow           → run to safe spot or next room
  health < restBelow           → find safe wall, rest to full
  armed == false               → stop() [BUG: no path to buy weapon]
  errand active                → execute multi-hop task
  farm mode                    → fight loop
  town needed                  → travel + bank/buy/sell
  idle                         → roam or wait
```

Policy fields (settable via MCP `autopilot` tool or `substrate/loadouts/<char>.json`):
- `hunt`: creature name to farm
- `assignedRoom`: room id to hunt in
- `purpose`: 'advance' | 'equip' (drives yield-check logic)
- `goals`: what stat to advance
- `restBelow`, `fleeBelow`: health thresholds (0-100 pct)
- `fightRounds`: swings per engagement
- `bankAbove`: purse threshold to trigger town trip
- `buyFood`, `buy_reagents`: whether to restock
- `roam`: whether to roam when prey isn't present
- `karma`: 'good' | 'evil' | 'neutral' (filters prey by karma alignment)
- `threatCeiling`: max creature level relative to our health

---

## Room exits — three mechanisms

Every hop in a travel may use a different exit type. They are NOT interchangeable:

1. **Walk off edge** (`plEdge_Exits`): move past row 1/piRows or col 1/piCols
   — conditional on which boundary column/row you crossed

2. **Stand on exact square + `REQ_GO`** (`plExits`): doors, stairs, portals
   — exact square match, one square off = nothing happens

3. **Region trigger** (`SomethingMoved` override in room class): walk into a
   coordinate range and the room teleports you — NOT in `plExits`, NOT in
   `plEdge_Exits`, only in the `.kod` source. Eleven rooms use these, including
   Marion (the only exits out of it), the Graveyard of Tos, and deep forest rooms.

The `travel` tool picks the correct mechanism per hop. `m59-codeexits.mjs`
extracts region exits from the kod source.

Exits are also NOT 1:1 — arriving from room A into room B does not put you
where the exit back to A starts. The return trip can be a full room away.

---

## Key game rules that shape bot behavior

**Advancement:**
- Monster level must STRICTLY exceed character's max health (= level)
- 3 pts: took damage AND landed killing blow
- 2 pts: only one of those
- 1 pt: within 5 levels, landed blow, took damage
- 0 pts: too easy (and sometimes a "spits in contempt" message)
- Stops paying the instant our max health equals or exceeds monster level

**Health regeneration:**
- `HealthTimer` only awards health if `PFLAG_MOVED_SINCE_ENTRY` is set
- Resting restores vigor; vigor sets the regeneration rate
- Walking one square after room entry, then resting = regenerates

**Death:**
- Drops everything carried (unless arena/safe room/cheap death)
- Chance to lose a point of max health permanently
- Wakes in Underworld — no ordinary exits, must walk onto a portal

**Karma:**
- Qor school: requires karma ≤ level × -10
- Shal'ille school: requires karma ≥ level × +10
- A kill is scored as the negative of the victim's karma
- Acts weaker than your current karma level do nothing (floor effect)

**Merchants:**
- Skills and spells sold from same list as items (`plFor_sale` slot 3)
- Price: `250 * 2^level` for skills/spells, no markup
- Refusals are spoken prose, never error packets
- Two merchants have finite inventory: Izzio (wanderer) and Ko'catan shopkeeper

**Soldiers (faction troops):**
- Not spawned by rooms — summoned by flagpoles on a timer
- Level 70-145, attack rating 390-855 (NOT level 50 as the kod declares)
- Above threat ceiling for any character at max health ≤50
- Do not farm them for armor

**Banking:**
- Balance is prose spoken once by the banker — catch it from event stream
- Two bank accounts: bank 1 (Jasper + Tos), bank 2 (Ko'catan)
- No bank in Barloque (the class exists in kod but no room creates one)

---

## What is currently working vs. broken

**Working:**
- TCP connection, login, character selection, game mode
- Full inbound packet parsing for all major opcodes
- Movement, combat, equipment, trading, shopping
- Travel (A* routing through all three exit mechanisms)
- Fight loop with safe-spot selection, flee/rest logic
- Watchdog interrupt for long-travel blindness
- Bank, sell, loot, cast
- Fleet rejoin on disconnect (45s sweep)
- Commitment model (claim/busy/free) for multi-bot coordination
- Ledger, death post-mortems, tougher events, ability tracking

**Broken / missing:**
- `arm self` rung: keeper knows it is unarmed, calls `stop()`, no path to buy
  a weapon exists inside the keeper. `m59-outfit.mjs` does this as an external
  CLI tool but is not callable from inside pass()
- BT (behavior tree) nodes were wired to `keeper.buyWeaponsAtNearestSmith()`
  which does not exist — disabled
- GOAP layer was scaffolded but strategy decisions still happen in the monolithic
  pass() ladder

---

## Map of source files

```
tools/
  m59-client.mjs          TCP client, packet parsing, world model, all raw commands
  m59-parse.mjs           Binary deserializers for every BP_* packet
  m59-rsc.mjs             Resource string table loader (NPC names, item names, etc.)
  m59-broker.mjs          Fleet manager: sessions, pacer, HTTP/MCP server, keeper loop
  m59-autopilot.mjs       The keeper — pass() decision ladder, watchdog, policy
  m59-skills.mjs          fight(), travel(), eat(), bank(), sell(), cast(), merchants
  m59-map.mjs             Room graph, A* pathfinding, exit extraction
  m59-safespots.mjs       Safe-wall detection and scoring
  m59-loadout.mjs         Per-character policy overlay (loadout JSON → policy fields)
  m59-commitment.mjs      claim/busy/free ownership model for multi-bot coordination
  m59-outfit.mjs          CLI tool: travel to smith, buy weapon, equip — NOT callable
                          from inside the keeper (standalone child process only)
  m59-bt.mjs              BT primitives (Selector, Sequence, Condition, Action)
  m59-bt-nodes.mjs        BT nodes for get_armed tree (travelAndBuy is a stub)
  m59-spawns.mjs          Creature spawn tables extracted from server source
  m59-merchants.mjs       Merchant catalog (what each NPC sells/buys/teaches)
  m59-ledger.mjs          5-min samples, kill/tougher events, economy history
  m59-supervise.mjs       External watchdog: unsticks stalled keepers at 60s
  m59-service.mjs         Broker lifecycle: start/stop/restart as a managed service
  m59-dashboard.mjs       Fleet web dashboard (:8902)

substrate/
  fleet-state.json        Credentials + autopilot policy (THE roster — never lose this)
  loadouts/<char>.json    Per-character gear/reagent/policy overlays
  abilities/<char>.json   Skill/spell levels (pushed by server, kept current)
  banks/<char>.json       Bank balance (caught from event stream)
  hits/<char>.json        Every health drop with room and killer
  ledger/<fleet>.jsonl    5-min samples + kill/tougher events

docs/
  m59-agent-primer.md     Rules of the world for a character-driving agent
  m59-mcp.md              MCP tool surface documentation
  architecture.md         System diagram
  bot-architecture.md     ← this file
```
