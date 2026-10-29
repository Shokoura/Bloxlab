// Lightweight Luau code editor (textarea + highlighted overlay).
import { h, esc } from './ui.js';
import { parse } from '../luau/parser.js';

const KW = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'export', 'type', 'typeof']);
const BUILTINS = new Set(['game', 'workspace', 'script', 'plugin', 'shared', '_G', 'print', 'warn', 'error', 'assert', 'pcall', 'xpcall', 'require', 'wait', 'spawn', 'delay', 'tick', 'time', 'type', 'typeof', 'tostring', 'tonumber', 'pairs', 'ipairs', 'next', 'select', 'unpack', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'rawequal', 'rawlen', 'string', 'table', 'math', 'os', 'coroutine', 'task', 'debug', 'bit32', 'utf8', 'buffer', 'Instance', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'BrickColor', 'UDim', 'UDim2', 'Enum', 'Ray', 'TweenInfo', 'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint', 'ColorSequence', 'ColorSequenceKeypoint', 'Rect', 'Region3', 'Random', 'DateTime', 'RaycastParams', 'OverlapParams', 'PhysicalProperties', 'Font', 'Faces', 'Axes', 'vector', 'self']);
const COMMON_MEMBERS = ['GetService', 'FindFirstChild', 'FindFirstChildOfClass', 'FindFirstChildWhichIsA', 'FindFirstAncestor', 'WaitForChild', 'GetChildren', 'GetDescendants', 'IsA', 'Destroy', 'Clone', 'Connect', 'Once', 'Wait', 'Disconnect', 'Fire', 'FireServer', 'FireClient', 'FireAllClients', 'InvokeServer', 'InvokeClient', 'OnServerEvent', 'OnClientEvent', 'OnServerInvoke', 'OnClientInvoke', 'Event', 'Changed', 'GetPropertyChangedSignal', 'GetAttribute', 'SetAttribute', 'Touched', 'TouchEnded', 'Parent', 'Name', 'Position', 'CFrame', 'Size', 'Color', 'Anchored', 'CanCollide', 'Transparency', 'Material', 'Value', 'Humanoid', 'Health', 'MaxHealth', 'WalkSpeed', 'JumpPower', 'Character', 'LocalPlayer', 'PlayerAdded', 'PlayerRemoving', 'CharacterAdded', 'Heartbeat', 'RenderStepped', 'Stepped', 'InputBegan', 'InputEnded', 'KeyCode', 'UserInputType', 'Create', 'Play', 'Stop', 'LoadAnimation', 'MoveTo', 'TakeDamage', 'GetPlayers', 'GetPlayerFromCharacter', 'Text', 'Visible', 'MouseButton1Click', 'Activated', 'new', 'fromRGB', 'Angles', 'lookAt', 'Magnitude', 'Unit', 'LookVector', 'Lerp', 'insert', 'remove', 'find', 'sort', 'concat', 'format', 'sub', 'gsub', 'match', 'gmatch', 'split', 'random', 'floor', 'clamp', 'spawn', 'defer', 'delay', 'wait', 'HumanoidRootPart', 'PrimaryPart', 'PivotTo', 'GetPivot', 'Raycast', 'JSONEncode', 'JSONDecode', 'AddItem', 'GetAsync', 'SetAsync', 'UpdateAsync', 'GetDataStore'];

const TOKEN = /(--\[(=*)\[[\s\S]*?\]\2\]|--[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?|\[(=*)\[[\s\S]*?\]\4\])|(\b0[xX][0-9a-fA-F_]+\b|\b0[bB][01_]+\b|\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b|\.\d+\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_])/g;

export function highlight(src) {
  let out = '';
  let prevSig = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src))) {
    const [all, comment, , str, , num, word, ws, punct] = m;
    if (comment !== undefined) out += `<span class="tk-c">${esc(comment)}</span>`;
    else if (str !== undefined) {
      if (str[0] === '`') out += `<span class="tk-s">${esc(str).replace(/\{([^}]*)\}/g, '<span class="tk-i">{$1}</span>')}</span>`;
      else out += `<span class="tk-s">${esc(str)}</span>`;
    } else if (num !== undefined) out += `<span class="tk-n">${esc(num)}</span>`;
    else if (word !== undefined) {
      if (KW.has(word)) out += `<span class="tk-k">${word}</span>`;
      else if (prevSig === ':' || prevSig === '.') out += `<span class="tk-m">${word}</span>`;
      else if (BUILTINS.has(word)) out += `<span class="tk-b">${word}</span>`;
      else if (/^[A-Z]/.test(word) && src[TOKEN.lastIndex] === '(') out += `<span class="tk-f">${word}</span>`;
      else if (src[TOKEN.lastIndex] === '(') out += `<span class="tk-f">${word}</span>`;
      else out += esc(word);
    } else if (ws !== undefined) out += ws;
    else out += `<span class="tk-p">${esc(punct)}</span>`;
    if (!ws) prevSig = punct || (word ? 'w' : 'x');
    if (all.length === 0) TOKEN.lastIndex++;
  }
  return out + '\n';
}

export class CodeEditor {
  constructor({ value = '', onChange, onSave, fontSize = 13, readOnly = false } = {}) {
    this.onChange = onChange;
    this.onSave = onSave;
    this.gutter = h('div', { class: 'ed-gutter' });
    this.pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
    this.ta = h('textarea', { class: 'ed-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', readonly: readOnly ? '' : null });
    this.ta.value = value;
    this.errBar = h('div', { class: 'ed-err' });
    this.find = h('div', { class: 'ed-find hidden' });
    this.ac = h('div', { class: 'ed-ac hidden' });
    this.body = h('div', { class: 'ed-body' }, this.pre, this.ta, this.ac);
    this.el = h('div', { class: 'editor', style: { '--ed-font': `${fontSize}px` } }, this.find, h('div', { class: 'ed-main' }, this.gutter, this.body), this.errBar);
    this.errorLine = 0;
    this.buildFind();
    this.ta.addEventListener('input', () => { this.schedule(); this.onChange?.(this.ta.value); this.updateAutocomplete(); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('click', () => this.hideAc());
    this.ta.addEventListener('blur', () => setTimeout(() => this.hideAc(), 150));
    this.render();
    this.checkSyntax();
  }
  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this.render(); this.checkSyntax(); }
  focus() { this.ta.focus(); }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
    clearTimeout(this.synT);
    this.synT = setTimeout(() => this.checkSyntax(), 400);
  }
  render() {
    const v = this.ta.value;
    this.pre.innerHTML = highlight(v);
    const lines = v.split('\n').length;
    if (this.lineCount !== lines || this.renderedErr !== this.errorLine) {
      this.lineCount = lines;
      this.renderedErr = this.errorLine;
      let g = '';
      for (let i = 1; i <= lines; i++) g += `<div${i === this.errorLine ? ' class="err"' : ''}>${i}</div>`;
      this.gutter.innerHTML = g;
    }
    this.syncScroll();
  }
  syncScroll() {
    this.pre.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
    this.gutter.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }
  checkSyntax() {
    try { parse(this.ta.value); this.errorLine = 0; this.errBar.textContent = ''; this.errBar.classList.remove('show'); }
    catch (e) { this.errorLine = e.line || 0; this.errBar.textContent = `Line ${e.line}: ${e.message}`; this.errBar.classList.add('show'); }
    this.renderedErr = -1;
    this.render();
  }
  setValue(v) { if (this.ta.value !== v) { this.ta.value = v; this.render(); } }
  gotoLine(n) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < Math.min(n - 1, lines.length); i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + (lines[n - 1] || '').length);
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    this.ta.scrollTop = Math.max(0, (n - 5) * lh);
  }

  insert(text, selectStart, selectEnd) {
    const ta = this.ta;
    ta.focus();
    // execCommand keeps the native undo stack working
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.dispatchEvent(new Event('input'));
    }
    if (selectStart !== undefined) ta.setSelectionRange(selectStart, selectEnd ?? selectStart);
  }

  onKey(e) {
    const ta = this.ta;
    if (this.acOpen && this.onAcKey(e)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.onSave?.(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); this.toggleComment(); return; }
    e.stopPropagation(); // keep studio shortcuts out of the editor
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      const v = ta.value;
      if (s === en && !e.shiftKey) { this.insert('\t'); return; }
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const block = v.slice(ls, en);
      const repl = e.shiftKey ? block.replace(/^(\t| {1,4})/gm, '') : block.replace(/^/gm, '\t');
      ta.setSelectionRange(ls, en);
      this.insert(repl, ls, ls + repl.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const s = ta.selectionStart;
      const v = ta.value;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(ls, s);
      const indent = /^[\t ]*/.exec(line)[0];
      const opens = /(\bthen|\bdo|\belse|\brepeat|\bfunction\b[^)]*\)|\bfunction\s*\([^)]*\)|[{(\[])\s*(--.*)?$/.test(line) && !/\bend\b\s*$/.test(line);
      if (opens) {
        const rest = v.slice(s);
        const nextLine = rest.split('\n')[1] ?? '';
        const needsEnd = /(\bthen|\bdo|\bfunction\b.*\))\s*$/.test(line) && !(/^\s*(end|else|elseif|until)\b/.test(rest.split('\n')[0] + nextLine)) && this.unbalanced();
        const closer = needsEnd ? `\n${indent}end` : /[{(\[]\s*$/.test(line) && /^[})\]]/.test(rest) ? `\n${indent}` : '';
        this.insert(`\n${indent}\t${closer}`, s + indent.length + 2);
      } else this.insert(`\n${indent}`);
      return;
    }
    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
    if (pairs[e.key] && ta.selectionStart === ta.selectionEnd) {
      const next = ta.value[ta.selectionStart] || '';
      if ((e.key === '"' || e.key === "'") && next === e.key) { e.preventDefault(); ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1); return; }
      if (/[\s)\]}]|^$/.test(next)) { e.preventDefault(); const s = ta.selectionStart; this.insert(e.key + pairs[e.key], s + 1); return; }
    }
    if ((e.key === ')' || e.key === ']' || e.key === '}') && ta.value[ta.selectionStart] === e.key && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault(); ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1);
    }
  }
  unbalanced() {
    // rough check: more block openers than `end`s in the document
    const v = this.ta.value.replace(/--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\[(=*)\[[\s\S]*?\]\2\]/g, '');
    const count = (re) => (v.match(re) || []).length;
    return count(/\bfunction\b/g) + count(/\bif\b/g) + count(/\bdo\b/g) > count(/\bend\b/g);
  }
  toggleComment() {
    const ta = this.ta;
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e); if (le < 0) le = v.length;
    const block = v.slice(ls, le);
    const allCommented = block.split('\n').every((l) => /^\s*--/.test(l) || !l.trim());
    const repl = allCommented ? block.replace(/^(\s*)-- ?/gm, '$1') : block.replace(/^(\s*)(?=\S)/gm, '$1-- ');
    ta.setSelectionRange(ls, le);
    this.insert(repl, ls, ls + repl.length);
  }

  // ---------------------------------------------------------------- find
  buildFind() {
    const input = h('input', { class: 'input', placeholder: 'Find' });
    const repl = h('input', { class: 'input', placeholder: 'Replace' });
    const next = () => {
      const q = input.value; if (!q) return;
      const v = this.ta.value;
      let i = v.indexOf(q, this.ta.selectionEnd);
      if (i < 0) i = v.indexOf(q);
      if (i >= 0) { this.ta.focus(); this.ta.setSelectionRange(i, i + q.length); const line = v.slice(0, i).split('\n').length; const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18; this.ta.scrollTop = Math.max(0, (line - 5) * lh); input.focus(); }
    };
    const replaceOne = () => { const q = input.value; const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd); if (q && sel === q) this.insert(repl.value); next(); };
    const replaceAll = () => { const q = input.value; if (!q) return; this.ta.select(); this.insert(this.ta.value.split(q).join(repl.value)); };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') next(); if (e.key === 'Escape') this.find.classList.add('hidden'); });
    repl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') replaceOne(); if (e.key === 'Escape') this.find.classList.add('hidden'); });
    this.find.append(input, h('button', { class: 'btn small', onclick: next }, 'Next'), repl, h('button', { class: 'btn small', onclick: replaceOne }, 'Replace'), h('button', { class: 'btn small', onclick: replaceAll }, 'All'), h('button', { class: 'icon-btn small', onclick: () => this.find.classList.add('hidden'), html: '&times;' }));
    this.findInput = input;
  }
  openFind() {
    this.find.classList.remove('hidden');
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n')) this.findInput.value = sel;
    this.findInput.focus(); this.findInput.select();
  }

  // ---------------------------------------------------------------- autocomplete
  updateAutocomplete() {
    const ta = this.ta;
    const s = ta.selectionStart;
    const before = ta.value.slice(Math.max(0, s - 80), s);
    const m = /([.:]?)([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
    if (!m || (m[2].length < 2 && !m[1])) { this.hideAc(); return; }
    const prefix = m[2];
    let pool;
    if (m[1]) pool = COMMON_MEMBERS;
    else {
      const words = new Set(ta.value.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []);
      pool = [...KW, ...BUILTINS, ...words];
    }
    const lower = prefix.toLowerCase();
    const items = [...new Set(pool)].filter((w) => w !== prefix && w.toLowerCase().startsWith(lower)).sort((a, b) => a.length - b.length).slice(0, 8);
    if (!items.length) { this.hideAc(); return; }
    this.acItems = items; this.acIndex = 0; this.acPrefix = prefix;
    this.ac.replaceChildren(...items.map((w, i) => h('div', { class: `ac-item${i === 0 ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); this.acIndex = i; this.acceptAc(); } }, w)));
    const pos = this.caretXY();
    this.ac.style.left = `${pos.x}px`; this.ac.style.top = `${pos.y}px`;
    this.ac.classList.remove('hidden');
    this.acOpen = true;
  }
  caretXY() {
    const ta = this.ta;
    const v = ta.value.slice(0, ta.selectionStart);
    const line = v.split('\n').length - 1;
    const col = v.length - v.lastIndexOf('\n') - 1;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 18;
    const cw = (parseFloat(cs.fontSize) || 13) * 0.6;
    const tabs = (v.slice(v.lastIndexOf('\n') + 1).match(/\t/g) || []).length;
    return { x: 8 + (col + tabs * 3) * cw - ta.scrollLeft, y: (line + 1) * lh + 6 - ta.scrollTop };
  }
  onAcKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.acIndex = (this.acIndex + (e.key === 'ArrowDown' ? 1 : -1) + this.acItems.length) % this.acItems.length;
      [...this.ac.children].forEach((c, i) => c.classList.toggle('on', i === this.acIndex));
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && this.acItems)) { e.preventDefault(); this.acceptAc(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); this.hideAc(); return true; }
    return false;
  }
  acceptAc() {
    const w = this.acItems[this.acIndex];
    const s = this.ta.selectionStart;
    this.ta.setSelectionRange(s - this.acPrefix.length, s);
    this.insert(w);
    this.hideAc();
  }
  hideAc() { this.acOpen = false; this.ac.classList.add('hidden'); }
}
