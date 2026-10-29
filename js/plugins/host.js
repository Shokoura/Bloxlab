// Studio plugins.
//  * Lua plugins: Roblox Studio plugin models (.rbxm / .rbxmx, a single .lua file, or a Roblox
//    plugin asset id). Their Scripts run against the edit place with the `plugin` global:
//    toolbars and buttons, dock widgets (rendered with the game GUI renderer), settings, mouse,
//    actions, Selection, ChangeHistoryService and StudioService.
//  * JS plugins: a .js / .html file running in a sandboxed iframe (no access to Bloxlab's page or
//    storage) that talks to Studio through the small message API documented in PLUGINS.md.
import { h, dialog, toast, pickFile, confirmBox, download } from '../studio/ui.js';
import { icon } from '../studio/icons.js';
import { idb } from '../util/idb.js';
import { defineBehavior, Instance } from '../engine/instance.js';
import { methods, lerr, S, arr, fromLuaArray, luaToPlain, plainToLua } from '../engine/bridge.js';
import { LuaTable, Coroutine, EMPTY, toByteStr, R } from '../luau/runtime.js';
import { LuauSyntaxError } from '../luau/lexer.js';
import { ScriptContext } from '../engine/scheduler.js';
import { loadModel, serialize } from '../engine/datamodel.js';
import { Vector2, Vector3, CFrame, Ray } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { GuiRenderer } from '../game/gui.js';
import { encodeValue, decodeValue } from '../net/codec.js';
import { utf8 } from '../formats/raw.js';

// DockWidgetPluginGuiInfo.new(initDockState, initEnabled, overrideEnabledRestore, floatX, floatY, minW, minH)
const DOCK_INFO = (() => {
  const t = new LuaTable();
  const mk = (state, enabled, override, fx, fy, mw, mh) => {
    const i = new LuaTable();
    i.set(toByteStr('InitialDockState'), state); i.set(toByteStr('InitialEnabled'), !!enabled); i.set(toByteStr('InitialEnabledShouldOverrideRestore'), !!override);
    i.set(toByteStr('FloatingXSize'), Number(fx) || 300); i.set(toByteStr('FloatingYSize'), Number(fy) || 240); i.set(toByteStr('MinWidth'), Number(mw) || 0); i.set(toByteStr('MinHeight'), Number(mh) || 0);
    return [i];
  };
  mk.$name = 'new'; mk.$builtin = true;
  t.set(toByteStr('new'), mk);
  return t;
})();
const hostOf = (inst) => inst.pluginHost || (inst.world && inst.world.app && inst.world.app.pluginHost);

// ------------------------------------------------------------------ Lua-visible plugin classes
defineBehavior('Plugin', {
  methods: methods({
    CreateToolbar: (self, name) => {
      const tb = new Instance('PluginToolbar', self.world);
      tb.props.Name = S(name) || 'Toolbar';
      tb.plugin = self;
      tb.buttons = [];
      self.toolbars.push(tb);
      hostOf(self)?.changed();
      return [tb];
    },
    CreateDockWidgetPluginGui: (self, id, info) => {
      const w = new Instance('DockWidgetPluginGui', self.world);
      const i = info instanceof LuaTable ? luaToPlain(info) : (info || {});
      w.props.Name = S(id);
      w.props.Title = S(id);
      w.props.Enabled = !!i.InitialEnabled;
      w.widgetInfo = i;
      w.plugin = self;
      w.pluginHost = hostOf(self);
      self.widgets.push(w);
      w.pluginHost?.mountWidget(w);
      return [w];
    },
    CreatePluginAction: (self, id, text, tip) => { const a = new Instance('PluginAction', self.world); a.props.Name = S(id); a.props.Text = S(text || id); a.props.StatusTip = S(tip || ''); return [a]; },
    CreatePluginMenu: (self, id, title) => { const m = new Instance('PluginMenu', self.world); m.props.Name = S(id); m.props.Title = S(title || ''); m.items = []; return [m]; },
    GetSetting: (self, key) => {
      try { const v = localStorage.getItem(`bloxlab.plugin.${self.pluginId}.${S(key)}`); return [v === null ? undefined : plainToLua(JSON.parse(v))]; } catch { return [undefined]; }
    },
    SetSetting: (self, key, value) => { try { localStorage.setItem(`bloxlab.plugin.${self.pluginId}.${S(key)}`, JSON.stringify(luaToPlain(value) ?? null)); } catch { /* storage unavailable */ } },
    GetMouse: (self) => [hostOf(self).pluginMouse(self)],
    Activate: (self, exclusive) => { const host = hostOf(self); if (host.active && host.active !== self) { const prev = host.active; prev.activated = false; prev.fire('Deactivation'); } host.active = self; self.activated = true; self.exclusiveMouse = !!exclusive; },
    Deactivate: (self) => { const host = hostOf(self); if (host.active === self) host.active = null; if (self.activated) { self.activated = false; self.fire('Deactivation'); } },
    IsActivated: (self) => [!!self.activated],
    IsActivatedWithExclusiveMouse: (self) => [!!self.activated && !!self.exclusiveMouse],
    GetStudioUserId: () => [0],
    OpenScript: (self, script, line) => { if (script) hostOf(self).app.openScript(script, typeof line === 'number' ? line : undefined); },
    OpenWikiPage: () => {},
    GetSelectedRibbonTool: () => [E('RibbonTool', 'None')],
    SelectRibbonTool: () => {},
    StartDrag: () => {},
    PromptSaveSelection: (self, name) => { const app = hostOf(self).app; const sel = app.selection.list(); if (sel.length) download(`${S(name) || 'Model'}.rbxm`, serialize(sel, 'rbxm')); return [sel.length > 0]; },
    SaveSelectedToRoblox: () => { toast('Publishing to Roblox is not available in Bloxlab', 'warn'); },
    *PromptForExistingAssetId(self) { const v = window.prompt('Asset id'); return [Number(v) || -1]; },
    Union: () => { throw lerr('Solid modeling (unions) is not supported in Bloxlab'); },
    Separate: () => { throw lerr('Solid modeling (unions) is not supported in Bloxlab'); },
    Negate: () => { throw lerr('Solid modeling (unions) is not supported in Bloxlab'); },
    GetItem: () => [undefined], SetItem: () => {},
    ImportFbxRig: () => { throw lerr('FBX import is not supported in Bloxlab'); },
  }),
  events: ['Deactivation', 'Unloading', 'Ready'],
});
defineBehavior('PluginToolbar', {
  methods: methods({
    CreateButton: (self, id, tooltip, iconId, text) => {
      const b = new Instance('PluginToolbarButton', self.world);
      b.props.Name = S(id);
      b.props.Text = text !== undefined ? S(text) : S(id);
      b.props.ToolTip = S(tooltip || '');
      b.props.Icon = S(iconId || '');
      b.props.Enabled = true;
      b.toolbar = self;
      self.buttons.push(b);
      hostOf(self.plugin)?.changed();
      return [b];
    },
  }),
});
defineBehavior('PluginToolbarButton', {
  methods: methods({ SetActive: (self, on) => { self.active = !!on; hostOf(self.toolbar.plugin)?.changed(); } }),
  events: ['Click', 'DropdownClick'],
});
defineBehavior('PluginMenu', {
  methods: methods({
    AddNewAction: (self, id, text) => { const a = new Instance('PluginAction', self.world); a.props.Name = S(id); a.props.Text = S(text); self.items.push(a); return [a]; },
    AddAction: (self, a) => { self.items.push(a); },
    AddMenu: (self, m) => { self.items.push(m); },
    AddSeparator: (self) => { self.items.push(null); },
    Clear: (self) => { self.items = []; },
    *ShowAsync(self) {
      const host = hostOf(self) || self.world.app.pluginHost;
      const picked = yield* self.world.scheduler.waitFor((wake) => host.showMenu(self, (a) => wake([a])));
      return picked;
    },
  }),
});
defineBehavior('PluginAction', { events: ['Triggered'] });
defineBehavior('DockWidgetPluginGui', {
  props: {
    Enabled: { get: (w) => !!w.props.Enabled, set: (w, v) => { w.rawSet('Enabled', !!v); w.pluginHost?.showWidget(w, !!v); }, type: 'Bool' },
    Title: { get: (w) => w.props.Title || '', set: (w, v) => { w.rawSet('Title', String(v)); w.pluginHost?.titleWidget(w); }, type: 'String' },
  },
  methods: methods({
    BindToClose: (self, fn) => { self.closeFn = fn || null; },
    RequestRaise: () => {},
    GetRelativeMousePosition: (self) => [self.mousePos || Vector2.zero],
  }),
});

// Studio services available to plugins and the command bar
defineBehavior('Selection', {
  methods: methods({
    Get: (self) => [arr(self.world?.app ? self.world.app.selection.list() : [])],
    Set: (self, list) => { self.world?.app?.selection.set(fromLuaArray(list).filter((i) => i instanceof Instance)); },
    Add: (self, list) => { const app = self.world?.app; if (app) app.selection.set([...app.selection.list(), ...fromLuaArray(list).filter((i) => i instanceof Instance)]); },
    Remove: (self, list) => { const app = self.world?.app; if (!app) return; const rm = new Set(fromLuaArray(list)); app.selection.set(app.selection.list().filter((i) => !rm.has(i))); },
  }),
  events: ['SelectionChanged'],
});
defineBehavior('ChangeHistoryService', {
  methods: methods({
    SetWaypoint: (self, name) => { hostOf(self)?.waypoint(S(name) || 'Change'); },
    TryBeginRecording: (self, name) => { const host = hostOf(self); return [host ? host.beginRecording(S(name) || 'Change') : undefined]; },
    FinishRecording: (self, id, op) => { hostOf(self)?.finishRecording(S(id), op ? op.Name : 'Commit'); },
    IsRecordingInProgress: (self) => [!!hostOf(self)?.recording],
    Undo: (self) => { self.world?.app?.history.undo(); },
    Redo: (self) => { self.world?.app?.history.redo(); },
    GetCanUndo: (self) => [!!self.world?.app?.history.canUndo],
    GetCanRedo: (self) => [!!self.world?.app?.history.canRedo],
    ResetWaypoints: (self) => { const hst = self.world?.app?.history; if (hst) { hst.undoStack = []; hst.redoStack = []; } },
    SetEnabled: () => {},
  }),
  events: ['OnUndo', 'OnRedo', 'OnRecordingStarted', 'OnRecordingFinished'],
});
defineBehavior('StudioService', {
  props: {
    ActiveScript: { get: (s) => { const t = s.world?.app?.activeTab; return t && t.inst ? t.inst : null; }, readonly: true, type: 'Ref' },
    GridSize: { get: (s) => s.world?.app?.settings.get('moveSnap') ?? 1, readonly: true, type: 'Float32' },
    RotateIncrement: { get: (s) => s.world?.app?.settings.get('rotateSnap') ?? 15, readonly: true, type: 'Float32' },
    UseLocalSpace: { get: (s) => !!s.world?.app?.settings.get('localSpace'), set: (s, v) => s.world?.app?.settings.set('localSpace', !!v), type: 'Bool' },
  },
  methods: methods({
    GetUserId: () => [0],
    GetClassIcon: () => { const t = new LuaTable(); t.set(toByteStr('Image'), toByteStr('')); t.set(toByteStr('ImageRectOffset'), Vector2.zero); t.set(toByteStr('ImageRectSize'), Vector2.zero); return [t]; },
    CopyToClipboard: (self, text) => { navigator.clipboard?.writeText(S(text)); },
    *PromptImportFile() { return [undefined]; },
    *PromptImportFiles() { return [new LuaTable()]; },
    IsPluginInstalled: () => [false],
  }),
});

// ------------------------------------------------------------------ host
const BOOT = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;font:13px system-ui,sans-serif;color:#e3e6ec;background:#24272e}</style><script>
(() => {
  let seq = 0; const waiting = new Map(); const handlers = {};
  const call = (method, args) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); parent.postMessage({ bloxlab: 1, id, method, args }, '*'); });
  addEventListener('message', (e) => {
    const m = e.data; if (!m || !m.bloxlab) return;
    if (m.reply) { const w = waiting.get(m.reply); if (!w) return; waiting.delete(m.reply); if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result); return; }
    if (m.event) for (const f of handlers[m.event] || []) { try { f(m.data); } catch (err) { console.error(err); } }
  });
  window.bloxlab = {
    on: (ev, f) => { (handlers[ev] ||= []).push(f); },
    button: (id, opts = {}) => call('button', { id, ...opts }),
    showPanel: (opts = {}) => call('panel', { show: true, ...opts }), hidePanel: () => call('panel', { show: false }),
    lua: (source) => call('lua', { source }),
    selection: { get: () => call('selection.get'), set: (paths) => call('selection.set', { paths }) },
    get: (path, prop) => call('get', { path, prop }), set: (path, prop, value) => call('set', { path, prop, value }),
    insert: (className, parent, props) => call('insert', { className, parent, props }),
    children: (path) => call('children', { path }),
    waypoint: (name) => call('waypoint', { name }),
    toast: (text) => call('toast', { text }), print: (...a) => call('print', { text: a.join(' ') }),
    exportPlace: (format) => call('export', { format }),
  };
})();
<\/script>`;

export class PluginHost {
  constructor(app) {
    this.app = app;
    this.plugins = []; // { id, name, kind, source/bytes, enabled, instance, contexts, frame, buttons }
    this.active = null;
    this.mouse = { x: 0, y: 0 };
    this.recording = null;
    const vp = app.viewport;
    vp.canvas.addEventListener('pointermove', (e) => { this.mouse = { x: e.clientX, y: e.clientY }; this.active?.mouseInst?.fire('Move'); });
    vp.canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) this.active?.mouseInst?.fire('Button1Down'); else if (e.button === 2) this.active?.mouseInst?.fire('Button2Down'); });
    vp.canvas.addEventListener('pointerup', (e) => { if (e.button === 0) this.active?.mouseInst?.fire('Button1Up'); else if (e.button === 2) this.active?.mouseInst?.fire('Button2Up'); });
    app.selection.onChange(() => {
      const sel = app.editWorld.dm.serviceFactory('Selection');
      sel?.fire('SelectionChanged');
      for (const p of this.plugins) if (p.frame) this.post(p, { event: 'selection', data: this.selectionPaths() });
    });
    window.addEventListener('message', (e) => this.onMessage(e));
    app.history.enableLoose();
    // undo / redo notify plugins
    const hist = app.history;
    const undo = hist.undo.bind(hist), redo = hist.redo.bind(hist);
    hist.undo = () => { const n = undo(); if (n) app.editWorld.dm.serviceFactory('ChangeHistoryService')?.fire('OnUndo', toByteStr(n)); return n; };
    hist.redo = () => { const n = redo(); if (n) app.editWorld.dm.serviceFactory('ChangeHistoryService')?.fire('OnRedo', toByteStr(n)); return n; };
  }

  changed() { clearTimeout(this.rebuildT); this.rebuildT = setTimeout(() => this.app.buildRibbon(), 0); }

  // ------------------------------------------------------------ persistence
  async loadInstalled() {
    for (const k of await idb.keys('plugins')) {
      const rec = await idb.get('plugins', k);
      if (rec) this.plugins.push({ ...rec, contexts: [], toolbars: [] });
    }
    for (const p of this.plugins) if (p.enabled !== false) this.start(p);
    this.changed();
  }
  save(p) { return idb.set('plugins', p.id, { id: p.id, name: p.name, kind: p.kind, source: p.source, bytes: p.bytes, enabled: p.enabled !== false, origin: p.origin || '' }); }

  async install({ name, kind, source, bytes, origin }) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const p = { id, name, kind, source, bytes, origin, enabled: true, contexts: [], toolbars: [] };
    this.plugins.push(p);
    await this.save(p);
    this.start(p);
    this.changed();
    toast(`Installed plugin "${name}"`);
    return p;
  }
  async remove(p) {
    this.stop(p);
    this.plugins = this.plugins.filter((x) => x !== p);
    await idb.del('plugins', p.id);
    this.changed();
  }

  // ------------------------------------------------------------ lifecycle
  start(p) {
    try {
      if (p.kind === 'js' || p.kind === 'html') this.startJs(p);
      else this.startLua(p);
    } catch (e) { this.app.output.add({ msg: `Plugin ${p.name}: ${e.message}`, kind: 'error', world: 'edit' }); }
  }
  stop(p) {
    if (p.instance) { try { p.instance.fire('Unloading'); } catch { /* ignore */ } }
    for (const c of p.contexts || []) c.kill();
    p.contexts = [];
    for (const w of p.instance ? p.instance.widgets : []) this.unmountWidget(w);
    p.instance = null;
    if (p.frame) { p.frame.remove(); p.frame = null; }
    if (p.panel) { p.panel.remove(); p.panel = null; }
    p.buttons = [];
    if (this.active && this.active.pluginRec === p) this.active = null;
  }
  restart(p) { this.stop(p); if (p.enabled !== false) this.start(p); this.changed(); }
  onPlaceChanged() { for (const p of this.plugins) if (p.enabled !== false) this.restart(p); }
  tick() {
    for (const p of this.plugins) for (const w of p.instance ? p.instance.widgets : []) if (w.gui && w.props.Enabled) w.gui.update();
  }

  startLua(p) {
    const w = this.app.editWorld;
    let roots;
    if (p.bytes) roots = loadModel(p.bytes instanceof Uint8Array ? p.bytes : new Uint8Array(p.bytes), w).instances;
    else {
      const s = new Instance('Script', w);
      s.props.Name = p.name.replace(/\.\w+$/, '');
      s.props.Source = p.source || '';
      roots = [s];
    }
    const plugin = new Instance('Plugin', w);
    plugin.props.Name = p.name;
    plugin.pluginId = p.id;
    plugin.pluginRec = p;
    plugin.pluginHost = this;
    plugin.toolbars = [];
    plugin.widgets = [];
    p.instance = plugin;
    p.roots = roots;
    for (const r of roots) { r.parent = plugin; plugin.children.push(r); }
    const scripts = [];
    plugin.forTree((d) => { if (d.ClassName === 'Script' && !d.props.Disabled) scripts.push(d); });
    for (const s of scripts) {
      const env = w.vm.newEnv({ script: s, plugin, DockWidgetPluginGuiInfo: DOCK_INFO });
      const ctx = new ScriptContext(w, s, env, `${p.name}.${s.getFullName()}`);
      p.contexts.push(ctx);
      let fn;
      try { fn = w.vm.load(s.props.Source || '', `Plugin_${p.name}.${s.props.Name}`, env); } catch (e) {
        w.output(e instanceof LuauSyntaxError ? `Plugin ${p.name}:${e.line}: ${e.message}` : `Plugin ${p.name}: ${e.message}`, 'error', ctx);
        continue;
      }
      w.scheduler.run(new Coroutine(fn, ctx), EMPTY);
    }
    plugin.fire('Ready');
  }

  pluginMouse(plugin) {
    if (plugin.mouseInst) return plugin.mouseInst;
    const m = new Instance('PluginMouse', plugin.world);
    m.props.Name = 'PluginMouse';
    const host = this;
    const compute = () => {
      const vp = host.app.viewport;
      const hit = vp.pick(host.mouse.x, host.mouse.y, { includeLocked: true });
      const r = vp.canvas.getBoundingClientRect();
      const dir = vp.rayDir(host.mouse.x, host.mouse.y);
      const o = vp.camera.position;
      const p = hit ? hit.point : o.clone().addScaledVector(dir, 1000);
      return { hit: new CFrame(p.x, p.y, p.z), target: hit ? hit.inst : null, x: host.mouse.x - r.left, y: host.mouse.y - r.top, unitRay: new Ray(new Vector3(o.x, o.y, o.z), new Vector3(dir.x, dir.y, dir.z)) };
    };
    for (const k of ['hit', 'target', 'x', 'y', 'unitRay']) Object.defineProperty(m, k, { get: () => compute()[k] });
    plugin.mouseInst = m;
    return m;
  }

  // ------------------------------------------------------------ change history
  waypoint(name) { this.app.history.waypoint(name); }
  beginRecording(name) {
    if (this.recording) this.finishRecording(this.recording.id, 'Commit');
    this.recording = { id: `rec${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name, at: performance.now(), auto: false };
    this.app.history.begin(name);
    this.app.editWorld.dm.serviceFactory('ChangeHistoryService')?.fire('OnRecordingStarted', toByteStr(name));
    return this.recording.id;
  }
  finishRecording(id, op) {
    if (!this.recording || this.recording.id !== id) return;
    const rec = this.recording;
    this.recording = null;
    this.app.history.commit();
    if (op === 'Cancel') this.app.history.undo();
    this.app.editWorld.dm.serviceFactory('ChangeHistoryService')?.fire('OnRecordingFinished', toByteStr(rec.name), undefined, undefined, op);
  }

  // ------------------------------------------------------------ dock widgets
  mountWidget(w) {
    const i = w.widgetInfo || {};
    const box = h('div', { class: 'plugin-widget hidden', style: { width: `${i.FloatingXSize || 300}px`, height: `${i.FloatingYSize || 240}px` } });
    const title = h('div', { class: 'plugin-widget-head' }, h('b', { text: w.props.Title || w.props.Name }), h('button', { class: 'icon-btn small', title: 'Close', onclick: () => { if (w.closeFn) this.app.editWorld.scheduler.spawn(w.closeFn, []); else w.set('Enabled', false); } }, '×'));
    const body = h('div', { class: 'plugin-widget-body' });
    box.append(title, body);
    document.body.append(box);
    // drag by the title bar
    title.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = box.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      const move = (ev) => { box.style.left = `${r.left + ev.clientX - sx}px`; box.style.top = `${r.top + ev.clientY - sy}px`; box.style.right = 'auto'; };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    w.box = box; w.boxTitle = title.querySelector('b');
    w.gui = new GuiRenderer({ world: w.world, app: this.app }, body, { widget: true, roots: () => [w], size: () => ({ w: body.clientWidth, h: body.clientHeight }) });
    this.showWidget(w, !!w.props.Enabled);
  }
  unmountWidget(w) { w.gui?.dispose(); w.box?.remove(); w.gui = null; w.box = null; }
  showWidget(w, on) { if (w.box) { w.box.classList.toggle('hidden', !on); if (w.gui) w.gui.dirty = true; } }
  titleWidget(w) { if (w.boxTitle) w.boxTitle.textContent = w.props.Title; }

  showMenu(menu, done) {
    const r = this.app.viewport.canvas.getBoundingClientRect();
    const items = (menu.items || []).map((a) => (a === null ? { sep: true } : { label: a.props.Text || a.props.Title || a.props.Name, onClick: () => { a.fire('Triggered'); done(a); } }));
    import('../studio/ui.js').then(({ contextMenu }) => contextMenu(this.mouse.x || r.left + 40, this.mouse.y || r.top + 40, items.length ? items : [{ label: '(empty)', disabled: true }]));
  }

  // ------------------------------------------------------------ JS plugins
  startJs(p) {
    const frame = h('iframe', { class: 'plugin-frame', sandbox: 'allow-scripts allow-forms allow-popups', title: p.name });
    const code = p.source || '';
    frame.srcdoc = p.kind === 'html' ? BOOT + code : `${BOOT}<script>${code.replace(/<\/script/gi, '<\\/script')}<\/script>`;
    const panel = h('div', { class: 'plugin-widget hidden' }, h('div', { class: 'plugin-widget-head' }, h('b', { text: p.name }), h('button', { class: 'icon-btn small', title: 'Close', onclick: () => panel.classList.add('hidden') }, '×')), h('div', { class: 'plugin-widget-body' }, frame));
    document.body.append(panel);
    p.frame = frame; p.panel = panel; p.buttons = [];
  }
  post(p, msg) { try { p.frame.contentWindow.postMessage({ bloxlab: 1, ...msg }, '*'); } catch { /* frame gone */ } }
  selectionPaths() { return this.app.selection.list().map((i) => ({ path: pathOf(i), name: i.props.Name, className: i.ClassName })); }
  async onMessage(e) {
    const m = e.data;
    if (!m || !m.bloxlab || !m.method) return;
    const p = this.plugins.find((x) => x.frame && x.frame.contentWindow === e.source);
    if (!p) return;
    const reply = (result, error) => this.post(p, { reply: m.id, result, error });
    try { reply(await this.jsCall(p, m.method, m.args || {})); } catch (err) { reply(undefined, err.message || String(err)); }
  }
  async jsCall(p, method, a) {
    const app = this.app, w = app.editWorld;
    const enc = (v) => encodeValue(v, (i) => pathOf(i));
    const dec = (v) => decodeValue(v, (path) => resolvePath(w.dm, path));
    switch (method) {
      case 'button': p.buttons = p.buttons.filter((b) => b.id !== a.id); p.buttons.push({ id: String(a.id), label: String(a.label || a.id), tip: String(a.tooltip || ''), icon: String(a.icon || '') }); this.changed(); return true;
      case 'panel': if (a.show) { p.panel.classList.remove('hidden'); if (a.width) p.panel.style.width = `${a.width}px`; if (a.height) p.panel.style.height = `${a.height}px`; if (a.title) p.panel.querySelector('b').textContent = a.title; } else p.panel.classList.add('hidden'); return true;
      case 'lua': {
        const out = [];
        const off = w.onOutput((x) => out.push(x.msg));
        try { app.history.run(`Plugin ${p.name}`, () => w.exec(String(a.source || ''), `Plugin_${p.name}`)); w.scheduler.step(0); } finally { off(); }
        return out;
      }
      case 'selection.get': return this.selectionPaths();
      case 'selection.set': app.selection.set((a.paths || []).map((x) => resolvePath(w.dm, x)).filter(Boolean)); return true;
      case 'get': { const i = resolvePath(w.dm, a.path); if (!i) throw new Error(`no instance at ${a.path}`); return enc(i.get(a.prop)); }
      case 'set': { const i = resolvePath(w.dm, a.path); if (!i) throw new Error(`no instance at ${a.path}`); app.history.run(`Plugin ${p.name}`, () => i.set(a.prop, dec(a.value))); return true; }
      case 'children': { const i = a.path ? resolvePath(w.dm, a.path) : w.dm; return i ? i.children.map((c) => ({ path: pathOf(c), name: c.props.Name, className: c.ClassName })) : []; }
      case 'insert': {
        const parent = a.parent ? resolvePath(w.dm, a.parent) : w.dm.findFirstChildOfClass('Workspace');
        const inst = new Instance(String(a.className), w);
        for (const [k, v] of Object.entries(a.props || {})) inst.props[k] = dec(v);
        app.history.run(`Plugin ${p.name}`, () => inst.setParent(parent));
        return pathOf(inst);
      }
      case 'waypoint': return true;
      case 'toast': toast(String(a.text || '')); return true;
      case 'print': app.output.add({ msg: `[${p.name}] ${a.text}`, kind: 'output', world: 'edit' }); return true;
      case 'export': { const { serializePlace } = await import('../engine/datamodel.js'); const b = serializePlace(w.dm, a.format === 'rbxlx' ? 'rbxlx' : 'rbxl'); return a.format === 'rbxlx' ? utf8.dec.decode(b) : btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')); }
      default: throw new Error(`unknown method ${method}`);
    }
  }

  // ------------------------------------------------------------ ribbon + dialogs
  ribbonItems() {
    const items = [];
    for (const p of this.plugins) {
      if (p.enabled === false) continue;
      for (const tb of p.instance ? p.instance.toolbars : []) for (const b of tb.buttons) {
        items.push({ id: `plg-${p.id}-${b.props.Name}`, label: b.props.Text || b.props.Name, icon: 'plugin', title: `${tb.props.Name}: ${b.props.ToolTip || b.props.Name}`, cls: b.active ? 'on' : '', fn: () => { if (b.props.Enabled !== false) b.fire('Click'); } });
      }
      for (const b of p.buttons || []) items.push({ id: `plg-${p.id}-${b.id}`, label: b.label, icon: 'plugin', title: b.tip || b.label, fn: () => this.post(p, { event: 'click', data: b.id }) });
    }
    return items;
  }

  manageDialog() {
    const list = h('div', { class: 'asset-list' });
    const render = () => list.replaceChildren(...(this.plugins.length ? this.plugins.map((p) => {
      const on = h('input', { type: 'checkbox' }); on.checked = p.enabled !== false;
      on.addEventListener('change', async () => { p.enabled = on.checked; await this.save(p); if (on.checked) this.start(p); else this.stop(p); this.changed(); });
      return h('div', { class: 'asset-row' }, on, h('span', { class: 'grow', text: p.name }), h('span', { class: 'muted small', text: p.kind === 'lua' ? 'Lua' : 'JS' }),
        h('button', { class: 'btn small', onclick: () => { this.restart(p); toast(`Reloaded ${p.name}`); } }, 'Reload'),
        p.source ? h('button', { class: 'btn small', onclick: () => download(p.name.includes('.') ? p.name : `${p.name}.${p.kind === 'lua' ? 'lua' : 'js'}`, p.source, 'text/plain') }, 'Source') : null,
        h('button', { class: 'icon-btn small', title: 'Uninstall', onclick: async () => { if (await confirmBox('Uninstall plugin', `Remove "${p.name}"?`, 'Uninstall')) { await this.remove(p); render(); } } }, icon('trash')));
    }) : [h('div', { class: 'muted small', text: 'No plugins installed.' })]));
    render();
    dialog({ title: 'Plugins', wide: true, body: h('div', {}, list, h('p', { class: 'muted small', text: 'Plugin buttons appear in the PLUGINS tab.' })), buttons: [{ label: 'Install…', onClick: () => { this.installDialog(); } }, { label: 'Close', primary: true }] });
  }

  installDialog() {
    const url = h('input', { class: 'input mono', placeholder: 'https://…/plugin.rbxmx  or  .lua / .js' });
    const asset = h('input', { class: 'input mono', placeholder: 'Roblox plugin asset id' });
    const src = h('textarea', { class: 'input mono small', rows: 8 });
    const kind = h('select', { class: 'input small' }, h('option', { value: 'lua' }, 'Lua (Roblox plugin API)'), h('option', { value: 'js' }, 'JavaScript (sandboxed)'));
    const templates = {
      lua: `-- A Roblox-style Studio plugin
local toolbar = plugin:CreateToolbar("My Tools")
local button = toolbar:CreateButton("Rainbow", "Color the selection randomly", "")
button.Click:Connect(function()
\tlocal ChangeHistoryService = game:GetService("ChangeHistoryService")
\tfor _, obj in ipairs(game:GetService("Selection"):Get()) do
\t\tif obj:IsA("BasePart") then obj.Color = Color3.fromHSV(math.random(), 0.8, 1) end
\tend
\tChangeHistoryService:SetWaypoint("Rainbow")
end)`,
      js: `// Runs in a sandboxed frame. API: bloxlab.button, bloxlab.on, bloxlab.lua, bloxlab.selection, bloxlab.get/set/insert, bloxlab.showPanel
bloxlab.button('count', { label: 'Count Parts' });
bloxlab.on('click', async (id) => {
  const out = await bloxlab.lua('local n = 0 for _, d in ipairs(workspace:GetDescendants()) do if d:IsA("BasePart") then n += 1 end end print(n)');
  bloxlab.toast('Parts in workspace: ' + out.join(' '));
});`,
    };
    src.value = templates.lua;
    kind.addEventListener('change', () => { if (!src.dataset.edited) src.value = templates[kind.value]; });
    src.addEventListener('input', () => { src.dataset.edited = '1'; });
    const fromBytes = async (name, bytes, origin) => {
      const lower = name.toLowerCase();
      if (/\.(rbxm|rbxmx)$/.test(lower) || bytes[0] === 0x3c) return this.install({ name: name.replace(/\.\w+$/, ''), kind: 'lua', bytes, origin });
      const text = utf8.dec.decode(bytes);
      if (/\.html?$/.test(lower)) return this.install({ name, kind: 'html', source: text, origin });
      if (/\.m?js$/.test(lower)) return this.install({ name, kind: 'js', source: text, origin });
      return this.install({ name, kind: 'lua', source: text, origin });
    };
    const d = dialog({
      title: 'Install Plugin',
      wide: true,
      body: h('div', { class: 'net-dialog' },
        h('p', { class: 'muted small', text: 'Roblox Studio plugins (.rbxm / .rbxmx / .lua) run with the plugin API. JavaScript plugins (.js / .html) run sandboxed and can only use the documented message API.' }),
        h('div', { class: 'hrow' }, h('button', { class: 'btn', onclick: async () => {
          const files = await pickFile('.rbxm,.rbxmx,.lua,.luau,.js,.mjs,.html', true);
          for (const f of files || []) await fromBytes(f.name, new Uint8Array(await f.arrayBuffer()), 'file');
          if (files && files.length) d.close();
        } }, 'From file…')),
        h('div', { class: 'hrow' }, url, h('button', { class: 'btn', onclick: async () => {
          try { const r = await fetch(url.value.trim()); if (!r.ok) throw new Error(`HTTP ${r.status}`); await fromBytes(url.value.split('/').pop().split('?')[0] || 'plugin', new Uint8Array(await r.arrayBuffer()), url.value.trim()); d.close(); } catch (e) { toast(`Download failed: ${e.message}`, 'error'); }
        } }, 'From URL')),
        h('div', { class: 'hrow' }, asset, h('button', { class: 'btn', onclick: async () => {
          const id = asset.value.replace(/\D/g, '');
          if (!id) return;
          try { const r = await this.app.assets.model(`rbxassetid://${id}`); await this.install({ name: `Plugin ${id}`, kind: 'lua', bytes: r.bytes, origin: `rbxassetid://${id}` }); d.close(); } catch (e) { toast(`Could not load asset ${id}: ${e.message}`, 'error', 7000); }
        } }, 'From Roblox (External Load)')),
        h('h4', { text: 'Or write one' }), kind, src),
      buttons: [{ label: 'Cancel' }, { label: 'Install', primary: true, onClick: async () => { await this.install({ name: kind.value === 'lua' ? 'My Plugin' : 'My JS Plugin', kind: kind.value, source: src.value, origin: 'editor' }); } }],
    });
  }
}

/** "Workspace.Model.Part" style paths for the JS plugin API. */
function pathOf(i) { return i ? i.getFullName() : null; }
function resolvePath(dm, path) {
  if (!path) return null;
  let cur = dm;
  for (const part of String(path).split('.')) {
    cur = cur && (cur.findFirstChild(part) || cur.children.find((c) => c.ClassName === part));
    if (!cur) return null;
  }
  return cur;
}

export { R, Vector2 };
