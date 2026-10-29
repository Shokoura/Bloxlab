// Explorer panel: instance tree with selection, rename, drag & drop and context menu.
import { h, contextMenu, debounce } from './ui.js';
import { classIcon, icon } from './icons.js';

const HIDDEN_SERVICES = new Set(['Selection', 'CoreGui', 'CorePackages', 'RobloxPluginGuiService', 'PluginGuiService', 'PluginDebugService', 'Visit', 'ScriptContext', 'NetworkClient', 'NetworkServer', 'Stats', 'LogService', 'GuiService', 'UserInputService', 'RunService', 'TweenService', 'ContextActionService', 'HttpService', 'CollectionService', 'Debris', 'KeyframeSequenceProvider', 'ContentProvider', 'MarketplaceService', 'PathfindingService', 'PhysicsService', 'DataStoreService', 'TeleportService', 'BadgeService', 'GroupService', 'InsertService', 'TextService', 'PolicyService', 'ChangeHistoryService', 'StudioService', 'PluginManager', 'AnalyticsService', 'MessagingService', 'MemoryStoreService', 'ProximityPromptService', 'SocialService', 'VRService', 'HapticService', 'AvatarEditorService', 'GamepadService', 'AssetService', 'ScriptEditorService', 'NotificationService', 'LocalizationService', 'TestService', 'MaterialService', 'TextChatService', 'Chat']);
const SERVICE_ORDER = ['Workspace', 'Players', 'Lighting', 'MaterialService', 'NetworkClient', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Teams', 'SoundService', 'Chat', 'TextChatService', 'LocalizationService', 'TestService'];
const ALWAYS_SHOWN = new Set(['MaterialService', 'TextChatService', 'Chat', 'LocalizationService', 'TestService']);

export class Explorer {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.expanded = new WeakSet();
    this.rows = new Map(); // inst -> row element
    this.filter = '';
    this.world = null;
    this.anchor = null;
    this.search = h('input', { class: 'input search', placeholder: 'Filter workspace (Ctrl+Shift+X)', oninput: debounce(() => { this.filter = this.search.value.trim().toLowerCase(); this.render(); }, 150) });
    this.tree = h('div', { class: 'tree', tabindex: '0', role: 'tree' });
    el.append(h('div', { class: 'panel-tools' }, this.search), this.tree);
    this.tree.addEventListener('keydown', (e) => this.onKey(e));
    this.scheduleRender = debounce(() => this.render(), 30);
    app.selection.onChange(() => { this.revealSelection(); this.updateSelectionClasses(); });
  }

  setWorld(world) {
    if (this.unobserve) this.unobserve();
    this.world = world;
    this.unobserve = world.observe({
      added: () => this.scheduleRender(),
      removed: () => this.scheduleRender(),
      moved: () => this.scheduleRender(),
      propChanged: (inst, name) => { if (name === 'Name' || name === 'Disabled') { const r = this.rows.get(inst); if (r) r.querySelector('.name').textContent = inst.props.Name; } },
    });
    if (world.dm) { this.expanded.add(world.dm.findFirstChildOfClass('Workspace')); }
    this.render();
  }

  serviceVisible(s) {
    if (!s.isService && s.parent && s.parent.ClassName === 'DataModel') return true;
    if (HIDDEN_SERVICES.has(s.ClassName) && !ALWAYS_SHOWN.has(s.ClassName)) return false;
    return true;
  }
  childrenOf(inst) {
    let list = inst.children;
    if (inst.ClassName === 'DataModel') {
      list = list.filter((c) => this.serviceVisible(c)).sort((a, b) => {
        const ia = SERVICE_ORDER.indexOf(a.ClassName), ib = SERVICE_ORDER.indexOf(b.ClassName);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    }
    return list;
  }
  matches(inst) {
    if (!this.filter) return true;
    if (inst.props.Name.toLowerCase().includes(this.filter) || inst.ClassName.toLowerCase().includes(this.filter)) return true;
    return inst.descendants().some((d) => d.props.Name.toLowerCase().includes(this.filter) || d.ClassName.toLowerCase().includes(this.filter));
  }

  render() {
    const dm = this.world && this.world.dm;
    this.rows.clear();
    if (!dm) { this.tree.replaceChildren(); return; }
    const frag = document.createDocumentFragment();
    const walk = (inst, depth) => {
      if (!this.matches(inst)) return;
      frag.append(this.row(inst, depth));
      if (this.expanded.has(inst) || (this.filter && inst.children.length)) for (const c of this.childrenOf(inst)) walk(c, depth + 1);
    };
    for (const s of this.childrenOf(dm)) walk(s, 0);
    const scroll = this.tree.scrollTop;
    this.tree.replaceChildren(frag);
    this.tree.scrollTop = scroll;
    this.updateSelectionClasses();
  }

  row(inst, depth) {
    const kids = this.childrenOf(inst).length > 0;
    const open = this.expanded.has(inst) || (this.filter && kids);
    const twisty = h('span', { class: `twisty${kids ? '' : ' none'}${open ? ' open' : ''}`, onclick: (e) => { e.stopPropagation(); this.toggle(inst); } }, kids ? icon('chevron') : null);
    const r = h('div', {
      class: `row${inst.props.Disabled ? ' disabled' : ''}`,
      role: 'treeitem',
      draggable: !inst.isService && inst.ClassName !== 'DataModel' ? 'true' : null,
      style: { paddingLeft: `${4 + depth * 14}px` },
      title: inst.ClassName,
    }, twisty, classIcon(inst.ClassName), h('span', { class: 'name', text: inst.props.Name }));
    r.__inst = inst;
    r.addEventListener('click', (e) => this.onClick(e, inst));
    r.addEventListener('dblclick', () => this.app.openInstance(inst));
    r.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!this.app.selection.has(inst)) this.app.selection.set([inst]); this.menu(e.clientX, e.clientY, inst); });
    r.addEventListener('dragstart', (e) => { this.dragging = this.app.selection.has(inst) ? this.app.selection.list() : [inst]; e.dataTransfer.setData('text/plain', 'bloxlab-instances'); e.dataTransfer.effectAllowed = 'move'; });
    r.addEventListener('dragover', (e) => { if (this.dragging) { e.preventDefault(); r.classList.add('drop'); } });
    r.addEventListener('dragleave', () => r.classList.remove('drop'));
    r.addEventListener('drop', (e) => {
      e.preventDefault(); r.classList.remove('drop');
      const list = this.dragging; this.dragging = null;
      if (list) this.app.reparent(list, inst);
    });
    this.rows.set(inst, r);
    return r;
  }

  toggle(inst) { if (this.expanded.has(inst)) this.expanded.delete(inst); else this.expanded.add(inst); this.render(); }

  onClick(e, inst) {
    const sel = this.app.selection;
    if (e.shiftKey && this.anchor) {
      const rows = [...this.rows.keys()];
      const a = rows.indexOf(this.anchor), b = rows.indexOf(inst);
      if (a >= 0 && b >= 0) sel.set(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) sel.toggle(inst);
    else { sel.set([inst]); this.anchor = inst; }
    this.tree.focus();
  }

  updateSelectionClasses() {
    const sel = new Set(this.app.selection.list());
    for (const [inst, r] of this.rows) r.classList.toggle('selected', sel.has(inst));
  }
  revealSelection() {
    let changed = false;
    for (const i of this.app.selection.list()) for (let p = i.parent; p; p = p.parent) if (!this.expanded.has(p)) { this.expanded.add(p); changed = true; }
    if (changed) this.render();
    const first = this.rows.get(this.app.selection.first());
    if (first) first.scrollIntoView({ block: 'nearest' });
  }

  startRename(inst) {
    const r = this.rows.get(inst);
    if (!r) return;
    const name = r.querySelector('.name');
    const input = h('input', { class: 'rename', value: inst.props.Name });
    name.replaceWith(input);
    input.focus(); input.select();
    const done = (ok) => {
      if (ok && input.value && input.value !== inst.props.Name) this.app.history.run('Rename', () => inst.set('Name', input.value));
      this.render();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }

  onKey(e) {
    const sel = this.app.selection.list();
    if (e.key === 'F2' && sel[0]) { e.preventDefault(); this.startRename(sel[0]); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...this.rows.keys()];
      const i = rows.indexOf(sel[sel.length - 1]);
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { this.app.selection.set([n]); this.anchor = n; }
    } else if (e.key === 'ArrowRight' && sel[0]) { if (!this.expanded.has(sel[0])) this.toggle(sel[0]); }
    else if (e.key === 'ArrowLeft' && sel[0]) { if (this.expanded.has(sel[0])) this.toggle(sel[0]); else if (sel[0].parent && sel[0].parent.ClassName !== 'DataModel') this.app.selection.set([sel[0].parent]); }
    else if (e.key === 'Enter' && sel[0]) this.app.openInstance(sel[0]);
  }

  menu(x, y, inst) {
    const app = this.app;
    const sel = app.selection.list();
    const scriptLike = /Script$/.test(inst.ClassName);
    contextMenu(x, y, [
      { label: 'Insert Object…', shortcut: 'Ctrl+I', onClick: () => app.insertObjectDialog(inst) },
      { label: 'Insert Part', onClick: () => app.insertPart('Block', inst) },
      { label: 'Insert', sub: ['Script', 'LocalScript', 'ModuleScript', 'Folder', 'Model', 'Part', 'RemoteEvent', 'RemoteFunction', 'ScreenGui', 'Frame', 'TextLabel', 'TextButton', 'PointLight', 'Sound', 'Decal', 'Attachment', 'WeldConstraint', 'ClickDetector', 'ProximityPrompt', 'Humanoid'].map((cn) => ({ label: cn, onClick: () => app.insertObject(cn, inst) })) },
      { sep: true },
      { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => app.cut(), disabled: !sel.length },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => app.copy(), disabled: !sel.length },
      { label: 'Paste Into', shortcut: 'Ctrl+Shift+V', onClick: () => app.paste(inst), disabled: !app.clipboard },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: () => app.duplicate() },
      { label: 'Delete', shortcut: 'Del', onClick: () => app.deleteSelection() },
      { label: 'Rename', shortcut: 'F2', onClick: () => this.startRename(inst) },
      { sep: true },
      { label: 'Group', shortcut: 'Ctrl+G', onClick: () => app.group() },
      { label: 'Ungroup', shortcut: 'Ctrl+U', onClick: () => app.ungroup() },
      { label: 'Select Children', onClick: () => app.selection.set(inst.children.slice()) },
      { label: 'Zoom To', shortcut: 'F', onClick: () => app.viewport.focusSelection() },
      { sep: true },
      scriptLike ? { label: 'Open Script', onClick: () => app.openInstance(inst) } : null,
      { label: 'Save to File…', onClick: () => app.exportSelection() },
      { label: 'Insert from File…', onClick: () => app.insertFromFile(inst) },
      { label: 'Insert from Roblox asset ID…', onClick: () => app.insertAssetDialog(inst) },
    ].filter(Boolean));
  }
}
