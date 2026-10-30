// BasePart, Model/PVInstance, Attachment, joints and other spatial classes.
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, S, arr, toLua, fromLuaArray, luaTypeof, materialPhysics } from '../bridge.js';
import { Vector3, CFrame, BrickColor, Color3, Region3 } from '../datatypes.js';
import { LuaTable, EMPTY } from '../../luau/runtime.js';
import { partAABB } from '../geom.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const vec = (v, n, f) => { if (!(v instanceof Vector3)) throw lerr(`invalid argument #${n} to '${f}' (Vector3 expected, got ${luaTypeof(v)})`); return v; };
const cfr = (v, n, f) => { if (!(v instanceof CFrame)) throw lerr(`invalid argument #${n} to '${f}' (CFrame expected, got ${luaTypeof(v)})`); return v; };

/** Sets a part's CFrame; in running worlds the physics layer moves the whole assembly. */
export function setPartCFrame(p, cf, opts) {
  const w = p.world;
  if (w && w.hooks.moveAssembly && w.kind !== 'edit') { w.hooks.moveAssembly(p, cf, opts); return; }
  p.rawSet('CFrame', cf, opts);
}

const MIN_SIZE = 0.001;
defineBehavior('BasePart', {
  props: {
    CFrame: { get: (p) => p.props.CFrame, set: (p, v) => setPartCFrame(p, v), type: 'CFrame' },
    Position: {
      get: (p) => p.props.CFrame.Position,
      set: (p, v) => { const c = p.props.CFrame; setPartCFrame(p, CFrame.fromPosRot(v.X, v.Y, v.Z, c.r)); },
      type: 'Vector3',
    },
    Orientation: {
      get: (p) => { const [x, y, z] = p.props.CFrame.toEulerYXZ(); return new Vector3(x * R2D, y * R2D, z * R2D); },
      set: (p, v) => { const c = p.props.CFrame; const r = CFrame.fromEulerYXZ(v.X * D2R, v.Y * D2R, v.Z * D2R); setPartCFrame(p, CFrame.fromPosRot(c.X, c.Y, c.Z, r.r)); },
      type: 'Vector3',
    },
    Rotation: {
      get: (p) => { const [x, y, z] = p.props.CFrame.toEulerXYZ(); return new Vector3(x * R2D, y * R2D, z * R2D); },
      set: (p, v) => { const c = p.props.CFrame; const r = CFrame.angles(v.X * D2R, v.Y * D2R, v.Z * D2R); setPartCFrame(p, CFrame.fromPosRot(c.X, c.Y, c.Z, r.r)); },
      type: 'Vector3',
    },
    Size: {
      get: (p) => p.props.Size,
      set: (p, v) => {
        let s = new Vector3(Math.max(MIN_SIZE, v.X), Math.max(MIN_SIZE, v.Y), Math.max(MIN_SIZE, v.Z));
        if (p.ClassName === 'Part' && p.props.Shape && p.props.Shape.Name === 'Ball') { const m = Math.min(s.X, s.Y, s.Z); s = new Vector3(m, m, m); }
        p.rawSet('Size', s);
      },
      type: 'Vector3',
    },
    BrickColor: { get: (p) => BrickColor.fromColor3(p.props.Color || new Color3()), set: (p, v) => p.set('Color', v.Color), type: 'BrickColor' },
    brickColor: { get: (p) => BrickColor.fromColor3(p.props.Color || new Color3()), set: (p, v) => p.set('Color', v.Color), type: 'BrickColor' },
    Transparency: { get: (p) => p.props.Transparency ?? 0, set: (p, v) => p.rawSet('Transparency', Number(v) || 0), type: 'Float32' },
    AssemblyLinearVelocity: { get: (p) => vel(p, 'linear'), set: (p, v) => setVel(p, 'linear', v), type: 'Vector3' },
    AssemblyAngularVelocity: { get: (p) => vel(p, 'angular'), set: (p, v) => setVel(p, 'angular', v), type: 'Vector3' },
    Velocity: { get: (p) => vel(p, 'linear'), set: (p, v) => setVel(p, 'linear', v), type: 'Vector3' },
    RotVelocity: { get: (p) => vel(p, 'angular'), set: (p, v) => setVel(p, 'angular', v), type: 'Vector3' },
    Mass: { get: (p) => partMass(p), readonly: true, type: 'Float32' },
    AssemblyMass: { get: (p) => (p.world?.hooks.assemblyMass ? p.world.hooks.assemblyMass(p) : partMass(p)), readonly: true, type: 'Float32' },
    AssemblyRootPart: { get: (p) => (p.world?.hooks.assemblyRoot ? p.world.hooks.assemblyRoot(p) : p), readonly: true, type: 'Ref' },
    AssemblyCenterOfMass: { get: (p) => p.props.CFrame.Position, readonly: true, type: 'Vector3' },
    CenterOfMass: { get: () => Vector3.zero, readonly: true, type: 'Vector3' },
    ReceiveAge: { get: () => 0, readonly: true, type: 'Float32' },
    CurrentPhysicalProperties: { get: (p) => p.props.CustomPhysicalProperties || materialPhysics(p.props.Material), readonly: true, type: 'PhysicalProperties' },
    ExtentsCFrame: { get: (p) => p.props.CFrame, readonly: true, type: 'CFrame' },
    ExtentsSize: { get: (p) => p.props.Size, readonly: true, type: 'Vector3' },
    PivotOffset: { get: (p) => p.props.PivotOffset || CFrame.identity, set: (p, v) => p.rawSet('PivotOffset', v), type: 'CFrame' },
  },
  methods: methods({
    GetMass: (self) => [partMass(self)],
    GetPivot: (self) => [self.props.CFrame.mul(self.props.PivotOffset || CFrame.identity)],
    PivotTo: (self, cf) => { cfr(cf, 1, 'PivotTo'); setPartCFrame(self, cf.mul((self.props.PivotOffset || CFrame.identity).inverse())); },
    ApplyImpulse: (self, imp) => { vec(imp, 1, 'ApplyImpulse'); self.world?.hooks.applyImpulse?.(self, imp); },
    ApplyImpulseAtPosition: (self, imp, pos) => { self.world?.hooks.applyImpulse?.(self, imp, pos); },
    ApplyAngularImpulse: (self, imp) => { self.world?.hooks.applyAngularImpulse?.(self, imp); },
    GetConnectedParts: (self, recursive) => [arr(self.world?.hooks.connectedParts ? self.world.hooks.connectedParts(self, !!recursive) : [self])],
    GetJoints: (self) => [arr(jointsOf(self))],
    GetTouchingParts: (self) => [arr(self.world?.hooks.touchingParts ? self.world.hooks.touchingParts(self) : [])],
    GetRootPart: (self) => [self.world?.hooks.assemblyRoot ? self.world.hooks.assemblyRoot(self) : self],
    IsGrounded: (self) => [self.world?.hooks.isGrounded ? self.world.hooks.isGrounded(self) : !!self.props.Anchored],
    SetNetworkOwner: (self, player) => { self.networkOwner = player || null; },
    GetNetworkOwner: (self) => [self.networkOwner || undefined],
    SetNetworkOwnershipAuto: (self) => { self.networkOwner = null; },
    CanSetNetworkOwnership: (self) => [!self.props.Anchored, self.props.Anchored ? 'Cannot set network ownership of anchored parts' : undefined],
    GetNetworkOwnershipAuto: () => [true],
    BreakJoints: (self) => { for (const j of jointsOf(self)) j.destroy(); },
    MakeJoints: () => {},
    CanCollideWith: (self, other) => [!!(self.props.CanCollide && other && other.props.CanCollide)],
    GetVelocityAtPosition: (self, pos) => { const v = vel(self, 'linear'), w = vel(self, 'angular'); return [v.add(w.cross(pos.sub(self.props.CFrame.Position)))]; },
    Resize: (self, face, delta) => {
      const n = (face && face.Value !== undefined ? face.Value : 1);
      const axis = n % 3; const sign = n < 3 ? 1 : -1;
      const s = self.props.Size.toArray(); s[axis] = Math.max(MIN_SIZE, s[axis] + delta);
      const grow = (s[axis] - self.props.Size.toArray()[axis]) / 2;
      const off = [0, 0, 0]; off[axis] = grow * sign;
      self.set('Size', new Vector3(...s));
      setPartCFrame(self, self.props.CFrame.mul(new CFrame(...off)));
      return [true];
    },
    SubtractAsync: () => { throw lerr('CSG operations are not supported in Bloxlab'); },
    UnionAsync: () => { throw lerr('CSG operations are not supported in Bloxlab'); },
    IntersectAsync: () => { throw lerr('CSG operations are not supported in Bloxlab'); },
  }),
});
function vel(p, kind) {
  const w = p.world;
  if (w && w.hooks.getVelocity) { const v = w.hooks.getVelocity(p, kind); if (v) return v; }
  return (kind === 'linear' ? p.props.AssemblyLinearVelocity : p.props.AssemblyAngularVelocity) || Vector3.zero;
}
function setVel(p, kind, v) {
  const w = p.world;
  if (w && w.hooks.setVelocity && w.kind !== 'edit') w.hooks.setVelocity(p, kind, v);
  else p.rawSet(kind === 'linear' ? 'AssemblyLinearVelocity' : 'AssemblyAngularVelocity', v);
}
export function partMass(p) {
  const s = p.props.Size || Vector3.one;
  if (p.props.Massless) return 0;
  const pp = p.props.CustomPhysicalProperties || materialPhysics(p.props.Material || { Name: 'Plastic' });
  let vol = s.X * s.Y * s.Z;
  const shape = p.props.Shape && p.props.Shape.Name;
  if (shape === 'Ball') vol = (4 / 3) * Math.PI * (Math.min(s.X, s.Y, s.Z) / 2) ** 3;
  else if (shape === 'Cylinder') vol = Math.PI * (Math.min(s.Y, s.Z) / 2) ** 2 * s.X;
  else if (p.ClassName === 'WedgePart') vol /= 2;
  else if (p.ClassName === 'CornerWedgePart') vol /= 3;
  return vol * pp.Density;
}
export function jointsOf(part) {
  const out = [];
  const dm = part.dm || part;
  const scan = (root) => {
    for (const d of root.descendants ? root.descendants() : []) {
      if ((d.isA('JointInstance') || d.ClassName === 'WeldConstraint' || d.isA('Constraint')) && (d.props.Part0 === part || d.props.Part1 === part)) out.push(d);
    }
  };
  // joints usually live next to (or inside) the parts they connect
  scan(part.parent && part.parent.ClassName !== 'Workspace' ? part.parent : part);
  if (!out.length && dm !== part) for (const d of part.children) if (d.isA('JointInstance') || d.ClassName === 'WeldConstraint') out.push(d);
  return [...new Set(out)];
}

defineBehavior('Part', {
  props: {
    Shape: {
      get: (p) => p.props.Shape, set: (p, v) => {
        p.rawSet('Shape', v);
        if (v.Name === 'Ball') { const s = p.props.Size; const m = Math.min(s.X, s.Y, s.Z); p.rawSet('Size', new Vector3(m, m, m)); }
      },
      type: 'Enum:PartType',
    },
  },
});

// ------------------------------------------------------------------ PVInstance / Model
export function modelParts(m) { const out = []; for (const d of m.descendants()) if (d.isA('BasePart')) out.push(d); return out; }
export function modelBounds(m, orient) {
  const parts = modelParts(m);
  if (!parts.length) return null;
  const base = orient || CFrame.identity;
  const inv = base.inverse();
  let min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of parts) {
    const local = inv.mul(p.props.CFrame);
    const s = p.props.Size, r = local.r;
    const ex = Math.abs(r[0]) * s.X / 2 + Math.abs(r[1]) * s.Y / 2 + Math.abs(r[2]) * s.Z / 2;
    const ey = Math.abs(r[3]) * s.X / 2 + Math.abs(r[4]) * s.Y / 2 + Math.abs(r[5]) * s.Z / 2;
    const ez = Math.abs(r[6]) * s.X / 2 + Math.abs(r[7]) * s.Y / 2 + Math.abs(r[8]) * s.Z / 2;
    min = min.min(new Vector3(local.X - ex, local.Y - ey, local.Z - ez));
    max = max.max(new Vector3(local.X + ex, local.Y + ey, local.Z + ez));
  }
  const c = min.add(max).mul(0.5);
  const cf = base.mul(new CFrame(c.X, c.Y, c.Z));
  return { cf, size: max.sub(min) };
}
export function modelPivot(m) {
  if (m.props.WorldPivotData) return m.props.WorldPivotData;
  const pp = m.props.PrimaryPart;
  if (pp && pp.isDescendantOf(m)) return pp.props.CFrame.mul(pp.props.PivotOffset || CFrame.identity);
  const b = modelBounds(m);
  return b ? CFrame.fromPosRot(b.cf.X, b.cf.Y, b.cf.Z, CFrame.identity.r) : CFrame.identity;
}
export function pivotModelTo(m, cf) {
  const old = modelPivot(m);
  const delta = cf.mul(old.inverse());
  const parts = modelParts(m);
  const w = m.world;
  if (w && w.hooks.moveParts && w.kind !== 'edit') w.hooks.moveParts(parts, delta);
  else for (const p of parts) p.rawSet('CFrame', delta.mul(p.props.CFrame));
  if (m.props.WorldPivotData) m.rawSet('WorldPivotData', cf);
}
defineBehavior('Model', {
  props: {
    WorldPivot: { get: (m) => modelPivot(m), set: (m, v) => m.rawSet('WorldPivotData', v), type: 'CFrame' },
  },
  methods: methods({
    GetPivot: (self) => [modelPivot(self)],
    PivotTo: (self, cf) => { pivotModelTo(self, cfr(cf, 1, 'PivotTo')); },
    MoveTo: (self, pos) => { vec(pos, 1, 'MoveTo'); const p = modelPivot(self); pivotModelTo(self, CFrame.fromPosRot(pos.X, pos.Y, pos.Z, p.r)); },
    moveTo: (self, pos) => { const p = modelPivot(self); pivotModelTo(self, CFrame.fromPosRot(pos.X, pos.Y, pos.Z, p.r)); },
    TranslateBy: (self, d) => { const p = modelPivot(self); pivotModelTo(self, p.add(vec(d, 1, 'TranslateBy'))); },
    SetPrimaryPartCFrame: (self, cf) => {
      const pp = self.props.PrimaryPart;
      if (!pp) throw lerr('Model:SetPrimaryPartCFrame() failed because no PrimaryPart has been set, or the PrimaryPart no longer exists. Please set Model.PrimaryPart before using this.');
      const delta = cfr(cf, 1, 'SetPrimaryPartCFrame').mul(pp.props.CFrame.inverse());
      const parts = modelParts(self);
      const w = self.world;
      if (w && w.hooks.moveParts && w.kind !== 'edit') w.hooks.moveParts(parts, delta);
      else for (const p of parts) p.rawSet('CFrame', delta.mul(p.props.CFrame));
    },
    GetPrimaryPartCFrame: (self) => {
      const pp = self.props.PrimaryPart;
      if (!pp) throw lerr('Model:GetPrimaryPartCFrame() failed because no PrimaryPart has been set, or the PrimaryPart no longer exists. Please set Model.PrimaryPart before using this.');
      return [pp.props.CFrame];
    },
    GetBoundingBox: (self) => {
      const pp = self.props.PrimaryPart;
      const orient = pp ? CFrame.fromPosRot(0, 0, 0, pp.props.CFrame.r) : (self.props.WorldPivotData ? CFrame.fromPosRot(0, 0, 0, self.props.WorldPivotData.r) : null);
      const b = modelBounds(self, orient);
      return b ? [b.cf, b.size] : [modelPivot(self), Vector3.zero];
    },
    GetExtentsSize: (self) => { const b = modelBounds(self); return [b ? b.size : Vector3.zero]; },
    GetModelSize: (self) => { const b = modelBounds(self); return [b ? b.size : Vector3.zero]; },
    GetModelCFrame: (self) => { const b = modelBounds(self); return [b ? b.cf : CFrame.identity]; },
    BreakJoints: (self) => { for (const d of self.descendants()) if (d.isA('JointInstance') || d.ClassName === 'WeldConstraint') d.destroy(); },
    MakeJoints: () => {},
    GetScale: (self) => [self.scaleFactor || 1],
    ScaleTo: (self, s) => {
      const old = self.scaleFactor || 1;
      const k = s / old;
      const pivot = modelPivot(self);
      for (const p of modelParts(self)) {
        const local = pivot.inverse().mul(p.props.CFrame);
        p.rawSet('Size', p.props.Size.mul(k));
        p.rawSet('CFrame', pivot.mul(CFrame.fromPosRot(local.X * k, local.Y * k, local.Z * k, local.r)));
      }
      for (const d of self.descendants()) {
        if (d.ClassName === 'Attachment') d.rawSet('CFrame', CFrame.fromPosRot(d.props.CFrame.X * k, d.props.CFrame.Y * k, d.props.CFrame.Z * k, d.props.CFrame.r));
        if (d.isA('JointInstance')) for (const c of ['C0', 'C1']) { const v = d.props[c]; if (v) d.rawSet(c, CFrame.fromPosRot(v.X * k, v.Y * k, v.Z * k, v.r)); }
      }
      self.scaleFactor = s;
    },
    GetPersistentPlayers: () => [new LuaTable()],
    AddPersistentPlayer: () => {}, RemovePersistentPlayer: () => {},
  }),
});
defineBehavior('PVInstance', {
  methods: methods({
    GetPivot: (self) => [CFrame.identity],
    PivotTo: () => {},
  }),
});

// ------------------------------------------------------------------ Attachment
const attachPartCF = (a) => { const p = a.parent; return p && p.isA && p.isA('BasePart') ? p.props.CFrame : CFrame.identity; };
defineBehavior('Attachment', {
  props: {
    CFrame: { get: (a) => a.props.CFrame || CFrame.identity, set: (a, v) => a.rawSet('CFrame', v), type: 'CFrame' },
    Position: { get: (a) => (a.props.CFrame || CFrame.identity).Position, set: (a, v) => { const c = a.props.CFrame || CFrame.identity; a.rawSet('CFrame', CFrame.fromPosRot(v.X, v.Y, v.Z, c.r)); }, type: 'Vector3' },
    Orientation: {
      get: (a) => { const [x, y, z] = (a.props.CFrame || CFrame.identity).toEulerYXZ(); return new Vector3(x * R2D, y * R2D, z * R2D); },
      set: (a, v) => { const c = a.props.CFrame || CFrame.identity; a.rawSet('CFrame', CFrame.fromPosRot(c.X, c.Y, c.Z, CFrame.fromEulerYXZ(v.X * D2R, v.Y * D2R, v.Z * D2R).r)); },
      type: 'Vector3',
    },
    Axis: { get: (a) => (a.props.CFrame || CFrame.identity).RightVector, set: (a, v) => { const c = a.props.CFrame || CFrame.identity; a.rawSet('CFrame', CFrame.fromMatrix(c.Position, v.Unit, c.UpVector)); }, type: 'Vector3' },
    SecondaryAxis: { get: (a) => (a.props.CFrame || CFrame.identity).UpVector, set: (a, v) => { const c = a.props.CFrame || CFrame.identity; a.rawSet('CFrame', CFrame.fromMatrix(c.Position, c.RightVector, v.Unit)); }, type: 'Vector3' },
    WorldCFrame: { get: (a) => attachPartCF(a).mul(a.props.CFrame || CFrame.identity), set: (a, v) => a.rawSet('CFrame', attachPartCF(a).inverse().mul(v)), type: 'CFrame' },
    WorldPosition: { get: (a) => attachPartCF(a).pointToWorld((a.props.CFrame || CFrame.identity).Position), set: (a, v) => { const c = a.props.CFrame || CFrame.identity; const l = attachPartCF(a).pointToObject(v); a.rawSet('CFrame', CFrame.fromPosRot(l.X, l.Y, l.Z, c.r)); }, type: 'Vector3' },
    WorldOrientation: { get: (a) => { const [x, y, z] = attachPartCF(a).mul(a.props.CFrame || CFrame.identity).toEulerYXZ(); return new Vector3(x * R2D, y * R2D, z * R2D); }, readonly: true, type: 'Vector3' },
    WorldAxis: { get: (a) => attachPartCF(a).mul(a.props.CFrame || CFrame.identity).RightVector, readonly: true, type: 'Vector3' },
    WorldSecondaryAxis: { get: (a) => attachPartCF(a).mul(a.props.CFrame || CFrame.identity).UpVector, readonly: true, type: 'Vector3' },
  },
  methods: methods({ GetConstrainedParts: () => [new LuaTable()], GetConnectedConstraints: () => [new LuaTable()] }),
});
defineBehavior('Bone', {
  props: {
    TransformedCFrame: { get: (b) => b.props.CFrame || CFrame.identity, readonly: true, type: 'CFrame' },
    TransformedWorldCFrame: { get: (b) => attachPartCF(b).mul(b.props.CFrame || CFrame.identity), readonly: true, type: 'CFrame' },
  },
});

// ------------------------------------------------------------------ joints
const jointChanged = (j) => { const w = j.world; if (w && w.hooks.jointChanged) w.hooks.jointChanged(j); };
defineBehavior('JointInstance', {
  props: {
    C0: { get: (j) => j.props.C0 || CFrame.identity, set: (j, v) => { j.rawSet('C0', v); jointChanged(j); }, type: 'CFrame' },
    C1: { get: (j) => j.props.C1 || CFrame.identity, set: (j, v) => { j.rawSet('C1', v); jointChanged(j); }, type: 'CFrame' },
    Part0: { get: (j) => j.props.Part0 || null, set: (j, v) => { j.rawSet('Part0', v); jointChanged(j); }, type: 'Ref' },
    Part1: { get: (j) => j.props.Part1 || null, set: (j, v) => { j.rawSet('Part1', v); jointChanged(j); }, type: 'Ref' },
    Enabled: { get: (j) => j.props.Enabled !== false, set: (j, v) => { j.rawSet('Enabled', !!v); jointChanged(j); }, type: 'Bool' },
    Active: { get: (j) => j.props.Enabled !== false && !!j.props.Part0 && !!j.props.Part1 && !!j.dm, readonly: true, type: 'Bool' },
  },
});
defineBehavior('Motor6D', {
  props: {
    Transform: { get: (j) => j.transform || CFrame.identity, set: (j, v) => { j.transform = v; jointChanged(j); }, type: 'CFrame' },
  },
});
defineBehavior('Motor', {
  props: {
    CurrentAngle: { get: (j) => j.props.CurrentAngle || 0, set: (j, v) => { j.rawSet('CurrentAngle', v); jointChanged(j); }, type: 'Float32' },
  },
  methods: methods({ SetDesiredAngle: (self, a) => { self.rawSet('DesiredAngle', a); } }),
});
defineBehavior('WeldConstraint', {
  init: (w) => { w.props.Enabled = true; },
  props: {
    Part0: { get: (j) => j.props.Part0 || null, set: (j, v) => { j.rawSet('Part0', v); j.offset = null; jointChanged(j); }, type: 'Ref' },
    Part1: { get: (j) => j.props.Part1 || null, set: (j, v) => { j.rawSet('Part1', v); j.offset = null; jointChanged(j); }, type: 'Ref' },
    Enabled: { get: (j) => j.props.Enabled !== false, set: (j, v) => { j.rawSet('Enabled', !!v); j.offset = null; jointChanged(j); }, type: 'Bool' },
    Active: { get: (j) => j.props.Enabled !== false && !!j.props.Part0 && !!j.props.Part1, readonly: true, type: 'Bool' },
  },
});
defineBehavior('Constraint', {
  props: {
    Active: { get: (c) => c.props.Enabled !== false && !!c.props.Attachment0 && !!c.props.Attachment1, readonly: true, type: 'Bool' },
  },
});

// ------------------------------------------------------------------ meshes / decals
defineBehavior('DataModelMesh', {});
defineBehavior('MeshPart', {
  props: {
    MeshId: { get: (p) => p.props.MeshId || '', set: (p, v) => p.rawSet('MeshId', v), type: 'ContentId' },
    TextureID: { get: (p) => p.props.TextureID || '', set: (p, v) => p.rawSet('TextureID', v), type: 'ContentId' },
  },
});

// ------------------------------------------------------------------ Seats
defineBehavior('Seat', {
  props: { Occupant: { get: (s) => s.occupant || s.props.Occupant || null, readonly: true, type: 'Ref' } },
  methods: methods({ Sit: (self, hum) => { self.world?.hooks.sit?.(self, hum); } }),
});
defineBehavior('VehicleSeat', {
  props: { Occupant: { get: (s) => s.occupant || s.props.Occupant || null, readonly: true, type: 'Ref' } },
  methods: methods({ Sit: (self, hum) => { self.world?.hooks.sit?.(self, hum); } }),
});

export { Region3, partAABB, EMPTY, toLua, fromLuaArray, S, Instance };
