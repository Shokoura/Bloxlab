// Terrain tools (Model tab): Generate, brush (add material where you click) and Clear.
// Shapes go into Terrain.Voxels, so they replicate, collide, undo and save (as an attribute).
import { h, dialog, toast, confirmBox } from './ui.js';
import { CFrame, Vector3 } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { TERRAIN_COLORS } from '../render/terrain.js';

const MATERIALS = Object.keys(TERRAIN_COLORS);

function terrainOf(app) { return app.dm().findFirstChildOfClass('Workspace').findFirstChildOfClass('Terrain'); }

// small deterministic value noise
function noise2(seed) {
  const hash = (x, z) => { let n = (x * 374761393 + z * 668265263 + seed * 2147483647) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967295; };
  const smooth = (t) => t * t * (3 - 2 * t);
  const at = (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = smooth(x - x0), fz = smooth(z - z0);
    const a = hash(x0, z0), b = hash(x0 + 1, z0), c = hash(x0, z0 + 1), d = hash(x0 + 1, z0 + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
  return (x, z) => at(x, z) * 0.55 + at(x * 2.1, z * 2.1) * 0.3 + at(x * 4.3, z * 4.3) * 0.15;
}

export function generateDialog(app) {
  const size = h('input', { class: 'input', type: 'number', value: 256, min: 32, max: 1024, step: 32 });
  const height = h('input', { class: 'input', type: 'number', value: 40, min: 4, max: 400 });
  const water = h('input', { class: 'input', type: 'number', value: 8, min: 0, max: 400 });
  const seed = h('input', { class: 'input', type: 'number', value: Math.floor(Math.random() * 10000) });
  const biome = h('select', { class: 'input' }, ['Grassland', 'Desert', 'Snow', 'Rocky'].map((b) => h('option', { value: b }, b)));
  dialog({
    title: 'Generate Terrain',
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { text: 'Size (studs)' }), size),
      h('label', { class: 'field' }, h('span', { text: 'Hill height (studs)' }), height),
      h('label', { class: 'field' }, h('span', { text: 'Water level (0 = none)' }), water),
      h('label', { class: 'field' }, h('span', { text: 'Biome' }), biome),
      h('label', { class: 'field' }, h('span', { text: 'Seed' }), seed)),
    buttons: [{ label: 'Cancel' }, { label: 'Generate', primary: true, onClick: () => generate(app, { size: Number(size.value), height: Number(height.value), water: Number(water.value), seed: Number(seed.value), biome: biome.value }) }],
  });
}

export function generate(app, { size = 256, height = 40, water = 8, seed = 1, biome = 'Grassland' }) {
  const t = terrainOf(app);
  if (!t) return;
  const top = { Grassland: 'Grass', Desert: 'Sand', Snow: 'Snow', Rocky: 'Rock' }[biome] || 'Grass';
  const under = { Grassland: 'Ground', Desert: 'Sandstone', Snow: 'Glacier', Rocky: 'Slate' }[biome] || 'Ground';
  const n = noise2(seed);
  const cells = Math.max(4, Math.round(size / 4));
  const half = (cells * 4) / 2;
  const base = -8;
  const shapes = [];
  for (let i = 0; i < cells; i++) for (let k = 0; k < cells; k++) {
    const x = -half + i * 4 + 2, z = -half + k * 4 + 2;
    const hgt = Math.max(4, Math.round((n(i / 12, k / 12) * height) / 4) * 4);
    const topY = base + hgt;
    if (hgt > 4) shapes.push([new CFrame(x, base + (hgt - 4) / 2, z), new Vector3(4, hgt - 4, 4), E('Material', under), 'box']);
    shapes.push([new CFrame(x, topY - 2, z), new Vector3(4, 4, 4), E('Material', topY - 2 < base + water + 2 && water > 0 ? 'Sand' : top), 'box']);
  }
  if (water > 0) shapes.push([new CFrame(0, base + water / 2, 0), new Vector3(cells * 4, water, cells * 4), E('Material', 'Water'), 'box']);
  app.history.run('Generate Terrain', () => t.rawSet('Voxels', [...(t.props.Voxels || []), ...shapes]));
  toast(`Generated ${shapes.length} terrain cells`);
}

export async function clearTerrain(app) {
  const t = terrainOf(app);
  if (!t || !(await confirmBox('Clear terrain', 'Remove all terrain from this place?', 'Clear'))) return;
  app.history.run('Clear Terrain', () => { t.rawSet('Voxels', []); t.rawSet('SmoothGrid', new Uint8Array([1, 5])); });
}

/** Brush settings shared by the viewport terrain tool. */
export const brush = { material: 'Grass', radius: 6 };
export function brushDialog(app) {
  const mat = h('select', { class: 'input' }, MATERIALS.map((m) => h('option', { value: m }, m)));
  mat.value = brush.material;
  const rad = h('input', { class: 'input', type: 'range', min: 2, max: 32, value: brush.radius });
  const lbl = h('span', { class: 'muted small', text: `${brush.radius} studs` });
  rad.addEventListener('input', () => { lbl.textContent = `${rad.value} studs`; });
  dialog({
    title: 'Terrain Brush',
    body: h('div', {}, h('label', { class: 'field' }, h('span', { text: 'Material' }), mat), h('label', { class: 'field' }, h('span', { text: 'Size' }), rad, lbl),
      h('p', { class: 'muted small', text: 'With the Brush tool on, click or drag in the viewport to add terrain.' })),
    buttons: [{ label: 'OK', primary: true, onClick: () => { brush.material = mat.value; brush.radius = Number(rad.value); app.setTool('terrain'); } }],
  });
}

/** Adds a ball of terrain at a viewport point (called by the viewport while the brush tool is active). */
export function stroke(app, point, normal) {
  const t = terrainOf(app);
  if (!t) return;
  const r = brush.radius;
  const c = new Vector3(point.x + (normal ? normal.x * r * 0.4 : 0), point.y + (normal ? normal.y * r * 0.4 : 0), point.z + (normal ? normal.z * r * 0.4 : 0));
  t.rawSet('Voxels', [...(t.props.Voxels || []), [new CFrame(c.X, c.Y, c.Z), new Vector3(r * 2, r * 2, r * 2), E('Material', brush.material), 'ball']]);
}
