// Workspace (WorldRoot), Camera, Lighting, Terrain.
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, arr, fromLuaArray, luaTypeof, S } from '../bridge.js';
import { Vector3, Vector2, CFrame, Ray, RaycastResult, Region3, OverlapParams, Color3 } from '../datatypes.js';
import { E, getEnum } from '../enums.js';
import { raycastWorld, makeFilter, allParts, obbOverlap, partOBB, sphereOverlapsPart, partAABB } from '../geom.js';
import { LuaTable } from '../../luau/runtime.js';

const vec = (v, n, f) => { if (!(v instanceof Vector3)) throw lerr(`invalid argument #${n} to '${f}' (Vector3 expected, got ${luaTypeof(v)})`); return v; };

function wsRaycast(ws, origin, dir, filter) {
  const w = ws.world;
  if (w && w.hooks.raycast) return w.hooks.raycast(origin, dir, filter);
  return raycastWorld(ws, origin, dir, filter);
}
const matOf = (p) => (p ? p.props.Material || E('Material', 'Plastic') : E('Material', 'Air'));

function ignoreFilter(list) {
  const items = list ? (Array.isArray(list) ? list : fromLuaArray(list)) : [];
  return (p) => p.props.CanQuery !== false && !items.some((i) => i === p || p.isDescendantOf(i));
}
function legacyRay(self, ray, filter) {
  if (!(ray instanceof Ray)) throw lerr('Unable to cast value to Ray');
  const hit = wsRaycast(self, ray.Origin, ray.Direction, filter);
  if (!hit) return [undefined, ray.Origin.add(ray.Direction), Vector3.zero, E('Material', 'Air')];
  return [hit.part, hit.position, hit.normal, matOf(hit.part)];
}
function partsInBox(ws, cf, size, params) {
  const filter = makeFilter(params);
  const box = { cf, half: size.mul(0.5) };
  const out = [];
  const max = params && params.MaxParts > 0 ? params.MaxParts : Infinity;
  for (const p of allParts(ws)) {
    if (!filter(p) || p.props.CanQuery === false) continue;
    if (obbOverlap(box, partOBB(p))) { out.push(p); if (out.length >= max) break; }
  }
  return out;
}

defineBehavior('WorldRoot', {
  methods: methods({
    Raycast: (self, origin, dir, params) => {
      vec(origin, 1, 'Raycast'); vec(dir, 2, 'Raycast');
      const f = makeFilter(params);
      const hit = wsRaycast(self, origin, dir, (p) => p.props.CanQuery !== false && f(p));
      if (!hit) return [undefined];
      return [new RaycastResult(hit.part, hit.position, hit.normal, matOf(hit.part), hit.distance)];
    },
    Spherecast: (self, origin, radius, dir, params) => {
      const f = makeFilter(params);
      const hit = wsRaycast(self, origin, dir, (p) => p.props.CanQuery !== false && f(p));
      if (!hit) return [undefined];
      return [new RaycastResult(hit.part, hit.position.sub(dir.Unit.mul(radius)), hit.normal, matOf(hit.part), Math.max(0, hit.distance - radius))];
    },
    Blockcast: (self, cf, size, dir, params) => {
      const f = makeFilter(params);
      const hit = wsRaycast(self, cf.Position, dir, (p) => p.props.CanQuery !== false && f(p));
      if (!hit) return [undefined];
      return [new RaycastResult(hit.part, hit.position, hit.normal, matOf(hit.part), hit.distance)];
    },
    Shapecast: (self, part, dir, params) => {
      const f = makeFilter(params);
      const hit = wsRaycast(self, part.props.CFrame.Position, dir, (p) => p !== part && p.props.CanQuery !== false && f(p));
      if (!hit) return [undefined];
      return [new RaycastResult(hit.part, hit.position, hit.normal, matOf(hit.part), hit.distance)];
    },
    FindPartOnRay: (self, ray, ignore) => legacyRay(self, ray, ignoreFilter(ignore ? [ignore] : [])),
    findPartOnRay: (self, ray, ignore) => legacyRay(self, ray, ignoreFilter(ignore ? [ignore] : [])),
    FindPartOnRayWithIgnoreList: (self, ray, list) => legacyRay(self, ray, ignoreFilter(list)),
    FindPartOnRayWithWhitelist: (self, ray, list) => { const items = fromLuaArray(list); return legacyRay(self, ray, (p) => items.some((i) => i === p || p.isDescendantOf(i))); },
    FindPartsInRegion3: (self, region, ignore, max) => {
      const r = region instanceof Region3 ? region : new Region3();
      const parts = partsInBox(self, r.CFrame, r.Size, null).filter(ignoreFilter(ignore ? [ignore] : []));
      return [arr(parts.slice(0, max || 20))];
    },
    FindPartsInRegion3WithIgnoreList: (self, region, list, max) => [arr(partsInBox(self, region.CFrame, region.Size, null).filter(ignoreFilter(list)).slice(0, max || 20))],
    FindPartsInRegion3WithWhiteList: (self, region, list, max) => { const items = fromLuaArray(list); return [arr(partsInBox(self, region.CFrame, region.Size, null).filter((p) => items.some((i) => i === p || p.isDescendantOf(i))).slice(0, max || 20))]; },
    IsRegion3Empty: (self, region, ignore) => [partsInBox(self, region.CFrame, region.Size, null).filter(ignoreFilter(ignore ? [ignore] : [])).length === 0],
    GetPartBoundsInBox: (self, cf, size, params) => [arr(partsInBox(self, cf, size, params))],
    GetPartBoundsInRadius: (self, pos, radius, params) => {
      const f = makeFilter(params);
      const out = [];
      for (const p of allParts(self)) if (f(p) && p.props.CanQuery !== false && sphereOverlapsPart(pos, radius, p)) out.push(p);
      return [arr(out)];
    },
    GetPartsInPart: (self, part, params) => {
      const f = makeFilter(params);
      const box = partOBB(part);
      const out = [];
      for (const p of allParts(self)) if (p !== part && f(p) && p.props.CanQuery !== false && obbOverlap(box, partOBB(p))) out.push(p);
      return [arr(out)];
    },
    ArePartsTouchingOthers: (self, list, overlap = 0) => {
      const parts = fromLuaArray(list);
      for (const a of parts) for (const b of allParts(self)) if (!parts.includes(b) && obbOverlap({ cf: a.props.CFrame, half: a.props.Size.mul(0.5).add(Vector3.one.mul(-overlap)) }, partOBB(b))) return [true];
      return [false];
    },
    BulkMoveTo: (self, parts, cfs) => {
      const ps = fromLuaArray(parts), cs = fromLuaArray(cfs);
      ps.forEach((p, i) => { if (cs[i]) p.set('CFrame', cs[i]); });
    },
    StepPhysics: () => {},
  }),
});

defineBehavior('Workspace', {
  props: {
    CurrentCamera: {
      get: (ws) => {
        let cam = ws.props.CurrentCamera;
        if (!cam || !cam.parent) {
          cam = ws.findFirstChildOfClass('Camera');
          if (!cam && ws.world && ws.world.kind !== 'edit') { cam = new Instance('Camera', ws.world); cam.props.Name = 'Camera'; cam.setParent(ws); }
          if (cam) ws.props.CurrentCamera = cam;
        }
        return cam || null;
      },
      set: (ws, v) => { ws.rawSet('CurrentCamera', v); },
      type: 'Ref',
    },
    DistributedGameTime: { get: (ws) => (ws.world ? ws.world.scheduler.clock : 0), readonly: true, type: 'Float64' },
    Gravity: { get: (ws) => ws.props.Gravity ?? 196.2, set: (ws, v) => ws.rawSet('Gravity', v), type: 'Float32' },
  },
  methods: methods({
    GetServerTimeNow: (self) => [self.world && self.world.serverTime ? self.world.serverTime() : Date.now() / 1000],
    GetRealPhysicsFPS: () => [60],
    GetPhysicsThrottling: () => [100],
    GetNumAwakeParts: (self) => [[...allParts(self)].filter((p) => !p.props.Anchored).length],
    PGSIsEnabled: () => [true],
    JoinToOutsiders: () => {}, UnjoinFromOutsiders: () => {}, MakeJoints: () => {}, BreakJoints: () => {},
    ZoomToExtents: () => {},
  }),
});

// ------------------------------------------------------------------ Camera
function viewport(cam) {
  const w = cam.world;
  const s = w && w.hooks.viewportSize ? w.hooks.viewportSize() : { w: 1280, h: 720 };
  return s;
}
function project(cam, pos) {
  const { w, h } = viewport(cam);
  const cf = cam.props.CFrame || CFrame.identity;
  const local = cf.pointToObject(pos);
  const fov = ((cam.props.FieldOfView ?? 70) * Math.PI) / 180;
  const depth = -local.Z;
  const f = 1 / Math.tan(fov / 2);
  const ndcX = (local.X * f * (h / w)) / Math.max(1e-6, depth);
  const ndcY = (local.Y * f) / Math.max(1e-6, depth);
  const x = ((ndcX + 1) / 2) * w, y = ((1 - ndcY) / 2) * h;
  const on = depth > 0 && x >= 0 && x <= w && y >= 0 && y <= h;
  return [new Vector3(x, y, depth), on];
}
function unproject(cam, x, y, depth = 0) {
  const { w, h } = viewport(cam);
  const cf = cam.props.CFrame || CFrame.identity;
  const fov = ((cam.props.FieldOfView ?? 70) * Math.PI) / 180;
  const t = Math.tan(fov / 2);
  const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
  const dir = cf.vectorToWorld(new Vector3(nx * t * (w / h), ny * t, -1)).Unit;
  const origin = cf.Position.add(dir.mul(depth));
  return new Ray(origin, dir);
}
const inset = (cam) => (cam.world && cam.world.hooks.guiInset ? cam.world.hooks.guiInset() : 0);
defineBehavior('Camera', {
  props: {
    ViewportSize: { get: (c) => { const v = viewport(c); return new Vector2(v.w, v.h); }, readonly: true, type: 'Vector2' },
    CoordinateFrame: { get: (c) => c.props.CFrame || CFrame.identity, set: (c, v) => c.set('CFrame', v), type: 'CFrame' },
    focus: { get: (c) => c.props.Focus || CFrame.identity, set: (c, v) => c.set('Focus', v), type: 'CFrame' },
    NearPlaneZ: { get: () => -0.1, readonly: true, type: 'Float32' },
  },
  methods: methods({
    WorldToViewportPoint: (self, p) => project(self, vec(p, 1, 'WorldToViewportPoint')),
    WorldToScreenPoint: (self, p) => { const [v, on] = project(self, vec(p, 1, 'WorldToScreenPoint')); return [new Vector3(v.X, v.Y - inset(self), v.Z), on]; },
    worldToScreenPoint: (self, p) => { const [v, on] = project(self, p); return [new Vector3(v.X, v.Y - inset(self), v.Z), on]; },
    ViewportPointToRay: (self, x, y, d) => [unproject(self, x, y, d || 0)],
    ScreenPointToRay: (self, x, y, d) => [unproject(self, x, y + inset(self), d || 0)],
    GetPartsObscuringTarget: (self, pts, ignore) => {
      const origin = (self.props.CFrame || CFrame.identity).Position;
      const f = ignoreFilter(ignore);
      const out = new Set();
      const ws = self.parent;
      if (!ws) return [new LuaTable()];
      for (const p of fromLuaArray(pts)) {
        const hit = raycastWorld(ws, origin, p.sub(origin), f);
        if (hit) out.add(hit.part);
      }
      return [arr([...out])];
    },
    Interpolate: (self, to, focus) => { self.set('CFrame', to); self.set('Focus', focus); },
    GetRoll: () => [0], SetRoll: () => {},
    ZoomToExtents: () => {},
    GetRenderCFrame: (self) => [self.props.CFrame || CFrame.identity],
    GetLargestCutoffDistance: () => [0],
  }),
});

// ------------------------------------------------------------------ Lighting
const clockFromString = (s) => { const [h, m, sec] = String(s || '14:00:00').split(':').map(Number); return ((h || 0) + (m || 0) / 60 + (sec || 0) / 3600) % 24; };
const clockToString = (c) => { c = ((c % 24) + 24) % 24; const h = Math.floor(c), m = Math.floor((c - h) * 60), s = Math.floor(((c - h) * 60 - m) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };
function sunDir(L, moon = false) {
  const c = L.get('ClockTime');
  const lat = ((L.props.GeographicLatitude ?? 41.7) * Math.PI) / 180;
  const h = ((c - 12) / 24) * Math.PI * 2 + (moon ? Math.PI : 0);
  const v = new Vector3(-Math.sin(h), Math.cos(h), 0);
  const ca = Math.cos(lat * 0.6), sa = Math.sin(lat * 0.6);
  return new Vector3(v.X, v.Y * ca - v.Z * sa, v.Y * sa + v.Z * ca).Unit;
}
defineBehavior('Lighting', {
  props: {
    ClockTime: {
      get: (L) => (typeof L.props.ClockTime === 'number' ? L.props.ClockTime : clockFromString(L.props.TimeOfDay)),
      set: (L, v) => { const c = ((Number(v) % 24) + 24) % 24; L.rawSet('ClockTime', c); L.rawSet('TimeOfDay', clockToString(c)); },
      type: 'Float32',
    },
    TimeOfDay: {
      get: (L) => L.props.TimeOfDay || clockToString(L.get('ClockTime')),
      set: (L, v) => { L.rawSet('TimeOfDay', String(v)); L.rawSet('ClockTime', clockFromString(v)); },
      type: 'String',
    },
  },
  methods: methods({
    GetMinutesAfterMidnight: (self) => [self.get('ClockTime') * 60],
    SetMinutesAfterMidnight: (self, m) => { self.set('ClockTime', Number(m) / 60); },
    GetSunDirection: (self) => [sunDir(self)],
    GetMoonDirection: (self) => [sunDir(self, true)],
    GetMoonPhase: () => [0.75],
  }),
  events: ['LightingChanged'],
});

// ------------------------------------------------------------------ Terrain (voxels are kept as part-like boxes)
const terrainBlocks = (t) => (t.voxels ||= []);
function terrainAdd(t, cf, size, material, shape = 'box') {
  terrainBlocks(t).push({ cf, size, material, shape });
  const w = t.world;
  if (w && w.hooks.terrainChanged) w.hooks.terrainChanged(t);
  t.changed('Voxels');
}
defineBehavior('Terrain', {
  methods: methods({
    FillBlock: (self, cf, size, mat) => { if (mat && mat.Name === 'Air') return; terrainAdd(self, cf, size, mat || E('Material', 'Grass')); },
    FillBall: (self, center, radius, mat) => { if (mat && mat.Name === 'Air') return; terrainAdd(self, new CFrame(center.X, center.Y, center.Z), new Vector3(radius * 2, radius * 2, radius * 2), mat || E('Material', 'Grass'), 'ball'); },
    FillCylinder: (self, cf, height, radius, mat) => { terrainAdd(self, cf.mul(CFrame.angles(0, 0, Math.PI / 2)), new Vector3(height, radius * 2, radius * 2), mat || E('Material', 'Grass'), 'cylinder'); },
    FillWedge: (self, cf, size, mat) => { terrainAdd(self, cf, size, mat || E('Material', 'Grass'), 'wedge'); },
    FillRegion: (self, region, res, mat) => { if (mat && mat.Name === 'Air') return; terrainAdd(self, region.CFrame, region.Size, mat || E('Material', 'Grass')); },
    Clear: (self) => { self.voxels = []; self.world?.hooks.terrainChanged?.(self); self.changed('Voxels'); },
    ReadVoxels: () => [new LuaTable(), new LuaTable()],
    WriteVoxels: () => {},
    ReplaceMaterial: () => {},
    GetMaterialColor: (self, mat) => [(self.materialColors && self.materialColors[mat.Name]) || Color3.fromRGB(106, 127, 63)],
    SetMaterialColor: (self, mat, c) => { (self.materialColors ||= {})[mat.Name] = c; },
    CellCenterToWorld: (self, x, y, z) => [new Vector3(x * 4 + 2, y * 4 + 2, z * 4 + 2)],
    WorldToCell: (self, p) => [new Vector3(Math.floor(p.X / 4), Math.floor(p.Y / 4), Math.floor(p.Z / 4))],
    WorldToCellPreferSolid: (self, p) => [new Vector3(Math.floor(p.X / 4), Math.floor(p.Y / 4), Math.floor(p.Z / 4))],
    PasteRegion: () => {}, CopyRegion: () => [undefined],
  }),
});

export { OverlapParams, partAABB, S };
