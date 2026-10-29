// Humanoid movement: walking, jumping, falling, climbing, sitting, MoveTo — driven by a Rapier
// kinematic character controller. One controller per humanoid simulated by a world
// (the local player's character on the client, NPCs on the server).
import { Vector3, CFrame } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { setState, rootPartOf, killHumanoid } from '../engine/classes/humanoid.js';
import { Instance } from '../engine/instance.js';

const UP = new Vector3(0, 1, 0);

export class CharacterController {
  constructor(humanoid, world) {
    this.hum = humanoid;
    this.world = world;
    this.velocity = Vector3.zero;
    this.vy = 0;
    this.grounded = false;
    this.ctl = null;
    this.capsule = null;
    this.impulse = Vector3.zero;
    this.jumpCooldown = 0;
    this.seatCooldown = 0;
    this.airTime = 0;
    this.lastGroundPart = null;
    this.yaw = null;
    humanoid.controller = this;
  }

  hipHeight() {
    const h = this.hum.props.HipHeight;
    const r15 = this.hum.props.RigType ? this.hum.props.RigType.Name === 'R15' : !!this.hum.parent?.findFirstChild('UpperTorso');
    if (r15 && h > 0) return h;
    if (r15) return 2;
    return h > 0 ? h : 2; // R6 legs are 2 studs
  }

  attach(asm, physics) {
    this.asm = asm;
    this.physics = physics;
    if (!this.ctl) this.ctl = physics.createController(0.04);
    const root = asm.root;
    const rs = root.props.Size || new Vector3(2, 2, 1);
    const hip = this.hipHeight();
    const head = this.hum.parent && this.hum.parent.findFirstChild('Head');
    const headH = head ? head.props.Size.Y : 1;
    const bottom = -(rs.Y / 2 + hip);
    const top = rs.Y / 2 + headH;
    const radius = Math.max(0.6, Math.min(1.2, rs.X / 2));
    const half = Math.max(0.1, (top - bottom) / 2 - radius);
    this.capsule = physics.addCapsule(asm, half, radius, (top + bottom) / 2);
    this.bottomOffset = bottom;
  }
  detach() { this.capsule = null; }
  onTeleport() { this.vy = 0; this.velocity = Vector3.zero; this.airTime = 0; }
  setVelocity(v) { this.vy = v.Y; this.velocity = v; this.impulse = new Vector3(v.X, 0, v.Z); if (v.Y > 0) this.grounded = false; }
  addImpulse(imp, asm) {
    const mass = 10;
    const dv = imp.div(mass);
    this.vy += dv.Y;
    this.impulse = this.impulse.add(new Vector3(dv.X, 0, dv.Z));
    if (dv.Y > 0) this.grounded = false;
    void asm;
  }
  mover(m, dt) {
    // body movers on characters (e.g. BodyVelocity knockback, flying scripts)
    const P = m.props;
    if (m.ClassName === 'BodyVelocity' || m.ClassName === 'LinearVelocity') {
      const v = m.ClassName === 'BodyVelocity' ? (P.Velocity || Vector3.zero) : (P.VectorVelocity || Vector3.zero);
      const mf = m.ClassName === 'BodyVelocity' ? (P.MaxForce || new Vector3(4000, 4000, 4000)) : new Vector3(1e9, 1e9, 1e9);
      this.override = { x: mf.X > 0 ? v.X : null, y: mf.Y > 0 ? v.Y : null, z: mf.Z > 0 ? v.Z : null };
    } else if (m.ClassName === 'BodyPosition' || m.ClassName === 'AlignPosition') {
      const target = m.ClassName === 'BodyPosition' ? (P.Position || Vector3.zero) : (P.Attachment1 ? P.Attachment1.get('WorldPosition') : P.Position || Vector3.zero);
      const cur = this.asm.rootCF.Position;
      const v = target.sub(cur).mul(10);
      this.override = { x: v.X, y: v.Y, z: v.Z };
    } else if (m.ClassName === 'BodyGyro' || m.ClassName === 'AlignOrientation') {
      const cf = m.ClassName === 'BodyGyro' ? (P.CFrame || CFrame.identity) : (P.CFrame || CFrame.identity);
      const look = cf.LookVector;
      this.forcedYaw = Math.atan2(-look.X, -look.Z);
    }
    void dt;
  }

  stateEnabled(s) { return !this.hum.disabledStates.has(s); }

  /** Called by Physics before each fixed step. */
  preStep(dt, asm, physics) {
    const hum = this.hum;
    if (!this.capsule || !asm.body) return;
    const model = hum.parent;
    if (!model || !hum.dm) return;
    if (hum.state === 'Dead') return;
    if ((hum.props.Health ?? 100) <= 0 && this.world.kind !== 'client') { killHumanoid(hum); return; }
    const rootCF = asm.rootCF || asm.root.props.CFrame;
    let pos = rootCF.Position;
    // seated: follow the seat
    if (hum.seat) {
      if (hum.jumpRequest || !hum.seat.dm) { this.unsit(); hum.jumpRequest = false; this.vy = jumpVelocity(hum, this.world); this.grounded = false; this.seatCooldown = 0.6; }
      else { this.followSeat(asm); return; }
    }
    if (this.seatCooldown > 0) this.seatCooldown -= dt;
    if (hum.props.PlatformStand || hum.state === 'PlatformStanding' || hum.state === 'Physics' || hum.state === 'Ragdoll') { this.gravityOnly(dt, asm, physics); return; }

    // desired horizontal movement
    let dir = hum.moveDir || Vector3.zero;
    if (hum.walkTo) {
      const goal = hum.walkToPart && hum.walkToPart.dm && hum.walkToOffset ? hum.walkToPart.props.CFrame.pointToWorld(hum.walkToOffset) : hum.walkTo;
      const d = new Vector3(goal.X - pos.X, 0, goal.Z - pos.Z);
      const elapsed = this.world.scheduler.clock - (hum.walkToStart || 0);
      if (d.Magnitude < 1.2) { hum.walkTo = null; hum.walkToPart = null; dir = Vector3.zero; hum.moveDir = Vector3.zero; hum.fire('MoveToFinished', true); }
      else if (elapsed > 8) { hum.walkTo = null; hum.moveDir = Vector3.zero; dir = Vector3.zero; hum.fire('MoveToFinished', false); }
      else { dir = d.Unit; hum.moveDir = dir; if (goal.Y - pos.Y > 2.5 && this.grounded && hum.props.AutoJumpEnabled !== false) hum.jumpRequest = true; }
    }
    const speed = hum.props.WalkSpeed ?? 16;
    let hv = dir.mul(speed);
    // knockback / scripted velocity decays while grounded
    if (this.impulse.Magnitude > 0.01) { hv = hv.add(this.impulse); this.impulse = this.impulse.mul(this.grounded ? Math.max(0, 1 - dt * 8) : Math.max(0, 1 - dt * 0.5)); }
    // climbing: TrussParts (and ladders) in front of the character
    const climbing = this.stateEnabled('Climbing') && this.canClimb(asm, pos, dir);
    // jumping
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    if (hum.jumpRequest && (this.grounded || climbing) && this.jumpCooldown <= 0 && this.stateEnabled('Jumping') && !climbing) {
      this.vy = jumpVelocity(hum, this.world);
      this.grounded = false;
      this.jumpCooldown = 0.2;
      setState(hum, 'Jumping');
      hum.jumpRequest = false;
      hum.rawSet('Jump', false);
    } else if (hum.jumpRequest && !this.grounded && !climbing) { /* keep request briefly */ }
    if (climbing) {
      this.vy = dir.Magnitude > 0.1 ? speed * 0.7 : 0;
      if (hum.jumpRequest) { this.vy = jumpVelocity(hum, this.world) * 0.6; hv = hv.sub(this.climbNormal.mul(-12)); hum.jumpRequest = false; }
      setState(hum, 'Climbing');
    } else {
      const g = this.world.dm.findFirstChildOfClass('Workspace').get('Gravity') ?? 196.2;
      this.vy -= g * dt;
      this.vy = Math.max(this.vy, -400);
    }
    if (this.override) {
      if (this.override.x !== null) hv = new Vector3(this.override.x, 0, hv.Z);
      if (this.override.z !== null) hv = new Vector3(hv.X, 0, this.override.z);
      if (this.override.y !== null) this.vy = this.override.y;
      this.override = null;
    }
    const delta = new Vector3(hv.X * dt, this.vy * dt, hv.Z * dt);
    const { movement, grounded } = physics.moveCharacter(this.ctl, this.capsule, asm, delta);
    const wasGrounded = this.grounded;
    this.grounded = grounded || (climbing && false);
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (!this.grounded && movement.Y > delta.Y + 1e-3 && this.vy > 0) this.vy = 0; // hit ceiling
    pos = pos.add(movement);
    // facing direction
    let yaw = this.yaw ?? Math.atan2(-rootCF.LookVector.X, -rootCF.LookVector.Z);
    if (this.forcedYaw !== undefined) { yaw = this.forcedYaw; this.forcedYaw = undefined; }
    else if (this.faceYaw !== null && this.faceYaw !== undefined && hum.props.AutoRotate !== false) yaw = this.faceYaw; // shift lock / first person
    else if (hum.props.AutoRotate !== false && dir.Magnitude > 0.05) {
      const target = Math.atan2(-dir.X, -dir.Z);
      let d = target - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      yaw += d * Math.min(1, dt * 14);
    } else if (this.lockYaw !== undefined && this.lockYaw !== null) yaw = this.lockYaw;
    this.yaw = yaw;
    const newCF = CFrame.fromPosRot(pos.X, pos.Y, pos.Z, CFrame.angles(0, yaw, 0).r);
    asm.body.setNextKinematicTranslation({ x: pos.X, y: pos.Y, z: pos.Z });
    const [qx, qy, qz, qw] = newCF.toQuaternion();
    asm.body.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw });
    asm.rootCF = newCF;
    this.velocity = new Vector3(movement.X / dt, this.grounded ? 0 : this.vy, movement.Z / dt);
    // floor material
    if (this.grounded) {
      const probe = physics.groundBelow(asm, pos.add(new Vector3(0, this.bottomOffset + 0.5, 0)), 2);
      this.lastGroundPart = probe && probe.part;
      hum.floorMaterial = probe && probe.part ? probe.part.props.Material || E('Material', 'Plastic') : E('Material', 'Plastic');
      this.airTime = 0;
    } else { hum.floorMaterial = E('Material', 'Air'); this.airTime += dt; }
    // state machine
    if (!climbing && hum.state !== 'Dead') {
      if (this.grounded) {
        if (!wasGrounded && (hum.state === 'Freefall' || hum.state === 'Jumping')) setState(hum, 'Landed');
        setState(hum, 'Running');
      } else if (this.vy < 0 && this.airTime > 0.05 && this.stateEnabled('Freefall')) setState(hum, 'Freefall');
    }
    const hs = Math.hypot(this.velocity.X, this.velocity.Z);
    if (Math.abs(hs - (this.lastSpeed ?? -1)) > 0.5 || (hs < 0.1) !== ((this.lastSpeed ?? 0) < 0.1)) { this.lastSpeed = hs; if (hum.state === 'Running' || hum.state === 'Climbing') hum.fire(hum.state === 'Climbing' ? 'Climbing' : 'Running', hum.state === 'Climbing' ? Math.abs(this.vy) : hs); }
    // seats under the character
    if (this.seatCooldown <= 0 && this.lastSeatCheck !== Math.floor(this.world.scheduler.clock * 10)) {
      this.lastSeatCheck = Math.floor(this.world.scheduler.clock * 10);
      this.checkSeats(asm, physics);
    }
    if (pos.Y < (this.world.dm.findFirstChildOfClass('Workspace').props.FallenPartsDestroyHeight ?? -500) && this.world.kind !== 'client') killHumanoid(hum);
    if (hum.jumpRequest && this.grounded && this.jumpCooldown > 0) { /* wait for cooldown */ }
    if (!hum.moveInput && !hum.walkTo) hum.moveDir = hum.moveDir || Vector3.zero;
  }

  gravityOnly(dt, asm, physics) {
    const g = this.world.dm.findFirstChildOfClass('Workspace').get('Gravity') ?? 196.2;
    this.vy -= g * dt;
    const { movement, grounded } = physics.moveCharacter(this.ctl, this.capsule, asm, new Vector3(this.impulse.X * dt, this.vy * dt, this.impulse.Z * dt));
    if (grounded && this.vy < 0) this.vy = 0;
    const p = asm.rootCF.Position.add(movement);
    asm.body.setNextKinematicTranslation({ x: p.X, y: p.Y, z: p.Z });
    asm.rootCF = CFrame.fromPosRot(p.X, p.Y, p.Z, asm.rootCF.r);
  }

  canClimb(asm, pos, dir) {
    const look = dir.Magnitude > 0.1 ? dir : asm.rootCF.LookVector;
    const ws = this.world.dm.findFirstChildOfClass('Workspace');
    const touching = this.physics.touchList;
    for (const p of asm.parts) {
      for (const other of touching.get(p) || []) {
        if (other.ClassName !== 'TrussPart' || !other.dm) continue;
        const to = other.props.CFrame.Position.sub(pos);
        const flat = new Vector3(to.X, 0, to.Z);
        if (flat.Magnitude < 0.1 || flat.Unit.dot(new Vector3(look.X, 0, look.Z).Unit) > 0.2) { this.climbNormal = flat.Magnitude > 0.1 ? flat.Unit.neg() : look.neg(); return true; }
      }
    }
    void ws;
    return false;
  }

  checkSeats(asm, physics) {
    const hum = this.hum;
    if (hum.seat || hum.state === 'Dead') return;
    for (const p of asm.parts) {
      for (const other of physics.touchList.get(p) || []) {
        if ((other.ClassName === 'Seat' || other.ClassName === 'VehicleSeat') && !other.occupant && other.props.Disabled !== true && other.dm) { this.sit(other); return; }
      }
    }
  }
  sit(seat) {
    const hum = this.hum;
    const root = rootPartOf(hum);
    if (!root) return;
    hum.seat = seat;
    seat.occupant = hum;
    seat.changed('Occupant');
    const w = new Instance('Weld', this.world);
    w.props.Name = 'SeatWeld';
    w.props.Part0 = seat;
    w.props.Part1 = root;
    const hip = this.hipHeight();
    w.props.C0 = new CFrame(0, seat.props.Size.Y / 2 + hip * 0.5 + (root.props.Size?.Y || 2) / 2 - 0.5, 0);
    w.props.C1 = CFrame.identity;
    this.seatWeld = w;
    hum.rawSet('Sit', true);
    setState(hum, 'Seated');
    hum.fire('Seated', true, seat);
    this.world.hooks.sat?.(hum, seat, w);
  }
  followSeat(asm) {
    const seat = this.hum.seat;
    const cf = seat.props.CFrame.mul(this.seatWeld.props.C0);
    asm.body.setNextKinematicTranslation({ x: cf.X, y: cf.Y, z: cf.Z });
    const [qx, qy, qz, qw] = cf.toQuaternion();
    asm.body.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw });
    asm.rootCF = cf;
    this.yaw = Math.atan2(-cf.LookVector.X, -cf.LookVector.Z);
    if (seat.ClassName === 'VehicleSeat') {
      const d = this.hum.moveDir || Vector3.zero;
      const local = seat.props.CFrame.vectorToObject(d);
      seat.rawSet('ThrottleFloat', -Math.round(local.Z)); seat.rawSet('Throttle', -Math.round(local.Z));
      seat.rawSet('SteerFloat', Math.round(local.X)); seat.rawSet('Steer', Math.round(local.X));
    }
  }
  unsit() {
    const hum = this.hum;
    const seat = hum.seat;
    if (!seat) return;
    seat.occupant = null;
    seat.changed('Occupant');
    hum.seat = null;
    this.seatWeld = null;
    hum.rawSet('Sit', false);
    setState(hum, 'Jumping');
    hum.fire('Seated', false, seat);
    if (seat.ClassName === 'VehicleSeat') { seat.rawSet('Throttle', 0); seat.rawSet('Steer', 0); seat.rawSet('ThrottleFloat', 0); seat.rawSet('SteerFloat', 0); }
    this.world.hooks.unsat?.(hum, seat);
  }
}

export function jumpVelocity(hum, world) {
  const g = world.dm.findFirstChildOfClass('Workspace').get('Gravity') ?? 196.2;
  if (hum.props.UseJumpPower) return hum.props.JumpPower ?? 50;
  const h = hum.props.JumpHeight ?? 7.2;
  return Math.sqrt(2 * g * h);
}

export { UP };
