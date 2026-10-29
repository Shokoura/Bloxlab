// Multiplayer dialogs: host a game (PeerJS code, other tabs, or manual copy/paste WebRTC),
// join one, and run several local test players.
import { h, dialog, toast } from '../studio/ui.js';
import { hostPeer, joinPeer, hostBroadcast, joinBroadcast, manualOffer, manualAnswer, DEFAULT_ICE } from './transport.js';

export function iceServers(settings) {
  const raw = String(settings.get('iceServers') || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return DEFAULT_ICE;
  // "turn:host:3478|user|pass" adds credentials
  return raw.map((s) => { const [urls, username, credential] = s.split('|'); return username ? { urls, username, credential } : { urls }; });
}
const netCfg = (app) => ({ iceServers: iceServers(app.settings), peerHost: app.settings.get('peerServer') || '', peerKey: app.settings.get('peerKey') || '' });
const copyBtn = (getText, label = 'Copy') => h('button', { class: 'btn small', onclick: async (e) => { try { await navigator.clipboard.writeText(getText()); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = label; }, 1200); } catch { toast('Copy failed: select the text and copy it manually', 'warn'); } } }, label);
const inviteLink = (code) => { const u = new URL(location.href); u.search = ''; u.searchParams.set('join', code); return u.href; };

/** Makes sure a hostable session (with a server) is running. */
async function ensureServer(app) {
  if (app.session && app.session.server) return app.session;
  if (app.session) { toast('Leave the current game first', 'warn'); return null; }
  await app.play('play');
  return app.session && app.session.server ? app.session : null;
}

export function hostDialog(app) {
  const status = h('div', { class: 'net-status muted', text: 'Your browser runs the game server; other players connect to you directly (peer-to-peer). Nothing is uploaded anywhere.' });
  const out = h('div', { class: 'net-out' });
  const tabs = h('div', { class: 'seg' });
  const panes = {};
  const show = (k) => { for (const [n, p] of Object.entries(panes)) p.classList.toggle('hidden', n !== k); for (const b of tabs.children) b.classList.toggle('on', b.dataset.k === k); };
  const tab = (k, label) => { tabs.append(h('button', { class: 'btn small', dataset: { k }, onclick: () => show(k) }, label)); };

  // --- online code (PeerJS broker for signalling only)
  tab('peer', 'Online code');
  panes.peer = h('div', {},
    h('p', { class: 'muted small', text: 'Creates a short code. Players enter it in Join Game (or open the invite link). A public PeerJS broker is used only to introduce the browsers; the game traffic goes directly between you.' }),
    h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const s = await ensureServer(app);
        if (!s) return;
        const host = await hostPeer(netCfg(app), (ep, info) => { s.accept(ep, info); toast('A player is connecting…'); }, (err) => toast(`Network: ${err.type || err.message}`, 'warn'));
        s.addHost(host);
        const link = inviteLink(host.code);
        out.replaceChildren(h('div', { class: 'net-code' }, h('span', { class: 'muted', text: 'Code' }), h('b', { class: 'mono', text: host.code }), copyBtn(() => host.code)),
          h('div', { class: 'net-code' }, h('span', { class: 'muted', text: 'Link' }), h('input', { class: 'input small mono', value: link, readonly: true }), copyBtn(() => link)));
        app.ensureConsole?.();
      } catch (err) { out.replaceChildren(h('p', { class: 'err', text: `${err.message}. Try "Manual" instead, or set a custom PeerJS server in Settings → Network.` })); e.target.disabled = false; }
    } }, 'Start hosting'));

  // --- other tabs of this browser
  tab('tab', 'This browser');
  panes.tab = h('div', {},
    h('p', { class: 'muted small', text: 'Players in other tabs or windows of this same browser can join instantly (handy for testing).' }),
    h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true;
      const s = await ensureServer(app);
      if (!s) { e.target.disabled = false; return; }
      const room = Math.random().toString(36).slice(2, 7);
      const host = hostBroadcast(room, (ep, info) => { s.accept(ep, info); toast('A tab joined'); });
      s.addHost(host);
      const code = `tab:${room}`;
      out.replaceChildren(h('div', { class: 'net-code' }, h('span', { class: 'muted', text: 'Code' }), h('b', { class: 'mono', text: code }), copyBtn(() => code)),
        h('button', { class: 'btn', onclick: () => window.open(inviteLink(code), '_blank') }, 'Open a player tab'));
      app.ensureConsole?.();
    } }, 'Start hosting'));

  // --- manual WebRTC (no third party at all)
  tab('manual', 'Manual');
  const offerBox = h('textarea', { class: 'input mono small', rows: 3, readonly: true, placeholder: 'Invitation appears here' });
  const answerBox = h('textarea', { class: 'input mono small', rows: 3, placeholder: 'Paste the player\'s reply here' });
  let pending = null;
  panes.manual = h('div', {},
    h('p', { class: 'muted small', text: 'Works without any broker: send the invitation text to a player (any chat app), they paste it in Join Game → Manual and send you back a reply to paste below. One invitation per player.' }),
    h('button', { class: 'btn', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const s = await ensureServer(app);
        if (!s) return;
        pending = await manualOffer(netCfg(app));
        offerBox.value = pending.offer;
      } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; }
    } }, 'Create invitation'), offerBox, copyBtn(() => offerBox.value, 'Copy invitation'),
    answerBox,
    h('button', { class: 'btn primary', onclick: async () => {
      if (!pending) { toast('Create an invitation first', 'warn'); return; }
      try {
        const p = pending; pending = null;
        const ep = await Promise.race([p.accept(answerBox.value), new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 20000))]);
        app.session.accept(ep, { kind: 'manual' });
        toast('Player connected');
        offerBox.value = ''; answerBox.value = '';
        app.ensureConsole?.();
      } catch (err) { toast(`Could not connect: ${err.message}`, 'error'); }
    } }, 'Connect player'));

  const body = h('div', { class: 'net-dialog' }, status, tabs, ...Object.values(panes), out);
  show('peer');
  dialog({ title: 'Host Game', body, buttons: [{ label: 'Close' }], wide: true });
}

export function joinDialog(app) {
  const code = h('input', { class: 'input mono', placeholder: 'Game code (e.g. k3x9q2 or tab:abcde)' });
  const offer = h('textarea', { class: 'input mono small', rows: 3, placeholder: 'Paste the host\'s invitation here' });
  const answer = h('textarea', { class: 'input mono small', rows: 3, readonly: true, placeholder: 'Your reply appears here' });
  const manual = h('div', { class: 'hidden' },
    h('p', { class: 'muted small', text: 'Manual connect: paste the host\'s invitation, then send them the reply.' }), offer,
    h('button', { class: 'btn', onclick: async () => {
      try {
        const r = await manualAnswer(netCfg(app), offer.value);
        answer.value = r.answer;
        toast('Send the reply to the host; waiting for them…');
        r.connected.then((ep) => startJoin(app, ep, 'manual')).catch((e) => toast(e.message, 'error'));
      } catch (e) { toast(`Invalid invitation: ${e.message}`, 'error'); }
    } }, 'Create reply'), answer, copyBtn(() => answer.value, 'Copy reply'));
  const body = h('div', { class: 'net-dialog' },
    h('label', { class: 'field' }, h('span', { text: 'Game code' }), code),
    h('button', { class: 'btn small', onclick: () => manual.classList.toggle('hidden') }, 'Manual connect…'), manual,
    h('p', { class: 'muted small', text: 'Joining runs the host\'s game in your browser. Assets you cannot download yourself can be fetched through the host (Settings → External Load → Host relay).' }));
  const d = dialog({ title: 'Join Game', body, buttons: [{ label: 'Cancel' }, { label: 'Join', primary: true, onClick: () => { if (!code.value.trim()) { toast('Enter a code', 'warn'); return false; } joinGame(app, code.value.trim()); return true; } }] });
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && code.value.trim()) { d.close(); joinGame(app, code.value.trim()); } });
}

export async function joinGame(app, code) {
  if (app.session) app.stopPlay();
  toast('Connecting…');
  try {
    const ep = code.startsWith('tab:') ? await joinBroadcast(code.slice(4)) : await joinPeer(netCfg(app), code.replace(/^bloxlab-/, ''));
    await startJoin(app, ep, code);
  } catch (e) { toast(`Could not join: ${e.message}`, 'error', 8000); }
}

async function startJoin(app, ep, label) {
  if (app.session) app.stopPlay();
  const { PlaySession } = await import('../game/session.js');
  const s = new PlaySession(app, { mode: 'join', transport: ep });
  app.session = s;
  try { await s.start(); } catch (e) { s.stop(); app.session = null; toast(`Could not join: ${e.message}`, 'error', 8000); return; }
  app.afterSessionStart();
  toast(`Joined ${label}`);
}

export function localTestDialog(app) {
  const count = h('select', { class: 'input' }, [2, 3, 4, 6, 8].map((n) => h('option', { value: n }, `${n} players`)));
  const body = h('div', { class: 'net-dialog' },
    h('p', { class: 'muted small', text: 'Starts a server and several players in this tab. Switch the player you control from the Console (Players list) or with the "Next player" button in the Test tab. All players run their own client world, scripts and physics.' }),
    h('label', { class: 'field' }, h('span', { text: 'Players' }), count));
  dialog({
    title: 'Local Test',
    body,
    buttons: [{ label: 'Cancel' }, { label: 'Start', primary: true, onClick: async () => {
      if (app.session) app.stopPlay();
      await app.play('play', { players: Number(count.value) });
      app.ensureConsole?.();
    } }],
  });
}
