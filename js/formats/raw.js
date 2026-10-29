// Format-neutral instance tree produced by the file readers and consumed by the writers.
// props: Map<name, { t: TypeName, v: value }>
export class RawInstance {
  constructor(className) {
    this.className = className;
    this.props = new Map();
    this.children = [];
    this.parent = null;
    this.isService = false;
  }
  set(name, t, v) { this.props.set(name, { t, v }); return this; }
  get(name) { return this.props.get(name)?.v; }
  add(child) { child.parent = this; this.children.push(child); return child; }
  *descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
}

export const utf8 = {
  enc: new TextEncoder(),
  dec: new TextDecoder(),
  strict: new TextDecoder('utf-8', { fatal: true }),
};

/** Properties stored as raw bytes even though the binary format calls them "String". */
export const BINARY_PROPS = new Set(['AttributesSerialize', 'Tags', 'SmoothGrid', 'PhysicsGrid', 'MaterialColors', 'PhysicalConfigData', 'MeshData', 'ChildData', 'ModelMeshData', 'SerializedOverrides', 'HistoryId', 'PackageContent', 'GuidBinaryString', 'LevelOfDetail', 'AttributesReplicate', 'LODData', 'PhysicsData', 'InitialSize', 'MeshData2']);

export function bytesToBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
