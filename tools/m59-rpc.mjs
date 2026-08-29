#!/usr/bin/env node
// m59-rpc.mjs -- call one broker MCP tool from the command line.
//
//   node tools/m59-rpc.mjs fleet
//   node tools/m59-rpc.mjs status '{"agent":"t3"}'
//   node tools/m59-rpc.mjs list                     # list the 85 tools
//
// Attaches to the broker that already holds the fleet (HTTP JSON-RPC on 8901).
// Holds no sessions, takes no lock — the same contract as m59-mcp-attach.mjs.
import process from 'node:process';

const argv = process.argv.slice(2);
const HOST = process.env.M59_BROKER_HOST || '127.0.0.1';
const PORT = Number(process.env.M59_BROKER_PORT || 8901);
const rpc = async (method, params) => {
  const res = await fetch(`http://${HOST}:${PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
};

if (!argv.length || argv[0] === 'list') {
  const d = await rpc('tools/list');
  for (const t of d.result?.tools ?? []) console.log(`${t.name.padEnd(28)} ${t.description?.split('\n')[0]?.slice(0, 70) ?? ''}`);
  process.exit(0);
}

const [tool, argStr] = argv;
const args = argStr ? JSON.parse(argStr) : {};
const d = await rpc('tools/call', { name: tool, arguments: args });
const text = d.result?.content?.[0]?.text;
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
catch { console.log(text ?? JSON.stringify(d, null, 2)); }
process.exit(d.error ? 1 : 0);
