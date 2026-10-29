// Exposes engine objects (Instances, datatypes, enums, signals) to Luau.
import {
  LuaTable, LuaError, EMPTY, R, mkgen, call, runSync, toByteStr, fromByteStr, typeName, tostr, numToStr,
} from '../luau/runtime.js';
import { Instance, mergedBehavior } from './instance.js';
import { classInfo, F } from './reflect.js';
import { Signal, Connection } from './signal.js';
import {
  Vector3, Vector2, CFrame, Color3, BrickColor, UDim, UDim2, Rect, Ray, Region3, Region3int16, NumberRange,
  NumberSequence, NumberSequenceKeypoint, ColorSequence, ColorSequenceKeypoint, PhysicalProperties, Faces, Axes,
  Font, TweenInfo, DateTime, RandomGen, RaycastParams, OverlapParams, RaycastResult, PathWaypoint, Vector3int16,
  Vector2int16, datatypeName, NORMALS, FONT_WEIGHTS,
} from './datatypes.js';
import { EnumItem, EnumType, getEnum, enumNames } from './enums.js';

// ================================================================ helpers
export const lerr = (msg) => new LuaError(msg, 1);
export const S = (v) => (typeof v === 'string' ? fromByteStr(v) : v === undefined ? undefined : typeof v === 'number' ? numToStr(v) : String(v));
export const L = (v) => (typeof v === 'string' ? toByteStr(v) : v);

/** Engine value -> Lua value */
export function toLua(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return toByteStr(v);
  if (Array.isArray(v)) return new LuaTable(v.map(toLua));
  return v;
}
export const arr = (list) => new LuaTable(list.map(toLua));
export function fromLuaArray(t) {
  if (!(t instanceof LuaTable)) return [];
  const out = [];
  for (let i = 1; i <= t.arr.length; i++) { const v = t.get(i); if (v !== undefined) out.push(v); }
  return out;
}
/** Lua table -> plain JS (for JSONEncode / network); returns undefined for unsupported */
export function luaToPlain(v, depth = 0) {
  if (depth > 64) throw lerr('table is too deep');
  if (v instanceof LuaTable) {
    const n = v.arr.length;
    const isArr = n > 0 && (!v.hash || v.hash.size === 0);
    if (isArr) return v.arr.map((x) => luaToPlain(x, depth + 1));
    const o = {};
    for (let i = 0; i < n; i++) o[String(i + 1)] = luaToPlain(v.arr[i], depth + 1);
    if (v.hash) for (const [k, x] of v.hash) if (typeof k === 'string' || typeof k === 'number') o[typeof k === 'string' ? fromByteStr(k) : String(k)] = luaToPlain(x, depth + 1);
    return o;
  }
  if (typeof v === 'string') return fromByteStr(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return v === undefined ? null : v;
}
export function plainToLua(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return new LuaTable(v.map(plainToLua));
  if (typeof v === 'object') {
    const t = new LuaTable();
    for (const [k, x] of Object.entries(v)) t.set(toByteStr(k), plainToLua(x));
    return t;
  }
  return toLua(v);
}

const num = (v, n, f, def) => {
  if (v === undefined && def !== undefined) return def;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  throw lerr(`invalid argument #${n} to '${f}' (number expected, got ${v === undefined ? 'nil' : typeName(v)})`);
};
const optNum = (v, d) => (v === undefined ? d : typeof v === 'number' ? v : Number(v) || d);
const check = (v, cls, n, f, tname) => {
  if (!(v instanceof cls)) throw lerr(`invalid argument #${n} to '${f}' (${tname} expected, got ${v === undefined ? 'nil' : luaTypeof(v)})`);
  return v;
};
export function luaTypeof(v) { return v != null && typeof v === 'object' && v.$typeof ? v.$typeof : typeName(v); }
const selfCheck = (self, cls, name, tname) => {
  if (!(self instanceof cls)) throw lerr(`Expected ':' not '.' calling member function ${name}`);
  return self;
};

/** Defines Lua access for a JS class: props (getters), methods (natives with self), meta (metamethods). */
function expose(cls, { typeName: tn, props = {}, methods = {}, meta = {}, newindex }) {
  const P = cls.prototype;
  const m = {};
  for (const [k, f] of Object.entries(methods)) { f.$name = k; f.$builtin = true; m[k] = f; }
  Object.defineProperty(P, '$typeof', { value: tn, configurable: true });
  P.$index = function (k) {
    const g = props[k];
    if (g) return toLua(g(this));
    const f = m[k];
    if (f) return f;
    throw lerr(`${typeof k === 'string' ? k : tostr(k)} is not a valid member of ${tn}`);
  };
  P.$newindex = newindex || function (k) { throw lerr(`${typeof k === 'string' ? k : tostr(k)} cannot be assigned to`); };
  const mt = { __tostring: (v) => [toByteStr(v.toString())], ...meta };
  if (!mt.__eq) mt.__eq = (a, b) => [a === b || (typeof a.eq === 'function' && a.eq(b))];
  for (const f of Object.values(mt)) if (typeof f === 'function') f.$builtin = true;
  Object.defineProperty(P, '$meta', { value: mt, configurable: true });
}
/** Builds a constructor library table (e.g. Vector3.new) */
function lib(fns, values = {}) {
  const t = new LuaTable();
  for (const [k, f] of Object.entries(fns)) { f.$name = k; f.$builtin = true; t.set(k, f); }
  for (const [k, v] of Object.entries(values)) t.set(k, v);
  t.frozen = true;
  return t;
}

// ================================================================ datatypes
const arith = (name, fn) => (a, b) => {
  try { return [fn(a, b)]; } catch { throw lerr(`attempt to perform arithmetic (${name}) on ${luaTypeof(a)} and ${luaTypeof(b)}`); }
};
const vecOp = (cls, name, op) => arith(name, (a, b) => {
  if (a instanceof cls && b instanceof cls) return a[op](b);
  if (a instanceof cls && typeof b === 'number' && (op === 'mul' || op === 'div' || op === 'idiv')) return a[op](b);
  if (typeof a === 'number' && b instanceof cls && op === 'mul') return b.mul(a);
  if (typeof a === 'number' && b instanceof cls && op === 'div') return new cls(...b.toArray().map((x) => a / x));
  throw new Error('bad');
});

expose(Vector3, {
  typeName: 'Vector3',
  props: {
    X: (v) => v.X, Y: (v) => v.Y, Z: (v) => v.Z, x: (v) => v.X, y: (v) => v.Y, z: (v) => v.Z,
    Magnitude: (v) => v.Magnitude, magnitude: (v) => v.Magnitude, Unit: (v) => v.Unit, unit: (v) => v.Unit,
  },
  methods: {
    Lerp: (a, b, t) => [a.lerp(check(b, Vector3, 1, 'Lerp', 'Vector3'), num(t, 2, 'Lerp'))],
    lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'lerp'))],
    Dot: (a, b) => [a.dot(check(b, Vector3, 1, 'Dot', 'Vector3'))],
    Cross: (a, b) => [a.cross(check(b, Vector3, 1, 'Cross', 'Vector3'))],
    FuzzyEq: (a, b, e) => [a.fuzzyEq(b, optNum(e, 1e-5))],
    Min: (a, ...o) => [a.min(...o)], Max: (a, ...o) => [a.max(...o)],
    Abs: (a) => [a.map(Math.abs)], Floor: (a) => [a.map(Math.floor)], Ceil: (a) => [a.map(Math.ceil)], Sign: (a) => [a.map(Math.sign)],
    Angle: (a, b, axis) => [a.angle(b, axis)],
    isClose: (a, b, e) => [a.fuzzyEq(b, optNum(e, 1e-5))],
  },
  meta: {
    __add: vecOp(Vector3, 'add', 'add'), __sub: vecOp(Vector3, 'sub', 'sub'), __mul: vecOp(Vector3, 'mul', 'mul'),
    __div: vecOp(Vector3, 'div', 'div'), __idiv: vecOp(Vector3, 'idiv', 'idiv'), __unm: (a) => [a.neg()],
  },
});
expose(Vector2, {
  typeName: 'Vector2',
  props: { X: (v) => v.X, Y: (v) => v.Y, x: (v) => v.X, y: (v) => v.Y, Magnitude: (v) => v.Magnitude, magnitude: (v) => v.Magnitude, Unit: (v) => v.Unit, unit: (v) => v.Unit },
  methods: {
    Lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'Lerp'))], lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'lerp'))],
    Dot: (a, b) => [a.dot(b)], Cross: (a, b) => [a.cross(b)], FuzzyEq: (a, b, e) => [a.fuzzyEq(b, optNum(e, 1e-5))],
    Min: (a, ...o) => [a.min(...o)], Max: (a, ...o) => [a.max(...o)], Abs: (a) => [a.map(Math.abs)], Floor: (a) => [a.map(Math.floor)],
    Ceil: (a) => [a.map(Math.ceil)], Sign: (a) => [a.map(Math.sign)], Angle: (a, b, s) => [a.angle(b, s)],
  },
  meta: {
    __add: vecOp(Vector2, 'add', 'add'), __sub: vecOp(Vector2, 'sub', 'sub'), __mul: vecOp(Vector2, 'mul', 'mul'),
    __div: vecOp(Vector2, 'div', 'div'), __idiv: vecOp(Vector2, 'idiv', 'idiv'), __unm: (a) => [a.neg()],
  },
});
expose(Vector3int16, { typeName: 'Vector3int16', props: { X: (v) => v.X, Y: (v) => v.Y, Z: (v) => v.Z }, meta: { __add: vecOp(Vector3int16, 'add', 'add'), __sub: vecOp(Vector3int16, 'sub', 'sub'), __mul: vecOp(Vector3int16, 'mul', 'mul'), __div: vecOp(Vector3int16, 'div', 'div') } });
expose(Vector2int16, { typeName: 'Vector2int16', props: { X: (v) => v.X, Y: (v) => v.Y }, meta: { __add: vecOp(Vector2int16, 'add', 'add'), __sub: vecOp(Vector2int16, 'sub', 'sub') } });

const cfComponents = (c) => c.components();
expose(CFrame, {
  typeName: 'CFrame',
  props: {
    Position: (c) => c.Position, p: (c) => c.Position, X: (c) => c.X, Y: (c) => c.Y, Z: (c) => c.Z, x: (c) => c.X, y: (c) => c.Y, z: (c) => c.Z,
    LookVector: (c) => c.LookVector, lookVector: (c) => c.LookVector, RightVector: (c) => c.RightVector, rightVector: (c) => c.RightVector,
    UpVector: (c) => c.UpVector, upVector: (c) => c.UpVector, XVector: (c) => c.XVector, YVector: (c) => c.YVector, ZVector: (c) => c.ZVector,
    Rotation: (c) => c.Rotation,
  },
  methods: {
    Inverse: (c) => [c.inverse()], inverse: (c) => [c.inverse()],
    Lerp: (a, b, t) => [a.lerp(check(b, CFrame, 1, 'Lerp', 'CFrame'), num(t, 2, 'Lerp'))], lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'lerp'))],
    Orthonormalize: (c) => [c.orthonormalize()],
    ToWorldSpace: (c, ...o) => o.map((x) => c.mul(x)), toWorldSpace: (c, ...o) => o.map((x) => c.mul(x)),
    ToObjectSpace: (c, ...o) => { const inv = c.inverse(); return o.map((x) => inv.mul(x)); }, toObjectSpace: (c, ...o) => { const inv = c.inverse(); return o.map((x) => inv.mul(x)); },
    PointToWorldSpace: (c, ...v) => v.map((x) => c.pointToWorld(x)), pointToWorldSpace: (c, ...v) => v.map((x) => c.pointToWorld(x)),
    PointToObjectSpace: (c, ...v) => v.map((x) => c.pointToObject(x)), pointToObjectSpace: (c, ...v) => v.map((x) => c.pointToObject(x)),
    VectorToWorldSpace: (c, ...v) => v.map((x) => c.vectorToWorld(x)), vectorToWorldSpace: (c, ...v) => v.map((x) => c.vectorToWorld(x)),
    VectorToObjectSpace: (c, ...v) => v.map((x) => c.vectorToObject(x)), vectorToObjectSpace: (c, ...v) => v.map((x) => c.vectorToObject(x)),
    GetComponents: cfComponents, components: cfComponents,
    ToEulerAnglesXYZ: (c) => c.toEulerXYZ(), toEulerAnglesXYZ: (c) => c.toEulerXYZ(),
    ToEulerAnglesYXZ: (c) => c.toEulerYXZ(), toEulerAnglesYXZ: (c) => c.toEulerYXZ(), ToOrientation: (c) => c.toEulerYXZ(),
    ToEulerAngles: (c, order) => (order && order.Name === 'YXZ' ? c.toEulerYXZ() : c.toEulerXYZ()),
    ToAxisAngle: (c) => c.toAxisAngle(), toAxisAngle: (c) => c.toAxisAngle(),
    FuzzyEq: (a, b, e) => [a.fuzzyEq(b, optNum(e, 1e-5))],
    AngleBetween: (a, b) => [a.Rotation.inverse().mul(b.Rotation).toAxisAngle()[1]],
  },
  meta: {
    __mul: (a, b) => {
      if (a instanceof CFrame && (b instanceof CFrame || b instanceof Vector3)) return [a.mul(b)];
      throw lerr(`attempt to perform arithmetic (mul) on ${luaTypeof(a)} and ${luaTypeof(b)}`);
    },
    __add: (a, b) => { if (a instanceof CFrame && b instanceof Vector3) return [a.add(b)]; throw lerr(`attempt to perform arithmetic (add) on ${luaTypeof(a)} and ${luaTypeof(b)}`); },
    __sub: (a, b) => { if (a instanceof CFrame && b instanceof Vector3) return [a.sub(b)]; throw lerr(`attempt to perform arithmetic (sub) on ${luaTypeof(a)} and ${luaTypeof(b)}`); },
  },
});
expose(Color3, {
  typeName: 'Color3',
  props: { R: (c) => c.R, G: (c) => c.G, B: (c) => c.B, r: (c) => c.R, g: (c) => c.G, b: (c) => c.B },
  methods: { Lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'Lerp'))], lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'lerp'))], ToHSV: (c) => c.toHSV(), ToHex: (c) => [c.toHex()] },
});
expose(BrickColor, {
  typeName: 'BrickColor',
  props: { Name: (b) => b.Name, Number: (b) => b.Number, Color: (b) => b.Color, r: (b) => b.r, g: (b) => b.g, b: (b) => b.b },
});
expose(UDim, {
  typeName: 'UDim',
  props: { Scale: (u) => u.Scale, Offset: (u) => u.Offset },
  meta: { __add: arith('add', (a, b) => a.add(b)), __sub: arith('sub', (a, b) => a.sub(b)), __unm: (a) => [a.neg()] },
});
expose(UDim2, {
  typeName: 'UDim2',
  props: { X: (u) => u.X, Y: (u) => u.Y, Width: (u) => u.X, Height: (u) => u.Y },
  methods: { Lerp: (a, b, t) => [a.lerp(b, num(t, 2, 'Lerp'))] },
  meta: { __add: arith('add', (a, b) => a.add(b)), __sub: arith('sub', (a, b) => a.sub(b)), __unm: (a) => [a.neg()] },
});
expose(Rect, { typeName: 'Rect', props: { Min: (r) => r.Min, Max: (r) => r.Max, Width: (r) => r.Width, Height: (r) => r.Height } });
expose(Ray, {
  typeName: 'Ray',
  props: { Origin: (r) => r.Origin, Direction: (r) => r.Direction, Unit: (r) => r.Unit, unit: (r) => r.Unit },
  methods: { ClosestPoint: (r, p) => [r.closestPoint(p)], Distance: (r, p) => [r.distance(p)] },
});
expose(Region3, { typeName: 'Region3', props: { CFrame: (r) => r.CFrame, Size: (r) => r.Size }, methods: { ExpandToGrid: (r, res) => [r.expandToGrid(num(res, 1, 'ExpandToGrid'))] } });
expose(Region3int16, { typeName: 'Region3int16', props: { Min: (r) => r.Min, Max: (r) => r.Max } });
expose(NumberRange, { typeName: 'NumberRange', props: { Min: (r) => r.Min, Max: (r) => r.Max } });
expose(NumberSequenceKeypoint, { typeName: 'NumberSequenceKeypoint', props: { Time: (k) => k.Time, Value: (k) => k.Value, Envelope: (k) => k.Envelope } });
expose(NumberSequence, { typeName: 'NumberSequence', props: { Keypoints: (s) => s.Keypoints } });
expose(ColorSequenceKeypoint, { typeName: 'ColorSequenceKeypoint', props: { Time: (k) => k.Time, Value: (k) => k.Value } });
expose(ColorSequence, { typeName: 'ColorSequence', props: { Keypoints: (s) => s.Keypoints } });
expose(PhysicalProperties, { typeName: 'PhysicalProperties', props: { Density: (p) => p.Density, Friction: (p) => p.Friction, Elasticity: (p) => p.Elasticity, FrictionWeight: (p) => p.FrictionWeight, ElasticityWeight: (p) => p.ElasticityWeight, AcousticAbsorption: (p) => p.AcousticAbsorption } });
expose(Faces, { typeName: 'Faces', props: Object.fromEntries(['Right', 'Top', 'Back', 'Left', 'Bottom', 'Front'].map((n) => [n, (f) => f[n]])) });
expose(Axes, { typeName: 'Axes', props: Object.fromEntries(['X', 'Y', 'Z', 'Right', 'Left', 'Top', 'Bottom', 'Front', 'Back'].map((n) => [n, (f) => f[n]])) });
expose(Font, {
  typeName: 'Font',
  props: { Family: (f) => f.Family, Weight: (f) => getEnum('FontWeight').fromValue(f.Weight), Style: (f) => getEnum('FontStyle').get(f.Style), Bold: (f) => f.Bold },
  newindex(k, v) {
    if (k === 'Weight') this.Weight = v instanceof EnumItem ? v.Value : num(v, 3, 'Weight');
    else if (k === 'Style') this.Style = v instanceof EnumItem ? v.Name : S(v);
    else if (k === 'Bold') this.Weight = v ? 700 : 400;
    else if (k === 'Family') this.Family = S(v);
    else throw lerr(`${k} cannot be assigned to`);
  },
});
expose(TweenInfo, {
  typeName: 'TweenInfo',
  props: { Time: (t) => t.Time, EasingStyle: (t) => t.EasingStyle, EasingDirection: (t) => t.EasingDirection, RepeatCount: (t) => t.RepeatCount, Reverses: (t) => t.Reverses, DelayTime: (t) => t.DelayTime },
});
expose(DateTime, {
  typeName: 'DateTime',
  props: { UnixTimestamp: (d) => d.UnixTimestamp, UnixTimestampMillis: (d) => d.UnixTimestampMillis },
  methods: {
    ToIsoDate: (d) => [new Date(d.UnixTimestampMillis).toISOString().replace(/\.\d+Z$/, 'Z')],
    ToUniversalTime: (d) => [dateTable(new Date(d.UnixTimestampMillis), true)],
    ToLocalTime: (d) => [dateTable(new Date(d.UnixTimestampMillis), false)],
    FormatUniversalTime: (d, fmt) => [toByteStr(formatDate(new Date(d.UnixTimestampMillis), S(fmt), true))],
    FormatLocalTime: (d, fmt) => [toByteStr(formatDate(new Date(d.UnixTimestampMillis), S(fmt), false))],
  },
});
function dateTable(d, utc) {
  const g = (m) => (utc ? d[`getUTC${m}`]() : d[`get${m}`]());
  const t = new LuaTable();
  t.set('Year', g('FullYear')); t.set('Month', g('Month') + 1); t.set('Day', g('Date')); t.set('Hour', g('Hours'));
  t.set('Minute', g('Minutes')); t.set('Second', g('Seconds')); t.set('Millisecond', g('Milliseconds'));
  return t;
}
function formatDate(d, fmt, utc) {
  const g = (m) => (utc ? d[`getUTC${m}`]() : d[`get${m}`]());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const map = {
    YYYY: g('FullYear'), YY: p(g('FullYear') % 100), MMMM: months[g('Month')], MMM: months[g('Month')].slice(0, 3), MM: p(g('Month') + 1), M: g('Month') + 1,
    dddd: days[g('Day')], ddd: days[g('Day')].slice(0, 3), DD: p(g('Date')), D: g('Date'), HH: p(g('Hours')), H: g('Hours'),
    hh: p(((g('Hours') + 11) % 12) + 1), h: ((g('Hours') + 11) % 12) + 1, mm: p(g('Minutes')), m: g('Minutes'), ss: p(g('Seconds')), s: g('Seconds'),
    A: g('Hours') < 12 ? 'AM' : 'PM', a: g('Hours') < 12 ? 'am' : 'pm', LT: `${((g('Hours') + 11) % 12) + 1}:${p(g('Minutes'))} ${g('Hours') < 12 ? 'AM' : 'PM'}`,
    L: `${p(g('Month') + 1)}/${p(g('Date'))}/${g('FullYear')}`, LL: `${months[g('Month')]} ${g('Date')}, ${g('FullYear')}`,
  };
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|m|ss|s|A|a|LT|LL|L/g, (k) => String(map[k]));
}
expose(RandomGen, {
  typeName: 'Random',
  methods: {
    NextNumber: (r, a, b) => [r.nextNumber(optNum(a, 0), optNum(b, 1))],
    NextInteger: (r, a, b) => [r.nextInteger(Math.trunc(num(a, 1, 'NextInteger')), Math.trunc(num(b, 2, 'NextInteger')))],
    NextUnitVector: (r) => { const z = r.nextNumber(-1, 1), t = r.nextNumber(0, Math.PI * 2), s = Math.sqrt(1 - z * z); return [new Vector3(s * Math.cos(t), s * Math.sin(t), z)]; },
    Shuffle: (r, t) => { const a = t.arr; for (let i = a.length - 1; i > 0; i--) { const j = r.nextInteger(0, i); [a[i], a[j]] = [a[j], a[i]]; } },
    Clone: (r) => [r.clone()],
  },
});
const paramsProps = (keys) => ({
  props: Object.fromEntries(keys.map((k) => [k, (p) => (k === 'FilterDescendantsInstances' ? arr(p[k]) : p[k])])),
  newindex(k, v) {
    if (!keys.includes(k)) throw lerr(`${k} is not a valid member`);
    if (k === 'FilterDescendantsInstances') this[k] = fromLuaArray(v);
    else if (k === 'CollisionGroup') this[k] = S(v);
    else this[k] = v;
  },
  methods: {
    AddToFilter(p, v) { if (v instanceof Instance) p.FilterDescendantsInstances.push(v); else p.FilterDescendantsInstances.push(...fromLuaArray(v)); },
  },
});
expose(RaycastParams, { typeName: 'RaycastParams', ...paramsProps(['FilterDescendantsInstances', 'FilterType', 'IgnoreWater', 'CollisionGroup', 'RespectCanCollide', 'BruteForceAllSlow']) });
expose(OverlapParams, { typeName: 'OverlapParams', ...paramsProps(['FilterDescendantsInstances', 'FilterType', 'MaxParts', 'CollisionGroup', 'RespectCanCollide', 'BruteForceAllSlow']) });
expose(RaycastResult, { typeName: 'RaycastResult', props: { Instance: (r) => r.Instance, Position: (r) => r.Position, Normal: (r) => r.Normal, Material: (r) => r.Material, Distance: (r) => r.Distance } });
expose(PathWaypoint, { typeName: 'PathWaypoint', props: { Position: (w) => w.Position, Action: (w) => w.Action, Label: (w) => w.Label } });

// ================================================================ enums
Object.defineProperty(EnumItem.prototype, '$typeof', { value: 'EnumItem' });
EnumItem.prototype.$index = function (k) {
  switch (k) {
    case 'Name': return toByteStr(this.Name);
    case 'Value': return this.Value;
    case 'EnumType': return this.EnumType;
    case 'IsA': return ENUMITEM_ISA;
    default: throw lerr(`${k} is not a valid member of "${this}"`);
  }
};
EnumItem.prototype.$newindex = function (k) { throw lerr(`${k} cannot be assigned to`); };
Object.defineProperty(EnumItem.prototype, '$meta', { value: { __tostring: (e) => [e.toString()], __eq: (a, b) => [a === b || (a.EnumType === b.EnumType && a.Value === b.Value)] } });
const ENUMITEM_ISA = (self, name) => [self.EnumType.name === S(name)];
ENUMITEM_ISA.$builtin = true;

Object.defineProperty(EnumType.prototype, '$typeof', { value: 'Enum' });
EnumType.prototype.$index = function (k) {
  if (k === 'GetEnumItems') return ENUM_GETITEMS;
  if (k === 'FromName') return ENUM_FROMNAME;
  if (k === 'FromValue') return ENUM_FROMVALUE;
  const it = this.byName.get(k);
  if (it) return it;
  throw lerr(`${k} is not a valid member of "Enum.${this.name}"`);
};
EnumType.prototype.$newindex = function (k) { throw lerr(`${k} cannot be assigned to`); };
Object.defineProperty(EnumType.prototype, '$meta', { value: { __tostring: (e) => [e.name] } });
const ENUM_GETITEMS = (self) => [arr(self.items())];
const ENUM_FROMNAME = (self, n) => [self.byName.get(S(n))];
const ENUM_FROMVALUE = (self, v) => [self.byValue.get(v)];
for (const f of [ENUM_GETITEMS, ENUM_FROMNAME, ENUM_FROMVALUE]) f.$builtin = true;

class Enums {
  get $typeof() { return 'Enums'; }
  $index(k) {
    if (k === 'GetEnums') return ENUMS_GET;
    const e = getEnum(k);
    if (!e) throw lerr(`${k} is not a valid member of "Enum"`);
    return e;
  }
  $newindex(k) { throw lerr(`${k} cannot be assigned to`); }
  $tostring() { return 'Enums'; }
}
Object.defineProperty(Enums.prototype, '$meta', { value: { __tostring: () => ['Enums'] } });
const ENUMS_GET = () => [arr(enumNames().map(getEnum))];
export const EnumRoot = new Enums();

/** Converts Lua values to EnumItems of the given enum (accepts EnumItem, number or name). */
export function toEnum(enumName, v, what = 'value') {
  const e = getEnum(enumName);
  if (v instanceof EnumItem) {
    if (v.EnumType.name !== enumName && e) throw lerr(`Invalid value "${v}" for enum ${enumName}`);
    return v;
  }
  if (!e) return v;
  if (typeof v === 'number') { const it = e.fromValue(v); if (it) return it; }
  if (typeof v === 'string') { const it = e.get(fromByteStr(v)); if (it) return it; }
  throw lerr(`Invalid value for enum ${enumName} (${what})`);
}

// ================================================================ signals
const sigMethods = {
  Connect: (self, fn) => { if (typeof fn !== 'function') throw lerr('Attempt to connect failed: Passed value is not a function'); return [self.connectLua(fn)]; },
  connect: (self, fn) => [self.connectLua(fn)],
  Once: (self, fn) => { if (typeof fn !== 'function') throw lerr('Attempt to connect failed: Passed value is not a function'); return [self.connectLua(fn, true)]; },
  ConnectParallel: (self, fn) => [self.connectLua(fn)],
  Wait: mkgen(function* (self) {
    const world = R.current && R.current.owner && R.current.owner.world;
    if (!world) throw lerr('Wait can only be used from a script');
    return yield* world.scheduler.waitFor((wake) => self.waiting.push({ wake }));
  }, 'Wait'),
};
sigMethods.wait = sigMethods.Wait;
for (const f of Object.values(sigMethods)) f.$builtin = true;
Signal.prototype.$index = function (k) {
  const f = sigMethods[k];
  if (f) return f;
  throw lerr(`${k} is not a valid member of RBXScriptSignal`);
};
Signal.prototype.$newindex = function (k) { throw lerr(`${k} cannot be assigned to`); };
Object.defineProperty(Signal.prototype, '$meta', { value: { __tostring: (s) => [`Signal ${s.name}`] } });

const DISCONNECT = (self) => { self.disconnect(); };
DISCONNECT.$builtin = true;
Connection.prototype.$index = function (k) {
  if (k === 'Disconnect' || k === 'disconnect') return DISCONNECT;
  if (k === 'Connected') return this.Connected;
  throw lerr(`${k} is not a valid member of RBXScriptConnection`);
};
Connection.prototype.$newindex = function (k) { throw lerr(`${k} cannot be assigned to`); };
Object.defineProperty(Connection.prototype, '$meta', { value: { __tostring: () => ['Connection'] } });

// ================================================================ instances
const memberCache = new Map(); // className -> Map(key -> member)
const unsupportedWarned = new Set();

function memberOf(inst, k) {
  let cache = memberCache.get(inst.ClassName);
  if (!cache) { cache = new Map(); memberCache.set(inst.ClassName, cache); }
  let m = cache.get(k);
  if (m !== undefined) return m;
  m = resolveMember(inst.ClassName, k);
  cache.set(k, m);
  return m;
}
export function invalidateMemberCache() { memberCache.clear(); }

function resolveMember(className, k) {
  const beh = mergedBehavior(className);
  const info = classInfo(className);
  if (beh.props[k]) return { kind: 'prop', name: k, type: (info.props[k] && info.props[k].type) || beh.props[k].type || 'any', acc: beh.props[k], flags: info.props[k] ? info.props[k].flags : 0 };
  if (beh.methods[k]) return { kind: 'method', fn: beh.methods[k] };
  const p = info.props[k];
  if (p) {
    if (p.flags & F.ALIAS && p.extra && p.extra !== k) { const c = resolveMember(className, p.extra); if (c) return c; }
    if (!(p.flags & F.NOTSCRIPTABLE)) return { kind: 'prop', name: k, type: p.type, flags: p.flags };
  }
  if (info.events.has(k) || beh.events.has(k)) return { kind: 'event', name: k };
  // deprecated camelCase spellings: findFirstChild -> FindFirstChild
  const cap = k[0] && k[0].toUpperCase() + k.slice(1);
  if (cap !== k && (beh.methods[cap] || info.methods.has(cap) || info.events.has(cap))) {
    if (info.methods.has(k) || info.events.has(k)) return resolveMember(className, cap);
  }
  if (info.methods.has(k)) {
    const stub = (self) => {
      const key = `${className}.${k}`;
      if (!unsupportedWarned.has(key)) {
        unsupportedWarned.add(key);
        const w = self && self.world;
        if (w) w.output(`${className}:${k}() is not supported in Bloxlab yet`, 'warn');
      }
      return EMPTY;
    };
    stub.$builtin = true;
    stub.$name = k;
    return { kind: 'method', fn: stub, stub: true };
  }
  return null;
}

/** Engine value of property `type` -> Lua */
export function propToLua(type, v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return toByteStr(v);
  if (type === 'Ref' && v && v.destroyed && !v.parent && false) return undefined;
  return v;
}

/** Lua value -> engine value for a property of `type` (throws on mismatch). */
export function luaToProp(type, v, prop) {
  const bad = (exp) => lerr(`Unable to assign property ${prop}. ${exp} expected, got ${v === undefined ? 'nil' : luaTypeof(v)}`);
  if (type.startsWith('Enum:')) return toEnum(type.slice(5), v, prop);
  switch (type) {
    case 'Bool': if (typeof v === 'boolean') return v; if (v === undefined) return false; throw bad('bool');
    case 'Int32': case 'Int64': { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (Number.isNaN(n)) throw bad('int'); return Math.trunc(n); }
    case 'Float32': case 'Float64': { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (typeof v !== 'number' && Number.isNaN(n)) throw bad('number'); return n; }
    case 'String': case 'Content': case 'ContentId':
      if (typeof v === 'string') return fromByteStr(v);
      if (typeof v === 'number') return numToStr(v);
      if (v === undefined && type !== 'String') return '';
      throw bad('string');
    case 'Ref': if (v === undefined) return null; if (v instanceof Instance) return v; throw bad('Instance');
    case 'Vector3': if (v instanceof Vector3) return v; throw bad('Vector3');
    case 'Vector2': if (v instanceof Vector2) return v; throw bad('Vector2');
    case 'CFrame': if (v instanceof CFrame) return v; throw bad('CFrame');
    case 'OptionalCFrame': if (v === undefined || v instanceof CFrame) return v ?? null; throw bad('CFrame');
    case 'Color3': case 'Color3uint8': if (v instanceof Color3) return v; throw bad('Color3');
    case 'BrickColor': if (v instanceof BrickColor) return v; if (typeof v === 'number') return BrickColor.fromNumber(v); throw bad('BrickColor');
    case 'UDim': if (v instanceof UDim) return v; throw bad('UDim');
    case 'UDim2': if (v instanceof UDim2) return v; throw bad('UDim2');
    case 'Rect': if (v instanceof Rect) return v; throw bad('Rect');
    case 'Ray': if (v instanceof Ray) return v; throw bad('Ray');
    case 'NumberRange': if (v instanceof NumberRange) return v; if (typeof v === 'number') return new NumberRange(v); throw bad('NumberRange');
    case 'NumberSequence': if (v instanceof NumberSequence) return v; if (typeof v === 'number') return new NumberSequence(v); throw bad('NumberSequence');
    case 'ColorSequence': if (v instanceof ColorSequence) return v; if (v instanceof Color3) return new ColorSequence(v); throw bad('ColorSequence');
    case 'PhysicalProperties': if (v === undefined || v instanceof PhysicalProperties) return v ?? null; throw bad('PhysicalProperties');
    case 'Faces': if (v instanceof Faces) return v; throw bad('Faces');
    case 'Axes': if (v instanceof Axes) return v; throw bad('Axes');
    case 'Font': if (v instanceof Font) return v; throw bad('Font');
    case 'Vector3int16': if (v instanceof Vector3int16) return v; throw bad('Vector3int16');
    case 'any': return typeof v === 'string' ? fromByteStr(v) : v;
    default: return typeof v === 'string' ? fromByteStr(v) : v;
  }
}

export function luaGetMember(inst, k) {
  if (typeof k !== 'string') throw lerr(`invalid member access ${tostr(k)}`);
  const m = memberOf(inst, k);
  if (m) {
    switch (m.kind) {
      case 'prop': {
        if (m.flags & F.WRITEONLY) throw lerr(`${k} is not a valid member of ${inst.ClassName} "${inst.getFullName()}"`);
        if (m.acc && m.acc.lua) return m.acc.lua(inst);
        if (m.acc && m.acc.get) return propToLua(m.type, m.acc.get(inst));
        return propToLua(m.type, inst.props[m.name]);
      }
      case 'method': return m.fn;
      case 'event': return inst.signal(k);
      default: break;
    }
  }
  const name = fromByteStr(k);
  for (const c of inst.children) if (c.props.Name === name) return c;
  throw lerr(`${name} is not a valid member of ${inst.ClassName} "${inst.getFullName()}"`);
}

export function luaSetMember(inst, k, v) {
  if (typeof k !== 'string') throw lerr(`invalid member access ${tostr(k)}`);
  if (k === 'Parent') {
    if (v !== undefined && !(v instanceof Instance)) throw lerr(`Unable to assign property Parent. Instance expected, got ${luaTypeof(v)}`);
    try { inst.setParent(v || null); } catch (e) { if (e instanceof LuaError) throw e; throw lerr(e.message); }
    return;
  }
  const m = memberOf(inst, k);
  if (!m || m.kind !== 'prop') {
    if (m && m.kind !== 'prop') throw lerr(`${k} cannot be assigned to`);
    throw lerr(`${fromByteStr(k)} is not a valid member of ${inst.ClassName} "${inst.getFullName()}"`);
  }
  if (m.acc && m.acc.luaSet) { m.acc.luaSet(inst, v); return; }
  if ((m.flags & F.READONLY) && !(m.acc && m.acc.set)) throw lerr(`Unable to assign property ${k}. Property is read only`);
  if (m.acc && m.acc.readonly) throw lerr(`Unable to assign property ${k}. Property is read only`);
  const val = luaToProp(m.type, v, k);
  if (m.acc && m.acc.set) m.acc.set(inst, val);
  else inst.set(m.name, val);
}

Instance.prototype.$index = function (k) { return luaGetMember(this, k); };
Instance.prototype.$newindex = function (k, v) { luaSetMember(this, k, v); };
Object.defineProperty(Instance.prototype, '$meta', {
  value: {
    __tostring: (i) => [toByteStr(i.props.Name)],
    __eq: (a, b) => [a === b],
  },
});

/** Registers native methods for a class; wraps them with self checks. */
export function methods(defs) {
  const out = {};
  for (const [name, fn] of Object.entries(defs)) {
    const wrapped = fn.constructor.name === 'GeneratorFunction'
      ? mkgen(function* (self, ...a) { selfCheck(self, Instance, name); return (yield* fn(self, ...a)) || EMPTY; }, name)
      : Object.assign((self, ...a) => { selfCheck(self, Instance, name); const r = fn(self, ...a); return r === undefined ? EMPTY : r; }, { $name: name });
    wrapped.$builtin = true;
    out[name] = wrapped;
  }
  return out;
}

// ================================================================ constructors (globals)
const V3 = (x, y, z) => new Vector3(optNum(x, 0), optNum(y, 0), optNum(z, 0));
export const constructors = {
  Vector3: lib({
    new: (x, y, z) => [V3(x, y, z)],
    FromNormalId: (n) => [NORMALS[toEnum('NormalId', n).Value]],
    FromAxis: (a) => { const it = toEnum('Axis', a); return [[Vector3.xAxis, Vector3.yAxis, Vector3.zAxis][it.Value]]; },
  }, { zero: Vector3.zero, one: Vector3.one, xAxis: Vector3.xAxis, yAxis: Vector3.yAxis, zAxis: Vector3.zAxis }),
  Vector2: lib({ new: (x, y) => [new Vector2(optNum(x, 0), optNum(y, 0))] }, { zero: Vector2.zero, one: Vector2.one, xAxis: Vector2.xAxis, yAxis: Vector2.yAxis }),
  Vector3int16: lib({ new: (x, y, z) => [new Vector3int16(optNum(x, 0), optNum(y, 0), optNum(z, 0))] }),
  Vector2int16: lib({ new: (x, y) => [new Vector2int16(optNum(x, 0), optNum(y, 0))] }),
  CFrame: lib({
    new: (...a) => {
      if (a.length === 0) return [CFrame.identity];
      if (a[0] instanceof Vector3) {
        if (a[1] instanceof Vector3) return [CFrame.lookAt(a[0], a[1])];
        if (a.length >= 5 && typeof a[1] === 'number') { const [p, qx, qy, qz, qw] = a; return [CFrame.fromQuaternion(p.X, p.Y, p.Z, qx, qy, qz, qw)]; }
        return [new CFrame(a[0].X, a[0].Y, a[0].Z)];
      }
      if (a.length === 7) return [CFrame.fromQuaternion(...a.map(Number))];
      if (a.length >= 12) return [new CFrame(...a.slice(0, 12).map(Number))];
      return [new CFrame(num(a[0], 1, 'new'), optNum(a[1], 0), optNum(a[2], 0))];
    },
    Angles: (x, y, z) => [CFrame.angles(optNum(x, 0), optNum(y, 0), optNum(z, 0))],
    fromEulerAnglesXYZ: (x, y, z) => [CFrame.angles(optNum(x, 0), optNum(y, 0), optNum(z, 0))],
    fromEulerAnglesYXZ: (x, y, z) => [CFrame.fromEulerYXZ(optNum(x, 0), optNum(y, 0), optNum(z, 0))],
    fromOrientation: (x, y, z) => [CFrame.fromEulerYXZ(optNum(x, 0), optNum(y, 0), optNum(z, 0))],
    fromEulerAngles: (x, y, z, order) => [order && order.Name === 'YXZ' ? CFrame.fromEulerYXZ(x, y, z) : CFrame.angles(optNum(x, 0), optNum(y, 0), optNum(z, 0))],
    fromAxisAngle: (axis, angle) => [CFrame.fromAxisAngle(check(axis, Vector3, 1, 'fromAxisAngle', 'Vector3'), num(angle, 2, 'fromAxisAngle'))],
    lookAt: (at, target, up) => [CFrame.lookAt(check(at, Vector3, 1, 'lookAt', 'Vector3'), check(target, Vector3, 2, 'lookAt', 'Vector3'), up || Vector3.yAxis)],
    lookAlong: (at, dir, up) => [CFrame.lookAt(at, at.add(dir), up || Vector3.yAxis)],
    fromMatrix: (pos, vx, vy, vz) => [CFrame.fromMatrix(pos, vx, vy, vz)],
  }, { identity: CFrame.identity }),
  Color3: lib({
    new: (r, g, b) => [new Color3(optNum(r, 0), optNum(g, 0), optNum(b, 0))],
    fromRGB: (r, g, b) => [Color3.fromRGB(optNum(r, 0), optNum(g, 0), optNum(b, 0))],
    fromHSV: (h, s, v) => [Color3.fromHSV(num(h, 1, 'fromHSV'), num(s, 2, 'fromHSV'), num(v, 3, 'fromHSV'))],
    toHSV: (c) => check(c, Color3, 1, 'toHSV', 'Color3').toHSV(),
    fromHex: (h) => { try { return [Color3.fromHex(S(h))]; } catch (e) { throw lerr(e.message); } },
  }),
  BrickColor: lib({
    new: (a, b, c) => {
      if (typeof a === 'number' && b !== undefined) return [BrickColor.fromColor3(new Color3(a, b, c))];
      if (typeof a === 'number') return [BrickColor.fromNumber(a)];
      if (typeof a === 'string') return [BrickColor.fromName(fromByteStr(a))];
      if (a instanceof Color3) return [BrickColor.fromColor3(a)];
      return [BrickColor.fromNumber(194)];
    },
    palette: (i) => [BrickColor.palette(num(i, 1, 'palette'))],
    random: () => [BrickColor.random()],
    White: () => [BrickColor.fromName('White')], Gray: () => [BrickColor.fromName('Medium stone grey')], DarkGray: () => [BrickColor.fromName('Dark stone grey')],
    Black: () => [BrickColor.fromName('Black')], Red: () => [BrickColor.fromName('Bright red')], Yellow: () => [BrickColor.fromName('Bright yellow')],
    Green: () => [BrickColor.fromName('Dark green')], Blue: () => [BrickColor.fromName('Bright blue')],
    fromHex: (h) => [BrickColor.fromColor3(Color3.fromHex(S(h)))],
  }),
  UDim: lib({ new: (s, o) => [new UDim(optNum(s, 0), optNum(o, 0))] }),
  UDim2: lib({
    new: (a, b, c, d) => {
      if (a instanceof UDim) return [new UDim2(a, b)];
      return [new UDim2(optNum(a, 0), optNum(b, 0), optNum(c, 0), optNum(d, 0))];
    },
    fromScale: (x, y) => [UDim2.fromScale(optNum(x, 0), optNum(y, 0))],
    fromOffset: (x, y) => [UDim2.fromOffset(optNum(x, 0), optNum(y, 0))],
  }),
  Rect: lib({ new: (a, b, c, d) => [a instanceof Vector2 ? new Rect(a, b) : new Rect(optNum(a, 0), optNum(b, 0), optNum(c, 0), optNum(d, 0))] }),
  Ray: lib({ new: (o, d) => [new Ray(o || Vector3.zero, d || Vector3.zero)] }),
  Region3: lib({ new: (a, b) => [new Region3(a || Vector3.zero, b || Vector3.zero)] }),
  Region3int16: lib({ new: (a, b) => [new Region3int16(a, b)] }),
  NumberRange: lib({ new: (a, b) => { try { return [new NumberRange(num(a, 1, 'new'), b === undefined ? a : num(b, 2, 'new'))]; } catch (e) { throw lerr(e.message); } } }),
  NumberSequenceKeypoint: lib({ new: (t, v, e) => [new NumberSequenceKeypoint(num(t, 1, 'new'), num(v, 2, 'new'), optNum(e, 0))] }),
  NumberSequence: lib({
    new: (a, b) => {
      if (a instanceof LuaTable) return [new NumberSequence(fromLuaArray(a))];
      return [new NumberSequence(num(a, 1, 'new'), b === undefined ? a : num(b, 2, 'new'))];
    },
  }),
  ColorSequenceKeypoint: lib({ new: (t, c) => [new ColorSequenceKeypoint(num(t, 1, 'new'), check(c, Color3, 2, 'new', 'Color3'))] }),
  ColorSequence: lib({
    new: (a, b) => {
      if (a instanceof LuaTable) return [new ColorSequence(fromLuaArray(a))];
      return [new ColorSequence(check(a, Color3, 1, 'new', 'Color3'), b)];
    },
  }),
  PhysicalProperties: lib({
    new: (...a) => {
      if (a[0] instanceof EnumItem) return [materialPhysics(a[0])];
      return [new PhysicalProperties(...a.map((x) => num(x, 1, 'new')))];
    },
  }),
  Faces: lib({ new: (...items) => [Faces.fromNames(items.map((i) => (i instanceof EnumItem ? i.Name : S(i))))] }),
  Axes: lib({ new: (...items) => { let b = 0; for (const i of items) { const n = i instanceof EnumItem ? i.Name : S(i); b |= { X: 1, Right: 1, Left: 1, Y: 2, Top: 2, Bottom: 2, Z: 4, Back: 4, Front: 4 }[n] || 0; } return [new Axes(b)]; } }),
  Font: lib({
    new: (family, weight, style) => [new Font(S(family), weight instanceof EnumItem ? weight.Value : 400, style instanceof EnumItem ? style.Name : 'Normal')],
    fromEnum: (e) => [fontFromEnum(e)],
    fromName: (name, weight, style) => [new Font(`rbxasset://fonts/families/${S(name)}.json`, weight instanceof EnumItem ? weight.Value : 400, style instanceof EnumItem ? style.Name : 'Normal')],
    fromId: (id, weight, style) => [new Font(`rbxassetid://${id}`, weight instanceof EnumItem ? weight.Value : 400, style instanceof EnumItem ? style.Name : 'Normal')],
  }),
  TweenInfo: lib({
    new: (time, style, dir, rep, rev, delay) => [new TweenInfo(optNum(time, 1), style ? toEnum('EasingStyle', style) : getEnum('EasingStyle').get('Quad'), dir ? toEnum('EasingDirection', dir) : getEnum('EasingDirection').get('Out'), optNum(rep, 0), !!rev && rev !== false, optNum(delay, 0))],
  }),
  DateTime: lib({
    now: () => [new DateTime(Date.now())],
    fromUnixTimestamp: (t) => [new DateTime(num(t, 1, 'fromUnixTimestamp') * 1000)],
    fromUnixTimestampMillis: (t) => [new DateTime(num(t, 1, 'fromUnixTimestampMillis'))],
    fromIsoDate: (s) => { const t = Date.parse(S(s)); return [Number.isNaN(t) ? undefined : new DateTime(t)]; },
    fromUniversalTime: (y, mo, d, h, mi, s, ms) => [new DateTime(Date.UTC(optNum(y, 1970), optNum(mo, 1) - 1, optNum(d, 1), optNum(h, 0), optNum(mi, 0), optNum(s, 0), optNum(ms, 0)))],
    fromLocalTime: (y, mo, d, h, mi, s, ms) => [new DateTime(new Date(optNum(y, 1970), optNum(mo, 1) - 1, optNum(d, 1), optNum(h, 0), optNum(mi, 0), optNum(s, 0), optNum(ms, 0)).getTime())],
  }),
  Random: lib({ new: (seed) => [new RandomGen(seed === undefined ? undefined : num(seed, 1, 'new'))] }),
  RaycastParams: lib({ new: () => [new RaycastParams()] }),
  OverlapParams: lib({ new: () => [new OverlapParams()] }),
  PathWaypoint: lib({ new: (p, a, l) => [new PathWaypoint(p, a, l ? S(l) : '')] }),
};
constructors.vector = lib({
  create: (x, y, z) => [V3(x, y, z)],
  magnitude: (v) => [v.Magnitude], normalize: (v) => [v.Unit], cross: (a, b) => [a.cross(b)], dot: (a, b) => [a.dot(b)],
  angle: (a, b, ax) => [a.angle(b, ax)], floor: (v) => [v.map(Math.floor)], ceil: (v) => [v.map(Math.ceil)], abs: (v) => [v.map(Math.abs)],
  sign: (v) => [v.map(Math.sign)], clamp: (v, lo, hi) => [v.max(lo).min(hi)], max: (...v) => [v[0].max(...v.slice(1))], min: (...v) => [v[0].min(...v.slice(1))],
}, { zero: Vector3.zero, one: Vector3.one });

export function materialPhysics(mat) {
  const T = {
    Plastic: [0.7, 0.3, 0.5, 1, 1], SmoothPlastic: [0.7, 0.2, 0.5, 1, 1], Neon: [0.7, 0.3, 0.2, 1, 1], Wood: [0.35, 0.48, 0.2, 1, 1],
    WoodPlanks: [0.35, 0.48, 0.2, 1, 1], Marble: [2.56, 0.2, 0.17, 1, 1], Slate: [2.69, 0.4, 0.2, 1, 1], Concrete: [2.4, 0.7, 0.2, 0.3, 1],
    Granite: [2.69, 0.4, 0.2, 1, 1], Brick: [1.92, 0.8, 0.15, 0.3, 1], Pebble: [2.4, 0.4, 0.17, 1, 1], Cobblestone: [2.69, 0.5, 0.17, 1, 1],
    CorrodedMetal: [7.85, 0.7, 0.2, 1, 1], DiamondPlate: [7.85, 0.35, 0.25, 1, 1], Foil: [2.7, 0.4, 0.25, 1, 1], Metal: [7.85, 0.4, 0.25, 1, 1],
    Grass: [0.9, 0.4, 0.1, 1, 1.5], Sand: [1.6, 0.5, 0.05, 5, 2.5], Fabric: [0.7, 0.35, 0.05, 1, 1], Ice: [0.919, 0.02, 0.15, 3, 1],
    Glass: [2.4, 0.25, 0.2, 1, 1], ForceField: [2.4, 0.25, 0.2, 1, 1], Rubber: [1.3, 1.5, 0.95, 3, 2],
  };
  const v = T[mat.Name] || T.Plastic;
  return new PhysicalProperties(...v);
}

const FONT_FAMILIES = {
  Legacy: 'LegacyArial', Arial: 'LegacyArial', ArialBold: 'LegacyArial', SourceSans: 'SourceSansPro', SourceSansBold: 'SourceSansPro', SourceSansSemibold: 'SourceSansPro',
  SourceSansLight: 'SourceSansPro', SourceSansItalic: 'SourceSansPro', Bodoni: 'AccanthisADFStd', Garamond: 'Guru', Cartoon: 'ComicNeueAngular', Code: 'Inconsolata',
  Highway: 'HighwayGothic', SciFi: 'Zekton', Arcade: 'PressStart2P', Fantasy: 'Balthazar', Antique: 'RomanAntique', Gotham: 'GothamSSm', GothamMedium: 'GothamSSm',
  GothamBold: 'GothamSSm', GothamBlack: 'GothamSSm', AmaticSC: 'AmaticSC', Bangers: 'Bangers', Creepster: 'Creepster', DenkOne: 'DenkOne', Fondamento: 'Fondamento',
  FredokaOne: 'FredokaOne', GrenzeGotisch: 'GrenzeGotisch', IndieFlower: 'IndieFlower', JosefinSans: 'JosefinSans', Jura: 'Jura', Kalam: 'Kalam', LuckiestGuy: 'LuckiestGuy',
  Merriweather: 'Merriweather', Michroma: 'Michroma', Nunito: 'Nunito', Oswald: 'Oswald', PatrickHand: 'PatrickHand', PermanentMarker: 'PermanentMarker', Roboto: 'Roboto',
  RobotoCondensed: 'RobotoCondensed', RobotoMono: 'RobotoMono', Sarpanch: 'Sarpanch', SpecialElite: 'SpecialElite', TitilliumWeb: 'TitilliumWeb', Ubuntu: 'Ubuntu',
  BuilderSans: 'BuilderSans', BuilderSansMedium: 'BuilderSans', BuilderSansBold: 'BuilderSans', BuilderSansExtraBold: 'BuilderSans', Montserrat: 'Montserrat',
  MontserratMedium: 'Montserrat', MontserratBold: 'Montserrat', MontserratBlack: 'Montserrat',
};
export function fontFromEnum(e) {
  const name = e instanceof EnumItem ? e.Name : String(e);
  const fam = FONT_FAMILIES[name] || 'SourceSansPro';
  const weight = /Black/.test(name) ? 900 : /ExtraBold/.test(name) ? 800 : /Bold/.test(name) ? 700 : /Semibold/.test(name) ? 600 : /Medium/.test(name) ? 500 : /Light/.test(name) ? 300 : 400;
  return new Font(`rbxasset://fonts/families/${fam}.json`, weight, /Italic/.test(name) ? 'Italic' : 'Normal');
}

export { FONT_WEIGHTS, datatypeName, Signal, call, runSync, EMPTY, mkgen, R, LuaTable, LuaError, Instance };
