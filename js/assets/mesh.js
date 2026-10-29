// Roblox mesh file parser (versions 1.00 - 7.00).
// Format notes: https://devforum.roblox.com/t/roblox-mesh-format/326114 and Roblox-File-Format.
const td = new TextDecoder();

/** @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array, colors?: Uint8Array, draco?: Uint8Array }} */
export function parseMesh(bytes) {
  const nl = bytes.indexOf(10);
  const header = td.decode(bytes.subarray(0, nl < 0 ? 16 : nl)).trim();
  const m = /^version (\d+)\.(\d+)/.exec(header);
  if (!m) throw new Error('not a Roblox mesh');
  const major = +m[1];
  if (major === 1) return parseV1(td.decode(bytes), header);
  const body = bytes.subarray(nl + 1);
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (major === 2) return parseV2(body, dv);
  if (major === 3) return parseV3(body, dv);
  if (major === 4 || major === 5) return parseV45(body, dv, major);
  if (major >= 6) return parseChunked(body, dv);
  throw new Error(`unsupported mesh version ${header}`);
}

function parseV1(text, header) {
  const lines = text.split(/\r?\n/);
  const nFaces = parseInt(lines[1], 10);
  const nums = (lines.slice(2).join(' ').match(/\[[^\]]*\]/g) || []).map((s) => s.slice(1, -1).split(',').map(Number));
  const scale = header.startsWith('version 1.00') ? 0.5 : 1;
  const n = nFaces * 3;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2), indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const p = nums[i * 3] || [0, 0, 0], no = nums[i * 3 + 1] || [0, 1, 0], uv = nums[i * 3 + 2] || [0, 0, 0];
    positions.set([p[0] * scale, p[1] * scale, p[2] * scale], i * 3);
    normals.set(no, i * 3);
    uvs.set([uv[0], 1 - uv[1]], i * 2);
    indices[i] = i;
  }
  return { positions, normals, uvs, indices };
}

function readVerts(body, dv, off, count, size) {
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
  let colors = null;
  if (size >= 40) colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = off + i * size;
    positions[i * 3] = dv.getFloat32(o, true); positions[i * 3 + 1] = dv.getFloat32(o + 4, true); positions[i * 3 + 2] = dv.getFloat32(o + 8, true);
    normals[i * 3] = dv.getFloat32(o + 12, true); normals[i * 3 + 1] = dv.getFloat32(o + 16, true); normals[i * 3 + 2] = dv.getFloat32(o + 20, true);
    uvs[i * 2] = dv.getFloat32(o + 24, true); uvs[i * 2 + 1] = 1 - dv.getFloat32(o + 28, true);
    if (colors) colors.set(body.subarray(o + size - 4, o + size), i * 4);
  }
  return { positions, normals, uvs, colors };
}
function readFaces(dv, off, count) {
  const idx = new Uint32Array(count * 3);
  for (let i = 0; i < count * 3; i++) idx[i] = dv.getUint32(off + i * 4, true);
  return idx;
}
const lod0 = (indices, lods) => (lods && lods.length >= 2 && lods[1] > lods[0] ? indices.subarray(lods[0] * 3, lods[1] * 3) : indices);

function parseV2(body, dv) {
  const hs = dv.getUint16(0, true);
  const vs = body[2];
  const nv = dv.getUint32(4, true), nf = dv.getUint32(8, true);
  const v = readVerts(body, dv, hs, nv, vs);
  return { ...v, indices: readFaces(dv, hs + nv * vs, nf) };
}

function parseV3(body, dv) {
  const hs = dv.getUint16(0, true);
  const vs = body[2];
  const lodSize = dv.getUint16(4, true);
  const nLods = dv.getUint16(6, true);
  const nv = dv.getUint32(8, true), nf = dv.getUint32(12, true);
  const v = readVerts(body, dv, hs, nv, vs);
  const fo = hs + nv * vs;
  const indices = readFaces(dv, fo, nf);
  const lo = fo + nf * 12;
  const lods = [];
  for (let i = 0; i < nLods; i++) lods.push(dv.getUint32(lo + i * lodSize, true));
  return { ...v, indices: lod0(indices, lods) };
}

function parseV45(body, dv, major) {
  const hs = dv.getUint16(0, true);
  const nv = dv.getUint32(4, true), nf = dv.getUint32(8, true);
  const nLods = dv.getUint16(12, true);
  const nBones = dv.getUint16(14, true);
  let o = hs;
  const v = readVerts(body, dv, o, nv, 40);
  o += nv * 40;
  if (nBones > 0) o += nv * 8;
  const indices = readFaces(dv, o, nf);
  o += nf * 12;
  const lods = [];
  for (let i = 0; i < nLods; i++) lods.push(dv.getUint32(o + i * 4, true));
  void major;
  return { ...v, indices: lod0(indices, lods) };
}

function parseChunked(body, dv) {
  let o = 0;
  let core = null;
  let lods = null;
  while (o + 16 <= body.length) {
    const type = td.decode(body.subarray(o, o + 8)).replace(/\0+$/, '');
    const ver = dv.getUint32(o + 8, true);
    const size = dv.getUint32(o + 12, true);
    const start = o + 16;
    if (type === 'COREMESH') {
      if (ver === 1) {
        const nv = dv.getUint32(start, true);
        const v = readVerts(body, dv, start + 4, nv, 40);
        const fo = start + 4 + nv * 40;
        const nf = dv.getUint32(fo, true);
        core = { ...v, indices: readFaces(dv, fo + 4, nf) };
      } else core = { draco: body.slice(start, start + size) };
    } else if (type === 'LODS' && ver === 1) {
      const n = dv.getUint32(start + 3, true);
      lods = [];
      for (let i = 0; i < n; i++) lods.push(dv.getUint32(start + 7 + i * 4, true));
    }
    o = start + size;
  }
  if (!core) throw new Error('mesh has no geometry');
  if (core.indices && lods) core.indices = lod0(core.indices, lods);
  return core;
}
