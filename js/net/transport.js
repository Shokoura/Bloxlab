// Transports carry replication messages between the host (server) and clients.
// Every endpoint exposes: send(obj), drain() -> obj[], close(), onclose, local (bool).
// Messages are buffered and drained by the game loop so worlds are only touched once per frame.

const CHUNK = 15000; // characters per data-channel message (keeps under SCTP limits everywhere)

class Endpoint {
  constructor() { this.inbox = []; this.onclose = null; this.local = false; this.closed = false; this.bytesIn = 0; this.bytesOut = 0; }
  drain() { const m = this.inbox; this.inbox = []; return m; }
  deliver(m) { if (!this.closed) this.inbox.push(m); }
  markClosed() { if (this.closed) return; this.closed = true; this.onclose?.(); }
}

/** Two endpoints wired to each other in memory (solo play and same-tab test players). */
export function loopbackPair() {
  const a = new Endpoint(), b = new Endpoint();
  a.local = b.local = true;
  a.send = (m) => { if (!a.closed) b.deliver(m); };
  b.send = (m) => { if (!b.closed) a.deliver(m); };
  a.close = () => { a.markClosed(); b.markClosed(); };
  b.close = () => { a.markClosed(); b.markClosed(); };
  return [a, b];
}

/**
 * Wraps a string pipe (data channel, BroadcastChannel, ...) with JSON encoding and chunking.
 * raw: { send(str), close() }; call ep.receiveRaw(str) for incoming data and ep.markClosed() when it dies.
 */
export class StringEndpoint extends Endpoint {
  constructor(raw) {
    super();
    this.raw = raw;
    this.partial = new Map();
    this.seq = 0;
  }
  send(obj) {
    if (this.closed) return;
    const s = JSON.stringify(obj);
    this.bytesOut += s.length;
    if (s.length <= CHUNK) { this.raw.send(s); return; }
    const id = ++this.seq;
    const total = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < total; i++) this.raw.send(`~${id}:${i}:${total}:${s.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  receiveRaw(str) {
    if (typeof str !== 'string') return;
    this.bytesIn += str.length;
    if (str[0] !== '~') { try { this.deliver(JSON.parse(str)); } catch (e) { console.warn('bad packet', e); } return; }
    const a = str.indexOf(':'), b = str.indexOf(':', a + 1), c = str.indexOf(':', b + 1);
    const id = str.slice(1, a), idx = +str.slice(a + 1, b), total = +str.slice(b + 1, c);
    let p = this.partial.get(id);
    if (!p) { p = { parts: new Array(total), n: 0 }; this.partial.set(id, p); }
    if (p.parts[idx] === undefined) { p.parts[idx] = str.slice(c + 1); p.n++; }
    if (p.n === total) {
      this.partial.delete(id);
      try { this.deliver(JSON.parse(p.parts.join(''))); } catch (e) { console.warn('bad packet', e); }
    }
  }
  close() { if (this.closed) return; try { this.raw.close(); } catch { /* ignore */ } this.markClosed(); }
}

// ================================================================ BroadcastChannel (other tabs, same origin)
/**
 * Host side: listens on `bloxlab:<room>` for join requests; each joiner gets a private channel.
 * onConnection(endpoint, info) is called for every new client.
 */
export function hostBroadcast(room, onConnection) {
  const lobby = new BroadcastChannel(`bloxlab:${room}`);
  const peers = new Map();
  lobby.onmessage = (e) => {
    const d = e.data;
    if (!d || d.type !== 'join' || peers.has(d.id)) return;
    const ch = new BroadcastChannel(`bloxlab:${room}:${d.id}`);
    const ep = new StringEndpoint({ send: (s) => ch.postMessage({ from: 'host', s }), close: () => { ch.postMessage({ from: 'host', bye: 1 }); ch.close(); } });
    ch.onmessage = (ev) => { const m = ev.data; if (!m || m.from !== 'client') return; if (m.bye) { ep.markClosed(); ch.close(); peers.delete(d.id); return; } ep.receiveRaw(m.s); };
    peers.set(d.id, ep);
    lobby.postMessage({ type: 'welcome', id: d.id });
    onConnection(ep, { kind: 'tab', id: d.id });
  };
  // let late joiners know the room exists
  const announce = () => lobby.postMessage({ type: 'host' });
  announce();
  return { close: () => { for (const ep of peers.values()) ep.close(); lobby.close(); }, room };
}
/** Client side; resolves with an endpoint once the host answers. */
export function joinBroadcast(room, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2, 10);
    const lobby = new BroadcastChannel(`bloxlab:${room}`);
    const ch = new BroadcastChannel(`bloxlab:${room}:${id}`);
    const ep = new StringEndpoint({ send: (s) => ch.postMessage({ from: 'client', s }), close: () => { ch.postMessage({ from: 'client', bye: 1 }); ch.close(); } });
    ch.onmessage = (ev) => { const m = ev.data; if (!m || m.from !== 'host') return; if (m.bye) { ep.markClosed(); ch.close(); return; } ep.receiveRaw(m.s); };
    const timer = setTimeout(() => { lobby.close(); ch.close(); reject(new Error(`No host found for room "${room}" in this browser`)); }, timeout);
    lobby.onmessage = (e) => {
      if (e.data && e.data.type === 'welcome' && e.data.id === id) { clearTimeout(timer); lobby.close(); resolve(ep); }
      if (e.data && e.data.type === 'host') lobby.postMessage({ type: 'join', id });
    };
    lobby.postMessage({ type: 'join', id });
  });
}

// ================================================================ WebRTC data channels
function channelEndpoint(dc, pc) {
  const ep = new StringEndpoint({ send: (s) => dc.send(s), close: () => { try { dc.close(); } catch { /* ignore */ } try { pc && pc.close(); } catch { /* ignore */ } } });
  dc.onmessage = (e) => ep.receiveRaw(e.data);
  dc.onclose = () => ep.markClosed();
  if (pc) pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) ep.markClosed(); });
  return ep;
}

export const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

let peerjsLoading = null;
function loadPeerJS() {
  if (window.peerjs && window.peerjs.Peer) return Promise.resolve(window.peerjs.Peer);
  if (window.Peer) return Promise.resolve(window.Peer);
  return (peerjsLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;
    s.onload = () => { const P = (window.peerjs && window.peerjs.Peer) || window.Peer; if (P) resolve(P); else reject(new Error('PeerJS failed to load')); };
    s.onerror = () => reject(new Error('PeerJS failed to load'));
    document.head.append(s);
  }));
}
function peerOptions(cfg) {
  const o = { debug: 0, config: { iceServers: cfg.iceServers && cfg.iceServers.length ? cfg.iceServers : DEFAULT_ICE } };
  if (cfg.peerHost) {
    try {
      const u = new URL(cfg.peerHost.includes('://') ? cfg.peerHost : `https://${cfg.peerHost}`);
      o.host = u.hostname; o.secure = u.protocol === 'https:'; o.port = u.port ? Number(u.port) : (o.secure ? 443 : 80); o.path = u.pathname || '/';
      if (cfg.peerKey) o.key = cfg.peerKey;
    } catch { /* fall back to the public broker */ }
  }
  return o;
}

/** Hosts via a PeerJS broker. Resolves { code, close } once registered. */
export async function hostPeer(cfg, onConnection, onError) {
  const Peer = await loadPeerJS();
  const id = cfg.code || `bloxlab-${Math.random().toString(36).slice(2, 8)}`;
  const peer = new Peer(id, peerOptions(cfg));
  await new Promise((resolve, reject) => {
    peer.on('open', resolve);
    peer.on('error', (e) => reject(new Error(`Could not reach the matchmaking broker: ${e.type || e.message}`)));
  });
  peer.on('error', (e) => onError?.(e));
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      const ep = new StringEndpoint({ send: (s) => conn.send(s), close: () => conn.close() });
      conn.on('data', (d) => ep.receiveRaw(d));
      conn.on('close', () => ep.markClosed());
      conn.on('error', () => ep.markClosed());
      onConnection(ep, { kind: 'peer', id: conn.peer });
    });
  });
  return { code: id.replace(/^bloxlab-/, ''), close: () => peer.destroy() };
}
export async function joinPeer(cfg, code) {
  const Peer = await loadPeerJS();
  const peer = new Peer(undefined, peerOptions(cfg));
  await new Promise((resolve, reject) => {
    peer.on('open', resolve);
    peer.on('error', (e) => reject(new Error(`Could not reach the matchmaking broker: ${e.type || e.message}`)));
  });
  const target = code.startsWith('bloxlab-') ? code : `bloxlab-${code}`;
  return new Promise((resolve, reject) => {
    const conn = peer.connect(target, { reliable: true, serialization: 'raw' });
    const timer = setTimeout(() => reject(new Error('The host did not answer (check the code, or try manual connect)')), 20000);
    peer.on('error', (e) => { clearTimeout(timer); reject(new Error(e.type === 'peer-unavailable' ? 'No game with that code' : `Connection failed: ${e.type || e.message}`)); });
    conn.on('open', () => {
      clearTimeout(timer);
      const ep = new StringEndpoint({ send: (s) => conn.send(s), close: () => { conn.close(); peer.destroy(); } });
      conn.on('data', (d) => ep.receiveRaw(d));
      conn.on('close', () => ep.markClosed());
      resolve(ep);
    });
  });
}

// ---------------------------------------------------------------- manual signalling (copy / paste)
const pack = (desc) => btoa(unescape(encodeURIComponent(JSON.stringify(desc))));
const unpack = (s) => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const t = setTimeout(resolve, 4000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
}
/** Host creates an offer per client; returns { offer, accept(answerText) -> endpoint }. */
export async function manualOffer(cfg) {
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers && cfg.iceServers.length ? cfg.iceServers : DEFAULT_ICE });
  const dc = pc.createDataChannel('bloxlab', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const opened = new Promise((resolve) => { dc.onopen = () => resolve(channelEndpoint(dc, pc)); });
  return {
    offer: pack(pc.localDescription),
    async accept(answer) { await pc.setRemoteDescription(unpack(answer)); return opened; },
    cancel: () => pc.close(),
  };
}
/** Client answers a pasted offer; returns { answer, connected: Promise<endpoint> }. */
export async function manualAnswer(cfg, offerText) {
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers && cfg.iceServers.length ? cfg.iceServers : DEFAULT_ICE });
  const connected = new Promise((resolve) => { pc.ondatachannel = (e) => { const dc = e.channel; dc.onopen = () => resolve(channelEndpoint(dc, pc)); }; });
  await pc.setRemoteDescription(unpack(offerText));
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { answer: pack(pc.localDescription), connected };
}
