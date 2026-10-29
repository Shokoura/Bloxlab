// Helpers shared by the server and client replicators.
import { Coroutine, mkgen, call, EMPTY, LuaError, fromByteStr } from '../luau/runtime.js';

export const PROTOCOL = 1;

/** Runs a Lua function in its own thread; resolves with { ok, values } once it returns (it may yield). */
export function invokeLua(world, fn, args, owner = world.defaultContext) {
  return new Promise((resolve) => {
    const runner = mkgen(function* () {
      try { resolve({ ok: true, values: yield* call(fn, ...args) }); }
      catch (e) {
        if (e && e.$kill) { resolve({ ok: false, error: 'thread was killed' }); throw e; }
        resolve({ ok: false, error: errorText(e) });
      }
      return EMPTY;
    }, 'invoke');
    world.scheduler.run(new Coroutine(runner, owner), EMPTY);
  });
}

export function errorText(e) {
  if (e instanceof LuaError) { const v = e.value; return typeof v === 'string' ? fromByteStr(v) : String(v); }
  return e && e.message ? e.message : String(e);
}

/** Waits (from Lua) for a callback property to be assigned, like Roblox queues invocations until then. */
export function* waitForCallback(world, inst, name) {
  let cb = inst.callbacks && inst.callbacks[name];
  if (cb) return cb;
  const prev = inst.onCallbackSet;
  yield* world.scheduler.waitFor((wake) => {
    inst.onCallbackSet = (n, v) => { if (prev) prev(n, v); if (n === name && v) { inst.onCallbackSet = prev; wake(EMPTY); } };
  });
  cb = inst.callbacks && inst.callbacks[name];
  return cb;
}

/** Same as waitForCallback but from JS: resolves when the callback exists. */
export function callbackReady(inst, name) {
  const cb = inst.callbacks && inst.callbacks[name];
  if (cb) return Promise.resolve(cb);
  return new Promise((resolve) => {
    const prev = inst.onCallbackSet;
    inst.onCallbackSet = (n, v) => { if (prev) prev(n, v); if (n === name && v) { inst.onCallbackSet = prev; resolve(v); } };
  });
}

export const isServerOnlyScript = (inst) => inst.ClassName === 'Script' && !(inst.props.RunContext && inst.props.RunContext.Name === 'Client');
