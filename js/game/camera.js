// Roblox-style player camera: classic follow camera with zoom, first person, shift lock,
// camera collision, and the other CameraTypes (Scriptable, Fixed, Attach, Watch, Track, Follow, Orbital).
import { Vector3, CFrame } from '../engine/datatypes.js';
import { raycastWorld } from '../engine/geom.js';

const SENS = 0.0045;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class CameraController {
  constructor(rt) {
    this.rt = rt;
    this.yaw = 0;
    this.pitch = -0.3;
    this.zoom = 12.5;
    this.targetZoom = 12.5;
    this.shiftLock = false;
    this.shiftLockEnabled = false; // player setting ("Shift Lock Switch")
    this.firstPerson = false;
    this.focus = new Vector3(0, 5, 0);
    this.hidden = new Set();
    this.lastSubject = null;
  }
  get cam() { return this.rt.service('Workspace').props.CurrentCamera; }
  sp() { return this.rt.service('StarterPlayer'); }
  zoomLimits() {
    const lp = this.rt.localPlayer, sp = this.sp();
    const min = lp && lp.props.CameraMinZoomDistance !== undefined ? lp.props.CameraMinZoomDistance : sp.props.CameraMinZoomDistance ?? 0.5;
    const max = lp && lp.props.CameraMaxZoomDistance !== undefined ? lp.props.CameraMaxZoomDistance : sp.props.CameraMaxZoomDistance ?? 128;
    return [Math.max(0.5, min), Math.max(Math.max(0.5, min), max)];
  }
  cameraMode() {
    const lp = this.rt.localPlayer, sp = this.sp();
    const m = (lp && lp.props.CameraMode) || sp.props.CameraMode;
    return m ? m.Name : 'Classic';
  }

  onCharacter(model) {
    const root = model.findFirstChild('HumanoidRootPart') || model.props.PrimaryPart;
    if (root) { const look = root.props.CFrame.LookVector; this.yaw = Math.atan2(-look.X, -look.Z); }
    this.pitch = -0.3;
    const [min, max] = this.zoomLimits();
    this.targetZoom = this.zoom = clamp(12.5, min, max);
  }

  /** Mouse / touch / gamepad rotation in pixels (or equivalent). */
  rotate(dx, dy) {
    const sens = SENS * (this.rt.service('UserInputService').props.MouseDeltaSensitivity ?? 1);
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, -1.39, 1.39);
  }
  zoomBy(steps) {
    const [min, max] = this.zoomLimits();
    let z = this.targetZoom * 1.15 ** steps;
    if (steps < 0 && this.targetZoom <= 1.6) z = min;
    if (steps > 0 && this.targetZoom <= min + 0.01) z = Math.max(min, 1.6);
    this.targetZoom = clamp(z, min, max);
  }
  toggleShiftLock() { if (this.shiftLockEnabled && this.sp().props.EnableMouseLockOption !== false) this.shiftLock = !this.shiftLock; }
  get mouseLocked() { return this.firstPerson || this.shiftLock; }

  subjectFocus(subject) {
    if (!subject || !subject.dm) return null;
    if (subject.ClassName === 'Humanoid') {
      const model = subject.parent;
      const root = model && (model.findFirstChild('HumanoidRootPart') || model.props.PrimaryPart || model.findFirstChild('Torso'));
      if (!root) return null;
      const off = subject.props.CameraOffset || Vector3.zero;
      const head = model.findFirstChild('Head');
      const base = subject.state === 'Dead' && head ? head.props.CFrame.Position : root.props.CFrame.Position.add(new Vector3(0, 1.5, 0));
      return base.add(CFrame.angles(0, this.yaw, 0).vectorToWorld(off));
    }
    if (subject.isA('BasePart')) return subject.props.CFrame.Position;
    if (subject.isA('Model')) {
      const pp = subject.props.PrimaryPart;
      if (pp) return pp.props.CFrame.Position;
      const parts = subject.descendants().filter((d) => d.isA('BasePart'));
      if (!parts.length) return null;
      let s = Vector3.zero; for (const p of parts) s = s.add(p.props.CFrame.Position);
      return s.div(parts.length);
    }
    return null;
  }

  update(dt) {
    const cam = this.cam;
    if (!cam) return;
    const type = cam.props.CameraType ? cam.props.CameraType.Name : 'Custom';
    const subject = cam.props.CameraSubject || this.rt.humanoid;
    const [min, max] = this.zoomLimits();
    if (this.cameraMode() === 'LockFirstPerson') this.targetZoom = min;
    this.targetZoom = clamp(this.targetZoom, min, max);
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 14);
    if (Math.abs(this.zoom - this.targetZoom) < 0.01) this.zoom = this.targetZoom;
    const hum = this.rt.humanoid;
    if (type === 'Scriptable' || type === 'Fixed') { this.setFirstPerson(false); this.faceCamera(null); return; }
    const focus = this.subjectFocus(subject) || this.focus;
    this.focus = focus;
    if (type === 'Attach' && subject) {
      const root = subject.ClassName === 'Humanoid' ? subject.parent?.findFirstChild('HumanoidRootPart') : subject.isA?.('BasePart') ? subject : null;
      if (root) { const look = root.props.CFrame.LookVector; this.yaw = Math.atan2(-look.X, -look.Z); }
    }
    if (type === 'Watch') {
      const pos = cam.props.CFrame ? cam.props.CFrame.Position : focus.add(new Vector3(0, 10, 20));
      cam.rawSet('CFrame', CFrame.lookAt(pos, focus));
      cam.rawSet('Focus', new CFrame(focus.X, focus.Y, focus.Z));
      return;
    }
    const fp = this.zoom <= min + 0.05 && min <= 0.6;
    this.setFirstPerson(fp);
    const rot = CFrame.fromEulerYXZ(this.pitch, this.yaw, 0);
    const look = rot.LookVector;
    let pos;
    if (fp) pos = focus;
    else {
      let off = look.mul(-this.zoom);
      if (this.shiftLock) off = off.add(rot.RightVector.mul(1.75));
      pos = focus.add(off);
      // keep the camera out of walls
      const dir = pos.sub(focus);
      const ch = this.rt.character;
      const hit = dir.Magnitude > 0.5 ? raycastWorld(this.rt.service('Workspace'), focus, dir, (p) => p.props.CanCollide !== false && (p.props.Transparency ?? 0) < 0.95 && !(ch && p.isDescendantOf(ch)) && !(subject && subject.isA && subject.isA('BasePart') && p === subject)) : null;
      if (hit) pos = focus.add(dir.Unit.mul(Math.max(0.5, hit.distance - 0.6)));
    }
    cam.rawSet('CFrame', CFrame.fromPosRot(pos.X, pos.Y, pos.Z, rot.r));
    cam.rawSet('Focus', new CFrame(focus.X, focus.Y, focus.Z));
    this.faceCamera(hum && (fp || this.shiftLock) ? this.yaw : null);
  }

  faceCamera(yaw) {
    const hum = this.rt.humanoid;
    if (hum && hum.controller) hum.controller.faceYaw = yaw;
  }

  setFirstPerson(on) {
    if (on === this.firstPerson && !on) return;
    this.firstPerson = on;
    const ch = this.rt.character;
    if (on && ch) {
      for (const d of ch.descendants()) {
        if (!d.isA('BasePart') && d.ClassName !== 'Decal') continue;
        if (d.findFirstAncestorWhichIsA('Tool')) continue;
        if ((d.props.LocalTransparencyModifier ?? 0) !== 1) { d.rawSet('LocalTransparencyModifier', 1); this.hidden.add(d); }
      }
    } else if (!on) {
      for (const d of this.hidden) if (d.dm) d.rawSet('LocalTransparencyModifier', 0);
      this.hidden.clear();
    }
  }

  /** Pushes the Camera instance to the renderer. */
  apply() {
    const cam = this.cam;
    const vp = this.rt.viewport;
    if (!cam || !vp) return;
    const cf = cam.props.CFrame;
    if (cf) vp.setCameraCFrame(cf, cam.props.FieldOfView ?? 70);
    if (this.focus) vp.setFocus(this.focus.X, this.focus.Y, this.focus.Z);
  }
}
