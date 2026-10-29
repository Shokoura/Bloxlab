// A game client: its own World built from the server's replication stream, client physics for the
// local character, LocalScripts, and (while attached to the Studio viewport) rendering, input, GUI,
// HUD and audio.
import { World } from '../engine/world.js';
import { Instance } from '../engine/instance.js';
import { Vector3 } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { stepTweens } from '../engine/classes/services.js';
import { stepAnimator, loadAnimation, ensureAnimator } from '../engine/classes/animation.js';
import { rootPartOf } from '../engine/classes/humanoid.js';
import { Physics, initRapier } from './physics.js';
import { CharacterController } from './controller.js';
import { ClientReplicator } from '../net/client.js';
import { encodePose } from '../net/codec.js';
import { SceneView } from '../render/scene.js';
import { CameraController } from './camera.js';
import { Input } from './input.js';
import { DefaultAnimator } from './animate.js';
import { SoundSystem } from './sound.js';
import { toByteStr } from '../luau/runtime.js';

let clientSeq = 0;

export class ClientRuntime {
  /**
   * @param app Studio app (output, settings, assets, viewport)
   * @param transport endpoint connected to a GameServer
   * @param opts { name, userId, avatar, label, forwardLogs }
   */
  constructor(app, transport, opts = {}) {
    this.app = app;
    this.opts = opts;
    this.label = opts.label || `Client${++clientSeq > 1 ? clientSeq : ''}`;
    this.world = new World({ kind: 'client', app, name: this.label });
    this.world.onOutput((e) => {
      app?.output?.add(e);
      if (opts.forwardLogs && this.replicator && this.replicator.ready && (e.kind === 'error' || e.kind === 'warn' || e.kind === 'output')) this.replicator.send({ t: 'log', k: e.kind, m: e.msg.slice(0, 2000) });
    });
    this.character = null;
    this.humanoid = null;
    this.attached = false;
    this.chatLog = [];
    this.listeners = new Set();
    this.poseAcc = 0;
    this.lastPose = null;
    this.lastPoseAt = 0;
    this.time = 0;
    this.remoteTracks = new Map();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.replicator = new ClientReplicator(this.world, transport, this, {
      name: opts.name || 'Player', displayName: opts.displayName || opts.name, userId: opts.userId || 0, avatar: opts.avatar || null,
      client: { agent: 'bloxlab', touch: globalThis.matchMedia?.('(pointer: coarse)').matches || false },
    });
    this.rapierReady = false;
    initRapier().then(() => { this.rapierReady = true; });
    this.sound = new SoundSystem(this);
    this.sound.setMuted(true);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const f of this.listeners) { try { f(type, data); } catch (e) { console.error(e); } } }

  async start(timeout = 45000) {
    await initRapier();
    const t = setTimeout(() => this.rejectReady(new Error('Timed out waiting for the server')), timeout);
    try { await this.ready; } finally { clearTimeout(t); }
  }

  get dm() { return this.world.dm; }
  get localPlayer() { return this.world.localPlayer; }
  service(n) { return this.world.dm.serviceFactory(n); }

  // ------------------------------------------------------------ replication callbacks
  onInit() {
    const w = this.world;
    const ws = this.service('Workspace');
    const cam = new Instance('Camera', w);
    cam.props.Name = 'Camera';
    cam.props.FieldOfView = 70;
    cam.props.CameraType = E('CameraType', 'Custom');
    cam.setParent(ws);
    ws.rawSet('CurrentCamera', cam);
    this.physics = new Physics(w, { role: 'client' });
    this.installHooks();
    this.camera = new CameraController(this);
    this.animator = new DefaultAnimator(this);
    const lp = w.localPlayer;
    if (lp) {
      const ps = new Instance('PlayerScripts', w);
      ps.props.Name = 'PlayerScripts';
      const sps = this.service('StarterPlayer').findFirstChildOfClass('StarterPlayerScripts');
      if (sps) for (const c of sps.children) { const cc = c.clone(false, null, w); if (cc) { cc.parent = ps; ps.children.push(cc); } }
      ps.setParent(lp);
    }
    this.unobserve = w.observe({ moved: (inst, oldParent) => this.toolMoved(inst, oldParent), added: (inst) => this.toolMoved(inst, null), removed: (inst, oldParent) => this.toolMoved(inst, oldParent) });
    w.start();
    // players already in the game when we joined
    for (const p of this.service('Players').children) if (p.ClassName === 'Player' && p.props.Character) this.onCharacterChanged(p, p.props.Character);
    this.resolveReady();
    this.emit('ready');
  }

  installHooks() {
    const w = this.world, h = w.hooks;
    h.characterChanged = (player, model) => this.onCharacterChanged(player, model);
    h.playerFromCharacter = (model) => this.service('Players').children.find((p) => p.ClassName === 'Player' && model && p.props.Character === model) || null;
    h.loadCharacter = () => { w.output('LoadCharacter can only be called by the backend server', 'error'); };
    h.kick = (player, msg) => { if (player === w.localPlayer) this.onKicked(msg); };
    h.sendChat = (text) => this.chat(text);
    h.cameraYaw = () => (this.camera ? this.camera.yaw : 0);
    h.sit = (seat, hum) => { if (hum && hum.controller) hum.controller.sit(seat); };
    h.unsit = (hum) => { if (hum && hum.controller) hum.controller.unsit(); };
    h.humanoidDied = (hum) => { if (hum === this.humanoid) this.emit('died'); };
    h.trackEvent = (track, kind) => this.syncTrack(track, kind);
    h.purchasePrompt = (player, id, kind) => { if (player === w.localPlayer || !player) this.hud?.purchasePrompt(id, kind); };
    const avatars = () => this.app?.avatars;
    h.descriptionFromUserId = (id) => (avatars() ? avatars().descriptionFromUserId(w, id) : Promise.reject(new Error('avatars unavailable')));
    h.applyDescription = (hum, desc) => (avatars() ? avatars().applyDescription(w, hum, desc) : Promise.resolve());
    h.viewportSize = () => (this.viewport ? this.viewport.size : { w: 1280, h: 720 });
    h.guiInset = () => ({ top: 58, left: 0 });
  }

  onCharacterChanged(player, model) {
    const old = player.lastChar;
    player.lastChar = model || null;
    if (old && old !== model) player.fire('CharacterRemoving', old);
    if (model && old !== model) player.fire('CharacterAdded', model);
    if (player === this.world.localPlayer && old !== model) this.setupLocalCharacter(model);
  }

  setupLocalCharacter(model) {
    const w = this.world;
    this.character = model || null;
    this.humanoid = model ? model.findFirstChildOfClass('Humanoid') : null;
    if (!model) return;
    const hum = this.humanoid;
    if (hum && !hum.controller) { new CharacterController(hum, w); hum.isLocal = true; }
    for (const d of model.descendants()) if (d.isA('BasePart')) this.physics.dirty.add(d);
    model.forTree((d) => w.maybeRunScript(d));
    const cam = this.service('Workspace').props.CurrentCamera;
    if (cam) { cam.rawSet('CameraSubject', hum || model.props.PrimaryPart || null); if (cam.props.CameraType?.Name !== 'Scriptable') cam.rawSet('CameraType', E('CameraType', 'Custom')); }
    this.camera?.onCharacter(model);
    this.lastPose = null;
    this.emit('character', model);
  }
  isLocalCharacterPart(inst) { return !!this.character && (inst === this.character || inst.isDescendantOf(this.character)); }

  /** Tool equip events on the client (the server owns the grip weld). */
  toolMoved(inst, oldParent) {
    if (!inst.isA || !inst.isA('Tool')) return;
    const ch = this.character;
    if (!ch) return;
    const was = oldParent === ch, now = inst.parent === ch;
    if (was && !now) { inst.fire('Unequipped'); this.service('ContextActionService').fire('LocalToolUnequipped', inst); }
    if (now && !was) { inst.fire('Equipped', this.input ? this.input.mouseObject() : undefined); this.service('ContextActionService').fire('LocalToolEquipped', inst); }
    this.emit('backpack');
  }

  // ------------------------------------------------------------ client-authoritative actions
  equip(tool) {
    const ch = this.character, lp = this.localPlayer;
    if (!ch || !lp || !tool || !this.humanoid || this.humanoid.state === 'Dead') return;
    const bp = lp.findFirstChildOfClass('Backpack');
    if (tool.parent === ch) { tool.setParent(bp); this.replicator.send({ t: 'eq', i: tool.netId, on: 0 }); return; }
    for (const other of ch.children.slice()) if (other.isA('Tool')) { other.setParent(bp); }
    tool.setParent(ch);
    this.replicator.send({ t: 'eq', i: tool.netId, on: 1 });
  }
  unequipAll() {
    const ch = this.character, bp = this.localPlayer && this.localPlayer.findFirstChildOfClass('Backpack');
    if (!ch) return;
    for (const t of ch.children.slice()) if (t.isA('Tool')) { t.setParent(bp); this.replicator.send({ t: 'eq', i: t.netId, on: 0 }); }
  }
  dropTool() {
    const ch = this.character;
    const tool = ch && ch.children.find((c) => c.isA('Tool'));
    if (tool && tool.props.CanBeDropped !== false) this.replicator.send({ t: 'eq', i: tool.netId, on: 0, drop: 1 });
  }
  activateTool(down) {
    const ch = this.character;
    const tool = ch && ch.children.find((c) => c.isA('Tool'));
    if (!tool || (this.humanoid && this.humanoid.state === 'Dead')) return;
    if (down && tool.props.ManualActivationOnly) return;
    if (tool.props.Enabled === false) return;
    tool.fire(down ? 'Activated' : 'Deactivated');
    this.replicator.send({ t: 'ac', i: tool.netId, k: down ? 'a' : 'd' });
  }
  clickDetector(cd, kind = 'c') {
    const ev = { c: 'MouseClick', r: 'RightMouseClick', he: 'MouseHoverEnter', hl: 'MouseHoverLeave' }[kind];
    if (ev) cd.fire(ev, this.localPlayer);
    if (cd.netId !== undefined) this.replicator.send({ t: 'cd', i: cd.netId, k: kind });
  }
  prompt(pp, kind) {
    const ev = { t: 'Triggered', e: 'TriggerEnded', hb: 'PromptButtonHoldBegan', he: 'PromptButtonHoldEnded' }[kind];
    if (ev) { pp.fire(ev, this.localPlayer); this.service('ProximityPromptService').fire(`Prompt${ev}`, pp, this.localPlayer); }
    if (pp.netId !== undefined) this.replicator.send({ t: 'pp', i: pp.netId, k: kind });
  }
  resetCharacter() { this.replicator.send({ t: 'reset' }); }
  chat(text) {
    const t = String(text || '').trim();
    if (!t) return;
    if (t.startsWith('/e ') && this.animator) { this.animator.emote(t.slice(3).trim()); return; }
    this.replicator.send({ t: 'chat', m: t });
  }
  purchaseResult(id, kind, ok) {
    const mps = this.service('MarketplaceService');
    const lp = this.localPlayer;
    if (kind === 'product') mps.fire('PromptProductPurchaseFinished', lp && lp.props.UserId, id, ok);
    else if (kind === 'gamepass') mps.fire('PromptGamePassPurchaseFinished', lp, id, ok);
    else mps.fire('PromptPurchaseFinished', lp, id, ok);
    this.replicator.send({ t: 'mp', i: id, k: kind, ok: ok ? 1 : 0 });
  }

  /** Sends animation tracks played on our character to the server (others play them too). */
  syncTrack(track, kind) {
    if (track.internal || track.remote) return;
    const owner = track.animator && track.animator.parent;
    if (!owner || !this.character || !owner.isDescendantOf(this.character) || owner.netId === undefined) return;
    this.replicator.send({ t: 'an', h: owner.netId, k: track.id, op: kind, a: track.animation ? track.animation.props.AnimationId : '', f: track.fade, w: track.targetWeight, s: track.speed, l: track.loopedOverride, p: track.priorityOverride });
  }
  onRemoteAnimation(m) {
    const owner = this.replicator.byId.get(m.h);
    if (!owner || !owner.dm || (this.character && owner.isDescendantOf(this.character))) return;
    const key = `${m.h}:${m.k}`;
    let track = this.remoteTracks.get(key);
    if (m.op === 'play') {
      if (!track) {
        const anim = new Instance('Animation', this.world);
        anim.props.AnimationId = m.a || '';
        track = loadAnimation(ensureAnimator(owner), anim);
        track.remote = true;
        this.remoteTracks.set(key, track);
      }
      if (m.l !== null && m.l !== undefined) track.loopedOverride = !!m.l;
      if (m.p) track.priorityOverride = m.p;
      track.beh.methods.Play(track, m.f, m.w, m.s);
    } else if (track && m.op === 'stop') { track.beh.methods.Stop(track, m.f); this.remoteTracks.delete(key); }
    else if (track && m.op === 'speed') track.speed = m.s;
  }

  onChatMessage(player, text, m) {
    if (m && m.bubble) { const part = this.replicator.byId.get(m.bubble); if (part) this.hud?.bubble(part, text); return; }
    if (player) player.fire('Chatted', toByteStr(text));
    const entry = { from: player ? player.props.DisplayName || player.props.Name : 'Server', player, text, time: Date.now() };
    this.chatLog.push(entry);
    if (this.chatLog.length > 200) this.chatLog.shift();
    this.emit('chat', entry);
    if (player && player.props.Character) { const head = player.props.Character.findFirstChild('Head'); if (head) this.hud?.bubble(head, text); }
  }
  onSystemMessage(text, kind) {
    const entry = { from: null, system: true, kind, text, time: Date.now() };
    this.chatLog.push(entry);
    this.emit('chat', entry);
  }
  onKicked(msg) { this.kicked = msg || 'You were kicked'; this.emit('kicked', this.kicked); }
  onDisconnected(msg) { if (!this.kicked) { this.kicked = msg; this.emit('kicked', msg); } }
  onPurchasePrompt(m) { this.hud?.purchasePrompt(m.i, m.k); }
  onHostCommand(m) {
    if (m.k === 'emit' || m.k === 'clearfx') { const em = this.replicator.byId.get(m.i); if (em) this.world.hooks[m.k === 'emit' ? 'emitParticles' : 'clearParticles']?.(em, m.n); }
  }

  // ------------------------------------------------------------ viewport attachment
  async attach(viewport) {
    if (this.attached) return;
    this.attached = true;
    this.viewport = viewport;
    if (!this.view) this.view = new SceneView(this.world, { assets: this.app.assets });
    viewport.setView(this.view, 'play');
    const [{ GuiRenderer }, { Hud }, { Effects }] = await Promise.all([import('./gui.js'), import('./hud.js'), import('../render/effects.js')]);
    if (!this.attached) return;
    this.input = new Input(this, viewport);
    this.gui = new GuiRenderer(this, viewport.overlay);
    this.hud = new Hud(this, viewport.overlay);
    if (!this.effects) this.effects = new Effects(this, this.view);
    this.sound.setMuted(!!this.app.audioMuted);
    viewport.canvas.focus();
  }
  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.input?.dispose(); this.input = null;
    this.gui?.dispose(); this.gui = null;
    this.hud?.dispose(); this.hud = null;
    this.sound.setMuted(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  stop() {
    this.detach();
    this.unobserve?.();
    this.effects?.dispose();
    this.view?.dispose();
    this.sound.dispose();
    this.replicator.dispose();
    this.physics?.dispose();
    this.world.stop();
  }

  // ------------------------------------------------------------ frame
  tick(dt) {
    const w = this.world;
    this.time += dt;
    if (!this.rapierReady) { this.replicator.flush(); return; }
    this.replicator.receive();
    if (!this.replicator.ready || !this.physics) { this.replicator.flush(); return; }
    this.replicator.step(dt);
    const rs = this.service('RunService');
    if (this.input) this.input.update(dt);
    // RenderStepped / BindToRenderStep (camera runs at Enum.RenderPriority.Camera = 200)
    const binds = rs.renderSteps || [];
    let camDone = false;
    for (const b of binds.slice()) {
      if (!camDone && b.priority >= 200) { this.camera.update(dt); camDone = true; }
      if (b.owner && b.owner.dead) continue;
      w.scheduler.spawn(b.fn, [dt], b.owner);
    }
    if (!camDone) this.camera.update(dt);
    rs.fire('RenderStepped', dt);
    rs.fire('PreRender', dt);
    rs.fire('PreAnimation', dt);
    this.animator.update(dt);
    if (w.animators) for (const a of w.animators) { if (!a.dm) { w.animators.delete(a); continue; } stepAnimator(a, dt); }
    rs.fire('Stepped', w.scheduler.clock, dt);
    rs.fire('PreSimulation', dt);
    this.physics.step(dt);
    rs.fire('PostSimulation', dt);
    rs.fire('Heartbeat', dt);
    w.scheduler.step(dt);
    stepTweens(w, dt);
    if (this.attached) {
      this.camera.apply();
      this.gui?.update(dt);
      this.hud?.update(dt);
      this.effects?.update(dt);
    }
    this.sound.update(dt);
    this.sendPose(dt);
    this.replicator.flush();
  }

  sendPose(dt) {
    const ch = this.character, hum = this.humanoid;
    if (!ch || !ch.dm || !hum || hum.state === 'Dead' || ch.netId === undefined) return;
    this.poseAcc += dt;
    const interval = this.replicator.transport.local ? 0 : 1 / 30;
    if (this.poseAcc < interval) return;
    this.poseAcc = 0;
    const root = rootPartOf(hum);
    if (!root) return;
    const d = encodePose(root.props.CFrame);
    const md = hum.moveDir || Vector3.zero;
    const key = `${d.join(',')}|${hum.state}|${md.X.toFixed(2)},${md.Z.toFixed(2)}|${this.replicator.tpAck || 0}`;
    if (key === this.lastPose && this.time - this.lastPoseAt < 0.5) return;
    this.lastPose = key;
    this.lastPoseAt = this.time;
    const v = hum.controller ? hum.controller.velocity : Vector3.zero;
    this.replicator.send({ t: 'ch', c: ch.netId, d, s: hum.state, md: [md.X, md.Y, md.Z], v: [v.X, v.Y, v.Z], q: this.replicator.tpAck || 0 });
  }

  statusText() {
    const p = this.replicator.ping;
    return `${this.localPlayer ? this.localPlayer.props.Name : this.label}${p ? ` · ${Math.round(p)} ms` : ''}`;
  }
}
