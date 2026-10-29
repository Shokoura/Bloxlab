// Persistent Studio settings (per browser).
const KEY = 'bloxlab.settings.v1';

export const DEFAULTS = {
  // studio
  moveSnap: 1, rotateSnap: 15, cameraSpeed: 1, localSpace: false, selectModels: true, autosave: true, theme: 'dark',
  // graphics
  shadows: true, pixelRatioCap: 2, quality: 'high',
  // assets ("External Load")
  assetMode: 'auto', // auto | direct | proxy | relay | offline
  proxies: [], // [{ name, url: 'https://x/asset?id={id}', enabled }]
  apiProxy: '', // base URL of a Bloxlab proxy that also forwards Roblox web APIs (avatar, users, thumbnails)
  hostRelay: true, // ask the multiplayer host to fetch assets we cannot load ourselves
  shareWithPeers: true, // serve assets to joined players who cannot reach Roblox
  cacheAssets: true,
  // avatars
  avatarMode: 'blocky', // blocky | roblox | thumbnail3d
  avatarUser: '', // Roblox username or user id used for your character
  avatarRig: 'R15', // R15 | R6 (blocky + fallback)
  loadOtherAvatars: true,
  // network
  peerServer: '', // custom PeerJS server (host:port/path); empty = PeerJS cloud
  iceServers: 'stun:stun.l.google.com:19302',
  playerName: '',
  // scripting
  loadstring: false, httpEnabled: true, editorFontSize: 13, editorWrap: false,
};

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS };
    this.listeners = new Set();
    try { Object.assign(this.values, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* storage unavailable */ }
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* ignore */ }
    for (const f of this.listeners) f(k, v);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
