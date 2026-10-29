// Roblox-like materials built from procedural (tileable) textures.
import * as THREE from 'three';

const SIZE = 256;
const texCache = new Map();
const matCache = new Map();

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; }; }

// tileable value noise
function noiseField(seed, cells) {
  const r = rng(seed);
  const g = Array.from({ length: cells * cells }, () => r());
  const at = (x, y) => g[((y % cells + cells) % cells) * cells + ((x % cells + cells) % cells)];
  return (u, v) => {
    const x = u * cells, y = v * cells;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}
function fbm(seed, base, oct = 4) {
  const fields = Array.from({ length: oct }, (_, i) => noiseField(seed + i * 101, base << i));
  return (u, v) => { let s = 0, amp = 0.5, tot = 0; for (const f of fields) { s += f(u, v) * amp; tot += amp; amp *= 0.5; } return s / tot; };
}

function canvasTex(draw, { alpha = false, repeat = true } = {}) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [l, a = 1] = draw(x / SIZE, y / SIZE, x, y);
      const i = (y * SIZE + x) * 4;
      const v = Math.max(0, Math.min(255, Math.round(l * 255)));
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = alpha ? Math.round(a * 255) : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const PATTERNS = {
  Plastic: () => { const n = fbm(1, 8, 3); return (u, v) => [0.95 + n(u, v) * 0.05]; },
  SmoothPlastic: () => () => [1],
  Wood: () => { const n = fbm(2, 4, 4); return (u, v) => { const w = Math.sin((v * 18 + n(u, v) * 4) * Math.PI) * 0.5 + 0.5; return [0.72 + w * 0.2 + n(u * 3, v) * 0.08]; }; },
  WoodPlanks: () => { const n = fbm(3, 4, 4); return (u, v) => { const plank = Math.floor(v * 4); const off = (plank * 0.37) % 1; const seam = (v * 4) % 1 < 0.03 || ((u + off) * 2) % 1 < 0.01 ? 0.55 : 1; const w = Math.sin((v * 40 + n(u + off, v) * 3) * Math.PI) * 0.5 + 0.5; return [seam * (0.7 + w * 0.18 + (plank % 2) * 0.05)]; }; },
  Grass: () => { const n = fbm(4, 16, 4); const r = rng(9); const sp = Array.from({ length: SIZE * SIZE }, () => r()); return (u, v, x, y) => [0.7 + n(u, v) * 0.25 + (sp[y * SIZE + x] > 0.93 ? 0.12 : 0)]; },
  LeafyGrass: () => PATTERNS.Grass(),
  Sand: () => { const r = rng(5); const n = fbm(6, 8, 3); return (u, v) => [0.82 + r() * 0.12 + n(u, v) * 0.06]; },
  Concrete: () => { const r = rng(7); const n = fbm(8, 8, 4); return (u, v) => [0.75 + n(u, v) * 0.18 + (r() > 0.97 ? -0.15 : r() * 0.06)]; },
  Brick: () => { const n = fbm(10, 8, 3); return (u, v) => { const row = Math.floor(v * 8); const off = row % 2 ? 0.125 : 0; const mortar = (v * 8) % 1 < 0.1 || ((u + off) * 4) % 1 < 0.05; return [mortar ? 0.95 : 0.6 + n(u, v) * 0.25]; }; },
  Cobblestone: () => { const n = fbm(11, 6, 4); const cells = 5; const r = rng(12); const pts = Array.from({ length: cells * cells }, (_, i) => [(i % cells + r()) / cells, (Math.floor(i / cells) + r()) / cells]); return (u, v) => { let d1 = 9, d2 = 9; for (const [px, py] of pts) for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) { const dx = u - px - ox, dy = v - py - oy; const d = dx * dx + dy * dy; if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; } const edge = Math.sqrt(d2) - Math.sqrt(d1); return [edge < 0.02 ? 0.45 : 0.68 + n(u, v) * 0.25]; }; },
  Pebble: () => PATTERNS.Cobblestone(),
  Slate: () => { const n = fbm(13, 4, 5); return (u, v) => { const h = n(u, v); return [0.62 + h * 0.3 + (Math.abs(((h * 6) % 1) - 0.5) < 0.04 ? -0.12 : 0)]; }; },
  Granite: () => { const r = rng(14); const n = fbm(15, 16, 3); return (u, v) => [0.65 + n(u, v) * 0.2 + (r() > 0.9 ? r() * 0.25 : 0)]; },
  Marble: () => { const n = fbm(16, 4, 5); return (u, v) => { const t = Math.sin((u * 3 + v * 2 + n(u, v) * 5) * Math.PI); return [0.85 + Math.abs(t) * 0.13 - (Math.abs(t) < 0.06 ? 0.25 : 0)]; }; },
  Metal: () => { const n = fbm(17, 32, 2); return (u, v) => [0.82 + n(u * 0.2, v) * 0.12]; },
  CorrodedMetal: () => { const n = fbm(18, 6, 5); return (u, v) => { const h = n(u, v); return [h > 0.55 ? 0.55 + h * 0.2 : 0.8 + h * 0.15]; }; },
  DiamondPlate: () => { const n = fbm(19, 32, 2); return (u, v) => { const gx = (u * 8) % 1, gy = (v * 8) % 1; const row = Math.floor(v * 8) % 2; const d = row ? Math.abs(gx - gy) : Math.abs(gx + gy - 1); return [(d < 0.12 ? 1 : 0.78) + n(u, v) * 0.06]; }; },
  Foil: () => { const n = fbm(20, 8, 4); return (u, v) => [0.75 + n(u, v) * 0.25]; },
  Fabric: () => { const n = fbm(21, 16, 2); return (u, v, x, y) => [0.78 + ((x + y) % 4 < 2 ? 0.08 : 0) + ((x - y + 1000) % 4 < 2 ? 0.05 : 0) + n(u, v) * 0.06]; },
  Ice: () => { const n = fbm(22, 4, 4); return (u, v) => [0.88 + n(u, v) * 0.12]; },
  Glacier: () => PATTERNS.Ice(),
  Snow: () => { const n = fbm(23, 8, 3); return (u, v) => [0.92 + n(u, v) * 0.08]; },
  Rock: () => PATTERNS.Slate(),
  Basalt: () => PATTERNS.Slate(),
  Ground: () => PATTERNS.Sand(),
  Mud: () => PATTERNS.Sand(),
  Asphalt: () => PATTERNS.Granite(),
  Limestone: () => PATTERNS.Concrete(),
  Pavement: () => PATTERNS.Concrete(),
  Sandstone: () => PATTERNS.Slate(),
  Salt: () => PATTERNS.Sand(),
  CrackedLava: () => PATTERNS.Cobblestone(),
};

export function materialTexture(name) {
  const k = PATTERNS[name] ? name : 'Plastic';
  let t = texCache.get(k);
  if (!t) { t = canvasTex(PATTERNS[k]()); texCache.set(k, t); }
  return t;
}

// Classic studs (top) / inlets (bottom) overlay, 1 stud per tile cell
export function studsTexture(inlet = false) {
  const k = inlet ? 'inlet' : 'studs';
  let t = texCache.get(k);
  if (t) return t;
  t = canvasTex((u, v) => {
    const dx = (u % 0.5) * 2 - 0.5, dy = (v % 0.5) * 2 - 0.5;
    const d = Math.hypot(dx, dy);
    if (d < 0.3) return inlet ? [0.75] : [1.0 - (dy > 0 ? 0.08 : 0) + (dx < 0 ? 0.04 : 0)];
    if (d < 0.34) return [inlet ? 0.95 : 0.78];
    return [0.92];
  });
  texCache.set(k, t);
  return t;
}

export function trussTexture() {
  let t = texCache.get('truss');
  if (t) return t;
  t = canvasTex((u, v) => {
    const e = 0.12;
    const bar = u < e || u > 1 - e || v < e || v > 1 - e || Math.abs(u - v) < e * 0.6;
    return [bar ? 0.95 : 0, bar ? 1 : 0];
  }, { alpha: true });
  texCache.set('truss', t);
  return t;
}

const MAT_PARAMS = {
  Plastic: { roughness: 0.75, metalness: 0 }, SmoothPlastic: { roughness: 0.55, metalness: 0 }, Neon: { neon: true },
  Wood: { roughness: 0.85 }, WoodPlanks: { roughness: 0.85 }, Marble: { roughness: 0.35 }, Slate: { roughness: 0.9 }, Concrete: { roughness: 0.95 },
  Granite: { roughness: 0.7 }, Brick: { roughness: 0.95 }, Pebble: { roughness: 0.9 }, Cobblestone: { roughness: 0.9 }, Rock: { roughness: 0.9 },
  CorrodedMetal: { roughness: 0.8, metalness: 0.4 }, DiamondPlate: { roughness: 0.4, metalness: 0.7 }, Foil: { roughness: 0.25, metalness: 0.8 },
  Metal: { roughness: 0.35, metalness: 0.75 }, Grass: { roughness: 1 }, LeafyGrass: { roughness: 1 }, Sand: { roughness: 1 }, Fabric: { roughness: 1 },
  Ice: { roughness: 0.15, transparent: 0.1 }, Glacier: { roughness: 0.2 }, Glass: { glass: true }, ForceField: { forcefield: true },
};

const srgb = (c) => new THREE.Color().setRGB(c.R, c.G, c.B, THREE.SRGBColorSpace);

/**
 * Shared material for (material, color, transparency, reflectance, surface overlay).
 * overlay: null | 'studs' | 'inlet'
 */
export function partMaterial(matName, color, transparency = 0, reflectance = 0, overlay = null, opts = {}) {
  const k = `${matName}|${color.R.toFixed(3)},${color.G.toFixed(3)},${color.B.toFixed(3)}|${transparency.toFixed(3)}|${reflectance.toFixed(2)}|${overlay}|${opts.truss ? 1 : 0}|${opts.doubleSide ? 1 : 0}`;
  let m = matCache.get(k);
  if (m) return m;
  const p = MAT_PARAMS[matName] || MAT_PARAMS.Plastic;
  const col = srgb(color);
  if (p.neon) {
    m = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.6) });
  } else if (p.forcefield) {
    m = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 * (1 - transparency), blending: THREE.AdditiveBlending, depthWrite: false });
  } else if (p.glass) {
    m = new THREE.MeshStandardMaterial({ color: col, roughness: 0.05, metalness: 0.1, transparent: true, opacity: Math.min(0.85, 0.45 * (1 - transparency) + 0.05 * (1 - transparency)) });
  } else {
    m = new THREE.MeshStandardMaterial({
      color: col,
      map: opts.truss ? trussTexture() : overlay ? studsTexture(overlay === 'inlet') : materialTexture(matName),
      roughness: Math.max(0.05, p.roughness * (1 - reflectance * 0.8)),
      metalness: Math.min(1, (p.metalness || 0) + reflectance * 0.5),
      alphaTest: opts.truss ? 0.5 : 0,
    });
    if (transparency > 0.001) { m.transparent = true; m.opacity = 1 - transparency; m.depthWrite = transparency < 0.5; }
  }
  if (opts.doubleSide || opts.truss) m.side = THREE.DoubleSide;
  if (transparency >= 0.999) m.visible = false;
  m.userData.shared = true;
  matCache.set(k, m);
  return m;
}

export function clearMaterialCache() { for (const m of matCache.values()) m.dispose(); matCache.clear(); }
export { srgb };
