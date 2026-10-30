// Server side of replication: mirrors the server DataModel to every connected client, routes
// remote events / functions, and applies the few things clients are allowed to send
// (their character pose and animations, tool equips and activations, clicks, prompts, chat).
import { Instance } from '../engine/instance.js';
import { Vector3, CFrame } from '../engine/datatypes.js';
import { setState, killHumanoid } from '../engine/classes/humanoid.js';
import { lerr } from '../engine/bridge.js';
import { EMPTY } from '../luau/runtime.js';
import { encodeValue, decodeValue, encodePose, decodePose } from './codec.js';
import { invokeLua, callbackReady, isServerOnlyScript, PROTOCOL } from './common.js';

const HIDDEN_SERVICES = new Set(['ServerScriptService', 'ServerStorage']);
const SKIP_PROPS = new Set(['CurrentCamera']);
// what a player's scripts may change on parts they own (vehicles, physics controllers)
const OWNED_CLASSES = /Constraint$|^Body|^(VehicleSeat|LinearVelocity|AngularVelocity|VectorForce|LineForce|Torque|AlignPosition|AlignOrientation)$/;

class Conn {
  constructor(id, transport) {
    this.id = id;
    this.transport = transport;
    this.player = null;
    this.ready = false;
    this.queue = [];
    this.props = new Map(); // coalesced property / attribute messages, flushed before structural ones
    this.poses = new Set();
    this.poseAcc = 0;
    this.poseInterval = transport.local ? 0 : 1 / 30;
    this.name = '';
    this.userId = 0;
    this.ping = 0;
    this.stats = { sent: 0, recv: 0, bytesIn: 0 };
  }
  flushProps() {
    if (!this.props.size) return;
    for (const m of this.props.values()) this.queue.push(m);
    this.props.clear();
  }
  push(m) { this.flushProps(); this.queue.push(m); }
}

/** null = everyone, Player = only that player's client, false = nobody */
function scopeOf(inst) {
  let owner = null;
  for (let p = inst; p; p = p.parent) {
    const parent = p.parent;
    if (!parent) return p.ClassName === 'DataModel' ? owner : false;
    if (parent.ClassName === 'DataModel' && !parent.parent) {
      if (HIDDEN_SERVICES.has(p.ClassName) && p !== inst) return false;
      return owner;
    }
    if (p.ClassName === 'Camera' && parent.ClassName === 'Workspace') return false;
    if (p.ClassName === 'PlayerGui' && parent.ClassName === 'Player') owner = parent;
  }
  return false;
}
/** Scope a child would have under `parent` (used for instances that just left it). */
function scopeUnder(parent, child) {
  if (!parent) return false;
  if (parent.ClassName === 'DataModel' && !parent.parent) return null;
  if (child.ClassName === 'Camera' && parent.ClassName === 'Workspace') return false;
  if (parent.parent && parent.parent.ClassName === 'DataModel' && !parent.parent.parent && HIDDEN_SERVICES.has(parent.ClassName)) return false;
  const s = scopeOf(parent);
  if (s === false) return false;
  if (child.ClassName === 'PlayerGui' && parent.ClassName === 'Player') return parent;
  return s;
}
const visible = (scope, conn) => scope !== false && (scope === null || scope === conn.player);
function inWorkspace(inst) {
  for (let p = inst.parent; p; p = p.parent) {
    if (p.ClassName === 'Workspace') return true;
    if (p.ClassName === 'Camera') return false;
  }
  return false;
}

export class ServerReplicator {
  constructor(world, session) {
    this.world = world;
    this.session = session;
    this.ids = new Map();
    this.byId = new Map();
    this.nextId = 1;
    this.conns = new Map();
    this.nextConn = 1;
    this.movedParts = new Map(); // part -> origin connection id (0 = server)
    this.humanoids = new Set();
    this.origin = 0;
    this.calls = new Map();
    this.callSeq = 0;
    this.encId = (i) => this.idOf(i);
    this.decId = (id) => this.byId.get(id) || null;
    world.net = this.api();
    this.idOf(world.dm);
    world.dm.forTree((d) => { if (d.ClassName === 'Humanoid') this.humanoids.add(d); });
    this.unobserve = world.observe({
      added: (inst) => this.onAdded(inst),
      removed: (inst, oldParent) => this.onRemoved(inst, oldParent),
      moved: (inst, oldParent) => this.onMoved(inst, oldParent),
      propChanged: (inst, name) => this.onProp(inst, name),
      attrChanged: (inst, name) => this.onAttr(inst, name),
      tagChanged: (inst, tag, on) => this.onTag(inst, tag, on),
    });
  }

  dispose() {
    this.unobserve();
    for (const c of this.conns.values()) { try { c.transport.close(); } catch { /* ignore */ } }
    this.conns.clear();
    for (const p of this.calls.values()) p.resolve({ ok: false, error: 'server shut down' });
    this.world.net = null;
  }

  idOf(inst) {
    if (!inst) return null;
    let id = this.ids.get(inst);
    if (id === undefined) { id = this.nextId++; this.ids.set(inst, id); this.byId.set(id, inst); }
    return id;
  }
  forget(inst) {
    inst.forTree((d) => { const id = this.ids.get(d); if (id !== undefined) { this.ids.delete(d); this.byId.delete(id); } });
  }
  enc(v) { return encodeValue(v, this.encId); }
  dec(v) { return decodeValue(v, this.decId); }

  // ------------------------------------------------------------ connections
  addConnection(transport) {
    const conn = new Conn(this.nextConn++, transport);
    this.conns.set(conn.id, conn);
    transport.onclose = () => this.dropConnection(conn, 'disconnected');
    return conn;
  }
  dropConnection(conn, reason) {
    if (!this.conns.has(conn.id)) return;
    this.conns.delete(conn.id);
    for (const [c, p] of this.calls) if (p.conn === conn) { this.calls.delete(c); p.resolve({ ok: false, error: 'player left' }); }
    this.session.onLeave?.(conn, reason);
    try { conn.transport.close(); } catch { /* ignore */ }
  }
  connOf(player) { for (const c of this.conns.values()) if (c.player === player) return c; return null; }

  serialize(inst, conn) {
    const node = { i: this.idOf(inst), c: inst.ClassName, p: this.encodeProps(inst) };
    if (inst.attrs && inst.attrs.size) node.a = [...inst.attrs].map(([k, v]) => [k, this.enc(v)]);
    if (inst.tags && inst.tags.size) node.g = [...inst.tags];
    const hideKids = inst.parent && inst.parent.ClassName === 'DataModel' && HIDDEN_SERVICES.has(inst.ClassName);
    if (!hideKids && inst.children.length) {
      const kids = [];
      for (const c of inst.children) {
        if (c.ClassName === 'Camera' && inst.ClassName === 'Workspace') continue;
        if (c.ClassName === 'PlayerGui' && inst.ClassName === 'Player' && inst !== conn.player) continue;
        kids.push(this.serialize(c, conn));
      }
      if (kids.length) node.k = kids;
    }
    return node;
  }
  encodeProps(inst) {
    const out = {};
    const stripSource = isServerOnlyScript(inst);
    for (const k of Object.keys(inst.props)) {
      if (SKIP_PROPS.has(k) || (stripSource && k === 'Source')) continue;
      const v = inst.props[k];
      if (typeof v === 'function') continue;
      out[k] = this.enc(v);
    }
    return out;
  }

  /** Sends the initial snapshot; the connection receives incremental changes from then on. */
  sendInit(conn, info = {}) {
    const dm = this.world.dm;
    const tree = dm.children.map((s) => this.serialize(s, conn));
    conn.push({ t: 'init', v: PROTOCOL, dm: this.idOf(dm), lp: this.idOf(conn.player), tree, info });
    conn.ready = true;
  }

  each(scope, fn, except = 0) {
    for (const c of this.conns.values()) if (c.ready && c.id !== except && visible(scope, c)) fn(c);
  }
  broadcast(msg, except = 0) { for (const c of this.conns.values()) if (c.ready && c.id !== except) c.push(msg); }

  // ------------------------------------------------------------ change tracking
  onAdded(inst) {
    inst.forTree((d) => { if (d.ClassName === 'Humanoid') this.humanoids.add(d); });
    const scope = scopeOf(inst);
    if (scope === false) return;
    const parentId = this.idOf(inst.parent);
    this.each(scope, (c) => c.push({ t: 'a', p: parentId, n: this.serialize(inst, c) }));
  }
  onRemoved(inst, oldParent) {
    const id = this.ids.get(inst);
    // children of an instance being destroyed are covered by the parent's message
    if (id !== undefined && !(oldParent && oldParent.destroyed)) {
      const scope = scopeUnder(oldParent, inst);
      if (scope !== false) this.each(scope, (c) => c.push({ t: 'r', i: id, d: inst.destroyed ? 1 : 0 }));
    }
    if (inst.destroyed) this.forget(inst);
  }
  onMoved(inst, oldParent) {
    const before = scopeUnder(oldParent, inst);
    const after = scopeOf(inst);
    const id = this.idOf(inst);
    for (const c of this.conns.values()) {
      if (!c.ready) continue;
      const was = visible(before, c), now = visible(after, c);
      if (was && now) c.push({ t: 'm', i: id, p: this.idOf(inst.parent) });
      else if (now) c.push({ t: 'a', p: this.idOf(inst.parent), n: this.serialize(inst, c) });
      else if (was) c.push({ t: 'r', i: id, d: 0 });
    }
  }
  onProp(inst, name) {
    if (SKIP_PROPS.has(name)) return;
    if (name === 'Source' && isServerOnlyScript(inst)) return;
    if (name === 'CFrame' && inst.isA('BasePart') && inWorkspace(inst)) {
      if (this.origin === 0 && inst.props.Name === 'HumanoidRootPart') this.serverMovedCharacter(inst);
      const prev = this.movedParts.get(inst);
      this.movedParts.set(inst, prev === undefined || prev === this.origin ? this.origin : 0);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(inst.props, name) && !(name in inst.cls.defaults)) return;
    const scope = scopeOf(inst);
    if (scope === false || !this.anyReady()) return;
    const id = this.idOf(inst);
    const v = inst.props[name];
    if (typeof v === 'function') return;
    const msg = { t: 'p', i: id, n: name, v: this.enc(v) };
    const key = `${id}\u0000${name}`;
    this.each(scope, (c) => { c.props.delete(key); c.props.set(key, msg); }, this.propOrigin || 0);
  }
  onAttr(inst, name) {
    const scope = scopeOf(inst);
    if (scope === false || !this.anyReady()) return;
    const id = this.idOf(inst);
    const msg = { t: 'at', i: id, n: name, v: this.enc(inst.attrs ? inst.attrs.get(name) : undefined) };
    const key = `${id}\u0001${name}`;
    this.each(scope, (c) => { c.props.delete(key); c.props.set(key, msg); });
  }
  onTag(inst, tag, on) {
    const scope = scopeOf(inst);
    if (scope === false) return;
    const id = this.idOf(inst);
    this.each(scope, (c) => c.push({ t: 'tg', i: id, g: tag, on: on ? 1 : 0 }));
  }
  /**
   * The server moved a player's character (teleport, PivotTo, seat...). The owning client must take
   * the new pose, and its in-flight (older) poses are ignored until it acknowledges this teleport.
   */
  /** True when this part's assembly is a character walked by its player's client. */
  clientDriven(part) {
    const info = this.session.physics?.parts.get(part);
    return !!(info && info.asm && info.asm.remoteDriven);
  }
  serverMovedCharacter(root) {
    const model = root.parent;
    if (!model || !this.clientDriven(root)) return;
    const pl = this.session.playerFromCharacter?.(model);
    const c = pl && this.connOf(pl);
    if (!c || !c.ready) return;
    if (!c.tpPending) c.tpSeq = (c.tpSeq || 0) + 1;
    c.tpPending = root;
  }
  anyReady() { for (const c of this.conns.values()) if (c.ready) return true; return false; }

  rootOf(part) {
    const ph = this.session.serverPhysics;
    const info = ph && ph.parts.get(part);
    return info && info.asm ? info.asm.root : part;
  }

  /** Called once per server frame: humanoid states, poses, then one batch per connection. */
  flush(dt) {
    for (const h of this.humanoids) {
      if (!h.dm || h.destroyed) { this.humanoids.delete(h); continue; }
      if (h.state !== h.netState) {
        h.netState = h.state;
        if (scopeOf(h) !== false) this.broadcast({ t: 'hs', i: this.idOf(h), s: h.state }, h.stateOrigin || 0);
        h.stateOrigin = 0;
      }
    }
    if (this.movedParts.size) {
      const roots = new Map();
      for (const [p, origin] of this.movedParts) {
        if (!p.dm || p.destroyed) continue;
        const r = this.rootOf(p);
        if (r !== p && !this.movedParts.has(r)) continue; // only joint offsets changed (animation)
        const prev = roots.get(r);
        roots.set(r, prev === undefined || prev === origin ? origin : 0);
      }
      this.movedParts.clear();
      for (const [r, origin] of roots) {
        const scope = scopeOf(r);
        if (scope === false) continue;
        let owner = null;
        if (this.clientDriven(r)) { const pl = this.session.playerFromCharacter?.(r.parent); owner = pl ? this.connOf(pl) : null; }
        for (const c of this.conns.values()) if (c.ready && c.id !== origin && c !== owner && visible(scope, c)) c.poses.add(r);
      }
    }
    for (const c of this.conns.values()) {
      if (!c.ready) continue;
      if (c.tpPending) {
        const r = c.tpPending;
        c.tpPending = null;
        if (r.dm && !r.destroyed) c.push({ t: 'tp', i: this.idOf(r), d: encodePose(r.props.CFrame), q: c.tpSeq });
      }
      c.poseAcc += dt;
      if (c.poses.size && c.poseAcc >= c.poseInterval) {
        c.poseAcc = 0;
        const d = [];
        for (const r of c.poses) {
          if (!r.dm || r.destroyed) continue;
          const id = this.ids.get(r);
          if (id === undefined) continue;
          d.push(id, ...encodePose(r.props.CFrame));
        }
        c.poses.clear();
        if (d.length) c.push({ t: 'ps', d });
      }
      c.flushProps();
      if (c.queue.length) {
        const batch = c.queue;
        c.queue = [];
        c.stats.sent += batch.length;
        try { c.transport.send({ t: 'b', m: batch }); } catch (e) { console.warn('send failed', e); this.dropConnection(c, 'send failed'); }
      }
    }
  }

  // ------------------------------------------------------------ incoming
  receive(conn) {
    const msgs = conn.transport.drain();
    for (const m of msgs) {
      conn.stats.recv++;
      try { this.handle(conn, m); } catch (e) { console.warn('[server] bad message', m && m.t, e); }
    }
  }
  handle(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'b') { for (const x of m.m || []) this.handle(conn, x); return; }
    if (m.t === 'hello') { this.session.onHello(conn, m); return; }
    if (m.t === 'ping') { conn.push({ t: 'pong', s: m.s }); return; }
    if (m.t === 'pong') { conn.ping = performance.now() - m.s; if (conn.player) conn.player.ping = conn.ping; return; }
    if (!conn.player) return;
    const P = conn.player;
    switch (m.t) {
      case 're': {
        const r = this.byId.get(m.i);
        if (r && (r.ClassName === 'RemoteEvent' || r.ClassName === 'UnreliableRemoteEvent')) r.fire('OnServerEvent', P, ...(m.a || []).map((x) => this.dec(x)));
        break;
      }
      case 'rf': this.serveInvoke(conn, m); break;
      case 'rfr': { const p = this.calls.get(m.c); if (p) { this.calls.delete(m.c); p.resolve(m); } break; }
      case 'ch': this.applyCharacter(conn, m); break;
      case 'an': {
        const h = this.byId.get(m.h);
        if (h && P.props.Character && h.isDescendantOf(P.props.Character)) this.broadcast(m, conn.id);
        break;
      }
      case 'eq': {
        const tool = this.byId.get(m.i);
        const ch = P.props.Character;
        const bp = P.findFirstChildOfClass('Backpack');
        if (!tool || !tool.isA('Tool') || !ch) break;
        if (!(tool.isDescendantOf(ch) || (bp && tool.isDescendantOf(bp)))) break;
        if (m.on) {
          for (const other of ch.children.slice()) if (other !== tool && other.isA('Tool')) other.setParent(bp || null);
          tool.setParent(ch);
        } else if (m.drop) {
          if (tool.props.CanBeDropped !== false) {
            tool.setParent(this.world.dm.findFirstChildOfClass('Workspace'));
            const hrp = ch.findFirstChild('HumanoidRootPart'), handle = tool.findFirstChild('Handle');
            if (hrp && handle) this.world.hooks.moveAssembly?.(handle, hrp.props.CFrame.mul(new CFrame(0, 0, -4)));
          }
        } else tool.setParent(bp || null);
        break;
      }
      case 'ac': {
        const tool = this.byId.get(m.i);
        if (tool && tool.isA('Tool') && P.props.Character && tool.parent === P.props.Character) tool.fire(m.k === 'd' ? 'Deactivated' : 'Activated');
        break;
      }
      case 'cd': {
        const cd = this.byId.get(m.i);
        if (cd && cd.ClassName === 'ClickDetector') {
          const ev = { c: 'MouseClick', r: 'RightMouseClick', he: 'MouseHoverEnter', hl: 'MouseHoverLeave' }[m.k || 'c'];
          if (ev) cd.fire(ev, P);
        }
        break;
      }
      case 'pp': {
        const pp = this.byId.get(m.i);
        if (pp && pp.ClassName === 'ProximityPrompt' && pp.props.Enabled !== false) {
          const ev = { t: 'Triggered', e: 'TriggerEnded', hb: 'PromptButtonHoldBegan', he: 'PromptButtonHoldEnded' }[m.k];
          if (ev) { pp.fire(ev, P); const svc = this.world.dm.findFirstChildOfClass('ProximityPromptService'); if (svc) svc.fire(`Prompt${ev}`, pp, P); }
        }
        break;
      }
      case 'dd': {
        const dd = this.byId.get(m.i);
        if (dd && dd.ClassName === 'DragDetector') dd.fire(m.k === 's' ? 'DragStart' : m.k === 'e' ? 'DragEnd' : 'DragContinue', P);
        break;
      }
      case 'sit': {
        const seat = this.byId.get(m.i);
        const ch = P.props.Character;
        const hum = ch && ch.findFirstChildOfClass('Humanoid');
        const root = ch && (ch.findFirstChild('HumanoidRootPart') || ch.props.PrimaryPart);
        if (seat && hum && root && (seat.ClassName === 'Seat' || seat.ClassName === 'VehicleSeat') && seat.props.CFrame.Position.sub(root.props.CFrame.Position).Magnitude < 12) this.session.seat?.(hum, seat);
        break;
      }
      case 'unsit': { const ch = P.props.Character; const hum = ch && ch.findFirstChildOfClass('Humanoid'); if (hum && hum.seat) this.session.unseat?.(hum, true); break; }
      case 'drive': {
        const ch = P.props.Character;
        const hum = ch && ch.findFirstChildOfClass('Humanoid');
        const seat = hum && hum.seat;
        if (seat && seat.ClassName === 'VehicleSeat') {
          const th = Math.max(-1, Math.min(1, Number(m.th) || 0)), st = Math.max(-1, Math.min(1, Number(m.st) || 0));
          seat.set('ThrottleFloat', th); seat.set('Throttle', Math.round(th)); seat.set('SteerFloat', st); seat.set('Steer', Math.round(st));
        }
        break;
      }
      case 'op': {
        // a property changed by the player's scripts on something the server let them own
        const inst = this.byId.get(m.i);
        if (!inst || !this.owns(P, inst) || typeof m.n !== 'string') break;
        this.propOrigin = conn.id;
        try { inst.set(m.n, this.dec(m.v)); } catch { /* invalid value */ } finally { this.propOrigin = 0; }
        break;
      }
      case 'chat': this.session.onChat?.(conn, String(m.m || '').slice(0, 200)); break;
      case 'reset': { const ch = P.props.Character; const hum = ch && ch.findFirstChildOfClass('Humanoid'); if (hum) killHumanoid(hum); break; }
      case 'log': this.session.onClientLog?.(conn, m); break;
      case 'ast': case 'api': this.session.onRelay?.(conn, m); break;
      case 'mp': this.session.onPurchaseResult?.(conn, m); break;
      default: break;
    }
  }

  /** Network ownership: the parts behind an instance belong to this player (SetNetworkOwner or driving it). */
  owns(player, inst) {
    const parts = [];
    if (inst.isA('BasePart')) parts.push(inst);
    else if (inst.parent && inst.parent.isA && inst.parent.isA('BasePart')) parts.push(inst.parent);
    for (const k of ['Attachment0', 'Attachment1']) { const a = inst.props[k]; if (a && a.parent && a.parent.isA && a.parent.isA('BasePart')) parts.push(a.parent); }
    if (!parts.length || !OWNED_CLASSES.test(inst.ClassName)) return false;
    const ph = this.session.physics;
    const ch = player.props.Character;
    const hum = ch && ch.findFirstChildOfClass('Humanoid');
    for (const p of parts) {
      if (p.networkOwner === player) return true;
      const asm = ph && ph.parts.get(p)?.asm;
      if (!asm) continue;
      for (const q of asm.parts) { if (q.networkOwner === player) return true; if (hum && hum.seat === q) return true; }
    }
    return false;
  }

  applyCharacter(conn, m) {
    const ch = conn.player.props.Character;
    if (!ch || !ch.dm || (m.c !== undefined && this.ids.get(ch) !== m.c)) return;
    const hrp = ch.findFirstChild('HumanoidRootPart') || ch.props.PrimaryPart;
    const hum = ch.findFirstChildOfClass('Humanoid');
    if (hrp && m.d && (m.q || 0) >= (conn.tpSeq || 0) && this.clientDriven(hrp)) {
      this.origin = conn.id;
      try {
        const cf = decodePose(m.d);
        if (this.world.hooks.moveAssembly) this.world.hooks.moveAssembly(hrp, cf); else hrp.rawSet('CFrame', cf);
      } finally { this.origin = 0; }
    }
    if (hum) {
      if (m.s && m.s !== hum.state && hum.state !== 'Dead') { setState(hum, m.s); hum.stateOrigin = conn.id; }
      if (m.md) hum.moveDir = new Vector3(m.md[0], m.md[1], m.md[2]);
      if (m.v && hrp) hrp.netVelocity = new Vector3(m.v[0], m.v[1], m.v[2]);
      if (m.j !== undefined) hum.props.Jump = !!m.j;
      if (m.st !== undefined && !!m.st !== !!hum.seat) { /* seat state is owned by the client controller */ }
    }
  }

  serveInvoke(conn, m) {
    const rf = this.byId.get(m.i);
    const reply = (msg) => { if (this.conns.has(conn.id)) conn.push({ t: 'rfr', c: m.c, ...msg }); };
    if (!rf || rf.ClassName !== 'RemoteFunction') { reply({ ok: 0, e: 'RemoteFunction not found' }); return; }
    const args = (m.a || []).map((x) => this.dec(x));
    callbackReady(rf, 'OnServerInvoke').then((cb) => invokeLua(this.world, cb, [conn.player, ...args])).then((r) => {
      if (r.ok) reply({ ok: 1, r: r.values.map((x) => this.enc(x)) });
      else reply({ ok: 0, e: r.error });
    });
  }

  // ------------------------------------------------------------ world.net (engine side of remotes)
  api() {
    const self = this;
    return {
      fireServer() { throw lerr('FireServer can only be called from the client'); },
      fireClient(remote, player, args) {
        const c = self.connOf(player);
        if (!c || !c.ready) return;
        c.push({ t: 're', i: self.idOf(remote), a: args.map((x) => self.enc(x)) });
      },
      fireAllClients(remote, args) {
        const msg = { t: 're', i: self.idOf(remote), a: args.map((x) => self.enc(x)) };
        self.broadcast(msg);
      },
      *invokeClient(remote, player, args) {
        const c = self.connOf(player);
        if (!c || !c.ready) throw lerr('InvokeClient: player is not connected');
        const id = ++self.callSeq;
        c.push({ t: 'rf', i: self.idOf(remote), c: id, a: args.map((x) => self.enc(x)) });
        const res = yield* self.world.scheduler.waitFor((wake) => { self.calls.set(id, { conn: c, resolve: (r) => wake([r]) }); });
        const r = res[0];
        if (!r || !r.ok) throw lerr(r && r.e ? r.e : 'InvokeClient failed');
        return (r.r || []).map((x) => self.dec(x));
      },
      *invokeServer() { throw lerr('InvokeServer can only be called from the client'); },
    };
  }
}

export { scopeOf, Instance, EMPTY };
