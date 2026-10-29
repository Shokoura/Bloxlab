// Entry point.
import { App } from './studio/app.js';
import { initNene } from './nene.js';
import { toast } from './studio/ui.js';

const msg = (t) => { const el = document.getElementById('boot-msg'); if (el) el.textContent = t; };

async function boot() {
  msg('Starting…');
  let nene = null;
  try { nene = await initNene(); } catch (e) { console.warn('[nene]', e); }
  const root = document.getElementById('app');
  document.getElementById('boot')?.remove();
  const app = new App(root, { nene });
  app.toast = toast;
  window.bloxlab = app; // handy for debugging from the console
  if (nene) { nene.attach(app); document.documentElement.classList.add('in-nene'); }
  // ?join=<code> joins a multiplayer game, ?open=<url> opens a place file
  const q = new URLSearchParams(location.search);
  if (q.get('join')) { const { joinGame } = await import('./net/ui.js'); joinGame(app, q.get('join')); }
  if (q.get('open')) {
    try { const r = await fetch(q.get('open')); await app.openBytes(new Uint8Array(await r.arrayBuffer()), q.get('open').split('/').pop() || 'place.rbxl'); } catch (e) { toast(`Could not open: ${e.message}`, 'error'); }
  }
}

boot().catch((e) => {
  console.error(e);
  msg(`Failed to start: ${e.message}`);
});
