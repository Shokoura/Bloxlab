// Task scheduler: resumes Lua threads (wait / task.* / events) once per frame.
import { R, Coroutine, resume, SCHED, checkYieldable, EMPTY, LuaError } from '../luau/runtime.js';

const SCRIPT_TIMEOUT_MS = 10000;

/** Owner of Lua threads: one per running script (plus one for the command bar / plugins). */
export class ScriptContext {
  constructor(world, script, env, name) {
    this.world = world;
    this.vm = world.vm;
    this.script = script;
    this.env = env;
    this.name = name || (script ? script.getFullName() : 'Command');
    this.conns = new Set();
    this.dead = false;
  }
  spawn(fn, args) { return this.world.scheduler.spawn(fn, args, this); }
  kill() {
    this.dead = true;
    for (const c of [...this.conns]) c.disconnect();
    this.conns.clear();
  }
}

export class Scheduler {
  constructor(world) {
    this.world = world;
    this.clock = 0; // seconds since start
    this.sleeping = []; // binary heap of { at, co, args?, start }
    this.deferred = [];
    this.timeout = SCRIPT_TIMEOUT_MS;
    this.seq = 0;
  }

  // ---------------------------------------------------------------- heap
  push(e) {
    e.seq = this.seq++;
    const h = this.sleeping;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(h[p], h[i]) <= 0) break;
      [h[p], h[i]] = [h[i], h[p]]; i = p;
    }
  }
  pop() {
    const h = this.sleeping;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && cmp(h[l], h[m]) < 0) m = l;
        if (r < h.length && cmp(h[r], h[m]) < 0) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]]; i = m;
      }
    }
    return top;
  }

  // ---------------------------------------------------------------- running threads
  /** Resume a thread now, reporting uncaught errors to the output. */
  run(co, args = EMPTY) {
    if (co.status !== 'suspended') return false;
    if (co.owner && co.owner.dead) { co.status = 'dead'; return false; }
    const outer = R.deadline;
    if (!outer) R.deadline = performance.now() + this.timeout;
    let r;
    try { r = resume(co, args); } finally { if (!outer) R.deadline = 0; }
    if (!r[0]) this.world.reportError(r[1], r[2], co);
    return true;
  }
  spawn(fn, args = EMPTY, owner = null) {
    let co;
    if (fn instanceof Coroutine) co = fn;
    else co = new Coroutine(fn, owner || (R.current && R.current.owner) || this.world.defaultContext);
    if (owner && !co.owner) co.owner = owner;
    this.run(co, args);
    return co;
  }
  defer(fn, args = EMPTY, owner = null) {
    const co = fn instanceof Coroutine ? fn : new Coroutine(fn, owner || (R.current && R.current.owner) || this.world.defaultContext);
    this.deferred.push({ co, args });
    return co;
  }
  delay(seconds, fn, args = EMPTY, owner = null) {
    const co = fn instanceof Coroutine ? fn : new Coroutine(fn, owner || (R.current && R.current.owner) || this.world.defaultContext);
    this.push({ at: this.clock + Math.max(0, seconds), co, args, start: this.clock, delay: true });
    return co;
  }
  /** Schedule an already-yielded thread to resume after `seconds` with [elapsed, clock]. */
  wake(co, seconds, payload, token = co.waitToken) {
    this.push({ at: this.clock + Math.max(0, seconds), co, start: this.clock, payload, token });
  }
  /** Run a JS callback after `seconds` of game time. */
  timer(seconds, fn) { this.push({ at: this.clock + Math.max(0, seconds), fn }); }
  cancel(co) {
    const items = this.sleeping.filter((e) => e.co !== co);
    this.sleeping = [];
    for (const e of items) this.push(e);
    this.deferred = this.deferred.filter((e) => e.co !== co);
    co.status = 'dead';
    co.gen = null;
  }

  /** Generator used by wait()/task.wait(): suspends the current thread. Returns [elapsed, clock]. */
  *sleep(seconds) {
    checkYieldable('wait');
    const co = R.current;
    co.waitToken = (co.waitToken || 0) + 1;
    this.wake(co, seconds);
    const r = yield SCHED;
    return r && r.length ? r : [seconds, this.clock];
  }
  /**
   * Suspends the current thread until `register(wake)` calls wake(values) (at most once counts).
   * register may call wake synchronously, in which case no yield happens.
   */
  *waitFor(register) {
    checkYieldable('wait');
    const co = R.current;
    const token = co.waitToken = (co.waitToken || 0) + 1;
    let state = 0; // 0 registering, 1 suspended, 2 done
    let early = EMPTY;
    register((vals) => {
      if (state === 2 || co.waitToken !== token) return;
      if (state === 0) { state = 2; early = vals || EMPTY; return; }
      state = 2;
      co.waitToken++;
      this.run(co, vals || EMPTY);
    });
    if (state === 2) return early;
    state = 1;
    const r = yield SCHED;
    return r || EMPTY;
  }

  /** Called once per frame after time advanced by dt. */
  step(dt) {
    this.clock += dt;
    let guard = 0;
    while (this.sleeping.length && this.sleeping[0].at <= this.clock && guard++ < 10000) {
      const e = this.pop();
      if (e.fn) { try { e.fn(); } catch (err) { console.error(err); } continue; }
      if (e.co.status !== 'suspended') continue;
      if (e.delay) { this.run(e.co, e.args); continue; }
      if (e.token !== e.co.waitToken) continue; // stale wake-up
      e.co.waitToken++;
      this.run(e.co, e.payload || [this.clock - e.start, this.clock]);
    }
    this.flushDeferred();
  }
  flushDeferred() {
    let rounds = 0;
    while (this.deferred.length && rounds++ < 80) {
      const list = this.deferred;
      this.deferred = [];
      for (const { co, args } of list) this.run(co, args);
    }
  }
  clear() { this.sleeping = []; this.deferred = []; }
}

function cmp(a, b) { return a.at - b.at || a.seq - b.seq; }
