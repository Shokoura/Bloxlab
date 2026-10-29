// Bloxlab External Load proxy:  player's browser  <->  this proxy  <->  Roblox
//
// Deploy as a Cloudflare Worker (paste this file, or `wrangler deploy`) or run it with Node
// (`node proxy/node-proxy.mjs`). Endpoints:
//   GET  /asset?id=<assetId>[&version=<n>]   asset bytes (models, meshes, images, audio, animations)
//   GET  /api/<service>/<path>               Roblox web APIs (avatar, users, thumbnails, catalog, ...)
//   POST /api/<service>/<path>               same, JSON body forwarded
//   GET  /fetch?url=<url>                    Roblox CDN files (thumbnails, 3D thumbnail parts)
//   GET  /                                   health check
//
// Settings (Worker "Variables and Secrets" / environment variables):
//   ROBLOX_API_KEY   Open Cloud API key (recommended: Roblox asset delivery needs authentication
//                    for most assets). Create one at create.roblox.com/credentials with the
//                    "Legacy Assets" (legacy-asset:manage) or asset read permission.
//   ROBLOSECURITY    alternatively, a .ROBLOSECURITY cookie of a throwaway account (asset downloads only)
//   ALLOWED_ORIGINS  comma separated list of sites allowed to use the proxy, e.g.
//                    "https://nenecookie.example,http://localhost:8080" (default: any origin)
//   CACHE_SECONDS    how long responses may be cached (default 86400)

const API_SERVICES = new Set(['users', 'avatar', 'thumbnails', 'catalog', 'games', 'economy', 'groups', 'friends', 'badges', 'inventory', 'presence', 'develop', 'apis', 'itemconfiguration', 'assetdelivery', 'gamepasses', 'premiumfeatures']);
const CDN = /^https:\/\/([a-z0-9-]+\.)*(rbxcdn\.com|roblox\.com)\//i;

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': allowed.length ? (ok ? origin : 'null') : '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });

async function fetchAsset(id, version, env) {
  const errors = [];
  const tryLocations = async (res, label) => {
    if (!res.ok) { errors.push(`${label}: HTTP ${res.status}`); return null; }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const j = await res.json();
      const loc = j.location || (j.locations && j.locations[0] && j.locations[0].location);
      if (!loc) { errors.push(`${label}: ${JSON.stringify(j.errors || j).slice(0, 200)}`); return null; }
      const r2 = await fetch(loc);
      if (!r2.ok) { errors.push(`${label} cdn: HTTP ${r2.status}`); return null; }
      return r2;
    }
    return res;
  };
  const v = version ? `/version/${encodeURIComponent(version)}` : '';
  if (env.ROBLOX_API_KEY) {
    const r = await tryLocations(await fetch(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}${v}`, { headers: { 'x-api-key': env.ROBLOX_API_KEY } }), 'open cloud');
    if (r) return r;
  }
  const cookie = env.ROBLOSECURITY ? { Cookie: `.ROBLOSECURITY=${env.ROBLOSECURITY}` } : {};
  const headers = { 'User-Agent': 'Roblox/WinInet', 'Roblox-Place-Id': env.PLACE_ID || '0', ...cookie };
  {
    const r = await tryLocations(await fetch(`https://assetdelivery.roblox.com/v2/assetId/${id}${v}`, { headers }), 'v2');
    if (r) return r;
  }
  const r = await tryLocations(await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${id}${version ? `&version=${encodeURIComponent(version)}` : ''}`, { headers, redirect: 'follow' }), 'v1');
  if (r) return r;
  throw new Error(errors.join('; '));
}

async function handle(req, env, ctx) {
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
  if (!cors.ok) return json({ error: 'origin not allowed' }, 403, cors.headers);
  const url = new URL(req.url);
  const maxAge = Number(env.CACHE_SECONDS || 86400);
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cacheable = req.method === 'GET' && url.pathname !== '/';
  if (cache && cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) { const r = new Response(hit.body, hit); for (const [k, v] of Object.entries(cors.headers)) r.headers.set(k, v); r.headers.set('X-Bloxlab-Cache', 'hit'); return r; }
  }
  let res;
  try {
    if (url.pathname === '/' || url.pathname === '') {
      return json({ ok: true, service: 'bloxlab-proxy', auth: env.ROBLOX_API_KEY ? 'open-cloud' : env.ROBLOSECURITY ? 'cookie' : 'none' }, 200, cors.headers);
    } else if (url.pathname === '/asset' || url.pathname === '/asset/') {
      const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
      if (!id) return json({ error: 'missing id' }, 400, cors.headers);
      const r = await fetchAsset(id, url.searchParams.get('version'), env);
      res = new Response(r.body, { status: 200, headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' } });
    } else if (url.pathname.startsWith('/api/')) {
      const rest = url.pathname.slice(5);
      const slash = rest.indexOf('/');
      const service = slash < 0 ? rest : rest.slice(0, slash);
      if (!API_SERVICES.has(service)) return json({ error: `service "${service}" is not allowed` }, 400, cors.headers);
      const target = `https://${service}.roblox.com${slash < 0 ? '/' : rest.slice(slash)}${url.search}`;
      const init = { method: req.method === 'POST' ? 'POST' : 'GET', headers: { Accept: 'application/json' } };
      if (init.method === 'POST') { init.headers['Content-Type'] = 'application/json'; init.body = await req.text(); }
      const r = await fetch(target, init);
      res = new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json' } });
    } else if (url.pathname === '/fetch') {
      const target = url.searchParams.get('url') || '';
      if (!CDN.test(target)) return json({ error: 'only Roblox CDN / roblox.com URLs can be fetched' }, 400, cors.headers);
      const r = await fetch(target);
      res = new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' } });
    } else return json({ error: 'not found' }, 404, cors.headers);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502, cors.headers);
  }
  for (const [k, v] of Object.entries(cors.headers)) res.headers.set(k, v);
  if (res.status === 200 && cacheable) {
    res.headers.set('Cache-Control', `public, max-age=${maxAge}`);
    if (cache) { const copy = res.clone(); const p = cache.put(cacheKey, copy); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  }
  return res;
}

export default { fetch: handle };
export { handle, fetchAsset };
