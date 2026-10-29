// A play session: Play (server + local client), Run (server only), hosting for other players,
// joining someone else's game, and extra same-tab test players.
import { GameServer } from './server.js';
import { ClientRuntime } from './client.js';
import { loopbackPair } from '../net/transport.js';
import { SceneView } from '../render/scene.js';
import { CFrame } from '../engine/datatypes.js';

const b64bytes = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

export class PlaySession {
  /**
   * @param app Studio app
   * @param opts { mode: 'play'|'run'|'join', spawnAt?: CFrame, transport?: endpoint (join), players?: number }
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.mode = opts.mode || 'play';
    this.spawnAt = opts.spawnAt || null;
    this.joinTransport = opts.transport || null;
    this.extraPlayers = Math.max(0, (opts.players || 1) - 1);
    this.server = null;
    this.clients = [];
    this.active = null;
    this.viewing = 'client';
    this.hosts = []; // open listeners (peer / tab / manual)
    this.listeners = new Set();
    this.started = performance.now();
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const f of this.listeners) { try { f(type, data); } catch (e) { console.error(e); } } }

  get serverWorld() { return this.server ? this.server.world : null; }
  get clientWorld() { return this.active ? this.active.world : null; }
  get capturesKeys() { return !!this.active && this.viewing === 'client'; }

  playerIdentity(i = 0) {
    const s = this.app.settings;
    const nene = this.app.nene && this.app.nene.user;
    const base = (s.get('playerName') || (nene && nene.username) || 'Player').replace(/[^\w]/g, '').slice(0, 16) || 'Player';
    const colors = {};
    for (const [k, v] of Object.entries(s.get('blockyColors') || {})) { const n = parseInt(String(v).slice(1), 16); if (!Number.isNaN(n)) colors[k] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
    const avatar = { mode: s.get('avatarMode'), user: s.get('avatarUser') || '', rig: s.get('avatarRig'), colors: Object.keys(colors).length ? colors : undefined };
    const userId = /^\d+$/.test(avatar.user) ? Number(avatar.user) : 0;
    return { name: i ? `${base}${i + 1}` : base, displayName: i ? `${base} ${i + 1}` : base, userId: i ? 0 : userId, avatar: i ? { mode: 'blocky' } : avatar };
  }

  async start() {
    const app = this.app;
    if (this.mode === 'join') {
      const c = new ClientRuntime(app, this.joinTransport, { ...this.playerIdentity(0), label: 'Client', forwardLogs: true });
      this.clients.push(c);
      this.installRelay(c);
      await this.waitReady([c]);
      this.setActive(c);
      this.running = true;
      return;
    }
    this.server = new GameServer(app, app.editWorld.dm, { name: 'Server', onLog: (e) => this.emit('serverlog', e) });
    await this.server.start();
    this.server.on((type, data) => this.emit(type, data));
    if (this.spawnAt) this.installSpawnOverride(this.spawnAt);
    if (this.mode === 'run') {
      this.serverView = new SceneView(this.server.world, { assets: app.assets });
      app.viewport.setView(this.serverView, 'edit');
      this.viewing = 'server';
      this.running = true;
      return;
    }
    const first = this.addLocalPlayer(0);
    for (let i = 0; i < this.extraPlayers; i++) this.addLocalPlayer(i + 1);
    await this.waitReady(this.clients);
    this.setActive(first);
    this.running = true;
  }

  /** Loopback client in this tab (the Play player, or extra test players). */
  addLocalPlayer(index = this.clients.length) {
    const [a, b] = loopbackPair();
    this.server.replicator.addConnection(a);
    const c = new ClientRuntime(this.app, b, { ...this.playerIdentity(index), label: index ? `Client${index + 1}` : 'Client' });
    this.clients.push(c);
    this.emit('clients');
    return c;
  }
  async addTestPlayer() {
    if (!this.server) return null;
    const c = this.addLocalPlayer(this.clients.length);
    await this.waitReady([c]);
    return c;
  }
  removeClient(c) {
    c.stop();
    this.clients = this.clients.filter((x) => x !== c);
    if (this.active === c) this.setActive(this.clients[0] || null);
    this.emit('clients');
  }

  /** Pumps the worlds until the clients have their snapshot (start() runs before the frame loop). */
  async waitReady(clients) {
    const t0 = performance.now();
    let err = null;
    const all = Promise.all(clients.map((c) => c.start().catch((e) => { err = e; })));
    let done = false;
    all.then(() => { done = true; });
    while (!done) {
      if (err) throw err;
      if (performance.now() - t0 > 60000) throw new Error('Timed out waiting for the game to start');
      if (this.server) this.server.tick(1 / 60);
      for (const c of clients) c.tick(1 / 60);
      await new Promise((r) => setTimeout(r, this.mode === 'join' ? 30 : 0));
    }
    if (err) throw err;
  }

  installSpawnOverride(cf) {
    const srv = this.server;
    const orig = srv.spawn.bind(srv);
    let used = false;
    srv.spawn = (player, model) => {
      orig(player, model);
      if (used) return;
      used = true;
      const root = model.findFirstChild('HumanoidRootPart');
      if (root) {
        const look = cf.LookVector;
        const yaw = Math.atan2(-look.X, -look.Z);
        srv.world.hooks.moveAssembly?.(root, CFrame.fromPosRot(cf.X, cf.Y, cf.Z, CFrame.angles(0, yaw, 0).r));
      }
    };
  }

  /** Lets a remote client use this host as its "External Load" relay. */
  installRelay(c) {
    const assets = this.app.assets;
    this.savedRelay = { relay: assets.relay, relayApi: assets.relayApi, relayFetch: assets.relayFetch };
    assets.relay = async (id) => { const m = await c.replicator.relay('ast', { id }); const bytes = b64bytes(m.b); return { bytes }; };
    assets.relayApi = async (service, path) => (await c.replicator.relay('api', { s: service, p: path })).j;
    assets.relayFetch = async (url) => b64bytes((await c.replicator.relay('ast', { url })).b);
  }

  setActive(c) {
    if (this.active && this.active !== c) this.active.detach();
    this.active = c;
    this.viewing = 'client';
    if (c) c.attach(this.app.viewport);
    this.emit('active', c);
  }
  setViewWorld(which) {
    if (!this.server && which === 'server') return;
    if (which === 'server') {
      this.viewing = 'server';
      if (this.active) this.active.detach();
      if (!this.serverView) this.serverView = new SceneView(this.server.world, { assets: this.app.assets });
      const vp = this.app.viewport;
      const cam = this.active && this.active.world.dm.findFirstChildOfClass('Workspace').props.CurrentCamera;
      vp.setView(this.serverView, 'edit');
      if (cam && cam.props.CFrame) {
        const cf = cam.props.CFrame, look = cf.LookVector;
        vp.camera.position.set(cf.X, cf.Y, cf.Z);
        vp.yaw = Math.atan2(-look.X, -look.Z); vp.pitch = Math.asin(Math.max(-1, Math.min(1, look.Y)));
        vp.applyCameraAngles();
      }
    } else if (this.active) {
      this.viewing = 'client';
      this.active.attach(this.app.viewport);
    }
  }
  setAudioMuted(m) { this.app.audioMuted = m; if (this.active) this.active.sound.setMuted(m || !this.active.attached); }

  /** Accept a connection from another player (PeerJS / BroadcastChannel / manual WebRTC). */
  accept(endpoint, info = {}) {
    if (!this.server) { endpoint.close(); return null; }
    const conn = this.server.replicator.addConnection(endpoint);
    conn.remote = info;
    this.emit('remote', { conn, info });
    return conn;
  }
  addHost(h) { this.hosts.push(h); this.emit('hosting', h); }

  tick(dt) {
    if (!this.running) return; // start() pumps the worlds itself until everyone is connected
    if (this.server) this.server.tick(dt);
    for (const c of this.clients) c.tick(dt);
  }

  stop() {
    for (const h of this.hosts) { try { h.close(); } catch { /* ignore */ } }
    this.hosts = [];
    for (const c of this.clients) { try { c.stop(); } catch (e) { console.error(e); } }
    this.clients = [];
    this.active = null;
    if (this.serverView) this.serverView.dispose();
    if (this.server) { try { this.server.stop(); } catch (e) { console.error(e); } }
    if (this.savedRelay) Object.assign(this.app.assets, this.savedRelay);
    this.emit('stopped');
  }

  statusText() {
    const secs = Math.floor((performance.now() - this.started) / 1000);
    const t = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (this.mode === 'run') return `Running · ${t}`;
    if (this.mode === 'join') return `Connected · ${this.active ? this.active.statusText() : ''}`;
    const remote = this.server ? [...this.server.replicator.conns.values()].filter((c) => !c.transport.local).length : 0;
    return `Playing · ${t}${this.clients.length > 1 ? ` · ${this.clients.length} local players` : ''}${remote ? ` · ${remote} remote` : ''}${this.hosts.length ? ' · hosting' : ''}`;
  }
}
