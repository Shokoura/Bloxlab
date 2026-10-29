#!/usr/bin/env node
// Runs the Bloxlab External Load proxy (worker.mjs) with Node 18+:
//   ROBLOX_API_KEY=... node proxy/node-proxy.mjs [port]
// Same environment variables as the Cloudflare Worker (see worker.mjs). Responses are cached in memory.
import http from 'node:http';
import worker from './worker.mjs';

const port = Number(process.argv[2] || process.env.PORT || 8787);
const env = process.env;
const MAX_CACHE = Number(env.CACHE_MB || 256) * 1024 * 1024;
const cache = new Map(); // url -> { body, type, at }
let cacheBytes = 0;

function remember(key, body, type) {
  if (body.length > MAX_CACHE / 8) return;
  cache.set(key, { body, type, at: Date.now() });
  cacheBytes += body.length;
  for (const [k, v] of cache) { if (cacheBytes <= MAX_CACHE) break; cache.delete(k); cacheBytes -= v.body.length; }
}

http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
    const maxAge = Number(env.CACHE_SECONDS || 86400) * 1000;
    const hit = req.method === 'GET' ? cache.get(url) : null;
    let response;
    if (hit && Date.now() - hit.at < maxAge) {
      response = await worker.fetch(new Request(url, { method: 'OPTIONS', headers })); // CORS headers for this origin
      res.writeHead(200, { ...Object.fromEntries(response.headers), 'Content-Type': hit.type, 'X-Bloxlab-Cache': 'hit', 'Access-Control-Allow-Origin': response.headers.get('Access-Control-Allow-Origin') || '*' });
      res.end(hit.body);
      return;
    }
    response = await worker.fetch(request, env, null);
    const buf = Buffer.from(await response.arrayBuffer());
    if (req.method === 'GET' && response.status === 200 && !new URL(url).pathname.match(/^\/?$/)) remember(url, buf, response.headers.get('content-type') || 'application/octet-stream');
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
}).listen(port, () => console.log(`Bloxlab proxy on http://localhost:${port}  (asset: /asset?id=ID, api: /api/<service>/<path>)  auth: ${env.ROBLOX_API_KEY ? 'open cloud key' : env.ROBLOSECURITY ? 'cookie' : 'none'}`));
