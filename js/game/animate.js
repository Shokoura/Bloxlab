// Stand-in for Roblox's default "Animate" LocalScript: picks idle / walk / run / jump / fall / climb / sit
// tracks from each humanoid's state and speed. Characters that ship their own Animate script are left alone.
import { Instance } from '../engine/instance.js';
import { loadAnimation, ensureAnimator } from '../engine/classes/animation.js';
import { rootPartOf } from '../engine/classes/humanoid.js';

const EMOTES = { wave: 'wave', point: 'point', dance: 'dance', dance1: 'dance', dance2: 'dance2', dance3: 'dance3', cheer: 'cheer', laugh: 'laugh' };

export class DefaultAnimator {
  constructor(rt) {
    this.rt = rt;
    this.states = new Map(); // humanoid -> { tracks, current, speed, lastPos }
  }

  humanoids() {
    const out = [];
    const ws = this.rt.service('Workspace');
    const players = this.rt.service('Players');
    for (const p of players.children) if (p.ClassName === 'Player' && p.props.Character) { const h = p.props.Character.findFirstChildOfClass('Humanoid'); if (h) out.push(h); }
    if (!this.npcScan || this.rt.time - this.npcScan > 1) {
      this.npcScan = this.rt.time;
      this.npcs = [];
      for (const m of ws.children) {
        if (!m.isA('Model')) continue;
        const h = m.findFirstChildOfClass('Humanoid');
        if (h && !out.includes(h)) this.npcs.push(h);
      }
    }
    for (const h of this.npcs || []) if (h.dm && !out.includes(h)) out.push(h);
    return out;
  }

  track(hum, s, role) {
    let t = s.tracks.get(role);
    if (t) return t;
    const anim = new Instance('Animation', this.rt.world);
    anim.props.Name = role;
    anim.props.AnimationId = `bloxlab://anim/${role}`;
    t = loadAnimation(ensureAnimator(hum), anim);
    t.internal = true;
    s.tracks.set(role, t);
    return t;
  }

  update(dt) {
    const seen = new Set();
    for (const hum of this.humanoids()) {
      const model = hum.parent;
      if (!model || !hum.dm) continue;
      if (model.findFirstChild('Animate')) continue; // the place animates it
      seen.add(hum);
      let s = this.states.get(hum);
      if (!s) { s = { tracks: new Map(), current: null, speed: 0, lastPos: null }; this.states.set(hum, s); }
      const root = rootPartOf(hum);
      if (!root) continue;
      // speed: local controller knows it, remote characters are estimated from movement
      let speed;
      if (hum.controller) { const v = hum.controller.velocity; speed = Math.hypot(v.X, v.Z); }
      else {
        const p = root.props.CFrame.Position;
        const inst = s.lastPos ? Math.hypot(p.X - s.lastPos.X, p.Z - s.lastPos.Z) / Math.max(dt, 1e-3) : 0;
        s.lastPos = p;
        s.speed += (inst - s.speed) * Math.min(1, dt * 8);
        speed = s.speed;
      }
      const st = hum.state || 'Running';
      let role;
      if (st === 'Dead') role = null;
      else if (st === 'Seated' || hum.seat) role = 'sit';
      else if (st === 'Climbing') role = 'climb';
      else if (st === 'Jumping') role = 'jump';
      else if (st === 'Freefall') role = s.current === 'jump' && s.jumpTime < 0.3 ? 'jump' : 'fall';
      else if (st === 'Swimming') role = speed > 1 ? 'swim' : 'swimidle';
      else if (speed > 0.75) role = 'walk';
      else role = 'idle';
      if (role === 'jump') s.jumpTime = (s.current === 'jump' ? s.jumpTime : 0) + dt;
      if (role !== s.current) {
        if (s.current) s.tracks.get(s.current)?.beh.methods.Stop(s.tracks.get(s.current), 0.15);
        if (role) { const t = this.track(hum, s, role); t.beh.methods.Play(t, 0.15, 1, 1); }
        s.current = role;
        if (role !== 'idle' && s.emote) {
          const e = s.tracks.get(s.emote);
          if (e) e.beh.methods.Stop(e, 0.2);
          if (hum === this.rt.humanoid) this.rt.replicator.send({ t: 'an', h: hum.netId, k: `emote-${s.emote}`, op: 'stop', f: 0.2 });
          s.emote = null;
        }
      }
      if (role === 'walk') { const t = s.tracks.get('walk'); if (t) t.speed = Math.max(0.3, speed / 14.5); }
      if (role === 'climb') { const t = s.tracks.get('climb'); if (t) t.speed = speed > 0.5 || (hum.controller && Math.abs(hum.controller.vy) > 0.5) ? 1 : 0; }
      // holding a tool raises the right arm
      const holding = model.children.some((c) => c.isA('Tool') && c.props.RequiresHandle !== false && c.findFirstChild('Handle'));
      const toolTrack = s.tracks.get('toolnone');
      if (holding && role !== 'sit' && role !== null && (!toolTrack || !toolTrack.playing || toolTrack.stopping)) { const t = this.track(hum, s, 'toolnone'); t.priorityOverride = 'Action'; t.beh.methods.Play(t, 0.1, 1, 1); }
      else if ((!holding || role === null) && toolTrack && toolTrack.playing && !toolTrack.stopping) toolTrack.beh.methods.Stop(toolTrack, 0.1);
      if (st === 'Dead') for (const t of s.tracks.values()) if (t.playing && !t.stopping) t.beh.methods.Stop(t, 0.1);
    }
    for (const h of this.states.keys()) if (!seen.has(h)) this.states.delete(h);
  }

  /** "/e dance" chat emotes for the local character. */
  emote(name) {
    const role = EMOTES[String(name).toLowerCase()];
    const hum = this.rt.humanoid;
    if (!role || !hum) return;
    const s = this.states.get(hum);
    if (!s || s.current !== 'idle') return;
    if (s.emote) { const e = s.tracks.get(s.emote); if (e) e.beh.methods.Stop(e, 0.2); }
    const t = this.track(hum, s, role);
    t.priorityOverride = 'Action';
    t.beh.methods.Play(t, 0.2, 1, 1);
    s.emote = role;
    // tell the other clients through a normal (replicated) track
    this.rt.replicator.send({ t: 'an', h: hum.netId, k: `emote-${role}`, op: 'play', a: `bloxlab://anim/${role}`, f: 0.2, w: 1, s: 1, l: null, p: 'Action' });
  }
}
