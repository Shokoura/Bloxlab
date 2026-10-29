// Roblox binary model format (.rbxl / .rbxm) reader + writer.
// Spec: https://github.com/rojo-rbx/rbx-dom/blob/master/docs/binary.md
import { RawInstance, utf8, BINARY_PROPS } from './raw.js';
import { lz4Compress, lz4Decompress } from './lz4.js';
import { decompress as zstdDecompress } from '../../vendor/fzstd/fzstd.mjs';
import {
  Vector3, Vector2, CFrame, Color3, UDim, UDim2, Ray, Faces, Axes, Rect, NumberRange,
  NumberSequence, NumberSequenceKeypoint, ColorSequence, ColorSequenceKeypoint, PhysicalProperties,
  Vector3int16, Vector2int16, Font,
} from '../engine/datatypes.js';
import reflection from '../engine/reflection.js';

const MAGIC = [0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a];
export const isBinary = (b) => b.length >= 14 && MAGIC.every((x, i) => b[i] === x);

const TYPE = {
  String: 0x01, Bool: 0x02, Int32: 0x03, Float32: 0x04, Float64: 0x05, UDim: 0x06, UDim2: 0x07, Ray: 0x08,
  Faces: 0x09, Axes: 0x0a, BrickColor: 0x0b, Color3: 0x0c, Vector2: 0x0d, Vector3: 0x0e, Vector2int16: 0x0f,
  CFrame: 0x10, Enum: 0x12, Ref: 0x13, Vector3int16: 0x14, NumberSequence: 0x15, ColorSequence: 0x16,
  NumberRange: 0x17, Rect: 0x18, PhysicalProperties: 0x19, Color3uint8: 0x1a, Int64: 0x1b, SharedString: 0x1c,
  Bytecode: 0x1d, OptionalCFrame: 0x1e, UniqueId: 0x1f, Font: 0x20, SecurityCapabilities: 0x21, Content: 0x22,
};
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
// raw types that are written as binary "String"
const STRINGISH = new Set(['String', 'ProtectedString', 'BinaryString', 'ContentId', 'Tags', 'Attributes']);

// ------------------------------------------------------------------ helpers
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const fromRbxFloat = (bits) => { u32[0] = (bits >>> 1) | (bits << 31); return f32[0]; };
const toRbxFloat = (x) => { f32[0] = x; const b = u32[0]; return ((b << 1) | (b >>> 31)) >>> 0; };
const untransform = (x) => ((x >>> 1) ^ -(x & 1)) | 0;
const transform = (x) => ((x << 1) ^ (x >> 31)) >>> 0;

class Reader {
  constructor(bytes) { this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.o = 0; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  bytes(n) { if (this.o + n > this.b.length) throw new Error('unexpected end of chunk'); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  strBytes() { return this.bytes(this.u32()); }
  str() { return utf8.dec.decode(this.strBytes()); }
  // byte-interleaved array of `count` values `width` bytes wide (big-endian per value)
  interleaved(count, width) {
    const src = this.bytes(count * width);
    const out = new Uint8Array(count * width);
    for (let i = 0; i < count; i++) for (let b = 0; b < width; b++) out[i * width + b] = src[b * count + i];
    return out;
  }
  u32s(count) {
    const d = this.interleaved(count, 4);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = ((d[i * 4] << 24) | (d[i * 4 + 1] << 16) | (d[i * 4 + 2] << 8) | d[i * 4 + 3]) >>> 0;
    return out;
  }
  i32s(count) { return this.u32s(count).map(untransform); }
  floats(count) { return this.u32s(count).map(fromRbxFloat); }
  refs(count) { const a = this.i32s(count); let acc = 0; for (let i = 0; i < count; i++) { acc += a[i]; a[i] = acc; } return a; }
  i64s(count) {
    const d = this.interleaved(count, 8);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v = (v << 8n) | BigInt(d[i * 8 + b]);
      v = (v >> 1n) ^ -(v & 1n);
      out[i] = Number(BigInt.asIntN(64, v));
    }
    return out;
  }
}

class Writer {
  constructor() { this.buf = new Uint8Array(1024); this.dv = new DataView(this.buf.buffer); this.o = 0; }
  ensure(n) {
    if (this.o + n <= this.buf.length) return;
    let len = this.buf.length * 2; while (len < this.o + n) len *= 2;
    const nb = new Uint8Array(len); nb.set(this.buf.subarray(0, this.o)); this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.o++] = v; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  i16(v) { this.ensure(2); this.dv.setInt16(this.o, v, true); this.o += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.o, v | 0, true); this.o += 4; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.o, v, true); this.o += 8; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.o); this.o += b.length; }
  str(s) { const b = typeof s === 'string' ? utf8.enc.encode(s) : s; this.u32(b.length); this.bytes(b); }
  interleaved(data, count, width) {
    this.ensure(count * width);
    for (let b = 0; b < width; b++) for (let i = 0; i < count; i++) this.buf[this.o + b * count + i] = data[i * width + b];
    this.o += count * width;
  }
  u32s(vals) {
    const d = new Uint8Array(vals.length * 4);
    vals.forEach((v, i) => { d[i * 4] = v >>> 24; d[i * 4 + 1] = (v >>> 16) & 255; d[i * 4 + 2] = (v >>> 8) & 255; d[i * 4 + 3] = v & 255; });
    this.interleaved(d, vals.length, 4);
  }
  i32s(vals) { this.u32s(vals.map((v) => transform(v | 0))); }
  floats(vals) { this.u32s(vals.map(toRbxFloat)); }
  refs(vals) { let prev = 0; this.i32s(vals.map((v) => { const d = v - prev; prev = v; return d; })); }
  i64s(vals) {
    const d = new Uint8Array(vals.length * 8);
    vals.forEach((v, i) => {
      let x = BigInt.asIntN(64, BigInt(Math.trunc(v || 0)));
      x = BigInt.asUintN(64, (x << 1n) ^ (x >> 63n));
      for (let b = 7; b >= 0; b--) { d[i * 8 + b] = Number(x & 255n); x >>= 8n; }
    });
    this.interleaved(d, vals.length, 8);
  }
  result() { return this.buf.slice(0, this.o); }
}

// ------------------------------------------------------------------ reading
function propType(className, prop) {
  let c = reflection.classes[className];
  while (c) {
    const p = c.p[prop];
    if (p) return p[0];
    c = reflection.classes[c.s];
  }
  return null;
}

export function readBinary(bytes) {
  if (!isBinary(bytes)) throw new Error('Not a Roblox binary file');
  const head = new Reader(bytes);
  head.o = 16;
  const classCount = head.i32();
  const instCount = head.i32();
  head.o = 32;
  const classes = new Map(); // id -> { name, refs, isService }
  const insts = new Map(); // referent -> RawInstance
  const meta = new Map();
  let shared = [];
  const parents = [];
  const warnings = [];

  while (head.o < bytes.length) {
    const name = utf8.dec.decode(bytes.subarray(head.o, head.o + 4)).replace(/\0+$/, '');
    head.o += 4;
    const clen = head.u32(), ulen = head.u32();
    head.u32();
    let data;
    if (clen === 0) data = head.bytes(ulen);
    else {
      const comp = head.bytes(clen);
      if (comp[0] === 0x28 && comp[1] === 0xb5 && comp[2] === 0x2f && comp[3] === 0xfd) data = zstdDecompress(comp, new Uint8Array(ulen));
      else data = lz4Decompress(comp, ulen);
    }
    if (name === 'END') break;
    const r = new Reader(data);
    try {
      if (name === 'META') {
        const n = r.u32();
        for (let i = 0; i < n; i++) meta.set(r.str(), r.str());
      } else if (name === 'SSTR') {
        r.u32();
        const n = r.u32();
        shared = new Array(n);
        for (let i = 0; i < n; i++) { r.bytes(16); shared[i] = r.strBytes().slice(); }
      } else if (name === 'INST') {
        const id = r.u32();
        const cname = r.str();
        const fmtByte = r.u8();
        const n = r.u32();
        const refs = r.refs(n);
        const c = { name: cname, refs, isService: fmtByte === 1 };
        classes.set(id, c);
        for (const ref of refs) { const ri = new RawInstance(cname); ri.isService = c.isService; ri.ref = ref; insts.set(ref, ri); }
      } else if (name === 'PROP') {
        readProp(r, classes, insts, shared, warnings);
      } else if (name === 'PRNT') {
        r.u8();
        const n = r.u32();
        const child = r.refs(n), par = r.refs(n);
        for (let i = 0; i < n; i++) parents.push([child[i], par[i]]);
      }
    } catch (err) {
      warnings.push(`${name} chunk: ${err.message}`);
    }
  }

  const roots = [];
  const parented = new Set();
  for (const [c, p] of parents) {
    const ci = insts.get(c);
    if (!ci) continue;
    parented.add(c);
    const pi = p === -1 ? null : insts.get(p);
    if (pi) { ci.parent = pi; } else roots.push(ci);
  }
  // keep children in file (referent) order rather than PRNT post-order
  const ordered = [...insts.values()].sort((a, b) => a.ref - b.ref);
  for (const ri of ordered) if (ri.parent) ri.parent.children.push(ri);
  for (const ri of ordered) if (!parented.has(ri.ref)) roots.push(ri);
  roots.sort((a, b) => a.ref - b.ref);
  if (instCount !== insts.size) warnings.push(`header says ${instCount} instances, found ${insts.size}`);
  if (classCount !== classes.size) warnings.push(`header says ${classCount} classes, found ${classes.size}`);
  return { roots, meta, warnings };
}

function readProp(r, classes, insts, shared, warnings) {
  const id = r.u32();
  const pname = r.str();
  const typeId = r.u8();
  const cls = classes.get(id);
  if (!cls) throw new Error(`PROP for unknown class ${id}`);
  const n = cls.refs.length;
  const targets = cls.refs.map((ref) => insts.get(ref));
  const set = (t, vals) => { for (let i = 0; i < n; i++) targets[i].set(pname, t, vals[i]); };
  const vec3s = () => { const x = r.floats(n), y = r.floats(n), z = r.floats(n); return x.map((_, i) => new Vector3(x[i], y[i], z[i])); };
  const cframes = () => {
    const rots = [];
    for (let i = 0; i < n; i++) {
      const rid = r.u8();
      if (rid === 0) { const m = []; for (let k = 0; k < 9; k++) m.push(r.f32()); rots.push(m); }
      else { const c = CFrame.fromRotationId(rid); rots.push(c ? c.r : [1, 0, 0, 0, 1, 0, 0, 0, 1]); }
    }
    const p = vec3s();
    return rots.map((m, i) => CFrame.fromPosRot(p[i].X, p[i].Y, p[i].Z, m));
  };
  switch (typeId) {
    case 0x01: case 0x1d: {
      const declared = propType(cls.name, pname);
      const binary = BINARY_PROPS.has(pname) || declared === 'BinaryString' || declared === 'Tags' || declared === 'Attributes';
      const vals = [];
      for (let i = 0; i < n; i++) {
        const b = r.strBytes();
        if (binary) { vals.push(b.slice()); continue; }
        try { vals.push(utf8.strict.decode(b)); } catch { vals.push(b.slice()); }
      }
      let t = typeId === 0x1d ? 'Bytecode' : binary ? 'BinaryString' : declared === 'ContentId' ? 'ContentId' : 'String';
      if (pname === 'Source' && t === 'String') t = 'ProtectedString';
      return set(t, vals);
    }
    case 0x02: return set('Bool', Array.from(r.bytes(n), (b) => b !== 0));
    case 0x03: return set('Int32', r.i32s(n));
    case 0x04: return set('Float32', r.floats(n));
    case 0x05: { const v = []; for (let i = 0; i < n; i++) v.push(r.f64()); return set('Float64', v); }
    case 0x06: { const s = r.floats(n), o = r.i32s(n); return set('UDim', s.map((_, i) => new UDim(s[i], o[i]))); }
    case 0x07: { const xs = r.floats(n), ys = r.floats(n), xo = r.i32s(n), yo = r.i32s(n); return set('UDim2', xs.map((_, i) => new UDim2(xs[i], xo[i], ys[i], yo[i]))); }
    case 0x08: { const v = []; for (let i = 0; i < n; i++) { const a = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]; v.push(new Ray(new Vector3(a[0], a[1], a[2]), new Vector3(a[3], a[4], a[5]))); } return set('Ray', v); }
    case 0x09: return set('Faces', Array.from(r.bytes(n), (b) => new Faces(b)));
    case 0x0a: return set('Axes', Array.from(r.bytes(n), (b) => new Axes(b)));
    case 0x0b: return set('BrickColor', r.u32s(n));
    case 0x0c: { const a = r.floats(n), b = r.floats(n), c = r.floats(n); return set('Color3', a.map((_, i) => new Color3(a[i], b[i], c[i]))); }
    case 0x0d: { const x = r.floats(n), y = r.floats(n); return set('Vector2', x.map((_, i) => new Vector2(x[i], y[i]))); }
    case 0x0e: return set('Vector3', vec3s());
    case 0x0f: { const v = []; for (let i = 0; i < n; i++) v.push(new Vector2int16(r.i16(), r.i16())); return set('Vector2int16', v); }
    case 0x10: return set('CFrame', cframes());
    case 0x12: return set('Enum', r.u32s(n));
    case 0x13: { const refs = r.refs(n); return set('Ref', refs.map((x) => (x === -1 ? null : insts.get(x) || null))); }
    case 0x14: { const v = []; for (let i = 0; i < n; i++) v.push(new Vector3int16(r.i16(), r.i16(), r.i16())); return set('Vector3int16', v); }
    case 0x15: {
      const v = [];
      for (let i = 0; i < n; i++) { const k = r.u32(); const kps = []; for (let j = 0; j < k; j++) kps.push(new NumberSequenceKeypoint(r.f32(), r.f32(), r.f32())); v.push(new NumberSequence(kps)); }
      return set('NumberSequence', v);
    }
    case 0x16: {
      const v = [];
      for (let i = 0; i < n; i++) { const k = r.u32(); const kps = []; for (let j = 0; j < k; j++) { const t = r.f32(); const c = new Color3(r.f32(), r.f32(), r.f32()); r.f32(); kps.push(new ColorSequenceKeypoint(t, c)); } v.push(new ColorSequence(kps)); }
      return set('ColorSequence', v);
    }
    case 0x17: { const v = []; for (let i = 0; i < n; i++) { const a = r.f32(), b = r.f32(); v.push(new NumberRange(Math.min(a, b), Math.max(a, b))); } return set('NumberRange', v); }
    case 0x18: { const a = r.floats(n), b = r.floats(n), c = r.floats(n), d = r.floats(n); return set('Rect', a.map((_, i) => new Rect(a[i], b[i], c[i], d[i]))); }
    case 0x19: {
      const v = [];
      for (let i = 0; i < n; i++) {
        const flag = r.u8();
        if (flag & 1) {
          const p = new PhysicalProperties(r.f32(), r.f32(), r.f32(), r.f32(), r.f32());
          if (flag & 2) p.AcousticAbsorption = r.f32();
          v.push(p);
        } else v.push(null);
      }
      return set('PhysicalProperties', v);
    }
    case 0x1a: { const R = r.bytes(n), G = r.bytes(n), B = r.bytes(n); const v = []; for (let i = 0; i < n; i++) v.push(Color3.fromRGB(R[i], G[i], B[i])); return set('Color3uint8', v); }
    case 0x1b: return set('Int64', r.i64s(n));
    case 0x1c: { const idx = r.u32s(n); const t = propType(cls.name, pname) === 'NetAssetRef' ? 'NetAssetRef' : 'SharedString'; return set(t, idx.map((i) => shared[i] ?? new Uint8Array(0))); }
    case 0x1e: {
      r.u8();
      const cfs = cframes();
      r.u8();
      const has = r.bytes(n);
      return set('OptionalCFrame', cfs.map((c, i) => (has[i] ? c : null)));
    }
    case 0x1f: { const d = r.interleaved(n, 16); const v = []; for (let i = 0; i < n; i++) v.push(d.slice(i * 16, i * 16 + 16)); return set('UniqueId', v); }
    case 0x20: {
      const v = [];
      for (let i = 0; i < n; i++) {
        const family = r.str(); const weight = r.u16(); const style = r.u8(); const cached = r.str();
        const f = new Font(family, weight, style === 1 ? 'Italic' : 'Normal'); f.CachedFaceId = cached; v.push(f);
      }
      return set('Font', v);
    }
    case 0x21: return set('SecurityCapabilities', r.i64s(n));
    case 0x22: {
      const types = r.i32s(n);
      const uc = r.u32(); const uris = []; for (let i = 0; i < uc; i++) uris.push(r.str());
      const oc = r.u32(); if (oc) r.refs(oc);
      const ec = r.u32(); if (ec) r.refs(ec);
      let ui = 0;
      return set('Content', types.map((t) => (t === 1 ? uris[ui++] ?? '' : '')));
    }
    default:
      warnings.push(`${cls.name}.${pname}: unsupported binary type 0x${typeId.toString(16)}`);
  }
}

// ------------------------------------------------------------------ writing
const DEFAULTS = {
  String: '', ProtectedString: '', BinaryString: new Uint8Array(0), ContentId: '', Bytecode: '', Tags: new Uint8Array(0),
  Bool: false, Int32: 0, Float32: 0, Float64: 0, Int64: 0, BrickColor: 194, Enum: 0, Ref: null,
  UDim: new UDim(), UDim2: new UDim2(), Ray: new Ray(), Faces: new Faces(0), Axes: new Axes(0), Color3: new Color3(),
  Color3uint8: new Color3(), Vector2: new Vector2(), Vector3: new Vector3(), Vector2int16: new Vector2int16(), CFrame: CFrame.identity,
  Vector3int16: new Vector3int16(), NumberSequence: new NumberSequence(0), ColorSequence: new ColorSequence(), NumberRange: new NumberRange(0),
  Rect: new Rect(), PhysicalProperties: null, SharedString: new Uint8Array(0), NetAssetRef: new Uint8Array(0), OptionalCFrame: null,
  UniqueId: new Uint8Array(16), Font: new Font(), SecurityCapabilities: 0, Content: '',
};

function md5ish(bytes) { // Roblox ignores the hash; we just need 16 stable bytes
  const h = new Uint8Array(16);
  let a = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { a ^= bytes[i]; a = Math.imul(a, 16777619) >>> 0; h[i & 15] ^= a & 255; }
  return h;
}

/**
 * @param {RawInstance[]} roots
 * @param {{ model?: boolean, compress?: boolean }} opts
 */
export function writeBinary(roots, { model = false, compress = true } = {}) {
  const all = [];
  const walk = (ri) => { all.push(ri); ri.children.forEach(walk); };
  roots.forEach(walk);
  const refOf = new Map(all.map((ri, i) => [ri, i]));

  // classes sorted by name (Roblox does the same)
  const byClass = new Map();
  for (const ri of all) { if (!byClass.has(ri.className)) byClass.set(ri.className, []); byClass.get(ri.className).push(ri); }
  const classNames = [...byClass.keys()].sort();

  const sharedList = [];
  const sharedIdx = new Map();
  const sharedKey = (b) => { const k = typeof b === 'string' ? b : Array.from(b, (x) => String.fromCharCode(x)).join(''); return k; };
  for (const ri of all) for (const { t, v } of ri.props.values()) {
    if ((t === 'SharedString' || t === 'NetAssetRef') && v) { const k = sharedKey(v); if (!sharedIdx.has(k)) { sharedIdx.set(k, sharedList.length); sharedList.push(typeof v === 'string' ? utf8.enc.encode(v) : v); } }
  }

  const chunks = [];
  const chunk = (name, w, comp = compress) => chunks.push({ name, data: w.result(), comp });

  if (model) { const w = new Writer(); w.u32(1); w.str('ExplicitAutoJoints'); w.str('true'); chunk('META', w); }
  if (sharedList.length) {
    const w = new Writer(); w.u32(0); w.u32(sharedList.length);
    for (const s of sharedList) { w.bytes(md5ish(s)); w.str(s); }
    chunk('SSTR', w);
  }
  classNames.forEach((cn, id) => {
    const list = byClass.get(cn);
    const w = new Writer();
    w.u32(id); w.str(cn);
    const svc = list.some((ri) => ri.isService);
    w.u8(svc ? 1 : 0);
    w.u32(list.length);
    w.refs(list.map((ri) => refOf.get(ri)));
    if (svc) for (let i = 0; i < list.length; i++) w.u8(1);
    chunk('INST', w);
  });
  classNames.forEach((cn, id) => {
    const list = byClass.get(cn);
    const propTypes = new Map();
    for (const ri of list) for (const [k, { t }] of ri.props) if (!propTypes.has(k)) propTypes.set(k, t);
    for (const pname of [...propTypes.keys()].sort()) {
      const t = propTypes.get(pname);
      const typeId = STRINGISH.has(t) ? TYPE.String : TYPE[t === 'NetAssetRef' ? 'SharedString' : t];
      if (typeId === undefined) continue;
      const vals = list.map((ri) => { const e = ri.props.get(pname); return e && e.t === t ? e.v : DEFAULTS[t]; });
      const w = new Writer();
      w.u32(id); w.str(pname); w.u8(typeId);
      writeValues(w, typeId, vals, refOf, sharedIdx, sharedKey);
      chunk('PROP', w);
    }
  });
  {
    const w = new Writer();
    const kids = [], pars = [];
    const post = (ri, p) => { ri.children.forEach((c) => post(c, ri)); kids.push(refOf.get(ri)); pars.push(p ? refOf.get(p) : -1); };
    roots.forEach((r) => post(r, null));
    w.u8(0); w.u32(kids.length); w.refs(kids); w.refs(pars);
    chunk('PRNT', w);
  }

  const out = new Writer();
  out.bytes(new Uint8Array(MAGIC));
  out.u16(0); out.i32(classNames.length); out.i32(all.length); out.u32(0); out.u32(0);
  for (const c of chunks) {
    out.bytes(utf8.enc.encode(c.name.padEnd(4, '\0')));
    if (c.comp && c.data.length > 64) {
      const z = lz4Compress(c.data);
      out.u32(z.length); out.u32(c.data.length); out.u32(0); out.bytes(z);
    } else {
      out.u32(0); out.u32(c.data.length); out.u32(0); out.bytes(c.data);
    }
  }
  out.bytes(utf8.enc.encode('END\0')); out.u32(0); out.u32(9); out.u32(0); out.bytes(utf8.enc.encode('</roblox>'));
  return out.result();
}

function writeValues(w, typeId, vals, refOf, sharedIdx, sharedKey) {
  const n = vals.length;
  const writeCFrames = (cfs) => {
    for (const c of cfs) {
      const id = c.rotationId();
      w.u8(id);
      if (!id) for (const x of c.r) w.f32(x);
    }
    w.floats(cfs.map((c) => c.X)); w.floats(cfs.map((c) => c.Y)); w.floats(cfs.map((c) => c.Z));
  };
  switch (typeId) {
    case 0x01: case 0x1d: for (const v of vals) w.str(v ?? ''); break;
    case 0x02: for (const v of vals) w.u8(v ? 1 : 0); break;
    case 0x03: w.i32s(vals.map((v) => v | 0)); break;
    case 0x04: w.floats(vals.map(Number)); break;
    case 0x05: for (const v of vals) w.f64(+v); break;
    case 0x06: w.floats(vals.map((v) => v.Scale)); w.i32s(vals.map((v) => v.Offset)); break;
    case 0x07: w.floats(vals.map((v) => v.X.Scale)); w.floats(vals.map((v) => v.Y.Scale)); w.i32s(vals.map((v) => v.X.Offset)); w.i32s(vals.map((v) => v.Y.Offset)); break;
    case 0x08: for (const v of vals) for (const x of [v.Origin.X, v.Origin.Y, v.Origin.Z, v.Direction.X, v.Direction.Y, v.Direction.Z]) w.f32(x); break;
    case 0x09: case 0x0a: for (const v of vals) w.u8(v.bits); break;
    case 0x0b: w.u32s(vals.map((v) => (typeof v === 'number' ? v : v.Number) >>> 0)); break;
    case 0x0c: w.floats(vals.map((v) => v.R)); w.floats(vals.map((v) => v.G)); w.floats(vals.map((v) => v.B)); break;
    case 0x0d: w.floats(vals.map((v) => v.X)); w.floats(vals.map((v) => v.Y)); break;
    case 0x0e: w.floats(vals.map((v) => v.X)); w.floats(vals.map((v) => v.Y)); w.floats(vals.map((v) => v.Z)); break;
    case 0x0f: for (const v of vals) { w.i16(v.X); w.i16(v.Y); } break;
    case 0x10: writeCFrames(vals); break;
    case 0x12: w.u32s(vals.map((v) => (typeof v === 'number' ? v : v?.Value ?? 0) >>> 0)); break;
    case 0x13: w.refs(vals.map((v) => (v && refOf.has(v) ? refOf.get(v) : -1))); break;
    case 0x14: for (const v of vals) { w.i16(v.X); w.i16(v.Y); w.i16(v.Z); } break;
    case 0x15: for (const v of vals) { w.u32(v.Keypoints.length); for (const k of v.Keypoints) { w.f32(k.Time); w.f32(k.Value); w.f32(k.Envelope); } } break;
    case 0x16: for (const v of vals) { w.u32(v.Keypoints.length); for (const k of v.Keypoints) { w.f32(k.Time); w.f32(k.Value.R); w.f32(k.Value.G); w.f32(k.Value.B); w.f32(0); } } break;
    case 0x17: for (const v of vals) { w.f32(v.Min); w.f32(v.Max); } break;
    case 0x18: w.floats(vals.map((v) => v.Min.X)); w.floats(vals.map((v) => v.Min.Y)); w.floats(vals.map((v) => v.Max.X)); w.floats(vals.map((v) => v.Max.Y)); break;
    case 0x19: for (const v of vals) { if (!v) { w.u8(0); continue; } w.u8(3); for (const x of [...v.toArray(), v.AcousticAbsorption ?? 1]) w.f32(x); } break;
    case 0x1a: for (const k of ['R', 'G', 'B']) for (const v of vals) w.u8(Math.max(0, Math.min(255, Math.round(v[k] * 255)))); break;
    case 0x1b: case 0x21: w.i64s(vals.map(Number)); break;
    case 0x1c: w.u32s(vals.map((v) => sharedIdx.get(sharedKey(v || new Uint8Array(0))) ?? 0)); break;
    case 0x1e: {
      w.u8(0x10); writeCFrames(vals.map((v) => v || CFrame.identity));
      w.u8(0x02); for (const v of vals) w.u8(v ? 1 : 0);
      break;
    }
    case 0x1f: { const d = new Uint8Array(n * 16); vals.forEach((v, i) => d.set(v || new Uint8Array(16), i * 16)); w.interleaved(d, n, 16); break; }
    case 0x20: for (const v of vals) { w.str(v.Family); w.u16(v.Weight); w.u8(v.Style === 'Italic' ? 1 : 0); w.str(v.CachedFaceId || ''); } break;
    case 0x22: {
      w.i32s(vals.map((v) => (v ? 1 : 0)));
      const uris = vals.filter(Boolean);
      w.u32(uris.length); for (const u of uris) w.str(u);
      w.u32(0); w.u32(0);
      break;
    }
    default: break;
  }
  void n;
}

export { TYPE_NAME };
