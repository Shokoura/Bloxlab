// Collision groups: the place file's Workspace.CollisionGroupData blob, the runtime table used by
// physics ({ names, off }), and the replicated Workspace.CollisionGroupsList ([[name, mask], ...]).

/** CollisionGroupData: u8 version, u8 count, then per group: u8 id, u8 4, u32 mask, u8 nameLength, name */
export function decodeCollisionGroupData(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const out = [];
  let i = 2;
  const count = bytes[1];
  for (let g = 0; g < count && i < bytes.length; g++) {
    const id = bytes[i++];
    const maskLen = bytes[i++];
    let mask = 0;
    for (let k = 0; k < maskLen; k++) mask |= bytes[i++] << (8 * k);
    const len = bytes[i++];
    let name = '';
    for (let k = 0; k < len; k++) name += String.fromCharCode(bytes[i++]);
    out[id] = [name, mask >>> 0];
  }
  return out.filter(Boolean);
}

export function encodeCollisionGroupData(list) {
  const out = [1, list.length];
  list.forEach(([name, mask], id) => {
    out.push(id, 4, mask & 255, (mask >>> 8) & 255, (mask >>> 16) & 255, (mask >>> 24) & 255, name.length);
    for (const ch of name) out.push(ch.charCodeAt(0) & 255);
  });
  return new Uint8Array(out);
}

/** [[name, mask]] -> { names, off: Set('a|b') } */
export function groupsFromList(list) {
  const names = list.map((g) => g[0]);
  if (!names.includes('Default')) names.unshift('Default');
  const maskOf = new Map(list.map(([n, m]) => [n, m >>> 0]));
  const off = new Set();
  names.forEach((a, i) => names.forEach((b, j) => {
    const ma = maskOf.has(a) ? maskOf.get(a) : 0xffffffff, mb = maskOf.has(b) ? maskOf.get(b) : 0xffffffff;
    if (!((ma >>> j) & 1) || !((mb >>> i) & 1)) off.add([a, b].sort().join('|'));
  }));
  return { names, off };
}

export function listFromGroups(g) {
  return g.names.map((a) => {
    let mask = 0;
    g.names.forEach((b, j) => { if (!g.off.has([a, b].sort().join('|'))) mask |= 1 << j; });
    return [a, mask >>> 0];
  });
}

/** The world's collision group table, created from the Workspace on first use. */
export function groupsOfWorld(w) {
  if (w.collisionGroups) return w.collisionGroups;
  const ws = w.dm && w.dm.findFirstChildOfClass('Workspace');
  const list = ws && ws.props.CollisionGroupsList;
  w.collisionGroups = list && list.length ? groupsFromList(list) : { names: ['Default'], off: new Set() };
  return w.collisionGroups;
}

/** After a PhysicsService change: store the table on the Workspace so clients get it too. */
export function publishGroups(w) {
  const ws = w.dm && w.dm.findFirstChildOfClass('Workspace');
  if (ws && w.collisionGroups) ws.rawSet('CollisionGroupsList', listFromGroups(w.collisionGroups));
  w.hooks.collisionGroupsChanged?.();
}
