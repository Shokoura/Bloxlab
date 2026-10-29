// Built-in procedural animations. Used for characters without an Animate script and as stand-ins
// for Roblox's default animation assets when they cannot be downloaded.
import { CFrame } from '../datatypes.js';

const A = (x, y, z) => CFrame.angles(x, y, z);
const T = (x, y, z) => new CFrame(x, y, z);
const PI = Math.PI;

// Roblox default Animate-script animation ids -> role
const DEFAULT_IDS = {
  507766666: 'idle', 507766951: 'idle', 507766388: 'idle', 180435571: 'idle', 180435792: 'idle',
  507777826: 'walk', 180426354: 'walk', 913402848: 'walk',
  507767714: 'run', 913376220: 'run',
  507765000: 'jump', 125750702: 'jump',
  507767968: 'fall', 180436148: 'fall',
  507765644: 'climb', 180436334: 'climb',
  2506281703: 'sit', 178130996: 'sit',
  507768375: 'toolnone', 182393478: 'toolnone',
  507784897: 'swim', 507785072: 'swimidle',
  507770239: 'wave', 128777973: 'wave', 507770453: 'point', 128853357: 'point',
  507771019: 'dance', 182435998: 'dance', 507776043: 'dance2', 507777268: 'dance3', 507770818: 'cheer', 129423030: 'cheer', 507770677: 'laugh', 129423131: 'laugh',
};

// pose functions: (phase 0..1) -> { jointPart1Name: CFrame }
const R15 = {
  idle: (p) => { const b = Math.sin(p * 2 * PI); return { LowerTorso: T(0, b * 0.03, 0), UpperTorso: A(b * 0.02, 0, 0), Head: A(-b * 0.03, 0, 0), RightUpperArm: A(0, 0, 0.05 + b * 0.03), LeftUpperArm: A(0, 0, -0.05 - b * 0.03) }; },
  walk: (p) => { const s = Math.sin(p * 2 * PI), c = Math.cos(p * 2 * PI); return { LowerTorso: T(0, Math.abs(c) * 0.12, 0), RightUpperArm: A(s * 0.75, 0, 0.04), LeftUpperArm: A(-s * 0.75, 0, -0.04), RightLowerArm: A(Math.max(0, s) * 0.4, 0, 0), LeftLowerArm: A(Math.max(0, -s) * 0.4, 0, 0), RightUpperLeg: A(-s * 0.8, 0, 0), LeftUpperLeg: A(s * 0.8, 0, 0), RightLowerLeg: A(-Math.max(0, -s) * 0.9, 0, 0), LeftLowerLeg: A(-Math.max(0, s) * 0.9, 0, 0) }; },
  run: (p) => { const s = Math.sin(p * 2 * PI), c = Math.cos(p * 2 * PI); return { LowerTorso: T(0, Math.abs(c) * 0.2, 0).mul(A(-0.12, 0, 0)), RightUpperArm: A(s * 1.1, 0, 0.05), LeftUpperArm: A(-s * 1.1, 0, -0.05), RightLowerArm: A(0.9, 0, 0), LeftLowerArm: A(0.9, 0, 0), RightUpperLeg: A(-s * 1.1, 0, 0), LeftUpperLeg: A(s * 1.1, 0, 0), RightLowerLeg: A(-Math.max(0, -s) * 1.4 - 0.2, 0, 0), LeftLowerLeg: A(-Math.max(0, s) * 1.4 - 0.2, 0, 0) }; },
  jump: () => ({ RightUpperArm: A(PI * 0.85, 0, 0.1), LeftUpperArm: A(PI * 0.85, 0, -0.1), RightUpperLeg: A(0.25, 0, 0), LeftUpperLeg: A(-0.1, 0, 0), RightLowerLeg: A(-0.4, 0, 0) }),
  fall: (p) => { const w = Math.sin(p * 2 * PI) * 0.1; return { RightUpperArm: A(PI * 0.7 + w, 0, 0.5), LeftUpperArm: A(PI * 0.7 - w, 0, -0.5), RightUpperLeg: A(0.3, 0, 0.05), LeftUpperLeg: A(-0.2, 0, -0.05), RightLowerLeg: A(-0.5, 0, 0), LeftLowerLeg: A(-0.3, 0, 0) }; },
  climb: (p) => { const s = Math.sin(p * 2 * PI); return { RightUpperArm: A(PI * 0.75 + s * 0.4, 0, 0), LeftUpperArm: A(PI * 0.75 - s * 0.4, 0, 0), RightUpperLeg: A(0.6 + s * 0.4, 0, 0), LeftUpperLeg: A(0.6 - s * 0.4, 0, 0), RightLowerLeg: A(-0.9, 0, 0), LeftLowerLeg: A(-0.9, 0, 0) }; },
  sit: () => ({ RightUpperLeg: A(PI / 2, 0, 0.05), LeftUpperLeg: A(PI / 2, 0, -0.05), RightLowerLeg: A(-PI / 2, 0, 0), LeftLowerLeg: A(-PI / 2, 0, 0), RightUpperArm: A(0.35, 0, 0), LeftUpperArm: A(0.35, 0, 0) }),
  toolnone: () => ({ RightUpperArm: A(PI / 2, 0, 0) }),
  swim: (p) => { const s = Math.sin(p * 2 * PI); return { LowerTorso: A(-PI / 2.4, 0, 0), RightUpperArm: A(PI * 0.8 + s * 0.6, 0, 0), LeftUpperArm: A(PI * 0.8 - s * 0.6, 0, 0), RightUpperLeg: A(s * 0.4, 0, 0), LeftUpperLeg: A(-s * 0.4, 0, 0) }; },
  swimidle: (p) => { const s = Math.sin(p * 2 * PI); return { RightUpperArm: A(0.5 + s * 0.3, 0, 0.6), LeftUpperArm: A(0.5 - s * 0.3, 0, -0.6), RightUpperLeg: A(s * 0.3, 0, 0), LeftUpperLeg: A(-s * 0.3, 0, 0) }; },
  wave: (p) => { const s = Math.sin(p * 4 * PI); return { RightUpperArm: A(PI * 0.15, 0, 2.4), RightLowerArm: A(0, 0, s * 0.5), Head: A(0, -0.15, 0) }; },
  point: () => ({ RightUpperArm: A(PI / 2, 0, 0) }),
  cheer: (p) => { const s = Math.abs(Math.sin(p * 2 * PI)); return { RightUpperArm: A(PI * 0.9, 0, 0.3 + s * 0.2), LeftUpperArm: A(PI * 0.9, 0, -0.3 - s * 0.2), LowerTorso: T(0, s * 0.3, 0) }; },
  laugh: (p) => { const s = Math.sin(p * 8 * PI); return { UpperTorso: A(-0.2 + s * 0.05, 0, 0), Head: A(-0.3, 0, 0) }; },
  dance: (p) => { const s = Math.sin(p * 2 * PI), c = Math.cos(p * 2 * PI); return { LowerTorso: T(s * 0.4, Math.abs(c) * 0.3, 0).mul(A(0, s * 0.4, 0)), RightUpperArm: A(PI * 0.6, 0, 0.8 + s), LeftUpperArm: A(PI * 0.6, 0, -0.8 + s), RightUpperLeg: A(Math.max(0, s) * 0.6, 0, 0), LeftUpperLeg: A(Math.max(0, -s) * 0.6, 0, 0) }; },
};
R15.dance2 = R15.dance; R15.dance3 = R15.dance;

// R6 joints use the classic rotated C0/C1 frames: limbs swing around their joint's Z axis.
const R6 = {
  idle: (p) => { const b = Math.sin(p * 2 * PI) * 0.04; return { 'Right Arm': A(0, 0, b), 'Left Arm': A(0, 0, b) }; },
  walk: (p) => { const s = Math.sin(p * 2 * PI) * 0.9; return { 'Right Arm': A(0, 0, s), 'Left Arm': A(0, 0, s), 'Right Leg': A(0, 0, s), 'Left Leg': A(0, 0, s) }; },
  run: (p) => { const s = Math.sin(p * 2 * PI) * 1.2; return { 'Right Arm': A(0, 0, s), 'Left Arm': A(0, 0, s), 'Right Leg': A(0, 0, s), 'Left Leg': A(0, 0, s) }; },
  jump: () => ({ 'Right Arm': A(0, 0, PI), 'Left Arm': A(0, 0, -PI), 'Right Leg': A(0, 0, 0), 'Left Leg': A(0, 0, 0) }),
  fall: () => ({ 'Right Arm': A(0, 0, PI), 'Left Arm': A(0, 0, -PI), 'Right Leg': A(0, 0, 0.3), 'Left Leg': A(0, 0, -0.3) }),
  climb: (p) => { const s = Math.sin(p * 2 * PI) * 0.6; return { 'Right Arm': A(0, 0, -PI * 0.8 + s), 'Left Arm': A(0, 0, PI * 0.8 + s), 'Right Leg': A(0, 0, s), 'Left Leg': A(0, 0, -s) }; },
  sit: () => ({ 'Right Arm': A(0, 0, -0.5), 'Left Arm': A(0, 0, 0.5), 'Right Leg': A(0, 0, -PI / 2), 'Left Leg': A(0, 0, PI / 2) }),
  toolnone: () => ({ 'Right Arm': A(0, 0, -PI / 2) }),
  wave: (p) => { const s = Math.sin(p * 4 * PI) * 0.3; return { 'Right Arm': A(0, 0, -PI * 0.85 + s) }; },
  point: () => ({ 'Right Arm': A(0, 0, -PI / 2) }),
  cheer: () => ({ 'Right Arm': A(0, 0, -PI * 0.9), 'Left Arm': A(0, 0, PI * 0.9) }),
  laugh: () => ({ Head: A(0, 0, 0) }),
  dance: (p) => { const s = Math.sin(p * 2 * PI); return { 'Right Arm': A(0, 0, -PI * 0.7 + s * 0.5), 'Left Arm': A(0, 0, PI * 0.7 + s * 0.5), 'Right Leg': A(0, 0, s * 0.4), 'Left Leg': A(0, 0, s * 0.4) }; },
};
R6.swim = R6.run; R6.swimidle = R6.idle; R6.dance2 = R6.dance; R6.dance3 = R6.dance;

const META = {
  idle: [2.5, true, 'Idle'], walk: [0.9, true, 'Movement'], run: [0.6, true, 'Movement'], jump: [0.3, false, 'Movement'], fall: [0.8, true, 'Core'],
  climb: [0.9, true, 'Movement'], sit: [1, true, 'Core'], toolnone: [1, true, 'Idle'], swim: [1, true, 'Movement'], swimidle: [2, true, 'Core'],
  wave: [2, false, 'Action'], point: [1.5, false, 'Action'], cheer: [1.5, false, 'Action'], laugh: [1.5, false, 'Action'], dance: [1.2, true, 'Core'], dance2: [1.2, true, 'Core'], dance3: [1.2, true, 'Core'],
};
const cache = new Map();

export function roleForAnimationId(id) {
  const s = String(id || '');
  let m = /bloxlab:\/\/anim\/(\w+)/.exec(s);
  if (m) return m[1];
  m = /(\d+)\s*$/.exec(s);
  return m ? DEFAULT_IDS[m[1]] || null : null;
}

/** Clip for a role ("walk") or a well known default animation id. */
export function proceduralClip(idOrRole, rig = 'R15') {
  const role = META[idOrRole] ? idOrRole : roleForAnimationId(idOrRole);
  if (!role) return null;
  const k = `${rig}:${role}`;
  if (cache.has(k)) return cache.get(k);
  const fn = (rig === 'R6' ? R6 : R15)[role];
  if (!fn) return null;
  const [len, loop, priority] = META[role];
  const samples = loop ? 16 : 4;
  const poses = new Map();
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * len;
    const pose = fn(i / samples);
    for (const [name, cf] of Object.entries(pose)) {
      if (!poses.has(name)) poses.set(name, []);
      poses.get(name).push({ t, cf, style: 'Linear', dir: 'In', w: 1 });
    }
  }
  const clip = { length: len, loop, priority, poses, keyframes: [], markers: [], procedural: role };
  cache.set(k, clip);
  return clip;
}
