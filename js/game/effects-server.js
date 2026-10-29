// Server-side effect of Explosion instances: impulses, joint breaking and Hit events.
import { Vector3 } from '../engine/datatypes.js';
import { killHumanoid } from '../engine/classes/humanoid.js';

const JOINTS = new Set(['Weld', 'ManualWeld', 'Snap', 'Glue', 'Motor6D', 'Motor', 'WeldConstraint', 'RigidConstraint']);

export function explodeServer(world, ex) {
  const P = ex.props;
  const pos = P.Position || Vector3.zero;
  const radius = Math.max(0, P.BlastRadius ?? 4);
  const pressure = P.BlastPressure ?? 500000;
  const breakFrac = (P.DestroyJointRadiusPercent ?? 100) / 100;
  const ws = world.dm.findFirstChildOfClass('Workspace');
  const hits = [];
  for (const d of ws.descendants()) {
    if (!d.isA('BasePart') || d.ClassName === 'Terrain') continue;
    const cf = d.props.CFrame;
    const half = d.props.Size.mul(0.5);
    // distance from the explosion to the part's box
    const local = cf.pointToObject(pos);
    const q = new Vector3(Math.max(Math.abs(local.X) - half.X, 0), Math.max(Math.abs(local.Y) - half.Y, 0), Math.max(Math.abs(local.Z) - half.Z, 0));
    const dist = q.Magnitude;
    if (dist > radius) continue;
    hits.push([d, dist]);
  }
  const hitModels = new Set();
  for (const [part, dist] of hits) {
    ex.fire('Hit', part, dist);
    if (part.props.Anchored) continue;
    if (dist <= radius * breakFrac && ex.props.ExplosionType?.Name !== 'NoCraters') {
      for (const j of [...part.children]) if (JOINTS.has(j.ClassName)) j.destroy();
      // joints living elsewhere that reference this part
      const model = part.parent;
      if (model) for (const d of model.descendants()) if (JOINTS.has(d.ClassName) && (d.props.Part0 === part || d.props.Part1 === part)) d.destroy();
    }
    if (part.parent) hitModels.add(part.parent);
  }
  for (const model of hitModels) {
    const hum = model.findFirstChildOfClass && model.findFirstChildOfClass('Humanoid');
    if (hum && !model.findFirstChildOfClass('ForceField') && (!model.findFirstChild('Head') || !hasNeck(model))) killHumanoid(hum);
  }
  // push what is left (after assemblies were rebuilt)
  world.scheduler.timer(0, () => {
    for (const [part, dist] of hits) {
      if (!part.dm || part.props.Anchored) continue;
      const dir = part.props.CFrame.Position.sub(pos);
      const n = dir.Magnitude > 1e-3 ? dir.Unit : new Vector3(0, 1, 0);
      const falloff = 1 - Math.min(1, dist / Math.max(radius, 0.01));
      const area = Math.max(1, part.props.Size.X * part.props.Size.Z);
      const impulse = n.mul((pressure / 4000) * area * falloff * 0.6);
      world.hooks.applyImpulse?.(part, impulse);
    }
  });
}

function hasNeck(model) {
  for (const d of model.descendants()) if ((d.ClassName === 'Motor6D' || d.ClassName === 'Weld') && d.props.Name === 'Neck') return true;
  return false;
}
