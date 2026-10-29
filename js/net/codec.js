// Wire encoding for property values and remote arguments (JSON-safe, no prototype tricks).
import {
  Vector3, Vector2, Vector3int16, Vector2int16, CFrame, Color3, BrickColor, UDim, UDim2, Rect, Ray, Region3, Region3int16,
  NumberRange, NumberSequence, NumberSequenceKeypoint, ColorSequence, ColorSequenceKeypoint, PhysicalProperties, Faces, Axes, Font,
  TweenInfo, DateTime, PathWaypoint,
} from '../engine/datatypes.js';
import { EnumItem, getEnum, enumFromValue } from '../engine/enums.js';
import { Instance } from '../engine/instance.js';
import { LuaTable } from '../luau/runtime.js';

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const num = (n) => (Number.isFinite(n) ? n : { $: 'n', v: String(n) });
const unnum = (v) => (typeof v === 'number' ? v : Number(v.v));

/**
 * @param v value
 * @param idOf (Instance) -> wire id or null when the receiver cannot see the instance
 * @param depth recursion guard for tables
 */
export function encodeValue(v, idOf, depth = 0) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return v;
  if (t === 'number') return num(v);
  if (t === 'function') return null;
  if (v instanceof Instance) { const id = idOf(v); return id === null || id === undefined ? null : { $: 'i', v: id }; }
  if (v instanceof EnumItem) return { $: 'e', t: v.EnumType.name, v: v.Name, n: v.Value };
  if (v instanceof CFrame) return { $: 'cf', v: [v.X, v.Y, v.Z, ...v.r] };
  if (v instanceof Vector3) return { $: 'v3', v: [v.X, v.Y, v.Z] };
  if (v instanceof Vector2) return { $: 'v2', v: [v.X, v.Y] };
  if (v instanceof Color3) return { $: 'c3', v: [v.R, v.G, v.B] };
  if (v instanceof BrickColor) return { $: 'bc', v: v.Number };
  if (v instanceof UDim2) return { $: 'u2', v: [v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset] };
  if (v instanceof UDim) return { $: 'u', v: [v.Scale, v.Offset] };
  if (v instanceof LuaTable) {
    if (depth > 40) return null;
    const out = { $: 't', a: v.arr.map((x) => encodeValue(x, idOf, depth + 1)) };
    if (v.hash && v.hash.size) {
      out.h = [];
      for (const [k, x] of v.hash) {
        if (typeof k === 'function' || (k && typeof k === 'object' && !(k instanceof Instance) && !(k instanceof EnumItem))) continue;
        const ek = encodeValue(k, idOf, depth + 1);
        if (ek === null) continue;
        out.h.push([ek, encodeValue(x, idOf, depth + 1)]);
      }
    }
    return out;
  }
  if (v instanceof Uint8Array) return { $: 'b', v: b64(v) };
  if (v instanceof NumberSequence) return { $: 'ns', v: v.Keypoints.map((k) => [k.Time, k.Value, k.Envelope]) };
  if (v instanceof ColorSequence) return { $: 'cs', v: v.Keypoints.map((k) => [k.Time, k.Value.R, k.Value.G, k.Value.B]) };
  if (v instanceof NumberRange) return { $: 'nr', v: [v.Min, v.Max] };
  if (v instanceof Rect) return { $: 'r', v: v.toArray() };
  if (v instanceof PhysicalProperties) return { $: 'pp', v: [v.Density, v.Friction, v.Elasticity, v.FrictionWeight, v.ElasticityWeight, v.AcousticAbsorption] };
  if (v instanceof Font) return { $: 'f', v: [v.Family, v.Weight, v.Style] };
  if (v instanceof Ray) return { $: 'ray', v: [v.Origin.X, v.Origin.Y, v.Origin.Z, v.Direction.X, v.Direction.Y, v.Direction.Z] };
  if (v instanceof Faces) return { $: 'fa', v: v.bits };
  if (v instanceof Axes) return { $: 'ax', v: v.bits };
  if (v instanceof Vector3int16) return { $: 'v3i', v: [v.X, v.Y, v.Z] };
  if (v instanceof Vector2int16) return { $: 'v2i', v: [v.X, v.Y] };
  if (v instanceof Region3) return { $: 'r3', v: [v.min.X, v.min.Y, v.min.Z, v.max.X, v.max.Y, v.max.Z] };
  if (v instanceof Region3int16) return { $: 'r3i', v: [v.Min.X, v.Min.Y, v.Min.Z, v.Max.X, v.Max.Y, v.Max.Z] };
  if (v instanceof NumberSequenceKeypoint) return { $: 'nsk', v: [v.Time, v.Value, v.Envelope] };
  if (v instanceof ColorSequenceKeypoint) return { $: 'csk', v: [v.Time, v.Value.R, v.Value.G, v.Value.B] };
  if (v instanceof TweenInfo) return { $: 'ti', v: [v.Time, v.EasingStyle ? v.EasingStyle.Name : 'Quad', v.EasingDirection ? v.EasingDirection.Name : 'Out', v.RepeatCount, v.Reverses, v.DelayTime] };
  if (v instanceof DateTime) return { $: 'dt', v: v.UnixTimestampMillis };
  if (v instanceof PathWaypoint) return { $: 'pw', v: [v.Position.X, v.Position.Y, v.Position.Z, v.Action ? v.Action.Name : 'Walk', v.Label] };
  if (Array.isArray(v)) return { $: 'arr', v: v.map((x) => encodeValue(x, idOf, depth + 1)) };
  return null;
}

const enumItem = (t, name, n) => { const e = getEnum(t); return (e && e.get(name)) || enumFromValue(t, n) || null; };

/** @param byId (wire id) -> Instance|null */
export function decodeValue(w, byId) {
  if (w === null || w === undefined) return undefined;
  const t = typeof w;
  if (t !== 'object') return w;
  const v = w.v;
  switch (w.$) {
    case 'n': return Number(v);
    case 'i': return byId(v) || undefined;
    case 'e': return enumItem(w.t, v, w.n);
    case 'cf': return new CFrame(...v.map(unnum));
    case 'v3': return new Vector3(unnum(v[0]), unnum(v[1]), unnum(v[2]));
    case 'v2': return new Vector2(unnum(v[0]), unnum(v[1]));
    case 'c3': return new Color3(v[0], v[1], v[2]);
    case 'bc': return BrickColor.fromNumber(v);
    case 'u2': return new UDim2(v[0], v[1], v[2], v[3]);
    case 'u': return new UDim(v[0], v[1]);
    case 't': {
      const tab = new LuaTable(w.a.map((x) => decodeValue(x, byId)));
      // nil holes inside the array part would break the border; trim at the first one
      const hole = tab.arr.indexOf(undefined);
      if (hole >= 0) { const rest = tab.arr.splice(hole); rest.forEach((x, i) => { if (x !== undefined) tab.set(hole + i + 1, x); }); }
      if (w.h) for (const [k, x] of w.h) { const dk = decodeValue(k, byId); if (dk !== undefined) tab.set(dk, decodeValue(x, byId)); }
      return tab;
    }
    case 'b': return unb64(v);
    case 'ns': return new NumberSequence(v.map((k) => new NumberSequenceKeypoint(k[0], k[1], k[2])));
    case 'cs': return new ColorSequence(v.map((k) => new ColorSequenceKeypoint(k[0], new Color3(k[1], k[2], k[3]))));
    case 'nr': return new NumberRange(v[0], v[1]);
    case 'r': return new Rect(v[0], v[1], v[2], v[3]);
    case 'pp': return new PhysicalProperties(...v);
    case 'f': return new Font(v[0], v[1], v[2]);
    case 'ray': return new Ray(new Vector3(v[0], v[1], v[2]), new Vector3(v[3], v[4], v[5]));
    case 'fa': return new Faces(v);
    case 'ax': return new Axes(v);
    case 'v3i': return new Vector3int16(v[0], v[1], v[2]);
    case 'v2i': return new Vector2int16(v[0], v[1]);
    case 'r3': return new Region3(new Vector3(v[0], v[1], v[2]), new Vector3(v[3], v[4], v[5]));
    case 'r3i': return new Region3int16(new Vector3int16(v[0], v[1], v[2]), new Vector3int16(v[3], v[4], v[5]));
    case 'nsk': return new NumberSequenceKeypoint(v[0], v[1], v[2]);
    case 'csk': return new ColorSequenceKeypoint(v[0], new Color3(v[1], v[2], v[3]));
    case 'ti': return new TweenInfo(v[0], enumItem('EasingStyle', v[1]), enumItem('EasingDirection', v[2]), v[3], v[4], v[5]);
    case 'dt': return new DateTime(v);
    case 'pw': return new PathWaypoint(new Vector3(v[0], v[1], v[2]), enumItem('PathWaypointAction', v[3]), v[4]);
    case 'arr': return v.map((x) => decodeValue(x, byId));
    default: return undefined;
  }
}

/** Compact pose encoding: [x, y, z, qx, qy, qz, qw] */
export function encodePose(cf) {
  const [qx, qy, qz, qw] = cf.toQuaternion();
  return [r4(cf.X), r4(cf.Y), r4(cf.Z), r5(qx), r5(qy), r5(qz), r5(qw)];
}
export function decodePose(a, i = 0) { return CFrame.fromQuaternion(a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5], a[i + 6]); }
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r5 = (n) => Math.round(n * 1e5) / 1e5;
