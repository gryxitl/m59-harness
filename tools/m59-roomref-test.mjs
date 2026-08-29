// resolveRoomRef: which map room is this, when neither key is safe alone?
//
// Both keys have now cost this repository a session. The runtime room id is a different
// namespace from the map's numbering (runtime 2000 is "Raza Inn"; map 2000 is Ko'catan),
// and resolving geometry from it draws one room's walls over another's floor. The room
// NAME is not unique — 14 names in the shipped map are shared, every one of them by rooms
// with DIFFERENT .roo files — so a name-keyed lookup serves one room's geometry to all of
// them. Both failures look identical from the outside: "two maps overlaid".
import { readFileSync } from 'node:fs';
import { resolveRoomRef } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));

console.log('the shipped map really does have colliding names');
{
  const byName = new Map();
  for (const r of Object.values(map.rooms)) {
    if (!r.name) continue;
    if (!byName.has(r.name)) byName.set(r.name, new Set());
    byName.get(r.name).add(r.roo?.file ?? null);
  }
  const collide = [...byName.entries()].filter(([, files]) => files.size > 1);
  ok('at least one name is shared by rooms with different geometry', collide.length > 0,
     `${collide.length} colliding names`);
  ok('and "Abandoned Building" is the worst of them',
     (byName.get('Abandoned Building')?.size ?? 0) > 2,
     JSON.stringify([...(byName.get('Abandoned Building') ?? [])]));
}

console.log('\nevery room resolves to its OWN geometry');
{
  let wrong = [];
  for (const [id, r] of Object.entries(map.rooms)) {
    if (!r.roo?.file || !r.name) continue;
    const got = resolveRoomRef(map, Number(id), r.name);
    if (got?.roo?.file !== r.roo.file) wrong.push({ id, want: r.roo.file, got: got?.roo?.file });
  }
  ok('all 264 of them, not 244', wrong.length === 0,
     `${wrong.length} wrong, e.g. ${JSON.stringify(wrong.slice(0, 3))}`);
}

console.log('\nthe number is corroborated, never trusted blind');
{
  // The original trap: a runtime id that happens to be a valid map number for a
  // DIFFERENT room. The names disagree, so the name must win.
  const raza = resolveRoomRef(map, 2000, 'Raza Inn');
  ok('a runtime id landing on the wrong room falls back to the name',
     raza?.name === 'Raza Inn', JSON.stringify(raza?.name));
  ok('...and that really was a trap — map 2000 is somewhere else',
     map.rooms['2000'].name !== 'Raza Inn', map.rooms['2000'].name);

  // The new capability: a genuine map number disambiguating a shared name.
  const kings = resolveRoomRef(map, 575, "The King's Way");
  ok('a genuine map number picks the right one of a shared name',
     kings?.num === 575 && kings?.roo?.file === map.rooms['575'].roo.file,
     JSON.stringify({ num: kings?.num, roo: kings?.roo?.file }));

  // Degradation: no number at all is the old name-only behaviour, not a crash.
  const noNum = resolveRoomRef(map, null, 'The Sewers of Jasper');
  ok('no number degrades to the name rather than throwing', noNum?.name === 'The Sewers of Jasper');
  ok('nothing at all is null, not a throw', resolveRoomRef(map, null, null) === null);
  ok('no map is null too', resolveRoomRef(null, 575, "The King's Way") === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
