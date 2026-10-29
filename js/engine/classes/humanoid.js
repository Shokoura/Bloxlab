// Humanoid, tools and accessories (engine side; movement lives in game/controller.js).
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, S, arr, toEnum, awaitPromise } from '../bridge.js';
import { CFrame, Vector3 } from '../datatypes.js';
import { E, EnumItem } from '../enums.js';
import { LuaTable, R } from '../../luau/runtime.js';
import { ensureAnimator, loadAnimation } from './animation.js';

const STATES = ['FallingDown', 'Ragdoll', 'GettingUp', 'Jumping', 'Swimming', 'Freefall', 'Flying', 'Landed', 'Running', 'RunningNoPhysics', 'StrafingNoPhysics', 'Climbing', 'Seated', 'PlatformStanding', 'Dead', 'Physics'];

export function rootPartOf(h) {
  const m = h.parent;
  if (!m) return null;
  return m.findFirstChild('HumanoidRootPart') || (m.props.PrimaryPart && m.props.PrimaryPart.isDescendantOf(m) ? m.props.PrimaryPart : null) || m.findFirstChild('Torso');
}
export function setState(h, s) {
  const old = h.state || 'Running';
  if (old === s) return;
  if (old === 'Dead') return;
  h.state = s;
  h.fire('StateChanged', E('HumanoidStateType', old), E('HumanoidStateType', s));
  switch (s) {
    case 'Jumping': h.fire('Jumping', true); break;
    case 'Freefall': h.fire('FreeFalling', true); break;
    case 'Climbing': h.fire('Climbing', 0); break;
    case 'PlatformStanding': h.fire('PlatformStanding', true); break;
    case 'FallingDown': h.fire('FallingDown', true); break;
    case 'GettingUp': h.fire('GettingUp', true); break;
    default: break;
  }
  if (old === 'Freefall') h.fire('FreeFalling', false);
  if (old === 'Jumping') h.fire('Jumping', false);
}

export function killHumanoid(h) {
  if (h.state === 'Dead') return;
  setState(h, 'Dead');
  h.rawSet('Health', 0);
  h.fire('Died');
  const model = h.parent;
  if (model && h.props.BreakJointsOnDeath !== false && h.world && h.world.kind !== 'client') {
    for (const d of model.descendants()) {
      if ((d.ClassName === 'Motor6D' || d.ClassName === 'Weld' || d.ClassName === 'WeldConstraint') && d.props.Name !== 'AccessoryWeld' && !(d.parent && d.parent.ClassName === 'Accessory')) d.destroy();
    }
  }
  h.world?.hooks.humanoidDied?.(h);
}

const healthProp = {
  get: (h) => (h.props.Health ?? 100),
  set: (h, v) => {
    if (h.state === 'Dead') return;
    const max = h.props.MaxHealth ?? 100;
    const nv = Math.max(0, Math.min(max, Number(v) || 0));
    if (h.rawSet('Health', nv)) h.fire('HealthChanged', nv);
    if (nv <= 0 && h.world && h.world.kind !== 'client') killHumanoid(h);
    else if (nv <= 0 && h.world && h.world.kind === 'client' && h.controller) killHumanoid(h);
  },
  type: 'Float32',
};

defineBehavior('Humanoid', {
  init: (h) => { h.state = 'Running'; h.moveDir = Vector3.zero; h.disabledStates = new Set(); },
  props: {
    Health: healthProp,
    MaxHealth: { get: (h) => h.props.MaxHealth ?? 100, set: (h, v) => { h.rawSet('MaxHealth', Math.max(0, Number(v) || 0)); if ((h.props.Health ?? 100) > v) h.set('Health', v); }, type: 'Float32' },
    Jump: { get: (h) => !!h.jumpRequest, set: (h, v) => { h.jumpRequest = !!v; h.rawSet('Jump', !!v); }, type: 'Bool' },
    Sit: {
      get: (h) => !!h.seat,
      set: (h, v) => { if (!v && h.seat) h.world?.hooks.unsit?.(h); h.rawSet('Sit', !!v); },
      type: 'Bool',
    },
    MoveDirection: { get: (h) => h.moveDir || Vector3.zero, readonly: true, type: 'Vector3' },
    RootPart: { get: (h) => rootPartOf(h), readonly: true, type: 'Ref' },
    SeatPart: { get: (h) => h.seat || null, readonly: true, type: 'Ref' },
    FloorMaterial: { get: (h) => h.floorMaterial || E('Material', 'Air'), readonly: true, type: 'Enum:Material' },
    TargetPoint: { get: (h) => h.targetPoint || Vector3.zero, set: (h, v) => { h.targetPoint = v; }, type: 'Vector3' },
    WalkToPoint: { get: (h) => h.walkTo || Vector3.zero, set: (h, v) => { h.walkTo = v; h.walkToStart = performance.now(); }, type: 'Vector3' },
    WalkToPart: { get: (h) => h.walkToPart || null, set: (h, v) => { h.walkToPart = v; }, type: 'Ref' },
    DisplayName: { get: (h) => (h.props.DisplayName || (h.parent ? h.parent.props.Name : '')), set: (h, v) => h.rawSet('DisplayName', String(v)), type: 'String' },
  },
  methods: methods({
    TakeDamage: (self, n) => {
      const model = self.parent;
      if (model && model.findFirstChildOfClass('ForceField')) return;
      self.set('Health', (self.props.Health ?? 100) - (Number(n) || 0));
    },
    Move: (self, dir, relative) => {
      let d = dir instanceof Vector3 ? dir : Vector3.zero;
      if (relative && self.world && self.world.hooks.cameraYaw) {
        const yaw = self.world.hooks.cameraYaw();
        d = CFrame.angles(0, yaw, 0).vectorToWorld(d);
      }
      d = new Vector3(d.X, 0, d.Z);
      self.moveDir = d.Magnitude > 1 ? d.Unit : d;
      self.moveInput = true;
      self.walkTo = null;
    },
    MoveTo: (self, pos, part) => {
      if (!(pos instanceof Vector3)) throw lerr('MoveTo: Vector3 expected');
      self.walkTo = pos;
      self.walkToPart = part || null;
      self.walkToOffset = part ? part.props.CFrame.pointToObject(pos) : null;
      self.walkToStart = self.world ? self.world.scheduler.clock : 0;
      self.moveInput = false;
    },
    ChangeState: (self, st) => {
      const s = toEnum('HumanoidStateType', st).Name;
      if (s === 'Dead') { killHumanoid(self); return; }
      if (s === 'Jumping') { self.jumpRequest = true; return; }
      self.forcedState = s;
      setState(self, s);
    },
    GetState: (self) => [E('HumanoidStateType', self.state || 'Running')],
    SetStateEnabled: (self, st, on) => { const s = toEnum('HumanoidStateType', st).Name; if (on) self.disabledStates.delete(s); else self.disabledStates.add(s); },
    GetStateEnabled: (self, st) => [!self.disabledStates.has(toEnum('HumanoidStateType', st).Name)],
    EquipTool: (self, tool) => { if (!tool || !tool.isA || !tool.isA('Tool')) throw lerr('EquipTool: Tool expected'); if (self.parent) tool.setParent(self.parent); },
    UnequipTools: (self) => {
      const model = self.parent;
      if (!model) return;
      const player = self.world?.hooks.playerFromCharacter?.(model);
      const bp = player && player.findFirstChildOfClass('Backpack');
      for (const c of model.children.slice()) if (c.isA('Tool')) c.setParent(bp || null);
    },
    LoadAnimation: (self, anim) => [loadAnimation(ensureAnimator(self), anim)],
    GetPlayingAnimationTracks: (self) => { const a = self.findFirstChildOfClass('Animator'); return [arr(a ? [...(a.tracks || [])].filter((t) => t.playing) : [])]; },
    AddAccessory: (self, acc) => { attachAccessory(self, acc); },
    GetAccessories: (self) => [arr(self.parent ? self.parent.children.filter((c) => c.isA('Accoutrement')) : [])],
    RemoveAccessories: (self) => { if (self.parent) for (const c of self.parent.children.slice()) if (c.isA('Accoutrement')) c.destroy(); },
    BuildRigFromAttachments: (self) => { buildRigFromAttachments(self.parent); },
    *ApplyDescription(self, desc) {
      const w = self.world;
      if (w && w.hooks.applyDescription) yield* awaitPromise(w.hooks.applyDescription(self, desc), 'ApplyDescription');
      self.appliedDescription = desc;
      self.fire('ApplyDescriptionFinished', desc);
    },
    *ApplyDescriptionReset(self, desc) { return yield* self.beh.methods.ApplyDescription(self, desc); },
    GetAppliedDescription: (self) => [self.appliedDescription || new Instance('HumanoidDescription', self.world)],
    GetBodyPartR15: (self, part) => {
      const n = part && part.props ? part.props.Name : '';
      const it = E('BodyPartR15', 'Unknown');
      return [(n && (() => { try { return E('BodyPartR15', n); } catch { return it; } })()) || it];
    },
    GetLimb: (self, part) => {
      const map = { Head: 'Head', Torso: 'Torso', 'Left Arm': 'LeftArm', 'Right Arm': 'RightArm', 'Left Leg': 'LeftLeg', 'Right Leg': 'RightLeg' };
      return [E('Limb', map[part && part.props.Name] || 'Unknown')];
    },
    ReplaceBodyPartR15: (self, bp, part) => {
      const model = self.parent;
      const name = bp instanceof EnumItem ? bp.Name : S(bp);
      const old = model && model.findFirstChild(name);
      if (!old || !part) return [false];
      part.props.Name = name;
      part.props.CFrame = old.props.CFrame;
      for (const d of model.descendants()) if (d.ClassName === 'Motor6D') { if (d.props.Part0 === old) d.set('Part0', part); if (d.props.Part1 === old) d.set('Part1', part); }
      part.setParent(model);
      old.destroy();
      return [true];
    },
    GetMoveVelocity: (self) => [(self.moveDir || Vector3.zero).mul(self.props.WalkSpeed ?? 16)],
    UnequipTools2: () => {},
  }),
  events: ['Died', 'HealthChanged', 'StateChanged', 'Running', 'Jumping', 'FreeFalling', 'Climbing', 'Seated', 'Touched', 'MoveToFinished', 'FallingDown', 'GettingUp', 'Swimming', 'Strafing', 'PlatformStanding', 'AnimationPlayed', 'ApplyDescriptionFinished', 'StateEnabledChanged', 'ServerBreakJoints'],
});

export function attachAccessory(hum, acc) {
  const model = hum.parent;
  if (!model || !acc) return;
  const handle = acc.findFirstChild('Handle');
  if (!handle) { acc.setParent(model); return; }
  let accAtt = null, bodyAtt = null;
  for (const a of handle.children) {
    if (a.ClassName !== 'Attachment') continue;
    for (const d of model.descendants()) if (d.ClassName === 'Attachment' && d.props.Name === a.props.Name && d.parent && d.parent.isA('BasePart') && !d.isDescendantOf(acc)) { accAtt = a; bodyAtt = d; break; }
    if (bodyAtt) break;
  }
  for (const c of handle.children.slice()) if (c.props.Name === 'AccessoryWeld') c.destroy();
  const w = new Instance('Weld', hum.world);
  w.props.Name = 'AccessoryWeld';
  if (bodyAtt) {
    w.props.Part0 = handle; w.props.Part1 = bodyAtt.parent;
    w.props.C0 = accAtt.props.CFrame || CFrame.identity; w.props.C1 = bodyAtt.props.CFrame || CFrame.identity;
  } else {
    const head = model.findFirstChild('Head');
    if (!head) { acc.setParent(model); return; }
    w.props.Part0 = handle; w.props.Part1 = head;
    w.props.C0 = acc.props.AttachmentPoint || CFrame.identity; w.props.C1 = new CFrame(0, (head.props.Size || Vector3.one).Y / 2, 0);
  }
  handle.props.CFrame = w.props.Part1.props.CFrame.mul(w.props.C1).mul(w.props.C0.inverse());
  handle.props.CanCollide = false;
  handle.props.Massless = true;
  w.setParent(handle);
  if (acc.parent !== model) acc.setParent(model);
}

/** Creates Motor6Ds between parts whose Attachments are named "<Name>RigAttachment". */
export function buildRigFromAttachments(model) {
  if (!model) return;
  const root = model.findFirstChild('HumanoidRootPart');
  if (!root) return;
  const parts = model.children.filter((c) => c.isA('BasePart'));
  const visited = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const a of p.children) {
      if (a.ClassName !== 'Attachment' || !/RigAttachment$/.test(a.props.Name)) continue;
      for (const q of parts) {
        if (visited.has(q)) continue;
        const b = q.findFirstChild(a.props.Name);
        if (!b || b.ClassName !== 'Attachment') continue;
        const jointName = a.props.Name.replace(/RigAttachment$/, '');
        let m = q.children.find((c) => c.ClassName === 'Motor6D' && c.props.Name === jointName);
        if (!m) { m = new Instance('Motor6D', model.world); m.props.Name = jointName; m.setParent(q); }
        m.props.Part0 = p; m.props.Part1 = q;
        m.props.C0 = a.props.CFrame || CFrame.identity; m.props.C1 = b.props.CFrame || CFrame.identity;
        q.props.CFrame = p.props.CFrame.mul(m.props.C0).mul(m.props.C1.inverse());
        visited.add(q);
        queue.push(q);
      }
    }
  }
}

// ------------------------------------------------------------------ tools
export function gripPart(model) { return model.findFirstChild('RightHand') || model.findFirstChild('Right Arm'); }
export function equipTool(tool, model) {
  const handle = tool.findFirstChild('Handle');
  const hand = gripPart(model);
  if (handle && hand && tool.props.RequiresHandle !== false) {
    for (const c of hand.children.slice()) if (c.props.Name === 'RightGrip') c.destroy();
    const w = new Instance('Weld', tool.world);
    w.props.Name = 'RightGrip';
    w.props.Part0 = hand; w.props.Part1 = handle;
    const att = hand.findFirstChild('RightGripAttachment');
    w.props.C0 = att ? att.props.CFrame || CFrame.identity : new CFrame(0, -1, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0);
    w.props.C1 = tool.props.Grip || CFrame.identity;
    handle.props.CFrame = hand.props.CFrame.mul(w.props.C0).mul(w.props.C1.inverse());
    w.setParent(hand);
  }
  tool.equippedIn = model;
}
export function unequipTool(tool, model) {
  const hand = model && gripPart(model);
  if (hand) for (const c of hand.children.slice()) if (c.props.Name === 'RightGrip' && c.props.Part1 && c.props.Part1.isDescendantOf(tool)) c.destroy();
  tool.equippedIn = null;
}
defineBehavior('Tool', {
  props: {
    GripPos: { get: (t) => (t.props.Grip || CFrame.identity).Position, set: (t, v) => { const g = t.props.Grip || CFrame.identity; t.set('Grip', CFrame.fromPosRot(v.X, v.Y, v.Z, g.r)); }, type: 'Vector3' },
    GripForward: { get: (t) => (t.props.Grip || CFrame.identity).LookVector.neg(), set: () => {}, type: 'Vector3' },
    GripRight: { get: (t) => (t.props.Grip || CFrame.identity).RightVector, set: () => {}, type: 'Vector3' },
    GripUp: { get: (t) => (t.props.Grip || CFrame.identity).UpVector, set: () => {}, type: 'Vector3' },
  },
  methods: methods({
    Activate: (self) => { self.fire('Activated'); },
    Deactivate: (self) => { self.fire('Deactivated'); },
  }),
});
defineBehavior('Accoutrement', {});

// ------------------------------------------------------------------ humanoid description
defineBehavior('HumanoidDescription', {
  methods: methods({
    GetAccessories: (self, includeRigid) => {
      const list = [];
      const fields = { HatAccessory: 'Hat', HairAccessory: 'Hair', FaceAccessory: 'Face', NeckAccessory: 'Neck', ShouldersAccessory: 'Shoulder', FrontAccessory: 'Front', BackAccessory: 'Back', WaistAccessory: 'Waist' };
      for (const [k, type] of Object.entries(fields)) for (const id of String(self.props[k] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const t = new LuaTable(); t.set('AssetId', Number(id)); t.set('AccessoryType', E('AccessoryType', type)); t.set('IsLayered', false); list.push(t);
      }
      void includeRigid;
      return [arr(list)];
    },
    SetAccessories: () => {},
    GetEmotes: () => [new LuaTable()], SetEmotes: () => {}, GetEquippedEmotes: () => [new LuaTable()], SetEquippedEmotes: () => {}, AddEmote: () => {}, RemoveEmote: () => {},
  }),
});

export { STATES, R };
