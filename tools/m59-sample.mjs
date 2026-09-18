#!/usr/bin/env node
// Sample swing/loot/death/kill counts from keeper logs in a time window.
// Usage: node tools/m59-sample.mjs [--since <ISO>] [--minutes N]
//
// kills: `-> loot` dispatch (fires only after a kill, m59-decide.mjs:2391)
// our_deaths: `### <our_name> was just killed by` broadcast (authoritative)
// uw_entries: [death-stamp] (entered Underworld, NOT a death)
// swings: `-> swing` (attack-packet offers, not kills)
import { createReadStream, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';

const args = process.argv.slice(2);
let minutes = 5;
let since = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--minutes') minutes = parseInt(args[++i], 10);
  if (args[i] === '--since') since = args[++i];
}
if (!since) {
  const d = new Date(Date.now() - minutes * 60000);
  since = d.toISOString().slice(0, 19);
}
console.log(`Window: since=${since} (last ${minutes} min)`);
const dir = join(dirname(new URL(import.meta.url).pathname), '..', 'substrate');
let roster = {};
try {
  const d = JSON.parse(readFileSync(join(dir, 'fleet-state.json'), 'utf8'));
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'object' && v?.credentials?.character) roster[k] = v.credentials.character;
  }
} catch {}
const files = readdirSync(dir).filter(f => f.startsWith('keeper-') && f.endsWith('.log'));
for (const f of files) {
  const p = join(dir, f);
  const key = f.replace('keeper-', '').replace('.log', '');
  const charName = roster[key] ?? key;
  const deathRe = new RegExp(`### ${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was just killed`);
  let swings = 0, loots = 0, deaths = 0, uwEntries = 0, first = null, last = null;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (!m) continue;
    const ts = m[1];
    if (!first) first = ts;
    last = ts;
    if (ts < since) continue;
    if (line.includes('-> swing')) swings++;
    if (line.includes('-> loot')) loots++;
    if (line.includes('[death-stamp]')) uwEntries++;
    if (deathRe.test(line)) deaths++;
  }
  rl.close();
  console.log(`  ${key} (${charName}): swings=${swings} kills=${loots} our_deaths=${deaths} uw_entries=${uwEntries} first=${first} last=${last}`);
}
