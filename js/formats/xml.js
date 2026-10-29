// Roblox XML model format (.rbxlx / .rbxmx) reader + writer.
// Spec: https://github.com/rojo-rbx/rbx-dom/blob/master/docs/xml.md
import { RawInstance, utf8, bytesToBase64, base64ToBytes, BINARY_PROPS } from './raw.js';
import {
  Vector3, Vector2, CFrame, Color3, UDim, UDim2, Ray, Faces, Axes, Rect, NumberRange,
  NumberSequence, NumberSequenceKeypoint, ColorSequence, ColorSequenceKeypoint, PhysicalProperties,
  Vector3int16, Font, FONT_WEIGHTS,
} from '../engine/datatypes.js';

// ------------------------------------------------------------------ tiny XML DOM
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeEnt = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});

export function parseXml(text) {
  let i = 0;
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += decodeEnt(text.slice(i)); break; }
    if (lt > i) top.text += decodeEnt(text.slice(i, lt));
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      top.text += text.slice(lt + 9, end < 0 ? n : end);
      top.cdata = true;
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt); i = end < 0 ? n : end + 3;
    } else if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const end = text.indexOf('>', lt); i = end < 0 ? n : end + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      stack.pop();
      if (!stack.length) stack.push(root);
      i = end + 1;
    } else {
      // read tag, honouring quoted attribute values that may contain '>'
      let j = lt + 1;
      let q = null;
      while (j < n) { const c = text[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j++; }
      let body = text.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      const el = { name: m ? m[1] : '', attrs: {}, children: [], text: '' };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = re.exec(body))) el.attrs[a[1]] = decodeEnt(a[3] ?? a[4] ?? '');
      top.children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  return root;
}
const child = (el, name) => el.children.find((c) => c.name === name);
const num = (s) => {
  const t = String(s ?? '').trim();
  if (/^\+?INF$/i.test(t)) return Infinity;
  if (/^-INF$/i.test(t)) return -Infinity;
  if (/^NAN$/i.test(t)) return NaN;
  return Number(t) || 0;
};
const cnum = (el, name) => num(child(el, name)?.text);

// ------------------------------------------------------------------ reading
export function readXml(text) {
  if (text instanceof Uint8Array) text = utf8.dec.decode(text);
  const doc = parseXml(text);
  const rob = child(doc, 'roblox');
  if (!rob) throw new Error('Not a Roblox XML file');
  const meta = new Map();
  const shared = new Map();
  const warnings = [];
  for (const c of rob.children) {
    if (c.name === 'Meta') meta.set(c.attrs.name, c.text);
    if (c.name === 'SharedStrings') for (const s of c.children) if (s.name === 'SharedString') shared.set(s.attrs.md5, base64ToBytes(s.text));
  }
  const byRef = new Map();
  const pendingRefs = [];
  const build = (el) => {
    const ri = new RawInstance(el.attrs.class);
    if (el.attrs.referent) byRef.set(el.attrs.referent, ri);
    for (const c of el.children) {
      if (c.name === 'Properties') {
        for (const p of c.children) {
          try { readProp(ri, p, shared, pendingRefs); } catch (err) { warnings.push(`${ri.className}.${p.attrs.name}: ${err.message}`); }
        }
      } else if (c.name === 'Item') ri.add(build(c));
    }
    return ri;
  };
  const roots = rob.children.filter((c) => c.name === 'Item').map(build);
  for (const [ri, name, ref] of pendingRefs) ri.set(name, 'Ref', byRef.get(ref) || null);
  return { roots, meta, warnings };
}

const vec3 = (el) => new Vector3(cnum(el, 'X'), cnum(el, 'Y'), cnum(el, 'Z'));
const vec2 = (el) => new Vector2(cnum(el, 'X'), cnum(el, 'Y'));
const cframe = (el) => new CFrame(...['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map((k) => cnum(el, k)));
const contentOf = (el) => { const u = child(el, 'url') || child(el, 'uri'); return u ? u.text.trim() : ''; };

function readProp(ri, p, shared, pendingRefs) {
  const name = p.attrs.name;
  const tx = p.text;
  switch (p.name) {
    case 'string': {
      if (BINARY_PROPS.has(name)) return ri.set(name, 'BinaryString', utf8.enc.encode(tx));
      return ri.set(name, 'String', tx);
    }
    case 'ProtectedString': return ri.set(name, 'ProtectedString', tx);
    case 'BinaryString': return ri.set(name, 'BinaryString', base64ToBytes(tx));
    case 'bool': return ri.set(name, 'Bool', tx.trim().toLowerCase() === 'true');
    case 'int': return ri.set(name, /^brickcolor$/i.test(name) ? 'BrickColor' : 'Int32', Math.trunc(num(tx)));
    case 'BrickColor': return ri.set(name, 'BrickColor', Math.trunc(num(tx)));
    case 'int64': return ri.set(name, 'Int64', Number(tx.trim()) || 0);
    case 'float': return ri.set(name, 'Float32', num(tx));
    case 'double': return ri.set(name, 'Float64', num(tx));
    case 'token': return ri.set(name, 'Enum', Math.trunc(num(tx)));
    case 'Vector3': return ri.set(name, 'Vector3', vec3(p));
    case 'Vector2': return ri.set(name, 'Vector2', vec2(p));
    case 'Vector3int16': return ri.set(name, 'Vector3int16', new Vector3int16(cnum(p, 'X'), cnum(p, 'Y'), cnum(p, 'Z')));
    case 'CoordinateFrame': return ri.set(name, 'CFrame', cframe(p));
    case 'OptionalCoordinateFrame': { const c = child(p, 'CFrame'); return ri.set(name, 'OptionalCFrame', c ? cframe(c) : null); }
    case 'Color3': {
      if (!p.children.length) { const v = Math.trunc(num(tx)) >>> 0; return ri.set(name, 'Color3', Color3.fromRGB((v >> 16) & 255, (v >> 8) & 255, v & 255)); }
      return ri.set(name, 'Color3', new Color3(cnum(p, 'R'), cnum(p, 'G'), cnum(p, 'B')));
    }
    case 'Color3uint8': { const v = Math.trunc(num(tx)) >>> 0; return ri.set(name, 'Color3uint8', Color3.fromRGB((v >> 16) & 255, (v >> 8) & 255, v & 255)); }
    case 'UDim': return ri.set(name, 'UDim', new UDim(cnum(p, 'S'), cnum(p, 'O')));
    case 'UDim2': return ri.set(name, 'UDim2', new UDim2(cnum(p, 'XS'), cnum(p, 'XO'), cnum(p, 'YS'), cnum(p, 'YO')));
    case 'Ray': return ri.set(name, 'Ray', new Ray(vec3(child(p, 'origin')), vec3(child(p, 'direction'))));
    case 'Rect2D': return ri.set(name, 'Rect', new Rect(vec2(child(p, 'min')), vec2(child(p, 'max'))));
    case 'Faces': return ri.set(name, 'Faces', new Faces(cnum(p, 'faces')));
    case 'Axes': return ri.set(name, 'Axes', new Axes(cnum(p, 'axes')));
    case 'NumberRange': { const [a, b] = tx.trim().split(/\s+/).map(num); return ri.set(name, 'NumberRange', new NumberRange(Math.min(a, b ?? a), Math.max(a, b ?? a))); }
    case 'NumberSequence': {
      const v = tx.trim().split(/\s+/).filter(Boolean).map(num); const k = [];
      for (let i = 0; i + 2 < v.length + 0; i += 3) k.push(new NumberSequenceKeypoint(v[i], v[i + 1], v[i + 2]));
      return ri.set(name, 'NumberSequence', new NumberSequence(k));
    }
    case 'ColorSequence': {
      const v = tx.trim().split(/\s+/).filter(Boolean).map(num); const k = [];
      for (let i = 0; i + 4 < v.length + 0; i += 5) k.push(new ColorSequenceKeypoint(v[i], new Color3(v[i + 1], v[i + 2], v[i + 3])));
      return ri.set(name, 'ColorSequence', new ColorSequence(k));
    }
    case 'PhysicalProperties': {
      if (child(p, 'CustomPhysics')?.text.trim().toLowerCase() !== 'true') return ri.set(name, 'PhysicalProperties', null);
      const pp = new PhysicalProperties(cnum(p, 'Density'), cnum(p, 'Friction'), cnum(p, 'Elasticity'), cnum(p, 'FrictionWeight'), cnum(p, 'ElasticityWeight'));
      if (child(p, 'AcousticAbsorption')) pp.AcousticAbsorption = cnum(p, 'AcousticAbsorption');
      return ri.set(name, 'PhysicalProperties', pp);
    }
    case 'Ref': { const r = tx.trim(); if (!r || r === 'null') return ri.set(name, 'Ref', null); pendingRefs.push([ri, name, r]); return undefined; }
    case 'Content': {
      const u = child(p, 'uri') || child(p, 'url');
      if (u) return ri.set(name, 'Content', u.text.trim());
      if (child(p, 'null') || child(p, 'Ref')) return ri.set(name, 'Content', '');
      return ri.set(name, 'ContentId', contentOf(p) || tx.trim()); // pre-645 "Content" == ContentId
    }
    case 'ContentId': return ri.set(name, 'ContentId', contentOf(p));
    case 'SharedString': return ri.set(name, 'SharedString', shared.get(tx.trim()) || new Uint8Array(0));
    case 'NetAssetRef': return ri.set(name, 'NetAssetRef', shared.get(tx.trim()) || new Uint8Array(0));
    case 'UniqueId': {
      const h = tx.trim();
      const b = new Uint8Array(16);
      for (let i = 0; i < 16; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0;
      // XML: random(8, rotl 1) time(4) index(4) -> binary: index(4) time(4) random(8)
      const out = new Uint8Array(16);
      out.set(b.subarray(12, 16), 0); out.set(b.subarray(8, 12), 4);
      let r = 0n; for (let i = 0; i < 8; i++) r = (r << 8n) | BigInt(b[i]);
      r = BigInt.asUintN(64, (r >> 1n) | (r << 63n));
      for (let i = 15; i >= 8; i--) { out[i] = Number(r & 255n); r >>= 8n; }
      return ri.set(name, 'UniqueId', out);
    }
    case 'Font': {
      const st = child(p, 'Style')?.text.trim();
      const w = child(p, 'Weight')?.text.trim();
      const f = new Font(contentOf(child(p, 'Family') || { children: [] }), FONT_WEIGHTS[w] ?? (num(w) || 400), st === 'Italic' ? 'Italic' : 'Normal');
      const c = child(p, 'CachedFaceId'); if (c) f.CachedFaceId = contentOf(c);
      return ri.set(name, 'Font', f);
    }
    case 'SecurityCapabilities': return ri.set(name, 'SecurityCapabilities', Number(tx.trim()) || 0);
    default:
      throw new Error(`unsupported XML type <${p.name}>`);
  }
}

// ------------------------------------------------------------------ writing
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fnum = (x) => {
  if (Number.isNaN(x)) return 'NAN';
  if (x === Infinity) return 'INF';
  if (x === -Infinity) return '-INF';
  return String(x);
};
const f32s = (x) => fnum(Number.isFinite(x) ? +Math.fround(x).toPrecision(9) : x);
const cdata = (s) => `<![CDATA[${String(s).split(']]>').join(']]]]><![CDATA[>')}]]>`;

export function writeXml(roots, { model = false } = {}) {
  const refs = new Map();
  let counter = 0;
  const refOf = (ri) => { if (!refs.has(ri)) refs.set(ri, 'RBX' + (++counter).toString(16).toUpperCase().padStart(8, '0') + 'B10C5AB'); return refs.get(ri); };
  const shared = new Map();
  const out = ['<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">'];
  if (model) out.push('\t<Meta name="ExplicitAutoJoints">true</Meta>');
  const v3 = (v) => `<X>${f32s(v.X)}</X><Y>${f32s(v.Y)}</Y><Z>${f32s(v.Z)}</Z>`;
  const v2 = (v) => `<X>${f32s(v.X)}</X><Y>${f32s(v.Y)}</Y>`;
  const cf = (c) => `<X>${f32s(c.X)}</X><Y>${f32s(c.Y)}</Y><Z>${f32s(c.Z)}</Z>` + ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map((k, i) => `<${k}>${f32s(c.r[i])}</${k}>`).join('');
  const sharedRef = (b) => {
    const bytes = typeof b === 'string' ? utf8.enc.encode(b) : b;
    const key = bytesToBase64(bytes);
    let id = shared.get(key);
    if (!id) {
      const h = new Uint8Array(16);
      let a = 0x811c9dc5, c = 0x01000193 ^ bytes.length;
      for (let i = 0; i < bytes.length; i++) { a = Math.imul(a ^ bytes[i], 16777619) >>> 0; c = Math.imul(c + bytes[i], 2246822519) >>> 0; h[i & 15] ^= (a ^ (c >>> 13)) & 255; }
      for (let i = 0; i < 16; i++) { a = Math.imul(a ^ h[i], 16777619) >>> 0; h[i] = (h[i] + a) & 255; }
      id = bytesToBase64(h); shared.set(key, id);
    }
    return id;
  };
  const prop = (name, { t, v }) => {
    const n = esc(name);
    switch (t) {
      case 'String': return `<string name="${n}">${esc(v)}</string>`;
      case 'ProtectedString': return `<ProtectedString name="${n}">${cdata(v)}</ProtectedString>`;
      case 'BinaryString': case 'Tags': case 'Attributes': return `<BinaryString name="${n}">${bytesToBase64(typeof v === 'string' ? utf8.enc.encode(v) : v)}</BinaryString>`;
      case 'Bytecode': return null;
      case 'Bool': return `<bool name="${n}">${v ? 'true' : 'false'}</bool>`;
      case 'Int32': return `<int name="${n}">${v | 0}</int>`;
      case 'BrickColor': return `<int name="${n}">${typeof v === 'number' ? v : v.Number}</int>`;
      case 'Int64': return `<int64 name="${n}">${Math.trunc(v)}</int64>`;
      case 'Float32': return `<float name="${n}">${f32s(v)}</float>`;
      case 'Float64': return `<double name="${n}">${fnum(v)}</double>`;
      case 'Enum': return `<token name="${n}">${typeof v === 'number' ? v : v?.Value ?? 0}</token>`;
      case 'Vector3': return `<Vector3 name="${n}">${v3(v)}</Vector3>`;
      case 'Vector2': return `<Vector2 name="${n}">${v2(v)}</Vector2>`;
      case 'Vector3int16': return `<Vector3int16 name="${n}"><X>${v.X}</X><Y>${v.Y}</Y><Z>${v.Z}</Z></Vector3int16>`;
      case 'CFrame': return `<CoordinateFrame name="${n}">${cf(v)}</CoordinateFrame>`;
      case 'OptionalCFrame': return `<OptionalCoordinateFrame name="${n}">${v ? `<CFrame>${cf(v)}</CFrame>` : ''}</OptionalCoordinateFrame>`;
      case 'Color3': return `<Color3 name="${n}"><R>${f32s(v.R)}</R><G>${f32s(v.G)}</G><B>${f32s(v.B)}</B></Color3>`;
      case 'Color3uint8': { const c = [v.R, v.G, v.B].map((x) => Math.max(0, Math.min(255, Math.round(x * 255)))); return `<Color3uint8 name="${n}">${((0xff << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0}</Color3uint8>`; }
      case 'UDim': return `<UDim name="${n}"><S>${f32s(v.Scale)}</S><O>${v.Offset}</O></UDim>`;
      case 'UDim2': return `<UDim2 name="${n}"><XS>${f32s(v.X.Scale)}</XS><XO>${v.X.Offset}</XO><YS>${f32s(v.Y.Scale)}</YS><YO>${v.Y.Offset}</YO></UDim2>`;
      case 'Ray': return `<Ray name="${n}"><origin>${v3(v.Origin)}</origin><direction>${v3(v.Direction)}</direction></Ray>`;
      case 'Rect': return `<Rect2D name="${n}"><min>${v2(v.Min)}</min><max>${v2(v.Max)}</max></Rect2D>`;
      case 'Faces': return `<Faces name="${n}"><faces>${v.bits}</faces></Faces>`;
      case 'Axes': return `<Axes name="${n}"><axes>${v.bits}</axes></Axes>`;
      case 'NumberRange': return `<NumberRange name="${n}">${f32s(v.Min)} ${f32s(v.Max)} </NumberRange>`;
      case 'NumberSequence': return `<NumberSequence name="${n}">${v.Keypoints.map((k) => `${f32s(k.Time)} ${f32s(k.Value)} ${f32s(k.Envelope)} `).join('')}</NumberSequence>`;
      case 'ColorSequence': return `<ColorSequence name="${n}">${v.Keypoints.map((k) => `${f32s(k.Time)} ${f32s(k.Value.R)} ${f32s(k.Value.G)} ${f32s(k.Value.B)} 0 `).join('')}</ColorSequence>`;
      case 'PhysicalProperties':
        if (!v) return `<PhysicalProperties name="${n}"><CustomPhysics>false</CustomPhysics></PhysicalProperties>`;
        return `<PhysicalProperties name="${n}"><CustomPhysics>true</CustomPhysics><Density>${f32s(v.Density)}</Density><Friction>${f32s(v.Friction)}</Friction><Elasticity>${f32s(v.Elasticity)}</Elasticity><FrictionWeight>${f32s(v.FrictionWeight)}</FrictionWeight><ElasticityWeight>${f32s(v.ElasticityWeight)}</ElasticityWeight><AcousticAbsorption>${f32s(v.AcousticAbsorption ?? 1)}</AcousticAbsorption></PhysicalProperties>`;
      case 'Ref': return `<Ref name="${n}">${v ? refOf(v) : 'null'}</Ref>`;
      case 'Content': return `<Content name="${n}">${v ? `<uri>${esc(v)}</uri>` : '<null></null>'}</Content>`;
      case 'ContentId': return `<ContentId name="${n}">${v ? `<url>${esc(v)}</url>` : '<null></null>'}</ContentId>`;
      case 'SharedString': return `<SharedString name="${n}">${sharedRef(v)}</SharedString>`;
      case 'NetAssetRef': return `<NetAssetRef name="${n}">${sharedRef(v)}</NetAssetRef>`;
      case 'UniqueId': {
        const b = v || new Uint8Array(16);
        let r = 0n; for (let i = 8; i < 16; i++) r = (r << 8n) | BigInt(b[i]);
        r = BigInt.asUintN(64, (r << 1n) | (r >> 63n));
        const hex = (x, len) => x.toString(16).padStart(len, '0');
        const time = (b[4] << 24 | b[5] << 16 | b[6] << 8 | b[7]) >>> 0;
        const idx = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0;
        return `<UniqueId name="${n}">${hex(r, 16)}${hex(time, 8)}${hex(idx, 8)}</UniqueId>`;
      }
      case 'Font':
        return `<Font name="${n}"><Family><url>${esc(v.Family)}</url></Family><Weight>${v.Weight}</Weight><Style>${v.Style}</Style>${v.CachedFaceId ? `<CachedFaceId><url>${esc(v.CachedFaceId)}</url></CachedFaceId>` : ''}</Font>`;
      case 'SecurityCapabilities': return `<SecurityCapabilities name="${n}">${Math.trunc(v)}</SecurityCapabilities>`;
      default: return null;
    }
  };
  const item = (ri, depth) => {
    const pad = '\t'.repeat(depth);
    out.push(`${pad}<Item class="${esc(ri.className)}" referent="${refOf(ri)}">`);
    out.push(`${pad}\t<Properties>`);
    for (const [k, e] of ri.props) { const s = prop(k, e); if (s) out.push(`${pad}\t\t${s}`); }
    out.push(`${pad}\t</Properties>`);
    for (const c of ri.children) item(c, depth + 1);
    out.push(`${pad}</Item>`);
  };
  for (const r of roots) item(r, 1);
  if (shared.size) {
    out.push('\t<SharedStrings>');
    for (const [data, id] of shared) out.push(`\t\t<SharedString md5="${id}">${data}</SharedString>`);
    out.push('\t</SharedStrings>');
  }
  out.push('</roblox>');
  return out.join('\n');
}
