// Roblox value types (Vector3, CFrame, Color3, UDim2, ...). All instances are immutable,
// exactly like in Roblox, so they can be shared freely between instances and threads.
import BRICK from './brickcolors.js';

const EPS = 1e-5;
const fmt = (n) => {
  if (Number.isInteger(n)) return String(n);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';
  return String(+n.toPrecision(7));
};
const lerp = (a, b, t) => a + (b - a) * t;

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.X = +x || 0; this.Y = +y || 0; this.Z = +z || 0; }
  get Magnitude() { return Math.hypot(this.X, this.Y, this.Z); }
  get Unit() { const m = this.Magnitude; return m === 0 ? new Vector3(NaN, NaN, NaN) : new Vector3(this.X / m, this.Y / m, this.Z / m); }
  add(o) { return new Vector3(this.X + o.X, this.Y + o.Y, this.Z + o.Z); }
  sub(o) { return new Vector3(this.X - o.X, this.Y - o.Y, this.Z - o.Z); }
  mul(o) { return typeof o === 'number' ? new Vector3(this.X * o, this.Y * o, this.Z * o) : new Vector3(this.X * o.X, this.Y * o.Y, this.Z * o.Z); }
  div(o) { return typeof o === 'number' ? new Vector3(this.X / o, this.Y / o, this.Z / o) : new Vector3(this.X / o.X, this.Y / o.Y, this.Z / o.Z); }
  idiv(o) { const v = this.div(o); return new Vector3(Math.floor(v.X), Math.floor(v.Y), Math.floor(v.Z)); }
  neg() { return new Vector3(-this.X, -this.Y, -this.Z); }
  dot(o) { return this.X * o.X + this.Y * o.Y + this.Z * o.Z; }
  cross(o) { return new Vector3(this.Y * o.Z - this.Z * o.Y, this.Z * o.X - this.X * o.Z, this.X * o.Y - this.Y * o.X); }
  lerp(o, t) { return new Vector3(lerp(this.X, o.X, t), lerp(this.Y, o.Y, t), lerp(this.Z, o.Z, t)); }
  eq(o) { return o instanceof Vector3 && this.X === o.X && this.Y === o.Y && this.Z === o.Z; }
  fuzzyEq(o, eps = EPS) { return Math.abs(this.X - o.X) <= eps && Math.abs(this.Y - o.Y) <= eps && Math.abs(this.Z - o.Z) <= eps; }
  min(...o) { let r = this; for (const v of o) r = new Vector3(Math.min(r.X, v.X), Math.min(r.Y, v.Y), Math.min(r.Z, v.Z)); return r; }
  max(...o) { let r = this; for (const v of o) r = new Vector3(Math.max(r.X, v.X), Math.max(r.Y, v.Y), Math.max(r.Z, v.Z)); return r; }
  map(f) { return new Vector3(f(this.X), f(this.Y), f(this.Z)); }
  angle(o, axis) {
    const c = this.cross(o);
    const a = Math.atan2(c.Magnitude, this.dot(o));
    return axis && c.dot(axis) < 0 ? -a : a;
  }
  toArray() { return [this.X, this.Y, this.Z]; }
  toString() { return `${fmt(this.X)}, ${fmt(this.Y)}, ${fmt(this.Z)}`; }
  static fromArray(a) { return new Vector3(a[0], a[1], a[2]); }
}
Vector3.zero = new Vector3(0, 0, 0);
Vector3.one = new Vector3(1, 1, 1);
Vector3.xAxis = new Vector3(1, 0, 0);
Vector3.yAxis = new Vector3(0, 1, 0);
Vector3.zAxis = new Vector3(0, 0, 1);
// NormalId: Right=0, Top=1, Back=2, Left=3, Bottom=4, Front=5
export const NORMALS = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, -1)];

export class Vector2 {
  constructor(x = 0, y = 0) { this.X = +x || 0; this.Y = +y || 0; }
  get Magnitude() { return Math.hypot(this.X, this.Y); }
  get Unit() { const m = this.Magnitude; return m === 0 ? new Vector2(NaN, NaN) : new Vector2(this.X / m, this.Y / m); }
  add(o) { return new Vector2(this.X + o.X, this.Y + o.Y); }
  sub(o) { return new Vector2(this.X - o.X, this.Y - o.Y); }
  mul(o) { return typeof o === 'number' ? new Vector2(this.X * o, this.Y * o) : new Vector2(this.X * o.X, this.Y * o.Y); }
  div(o) { return typeof o === 'number' ? new Vector2(this.X / o, this.Y / o) : new Vector2(this.X / o.X, this.Y / o.Y); }
  idiv(o) { const v = this.div(o); return new Vector2(Math.floor(v.X), Math.floor(v.Y)); }
  neg() { return new Vector2(-this.X, -this.Y); }
  dot(o) { return this.X * o.X + this.Y * o.Y; }
  cross(o) { return this.X * o.Y - this.Y * o.X; }
  lerp(o, t) { return new Vector2(lerp(this.X, o.X, t), lerp(this.Y, o.Y, t)); }
  eq(o) { return o instanceof Vector2 && this.X === o.X && this.Y === o.Y; }
  fuzzyEq(o, eps = EPS) { return Math.abs(this.X - o.X) <= eps && Math.abs(this.Y - o.Y) <= eps; }
  min(...o) { let r = this; for (const v of o) r = new Vector2(Math.min(r.X, v.X), Math.min(r.Y, v.Y)); return r; }
  max(...o) { let r = this; for (const v of o) r = new Vector2(Math.max(r.X, v.X), Math.max(r.Y, v.Y)); return r; }
  map(f) { return new Vector2(f(this.X), f(this.Y)); }
  angle(o, sign) { const a = Math.atan2(this.cross(o), this.dot(o)); return sign ? a : Math.abs(a); }
  toArray() { return [this.X, this.Y]; }
  toString() { return `${fmt(this.X)}, ${fmt(this.Y)}`; }
}
Vector2.zero = new Vector2(0, 0);
Vector2.one = new Vector2(1, 1);
Vector2.xAxis = new Vector2(1, 0);
Vector2.yAxis = new Vector2(0, 1);

export class Vector3int16 {
  constructor(x = 0, y = 0, z = 0) { this.X = (x | 0) << 16 >> 16; this.Y = (y | 0) << 16 >> 16; this.Z = (z | 0) << 16 >> 16; }
  eq(o) { return o instanceof Vector3int16 && this.X === o.X && this.Y === o.Y && this.Z === o.Z; }
  add(o) { return new Vector3int16(this.X + o.X, this.Y + o.Y, this.Z + o.Z); }
  sub(o) { return new Vector3int16(this.X - o.X, this.Y - o.Y, this.Z - o.Z); }
  mul(o) { return typeof o === 'number' ? new Vector3int16(this.X * o, this.Y * o, this.Z * o) : new Vector3int16(this.X * o.X, this.Y * o.Y, this.Z * o.Z); }
  div(o) { return typeof o === 'number' ? new Vector3int16(this.X / o, this.Y / o, this.Z / o) : new Vector3int16(this.X / o.X, this.Y / o.Y, this.Z / o.Z); }
  toArray() { return [this.X, this.Y, this.Z]; }
  toString() { return `${this.X}, ${this.Y}, ${this.Z}`; }
}
export class Vector2int16 {
  constructor(x = 0, y = 0) { this.X = (x | 0) << 16 >> 16; this.Y = (y | 0) << 16 >> 16; }
  eq(o) { return o instanceof Vector2int16 && this.X === o.X && this.Y === o.Y; }
  add(o) { return new Vector2int16(this.X + o.X, this.Y + o.Y); }
  sub(o) { return new Vector2int16(this.X - o.X, this.Y - o.Y); }
  toString() { return `${this.X}, ${this.Y}`; }
}

// ---------------------------------------------------------------- CFrame
// Rotation matrix stored row-major: R00 R01 R02 / R10 R11 R12 / R20 R21 R22.
// Columns are RightVector (X), UpVector (Y) and -LookVector (Z).
export class CFrame {
  constructor(x = 0, y = 0, z = 0, r00 = 1, r01 = 0, r02 = 0, r10 = 0, r11 = 1, r12 = 0, r20 = 0, r21 = 0, r22 = 1) {
    this.X = x; this.Y = y; this.Z = z;
    this.r = [r00, r01, r02, r10, r11, r12, r20, r21, r22];
  }
  static fromPosRot(x, y, z, r) { const c = new CFrame(x, y, z); c.r = r; return c; }
  get Position() { return new Vector3(this.X, this.Y, this.Z); }
  get p() { return this.Position; }
  get Rotation() { return CFrame.fromPosRot(0, 0, 0, this.r); }
  get RightVector() { const r = this.r; return new Vector3(r[0], r[3], r[6]); }
  get UpVector() { const r = this.r; return new Vector3(r[1], r[4], r[7]); }
  get LookVector() { const r = this.r; return new Vector3(-r[2], -r[5], -r[8]); }
  get XVector() { return this.RightVector; }
  get YVector() { return this.UpVector; }
  get ZVector() { const r = this.r; return new Vector3(r[2], r[5], r[8]); }
  components() { return [this.X, this.Y, this.Z, ...this.r]; }

  mul(o) {
    const a = this.r;
    if (o instanceof Vector3) return this.pointToWorld(o);
    const b = o.r;
    const r = [
      a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
      a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
      a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    ];
    return CFrame.fromPosRot(
      a[0] * o.X + a[1] * o.Y + a[2] * o.Z + this.X,
      a[3] * o.X + a[4] * o.Y + a[5] * o.Z + this.Y,
      a[6] * o.X + a[7] * o.Y + a[8] * o.Z + this.Z, r);
  }
  add(v) { return CFrame.fromPosRot(this.X + v.X, this.Y + v.Y, this.Z + v.Z, this.r); }
  sub(v) { return CFrame.fromPosRot(this.X - v.X, this.Y - v.Y, this.Z - v.Z, this.r); }
  inverse() {
    const a = this.r;
    const r = [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
    const x = this.X, y = this.Y, z = this.Z;
    return CFrame.fromPosRot(-(r[0] * x + r[1] * y + r[2] * z), -(r[3] * x + r[4] * y + r[5] * z), -(r[6] * x + r[7] * y + r[8] * z), r);
  }
  pointToWorld(v) { const a = this.r; return new Vector3(a[0] * v.X + a[1] * v.Y + a[2] * v.Z + this.X, a[3] * v.X + a[4] * v.Y + a[5] * v.Z + this.Y, a[6] * v.X + a[7] * v.Y + a[8] * v.Z + this.Z); }
  vectorToWorld(v) { const a = this.r; return new Vector3(a[0] * v.X + a[1] * v.Y + a[2] * v.Z, a[3] * v.X + a[4] * v.Y + a[5] * v.Z, a[6] * v.X + a[7] * v.Y + a[8] * v.Z); }
  pointToObject(v) { const a = this.r; const x = v.X - this.X, y = v.Y - this.Y, z = v.Z - this.Z; return new Vector3(a[0] * x + a[3] * y + a[6] * z, a[1] * x + a[4] * y + a[7] * z, a[2] * x + a[5] * y + a[8] * z); }
  vectorToObject(v) { const a = this.r; return new Vector3(a[0] * v.X + a[3] * v.Y + a[6] * v.Z, a[1] * v.X + a[4] * v.Y + a[7] * v.Z, a[2] * v.X + a[5] * v.Y + a[8] * v.Z); }
  toWorldSpace(c) { return this.mul(c); }
  toObjectSpace(c) { return this.inverse().mul(c); }
  eq(o) { if (!(o instanceof CFrame) || o.X !== this.X || o.Y !== this.Y || o.Z !== this.Z) return false; for (let i = 0; i < 9; i++) if (o.r[i] !== this.r[i]) return false; return true; }
  fuzzyEq(o, eps = EPS) { if (Math.abs(o.X - this.X) > eps || Math.abs(o.Y - this.Y) > eps || Math.abs(o.Z - this.Z) > eps) return false; for (let i = 0; i < 9; i++) if (Math.abs(o.r[i] - this.r[i]) > eps) return false; return true; }

  toEulerXYZ() {
    const r = this.r;
    const b = Math.asin(Math.max(-1, Math.min(1, r[2])));
    if (Math.abs(r[2]) < 0.9999999) return [Math.atan2(-r[5], r[8]), b, Math.atan2(-r[1], r[0])];
    return [Math.atan2(r[7], r[4]), b, 0];
  }
  toEulerYXZ() {
    const r = this.r;
    const x = Math.asin(Math.max(-1, Math.min(1, -r[5])));
    if (Math.abs(r[5]) < 0.9999999) return [x, Math.atan2(r[2], r[8]), Math.atan2(r[3], r[4])];
    return [x, Math.atan2(-r[6], r[0]), 0];
  }
  toQuaternion() { // [x, y, z, w]
    const m = this.r;
    const t = m[0] + m[4] + m[8];
    let x, y, z, w;
    if (t > 0) { const s = 0.5 / Math.sqrt(t + 1); w = 0.25 / s; x = (m[7] - m[5]) * s; y = (m[2] - m[6]) * s; z = (m[3] - m[1]) * s; }
    else if (m[0] > m[4] && m[0] > m[8]) { const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]); w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s; }
    else if (m[4] > m[8]) { const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]); w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s; }
    else { const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]); w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s; }
    const n = Math.hypot(x, y, z, w) || 1;
    return [x / n, y / n, z / n, w / n];
  }
  toAxisAngle() {
    const [x, y, z, w] = this.toQuaternion();
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, w)));
    const s = Math.sqrt(1 - w * w);
    return s < 1e-6 ? [new Vector3(1, 0, 0), 0] : [new Vector3(x / s, y / s, z / s), angle];
  }
  lerp(o, t) {
    const q = slerp(this.toQuaternion(), o.toQuaternion(), t);
    return CFrame.fromQuaternion(lerp(this.X, o.X, t), lerp(this.Y, o.Y, t), lerp(this.Z, o.Z, t), q[0], q[1], q[2], q[3]);
  }
  orthonormalize() {
    const r = this.r;
    let x = new Vector3(r[0], r[3], r[6]).Unit;
    let y = new Vector3(r[1], r[4], r[7]);
    const z = x.cross(y).Unit;
    y = z.cross(x).Unit;
    if (!Number.isFinite(x.X)) x = Vector3.xAxis;
    return CFrame.fromMatrix(this.Position, x, y, z);
  }
  toString() { return this.components().map(fmt).join(', '); }

  static fromQuaternion(px, py, pz, qx, qy, qz, qw) {
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= n; qy /= n; qz /= n; qw /= n;
    return CFrame.fromPosRot(px, py, pz, [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)]);
  }
  static angles(rx, ry, rz) { // XYZ: Rx * Ry * Rz
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    return CFrame.fromPosRot(0, 0, 0, [
      cy * cz, -cy * sz, sy,
      cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
      sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy]);
  }
  static fromEulerYXZ(rx, ry, rz) { // Ry * Rx * Rz
    return CFrame.angles(0, ry, 0).mul(CFrame.angles(rx, 0, 0)).mul(CFrame.angles(0, 0, rz));
  }
  static fromAxisAngle(axis, angle) {
    const u = axis.Unit; const s = Math.sin(angle / 2);
    return CFrame.fromQuaternion(0, 0, 0, u.X * s, u.Y * s, u.Z * s, Math.cos(angle / 2));
  }
  static lookAt(at, target, up = Vector3.yAxis) {
    let look = target.sub(at).Unit;
    if (!Number.isFinite(look.X)) look = new Vector3(0, 0, -1);
    let right = look.cross(up);
    if (right.Magnitude < 1e-6) right = look.cross(Math.abs(look.Z) < 0.9 ? Vector3.zAxis : Vector3.xAxis);
    right = right.Unit;
    const up2 = right.cross(look).Unit;
    return CFrame.fromMatrix(at, right, up2, look.neg());
  }
  static fromMatrix(pos, vx, vy, vz) {
    if (!vz) vz = vx.cross(vy).Unit;
    return CFrame.fromPosRot(pos.X, pos.Y, pos.Z, [vx.X, vy.X, vz.X, vx.Y, vy.Y, vz.Y, vx.Z, vy.Z, vz.Z]);
  }
  // rotation IDs used by the binary format (see docs: "CFrame special cases")
  static fromRotationId(id) {
    const n = id - 1;
    const xi = Math.floor(n / 6), yi = n % 6;
    const vx = NORMALS[xi], vy = NORMALS[yi];
    if (!vx || !vy || xi % 3 === yi % 3) return null;
    return CFrame.fromMatrix(Vector3.zero, vx, vy, vx.cross(vy));
  }
  rotationId() {
    const r = this.r;
    const col = (c) => [r[c], r[3 + c], r[6 + c]];
    const idOf = (v) => {
      for (let i = 0; i < 6; i++) { const n = NORMALS[i]; if (n.X === v[0] && n.Y === v[1] && n.Z === v[2]) return i; }
      return -1;
    };
    const xi = idOf(col(0)), yi = idOf(col(1));
    if (xi < 0 || yi < 0) return 0;
    const id = xi * 6 + yi + 1;
    const ref = CFrame.fromRotationId(id);
    if (!ref) return 0;
    for (let i = 0; i < 9; i++) if (ref.r[i] !== r[i] && !(ref.r[i] === 0 && r[i] === 0)) return 0;
    return id;
  }
}
CFrame.identity = new CFrame();

function slerp(a, b, t) {
  let [ax, ay, az, aw] = a; let [bx, by, bz, bw] = b;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) return [lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t), lerp(aw, bw, t)];
  const th = Math.acos(cos), s = Math.sin(th);
  const k0 = Math.sin((1 - t) * th) / s, k1 = Math.sin(t * th) / s;
  return [ax * k0 + bx * k1, ay * k0 + by * k1, az * k0 + bz * k1, aw * k0 + bw * k1];
}

// ---------------------------------------------------------------- colors
export class Color3 {
  constructor(r = 0, g = 0, b = 0) { this.R = +r || 0; this.G = +g || 0; this.B = +b || 0; }
  static fromRGB(r = 0, g = 0, b = 0) { return new Color3(r / 255, g / 255, b / 255); }
  static fromHSV(h, s, v) {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return new Color3(r, g, b);
  }
  static fromHex(hex) {
    let h = String(hex).replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error('Unable to convert characters to hex value');
    return Color3.fromRGB(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
  }
  toHSV() {
    const { R: r, G: g, B: b } = this;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h /= 6; if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  toHex() { return [this.R, this.G, this.B].map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join(''); }
  toCss() { return `rgb(${Math.round(this.R * 255)},${Math.round(this.G * 255)},${Math.round(this.B * 255)})`; }
  lerp(o, t) { return new Color3(lerp(this.R, o.R, t), lerp(this.G, o.G, t), lerp(this.B, o.B, t)); }
  eq(o) { return o instanceof Color3 && this.R === o.R && this.G === o.G && this.B === o.B; }
  toArray() { return [this.R, this.G, this.B]; }
  toString() { return `${fmt(this.R)}, ${fmt(this.G)}, ${fmt(this.B)}`; }
}

const BC_BY_NUM = new Map(BRICK.map((b) => [b[0], b]));
const BC_BY_NAME = new Map();
for (const b of BRICK) if (!BC_BY_NAME.has(b[1])) BC_BY_NAME.set(b[1], b);
// The 128-colour picker palette (BrickColor.palette(i))
const PALETTE = [141, 301, 107, 26, 1012, 303, 1011, 304, 28, 1018, 302, 305, 306, 307, 308, 1021, 309, 310, 1019, 135, 102, 23, 1010, 312, 313, 37, 1022, 1020, 1027, 311, 315, 1023, 1031, 316, 151, 317, 318, 319, 1024, 314, 1013, 1006, 321, 322, 104, 1008, 119, 323, 324, 325, 320, 11, 1026, 1016, 1032, 1015, 327, 1005, 1009, 29, 328, 1028, 208, 45, 329, 330, 331, 1004, 21, 332, 333, 24, 334, 226, 1029, 335, 336, 342, 343, 338, 1007, 339, 133, 106, 340, 341, 1001, 1, 9, 1025, 337, 344, 345, 1014, 105, 346, 347, 348, 349, 1030, 125, 101, 350, 192, 351, 352, 353, 354, 1002, 5, 18, 217, 355, 356, 153, 357, 358, 359, 360, 38, 361, 362, 199, 194, 363, 364, 365, 1003, 26];

export class BrickColor {
  constructor(entry) { this.Number = entry[0]; this.Name = entry[1]; this.Color = Color3.fromRGB(entry[2], entry[3], entry[4]); }
  get r() { return this.Color.R; }
  get g() { return this.Color.G; }
  get b() { return this.Color.B; }
  eq(o) { return o instanceof BrickColor && o.Number === this.Number; }
  toString() { return this.Name; }
  static fromNumber(n) { return new BrickColor(BC_BY_NUM.get(n) || BC_BY_NUM.get(194)); }
  static fromName(s) { return new BrickColor(BC_BY_NAME.get(s) || BC_BY_NUM.get(194)); }
  static fromColor3(c) {
    let best = null, bd = Infinity;
    for (const b of BRICK) {
      const d = (b[2] / 255 - c.R) ** 2 + (b[3] / 255 - c.G) ** 2 + (b[4] / 255 - c.B) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return new BrickColor(best);
  }
  static palette(i) { return BrickColor.fromNumber(PALETTE[i] ?? 194); }
  static random() { return new BrickColor(BRICK[Math.floor(Math.random() * BRICK.length)]); }
  static all() { return BRICK; }
}

// ---------------------------------------------------------------- GUI dims
export class UDim {
  constructor(scale = 0, offset = 0) { this.Scale = +scale || 0; this.Offset = Math.trunc(+offset || 0); }
  add(o) { return new UDim(this.Scale + o.Scale, this.Offset + o.Offset); }
  sub(o) { return new UDim(this.Scale - o.Scale, this.Offset - o.Offset); }
  neg() { return new UDim(-this.Scale, -this.Offset); }
  eq(o) { return o instanceof UDim && o.Scale === this.Scale && o.Offset === this.Offset; }
  lerp(o, t) { return new UDim(lerp(this.Scale, o.Scale, t), Math.round(lerp(this.Offset, o.Offset, t))); }
  toString() { return `${fmt(this.Scale)}, ${this.Offset}`; }
}
export class UDim2 {
  constructor(xs = 0, xo = 0, ys = 0, yo = 0) {
    if (xs instanceof UDim) { this.X = xs; this.Y = xo instanceof UDim ? xo : new UDim(); }
    else { this.X = new UDim(xs, xo); this.Y = new UDim(ys, yo); }
  }
  get Width() { return this.X; }
  get Height() { return this.Y; }
  add(o) { return new UDim2(this.X.add(o.X), this.Y.add(o.Y)); }
  sub(o) { return new UDim2(this.X.sub(o.X), this.Y.sub(o.Y)); }
  neg() { return new UDim2(this.X.neg(), this.Y.neg()); }
  lerp(o, t) { return new UDim2(lerp(this.X.Scale, o.X.Scale, t), lerp(this.X.Offset, o.X.Offset, t), lerp(this.Y.Scale, o.Y.Scale, t), lerp(this.Y.Offset, o.Y.Offset, t)); }
  eq(o) { return o instanceof UDim2 && this.X.eq(o.X) && this.Y.eq(o.Y); }
  toArray() { return [this.X.Scale, this.X.Offset, this.Y.Scale, this.Y.Offset]; }
  toString() { return `{${this.X}}, {${this.Y}}`; }
  static fromScale(x = 0, y = 0) { return new UDim2(x, 0, y, 0); }
  static fromOffset(x = 0, y = 0) { return new UDim2(0, x, 0, y); }
}

export class Rect {
  constructor(x0 = 0, y0 = 0, x1 = 0, y1 = 0) {
    if (x0 instanceof Vector2) { this.Min = x0; this.Max = y0 instanceof Vector2 ? y0 : new Vector2(); }
    else { this.Min = new Vector2(x0, y0); this.Max = new Vector2(x1, y1); }
  }
  get Width() { return this.Max.X - this.Min.X; }
  get Height() { return this.Max.Y - this.Min.Y; }
  eq(o) { return o instanceof Rect && this.Min.eq(o.Min) && this.Max.eq(o.Max); }
  toArray() { return [this.Min.X, this.Min.Y, this.Max.X, this.Max.Y]; }
  toString() { return `${this.Min}, ${this.Max}`; }
}

export class Ray {
  constructor(origin = Vector3.zero, direction = Vector3.zero) { this.Origin = origin; this.Direction = direction; }
  get Unit() { return new Ray(this.Origin, this.Direction.Unit); }
  closestPoint(p) {
    const d = this.Direction.Unit;
    const t = Math.max(0, p.sub(this.Origin).dot(d));
    return this.Origin.add(d.mul(t));
  }
  distance(p) { return p.sub(this.closestPoint(p)).Magnitude; }
  eq(o) { return o instanceof Ray && this.Origin.eq(o.Origin) && this.Direction.eq(o.Direction); }
  toString() { return `{${this.Origin}}, {${this.Direction}}`; }
}

export class Region3 {
  constructor(min = Vector3.zero, max = Vector3.zero) { this.min = min; this.max = max; }
  get CFrame() { const c = this.min.add(this.max).mul(0.5); return new CFrame(c.X, c.Y, c.Z); }
  get Size() { return this.max.sub(this.min); }
  expandToGrid(res) {
    const f = (v, fn) => v.map((c) => fn(c / res) * res);
    return new Region3(f(this.min, Math.floor), f(this.max, Math.ceil));
  }
  toString() { return `${this.CFrame}; ${this.Size}`; }
}
export class Region3int16 {
  constructor(min = new Vector3int16(), max = new Vector3int16()) { this.Min = min; this.Max = max; }
  toString() { return `${this.Min}; ${this.Max}`; }
}

export class NumberRange {
  constructor(min = 0, max = min) {
    if (max < min) throw new Error('NumberRange: invalid range');
    this.Min = +min; this.Max = +max;
  }
  eq(o) { return o instanceof NumberRange && o.Min === this.Min && o.Max === this.Max; }
  toString() { return `${fmt(this.Min)} ${fmt(this.Max)} `; }
}

export class NumberSequenceKeypoint {
  constructor(time = 0, value = 0, envelope = 0) { this.Time = +time; this.Value = +value; this.Envelope = +envelope; }
  eq(o) { return o instanceof NumberSequenceKeypoint && o.Time === this.Time && o.Value === this.Value && o.Envelope === this.Envelope; }
  toString() { return `${fmt(this.Time)} ${fmt(this.Value)} ${fmt(this.Envelope)}`; }
}
export class NumberSequence {
  constructor(a, b) {
    if (Array.isArray(a)) this.Keypoints = a;
    else if (typeof a === 'number') this.Keypoints = [new NumberSequenceKeypoint(0, a), new NumberSequenceKeypoint(1, b ?? a)];
    else this.Keypoints = [new NumberSequenceKeypoint(0, 0), new NumberSequenceKeypoint(1, 0)];
  }
  at(t) {
    const k = this.Keypoints;
    if (!k.length) return 0;
    if (t <= k[0].Time) return k[0].Value;
    for (let i = 1; i < k.length; i++) if (t <= k[i].Time) { const a = k[i - 1], b = k[i]; return lerp(a.Value, b.Value, (t - a.Time) / ((b.Time - a.Time) || 1)); }
    return k[k.length - 1].Value;
  }
  eq(o) { return o instanceof NumberSequence && o.Keypoints.length === this.Keypoints.length && o.Keypoints.every((k, i) => k.eq(this.Keypoints[i])); }
  toString() { return this.Keypoints.join(' ') + ' '; }
}
export class ColorSequenceKeypoint {
  constructor(time = 0, value = new Color3()) { this.Time = +time; this.Value = value; }
  eq(o) { return o instanceof ColorSequenceKeypoint && o.Time === this.Time && o.Value.eq(this.Value); }
  toString() { return `${fmt(this.Time)} ${fmt(this.Value.R)} ${fmt(this.Value.G)} ${fmt(this.Value.B)} 0`; }
}
export class ColorSequence {
  constructor(a, b) {
    if (Array.isArray(a)) this.Keypoints = a;
    else if (a instanceof Color3) this.Keypoints = [new ColorSequenceKeypoint(0, a), new ColorSequenceKeypoint(1, b || a)];
    else this.Keypoints = [new ColorSequenceKeypoint(0, new Color3(1, 1, 1)), new ColorSequenceKeypoint(1, new Color3(1, 1, 1))];
  }
  at(t) {
    const k = this.Keypoints;
    if (t <= k[0].Time) return k[0].Value;
    for (let i = 1; i < k.length; i++) if (t <= k[i].Time) { const a = k[i - 1], b = k[i]; return a.Value.lerp(b.Value, (t - a.Time) / ((b.Time - a.Time) || 1)); }
    return k[k.length - 1].Value;
  }
  eq(o) { return o instanceof ColorSequence && o.Keypoints.length === this.Keypoints.length && o.Keypoints.every((k, i) => k.eq(this.Keypoints[i])); }
  toString() { return this.Keypoints.join(' ') + ' '; }
}

export class PhysicalProperties {
  constructor(density = 0.7, friction = 0.3, elasticity = 0.5, frictionWeight = 1, elasticityWeight = 1, acousticAbsorption = 1) {
    this.Density = density; this.Friction = friction; this.Elasticity = elasticity;
    this.FrictionWeight = frictionWeight; this.ElasticityWeight = elasticityWeight; this.AcousticAbsorption = acousticAbsorption;
  }
  eq(o) { return o instanceof PhysicalProperties && ['Density', 'Friction', 'Elasticity', 'FrictionWeight', 'ElasticityWeight'].every((k) => o[k] === this[k]); }
  toArray() { return [this.Density, this.Friction, this.Elasticity, this.FrictionWeight, this.ElasticityWeight]; }
  toString() { return this.toArray().map(fmt).join(', '); }
}

const FACE_NAMES = ['Right', 'Top', 'Back', 'Left', 'Bottom', 'Front'];
export class Faces {
  constructor(bits = 0) { this.bits = bits & 63; }
  has(i) { return !!(this.bits & (1 << i)); }
  get Right() { return this.has(0); } get Top() { return this.has(1); } get Back() { return this.has(2); }
  get Left() { return this.has(3); } get Bottom() { return this.has(4); } get Front() { return this.has(5); }
  eq(o) { return o instanceof Faces && o.bits === this.bits; }
  toString() { return FACE_NAMES.filter((_, i) => this.has(i)).join(', '); }
  static fromNames(names) { let b = 0; for (const n of names) { const i = FACE_NAMES.indexOf(n); if (i >= 0) b |= 1 << i; } return new Faces(b); }
}
const AXES_NAMES = ['X', 'Y', 'Z'];
export class Axes {
  constructor(bits = 0) { this.bits = bits & 7; }
  get X() { return !!(this.bits & 1); } get Y() { return !!(this.bits & 2); } get Z() { return !!(this.bits & 4); }
  get Right() { return this.X; } get Left() { return this.X; } get Top() { return this.Y; } get Bottom() { return this.Y; } get Front() { return this.Z; } get Back() { return this.Z; }
  eq(o) { return o instanceof Axes && o.bits === this.bits; }
  toString() { return AXES_NAMES.filter((_, i) => this.bits & (1 << i)).join(', '); }
}

export const FONT_WEIGHTS = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Heavy: 900 };
export class Font {
  constructor(family = 'rbxasset://fonts/families/SourceSansPro.json', weight = 400, style = 'Normal') {
    this.Family = family; this.Weight = weight; this.Style = style; this.CachedFaceId = '';
  }
  get Bold() { return this.Weight >= 600; }
  get familyName() { const m = /families\/([^/.]+)\.json/i.exec(this.Family); return m ? m[1] : 'SourceSansPro'; }
  eq(o) { return o instanceof Font && o.Family === this.Family && o.Weight === this.Weight && o.Style === this.Style; }
  toString() { return `Font { Family = ${this.Family}, Weight = ${this.Weight}, Style = ${this.Style} }`; }
}

export class TweenInfo {
  constructor(time = 1, style = null, direction = null, repeatCount = 0, reverses = false, delayTime = 0) {
    this.Time = time; this.EasingStyle = style; this.EasingDirection = direction;
    this.RepeatCount = repeatCount; this.Reverses = reverses; this.DelayTime = delayTime;
  }
  toString() { return `Time:${this.Time} DelayTime:${this.DelayTime} RepeatCount:${this.RepeatCount} Reverses:${this.Reverses}`; }
}

export class DateTime {
  constructor(ms) { this.UnixTimestampMillis = Math.floor(ms); }
  get UnixTimestamp() { return Math.floor(this.UnixTimestampMillis / 1000); }
  toString() { return new Date(this.UnixTimestampMillis).toISOString(); }
}

// xorshift-ish PRNG compatible in spirit with Roblox's Random (PCG32 there)
export class RandomGen {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(Math.floor(seed ?? (Math.random() * 2 ** 52))) * 6364136223846793005n + 1442695040888963407n);
    this.inc = 1442695040888963407n;
  }
  nextU32() {
    const old = this.state;
    this.state = BigInt.asUintN(64, old * 6364136223846793005n + this.inc);
    const xs = Number(BigInt.asUintN(32, ((old >> 18n) ^ old) >> 27n));
    const rot = Number(old >> 59n);
    return ((xs >>> rot) | (xs << ((-rot) & 31))) >>> 0;
  }
  nextNumber(min = 0, max = 1) { const r = (this.nextU32() * 2 ** 21 + (this.nextU32() >>> 11)) / 2 ** 53; return min + (max - min) * r; }
  nextInteger(min, max) { if (max < min) throw new Error('invalid argument #2 to \'NextInteger\' (interval is empty)'); return min + Math.floor(this.nextNumber() * (max - min + 1)); }
  clone() { const r = new RandomGen(0); r.state = this.state; return r; }
}

export class RaycastParams {
  constructor() { this.FilterDescendantsInstances = []; this.FilterType = null; this.IgnoreWater = false; this.CollisionGroup = 'Default'; this.RespectCanCollide = false; this.BruteForceAllSlow = false; }
}
export class OverlapParams {
  constructor() { this.FilterDescendantsInstances = []; this.FilterType = null; this.MaxParts = 0; this.CollisionGroup = 'Default'; this.RespectCanCollide = false; this.BruteForceAllSlow = false; }
}
export class RaycastResult {
  constructor(inst, pos, normal, material, distance) { this.Instance = inst; this.Position = pos; this.Normal = normal; this.Material = material; this.Distance = distance; }
  toString() { return 'RaycastResult{' + (this.Instance ? this.Instance.Name : 'nil') + ' @ ' + this.Position + '}'; }
}
export class PathWaypoint {
  constructor(pos, action, label = '') { this.Position = pos; this.Action = action; this.Label = label; }
}

// Name of the Roblox datatype of a JS value (used by typeof()).
export function datatypeName(v) {
  if (v instanceof Vector3) return 'Vector3';
  if (v instanceof CFrame) return 'CFrame';
  if (v instanceof Color3) return 'Color3';
  if (v instanceof Vector2) return 'Vector2';
  if (v instanceof UDim2) return 'UDim2';
  if (v instanceof UDim) return 'UDim';
  if (v instanceof BrickColor) return 'BrickColor';
  if (v instanceof Ray) return 'Ray';
  if (v instanceof NumberRange) return 'NumberRange';
  if (v instanceof NumberSequence) return 'NumberSequence';
  if (v instanceof NumberSequenceKeypoint) return 'NumberSequenceKeypoint';
  if (v instanceof ColorSequence) return 'ColorSequence';
  if (v instanceof ColorSequenceKeypoint) return 'ColorSequenceKeypoint';
  if (v instanceof Rect) return 'Rect';
  if (v instanceof Region3) return 'Region3';
  if (v instanceof Region3int16) return 'Region3int16';
  if (v instanceof Vector3int16) return 'Vector3int16';
  if (v instanceof Vector2int16) return 'Vector2int16';
  if (v instanceof PhysicalProperties) return 'PhysicalProperties';
  if (v instanceof Faces) return 'Faces';
  if (v instanceof Axes) return 'Axes';
  if (v instanceof Font) return 'Font';
  if (v instanceof TweenInfo) return 'TweenInfo';
  if (v instanceof DateTime) return 'DateTime';
  if (v instanceof RandomGen) return 'Random';
  if (v instanceof RaycastParams) return 'RaycastParams';
  if (v instanceof OverlapParams) return 'OverlapParams';
  if (v instanceof RaycastResult) return 'RaycastResult';
  if (v instanceof PathWaypoint) return 'PathWaypoint';
  return null;
}

// Generic linear interpolation used by TweenService.
export function lerpValue(a, b, t) {
  if (typeof a === 'number') return lerp(a, b, t);
  if (a && typeof a.lerp === 'function') return a.lerp(b, t);
  if (a instanceof NumberRange) return new NumberRange(lerp(a.Min, b.Min, t), lerp(a.Max, b.Max, t));
  if (a instanceof Rect) return new Rect(a.Min.lerp(b.Min, t), a.Max.lerp(b.Max, t));
  return t < 1 ? a : b;
}
