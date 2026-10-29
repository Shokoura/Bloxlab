// Part geometries with world-scaled UVs (so material textures keep a constant density).
import * as THREE from 'three';

const cache = new Map();
const key = (...a) => a.map((x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)).join('|');

// face order: +X (Right), +Y (Top), +Z (Back), -X (Left), -Y (Bottom), -Z (Front) == Enum.NormalId values
const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** Box with one material group per face (group index = NormalId). UV units are studs / tile. */
export function boxGeometry(sx, sy, sz, tile = 4) {
  const k = key('box', sx, sy, sz, tile);
  let g = cache.get(k);
  if (g) return g;
  const pos = [], nor = [], uv = [], idx = [];
  const half = [sx / 2, sy / 2, sz / 2];
  const size = [sx, sy, sz];
  g = new THREE.BufferGeometry();
  FACES.forEach((f, fi) => {
    const base = pos.length / 3;
    const uLen = Math.abs(f.u[0] * size[0] + f.u[1] * size[1] + f.u[2] * size[2]);
    const vLen = Math.abs(f.v[0] * size[0] + f.v[1] * size[1] + f.v[2] * size[2]);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let c = 0; c < 3; c++) pos.push(f.n[c] * half[c] + f.u[c] * a * uLen / 2 + f.v[c] * b * vLen / 2);
      nor.push(...f.n);
      uv.push(((a + 1) / 2) * uLen / tile, ((b + 1) / 2) * vLen / tile);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.addGroup(fi * 6, 6, fi);
  });
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  cache.set(k, g);
  return g;
}

function polyGeometry(tris, tile) {
  // tris: array of [p0,p1,p2, group]
  const pos = [], nor = [], uv = [];
  const g = new THREE.BufferGeometry();
  let vi = 0;
  const byGroup = new Map();
  for (const t of tris) { if (!byGroup.has(t[3])) byGroup.set(t[3], []); byGroup.get(t[3]).push(t); }
  for (const [grp, list] of [...byGroup].sort((a, b) => a[0] - b[0])) {
    const start = vi;
    for (const [a, b, c] of list) {
      const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
      const n = new THREE.Vector3().crossVectors(ab, ac).normalize();
      // planar projection on the dominant axis for UVs
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      for (const p of [a, b, c]) {
        pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z);
        if (ax >= ay && ax >= az) uv.push(p.z / tile, p.y / tile);
        else if (ay >= az) uv.push(p.x / tile, p.z / tile);
        else uv.push(p.x / tile, p.y / tile);
      }
      vi += 3;
    }
    g.addGroup(start, vi - start, grp);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

/** Roblox WedgePart: tall side at the back (+Z), slope facing front/up. */
export function wedgeGeometry(sx, sy, sz, tile = 4) {
  const k = key('wedge', sx, sy, sz, tile);
  let g = cache.get(k);
  if (g) return g;
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const V = (a, b, c) => new THREE.Vector3(a, b, c);
  const b0 = V(-x, -y, -z), b1 = V(x, -y, -z), b2 = V(x, -y, z), b3 = V(-x, -y, z), t2 = V(x, y, z), t3 = V(-x, y, z);
  g = polyGeometry([
    [b0, b1, b2, 4], [b0, b2, b3, 4], // bottom
    [b3, b2, t2, 2], [b3, t2, t3, 2], // back
    [b1, b0, t3, 1], [b1, t3, t2, 1], // slope (counts as "top")
    [b1, t2, b2, 0], // right
    [b0, b3, t3, 3], // left
  ], tile);
  cache.set(k, g);
  return g;
}

/** Roblox CornerWedgePart: pyramid with the apex above the right-front corner. */
export function cornerWedgeGeometry(sx, sy, sz, tile = 4) {
  const k = key('cwedge', sx, sy, sz, tile);
  let g = cache.get(k);
  if (g) return g;
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const V = (a, b, c) => new THREE.Vector3(a, b, c);
  const b0 = V(-x, -y, -z), b1 = V(x, -y, -z), b2 = V(x, -y, z), b3 = V(-x, -y, z), top = V(x, y, -z);
  g = polyGeometry([
    [b0, b1, b2, 4], [b0, b2, b3, 4],
    [b1, top, b2, 0], // right
    [b0, top, b1, 5], // front
    [b2, top, b3, 1], // back slope
    [b3, top, b0, 1], // left slope
  ], tile);
  cache.set(k, g);
  return g;
}

export function sphereGeometry(sx, sy, sz, tile = 4) {
  const k = key('sphere', sx, sy, sz, tile);
  let g = cache.get(k);
  if (g) return g;
  g = new THREE.SphereGeometry(0.5, 32, 20);
  g.scale(sx, sy, sz);
  const uv = g.attributes.uv;
  const circ = Math.PI * Math.max(sx, sz);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / tile, uv.getY(i) * (Math.PI * sy / 2) / tile);
  g.clearGroups(); g.addGroup(0, Infinity, 0);
  cache.set(k, g);
  return g;
}

/** Cylinder along the X axis (Roblox Cylinder parts). */
export function cylinderGeometry(sx, sy, sz, tile = 4, axis = 'x') {
  const k = key('cyl', sx, sy, sz, tile, axis);
  let g = cache.get(k);
  if (g) return g;
  const r = axis === 'x' ? Math.min(sy, sz) / 2 : Math.min(sx, sz) / 2;
  const len = axis === 'x' ? sx : sy;
  g = new THREE.CylinderGeometry(r, r, len, 32, 1, false);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (2 * Math.PI * r) / tile, uv.getY(i) * len / tile);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  g.clearGroups(); g.addGroup(0, Infinity, 0);
  cache.set(k, g);
  return g;
}

/** Classic Roblox head: a cylinder with rounded edges. */
export function headGeometry(sx, sy, sz) {
  const k = key('head', sx, sy, sz);
  let g = cache.get(k);
  if (g) return g;
  const pts = [];
  const r = 0.5, h = 0.5, round = 0.18;
  pts.push(new THREE.Vector2(0, -h));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(r - round + Math.cos(a) * round, -h + round + Math.sin(a) * round)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(r - round + Math.cos(a) * round, h - round + Math.sin(a) * round)); }
  pts.push(new THREE.Vector2(0, h));
  g = new THREE.LatheGeometry(pts, 32);
  g.scale(sx, sy, sz);
  g.clearGroups(); g.addGroup(0, Infinity, 0);
  cache.set(k, g);
  return g;
}

/** Truss: box frame rendered with an alpha-tested lattice texture (see materials.js). */
export function trussGeometry(sx, sy, sz) { return boxGeometry(sx, sy, sz, 2); }

export function clearGeometryCache() { for (const g of cache.values()) g.dispose(); cache.clear(); }
