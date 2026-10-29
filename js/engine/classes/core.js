// Core Instance API + basic classes (DataModel, scripts, values, bindables, remotes).
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, S, toLua, arr, luaTypeof, luaToProp } from '../bridge.js';
import { LuaTable, LuaError, EMPTY, R, mkgen, call, toByteStr, fromByteStr, typeName } from '../../luau/runtime.js';
import { classInfo, isA, F, classExists } from '../reflect.js';
import {
  Vector3, Vector2, CFrame, Color3, BrickColor, UDim, UDim2, Rect, NumberRange, NumberSequence, ColorSequence, Font,
} from '../datatypes.js';
import { EnumItem } from '../enums.js';

const ATTR_TYPES = [Vector3, Vector2, CFrame, Color3, BrickColor, UDim, UDim2, Rect, NumberRange, NumberSequence, ColorSequence, Font, EnumItem];
const str = (v, n, f) => {
  if (typeof v === 'string') return fromByteStr(v);
  if (typeof v === 'number') return String(v);
  throw lerr(`invalid argument #${n} to '${f}' (string expected, got ${v === undefined ? 'nil' : luaTypeof(v)})`);
};

// ------------------------------------------------------------------ Instance
defineBehavior('Instance', {
  props: {
    ClassName: { get: (i) => i.ClassName, readonly: true, type: 'String' },
    className: { get: (i) => i.ClassName, readonly: true, type: 'String' },
    Archivable: { get: (i) => i.archivable, set: (i, v) => { i.archivable = !!v; i.changed('Archivable'); }, type: 'Bool' },
    Name: {
      get: (i) => i.props.Name,
      set: (i, v) => { i.rawSet('Name', String(v)); },
      type: 'String',
    },
    Parent: { get: (i) => i.parent, set: (i, v) => i.setParent(v), type: 'Ref' },
    RobloxLocked: { get: () => false, set: () => {}, type: 'Bool' },
  },
  methods: methods({
    FindFirstChild: (self, name, rec) => [self.findFirstChild(str(name, 1, 'FindFirstChild'), !!rec && rec !== false)],
    FindFirstChildOfClass: (self, cn) => [self.findFirstChildOfClass(str(cn, 1, 'FindFirstChildOfClass'))],
    FindFirstChildWhichIsA: (self, cn, rec) => [self.findFirstChildWhichIsA(str(cn, 1, 'FindFirstChildWhichIsA'), !!rec)],
    FindFirstAncestor: (self, name) => [self.findFirstAncestor(str(name, 1, 'FindFirstAncestor'))],
    FindFirstAncestorOfClass: (self, cn) => [self.findFirstAncestorOfClass(str(cn, 1, 'FindFirstAncestorOfClass'))],
    FindFirstAncestorWhichIsA: (self, cn) => [self.findFirstAncestorWhichIsA(str(cn, 1, 'FindFirstAncestorWhichIsA'))],
    FindFirstDescendant: (self, name) => [self.findFirstChild(str(name, 1, 'FindFirstDescendant'), true)],
    GetChildren: (self) => [arr(self.children)],
    children: (self) => [arr(self.children)],
    GetDescendants: (self) => [arr(self.descendants())],
    IsA: (self, cn) => [self.isA(str(cn, 1, 'IsA'))],
    isA: (self, cn) => [self.isA(str(cn, 1, 'isA'))],
    IsAncestorOf: (self, d) => [d instanceof Instance && d.isDescendantOf(self)],
    IsDescendantOf: (self, a) => {
      if (a !== undefined && !(a instanceof Instance)) throw lerr('invalid argument #1 to \'IsDescendantOf\' (Instance expected)');
      return [!!a && self.isDescendantOf(a)];
    },
    isDescendantOf: (self, a) => [!!a && self.isDescendantOf(a)],
    GetFullName: (self) => [toByteStr(self.getFullName())],
    GetDebugId: (self) => [`${self.id}`],
    Destroy: (self) => { if (self.ClassName === 'DataModel' || self.isService) throw lerr(`Cannot destroy ${self.ClassName}`); self.destroy(); },
    destroy: (self) => { self.destroy(); },
    Remove: (self) => { self.setParent(null); for (const c of self.children.slice()) c.setParent(null); },
    remove: (self) => { self.setParent(null); },
    ClearAllChildren: (self) => { self.clearAllChildren(); },
    Clone: (self) => {
      const c = self.clone(false);
      if (c && self.world) c.forTree((d) => { d.world = self.world; });
      return [c || undefined];
    },
    clone: (self) => [self.clone(false) || undefined],
    *WaitForChild(self, name, timeout) {
      const n = str(name, 1, 'WaitForChild');
      const found = self.findFirstChild(n);
      if (found) return [found];
      const world = (R.current && R.current.owner && R.current.owner.world) || self.world;
      if (!world) throw lerr('WaitForChild can only be called from a running script');
      let warned = false;
      let conn = null;
      const r = yield* world.scheduler.waitFor((wake) => {
        conn = self.signal('ChildAdded').connect((c) => { if (c.props.Name === n) wake([c]); });
        if (typeof timeout === 'number') world.scheduler.timer(timeout, () => wake([undefined]));
        else world.scheduler.timer(5, () => {
          if (!warned && !self.findFirstChild(n)) { warned = true; world.output(`Infinite yield possible on '${self.getFullName()}:WaitForChild("${n}")'`, 'warn'); }
        });
      });
      if (conn) conn.disconnect();
      return [r[0]];
    },
    waitForChild: (self, name) => [self.findFirstChild(str(name, 1, 'waitForChild'))],
    GetAttribute: (self, name) => [toLua(self.getAttribute(str(name, 1, 'GetAttribute')))],
    SetAttribute: (self, name, v) => {
      const n = str(name, 1, 'SetAttribute');
      if (n.length > 100 || !/^[A-Za-z0-9_]+$/.test(n) || n.startsWith('RBX')) throw lerr(`Attribute name '${n}' is invalid`);
      if (v !== undefined && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean' && !ATTR_TYPES.some((T) => v instanceof T)) {
        throw lerr(`${luaTypeof(v)} is not a supported attribute type`);
      }
      self.setAttribute(n, typeof v === 'string' ? fromByteStr(v) : v);
    },
    GetAttributes: (self) => {
      const t = new LuaTable();
      if (self.attrs) for (const [k, v] of self.attrs) t.set(toByteStr(k), toLua(v));
      return [t];
    },
    GetAttributeChangedSignal: (self, name) => [self.attributeSignal(str(name, 1, 'GetAttributeChangedSignal'))],
    AddTag: (self, t) => { self.addTag(str(t, 1, 'AddTag')); },
    RemoveTag: (self, t) => { self.removeTag(str(t, 1, 'RemoveTag')); },
    HasTag: (self, t) => [self.hasTag(str(t, 1, 'HasTag'))],
    GetTags: (self) => [arr(self.tags ? [...self.tags] : [])],
    GetPropertyChangedSignal: (self, prop) => {
      const p = str(prop, 1, 'GetPropertyChangedSignal');
      if (!self.hasProp(p) && p !== 'Parent' && p !== 'Name') throw lerr(`${p} is not a valid property name.`);
      return [self.propertySignal(p)];
    },
    IsPropertyModified: (self, p) => [self.isPropModified(str(p, 1, 'IsPropertyModified'))],
    ResetPropertyToDefault: (self, p) => { self.resetProp(str(p, 1, 'ResetPropertyToDefault')); },
    GetActor: () => [undefined],
    GetStyled: (self, p) => [toLua(self.get(str(p, 1, 'GetStyled')))],
    QueryDescendants: (self, sel) => {
      const q = str(sel, 1, 'QueryDescendants').trim();
      const all = self.descendants();
      let out = all;
      if (q.startsWith('.')) out = all.filter((d) => d.hasTag(q.slice(1)));
      else if (q.startsWith('#')) out = all.filter((d) => d.props.Name === q.slice(1));
      else if (q) out = all.filter((d) => d.isA(q));
      return [arr(out)];
    },
  }),
});

// ------------------------------------------------------------------ DataModel
defineBehavior('ServiceProvider', {
  methods: methods({
    GetService: (self, name) => {
      const n = str(name, 1, 'GetService');
      const s = self.serviceFactory ? self.serviceFactory(n) : self.findFirstChildOfClass(n);
      if (!s) throw lerr(`'${n}' is not a valid Service name`);
      return [s];
    },
    getService: (self, name) => [self.serviceFactory(str(name, 1, 'getService'))],
    service: (self, name) => [self.serviceFactory(str(name, 1, 'service'))],
    FindService: (self, name) => [self.findFirstChildOfClass(str(name, 1, 'FindService'))],
    findService: (self, name) => [self.findFirstChildOfClass(str(name, 1, 'findService'))],
  }),
});
defineBehavior('DataModel', {
  props: {
    PlaceId: { get: (i) => i.world?.app?.placeInfo?.placeId ?? 0, readonly: true, type: 'Int64' },
    GameId: { get: (i) => i.world?.app?.placeInfo?.gameId ?? 0, readonly: true, type: 'Int64' },
    CreatorId: { get: (i) => i.world?.app?.placeInfo?.creatorId ?? 0, readonly: true, type: 'Int64' },
    CreatorType: { get: () => null, readonly: true, type: 'Enum:CreatorType' },
    JobId: { get: (i) => i.jobId || (i.jobId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)), readonly: true, type: 'String' },
    PlaceVersion: { get: () => 1, readonly: true, type: 'Int32' },
    PrivateServerId: { get: () => '', readonly: true, type: 'String' },
    PrivateServerOwnerId: { get: () => 0, readonly: true, type: 'Int64' },
    Workspace: { get: (i) => i.findFirstChildOfClass('Workspace'), readonly: true, type: 'Ref' },
    workspace: { get: (i) => i.findFirstChildOfClass('Workspace'), readonly: true, type: 'Ref' },
    lighting: { get: (i) => i.findFirstChildOfClass('Lighting'), readonly: true, type: 'Ref' },
  },
  methods: methods({
    IsLoaded: () => [true],
    BindToClose: (self, fn) => { (self.closeCallbacks ||= []).push(fn); },
    Shutdown: (self) => { if (self.world && self.world.app && self.world.app.stopPlay) self.world.app.stopPlay(); },
    GetJobsInfo: () => [new LuaTable()],
    SetPlaceId: () => {}, SetUniverseId: () => {},
    GetObjects: (self, url) => {
      const w = self.world;
      if (!w || !w.loadObjectsSync) throw lerr('GetObjects is not available');
      return [arr(w.loadObjectsSync(fromByteStr(url)))];
    },
  }),
  events: ['Loaded', 'GraphicsQualityChangeRequest', 'ItemChanged', 'Close'],
});

// ------------------------------------------------------------------ scripts
const restartIfRunning = (inst) => {
  const w = inst.world;
  if (!w || !w.running) return;
  if (inst.get('Disabled')) w.stopScript(inst);
  else { w.stopScript(inst); w.maybeRunScript(inst); }
};
defineBehavior('BaseScript', {
  props: {
    Enabled: { get: (i) => !i.props.Disabled, set: (i, v) => i.set('Disabled', !v), type: 'Bool' },
    Disabled: { get: (i) => !!i.props.Disabled, set: (i, v) => { if (i.rawSet('Disabled', !!v)) { i.changed('Enabled'); restartIfRunning(i); } }, type: 'Bool' },
  },
});
defineBehavior('LuaSourceContainer', {
  props: {
    Source: { get: (i) => i.props.Source || '', set: (i, v) => i.rawSet('Source', String(v)), type: 'String' },
  },
});

// ------------------------------------------------------------------ values
defineBehavior('ValueBase', {});
defineBehavior('IntValue', { props: { Value: { get: (i) => i.props.Value ?? 0, set: (i, v) => i.rawSet('Value', Math.trunc(Number(v) || 0)), type: 'Int64' } } });
defineBehavior('NumberValue', { props: { Value: { get: (i) => i.props.Value ?? 0, set: (i, v) => i.rawSet('Value', Number(v) || 0), type: 'Float64' } } });
defineBehavior('StringValue', { props: { Value: { get: (i) => i.props.Value ?? '', set: (i, v) => i.rawSet('Value', String(v)), type: 'String' } } });
defineBehavior('BoolValue', { props: { Value: { get: (i) => !!i.props.Value, set: (i, v) => i.rawSet('Value', !!v), type: 'Bool' } } });

// ------------------------------------------------------------------ bindables
const callbackProp = (name) => ({
  [name]: {
    get: (i) => (i.callbacks && i.callbacks[name]) || undefined,
    lua: () => { throw lerr(`${name} is a callback member of ${'this class'}; you can only set the callback value, get is not available`); },
    luaSet: (i, v) => { if (v !== undefined && typeof v !== 'function') throw lerr(`Unable to assign property ${name}. function expected`); (i.callbacks ||= {})[name] = v; if (i.onCallbackSet) i.onCallbackSet(name, v); },
    type: 'function',
  },
});
defineBehavior('BindableEvent', {
  methods: methods({
    Fire: (self, ...args) => { self.fire('Event', ...args.map(copyForBindable)); },
  }),
});
defineBehavior('BindableFunction', {
  props: callbackProp('OnInvoke'),
  methods: methods({
    *Invoke(self, ...args) {
      let cb = self.callbacks && self.callbacks.OnInvoke;
      if (!cb) {
        const world = self.world || (R.current && R.current.owner && R.current.owner.world);
        if (!world) throw lerr('BindableFunction has no OnInvoke');
        yield* world.scheduler.waitFor((wake) => { self.onCallbackSet = (n, v) => { if (n === 'OnInvoke' && v) wake(EMPTY); }; });
        cb = self.callbacks.OnInvoke;
      }
      return yield* call(cb, ...args.map(copyForBindable));
    },
  }),
});
function copyForBindable(v, depth = 0) {
  if (v instanceof LuaTable && depth < 32) {
    const t = new LuaTable(v.arr.map((x) => copyForBindable(x, depth + 1)));
    if (v.hash) for (const [k, x] of v.hash) t.set(k, copyForBindable(x, depth + 1));
    return t;
  }
  if (typeof v === 'function') return v;
  return v;
}

// ------------------------------------------------------------------ remotes (network hooks provided by net/replication.js)
const net = (self, what) => {
  const w = self.world;
  if (!w || !w.net) throw lerr(`${what} cannot be called while not playing`);
  return w.net;
};
const remoteEventMethods = methods({
  FireServer: (self, ...args) => {
    if (!self.world || self.world.kind !== 'client') throw lerr('FireServer can only be called from the client');
    net(self, 'FireServer').fireServer(self, args);
  },
  FireClient: (self, player, ...args) => {
    if (!self.world || self.world.kind !== 'server') throw lerr('FireClient can only be called from the server');
    if (!(player instanceof Instance) || player.ClassName !== 'Player') throw lerr('FireClient: player argument must be a Player object');
    net(self, 'FireClient').fireClient(self, player, args);
  },
  FireAllClients: (self, ...args) => {
    if (!self.world || self.world.kind !== 'server') throw lerr('FireAllClients can only be called from the server');
    net(self, 'FireAllClients').fireAllClients(self, args);
  },
});
defineBehavior('RemoteEvent', { methods: remoteEventMethods });
defineBehavior('UnreliableRemoteEvent', { methods: remoteEventMethods });
defineBehavior('RemoteFunction', {
  props: { ...callbackProp('OnServerInvoke'), ...callbackProp('OnClientInvoke') },
  methods: methods({
    *InvokeServer(self, ...args) {
      if (!self.world || self.world.kind !== 'client') throw lerr('InvokeServer can only be called from the client');
      return yield* net(self, 'InvokeServer').invokeServer(self, args);
    },
    *InvokeClient(self, player, ...args) {
      if (!self.world || self.world.kind !== 'server') throw lerr('InvokeClient can only be called from the server');
      return yield* net(self, 'InvokeClient').invokeClient(self, player, args);
    },
  }),
});

// ------------------------------------------------------------------ Folder/Configuration are plain containers
defineBehavior('Folder', {});

export { classInfo, isA, F, classExists, LuaError, typeName, luaToProp };
