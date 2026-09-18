#!/usr/bin/env node
// Sample swing/death/level counts from keeper logs in a time window.
// Usage: node tools/m59-sample.mjs [--since <ISO>] [--minutes N]
import { createReadStream } from 'fs';
import { join, dirname } from 'path';
import { readdirSync } from 'fs';

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
  let swings = 0, deaths = 0, levels = 0;
  const stream = createReadStream(join(dir, f), 'utf8');
  for await (const line of stream) {
    if (line < since) continue;
    if (line.includes('-> swing')) swings++;
    if (line.includes('[death-stamp]')) deaths++;
    if (line.includes('level up') || line.includes('Level up')) levels++;
  }
  console.log(`  ${f.replace('keeper-','').replace('.log','')}: swings=${swings} deaths=${deaths} levels=${levels}`);
}
