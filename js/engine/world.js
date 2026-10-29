// A World is one DataModel plus its Lua VM and task scheduler.
// Studio has an "edit" world; Play creates a "server" world and one "client" world per local player.
import { VM } from '../luau/stdlib.js';
import { LuaError, Coroutine, R, fromByteStr, mkgen, EMPTY, call, SCHED, toByteStr } from '../luau/runtime.js';
import { LuauSyntaxError } from '../luau/lexer.js';
import { Scheduler, ScriptContext } from './scheduler.js';
import { Instance } from './instance.js';
import { installGlobals } from './globals.js';

export class World {
  /**
   * @param {{ kind: 'edit'|'server'|'client', app?: object, name?: string }} opts
   */
  constructor({ kind, app = null, name = kind }) {
    this.kind = kind;
    this.app = app;
    this.name = name;
    this.vm = new VM({ print: (m, k, th) => this.output(m, k === 'warn' ? 'warn' : 'output', th && th.owner) });
    this.scheduler = new Scheduler(this);
    this.observers = new Set();
    this.contexts = new Map(); // script -> ScriptContext
    this.modules = new Map(); // ModuleScript -> { state, value, error, waiters }
    this.dm = null;
    this.localPlayer = null;
    this.running = false;
    this.started = 0;
    this.outputHandlers = new Set();
    this.services = new Map();
    this.defaultContext = new ScriptContext(this, null, this.vm.newEnv(), kind === 'edit' ? 'Command' : `${kind}`);
    this.hooks = {}; // set by physics / renderer / net: raycast, etc.
    installGlobals(this);
  }

  // ------------------------------------------------------------ observers
  observe(o) { this.observers.add(o); return () => this.observers.delete(o); }
  propChanged(inst, name, opts) { for (const o of this.observers) if (o.propChanged) o.propChanged(inst, name, opts); }
  attrChanged(inst, name) { for (const o of this.observers) if (o.attrChanged) o.attrChanged(inst, name); }
  tagChanged(inst, tag, added) {
    for (const o of this.observers) if (o.tagChanged) o.tagChanged(inst, tag, added);
    const cs = this.services.get('CollectionService');
    if (cs) cs.onTag(inst, tag, added);
  }
  instanceAdded(inst, opts) {
    for (const o of this.observers) if (o.added) o.added(inst, opts);
    if (this.running) inst.forTree((d) => this.maybeRunScript(d));
    const cs = this.services.get('CollectionService');
    if (cs) inst.forTree((d) => { if (d.tags) for (const t of d.tags) cs.onTag(d, t, true); });
  }
  instanceRemoved(inst, oldParent, opts) {
    for (const o of this.observers) if (o.removed) o.removed(inst, oldParent, opts);
    const cs = this.services.get('CollectionService');
    if (cs) inst.forTree((d) => { if (d.tags) for (const t of d.tags) cs.onTag(d, t, false); });
    if (this.running) inst.forTree((d) => { if (d.destroyed || !this.scriptShouldRun(d)) this.stopScriptIfDestroyed(d); });
  }
  instanceMoved(inst, oldParent, opts) {
    for (const o of this.observers) if (o.moved) o.moved(inst, oldParent, opts);
    if (this.running) inst.forTree((d) => this.maybeRunScript(d));
  }

  // ------------------------------------------------------------ output
  onOutput(fn) { this.outputHandlers.add(fn); return () => this.outputHandlers.delete(fn); }
  /** kind: output | warn | error | info | trace */
  output(msg, kind = 'output', source = null) {
    const entry = { msg: String(msg), kind, source: source && source.name ? source.name : (typeof source === 'string' ? source : null), world: this.kind, worldName: this.name, time: Date.now() };
    for (const h of this.outputHandlers) { try { h(entry); } catch (e) { console.error(e); } }
    if (!this.outputHandlers.size) (kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log)(`[${this.name}] ${msg}`);
    const ls = this.services.get('LogService');
    if (ls) ls.onLog(entry);
  }
  reportError(value, err, co) {
    const msg = typeof value === 'string' ? fromByteStr(value) : value && value.$typeof ? String(value) : `${value && typeof value === 'object' ? 'error object' : String(value)}`;
    const owner = co && co.owner;
    this.output(msg, 'error', owner);
    if (err && err.trace && err.trace.length) {
      const lines = err.trace.map(([chunk, line]) => `Script '${chunk}', Line ${line}`);
      this.output(['Stack Begin', ...lines, 'Stack End'].join('\n'), 'trace', owner);
    }
    if (err && err.js && !(err.js instanceof LuaError) && err.js.stack && /bloxlab|\.js/.test(err.js.stack) && !/call stack/.test(err.js.message)) console.warn('[engine]', err.js);
  }

  // ------------------------------------------------------------ scripts
  scriptShouldRun(s) {
    if (!s.dm || s.destroyed) return false;
    const cn = s.ClassName;
    if (cn !== 'Script' && cn !== 'LocalScript') return false;
    if (s.get('Disabled')) return false;
    const rc = s.props.RunContext ? s.props.RunContext.Name : 'Legacy';
    const top = topContainer(s);
    if (this.kind === 'server') {
      if (cn !== 'Script') return false;
      if (rc === 'Client' || rc === 'Plugin') return false;
      if (rc === 'Server') return ['Workspace', 'ServerScriptService', 'ReplicatedStorage', 'ReplicatedFirst'].includes(top);
      return top === 'Workspace' || top === 'ServerScriptService';
    }
    if (this.kind === 'client') {
      if (cn === 'Script') return rc === 'Client' && ['Workspace', 'ReplicatedStorage', 'ReplicatedFirst', 'Players', 'StarterPlayer'].includes(top) && !inStarter(s);
      // LocalScript
      if (top === 'ReplicatedFirst') return true;
      if (top === 'Players') {
        const lp = this.localPlayer;
        return !!lp && s.isDescendantOf(lp) && (inside(s, 'PlayerGui') || inside(s, 'Backpack') || inside(s, 'PlayerScripts'));
      }
      if (top === 'Workspace') {
        const ch = this.localPlayer && this.localPlayer.get('Character');
        return !!ch && s.isDescendantOf(ch);
      }
      return false;
    }
    return false;
  }
  maybeRunScript(s) {
    if (this.contexts.has(s)) return;
    if (!this.scriptShouldRun(s)) return;
    this.runScript(s);
  }
  stopScriptIfDestroyed(s) {
    const ctx = this.contexts.get(s);
    if (ctx && (s.destroyed || !s.dm)) { ctx.kill(); this.contexts.delete(s); }
  }
  stopScript(s) { const ctx = this.contexts.get(s); if (ctx) { ctx.kill(); this.contexts.delete(s); } }

  runScript(s) {
    const env = this.vm.newEnv({ script: s });
    const ctx = new ScriptContext(this, s, env);
    this.contexts.set(s, ctx);
    let fn;
    try {
      fn = this.vm.load(s.get('Source') || '', s.getFullName(), env);
    } catch (e) {
      this.output(e instanceof LuauSyntaxError ? `${s.getFullName()}:${e.line}: ${e.message}` : `${s.getFullName()}: ${e.message}`, 'error', ctx);
      return ctx;
    }
    const co = new Coroutine(fn, ctx);
    this.scheduler.run(co, EMPTY);
    return ctx;
  }

  /** require(ModuleScript) */
  *require(mod) {
    if (!(mod instanceof Instance) || mod.ClassName !== 'ModuleScript') throw new LuaError('Attempted to call require with invalid argument(s).', 1);
    let entry = this.modules.get(mod);
    if (entry && entry.state === 'done') return [entry.value];
    if (entry && entry.state === 'error') throw new LuaError('Requested module experienced an error while loading', 1);
    if (!entry) {
      entry = { state: 'loading', value: undefined, waiters: [], thread: null };
      this.modules.set(mod, entry);
      const env = this.vm.newEnv({ script: mod });
      const ctx = new ScriptContext(this, mod, env, mod.getFullName());
      let fn;
      try { fn = this.vm.load(mod.get('Source') || '', mod.getFullName(), env); }
      catch (e) {
        entry.state = 'error';
        const msg = e instanceof LuauSyntaxError ? `${mod.getFullName()}:${e.line}: ${e.message}` : e.message;
        this.output(msg, 'error', ctx);
        throw new LuaError('Requested module experienced an error while loading', 1);
      }
      const world = this;
      const finish = (ok, vals, err) => {
        if (!ok) {
          entry.state = 'error';
          world.reportError(vals[0], err, { owner: ctx });
        } else if (vals.length !== 1) {
          entry.state = 'error';
          world.output(`${mod.getFullName()}: Module code did not return exactly one value`, 'error', ctx);
        } else { entry.state = 'done'; entry.value = vals[0]; }
        const w = entry.waiters; entry.waiters = [];
        for (const wake of w) wake();
      };
      const runner = mkgen(function* () {
        try { const r = yield* call(fn); finish(true, r); }
        catch (e) { if (e && e.$kill) throw e; finish(false, [e instanceof LuaError ? e.value : String(e && e.message)], e); }
        return EMPTY;
      }, 'module');
      const co = new Coroutine(runner, ctx);
      entry.thread = co;
      this.scheduler.run(co, EMPTY);
    }
    if (entry.state === 'loading') {
      if (entry.thread === R.current) throw new LuaError('Requested module was required recursively', 1);
      yield* this.scheduler.waitFor((wake) => entry.waiters.push(() => wake(EMPTY)));
    }
    if (entry.state === 'done') return [entry.value];
    throw new LuaError('Requested module experienced an error while loading', 1);
  }

  /** Runs a chunk of Lua (command bar). */
  exec(src, name = 'CommandBar', extraEnv) {
    const env = this.vm.newEnv(extraEnv);
    const ctx = new ScriptContext(this, null, env, name);
    let fn;
    try { fn = this.vm.load(src, name, env); } catch (e) {
      this.output(e instanceof LuauSyntaxError ? `${name}:${e.line}: ${e.message}` : e.message, 'error', ctx);
      return null;
    }
    const co = new Coroutine(fn, ctx);
    this.scheduler.run(co, EMPTY);
    return ctx;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.started = performance.now();
    if (this.dm) this.dm.forTree((d) => this.maybeRunScript(d));
  }
  stop() {
    this.running = false;
    for (const ctx of this.contexts.values()) ctx.kill();
    this.contexts.clear();
    this.modules.clear();
    this.scheduler.clear();
    this.defaultContext.kill();
    for (const o of this.observers) if (o.dispose) o.dispose();
  }

  getService(name) {
    return this.services.get(name) || (this.dm ? this.dm.serviceFactory(name) : null);
  }
}

function topContainer(inst) {
  let p = inst;
  while (p.parent && !(p.parent.ClassName === 'DataModel' && !p.parent.parent)) p = p.parent;
  return p.ClassName === 'DataModel' ? null : p.ClassName;
}
function inside(inst, cn) { for (let p = inst.parent; p; p = p.parent) if (p.ClassName === cn) return true; return false; }
function inStarter(inst) { for (let p = inst.parent; p; p = p.parent) if (/^Starter/.test(p.ClassName)) return true; return false; }

export { topContainer, SCHED, toByteStr };
