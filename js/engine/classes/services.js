// Engine services exposed to scripts.
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, S, L, arr, toLua, fromLuaArray, luaTypeof, luaToPlain, plainToLua, awaitPromise, toEnum } from '../bridge.js';
import { Signal } from '../signal.js';
import { LuaTable, LuaError, EMPTY, R, call, runSync, mkgen, toByteStr, fromByteStr, tostr, Coroutine } from '../../luau/runtime.js';
import { Vector3, Vector2, CFrame, Color3, UDim, UDim2, TweenInfo, PathWaypoint, lerpValue, Rect } from '../datatypes.js';
import { E, getEnum, EnumItem } from '../enums.js';
import { idb } from '../../util/idb.js';
import { raycastWorld } from '../geom.js';

const str = (v, n, f) => { if (typeof v === 'string') return fromByteStr(v); if (typeof v === 'number') return String(v); throw lerr(`invalid argument #${n} to '${f}' (string expected, got ${luaTypeof(v)})`); };
const worldOf = (self) => self.world || (R.current && R.current.owner && R.current.owner.world);

// ------------------------------------------------------------------ RunService
defineBehavior('RunService', {
  methods: methods({
    IsServer: (self) => [worldOf(self)?.kind === 'server' || worldOf(self)?.kind === 'edit'],
    IsClient: (self) => [worldOf(self)?.kind === 'client' || worldOf(self)?.kind === 'edit'],
    IsStudio: () => [true],
    IsRunning: (self) => [!!worldOf(self)?.running],
    IsRunMode: (self) => [!!worldOf(self)?.runMode],
    IsEdit: (self) => [worldOf(self)?.kind === 'edit'],
    BindToRenderStep: (self, name, priority, fn) => {
      const list = (self.renderSteps ||= []);
      const owner = R.current ? R.current.owner : null;
      const n = str(name, 1, 'BindToRenderStep');
      const i = list.findIndex((x) => x.name === n); if (i >= 0) list.splice(i, 1);
      list.push({ name: n, priority: Number(priority) || 0, fn, owner });
      list.sort((a, b) => a.priority - b.priority);
    },
    UnbindFromRenderStep: (self, name) => { const n = str(name, 1, 'UnbindFromRenderStep'); self.renderSteps = (self.renderSteps || []).filter((x) => x.name !== n); },
    Run: () => {}, Pause: () => {}, Stop: (self) => { worldOf(self)?.app?.stopPlay?.(); },
    IsUnderBenchmark: () => [false],
    GetCoreScriptVersion: () => ['1.0'],
    GetRobloxVersion: () => ['0.650'],
    setThrottleFramerateEnabled: () => {},
  }),
  events: ['Heartbeat', 'Stepped', 'RenderStepped', 'PreRender', 'PreSimulation', 'PostSimulation', 'PreAnimation'],
});

// ------------------------------------------------------------------ UserInputService
defineBehavior('UserInputService', {
  props: {
    MouseBehavior: { get: (s) => s.props.MouseBehavior || E('MouseBehavior', 'Default'), set: (s, v) => { s.rawSet('MouseBehavior', v); s.world?.hooks.setMouseBehavior?.(v.Name); }, type: 'Enum:MouseBehavior' },
    MouseIconEnabled: { get: (s) => s.props.MouseIconEnabled !== false, set: (s, v) => { s.rawSet('MouseIconEnabled', !!v); s.world?.hooks.setMouseIcon?.(!!v); }, type: 'Bool' },
    MouseEnabled: { get: (s) => s.world?.input?.mouseEnabled ?? true, readonly: true, type: 'Bool' },
    KeyboardEnabled: { get: (s) => s.world?.input?.keyboardEnabled ?? true, readonly: true, type: 'Bool' },
    TouchEnabled: { get: (s) => s.world?.input?.touchEnabled ?? false, readonly: true, type: 'Bool' },
    GamepadEnabled: { get: (s) => s.world?.input?.gamepadEnabled ?? false, readonly: true, type: 'Bool' },
    AccelerometerEnabled: { get: () => false, readonly: true, type: 'Bool' },
    GyroscopeEnabled: { get: () => false, readonly: true, type: 'Bool' },
    VREnabled: { get: () => false, readonly: true, type: 'Bool' },
    MouseDeltaSensitivity: { get: (s) => s.props.MouseDeltaSensitivity ?? 1, set: (s, v) => s.rawSet('MouseDeltaSensitivity', v), type: 'Float32' },
    OnScreenKeyboardVisible: { get: () => false, readonly: true, type: 'Bool' },
    PreferredInput: { get: (s) => E('PreferredInput', s.world?.input?.touchEnabled ? 'Touch' : 'KeyboardAndMouse'), readonly: true, type: 'Enum:PreferredInput' },
  },
  methods: methods({
    IsKeyDown: (self, kc) => [!!self.world?.input?.isKeyDown(toEnum('KeyCode', kc).Name)],
    IsMouseButtonPressed: (self, t) => [!!self.world?.input?.isMouseDown(toEnum('UserInputType', t).Name)],
    GetKeysPressed: (self) => [arr(self.world?.input ? self.world.input.keysPressed() : [])],
    GetMouseButtonsPressed: (self) => [arr(self.world?.input ? self.world.input.buttonsPressed() : [])],
    GetMouseLocation: (self) => [self.world?.input ? self.world.input.mouseLocation() : Vector2.zero],
    GetMouseDelta: (self) => [self.world?.input ? self.world.input.mouseDelta() : Vector2.zero],
    GetFocusedTextBox: (self) => [self.world?.input?.focusedTextBox || undefined],
    GetLastInputType: (self) => [E('UserInputType', self.world?.input?.lastInputType || 'MouseMovement')],
    GetStringForKeyCode: (self, kc) => { const n = toEnum('KeyCode', kc).Name; return [n.length === 1 ? n : n]; },
    GetGamepadConnected: () => [false], GetConnectedGamepads: () => [new LuaTable()], GetNavigationGamepads: () => [new LuaTable()],
    GetSupportedGamepadKeyCodes: () => [new LuaTable()], GetGamepadState: () => [new LuaTable()],
    GetDeviceRotation: () => [CFrame.identity], GetDeviceGravity: () => [undefined], GetDeviceAcceleration: () => [undefined],
    GetImageForKeyCode: () => [''],
    GetUserCFrame: () => [CFrame.identity],
    RecenterUserHeadCFrame: () => {},
  }),
  events: ['InputBegan', 'InputChanged', 'InputEnded', 'JumpRequest', 'TouchStarted', 'TouchMoved', 'TouchEnded', 'TouchTap', 'TouchLongPress', 'TouchPinch', 'TouchSwipe', 'TouchPan', 'TouchRotate', 'WindowFocused', 'WindowFocusReleased', 'LastInputTypeChanged', 'TextBoxFocused', 'TextBoxFocusReleased', 'GamepadConnected', 'GamepadDisconnected', 'PointerAction', 'DeviceRotationChanged', 'DeviceGravityChanged', 'DeviceAccelerationChanged'],
});

// ------------------------------------------------------------------ ContextActionService
defineBehavior('ContextActionService', {
  methods: methods({
    BindAction: (self, name, fn, touch, ...inputs) => bindAction(self, name, fn, touch, inputs, 2000),
    BindActionAtPriority: (self, name, fn, touch, priority, ...inputs) => bindAction(self, name, fn, touch, inputs, Number(priority) || 0),
    BindActivate: () => {}, UnbindActivate: () => {},
    UnbindAction: (self, name) => { const n = str(name, 1, 'UnbindAction'); self.actions = (self.actions || []).filter((a) => a.name !== n); self.world?.hooks.touchButtonsChanged?.(); },
    UnbindAllActions: (self) => { self.actions = []; },
    GetBoundActionInfo: (self, name) => { const a = (self.actions || []).find((x) => x.name === S(name)); const t = new LuaTable(); if (a) { t.set('priorityLevel', a.priority); t.set('stackOrder', 0); t.set('inputTypes', arr(a.inputs)); t.set('createTouchButton', a.touch); } return [t]; },
    GetAllBoundActionInfo: (self) => { const t = new LuaTable(); for (const a of self.actions || []) { const i = new LuaTable(); i.set('priorityLevel', a.priority); t.set(toByteStr(a.name), i); } return [t]; },
    SetTitle: (self, n, title) => { const a = (self.actions || []).find((x) => x.name === S(n)); if (a) { a.title = S(title); self.world?.hooks.touchButtonsChanged?.(); } },
    SetDescription: () => {}, SetImage: (self, n, img) => { const a = (self.actions || []).find((x) => x.name === S(n)); if (a) { a.image = S(img); self.world?.hooks.touchButtonsChanged?.(); } },
    SetPosition: (self, n, pos) => { const a = (self.actions || []).find((x) => x.name === S(n)); if (a) { a.position = pos; self.world?.hooks.touchButtonsChanged?.(); } },
    GetButton: () => [undefined],
    GetCurrentLocalToolIcon: () => [''],
  }),
  events: ['LocalToolEquipped', 'LocalToolUnequipped'],
});
function bindAction(self, name, fn, touch, inputs, priority) {
  if (typeof fn !== 'function') throw lerr('BindAction: function expected');
  const n = str(name, 1, 'BindAction');
  self.actions = (self.actions || []).filter((a) => a.name !== n);
  self.actions.push({ name: n, fn, touch: !!touch, inputs, priority, owner: R.current ? R.current.owner : null, seq: (self.seq = (self.seq || 0) + 1) });
  self.actions.sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  self.world?.hooks.touchButtonsChanged?.();
}

// ------------------------------------------------------------------ TweenService
export const EASING = {
  Linear: (t) => t,
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t, Cubic: (t) => t * t * t, Quart: (t) => t ** 4, Quint: (t) => t ** 5,
  Exponential: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  Circular: (t) => 1 - Math.sqrt(1 - t * t),
  Back: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
  Elastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))),
  Bounce: (t) => 1 - bounceOut(1 - t),
};
function bounceOut(t) {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}
export function ease(alpha, style = 'Quad', dir = 'Out') {
  const f = EASING[style] || EASING.Quad;
  if (style === 'Linear') return alpha;
  if (dir === 'In') return f(alpha);
  if (dir === 'Out') return 1 - f(1 - alpha);
  return alpha < 0.5 ? f(alpha * 2) / 2 : 1 - f((1 - alpha) * 2) / 2;
}
defineBehavior('TweenService', {
  methods: methods({
    Create: (self, inst, info, goals) => {
      if (!(inst instanceof Instance)) throw lerr(`TweenService:Create no instance`);
      if (!(info instanceof TweenInfo)) throw lerr('TweenService:Create: TweenInfo expected');
      if (!(goals instanceof LuaTable)) throw lerr('TweenService:Create: property table expected');
      const tw = new Instance('Tween', self.world);
      tw.props.Name = 'Tween';
      tw.target = inst;
      tw.info = info;
      tw.goals = [];
      const add = (k, v) => {
        const name = fromByteStr(k);
        if (!inst.hasProp(name)) throw lerr(`TweenService:Create property named '${name}' cannot be tweened due to type mismatch (property is a 'nil', but given type is '${luaTypeof(v)}')`);
        tw.goals.push({ name, to: typeof v === 'string' ? fromByteStr(v) : v });
      };
      for (const [k, v] of goals.hash || []) add(k, v);
      tw.props.PlaybackState = E('PlaybackState', 'Begin');
      return [tw];
    },
    GetValue: (self, alpha, style, dir) => [ease(Math.max(0, Math.min(1, alpha)), style ? style.Name : 'Quad', dir ? dir.Name : 'Out')],
    SmoothDamp: (self, cur, target, vel, smooth, maxSpeed, dt) => {
      const omega = 2 / Math.max(1e-4, smooth); const x = omega * dt; const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = typeof cur === 'number' ? cur - target : cur.sub(target);
      if (typeof cur === 'number') { const temp = (vel + omega * change) * dt; const nv = (vel - omega * temp) * exp; return [target + (change + temp) * exp, nv]; }
      const temp = vel.add(change.mul(omega)).mul(dt); const nv = vel.sub(temp.mul(omega)).mul(exp);
      return [target.add(change.add(temp).mul(exp)), nv];
    },
  }),
});
defineBehavior('Tween', {
  props: {
    Instance: { get: (t) => t.target || null, readonly: true, type: 'Ref' },
    TweenInfo: { get: (t) => t.info, readonly: true, type: 'any' },
    PlaybackState: { get: (t) => t.props.PlaybackState || E('PlaybackState', 'Begin'), readonly: true, type: 'Enum:PlaybackState' },
  },
  methods: methods({
    Play: (self) => {
      const w = self.world || worldOf(self);
      if (!w) return;
      if (self.props.PlaybackState && self.props.PlaybackState.Name === 'Playing') return;
      if (!self.paused) {
        self.elapsed = 0; self.repeats = 0; self.reverse = false;
        self.from = self.goals.map((g) => self.target.get(g.name));
      }
      self.paused = false;
      self.rawSet('PlaybackState', E('PlaybackState', self.info.DelayTime > 0 ? 'Delayed' : 'Playing'));
      (w.tweens ||= new Set()).add(self);
      // tweening the same property cancels older tweens on it
      for (const other of w.tweens) {
        if (other !== self && other.target === self.target && other.goals.some((g) => self.goals.some((h) => h.name === g.name))) { w.tweens.delete(other); other.rawSet('PlaybackState', E('PlaybackState', 'Cancelled')); other.fire('Completed', E('PlaybackState', 'Cancelled')); }
      }
    },
    Pause: (self) => { const w = self.world || worldOf(self); if (w && w.tweens) w.tweens.delete(self); self.paused = true; self.rawSet('PlaybackState', E('PlaybackState', 'Paused')); },
    Cancel: (self) => { const w = self.world || worldOf(self); if (w && w.tweens) w.tweens.delete(self); self.paused = false; self.rawSet('PlaybackState', E('PlaybackState', 'Cancelled')); self.fire('Completed', E('PlaybackState', 'Cancelled')); },
  }),
  events: ['Completed'],
});
/** Advance all tweens of a world by dt (called by the game loop). */
export function stepTweens(world, dt) {
  if (!world.tweens || !world.tweens.size) return;
  for (const tw of [...world.tweens]) {
    const info = tw.info;
    if (tw.target.destroyed) { world.tweens.delete(tw); continue; }
    tw.elapsed += dt;
    let t = tw.elapsed - info.DelayTime;
    if (t < 0) continue;
    if (tw.props.PlaybackState.Name === 'Delayed') tw.rawSet('PlaybackState', E('PlaybackState', 'Playing'));
    const dur = Math.max(0, info.Time);
    let alpha = dur > 0 ? Math.min(1, t / dur) : 1;
    const a = ease(tw.reverse ? 1 - alpha : alpha, info.EasingStyle ? info.EasingStyle.Name : 'Quad', info.EasingDirection ? info.EasingDirection.Name : 'Out');
    tw.goals.forEach((g, i) => {
      try { tw.target.set(g.name, lerpTweenValue(tw.from[i], g.to, a)); } catch { /* property no longer valid */ }
    });
    if (alpha >= 1) {
      if (info.Reverses && !tw.reverse) { tw.reverse = true; tw.elapsed = info.DelayTime; continue; }
      tw.reverse = false;
      if (info.RepeatCount < 0 || tw.repeats < info.RepeatCount) { tw.repeats++; tw.elapsed = info.DelayTime > 0 ? 0 : 0; continue; }
      world.tweens.delete(tw);
      tw.rawSet('PlaybackState', E('PlaybackState', 'Completed'));
      tw.fire('Completed', E('PlaybackState', 'Completed'));
    }
  }
}
function lerpTweenValue(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (typeof a === 'boolean' || a instanceof EnumItem) return t >= 1 ? b : a;
  if (a === undefined || a === null) return b;
  return lerpValue(a, b, t);
}

// ------------------------------------------------------------------ Debris
defineBehavior('Debris', {
  methods: methods({
    AddItem: (self, inst, life) => {
      const w = worldOf(self);
      if (!(inst instanceof Instance)) return;
      const t = typeof life === 'number' ? life : 10;
      if (w) w.scheduler.timer(t, () => { if (!inst.destroyed) inst.destroy(); });
    },
    addItem: (self, inst, life) => { const w = worldOf(self); if (w) w.scheduler.timer(typeof life === 'number' ? life : 10, () => inst.destroy()); },
    SetLegacyMaxItems: () => {},
  }),
});

// ------------------------------------------------------------------ HttpService
function jsonEncode(v) {
  const seen = new Set();
  const conv = (x, depth) => {
    if (depth > 100) throw lerr('Cannot convert to JSON: nesting too deep');
    if (x === undefined) return null;
    if (typeof x === 'string') return fromByteStr(x);
    if (typeof x === 'number') { if (!Number.isFinite(x)) return null; return x; }
    if (typeof x === 'boolean') return x;
    if (x instanceof LuaTable) {
      if (seen.has(x)) throw lerr('tables cannot be cyclic');
      seen.add(x);
      const n = x.arr.length;
      let r;
      if (n > 0 && (!x.hash || x.hash.size === 0)) r = x.arr.map((y) => conv(y, depth + 1));
      else if (n === 0 && (!x.hash || x.hash.size === 0)) r = [];
      else {
        r = {};
        x.arr.forEach((y, i) => { r[String(i + 1)] = conv(y, depth + 1); });
        for (const [k, y] of x.hash) { if (typeof k !== 'string' && typeof k !== 'number') continue; r[typeof k === 'string' ? fromByteStr(k) : String(k)] = conv(y, depth + 1); }
      }
      seen.delete(x);
      return r;
    }
    if (x instanceof EnumItem) return x.toString();
    if (x instanceof Vector3 || x instanceof CFrame || x instanceof Color3) return null;
    if (x instanceof Instance) return null;
    throw lerr(`Cannot convert ${luaTypeof(x)} to JSON`);
  };
  return JSON.stringify(conv(v, 0));
}
function jsonDecode(s) {
  let v;
  try { v = JSON.parse(fromByteStr(s)); } catch (e) { throw lerr(`Can't parse JSON`); }
  return plainToLua(v);
}
const httpEnabled = (self) => {
  const app = self.world?.app;
  if (self.props.HttpEnabled === false) throw lerr('Http requests are not enabled. Enable via game settings');
  if (app && app.settings && !app.settings.get('httpEnabled')) throw lerr('Http requests are disabled in Bloxlab settings');
};
async function httpFetch(self, url, init) {
  const app = self.world?.app;
  try {
    const r = await fetch(url, init);
    return r;
  } catch (e) {
    const base = app && (app.settings.get('apiProxy') || app.assets?.inferApiProxy());
    if (base) return fetch(`${base.replace(/\/+$/, '')}/fetch?url=${encodeURIComponent(url)}`, init);
    throw new Error(`HttpError: ${e.message} (the server may not allow cross-origin requests)`);
  }
}
defineBehavior('HttpService', {
  props: { HttpEnabled: { get: (s) => s.props.HttpEnabled !== false, set: (s, v) => s.rawSet('HttpEnabled', !!v), type: 'Bool' } },
  methods: methods({
    JSONEncode: (self, v) => [toByteStr(jsonEncode(v))],
    JSONDecode: (self, s) => [jsonDecode(str(s, 1, 'JSONDecode'))],
    GenerateGUID: (self, wrap) => { const g = (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (Math.random() * 16 >> (c / 4))).toString(16))).toUpperCase(); return [wrap === false ? g : `{${g}}`]; },
    UrlEncode: (self, s) => [encodeURIComponent(str(s, 1, 'UrlEncode'))],
    *GetAsync(self, url, nocache, headers) {
      httpEnabled(self);
      const r = yield* awaitPromise(httpFetch(self, str(url, 1, 'GetAsync'), { headers: headers instanceof LuaTable ? luaToPlain(headers) : undefined }).then(async (res) => { if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`); return res.text(); }), 'GetAsync');
      return [toByteStr(r)];
    },
    *PostAsync(self, url, body, contentType, compress, headers) {
      httpEnabled(self);
      const ct = contentType instanceof EnumItem ? { ApplicationJson: 'application/json', ApplicationXml: 'application/xml', ApplicationUrlEncoded: 'application/x-www-form-urlencoded', TextPlain: 'text/plain', TextXml: 'text/xml' }[contentType.Name] : 'application/json';
      const r = yield* awaitPromise(httpFetch(self, str(url, 1, 'PostAsync'), { method: 'POST', body: fromByteStr(body || ''), headers: { 'Content-Type': ct || 'application/json', ...(headers instanceof LuaTable ? luaToPlain(headers) : {}) } }).then(async (res) => { if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`); return res.text(); }), 'PostAsync');
      return [toByteStr(r)];
    },
    *RequestAsync(self, opts) {
      httpEnabled(self);
      const o = luaToPlain(opts) || {};
      const res = yield* awaitPromise(httpFetch(self, o.Url, { method: o.Method || 'GET', headers: o.Headers || {}, body: o.Body }).then(async (r) => ({ r, body: await r.text() })), 'RequestAsync');
      const hdr = {};
      res.r.headers.forEach((v, k) => { hdr[k] = v; });
      return [plainToLua({ Success: res.r.ok, StatusCode: res.r.status, StatusMessage: res.r.statusText, Headers: hdr, Body: res.body })];
    },
    GetHttpEnabled: (self) => [self.props.HttpEnabled !== false],
    SetHttpEnabled: (self, v) => { self.rawSet('HttpEnabled', !!v); },
    GetSecret: () => { throw lerr('Secrets are not available in Bloxlab'); },
  }),
});

// ------------------------------------------------------------------ CollectionService
defineBehavior('CollectionService', {
  init: (cs) => {
    cs.index = new Map();
    cs.addedSignals = new Map();
    cs.removedSignals = new Map();
    cs.onTag = (inst, tag, added) => {
      let set = cs.index.get(tag);
      if (!set) { set = new Set(); cs.index.set(tag, set); }
      if (added) { if (!set.has(inst)) { set.add(inst); cs.addedSignals.get(tag)?.fire(inst); cs.fire('TagAdded', tag); } }
      else if (set.delete(inst)) { cs.removedSignals.get(tag)?.fire(inst); cs.fire('TagRemoved', tag); }
    };
  },
  added: (cs) => {
    const w = cs.world;
    if (w) { w.services.set('CollectionService', cs); if (cs.dm) cs.dm.forTree((d) => { if (d.tags) for (const t of d.tags) cs.onTag(d, t, true); }); }
  },
  methods: methods({
    GetTagged: (self, tag) => [arr([...(self.index.get(str(tag, 1, 'GetTagged')) || [])].filter((i) => i.dm))],
    GetInstanceAddedSignal: (self, tag) => { const t = str(tag, 1, 'GetInstanceAddedSignal'); let s = self.addedSignals.get(t); if (!s) { s = new Signal(`${t}Added`); self.addedSignals.set(t, s); } return [s]; },
    GetInstanceRemovedSignal: (self, tag) => { const t = str(tag, 1, 'GetInstanceRemovedSignal'); let s = self.removedSignals.get(t); if (!s) { s = new Signal(`${t}Removed`); self.removedSignals.set(t, s); } return [s]; },
    AddTag: (self, inst, tag) => { inst.addTag(str(tag, 2, 'AddTag')); },
    RemoveTag: (self, inst, tag) => { inst.removeTag(str(tag, 2, 'RemoveTag')); },
    HasTag: (self, inst, tag) => [inst.hasTag(str(tag, 2, 'HasTag'))],
    GetTags: (self, inst) => [arr(inst.tags ? [...inst.tags] : [])],
    GetAllTags: (self) => [arr([...self.index.keys()].filter((t) => self.index.get(t).size))],
    GetCollection: (self, tag) => [arr([...(self.index.get(str(tag, 1, 'GetCollection')) || [])])],
  }),
  events: ['TagAdded', 'TagRemoved', 'ItemAdded', 'ItemRemoved'],
});

// ------------------------------------------------------------------ DataStoreService (persisted in the host browser)
function dsKey(store, scope, key) { return `${store}/${scope}/${key}`; }
function placeKey(world) { const app = world?.app; return (app && (app.project?.id || app.project?.name)) || 'place'; }
async function dsGet(world, k) { return idb.get('datastores', `${placeKey(world)}:${k}`); }
async function dsSet(world, k, v) { if (v === undefined) await idb.del('datastores', `${placeKey(world)}:${k}`); else await idb.set('datastores', `${placeKey(world)}:${k}`, v); }
const toStored = (v) => { const plain = luaToPlain(v); const s = JSON.stringify(plain); if (s && s.length > 4194304) throw lerr('DataStore value too large (4 MB max)'); return plain; };
const checkServer = (self) => { const w = worldOf(self); if (w && w.kind === 'client') throw lerr('DataStoreService: DataStore can\'t be accessed from client'); };
const dsMethods = (ordered) => methods({
  *GetAsync(self, key) {
    checkServer(self);
    const v = yield* awaitPromise(dsGet(self.world, dsKey(self.storeName, self.scope, str(key, 1, 'GetAsync'))), 'GetAsync');
    const info = new Instance('DataStoreKeyInfo', self.world);
    return [v === undefined ? undefined : plainToLua(v.value), info];
  },
  *SetAsync(self, key, value) {
    checkServer(self);
    const k = dsKey(self.storeName, self.scope, str(key, 1, 'SetAsync'));
    if (ordered && typeof value !== 'number') throw lerr('OrderedDataStore values must be integers');
    yield* awaitPromise(dsSet(self.world, k, { value: toStored(value), t: Date.now() }), 'SetAsync');
    return [`v${Date.now()}`];
  },
  *UpdateAsync(self, key, fn) {
    checkServer(self);
    const k = dsKey(self.storeName, self.scope, str(key, 1, 'UpdateAsync'));
    const cur = yield* awaitPromise(dsGet(self.world, k), 'UpdateAsync');
    const r = yield* call(fn, cur === undefined ? undefined : plainToLua(cur.value), new Instance('DataStoreKeyInfo', self.world));
    if (r[0] === undefined) return [cur === undefined ? undefined : plainToLua(cur.value)];
    yield* awaitPromise(dsSet(self.world, k, { value: toStored(r[0]), t: Date.now() }), 'UpdateAsync');
    return [r[0]];
  },
  *IncrementAsync(self, key, delta = 1) {
    checkServer(self);
    const k = dsKey(self.storeName, self.scope, str(key, 1, 'IncrementAsync'));
    const cur = yield* awaitPromise(dsGet(self.world, k), 'IncrementAsync');
    const n = (cur && typeof cur.value === 'number' ? cur.value : 0) + (Number(delta) || 0);
    yield* awaitPromise(dsSet(self.world, k, { value: n, t: Date.now() }), 'IncrementAsync');
    return [n];
  },
  *RemoveAsync(self, key) {
    checkServer(self);
    const k = dsKey(self.storeName, self.scope, str(key, 1, 'RemoveAsync'));
    const cur = yield* awaitPromise(dsGet(self.world, k), 'RemoveAsync');
    yield* awaitPromise(dsSet(self.world, k, undefined), 'RemoveAsync');
    return [cur === undefined ? undefined : plainToLua(cur.value)];
  },
  *GetSortedAsync(self, ascending, pageSize, minV, maxV) {
    checkServer(self);
    const prefix = `${placeKey(self.world)}:${self.storeName}/${self.scope}/`;
    const keys = (yield* awaitPromise(idb.keys('datastores'), 'GetSortedAsync')).filter((k) => k.startsWith(prefix));
    const entries = [];
    for (const k of keys) { const v = yield* awaitPromise(idb.get('datastores', k), 'GetSortedAsync'); if (v && typeof v.value === 'number' && (minV === undefined || v.value >= minV) && (maxV === undefined || v.value <= maxV)) entries.push([k.slice(prefix.length), v.value]); }
    entries.sort((a, b) => (ascending ? a[1] - b[1] : b[1] - a[1]));
    const pages = new Instance('DataStorePages', self.world);
    pages.entries = entries; pages.pageSize = Math.max(1, Math.min(100, Number(pageSize) || 50)); pages.page = 0;
    return [pages];
  },
  ListKeysAsync: (self) => { const pages = new Instance('DataStoreKeyPages', self.world); pages.entries = []; pages.pageSize = 50; pages.page = 0; return [pages]; },
  ListVersionsAsync: (self) => { const pages = new Instance('DataStoreVersionPages', self.world); pages.entries = []; pages.pageSize = 50; pages.page = 0; return [pages]; },
  GetVersionAsync: () => [undefined],
  RemoveVersionAsync: () => {},
});
defineBehavior('GlobalDataStore', { methods: dsMethods(false) });
defineBehavior('OrderedDataStore', { methods: dsMethods(true) });
defineBehavior('Pages', {
  props: { IsFinished: { get: (p) => (p.page + 1) * p.pageSize >= (p.entries || []).length, readonly: true, type: 'Bool' } },
  methods: methods({
    GetCurrentPage: (self) => {
      const list = (self.entries || []).slice(self.page * self.pageSize, (self.page + 1) * self.pageSize);
      return [new LuaTable(list.map(([k, v]) => { const t = new LuaTable(); t.set('key', toByteStr(k)); t.set('value', v); return t; }))];
    },
    AdvanceToNextPageAsync: (self) => { self.page++; },
  }),
});
defineBehavior('DataStoreService', {
  methods: methods({
    GetDataStore: (self, name, scope) => { checkServer(self); const ds = new Instance('DataStore', self.world); ds.storeName = str(name, 1, 'GetDataStore'); ds.scope = scope ? str(scope, 2, 'GetDataStore') : 'global'; ds.props.Name = ds.storeName; return [ds]; },
    GetGlobalDataStore: (self) => { checkServer(self); const ds = new Instance('DataStore', self.world); ds.storeName = '__global'; ds.scope = 'global'; return [ds]; },
    GetOrderedDataStore: (self, name, scope) => { checkServer(self); const ds = new Instance('OrderedDataStore', self.world); ds.storeName = `ordered:${str(name, 1, 'GetOrderedDataStore')}`; ds.scope = scope ? S(scope) : 'global'; ds.props.Name = S(name); return [ds]; },
    GetRequestBudgetForRequestType: () => [60],
    ListDataStoresAsync: (self) => { const pages = new Instance('DataStoreListingPages', self.world); pages.entries = []; pages.pageSize = 50; pages.page = 0; return [pages]; },
  }),
});

// ------------------------------------------------------------------ MarketplaceService (purchases are simulated)
defineBehavior('MarketplaceService', {
  props: { ProcessReceipt: { get: (m) => m.callbacks?.ProcessReceipt, lua: () => undefined, luaSet: (m, v) => { (m.callbacks ||= {}).ProcessReceipt = v; }, type: 'function' } },
  methods: methods({
    PromptPurchase: (self, player, id) => { simulatePurchase(self, player, id, 'asset'); },
    PromptProductPurchase: (self, player, id) => { simulatePurchase(self, player, id, 'product'); },
    PromptGamePassPurchase: (self, player, id) => { simulatePurchase(self, player, id, 'gamepass'); },
    PromptPremiumPurchase: () => {},
    PromptSubscriptionPurchase: () => {},
    PromptBundlePurchase: () => {},
    *UserOwnsGamePassAsync(self, userId, passId) { return [!!(self.world?.app?.ownedPasses?.has(`${userId}:${passId}`))]; },
    *PlayerOwnsAsset(self, player, id) { return [false]; },
    *PlayerOwnsBundle() { return [false]; },
    *IsPlayerSubscribed() { return [false]; },
    *GetProductInfo(self, id, infoType) {
      const t = new LuaTable();
      t.set('Name', toByteStr(`Item ${id}`)); t.set('Description', ''); t.set('PriceInRobux', 0); t.set('AssetId', id); t.set('ProductId', id); t.set('IsForSale', true); t.set('IconImageAssetId', 0);
      const app = self.world?.app;
      if (app) {
        try {
          const j = yield* awaitPromise(app.assets.api('economy', `/v2/assets/${id}/details`), 'GetProductInfo');
          if (j && j.Name) { t.set('Name', toByteStr(j.Name)); t.set('Description', toByteStr(j.Description || '')); t.set('PriceInRobux', j.PriceInRobux || 0); const c = new LuaTable(); c.set('Name', toByteStr(j.Creator?.Name || '')); c.set('Id', j.Creator?.Id || 0); t.set('Creator', c); }
        } catch { /* offline: keep defaults */ }
      }
      return [t];
    },
    *GetDeveloperProductsAsync(self) { const pages = new Instance('Pages', self.world); pages.entries = []; pages.pageSize = 50; pages.page = 0; return [pages]; },
    *GetRobuxBalance() { return [0]; },
    GetSubscriptionProductInfoAsync: () => [new LuaTable()],
  }),
  events: ['PromptPurchaseFinished', 'PromptProductPurchaseFinished', 'PromptGamePassPurchaseFinished', 'PromptPremiumPurchaseFinished', 'PromptBundlePurchaseFinished', 'PromptSubscriptionPurchaseFinished'],
});
function simulatePurchase(ms, player, id, kind) {
  const w = ms.world;
  if (!w || !w.hooks.purchasePrompt) return;
  w.hooks.purchasePrompt(player, id, kind);
}

// ------------------------------------------------------------------ assorted services
defineBehavior('TeleportService', {
  methods: methods({
    Teleport: (self, placeId, player) => { const w = worldOf(self); w?.output(`TeleportService:Teleport(${placeId}) is not available in Bloxlab`, 'warn'); self.fire('TeleportInitFailed', player, E('TeleportResult', 'Failure'), 'Teleporting is not supported in Bloxlab', placeId); },
    TeleportAsync: (self, placeId) => { worldOf(self)?.output(`TeleportService:TeleportAsync(${placeId}) is not available in Bloxlab`, 'warn'); return [undefined]; },
    TeleportToPlaceInstance: (self, placeId) => { worldOf(self)?.output('Teleporting is not supported in Bloxlab', 'warn'); },
    TeleportToPrivateServer: () => {}, TeleportPartyAsync: () => [''], ReserveServer: () => ['', ''],
    GetLocalPlayerTeleportData: () => [undefined], GetTeleportSetting: () => [undefined], SetTeleportSetting: () => {},
    SetTeleportGui: () => {}, GetArrivingTeleportGui: () => [undefined],
  }),
  events: ['TeleportInitFailed', 'LocalPlayerArrivedFromTeleport'],
});
defineBehavior('BadgeService', {
  methods: methods({
    *AwardBadge(self, userId, badgeId) { const w = worldOf(self); const set = (w.app && (w.app.badges ||= new Set())) || new Set(); set.add(`${userId}:${badgeId}`); w.output(`Badge ${badgeId} awarded to ${userId} (simulated)`, 'info'); return [true]; },
    *UserHasBadgeAsync(self, userId, badgeId) { const w = worldOf(self); return [!!(w.app && w.app.badges && w.app.badges.has(`${userId}:${badgeId}`))]; },
    *CheckUserBadgesAsync(self, userId, ids) { return [new LuaTable()]; },
    *GetBadgeInfoAsync(self, id) { const t = new LuaTable(); t.set('Name', toByteStr(`Badge ${id}`)); t.set('Description', ''); t.set('IconImageId', 0); t.set('IsEnabled', true); return [t]; },
    IsLegal: () => [true], IsDisabled: () => [false], UserHasBadge: () => [false],
  }),
  events: ['BadgeAwarded'],
});
defineBehavior('GroupService', {
  methods: methods({
    *GetGroupInfoAsync(self, id) { const t = new LuaTable(); t.set('Name', toByteStr(`Group ${id}`)); t.set('Id', id); return [t]; },
    *GetGroupsAsync() { return [new LuaTable()]; },
    *GetAlliesAsync(self) { const p = new Instance('Pages', self.world); p.entries = []; p.pageSize = 50; p.page = 0; return [p]; },
    *GetEnemiesAsync(self) { const p = new Instance('Pages', self.world); p.entries = []; p.pageSize = 50; p.page = 0; return [p]; },
  }),
});
defineBehavior('LocalizationService', {
  props: {
    RobloxLocaleId: { get: () => (typeof navigator !== 'undefined' ? navigator.language : 'en-us').toLowerCase(), readonly: true, type: 'String' },
    SystemLocaleId: { get: () => (typeof navigator !== 'undefined' ? navigator.language : 'en-us').toLowerCase(), readonly: true, type: 'String' },
  },
  methods: methods({
    *GetTranslatorForPlayerAsync(self) { return [makeTranslator(self)]; },
    GetTranslatorForPlayer: (self) => [makeTranslator(self)],
    *GetTranslatorForLocaleAsync(self) { return [makeTranslator(self)]; },
    *GetCountryRegionForPlayerAsync() { return ['US']; },
    GetCorescriptLocalizations: () => [new LuaTable()],
    GetTableEntries: () => [new LuaTable()],
  }),
});
function makeTranslator(svc) { const t = new Instance('Translator', svc.world); t.props.LocaleId = svc.get('RobloxLocaleId'); return t; }
defineBehavior('Translator', {
  methods: methods({
    Translate: (self, ctx, text) => [text],
    FormatByKey: (self, key, args) => [key],
    RobloxOnlyTranslate: (self, ctx, text) => [text],
  }),
});
defineBehavior('PolicyService', {
  methods: methods({
    *GetPolicyInfoForPlayerAsync() {
      return [plainToLua({ AreAdsAllowed: false, ArePaidRandomItemsRestricted: false, AllowedExternalLinkReferences: ['Discord', 'YouTube', 'Twitch', 'Facebook', 'X'], IsPaidItemTradingAllowed: true, IsSubjectToChinaPolicies: false, IsContentSharingAllowed: true, IsEligibleToPurchaseSubscription: false, IsEligibleToPurchaseCommerceProduct: false })];
    },
    *CanViewBrandProjectAsync() { return [true]; },
  }),
});
defineBehavior('SocialService', {
  methods: methods({
    PromptGameInvite: () => {}, PromptPhoneBook: () => {},
    *CanSendGameInviteAsync() { return [false]; }, *CanSendCallInviteAsync() { return [false]; },
    PromptLinkSharing: () => {}, ShowSelfView: () => {}, HideSelfView: () => {},
  }),
  events: ['GameInvitePromptClosed', 'PhoneBookPromptClosed'],
});
defineBehavior('AnalyticsService', {
  methods: methods({ LogCustomEvent: () => {}, LogEconomyEvent: () => {}, LogFunnelStepEvent: () => {}, LogOnboardingFunnelStepEvent: () => {}, LogProgressionEvent: () => {}, LogProgressionStartEvent: () => {}, LogProgressionCompleteEvent: () => {}, LogProgressionFailEvent: () => {}, FireCustomEvent: () => {}, FireInGameEconomyEvent: () => {}, FirePlayerProgressionEvent: () => {}, FireLogEvent: () => {} }),
});
defineBehavior('MessagingService', {
  methods: methods({
    *PublishAsync(self, topic, message) {
      const t = str(topic, 1, 'PublishAsync');
      const subs = (self.subs && self.subs.get(t)) || [];
      const w = worldOf(self);
      const msg = new LuaTable(); msg.set('Data', message); msg.set('Sent', Date.now() / 1000);
      for (const s of subs) if (s.Connected) w.scheduler.defer(s.fn, [msg], s.owner);
      return EMPTY;
    },
    *SubscribeAsync(self, topic, fn) {
      const t = str(topic, 1, 'SubscribeAsync');
      if (!self.subs) self.subs = new Map();
      if (!self.subs.has(t)) self.subs.set(t, []);
      const conn = new Signal('Subscription').connect(() => {});
      const entry = { fn, owner: R.current ? R.current.owner : null, get Connected() { return conn.Connected; } };
      self.subs.get(t).push(entry);
      return [conn];
    },
  }),
});
defineBehavior('MemoryStoreService', {
  methods: methods({
    GetSortedMap: (self, name) => [memStore(self, 'MemoryStoreSortedMap', S(name))],
    GetQueue: (self, name) => [memStore(self, 'MemoryStoreQueue', S(name))],
    GetHashMap: (self, name) => [memStore(self, 'MemoryStoreHashMap', S(name))],
  }),
});
function memStore(svc, cls, name) {
  const all = (svc.stores ||= new Map());
  const k = `${cls}:${name}`;
  if (!all.has(k)) { const s = new Instance(cls, svc.world); s.props.Name = name; s.data = new Map(); s.queue = []; all.set(k, s); }
  return all.get(k);
}
const memMethods = methods({
  *GetAsync(self, key) { const e = self.data.get(S(key)); return [e && (!e.exp || e.exp > Date.now()) ? e.value : undefined]; },
  *SetAsync(self, key, value, exp) { self.data.set(S(key), { value, exp: exp ? Date.now() + exp * 1000 : 0 }); return [true]; },
  *UpdateAsync(self, key, fn, exp) { const e = self.data.get(S(key)); const r = yield* call(fn, e ? e.value : undefined); if (r[0] !== undefined) self.data.set(S(key), { value: r[0], exp: exp ? Date.now() + exp * 1000 : 0 }); return [r[0]]; },
  *RemoveAsync(self, key) { self.data.delete(S(key)); return EMPTY; },
  *GetRangeAsync(self, dir, count) { const items = [...self.data.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); if (dir && dir.Name === 'Descending') items.reverse(); return [new LuaTable(items.slice(0, count || 100).map(([k, e]) => { const t = new LuaTable(); t.set('key', toByteStr(k)); t.set('value', e.value); return t; }))]; },
  *AddAsync(self, value) { self.queue.push(value); return EMPTY; },
  *ReadAsync(self, count) { const items = self.queue.splice(0, count || 1); return [new LuaTable(items), 'id']; },
});
for (const cls of ['MemoryStoreSortedMap', 'MemoryStoreQueue', 'MemoryStoreHashMap']) defineBehavior(cls, { methods: memMethods });

// ------------------------------------------------------------------ PathfindingService (grid A* over raycasts)
defineBehavior('PathfindingService', {
  methods: methods({
    CreatePath: (self, params) => {
      const p = new Instance('Path', self.world);
      const opts = params instanceof LuaTable ? luaToPlain(params) : {};
      p.agentRadius = Number(opts.AgentRadius) || 2;
      p.agentHeight = Number(opts.AgentHeight) || 5;
      p.canJump = opts.AgentCanJump !== false;
      p.waypoints = [];
      p.props.Status = E('PathStatus', 'NoPath');
      return [p];
    },
    *FindPathAsync(self, a, b) {
      const p = new Instance('Path', self.world);
      p.agentRadius = 2; p.agentHeight = 5; p.canJump = true; p.waypoints = [];
      computePath(p, a, b);
      return [p];
    },
  }),
});
defineBehavior('Path', {
  props: { Status: { get: (p) => p.props.Status || E('PathStatus', 'NoPath'), readonly: true, type: 'Enum:PathStatus' } },
  methods: methods({
    *ComputeAsync(self, a, b) { computePath(self, a, b); },
    GetWaypoints: (self) => [arr(self.waypoints || [])],
    CheckOcclusionAsync: () => [-1],
  }),
  events: ['Blocked', 'Unblocked'],
});
function computePath(path, start, goal) {
  const ws = path.world && path.world.dm && path.world.dm.findFirstChildOfClass('Workspace');
  const STEP = 4;
  const ground = (x, z, yHint) => {
    if (!ws) return yHint;
    const hit = raycastWorld(ws, new Vector3(x, yHint + 12, z), new Vector3(0, -40, 0), (p) => p.props.CanCollide !== false && !p.isDescendantOfCharacter);
    return hit ? hit.position.Y : null;
  };
  const blocked = (a, b) => {
    if (!ws) return false;
    const up = new Vector3(0, 2.5, 0);
    const hit = raycastWorld(ws, a.add(up), b.sub(a), (p) => p.props.CanCollide !== false && !p.parent?.findFirstChildOfClass?.('Humanoid'));
    return !!hit;
  };
  const key = (x, z) => `${x},${z}`;
  const sx = Math.round(start.X / STEP), sz = Math.round(start.Z / STEP), gx = Math.round(goal.X / STEP), gz = Math.round(goal.Z / STEP);
  const open = [{ x: sx, z: sz, y: start.Y, g: 0, f: 0, prev: null }];
  const seen = new Map([[key(sx, sz), open[0]]]);
  let found = null, iter = 0;
  while (open.length && iter++ < 4000) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (Math.abs(cur.x - gx) <= 1 && Math.abs(cur.z - gz) <= 1) { found = cur; break; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cur.x + dx, nz = cur.z + dz;
      const k = key(nx, nz);
      const y = ground(nx * STEP, nz * STEP, cur.y);
      if (y === null || y - cur.y > (path.canJump ? 7 : 1.5) || cur.y - y > 30) continue;
      const a = new Vector3(cur.x * STEP, cur.y, cur.z * STEP), b = new Vector3(nx * STEP, y, nz * STEP);
      if (blocked(a, b)) continue;
      const g = cur.g + Math.hypot(dx, dz);
      const old = seen.get(k);
      if (old && old.g <= g) continue;
      const node = { x: nx, z: nz, y, g, f: g + Math.hypot(gx - nx, gz - nz), prev: cur };
      seen.set(k, node);
      open.push(node);
    }
  }
  if (!found) {
    // fall back to a straight line when the goal is directly reachable
    if (!blocked(start, goal)) {
      path.waypoints = [new PathWaypoint(start, E('PathWaypointAction', 'Walk')), new PathWaypoint(goal, E('PathWaypointAction', 'Walk'))];
      path.rawSet('Status', E('PathStatus', 'Success'));
    } else { path.waypoints = []; path.rawSet('Status', E('PathStatus', 'NoPath')); }
    return;
  }
  const nodes = [];
  for (let n = found; n; n = n.prev) nodes.unshift(n);
  const wps = [new PathWaypoint(start, E('PathWaypointAction', 'Walk'))];
  let prevY = start.Y;
  for (const n of nodes.slice(1)) {
    const pos = new Vector3(n.x * STEP, n.y + 0.5, n.z * STEP);
    wps.push(new PathWaypoint(pos, E('PathWaypointAction', n.y - prevY > 1.5 ? 'Jump' : 'Walk')));
    prevY = n.y;
  }
  wps.push(new PathWaypoint(goal, E('PathWaypointAction', 'Walk')));
  path.waypoints = wps;
  path.rawSet('Status', E('PathStatus', 'Success'));
}

// ------------------------------------------------------------------ PhysicsService (collision groups)
const groupsOf = (w) => (w.collisionGroups ||= { names: ['Default'], off: new Set() });
defineBehavior('PhysicsService', {
  methods: methods({
    RegisterCollisionGroup: (self, name) => { const g = groupsOf(worldOf(self)); const n = str(name, 1, 'RegisterCollisionGroup'); if (!g.names.includes(n)) g.names.push(n); worldOf(self).hooks.collisionGroupsChanged?.(); },
    CreateCollisionGroup: (self, name) => { const g = groupsOf(worldOf(self)); const n = S(name); if (!g.names.includes(n)) g.names.push(n); return [g.names.indexOf(n)]; },
    UnregisterCollisionGroup: (self, name) => { const g = groupsOf(worldOf(self)); g.names = g.names.filter((x) => x !== S(name)); },
    RemoveCollisionGroup: (self, name) => { const g = groupsOf(worldOf(self)); g.names = g.names.filter((x) => x !== S(name)); },
    RenameCollisionGroup: (self, a, b) => { const g = groupsOf(worldOf(self)); const i = g.names.indexOf(S(a)); if (i >= 0) g.names[i] = S(b); },
    CollisionGroupSetCollidable: (self, a, b, on) => {
      const g = groupsOf(worldOf(self));
      const k = [S(a), S(b)].sort().join('|');
      if (on) g.off.delete(k); else g.off.add(k);
      worldOf(self).hooks.collisionGroupsChanged?.();
    },
    CollisionGroupsAreCollidable: (self, a, b) => [!groupsOf(worldOf(self)).off.has([S(a), S(b)].sort().join('|'))],
    GetRegisteredCollisionGroups: (self) => { const g = groupsOf(worldOf(self)); return [new LuaTable(g.names.map((n, i) => { const t = new LuaTable(); t.set('name', toByteStr(n)); t.set('id', i); t.set('mask', 0xffffffff); return t; }))]; },
    GetCollisionGroups: (self) => { const g = groupsOf(worldOf(self)); return [new LuaTable(g.names.map((n, i) => { const t = new LuaTable(); t.set('name', toByteStr(n)); t.set('id', i); return t; }))]; },
    IsCollisionGroupRegistered: (self, n) => [groupsOf(worldOf(self)).names.includes(S(n))],
    GetMaxCollisionGroups: () => [32],
    GetCollisionGroupId: (self, n) => [groupsOf(worldOf(self)).names.indexOf(S(n))],
    GetCollisionGroupName: (self, id) => [toByteStr(groupsOf(worldOf(self)).names[id] || '')],
    SetPartCollisionGroup: (self, part, name) => { part.set('CollisionGroup', S(name)); },
    GetPartCollisionGroup: (self, part) => [0],
    CollisionGroupContainsPart: (self, name, part) => [part.props.CollisionGroup === S(name)],
  }),
});

// ------------------------------------------------------------------ InsertService / ContentProvider / KeyframeSequenceProvider
defineBehavior('InsertService', {
  methods: methods({
    *LoadAsset(self, id) {
      const w = worldOf(self);
      if (!w.loadAsset) throw lerr('InsertService:LoadAsset is not available');
      const insts = yield* awaitPromise(w.loadAsset(id), 'LoadAsset');
      const model = new Instance('Model', w);
      model.props.Name = 'Model';
      for (const i of insts) i.setParent(model);
      return [model];
    },
    *LoadAssetVersion(self, id) { return yield* self.beh.methods.LoadAsset(self, id); },
    *GetFreeModels() { return [new LuaTable()]; },
    *GetFreeDecals() { return [new LuaTable()]; },
    *GetLatestAssetVersionAsync(self, id) { return [id]; },
    *CreateMeshPartAsync(self, meshId) { const p = new Instance('MeshPart', self.world); p.props.MeshId = S(meshId); return [p]; },
  }),
});
defineBehavior('ContentProvider', {
  props: { RequestQueueSize: { get: () => 0, readonly: true, type: 'Int32' } },
  methods: methods({
    *PreloadAsync(self, list, cb) {
      const w = worldOf(self);
      const ids = [];
      for (const v of fromLuaArray(list)) {
        if (typeof v === 'string') ids.push(fromByteStr(v));
        else if (v instanceof Instance) v.forTree((d) => { for (const k of ['Texture', 'Image', 'MeshId', 'TextureID', 'SoundId', 'AnimationId']) if (d.props[k]) ids.push(d.props[k]); });
      }
      const app = w && w.app;
      for (const id of ids) {
        let ok = true;
        if (app) { try { yield* awaitPromise(app.assets.bytes(id), 'PreloadAsync'); } catch { ok = false; } }
        if (cb) yield* call(cb, toByteStr(id), E('AssetFetchStatus', ok ? 'Success' : 'Failure'));
      }
    },
    Preload: () => {},
    GetAssetFetchStatus: () => [E('AssetFetchStatus', 'Success')],
  }),
});
defineBehavior('KeyframeSequenceProvider', {
  methods: methods({
    RegisterKeyframeSequence: (self, kfs) => { const w = worldOf(self); const reg = (w.tempKfs ||= new Map()); const id = `rbxtemp://${reg.size + 1}`; reg.set(id, kfs); return [id]; },
    RegisterActiveKeyframeSequence: (self, kfs) => { const w = worldOf(self); const reg = (w.tempKfs ||= new Map()); const id = `rbxtemp://${reg.size + 1}`; reg.set(id, kfs); return [id]; },
    *GetKeyframeSequenceAsync(self, id) { const w = worldOf(self); if (!w.loadKeyframeSequence) throw lerr('not available'); return [yield* awaitPromise(w.loadKeyframeSequence(S(id)), 'GetKeyframeSequenceAsync')]; },
    *GetAnimations(self) { const p = new Instance('Pages', self.world); p.entries = []; p.pageSize = 50; p.page = 0; return [p]; },
  }),
});

// ------------------------------------------------------------------ StarterGui / GuiService / TextService / LogService / SoundService
defineBehavior('StarterGui', {
  methods: methods({
    SetCoreGuiEnabled: (self, type, on) => { const w = worldOf(self); const t = toEnum('CoreGuiType', type).Name; (w.coreGui ||= {})[t] = !!on; if (t === 'All') for (const k of ['PlayerList', 'Health', 'Backpack', 'Chat', 'EmotesMenu']) w.coreGui[k] = !!on; w.hooks.coreGuiChanged?.(); },
    GetCoreGuiEnabled: (self, type) => { const w = worldOf(self); const t = toEnum('CoreGuiType', type).Name; return [!w.coreGui || w.coreGui[t] !== false]; },
    SetCore: (self, name, value) => { const w = worldOf(self); w.hooks.setCore?.(S(name), value); },
    GetCore: (self, name) => [worldOf(self).hooks.getCore?.(S(name))],
    RegisterSetCore: () => {}, RegisterGetCore: () => {},
  }),
});
defineBehavior('GuiService', {
  props: {
    MenuIsOpen: { get: () => false, readonly: true, type: 'Bool' },
    SelectedObject: { get: (g) => g.props.SelectedObject || null, set: (g, v) => g.rawSet('SelectedObject', v), type: 'Ref' },
    TopbarInset: { get: (g) => new Rect(0, 0, (worldOf(g)?.hooks.viewportSize?.().w || 1280), 58), readonly: true, type: 'Rect' },
  },
  methods: methods({
    GetGuiInset: () => [new Vector2(0, 58), new Vector2(0, 0)],
    IsTenFootInterface: () => [false],
    AddSelectionParent: () => {}, RemoveSelectionGroup: () => {}, Select: () => {},
    GetEmotesMenuOpen: () => [false], SetEmotesMenuOpen: () => {}, GetInspectMenuEnabled: () => [false], SetInspectMenuEnabled: () => {},
    InspectPlayerFromUserId: () => {}, CloseInspectMenu: () => {},
  }),
  events: ['MenuOpened', 'MenuClosed'],
});
let measureCtx = null;
export function measureText(text, size, family = 'sans-serif', weight = 400, maxWidth = Infinity) {
  if (!measureCtx && typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(4, 4).getContext('2d');
  const lines = String(text).split('\n');
  let w = 0, h = 0;
  for (const line of lines) {
    let lw;
    if (measureCtx) { measureCtx.font = `${weight} ${size}px ${family}`; lw = measureCtx.measureText(line).width; }
    else lw = line.length * size * 0.5;
    if (lw > maxWidth && maxWidth > 0) { const rows = Math.ceil(lw / maxWidth); h += rows * size; w = Math.max(w, maxWidth); }
    else { w = Math.max(w, lw); h += size; }
  }
  return new Vector2(Math.ceil(w), Math.ceil(h));
}
defineBehavior('TextService', {
  methods: methods({
    GetTextSize: (self, text, size, font, frame) => [measureText(S(text), Number(size) || 14, 'sans-serif', font && /Bold/.test(font.Name) ? 700 : 400, frame instanceof Vector2 && frame.X > 0 ? frame.X : Infinity)],
    *GetTextBoundsAsync(self, params) { return [measureText(S(params.props?.Text || ''), params.props?.Size || 14)]; },
    *FilterStringAsync(self, text) { const r = new Instance('TextFilterResult', self.world); r.text = S(text); return [r]; },
    *GetFamilyInfoAsync() { const t = new LuaTable(); t.set('Name', 'Font'); return [t]; },
    *FilterAndTranslateStringAsync(self, text) { const r = new Instance('TextFilterTranslatedResult', self.world); r.text = S(text); return [r]; },
  }),
});
defineBehavior('TextFilterResult', {
  methods: methods({
    *GetNonChatStringForBroadcastAsync(self) { return [toByteStr(self.text || '')]; },
    *GetNonChatStringForUserAsync(self) { return [toByteStr(self.text || '')]; },
    *GetChatForUserAsync(self) { return [toByteStr(self.text || '')]; },
  }),
});
defineBehavior('LogService', {
  init: (ls) => {
    ls.history = [];
    ls.onLog = (e) => {
      const type = e.kind === 'error' ? 'MessageError' : e.kind === 'warn' ? 'MessageWarning' : e.kind === 'info' || e.kind === 'trace' ? 'MessageInfo' : 'MessageOutput';
      ls.history.push({ message: e.msg, messageType: type, timestamp: e.time / 1000 });
      if (ls.history.length > 500) ls.history.shift();
      ls.fire('MessageOut', toByteStr(e.msg), E('MessageType', type));
    };
  },
  added: (ls) => { if (ls.world) ls.world.services.set('LogService', ls); },
  methods: methods({
    GetLogHistory: (self) => [new LuaTable(self.history.map((h) => plainToLua(h)))],
    ClearOutput: () => {},
    ExecuteScript: () => {},
  }),
  events: ['MessageOut', 'HttpResultOut'],
});
defineBehavior('SoundService', {
  methods: methods({
    PlayLocalSound: (self, sound) => { worldOf(self)?.hooks.playSound?.(sound, true); },
    GetListener: () => [E('ListenerType', 'Camera'), undefined],
    SetListener: () => {},
    SetRBXEvent: () => {},
  }),
});
defineBehavior('ProximityPromptService', { events: ['PromptTriggered', 'PromptTriggerEnded', 'PromptButtonHoldBegan', 'PromptButtonHoldEnded', 'PromptShown', 'PromptHidden'] });
defineBehavior('VRService', { props: { VREnabled: { get: () => false, readonly: true, type: 'Bool' } }, methods: methods({ GetUserCFrame: () => [CFrame.identity], GetUserCFrameEnabled: () => [false], RecenterUserHeadCFrame: () => {}, RequestNavigation: () => {}, SetTouchpadMode: () => {} }) });
defineBehavior('HapticService', { methods: methods({ IsVibrationSupported: () => [false], IsMotorSupported: () => [false], SetMotor: () => {}, GetMotor: () => [0] }) });
defineBehavior('GamepadService', { methods: methods({ EnableGamepadCursor: () => {}, DisableGamepadCursor: () => {} }) });
defineBehavior('AvatarEditorService', { methods: methods({ PromptAllowInventoryReadAccess: () => {}, PromptSaveAvatar: () => {}, *GetInventory() { return [undefined]; }, *SearchCatalog() { return [undefined]; } }) });
defineBehavior('UserService', { methods: methods({ *GetUserInfosByUserIdsAsync(self, ids) { return [new LuaTable(fromLuaArray(ids).map((id) => plainToLua({ Id: id, Username: `Player${id}`, DisplayName: `Player${id}`, HasVerifiedBadge: false })))]; } }) });
defineBehavior('ExperienceNotificationService', { methods: methods({ *CanPromptOptInAsync() { return [false]; }, PromptOptIn: () => {} }) });
defineBehavior('Chat', {
  methods: methods({
    Chat: (self, part, msg, color) => { worldOf(self)?.hooks.bubbleChat?.(part, S(msg), color); },
    *FilterStringAsync(self, s) { return [s]; },
    *FilterStringForBroadcast(self, s) { return [s]; },
    FilterStringForPlayerAsync: (self, s) => [s],
    CanUserChatAsync: () => [true], CanUsersChatAsync: () => [true],
    RegisterChatCallback: () => {}, InvokeChatCallback: () => [undefined],
    SetBubbleChatSettings: () => {},
  }),
  events: ['Chatted'],
});

export { Coroutine, Signal, runSync, mkgen, tostr, LuaError, UDim, UDim2, Color3, getEnum, L, toLua };
