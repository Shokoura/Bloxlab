// Terrain.SmoothGrid decoding (best effort).
//
// The blob is: u8 version (1), u8 log2(chunk size) (5 -> 32^3 voxel chunks), then chunks. Each chunk
// is its index followed by run-length encoded voxels; a voxel byte holds the material in its low six
// bits plus two flags (an occupancy byte follows / a run-length byte follows). The exact chunk index
// encoding, flag assignment and voxel order are not publicly specified, so every plausible variant is
// tried, invalid parses are rejected, and the voxel order that makes the terrain look most like
// ground (solid below air) wins.

export const TERRAIN_MATERIALS = ['Air', 'Water', 'Grass', 'Slate', 'Concrete', 'Brick', 'Sand', 'WoodPlanks', 'Rock', 'Glacier', 'Snow', 'Sandstone', 'Mud', 'Basalt', 'Ground', 'CrackedLava', 'Asphalt', 'Cobblestone', 'Ice', 'LeafyGrass', 'Salt', 'Limestone', 'Pavement'];

class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  get done() { return this.i >= this.b.length; }
  u8() { if (this.i >= this.b.length) throw new Error('eof'); return this.b[this.i++]; }
  varint() { let r = 0, s = 0, c; do { c = this.u8(); r |= (c & 0x7f) << s; s += 7; if (s > 35) throw new Error('varint'); } while (c & 0x80); return r >>> 0; }
  zig() { const v = this.varint(); return (v >>> 1) ^ -(v & 1); }
  i32() { const v = this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24); this.i += 4; if (this.i > this.b.length) throw new Error('eof'); return v; }
  i16() { const v = (this.b[this.i] | (this.b[this.i + 1] << 8)) << 16 >> 16; this.i += 2; if (this.i > this.b.length) throw new Error('eof'); return v; }
}

const COORDS = {
  zigDelta: (r, prev) => [prev[0] + r.zig(), prev[1] + r.zig(), prev[2] + r.zig()],
  zigAbs: (r) => [r.zig(), r.zig(), r.zig()],
  i32: (r) => [r.i32(), r.i32(), r.i32()],
  i16: (r) => [r.i16(), r.i16(), r.i16()],
};
const FLAGS = [{ occ: 0x40, count: 0x80 }, { occ: 0x80, count: 0x40 }];

/** Parses with one hypothesis; returns [{ cx, cy, cz, mat: Uint8Array, occ: Uint8Array }] or throws. */
function parseWith(bytes, coordKind, flags, size) {
  const r = new Reader(bytes);
  r.i = 2;
  const n = size * size * size;
  const chunks = [];
  const seen = new Set();
  let prev = [0, 0, 0];
  while (!r.done) {
    const c = COORDS[coordKind](r, prev);
    prev = c;
    if (c.some((v) => Math.abs(v) > 4096)) throw new Error('coordinate out of range');
    const key = c.join(',');
    if (seen.has(key)) throw new Error('duplicate chunk');
    seen.add(key);
    const mat = new Uint8Array(n), occ = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const h = r.u8();
      const m = h & 0x3f;
      if (m >= TERRAIN_MATERIALS.length) throw new Error('material id');
      const o = h & flags.occ ? r.u8() : (m ? 255 : 0);
      const count = h & flags.count ? r.u8() + 1 : 1;
      if (i + count > n) throw new Error('run overflows chunk');
      if (m) { mat.fill(m, i, i + count); occ.fill(o, i, i + count); }
      i += count;
    }
    chunks.push({ cx: c[0], cy: c[1], cz: c[2], mat, occ });
  }
  return chunks;
}

// voxel index -> (x, y, z) inside a chunk for each candidate order (first letter varies fastest)
const ORDERS = ['xzy', 'xyz', 'zxy', 'yxz', 'yzx', 'zyx'];
function indexer(order, size) {
  const s1 = size, s2 = size * size;
  const pos = { [order[0]]: 1, [order[1]]: s1, [order[2]]: s2 };
  return (x, y, z) => x * pos.x + y * pos.y + z * pos.z;
}
function groundScore(chunk, order, size) {
  const at = indexer(order, size);
  let good = 0, bad = 0;
  for (let x = 0; x < size; x += 2) for (let z = 0; z < size; z += 2) for (let y = 1; y < size; y++) {
    const below = chunk.mat[at(x, y - 1, z)], here = chunk.mat[at(x, y, z)];
    if (below && !here) good++;
    else if (!below && here && here !== 1) bad++;
  }
  return good - bad * 1.5;
}

/**
 * Decodes SmoothGrid. Returns { size, chunks, order, at(x,y,z) } or null when the blob is empty / unknown.
 */
export function decodeSmoothGrid(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const size = 1 << (bytes[1] || 5);
  if (bytes.length === 2) return { size, chunks: [], order: 'xzy', at: indexer('xzy', size) };
  let chunks = null;
  for (const kind of Object.keys(COORDS)) {
    for (const flags of FLAGS) {
      try { chunks = parseWith(bytes, kind, flags, size); break; } catch { chunks = null; }
    }
    if (chunks) break;
  }
  if (!chunks || !chunks.length) return null;
  // pick the voxel order that looks most like terrain
  const sample = chunks.slice().sort((a, b) => b.mat.reduce((s, v) => s + (v ? 1 : 0), 0) - a.mat.reduce((s, v) => s + (v ? 1 : 0), 0)).slice(0, 6);
  let best = 'xzy', bestScore = -Infinity;
  for (const o of ORDERS) {
    const s = sample.reduce((acc, c) => acc + groundScore(c, o, size), 0);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return { size, chunks, order: best, at: indexer(best, size) };
}
