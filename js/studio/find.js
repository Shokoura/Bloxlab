// Find All / Replace All across every script in the place (Ctrl+Shift+F).
import { h, dialog, toast } from './ui.js';
import { classIcon } from './icons.js';

const SCRIPT = /^(Script|LocalScript|ModuleScript)$/;

export function findAllDialog(app) {
  const q = h('input', { class: 'input mono', placeholder: 'Find' });
  const r = h('input', { class: 'input mono', placeholder: 'Replace with' });
  const cs = h('input', { type: 'checkbox' });
  const re = h('input', { type: 'checkbox' });
  const ww = h('input', { type: 'checkbox' });
  const results = h('div', { class: 'find-results' });
  const pattern = () => {
    const src = q.value;
    if (!src) return null;
    let body = re.checked ? src : src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (ww.checked) body = `\\b${body}\\b`;
    try { return new RegExp(body, cs.checked ? 'g' : 'gi'); } catch { return null; }
  };
  const scripts = () => { const out = []; app.dm().forTree((d) => { if (SCRIPT.test(d.ClassName)) out.push(d); }); return out; };
  const search = () => {
    const rx = pattern();
    if (!rx) { results.replaceChildren(h('div', { class: 'muted small', text: q.value ? 'Invalid pattern' : 'Type something to search' })); return 0; }
    let count = 0;
    const rows = [];
    for (const s of scripts()) {
      const lines = String(s.props.Source || '').split('\n');
      const hits = [];
      lines.forEach((line, i) => { rx.lastIndex = 0; if (rx.test(line)) hits.push([i + 1, line]); });
      if (!hits.length) continue;
      count += hits.length;
      rows.push(h('div', { class: 'find-file' }, classIcon(s.ClassName), h('b', { text: s.getFullName() }), h('span', { class: 'muted small', text: ` ${hits.length}` })));
      for (const [n, line] of hits.slice(0, 200)) rows.push(h('div', { class: 'find-hit mono', onclick: () => app.openScript(s, n) }, h('span', { class: 'muted', text: `${n}: ` }), line.trim().slice(0, 160)));
    }
    results.replaceChildren(...(rows.length ? rows : [h('div', { class: 'muted small', text: 'No matches' })]));
    return count;
  };
  for (const el of [q, cs, re, ww]) el.addEventListener(el === q ? 'input' : 'change', search);
  q.addEventListener('keydown', (e) => e.stopPropagation());
  r.addEventListener('keydown', (e) => e.stopPropagation());
  const replaceAll = () => {
    const rx = pattern();
    if (!rx) return false;
    let n = 0;
    app.history.run('Replace All', () => {
      for (const s of scripts()) {
        const src = String(s.props.Source || '');
        const next = src.replace(rx, () => { n++; return r.value; });
        if (next !== src) {
          s.set('Source', next);
          const tab = app.tabs.find((t) => t.inst === s);
          if (tab) tab.editor.setValue(next);
        }
      }
    });
    toast(`Replaced ${n} occurrence(s)`);
    search();
    return false;
  };
  dialog({
    title: 'Find All / Replace All',
    wide: true,
    body: h('div', { class: 'find-dialog' }, q, r,
      h('div', { class: 'hrow' }, h('label', { class: 'small' }, cs, ' Match case'), h('label', { class: 'small' }, ww, ' Whole word'), h('label', { class: 'small' }, re, ' Regex')),
      results),
    buttons: [{ label: 'Replace All', onClick: replaceAll }, { label: 'Close', primary: true }],
  });
  search();
}
