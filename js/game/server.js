// The game server: authoritative copy of the place, server scripts, physics, players and characters.
// Clients (local or remote) connect through transports and are kept in sync by ServerReplicator.
import { World } from '../engine/world.js';
import { Instance } from '../engine/instance.js';
import { createDataModel, ensureServiceChildren, DEFAULT_SERVICES } from '../engine/datamodel.js';
import { isService } from '../engine/reflect.js';
import { CFrame, Vector3, Color3 } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { stepTweens } from '../engine/classes/services.js';
import { stepAnimator } from '../engine/classes/animation.js';
import { killHumanoid, equipTool, unequipTool, rootPartOf, setState } from '../engine/classes/humanoid.js';
import { Physics, initRapier } from './physics.js';
import { CharacterController } from './controller.js';
import { buildRig, applyStarterSettings, spawnCFrame } from './characters.js';
import { ServerReplicator } from '../net/server.js';
import { explodeServer } from './effects-server.js';
import { toByteStr } from '../luau/runtime.js';

/** Deep copy of a DataModel into another world (services become real services there). */
export function cloneDataModel(src, world) {
  const copy = src.clone(true, null, world);
  const dm = createDataModel(world);
  dm.props.Name = src.props.Name || 'Game';
  for (const k of ['PlaceId', 'GameId', 'CreatorId', 'PlaceVersion']) if (src.props[k] !== undefined) dm.props[k] = src.props[k];
  const kids = copy.children.slice();
  copy.children = [];
  for (const c of kids) {
    c.parent = null;
    if (isService(c.ClassName)) c.isService = true;
    c.setParent(dm);
  }
  for (const s of DEFAULT_SERVICES) dm.serviceFactory(s);
  ensureServiceChildren(dm);
  return dm;
}

function pivotModel(model, cf) {
  const root = model.findFirstChild('HumanoidRootPart') || model.props.PrimaryPart || model.descendants().find((d) => d.isA('BasePart'));
  if (!root) return;
  const delta = cf.mul(root.props.CFrame.inverse());
  for (const d of model.descendants()) if (d.isA('BasePart')) d.props.CFrame = delta.mul(d.props.CFrame);
}

export class GameServer {
  constructor(app, sourceDM, { name = 'Server', onLog = null } = {}) {
    this.app = app;
    this.sourceDM = sourceDM;
    this.name = name;
    this.onLog = onLog;
    this.players = new Map(); // Player -> { conn, firstSpawn, respawnAt }
    this.time = 0;
    this.listeners = new Set();
  }

  async start() {
    const w = new World({ kind: 'server', app: this.app, name: this.name });
    this.world = w;
    w.onOutput((e) => { this.app?.output?.add(e); this.onLog?.(e); });
    const dm = cloneDataModel(this.sourceDM, w);
    w.setGameGlobals(dm);
    await initRapier();
    this.physics = new Physics(w, { role: 'server' });
    this.physics.remoteOwnedModels = new Set();
    this.replicator = new ServerReplicator(w, this);
    this.installHooks();
    this.unobserve = w.observe({ moved: (inst, oldParent) => this.onMoved(inst, oldParent), added: (inst) => this.onAdded(inst), removed: (inst, oldParent) => this.onRemoved(inst, oldParent) });
    dm.forTree((d) => { if (d.ClassName === 'Humanoid') this.maybeNPC(d); });
    w.start();
  }
  get serverPhysics() { return this.physics; }
  get dm() { return this.world.dm; }
  service(n) { return this.world.dm.serviceFactory(n); }

  stop() {
    for (const p of [...this.players.keys()]) { const s = this.players.get(p); if (s && s.conn) this.replicator.dropConnection(s.conn, 'server stopped'); }
    this.replicator?.dispose();
    this.unobserve?.();
    this.physics?.dispose();
    this.world?.stop();
  }

  emit(type, data) { for (const f of this.listeners) { try { f(type, data); } catch (e) { console.error(e); } } }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ------------------------------------------------------------ hooks scripts can reach
  installHooks() {
    const h = this.world.hooks;
    h.loadCharacter = (player, desc) => { this.loadCharacter(player, desc); };
    h.playerFromCharacter = (model) => this.playerFromCharacter(model);
    h.kick = (player, msg) => this.kick(player, msg);
    h.humanoidDied = (hum) => this.onHumanoidDied(hum);
    h.explode = (ex) => explodeServer(this.world, ex);
    h.purchasePrompt = (player, id, kind) => {
      const s = player && this.players.get(player);
      if (s && s.conn) s.conn.push({ t: 'mp', i: id, k: kind });
    };
    h.bubbleChat = (part, msg, color) => { this.replicator.broadcast({ t: 'chat', bubble: this.replicator.idOf(part), m: msg, color: color ? color.Name : null }); };
    h.emitParticles = (em, n) => { this.replicator.broadcast({ t: 'cmd', k: 'emit', i: this.replicator.idOf(em), n }); };
    h.clearParticles = (em) => { this.replicator.broadcast({ t: 'cmd', k: 'clearfx', i: this.replicator.idOf(em) }); };
    h.sit = (seat, hum) => this.seat(hum, seat);
    h.unsit = (hum) => this.unseat(hum);
    h.setCore = () => {};
    h.getCore = () => undefined;
    const avatars = () => this.app?.avatars;
    h.descriptionFromUserId = (id) => (avatars() ? avatars().descriptionFromUserId(this.world, id) : Promise.reject(new Error('avatars unavailable')));
    h.createCharacterModel = (desc, rig) => (avatars() ? avatars().createModel(this.world, desc, rig) : Promise.resolve(buildRig(this.world, rig || 'R15', { name: 'Character' })));
    h.applyDescription = (hum, desc) => (avatars() ? avatars().applyDescription(this.world, hum, desc) : Promise.resolve());
  }

  // ------------------------------------------------------------ players
  playerFromCharacter(model) {
    if (!model) return null;
    for (const p of this.players.keys()) if (p.props.Character === model) return p;
    return null;
  }

  /** A client sent its hello: create the Player and send the snapshot. */
  onHello(conn, hello) {
    if (conn.player) return;
    const w = this.world;
    const players = this.service('Players');
    const maxPlayers = players.props.MaxPlayers || 50;
    if (this.players.size >= maxPlayers) { conn.push({ t: 'kick', m: 'This server is full' }); this.replicator.flush(0); conn.transport.close(); return; }
    let name = String(hello.name || 'Player').replace(/[^\w]/g, '').slice(0, 20) || 'Player';
    const taken = new Set([...this.players.keys()].map((p) => p.props.Name));
    if (taken.has(name)) { let i = 2; while (taken.has(`${name}${i}`)) i++; name = `${name}${i}`; }
    const player = new Instance('Player', w);
    player.props.Name = name;
    const requested = String(hello.name || 'Player').replace(/[^\w]/g, '').slice(0, 20) || 'Player';
    player.props.DisplayName = name !== requested ? name : String(hello.displayName || name).slice(0, 30);
    player.props.UserId = Number(hello.userId) > 0 ? Number(hello.userId) : -conn.id;
    player.props.CharacterAppearanceId = player.props.UserId;
    player.avatar = hello.avatar || null;
    const bp = new Instance('Backpack', w); bp.props.Name = 'Backpack'; bp.parent = player; player.children.push(bp);
    const pg = new Instance('PlayerGui', w); pg.props.Name = 'PlayerGui'; pg.parent = player; player.children.push(pg);
    const sg = new Instance('StarterGear', w); sg.props.Name = 'StarterGear'; sg.parent = player; player.children.push(sg);
    conn.player = player;
    conn.name = name;
    conn.userId = player.props.UserId;
    conn.client = hello.client || {};
    this.players.set(player, { conn, firstSpawn: true, respawnAt: 0, joined: performance.now() });
    // default team assignment (AutoAssignable teams)
    const teams = this.service('Teams');
    const auto = teams ? teams.children.filter((t) => t.ClassName === 'Team' && t.props.AutoAssignable !== false) : [];
    if (auto.length) {
      const counts = auto.map((t) => [...this.players.keys()].filter((p) => p.props.Team === t).length);
      const t = auto[counts.indexOf(Math.min(...counts))];
      player.props.Team = t; player.props.TeamColor = t.props.TeamColor; player.props.Neutral = false;
    } else player.props.Neutral = true;
    player.setParent(players);
    this.replicator.sendInit(conn, { place: this.app?.project?.name || 'Place', server: this.name, players: this.players.size });
    players.fire('PlayerAdded', player);
    if (player.props.Team) player.props.Team.fire('PlayerAdded', player);
    this.emit('join', { player, conn });
    this.system(`${player.props.DisplayName} joined the game`);
    if (players.props.CharacterAutoLoads !== false) this.loadCharacter(player);
  }

  onLeave(conn, reason) {
    const player = conn.player;
    if (!player || !this.players.has(player)) return;
    this.players.delete(player);
    const players = this.service('Players');
    players.fire('PlayerRemoving', player);
    const ch = player.props.Character;
    if (ch) { player.fire('CharacterRemoving', ch); ch.destroy(); }
    player.destroy();
    this.emit('leave', { player, conn, reason });
    this.system(`${player.props.DisplayName} left the game`);
  }

  kick(player, msg) {
    const s = this.players.get(player);
    if (!s) return;
    s.conn.push({ t: 'kick', m: msg || 'You were kicked from this experience' });
    this.replicator.flush(0);
    this.emit('kick', { player, msg });
    setTimeout(() => this.replicator.dropConnection(s.conn, 'kicked'), 50);
  }

  system(text, kind = 'system') { this.replicator.broadcast({ t: 'sys', m: text, k: kind }); }

  onChat(conn, text) {
    const player = conn.player;
    if (!player || !text.trim()) return;
    player.fire('Chatted', toByteStr(text));
    this.replicator.broadcast({ t: 'chat', p: this.replicator.idOf(player), m: text });
    this.emit('chat', { player, text });
  }

  onClientLog(conn, m) { this.emit('clientlog', { player: conn.player, kind: m.k, msg: String(m.m || '').slice(0, 4000) }); }

  /** External Load "host relay": fetch assets / API calls for clients that cannot reach Roblox. */
  async onRelay(conn, m) {
    const app = this.app;
    const reply = (x) => { conn.push({ t: m.t === 'ast' ? 'astr' : 'apir', c: m.c, ...x }); };
    if (!app || !app.settings.get('shareWithPeers')) { reply({ ok: 0, e: 'The host does not share assets' }); return; }
    try {
      if (m.t === 'ast') {
        let bytes;
        if (m.url) bytes = await app.assets.fetchUrl(m.url);
        else bytes = (await app.assets.bytes(`rbxassetid://${m.id}`)).bytes;
        reply({ ok: 1, b: b64(bytes) });
        this.emit('relay', { player: conn.player, what: m.url || m.id, size: bytes.length });
      } else {
        const j = await app.assets.api(m.s, m.p);
        reply({ ok: 1, j });
      }
    } catch (e) { reply({ ok: 0, e: e.message }); }
  }

  onPurchaseResult(conn, m) {
    const mps = this.service('MarketplaceService');
    if (!mps || !conn.player) return;
    const ok = !!m.ok;
    if (m.k === 'product') {
      mps.fire('PromptProductPurchaseFinished', conn.player.props.UserId, m.i, ok);
      if (ok && mps.callbacks && mps.callbacks.ProcessReceipt) this.app?.output?.add({ msg: `Simulated purchase of developer product ${m.i}`, kind: 'info', world: 'server' });
      if (ok) mps.processReceipt?.(conn.player, m.i);
    } else if (m.k === 'gamepass') mps.fire('PromptGamePassPurchaseFinished', conn.player, m.i, ok);
    else if (m.k === 'subscription') mps.fire('PromptSubscriptionPurchaseFinished', conn.player, m.i, ok);
    else mps.fire('PromptPurchaseFinished', conn.player, m.i, ok);
  }

  // ------------------------------------------------------------ characters
  async buildCharacter(player, desc) {
    const w = this.world;
    const sp = this.service('StarterPlayer');
    const custom = sp && sp.findFirstChild('StarterCharacter');
    if (custom && custom.isA('Model')) {
      const m = custom.clone(true, null, w);
      m.props.Name = player.props.Name;
      return m;
    }
    const app = this.app;
    const rig = (app && app.settings.get('avatarRig')) || 'R15';
    const avatar = player.avatar;
    const local = !!this.players.get(player)?.conn?.transport?.local;
    const allowed = local || !app || app.settings.get('loadOtherAvatars') !== false;
    if (app && app.avatars && allowed && (desc || (avatar && avatar.mode && avatar.mode !== 'blocky'))) {
      try {
        const m = await app.avatars.characterFor(w, player, avatar, desc, rig);
        if (m) return m;
      } catch (e) { w.output(`Could not load avatar for ${player.props.Name}: ${e.message}`, 'warn'); }
    }
    const colors = avatar && avatar.colors ? Object.fromEntries(Object.entries(avatar.colors).map(([k, v]) => [k, new Color3(v[0], v[1], v[2])])) : undefined;
    return buildRig(w, rig, { name: player.props.Name, colors });
  }

  loadCharacter(player, desc) {
    const s = this.players.get(player);
    if (!s) return;
    const token = (s.spawnToken = (s.spawnToken || 0) + 1);
    this.buildCharacter(player, desc).then((model) => {
      if (s.spawnToken !== token || !player.dm) return;
      this.spawn(player, model);
    }).catch((e) => { console.error(e); this.world.output(`LoadCharacter failed: ${e.message}`, 'error'); });
  }

  spawn(player, model) {
    const w = this.world;
    const s = this.players.get(player);
    const ws = this.service('Workspace');
    const sp = this.service('StarterPlayer');
    const old = player.props.Character;
    if (old) {
      player.fire('CharacterRemoving', old);
      this.physics.remoteOwnedModels.delete(old);
      old.destroy();
    }
    model.props.Name = player.props.Name;
    const hum = model.findFirstChildOfClass('Humanoid');
    if (hum) {
      applyStarterSettings(hum, sp);
      hum.props.DisplayName = player.props.DisplayName;
      hum.props.Health = hum.props.MaxHealth ?? 100;
    }
    // StarterCharacterScripts (replace same-named defaults like Animate / Health)
    const scs = sp && sp.findFirstChildOfClass('StarterCharacterScripts');
    if (scs) for (const c of scs.children) {
      const existing = model.findFirstChild(c.props.Name);
      if (existing) { const i = model.children.indexOf(existing); model.children.splice(i, 1); existing.parent = null; }
      const cc = c.clone(false, null, w);
      if (cc) { cc.parent = model; model.children.push(cc); }
    }
    const { cf, spawn } = spawnCFrame(w, player, 3 + (hum ? 0 : 0));
    pivotModel(model, cf);
    // spawn protection
    const ffTime = spawn ? (spawn.props.Duration ?? 10) : 0;
    if (ffTime > 0) {
      const ff = new Instance('ForceField', w);
      ff.props.Name = 'ForceField';
      ff.parent = model; model.children.push(ff);
      w.scheduler.timer(ffTime, () => { if (ff.dm) ff.destroy(); });
    }
    if (spawn && spawn.props.AllowTeamChangeOnTouch && spawn.props.TeamColor) { /* handled by touch scripts */ }
    this.physics.remoteOwnedModels.add(model);
    model.setParent(ws);
    player.set('Character', model);
    s.firstSpawn = false;
    // StarterGui -> PlayerGui (ResetOnSpawn guis are recreated every spawn)
    const pg = player.findFirstChildOfClass('PlayerGui');
    const sg = this.service('StarterGui');
    if (pg && sg) {
      const reset = (g) => !(g.isA('LayerCollector') || g.ClassName === 'ScreenGui') || g.props.ResetOnSpawn !== false;
      const first = !s.guiInit;
      if (!first) for (const g of pg.children.slice()) if (g.fromStarter && reset(g)) g.destroy();
      for (const g of sg.children) {
        if (!first && !reset(g)) continue;
        const c = g.clone(false, null, w);
        if (c) { c.fromStarter = true; c.setParent(pg); }
      }
      s.guiInit = true;
    }
    // StarterPack + StarterGear -> Backpack
    const bp = player.findFirstChildOfClass('Backpack');
    if (bp) {
      bp.clearAllChildren();
      for (const src of [this.service('StarterPack'), player.findFirstChildOfClass('StarterGear')]) {
        if (!src) continue;
        for (const t of src.children) { const c = t.clone(false, null, w); if (c) c.setParent(bp); }
      }
    }
    player.fire('CharacterAdded', model);
    player.fire('CharacterAppearanceLoaded', model);
    s.respawnAt = 0;
    this.emit('spawn', { player, model });
  }

  /** Seat:Sit(humanoid) / a player touching a seat: weld the character to the seat. */
  seat(hum, seat) {
    const w = this.world;
    if (!hum || !seat || !hum.dm || !seat.dm || hum.state === 'Dead' || seat.props.Disabled === true) return;
    if (hum.seat === seat) return;
    if (seat.occupant && seat.occupant !== hum && seat.occupant.dm) return;
    if (hum.seat) this.unseat(hum);
    const root = rootPartOf(hum);
    if (!root) return;
    const r15 = !!hum.parent.findFirstChild('UpperTorso');
    const hip = hum.props.HipHeight > 0 ? hum.props.HipHeight : 2;
    const weld = new Instance('Weld', w);
    weld.props.Name = 'SeatWeld';
    weld.props.Part0 = seat;
    weld.props.Part1 = root;
    weld.props.C0 = new CFrame(0, seat.props.Size.Y / 2 + (r15 ? hip * 0.45 : 0) + root.props.Size.Y / 2 + (r15 ? 0 : 0.5), 0);
    weld.props.C1 = CFrame.identity;
    // like Roblox, the character moves onto the seat (not the seat to the character)
    const target = seat.props.CFrame.mul(weld.props.C0).mul(weld.props.C1.inverse());
    if (w.hooks.moveAssembly) w.hooks.moveAssembly(root, target); else root.rawSet('CFrame', target);
    hum.seat = seat;
    seat.occupant = hum;
    seat.rawSet('Occupant', hum);
    weld.setParent(seat);
    hum.rawSet('Sit', true);
    setState(hum, 'Seated');
    hum.fire('Seated', true, seat);
  }
  unseat(hum, jump) {
    const seat = hum && hum.seat;
    if (!seat) return;
    const root = rootPartOf(hum);
    for (const c of seat.children.slice()) if (c.props.Name === 'SeatWeld' && (!root || c.props.Part1 === root)) c.destroy();
    seat.occupant = null;
    seat.rawSet('Occupant', null);
    if (seat.ClassName === 'VehicleSeat') for (const k of ['Throttle', 'Steer', 'ThrottleFloat', 'SteerFloat']) seat.set(k, 0);
    hum.seat = null;
    hum.rawSet('Sit', false);
    setState(hum, jump ? 'Jumping' : 'Running');
    hum.fire('Seated', false, seat);
  }

  onHumanoidDied(hum) {
    const model = hum.parent;
    const player = this.playerFromCharacter(model);
    if (!player) return;
    const s = this.players.get(player);
    // let the body fall apart on the server
    this.physics.remoteOwnedModels.delete(model);
    for (const d of model.descendants()) if (d.isA('BasePart')) this.physics.dirty.add(d);
    const players = this.service('Players');
    if (players.props.CharacterAutoLoads !== false && s) s.respawnAt = this.time + (players.props.RespawnTime ?? 5);
    this.emit('died', { player });
  }

  /** NPC humanoids are simulated by the server. */
  maybeNPC(hum) {
    if (hum.controller || this.world.kind !== 'server') return;
    const model = hum.parent;
    if (!model || !hum.dm) return;
    if (this.physics.remoteOwnedModels.has(model) || this.playerFromCharacter(model)) return;
    const ws = this.service('Workspace');
    if (!model.isDescendantOf(ws)) return;
    if (!rootPartOf(hum)) return;
    new CharacterController(hum, this.world);
    for (const d of model.descendants()) if (d.isA('BasePart')) this.physics.dirty.add(d);
  }

  onAdded(inst) {
    if (inst.ClassName === 'Humanoid' || inst.isA('Model')) {
      // wait a frame: scripts usually finish building the model before we look at it
      this.world.scheduler.timer(0, () => inst.forTree((d) => { if (d.ClassName === 'Humanoid') this.maybeNPC(d); }));
    }
    this.toolMoved(inst, null);
  }
  onRemoved(inst, oldParent) { this.toolMoved(inst, oldParent); }
  onMoved(inst, oldParent) {
    this.toolMoved(inst, oldParent);
    if (inst.isA('Model') || inst.ClassName === 'Humanoid') this.world.scheduler.timer(0, () => inst.forTree((d) => { if (d.ClassName === 'Humanoid') this.maybeNPC(d); }));
  }

  /** Tools parented into a character are equipped, out of it unequipped. */
  toolMoved(inst, oldParent) {
    if (!inst.isA('Tool')) return;
    const wasIn = oldParent && oldParent.findFirstChildOfClass?.('Humanoid') ? oldParent : null;
    const nowIn = inst.parent && inst.parent.findFirstChildOfClass('Humanoid') ? inst.parent : null;
    if (wasIn && wasIn !== nowIn) {
      unequipTool(inst, wasIn);
      inst.fire('Unequipped');
    }
    if (nowIn && nowIn !== wasIn) {
      for (const other of nowIn.children) if (other !== inst && other.isA('Tool') && other.equippedIn) { /* engine allows only one; client enforces */ }
      equipTool(inst, nowIn);
      const player = this.playerFromCharacter(nowIn);
      const mouse = null;
      inst.fire('Equipped', mouse);
      void player;
    }
  }

  // ------------------------------------------------------------ frame
  tick(dt) {
    const w = this.world;
    this.time += dt;
    for (const s of this.players.values()) if (s.conn) this.replicator.receive(s.conn);
    for (const c of this.replicator.conns.values()) if (!c.player) this.replicator.receive(c);
    const rs = this.service('RunService');
    const t = w.scheduler.clock;
    rs.fire('Stepped', t, dt);
    rs.fire('PreSimulation', dt);
    this.physics.step(dt);
    rs.fire('PostSimulation', dt);
    rs.fire('Heartbeat', dt);
    w.scheduler.step(dt);
    stepTweens(w, dt);
    if (w.animators) for (const a of w.animators) { if (!a.dm) { w.animators.delete(a); continue; } stepAnimator(a, dt); }
    // respawns, regeneration, void kills
    const fall = this.service('Workspace').props.FallenPartsDestroyHeight ?? -500;
    for (const [player, s] of this.players) {
      if (s.respawnAt && this.time >= s.respawnAt) { s.respawnAt = 0; this.loadCharacter(player); }
      const ch = player.props.Character;
      const hum = ch && ch.findFirstChildOfClass('Humanoid');
      if (!hum || hum.state === 'Dead') continue;
      const root = rootPartOf(hum);
      if (root && root.props.CFrame.Y < fall) { killHumanoid(hum); continue; }
      if (!ch.findFirstChild('Health')) {
        const max = hum.props.MaxHealth ?? 100, hp = hum.props.Health ?? 100;
        if (hp < max && hp > 0) { s.regen = (s.regen || 0) + dt; if (s.regen >= 1) { s.regen = 0; hum.set('Health', Math.min(max, hp + max / 100)); } }
      }
    }
    this.replicator.flush(dt);
  }
}

function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }

export { CFrame, Vector3, E };
