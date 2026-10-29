// nenecookie launcher integration (optional). When Bloxlab runs as a nenecookie game
// (an iframe on the launcher's origin), the launcher SDK at /sdk/nene.js gives us the
// signed-in user, cloud saves (F3 -> Save) and visibility events.
import { idb } from './util/idb.js';

const MAX_SAVE = 480 * 1024; // the launcher accepts saves up to 512 KB of JSON

function inSameOriginFrame() {
  if (window.parent === window) return false;
  try { return window.parent.location.origin === location.origin; } catch { return false; }
}

function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
}

async function compress(bytes) {
  if (typeof CompressionStream === 'undefined') return { enc: 'raw', bytes };
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return { enc: 'deflate', bytes: new Uint8Array(out) };
}
async function decompress(enc, bytes) {
  if (enc !== 'deflate') return bytes;
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

export async function initNene() {
  if (!inSameOriginFrame()) return null;
  const ok = await loadScript('/sdk/nene.js');
  const Nene = window.Nene;
  if (!ok || !Nene || !Nene.inLauncher) return null;
  const user = await Promise.race([Nene.ready, new Promise((r) => setTimeout(() => r(null), 2500))]);
  const nene = {
    Nene,
    user,
    app: null,
    pendingLoad: null,
    attach(app) {
      this.app = app;
      if (user && !app.settings.get('playerName')) app.settings.set('playerName', user.username);
      if (this.pendingLoad) { const d = this.pendingLoad; this.pendingLoad = null; this.restore(d); }
    },
    projectSaved() { /* cloud saves happen through the launcher's F3 menu */ },
    async restore(state) {
      const app = this.app;
      if (!app || !state) return;
      try {
        let bytes;
        if (state.data) bytes = await decompress(state.enc, unb64(state.data));
        else if (state.projectId) { const p = await idb.get('projects', state.projectId); bytes = p && p.bytes; }
        if (!bytes) { app.toast?.('This save refers to a project stored in another browser.'); return; }
        await app.openBytes(bytes, `${state.name || 'Place'}.rbxl`);
        app.project.id = state.projectId || null;
      } catch (e) { console.warn('[nene] restore failed', e); }
    },
  };
  // F3 -> Save: store the place itself when it fits, otherwise a reference to the browser copy
  Nene.onSave(async () => {
    const app = nene.app;
    if (!app) return undefined;
    if (app.session) app.stopPlay();
    await app.saveToBrowser(true);
    const { serializePlace } = await import('./engine/datamodel.js');
    const raw = serializePlace(app.dm(), 'rbxl');
    const c = await compress(raw);
    const base = { v: 1, name: app.project.name, projectId: app.project.id, savedAt: Date.now() };
    if (c.bytes.length * 1.34 < MAX_SAVE) return { ...base, enc: c.enc, data: b64(c.bytes) };
    Nene.toast(`"${app.project.name}" is too big for a cloud save; saved in this browser instead.`);
    return base;
  });
  Nene.onLoad((state) => { if (nene.app) nene.restore(state); else nene.pendingLoad = state; });
  Nene.onVisibility((visible) => {
    const app = nene.app;
    if (!app) return;
    // a networked game keeps running (other players depend on it); everything else pauses
    const networked = app.session && (app.session.mode === 'join' || (app.session.hosts && app.session.hosts.length) || (app.session.server && [...app.session.server.replicator.conns.values()].some((c) => !c.transport.local)));
    app.paused = !visible && !networked;
    if (!visible && document.pointerLockElement) document.exitPointerLock();
    if (app.session) app.session.setAudioMuted?.(!visible);
  });
  return nene;
}
