// Lighting service -> sun, ambient, fog and sky.
import * as THREE from 'three';
import { srgb } from './materials.js';
import { Color3 } from '../engine/datatypes.js';

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = `
uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunSize; uniform float haze;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, bottom, pow(clamp(-h, 0.0, 1.0), 0.4));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  c += sunColor * (pow(s, 900.0 / sunSize) * 2.5 + pow(s, 12.0) * 0.18 * haze);
  // soft procedural clouds
  if (h > 0.02) {
    vec2 uv = d.xz / (h + 0.25) * 1.6;
    float n = sin(uv.x * 1.7 + sin(uv.y * 1.3)) * 0.5 + sin(uv.y * 2.3 + uv.x * 0.7) * 0.35 + sin((uv.x + uv.y) * 3.1) * 0.15;
    float cloud = smoothstep(0.35, 0.9, n) * smoothstep(0.02, 0.25, h) * 0.55;
    c = mix(c, vec3(1.0) * (0.85 + 0.15 * s), cloud);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export class LightingView {
  constructor(scene, world, assets) {
    this.scene = scene;
    this.world = world;
    this.assets = assets;
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera;
    sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 800;
    this.sunTarget = new THREE.Object3D();
    this.sun.target = this.sunTarget;
    scene.add(this.sun, this.sunTarget);
    this.hemi = new THREE.HemisphereLight(0xbcd3ff, 0x6d6450, 0.9);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(this.ambient);
    this.skyUniforms = {
      top: { value: new THREE.Color(0x3d8be0) }, horizon: { value: new THREE.Color(0xbfe0ff) }, bottom: { value: new THREE.Color(0x8a9bb0) },
      sunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) }, sunColor: { value: new THREE.Color(0xfff2d0) }, sunSize: { value: 21 }, haze: { value: 1 },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false }));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);
    scene.fog = new THREE.Fog(0xbfe0ff, 500, 10000);
    this.skyboxKey = '';
    this.cubeTex = null;
    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.2);
    this.exposure = 1;
    this.effects = { brightness: 0, contrast: 0, saturation: 0, tint: null, blur: 0 };
  }
  dispose() {
    this.scene.remove(this.sun, this.sunTarget, this.hemi, this.ambient, this.sky);
    this.sky.geometry.dispose(); this.sky.material.dispose();
  }

  /** Keep the shadow camera around the view focus. */
  follow(pos) {
    this.sunTarget.position.copy(pos);
    this.sun.position.copy(pos).addScaledVector(this.sunDir, 400);
    this.sky.position.copy(pos);
    this.sunTarget.updateMatrixWorld();
  }

  update() {
    const dm = this.world.dm;
    const L = dm && dm.findFirstChildOfClass('Lighting');
    if (!L) return;
    const P = L.props;
    const clock = clockOf(P);
    const lat = THREE.MathUtils.degToRad(P.GeographicLatitude ?? 41.7);
    const h = ((clock - 12) / 24) * Math.PI * 2;
    // sun orbit: rises in +X... sets in -X, tilted south by latitude
    const v = new THREE.Vector3(-Math.sin(h), Math.cos(h), 0);
    v.applyAxisAngle(new THREE.Vector3(1, 0, 0), lat * 0.6);
    this.sunDir.copy(v).normalize();
    const elev = this.sunDir.y;
    const day = THREE.MathUtils.smoothstep(elev, -0.15, 0.25);
    const dusk = 1 - Math.min(1, Math.abs(elev - 0.05) / 0.3);
    const brightness = P.Brightness ?? 2;
    const amb = P.Ambient || new Color3(0.27, 0.27, 0.27);
    const outdoor = P.OutdoorAmbient || new Color3(0.5, 0.5, 0.5);
    const shiftTop = P.ColorShift_Top || new Color3(0, 0, 0);
    // sun
    const sunCol = new THREE.Color(1, 0.96, 0.88).lerp(new THREE.Color(1, 0.6, 0.35), dusk * 0.8);
    sunCol.add(srgb(shiftTop).multiplyScalar(0.5));
    this.sun.color.copy(sunCol);
    this.sun.intensity = Math.max(0, brightness) * 0.85 * day;
    this.sun.castShadow = P.GlobalShadows !== false && day > 0.05;
    // ambient
    const moon = (1 - day) * 0.15;
    this.hemi.color.copy(srgb(outdoor)).multiplyScalar(1.1).lerp(new THREE.Color(0.55, 0.65, 0.9), 0.35);
    this.hemi.groundColor.copy(srgb(outdoor)).multiplyScalar(0.6);
    this.hemi.intensity = 0.6 + day * 0.9 + moon;
    this.ambient.color.copy(srgb(amb));
    this.ambient.intensity = 0.6;
    this.exposure = Math.pow(2, P.ExposureCompensation || 0);
    // sky colors
    const dayTop = new THREE.Color(0x3d8be0), dayHor = new THREE.Color(0xc4e2ff);
    const duskTop = new THREE.Color(0x3a4f8f), duskHor = new THREE.Color(0xff9a5c);
    const nightTop = new THREE.Color(0x05070f), nightHor = new THREE.Color(0x141c33);
    const top = nightTop.clone().lerp(dayTop, day).lerp(duskTop, dusk * 0.5);
    const hor = nightHor.clone().lerp(dayHor, day).lerp(duskHor, dusk * 0.7);
    const atm = L.findFirstChildOfClass('Atmosphere');
    if (atm) {
      const ac = srgb(atm.props.Color || new Color3(0.78, 0.67, 0.67));
      const haze = atm.props.Haze ?? 0;
      hor.lerp(ac, Math.min(0.5, haze * 0.15));
      this.skyUniforms.haze.value = 1 + haze;
    }
    this.skyUniforms.top.value.copy(top);
    this.skyUniforms.horizon.value.copy(hor);
    this.skyUniforms.bottom.value.copy(hor.clone().multiplyScalar(0.75));
    this.skyUniforms.sunDir.value.copy(this.sunDir);
    this.skyUniforms.sunColor.value.copy(sunCol).multiplyScalar(day);
    const skyInst = L.findFirstChildOfClass('Sky');
    this.skyUniforms.sunSize.value = skyInst ? (skyInst.props.SunAngularSize ?? 21) : 21;
    this.sky.visible = !this.cubeTex;
    // fog
    const fogEnd = P.FogEnd ?? 100000;
    const fogStart = P.FogStart ?? 0;
    if (atm && (atm.props.Density ?? 0.3) > 0) {
      const dens = atm.props.Density ?? 0.3;
      this.scene.fog = new THREE.FogExp2(hor.getHex(), 0.00004 + dens * dens * 0.004 * (1 - (atm.props.Offset ?? 0) * 0.5));
    } else if (fogEnd < 99999) {
      this.scene.fog = new THREE.Fog(srgb(P.FogColor || new Color3(0.75, 0.75, 0.75)).getHex(), fogStart, fogEnd);
    } else this.scene.fog = new THREE.Fog(hor.getHex(), 2000, 12000);
    // post effects (applied as CSS filters by the viewport)
    const fx = { brightness: 0, contrast: 0, saturation: 0, tint: null, blur: 0, bloom: 0 };
    for (const c of L.children) {
      if (c.props.Enabled === false) continue;
      if (c.ClassName === 'ColorCorrectionEffect') { fx.brightness += c.props.Brightness || 0; fx.contrast += c.props.Contrast || 0; fx.saturation += c.props.Saturation || 0; fx.tint = c.props.TintColor || null; }
      if (c.ClassName === 'BlurEffect') fx.blur += c.props.Size ?? 24;
      if (c.ClassName === 'BloomEffect') fx.bloom = c.props.Intensity ?? 1;
    }
    const cam = this.world.dm && this.world.dm.findFirstChildOfClass('Workspace')?.props.CurrentCamera;
    if (cam) for (const c of cam.children) {
      if (c.props.Enabled === false) continue;
      if (c.ClassName === 'ColorCorrectionEffect') { fx.brightness += c.props.Brightness || 0; fx.contrast += c.props.Contrast || 0; fx.saturation += c.props.Saturation || 0; fx.tint = c.props.TintColor || fx.tint; }
      if (c.ClassName === 'BlurEffect') fx.blur += c.props.Size ?? 24;
    }
    this.effects = fx;
    // skybox textures
    if (skyInst && this.assets) {
      const ids = ['SkyboxRt', 'SkyboxLf', 'SkyboxUp', 'SkyboxDn', 'SkyboxBk', 'SkyboxFt'].map((k) => skyInst.props[k] || '');
      const key = ids.join('|');
      if (key !== this.skyboxKey) {
        this.skyboxKey = key;
        const usable = ids.every((id) => /rbxassetid|asset\/?\?id=|^https?:|^\d+$/.test(id));
        if (usable) {
          Promise.all(ids.map((id) => this.assets.image(id))).then((imgs) => {
            if (this.skyboxKey !== key || imgs.some((i) => !i)) return;
            const tex = new THREE.CubeTexture(imgs);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            this.cubeTex = tex;
            this.scene.background = tex;
            this.sky.visible = false;
          }).catch(() => {});
        } else { this.cubeTex = null; this.scene.background = null; this.sky.visible = true; }
      }
    } else if (this.cubeTex) { this.cubeTex = null; this.scene.background = null; this.sky.visible = true; this.skyboxKey = ''; }
  }

  cssFilter() {
    const f = this.effects;
    const parts = [];
    if (f.brightness) parts.push(`brightness(${(1 + f.brightness).toFixed(3)})`);
    if (f.contrast) parts.push(`contrast(${(1 + f.contrast).toFixed(3)})`);
    if (f.saturation) parts.push(`saturate(${Math.max(0, 1 + f.saturation).toFixed(3)})`);
    if (f.blur) parts.push(`blur(${(f.blur / 6).toFixed(1)}px)`);
    return parts.join(' ');
  }
}

export function clockOf(P) {
  if (typeof P.ClockTime === 'number') return P.ClockTime;
  const t = P.TimeOfDay;
  if (typeof t === 'string') { const [h, m, s] = t.split(':').map(Number); return (h || 0) + (m || 0) / 60 + (s || 0) / 3600; }
  return 14;
}
