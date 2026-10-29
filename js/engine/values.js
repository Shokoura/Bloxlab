// Conversions between engine values and compact JSON ("wire") values.
// Used for class defaults, project files, replication and the property editor.
import {
  Vector3, Vector2, CFrame, Color3, UDim, UDim2, Rect, Ray, NumberRange, NumberSequence, NumberSequenceKeypoint,
  ColorSequence, ColorSequenceKeypoint, PhysicalProperties, Faces, Axes, Font, BrickColor, Vector3int16,
} from './datatypes.js';
import { EnumItem, getEnum, enumFromValue } from './enums.js';

export function fromWire(type, w) {
  if (type.startsWith('Enum:')) return w == null ? null : enumFromValue(type.slice(5), typeof w === 'number' ? w : w.Value ?? 0);
  switch (type) {
    case 'Bool': return !!w;
    case 'Int32': case 'Int64': case 'Float32': case 'Float64': return Number(w) || 0;
    case 'String': case 'Content': case 'ContentId': return w == null ? '' : String(w);
    case 'Vector3': return new Vector3(w[0], w[1], w[2]);
    case 'Vector2': return new Vector2(w[0], w[1]);
    case 'Vector3int16': return new Vector3int16(w[0], w[1], w[2]);
    case 'CFrame': return new CFrame(...w);
    case 'OptionalCFrame': return w ? new CFrame(...w) : null;
    case 'Color3': case 'Color3uint8': return new Color3(w[0], w[1], w[2]);
    case 'BrickColor': return BrickColor.fromNumber(w);
    case 'UDim': return new UDim(w[0], w[1]);
    case 'UDim2': return new UDim2(w[0], w[1], w[2], w[3]);
    case 'Rect': return new Rect(w[0], w[1], w[2], w[3]);
    case 'Ray': return new Ray(new Vector3(w[0], w[1], w[2]), new Vector3(w[3], w[4], w[5]));
    case 'NumberRange': return new NumberRange(w[0], w[1] ?? w[0]);
    case 'NumberSequence': return new NumberSequence(w.map((k) => new NumberSequenceKeypoint(k[0], k[1], k[2] || 0)));
    case 'ColorSequence': return new ColorSequence(w.map((k) => new ColorSequenceKeypoint(k[0], new Color3(k[1], k[2], k[3]))));
    case 'PhysicalProperties': return w ? new PhysicalProperties(...w) : null;
    case 'Faces': return new Faces(w);
    case 'Axes': return new Axes(w);
    case 'Font': return new Font(w[0], w[1], w[2]);
    case 'Ref': return null;
    default: return w;
  }
}

export function toWire(type, v) {
  if (type.startsWith('Enum:')) return v == null ? null : typeof v === 'number' ? v : v.Value;
  if (v == null) return null;
  switch (type) {
    case 'Bool': case 'Int32': case 'Int64': case 'Float32': case 'Float64': case 'String': case 'Content': case 'ContentId': return v;
    case 'Vector3': case 'Vector3int16': return [v.X, v.Y, v.Z];
    case 'Vector2': return [v.X, v.Y];
    case 'CFrame': case 'OptionalCFrame': return v.components();
    case 'Color3': case 'Color3uint8': return [v.R, v.G, v.B];
    case 'BrickColor': return v.Number;
    case 'UDim': return [v.Scale, v.Offset];
    case 'UDim2': return v.toArray();
    case 'Rect': return v.toArray();
    case 'Ray': return [v.Origin.X, v.Origin.Y, v.Origin.Z, v.Direction.X, v.Direction.Y, v.Direction.Z];
    case 'NumberRange': return [v.Min, v.Max];
    case 'NumberSequence': return v.Keypoints.map((k) => [k.Time, k.Value, k.Envelope]);
    case 'ColorSequence': return v.Keypoints.map((k) => [k.Time, k.Value.R, k.Value.G, k.Value.B]);
    case 'PhysicalProperties': return v.toArray();
    case 'Faces': case 'Axes': return v.bits;
    case 'Font': return [v.Family, v.Weight, v.Style];
    default: return undefined;
  }
}

// ---- self-describing encoding for values whose type is not known statically (attributes, remote args)
export function encodeTagged(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return v;
  if (v instanceof Vector3) return { $: 'V3', v: [v.X, v.Y, v.Z] };
  if (v instanceof Vector2) return { $: 'V2', v: [v.X, v.Y] };
  if (v instanceof CFrame) return { $: 'CF', v: v.components() };
  if (v instanceof Color3) return { $: 'C3', v: [v.R, v.G, v.B] };
  if (v instanceof BrickColor) return { $: 'BC', v: v.Number };
  if (v instanceof UDim2) return { $: 'U2', v: v.toArray() };
  if (v instanceof UDim) return { $: 'U1', v: [v.Scale, v.Offset] };
  if (v instanceof Rect) return { $: 'RC', v: v.toArray() };
  if (v instanceof NumberRange) return { $: 'NR', v: [v.Min, v.Max] };
  if (v instanceof NumberSequence) return { $: 'NS', v: toWire('NumberSequence', v) };
  if (v instanceof ColorSequence) return { $: 'CS', v: toWire('ColorSequence', v) };
  if (v instanceof Font) return { $: 'FT', v: toWire('Font', v) };
  if (v instanceof Ray) return { $: 'RY', v: toWire('Ray', v) };
  if (v instanceof EnumItem) return { $: 'EI', e: v.EnumType.name, v: v.Value };
  return undefined;
}
export function decodeTagged(w) {
  if (w === null || typeof w !== 'object') return w ?? undefined;
  switch (w.$) {
    case 'V3': return fromWire('Vector3', w.v);
    case 'V2': return fromWire('Vector2', w.v);
    case 'CF': return fromWire('CFrame', w.v);
    case 'C3': return fromWire('Color3', w.v);
    case 'BC': return fromWire('BrickColor', w.v);
    case 'U2': return fromWire('UDim2', w.v);
    case 'U1': return fromWire('UDim', w.v);
    case 'RC': return fromWire('Rect', w.v);
    case 'NR': return fromWire('NumberRange', w.v);
    case 'NS': return fromWire('NumberSequence', w.v);
    case 'CS': return fromWire('ColorSequence', w.v);
    case 'FT': return fromWire('Font', w.v);
    case 'RY': return fromWire('Ray', w.v);
    case 'EI': return getEnum(w.e)?.fromValue(w.v);
    default: return undefined;
  }
}

/** Structural equality for property values (avoids firing Changed for identical values). */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b;
  if (typeof a.eq === 'function') return a.eq(b);
  return false;
}
