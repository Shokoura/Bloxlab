// Core GUI drawn over the game: top bar + menu, chat, player list (with leaderstats), health,
// backpack hotbar, proximity prompts, name tags, chat bubbles, notifications, purchase prompts,
// touch controls and the disconnected screen.
import { Vector3 } from '../engine/datatypes.js';
import { luaToPlain } from '../engine/bridge.js';
import { LuaTable, fromByteStr } from '../luau/runtime.js';
import { rootPartOf } from '../engine/classes/humanoid.js';
import { INSET } from './input.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const css = (c) => (c ? `rgb(${Math.round(c.R * 255)},${Math.round(c.G * 255)},${Math.round(c.B * 255)})` : '#fff');
const ICON = {
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  bag: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/></svg>',
};

function project(vp, pos) {
  const cam = vp.camera;
  const e = cam.matrixWorldInverse.elements;
  const x = e[0] * pos.X + e[4] * pos.Y + e[8] * pos.Z + e[12];
  const y = e[1] * pos.X + e[5] * pos.Y + e[9] * pos.Z + e[13];
  const z = e[2] * pos.X + e[6] * pos.Y + e[10] * pos.Z + e[14];
  if (z > -0.1) return null;
  const f = 1 / Math.tan((cam.fov * Math.PI) / 360);
  return { x: ((f / cam.aspect) * x / -z + 1) / 2 * vp.size.w, y: (1 - f * y / -z) / 2 * vp.size.h, d: -z };
}

export class Hud {
  constructor(rt, container) {
    this.rt = rt;
    this.vp = rt.viewport;
    this.root = el('div', 'game-hud game-ui');
    this.root.style.zIndex = '30';
    container.append(this.root);
    this.tags = new Map();
    this.bubbles = [];
    this.prompts = new Map();
    this.notes = [];
    this.coreState = { ResetButtonCallback: true, TopbarEnabled: true };
    this.build();
    const h = rt.world.hooks;
    h.setCore = (name, value) => this.setCore(name, value);
    h.getCore = (name) => this.getCore(name);
    h.bubbleChat = (part, msg) => this.bubble(part, msg);
    h.touchButtonsChanged = () => this.renderTouchButtons();
    h.promptHoldBegin = (pp) => this.holdBegin(pp);
    h.promptHoldEnd = (pp) => this.holdEnd(pp);
    this.off = rt.on((type, data) => {
      if (type === 'chat') this.addChat(data);
      else if (type === 'kicked') this.showKicked(data);
      else if (type === 'backpack' || type === 'character') this.backpackDirty = true;
      else if (type === 'died') this.root.classList.add('dead');
    });
    for (const e of rt.chatLog.slice(-30)) this.addChat(e);
    if (rt.kicked) this.showKicked(rt.kicked);
  }
  dispose() {
    this.off();
    this.root.remove();
    for (const k of ['setCore', 'getCore', 'bubbleChat', 'touchButtonsChanged', 'promptHoldBegin', 'promptHoldEnd']) delete this.rt.world.hooks[k];
  }
  core(type) { const c = this.rt.world.coreGui; return !c || (c[type] !== false && c.All !== false); }

  build() {
    const r = this.root;
    // top bar
    this.topbar = el('div', 'topbar-game');
    const mk = (icon, title, fn) => { const b = el('button'); b.innerHTML = ICON[icon]; b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    this.menuBtn = mk('menu', 'Menu (Esc)', () => this.toggleMenu());
    this.chatBtn = mk('chat', 'Chat (/)', () => { this.chatHidden = !this.chatHidden; this.chat.classList.toggle('hidden', this.chatHidden); });
    this.bagBtn = mk('bag', 'Backpack', () => { this.hotbarHidden = !this.hotbarHidden; this.backpackDirty = true; });
    this.topbar.append(this.menuBtn, this.chatBtn, this.bagBtn);
    // chat
    this.chat = el('div', 'game-chat idle');
    this.chatLogEl = el('div', 'log');
    this.chatInput = el('input');
    this.chatInput.placeholder = 'To chat click here or press "/" key';
    this.chatInput.maxLength = 200;
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = this.chatInput.value; this.chatInput.value = ''; this.chatInput.blur(); if (t.trim()) this.rt.chat(t); }
      else if (e.key === 'Escape') this.chatInput.blur();
    });
    this.chatInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.chatInput.addEventListener('focus', () => this.chat.classList.remove('idle'));
    this.chatInput.addEventListener('blur', () => { this.chat.classList.add('idle'); this.vp.canvas.focus({ preventScroll: true }); });
    this.chat.append(this.chatLogEl, this.chatInput);
    // player list + health
    this.list = el('div', 'player-list');
    this.health = el('div', 'health-bar hidden');
    this.healthFill = el('i');
    this.health.append(this.healthFill);
    this.hotbar = el('div', 'hotbar');
    this.world3d = el('div', 'hud-3d');
    this.notesEl = el('div', 'notes');
    this.netbar = el('div', 'netbar');
    r.append(this.world3d, this.topbar, this.chat, this.list, this.health, this.hotbar, this.notesEl, this.netbar);
    if (this.rt.input && this.rt.input.touchEnabled) this.buildTouch();
  }

  // ------------------------------------------------------------ chat
  addChat(e) {
    const row = el('div', e.system ? 'sys' : '');
    if (e.system) row.textContent = e.text;
    else {
      const name = el('b', '', `${e.from}: `);
      const p = e.player;
      if (p && p.props.Team && p.props.TeamColor) name.style.color = css(p.props.TeamColor.Color);
      else name.style.color = nameColor(e.from || '');
      row.append(name, document.createTextNode(e.text));
    }
    if (e.color) row.style.color = e.color;
    this.chatLogEl.append(row);
    while (this.chatLogEl.childNodes.length > 80) this.chatLogEl.firstChild.remove();
    this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    this.chat.classList.remove('faded');
    this.lastChat = performance.now();
  }
  focusChat() { if (this.core('Chat') && !this.chatHidden) setTimeout(() => this.chatInput.focus(), 0); }

  // ------------------------------------------------------------ SetCore / GetCore
  setCore(name, value) {
    const v = value instanceof LuaTable ? luaToPlain(value) : typeof value === 'string' ? fromByteStr(value) : value;
    switch (name) {
      case 'SendNotification': this.notify(v || {}); break;
      case 'ChatMakeSystemMessage': this.addChat({ system: true, text: String(v && v.Text || ''), color: v && v.Color ? css(v.Color) : null }); break;
      case 'ChatActive': this.chatHidden = !v; this.chat.classList.toggle('hidden', !v); break;
      case 'TopbarEnabled': this.coreState.TopbarEnabled = !!v; break;
      case 'ResetButtonCallback': this.coreState.ResetButtonCallback = value; break;
      case 'PromptSendFriendRequest': case 'PromptUnfriend': case 'PromptBlockPlayer': case 'PromptUnblockPlayer': this.notify({ Title: 'Friends', Text: 'Friend requests are not available in Bloxlab' }); break;
      default: this.coreState[name] = value;
    }
  }
  getCore(name) {
    if (name === 'ChatActive') return !this.chatHidden;
    if (name === 'PlayerBlockedEvent' || name === 'PlayerUnblockedEvent' || name === 'PlayerFriendedEvent' || name === 'PlayerUnfriendedEvent') return undefined;
    return this.coreState[name];
  }
  notify(n) {
    const box = el('div', 'note');
    if (n.Title) box.append(el('b', '', String(n.Title)));
    if (n.Text) box.append(el('div', '', String(n.Text)));
    const cb = n.Callback;
    for (const k of ['Button1', 'Button2']) if (n[k]) {
      const b = el('button', 'note-btn', String(n[k]));
      b.addEventListener('click', () => { if (cb && cb.ClassName === 'BindableFunction') this.rt.world.scheduler.spawn(cb.callbacks?.OnInvoke, [n[k]]); box.remove(); });
      box.append(b);
    }
    this.notesEl.append(box);
    setTimeout(() => box.remove(), Math.max(1, Number(n.Duration) || 5) * 1000);
  }

  // ------------------------------------------------------------ menu
  toggleMenu() {
    if (this.menu) { this.menu.remove(); this.menu = null; return; }
    const rt = this.rt;
    const m = el('div', 'dialog-game game-menu');
    m.append(el('h3', '', 'Game Menu'));
    const btn = (label, fn, cls = '') => { const b = el('button', `menu-btn ${cls}`, label); b.addEventListener('click', () => { fn(); }); m.append(b); return b; };
    btn('Resume', () => this.toggleMenu());
    const rbc = this.coreState.ResetButtonCallback;
    if (rbc !== false) btn('Reset Character', () => {
      this.toggleMenu();
      if (rbc && rbc.ClassName === 'BindableEvent') { rbc.fire('Event'); return; }
      rt.resetCharacter();
    });
    const sl = el('label', 'menu-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = rt.camera.shiftLockEnabled;
    cb.addEventListener('change', () => { rt.camera.shiftLockEnabled = cb.checked; if (!cb.checked) rt.camera.shiftLock = false; });
    sl.append(cb, document.createTextNode(' Shift Lock Switch'));
    m.append(sl);
    const vol = el('label', 'menu-row');
    const vr = el('input'); vr.type = 'range'; vr.min = '0'; vr.max = '1'; vr.step = '0.05'; vr.value = String(rt.sound.master ? rt.sound.master.gain.value : 1);
    vr.addEventListener('input', () => { if (rt.sound.master) rt.sound.master.gain.value = Number(vr.value); });
    vol.append(document.createTextNode('Volume '), vr);
    m.append(vol);
    btn(rt.app.session && rt.app.session.mode !== 'join' ? 'Stop Playing' : 'Leave Game', () => { this.toggleMenu(); rt.app.stopPlay?.(); }, 'danger');
    this.root.append(m);
    this.menu = m;
  }
  togglePlayerList() { this.listHidden = !this.listHidden; }

  // ------------------------------------------------------------ purchase prompt (simulated)
  purchasePrompt(id, kind) {
    const d = el('div', 'dialog-game');
    const what = { product: 'Developer Product', gamepass: 'Game Pass', subscription: 'Subscription' }[kind] || 'Item';
    d.append(el('h3', '', `Buy ${what}`), el('p', '', `${what} #${id}`), el('p', 'muted', 'Purchases are simulated in Bloxlab: nothing is charged.'));
    const row = el('div', 'row');
    const ok = el('button', 'menu-btn primary', 'Buy (test)'), no = el('button', 'menu-btn', 'Cancel');
    ok.addEventListener('click', () => { d.remove(); this.rt.purchaseResult(id, kind, true); });
    no.addEventListener('click', () => { d.remove(); this.rt.purchaseResult(id, kind, false); });
    row.append(ok, no);
    d.append(row);
    this.root.append(d);
  }

  showKicked(msg) {
    if (this.kickedEl) return;
    const d = el('div', 'dialog-game kicked');
    d.append(el('h3', '', 'Disconnected'), el('p', '', msg || 'You were disconnected'));
    const b = el('button', 'menu-btn', 'Leave');
    b.addEventListener('click', () => this.rt.app.stopPlay?.());
    d.append(b);
    this.root.append(d);
    this.kickedEl = d;
  }

  // ------------------------------------------------------------ hotbar
  hotbarTools() {
    const lp = this.rt.localPlayer;
    const bp = lp && lp.findFirstChildOfClass('Backpack');
    const ch = this.rt.character;
    const tools = [];
    this.order ||= [];
    const all = [...(bp ? bp.children : []), ...(ch ? ch.children : [])].filter((t) => t.isA('Tool'));
    this.order = this.order.filter((t) => all.includes(t));
    for (const t of all) if (!this.order.includes(t)) this.order.push(t);
    for (const t of this.order) tools.push(t);
    return tools.slice(0, 10);
  }
  renderHotbar() {
    const show = this.core('Backpack') && !this.hotbarHidden;
    this.hotbar.classList.toggle('hidden', !show);
    if (!show) return;
    const tools = this.hotbarTools();
    const key = tools.map((t) => `${t.id}:${t.props.Name}:${t.parent === this.rt.character ? 1 : 0}:${t.props.TextureId || ''}`).join('|');
    if (key === this.hotKey) return;
    this.hotKey = key;
    this.hotbar.replaceChildren(...tools.map((t, i) => {
      const s = el('div', `slot${t.parent === this.rt.character ? ' on' : ''}`);
      s.append(el('span', 'n', String((i + 1) % 10)));
      const tex = t.props.TextureId;
      if (tex) { const img = el('img'); img.alt = ''; this.rt.app.assets.imageUrl(tex).then((u) => { img.src = u; }).catch(() => { img.replaceWith(el('span', '', t.props.Name)); }); s.append(img); }
      else s.append(el('span', 'label', t.props.Name));
      s.title = t.props.ToolTip || t.props.Name;
      s.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.rt.equip(t); });
      return s;
    }));
  }

  // ------------------------------------------------------------ player list
  renderList() {
    const show = this.core('PlayerList') && !this.listHidden;
    this.list.classList.toggle('hidden', !show);
    if (!show) return;
    const players = this.rt.service('Players').children.filter((p) => p.ClassName === 'Player');
    const statsOf = (p) => { const ls = p.findFirstChild('leaderstats'); return ls ? ls.children.filter((c) => c.isA('ValueBase')) : []; };
    const cols = [];
    for (const p of players) for (const s of statsOf(p)) if (!cols.includes(s.props.Name)) cols.push(s.props.Name);
    const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v * 100) / 100)) : v === undefined || v === null ? '-' : String(v));
    const rows = players.map((p) => [p, cols.map((c) => { const s = statsOf(p).find((x) => x.props.Name === c); return s ? fmt(s.get('Value')) : '-'; })]);
    const first = cols[0];
    if (first) rows.sort((a, b) => (parseFloat(b[1][0]) || 0) - (parseFloat(a[1][0]) || 0));
    const key = JSON.stringify([cols, rows.map(([p, v]) => [p.props.Name, p.props.DisplayName, p.props.Team ? p.props.Team.props.Name : '', v])]);
    if (key === this.listKey) return;
    this.listKey = key;
    const table = el('table');
    if (cols.length) { const hr = el('tr'); hr.append(el('th', '', 'Player'), ...cols.map((c) => el('th', '', c))); table.append(hr); }
    const teams = this.rt.service('Teams');
    const teamList = teams ? teams.children.filter((t) => t.ClassName === 'Team') : [];
    const addRow = ([p, vals]) => {
      const tr = el('tr', p === this.rt.localPlayer ? 'me' : '');
      tr.append(el('td', '', p.props.DisplayName || p.props.Name), ...vals.map((v) => el('td', 'v', v)));
      table.append(tr);
    };
    if (teamList.length) {
      for (const t of teamList) {
        const members = rows.filter(([p]) => p.props.Team === t);
        if (!members.length && t.props.AutoAssignable === false) continue;
        const tr = el('tr', 'team'); const td = el('td', '', t.props.Name); td.colSpan = cols.length + 1; td.style.background = css(t.props.TeamColor && t.props.TeamColor.Color); tr.append(td); table.append(tr);
        members.forEach(addRow);
      }
      rows.filter(([p]) => !p.props.Team).forEach(addRow);
    } else rows.forEach(addRow);
    this.list.replaceChildren(table);
  }

  // ------------------------------------------------------------ 3D overlays (name tags, bubbles, prompts)
  bubble(part, text) {
    const b = el('div', 'bubble', String(text));
    this.world3d.append(b);
    this.bubbles = this.bubbles.filter((x) => { if (x.part === part) { x.el.remove(); return false; } return true; });
    this.bubbles.push({ part, el: b, until: performance.now() + 9000 + String(text).length * 40 });
  }
  renderTags() {
    const players = this.rt.service('Players').children.filter((p) => p.ClassName === 'Player');
    const seen = new Set();
    const camCF = this.rt.service('Workspace').props.CurrentCamera?.props.CFrame;
    for (const p of players) {
      if (p === this.rt.localPlayer) continue;
      const ch = p.props.Character;
      const hum = ch && ch.findFirstChildOfClass('Humanoid');
      const head = ch && ch.findFirstChild('Head');
      if (!hum || !head || hum.props.DisplayDistanceType?.Name === 'None') continue;
      seen.add(p);
      let t = this.tags.get(p);
      if (!t) { t = { el: el('div', 'nametag'), name: el('div'), hp: el('div', 'hp'), fill: el('i') }; t.hp.append(t.fill); t.el.append(t.name, t.hp); this.world3d.append(t.el); this.tags.set(p, t); }
      const pos = head.props.CFrame.Position.add(new Vector3(0, head.props.Size.Y / 2 + 1.2, 0));
      const s = project(this.vp, pos);
      const dist = camCF ? camCF.Position.sub(pos).Magnitude : 0;
      const maxD = hum.props.NameDisplayDistance ?? 100;
      if (!s || dist > maxD) { t.el.style.display = 'none'; continue; }
      t.el.style.display = '';
      t.el.style.left = `${s.x}px`; t.el.style.top = `${s.y}px`;
      const name = hum.props.DisplayName || p.props.DisplayName || p.props.Name;
      if (t.name.textContent !== name) t.name.textContent = name;
      if (p.props.Team && p.props.TeamColor) t.name.style.color = css(p.props.TeamColor.Color);
      const hpv = Math.max(0, (hum.props.Health ?? 100) / (hum.props.MaxHealth || 100));
      t.hp.style.display = hpv < 1 && dist < (hum.props.HealthDisplayDistance ?? 100) ? '' : 'none';
      t.fill.style.width = `${hpv * 100}%`;
    }
    for (const [p, t] of this.tags) if (!seen.has(p)) { t.el.remove(); this.tags.delete(p); }
    const now = performance.now();
    this.bubbles = this.bubbles.filter((b) => {
      if (now > b.until || !b.part.dm) { b.el.remove(); return false; }
      const pos = b.part.props.CFrame.Position.add(new Vector3(0, (b.part.props.Size?.Y || 1) / 2 + 2.6, 0));
      const s = project(this.vp, pos);
      if (!s || s.d > 100) { b.el.style.display = 'none'; return true; }
      b.el.style.display = '';
      b.el.style.left = `${s.x}px`; b.el.style.top = `${s.y}px`;
      return true;
    });
  }

  // ------------------------------------------------------------ proximity prompts
  renderPrompts(dt) {
    const rt = this.rt;
    const root = rt.humanoid && rootPartOf(rt.humanoid);
    const ws = rt.service('Workspace');
    if (!this.promptScan || performance.now() - this.promptScan > 500) {
      this.promptScan = performance.now();
      this.allPrompts = [];
      ws.forTree((d) => { if (d.ClassName === 'ProximityPrompt') this.allPrompts.push(d); });
      const pg = rt.localPlayer && rt.localPlayer.findFirstChildOfClass('PlayerGui');
      if (pg) pg.forTree((d) => { if (d.ClassName === 'ProximityPrompt') this.allPrompts.push(d); });
    }
    const pps = rt.service('ProximityPromptService');
    const enabledSvc = pps.props.Enabled !== false;
    const active = new Map();
    if (root && enabledSvc && rt.humanoid.state !== 'Dead') {
      const me = root.props.CFrame.Position;
      const byKey = new Map();
      for (const pp of this.allPrompts) {
        if (!pp.dm || pp.props.Enabled === false) continue;
        const parent = pp.parent;
        const pos = parent && (parent.isA('BasePart') ? parent.props.CFrame.Position : parent.ClassName === 'Attachment' ? parent.get('WorldPosition') : parent.isA('Model') && parent.props.PrimaryPart ? parent.props.PrimaryPart.props.CFrame.Position : null);
        if (!pos) continue;
        const d = pos.sub(me).Magnitude;
        if (d > (pp.props.MaxActivationDistance ?? 10)) continue;
        const key = pp.props.KeyboardKeyCode ? pp.props.KeyboardKeyCode.Name : 'E';
        const ex = pp.props.Exclusivity ? pp.props.Exclusivity.Name : 'OnePerButton';
        const entry = { pp, pos, d, key };
        if (ex === 'AlwaysShow') active.set(pp, entry);
        else if (!byKey.has(key) || byKey.get(key).d > d) byKey.set(key, entry);
      }
      for (const e of byKey.values()) active.set(e.pp, e);
    }
    // shown / hidden events + DOM
    for (const [pp, ui] of this.prompts) {
      if (active.has(pp)) continue;
      ui.el.remove(); this.prompts.delete(pp);
      pp.fire('PromptHidden'); pps.fire('PromptHidden', pp);
      if (ui.holding) this.holdEnd(pp);
    }
    for (const [pp, e] of active) {
      let ui = this.prompts.get(pp);
      if (!ui) {
        ui = { el: el('div', 'prompt-ui'), keyEl: el('div', 'key'), ring: el('div', 'ring'), text: el('div', 'txt'), hold: 0, holding: false, key: e.key };
        ui.keyEl.append(ui.ring);
        ui.el.append(ui.keyEl, ui.text);
        ui.el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.holdBegin(pp); });
        ui.el.addEventListener('pointerup', (ev) => { ev.stopPropagation(); this.holdEnd(pp); });
        this.prompts.set(pp, ui);
        pp.fire('PromptShown', 'Keyboard'); pps.fire('PromptShown', pp, 'Keyboard');
        if (!pp.props.Style || pp.props.Style.Name !== 'Custom') this.world3d.append(ui.el);
      }
      ui.key = e.key;
      const label = e.key.length === 1 ? e.key : e.key.replace(/^Button/, '');
      if (ui.keyEl.firstChild !== ui.ring || ui.keyEl.dataset.k !== label) { ui.keyEl.dataset.k = label; ui.keyEl.replaceChildren(ui.ring, document.createTextNode(label)); }
      const txt = `${pp.props.ObjectText ? `<small>${escapeHtml(pp.props.ObjectText)}</small>` : ''}${escapeHtml(pp.props.ActionText ?? 'Interact')}`;
      if (ui.text.innerHTML !== txt) ui.text.innerHTML = txt;
      const off = pp.props.UIOffset || { X: 0, Y: 0 };
      const s = project(this.vp, e.pos);
      if (!s) { ui.el.style.display = 'none'; continue; }
      ui.el.style.display = '';
      ui.el.style.left = `${s.x + off.X}px`; ui.el.style.top = `${s.y - off.Y}px`;
      const dur = pp.props.HoldDuration ?? 0;
      if (ui.holding && dur > 0) {
        ui.hold += dt;
        ui.ring.style.background = `conic-gradient(#fff ${Math.min(1, ui.hold / dur) * 360}deg, transparent 0)`;
        if (ui.hold >= dur && !ui.fired) { ui.fired = true; this.rt.prompt(pp, 't'); }
      } else ui.ring.style.background = 'transparent';
    }
  }
  promptKey(kc, down) {
    for (const [pp, ui] of this.prompts) if (ui.key === kc) { if (down) this.holdBegin(pp); }
  }
  holdBegin(pp) {
    const ui = this.prompts.get(pp);
    if (!ui || ui.holding) return;
    ui.holding = true; ui.hold = 0; ui.fired = false;
    this.rt.prompt(pp, 'hb');
    if (!(pp.props.HoldDuration > 0)) { ui.fired = true; this.rt.prompt(pp, 't'); }
  }
  holdEnd(pp) {
    const ui = this.prompts.get(pp);
    if (!ui || !ui.holding) return;
    ui.holding = false;
    ui.ring.style.background = 'transparent';
    this.rt.prompt(pp, 'he');
    if (ui.fired) this.rt.prompt(pp, 'e');
  }

  // ------------------------------------------------------------ touch controls
  buildTouch() {
    const t = el('div', 'touch-ui');
    const stick = el('div', 'touch-stick'), knob = el('i');
    stick.append(knob);
    const jump = el('button', 'touch-jump', 'Jump');
    let id = null, cx = 0, cy = 0;
    stick.addEventListener('pointerdown', (e) => { id = e.pointerId; const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; stick.setPointerCapture(e.pointerId); e.stopPropagation(); });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = (e.clientX - cx) / 50, dy = (e.clientY - cy) / 50;
      const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      if (this.rt.input) this.rt.input.touchMove = { x: dx, y: dy };
    });
    const end = (e) => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; if (this.rt.input) this.rt.input.touchMove = null; };
    stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
    jump.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (this.rt.input) this.rt.input.touchJump = true; this.rt.service('UserInputService').fire('JumpRequest'); });
    const jend = () => { if (this.rt.input) this.rt.input.touchJump = false; };
    jump.addEventListener('pointerup', jend); jump.addEventListener('pointercancel', jend);
    this.touchButtons = el('div', 'touch-actions');
    t.append(stick, jump, this.touchButtons);
    this.root.append(t);
    this.touchEl = t;
    this.renderTouchButtons();
  }
  renderTouchButtons() {
    if (!this.touchButtons) return;
    const cas = this.rt.service('ContextActionService');
    const acts = (cas.actions || []).filter((a) => a.touch);
    this.touchButtons.replaceChildren(...acts.map((a, i) => {
      const b = el('button', 'touch-act', a.title || a.name);
      b.style.right = `${130 + (i % 3) * 64}px`; b.style.bottom = `${40 + Math.floor(i / 3) * 64}px`;
      const io = (state) => this.rt.input && this.rt.input.makeInput('Touch', state);
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.rt.input?.runAction(a, 'Begin', io('Begin')); });
      b.addEventListener('pointerup', (e) => { e.stopPropagation(); this.rt.input?.runAction(a, 'End', io('End')); });
      return b;
    }));
  }

  // ------------------------------------------------------------ frame
  update(dt) {
    const tb = this.coreState.TopbarEnabled !== false;
    this.topbar.classList.toggle('hidden', !tb);
    this.chat.classList.toggle('hidden', !this.core('Chat') || !!this.chatHidden);
    if (this.lastChat && performance.now() - this.lastChat > 12000 && document.activeElement !== this.chatInput) this.chat.classList.add('faded');
    this.renderList();
    this.renderHotbar();
    const hum = this.rt.humanoid;
    const showHp = this.core('Health') && hum && (hum.props.Health ?? 100) < (hum.props.MaxHealth ?? 100);
    this.health.classList.toggle('hidden', !showHp);
    if (showHp) {
      const f = Math.max(0, (hum.props.Health ?? 0) / (hum.props.MaxHealth || 100));
      this.healthFill.style.width = `${f * 100}%`;
      this.healthFill.style.background = f > 0.5 ? '#3ddc5c' : f > 0.25 ? '#f0c419' : '#e5534b';
    }
    this.root.classList.toggle('dead', !!hum && hum.state === 'Dead');
    this.renderTags();
    this.renderPrompts(dt);
    this.netAcc = (this.netAcc || 0) + dt;
    if (this.netAcc > 0.5) {
      this.netAcc = 0;
      const p = this.rt.replicator.ping;
      const fps = Math.round(1 / Math.max(dt, 1e-3));
      this.netbar.textContent = `${fps} fps${p ? ` · ${Math.round(p)} ms` : ''}`;
      if (!this.rt.replicator.transport.local) this.rt.replicator.send({ t: 'ping', s: performance.now() });
    }
    void INSET;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME_COLORS = ['#fd2943', '#01a2ff', '#02b857', '#a75ec2', '#f58e2c', '#f5cd30', '#e8bac8', '#d7c59a'];
function nameColor(name) {
  // Roblox's legacy chat name color hash
  let v = 0;
  for (let i = 0; i < name.length; i++) { const c = name.charCodeAt(i); const r = name.length - i; v += (r % 2 === 1 ? c : -c) * (r % 4 === 0 || r % 4 === 1 ? 1 : 1); }
  return NAME_COLORS[((v % NAME_COLORS.length) + NAME_COLORS.length) % NAME_COLORS.length];
}
