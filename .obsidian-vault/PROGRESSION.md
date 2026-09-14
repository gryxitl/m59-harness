# Progression

> How leveling, skills, and abilities work. When a character is not leveling up, start here.

## The leveling system

Characters gain experience (XP) by:
- **Killing monsters** (the primary source)
- **Completing quests** (if any)
- **Using skills/abilities** (some skills give XP on use)

When a character gains enough XP, they level up. Each level:
- Increases max HP (by a small amount)
- Increases max vigor (by a small amount)
- May unlock new skills/abilities

## The max HP death spiral

**Each death drops max HP by 1-2.** This is the "death spiral":
1. Character dies → max HP drops by 1-2
2. Lower max HP → harder to survive → more deaths
3. More deaths → max HP drops further → harder to survive
4. ...until the character can't survive at all

**The fix:** Route to a weaker-mob room (don't raise the hunt band ceiling).
If max HP is too low, re-roll (manual only).

## Skills

Skills are learned abilities that the character can use in combat or outside
combat. They are:
- **Learned** by using them (or by training)
- **Leveled** by using them more
- **Recorded** in `substrate/abilities/<char>.json`

### Skill levels

Each skill has a level (1-10). Higher levels:
- Do more damage (combat skills)
- Last longer (buffs)
- Cost less (resource costs)

### Skill data

Skill data is in `m59-skills.mjs` and `substrate/abilities/<char>.json`.
The abilities file is updated by the server (pushed via `BP_STAT`).

## Abilities

Abilities are innate powers that the character has. They are:
- **Fixed** at creation (based on the character's attributes)
- **Not leveled** (they don't improve with use)
- **Recorded** in `substrate/abilities/<char>.json`

### Key abilities

| Ability | What it does |
|---------|-------------|
| Stamina | Max HP ceiling (`101 + stamina`) |
| Strength | Melee damage |
| Agility | Dodge, initiative |
| Intelligence | Spell power, mana |
| Wisdom | Willpower, resistances |
| Charisma | Social, merchant discounts |

## Reagents

Reagents are items used in spellcasting. They are:
- **Consumed** when casting a spell
- **Bought** from merchants or gathered in the wild
- **Recorded** in `m59-reagents.mjs`

### Key reagents

| Reagent | Used for |
|---------|----------|
| Glowworm | Light spells |
| Sulfur | Fire spells |
| Moonpetal | Healing spells |
| Shadowleaf | Illusion spells |
| Crystal shard | Teleportation (blink) |

## The loadout

The loadout (`substrate/loadouts/<char>.json`) specifies:
- **Gear targets**: What equipment the character should have
- **Reagent targets**: What reagents the character should stock
- **Standing preferences**: Policy keys (hunt, assignedRoom, etc.)

The loadout is the **source of truth** for standing preferences (POLICY_KEYS).
The roster is the source of truth for everything else (protected faculties).

## Debugging progression

```bash
# Check the character's level and XP
curl -s http://127.0.0.1:8901/snapshot?t1 | python3 -m json.tool | grep -E "level|xp|hp"

# Check the character's skills
cat substrate/abilities/<char>.json | python3 -m json.tool

# Check the broker log for level-up events
grep -i "level\|improve" substrate/broker-prod.log | tail -20

# Check the skills page
curl -s http://127.0.0.1:8902/skills | python3 -m json.tool
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Character not leveling up | Not enough XP, or level cap | XP gain, level cap |
| Max HP dropping | Death spiral (each death drops max HP by 1-2) | Route to weaker mobs |
| Skills not improving | Not using the skill, or skill cap | Skill use, skill cap |
| Reagents running out | Not buying/gathering reagents | Buy logic, reagent targets |
| Loadout not being followed | Loadout not updated, or broker cache | `autopilot set`, restart broker |

## Links

- [[COMBAT]] — how hunting generates XP
- [[ECONOMY]] — how to buy reagents/gear
- [[FLEET-OPS]] — loadout management
