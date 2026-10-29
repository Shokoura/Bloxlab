// Asset loading for rbxassetid:// content.
//
// Browsers cannot download Roblox assets directly (no CORS, and asset delivery needs
// authentication), so Bloxlab resolves content through an ordered chain ("External Load"):
//   1. assets embedded in the project / uploaded by the user (Asset Manager)
//   2. the browser cache (IndexedDB)
//   3. External Load proxies:  Browser <-> your proxy (Cloudflare Worker / Node) <-> Roblox
//   4. the multiplayer host:   Browser <-> host browser <-> (host's proxy) <-> Roblox
//   5. direct requests to Roblox (works only with a CORS-enabled network / extension)
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { idb } from '../util/idb.js';
import { parseMesh } from './mesh.js';
import { builtinContent, FALLBACK_IDS } from './builtin.js';

const td = new TextDecoder();
const DIRECT = 'https://assetdelivery.roblox.com/v1/asset/?id={id}';

export function parseContentId(c) {
  if (c === undefined || c === null) return null;
  const s = String(c).trim();
  if (!s) return null;
  let m;
  if ((m = /^rbxassetid:\/\/(\d+)/i.exec(s))) return { kind: 'id', id: m[1] };
  if ((m = /^rbxthumb:\/\/(.*)$/i.exec(s))) return { kind: 'thumb', query: m[1] };
  if ((m = /[?&]id=(\d+)/i.exec(s)) && /roblox\.com|rbxcdn|^https?:\/\/[^/]*\/asset/i.test(s)) return { kind: 'id', id: m[1] };
  if ((m = /^https?:\/\/(?:www\.)?roblox\.com\/(?:library|catalog)\/(\d+)/i.exec(s))) return { kind: 'id', id: m[1] };
  if (/^\d+$/.test(s)) return { kind: 'id', id: s };
  if (/^rbxasset:\/\//i.test(s)) return { kind: 'builtin', path: s.slice(11) };
  if (/^bloxlab:\/\//i.test(s)) return { kind: 'local', key: s.slice(10) };
  if (/^(data|blob):/i.test(s)) return { kind: 'url', url: s };
  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
  return null;
}

export function sniff(b) {
  if (!b || b.length < 4) return 'unknown';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42) return 'image/webp';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'audio/wav';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac';
  const head = td.decode(b.subarray(0, 16));
  if (head.startsWith('<roblox!')) return 'model/rbxm';
  if (head.startsWith('<roblox') || head.trimStart().startsWith('<roblox')) return 'model/rbxmx';
  if (head.startsWith('version ')) return 'mesh/roblox';
  if (head.trimStart().startsWith('{') || head.trimStart().startsWith('[')) return 'application/json';
  if (head.trimStart().startsWith('<')) return 'text/xml';
  return 'unknown';
}

export class AssetManager {
  constructor(settings) {
    this.settings = settings;
    this.mem = new Map(); // key -> Promise<{ bytes, type }>
    this.textures = new Map();
    this.meshes = new Map();
    this.images = new Map();
    this.overrides = new Map(); // asset id / local key -> { bytes, type, name }
    this.relay = null; // (id) => Promise<{ bytes, type }> provided by multiplayer sessions
    this.stats = { loaded: 0, failed: 0, via: {} };
    this.listeners = new Set();
    this.failures = new Map();
    this.draco = null;
  }
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(e) { for (const f of this.listeners) f(e); }

  // ------------------------------------------------------------ bytes
  /** Raw bytes of a content id. Throws when unavailable. */
  async bytes(content) {
    const ref = parseContentId(content);
    if (!ref) throw new Error(`invalid content id "${content}"`);
    const key = ref.kind === 'id' ? `id:${ref.id}` : ref.kind === 'local' ? `local:${ref.key}` : ref.kind === 'builtin' ? `builtin:${ref.path}` : `url:${ref.url || ref.query}`;
    let p = this.mem.get(key);
    if (!p) {
      p = this.resolve(ref, key);
      this.mem.set(key, p);
      p.catch(() => setTimeout(() => this.mem.delete(key), 15000));
    }
    return p;
  }

  async resolve(ref, key) {
    if (ref.kind === 'builtin') {
      const b = await builtinContent(ref.path);
      if (!b) throw new Error(`built-in content ${ref.path} is not bundled`);
      return b;
    }
    if (ref.kind === 'local') {
      const o = this.overrides.get(`local:${ref.key}`) || (await idb.get('assets', `local:${ref.key}`));
      if (!o) throw new Error(`local asset ${ref.key} not found`);
      return { bytes: o.bytes, type: o.type || sniff(o.bytes) };
    }
    if (ref.kind === 'url') {
      const r = await fetch(ref.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { bytes, type: sniff(bytes) };
    }
    if (ref.kind === 'thumb') return this.thumbnail(ref.query);
    // numeric asset id
    const id = ref.id;
    const ov = this.overrides.get(id);
    if (ov) return { bytes: ov.bytes, type: ov.type || sniff(ov.bytes) };
    if (this.settings.get('cacheAssets')) {
      const c = await idb.get('assets', key);
      if (c) return c;
    }
    const errors = [];
    for (const [via, fn] of this.sources()) {
      try {
        const res = await fn(id);
        if (res && res.bytes && res.bytes.length) {
          const out = { bytes: res.bytes, type: res.type && res.type !== 'unknown' ? res.type : sniff(res.bytes) };
          this.stats.loaded++; this.stats.via[via] = (this.stats.via[via] || 0) + 1;
          this.emit({ type: 'loaded', id, via });
          if (this.settings.get('cacheAssets')) idb.set('assets', key, out);
          return out;
        }
      } catch (e) { errors.push(`${via}: ${e.message}`); }
    }
    if (FALLBACK_IDS[id]) { const b = await builtinContent(FALLBACK_IDS[id]); if (b) return b; }
    this.stats.failed++;
    this.failures.set(id, errors);
    this.emit({ type: 'failed', id, errors });
    throw new Error(`could not load asset ${id} (${errors.join('; ') || 'no sources configured'})`);
  }

  /** Ordered list of [name, (id) => Promise<{bytes,type}>] according to the External Load settings. */
  sources() {
    const mode = this.settings.get('assetMode');
    const list = [];
    const proxies = (this.settings.get('proxies') || []).filter((p) => p.enabled !== false && p.url);
    const proxy = () => proxies.forEach((p) => list.push([`proxy:${p.name || p.url}`, (id) => this.fetchFrom(p.url, id)]));
    const relay = () => { if (this.relay && this.settings.get('hostRelay')) list.push(['host', (id) => this.relay(id)]); };
    const direct = () => list.push(['direct', (id) => this.fetchFrom(DIRECT, id)]);
    if (mode === 'offline') return list;
    if (mode === 'proxy') proxy();
    else if (mode === 'relay') relay();
    else if (mode === 'direct') direct();
    else { proxy(); relay(); direct(); }
    return list;
  }

  async fetchFrom(template, id) {
    const url = template.includes('{id}') ? template.replace('{id}', encodeURIComponent(id)) : `${template}${template.includes('?') ? '&' : '?'}id=${encodeURIComponent(id)}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      const bytes = new Uint8Array(await r.arrayBuffer());
      // some proxies answer with JSON { location } instead of bytes
      if (ct.includes('json')) {
        const j = JSON.parse(td.decode(bytes));
        const loc = j.location || (j.locations && j.locations[0] && j.locations[0].location);
        if (loc) { const r2 = await fetch(loc, { credentials: 'omit' }); if (!r2.ok) throw new Error(`HTTP ${r2.status}`); const b2 = new Uint8Array(await r2.arrayBuffer()); return { bytes: b2, type: sniff(b2) }; }
        if (j.errors) throw new Error(j.errors.map((e) => e.message).join(', '));
      }
      return { bytes, type: sniff(bytes) };
    } finally { clearTimeout(timer); }
  }

  /** Roblox web API through the configured API proxy: api('avatar', '/v1/users/1/avatar'); body => POST JSON */
  async api(service, path, body) {
    const base = (this.settings.get('apiProxy') || this.inferApiProxy() || '').replace(/\/+$/, '');
    const init = body === undefined ? { credentials: 'omit' } : { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const errors = [];
    if (base) {
      try { const r = await fetch(`${base}/api/${service}${path}`, init); if (r.ok) return r.json(); errors.push(`proxy: HTTP ${r.status}`); } catch (e) { errors.push(`proxy: ${e.message}`); }
    }
    if (this.relayApi && this.settings.get('hostRelay') && body === undefined) {
      try { return await this.relayApi(service, path); } catch (e) { errors.push(`host: ${e.message}`); }
    }
    if (this.settings.get('assetMode') !== 'offline') {
      try { const r = await fetch(`https://${service}.roblox.com${path}`, init); if (r.ok) return r.json(); errors.push(`direct: HTTP ${r.status}`); } catch (e) { errors.push(`direct: ${e.message}`); }
    }
    throw new Error(`Roblox API ${service}${path} is unreachable (${errors.join('; ') || 'offline'}). Set an API proxy in Settings → External Load.`);
  }

  /** { id, name, displayName } for a username or user id, or null. */
  async lookupUser(q) {
    const s = String(q || '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) { const j = await this.api('users', `/v1/users/${s}`); return j && j.id ? { id: j.id, name: j.name, displayName: j.displayName } : null; }
    try {
      const j = await this.api('users', '/v1/usernames/users', { usernames: [s], excludeBannedUsers: false });
      const u = j && j.data && j.data[0];
      if (u) return { id: u.id, name: u.name, displayName: u.displayName };
    } catch { /* POST may be blocked; fall back to search */ }
    const j = await this.api('users', `/v1/users/search?keyword=${encodeURIComponent(s)}&limit=10`);
    const list = (j && j.data) || [];
    const u = list.find((x) => x.name.toLowerCase() === s.toLowerCase()) || list[0];
    return u ? { id: u.id, name: u.name, displayName: u.displayName } : null;
  }
  inferApiProxy() {
    const p = (this.settings.get('proxies') || []).find((x) => x.enabled !== false && /\/asset(\?|$)/.test(x.url));
    return p ? p.url.replace(/\/asset.*$/, '') : '';
  }
  async thumbnail(query) {
    // rbxthumb://type=Asset&id=123&w=150&h=150
    const q = new URLSearchParams(query);
    const type = q.get('type') || 'Asset', id = q.get('id'), w = q.get('w') || 150, h = q.get('h') || 150;
    const map = { Asset: ['thumbnails', `/v1/assets?assetIds=${id}&size=${w}x${h}&format=Png`], AvatarHeadShot: ['thumbnails', `/v1/users/avatar-headshot?userIds=${id}&size=${w}x${h}&format=Png`], Avatar: ['thumbnails', `/v1/users/avatar?userIds=${id}&size=${w}x${h}&format=Png`], GameIcon: ['thumbnails', `/v1/games/icons?universeIds=${id}&size=${w}x${h}&format=Png`], BadgeIcon: ['thumbnails', `/v1/badges/icons?badgeIds=${id}&size=150x150&format=Png`], GamePass: ['thumbnails', `/v1/game-passes?gamePassIds=${id}&size=150x150&format=Png`] };
    const [svc, path] = map[type] || map.Asset;
    const j = await this.api(svc, path);
    const url = j && j.data && j.data[0] && j.data[0].imageUrl;
    if (!url) throw new Error('thumbnail not available');
    const bytes = await this.fetchUrl(url);
    return { bytes, type: sniff(bytes) };
  }
  /** Fetch an absolute URL (CDN) directly, falling back to the proxy's /fetch endpoint. */
  async fetchUrl(url) {
    try { const r = await fetch(url, { credentials: 'omit' }); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch { /* try proxy */ }
    const base = (this.settings.get('apiProxy') || this.inferApiProxy() || '').replace(/\/+$/, '');
    if (base) { const r = await fetch(`${base}/fetch?url=${encodeURIComponent(url)}`, { credentials: 'omit' }); if (r.ok) return new Uint8Array(await r.arrayBuffer()); }
    if (this.relayFetch) return this.relayFetch(url);
    throw new Error(`cannot fetch ${url}`);
  }

  // ------------------------------------------------------------ typed loaders
  /** Follows Decal/Shirt/... asset wrappers (XML) to the real image. */
  async imageBytes(content, depth = 0) {
    const r = await this.bytes(content);
    if (r.type.startsWith('image/')) return r;
    if ((r.type === 'model/rbxmx' || r.type === 'model/rbxm' || r.type === 'text/xml') && depth < 3) {
      const inner = await innerImageId(r);
      if (inner) return this.imageBytes(inner, depth + 1);
    }
    throw new Error(`asset ${content} is not an image (${r.type})`);
  }
  async imageUrl(content) {
    const k = String(content);
    let p = this.images.get(k);
    if (!p) {
      p = this.imageBytes(content).then((r) => URL.createObjectURL(new Blob([r.bytes], { type: r.type })));
      this.images.set(k, p);
      p.catch(() => this.images.delete(k));
    }
    return p;
  }
  async image(content) {
    const url = await this.imageUrl(content);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    return img;
  }
  async texture(content) {
    const k = String(content);
    let p = this.textures.get(k);
    if (!p) {
      p = this.image(content).then((img) => {
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        t.needsUpdate = true;
        return t;
      });
      this.textures.set(k, p);
      p.catch(() => this.textures.delete(k));
    }
    return p.catch(() => null);
  }
  async mesh(content) {
    const k = String(content);
    let p = this.meshes.get(k);
    if (!p) {
      p = this.bytes(content).then(async (r) => {
        let bytes = r.bytes;
        if (r.type === 'model/rbxm' || r.type === 'model/rbxmx') {
          const inner = await innerMeshId(r);
          if (!inner) throw new Error('model asset has no mesh');
          bytes = (await this.bytes(inner)).bytes;
        }
        return this.buildGeometry(parseMesh(bytes));
      });
      this.meshes.set(k, p);
      p.catch((e) => { console.warn('[mesh]', content, e.message); this.meshes.delete(k); });
    }
    return p.catch(() => null);
  }
  async buildGeometry(m) {
    let g;
    if (m.draco) g = await this.decodeDraco(m.draco);
    else {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
      const max = m.positions.length / 3;
      g.setIndex(new THREE.BufferAttribute(m.indices.filter((i) => i < max), 1));
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.userData.shared = true;
    return { geometry: g, bbox: g.boundingBox };
  }
  async decodeDraco(data) {
    if (!this.draco) {
      this.draco = new DRACOLoader();
      this.draco.setDecoderPath(new URL('../../vendor/three/addons/libs/draco/', import.meta.url).href);
      this.draco.setDecoderConfig({ type: 'wasm' });
    }
    const tryParse = (buf) => new Promise((res, rej) => this.draco.parse(buf, res, rej));
    try { return await tryParse(data.slice().buffer); }
    catch { return tryParse(data.slice(4).buffer); }
  }
  /** Model asset -> raw instance roots (for InsertService, accessories, plugins, require(id)) */
  async model(content) {
    const r = await this.bytes(content);
    if (r.type !== 'model/rbxm' && r.type !== 'model/rbxmx' && r.type !== 'text/xml') throw new Error(`asset ${content} is not a model (${r.type})`);
    return r;
  }
  async soundUrl(content) {
    const k = `snd:${content}`;
    let p = this.images.get(k);
    if (!p) {
      p = this.bytes(content).then((r) => URL.createObjectURL(new Blob([r.bytes], { type: r.type.startsWith('audio/') ? r.type : 'audio/mpeg' })));
      this.images.set(k, p);
      p.catch(() => this.images.delete(k));
    }
    return p;
  }

  // ------------------------------------------------------------ user supplied assets
  async addOverride(id, bytes, name = '') {
    const type = sniff(bytes);
    const key = /^\d+$/.test(String(id)) ? String(id) : `local:${id}`;
    this.overrides.set(key, { bytes, type, name });
    await idb.set('assets', key.startsWith('local:') ? key : `override:${key}`, { bytes, type, name });
    this.invalidate();
  }
  async loadOverrides() {
    for (const k of await idb.keys('assets')) {
      if (k.startsWith('override:')) { const v = await idb.get('assets', k); if (v) this.overrides.set(k.slice(9), v); }
      if (k.startsWith('local:')) { const v = await idb.get('assets', k); if (v) this.overrides.set(k, v); }
    }
  }
  async removeOverride(key) {
    this.overrides.delete(key);
    await idb.del('assets', key.startsWith('local:') ? key : `override:${key}`);
    this.invalidate();
  }
  invalidate() { this.mem.clear(); this.textures.clear(); this.meshes.clear(); this.images.clear(); }
  async clearCache() {
    for (const k of await idb.keys('assets')) if (k.startsWith('id:') || k.startsWith('url:')) await idb.del('assets', k);
    this.invalidate();
  }
  async test(url) {
    const t0 = performance.now();
    const r = await this.fetchFrom(url, '1818');
    return { ms: Math.round(performance.now() - t0), type: r.type, size: r.bytes.length };
  }
}

async function innerContent(r, props) {
  const { parseFile } = await import('../engine/datamodel.js');
  const doc = parseFile(r.bytes);
  const walk = (list) => {
    for (const ri of list) {
      for (const p of props) { const v = ri.props.get(p); if (v && typeof v.v === 'string' && v.v) return v.v; }
      const x = walk(ri.children); if (x) return x;
    }
    return null;
  };
  return walk(doc.roots);
}
const innerImageId = (r) => innerContent(r, ['Texture', 'TextureContent', 'ShirtTemplate', 'PantsTemplate', 'Graphic', 'Image', 'ImageContent', 'TextureID', 'ColorMap']);
const innerMeshId = (r) => innerContent(r, ['MeshId', 'MeshContent']);
