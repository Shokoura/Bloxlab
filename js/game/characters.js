// Character rigs (R6 / R15 blocky) and spawning.
import { Instance } from '../engine/instance.js';
import { Vector3, CFrame, Color3, BrickColor } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { raycastWorld } from '../engine/geom.js';

const M = (x, y, z, ...r) => new CFrame(x, y, z, ...r);
const R6J = [-1, 0, 0, 0, 0, 1, 0, 1, 0];
const RSH = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const LSH = [0, 0, -1, 0, 1, 0, 1, 0, 0];

export const DEFAULT_COLORS = {
  head: Color3.fromRGB(245, 205, 48), torso: Color3.fromRGB(13, 105, 172), arms: Color3.fromRGB(245, 205, 48), legs: Color3.fromRGB(164, 189, 71),
};

function part(world, name, size, cf, color, props = {}) {
  const p = new Instance('Part', world);
  Object.assign(p.props, {
    Name: name, Size: size, CFrame: cf, Color: color, CanCollide: false, TopSurface: E('SurfaceType', 'Smooth'), BottomSurface: E('SurfaceType', 'Smooth'),
    Material: E('Material', 'Plastic'), ...props,
  });
  return p;
}
function motor(world, name, parent, p0, p1, c0, c1) {
  const m = new Instance('Motor6D', world);
  Object.assign(m.props, { Name: name, Part0: p0, Part1: p1, C0: c0, C1: c1 });
  m.parent = parent; parent.children.push(m);
  return m;
}
function att(world, parent, name, cf) {
  const a = new Instance('Attachment', world);
  a.props.Name = name; a.props.CFrame = cf;
  a.parent = parent; parent.children.push(a);
  return a;
}
const add = (parent, child) => { child.parent = parent; parent.children.push(child); return child; };

function face(world, head) {
  const d = new Instance('Decal', world);
  Object.assign(d.props, { Name: 'face', Texture: 'rbxasset://textures/face.png', Face: E('NormalId', 'Front') });
  add(head, d);
  const mesh = new Instance('SpecialMesh', world);
  Object.assign(mesh.props, { Name: 'Mesh', MeshType: E('MeshType', 'Head'), Scale: new Vector3(1.25, 1.25, 1.25) });
  add(head, mesh);
}

/** Builds an unparented character model. colors: { head, torso, arms, legs } (Color3) */
export function buildRig(world, rig = 'R15', { name = 'Player', colors = DEFAULT_COLORS, at = CFrame.identity } = {}) {
  const model = new Instance('Model', world);
  model.props.Name = name;
  const hrp = part(world, 'HumanoidRootPart', new Vector3(2, 2, 1), at, Color3.fromRGB(163, 162, 165), { Transparency: 1, CanCollide: false, RootPriority: 127 });
  add(model, hrp);
  att(world, hrp, 'RootAttachment', CFrame.identity);
  const P = (n, size, local, color, props) => add(model, part(world, n, size, at.mul(local), color, props));
  const hum = new Instance('Humanoid', world);
  if (rig === 'R6') {
    const torso = P('Torso', new Vector3(2, 2, 1), CFrame.identity, colors.torso, { CanCollide: true });
    const head = P('Head', new Vector3(2, 1, 1), new CFrame(0, 1.5, 0), colors.head, { CanCollide: true });
    const ra = P('Right Arm', new Vector3(1, 2, 1), new CFrame(1.5, 0, 0), colors.arms);
    const la = P('Left Arm', new Vector3(1, 2, 1), new CFrame(-1.5, 0, 0), colors.arms);
    const rl = P('Right Leg', new Vector3(1, 2, 1), new CFrame(0.5, -2, 0), colors.legs);
    const ll = P('Left Leg', new Vector3(1, 2, 1), new CFrame(-0.5, -2, 0), colors.legs);
    face(world, head);
    motor(world, 'RootJoint', hrp, hrp, torso, M(0, 0, 0, ...R6J), M(0, 0, 0, ...R6J));
    motor(world, 'Neck', torso, torso, head, M(0, 1, 0, ...R6J), M(0, -0.5, 0, ...R6J));
    motor(world, 'Right Shoulder', torso, torso, ra, M(1, 0.5, 0, ...RSH), M(-0.5, 0.5, 0, ...RSH));
    motor(world, 'Left Shoulder', torso, torso, la, M(-1, 0.5, 0, ...LSH), M(0.5, 0.5, 0, ...LSH));
    motor(world, 'Right Hip', torso, torso, rl, M(1, -1, 0, ...RSH), M(0.5, 1, 0, ...RSH));
    motor(world, 'Left Hip', torso, torso, ll, M(-1, -1, 0, ...LSH), M(-0.5, 1, 0, ...LSH));
    for (const [n, cf] of [['HatAttachment', new CFrame(0, 0.6, 0)], ['HairAttachment', new CFrame(0, 0.6, 0)], ['FaceFrontAttachment', new CFrame(0, 0, -0.6)], ['FaceCenterAttachment', CFrame.identity]]) att(world, head, n, cf);
    for (const [n, cf] of [['NeckAttachment', new CFrame(0, 1, 0)], ['BodyFrontAttachment', new CFrame(0, 0, -0.5)], ['BodyBackAttachment', new CFrame(0, 0, 0.5)], ['LeftCollarAttachment', new CFrame(-1, 1, 0)], ['RightCollarAttachment', new CFrame(1, 1, 0)], ['WaistFrontAttachment', new CFrame(0, -1, -0.5)], ['WaistCenterAttachment', new CFrame(0, -1, 0)], ['WaistBackAttachment', new CFrame(0, -1, 0.5)]]) att(world, torso, n, cf);
    att(world, la, 'LeftShoulderAttachment', new CFrame(0, 1, 0)); att(world, ra, 'RightShoulderAttachment', new CFrame(0, 1, 0));
    att(world, la, 'LeftGripAttachment', new CFrame(0, -1, 0)); att(world, ra, 'RightGripAttachment', new CFrame(0, -1, 0).mul(CFrame.angles(-Math.PI / 2, 0, 0)));
    att(world, ll, 'LeftFootAttachment', new CFrame(0, -1, 0)); att(world, rl, 'RightFootAttachment', new CFrame(0, -1, 0));
    Object.assign(hum.props, { RigType: E('HumanoidRigType', 'R6'), HipHeight: 0 });
  } else {
    const lt = P('LowerTorso', new Vector3(2, 0.4, 1), new CFrame(0, -0.8, 0), colors.torso, { CanCollide: true });
    const ut = P('UpperTorso', new Vector3(2, 1.6, 1), new CFrame(0, 0.2, 0), colors.torso, { CanCollide: true });
    const head = P('Head', new Vector3(2, 1, 1), new CFrame(0, 1.5, 0), colors.head, { CanCollide: true });
    face(world, head);
    att(world, hrp, 'RootRigAttachment', new CFrame(0, -0.8, 0));
    att(world, lt, 'RootRigAttachment', CFrame.identity);
    att(world, lt, 'WaistRigAttachment', new CFrame(0, 0.2, 0)); att(world, ut, 'WaistRigAttachment', new CFrame(0, -0.8, 0));
    att(world, ut, 'NeckRigAttachment', new CFrame(0, 0.8, 0)); att(world, head, 'NeckRigAttachment', new CFrame(0, -0.5, 0));
    motor(world, 'Root', lt, hrp, lt, new CFrame(0, -0.8, 0), CFrame.identity);
    motor(world, 'Waist', ut, lt, ut, new CFrame(0, 0.2, 0), new CFrame(0, -0.8, 0));
    motor(world, 'Neck', head, ut, head, new CFrame(0, 0.8, 0), new CFrame(0, -0.5, 0));
    for (const side of ['Right', 'Left']) {
      const s = side === 'Right' ? 1 : -1;
      const ua = P(`${side}UpperArm`, new Vector3(1, 1, 1), new CFrame(1.5 * s, 0.5, 0), colors.arms);
      const la = P(`${side}LowerArm`, new Vector3(1, 0.75, 1), new CFrame(1.5 * s, -0.375, 0), colors.arms);
      const hand = P(`${side}Hand`, new Vector3(1, 0.25, 1), new CFrame(1.5 * s, -0.875, 0), colors.arms);
      const ul = P(`${side}UpperLeg`, new Vector3(1, 1, 1), new CFrame(0.5 * s, -1.5, 0), colors.legs);
      const ll = P(`${side}LowerLeg`, new Vector3(1, 0.75, 1), new CFrame(0.5 * s, -2.375, 0), colors.legs);
      const foot = P(`${side}Foot`, new Vector3(1, 0.25, 1), new CFrame(0.5 * s, -2.875, 0), colors.legs);
      const sh = [new CFrame(1.5 * s, 0.6, 0), new CFrame(0, 0.3, 0)];
      att(world, ut, `${side}ShoulderRigAttachment`, sh[0]); att(world, ua, `${side}ShoulderRigAttachment`, sh[1]);
      motor(world, `${side}Shoulder`, ua, ut, ua, sh[0], sh[1]);
      att(world, ua, `${side}ElbowRigAttachment`, new CFrame(0, -0.5, 0)); att(world, la, `${side}ElbowRigAttachment`, new CFrame(0, 0.375, 0));
      motor(world, `${side}Elbow`, la, ua, la, new CFrame(0, -0.5, 0), new CFrame(0, 0.375, 0));
      att(world, la, `${side}WristRigAttachment`, new CFrame(0, -0.375, 0)); att(world, hand, `${side}WristRigAttachment`, new CFrame(0, 0.125, 0));
      motor(world, `${side}Wrist`, hand, la, hand, new CFrame(0, -0.375, 0), new CFrame(0, 0.125, 0));
      att(world, lt, `${side}HipRigAttachment`, new CFrame(0.5 * s, -0.2, 0)); att(world, ul, `${side}HipRigAttachment`, new CFrame(0, 0.5, 0));
      motor(world, `${side}Hip`, ul, lt, ul, new CFrame(0.5 * s, -0.2, 0), new CFrame(0, 0.5, 0));
      att(world, ul, `${side}KneeRigAttachment`, new CFrame(0, -0.5, 0)); att(world, ll, `${side}KneeRigAttachment`, new CFrame(0, 0.375, 0));
      motor(world, `${side}Knee`, ll, ul, ll, new CFrame(0, -0.5, 0), new CFrame(0, 0.375, 0));
      att(world, ll, `${side}AnkleRigAttachment`, new CFrame(0, -0.375, 0)); att(world, foot, `${side}AnkleRigAttachment`, new CFrame(0, 0.125, 0));
      motor(world, `${side}Ankle`, foot, ll, foot, new CFrame(0, -0.375, 0), new CFrame(0, 0.125, 0));
      att(world, ua, `${side}ShoulderAttachment`, new CFrame(0, 0.5, 0));
      att(world, hand, `${side}GripAttachment`, new CFrame(0, -0.125, 0).mul(CFrame.angles(-Math.PI / 2, 0, 0)));
      att(world, foot, `${side}FootAttachment`, new CFrame(0, -0.125, 0));
    }
    for (const [n, cf] of [['HatAttachment', new CFrame(0, 0.6, 0)], ['HairAttachment', new CFrame(0, 0.6, 0)], ['FaceFrontAttachment', new CFrame(0, 0, -0.6)], ['FaceCenterAttachment', CFrame.identity]]) att(world, head, n, cf);
    for (const [n, cf] of [['NeckAttachment', new CFrame(0, 0.8, 0)], ['BodyFrontAttachment', new CFrame(0, 0.2, -0.5)], ['BodyBackAttachment', new CFrame(0, 0.2, 0.5)], ['LeftCollarAttachment', new CFrame(-1, 0.8, 0)], ['RightCollarAttachment', new CFrame(1, 0.8, 0)]]) att(world, ut, n, cf);
    for (const [n, cf] of [['WaistFrontAttachment', new CFrame(0, 0, -0.5)], ['WaistBackAttachment', new CFrame(0, 0, 0.5)], ['WaistCenterAttachment', CFrame.identity]]) att(world, lt, n, cf);
    Object.assign(hum.props, { RigType: E('HumanoidRigType', 'R15'), HipHeight: 2 });
  }
  hum.props.Name = 'Humanoid';
  add(model, hum);
  const animator = new Instance('Animator', world);
  animator.props.Name = 'Animator';
  add(hum, animator);
  const bc = new Instance('BodyColors', world);
  const bcn = (c) => BrickColor.fromColor3(c).Number;
  Object.assign(bc.props, { Name: 'Body Colors', HeadColor3: colors.head, TorsoColor3: colors.torso, LeftArmColor3: colors.arms, RightArmColor3: colors.arms, LeftLegColor3: colors.legs, RightLegColor3: colors.legs, HeadColor: bcn(colors.head) });
  add(model, bc);
  model.props.PrimaryPart = hrp;
  return model;
}

/** Applies StarterPlayer character settings to a humanoid. */
export function applyStarterSettings(hum, sp) {
  if (!sp) return;
  const P = sp.props;
  if (P.CharacterWalkSpeed !== undefined) hum.props.WalkSpeed = P.CharacterWalkSpeed;
  if (P.CharacterUseJumpPower !== undefined) hum.props.UseJumpPower = P.CharacterUseJumpPower;
  if (P.CharacterJumpPower !== undefined) hum.props.JumpPower = P.CharacterJumpPower;
  if (P.CharacterJumpHeight !== undefined) hum.props.JumpHeight = P.CharacterJumpHeight;
  if (P.CharacterMaxSlopeAngle !== undefined) hum.props.MaxSlopeAngle = P.CharacterMaxSlopeAngle;
  if (P.HealthDisplayDistance !== undefined) hum.props.HealthDisplayDistance = P.HealthDisplayDistance;
  if (P.NameDisplayDistance !== undefined) hum.props.NameDisplayDistance = P.NameDisplayDistance;
  if (P.AutoJumpEnabled !== undefined) hum.props.AutoJumpEnabled = P.AutoJumpEnabled;
}

/** Spawn CFrame for a player (SpawnLocations, teams, or ground under the origin). */
export function spawnCFrame(world, player, heightAboveGround = 3) {
  const ws = world.dm.findFirstChildOfClass('Workspace');
  const spawns = ws.descendants().filter((d) => d.ClassName === 'SpawnLocation' && d.props.Enabled !== false);
  let candidates = spawns;
  if (player && player.props.Team && !player.props.Neutral) {
    const tc = player.props.Team.props.TeamColor;
    const team = spawns.filter((s) => !s.props.Neutral && s.props.TeamColor && tc && s.props.TeamColor.Number === tc.Number);
    if (team.length) candidates = team;
    else candidates = spawns.filter((s) => s.props.Neutral !== false);
  } else {
    const neutral = spawns.filter((s) => s.props.Neutral !== false);
    if (neutral.length) candidates = neutral;
  }
  if (player && player.props.RespawnLocation && player.props.RespawnLocation.dm) candidates = [player.props.RespawnLocation];
  if (candidates.length) {
    const s = candidates[Math.floor(Math.random() * candidates.length)];
    const sz = s.props.Size;
    const off = new Vector3((Math.random() - 0.5) * Math.max(0, sz.X - 4), 0, (Math.random() - 0.5) * Math.max(0, sz.Z - 4));
    const top = s.props.CFrame.pointToWorld(new Vector3(off.X, sz.Y / 2, off.Z));
    const look = s.props.CFrame.LookVector;
    const yaw = Math.atan2(-look.X, -look.Z);
    return { cf: CFrame.fromPosRot(top.X, top.Y + heightAboveGround + 0.1, top.Z, CFrame.angles(0, yaw, 0).r), spawn: s };
  }
  const hit = raycastWorld(ws, new Vector3(0, 1000, 0), new Vector3(0, -2000, 0), (p) => p.props.CanCollide !== false);
  const y = hit ? hit.position.Y : 0;
  return { cf: new CFrame(0, y + heightAboveGround + 0.1, 0), spawn: null };
}
