// PARK JAYB ON A PROVEN SAFE WALL. The mover is walking him into the room boundary and he
// is losing health; a square the book records as HELD with no failures is somewhere the
// fleet has actually stood and not been hit.
import { readFileSync } from 'node:fs';
import { Session } from './m59-session.mjs';
const cred = JSON.parse(readFileSync('substrate/fleet-state.json','utf8')).t3.credentials;
const s = new Session('t3'); await s.join(cred);
await new Promise(r => setTimeout(r, 2000));
const c = s.client;
const at = async () => { try { return await s.confirmPosition(); } catch { return null; } };

const book = JSON.parse(readFileSync('substrate/m59-safespots.json','utf8')).rooms?.['1016'] ?? {};
const spots = Object.values(book)
  .filter(x => (x?.held ?? 0) > 0 && !(x?.failed > 0) && Number.isFinite(x.col))
  .sort((a, b) => (b.held ?? 0) - (a.held ?? 0));
console.log(`  ${spots.length} squares held here with no recorded failure`);
const t = spots[0];
if (!t) { console.log('  none — leaving him where he is'); process.exit(0); }
console.log(`  best: ${t.col},${t.row}  held ${t.held}  free_shots ${t.free_shots ?? '?'}`);

let p = await at();
console.log(`  from ${p?.col},${p?.row}  hp ${JSON.stringify(c.vitals?.()?.health)}`);
for (let i = 0; i < 10; i++) {
  c.moveTo(t.col * 64 + 32, t.row * 64 + 32);
  await new Promise(r => setTimeout(r, 450));
  const q = await at();
  if (q && q.col === t.col && q.row === t.row) break;
}
const end = await at();
console.log(`  parked at ${end?.col},${end?.row}  hp ${JSON.stringify(c.vitals?.()?.health)}`);
await s.leave?.().catch(() => {});
process.exit(0);
