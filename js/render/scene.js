// Mirrors a World's Workspace into a three.js scene and keeps it in sync.
import * as THREE from 'three';
import { boxGeometry, wedgeGeometry, cornerWedgeGeometry, sphereGeometry, cylinderGeometry, headGeometry, trussGeometry } from './geometry.js';
import { partMaterial, srgb } from './materials.js';
import { LightingView } from './lighting.js';
import { isClothedLimb, composite, faceMaterials, meshTexture } from './clothing.js';
import { buildTerrainObject } from './terrain.js';
import { Color3, Vector3 } from '../engine/datatypes.js';

const tmpM = new THREE.Matrix4();
export function cframeToMatrix(cf, m = new THREE.Matrix4()) {
  const r = cf.r;
  return m.set(r[0], r[1], r[2], cf.X, r[3], r[4], r[5], cf.Y, r[6], r[7], r[8], cf.Z, 0, 0, 0, 1);
}

const PART_PROPS = new Set(['Size', 'Shape', 'shape', 'Material', 'Color', 'Transparency', 'Reflectance', 'TopSurface', 'BottomSurface', 'LeftSurface', 'RightSurface', 'FrontSurface', 'BackSurface', 'LocalTransparencyModifier', 'MeshId', 'TextureID', 'CastShadow']);
const MESH_PROPS = new Set(['MeshType', 'MeshId', 'TextureId', 'Scale', 'Offset', 'VertexColor']);
const DECAL_PROPS = new Set(['Texture', 'Face', 'Transparency', 'Color3', 'StudsPerTileU', 'StudsPerTileV', 'OffsetStudsU', 'OffsetStudsV', 'LocalTransparencyModifier', 'ZIndex']);
const LIGHT_PROPS = new Set(['Brightness', 'Color', 'Range', 'Enabled', 'Shadows', 'Angle', 'Face']);
const CLOTHING = new Set(['Shirt', 'Pants', 'ShirtGraphic', 'BodyColors']);
const VISUAL_CLASSES = new Set(['SpecialMesh', 'BlockMesh', 'CylinderMesh', 'Decal', 'Texture', 'PointLight', 'SpotLight', 'SurfaceLight', 'SelectionBox', 'Highlight']);

// NormalId -> rotation that makes a +Z facing plane face that direction
const FACE_DIR = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1)];

export class SceneView {
  /**
   * @param {World} world
   * @param {{ assets?: object, edit?: boolean }} opts
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.assets = opts.assets || null;
    this.edit = !!opts.edit;
    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.objects = new Map(); // part -> { obj, mesh, attachments }
    this.lightingView = new LightingView(this.scene, world, this.assets);
    this.pending = new Set();
    this.dirtyLighting = true;
    this.listeners = [];
    this.stop = world.observe({
      added: (inst) => this.onAdded(inst),
      removed: (inst, oldParent) => this.onRemoved(inst, oldParent),
      moved: (inst, oldParent) => { this.onRemoved(inst, oldParent); this.onAdded(inst); },
      propChanged: (inst, name) => this.onProp(inst, name),
    });
    if (world.dm) this.onAdded(world.dm);
  }

  dispose() {
    this.stop();
    for (const e of this.objects.values()) this.disposeEntry(e);
    this.objects.clear();
    this.lightingView.dispose();
  }

  inWorkspace(inst) {
    for (let p = inst; p; p = p.parent) if (p.ClassName === 'Workspace') return true;
    return false;
  }

  /** Clothing changed on a character: its limbs are rebuilt. */
  clothingChanged(model) {
    if (!model) return;
    for (const c of model.children) if (this.objects.has(c)) this.pending.add(c);
  }
  onAdded(inst) {
    if (CLOTHING.has(inst.ClassName)) this.clothingChanged(inst.parent);
    inst.forTree((d) => {
      if (d.ClassName === 'Terrain' && this.inWorkspace(d)) { this.terrain = d; this.terrainDirty = true; }
      if (d.isA('BasePart') && d.ClassName !== 'Terrain' && this.inWorkspace(d)) this.pending.add(d);
      else if (VISUAL_CLASSES.has(d.ClassName) && d.parent && this.objects.has(d.parent)) this.pending.add(d.parent);
      else if (d.ClassName === 'Lighting' || (d.parent && d.parent.ClassName === 'Lighting')) this.dirtyLighting = true;
    });
  }
  onRemoved(inst, oldParent) {
    if (CLOTHING.has(inst.ClassName)) this.clothingChanged(oldParent);
    inst.forTree((d) => {
      const e = this.objects.get(d);
      if (e) { this.disposeEntry(e); this.objects.delete(d); }
      this.pending.delete(d);
    });
    // a visual child (decal/mesh/light) left a part: rebuild that part
    if (VISUAL_CLASSES.has(inst.ClassName) && oldParent && this.objects.has(oldParent)) this.pending.add(oldParent);
    if (inst.ClassName === 'Lighting' || (oldParent && oldParent.ClassName === 'Lighting')) this.dirtyLighting = true;
  }
  onProp(inst, name) {
    if (inst.ClassName === 'Terrain') { if (name === 'SmoothGrid' || name === 'Voxels' || name === 'WaterColor' || name === 'WaterTransparency' || name === 'MaterialColors') this.terrainDirty = true; return; }
    const e = this.objects.get(inst);
    if (e) {
      if (name === 'CFrame') { this.place(e, inst); return; }
      if (PART_PROPS.has(name)) this.pending.add(inst);
      return;
    }
    if (CLOTHING.has(inst.ClassName)) { this.clothingChanged(inst.parent); return; }
    if (VISUAL_CLASSES.has(inst.ClassName) && inst.parent && this.objects.has(inst.parent)) {
      if (MESH_PROPS.has(name) || DECAL_PROPS.has(name) || LIGHT_PROPS.has(name) || name === 'Adornee' || name === 'Visible' || name === 'Enabled') this.pending.add(inst.parent);
      return;
    }
    if (inst.ClassName === 'Lighting' || (inst.parent && inst.parent.ClassName === 'Lighting')) this.dirtyLighting = true;
  }

  /** Apply queued rebuilds; call once per frame before rendering. */
  flush() {
    if (this.pending.size) {
      const list = [...this.pending];
      this.pending.clear();
      for (const p of list) {
        if (!p.dm || p.destroyed || !this.inWorkspace(p)) { const e = this.objects.get(p); if (e) { this.disposeEntry(e); this.objects.delete(p); } continue; }
        this.build(p);
      }
    }
    if (this.dirtyLighting) { this.dirtyLighting = false; this.lightingView.update(); }
    if (this.terrainDirty) {
      this.terrainDirty = false;
      if (this.terrainObj) { this.root.remove(this.terrainObj); this.terrainObj.traverse((o) => { o.geometry?.dispose(); }); this.terrainObj = null; }
      const t = this.terrain;
      if (t && t.dm && this.inWorkspace(t)) { try { this.terrainObj = buildTerrainObject(t); this.root.add(this.terrainObj); } catch (e) { console.warn('[terrain]', e); } }
    }
  }

  disposeEntry(e) {
    this.root.remove(e.obj);
    e.obj.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared && o.userData.ownGeometry) o.geometry.dispose();
      if (o.material && o.userData.ownMaterial) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }

  place(e, part) {
    const cf = part.props.CFrame;
    cframeToMatrix(cf, e.obj.matrix);
    e.obj.matrixWorldNeedsUpdate = true;
  }

  build(part) {
    const old = this.objects.get(part);
    if (old) this.disposeEntry(old);
    const obj = new THREE.Group();
    obj.matrixAutoUpdate = false;
    obj.userData.inst = part;
    const e = { obj, part };
    this.objects.set(part, e);
    this.root.add(obj);
    this.place(e, part);

    const P = part.props;
    const size = P.Size || new Vector3(4, 1, 2);
    const ltm = P.LocalTransparencyModifier || 0;
    let transparency = P.Transparency || 0;
    transparency = transparency + (1 - transparency) * ltm;
    const color = P.Color || new Color3(0.64, 0.64, 0.65);
    const matName = P.Material ? P.Material.Name : 'Plastic';
    const cast = P.CastShadow !== false;

    let specialMesh = null;
    for (const c of part.children) if (c.ClassName === 'SpecialMesh' || c.ClassName === 'BlockMesh' || c.ClassName === 'CylinderMesh') { specialMesh = c; break; }

    let mesh;
    if (specialMesh) mesh = this.buildSpecialMesh(part, specialMesh, size, color, matName, transparency);
    else if (part.ClassName === 'MeshPart') mesh = this.buildMeshPart(part, size, color, matName, transparency);
    else {
      let geom;
      const cn = part.ClassName;
      const shape = (P.Shape && P.Shape.Name) || 'Block';
      const tile = matName === 'SmoothPlastic' || matName === 'Plastic' ? 2 : 8;
      if (cn === 'WedgePart' || shape === 'Wedge') geom = wedgeGeometry(size.X, size.Y, size.Z, tile);
      else if (cn === 'CornerWedgePart' || shape === 'CornerWedge') geom = cornerWedgeGeometry(size.X, size.Y, size.Z, tile);
      else if (shape === 'Ball') { const d = Math.min(size.X, size.Y, size.Z); geom = sphereGeometry(d, d, d, tile); }
      else if (shape === 'Cylinder') geom = cylinderGeometry(size.X, size.Y, size.Z, tile);
      else if (cn === 'TrussPart') geom = trussGeometry(size.X, size.Y, size.Z);
      else geom = boxGeometry(size.X, size.Y, size.Z, (shape === 'Block' && hasStuds(P)) ? 1 : tile);
      let materials;
      if (cn === 'TrussPart') materials = partMaterial(matName, color, transparency, P.Reflectance || 0, null, { truss: true });
      else if (geom.groups.length === 6 && hasStuds(P)) {
        const faces = ['RightSurface', 'TopSurface', 'BackSurface', 'LeftSurface', 'BottomSurface', 'FrontSurface'];
        materials = faces.map((f) => {
          const st = P[f] ? P[f].Name : 'Smooth';
          const overlay = (st === 'Studs' || st === 'Universal') ? 'studs' : (st === 'Inlet') ? 'inlet' : null;
          return partMaterial(matName, color, transparency, P.Reflectance || 0, overlay && matName !== 'Neon' && matName !== 'Glass' ? overlay : null);
        });
      } else materials = partMaterial(matName, color, transparency, P.Reflectance || 0);
      mesh = new THREE.Mesh(geom, materials);
    }
    if (mesh && !specialMesh && part.ClassName !== 'MeshPart' && isClothedLimb(part) && this.assets) {
      // shirt / pants templates on a blocky limb
      composite(part.parent, this.assets).then((layers) => {
        if (this.objects.get(part) !== e || !e.mesh) return;
        e.mesh.geometry = new THREE.BoxGeometry(size.X, size.Y, size.Z);
        e.mesh.material = faceMaterials(part, layers, transparency);
        e.mesh.userData.ownGeometry = true; e.mesh.userData.ownMaterial = true;
      }).catch(() => {});
    }
    if (mesh) {
      mesh.castShadow = cast && transparency < 0.6 && matName !== 'ForceField';
      mesh.receiveShadow = true;
      mesh.userData.inst = part;
      obj.add(mesh);
      e.mesh = mesh;
    }

    // decals / textures / lights
    for (const c of part.children) {
      if (c.ClassName === 'Decal' || c.ClassName === 'Texture') this.addDecal(obj, part, c, size, ltm);
      else if (c.ClassName === 'PointLight' || c.ClassName === 'SpotLight' || c.ClassName === 'SurfaceLight') this.addLight(obj, c);
    }
    if (part.ClassName === 'Seat' || part.ClassName === 'VehicleSeat' || part.ClassName === 'SpawnLocation') { /* rendered as plain parts */ }
    return e;
  }

  buildSpecialMesh(part, sm, size, color, matName, transparency) {
    const P = sm.props;
    const scale = P.Scale || new Vector3(1, 1, 1);
    const offset = P.Offset || Vector3.zero;
    let geom = null;
    let fitPart = true;
    const type = sm.ClassName === 'BlockMesh' ? 'Brick' : sm.ClassName === 'CylinderMesh' ? 'Cylinder' : (P.MeshType ? P.MeshType.Name : 'Head');
    const sx = size.X * scale.X, sy = size.Y * scale.Y, sz = size.Z * scale.Z;
    switch (type) {
      case 'Brick': case 'Torso': geom = boxGeometry(sx, sy, sz, 4); break;
      case 'Sphere': geom = sphereGeometry(sx, sy, sz); break;
      case 'Cylinder': geom = cylinderGeometry(sx, sy, sz, 4, 'y'); break;
      case 'Wedge': geom = wedgeGeometry(sx, sy, sz); break;
      case 'Head': { const d = Math.min(size.X, size.Z); geom = headGeometry(d * scale.X, sy, d * scale.Z); break; }
      case 'FileMesh': fitPart = false; break;
      default: geom = boxGeometry(sx, sy, sz); break;
    }
    void fitPart;
    const tex = type === 'FileMesh' ? P.TextureId : '';
    const material = partMaterial(type === 'FileMesh' && tex ? 'SmoothPlastic' : matName, color, transparency, part.props.Reflectance || 0);
    const holder = new THREE.Group();
    holder.position.set(offset.X, offset.Y, offset.Z);
    if (geom) {
      const m = new THREE.Mesh(geom, material);
      m.userData.inst = part;
      holder.add(m);
      holder.castShadow = true;
      return wrapShadow(holder);
    }
    // FileMesh: geometry in mesh units scaled by Scale
    const placeholder = new THREE.Mesh(boxGeometry(size.X, size.Y, size.Z), partMaterial(matName, color, Math.max(transparency, 0.5), 0));
    placeholder.userData.inst = part;
    holder.add(placeholder);
    if (this.assets && P.MeshId) {
      const token = Symbol('mesh');
      part.__meshToken = token;
      this.assets.mesh(P.MeshId).then((res) => {
        if (part.__meshToken !== token || !res) return;
        holder.remove(placeholder);
        const mat = tex ? new THREE.MeshStandardMaterial({ color: P.VertexColor ? srgb(new Color3(P.VertexColor.X, P.VertexColor.Y, P.VertexColor.Z)) : 0xffffff, roughness: 0.8, transparent: transparency > 0, opacity: 1 - transparency })
          : partMaterial('SmoothPlastic', color, transparency, 0);
        const m = new THREE.Mesh(res.geometry, mat);
        m.scale.set(scale.X, scale.Y, scale.Z);
        m.castShadow = true; m.receiveShadow = true;
        m.userData.inst = part;
        if (tex) { m.userData.ownMaterial = true; this.assets.texture(tex).then((t) => { if (t) { mat.map = t; mat.needsUpdate = true; } }); }
        holder.add(m);
      }).catch(() => {});
    }
    return wrapShadow(holder);
  }

  buildMeshPart(part, size, color, matName, transparency) {
    const P = part.props;
    const holder = new THREE.Group();
    // until (unless) the mesh arrives, a see-through box shows where it is without hiding the world
    const placeholder = new THREE.Mesh(boxGeometry(size.X, size.Y, size.Z), partMaterial(matName, color, P.MeshId ? Math.max(transparency, 0.6) : transparency, 0));
    placeholder.userData.inst = part;
    placeholder.castShadow = false;
    holder.add(placeholder);
    const id = P.MeshId;
    if (this.assets && id) {
      const token = Symbol('mesh');
      part.__meshToken = token;
      this.assets.mesh(id).then((res) => {
        if (part.__meshToken !== token || !res) return;
        holder.remove(placeholder);
        const bb = res.bbox; // {min, max} THREE.Vector3
        const ext = new THREE.Vector3().subVectors(bb.max, bb.min);
        const center = new THREE.Vector3().addVectors(bb.max, bb.min).multiplyScalar(0.5);
        const texId = P.TextureID;
        const mat = texId ? new THREE.MeshStandardMaterial({ color: srgb(color), roughness: 0.8, transparent: transparency > 0, opacity: 1 - transparency })
          : partMaterial(matName, color, transparency, P.Reflectance || 0, null, { doubleSide: P.DoubleSided });
        const m = new THREE.Mesh(res.geometry, mat);
        m.userData.inst = part;
        m.scale.set(size.X / (ext.x || 1), size.Y / (ext.y || 1), size.Z / (ext.z || 1));
        m.position.set(-center.x * m.scale.x, -center.y * m.scale.y, -center.z * m.scale.z);
        m.castShadow = transparency < 0.6; m.receiveShadow = true;
        if (texId) { m.userData.ownMaterial = true; this.assets.texture(texId).then((t) => { if (t) { mat.map = t; mat.needsUpdate = true; } }); }
        else if (isClothedLimb(part)) {
          composite(part.parent, this.assets).then((layers) => {
            if (part.__meshToken !== token) return;
            m.material = new THREE.MeshStandardMaterial({ map: meshTexture(part, layers), roughness: 0.75, transparent: transparency > 0, opacity: 1 - transparency });
            m.userData.ownMaterial = true;
          }).catch(() => {});
        }
        holder.add(m);
      }).catch(() => {});
    }
    return wrapShadow(holder);
  }

  addDecal(obj, part, d, size, ltm) {
    const P = d.props;
    const face = P.Face ? P.Face.Value : 5;
    const dir = FACE_DIR[face];
    const dims = [[size.Z, size.Y], [size.X, size.Z], [size.X, size.Y], [size.Z, size.Y], [size.X, size.Z], [size.X, size.Y]][face];
    const half = [size.X / 2, size.Y / 2, size.Z / 2];
    let geom = new THREE.PlaneGeometry(dims[0], dims[1]);
    // decals on the classic round head wrap around its front instead of floating inside it
    const sm = part.findFirstChildOfClass('SpecialMesh');
    const head = sm && sm.props.MeshType && sm.props.MeshType.Name === 'Head' && face !== 1 && face !== 4;
    if (head) {
      const sc = sm.props.Scale || new Vector3(1, 1, 1);
      const r = (Math.min(size.X, size.Z) * sc.X) / 2 + 0.012;
      const hgt = size.Y * sc.Y * 0.82;
      const yaw = { 0: Math.PI / 2, 2: 0, 3: -Math.PI / 2, 5: Math.PI }[face];
      geom = new THREE.CylinderGeometry(r, r, hgt, 24, 1, true, yaw - Math.PI * 0.42, Math.PI * 0.84);
    }
    let tr = P.Transparency || 0;
    tr = tr + (1 - tr) * ltm;
    // nothing is drawn until the image is available (places can have thousands of decals)
    if (tr >= 0.999 || !P.Texture || !this.assets) { geom.dispose(); return; }
    this.assets.texture(P.Texture).then((t) => {
      if (!t || !obj.parent || this.objects.get(part)?.obj !== obj) { geom.dispose(); return; }
      let tex = t;
      if (d.ClassName === 'Texture') {
        tex = t.clone();
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(dims[0] / (P.StudsPerTileU || 2), dims[1] / (P.StudsPerTileV || 2));
        tex.offset.set((P.OffsetStudsU || 0) / (P.StudsPerTileU || 2), (P.OffsetStudsV || 0) / (P.StudsPerTileV || 2));
        tex.needsUpdate = true;
      }
      const mat = new THREE.MeshStandardMaterial({ map: tex, color: srgb(P.Color3 || new Color3(1, 1, 1)), transparent: true, opacity: 1 - tr, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.9 });
      const m = new THREE.Mesh(geom, mat);
      m.userData.ownGeometry = true; m.userData.ownMaterial = true;
      m.userData.inst = part;
      m.receiveShadow = true;
      if (!head) {
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        m.quaternion.copy(q);
        if (face === 4) m.rotateZ(Math.PI);
        m.position.set(dir.x * (half[0] + 0.01), dir.y * (half[1] + 0.01), dir.z * (half[2] + 0.01));
      } else { const off = sm.props.Offset; if (off) m.position.set(off.X, off.Y, off.Z); }
      obj.add(m);
    }).catch(() => geom.dispose());
  }

  addLight(obj, l) {
    const P = l.props;
    if (P.Enabled === false) return;
    const color = srgb(P.Color || new Color3(1, 1, 1));
    const bright = P.Brightness ?? 1;
    const range = P.Range ?? 8;
    let light;
    if (l.ClassName === 'PointLight') light = new THREE.PointLight(color, bright * 4, range, 1.5);
    else {
      light = new THREE.SpotLight(color, bright * 6, range, THREE.MathUtils.degToRad(Math.min(89, (P.Angle ?? 90) / 2)), 0.4, 1.5);
      const face = P.Face ? P.Face.Value : 5;
      const t = new THREE.Object3D();
      t.position.copy(FACE_DIR[face]).multiplyScalar(10);
      obj.add(t);
      light.target = t;
    }
    light.castShadow = false;
    obj.add(light);
  }

  /** Objects for ray picking. */
  pickables() { return [...this.objects.values()].map((e) => e.obj); }
}

function hasStuds(P) {
  for (const f of ['TopSurface', 'BottomSurface', 'LeftSurface', 'RightSurface', 'FrontSurface', 'BackSurface']) {
    const s = P[f] && P[f].Name;
    if (s === 'Studs' || s === 'Inlet' || s === 'Universal') return true;
  }
  return false;
}
function wrapShadow(holder) {
  holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return holder;
}
export { tmpM };
