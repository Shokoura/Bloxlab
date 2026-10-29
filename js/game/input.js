// Player input: DOM keyboard / mouse / touch / gamepad -> UserInputService, ContextActionService,
// the legacy Mouse object, character movement, tools, click detectors and the camera.
import { Instance } from '../engine/instance.js';
import { Vector3, Vector2, CFrame, Ray } from '../engine/datatypes.js';
import { E, getEnum } from '../engine/enums.js';
import { raycastWorld } from '../engine/geom.js';
import { Coroutine, mkgen, call, EMPTY, toByteStr } from '../luau/runtime.js';

const CODES = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'KeypadEnter', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', CapsLock: 'CapsLock',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl', AltLeft: 'LeftAlt', AltRight: 'RightAlt',
  MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: 'Minus', Equal: 'Equals', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Semicolon: 'Semicolon', Quote: 'Quote',
  Comma: 'Comma', Period: 'Period', Slash: 'Slash', Backslash: 'BackSlash', Backquote: 'Backquote', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', NumpadAdd: 'KeypadPlus', NumpadSubtract: 'KeypadMinus',
  NumpadMultiply: 'KeypadMultiply', NumpadDivide: 'KeypadDivide', NumpadDecimal: 'KeypadPeriod', Pause: 'Pause', PrintScreen: 'Print', ScrollLock: 'ScrollLock', NumLock: 'NumLock',
};
const DIGITS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
export function keyCodeName(e) {
  const c = e.code || '';
  if (CODES[c]) return CODES[c];
  let m = /^Key([A-Z])$/.exec(c); if (m) return m[1];
  m = /^Digit(\d)$/.exec(c); if (m) return DIGITS[+m[1]];
  m = /^Numpad(\d)$/.exec(c); if (m) return `Keypad${DIGITS[+m[1]]}`;
  m = /^F(\d{1,2})$/.exec(c); if (m) return `F${m[1]}`;
  return 'Unknown';
}
const BUTTON = ['MouseButton1', 'MouseButton3', 'MouseButton2'];
const MOVE_KEYS = { W: [0, -1], Up: [0, -1], S: [0, 1], Down: [0, 1], A: [-1, 0], Left: [-1, 0], D: [1, 0], Right: [1, 0] };
const HOTBAR = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Zero'];
export const INSET = 58; // Roblox top bar height: GUI space starts below it
const safeEnum = (t, n) => {
  const e = getEnum(t);
  return e.get(n) || e.get('Unknown') || e.get('None') || e.fromValue(0) || e.items()[0];
};

export class Input {
  constructor(rt, viewport) {
    this.rt = rt;
    this.vp = viewport;
    this.canvas = viewport.canvas;
    this.world = rt.world;
    this.keys = new Map(); // KeyCode name -> InputObject
    this.buttons = new Map(); // UserInputType name -> InputObject
    this.sunk = new Map(); // KeyCode/Type -> action that sank Begin
    this.mouse = { x: 0, y: 0 };
    this.delta = { x: 0, y: 0 };
    this.focusedTextBox = null;
    this.lastInputType = 'MouseMovement';
    this.touchEnabled = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
    this.mouseEnabled = true;
    this.keyboardEnabled = true;
    this.gamepadEnabled = false;
    this.behavior = 'Default';
    this.iconEnabled = true;
    this.touchMove = null; // set by the HUD thumbstick: { x, y } in -1..1
    this.touchJump = false;
    this.hover = null;
    this.hitFrame = -1;
    this.frame = 0;
    this.mouseInst = new Instance('PlayerMouse', this.world);
    this.mouseInst.props.Name = 'Mouse';
    const self = this;
    for (const k of ['hit', 'target', 'targetSurface', 'unitRay', 'origin']) Object.defineProperty(this.mouseInst, k, { get() { self.computeHit(); return self.hitInfo[k]; }, configurable: true });
    Object.defineProperty(this.mouseInst, 'x', { get: () => this.mouse.x });
    Object.defineProperty(this.mouseInst, 'y', { get: () => this.mouse.y - INSET });
    Object.defineProperty(this.mouseInst, 'viewW', { get: () => this.vp.size.w });
    Object.defineProperty(this.mouseInst, 'viewH', { get: () => this.vp.size.h });
    this.world.input = this;
    const h = this.world.hooks;
    h.setMouseBehavior = (b) => { this.behavior = b; if (b === 'Default' && document.pointerLockElement === this.canvas) document.exitPointerLock(); };
    h.setMouseIcon = (on) => { this.iconEnabled = on; this.updateCursor(); };
    h.setMouseIconImage = (icon) => this.setIcon(icon);
    this.bind();
  }

  // ------------------------------------------------------------ queries used by engine services
  isKeyDown(n) { return this.keys.has(n); }
  isMouseDown(t) { return this.buttons.has(t); }
  keysPressed() { return [...this.keys.values()]; }
  buttonsPressed() { return [...this.buttons.values()]; }
  mouseLocation() { return new Vector2(this.mouse.x, this.mouse.y); }
  mouseDelta() { return new Vector2(this.delta.x, this.delta.y); }
  mouseObject() { return this.mouseInst; }
  get uis() { return this.rt.service('UserInputService'); }
  get locked() { return document.pointerLockElement === this.canvas; }
  wantsLock() { return this.behavior === 'LockCenter' || this.rt.camera.mouseLocked; }

  makeInput(type, state, keyCode = 'Unknown', pos = null, delta = null) {
    const io = new Instance('InputObject', this.world);
    io.props.Name = 'InputObject';
    io.props.UserInputType = safeEnum('UserInputType', type);
    io.props.UserInputState = safeEnum('UserInputState', state);
    io.props.KeyCode = safeEnum('KeyCode', keyCode);
    io.props.Position = pos || new Vector3(this.mouse.x, this.mouse.y - INSET, 0);
    io.props.Delta = delta || Vector3.zero;
    return io;
  }
  setState(io, state) { io.props.UserInputState = safeEnum('UserInputState', state); }

  // ------------------------------------------------------------ ContextActionService
  dispatchAction(io, state) {
    const cas = this.rt.service('ContextActionService');
    const actions = cas.actions || [];
    const kc = io.props.KeyCode.Name, ut = io.props.UserInputType.Name;
    for (const a of actions.slice()) {
      if (a.owner && a.owner.dead) continue;
      const match = a.inputs.some((inp) => inp && inp.EnumType && ((inp.EnumType.name === 'KeyCode' && inp.Name === kc && kc !== 'Unknown') || (inp.EnumType.name === 'UserInputType' && inp.Name === ut)));
      if (!match) continue;
      const r = this.runAction(a, state, io);
      if (!r || r.Name !== 'Pass') return a;
    }
    return null;
  }
  runAction(a, state, io) {
    let result;
    const runner = mkgen(function* () { const r = yield* call(a.fn, toByteStr(a.name), safeEnum('UserInputState', state), io); result = r[0]; return EMPTY; }, 'action');
    this.world.scheduler.run(new Coroutine(runner, a.owner || this.world.defaultContext), EMPTY);
    return result;
  }

  fire(ev, io, processed) { this.uis.fire(ev, io, !!processed); }

  // ------------------------------------------------------------ DOM binding
  bind() {
    const c = this.canvas;
    const L = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); (this.unbind ||= []).push(() => t.removeEventListener(ev, fn, o)); };
    L(c, 'contextmenu', (e) => e.preventDefault());
    L(c, 'pointerdown', (e) => this.onPointerDown(e));
    L(window, 'pointermove', (e) => this.onPointerMove(e));
    L(window, 'pointerup', (e) => this.onPointerUp(e));
    L(c, 'wheel', (e) => this.onWheel(e), { passive: false });
    L(document, 'keydown', (e) => this.onKey(e, true), true);
    L(document, 'keyup', (e) => this.onKey(e, false), true);
    L(window, 'blur', () => this.releaseAll());
    L(document, 'pointerlockchange', () => this.updateCursor());
    L(c, 'touchstart', (e) => this.onTouch(e, 'Begin'), { passive: false });
    L(c, 'touchmove', (e) => this.onTouch(e, 'Change'), { passive: false });
    L(c, 'touchend', (e) => this.onTouch(e, 'End'), { passive: false });
    L(c, 'touchcancel', (e) => this.onTouch(e, 'End'), { passive: false });
    L(window, 'gamepadconnected', () => { this.gamepadEnabled = true; this.uis.fire('GamepadConnected', E('UserInputType', 'Gamepad1')); });
  }
  dispose() {
    for (const f of this.unbind || []) f();
    this.releaseAll();
    if (this.world.input === this) this.world.input = null;
    this.canvas.style.cursor = '';
  }

  relPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  ownsEvent(e) {
    const t = e.target;
    return t === this.canvas || t === document.body || t === document.documentElement || (t && t.closest && !!t.closest('.game-ui'));
  }

  onPointerDown(e) {
    if (e.pointerType === 'touch') return;
    this.canvas.focus();
    if (this.wantsLock() && !this.locked) this.canvas.requestPointerLock?.()?.catch?.(() => {});
    const p = this.relPos(e);
    this.mouse = this.locked ? { x: this.vp.size.w / 2, y: this.vp.size.h / 2 } : p;
    const type = BUTTON[e.button] || 'MouseButton1';
    this.lastInputType = type;
    const io = this.makeInput(type, 'Begin');
    this.buttons.set(type, io);
    const sunk = this.dispatchAction(io, 'Begin');
    if (sunk) this.sunk.set(type, sunk);
    this.fire('InputBegan', io, false);
    const m = this.mouseInst;
    if (type === 'MouseButton1') {
      m.fire('Button1Down');
      this.downTarget = this.hitInfo && this.frame === this.hitFrame ? this.hitInfo.target : this.computeHit(true).target;
      if (!sunk) this.rt.activateTool(true);
    } else if (type === 'MouseButton2') {
      m.fire('Button2Down');
      this.rotating = { x: e.clientX, y: e.clientY, moved: 0 };
      this.downTarget2 = this.computeHit(true).target;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }
  onPointerMove(e) {
    if (e.pointerType === 'touch') return;
    const locked = this.locked;
    const dx = locked ? e.movementX || 0 : (this.rotating ? e.clientX - this.rotating.x : e.movementX || 0);
    const dy = locked ? e.movementY || 0 : (this.rotating ? e.clientY - this.rotating.y : e.movementY || 0);
    if (this.rotating) { this.rotating.x = e.clientX; this.rotating.y = e.clientY; this.rotating.moved += Math.abs(dx) + Math.abs(dy); }
    if (!locked && e.target !== this.canvas && !this.rotating && !this.ownsEvent(e)) return;
    this.mouse = locked ? { x: this.vp.size.w / 2, y: this.vp.size.h / 2 } : this.relPos(e);
    this.delta = { x: dx, y: dy };
    const cam = this.rt.camera;
    const camType = cam.cam && cam.cam.props.CameraType ? cam.cam.props.CameraType.Name : 'Custom';
    if ((this.rotating || locked) && camType !== 'Scriptable' && camType !== 'Fixed') cam.rotate(dx, dy);
    this.lastInputType = 'MouseMovement';
    const io = this.makeInput('MouseMovement', 'Change', 'Unknown', null, new Vector3(dx, dy, 0));
    this.fire('InputChanged', io, false);
    this.mouseInst.fire('Move');
  }
  onPointerUp(e) {
    if (e.pointerType === 'touch') return;
    const type = BUTTON[e.button] || 'MouseButton1';
    const io = this.buttons.get(type);
    if (!io) return;
    this.buttons.delete(type);
    this.setState(io, 'End');
    const sunk = this.sunk.get(type);
    if (sunk) { this.sunk.delete(type); this.runAction(sunk, 'End', io); }
    this.fire('InputEnded', io, false);
    const m = this.mouseInst;
    if (type === 'MouseButton1') {
      m.fire('Button1Up');
      if (!sunk) this.rt.activateTool(false);
      const t = this.computeHit(true).target;
      if (t && t === this.downTarget) { const cd = this.clickDetectorOf(t); if (cd) this.rt.clickDetector(cd, 'c'); }
    } else if (type === 'MouseButton2') {
      m.fire('Button2Up');
      const r = this.rotating;
      this.rotating = null;
      if (r && r.moved < 6) { const t = this.computeHit(true).target; if (t && t === this.downTarget2) { const cd = this.clickDetectorOf(t); if (cd) this.rt.clickDetector(cd, 'r'); } }
    }
  }
  onWheel(e) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const io = this.makeInput('MouseWheel', 'Change', 'Unknown', new Vector3(this.mouse.x, this.mouse.y - INSET, dir));
    const sunk = this.dispatchAction(io, 'Change');
    this.fire('InputChanged', io, false);
    this.mouseInst.fire(dir > 0 ? 'WheelForward' : 'WheelBackward');
    if (!sunk) this.rt.camera.zoomBy(-dir);
  }

  onKey(e, down) {
    if (!this.rt.attached) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const inGameBox = !!(e.target && e.target.closest && e.target.closest('.game-ui')) && (tag === 'input' || tag === 'textarea');
    if (!inGameBox && !this.ownsEvent(e)) return;
    // Studio shortcuts that must keep working while playing
    if (down && e.key === 'F5' && e.shiftKey) { e.preventDefault(); this.rt.app.stopPlay?.(); return; }
    if (e.key === 'F5' || e.key === 'F8' || e.key === 'F12' || (e.key === 'F11')) return;
    const kc = keyCodeName(e);
    if (!inGameBox && (kc === 'Space' || kc === 'Tab' || kc === 'Backspace' || kc === 'Slash' || /^(Up|Down|Left|Right)$/.test(kc))) e.preventDefault();
    if (down) {
      if (e.repeat) return;
      if (this.keys.has(kc)) return;
      this.lastInputType = 'Keyboard';
      if (!inGameBox && this.wantsLock() && !this.locked) this.canvas.requestPointerLock?.()?.catch?.(() => {});
      const io = this.makeInput('Keyboard', 'Begin', kc);
      this.keys.set(kc, io);
      const processed = inGameBox || !!this.focusedTextBox;
      let sunk = null;
      if (!processed) { sunk = this.dispatchAction(io, 'Begin'); if (sunk) this.sunk.set(kc, sunk); }
      this.fire('InputBegan', io, processed);
      if (processed) return;
      const ch = e.key && e.key.length === 1 ? e.key.toLowerCase() : kc.toLowerCase();
      this.mouseInst.fire('KeyDown', toByteStr(ch));
      if (sunk) return;
      this.defaultKey(kc, e);
    } else {
      const io = this.keys.get(kc);
      if (!io) return;
      this.keys.delete(kc);
      this.setState(io, 'End');
      const sunk = this.sunk.get(kc);
      if (sunk) { this.sunk.delete(kc); this.runAction(sunk, 'End', io); }
      this.fire('InputEnded', io, inGameBox || !!this.focusedTextBox);
      const ch = e.key && e.key.length === 1 ? e.key.toLowerCase() : kc.toLowerCase();
      this.mouseInst.fire('KeyUp', toByteStr(ch));
    }
  }

  /** Core-script keyboard behaviour (hotbar, drop, chat, shift lock, zoom, menu). */
  defaultKey(kc, e) {
    const rt = this.rt;
    const hud = rt.hud;
    const sg = rt.service('StarterGui');
    const backpackOn = !rt.world.coreGui || rt.world.coreGui.Backpack !== false;
    if (kc === 'Space') { const h = rt.humanoid; if (h) h.jumpRequest = true; this.uis.fire('JumpRequest'); }
    else if (HOTBAR.includes(kc) && backpackOn) { const tools = hud ? hud.hotbarTools() : []; const t = tools[HOTBAR.indexOf(kc)]; if (t) rt.equip(t); }
    else if (kc === 'Backspace' && backpackOn) rt.dropTool();
    else if ((kc === 'Slash') && hud) { e.preventDefault(); hud.focusChat(); }
    else if ((kc === 'LeftShift' || kc === 'RightShift')) rt.camera.toggleShiftLock();
    else if (kc === 'I') rt.camera.zoomBy(-1);
    else if (kc === 'O') rt.camera.zoomBy(1);
    else if (kc === 'Escape' && hud) hud.toggleMenu();
    else if (kc === 'Tab' && hud) hud.togglePlayerList();
    else if (kc === 'E' || kc === 'F' || kc === 'Q' || kc === 'R') hud?.promptKey(kc, true);
    void sg;
  }

  releaseAll() {
    for (const [kc, io] of [...this.keys]) { this.keys.delete(kc); this.setState(io, 'End'); this.fire('InputEnded', io, false); }
    for (const [t, io] of [...this.buttons]) { this.buttons.delete(t); this.setState(io, 'End'); this.fire('InputEnded', io, false); }
    this.sunk.clear();
    this.rotating = null;
  }

  // ------------------------------------------------------------ touch
  onTouch(e, state) {
    e.preventDefault();
    this.lastInputType = 'Touch';
    this.touchEnabled = true;
    for (const t of e.changedTouches) {
      const p = this.relPos(t);
      const io = this.makeInput('Touch', state, 'Unknown', new Vector3(p.x, p.y, 0));
      if (state === 'Begin') {
        (this.touches ||= new Map()).set(t.identifier, { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t: performance.now(), io });
        this.fire('InputBegan', io, false); this.uis.fire('TouchStarted', io, false);
      } else if (state === 'Change') {
        const s = this.touches && this.touches.get(t.identifier);
        if (!s) continue;
        const dx = t.clientX - s.x, dy = t.clientY - s.y;
        s.x = t.clientX; s.y = t.clientY;
        if (this.touches.size === 1) this.rt.camera.rotate(dx * 1.2, dy * 1.2);
        else if (this.touches.size === 2) {
          const [a, b] = [...this.touches.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (this.pinch) this.rt.camera.zoomBy((this.pinch - d) / 40);
          this.pinch = d;
        }
        s.io.props.Position = new Vector3(p.x, p.y, 0); s.io.props.Delta = new Vector3(dx, dy, 0);
        this.fire('InputChanged', s.io, false); this.uis.fire('TouchMoved', s.io, false);
      } else {
        const s = this.touches && this.touches.get(t.identifier);
        if (!s) continue;
        this.touches.delete(t.identifier);
        this.pinch = null;
        this.setState(s.io, 'End');
        this.fire('InputEnded', s.io, false); this.uis.fire('TouchEnded', s.io, false);
        if (performance.now() - s.t < 250 && Math.hypot(t.clientX - s.sx, t.clientY - s.sy) < 12) {
          this.mouse = p;
          this.uis.fire('TouchTap', [new Vector2(p.x, p.y)], false);
          const target = this.computeHit(true).target;
          const cd = target && this.clickDetectorOf(target);
          if (cd) this.rt.clickDetector(cd, 'c');
          else { this.rt.activateTool(true); this.rt.activateTool(false); }
        }
      }
    }
  }

  // ------------------------------------------------------------ mouse ray / hover
  computeHit(force) {
    if (!force && this.hitFrame === this.frame && this.hitInfo) return this.hitInfo;
    this.hitFrame = this.frame;
    const cam = this.rt.service('Workspace').props.CurrentCamera;
    const vp = this.vp;
    const x = this.locked ? vp.size.w / 2 : this.mouse.x, y = this.locked ? vp.size.h / 2 : this.mouse.y;
    const dir3 = vp.rayDir(x + vp.canvas.getBoundingClientRect().left, y + vp.canvas.getBoundingClientRect().top);
    const origin = cam && cam.props.CFrame ? cam.props.CFrame.Position : Vector3.zero;
    const dir = new Vector3(dir3.x, dir3.y, dir3.z);
    const ch = this.rt.character;
    const tf = this.mouseInst.targetFilter;
    const hit = raycastWorld(this.rt.service('Workspace'), origin, dir.mul(1000), (p) => !(ch && p.isDescendantOf(ch)) && !(tf && (p === tf || p.isDescendantOf(tf))) && p.props.CanQuery !== false && (p.props.Transparency ?? 0) < 1);
    const pos = hit ? hit.position : origin.add(dir.mul(1000));
    let surface = E('NormalId', 'Top');
    if (hit && hit.part) {
      const n = hit.part.props.CFrame.vectorToObject(hit.normal);
      const ax = Math.abs(n.X), ay = Math.abs(n.Y), az = Math.abs(n.Z);
      surface = E('NormalId', ax > ay && ax > az ? (n.X > 0 ? 'Right' : 'Left') : ay > az ? (n.Y > 0 ? 'Top' : 'Bottom') : (n.Z > 0 ? 'Back' : 'Front'));
    }
    const rot = cam && cam.props.CFrame ? cam.props.CFrame : CFrame.identity;
    this.hitInfo = {
      hit: CFrame.fromPosRot(pos.X, pos.Y, pos.Z, rot.r),
      target: hit ? hit.part : null,
      targetSurface: surface,
      unitRay: new Ray(origin, dir),
      origin: rot,
    };
    return this.hitInfo;
  }
  clickDetectorOf(part) {
    const ch = this.rt.character;
    const root = ch && (ch.findFirstChild('HumanoidRootPart') || ch.findFirstChild('Head'));
    for (let p = part; p && p.ClassName !== 'Workspace'; p = p.parent) {
      const cd = p.findFirstChildOfClass && p.findFirstChildOfClass('ClickDetector');
      if (cd) {
        const dist = root ? root.props.CFrame.Position.sub(part.props.CFrame.Position).Magnitude : 0;
        return dist <= (cd.props.MaxActivationDistance ?? 32) ? cd : null;
      }
    }
    return null;
  }
  updateCursor() {
    const c = this.canvas;
    if (!this.iconEnabled || this.locked) c.style.cursor = 'none';
    else if (this.iconUrl) c.style.cursor = `url(${this.iconUrl}) 32 32, auto`;
    else if (this.hover && this.hover.props.CursorIcon) c.style.cursor = 'pointer';
    else c.style.cursor = this.hover ? 'pointer' : 'default';
  }
  setIcon(icon) {
    if (!icon) { this.iconUrl = null; this.updateCursor(); return; }
    this.rt.app.assets.imageUrl(icon).then((u) => { this.iconUrl = u; this.updateCursor(); }).catch(() => {});
  }

  // ------------------------------------------------------------ per-frame
  update(dt) {
    this.frame++;
    const rt = this.rt;
    if (this.wantsLock() === false && this.locked) document.exitPointerLock();
    this.pollGamepad(dt);
    // movement
    const hum = rt.humanoid;
    if (hum && hum.controller && hum.state !== 'Dead') {
      let x = 0, z = 0;
      const typing = !!this.focusedTextBox || (document.activeElement && document.activeElement.closest && document.activeElement.closest('.game-ui') && /input|textarea/i.test(document.activeElement.tagName));
      if (!typing) for (const [k, [dx, dz]] of Object.entries(MOVE_KEYS)) if (this.keys.has(k) && !this.sunk.has(k)) { x += dx; z += dz; }
      if (this.touchMove) { x += this.touchMove.x; z += this.touchMove.y; }
      if (this.pad) { x += this.pad.x; z += this.pad.y; }
      const mag = Math.hypot(x, z);
      if (mag > 1) { x /= mag; z /= mag; }
      if (mag > 0.05) {
        const d = CFrame.angles(0, rt.camera.yaw, 0).vectorToWorld(new Vector3(x, 0, z));
        hum.moveDir = new Vector3(d.X, 0, d.Z);
        hum.moveInput = true;
        hum.walkTo = null;
        this.wasMoving = true;
      } else if (this.wasMoving) { hum.moveDir = Vector3.zero; this.wasMoving = false; }
      if ((this.keys.has('Space') && !this.sunk.has('Space') && !typing) || this.touchJump || (this.pad && this.pad.jump)) hum.jumpRequest = true;
    }
    // click detector hover
    const target = this.computeHit().target;
    const cd = target ? this.clickDetectorOf(target) : null;
    if (cd !== this.hover) {
      if (this.hover && this.hover.dm) rt.clickDetector(this.hover, 'hl');
      if (cd) rt.clickDetector(cd, 'he');
      this.hover = cd;
      this.updateCursor();
    }
    this.delta = { x: 0, y: 0 };
  }
  pollGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const g = pads && [...pads].find((p) => p && p.connected);
    if (!g) { this.pad = null; return; }
    this.gamepadEnabled = true;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    const jump = !!(g.buttons[0] && g.buttons[0].pressed);
    this.pad = { x: dz(g.axes[0] || 0), y: dz(g.axes[1] || 0), jump };
    const rx = dz(g.axes[2] || 0), ry = dz(g.axes[3] || 0);
    if (rx || ry) this.rt.camera.rotate(rx * 600 * dt, ry * 400 * dt);
    const rtrig = !!(g.buttons[7] && g.buttons[7].pressed);
    if (rtrig !== this.padTrigger) { this.padTrigger = rtrig; this.rt.activateTool(rtrig); }
  }
}
