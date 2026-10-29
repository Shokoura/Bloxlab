// Animator / AnimationTrack: plays KeyframeSequences by writing Motor6D.Transform.
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, S, toEnum, arr } from '../bridge.js';
import { CFrame } from '../datatypes.js';
import { E } from '../enums.js';
import { Signal } from '../signal.js';
import { ease } from './services.js';
import { proceduralClip } from './procedural.js';

const PRIORITY = { Core: 0, Idle: 1, Movement: 2, Action: 3, Action2: 4, Action3: 5, Action4: 6 };

/** KeyframeSequence instance -> { length, loop, priority, poses: Map(name -> [{t, cf, style, dir, w}]), keyframes: [{t, name}], markers: [{t, name, value}] } */
export function compileKeyframeSequence(kfs) {
  const poses = new Map();
  const keyframes = [], markers = [];
  let length = 0;
  for (const kf of kfs.children) {
    if (kf.ClassName !== 'Keyframe') continue;
    const t = kf.props.Time || 0;
    length = Math.max(length, t);
    if (kf.props.Name && kf.props.Name !== 'Keyframe') keyframes.push({ t, name: kf.props.Name });
    const walk = (pose) => {
      for (const p of pose.children) {
        if (p.ClassName === 'Pose' || p.ClassName === 'NumberPose') {
          if (p.ClassName === 'Pose') {
            if (!poses.has(p.props.Name)) poses.set(p.props.Name, []);
            poses.get(p.props.Name).push({ t, cf: p.props.CFrame || CFrame.identity, style: p.props.EasingStyle ? p.props.EasingStyle.Name : 'Linear', dir: p.props.EasingDirection ? p.props.EasingDirection.Name : 'In', w: p.props.Weight ?? 1 });
          }
          walk(p);
        } else if (p.ClassName === 'KeyframeMarker') markers.push({ t, name: p.props.Name, value: p.props.Value || '' });
      }
    };
    walk(kf);
  }
  for (const list of poses.values()) list.sort((a, b) => a.t - b.t);
  return { length, loop: !!kfs.props.Loop, priority: kfs.props.Priority ? kfs.props.Priority.Name : 'Core', poses, keyframes, markers };
}

function sampleTrack(list, t) {
  if (!list.length) return null;
  if (t <= list[0].t) return { cf: list[0].cf, w: list[0].w };
  for (let i = 1; i < list.length; i++) {
    const b = list[i];
    if (t <= b.t) {
      const a = list[i - 1];
      if (a.style === 'Constant') return { cf: a.cf, w: a.w };
      const span = b.t - a.t || 1;
      let alpha = (t - a.t) / span;
      const style = a.style === 'Cubic' ? 'Cubic' : a.style === 'Elastic' ? 'Elastic' : a.style === 'Bounce' ? 'Bounce' : a.style === 'Linear' ? 'Linear' : a.style;
      alpha = style === 'Linear' ? alpha : ease(alpha, style, a.dir === 'InOut' ? 'InOut' : a.dir === 'Out' ? 'In' : 'Out');
      return { cf: a.cf.lerp(b.cf, alpha), w: a.w + (b.w - a.w) * alpha };
    }
  }
  const last = list[list.length - 1];
  return { cf: last.cf, w: last.w };
}

function rigOf(animator) {
  const owner = animator.parent; // Humanoid or AnimationController
  const model = owner && owner.parent;
  if (!model) return null;
  const joints = new Map(); // Part1 name -> Motor6D
  for (const d of model.descendants()) if ((d.ClassName === 'Motor6D' || d.ClassName === 'Bone') && (d.props.Part1 || d.ClassName === 'Bone')) joints.set(d.ClassName === 'Bone' ? d.props.Name : d.props.Part1.props.Name, d);
  return { model, joints, rig: owner.ClassName === 'Humanoid' && owner.props.RigType ? owner.props.RigType.Name : (model.findFirstChild('UpperTorso') ? 'R15' : 'R6') };
}

defineBehavior('Animator', {
  added: (a) => { if (a.world) (a.world.animators ||= new Set()).add(a); },
  removed: (a, dm) => { dm.world?.animators?.delete(a); },
  methods: methods({
    LoadAnimation: (self, anim) => [loadAnimation(self, anim)],
    GetPlayingAnimationTracks: (self) => [arrTracks(self)],
    StepAnimations: (self, dt) => { stepAnimator(self, Number(dt) || 0); },
    ApplyJointVelocities: () => {},
  }),
  events: ['AnimationPlayed'],
});
defineBehavior('AnimationController', {
  methods: methods({
    LoadAnimation: (self, anim) => [loadAnimation(ensureAnimator(self), anim)],
    GetPlayingAnimationTracks: (self) => [arrTracks(ensureAnimator(self))],
  }),
});
export function ensureAnimator(owner) {
  let a = owner.findFirstChildOfClass('Animator');
  if (!a) { a = new Instance('Animator', owner.world); a.props.Name = 'Animator'; a.setParent(owner); }
  return a;
}
function arrTracks(animator) { return arr([...(animator.tracks || [])].filter((t) => t.playing)); }

export function loadAnimation(animator, anim) {
  if (!(anim instanceof Instance) || anim.ClassName !== 'Animation') throw lerr('LoadAnimation requires an Animation object');
  const track = new Instance('AnimationTrack', animator.world);
  track.props.Name = anim.props.Name || 'AnimationTrack';
  track.animator = animator;
  track.animation = anim;
  track.clip = null;
  track.time = 0;
  track.speed = 1;
  track.weight = 0;
  track.targetWeight = 1;
  track.fade = 0.1;
  track.playing = false;
  track.priorityOverride = null;
  track.loopedOverride = null;
  track.markerSignals = new Map();
  (animator.tracks ||= new Set()).add(track);
  const id = anim.props.AnimationId || '';
  const w = animator.world;
  const rig = rigOf(animator);
  const proc = proceduralClip(id, rig ? rig.rig : 'R15');
  if (proc) track.clip = proc;
  else if (id && w && w.loadKeyframeSequence) {
    w.loadKeyframeSequence(id).then((kfs) => {
      if (kfs) track.clip = compileKeyframeSequence(kfs);
    }).catch((e) => { if (w) w.output(`Failed to load animation ${id}: ${e.message}`, 'warn'); });
  }
  return track;
}

defineBehavior('AnimationTrack', {
  props: {
    Animation: { get: (t) => t.animation || null, readonly: true, type: 'Ref' },
    IsPlaying: { get: (t) => !!t.playing, readonly: true, type: 'Bool' },
    Length: { get: (t) => (t.clip ? t.clip.length : 0), readonly: true, type: 'Float32' },
    Looped: { get: (t) => (t.loopedOverride !== null ? t.loopedOverride : t.clip ? t.clip.loop : false), set: (t, v) => { t.loopedOverride = !!v; }, type: 'Bool' },
    Priority: { get: (t) => E('AnimationPriority', t.priorityOverride || (t.clip ? t.clip.priority : 'Core')), set: (t, v) => { t.priorityOverride = v.Name; }, type: 'Enum:AnimationPriority' },
    Speed: { get: (t) => t.speed, readonly: true, type: 'Float32' },
    TimePosition: { get: (t) => t.time, set: (t, v) => { t.time = Math.max(0, Number(v) || 0); }, type: 'Float32' },
    WeightCurrent: { get: (t) => t.weight, readonly: true, type: 'Float32' },
    WeightTarget: { get: (t) => t.targetWeight, readonly: true, type: 'Float32' },
  },
  methods: methods({
    Play: (self, fade, weight, speed) => {
      self.fade = typeof fade === 'number' ? fade : 0.1;
      self.targetWeight = typeof weight === 'number' ? weight : 1;
      if (typeof speed === 'number') self.speed = speed;
      if (!self.playing) { self.time = 0; if (self.fade <= 0) self.weight = self.targetWeight; }
      self.playing = true;
      self.stopping = false;
      self.animator.fire('AnimationPlayed', self);
      const hum = self.animator.parent;
      if (hum && hum.ClassName === 'Humanoid') hum.fire('AnimationPlayed', self);
    },
    Stop: (self, fade) => {
      if (!self.playing) return;
      self.fade = typeof fade === 'number' ? fade : 0.1;
      self.stopping = true;
      self.targetWeight = 0;
      if (self.fade <= 0) finishStop(self);
    },
    AdjustSpeed: (self, s) => { self.speed = typeof s === 'number' ? s : 1; },
    AdjustWeight: (self, w, fade) => { self.targetWeight = typeof w === 'number' ? w : 1; self.fade = typeof fade === 'number' ? fade : 0.1; },
    GetMarkerReachedSignal: (self, name) => {
      const n = S(name);
      if (!self.markerSignals.has(n)) self.markerSignals.set(n, new Signal(`${n}MarkerReached`));
      return [self.markerSignals.get(n)];
    },
    GetTimeOfKeyframe: (self, name) => { const k = self.clip && self.clip.keyframes.find((x) => x.name === S(name)); if (!k) throw lerr(`Keyframe ${S(name)} not found`); return [k.t]; },
    GetTargetInstance: () => [undefined], SetTargetInstance: () => {},
  }),
  events: ['Stopped', 'Ended', 'KeyframeReached', 'DidLoop'],
});
function finishStop(t) {
  t.playing = false;
  t.stopping = false;
  t.weight = 0;
  t.fire('Stopped');
  t.fire('Ended');
}

/** Advances an animator's tracks and writes joint transforms. */
export function stepAnimator(animator, dt) {
  const tracks = animator.tracks;
  if (!tracks || !tracks.size) return;
  const rig = rigOf(animator);
  if (!rig) return;
  const active = [];
  for (const t of tracks) {
    if (!t.playing) continue;
    // weight fading
    const rate = t.fade > 0 ? dt / t.fade : 1;
    if (t.weight < t.targetWeight) t.weight = Math.min(t.targetWeight, t.weight + rate * Math.max(t.targetWeight, 0.01));
    else if (t.weight > t.targetWeight) t.weight = Math.max(t.targetWeight, t.weight - rate * Math.max(1, t.weight));
    if (t.stopping && t.weight <= 0.001) { finishStop(t); continue; }
    const clip = t.clip;
    if (!clip) continue;
    const prev = t.time;
    t.time += dt * t.speed;
    const len = clip.length;
    const looped = t.loopedOverride !== null ? t.loopedOverride : clip.loop;
    // keyframe / marker events
    for (const k of clip.keyframes) if (k.t > prev && k.t <= t.time) t.fire('KeyframeReached', k.name);
    for (const m of clip.markers) if (m.t > prev && m.t <= t.time) t.markerSignals.get(m.name)?.fire(m.value);
    if (len > 0 && t.time >= len) {
      if (looped) { t.time %= len; t.fire('DidLoop'); }
      else { t.time = len; if (!t.stopping) { t.stopping = true; t.targetWeight = 0; t.fade = Math.max(t.fade, 0.05); } }
    }
    active.push(t);
  }
  if (!active.length && !animator.hadActive) return;
  animator.hadActive = active.length > 0;
  active.sort((a, b) => PRIORITY[a.priorityOverride || a.clip.priority] - PRIORITY[b.priorityOverride || b.clip.priority]);
  const result = new Map();
  for (const t of active) {
    for (const [name, list] of t.clip.poses) {
      if (!rig.joints.has(name)) continue;
      const s = sampleTrack(list, t.clip.dynamic ? t.time : Math.min(t.time, t.clip.length));
      if (!s) continue;
      const w = Math.max(0, Math.min(1, t.weight * s.w));
      const cur = result.get(name) || CFrame.identity;
      result.set(name, w >= 0.999 ? s.cf : cur.lerp(s.cf, w));
    }
  }
  for (const [name, j] of rig.joints) {
    const cf = result.get(name) || CFrame.identity;
    if (j.ClassName === 'Bone') { j.transform = cf; continue; }
    if (j.transform && j.transform.eq(cf)) continue;
    j.transform = cf;
    j.world?.hooks.jointChanged?.(j);
  }
}

export { toEnum };
