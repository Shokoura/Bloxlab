// Roblox avatars: reads a user's public avatar (avatar.roblox.com through the External Load API proxy),
// turns it into a HumanoidDescription, and dresses characters with body colors, body parts, faces,
// clothing and accessories loaded through the asset chain.
import { Instance } from '../engine/instance.js';
import { Color3, Vector3, CFrame, BrickColor } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { loadModel } from '../engine/datamodel.js';
import { attachAccessory, buildRigFromAttachments } from '../engine/classes/humanoid.js';
import { buildRig } from '../game/characters.js';

// avatar asset type id -> HumanoidDescription field
const ACCESSORY_FIELDS = { 8: 'HatAccessory', 41: 'HairAccessory', 42: 'FaceAccessory', 43: 'NeckAccessory', 44: 'ShouldersAccessory', 45: 'FrontAccessory', 46: 'BackAccessory', 47: 'WaistAccessory' };
const LAYERED = new Set([64, 65, 66, 67, 68, 69, 70, 71, 72, 76, 77]); // layered clothing / shoes / brows, drawn rigidly
const BODY_FIELDS = { 17: 'Head', 79: 'Head', 27: 'Torso', 28: 'RightArm', 29: 'LeftArm', 30: 'LeftLeg', 31: 'RightLeg' };
const CLOTHING_FIELDS = { 2: 'GraphicTShirt', 11: 'Shirt', 12: 'Pants', 18: 'Face' };
const ANIM_FIELDS = { 48: 'ClimbAnimation', 50: 'FallAnimation', 51: 'IdleAnimation', 52: 'JumpAnimation', 53: 'RunAnimation', 54: 'SwimAnimation', 55: 'WalkAnimation', 78: 'MoodAnimation' };
const COLOR_KEYS = { headColor: 'HeadColor', torsoColor: 'TorsoColor', leftArmColor: 'LeftArmColor', rightArmColor: 'RightArmColor', leftLegColor: 'LeftLegColor', rightLegColor: 'RightLegColor' };
const R15_PARTS = {
  Head: ['Head'], Torso: ['UpperTorso', 'LowerTorso'], LeftArm: ['LeftUpperArm', 'LeftLowerArm', 'LeftHand'], RightArm: ['RightUpperArm', 'RightLowerArm', 'RightHand'],
  LeftLeg: ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot'], RightLeg: ['RightUpperLeg', 'RightLowerLeg', 'RightFoot'],
};
const R6_PARTS = { Head: ['Head'], Torso: ['Torso'], LeftArm: ['Left Arm'], RightArm: ['Right Arm'], LeftLeg: ['Left Leg'], RightLeg: ['Right Leg'] };
const hex = (s) => { const n = parseInt(String(s).replace('#', ''), 16); return Color3.fromRGB((n >> 16) & 255, (n >> 8) & 255, n & 255); };

export class Avatars {
  constructor(app) {
    this.app = app;
    this.info = new Map(); // userId -> Promise<avatar json>
    this.models = new Map(); // asset id -> Promise<raw bytes>
  }
  get assets() { return this.app.assets; }

  async userId(nameOrId) {
    const s = String(nameOrId || '').trim();
    if (!s) throw new Error('no Roblox user set (Settings → Avatar)');
    if (/^\d+$/.test(s)) return Number(s);
    const u = await this.assets.lookupUser(s);
    if (!u) throw new Error(`Roblox user "${s}" not found`);
    return u.id;
  }

  avatarJson(userId) {
    let p = this.info.get(userId);
    if (!p) {
      p = (async () => {
        const v1 = await this.assets.api('avatar', `/v1/users/${userId}/avatar`);
        // v2 has exact body colors; v1 only BrickColor ids
        try { const v2 = await this.assets.api('avatar', `/v2/avatar/users/${userId}/avatar`); if (v2 && v2.bodyColor3s) v1.bodyColor3s = v2.bodyColor3s; } catch { /* v1 is enough */ }
        return v1;
      })();
      this.info.set(userId, p);
      p.catch(() => setTimeout(() => this.info.delete(userId), 30000));
    }
    return p;
  }

  /** HumanoidDescription instance from avatar.roblox.com data. */
  descriptionFromJson(world, j) {
    const d = new Instance('HumanoidDescription', world);
    d.props.Name = 'HumanoidDescription';
    const P = d.props;
    if (j.bodyColor3s) for (const [k, f] of Object.entries(COLOR_KEYS)) { const v = j.bodyColor3s[`${k}3`]; if (v) P[f] = hex(v); }
    else if (j.bodyColors) for (const [k, f] of Object.entries(COLOR_KEYS)) { const v = j.bodyColors[`${k}Id`]; if (v !== undefined) P[f] = BrickColor.fromNumber(v).Color; }
    const acc = {};
    d.extraAccessories = [];
    for (const a of j.assets || []) {
      const t = a.assetType ? a.assetType.id : a.assetTypeId;
      if (ACCESSORY_FIELDS[t]) (acc[ACCESSORY_FIELDS[t]] ||= []).push(a.id);
      else if (LAYERED.has(t)) d.extraAccessories.push(a.id);
      else if (BODY_FIELDS[t]) P[BODY_FIELDS[t]] = a.id;
      else if (CLOTHING_FIELDS[t]) P[CLOTHING_FIELDS[t]] = a.id;
      else if (ANIM_FIELDS[t]) P[ANIM_FIELDS[t]] = a.id;
    }
    for (const [k, v] of Object.entries(acc)) P[k] = v.join(',');
    const s = j.scales || {};
    P.HeightScale = s.height ?? 1; P.WidthScale = s.width ?? 1; P.DepthScale = s.depth ?? 1; P.HeadScale = s.head ?? 1;
    P.BodyTypeScale = s.bodyType ?? 0; P.ProportionScale = s.proportion ?? 0;
    d.rigType = j.playerAvatarType === 'R6' ? 'R6' : 'R15';
    return d;
  }

  async descriptionFromUserId(world, userId) {
    const j = await this.avatarJson(userId);
    return this.descriptionFromJson(world, j);
  }

  async createModel(world, desc, rig = 'R15') {
    const m = buildRig(world, rig || (desc && desc.rigType) || 'R15', { name: 'Character' });
    const hum = m.findFirstChildOfClass('Humanoid');
    if (desc) await this.applyDescription(world, hum, desc);
    return m;
  }

  /** Character for a player whose hello carried avatar settings { mode, user }. */
  async characterFor(world, player, avatar, desc, rigPref) {
    if (!desc) {
      if (!avatar || avatar.mode !== 'roblox') return null;
      const id = await this.userId(avatar.user || player.props.UserId);
      desc = await this.descriptionFromUserId(world, id);
    }
    const rig = desc.rigType || rigPref || 'R15';
    const m = buildRig(world, rig, { name: player.props.Name });
    await this.applyDescription(world, m.findFirstChildOfClass('Humanoid'), desc);
    return m;
  }

  async modelInstances(world, id) {
    let p = this.models.get(id);
    if (!p) { p = this.assets.model(`rbxassetid://${id}`).then((r) => r.bytes); this.models.set(id, p); p.catch(() => this.models.delete(id)); }
    const bytes = await p;
    return loadModel(bytes, world).instances;
  }

  /** Dresses a character model according to a HumanoidDescription (missing assets are skipped). */
  async applyDescription(world, hum, desc) {
    const model = hum && hum.parent;
    if (!model || !desc) return;
    const P = desc.props;
    const r15 = !!model.findFirstChild('UpperTorso');
    const groups = r15 ? R15_PARTS : R6_PARTS;
    const warn = (what, e) => world.output(`Avatar: could not load ${what} (${e.message})`, 'warn');
    // body parts first (they replace limbs), then colors so new parts are tinted
    if (r15) {
      for (const field of ['Head', 'Torso', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg']) {
        const id = Number(P[field] || 0);
        if (!id) continue;
        try { await this.replaceBodyPart(world, model, field, id); } catch (e) { warn(`${field} ${id}`, e); }
      }
      buildRigFromAttachments(model);
    }
    const bc = model.findFirstChildOfClass('BodyColors') || (() => { const b = new Instance('BodyColors', world); b.props.Name = 'Body Colors'; b.parent = model; model.children.push(b); return b; })();
    for (const [field, names] of Object.entries(groups)) {
      const c = P[`${field}Color`];
      if (!c) continue;
      bc.props[`${field}Color3`] = c;
      bc.props[`${field}Color`] = BrickColor.fromColor3(c);
      for (const n of names) { const part = model.findFirstChild(n); if (part) part.props.Color = c; }
    }
    // face
    const faceId = Number(P.Face || 0);
    const head = model.findFirstChild('Head');
    if (faceId && head) {
      try {
        const list = await this.modelInstances(world, faceId);
        const decal = list.find((i) => i.ClassName === 'Decal') || list.flatMap((i) => i.descendants()).find((i) => i.ClassName === 'Decal');
        if (decal) { let face = head.findFirstChild('face'); if (!face) { face = new Instance('Decal', world); face.props.Name = 'face'; face.parent = head; head.children.push(face); } face.props.Texture = decal.props.Texture; face.props.Face = E('NormalId', 'Front'); }
      } catch (e) { warn(`face ${faceId}`, e); }
    }
    // clothing
    for (const [field, cls] of [['Shirt', 'Shirt'], ['Pants', 'Pants'], ['GraphicTShirt', 'ShirtGraphic']]) {
      const id = Number(P[field] || 0);
      if (!id) continue;
      try {
        const list = await this.modelInstances(world, id);
        const item = list.find((i) => i.ClassName === cls) || list.flatMap((i) => i.descendants()).find((i) => i.ClassName === cls);
        if (!item) continue;
        for (const c of model.children.slice()) if (c.ClassName === cls) c.destroy();
        item.parent = model; model.children.push(item);
      } catch (e) { warn(`${field} ${id}`, e); }
    }
    // accessories (rigid; layered clothing is attached rigidly as an approximation)
    const ids = [];
    for (const f of Object.values(ACCESSORY_FIELDS)) for (const s of String(P[f] || '').split(',')) if (/^\d+$/.test(s.trim())) ids.push(Number(s.trim()));
    for (const id of desc.extraAccessories || []) ids.push(id);
    await Promise.all(ids.map(async (id) => {
      try {
        const list = await this.modelInstances(world, id);
        const acc = list.find((i) => i.isA('Accoutrement')) || list.flatMap((i) => i.descendants()).find((i) => i.isA('Accoutrement'));
        if (acc) attachAccessory(hum, acc);
      } catch (e) { warn(`accessory ${id}`, e); }
    }));
    if (r15) { this.applyScales(model, P); autoHipHeight(model); }
    hum.appliedDescription = desc;
  }

  /** Swaps limbs for the MeshParts of a body-part asset (R15ArtistIntent / R15Fixed folders). */
  async replaceBodyPart(world, model, field, id) {
    const list = await this.modelInstances(world, id);
    const all = list.flatMap((i) => [i, ...i.descendants()]);
    const folder = all.find((i) => i.props.Name === 'R15ArtistIntent' && i.children.length) || all.find((i) => i.props.Name === 'R15Fixed' && i.children.length);
    const parts = folder ? folder.children.filter((c) => c.isA('BasePart')) : all.filter((c) => c.isA('BasePart') && R15_PARTS[field].includes(c.props.Name));
    if (field === 'Head' && !parts.length) {
      // classic head: a SpecialMesh to put on the existing head
      const sm = all.find((i) => i.ClassName === 'SpecialMesh');
      const head = model.findFirstChild('Head');
      if (sm && head) { for (const c of head.children.slice()) if (c.ClassName === 'SpecialMesh') { head.children.splice(head.children.indexOf(c), 1); c.parent = null; } sm.parent = head; head.children.push(sm); }
      return;
    }
    for (const np of parts) {
      const old = model.findFirstChild(np.props.Name);
      if (!old) continue;
      if (np.parent) { np.parent.children.splice(np.parent.children.indexOf(np), 1); np.parent = null; }
      np.props.CFrame = old.props.CFrame;
      np.props.Color = old.props.Color;
      np.props.CanCollide = false;
      np.props.Anchored = false;
      // keep the face on a replaced head
      if (np.props.Name === 'Head') { const face = old.findFirstChild('face'); if (face && !np.findFirstChildOfClass('Decal')) { old.children.splice(old.children.indexOf(face), 1); face.parent = np; np.children.push(face); } }
      // re-point joints and welds at the new part
      for (const d of model.descendants()) {
        if (d.props.Part0 === old) d.props.Part0 = np;
        if (d.props.Part1 === old) d.props.Part1 = np;
      }
      for (const c of old.children.slice()) if (c.ClassName === 'Motor6D') { old.children.splice(old.children.indexOf(c), 1); c.parent = np; np.children.push(c); }
      const i = model.children.indexOf(old);
      model.children.splice(i, 1, np);
      np.parent = model;
      old.parent = null;
    }
  }

  applyScales(model, P) {
    const h = P.HeightScale ?? 1, w = P.WidthScale ?? 1, d = P.DepthScale ?? 1, hs = P.HeadScale ?? 1;
    if (Math.abs(h - 1) < 1e-3 && Math.abs(w - 1) < 1e-3 && Math.abs(d - 1) < 1e-3 && Math.abs(hs - 1) < 1e-3) return;
    const hum = model.findFirstChildOfClass('Humanoid');
    for (const p of model.children) {
      if (!p.isA('BasePart') || p.props.Name === 'HumanoidRootPart') continue;
      const s = p.props.Name === 'Head' ? new Vector3(hs, hs, hs) : new Vector3(w, h, d);
      p.props.Size = new Vector3(p.props.Size.X * s.X, p.props.Size.Y * s.Y, p.props.Size.Z * s.Z);
      for (const a of p.children) if (a.ClassName === 'Attachment') { const c = a.props.CFrame || CFrame.identity; a.props.CFrame = CFrame.fromPosRot(c.X * s.X, c.Y * s.Y, c.Z * s.Z, c.r); }
    }
    const root = model.findFirstChild('HumanoidRootPart');
    if (root) root.props.Size = new Vector3(root.props.Size.X * w, root.props.Size.Y * h, root.props.Size.Z * d);
    for (const a of root ? root.children : []) if (a.ClassName === 'Attachment') { const c = a.props.CFrame || CFrame.identity; a.props.CFrame = CFrame.fromPosRot(c.X * w, c.Y * h, c.Z * d, c.r); }
    buildRigFromAttachments(model);
    if (hum) hum.props.HipHeight = (hum.props.HipHeight ?? 2) * h;
  }
}

/** Humanoid.HipHeight from where the feet end up (Roblox computes this automatically for R15). */
export function autoHipHeight(model) {
  const root = model.findFirstChild('HumanoidRootPart');
  const hum = model.findFirstChildOfClass('Humanoid');
  if (!root || !hum) return;
  let minY = Infinity;
  for (const p of model.children) {
    if (!p.isA('BasePart') || p === root || !/Foot|Leg/.test(p.props.Name)) continue;
    const cf = p.props.CFrame, s = p.props.Size;
    const ext = Math.abs(cf.r[3]) * s.X / 2 + Math.abs(cf.r[4]) * s.Y / 2 + Math.abs(cf.r[5]) * s.Z / 2;
    minY = Math.min(minY, cf.Y - ext);
  }
  if (minY < Infinity) hum.props.HipHeight = Math.max(0.1, root.props.CFrame.Y - root.props.Size.Y / 2 - minY);
}

export { Color3 };
