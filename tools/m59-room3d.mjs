// m59-room3d.mjs -- Three.js 3D room view.
//
// Coordinate mapping:
//   room (col, row)  ->  Three.js (x, 0, z)
//   Three.js Y is UP (height). Floor is at Y=0.
//   Camera looks down from above.

export function renderRoom3D(name, rv, hero) {
  if (!rv) return `<!doctype html><html><body style="background:#111;color:#ccc;font:14px system-ui;padding:20px">
    <a href="/hero/${name}" style="color:#4a9">&larr; ${name}</a>
    <p>No room data available.</p></body></html>`;

  const { cols, rows, objects: _objects, self } = rv;
  const objects = _objects ?? [];
  const walkable = rv.walkable ?? [];
  const hasWalls = walkable.length === cols * rows && walkable.some(v => v === 0);
  let roomName = hero?.room?.name ?? '';
  const hp = hero?.vitals?.health ?? {};
  const mana = hero?.vitals?.mana ?? {};
  const vigor = hero?.vitals?.vigor ?? {};
  const vigMax = vigor.current_max ?? vigor.max ?? 100;

  const wallData = hasWalls ? JSON.stringify(walkable) : 'null';
  const wallSegs = (rv.walls ?? []).map(w => [w[0], w[1], w[2], w[3]]);
  const wallSegsJson = JSON.stringify(wallSegs);
  const objectsJson = JSON.stringify(objects.map(o => ({
    x: Math.min(Math.max(o.col - 1, 0), cols - 1),
    z: Math.min(Math.max(o.row - 1, 0), rows - 1),
    t: o.is_self ? 0 : o.is_player ? 1 : 2,
    n: o.name,
  })));
  const selfJson = self ? JSON.stringify({
    x: Math.min(Math.max(self.col - 1, 0), cols - 1),
    z: Math.min(Math.max(self.row - 1, 0), rows - 1),
  }) : 'null';
  // The decider's current target: a tall beacon above it.
  const target = rv?.target ?? null;
  const targetJson = target && target.col != null ? JSON.stringify({
    x: Math.min(Math.max(target.col - 1, 0), cols - 1),
    z: Math.min(Math.max(target.row - 1, 0), rows - 1),
    name: target.name ?? '',
  }) : 'null';

  // Floor height data (cells, i.e. units of 1024). -1 = void/cliff.
  // The broker nests it as room_view.heights = { heights:[...], min, max, step }.
  const hObj = rv && rv.heights && Array.isArray(rv.heights.heights) ? rv.heights : null;
  const heights = (hObj && hObj.heights.length === cols * rows) ? hObj.heights : null;
  const heightsJson = heights ? JSON.stringify(heights) : 'null';
  const hMin = heights ? (hObj.min ?? 0) : 0;
  const hMax = heights ? (hObj.max ?? 0) : 0;
  const hiddenJson = JSON.stringify(rv.hidden ?? []);
  const hiddenCount = (rv.hidden ?? []).length;
  const safeSpotsJson = JSON.stringify((rv.safe_spots ?? []).map(s => ({ x: s.x, z: s.z, score: s.score })));

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${name} — 3D Room</title>

<style>
  * { margin:0; padding:0; }
  body { background:#0a0a12; overflow:hidden; touch-action:none; }
  canvas { display:block; width:100vw; height:100vh; }
  #hud { position:fixed; top:env(safe-area-inset-top,8px); left:8px;
    font:13px system-ui; color:#aaa; background:rgba(0,0,0,.75);
    padding:8px 14px; border-radius:8px; z-index:10; pointer-events:none; }
  #hud a { color:#4a9; text-decoration:none; pointer-events:auto; }
  #hud .dim { color:#666; font-size:11px; }
  #hud .bars { display:flex; gap:4px; margin-top:6px; height:6px; }
  #hud .bar { border-radius:3px; transition:width .5s; }
  #hud .bar.hp { background:#e44; }
  #hud .bar.mana { background:#48e; }
  #hud .bar.vigor { background:#4a4; }
  #hud .stats { display:flex; gap:10px; margin-top:4px; font-size:11px; }
  #hud .stats .hp { color:#e66; }
  #hud .stats .mana { color:#68e; }
  #hud .stats .vigor { color:#6a6; }
  #err { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    color:#f88; font:13px system-ui; text-align:center; max-width:85vw; white-space:pre-wrap; z-index:20; }
</style>
</head>
<body>
<div id="hud">
  <a href="/hero/${name}">&larr; ${name}</a>
  <span class="dim"> &middot; ${roomName || 'unknown room'} &middot; ${cols}\\u00d7${rows}${hasWalls ? '' : ' &middot; unmapped'} &middot; <span style="color:#4a9" id="poll-dot">\u25cf</span></span>
  <div class="bars">
    <span class="bar hp" style="width:${Math.round((hp.value/hp.max)*100)}%" title="HP ${hp.value}/${hp.max}"></span>
    <span class="bar mana" style="width:${Math.round((mana.value/mana.max)*100)}%" title="Mana ${mana.value}/${mana.max}"></span>
    <span class="bar vigor" style="width:${Math.round((vigor.value/vigMax)*100)}%" title="Vigor ${vigor.value}/${vigMax}"></span>
  </div>
  <div class="stats">
    <span class="hp">HP ${hp.value}/${hp.max}</span>
    <span class="mana">MP ${mana.value}/${mana.max}</span>
    <span class="vigor">VIG ${vigor.value}/${vigMax}</span>
    ${hiddenCount ? `<span style="color:#ffcc33" title="Asymmetric safe cells: we can stand here, monsters (NSEW grid) cannot">&#9670; ${hiddenCount} hidden</span>` : ''}
    ${(rv.safe_spots?.length ?? 0) ? `<span style="color:#ffd700" title="Computed safe spots: walls that block enemy line-of-sight">&#9679; ${rv.safe_spots.length} safe</span>` : ''}
  </div>
</div>
<div id="err"></div>
<canvas id="c"></canvas>
<script type="importmap">
{ "imports": { "three": "/vendor/three.module.js" } }
</script>
<script type="module">
try {
const THREE = await import('/vendor/three.module.js');
const { OrbitControls } = await import('/vendor/OrbitControls.js');

const COLS = ${cols}, ROWS = ${rows};
const WALLS = ${wallData};
const WALL_SEGS = ${wallSegsJson};
const OBJECTS = ${objectsJson};
const SELF = ${selfJson};
const TARGET = ${targetJson};

// Room (col, row) -> Three.js (x, z). Y is up.
// Floor center in Three.js: (COLS/2, 0, ROWS/2)
const FCX = COLS / 2, FCZ = ROWS / 2;
const HEIGHTS = ${heightsJson};
const HMIN = ${hMin}, HMAX = ${hMax};
// Asymmetric safe cells: coarse-grid WALL but fine-grid open. The player can stand
// here (fine-grid, any direction); a monster (NSEW on the coarse grid) cannot step in.
const HIDDEN = ${hiddenJson};
const SAFE_SPOTS = ${safeSpotsJson};
let roomName = ${JSON.stringify(roomName)};

// Debug path overlay state: the fine path (green) + the direct raycast (red if blocked).
let pathGroup = null;
let pathLine = null, pathDots = null, directLine = null, directX = null;
function setPath3d(p) {
  if (pathGroup) { scene.remove(pathGroup); pathGroup.traverse(n => { n.geometry?.dispose?.(); n.material?.dispose?.(); }); pathGroup = null; }
  pathLine = pathDots = directLine = directX = null;
  if (!p) return;
  pathGroup = new THREE.Group();
  // The fine path: a green line through the waypoints (self -> ... -> target).
  if (Array.isArray(p.path) && p.path.length) {
    const pts = p.path.map(w => new THREE.Vector3(w.x + 0.5, 0.15 + heightAt(w.x, w.z), w.z + 0.5));
    if (pts.length >= 2) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      pathLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x33ff66, linewidth: 3 }));
      pathGroup.add(pathLine);
    }
    // Waypoint dots.
    const dotPts = pts.map(pt => [pt.x, pt.y, pt.z]).flat();
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(dotPts, 3));
    pathDots = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x66ffaa, size: 0.5 }));
    pathGroup.add(pathDots);
  }
  // The direct raycast: a red line self->target, with an X at the block point if blocked.
  if (p.direct && p.self && p.target) {
    const s = new THREE.Vector3(p.self.x + 0.5, 0.2 + heightAt(p.self.x, p.self.z), p.self.z + 0.5);
    const e = new THREE.Vector3(p.target.x + 0.5, 0.2 + heightAt(p.target.x, p.target.z), p.target.z + 0.5);
    if (p.direct.blocked) {
      const dg = new THREE.BufferGeometry().setFromPoints([s, e]);
      directLine = new THREE.Line(dg, new THREE.LineBasicMaterial({ color: 0xff3333, linewidth: 3, transparent: true, opacity: 0.7 }));
      pathGroup.add(directLine);
      // X at the block point.
      if (p.direct.stopX != null && p.direct.stopZ != null) {
        const bx = p.direct.stopX + 0.5, bz = p.direct.stopZ + 0.5, by = 0.3 + heightAt(p.direct.stopX, p.direct.stopZ);
        const xg = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(bx - 0.3, by, bz - 0.3), new THREE.Vector3(bx + 0.3, by, bz + 0.3),
          new THREE.Vector3(bx - 0.3, by, bz + 0.3), new THREE.Vector3(bx + 0.3, by, bz - 0.3),
        ]);
        directX = new THREE.LineSegments(xg, new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 4 }));
        pathGroup.add(directX);
      }
    } else {
      // Direct line is clear: draw it faintly (blue) so you can see the straight shot.
      const dg = new THREE.BufferGeometry().setFromPoints([s, e]);
      directLine = new THREE.Line(dg, new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.3 }));
      pathGroup.add(directLine);
    }
  }
  scene.add(pathGroup);
}

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);

// Camera: above and behind the room center, looking down at it
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 500);
camera.position.set(FCX, 50, FCZ + 40);
camera.lookAt(FCX, 0, FCZ);

const controls = new OrbitControls(camera, canvas);
controls.target.set(FCX, 0, FCZ);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.maxPolarAngle = Math.PI / 2.05;  // don't go under the floor
controls.minDistance = 15;
controls.maxDistance = 120;
controls.update();

// Lights
scene.add(new THREE.AmbientLight(0x8888aa, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(FCX + 30, 50, FCZ + 20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x4466aa, 0.4);
fill.position.set(FCX - 30, 30, FCZ - 20);
scene.add(fill);

// Floor: per-cell quads at their BSP height, tinted by elevation.
// 1 height-cell (1024) = 1 world unit up. Lowest floor sits at y=0.
const hAt = (c, r) => (HEIGHTS && HEIGHTS[r * COLS + c] != null && HEIGHTS[r * COLS + c] >= 0)
  ? HEIGHTS[r * COLS + c] : null;
const hRange = (HMAX - HMIN) || 1;
const floorGroup = new THREE.Group();
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const h = hAt(c, r);
    if (h == null) continue;              // void / outside the room: no floor slab
    const y = (h - HMIN) * 1;             // world-unit height
    // Tint: low = cool dark, high = warm light. Flat rooms all get the base color.
    const t = (h - HMIN) / hRange;
    const col = new THREE.Color().setHSL(0.62 - 0.42 * t, 0.35, 0.16 + 0.22 * t);
    const g = new THREE.PlaneGeometry(1, 1);
    const m = new THREE.MeshLambertMaterial({ color: col });
    const slab = new THREE.Mesh(g, m);
    slab.rotation.x = -Math.PI / 2;
    slab.position.set(c + 0.5, y, r + 0.5);
    slab.receiveShadow = true;
    floorGroup.add(slab);
    // Side faces where a neighbor is lower (shows the cliff drop).
    const nb = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]];
    for (const [nc, nr] of nb) {
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const nh = hAt(nc, nr);
      if (nh == null || h - nh > 0.05) {
        const dropH = h - Math.max(nh ?? (h - 1), HMIN);
        if (dropH <= 0) continue;
        const ang = nc === c + 1 ? 0 : nc === c - 1 ? Math.PI : nr === r + 1 ? Math.PI / 2 : -Math.PI / 2;
        const wall = new THREE.Mesh(
          new THREE.PlaneGeometry(1, dropH),
          new THREE.MeshLambertMaterial({ color: 0x3a3a50, side: THREE.DoubleSide }));
        wall.position.set(c + 0.5 + Math.cos(ang) * 0.5, y - dropH / 2, r + 0.5 + Math.sin(ang) * 0.5);
        wall.rotation.y = -ang;
        floorGroup.add(wall);
      }
    }
  }
}
scene.add(floorGroup);

// Asymmetric safe cells: gold floor tiles. These are coarse-WALL / fine-open cells the
// player can stand in but a monster (NSEW grid) cannot enter.
if (Array.isArray(HIDDEN) && HIDDEN.length) {
  for (const [c, r] of HIDDEN) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
    const h = hAt(c, r);
    const y = (h != null ? h - HMIN : 0) * 1 + 0.06;   // just above the floor slab
    const g = new THREE.PlaneGeometry(0.92, 0.92);
    const m = new THREE.MeshLambertMaterial({ color: 0xffcc33, emissive: 0x443300, side: THREE.DoubleSide });
    const tile = new THREE.Mesh(g, m);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(c + 0.5, y, r + 0.5);
    scene.add(tile);
  }
}

// Computed safe spots: bright green floor tiles. These are positions where the
// character can fight with reduced enemy line-of-sight (back against a wall/corner).
if (Array.isArray(SAFE_SPOTS) && SAFE_SPOTS.length) {
  for (const s of SAFE_SPOTS) {
    if (s.x < 0 || s.z < 0 || s.x >= COLS || s.z >= ROWS) continue;
    const h = hAt(s.x, s.z);
    const y = (h != null ? h - HMIN : 0) * 1 + 0.07;   // slightly above hidden tiles
    const g = new THREE.PlaneGeometry(0.85, 0.85);
    const m = new THREE.MeshLambertMaterial({ color: 0x00ff88, emissive: 0x004422, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    const tile = new THREE.Mesh(g, m);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(s.x + 0.5, y, s.z + 0.5);
    scene.add(tile);
  }
}

// Keep a thin reference plane at y=0 for rooms with no height data.
if (!HEIGHTS) {
  const floorGeo = new THREE.PlaneGeometry(COLS, ROWS);
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x1e1e30 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(FCX, 0, FCZ);
  floor.receiveShadow = true;
  scene.add(floor);
}

// Grid lines on the floor
const gridVerts = [];
for (let x = 0; x <= COLS; x++) {
  gridVerts.push(x, 0.01, 0, x, 0.01, ROWS);
}
for (let z = 0; z <= ROWS; z++) {
  gridVerts.push(0, 0.01, z, COLS, 0.01, z);
}
const gridGeo = new THREE.BufferGeometry();
gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridVerts, 3));
const gridMat = new THREE.LineBasicMaterial({ color: 0x2a2a40, transparent: true, opacity: 0.6 });
const grid = new THREE.LineSegments(gridGeo, gridMat);
grid.position.set(0, 0, 0);
scene.add(grid);

// Walls
if (WALLS) {
  const wallGeo = new THREE.BoxGeometry(1, 2, 1);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a4a6a });
  let count = 0;
  for (let z = 0; z < ROWS; z++)
    for (let x = 0; x < COLS; x++)
      if (WALLS[z * COLS + x] === 0) count++;

  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, count);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let i = 0;
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < COLS; x++) {
      if (WALLS[z * COLS + x] !== 0) continue;
      const h = (HEIGHTS && HEIGHTS[z * COLS + x] != null && HEIGHTS[z * COLS + x] >= 0)
        ? (HEIGHTS[z * COLS + x] - HMIN) : 0;
      dummy.position.set(x + 0.5, h + 1, z + 0.5);
      dummy.updateMatrix();
      wallMesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  wallMesh.instanceMatrix.needsUpdate = true;
  scene.add(wallMesh);
} else {
  // Unmapped room: border outline
  const b = 0.1;
  const borderGeo = new THREE.BufferGeometry();
  borderGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.1, 0, COLS, 0.1, 0,
    COLS, 0.1, 0, COLS, 0.1, ROWS,
    COLS, 0.1, ROWS, 0, 0.1, ROWS,
    0, 0.1, ROWS, 0, 0.1, 0,
  ], 3));
  const borderMat = new THREE.LineBasicMaterial({ color: 0x5566aa });
  scene.add(new THREE.LineSegments(borderGeo, borderMat));
}

// Wall segments (from .roo geometry, fine polygon walls)
if (WALL_SEGS.length) {
  const segVerts = [];
  const wallH = 2.0;
  for (const [x0, z0, x1, z1] of WALL_SEGS) {
    // Base height from the cell under the midpoint
    const bc = Math.floor((x0 + x1) / 2), br = Math.floor((z0 + z1) / 2);
    const hh = (HEIGHTS && bc >= 0 && br >= 0 && bc < COLS && br < ROWS && HEIGHTS[br * COLS + bc] != null && HEIGHTS[br * COLS + bc] >= 0)
      ? (HEIGHTS[br * COLS + bc] - HMIN) : 0;
    // Vertical posts at each end
    segVerts.push(x0, hh, z0, x0, hh + wallH, z0);
    segVerts.push(x1, hh, z1, x1, hh + wallH, z1);
    // Horizontal top
    segVerts.push(x0, hh + wallH, z0, x1, hh + wallH, z1);
  }
  const segGeo = new THREE.BufferGeometry();
  segGeo.setAttribute('position', new THREE.Float32BufferAttribute(segVerts, 3));
  const segMat = new THREE.LineBasicMaterial({ color: 0x6a6a9a, linewidth: 1 });
  scene.add(new THREE.LineSegments(segGeo, segMat));
}

// Entities — built as a group so we can update positions in-place on poll.
const entityGroup = new THREE.Group();
scene.add(entityGroup);

// Target beacon: a tall, pulsating cylinder pointing down from above at the
// decider's current target. Makes it obvious what the character is engaging.
let targetBeacon = null;
function setTargetBeacon(t) {
  // Remove existing.
  if (targetBeacon) {
    targetBeacon.group.traverse(n => { n.geometry?.dispose?.(); n.material?.map?.dispose?.(); n.material?.dispose?.(); });
    scene.remove(targetBeacon.group);
    targetBeacon = null;
  }
  if (!t) return;
  const x = t.x + 0.5, z = t.z + 0.5;
  const oh = heightAt(t.x, t.z);
  const group = new THREE.Group();
  const shaftGeo = new THREE.CylinderGeometry(0.18, 0.35, 22, 16, 1, true);
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0xff2255, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.set(x, 11 + oh, z);
  group.add(shaft);
  const ringGeo = new THREE.RingGeometry(0.5, 0.85, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff2255, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.05 + oh, z);
  group.add(ring);
  const label = makeLabel('TARGET: ' + (t.name || '?'), '#ff5577');
  label.position.set(x, 23 + oh, z);
  label.scale.set(5, 1.2, 1);
  group.add(label);
  scene.add(group);
  targetBeacon = { group, shaftMat, ring, ringMat };
}
setTargetBeacon(TARGET);
// Self beacon: the same tall-beacon treatment for our own character, so he is
// findable at a glance in a big room (the ground ring alone gets lost).
let selfBeacon = null;
function setSelfBeacon(s) {
  // Remove existing.
  if (selfBeacon) {
    selfBeacon.group.traverse(n => { n.geometry?.dispose?.(); n.material?.map?.dispose?.(); n.material?.dispose?.(); });
    scene.remove(selfBeacon.group);
    selfBeacon = null;
  }
  if (!s) return;
  const x = s.x + 0.5, z = s.z + 0.5;
  const oh = heightAt(s.x, s.z);
  const group = new THREE.Group();
  const shaftGeo = new THREE.CylinderGeometry(0.18, 0.35, 22, 16, 1, true);
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0x44ffaa, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.set(x, 11 + oh, z);
  group.add(shaft);
  const ringGeo = new THREE.RingGeometry(0.5, 0.85, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x44ffaa, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.05 + oh, z);
  group.add(ring);
  const label = makeLabel('YOU: ' + (s.name || '?'), '#55ffaa');
  label.position.set(x, 23 + oh, z);
  label.scale.set(5, 1.2, 1);
  group.add(label);
  scene.add(group);
  selfBeacon = { group, shaftMat, ring, ringMat };
}
setSelfBeacon((OBJECTS || []).find(o => o.t === 0) ?? null);
const colors = [0x44ffaa, 0xff4444, 0xffaa44];
const selfRing = { mesh: null };

function heightAt(c, r) {
  if (!HEIGHTS || c < 0 || r < 0 || c >= COLS || r >= ROWS) return 0;
  const h = HEIGHTS[r * COLS + c];
  return (h != null && h >= 0) ? (h - HMIN) : 0;
}

function makeLabel(text, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 28px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 44);
  const tex = new THREE.CanvasTexture(cv);
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
}

let facingArrow = null;
let targetRing = null;

function buildEntities(objs, facing, targetId, targetInBand) {
  // Clear existing
  while (entityGroup.children.length) {
    const ch = entityGroup.children[0];
    entityGroup.remove(ch);
    ch.traverse?.(n => { n.geometry?.dispose?.(); n.material?.map?.dispose?.(); n.material?.dispose?.(); });
  }
  selfRing.mesh = null;
  facingArrow = null;
  targetRing = null;
  for (const o of objs) {
    const cx = Math.min(Math.max(o.x, 0), COLS - 1);
    const cz = Math.min(Math.max(o.z, 0), ROWS - 1);
    const x = cx + 0.5, z = cz + 0.5;
    const oh = heightAt(cx, cz);
    const r = o.t === 0 ? 0.45 : 0.3;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 12),
      new THREE.MeshLambertMaterial({ color: colors[o.t], emissive: o.t === 0 ? 0x228844 : 0x000000 })
    );
    body.position.set(x, r + 0.1 + oh, z);
    body.castShadow = true;
    entityGroup.add(body);
    if (o.t === 0) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.75, 32),
        new THREE.MeshBasicMaterial({ color: 0x44ffaa, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.02 + oh, z);
      entityGroup.add(ring);
      selfRing.mesh = ring;
      // Facing arrow: a small cone pointing in the character's facing direction.
      // degrees: 0=east, 90=south, 180=west, 270=north (game convention).
      // In Three.js: 0=east(+x), 90=south(+z), 180=west(-x), 270=north(-z).
      if (facing != null) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.15, 0.6, 8),
          new THREE.MeshBasicMaterial({ color: 0x44ffaa })
        );
        // Cone points +Y by default; rotate to point horizontally.
        cone.rotation.z = -Math.PI / 2;  // now points +X (east)
        // Game degrees: 0=east, 90=south. Three.js rotation around Y: 0=+X, PI/2=+Z.
        // So game_degrees maps directly to Y-rotation in radians.
        const holder = new THREE.Group();
        holder.add(cone);
        holder.position.set(x, 0.3 + oh, z);
        holder.rotation.y = -(facing * Math.PI / 180);
        entityGroup.add(holder);
        facingArrow = holder;
      }
    }
    // Target reticle: color indicates intent.
    //   orange = in-band, will fight
    //   red    = out-of-band, will flee (danger)
    if (targetId != null && o.t !== 0 && o._objId === targetId) {
      const ringColor = targetInBand ? 0xff9933 : 0xff3333;
      const tring = new THREE.Mesh(
        new THREE.RingGeometry(0.4, 0.65, 32),
        new THREE.MeshBasicMaterial({ color: ringColor, side: THREE.DoubleSide, transparent: true, opacity: 0.8 })
      );
      tring.rotation.x = -Math.PI / 2;
      tring.position.set(x, 0.04 + oh, z);
      entityGroup.add(tring);
      targetRing = tring;
      // Small text label above the ring: FIGHT or FLEE
      const label = makeLabel(targetInBand ? 'FIGHT' : 'FLEE!', '#' + ringColor.toString(16).padStart(6, '0'));
      label.position.set(x, 1.2 + oh, z);
      label.scale.set(2.5, 0.7, 1);
      entityGroup.add(label);
    }
    const hex = '#' + colors[o.t].toString(16).padStart(6, '0');
    const sprite = makeLabel(o.n, hex);
    sprite.position.set(x, 2.0 + oh, z);
    sprite.scale.set(3.5, 0.9, 1);
    entityGroup.add(sprite);
  }
}
buildEntities(OBJECTS, null, null, null);

// Background poll: update entities + vitals every 3s without reloading.
let entityKey = null;
let roomNum = null; // current room number for change detection
async function pollData() {
  try {
    const res = await fetch('/room3d-data/${name}');
    if (!res.ok) return;
    const d = await res.json();
    // ROOM CHANGE: the static page (walls, grid, dimensions) is baked in at
    // render time. When the character moves to a new room, we must reload
    // the entire page to get the new geometry. A room NUMBER change is the
    // reliable signal (names can repeat, numbers don't within a session).
    if (d.roomNum != null) {
      if (roomNum === null) roomNum = d.roomNum; // first poll: record
      else if (d.roomNum !== roomNum) {
        // New room — reload the page to pick up the new walls/grid/heights
        window.location.reload();
        return;
      }
    }
    // Update room name in HUD (cosmetic; geometry is already correct)
    if (d.room && d.room !== roomName) {
      const dimEl = document.querySelector('#hud .dim');
      if (dimEl) dimEl.innerHTML =
        ' &middot; ' + d.room + ' &middot; ' + d.cols + '&times;' + d.rows + ' &middot; <span style="color:#4a9">&bull;</span>';
      roomName = d.room;
    }
    // Update entities in-place (only rebuild if the set or facing/target changed)
    var targetId = d.target ? d.target.id : null;
    var targetInBand = d.target ? !!d.target.in_band : null;
    var key = JSON.stringify((d.objects || []).map(function(o) { return o.n + o.t + o.x + ',' + o.z + (o.id || ''); })) + 'f' + (d.facing ?? '') + 't' + (targetId ?? '') + 'b' + (targetInBand ?? '');
    if (key !== entityKey) {
      // Attach _objId to each object for target matching
      var objs = (d.objects || []).map(function(o) { o._objId = o.id; return o; });
      buildEntities(objs, d.facing, targetId, targetInBand);
      entityKey = key;
      // Update the tall target beacon to track the current target.
      var tObj = (d.objects || []).find(function(o) { return o._objId === targetId; });
      setTargetBeacon(tObj ? { x: tObj.x, z: tObj.z, name: tObj.n } : null);
      // Update the self beacon to track our own character.
      var sObj = (d.objects || []).find(function(o) { return o.t === 0; });
      setSelfBeacon(sObj ? { x: sObj.x, z: sObj.z, name: sObj.n } : null);
    }
    // Update the debug path overlay (fine path + direct raycast) on EVERY poll —
    // the path can replan even when the entity set is unchanged.
    setPath3d(d.path3d || null);
    // Update vitals
    if (d.vitals) {
      const v = d.vitals;
      function setBar(sel, val, max) {
        const el = document.querySelector(sel);
        if (el && max) el.style.width = Math.round((val / max) * 100) + '%';
      }
      setBar('#hud .bar.hp', v.hp, v.hpMax);
      setBar('#hud .bar.mana', v.mp, v.mpMax);
      setBar('#hud .bar.vigor', v.vig, v.vigMax);
      const stats = document.querySelector('#hud .stats');
      if (stats) {
        var goapStr = '';
        if (d.goap && d.goap.goal) {
          var planTitle = (d.goap.plan || '').replace(/"/g, '&quot;');
          goapStr = ' <span style="color:#888" title="' + planTitle + '">\u25b8 ' + d.goap.goal + (d.goap.action ? ' \u2192 ' + d.goap.action : '') + '</span>';
        }
        var hiddenSpan = HIDDEN && HIDDEN.length ? '<span style="color:#ffcc33">\u25c6 ' + HIDDEN.length + ' hidden</span>' : '';
        stats.innerHTML =
          '<span class="hp">HP ' + (v.hp ?? '?') + '/' + (v.hpMax ?? '?') + '</span>' +
          '<span class="mana">MP ' + (v.mp ?? '?') + '/' + (v.mpMax ?? '?') + '</span>' +
          '<span class="vigor">VIG ' + (v.vig ?? '?') + '/' + (v.vigMax ?? '?') + '</span>' +
          hiddenSpan + goapStr;
      }
    }
  } catch (e) {}
}
pollData();
setInterval(pollData, 3000);

// Animate
let _t0 = performance.now();
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  // Pulse the beacons: rings expand + fade, shafts shimmer. Target runs hot
  // red, self runs green; shared phase so they read as a pair.
  if (targetBeacon || selfBeacon) {
    const t = (performance.now() - _t0) / 1000;
    const pulse = (Math.sin(t * 4) + 1) / 2;  // 0..1, ~1.5Hz
    for (const b of [targetBeacon, selfBeacon]) {
      if (!b) continue;
      b.ringMat.opacity = 0.4 + 0.6 * pulse;
      const s = 0.7 + 0.9 * pulse;
      b.ring.scale.set(s, s, 1);
      b.shaftMat.opacity = 0.25 + 0.35 * pulse;
      // Slow spin of the shaft for extra visibility.
      b.group.children[0].rotation.y = t * 0.8;
    }
  }
  renderer.render(scene, camera);
})();

// Resize
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

} catch (e) {
  document.getElementById('err').textContent =
    '3D error: ' + e.message + '\\n' + (e.stack || '').split('\\n').slice(0, 3).join('\\n');
  document.getElementById('err').style.display = 'block';
}
</script>
</body></html>`;
}
