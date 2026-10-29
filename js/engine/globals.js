// Roblox globals for a World's VM: game, workspace, Instance, wait, task, require, ...
import { LuaTable, LuaError, EMPTY, R, mkgen, Coroutine, typeName, toByteStr, fromByteStr, resume } from '../luau/runtime.js';
import { libTable } from '../luau/stdlib.js';
import { constructors, EnumRoot, S, lerr, luaTypeof } from './bridge.js';
import { Instance } from './instance.js';
import { classInfo, isCreatable, isService, classExists } from './reflect.js';

export function installGlobals(world) {
  const G = world.vm.globals;
  const set = (k, v) => { if (typeof v === 'function') { v.$name = v.$name || k; v.$builtin = true; } G.set(k, v); };
  for (const [k, v] of Object.entries(constructors)) G.set(k, v);
  G.set('Enum', EnumRoot);

  // game / workspace are resolved lazily so the DataModel can be created after the VM
  const envMeta = G;
  void envMeta;

  // ---------------------------------------------------------- Instance
  const newInstance = (className, parent) => {
    const cn = S(className);
    if (typeof cn !== 'string') throw lerr(`invalid argument #1 to 'new' (string expected, got ${typeName(className)})`);
    if (!classExists(cn) || (!isCreatable(cn) && !world.creatableOverride?.(cn))) {
      if (isService(cn)) throw lerr(`Unable to create an Instance of type "${cn}"`);
      throw lerr(`Unable to create an Instance of type "${cn}"`);
    }
    const inst = new Instance(cn, world);
    if (world.dm && world.dm.onInstanceCreated) world.dm.onInstanceCreated(inst);
    if (parent !== undefined) {
      if (!(parent instanceof Instance)) throw lerr(`invalid argument #2 to 'new' (Instance expected, got ${luaTypeof(parent)})`);
      inst.setParent(parent);
    }
    return inst;
  };
  G.set('Instance', libTable({
    new: (cn, parent) => [newInstance(cn, parent)],
    fromExisting: (src) => { if (!(src instanceof Instance)) throw lerr('Instance expected'); const c = new Instance(src.ClassName, world); for (const k of Object.keys(src.props)) c.props[k] = src.props[k]; return [c]; },
  }, 'Instance'));
  world.newInstance = newInstance;

  // ---------------------------------------------------------- time & threads
  const sched = world.scheduler;
  const clockNow = () => sched.clock;
  const waitFn = mkgen(function* (t) {
    const sec = typeof t === 'number' && t > 0 ? Math.max(t, 1 / 60) : 1 / 30;
    const r = yield* sched.sleep(sec);
    return [r[0], world.elapsedTime ? world.elapsedTime() : r[1]];
  }, 'wait');
  set('wait', waitFn); set('Wait', waitFn);
  const spawnFn = (f) => { if (typeof f !== 'function') throw lerr('invalid argument #1 to \'spawn\' (function expected)'); sched.delay(1 / 30, f, [0, clockNow()]); };
  set('spawn', spawnFn); set('Spawn', spawnFn);
  const delayFn = (t, f) => { if (typeof f !== 'function') throw lerr('invalid argument #2 to \'delay\' (function expected)'); sched.delay(Math.max(typeof t === 'number' ? t : 0, 1 / 30), f, [t, clockNow()]); };
  set('delay', delayFn); set('Delay', delayFn);
  set('tick', () => [Date.now() / 1000]);
  set('time', () => [clockNow()]);
  set('elapsedTime', () => [(performance.now() - (world.started || 0)) / 1000]);
  set('ElapsedTime', () => [(performance.now() - (world.started || 0)) / 1000]);
  set('version', () => ['0.650.0.6500000']);
  set('printidentity', (pre) => { world.output(`${pre ? S(pre) + ' ' : 'Current identity is '}${world.kind === 'edit' ? 5 : 2}`); });
  set('settings', () => [world.getService('Settings') || undefined]);
  set('UserSettings', () => [world.getService('UserSettings') || undefined]);
  set('stats', () => [world.getService('Stats') || undefined]);
  set('require', mkgen(function* (mod) {
    if (typeof mod === 'number') {
      if (!world.requireAsset) throw lerr('require(assetId) is not available');
      const m = yield* world.requireAsset(mod);
      return yield* world.require(m);
    }
    return yield* world.require(mod);
  }, 'require'));

  const thread = (f, args) => {
    if (f instanceof Coroutine) return f;
    if (typeof f !== 'function') throw lerr(`invalid argument #1 (function or thread expected, got ${typeName(f)})`);
    return new Coroutine(f, (R.current && R.current.owner) || world.defaultContext);
  };
  G.set('task', libTable({
    spawn: (f, ...args) => { const co = thread(f); sched.run(co, args); return [co]; },
    defer: (f, ...args) => { const co = thread(f); sched.deferred.push({ co, args }); return [co]; },
    delay: (t, f, ...args) => { const co = thread(f); sched.push({ at: sched.clock + Math.max(0, typeof t === 'number' ? t : 0), co, args, delay: true }); return [co]; },
    wait: mkgen(function* (t) {
      const sec = typeof t === 'number' && t > 0 ? t : 0;
      const r = yield* sched.sleep(sec);
      return [r[0]];
    }, 'wait'),
    cancel: (co) => { if (!(co instanceof Coroutine)) throw lerr('invalid argument #1 to \'cancel\' (thread expected)'); if (co === R.current) throw lerr('cannot cancel running thread'); sched.cancel(co); },
    synchronize: () => {}, desynchronize: () => {},
  }, 'task'));

  // game / workspace / plugin are set once the DataModel exists (see datamodel.js)
  world.setGameGlobals = (dm) => {
    G.set('game', dm); G.set('Game', dm);
    const ws = dm.findFirstChildOfClass('Workspace');
    G.set('workspace', ws); G.set('Workspace', ws);
  };
  void toByteStr; void fromByteStr; void resume; void classInfo; void LuaTable; void LuaError; void EMPTY;
}
