// Attribute blob codec (Instance.AttributesSerialize) and Tags (null separated strings).
// Spec: https://github.com/rojo-rbx/rbx-dom/blob/master/docs/attributes.md
import { utf8 } from './raw.js';
import {
  Vector3, Vector2, CFrame, Color3, UDim, UDim2, Rect, NumberRange, NumberSequence, NumberSequenceKeypoint,
  ColorSequence, ColorSequenceKeypoint, BrickColor, Font,
} from '../engine/datatypes.js';
import { EnumItem, getEnum } from '../engine/enums.js';

export function decodeAttributes(bytes) {
  const out = new Map();
  if (!bytes || bytes.length < 4) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8 = () => bytes[o++];
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(o, true); o += 8; return v; };
  const str = () => { const n = u32(); const s = utf8.dec.decode(bytes.subarray(o, o + n)); o += n; return s; };
  const v3 = () => new Vector3(f32(), f32(), f32());
  const n = u32();
  for (let i = 0; i < n; i++) {
    const name = str();
    const t = u8();
    let v;
    switch (t) {
      case 0x02: v = str(); break;
      case 0x03: v = u8() !== 0; break;
      case 0x04: v = i32(); break;
      case 0x05: v = f32(); break;
      case 0x06: v = f64(); break;
      case 0x09: v = new UDim(f32(), i32()); break;
      case 0x0a: { const xs = f32(), xo = i32(), ys = f32(), yo = i32(); v = new UDim2(xs, xo, ys, yo); break; }
      case 0x0e: v = BrickColor.fromNumber(u32()); break;
      case 0x0f: v = new Color3(f32(), f32(), f32()); break;
      case 0x10: v = new Vector2(f32(), f32()); break;
      case 0x11: v = v3(); break;
      case 0x14: {
        const p = v3(); const id = u8();
        if (id === 0) { const m = []; for (let k = 0; k < 9; k++) m.push(f32()); const c = CFrame.fromMatrix(p, new Vector3(m[0], m[1], m[2]), new Vector3(m[3], m[4], m[5]), new Vector3(m[6], m[7], m[8])); v = c; }
        else { const r = CFrame.fromRotationId(id) || CFrame.identity; v = CFrame.fromPosRot(p.X, p.Y, p.Z, r.r); }
        break;
      }
      case 0x15: { const en = str(); const val = u32(); const e = getEnum(en); v = e?.fromValue(val) || new EnumItem({ name: en }, String(val), val); break; }
      case 0x17: { const k = u32(); const kp = []; for (let j = 0; j < k; j++) { const env = f32(), time = f32(), val = f32(); kp.push(new NumberSequenceKeypoint(time, val, env)); } v = new NumberSequence(kp); break; }
      case 0x19: { const k = u32(); const kp = []; for (let j = 0; j < k; j++) { f32(); const time = f32(); kp.push(new ColorSequenceKeypoint(time, new Color3(f32(), f32(), f32()))); } v = new ColorSequence(kp); break; }
      case 0x1b: v = new NumberRange(f32(), f32()); break;
      case 0x1c: v = new Rect(f32(), f32(), f32(), f32()); break;
      case 0x21: { const w = u16(); const st = u8(); const fam = str(); const cached = str(); v = new Font(fam, w, st === 1 ? 'Italic' : 'Normal'); v.CachedFaceId = cached; break; }
      default: return out; // unknown type: we cannot know its length, stop here
    }
    out.set(name, v);
  }
  return out;
}

export function encodeAttributes(map) {
  const parts = [];
  let len = 4;
  const push = (b) => { parts.push(b); len += b.length; };
  const num = (fn, size, v) => { const b = new Uint8Array(size); fn(new DataView(b.buffer), v); push(b); };
  const u8 = (v) => push(Uint8Array.of(v));
  const u16 = (v) => num((d, x) => d.setUint16(0, x, true), 2, v);
  const u32 = (v) => num((d, x) => d.setUint32(0, x >>> 0, true), 4, v);
  const i32 = (v) => num((d, x) => d.setInt32(0, x | 0, true), 4, v);
  const f32 = (v) => num((d, x) => d.setFloat32(0, x, true), 4, v);
  const f64 = (v) => num((d, x) => d.setFloat64(0, x, true), 8, v);
  const str = (s) => { const b = utf8.enc.encode(s); u32(b.length); push(b); };
  let count = 0;
  for (const [name, v] of map) {
    const before = parts.length;
    str(name);
    if (typeof v === 'string') { u8(0x02); str(v); }
    else if (typeof v === 'boolean') { u8(0x03); u8(v ? 1 : 0); }
    else if (typeof v === 'number') { u8(0x06); f64(v); }
    else if (v instanceof UDim) { u8(0x09); f32(v.Scale); i32(v.Offset); }
    else if (v instanceof UDim2) { u8(0x0a); f32(v.X.Scale); i32(v.X.Offset); f32(v.Y.Scale); i32(v.Y.Offset); }
    else if (v instanceof BrickColor) { u8(0x0e); u32(v.Number); }
    else if (v instanceof Color3) { u8(0x0f); f32(v.R); f32(v.G); f32(v.B); }
    else if (v instanceof Vector2) { u8(0x10); f32(v.X); f32(v.Y); }
    else if (v instanceof Vector3) { u8(0x11); f32(v.X); f32(v.Y); f32(v.Z); }
    else if (v instanceof CFrame) { u8(0x14); f32(v.X); f32(v.Y); f32(v.Z); u8(0); const r = v.r; for (const k of [0, 3, 6, 1, 4, 7, 2, 5, 8]) f32(r[k]); }
    else if (v instanceof EnumItem) { u8(0x15); str(v.EnumType.name); u32(v.Value); }
    else if (v instanceof NumberSequence) { u8(0x17); u32(v.Keypoints.length); for (const k of v.Keypoints) { f32(k.Envelope); f32(k.Time); f32(k.Value); } }
    else if (v instanceof ColorSequence) { u8(0x19); u32(v.Keypoints.length); for (const k of v.Keypoints) { f32(0); f32(k.Time); f32(k.Value.R); f32(k.Value.G); f32(k.Value.B); } }
    else if (v instanceof NumberRange) { u8(0x1b); f32(v.Min); f32(v.Max); }
    else if (v instanceof Rect) { u8(0x1c); f32(v.Min.X); f32(v.Min.Y); f32(v.Max.X); f32(v.Max.Y); }
    else if (v instanceof Font) { u8(0x21); u16(v.Weight); u8(v.Style === 'Italic' ? 1 : 0); str(v.Family); str(v.CachedFaceId || ''); }
    else { while (parts.length > before) len -= parts.pop().length; continue; }
    count++;
  }
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, count, true);
  let o = 4;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const decodeTags = (bytes) => (bytes && bytes.length ? utf8.dec.decode(bytes).split('\0').filter(Boolean) : []);
export const encodeTags = (tags) => utf8.enc.encode([...tags].join('\0'));
