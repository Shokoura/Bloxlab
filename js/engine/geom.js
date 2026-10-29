// Geometric queries on parts (ray casts, overlap tests) without a physics engine.
import { Vector3, CFrame } from './datatypes.js';

/** Shape of a part for queries: 'box' | 'ball' | 'cylinder' | 'wedge' | 'cornerwedge' */
export function partShape(p) {
  const cn = p.ClassName;
  if (cn === 'WedgePart') return 'wedge';
  if (cn === 'CornerWedgePart') return 'cornerwedge';
  const s = p.props.Shape && p.props.Shape.Name;
  if (s === 'Ball') return 'ball';
  if (s === 'Cylinder') return 'cylinder';
  if (s === 'Wedge') return 'wedge';
  if (s === 'CornerWedge') return 'cornerwedge';
  return 'box';
}

/**
 * Ray vs part. Returns { t, normal (world Vector3) } or null. dir is not normalized; t in [0,1].
 */
export function rayPart(origin, dir, part) {
  const cf = part.props.CFrame, size = part.props.Size;
  if (!cf || !size) return null;
  const o = cf.pointToObject(origin), d = cf.vectorToObject(dir);
  const shape = partShape(part);
  const hx = size.X / 2, hy = size.Y / 2, hz = size.Z / 2;
  let best = null;
  if (shape === 'ball') {
    const r = Math.min(hx, hy, hz);
    const a = d.dot(d), b = 2 * o.dot(d), c = o.dot(o) - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a === 0) return null;
    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a);
    if (t < 0) t = (-b + sq) / (2 * a);
    if (t < 0 || t > 1) return null;
    const p = o.add(d.mul(t));
    return { t, normal: cf.vectorToWorld(p.Unit) };
  }
  if (shape === 'cylinder') {
    const r = Math.min(hy, hz);
    // infinite cylinder along X, then caps
    const a = d.Y * d.Y + d.Z * d.Z, b = 2 * (o.Y * d.Y + o.Z * d.Z), c = o.Y * o.Y + o.Z * o.Z - r * r;
    const cands = [];
    if (a > 1e-12) {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
          const x = o.X + d.X * t;
          if (t >= 0 && t <= 1 && Math.abs(x) <= hx) cands.push({ t, n: new Vector3(0, o.Y + d.Y * t, o.Z + d.Z * t).Unit });
        }
      }
    }
    if (Math.abs(d.X) > 1e-12) {
      for (const sx of [-hx, hx]) {
        const t = (sx - o.X) / d.X;
        const y = o.Y + d.Y * t, z = o.Z + d.Z * t;
        if (t >= 0 && t <= 1 && y * y + z * z <= r * r) cands.push({ t, n: new Vector3(Math.sign(sx), 0, 0) });
      }
    }
    for (const cnd of cands) if (!best || cnd.t < best.t) best = cnd;
    return best ? { t: best.t, normal: cf.vectorToWorld(best.n) } : null;
  }
  // slab test for the box
  let tmin = -Infinity, tmax = Infinity, nmin = null;
  const axes = [[o.X, d.X, hx, new Vector3(1, 0, 0)], [o.Y, d.Y, hy, new Vector3(0, 1, 0)], [o.Z, d.Z, hz, new Vector3(0, 0, 1)]];
  for (const [oo, dd, h, n] of axes) {
    if (Math.abs(dd) < 1e-12) { if (oo < -h || oo > h) return null; continue; }
    let t1 = (-h - oo) / dd, t2 = (h - oo) / dd;
    let n1 = n.neg();
    if (t1 > t2) { [t1, t2] = [t2, t1]; n1 = n; }
    if (t1 > tmin) { tmin = t1; nmin = n1; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0 || tmin > 1) return null;
  if (shape === 'wedge' || shape === 'cornerwedge') {
    // clip against the slope plane(s)
    const planes = shape === 'wedge'
      ? [[new Vector3(0, hz, -hy).Unit, 0]] // slope: from front-bottom edge to back-top edge
      : [[new Vector3(0, hz, hy).Unit.add(new Vector3(-hy, hx, 0).Unit).Unit, 0]];
    let t0 = Math.max(tmin, 0), t1 = tmax, n0 = tmin >= 0 ? nmin : null;
    for (const [pn] of planes) {
      // half-space: pn . p <= 0
      const denom = pn.dot(d), num = -pn.dot(o);
      if (Math.abs(denom) < 1e-12) { if (num < 0) return null; continue; }
      const t = num / denom;
      if (denom < 0) { if (t > t0) { t0 = t; n0 = pn; } } else if (t < t1) t1 = t;
      if (t0 > t1) return null;
    }
    if (t0 > 1 || t0 < 0) return null;
    return { t: t0, normal: cf.vectorToWorld(n0 || nmin || new Vector3(0, 1, 0)) };
  }
  const t = tmin >= 0 ? tmin : 0;
  return { t, normal: cf.vectorToWorld(nmin || new Vector3(0, 1, 0)) };
}

/** World AABB of a part: { min, max } */
export function partAABB(p) {
  const cf = p.props.CFrame, s = p.props.Size, r = cf.r;
  const ex = Math.abs(r[0]) * s.X / 2 + Math.abs(r[1]) * s.Y / 2 + Math.abs(r[2]) * s.Z / 2;
  const ey = Math.abs(r[3]) * s.X / 2 + Math.abs(r[4]) * s.Y / 2 + Math.abs(r[5]) * s.Z / 2;
  const ez = Math.abs(r[6]) * s.X / 2 + Math.abs(r[7]) * s.Y / 2 + Math.abs(r[8]) * s.Z / 2;
  return { min: new Vector3(cf.X - ex, cf.Y - ey, cf.Z - ez), max: new Vector3(cf.X + ex, cf.Y + ey, cf.Z + ez) };
}

/** OBB vs OBB (separating axis test). a/b: { cf: CFrame, half: Vector3 } */
export function obbOverlap(a, b) {
  const A = [a.cf.RightVector, a.cf.UpVector, a.cf.ZVector], B = [b.cf.RightVector, b.cf.UpVector, b.cf.ZVector];
  const ha = [a.half.X, a.half.Y, a.half.Z], hb = [b.half.X, b.half.Y, b.half.Z];
  const T = b.cf.Position.sub(a.cf.Position);
  const axes = [...A, ...B];
  for (const u of A) for (const v of B) { const c = u.cross(v); if (c.Magnitude > 1e-6) axes.push(c.Unit); }
  for (const L of axes) {
    const ra = ha[0] * Math.abs(A[0].dot(L)) + ha[1] * Math.abs(A[1].dot(L)) + ha[2] * Math.abs(A[2].dot(L));
    const rb = hb[0] * Math.abs(B[0].dot(L)) + hb[1] * Math.abs(B[1].dot(L)) + hb[2] * Math.abs(B[2].dot(L));
    if (Math.abs(T.dot(L)) > ra + rb) return false;
  }
  return true;
}
export const partOBB = (p) => ({ cf: p.props.CFrame, half: p.props.Size.mul(0.5) });

/** Sphere vs OBB */
export function sphereOverlapsPart(center, radius, p) {
  const local = p.props.CFrame.pointToObject(center);
  const h = p.props.Size.mul(0.5);
  if (partShape(p) === 'ball') return local.Magnitude <= radius + Math.min(h.X, h.Y, h.Z);
  const c = new Vector3(Math.max(-h.X, Math.min(h.X, local.X)), Math.max(-h.Y, Math.min(h.Y, local.Y)), Math.max(-h.Z, Math.min(h.Z, local.Z)));
  return local.sub(c).Magnitude <= radius;
}

export function* allParts(root) {
  const stack = [root];
  while (stack.length) {
    const i = stack.pop();
    if (i.isA && i.isA('BasePart') && i.ClassName !== 'Terrain') yield i;
    for (let k = i.children.length - 1; k >= 0; k--) stack.push(i.children[k]);
  }
}

/** Filter helper for RaycastParams / OverlapParams. */
export function makeFilter(params) {
  if (!params) return () => true;
  const list = params.FilterDescendantsInstances || [];
  const include = params.FilterType && params.FilterType.Name === 'Include' || (params.FilterType && params.FilterType.Name === 'Whitelist');
  const inList = (p) => list.some((f) => f === p || p.isDescendantOf(f));
  const group = params.CollisionGroup;
  return (p) => {
    if (params.RespectCanCollide && !p.props.CanCollide) return false;
    if (p.props.CanQuery === false) return false;
    if (group && group !== 'Default' && p.props.CollisionGroup && p.props.CollisionGroup !== group) { /* collision group filtering handled by physics service */ }
    return include ? inList(p) : !inList(p);
  };
}

export function raycastWorld(root, origin, dir, filter = () => true) {
  let best = null;
  for (const p of allParts(root)) {
    if (!filter(p)) continue;
    const h = rayPart(origin, dir, p);
    if (h && (!best || h.t < best.t)) best = { ...h, part: p };
  }
  if (!best) return null;
  return { part: best.part, position: origin.add(dir.mul(best.t)), normal: best.normal, distance: dir.Magnitude * best.t };
}

export { Vector3, CFrame };
