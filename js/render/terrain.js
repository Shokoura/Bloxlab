// Terrain rendering + collision geometry: SmoothGrid voxels (4-stud cells) as blocky surfaces,
// plus the boxes / balls / cylinders that scripts add with Terrain:Fill*.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Color3 } from '../engine/datatypes.js';
import { decodeSmoothGrid, TERRAIN_MATERIALS } from '../formats/terrain.js';

export const TERRAIN_COLORS = {
  Grass: [106, 127, 63], Slate: [63, 127, 107], Concrete: [127, 102, 63], Brick: [138, 86, 62], Sand: [143, 126, 95], WoodPlanks: [139, 109, 79],
  Rock: [102, 108, 111], Glacier: [101, 176, 234], Snow: [195, 199, 218], Sandstone: [137, 90, 71], Mud: [58, 46, 36], Basalt: [30, 30, 37],
  Ground: [102, 92, 59], CrackedLava: [232, 156, 74], Asphalt: [115, 123, 107], Cobblestone: [132, 123, 90], Ice: [129, 194, 224],
  LeafyGrass: [115, 132, 74], Salt: [198, 189, 181], Limestone: [206, 173, 148], Pavement: [148, 148, 140], Water: [12, 84, 92],
};
const SOLID_MIN = 40; // occupancy (0..255) below which a cell is treated as empty
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SHADE = [0.86, 0.86, 1.0, 0.62, 0.93, 0.93];
// quad corners per face direction (unit cube 0..1)
const QUADS = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
];

/** Decoded voxel grid for a Terrain instance (cached until SmoothGrid changes). */
export function terrainGrid(t) {
  const sg = t.props.SmoothGrid;
  if (t.gridCache && t.gridCache.src === sg) return t.gridCache.grid;
  let grid = null;
  try { grid = decodeSmoothGrid(sg instanceof Uint8Array ? sg : null); } catch (e) { console.warn('[terrain]', e); }
  if (grid) {
    grid.map = new Map(grid.chunks.map((c) => [`${c.cx},${c.cy},${c.cz}`, c]));
    grid.cell = (x, y, z) => {
      const s = grid.size;
      const cx = Math.floor(x / s), cy = Math.floor(y / s), cz = Math.floor(z / s);
      const c = grid.map.get(`${cx},${cy},${cz}`);
      if (!c) return 0;
      const i = grid.at(x - cx * s, y - cy * s, z - cz * s);
      return c.occ[i] >= SOLID_MIN ? c.mat[i] : 0;
    };
  }
  t.gridCache = { src: sg, grid };
  return grid;
}

function colorOf(t, name) {
  const custom = t.materialColors && t.materialColors[name];
  if (custom) return [custom.R, custom.G, custom.B];
  const c = TERRAIN_COLORS[name] || [110, 110, 110];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

/**
 * Surface geometry of the voxel grid, per chunk: [{ solid: {pos, col, idx}, water: {...} }]
 */
export function terrainSurfaces(t) {
  const grid = terrainGrid(t);
  const out = [];
  if (!grid) return out;
  const s = grid.size;
  for (const c of grid.chunks) {
    const solid = { pos: [], col: [], idx: [] }, water = { pos: [], col: [], idx: [] };
    const ox = c.cx * s, oy = c.cy * s, oz = c.cz * s;
    for (let z = 0; z < s; z++) for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = grid.at(x, y, z);
      const m = c.mat[i];
      if (!m || c.occ[i] < SOLID_MIN) continue;
      const isWater = m === 1;
      const target = isWater ? water : solid;
      const base = colorOf(t, TERRAIN_MATERIALS[m]);
      const gx = ox + x, gy = oy + y, gz = oz + z;
      for (let d = 0; d < 6; d++) {
        const [dx, dy, dz] = DIRS[d];
        const n = grid.cell(gx + dx, gy + dy, gz + dz);
        if (isWater ? n !== 0 : (n !== 0 && n !== 1)) continue;
        const v0 = target.pos.length / 3;
        const k = SHADE[d] * (0.94 + ((gx * 73856093 ^ gy * 19349663 ^ gz * 83492791) & 15) / 160);
        for (const q of QUADS[d]) {
          target.pos.push((gx + q[0]) * 4, (gy + q[1]) * 4, (gz + q[2]) * 4);
          target.col.push(base[0] * k, base[1] * k, base[2] * k);
        }
        target.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      }
    }
    out.push({ solid, water });
  }
  return out;
}

const toGeom = (g) => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col.map((v) => Math.pow(v, 2.2)), 3));
  geo.setIndex(g.idx);
  geo.computeVertexNormals();
  return geo;
};

/** Shapes added by Terrain:Fill* scripts: [{ cf, size, material, shape }] */
export function terrainShapes(t) {
  return (t.props.Voxels || []).filter((v) => Array.isArray(v) && v[0] && v[1]).map(([cf, size, material, shape]) => ({ cf, size, material, shape }));
}

/** three.js group with the terrain surfaces and scripted fill shapes. */
export function buildTerrainObject(t) {
  const group = new THREE.Group();
  group.name = 'Terrain';
  const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const wc = t.props.WaterColor || new Color3(12 / 255, 84 / 255, 92 / 255);
  const waterMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(wc.R, wc.G, wc.B).convertSRGBToLinear(), transparent: true, opacity: Math.max(0.25, 1 - (t.props.WaterTransparency ?? 0.3)), roughness: 0.1, metalness: 0.1, depthWrite: false });
  for (const s of terrainSurfaces(t)) {
    if (s.solid.idx.length) { const m = new THREE.Mesh(toGeom(s.solid), solidMat); m.receiveShadow = true; m.castShadow = true; m.userData.inst = t; group.add(m); }
    if (s.water.idx.length) { const m = new THREE.Mesh(toGeom(s.water), waterMat); m.userData.inst = t; group.add(m); }
  }
  // fill shapes are merged into one mesh per material (generated terrain can have thousands)
  const byMat = new Map();
  for (const v of terrainShapes(t)) {
    const name = v.material ? v.material.Name : 'Grass';
    const geo = v.shape === 'cylinder' ? new THREE.CylinderGeometry(v.size.Y / 2, v.size.Y / 2, v.size.X, 20).rotateZ(Math.PI / 2)
      : v.shape === 'ball' ? new THREE.SphereGeometry(v.size.X / 2, 20, 14) : new THREE.BoxGeometry(v.size.X, v.size.Y, v.size.Z);
    const cf = v.cf, rr = cf.r;
    geo.applyMatrix4(new THREE.Matrix4().set(rr[0], rr[1], rr[2], cf.X, rr[3], rr[4], rr[5], cf.Y, rr[6], rr[7], rr[8], cf.Z, 0, 0, 0, 1));
    const flat = geo.index ? geo.toNonIndexed() : geo;
    if (flat !== geo) geo.dispose();
    if (!byMat.has(name)) byMat.set(name, []);
    byMat.get(name).push(flat);
  }
  for (const [name, geos] of byMat) {
    const merged = mergeGeometries(geos.map((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k); return g; }), false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const [r, g, b] = colorOf(t, name);
    const mat = name === 'Water' ? waterMat : new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b).convertSRGBToLinear(), roughness: 0.92 });
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = m.receiveShadow = name !== 'Water';
    m.userData.inst = t;
    group.add(m);
  }
  return group;
}
