#!/usr/bin/env node
// Sample swing/loot/death counts from keeper logs in a time window.
// Usage: node tools/m59-sample.mjs [--since <ISO>] [--minutes N]
import { createReadStream, readdirSync } from 'fs';
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
const files = readdirSync(dir).filter(f => f.startsWith('keeper-') && f.endsWith('.log'));
for (const f of files) {
  const p = join(dir, f);
  let swings = 0, loots = 0, deaths = 0, first = null, last = null;
  const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const ts = line.slice(0, 19);
    if (!first) first = ts;
    last = ts;
    if (ts < since) continue;
    if (line.includes('-> swing')) swings++;
    if (line.includes('-> loot')) loots++;
    if (line.includes('[death-stamp]')) deaths++;
  }
  rl.close();
  const name = f.replace('keeper-', '').replace('.log', '');
  console.log(`  ${name}: swings=${swings} loots=${loots} deaths=${deaths} first=${first} last=${last}`);
}
