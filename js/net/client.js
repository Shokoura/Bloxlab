// Client side of replication: builds the client DataModel from the server's stream and sends
// remote calls, the local character's pose and the client-authoritative bits back.
import { Instance } from '../engine/instance.js';
import { createDataModel } from '../engine/datamodel.js';
import { isService } from '../engine/reflect.js';
import { setState, killHumanoid } from '../engine/classes/humanoid.js';
import { lerr } from '../engine/bridge.js';
import { encodeValue, decodeValue, decodePose } from './codec.js';
import { invokeLua, callbackReady, PROTOCOL } from './common.js';

export class ClientReplicator {
  /**
   * @param world client World (kind 'client')
   * @param transport { send, drain, close, local }
   * @param session receives onInit / onChat / onKicked / onAnimation ... callbacks
   */
  constructor(world, transport, session, hello) {
    this.world = world;
    this.transport = transport;
    this.session = session;
    this.byId = new Map();
    this.pendingRefs = new Map(); // id -> [{ inst, name }]
    this.calls = new Map();
    this.callSeq = 0;
    this.queue = [];
    this.interp = new Map(); // part -> { from, to, t, dur }
    this.ready = false;
    this.closed = false;
    this.ping = 0;
    this.encId = (i) => (i && i.netId !== undefined ? i.netId : null);
    this.decId = (id) => this.byId.get(id) || null;
    world.net = this.api();
    transport.onclose = () => { if (!this.closed) { this.closed = true; session.onDisconnected?.('Lost connection to the server'); } };
    this.send({ t: 'hello', v: PROTOCOL, ...hello });
    this.flush();
  }

  dispose() {
    this.closed = true;
    try { this.transport.close(); } catch { /* ignore */ }
    for (const p of this.calls.values()) p({ ok: 0, e: 'disconnected' });
    this.calls.clear();
    this.world.net = null;
  }

  send(m) { this.queue.push(m); }
  flush() {
    if (!this.queue.length || this.closed) return;
    const batch = this.queue;
    this.queue = [];
    try { this.transport.send(batch.length === 1 ? batch[0] : { t: 'b', m: batch }); } catch (e) { console.warn('[client] send failed', e); }
  }
  enc(v) { return encodeValue(v, this.encId); }
  dec(v) { return decodeValue(v, this.decId); }

  // ------------------------------------------------------------ building instances
  register(inst, id) {
    inst.netId = id;
    this.byId.set(id, inst);
    const waiting = this.pendingRefs.get(id);
    if (waiting) {
      this.pendingRefs.delete(id);
      for (const { inst: owner, name } of waiting) if (!owner.destroyed) this.applyProp(owner, name, inst);
    }
  }
  forget(inst) {
    inst.forTree((d) => { if (d.netId !== undefined && this.byId.get(d.netId) === d) this.byId.delete(d.netId); });
  }
  decodeProp(inst, name, w) {
    if (w && typeof w === 'object' && w.$ === 'i' && !this.byId.has(w.v)) {
      if (!this.pendingRefs.has(w.v)) this.pendingRefs.set(w.v, []);
      this.pendingRefs.get(w.v).push({ inst, name });
      return undefined;
    }
    return this.dec(w);
  }

  /** Creates (or refreshes) an instance tree from a serialized node; new trees are built detached. */
  materialize(node) {
    const existing = this.byId.get(node.i);
    if (existing && !existing.destroyed) {
      for (const [k, w] of Object.entries(node.p || {})) this.applyProp(existing, k, this.decodeProp(existing, k, w));
      for (const k of node.k || []) { const c = this.materialize(k); if (c.parent !== existing) c.setParent(existing); }
      return existing;
    }
    const inst = new Instance(node.c, this.world);
    for (const [k, w] of Object.entries(node.p || {})) {
      const v = this.decodeProp(inst, k, w);
      if (v !== undefined) inst.props[k] = v;
    }
    if (node.a) inst.attrs = new Map(node.a.map(([k, w]) => [k, this.dec(w)]));
    if (node.g) inst.tags = new Set(node.g);
    for (const k of node.k || []) {
      const c = this.materialize(k);
      if (c.parent) c.setParent(inst); else { c.parent = inst; inst.children.push(c); }
    }
    this.register(inst, node.i);
    return inst;
  }

  applyProp(inst, name, v) {
    try {
      if (name === 'CFrame' && inst.isA('BasePart')) { inst.rawSet('CFrame', v); return; }
      const acc = inst.beh.props[name];
      if (acc && acc.set && !acc.readonly) inst.set(name, v);
      else inst.rawSet(name, v);
    } catch {
      inst.rawSet(name, v);
    }
  }

  buildInit(m) {
    const w = this.world;
    const dm = createDataModel(w);
    this.register(dm, m.dm);
    for (const node of m.tree) {
      let svc = null;
      if (isService(node.c)) svc = dm.serviceFactory(node.c);
      if (svc) {
        for (const [k, x] of Object.entries(node.p || {})) { const v = this.decodeProp(svc, k, x); if (v !== undefined) svc.props[k] = v; }
        if (node.a) svc.attrs = new Map(node.a.map(([k, x]) => [k, this.dec(x)]));
        if (node.g) svc.tags = new Set(node.g);
        this.register(svc, node.i);
        for (const k of node.k || []) this.materialize(k).setParent(svc);
      } else this.materialize(node).setParent(dm);
    }
    w.setGameGlobals(dm);
    w.localPlayer = this.byId.get(m.lp) || null;
    this.ready = true;
    this.session.onInit?.(this, m);
  }

  // ------------------------------------------------------------ incoming
  receive() {
    for (const m of this.transport.drain()) {
      try { this.handle(m); } catch (e) { console.warn('[client] bad message', m && m.t, e); }
    }
  }
  handle(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'b': for (const x of m.m || []) this.handle(x); return;
      case 'init': this.buildInit(m); return;
      case 'ping': this.send({ t: 'pong', s: m.s }); return;
      case 'pong': this.ping = performance.now() - m.s; return;
      case 'kick': this.closed = true; this.session.onKicked?.(m.m || ''); return;
      default: break;
    }
    if (!this.ready) return;
    switch (m.t) {
      case 'a': {
        const parent = this.byId.get(m.p);
        if (!parent) return;
        const inst = this.materialize(m.n);
        if (inst.parent !== parent) inst.setParent(parent);
        break;
      }
      case 'r': {
        const inst = this.byId.get(m.i);
        if (!inst) return;
        this.interp.delete(inst);
        if (m.d) { this.forget(inst); inst.destroy(); } else inst.setParent(null);
        break;
      }
      case 'm': {
        const inst = this.byId.get(m.i), parent = this.byId.get(m.p);
        if (inst && parent && inst.parent !== parent && !parent.isDescendantOf(inst) && parent !== inst) inst.setParent(parent);
        break;
      }
      case 'p': {
        const inst = this.byId.get(m.i);
        if (inst) { const v = this.decodeProp(inst, m.n, m.v); if (v !== undefined || m.v === null) this.applyProp(inst, m.n, v); }
        break;
      }
      case 'at': { const inst = this.byId.get(m.i); if (inst) inst.setAttribute(m.n, this.dec(m.v)); break; }
      case 'tg': { const inst = this.byId.get(m.i); if (inst) { if (m.on) inst.addTag(m.g); else inst.removeTag(m.g); } break; }
      case 'ps': this.applyPoses(m.d); break;
      case 'tp': { const inst = this.byId.get(m.i); if (inst && inst.dm) { this.interp.delete(inst); this.movePart(inst, decodePose(m.d)); } this.tpAck = m.q; break; }
      case 'hs': {
        const h = this.byId.get(m.i);
        if (!h || h.ClassName !== 'Humanoid' || h.controller) return;
        if (m.s === 'Dead') killHumanoid(h); else setState(h, m.s);
        break;
      }
      case 're': {
        const r = this.byId.get(m.i);
        if (r && (r.ClassName === 'RemoteEvent' || r.ClassName === 'UnreliableRemoteEvent')) r.fire('OnClientEvent', ...(m.a || []).map((x) => this.dec(x)));
        break;
      }
      case 'rf': this.serveInvoke(m); break;
      case 'rfr': { const p = this.calls.get(m.c); if (p) { this.calls.delete(m.c); p(m); } break; }
      case 'an': this.session.onRemoteAnimation?.(m, this); break;
      case 'chat': this.session.onChatMessage?.(this.byId.get(m.p) || null, m.m, m); break;
      case 'sys': this.session.onSystemMessage?.(m.m, m.k); break;
      case 'astr': case 'apir': { const p = this.calls.get(`x${m.c}`); if (p) { this.calls.delete(`x${m.c}`); p(m); } break; }
      case 'mp': this.session.onPurchasePrompt?.(m); break;
      case 'cmd': this.session.onHostCommand?.(m); break;
      default: break;
    }
  }

  applyPoses(d) {
    const smooth = !this.transport.local;
    for (let i = 0; i + 7 < d.length; i += 8) {
      const inst = this.byId.get(d[i]);
      if (!inst || !inst.dm || inst.destroyed) continue;
      const cf = decodePose(d, i + 1);
      const local = this.session.isLocalCharacterPart?.(inst);
      if (local || !smooth) { this.interp.delete(inst); this.movePart(inst, cf); continue; }
      const cur = inst.props.CFrame;
      // big jumps (respawn, teleport) snap; small ones are smoothed over the update interval
      if (!cur || cur.Position.sub(cf.Position).Magnitude > 30) { this.interp.delete(inst); this.movePart(inst, cf); continue; }
      this.interp.set(inst, { from: cur, to: cf, t: 0, dur: 1 / 30 });
    }
  }
  movePart(inst, cf) {
    const h = this.world.hooks;
    if (h.moveAssembly) h.moveAssembly(inst, cf); else inst.rawSet('CFrame', cf);
  }
  /** Advances pose interpolation (network clients). */
  step(dt) {
    if (!this.interp.size) return;
    for (const [inst, s] of this.interp) {
      if (!inst.dm) { this.interp.delete(inst); continue; }
      s.t = Math.min(s.dur, s.t + dt);
      const a = s.t / s.dur;
      this.movePart(inst, a >= 1 ? s.to : s.from.lerp(s.to, a));
      if (a >= 1) this.interp.delete(inst);
    }
  }

  serveInvoke(m) {
    const rf = this.byId.get(m.i);
    const reply = (msg) => this.send({ t: 'rfr', c: m.c, ...msg });
    if (!rf || rf.ClassName !== 'RemoteFunction') { reply({ ok: 0, e: 'RemoteFunction not found' }); return; }
    const args = (m.a || []).map((x) => this.dec(x));
    callbackReady(rf, 'OnClientInvoke').then((cb) => invokeLua(this.world, cb, args)).then((r) => {
      if (r.ok) reply({ ok: 1, r: r.values.map((x) => this.enc(x)) });
      else reply({ ok: 0, e: r.error });
    });
  }

  /** Asks the host to fetch something on our behalf (External Load: host relay). */
  relay(kind, payload) {
    const c = ++this.callSeq;
    this.send({ t: kind, c, ...payload });
    this.flush();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(`x${c}`); reject(new Error('Host relay timed out')); }, 60000);
      this.calls.set(`x${c}`, (m) => { clearTimeout(timer); if (m.ok) resolve(m); else reject(new Error(m.e || 'Host relay failed')); });
    });
  }

  // ------------------------------------------------------------ world.net (engine side of remotes)
  api() {
    const self = this;
    return {
      fireServer(remote, args) {
        if (remote.netId === undefined) throw lerr('FireServer: this RemoteEvent does not exist on the server');
        self.send({ t: 're', i: remote.netId, a: args.map((x) => self.enc(x)) });
      },
      *invokeServer(remote, args) {
        if (remote.netId === undefined) throw lerr('InvokeServer: this RemoteFunction does not exist on the server');
        const id = ++self.callSeq;
        self.send({ t: 'rf', i: remote.netId, c: id, a: args.map((x) => self.enc(x)) });
        const res = yield* self.world.scheduler.waitFor((wake) => { self.calls.set(id, (r) => wake([r])); });
        const r = res[0];
        if (!r || !r.ok) throw lerr(r && r.e ? r.e : 'InvokeServer failed');
        return (r.r || []).map((x) => self.dec(x));
      },
      fireClient() { throw lerr('FireClient can only be called from the server'); },
      fireAllClients() { throw lerr('FireAllClients can only be called from the server'); },
      *invokeClient() { throw lerr('InvokeClient can only be called from the server'); },
    };
  }
}
