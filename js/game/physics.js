// Rapier-backed physics for a World.
//
// Parts joined by rigid joints (Weld, Motor6D, WeldConstraint, ...) form an *assembly* that maps to
// one rigid body. Anchored assemblies are fixed bodies, character assemblies are kinematic (driven by
// the humanoid controller or by network updates), everything else is dynamic.
import RAPIER from '../../vendor/rapier/rapier.es.js';
import { CFrame, Vector3 } from '../engine/datatypes.js';
import { materialPhysics } from '../engine/bridge.js';
import { partShape } from '../engine/geom.js';
import { partMass } from '../engine/classes/parts.js';
import { terrainSurfaces, terrainShapes } from '../render/terrain.js';
import { groupsOfWorld, groupsFromList } from '../engine/collision-groups.js';

let ready = null;
export const initRapier = () => (ready ||= RAPIER.init());

const RIGID_JOINTS = new Set(['Weld', 'ManualWeld', 'Snap', 'Glue', 'ManualGlue', 'Motor6D', 'Motor', 'VelocityMotor', 'WeldConstraint', 'Rotate', 'RotateP', 'RotateV', 'RigidConstraint']);
const PHYS_PROPS = new Set(['Anchored', 'CanCollide', 'CanTouch', 'Size', 'Shape', 'shape', 'CollisionGroup', 'Massless', 'CustomPhysicalProperties', 'Material', 'RootPriority']);
const JOINT_PROPS = new Set(['Part0', 'Part1', 'Enabled', 'C0', 'C1', 'Attachment0', 'Attachment1']);
const MOVER_CLASSES = new Set(['BodyVelocity', 'BodyPosition', 'BodyGyro', 'BodyForce', 'BodyAngularVelocity', 'BodyThrust', 'VectorForce', 'LinearVelocity', 'AngularVelocity', 'AlignPosition', 'AlignOrientation', 'Torque', 'LineForce']);
let SERVO_K = 5e4, SERVO_D = 0.1;
export const tuneServo = (k, d) => { SERVO_K = k; SERVO_D = d; };
// (LimitsEnabled is not live: Rapier joints cannot drop limits again, so that rebuilds the joint)
const LIVE_CONSTRAINT_PROPS = new Set(['ActuatorType', 'AngularVelocity', 'MotorMaxTorque', 'MotorMaxAcceleration', 'TargetAngle', 'AngularSpeed', 'ServoMaxTorque', 'AngularResponsiveness', 'UpperAngle', 'LowerAngle', 'Restitution', 'Velocity', 'MotorMaxForce', 'TargetPosition', 'Speed', 'ServoMaxForce', 'LinearResponsiveness', 'UpperLimit', 'LowerLimit', 'Visible', 'Color', 'Thickness', 'Radius', 'Coils', 'MaxForce']);
const JOINT_CONSTRAINTS = new Set(['HingeConstraint', 'BallSocketConstraint', 'RopeConstraint', 'SpringConstraint', 'PrismaticConstraint', 'RodConstraint', 'CylindricalConstraint', 'UniversalConstraint', 'SlidingBallConstraint']);

const quat = (cf) => { const [x, y, z, w] = cf.toQuaternion(); return { x, y, z, w }; };
const cfOfBody = (b) => { const t = b.translation(), r = b.rotation(); return CFrame.fromQuaternion(t.x, t.y, t.z, r.x, r.y, r.z, r.w); };
const v3 = (v) => ({ x: v.X, y: v.Y, z: v.Z });
const V = (o) => new Vector3(o.x, o.y, o.z);

export function jointOffset(j, from0) {
  // transform from Part0 to Part1:  P1 = P0 * C0 * T * C1^-1
  if (j.ClassName === 'WeldConstraint') {
    if (!j.offset) { const a = j.props.Part0, b = j.props.Part1; j.offset = a.props.CFrame.inverse().mul(b.props.CFrame); }
    return from0 ? j.offset : j.offset.inverse();
  }
  if (j.ClassName === 'RigidConstraint') {
    const a0 = j.props.Attachment0, a1 = j.props.Attachment1;
    const m = (a0.props.CFrame || CFrame.identity).mul((a1.props.CFrame || CFrame.identity).inverse());
    return from0 ? m : m.inverse();
  }
  const c0 = j.props.C0 || CFrame.identity, c1 = j.props.C1 || CFrame.identity;
  let t = j.transform || CFrame.identity;
  if (j.ClassName === 'Motor' || j.ClassName === 'VelocityMotor') t = CFrame.angles(0, 0, j.props.CurrentAngle || 0);
  const m = c0.mul(t).mul(c1.inverse());
  return from0 ? m : m.inverse();
}
function jointParts(j) {
  if (j.ClassName === 'RigidConstraint') {
    const a0 = j.props.Attachment0, a1 = j.props.Attachment1;
    return [a0 && a0.parent, a1 && a1.parent];
  }
  return [j.props.Part0, j.props.Part1];
}
const jointActive = (j) => {
  if (!j.dm || j.props.Enabled === false) return false;
  const [a, b] = jointParts(j);
  return !!(a && b && a !== b && a.isA && b.isA && a.isA('BasePart') && b.isA('BasePart') && a.dm && b.dm);
};

export class Physics {
  static async create(world, opts) { await initRapier(); return new Physics(world, opts); }

  constructor(world, { role = 'server' } = {}) {
    this.world = world;
    this.role = role;
    this.rw = new RAPIER.World({ x: 0, y: -196.2, z: 0 });
    this.rw.timestep = 1 / 60;
    this.queue = new RAPIER.EventQueue(true);
    this.parts = new Map(); // part -> { asm, offset, colliders: [] }
    this.asms = new Set();
    this.byCollider = new Map(); // collider handle -> part
    this.jointsOf = new Map(); // part -> Set(joint)
    this.dirty = new Set();
    this.constraints = new Set(); // non-rigid constraint instances
    this.constraintJoints = new Map(); // constraint -> rapier joint
    this.jointBodies = new Map(); // constraint -> [asm0, asm1]
    this.constraintParams = new Set(); // constraints whose motor / limit settings changed
    this.movers = new Set();
    this.touching = new Map(); // `${a.id}|${b.id}` -> count
    this.touchList = new Map(); // part -> Set(part)
    this.remoteOwned = new Set(); // assemblies driven by network updates
    this.characterBodies = new Map(); // humanoid -> asm
    this.accum = 0;
    this.groupBits = new Map([['Default', 0]]);
    const ws = world.dm.findFirstChildOfClass('Workspace');
    this.ws = ws;
    this.unobserve = world.observe({
      added: (inst) => inst.forTree((d) => this.onAdded(d)),
      removed: (inst) => inst.forTree((d) => this.onRemoved(d)),
      moved: (inst) => inst.forTree((d) => { this.onRemoved(d); this.onAdded(d); }),
      propChanged: (inst, name, opts) => this.onProp(inst, name, opts),
    });
    this.installHooks();
    ws.forTree((d) => this.onAdded(d));
    this.flushDirty();
  }

  dispose() {
    this.unobserve();
    for (const k of Object.keys(this.hookNames || {})) delete this.world.hooks[k];
    try { this.rw.free(); } catch { /* ignore */ }
    this.queue.free?.();
  }

  // ------------------------------------------------------------ bookkeeping
  inWorkspace(i) { for (let p = i; p; p = p.parent) if (p === this.ws) return true; return false; }
  onAdded(d) {
    if (!this.inWorkspace(d)) return;
    if (d.isA('BasePart') && d.ClassName !== 'Terrain') this.dirty.add(d);
    else if (RIGID_JOINTS.has(d.ClassName)) this.indexJoint(d, true);
    else if (JOINT_CONSTRAINTS.has(d.ClassName)) { this.constraints.add(d); this.constraintsDirty = true; }
    else if (MOVER_CLASSES.has(d.ClassName)) this.movers.add(d);
    else if (d.ClassName === 'Terrain') this.terrainDirty = true;
  }
  onRemoved(d) {
    if (this.parts.has(d)) {
      const info = this.parts.get(d);
      for (const other of this.touchList.get(d) || []) this.endTouch(d, other);
      this.dirty.add(d);
      if (info.asm) for (const p of info.asm.parts) if (p !== d) this.dirty.add(p);
      this.detachPart(d);
    }
    this.dirty.delete(d);
    if (RIGID_JOINTS.has(d.ClassName)) this.indexJoint(d, false);
    if (JOINT_CONSTRAINTS.has(d.ClassName)) { this.removeConstraintJoint(d); this.constraints.delete(d); }
    this.movers.delete(d);
  }
  indexJoint(j, add) {
    const parts = j.lastIndexed || [];
    for (const p of parts) { if (p) { this.jointsOf.get(p)?.delete(j); this.dirty.add(p); } }
    j.lastIndexed = null;
    if (!add) return;
    const now = jointParts(j);
    j.lastIndexed = now;
    for (const p of now) {
      if (!p) continue;
      if (!this.jointsOf.has(p)) this.jointsOf.set(p, new Set());
      this.jointsOf.get(p).add(j);
      this.dirty.add(p);
    }
  }
  onProp(inst, name, opts) {
    if (opts && opts.physics) return;
    if (inst.ClassName === 'Terrain') { if (name === 'SmoothGrid' || name === 'Voxels') this.terrainDirty = true; return; }
    if (inst === this.ws && name === 'CollisionGroupsList') {
      this.world.collisionGroups = groupsFromList(inst.props.CollisionGroupsList || []);
      for (const p of this.parts.keys()) this.dirty.add(p);
      return;
    }
    if (this.parts.has(inst)) {
      if (PHYS_PROPS.has(name)) this.dirty.add(inst);
      else if (name === 'CFrame') {
        // direct writes (e.g. rawSet by the network) -> move the body
        const info = this.parts.get(inst);
        if (info.asm && info.asm.root === inst && !(opts && opts.noTeleport)) this.syncBodyToRoot(info.asm);
        else if (info.asm && !(opts && opts.noTeleport)) this.dirty.add(inst);
      }
      return;
    }
    if (RIGID_JOINTS.has(inst.ClassName)) {
      if (name === 'Transform' || name === 'CurrentAngle') { const p = inst.props.Part0 && this.parts.get(inst.props.Part0); if (p && p.asm) p.asm.offsetsDirty = true; return; }
      if (JOINT_PROPS.has(name)) { inst.offset = null; this.indexJoint(inst, this.inWorkspace(inst)); }
      return;
    }
    if (JOINT_CONSTRAINTS.has(inst.ClassName)) {
      // motor / servo / limit settings change every frame in vehicle scripts: update the joint in place
      if (LIVE_CONSTRAINT_PROPS.has(name) && this.constraintJoints.has(inst)) { this.constraintParams.add(inst); return; }
      this.constraintsDirty = true;
      this.removeConstraintJoint(inst);
    }
  }

  // ------------------------------------------------------------ hooks for engine code
  installHooks() {
    const h = {
      moveAssembly: (part, cf) => this.moveAssembly(part, cf),
      moveParts: (parts, delta) => this.moveParts(parts, delta),
      getVelocity: (part, kind) => this.getVelocity(part, kind),
      setVelocity: (part, kind, v) => this.setVelocity(part, kind, v),
      applyImpulse: (part, imp) => { const a = this.asmOf(part); if (a && a.body && a.kind === 'dynamic') a.body.applyImpulse(v3(imp), true); else if (a && a.character) a.character.addImpulse(imp, a); },
      applyAngularImpulse: (part, imp) => { const a = this.asmOf(part); if (a && a.body && a.kind === 'dynamic') a.body.applyTorqueImpulse(v3(imp), true); },
      assemblyRoot: (part) => { const a = this.asmOf(part); return a ? a.root : part; },
      assemblyMass: (part) => { const a = this.asmOf(part); return a ? [...a.parts].reduce((s, p) => s + partMass(p), 0) : partMass(part); },
      connectedParts: (part) => { const a = this.asmOf(part); return a ? [...a.parts] : [part]; },
      touchingParts: (part) => [...(this.touchList.get(part) || [])],
      isGrounded: (part) => { const a = this.asmOf(part); return !!a && a.kind === 'fixed'; },
      jointChanged: (j) => this.onProp(j, j.ClassName === 'Motor6D' ? 'Transform' : 'C0'),
      collisionGroupsChanged: () => { for (const p of this.parts.keys()) this.dirty.add(p); },
      raycast: (origin, dir, filter) => this.raycast(origin, dir, filter),
    };
    this.hookNames = h;
    Object.assign(this.world.hooks, h);
  }
  /** Ray against every part collider (and terrain); filter(part) -> include. */
  raycast(origin, dir, filter) {
    if (this.dirty.size) this.flushDirty();
    const len = dir.Magnitude;
    if (!(len > 1e-9)) return null;
    const unit = dir.div(len);
    const ray = new RAPIER.Ray(v3(origin), v3(unit));
    const hit = this.rw.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, undefined, (c) => {
      const p = this.byCollider.get(c.handle);
      return !!p && !c.__capsule && (!filter || filter(p));
    });
    if (!hit) return null;
    const toi = hit.timeOfImpact ?? hit.toi;
    return { part: this.byCollider.get(hit.collider.handle), position: origin.add(unit.mul(toi)), normal: V(hit.normal), distance: toi };
  }
  asmOf(part) {
    if (this.dirty.size) this.flushDirty();
    const i = this.parts.get(part);
    return i ? i.asm : null;
  }

  moveAssembly(part, cf) {
    if (this.dirty.has(part) || this.dirty.size) this.flushDirty();
    const info = this.parts.get(part);
    if (!info || !info.asm) { part.rawSet('CFrame', cf); return; }
    const asm = info.asm;
    const rootCF = cf.mul(info.offset.inverse());
    this.setAssemblyPose(asm, rootCF, true);
  }
  moveParts(parts, delta) {
    if (this.dirty.size) this.flushDirty();
    const done = new Set();
    for (const p of parts) {
      const info = this.parts.get(p);
      if (!info || !info.asm) { p.rawSet('CFrame', delta.mul(p.props.CFrame)); continue; }
      if (done.has(info.asm)) continue;
      done.add(info.asm);
      this.setAssemblyPose(info.asm, delta.mul(info.asm.root.props.CFrame), true);
    }
  }
  setAssemblyPose(asm, rootCF, teleport) {
    asm.rootCF = rootCF;
    if (asm.body) {
      if (asm.kind === 'kinematic' && !teleport) { asm.body.setNextKinematicTranslation(v3(rootCF.Position)); asm.body.setNextKinematicRotation(quat(rootCF)); }
      else { asm.body.setTranslation(v3(rootCF.Position), true); asm.body.setRotation(quat(rootCF), true); }
    }
    for (const p of asm.parts) {
      const info = this.parts.get(p);
      p.rawSet('CFrame', p === asm.root ? rootCF : rootCF.mul(info.offset), { physics: true });
    }
    if (asm.character) asm.character.onTeleport?.(rootCF);
  }
  syncBodyToRoot(asm) {
    const cf = asm.root.props.CFrame;
    asm.rootCF = cf;
    if (asm.body) { asm.body.setTranslation(v3(cf.Position), true); asm.body.setRotation(quat(cf), true); }
    for (const p of asm.parts) if (p !== asm.root) p.rawSet('CFrame', cf.mul(this.parts.get(p).offset), { physics: true });
  }
  getVelocity(part, kind) {
    const a = this.asmOf(part);
    if (!a) return null;
    if (a.character) return kind === 'linear' ? a.character.velocity : Vector3.zero;
    if (!a.body || a.kind !== 'dynamic') return Vector3.zero;
    return V(kind === 'linear' ? a.body.linvel() : a.body.angvel());
  }
  setVelocity(part, kind, v) {
    const a = this.asmOf(part);
    if (!a) { part.rawSet(kind === 'linear' ? 'AssemblyLinearVelocity' : 'AssemblyAngularVelocity', v); return; }
    if (a.character) { if (kind === 'linear') a.character.setVelocity(v); return; }
    if (!a.body || a.kind !== 'dynamic') return;
    if (kind === 'linear') a.body.setLinvel(v3(v), true); else a.body.setAngvel(v3(v), true);
  }

  // ------------------------------------------------------------ assembly construction
  flushDirty() {
    if (!this.dirty.size) return;
    const valid = (p) => p.dm && !p.destroyed && p.isA('BasePart') && this.inWorkspace(p);
    // everything that shares an assembly or an active joint with a dirty part is rebuilt
    const all = new Set();
    const stack = [...this.dirty];
    this.dirty.clear();
    while (stack.length) {
      const p = stack.pop();
      if (all.has(p)) continue;
      all.add(p);
      const info = this.parts.get(p);
      if (info && info.asm) for (const q of info.asm.parts) if (!all.has(q)) stack.push(q);
      if (!valid(p)) continue;
      for (const j of this.jointsOf.get(p) || []) {
        if (!jointActive(j)) continue;
        for (const q of jointParts(j)) if (q && !all.has(q)) stack.push(q);
      }
    }
    const oldAsms = new Set();
    for (const p of all) { const info = this.parts.get(p); if (info && info.asm) oldAsms.add(info.asm); }
    for (const a of oldAsms) this.destroyAssembly(a);
    for (const p of all) if (!valid(p)) this.detachPart(p);
    const visited = new Set();
    for (const s of all) {
      if (visited.has(s) || !valid(s)) continue;
      const comp = [];
      const st = [s];
      visited.add(s);
      while (st.length) {
        const p = st.pop();
        comp.push(p);
        for (const j of this.jointsOf.get(p) || []) {
          if (!jointActive(j)) continue;
          for (const o of jointParts(j)) if (o && !visited.has(o) && valid(o)) { visited.add(o); st.push(o); }
        }
      }
      this.buildAssembly(comp);
    }
  }

  chooseRoot(parts) {
    let anchored = parts.find((p) => p.props.Anchored);
    if (anchored) return anchored;
    const hrp = parts.find((p) => p.props.Name === 'HumanoidRootPart' && p.parent && p.parent.findFirstChildOfClass('Humanoid'));
    if (hrp) return hrp;
    let best = parts[0], bestScore = -Infinity;
    for (const p of parts) {
      const s = (p.props.RootPriority || 0) * 1e9 + partMass(p);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  computeOffsets(asm) {
    const root = asm.root;
    const offsets = new Map([[root, CFrame.identity]]);
    const queue = [root];
    while (queue.length) {
      const p = queue.shift();
      const base = offsets.get(p);
      for (const j of this.jointsOf.get(p) || []) {
        if (!jointActive(j)) continue;
        const [a, b] = jointParts(j);
        const other = a === p ? b : a;
        if (!asm.parts.has(other) || offsets.has(other)) continue;
        offsets.set(other, base.mul(jointOffset(j, a === p)));
        queue.push(other);
      }
    }
    for (const p of asm.parts) if (!offsets.has(p)) offsets.set(p, root.props.CFrame.inverse().mul(p.props.CFrame));
    return offsets;
  }

  buildAssembly(parts) {
    const root = this.chooseRoot(parts);
    const anyAnchored = parts.some((p) => p.props.Anchored);
    // a character welded to a seat rides with it: the seat's assembly is simulated, not walked
    const seated = parts.some((p) => p.ClassName === 'Seat' || p.ClassName === 'VehicleSeat');
    const hum = !anyAnchored && !seated && root.props.Name === 'HumanoidRootPart' ? root.parent.findFirstChildOfClass('Humanoid') : null;
    const asm = { root, parts: new Set(parts), body: null, kind: anyAnchored ? 'fixed' : 'dynamic', character: null, humanoid: hum, colliders: [], seated };
    const offsets = this.computeOffsets(asm);
    const rootCF = root.props.CFrame;
    asm.rootCF = rootCF;
    if (hum && hum.controller) { asm.kind = 'kinematic'; asm.character = hum.controller; }
    if (!anyAnchored && !seated && this.remoteOwnedModels && this.remoteOwnedModels.has(root.parent)) { asm.kind = 'kinematic'; asm.remoteDriven = true; }
    // on clients, replicated assemblies follow the server's poses (except our own character)
    if (this.role === 'client' && asm.kind === 'dynamic' && !asm.character && parts.some((p) => p.netId !== undefined)) asm.kind = 'kinematic';
    const desc = asm.kind === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : asm.kind === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(rootCF.X, rootCF.Y, rootCF.Z).setRotation(quat(rootCF));
    if (asm.kind === 'dynamic') {
      desc.setCanSleep(true).setCcdEnabled(parts.length < 4 && parts.some((p) => Math.min(p.props.Size.X, p.props.Size.Y, p.props.Size.Z) < 1));
      desc.setLinearDamping(0.05).setAngularDamping(0.1);
      const lv = root.props.AssemblyLinearVelocity, av = root.props.AssemblyAngularVelocity;
      if (lv) desc.setLinvel(lv.X, lv.Y, lv.Z);
      if (av) desc.setAngvel({ x: av.X, y: av.Y, z: av.Z });
    }
    asm.body = this.rw.createRigidBody(desc);
    let solidCount = 0;
    for (const p of parts) {
      const off = offsets.get(p);
      const info = { asm, offset: off, colliders: [] };
      this.parts.set(p, info);
      const made = this.makeColliders(p, off, asm);
      info.colliders = made;
      for (const c of made) { this.byCollider.set(c.handle, p); if (!c.isSensor()) solidCount++; }
      if (p !== root) p.rawSet('CFrame', rootCF.mul(off), { physics: true });
    }
    if (asm.kind === 'dynamic' && solidCount === 0) {
      // nothing to collide with (all CanCollide false): give it mass so it still falls
      const c = this.rw.createCollider(RAPIER.ColliderDesc.ball(0.1).setDensity(1).setSensor(true), asm.body);
      asm.colliders.push(c);
    }
    if (asm.character) asm.character.attach(asm, this);
    this.asms.add(asm);
    return asm;
  }

  groupsFor(p) {
    const w = this.world;
    const groups = groupsOfWorld(w);
    const name = p.props.CollisionGroup || 'Default';
    let idx = groups.names.indexOf(name);
    if (idx < 0 || idx > 15) idx = 0;
    let filter = 0;
    groups.names.forEach((n, i) => { if (i < 16 && !groups.off.has([name, n].sort().join('|'))) filter |= 1 << i; });
    return ((1 << idx) << 16) | (filter & 0xffff);
  }

  makeColliders(p, off, asm) {
    const P = p.props;
    const s = P.Size;
    const canCollide = P.CanCollide !== false;
    const canTouch = P.CanTouch !== false;
    // non-colliding, non-touching parts still get a query-only sensor so raycasts can hit them
    const queryOnly = !canCollide && !canTouch;
    const shape = partShape(p);
    let desc;
    const hx = Math.max(0.025, s.X / 2), hy = Math.max(0.025, s.Y / 2), hz = Math.max(0.025, s.Z / 2);
    let extraRot = null;
    if (shape === 'ball') desc = RAPIER.ColliderDesc.ball(Math.min(hx, hy, hz));
    else if (shape === 'cylinder') { desc = RAPIER.ColliderDesc.cylinder(hx, Math.min(hy, hz)); extraRot = CFrame.angles(0, 0, Math.PI / 2); }
    else if (shape === 'wedge') {
      const pts = new Float32Array([-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, hx, hy, hz, -hx, hy, hz]);
      desc = RAPIER.ColliderDesc.convexHull(pts) || RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    } else if (shape === 'cornerwedge') {
      const pts = new Float32Array([-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, hx, hy, -hz]);
      desc = RAPIER.ColliderDesc.convexHull(pts) || RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    } else desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    const local = extraRot ? off.mul(extraRot) : off;
    desc.setTranslation(local.X, local.Y, local.Z).setRotation(quat(local));
    const pp = P.CustomPhysicalProperties || materialPhysics(P.Material || { Name: 'Plastic' });
    desc.setDensity(P.Massless ? 0.0001 : Math.max(0.01, pp.Density));
    desc.setFriction(pp.Friction).setRestitution(pp.Elasticity * 0.5);
    desc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Average);
    desc.setCollisionGroups(queryOnly ? 0 : this.groupsFor(p));
    const isCharacterLimb = !!asm.character;
    if (!canCollide) desc.setSensor(true);
    else if (isCharacterLimb) desc.setSolverGroups(0); // limbs detect touches; the capsule does the colliding
    if (canTouch && !queryOnly) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    const c = this.rw.createCollider(desc, asm.body);
    c.__limb = isCharacterLimb;
    asm.colliders.push(c);
    return [c];
  }

  detachPart(p) {
    const info = this.parts.get(p);
    if (!info) return;
    for (const c of info.colliders) { this.byCollider.delete(c.handle); }
    this.parts.delete(p);
  }
  destroyAssembly(asm) {
    if (!this.asms.has(asm)) return;
    this.asms.delete(asm);
    if (asm.character) asm.character.detach?.(asm);
    for (const p of asm.parts) {
      const info = this.parts.get(p);
      if (info && info.asm === asm) this.detachPart(p);
      // carry the velocity over to whatever assembly gets rebuilt
      if (asm.body && asm.kind === 'dynamic') { try { const lv = asm.body.linvel(), av = asm.body.angvel(); p.props.AssemblyLinearVelocity = V(lv); p.props.AssemblyAngularVelocity = V(av); } catch { /* freed */ } }
    }
    this.dropJointsOf(asm);
    if (asm.body) { try { this.rw.removeRigidBody(asm.body); } catch { /* ignore */ } }
    asm.body = null;
  }

  /** Recompute part offsets after Motor6D.Transform / C0 changes (animations). */
  refreshOffsets(asm) {
    asm.offsetsDirty = false;
    const offsets = this.computeOffsets(asm);
    for (const p of asm.parts) {
      const info = this.parts.get(p);
      if (!info) continue;
      const off = offsets.get(p);
      info.offset = off;
      for (const c of info.colliders) {
        let local = off;
        if (partShape(p) === 'cylinder') local = off.mul(CFrame.angles(0, 0, Math.PI / 2));
        c.setTranslationWrtParent(v3(local.Position));
        c.setRotationWrtParent(quat(local));
      }
    }
    if (asm.kind !== 'dynamic' || asm.character) {
      const root = asm.rootCF || asm.root.props.CFrame;
      for (const p of asm.parts) if (p !== asm.root) p.rawSet('CFrame', root.mul(this.parts.get(p).offset), { physics: true });
    }
  }

  // ------------------------------------------------------------ constraints (hinges, ropes, ...)
  removeConstraintJoint(c) {
    const j = this.constraintJoints.get(c);
    if (j) { try { this.rw.removeImpulseJoint(j, true); } catch { /* ignore */ } this.constraintJoints.delete(c); }
    this.jointBodies.delete(c);
  }
  /** Joints attached to an assembly's body die with it; they are recreated on the next step. */
  dropJointsOf(asm) {
    for (const [c, [a0, a1]] of this.jointBodies) {
      if (a0 !== asm && a1 !== asm) continue;
      this.constraintJoints.delete(c);
      this.jointBodies.delete(c);
      this.constraintsDirty = true;
    }
  }
  /**
   * Roblox's solver copes with a light part (steering knuckle) carrying a heavy one (wheel); Rapier's
   * needs help: more iterations for jointed bodies and no more than 1:8 mass ratios across a joint.
   */
  stiffenJoint(a, b) {
    for (const x of [a, b]) {
      if (!x.body || x.kind !== 'dynamic') continue;
      try { x.body.setAdditionalSolverIterations(6); } catch { /* older Rapier */ }
      if (x.baseMass === undefined) x.baseMass = x.body.mass();
    }
    if (!a.body || !b.body || a.kind !== 'dynamic' || b.kind !== 'dynamic') return;
    const [light, heavy] = a.baseMass < b.baseMass ? [a, b] : [b, a];
    const want = heavy.baseMass / 8;
    if (light.baseMass < want && want - light.baseMass > (light.extraMass || 0)) {
      light.extraMass = want - light.baseMass;
      try { light.body.setAdditionalMass(light.extraMass, true); } catch { /* older Rapier */ }
    }
  }

  /** Motor, servo and limit settings of a Roblox constraint -> its Rapier joint. */
  applyConstraintParams(c, j) {
    const P = c.props;
    const act = P.ActuatorType ? P.ActuatorType.Name : 'None';
    const gain = (t) => (t > 0 ? Math.min(60, 4 + Math.log10(1 + t) * 5) : 0);
    try {
      if (c.ClassName === 'HingeConstraint') {
        // (huge "no limit" values would silently disable Rapier's motor)
        if (P.LimitsEnabled) { const lo = ((P.LowerAngle ?? -45) * Math.PI) / 180, hi = ((P.UpperAngle ?? 45) * Math.PI) / 180; j.setLimits(Math.min(lo, hi), Math.max(lo, hi)); }
        if (act === 'Motor') j.configureMotorVelocity(P.AngularVelocity ?? 0, gain(P.MotorMaxTorque ?? 0));
        else if (act === 'Servo') {
          // force based: a servo has to hold whatever hangs on it (a wheel scrubbing the ground)
          const t = Math.min(P.ServoMaxTorque ?? 0, 1e9);
          const k = t > 0 ? Math.min(SERVO_K, t * 2) : 2000;
          j.configureMotorModel(RAPIER.MotorModel ? RAPIER.MotorModel.ForceBased : 1);
          j.configureMotorPosition(((P.TargetAngle ?? 0) * Math.PI) / 180, k, k * SERVO_D);
        } else j.configureMotorVelocity(0, 0);
      } else if (c.ClassName === 'PrismaticConstraint' || c.ClassName === 'CylindricalConstraint') {
        if (P.LimitsEnabled) { const lo = P.LowerLimit ?? -5, hi = P.UpperLimit ?? 5; j.setLimits(Math.min(lo, hi), Math.max(lo, hi)); }
        if (act === 'Motor') j.configureMotorVelocity(P.Velocity ?? 0, gain(P.MotorMaxForce ?? 0));
        else if (act === 'Servo') j.configureMotorPosition(P.TargetPosition ?? 0, 400, 40);
        else j.configureMotorVelocity(0, 0);
      }
    } catch { /* joint type without motors */ }
  }
  syncConstraints() {
    for (const c of this.constraints) {
      if (this.constraintJoints.has(c)) continue;
      const a0 = c.props.Attachment0, a1 = c.props.Attachment1;
      if (!a0 || !a1 || c.props.Enabled === false) continue;
      const p0 = a0.parent, p1 = a1.parent;
      if (!p0 || !p1 || !this.parts.has(p0) || !this.parts.has(p1)) continue;
      const i0 = this.parts.get(p0), i1 = this.parts.get(p1);
      if (i0.asm === i1.asm || !i0.asm.body || !i1.asm.body) continue;
      const w0 = p0.props.CFrame.mul(a0.props.CFrame || CFrame.identity), w1 = p1.props.CFrame.mul(a1.props.CFrame || CFrame.identity);
      const l0 = i0.asm.rootCF.inverse().mul(w0), l1 = i1.asm.rootCF.inverse().mul(w1);
      let data = null;
      switch (c.ClassName) {
        case 'HingeConstraint': data = RAPIER.JointData.revolute(v3(l0.Position), v3(l1.Position), v3(i0.asm.rootCF.inverse().vectorToWorld(w0.RightVector))); break;
        case 'BallSocketConstraint': data = RAPIER.JointData.spherical(v3(l0.Position), v3(l1.Position)); break;
        case 'RopeConstraint': case 'RodConstraint': data = RAPIER.JointData.rope(c.props.Length ?? w0.Position.sub(w1.Position).Magnitude, v3(l0.Position), v3(l1.Position)); break;
        case 'SpringConstraint': data = RAPIER.JointData.spring(c.props.FreeLength ?? 1, c.props.Stiffness ?? 100, c.props.Damping ?? 1, v3(l0.Position), v3(l1.Position)); break;
        case 'PrismaticConstraint': case 'CylindricalConstraint': case 'SlidingBallConstraint': data = RAPIER.JointData.prismatic(v3(l0.Position), v3(l1.Position), v3(i0.asm.rootCF.inverse().vectorToWorld(w0.RightVector))); break;
        default: data = RAPIER.JointData.spherical(v3(l0.Position), v3(l1.Position));
      }
      if (!data) continue;
      const j = this.rw.createImpulseJoint(data, i0.asm.body, i1.asm.body, true);
      this.applyConstraintParams(c, j);
      this.constraintJoints.set(c, j);
      this.jointBodies.set(c, [i0.asm, i1.asm]);
      this.stiffenJoint(i0.asm, i1.asm);
    }
  }

  // ------------------------------------------------------------ body movers
  applyMovers(dt) {
    for (const m of this.movers) {
      if (!m.dm || m.props.Enabled === false) continue;
      let part = m.parent;
      if (m.props.Attachment0) part = m.props.Attachment0.parent;
      if (!part || !part.isA || !part.isA('BasePart')) continue;
      const a = this.asmOf(part);
      if (!a || !a.body || a.kind !== 'dynamic') { if (a && a.character) a.character.mover?.(m, dt); continue; }
      const b = a.body;
      const mass = b.mass() || 1;
      const P = m.props;
      const lin = V(b.linvel()), ang = V(b.angvel());
      const pos = V(b.translation());
      switch (m.ClassName) {
        case 'BodyVelocity': case 'LinearVelocity': {
          const target = m.ClassName === 'BodyVelocity' ? (P.Velocity || P.velocity || Vector3.zero) : velocityTarget(m);
          const maxF = m.ClassName === 'BodyVelocity' ? (P.MaxForce || new Vector3(4000, 4000, 4000)) : new Vector3(P.MaxForce ?? 1000, P.MaxForce ?? 1000, P.MaxForce ?? 1000);
          const nv = new Vector3(maxF.X > 0 ? target.X : lin.X, maxF.Y > 0 ? target.Y : lin.Y, maxF.Z > 0 ? target.Z : lin.Z);
          const blend = Math.min(1, ((P.P ?? 1250) * dt) / Math.max(1, mass * 0.02) + 0.35);
          b.setLinvel(v3(lin.lerp(nv, Math.min(1, blend))), true);
          break;
        }
        case 'BodyPosition': case 'AlignPosition': {
          let target = P.Position || P.position || Vector3.zero;
          if (m.ClassName === 'AlignPosition') {
            if (P.Mode && P.Mode.Name === 'OneAttachment') target = P.Position || Vector3.zero;
            else if (P.Attachment1) target = P.Attachment1.get('WorldPosition');
          }
          const resp = m.ClassName === 'AlignPosition' ? (P.RigidityEnabled ? 200 : (P.Responsiveness ?? 10)) : Math.sqrt((P.P ?? 10000) / Math.max(1, mass));
          const want = target.sub(pos).mul(Math.min(60, resp));
          b.setLinvel(v3(lin.lerp(want, Math.min(1, dt * 12))), true);
          break;
        }
        case 'BodyGyro': case 'AlignOrientation': {
          let target = P.CFrame || P.cframe || CFrame.identity;
          if (m.ClassName === 'AlignOrientation') {
            if (P.Mode && P.Mode.Name === 'OneAttachment') target = P.CFrame || CFrame.identity;
            else if (P.Attachment1) target = P.Attachment1.get('WorldCFrame');
            if (P.Attachment0) target = target.mul((P.Attachment0.props.CFrame || CFrame.identity).inverse());
          }
          const cur = cfOfBody(b);
          const diff = target.mul(cur.inverse());
          const [axis, angle] = diff.Rotation.toAxisAngle();
          const resp = m.ClassName === 'AlignOrientation' ? (P.RigidityEnabled ? 120 : (P.Responsiveness ?? 10)) : 12;
          const want = axis.mul(angle * Math.min(60, resp));
          b.setAngvel(v3(ang.lerp(want, Math.min(1, dt * 15))), true);
          break;
        }
        case 'BodyAngularVelocity': case 'AngularVelocity': {
          let w = P.AngularVelocity || P.angularvelocity || Vector3.zero;
          if (m.ClassName === 'AngularVelocity' && P.RelativeTo && P.RelativeTo.Name === 'Attachment0' && P.Attachment0) w = P.Attachment0.get('WorldCFrame').vectorToWorld(w);
          b.setAngvel(v3(w), true);
          break;
        }
        case 'BodyForce': b.addForce(v3((P.Force || P.force || Vector3.zero)), true); break;
        case 'BodyThrust': b.addForce(v3(cfOfBody(b).vectorToWorld(P.Force || Vector3.zero)), true); break;
        case 'VectorForce': {
          let f = P.Force || Vector3.zero;
          if (!P.RelativeTo || P.RelativeTo.Name !== 'World') { const att = P.Attachment0; f = (att ? att.get('WorldCFrame') : cfOfBody(b)).vectorToWorld(f); }
          if (P.ApplyAtCenterOfMass !== false || !P.Attachment0) b.addForce(v3(f), true);
          else b.addForceAtPoint(v3(f), v3(P.Attachment0.get('WorldPosition')), true);
          break;
        }
        case 'Torque': b.addTorque(v3(P.Torque || Vector3.zero), true); break;
        default: break;
      }
    }
  }

  // ------------------------------------------------------------ touch events
  beginTouch(a, b) {
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const n = (this.touching.get(k) || 0) + 1;
    this.touching.set(k, n);
    if (n !== 1) return;
    for (const [x, y] of [[a, b], [b, a]]) { if (!this.touchList.has(x)) this.touchList.set(x, new Set()); this.touchList.get(x).add(y); }
    if (a.props.Anchored && b.props.Anchored) return;
    a.fire('Touched', b);
    b.fire('Touched', a);
    this.world.hooks.onTouch?.(a, b);
  }
  endTouch(a, b) {
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const n = (this.touching.get(k) || 0) - 1;
    if (n > 0) { this.touching.set(k, n); return; }
    this.touching.delete(k);
    this.touchList.get(a)?.delete(b);
    this.touchList.get(b)?.delete(a);
    if (a.props.Anchored && b.props.Anchored) return;
    a.fire('TouchEnded', b);
    b.fire('TouchEnded', a);
  }

  // ------------------------------------------------------------ stepping
  /** Fixed colliders for terrain voxels (trimeshes per chunk) and scripted Fill* shapes. */
  rebuildTerrain() {
    this.terrainDirty = false;
    if (this.terrainBody) { try { this.rw.removeRigidBody(this.terrainBody); } catch { /* ignore */ } this.terrainBody = null; }
    const t = this.ws.findFirstChildOfClass('Terrain');
    if (!t) return;
    const body = this.rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.terrainBody = body;
    const groups = this.groupsFor(t);
    const add = (desc) => { desc.setCollisionGroups(groups).setFriction(0.8).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL); const c = this.rw.createCollider(desc, body); this.byCollider.set(c.handle, t); };
    for (const s of terrainSurfaces(t)) {
      if (!s.solid.idx.length) continue;
      add(RAPIER.ColliderDesc.trimesh(new Float32Array(s.solid.pos), new Uint32Array(s.solid.idx)));
    }
    for (const v of terrainShapes(t)) {
      if (v.material && v.material.Name === 'Water') continue;
      const h = v.size.mul(0.5);
      const d = v.shape === 'ball' ? RAPIER.ColliderDesc.ball(h.X) : v.shape === 'cylinder' ? RAPIER.ColliderDesc.cylinder(h.X, h.Y).setRotation(quat(CFrame.angles(0, 0, Math.PI / 2))) : RAPIER.ColliderDesc.cuboid(h.X, h.Y, h.Z);
      const cf = v.cf;
      const q = quat(cf);
      if (v.shape === 'cylinder') d.setRotation(quat(cf.mul(CFrame.angles(0, 0, Math.PI / 2)))); else d.setRotation(q);
      d.setTranslation(cf.X, cf.Y, cf.Z);
      add(d);
    }
  }

  step(dt) {
    if (this.terrainDirty) this.rebuildTerrain();
    this.flushDirty();
    if (this.constraintsDirty) { this.constraintsDirty = false; this.syncConstraints(); }
    if (this.constraintParams.size) {
      for (const c of this.constraintParams) { const j = this.constraintJoints.get(c); if (j) this.applyConstraintParams(c, j); }
      this.constraintParams.clear();
    }
    const g = this.ws.get('Gravity') ?? 196.2;
    this.rw.gravity = { x: 0, y: -g, z: 0 };
    for (const a of this.asms) if (a.offsetsDirty) this.refreshOffsets(a);
    // fixed 60 Hz sub-steps
    this.accum = Math.min(this.accum + dt, 0.1);
    const h = 1 / 60;
    let steps = 0;
    while (this.accum >= h && steps < 4) {
      this.accum -= h; steps++;
      this.applyMovers(h);
      for (const a of this.asms) if (a.character && a.character.preStep) a.character.preStep(h, a, this);
      this.rw.timestep = h;
      this.rw.step(this.queue);
      this.queue.drainCollisionEvents((h1, h2, started) => {
        const a = this.byCollider.get(h1), b = this.byCollider.get(h2);
        if (!a || !b || a === b) return;
        if (started) this.beginTouch(a, b); else this.endTouch(a, b);
      });
    }
    if (!steps) return;
    // pull simulated poses back into the DataModel
    const fall = this.ws.props.FallenPartsDestroyHeight ?? -500;
    for (const a of [...this.asms]) {
      if (!a.body) continue;
      if (a.kind === 'dynamic') {
        if (a.body.isSleeping()) continue;
        const cf = cfOfBody(a.body);
        a.rootCF = cf;
        for (const p of a.parts) { const info = this.parts.get(p); if (p === a.root) p.rawSet('CFrame', cf, { physics: true }); else if (info && info.asm === a) p.rawSet('CFrame', cf.mul(info.offset), { physics: true }); }
        if (cf.Y < fall && this.role === 'server') for (const p of [...a.parts]) if (!p.destroyed) p.destroy();
      } else if (a.kind === 'kinematic' && a.character) {
        const cf = cfOfBody(a.body);
        a.rootCF = cf;
        a.root.rawSet('CFrame', cf, { physics: true });
        for (const p of a.parts) { if (p === a.root) continue; const info = this.parts.get(p); if (info && info.asm === a) p.rawSet('CFrame', cf.mul(info.offset), { physics: true }); }
      }
    }
  }

  // ------------------------------------------------------------ character controller support
  createController(offset = 0.05) {
    const c = this.rw.createCharacterController(offset);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setMaxSlopeClimbAngle((60 * Math.PI) / 180);
    c.setMinSlopeSlideAngle((70 * Math.PI) / 180);
    c.enableAutostep(1.2, 0.3, false);
    c.enableSnapToGround(0.6);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setSlideEnabled(true);
    return c;
  }
  addCapsule(asm, halfHeight, radius, offsetY) {
    const desc = RAPIER.ColliderDesc.capsule(halfHeight, radius).setTranslation(0, offsetY, 0).setFriction(0).setCollisionGroups(this.groupsFor(asm.root));
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const c = this.rw.createCollider(desc, asm.body);
    c.__capsule = true;
    asm.colliders.push(c);
    return c;
  }
  /** Moves a kinematic character collider; returns { movement: Vector3, grounded } */
  moveCharacter(ctl, collider, asm, delta) {
    ctl.computeColliderMovement(collider, v3(delta), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (other) => {
      if (other.__limb) return false;
      const p = this.byCollider.get(other.handle);
      return !(p && asm.parts.has(p));
    });
    const m = ctl.computedMovement();
    return { movement: new Vector3(m.x, m.y, m.z), grounded: ctl.computedGrounded() };
  }
  /** Ground probe below a point (ignores the given assembly). */
  groundBelow(asm, from, dist) {
    const ray = new RAPIER.Ray(v3(from), { x: 0, y: -1, z: 0 });
    const hit = this.rw.castRay(ray, dist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, (c) => { if (c.__limb || c.__capsule) return false; const p = this.byCollider.get(c.handle); return !(p && asm.parts.has(p)); });
    if (!hit) return null;
    const toi = hit.timeOfImpact ?? hit.toi;
    return { distance: toi, part: this.byCollider.get(hit.collider.handle) || null };
  }
}

function velocityTarget(m) {
  const P = m.props;
  const mode = P.VelocityConstraintMode ? P.VelocityConstraintMode.Name : 'Vector';
  let v = mode === 'Line' ? (P.LineDirection || Vector3.xAxis).Unit.mul(P.LineVelocity || 0) : mode === 'Plane' ? new Vector3((P.PlaneVelocity || { X: 0 }).X, 0, (P.PlaneVelocity || { Y: 0 }).Y) : (P.VectorVelocity || Vector3.zero);
  if (P.RelativeTo && P.RelativeTo.Name === 'Attachment0' && P.Attachment0) v = P.Attachment0.get('WorldCFrame').vectorToWorld(v);
  return v;
}

export { RAPIER, quat, cfOfBody };
