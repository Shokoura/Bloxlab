// Settings dialog (General, Graphics, External Load, Avatar, Network, Scripting) and the Asset Manager.
import { h, dialog, toast, pickFile, confirmBox, download } from './ui.js';
import { icon } from './icons.js';
import { idb } from '../util/idb.js';
import { sniff } from '../assets/manager.js';

const PRESETS = [
  { name: 'My Bloxlab proxy (Cloudflare Worker / Node)', url: 'https://YOUR-WORKER.workers.dev/asset?id={id}', note: 'Deploy proxy/cloudflare-worker.js or proxy/node-proxy.mjs from the Bloxlab repo, then put its URL here.' },
  { name: 'RoProxy (public mirror)', url: 'https://assetdelivery.roproxy.com/v1/asset/?id={id}', note: 'A public Roblox mirror run by a third party. It may be slow, rate-limited or blocked.' },
  { name: 'Roblox asset delivery (direct)', url: 'https://assetdelivery.roblox.com/v1/asset/?id={id}', note: 'Only works when your network / a browser extension allows cross-origin requests to Roblox.' },
];

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { class: 'muted', text: hint }) : null);
const check = (app, key, label, hint, onChange) => {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!app.settings.get(key);
  cb.addEventListener('change', () => { app.settings.set(key, cb.checked); onChange?.(cb.checked); });
  return h('label', { class: 'check' }, cb, h('span', {}, label, hint ? h('small', { class: 'muted block', text: hint }) : null));
};
const text = (app, key, attrs = {}) => {
  const i = h('input', { class: 'input', value: app.settings.get(key) ?? '', ...attrs });
  i.addEventListener('change', () => app.settings.set(key, attrs.type === 'number' ? Number(i.value) : i.value.trim()));
  return i;
};
const select = (app, key, options, onChange) => {
  const s = h('select', { class: 'input' }, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = String(app.settings.get(key));
  s.addEventListener('change', () => { const v = typeof app.settings.get(key) === 'number' ? Number(s.value) : s.value; app.settings.set(key, v); onChange?.(v); });
  return s;
};

// ------------------------------------------------------------------ tabs
function generalTab(app) {
  return h('div', {},
    check(app, 'autosave', 'Autosave to this browser', 'The place is saved in IndexedDB every minute while editing.'),
    field('Script editor font size', text(app, 'editorFontSize', { type: 'number', min: 9, max: 24 })),
    check(app, 'editorWrap', 'Wrap long lines in the script editor'),
    field('Studio camera speed', text(app, 'cameraSpeed', { type: 'number', min: 0.2, max: 8, step: 0.1 })),
  );
}

function graphicsTab(app) {
  return h('div', {},
    check(app, 'shadows', 'Shadows', 'Takes effect after reloading the page.', (v) => { app.viewport.renderer.shadowMap.enabled = v; }),
    field('Resolution limit', select(app, 'pixelRatioCap', [[1, '1x (fastest)'], [1.5, '1.5x'], [2, '2x (sharp)'], [3, '3x']], (v) => { app.viewport.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, v)); app.viewport.resize(); })),
    field('Quality', select(app, 'quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])),
  );
}

function externalLoadTab(app) {
  const list = h('div', { class: 'proxy-list' });
  const proxies = () => (app.settings.get('proxies') || []).map((p) => ({ ...p }));
  const save = (arr) => { app.settings.set('proxies', arr); app.assets.invalidate(); render(); };
  const render = () => {
    const arr = proxies();
    list.replaceChildren(...(arr.length ? arr.map((p, i) => {
      const on = h('input', { type: 'checkbox' }); on.checked = p.enabled !== false;
      on.addEventListener('change', () => { arr[i].enabled = on.checked; save(arr); });
      const name = h('input', { class: 'input small', value: p.name || '', placeholder: 'Name' });
      name.addEventListener('change', () => { arr[i].name = name.value; save(arr); });
      const url = h('input', { class: 'input small mono grow', value: p.url, placeholder: 'https://…/asset?id={id}' });
      url.addEventListener('change', () => { arr[i].url = url.value.trim(); save(arr); });
      const res = h('span', { class: 'small muted' });
      return h('div', { class: 'proxy-row' }, on, name, url,
        h('button', { class: 'btn small', onclick: async () => { res.textContent = 'testing…'; try { const r = await app.assets.test(url.value.trim()); res.textContent = `ok · ${r.ms} ms · ${r.type}`; res.className = 'small ok'; } catch (e) { res.textContent = e.message; res.className = 'small err'; } } }, 'Test'),
        h('button', { class: 'icon-btn small', title: 'Move up', onclick: () => { if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(arr); } } }, '↑'),
        h('button', { class: 'icon-btn small', title: 'Remove', onclick: () => { arr.splice(i, 1); save(arr); } }, icon('trash')), res);
    }) : [h('div', { class: 'muted small', text: 'No proxies yet. Add one below.' })]));
  };
  render();
  const presetSel = h('select', { class: 'input small' }, h('option', { value: '' }, 'Add a proxy…'), PRESETS.map((p, i) => h('option', { value: i }, p.name)), h('option', { value: 'custom' }, 'Custom URL'));
  presetSel.addEventListener('change', () => {
    const v = presetSel.value; presetSel.value = '';
    if (v === '') return;
    const arr = proxies();
    if (v === 'custom') arr.push({ name: 'Custom', url: 'https://', enabled: true });
    else { const p = PRESETS[Number(v)]; arr.push({ name: p.name, url: p.url, enabled: true }); toast(p.note, 'info', 7000); }
    save(arr);
  });
  const stats = h('div', { class: 'small muted' });
  const s = app.assets.stats;
  stats.textContent = `Loaded ${s.loaded} assets (${Object.entries(s.via).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none yet'}), ${s.failed} failed.`;
  return h('div', {},
    h('div', { class: 'diagram' },
      h('div', {}, h('b', { text: 'Your browser' })), h('span', { text: '⇄' }), h('div', {}, h('b', { text: 'External Load' }), h('small', { text: 'proxy · host · cache' })), h('span', { text: '⇄' }), h('div', {}, h('b', { text: 'Roblox' }))),
    h('p', { class: 'muted small', text: 'Browsers cannot download Roblox assets directly (rbxassetid://…). External Load fetches them through something else: your own proxy, a public mirror, or the multiplayer host\'s browser. Assets are cached locally once loaded, and you can always upload files yourself in the Asset Manager.' }),
    field('Load assets from', select(app, 'assetMode', [['auto', 'Automatic (proxies → host → direct)'], ['proxy', 'Proxies only'], ['relay', 'Multiplayer host only'], ['direct', 'Directly from Roblox'], ['offline', 'Offline (uploaded / cached only)']], () => app.assets.invalidate())),
    h('h4', { text: 'Asset proxies (tried in order)' }), list, presetSel,
    field('Roblox API proxy (avatars, users, thumbnails)', text(app, 'apiProxy', { placeholder: 'https://YOUR-WORKER.workers.dev', class: 'input mono' }), 'A Bloxlab proxy serves /api/<service>/<path> for avatar.roblox.com, users.roblox.com, thumbnails.roblox.com… Leave empty to derive it from the first Bloxlab proxy above.'),
    check(app, 'hostRelay', 'Ask the multiplayer host to fetch assets I cannot load', 'Player\'s browser ⇄ host\'s browser ⇄ (host\'s proxy) ⇄ Roblox.'),
    check(app, 'shareWithPeers', 'When hosting, fetch assets for players who ask'),
    check(app, 'cacheAssets', 'Cache downloaded assets in this browser'),
    h('div', { class: 'hrow' }, h('button', { class: 'btn small', onclick: async () => { await app.assets.clearCache(); toast('Asset cache cleared'); } }, 'Clear cache'), h('button', { class: 'btn small', onclick: () => openAssetManager(app) }, 'Asset Manager…')),
    stats);
}

function avatarTab(app) {
  const preview = h('div', { class: 'avatar-preview muted small', text: '' });
  const user = text(app, 'avatarUser', { placeholder: 'Roblox username or user id', class: 'input' });
  const lookup = async () => {
    const v = user.value.trim();
    if (!v) { preview.textContent = ''; return; }
    preview.textContent = 'Looking up…';
    try {
      const u = await app.assets.lookupUser(v);
      if (!u) { preview.textContent = 'No such user'; return; }
      const img = h('img', { alt: '', width: 72, height: 72 });
      app.assets.imageUrl(`rbxthumb://type=AvatarHeadShot&id=${u.id}&w=150&h=150`).then((url) => { img.src = url; }).catch(() => img.remove());
      preview.replaceChildren(img, h('div', {}, h('b', { text: u.displayName || u.name }), h('div', { class: 'muted', text: `@${u.name} · id ${u.id}` })));
    } catch (e) { preview.textContent = `Lookup failed: ${e.message} (configure External Load → API proxy)`; }
  };
  user.addEventListener('change', lookup);
  if (user.value) setTimeout(lookup, 50);
  const colors = app.settings.get('blockyColors') || {};
  const colorRow = h('div', { class: 'hrow' }, ['head', 'torso', 'arms', 'legs'].map((k) => {
    const def = { head: '#f5cd30', torso: '#0d69ac', arms: '#f5cd30', legs: '#a4bd47' }[k];
    const c = h('input', { type: 'color', value: colors[k] || def });
    c.addEventListener('change', () => { const v = { ...(app.settings.get('blockyColors') || {}) }; v[k] = c.value; app.settings.set('blockyColors', v); });
    return h('label', { class: 'small' }, c, ` ${k}`);
  }));
  return h('div', {},
    field('Character', select(app, 'avatarMode', [['blocky', 'Blocky (offline, no downloads)'], ['roblox', 'My Roblox avatar (body, clothes, accessories)']])),
    field('Roblox account', user, 'Public avatar data is read through the External Load API proxy. No login needed.'),
    preview,
    field('Rig', select(app, 'avatarRig', [['R15', 'R15'], ['R6', 'R6']]), 'Used for blocky characters and when a place does not decide. Roblox avatars use their own type unless the place forces one.'),
    check(app, 'loadOtherAvatars', 'Show other players\' Roblox avatars'),
    h('h4', { text: 'Blocky colors' }), colorRow,
    field('Player name', text(app, 'playerName', { placeholder: app.nene?.user?.username || 'Player' }), 'Shown to other players. Inside nenecookie your nenecookie name is used by default.'),
  );
}

function networkTab(app) {
  return h('div', {},
    h('p', { class: 'muted small', text: 'Multiplayer is serverless: the host\'s browser runs the game and players connect to it with WebRTC. A matchmaking broker only exchanges connection details; "Manual" connect needs none.' }),
    field('PeerJS broker', text(app, 'peerServer', { placeholder: 'default: PeerJS cloud (0.peerjs.com)', class: 'input mono' }), 'Self-host with `npx peerjs --port 9000` and enter host:port/path.'),
    field('PeerJS key', text(app, 'peerKey', { placeholder: 'peerjs', class: 'input mono' })),
    field('ICE servers', (() => { const t = h('textarea', { class: 'input mono small', rows: 3 }); t.value = app.settings.get('iceServers') || ''; t.addEventListener('change', () => app.settings.set('iceServers', t.value)); return t; })(), 'One per line. STUN: stun:host:port · TURN with login: turn:host:3478|user|password'),
  );
}

function scriptingTab(app) {
  return h('div', {},
    check(app, 'httpEnabled', 'Allow HttpService requests', 'Requests are made by your browser (subject to CORS).'),
    check(app, 'loadstring', 'Allow loadstring() on the server'),
    h('p', { class: 'muted small', text: 'DataStores are simulated and stored in this browser per place.' }),
  );
}

export function openSettings(app, tab = 'General') {
  const tabs = { General: generalTab, Graphics: graphicsTab, 'External Load': externalLoadTab, Avatar: avatarTab, Network: networkTab, Scripting: scriptingTab };
  const nav = h('div', { class: 'settings-nav' });
  const pane = h('div', { class: 'settings-pane' });
  const show = (k) => {
    for (const b of nav.children) b.classList.toggle('active', b.dataset.k === k);
    pane.replaceChildren(tabs[k](app));
  };
  for (const k of Object.keys(tabs)) nav.append(h('button', { class: 'settings-tab', dataset: { k }, onclick: () => show(k) }, k));
  show(tabs[tab] ? tab : 'General');
  dialog({ title: 'Settings', body: h('div', { class: 'settings' }, nav, pane), wide: true });
}

// ------------------------------------------------------------------ Asset Manager
export function openAssetManager(app) {
  const listEl = h('div', { class: 'asset-list' });
  const failedEl = h('div', { class: 'asset-list' });
  const render = async () => {
    const items = [...app.assets.overrides.entries()];
    listEl.replaceChildren(...(items.length ? items.map(([key, v]) => {
      const id = key.startsWith('local:') ? `bloxlab://${key.slice(6)}` : `rbxassetid://${key}`;
      return h('div', { class: 'asset-row' },
        h('span', { class: 'mono grow', text: id, title: v.name || '' }), h('span', { class: 'muted small', text: `${v.type} · ${Math.round(v.bytes.length / 1024)} KB` }),
        h('button', { class: 'btn small', title: 'Copy content id', onclick: () => navigator.clipboard?.writeText(id).then(() => toast('Copied')) }, 'Copy'),
        h('button', { class: 'icon-btn small', title: 'Remove', onclick: async () => { await app.assets.removeOverride(key); render(); } }, icon('trash')));
    }) : [h('div', { class: 'muted small', text: 'No uploaded assets.' })]));
    const failed = [...app.assets.failures.entries()];
    failedEl.replaceChildren(...(failed.length ? failed.map(([id, errs]) => h('div', { class: 'asset-row' },
      h('span', { class: 'mono grow', text: `rbxassetid://${id}`, title: errs.join('\n') }),
      h('button', { class: 'btn small', onclick: async () => {
        const f = await pickFile('*/*');
        if (!f) return;
        await app.assets.addOverride(id, new Uint8Array(await f.arrayBuffer()), f.name);
        app.assets.failures.delete(id);
        toast(`Asset ${id} will use ${f.name}`);
        render();
      } }, 'Provide file…'))) : [h('div', { class: 'muted small', text: 'Nothing failed to load.' })]));
  };
  render();
  const upload = async (asId) => {
    const files = await pickFile('image/*,audio/*,.mesh,.rbxm,.rbxmx,.obj', true);
    for (const f of files || []) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const id = asId ? asId : `upload-${Date.now().toString(36)}-${f.name.replace(/[^\w.]/g, '_')}`;
      await app.assets.addOverride(id, bytes, f.name);
      toast(`Added ${f.name} as ${/^\d+$/.test(id) ? `rbxassetid://${id}` : `bloxlab://${id}`} (${sniff(bytes)})`);
    }
    render();
  };
  const idInput = h('input', { class: 'input small mono', placeholder: 'asset id (optional)' });
  const exportPack = async () => {
    const out = {};
    for (const [k, v] of app.assets.overrides) out[k] = { name: v.name, type: v.type, b64: btoa(Array.from(v.bytes, (c) => String.fromCharCode(c)).join('')) };
    download('bloxlab-assets.json', JSON.stringify({ bloxlabAssets: 1, items: out }), 'application/json');
  };
  const importPack = async () => {
    const f = await pickFile('.json');
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      for (const [k, v] of Object.entries(j.items || {})) {
        const bin = atob(v.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        await app.assets.addOverride(k.startsWith('local:') ? k.slice(6) : k, u, v.name);
      }
      toast('Asset pack imported'); render();
    } catch (e) { toast(`Invalid pack: ${e.message}`, 'error'); }
  };
  dialog({
    title: 'Asset Manager',
    wide: true,
    body: h('div', { class: 'asset-mgr' },
      h('p', { class: 'muted small', text: 'Upload images, sounds, meshes or models. Give a Roblox asset id to make every rbxassetid://<id> in your places use your file (great for offline play), or leave it empty to get a bloxlab:// id you can paste into properties.' }),
      h('div', { class: 'hrow' }, idInput, h('button', { class: 'btn primary small', onclick: () => upload(idInput.value.trim().replace(/\D/g, '') || null) }, 'Upload…'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: exportPack }, 'Export pack'), h('button', { class: 'btn small', onclick: importPack }, 'Import pack'),
        h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox('Clear cache', 'Remove all downloaded (not uploaded) assets from this browser?', 'Clear')) { await app.assets.clearCache(); toast('Cache cleared'); } } }, 'Clear cache')),
      h('h4', { text: 'Uploaded' }), listEl,
      h('h4', { text: 'Failed to load this session' }), failedEl),
  });
  void idb;
}
