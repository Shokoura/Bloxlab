// Output window + command bar.
import { h } from './ui.js';
import { icon } from './icons.js';

const MAX = 2000;

export class Output {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.entries = [];
    this.filter = 'all';
    this.list = h('div', { class: 'out-list', role: 'log' });
    const filterSel = h('select', { class: 'input small', onchange: () => { this.filter = filterSel.value; this.renderAll(); } },
      ['all', 'output', 'warn', 'error', 'info'].map((k) => h('option', { value: k, text: k === 'all' ? 'All messages' : k[0].toUpperCase() + k.slice(1) })));
    this.search = h('input', { class: 'input small', placeholder: 'Filter…', oninput: () => this.renderAll() });
    this.ctxLabel = h('span', { class: 'muted small' });
    el.append(
      h('div', { class: 'panel-tools row' }, filterSel, this.search, this.ctxLabel, h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'Clear output', onclick: () => this.clear() }, icon('trash'))),
      this.list,
    );
  }
  add(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
    if (this.visible(entry)) {
      const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 30;
      this.list.append(this.row(entry));
      while (this.list.childElementCount > MAX) this.list.firstChild.remove();
      if (atBottom) this.list.scrollTop = this.list.scrollHeight;
    }
  }
  visible(e) {
    if (this.filter !== 'all' && e.kind !== this.filter && !(this.filter === 'error' && e.kind === 'trace')) return false;
    const q = this.search.value.trim().toLowerCase();
    return !q || e.msg.toLowerCase().includes(q);
  }
  row(e) {
    const t = new Date(e.time || Date.now());
    const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
    const msg = h('span', { class: 'msg', text: e.msg });
    const r = h('div', { class: `out-row k-${e.kind}` }, h('span', { class: 'ts', text: ts }),
      e.worldName && e.worldName !== 'edit' ? h('span', { class: `ctx ctx-${e.world}`, text: e.worldName }) : null, msg,
      e.source ? h('span', { class: 'src', text: `- ${e.source}` }) : null);
    // clickable script locations: Workspace.Script:12
    const m = /^([\w. ]+):(\d+):/.exec(e.msg) || /Script '([^']+)', Line (\d+)/.exec(e.msg);
    if (m) { r.classList.add('link'); r.title = 'Open script'; r.addEventListener('click', () => this.app.openScriptByName(m[1], Number(m[2]))); }
    return r;
  }
  renderAll() {
    const frag = document.createDocumentFragment();
    for (const e of this.entries) if (this.visible(e)) frag.append(this.row(e));
    this.list.replaceChildren(frag);
    this.list.scrollTop = this.list.scrollHeight;
  }
  clear() { this.entries = []; this.list.replaceChildren(); }
}

export class CommandBar {
  constructor(app, el) {
    this.app = app;
    this.history = [];
    this.pos = 0;
    this.input = h('input', { class: 'input mono', placeholder: 'Run a command (Luau)', spellcheck: 'false' });
    this.target = h('span', { class: 'cmd-target', title: 'Where commands run' });
    el.append(h('div', { class: 'cmdbar' }, icon('terminal'), this.target, this.input));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.input.value.trim()) {
        const src = this.input.value;
        this.history.push(src); this.pos = this.history.length;
        this.input.value = '';
        this.app.runCommand(src);
      } else if (e.key === 'ArrowUp') { if (this.pos > 0) { this.pos--; this.input.value = this.history[this.pos]; } e.preventDefault(); }
      else if (e.key === 'ArrowDown') { if (this.pos < this.history.length) { this.pos++; this.input.value = this.history[this.pos] || ''; } e.preventDefault(); }
    });
  }
  setTarget(label) { this.target.textContent = label; }
}
