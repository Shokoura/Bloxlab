// DataModel creation and conversion between file trees (RawInstance) and engine Instances.
import { Instance } from './instance.js';
import { classInfo, isService, classExists, F } from './reflect.js';
import { RawInstance, utf8 } from '../formats/raw.js';
import { readBinary, writeBinary, isBinary } from '../formats/binary.js';
import { readXml, writeXml } from '../formats/xml.js';
import { decodeAttributes, encodeAttributes, decodeTags, encodeTags } from '../formats/attributes.js';
import { Vector3, CFrame, Color3, BrickColor, UDim2, Font } from './datatypes.js';
import { enumFromValue, EnumItem, E } from './enums.js';

// Services every place starts with (Studio creates these).
export const DEFAULT_SERVICES = ['Workspace', 'Players', 'Lighting', 'MaterialService', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Teams', 'SoundService', 'Chat', 'TextChatService', 'LocalizationService', 'TestService'];

// ------------------------------------------------------------------ DataModel
export function createDataModel(world) {
  const dm = new Instance('DataModel', world);
  dm.props.Name = 'Game';
  dm.dm = dm;
  dm.world = world;
  world.dm = dm;
  dm.isService = true;
  dm.serviceFactory = (name) => {
    let s = dm.findFirstChildOfClass(name);
    if (s) return s;
    if (!classExists(name) || !isService(name)) return null;
    s = new Instance(name, world);
    s.isService = true;
    s.props.Name = name;
    s.setParent(dm);
    return s;
  };
  return dm;
}

/** Adds the standard children services need (Terrain, Camera, StarterPlayerScripts ...). */
export function ensureServiceChildren(dm) {
  const ws = dm.serviceFactory('Workspace');
  if (!ws.findFirstChildOfClass('Terrain')) { const t = new Instance('Terrain', dm.world); t.props.Name = 'Terrain'; t.setParent(ws); }
  if (!ws.findFirstChildOfClass('Camera')) {
    const c = new Instance('Camera', dm.world);
    c.props.Name = 'Camera';
    c.props.CFrame = CFrame.lookAt(new Vector3(0, 20, 30), new Vector3(0, 0, 0));
    c.setParent(ws);
    ws.props.CurrentCamera = c;
  } else if (!ws.props.CurrentCamera) ws.props.CurrentCamera = ws.findFirstChildOfClass('Camera');
  const sp = dm.serviceFactory('StarterPlayer');
  for (const cn of ['StarterPlayerScripts', 'StarterCharacterScripts']) {
    if (!sp.findFirstChildOfClass(cn)) { const i = new Instance(cn, dm.world); i.props.Name = cn; i.setParent(sp); }
  }
}

export function newEmptyPlace(world) {
  const dm = createDataModel(world);
  for (const s of DEFAULT_SERVICES) dm.serviceFactory(s);
  ensureServiceChildren(dm);
  // Studio's place templates use JumpHeight rather than the legacy JumpPower
  const sp = dm.findFirstChildOfClass('StarterPlayer');
  sp.props.CharacterUseJumpPower = false;
  return dm;
}

/** The "Baseplate" template. */
export function newBaseplate(world) {
  const dm = newEmptyPlace(world);
  const ws = dm.findFirstChildOfClass('Workspace');
  const bp = new Instance('Part', world);
  Object.assign(bp.props, {
    Name: 'Baseplate', Anchored: true, Locked: true, Size: new Vector3(2048, 16, 2048), CFrame: new CFrame(0, -8, 0),
    Color: Color3.fromRGB(91, 91, 91), Material: E('Material', 'Plastic'), TopSurface: E('SurfaceType', 'Smooth'), BottomSurface: E('SurfaceType', 'Smooth'),
  });
  const tex = new Instance('Texture', world);
  Object.assign(tex.props, { Name: 'Texture', Texture: 'rbxassetid://6372755229', Face: E('NormalId', 'Top'), StudsPerTileU: 8, StudsPerTileV: 8, Color3: new Color3(0, 0, 0), Transparency: 0.8 });
  tex.setParent(bp);
  bp.setParent(ws);
  const spawn = new Instance('SpawnLocation', world);
  Object.assign(spawn.props, {
    Name: 'SpawnLocation', Anchored: true, Size: new Vector3(12, 1, 12), CFrame: new CFrame(0, 0.5, 0), Color: Color3.fromRGB(163, 162, 165),
    TopSurface: E('SurfaceType', 'Smooth'), BottomSurface: E('SurfaceType', 'Smooth'),
  });
  spawn.setParent(ws);
  const light = dm.findFirstChildOfClass('Lighting');
  Object.assign(light.props, { Ambient: Color3.fromRGB(70, 70, 70), Brightness: 3, OutdoorAmbient: Color3.fromRGB(70, 70, 70), ClockTime: 14.5, GeographicLatitude: 0 });
  const sky = new Instance('Sky', world); sky.props.Name = 'Sky'; sky.setParent(light);
  const atm = new Instance('Atmosphere', world); atm.props.Name = 'Atmosphere'; atm.setParent(light);
  return dm;
}

// ------------------------------------------------------------------ file -> instances
const migrationCache = new Map();
/** For a class: Content prop name -> ContentId prop name (e.g. TextureContent -> Texture) */
function contentMigrations(className) {
  let m = migrationCache.get(className);
  if (m) return m;
  m = new Map();
  const info = classInfo(className);
  for (const k in info.props) {
    const p = info.props[k];
    if (p.flags & F.MIGRATE && p.extra && p.type === 'ContentId') m.set(p.extra, k);
  }
  migrationCache.set(className, m);
  return m;
}

function rawValueToEngine(propType, t, v) {
  if (propType && propType.startsWith('Enum:')) return typeof v === 'number' ? enumFromValue(propType.slice(5), v) : v;
  switch (t) {
    case 'Color3uint8': return v;
    case 'BrickColor': return propType === 'Color3' || propType === 'Color3uint8' ? BrickColor.fromNumber(v).Color : BrickColor.fromNumber(v);
    case 'BinaryString': return v;
    case 'String': case 'ProtectedString': case 'ContentId': case 'Content':
      return typeof v === 'string' ? v : utf8.dec.decode(v);
    case 'Int32': case 'Int64':
      if (propType === 'BrickColor') return BrickColor.fromNumber(v);
      return v;
    case 'Enum': return v;
    default: return v;
  }
}

/**
 * Converts raw roots into Instances (not yet parented).
 * @returns {{ roots: Instance[], refs: Map<RawInstance, Instance> }}
 */
export function rawToInstances(rawRoots, world) {
  const map = new Map();
  const pendingRefs = [];
  const build = (ri) => {
    const cn = ri.className;
    const inst = new Instance(cn, world);
    map.set(ri, inst);
    if (ri.isService) inst.isService = true;
    const info = classInfo(cn);
    const migr = contentMigrations(cn);
    for (const [name, { t, v }] of ri.props) {
      if (name === 'AttributesSerialize') { if (v && v.length) { try { inst.attrs = decodeAttributes(v); } catch { /* ignore broken attributes */ } } continue; }
      if (name === 'Tags') { const tags = decodeTags(typeof v === 'string' ? utf8.enc.encode(v) : v); if (tags.length) inst.tags = new Set(tags); continue; }
      let canon = info.serialToCanon.get(name) || name;
      if (migr.has(canon)) { if (v) inst.props[migr.get(canon)] = typeof v === 'string' ? v : ''; continue; }
      const p = info.props[canon];
      if (!p) {
        if (name === 'BrickColor' && info.props.Color) { if (ri.props.has('Color3uint8')) continue; inst.props.Color = BrickColor.fromNumber(v).Color; continue; }
        if (name === 'archivable') { inst.archivable = !!v; continue; }
        (inst.extra ||= new Map()).set(name, { t, v });
        continue;
      }
      if (p.flags & F.ALIAS && p.extra) canon = p.extra;
      if (canon === 'Archivable') { inst.archivable = !!v; continue; }
      if (t === 'Ref') { pendingRefs.push([inst, canon, v]); continue; }
      if (p.type === 'UniqueId' || p.type === 'SecurityCapabilities' || p.type === 'SharedString' || p.type === 'NetAssetRef' || (p.type === 'BinaryString' && canon !== 'Source')) {
        (inst.extra ||= new Map()).set(name, { t, v });
        continue;
      }
      inst.props[canon] = rawValueToEngine(p.type, t, v);
    }
    if (!ri.props.has('Name')) inst.props.Name = cn;
    for (const c of ri.children) {
      const ci = build(c);
      ci.parent = inst;
      inst.children.push(ci);
    }
    return inst;
  };
  const roots = rawRoots.map(build);
  for (const [inst, prop, target] of pendingRefs) inst.props[prop] = target ? map.get(target) || null : null;
  return { roots, refs: map };
}

/** Loads a place file into a fresh DataModel for `world`. */
export function loadPlace(bytes, world) {
  const doc = parseFile(bytes);
  const dm = createDataModel(world);
  const { roots } = rawToInstances(doc.roots, world);
  for (const r of roots) {
    if (isService(r.ClassName) || r.isService) {
      r.isService = true;
      const existing = dm.findFirstChildOfClass(r.ClassName);
      if (existing) { for (const c of r.children.slice()) c.setParent(existing); Object.assign(existing.props, r.props); }
      else r.setParent(dm);
    } else {
      // loose instances at the root of a place go into Workspace
      r.setParent(dm.serviceFactory('Workspace'));
    }
  }
  for (const s of DEFAULT_SERVICES) dm.serviceFactory(s);
  ensureServiceChildren(dm);
  return { dm, warnings: doc.warnings };
}

/** Loads a model file; returns unparented instances. */
export function loadModel(bytes, world) {
  const doc = parseFile(bytes);
  return { instances: rawToInstances(doc.roots, world).roots, warnings: doc.warnings };
}

export function parseFile(bytes) {
  if (typeof bytes === 'string') return readXml(bytes);
  if (isBinary(bytes)) return readBinary(bytes);
  const head = utf8.dec.decode(bytes.subarray(0, 64)).trimStart();
  if (head.startsWith('<roblox')) return readXml(bytes);
  throw new Error('Unrecognised file: expected a Roblox .rbxl/.rbxm/.rbxlx/.rbxmx file');
}

// ------------------------------------------------------------------ instances -> file
function engineToRaw(type, v) {
  if (type.startsWith('Enum:')) return { t: 'Enum', v: v instanceof EnumItem ? v.Value : (typeof v === 'number' ? v : 0) };
  switch (type) {
    case 'Color3uint8': return { t: 'Color3uint8', v: v || new Color3() };
    case 'BrickColor': return { t: 'BrickColor', v: v instanceof BrickColor ? v.Number : (v ?? 194) };
    case 'Ref': return { t: 'Ref', v };
    case 'Content': return { t: 'Content', v: v || '' };
    case 'ContentId': return { t: 'ContentId', v: v || '' };
    case 'String': return { t: 'String', v: v ?? '' };
    case 'Font': return { t: 'Font', v: v || new Font() };
    case 'UDim2': return { t: 'UDim2', v: v || new UDim2() };
    case 'Attributes': case 'Tags': case 'UniqueId': case 'SecurityCapabilities': case 'SharedString': case 'NetAssetRef': case 'BinaryString': case 'MaterialColors': return null;
    default: return v === undefined ? null : { t: type, v };
  }
}

export function instancesToRaw(roots, { includeNonArchivable = false } = {}) {
  const map = new Map();
  const refFix = [];
  const build = (inst) => {
    if (!includeNonArchivable && !inst.archivable) return null;
    const ri = new RawInstance(inst.ClassName);
    ri.isService = !!inst.isService;
    map.set(inst, ri);
    const info = classInfo(inst.ClassName);
    const migr = contentMigrations(inst.ClassName);
    for (const k in info.props) {
      const p = info.props[k];
      if (!(p.flags & F.SERIALIZES)) continue;
      const fileName = p.extra || k;
      if (k === 'Archivable') { ri.set(fileName, 'Bool', inst.archivable); continue; }
      if (k === 'Attributes') { if (inst.attrs && inst.attrs.size) ri.set('AttributesSerialize', 'BinaryString', encodeAttributes(inst.attrs)); continue; }
      if (k === 'Tags') { if (inst.tags && inst.tags.size) ri.set('Tags', 'BinaryString', encodeTags(inst.tags)); continue; }
      let v;
      if (migr.has(k)) v = inst.props[migr.get(k)] || '';
      else v = inst.props[k];
      const r = engineToRaw(p.type, v);
      if (!r) continue;
      if (k === 'Source') r.t = 'ProtectedString';
      if (r.t === 'Ref') refFix.push([ri, fileName, v]);
      else ri.set(fileName, r.t, r.v);
    }
    if (inst.extra) for (const [k, e] of inst.extra) if (!ri.props.has(k)) ri.props.set(k, e);
    for (const c of inst.children) {
      const rc = build(c);
      if (rc) ri.add(rc);
    }
    return ri;
  };
  const rawRoots = roots.map(build).filter(Boolean);
  for (const [ri, name, target] of refFix) ri.set(name, 'Ref', target ? map.get(target) || null : null);
  return rawRoots;
}

/** format: 'rbxl' | 'rbxlx' | 'rbxm' | 'rbxmx' */
export function serialize(roots, format) {
  const raw = instancesToRaw(roots);
  const model = format === 'rbxm' || format === 'rbxmx';
  if (format === 'rbxlx' || format === 'rbxmx') return utf8.enc.encode(writeXml(raw, { model }));
  return writeBinary(raw, { model });
}
export function serializePlace(dm, format = 'rbxl') {
  const roots = dm.children.filter((c) => c.archivable && !c.transient);
  return serialize(roots, format);
}
