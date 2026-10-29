// Small DOM helpers shared by the Studio UI.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastHost = null;
export function toast(text, kind = 'info', ms = 3200) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts' }); document.body.append(toastHost); }
  const t = h('div', { class: `toast ${kind}` }, text);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/** Modal dialog. Returns { el, close }. buttons: [{ label, primary, onClick -> false keeps open }] */
export function dialog({ title, body, buttons = [{ label: 'Close' }], wide = false, onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('b', { text: title }), h('button', { class: 'icon-btn', title: 'Close', onclick: close, html: '&times;' })),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', {
      class: b.primary ? 'btn primary' : 'btn',
      onclick: async () => { const r = b.onClick ? await b.onClick() : undefined; if (r !== false) close(); },
    }, b.label))) : null);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => box.querySelector('input,textarea,select,button.primary')?.focus(), 30);
  return { el: box, close };
}

export function prompt(title, label, value = '', { placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder });
    const d = dialog({
      title,
      body: h('label', { class: 'field' }, h('span', { text: label }), input),
      buttons: [{ label: 'Cancel', onClick: () => { done = true; resolve(null); } }, { label: 'OK', primary: true, onClick: () => { done = true; resolve(input.value); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; resolve(input.value); d.close(); } });
  });
}

export function confirmBox(title, text, yes = 'OK') {
  return new Promise((resolve) => {
    let done = false;
    dialog({
      title, body: h('p', { text }),
      buttons: [{ label: 'Cancel', onClick: () => { done = true; resolve(false); } }, { label: yes, primary: true, onClick: () => { done = true; resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/** Context menu at (x, y). items: [{ label, onClick, disabled, sep, shortcut, sub: items }] */
export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const build = (list) => h('div', { class: 'ctx-menu' }, list.map((it) => {
    if (it.sep) return h('div', { class: 'ctx-sep' });
    const row = h('div', { class: `ctx-item${it.disabled ? ' disabled' : ''}${it.sub ? ' has-sub' : ''}` },
      h('span', { text: it.label }), it.shortcut ? h('kbd', { text: it.shortcut }) : null);
    if (it.sub) {
      const sub = build(it.sub);
      sub.classList.add('sub');
      row.append(sub);
    } else if (!it.disabled) row.addEventListener('click', (e) => { e.stopPropagation(); close(); it.onClick?.(); });
    return row;
  }));
  const menu = build(items);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  return close;
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => { resolve(multiple ? [...input.files] : input.files[0] || null); input.remove(); });
    input.click();
  });
}

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
