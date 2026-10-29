// RBXScriptSignal / RBXScriptConnection.
// Handlers are either JS functions (engine internals, called synchronously) or Lua functions
// (spawned as new threads on the VM of the script that connected them).
import { R } from '../luau/runtime.js';

export class Connection {
  constructor(signal, fn, owner, once) { this.signal = signal; this.fn = fn; this.owner = owner; this.once = once; this.Connected = true; }
  disconnect() {
    if (!this.Connected) return;
    this.Connected = false;
    const list = this.signal.conns;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    if (this.owner && this.owner.conns) this.owner.conns.delete(this);
    if (this.signal.onDisconnect) this.signal.onDisconnect(this);
  }
  get $typeof() { return 'RBXScriptConnection'; }
}

export class Signal {
  /**
   * @param {string} name
   * @param {object} [opts] { onConnect(conn), onDisconnect(conn), owner }
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.conns = [];
    this.waiting = [];
    this.onConnect = opts.onConnect || null;
    this.onDisconnect = opts.onDisconnect || null;
  }
  get $typeof() { return 'RBXScriptSignal'; }

  /** JS-side connect. Returns the connection. */
  connect(fn, { once = false, owner = null } = {}) {
    const c = new Connection(this, fn, owner, once);
    this.conns.push(c);
    if (owner && owner.conns) owner.conns.add(c);
    if (this.onConnect) this.onConnect(c);
    return c;
  }
  /** Lua-side connect: remembers which script (context) owns the handler. */
  connectLua(fn, once = false) {
    const owner = R.current ? R.current.owner : null;
    return this.connect(fn, { once, owner });
  }
  get hasListeners() { return this.conns.length > 0 || this.waiting.length > 0; }

  fire(...args) {
    if (this.conns.length) {
      const list = this.conns.slice();
      for (const c of list) {
        if (!c.Connected) continue;
        if (c.once) c.disconnect();
        const f = c.fn;
        if (typeof f === 'function' && !f.$g && !f.$builtin && !c.owner) {
          try { f(...args); } catch (e) { console.error(`[${this.name}] handler error`, e); }
        } else if (c.owner && c.owner.spawn) {
          c.owner.spawn(f, args);
        } else if (typeof f === 'function' && !f.$g) {
          try { f(...args); } catch (e) { console.error(e); }
        }
      }
    }
    if (this.waiting.length) {
      const w = this.waiting;
      this.waiting = [];
      for (const th of w) th.wake(args);
    }
  }
  disconnectAll() { for (const c of this.conns.slice()) c.disconnect(); this.waiting = []; }
}
