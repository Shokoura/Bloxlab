#!/usr/bin/env node
// Builds js/engine/reflection.js (class / property / enum database) from
//   * rbx-dom's reflection database (database.msgpack)
//       https://raw.githubusercontent.com/rojo-rbx/rbx-dom/master/rbx_reflection_database/database.msgpack
//   * the Roblox API dump (events + functions)
//       https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json
//
// usage: node tools/build-reflection.mjs <database.msgpack> <API-Dump.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [dbFile, dumpFile] = process.argv.slice(2);
if (!dbFile || !dumpFile) { console.error('usage: node tools/build-reflection.mjs <database.msgpack> <API-Dump.json>'); process.exit(1); }

// ---- tiny msgpack decoder (enough for the reflection database) ----
function msgpackDecode(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const td = new TextDecoder();
  const str = (n) => { const s = td.decode(buf.subarray(o, o + n)); o += n; return s; };
  const bin = (n) => { const b = buf.slice(o, o + n); o += n; return b; };
  const arr = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = read(); return a; };
  const map = (n) => { const m = {}; for (let i = 0; i < n; i++) { const k = read(); m[k] = read(); } return m; };
  function read() {
    const t = buf[o++];
    if (t <= 0x7f) return t;
    if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f);
    if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f);
    if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
    if (t >= 0xe0) return t - 256;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { const n = buf[o]; o += 1; return bin(n); }
      case 0xc5: { const n = dv.getUint16(o); o += 2; return bin(n); }
      case 0xc6: { const n = dv.getUint32(o); o += 4; return bin(n); }
      case 0xca: { const v = dv.getFloat32(o); o += 4; return v; }
      case 0xcb: { const v = dv.getFloat64(o); o += 8; return v; }
      case 0xcc: return buf[o++];
      case 0xcd: { const v = dv.getUint16(o); o += 2; return v; }
      case 0xce: { const v = dv.getUint32(o); o += 4; return v; }
      case 0xcf: { const v = Number(dv.getBigUint64(o)); o += 8; return v; }
      case 0xd0: { const v = dv.getInt8(o); o += 1; return v; }
      case 0xd1: { const v = dv.getInt16(o); o += 2; return v; }
      case 0xd2: { const v = dv.getInt32(o); o += 4; return v; }
      case 0xd3: { const v = Number(dv.getBigInt64(o)); o += 8; return v; }
      case 0xd9: { const n = buf[o]; o += 1; return str(n); }
      case 0xda: { const n = dv.getUint16(o); o += 2; return str(n); }
      case 0xdb: { const n = dv.getUint32(o); o += 4; return str(n); }
      case 0xdc: { const n = dv.getUint16(o); o += 2; return arr(n); }
      case 0xdd: { const n = dv.getUint32(o); o += 4; return arr(n); }
      case 0xde: { const n = dv.getUint16(o); o += 2; return map(n); }
      case 0xdf: { const n = dv.getUint32(o); o += 4; return map(n); }
      default: throw new Error('msgpack: unsupported type 0x' + t.toString(16) + ' at ' + (o - 1));
    }
  }
  return read();
}

const db = msgpackDecode(new Uint8Array(fs.readFileSync(dbFile)));
const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
const [, classes, enums] = db;

const FONT_WEIGHTS = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Heavy: 900 };
const mat = (r) => [r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2]];
const round = (x) => (typeof x === 'number' ? Math.fround(x) === x && !Number.isInteger(x) ? +x.toPrecision(7) : x : x);

// Converts a rbx-dom variant into Bloxlab's compact "wire" value (see js/engine/values.js).
function wire(v) {
  const [k] = Object.keys(v);
  const x = v[k];
  switch (k) {
    case 'Bool': case 'Int32': case 'Int64': case 'Float64': case 'String': case 'Enum': case 'BrickColor': case 'Faces': case 'Axes':
      return x;
    case 'Float32': return round(x);
    case 'ContentId': return x;
    case 'Content': return typeof x === 'string' ? '' : (x.Uri ?? '');
    case 'Vector3': case 'Vector2': case 'NumberRange': case 'UDim': case 'Vector3int16': return x.map(round);
    case 'Color3': return x.map(round);
    case 'Color3uint8': return x.map((c) => +(c / 255).toPrecision(7));
    case 'CFrame': return [...x[0], ...mat(x[1])].map(round);
    case 'OptionalCFrame': return x ? [...x[0], ...mat(x[1])].map(round) : null;
    case 'UDim2': return [round(x[0][0]), x[0][1], round(x[1][0]), x[1][1]];
    case 'Rect': return [...x[0], ...x[1]].map(round);
    case 'Ray': return [...x[0], ...x[1]].map(round);
    case 'NumberSequence': return x[0].map((kp) => kp.map(round));
    case 'ColorSequence': return x[0].map((kp) => [round(kp[0]), ...kp[1].map(round)]);
    case 'Font': return [x[0], FONT_WEIGHTS[x[1]] ?? 400, x[2]];
    case 'PhysicalProperties': return x === 'Default' ? null : [x.density, x.friction, x.elasticity, x.frictionWeight, x.elasticityWeight].map(round);
    case 'Ref': return null;
    case 'Attributes': return undefined;
    case 'Tags': return undefined;
    default: return undefined; // UniqueId, SharedString, BinaryString, SecurityCapabilities, NetAssetRef, MaterialColors ...
  }
}

function typeName(t) {
  if (t.Enum) return 'Enum:' + t.Enum;
  return t.Value;
}

const F = { READONLY: 1, NOTSCRIPTABLE: 2, NOTREPLICATED: 4, DEPRECATED: 8, HIDDEN: 16, SERIALIZES: 32, ALIAS: 64, WRITEONLY: 128, MIGRATE: 256 };
const CF = { NOTCREATABLE: 1, SERVICE: 2, NOTBROWSABLE: 4, DEPRECATED: 8, NOTREPLICATED: 16, PLAYERREPLICATED: 32 };

// events + functions from the API dump
const members = {};
for (const c of dump.Classes) {
  const ev = [], fn = [], cb = [];
  for (const m of c.Members) {
    const tags = m.Tags || [];
    if (tags.includes('Hidden') && tags.includes('NotScriptable')) continue;
    if (m.MemberType === 'Event') ev.push(m.Name);
    else if (m.MemberType === 'Function') fn.push(m.Name);
    else if (m.MemberType === 'Callback') cb.push(m.Name);
  }
  members[c.Name] = { ev, fn, cb, tags: c.Tags || [], mem: c.MemoryCategory };
}

const out = { classes: {}, enums: {} };
for (const [name, c] of Object.entries(classes)) {
  const [, ctags, superclass, props, defaults] = c;
  let cf = 0;
  for (const t of ctags) cf |= CF[t.toUpperCase()] || 0;
  const p = {};
  for (const [pn, d] of Object.entries(props)) {
    const [, scriptability, type, ptags, kind] = d;
    let f = 0;
    let extra;
    if (scriptability === 'None') f |= F.NOTSCRIPTABLE;
    if (scriptability === 'Read' || ptags.includes('ReadOnly')) f |= F.READONLY;
    if (scriptability === 'Write' || ptags.includes('WriteOnly')) f |= F.WRITEONLY;
    if (ptags.includes('NotReplicated')) f |= F.NOTREPLICATED;
    if (ptags.includes('Deprecated')) f |= F.DEPRECATED;
    if (ptags.includes('Hidden')) f |= F.HIDDEN;
    if (kind.Alias) { f |= F.ALIAS; extra = kind.Alias[0]; }
    else if (kind.Canonical) {
      const s = kind.Canonical[0];
      if (s === 'Serializes') f |= F.SERIALIZES;
      else if (s && s.SerializesAs) { f |= F.SERIALIZES; extra = s.SerializesAs; }
      else if (s && s.Migrate) { f |= F.MIGRATE; extra = s.Migrate[0]; }
    }
    const entry = [typeName(type), f];
    if (extra !== undefined) entry.push(extra);
    p[pn] = entry;
  }
  const d = {};
  for (const [pn, v] of Object.entries(defaults || {})) {
    const w = wire(v);
    if (w !== undefined) d[pn] = w;
  }
  const m = members[name] || { ev: [], fn: [], cb: [] };
  const entry = { s: superclass || null, f: cf, p, d };
  if (m.ev.length) entry.e = m.ev;
  if (m.fn.length) entry.m = m.fn;
  if (m.cb.length) entry.cb = m.cb;
  out.classes[name] = entry;
}
for (const [name, e] of Object.entries(enums)) {
  const items = e[1];
  out.enums[name] = items;
}

const json = JSON.stringify(out);
const file = path.join(root, 'js/engine/reflection.js');
fs.writeFileSync(file, `// Generated by tools/build-reflection.mjs from rbx-dom's reflection database and the Roblox API dump. Do not edit.\nexport const F = ${JSON.stringify(F)};\nexport const CF = ${JSON.stringify(CF)};\nexport default ${json};\n`);
console.log(`wrote ${file} (${(json.length / 1024).toFixed(0)} KB, ${Object.keys(out.classes).length} classes, ${Object.keys(out.enums).length} enums)`);
