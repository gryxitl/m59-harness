import { protocolToClient } from './m59-roo.mjs';
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('substrate/m59-map.json','utf8'));
const rooms = Array.isArray(d.rooms)?d.rooms:Object.values(d.rooms);
const r = rooms.find(x=>x.num===557);
const seg=(a,b,p)=>{const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(!l2)return Math.hypot(p.x-a.x,p.y-a.y);let t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2));return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));};
for (const [label, col, row] of [['live square (26,38)',27,39], ['a floored square (29,38)',29,38]]) {
  const x=protocolToClient((col-1)*64+32), y=protocolToClient((row-1)*64+32);
  const ds=r.roo.walls.map(w=>({d:seg({x:w[0],y:w[1]},{x:w[2],y:w[3]},{x,y}),f:w[4]})).sort((a,b)=>a.d-b.d).slice(0,3);
  console.log(`${label}: nearest walls at ${ds.map(z=>`${Math.round(z.d)}u (${(z.d/64).toFixed(2)} sq) flags=${z.f}`).join(', ')}`);
}
