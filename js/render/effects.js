// Visual effects for a client world: ParticleEmitter, Fire, Smoke, Sparkles, Explosion, Trail, Beam.
// Particles are camera-facing quads drawn with one instanced mesh per emitter.
import * as THREE from 'three';
import { Vector3, Color3, NumberSequence, ColorSequence } from '../engine/datatypes.js';

const MAX = 600;
const VERT = `
attribute vec3 iPos; attribute vec4 iColor; attribute vec2 iSizeRot;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vUv = uv; vColor = iColor;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iSizeRot.y), s = sin(iSizeRot.y);
  vec2 p = position.xy * iSizeRot.x;
  mv.xy += vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D map; uniform float hasMap; uniform float emission;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0, 1.0, 1.0, smoothstep(0.5, 0.15, length(vUv - 0.5)));
  vec4 c = t * vColor;
  if (c.a < 0.01) discard;
  gl_FragColor = vec4(c.rgb * (1.0 + emission), c.a);
}`;

function seqAt(seq, t, def) {
  if (seq instanceof NumberSequence) return seq.at(t);
  if (typeof seq === 'number') return seq;
  return def;
}
function colorAt(seq, t) {
  if (seq instanceof ColorSequence) return seq.at(t);
  if (seq instanceof Color3) return seq;
  return new Color3(1, 1, 1);
}
const rnd = (a, b) => a + Math.random() * (b - a);
const range = (r, d0, d1) => (r && r.Min !== undefined ? rnd(r.Min, r.Max) : rnd(d0, d1));

class EmitterView {
  constructor(fx, inst) {
    this.fx = fx;
    this.inst = inst;
    this.parts = [];
    this.acc = 0;
    const geo = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.aSR = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2);
    for (const a of [this.aPos, this.aColor, this.aSR]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iColor', this.aColor); geo.setAttribute('iSizeRot', this.aSR);
    geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, uniforms: { map: { value: null }, hasMap: { value: 0 }, emission: { value: 0 } } });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    fx.group.add(this.mesh);
    this.texKey = null;
  }
  dispose() { this.fx.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }

  /** Emission source: { cf, size } of the parent part / attachment. */
  source() {
    const p = this.inst.parent;
    if (!p || !p.dm) return null;
    if (p.isA('BasePart')) return { cf: p.props.CFrame, size: p.props.Size };
    if (p.ClassName === 'Attachment') return { cf: p.get('WorldCFrame'), size: new Vector3(0, 0, 0) };
    return null;
  }
  config() {
    const P = this.inst.props, cn = this.inst.ClassName;
    if (cn === 'ParticleEmitter') return P;
    // legacy effects mapped onto emitter settings
    if (cn === 'Fire') {
      const s = P.Size ?? 5, h = P.Heat ?? 9;
      return { Rate: 65, Lifetime: { Min: 0.7, Max: 1.2 }, Speed: { Min: h * 0.5, Max: h * 0.9 }, SpreadAngle: { X: 15, Y: 15 }, Size: new NumberSequence(s * 0.7, s * 0.15), Transparency: new NumberSequence(0.2, 1),
        Color: new ColorSequence(P.Color || new Color3(0.93, 0.5, 0.2), P.SecondaryColor || new Color3(0.54, 0.2, 0.05)), LightEmission: 0.9, EmissionDirection: { Name: 'Top' }, Enabled: P.Enabled !== false, Acceleration: new Vector3(0, 2, 0), Drag: 1 };
    }
    if (cn === 'Smoke') {
      const s = P.Size ?? 1;
      return { Rate: 20, Lifetime: { Min: 3, Max: 5 }, Speed: { Min: (P.RiseVelocity ?? 1), Max: (P.RiseVelocity ?? 1) * 1.6 }, SpreadAngle: { X: 25, Y: 25 }, Size: new NumberSequence(s * 1.5, s * 4), Transparency: new NumberSequence(Math.max(P.Opacity !== undefined ? 1 - P.Opacity : 0.5, 0), 1),
        Color: new ColorSequence(P.Color || new Color3(1, 1, 1)), LightEmission: 0, EmissionDirection: { Name: 'Top' }, Enabled: P.Enabled !== false, Drag: 0.3 };
    }
    if (cn === 'Sparkles') {
      return { Rate: 40, Lifetime: { Min: 0.6, Max: 1.2 }, Speed: { Min: 4, Max: 8 }, SpreadAngle: { X: 180, Y: 180 }, Size: new NumberSequence(0.3, 0), Transparency: new NumberSequence(0, 0.6),
        Color: new ColorSequence(P.SparkleColor || new Color3(0.56, 0.36, 1)), LightEmission: 1, EmissionDirection: { Name: 'Top' }, Enabled: P.Enabled !== false };
    }
    return null;
  }
  spawn(src, cfg) {
    if (this.parts.length >= MAX) return;
    const s = src.size;
    const local = new Vector3(rnd(-0.5, 0.5) * s.X, rnd(-0.5, 0.5) * s.Y, rnd(-0.5, 0.5) * s.Z);
    const shape = cfg.Shape ? cfg.Shape.Name : 'Box';
    const pos = src.cf.pointToWorld(shape === 'Box' ? local : Vector3.zero);
    const dirName = cfg.EmissionDirection ? cfg.EmissionDirection.Name : 'Top';
    const dirs = { Top: [0, 1, 0], Bottom: [0, -1, 0], Left: [-1, 0, 0], Right: [1, 0, 0], Front: [0, 0, -1], Back: [0, 0, 1] };
    let d = new Vector3(...(dirs[dirName] || dirs.Top));
    const sa = cfg.SpreadAngle || { X: 0, Y: 0 };
    const ax = (rnd(-1, 1) * (sa.X || 0) * Math.PI) / 180, ay = (rnd(-1, 1) * (sa.Y || 0) * Math.PI) / 180;
    d = new Vector3(d.X + Math.sin(ax), d.Y, d.Z + Math.sin(ay)).Unit;
    d = src.cf.vectorToWorld(d);
    const speed = range(cfg.Speed, 5, 5);
    this.parts.push({
      p: pos, v: d.mul(speed), age: 0, life: Math.max(0.05, range(cfg.Lifetime, 1, 2)),
      rot: (range(cfg.Rotation, 0, 0) * Math.PI) / 180, rs: (range(cfg.RotSpeed, 0, 0) * Math.PI) / 180, seed: Math.random(),
    });
  }
  update(dt, emitBurst = 0) {
    const cfg = this.config();
    const src = this.source();
    if (!cfg) return;
    if (src && cfg.Enabled !== false) {
      const rate = Math.min(500, cfg.Rate ?? 20) * (this.fx.rt.service('Workspace').props.TimeScale ?? 1);
      this.acc += rate * dt;
      while (this.acc >= 1) { this.acc -= 1; this.spawn(src, cfg); }
    }
    if (src) for (let i = 0; i < emitBurst; i++) this.spawn(src, cfg);
    const tex = cfg.Texture || '';
    if (tex !== this.texKey) {
      this.texKey = tex;
      this.mat.uniforms.hasMap.value = 0;
      if (tex && this.fx.rt.app.assets) this.fx.rt.app.assets.texture(tex).then((t) => { if (this.texKey === tex && t) { this.mat.uniforms.map.value = t; this.mat.uniforms.hasMap.value = 1; } }).catch(() => {});
    }
    const le = cfg.LightEmission ?? 0;
    this.mat.blending = le > 0.5 ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mat.uniforms.emission.value = le * 0.5;
    const acc = cfg.Acceleration || Vector3.zero;
    const drag = cfg.Drag ?? 0;
    const lockedTo = cfg.LockedToPart && src ? src.cf : null;
    let n = 0;
    this.parts = this.parts.filter((q) => (q.age += dt) < q.life);
    for (const q of this.parts) {
      q.v = q.v.add(acc.mul(dt));
      if (drag) q.v = q.v.mul(Math.max(0, 1 - drag * dt));
      q.p = q.p.add(q.v.mul(dt));
      q.rot += q.rs * dt;
      const t = q.age / q.life;
      const size = Math.max(0, seqAt(cfg.Size, t, 1));
      const tr = Math.max(0, Math.min(1, seqAt(cfg.Transparency, t, 0)));
      const col = colorAt(cfg.Color, t);
      const p = lockedTo ? q.p : q.p;
      this.aPos.array.set([p.X, p.Y, p.Z], n * 3);
      this.aColor.array.set([col.R, col.G, col.B, 1 - tr], n * 4);
      this.aSR.array.set([size, q.rot], n * 2);
      n++;
    }
    this.mesh.geometry.instanceCount = n;
    this.aPos.needsUpdate = this.aColor.needsUpdate = this.aSR.needsUpdate = true;
  }
}

class Blast {
  constructor(fx, pos, radius) {
    this.fx = fx;
    this.age = 0;
    this.life = 0.9;
    this.radius = Math.max(1, radius);
    const g = new THREE.SphereGeometry(1, 24, 16);
    this.core = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.shell = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.6, depthWrite: false }));
    this.light = new THREE.PointLight(0xffa040, 6, this.radius * 6, 1.5);
    for (const o of [this.core, this.shell, this.light]) { o.position.set(pos.X, pos.Y, pos.Z); fx.group.add(o); }
  }
  update(dt) {
    this.age += dt;
    const t = this.age / this.life;
    const s = this.radius * (0.4 + t * 1.4);
    this.core.scale.setScalar(s * 0.6);
    this.shell.scale.setScalar(s);
    this.core.material.opacity = Math.max(0, 0.9 * (1 - t * 1.6));
    this.shell.material.opacity = Math.max(0, 0.6 * (1 - t));
    this.light.intensity = Math.max(0, 6 * (1 - t * 2));
    return t < 1;
  }
  dispose() { for (const o of [this.core, this.shell, this.light]) this.fx.group.remove(o); this.core.geometry.dispose(); this.core.material.dispose(); this.shell.material.dispose(); }
}

class TrailView {
  constructor(fx, inst) {
    this.fx = fx; this.inst = inst; this.points = [];
    this.geo = new THREE.BufferGeometry();
    this.mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    fx.group.add(this.mesh);
  }
  dispose() { this.fx.group.remove(this.mesh); this.geo.dispose(); this.mat.dispose(); }
  update(dt) {
    const P = this.inst.props;
    const a0 = P.Attachment0, a1 = P.Attachment1;
    const life = Math.max(0.05, P.Lifetime ?? 2);
    if (P.Enabled !== false && a0 && a1 && a0.dm && a1.dm) {
      const p0 = a0.get('WorldPosition'), p1 = a1.get('WorldPosition');
      const last = this.points[this.points.length - 1];
      if (!last || last.a.sub(p0).Magnitude > (P.MinLength ?? 0.1)) this.points.push({ a: p0, b: p1, age: 0 });
      else { last.a = p0; last.b = p1; }
    }
    for (const p of this.points) p.age += dt;
    this.points = this.points.filter((p) => p.age < life);
    const n = this.points.length;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 4), idx = [];
    this.points.forEach((p, i) => {
      const t = p.age / life;
      const c = colorAt(P.Color, t), tr = Math.max(0, Math.min(1, seqAt(P.Transparency, t, 0.5)));
      pos.set([p.a.X, p.a.Y, p.a.Z, p.b.X, p.b.Y, p.b.Z], i * 6);
      col.set([c.R, c.G, c.B, 1 - tr, c.R, c.G, c.B, 1 - tr], i * 8);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    });
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, idx.length);
  }
}

class BeamView {
  constructor(fx, inst) {
    this.fx = fx; this.inst = inst;
    this.geo = new THREE.BufferGeometry();
    this.mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    fx.group.add(this.mesh);
  }
  dispose() { this.fx.group.remove(this.mesh); this.geo.dispose(); this.mat.dispose(); }
  update() {
    const P = this.inst.props;
    const a0 = P.Attachment0, a1 = P.Attachment1;
    if (P.Enabled === false || !a0 || !a1 || !a0.dm || !a1.dm) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const p0 = a0.get('WorldPosition'), p1 = a1.get('WorldPosition');
    const camPos = this.fx.view.cameraPosition || new Vector3(0, 0, 0);
    const dir = p1.sub(p0);
    const side = dir.cross(camPos.sub(p0)).Unit;
    const segs = Math.max(1, Math.min(20, P.Segments ?? 10));
    const w0 = (P.Width0 ?? 1) / 2, w1 = (P.Width1 ?? 1) / 2;
    const pos = [], col = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const c = p0.add(dir.mul(t));
      const w = w0 + (w1 - w0) * t;
      const a = c.add(side.mul(w)), b = c.sub(side.mul(w));
      pos.push(a.X, a.Y, a.Z, b.X, b.Y, b.Z);
      const cc = colorAt(P.Color, t), tr = Math.max(0, Math.min(1, seqAt(P.Transparency, t, 0.5)));
      col.push(cc.R, cc.G, cc.B, 1 - tr, cc.R, cc.G, cc.B, 1 - tr);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    this.geo.setIndex(idx);
  }
}

const KINDS = { ParticleEmitter: EmitterView, Fire: EmitterView, Smoke: EmitterView, Sparkles: EmitterView, Trail: TrailView, Beam: BeamView };

export class Effects {
  constructor(rt, view) {
    this.rt = rt;
    this.view = view;
    this.group = new THREE.Group();
    view.scene.add(this.group);
    this.items = new Map();
    this.blasts = [];
    this.bursts = new Map();
    const h = rt.world.hooks;
    h.explode = (ex) => { const p = ex.props.Position || Vector3.zero; if (ex.props.Visible !== false) this.blasts.push(new Blast(this, p, ex.props.BlastRadius ?? 4)); };
    h.emitParticles = (em, n) => { this.bursts.set(em, (this.bursts.get(em) || 0) + Math.min(MAX, n)); this.ensure(em); };
    h.clearParticles = (em) => { const v = this.items.get(em); if (v && v.parts) v.parts = []; };
    this.unobserve = rt.world.observe({
      added: (i) => i.forTree((d) => { if (KINDS[d.ClassName]) this.ensure(d); }),
      removed: (i) => i.forTree((d) => { const v = this.items.get(d); if (v) { v.dispose(); this.items.delete(d); } }),
    });
    rt.world.dm.forTree((d) => { if (KINDS[d.ClassName]) this.ensure(d); });
  }
  ensure(inst) {
    if (this.items.has(inst) || !inst.dm) return;
    const K = KINDS[inst.ClassName];
    if (K) this.items.set(inst, new K(this, inst));
  }
  dispose() {
    this.unobserve();
    for (const v of this.items.values()) v.dispose();
    for (const b of this.blasts) b.dispose();
    this.view.scene.remove(this.group);
  }
  update(dt) {
    const cam = this.rt.viewport && this.rt.viewport.camera;
    if (cam) this.view.cameraPosition = new Vector3(cam.position.x, cam.position.y, cam.position.z);
    for (const [inst, v] of this.items) {
      if (!inst.dm) { v.dispose(); this.items.delete(inst); continue; }
      const burst = this.bursts.get(inst) || 0;
      v.update(dt, burst);
    }
    this.bursts.clear();
    this.blasts = this.blasts.filter((b) => { const alive = b.update(dt); if (!alive) b.dispose(); return alive; });
  }
}
