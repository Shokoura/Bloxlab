// Sound playback for a client world (Web Audio): 2D and 3D sounds, looping, SoundGroups,
// PlaybackSpeed, TimePosition, PlaybackLoudness and the Ended / Loaded / DidLoop events.
import { Vector3 } from '../engine/datatypes.js';

let sharedCtx = null;
function audioContext() {
  if (sharedCtx) return sharedCtx;
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  sharedCtx = new AC();
  const resume = () => { if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
  return sharedCtx;
}

export class SoundSystem {
  constructor(rt) {
    this.rt = rt;
    this.world = rt.world;
    this.ctx = audioContext();
    this.active = new Map(); // Sound -> voice
    this.buffers = new Map(); // SoundId -> Promise<AudioBuffer>
    this.muted = false;
    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    const h = this.world.hooks;
    h.sound = (s, what, arg) => this.onHook(s, what, arg);
    h.soundTime = (s) => this.timeOf(s);
    h.soundLoudness = (s) => this.loudness(s);
    h.playSound = (s) => this.playOneShot(s);
    this.unobserve = this.world.observe({
      added: (inst) => inst.forTree((d) => { if (d.ClassName === 'Sound' && d.props.Playing) this.start(d, d.props.TimePosition || 0); }),
      removed: (inst) => inst.forTree((d) => { if (d.ClassName === 'Sound') this.stopVoice(d); }),
      propChanged: (inst, name) => { if (inst.ClassName === 'Sound' && this.active.has(inst) && (name === 'Volume' || name === 'PlaybackSpeed' || name === 'Looped' || name === 'SoundGroup')) this.refresh(inst); else if (inst.ClassName === 'Sound' && name === 'SoundId' && inst.props.Playing) this.start(inst, 0); },
    });
  }

  dispose() {
    this.unobserve?.();
    for (const s of [...this.active.keys()]) this.stopVoice(s);
    if (this.master) this.master.disconnect();
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
    if (!m && this.world.dm) this.world.dm.forTree((d) => { if (d.ClassName === 'Sound' && d.props.Playing && !this.active.has(d)) this.start(d, d.props.TimePosition || 0); });
  }

  buffer(id) {
    if (!id) return Promise.reject(new Error('no SoundId'));
    let p = this.buffers.get(id);
    if (!p) {
      p = this.rt.app.assets.bytes(id).then(({ bytes }) => this.ctx.decodeAudioData(bytes.slice().buffer));
      this.buffers.set(id, p);
      p.catch(() => setTimeout(() => this.buffers.delete(id), 20000));
    }
    return p;
  }

  onHook(s, what, arg) {
    if (!this.ctx) return;
    if (what === 'play' || what === 'restart') this.start(s, what === 'restart' ? 0 : s.props.TimePosition || 0);
    else if (what === 'pause') { const v = this.active.get(s); if (v) s.props.TimePosition = this.timeOf(s); this.stopVoice(s); }
    else if (what === 'stop') this.stopVoice(s);
    else if (what === 'seek' && this.active.has(s)) this.start(s, Number(arg) || 0);
  }

  volumeOf(s) {
    let v = s.props.Volume ?? 0.5;
    const g = s.props.SoundGroup;
    if (g && g.props) v *= g.props.Volume ?? 0.5;
    return Math.max(0, Math.min(10, v));
  }
  emitterPos(s) {
    const p = s.parent;
    if (!p) return null;
    if (p.isA && p.isA('BasePart')) return p.props.CFrame.Position;
    if (p.ClassName === 'Attachment') { const wp = p.get('WorldPosition'); return wp; }
    return null;
  }

  start(s, offset) {
    if (!this.ctx || !s.dm) return;
    this.stopVoice(s);
    const token = (s.soundToken = (s.soundToken || 0) + 1);
    const id = s.props.SoundId || '';
    this.buffer(id).then((buf) => {
      if (s.soundToken !== token || !s.props.Playing || !s.dm) return;
      s.timeLength = buf.duration;
      if (!s.loadedOnce) { s.loadedOnce = true; s.fire('Loaded', id); }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = !!s.props.Looped;
      const speed = Math.max(0.01, s.props.PlaybackSpeed ?? 1);
      src.playbackRate.value = speed;
      const gain = this.ctx.createGain();
      gain.gain.value = this.volumeOf(s);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(gain);
      let out = gain;
      const pos = this.emitterPos(s);
      let panner = null;
      if (pos) {
        panner = this.ctx.createPanner();
        panner.panningModel = 'HRTF';
        const mode = s.props.RollOffMode ? s.props.RollOffMode.Name : 'Inverse';
        panner.distanceModel = mode.startsWith('Linear') ? 'linear' : 'inverse';
        panner.refDistance = Math.max(0.1, s.props.RollOffMinDistance ?? s.props.EmitterSize ?? 10);
        panner.maxDistance = Math.max(panner.refDistance + 1, s.props.RollOffMaxDistance ?? s.props.MaxDistance ?? 10000);
        panner.rolloffFactor = 1;
        panner.positionX.value = pos.X; panner.positionY.value = pos.Y; panner.positionZ.value = pos.Z;
        gain.connect(panner);
        out = panner;
      }
      out.connect(analyser);
      analyser.connect(this.master);
      const start = Math.max(0, Math.min(offset || 0, buf.duration - 0.001));
      src.start(0, start);
      const voice = { src, gain, panner, analyser, startedAt: this.ctx.currentTime, offset: start, speed, duration: buf.duration, loops: 0, data: new Uint8Array(analyser.frequencyBinCount) };
      src.onended = () => {
        if (this.active.get(s) !== voice) return;
        this.active.delete(s);
        if (!src.loop) {
          s.rawSet('Playing', false);
          s.rawSet('TimePosition', 0);
          s.fire('Ended', id);
          if (s.props.PlayOnRemove === false && s.removeAfterEnd) s.destroy();
        }
      };
      this.active.set(s, voice);
    }).catch((e) => {
      if (!s.warnedLoad) { s.warnedLoad = true; this.world.output(`Failed to load sound ${id}: ${e.message}`, 'warn'); }
    });
  }
  stopVoice(s) {
    const v = this.active.get(s);
    if (!v) return;
    this.active.delete(s);
    try { v.src.onended = null; v.src.stop(); } catch { /* already stopped */ }
    v.src.disconnect(); v.gain.disconnect(); v.panner?.disconnect(); v.analyser.disconnect();
  }
  refresh(s) {
    const v = this.active.get(s);
    if (!v) return;
    v.gain.gain.value = this.volumeOf(s);
    const sp = Math.max(0.01, s.props.PlaybackSpeed ?? 1);
    if (sp !== v.speed) { v.offset = this.timeOf(s); v.startedAt = this.ctx.currentTime; v.speed = sp; v.src.playbackRate.value = sp; }
    v.src.loop = !!s.props.Looped;
  }
  timeOf(s) {
    const v = this.active.get(s);
    if (!v) return s.props.TimePosition || 0;
    const t = v.offset + (this.ctx.currentTime - v.startedAt) * v.speed;
    return v.src.loop && v.duration > 0 ? t % v.duration : Math.min(t, v.duration);
  }
  loudness(s) {
    const v = this.active.get(s);
    if (!v) return 0;
    v.analyser.getByteTimeDomainData(v.data);
    let sum = 0;
    for (const x of v.data) { const d = (x - 128) / 128; sum += d * d; }
    return Math.min(1000, Math.sqrt(sum / v.data.length) * 1000 * 2.5);
  }
  playOneShot(s) {
    if (!this.ctx) return;
    this.buffer(s.props.SoundId || '').then((buf) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.max(0.01, s.props.PlaybackSpeed ?? 1);
      const g = this.ctx.createGain(); g.gain.value = this.volumeOf(s);
      src.connect(g); g.connect(this.master); src.start();
    }).catch(() => {});
  }

  update() {
    if (!this.ctx || this.muted) return;
    // listener follows the camera
    const cam = this.rt.world.dm && this.rt.service('Workspace').props.CurrentCamera;
    const cf = cam && cam.props.CFrame;
    const L = this.ctx.listener;
    if (cf && L.positionX) {
      L.positionX.value = cf.X; L.positionY.value = cf.Y; L.positionZ.value = cf.Z;
      const f = cf.LookVector, u = cf.UpVector;
      L.forwardX.value = f.X; L.forwardY.value = f.Y; L.forwardZ.value = f.Z;
      L.upX.value = u.X; L.upY.value = u.Y; L.upZ.value = u.Z;
    }
    for (const [s, v] of this.active) {
      if (v.panner) { const p = this.emitterPos(s); if (p) { v.panner.positionX.value = p.X; v.panner.positionY.value = p.Y; v.panner.positionZ.value = p.Z; } }
      if (v.src.loop && v.duration > 0) {
        const loops = Math.floor((v.offset + (this.ctx.currentTime - v.startedAt) * v.speed) / v.duration);
        if (loops > v.loops) { v.loops = loops; s.fire('DidLoop', s.props.SoundId || '', loops); }
      }
    }
  }
}

export { Vector3 };
