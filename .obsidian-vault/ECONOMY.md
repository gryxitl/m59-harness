# Economy

> How the economy works. When a character is not buying, selling, or banking, start here.

## The economy loop

```
1. Hunt → kill → loot (gold + items drop on the floor)
2. Pick up the loot (gold + items go to the pack)
3. Travel to town (when the pack is full or gold is above bankAbove)
4. Bank the gold (if gold > bankAbove)
5. Sell the items (if the items are on the sell list)
6. Buy food (if buyFood policy is set and food is low)
7. Buy gear (if the loadout specifies gear to buy)
8. Return to the hunt room
```

## The policy keys

| Key | What it controls | Default |
|-----|-----------------|---------|
| `bankAbove` | Bank gold when purse > this | 500 |
| `buyFood` | Buy food when food < this | true |
| `roam` | Roam between hunt rooms | false |
| `partner` | Partner character (share loot) | null |

## Banking

### When to bank

The character banks when:
- Purse > `bankAbove` (default: 500)
- The character is in a town (banker available)
- The character is not in combat

### How banking works

```
1. Find the banker (scan room.objects for OF_BANKER)
2. Approach the banker
3. Use the "bank" action (deposit gold)
4. The gold moves from purse to bank
5. The bank balance is recorded in substrate/banks/<char>.json
```

## Buying

### When to buy

The character buys when:
- In a town (merchant available)
- `buyFood` policy is set and food is low
- The loadout specifies gear to buy
- The character has enough gold

### How buying works

```
1. Find the merchant (scan room.objects for OF_MERCHANT)
2. Approach the merchant
3. Use the "buy" action (purchase the item)
4. The gold moves from purse to the merchant
5. The item goes to the pack
```

## Selling

### When to sell

The character sells when:
- In a town (merchant available)
- The pack has items on the sell list
- The items are not needed for the loadout

### How selling works

```
1. Find the merchant (scan room.objects for OF_MERCHANT)
2. Approach the merchant
3. Use the "sell" action (sell the item)
4. The gold moves from the merchant to the purse
5. The item is removed from the pack
```

### The sell list

The sell list is defined in `m59-selling.mjs`. It specifies which items to sell
and at what price. Items on the list are sold automatically when the character
is in a town.

## The treasury

The treasury is the guild's shared gold pool. The character can:
- **Deposit** gold to the treasury (tithe)
- **Withdraw** gold from the treasury (if the guild allows)

The tithe is a percentage of the character's gold, deposited to the guild.

## The guild

The guild is a shared organization that:
- Collects tithes (gold) from members
- Provides services (healing, gear, information)
- Has "wants" (items the guild needs)

The character can:
- **Tithe**: Deposit a percentage of gold to the guild
- **Fulfill wants**: Buy and deliver items the guild needs
- **Receive services**: Use guild services (healing, gear)

## Debugging economy

```bash
# Check the character's purse and bank
curl -s http://127.0.0.1:8901/snapshot?t1 | python3 -m json.tool | grep -E "purse|bank|pack"

# Check the broker log for economy events
grep -i "bank\|buy\|sell\|tithe" substrate/broker-prod.log | tail -20

# Check the economy page
curl -s http://127.0.0.1:8902/economy | python3 -m json.tool
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Character not banking | Purse < bankAbove, or no banker in room | Policy `bankAbove`, room objects |
| Character not buying | No merchant, or not enough gold | Room objects, purse |
| Character not selling | No items on the sell list, or no merchant | Sell list, room objects |
| Character not tithing | Guild not active, or tithe disabled | Guild state, policy |
| Gold not appearing in bank | Bank action failed | Broker log, bank action |

## Links

- [[FLEET-OPS]] — policy management
- [[COMBAT]] — how hunting generates gold
- [[FILES]] — economy-related files
