// Classic clothing: composites body colors + Pants + Shirt + ShirtGraphic templates (585x559) and
// maps them onto character limbs — per face for blocky parts, as a whole texture for R15 MeshParts
// (whose UVs follow the same template layout).
import * as THREE from 'three';

const W = 585, H = 559;
// template regions [x, y, w, h] per box face as seen from outside
const TORSO = { F: [231, 74, 128, 128], B: [427, 74, 128, 128], R: [165, 74, 64, 128], L: [361, 74, 64, 128], U: [231, 8, 128, 64], D: [231, 204, 128, 64] };
const RIGHT = { F: [217, 355, 64, 128], B: [85, 355, 64, 128], R: [151, 355, 64, 128], L: [19, 355, 64, 128], U: [217, 289, 64, 64], D: [217, 485, 64, 64] };
const LEFT = { F: [308, 355, 64, 128], B: [440, 355, 64, 128], R: [506, 355, 64, 128], L: [374, 355, 64, 128], U: [308, 289, 64, 64], D: [308, 485, 64, 64] };
// limb -> [layout, layer ('upper' = shirt, 'lower' = pants), vertical slice [from, to] of the 128px faces]
const LIMBS = {
  Torso: [TORSO, 'upper', [0, 1]], UpperTorso: [TORSO, 'upper', [0, 0.8]], LowerTorso: [TORSO, 'upper', [0.8, 1]],
  'Right Arm': [RIGHT, 'upper', [0, 1]], RightUpperArm: [RIGHT, 'upper', [0, 0.5]], RightLowerArm: [RIGHT, 'upper', [0.5, 0.875]], RightHand: [RIGHT, 'upper', [0.875, 1]],
  'Left Arm': [LEFT, 'upper', [0, 1]], LeftUpperArm: [LEFT, 'upper', [0, 0.5]], LeftLowerArm: [LEFT, 'upper', [0.5, 0.875]], LeftHand: [LEFT, 'upper', [0.875, 1]],
  'Right Leg': [RIGHT, 'lower', [0, 1]], RightUpperLeg: [RIGHT, 'lower', [0, 0.5]], RightLowerLeg: [RIGHT, 'lower', [0.5, 0.875]], RightFoot: [RIGHT, 'lower', [0.875, 1]],
  'Left Leg': [LEFT, 'lower', [0, 1]], LeftUpperLeg: [LEFT, 'lower', [0, 0.5]], LeftLowerLeg: [LEFT, 'lower', [0.5, 0.875]], LeftFoot: [LEFT, 'lower', [0.875, 1]],
};
// three.js box material order: +X, -X, +Y, -Y, +Z, -Z  ->  right, left, up, down, back, front
const FACE_ORDER = ['R', 'L', 'U', 'D', 'B', 'F'];

const cssColor = (c) => (c ? `rgb(${Math.round(c.R * 255)},${Math.round(c.G * 255)},${Math.round(c.B * 255)})` : '#a3a2a5');

export const isClothedLimb = (part) => !!LIMBS[part.props.Name] && !!part.parent && !!part.parent.findFirstChildOfClass?.('Humanoid') && clothingOf(part.parent) !== null;
export function clothingOf(model) {
  let shirt = null, pants = null, graphic = null;
  for (const c of model.children) {
    if (c.ClassName === 'Shirt' && c.props.ShirtTemplate) shirt = c.props.ShirtTemplate;
    else if (c.ClassName === 'Pants' && c.props.PantsTemplate) pants = c.props.PantsTemplate;
    else if (c.ClassName === 'ShirtGraphic' && c.props.Graphic) graphic = c.props.Graphic;
  }
  return shirt || pants || graphic ? { shirt, pants, graphic } : null;
}

const cache = new Map(); // model -> { key, promise }
async function loadImage(assets, content) {
  if (!content) return null;
  try { return await assets.image(content); } catch { return null; }
}

/** Both template layers for a character: { upper: canvas, lower: canvas } */
export function composite(model, assets) {
  const cl = clothingOf(model);
  const colorOf = (n) => { const p = model.findFirstChild(n); return p ? p.props.Color : null; };
  const torso = colorOf('Torso') || colorOf('UpperTorso');
  const ra = colorOf('Right Arm') || colorOf('RightUpperArm'), la = colorOf('Left Arm') || colorOf('LeftUpperArm');
  const rl = colorOf('Right Leg') || colorOf('RightUpperLeg'), ll = colorOf('Left Leg') || colorOf('LeftUpperLeg');
  const key = JSON.stringify([cl, [torso, ra, la, rl, ll].map(cssColor)]);
  const hit = cache.get(model);
  if (hit && hit.key === key) return hit.promise;
  const promise = (async () => {
    const [shirt, pants, graphic] = await Promise.all([loadImage(assets, cl && cl.shirt), loadImage(assets, cl && cl.pants), loadImage(assets, cl && cl.graphic)]);
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const fill = (g, layout, color) => { g.fillStyle = cssColor(color); for (const r of Object.values(layout)) g.fillRect(r[0], r[1], r[2], r[3]); };
    const upper = mk(), lower = mk();
    const gu = upper.getContext('2d'), gl = lower.getContext('2d');
    fill(gu, TORSO, torso); fill(gu, RIGHT, ra); fill(gu, LEFT, la);
    if (pants) { gu.save(); gu.beginPath(); for (const r of Object.values(TORSO)) gu.rect(...r); gu.clip(); gu.drawImage(pants, 0, 0, W, H); gu.restore(); }
    if (shirt) gu.drawImage(shirt, 0, 0, W, H);
    if (graphic) { const f = TORSO.F; gu.drawImage(graphic, f[0] + 8, f[1] + 8, f[2] - 16, f[3] - 16); }
    fill(gl, TORSO, torso); fill(gl, RIGHT, rl); fill(gl, LEFT, ll);
    if (pants) gl.drawImage(pants, 0, 0, W, H);
    return { upper, lower };
  })();
  cache.set(model, { key, promise });
  return promise;
}

const tex = (canvas) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };

/** Six materials (box face order) for a blocky limb. */
export function faceMaterials(part, layers, transparency) {
  const [layout, layer, [a, b]] = LIMBS[part.props.Name];
  const src = layers[layer];
  return FACE_ORDER.map((f) => {
    const r = layout[f];
    let [x, y, w, h] = r;
    if (f !== 'U' && f !== 'D') { y += h * a; h *= (b - a); }
    if ((f === 'U' && a > 0) || (f === 'D' && b < 1)) {
      // inner caps of split R15 limbs: plain color taken from the face edge
      const c = document.createElement('canvas'); c.width = 4; c.height = 4;
      const g = c.getContext('2d'); g.drawImage(src, layout.F[0] + 2, layout.F[1] + layout.F[3] * (f === 'U' ? a : b) - 2, 1, 1, 0, 0, 4, 4);
      return new THREE.MeshStandardMaterial({ map: tex(c), roughness: 0.75, transparent: transparency > 0, opacity: 1 - transparency });
    }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * 2)); c.height = Math.max(1, Math.round(h * 2));
    const g = c.getContext('2d');
    // three.js box caps face the other way round than the template's folded U / D squares
    if (f === 'U' || f === 'D') { g.translate(c.width, c.height); g.rotate(Math.PI); }
    g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    return new THREE.MeshStandardMaterial({ map: tex(c), roughness: 0.75, transparent: transparency > 0, opacity: 1 - transparency });
  });
}

/** Whole-template texture for an R15 MeshPart limb. */
export function meshTexture(part, layers) {
  const [, layer] = LIMBS[part.props.Name];
  return tex(layers[layer]);
}
