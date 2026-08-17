#!/usr/bin/env node
// WHAT A MERCHANT WILL BUY — the contract test. Offline, no broker, no server.
//
// The thing being pinned is not "does the table say what the kod says" — that is a
// transcription, and a reader can check it against the citations. It is the two
// directions this can fail in, which are not symmetric:
//
//   OFFERING SOMETHING A MERCHANT DOES NOT DEAL IN costs a round trip and a silence, and
//   twenty of them bury the one line that mattered. That is the bug this module fixes.
//
//   HOLDING SOMETHING BACK THAT WOULD HAVE SOLD costs the sale, and it is INVISIBLE — the
//   trip reports success, the pack still has the goods, and nothing says why. That is the
//   bug this module could introduce, and it is the worse of the two, so every "cannot say"
//   path is asserted to fall through to offering.
import assert from 'node:assert';
import * as B from './m59-buyers.mjs';

let n = 0;
const ok = (cond, what) => { n++; assert.ok(cond, what); };
const eq = (a, b, what) => { n++; assert.deepStrictEqual(a, b, what); };

// A fixture index rather than the built one: this test must not start failing because
// somebody rebuilt the compendium, and it must state the shapes it depends on.
B.setItems([
  { name: 'long sword', cls: 'LongSword', kind: 'weapon', file: 'kod/object/item/passitem/weapon/longswrd.kod' },
  { name: 'mace', cls: 'Mace', kind: 'weapon', file: 'kod/object/item/passitem/weapon/mace.kod' },
  { name: 'short sword', cls: 'ShortSword', kind: 'weapon', file: 'kod/object/item/passitem/weapon/shrtswrd.kod' },
  { name: 'leather armor', cls: 'LeatherArmor', kind: 'armour', file: 'kod/object/item/passitem/defmod/armor/leather.kod' },
  { name: "knight's shield", cls: 'Knightshield', kind: 'shield', file: 'kod/object/item/passitem/defmod/shield/knhtshld.kod' },
  { name: 'elderberry', cls: 'ElderBerry', kind: 'reagent', file: 'kod/object/item/passitem/numbitem/elderbry.kod' },
  { name: 'sapphire', cls: 'Sapphire', kind: 'reagent', file: 'kod/object/item/passitem/numbitem/sapphire.kod' },
  { name: 'loaf of bread', cls: 'Bread', kind: 'food', file: 'kod/object/item/passitem/numbitem/food/bread.kod' },
  { name: 'signet ring', cls: 'SignetRing', kind: 'misc', file: 'kod/object/item/passitem/ring/ringsgnt.kod' },
]);

// ---- categories are read off the class hierarchy, which is the directory path
ok(B.categoriesOf('long sword').categories.has('weapon'), 'a long sword is a weapon');
ok(B.categoriesOf('leather armor').categories.has('wearable'), 'armour is wearable');
ok(B.categoriesOf("knight's shield").categories.has('wearable'), 'a shield is wearable');
ok(B.categoriesOf('loaf of bread').categories.has('sundry'), 'Food is sundry, not its own category');

// A GEM IS A REAGENT TOO. This is the overlap the apothecaries exist to exclude, and a
// categoriser that returned one answer per item could not express it.
const sap = B.categoriesOf('sapphire').categories;
ok(sap.has('gem') && sap.has('reagent'), 'a sapphire is BOTH gem and reagent');

// A SIGNET RING IS A GEM to the buying code (monster.kod:4198 lists Ring), which is why an
// apothecary that buys every other reagent refuses it.
ok(B.categoriesOf('signet ring').categories.has('gem'), 'Ring counts as a gem');

// ---- the user-facing rule: a smith buys weapons, armour and shields. Nothing else.
eq(B.willBuy('JasperBlacksmith', 'long sword').buys, true, 'smith buys a weapon');
eq(B.willBuy('JasperBlacksmith', "knight's shield").buys, true, 'smith buys a shield');
eq(B.willBuy('JasperBlacksmith', 'leather armor').buys, true, 'smith buys armour');
eq(B.willBuy('JasperBlacksmith', 'sapphire').buys, false, 'smith does NOT buy gems');
eq(B.willBuy('JasperBlacksmith', 'elderberry').buys, false, 'smith does NOT buy reagents');
eq(B.willBuy('JasperBlacksmith', 'loaf of bread').buys, false, 'smith does NOT buy food');

// THE MARION SMITH IS THE ODD ONE: weapons and shields, and NO body armour. Folding the
// six smiths into one rule would sell his leather to a silence.
eq(B.willBuy('MarionBlacksmith', "knight's shield").buys, true, 'Marion takes shields');
eq(B.willBuy('MarionBlacksmith', 'leather armor').buys, false, 'Marion takes no body armour');

// ---- the gem exclusion, in both directions
eq(B.willBuy('TosApothecary', 'elderberry').buys, true, 'apothecary buys reagents');
eq(B.willBuy('TosApothecary', 'sapphire').buys, false, 'three of four apothecaries refuse gems');
eq(B.willBuy('HazarApothecary', 'sapphire').buys, true, 'Hazar is the one that takes them');

// ---- onlyClasses is exclusive, and it is exclusive against a sibling of the same family
eq(B.willBuy('KocatanBartender', 'short sword').buys, true, 'the bartender buys short swords');
eq(B.willBuy('KocatanBartender', 'long sword').buys, false, 'and no other weapon');

// ---- CANNOT SAY IS NOT NO. Both of these must offer, or the module silently stops sales.
eq(B.willBuy('SomeClassNobodyHasMapped', 'long sword').buys, null, 'unknown merchant: cannot say');
eq(B.willBuy('JasperBlacksmith', 'a thing not in the index').buys, null, 'unknown item: cannot say');

// ---- partition: the seller's shape
const p = B.partition(
  [{ name: 'long sword', amount: 1 }, { name: 'sapphire', amount: 12 },
   { name: 'elderberry', amount: 40 }, { name: "knight's shield", amount: 2 }],
  { cls: 'JasperBlacksmith', name: 'Quintor' });
eq(p.offer.map(i => i.name).sort(), ["knight's shield", 'long sword'], 'only gear is offered');
eq(p.not_offered.map(i => i.name).sort(), ['elderberry', 'sapphire'], 'the rest is held back');
ok(p.not_offered.every(i => i.why && i.cite), 'every exclusion carries a reason and a citation');
ok(p.not_offered.find(i => i.name === 'sapphire').amount === 12, 'the amount survives, so a caller can plan a second trip');
eq(p.merchant.buys, ['weapon', 'wearable'], 'the merchant block says what it does deal in');

// AN UNRESOLVED MERCHANT OFFERS EVERYTHING — the pre-module behaviour, exactly.
const u = B.partition([{ name: 'sapphire' }, { name: 'long sword' }], { name: 'somebody new' });
eq(u.not_offered.length, 0, 'nothing is held back from a merchant we cannot identify');
eq(u.offer.length, 2, 'and everything is still offered');

// ---- name resolution
eq(B.classOf({ name: 'Quintor' }).cls, 'JasperBlacksmith', 'the known-buyer table resolves Quintor');
eq(B.classOf({ id: 3292, index: { merchants: [{ id: 3292, cls: 'TosBlacksmith', name: 'X' }] } }).cls,
   'TosBlacksmith', 'an object id resolves through the merchant index');

// TWO PEOPLE, ONE NAME. Same rule is fine; different rules must refuse rather than guess.
const shared = { merchants: [{ id: 1, cls: 'TosBlacksmith', name: "Fehr'loi Qan" },
                             { id: 2, cls: 'BarloqueBlacksmith', name: "Fehr'loi Qan" }] };
ok(B.classOf({ name: "Fehr'loi Qan", index: shared }).cls, 'two blacksmiths with one rule resolve');
const conflict = { merchants: [{ id: 1, cls: 'TosApothecary', name: 'Twin' },
                               { id: 2, cls: 'JasperBlacksmith', name: 'Twin' }] };
eq(B.classOf({ name: 'Twin', index: conflict }).cls, null, 'a name over two DIFFERENT rules is ambiguous');
ok(B.classOf({ name: 'Twin', index: conflict }).ambiguous.length === 2, 'and it names both');

// ---- whoBuys: the question worth asking before the walk
const wb = B.whoBuys('elderberry');
ok(wb.buyers.some(b => b.class === 'TosApothecary'), 'an apothecary is offered for elderberry');
ok(!wb.buyers.some(b => b.class === 'JasperBlacksmith'), 'a smith is not');
ok(B.whoBuys('sapphire').buyers.some(b => b.class === 'HazarApothecary'), 'the gem apothecary is findable');

// ---- the two with a real inventory buy any category and fail for SHELF SPACE instead,
// so category must never be reported as their reason.
eq(B.willBuy('Izzio', 'elderberry').buys, true, 'Izzio buys any category');
ok(B.willBuy('Izzio', 'elderberry').caveat, 'and is flagged as able to refuse for space');

console.log(`m59-buyers: ${n} assertions passed`);
