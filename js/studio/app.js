// Bloxlab Studio: layout, ribbon, file handling and editing operations.
import '../engine/classes/index.js';
import { h, $, toast, dialog, prompt, contextMenu, download, pickFile, confirmBox, debounce } from './ui.js';
import { icon, classIcon } from './icons.js';
import { Settings } from './settings.js';
import { Selection } from './selection.js';
import { History } from './history.js';
import { Viewport } from './viewport.js';
import { Explorer } from './explorer.js';
import { Properties } from './properties.js';
import { Output, CommandBar } from './output.js';
import { CodeEditor } from './editor.js';
import { SceneView } from '../render/scene.js';
import { World } from '../engine/world.js';
import { Instance } from '../engine/instance.js';
import { newBaseplate, newEmptyPlace, loadPlace, loadModel, serializePlace, serialize, parseFile, rawToInstances } from '../engine/datamodel.js';
import { isCreatable, allClassNames, isA } from '../engine/reflect.js';
import { Vector3, CFrame, Color3, BrickColor } from '../engine/datatypes.js';
import { E, getEnum } from '../engine/enums.js';
import { AssetManager } from '../assets/manager.js';
import { idb } from '../util/idb.js';
import { utf8 } from '../formats/raw.js';

const PART_SHAPES = { Block: 'Block', Sphere: 'Ball', Cylinder: 'Cylinder' };

export class App {
  constructor(root, { nene = null } = {}) {
    this.root = root;
    this.nene = nene;
    this.settings = new Settings();
    this.selection = new Selection();
    this.assets = new AssetManager(this.settings);
    this.assets.loadOverrides().catch(() => {});
    this.clipboard = null;
    this.tabs = [];
    this.activeTab = null;
    this.session = null;
    this.project = { id: null, name: 'Place1', dirty: false };
    this.pluginHost = null;
    this.buildLayout();
    this.viewport = new Viewport(this, this.centerView);
    this.explorer = new Explorer(this, this.explorerEl);
    this.properties = new Properties(this, this.propertiesEl);
    this.output = new Output(this, this.outputEl);
    this.commandBar = new CommandBar(this, this.cmdEl);
    this.history = new History(null, () => this.updateRibbonState());
    this.selection.onChange(() => { this.viewport.refreshSelection(); this.updateRibbonState(); if (this.pickCallback) { const cb = this.pickCallback; this.pickCallback = null; cb(this.selection.first()); } });
    this.bindKeys();
    this.setPlace(newBaseplate(this.makeEditWorld()), 'Place1');
    this.loop();
    this.autosave = debounce(() => this.saveToBrowser(true), 4000);
    setInterval(() => { if (this.project.dirty && this.settings.get('autosave') && !this.session) this.saveToBrowser(true); }, 60000);
  }

  // ================================================================ layout
  buildLayout() {
    const r = this.root;
    r.classList.add('studio');
    this.ribbonTabs = h('div', { class: 'ribbon-tabs' });
    this.ribbonBody = h('div', { class: 'ribbon-body' });
    this.titleEl = h('span', { class: 'title' });
    this.statusEl = h('span', { class: 'status' });
    const fileBtn = h('button', { class: 'file-btn', onclick: (e) => this.fileMenu(e.currentTarget) }, 'File');
    const top = h('header', { class: 'topbar' }, h('div', { class: 'brand', title: 'Bloxlab Studio' }, h('img', { src: 'icon.svg', alt: '' }), h('b', { text: 'Bloxlab' })), fileBtn, this.ribbonTabs, h('span', { class: 'spacer' }), this.statusEl, this.titleEl,
      h('button', { class: 'icon-btn', title: 'Settings', onclick: () => this.openSettings() }, icon('settings')));
    this.centerTabs = h('div', { class: 'center-tabs' });
    this.centerView = h('div', { class: 'center-view' });
    this.centerEditor = h('div', { class: 'center-editor hidden' });
    this.explorerEl = h('section', { class: 'panel explorer' }, h('div', { class: 'panel-head' }, icon('explorer'), h('span', { text: 'Explorer' })));
    this.propertiesEl = h('section', { class: 'panel properties' }, h('div', { class: 'panel-head' }, icon('properties'), h('span', { text: 'Properties' })));
    this.outputEl = h('section', { class: 'panel output' }, h('div', { class: 'panel-head' }, icon('output'), h('span', { text: 'Output' })));
    this.cmdEl = h('div', { class: 'cmd-host' });
    this.toolboxEl = h('section', { class: 'panel toolbox hidden' }, h('div', { class: 'panel-head' }, icon('toolbox'), h('span', { text: 'Toolbox' })));
    this.consoleEl = h('section', { class: 'panel console hidden' }, h('div', { class: 'panel-head' }, icon('network'), h('span', { text: 'Server Console' })));
    const center = h('main', { class: 'center' }, this.centerTabs, h('div', { class: 'center-stack' }, this.centerView, this.centerEditor));
    const right = h('aside', { class: 'side right' }, this.explorerEl, h('div', { class: 'split h', dataset: { split: 'explorer' } }), this.propertiesEl);
    const left = h('aside', { class: 'side left hidden' }, this.toolboxEl);
    const bottom = h('footer', { class: 'bottom' }, this.outputEl, this.consoleEl, this.cmdEl);
    this.layout = h('div', { class: 'layout' }, left, h('div', { class: 'col' }, center, h('div', { class: 'split v', dataset: { split: 'bottom' } }), bottom), h('div', { class: 'split vside', dataset: { split: 'right' } }), right);
    this.leftEl = left; this.rightEl = right; this.bottomEl = bottom;
    r.append(top, h('div', { class: 'ribbon' }, this.ribbonBody), this.layout);
    this.buildRibbon();
    this.bindSplitters();
  }

  bindSplitters() {
    for (const s of this.root.querySelectorAll('.split')) {
      s.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        s.setPointerCapture(e.pointerId);
        const kind = s.dataset.split;
        const start = { x: e.clientX, y: e.clientY, bottom: this.bottomEl.offsetHeight, right: this.rightEl.offsetWidth, explorer: this.explorerEl.offsetHeight };
        const move = (ev) => {
          if (kind === 'bottom') this.bottomEl.style.height = `${Math.max(60, start.bottom - (ev.clientY - start.y))}px`;
          if (kind === 'right') this.rightEl.style.width = `${Math.max(180, start.right - (ev.clientX - start.x))}px`;
          if (kind === 'explorer') this.explorerEl.style.flex = `0 0 ${Math.max(80, start.explorer + (ev.clientY - start.y))}px`;
        };
        const up = () => { s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); };
        s.addEventListener('pointermove', move);
        s.addEventListener('pointerup', up);
      });
    }
  }

  ribbonDefs() {
    const b = (id, label, ic, fn, opts = {}) => ({ id, label, icon: ic, fn, ...opts });
    const tools = [b('tool-select', 'Select', 'select', () => this.setTool('select'), { toggle: 'select' }), b('tool-move', 'Move', 'move', () => this.setTool('move'), { toggle: 'move' }), b('tool-scale', 'Scale', 'scale', () => this.setTool('scale'), { toggle: 'scale' }), b('tool-rotate', 'Rotate', 'rotate', () => this.setTool('rotate'), { toggle: 'rotate' })];
    const test = [b('play', 'Play', 'playFill', () => this.play('play'), { cls: 'green', title: 'Play (F5)' }), b('playhere', 'Play Here', 'play', () => this.play('here')), b('run', 'Run', 'run', () => this.play('run'), { title: 'Run (F8)' }), b('stop', 'Stop', 'stop', () => this.stopPlay(), { cls: 'red', title: 'Stop (Shift+F5)' })];
    return {
      HOME: [
        { group: 'Clipboard', items: [b('paste', 'Paste', 'paste', () => this.paste()), b('copy', 'Copy', 'copy', () => this.copy()), b('cut', 'Cut', 'cut', () => this.cut()), b('dup', 'Duplicate', 'copy', () => this.duplicate())] },
        { group: 'Tools', items: tools },
        { group: 'Insert', items: [b('part', 'Part', 'part', (e) => this.partMenu(e)), b('ui', 'UI', 'monitor', () => this.insertObject('ScreenGui', this.dm().findFirstChildOfClass('StarterGui'))), b('obj', 'Object', 'plus', () => this.insertObjectDialog())] },
        { group: 'Edit', items: [b('color', 'Color', 'color', (e) => this.colorMenu(e)), b('material', 'Material', 'material', (e) => this.materialMenu(e)), b('group', 'Group', 'group', () => this.group()), b('anchor', 'Anchor', 'anchor', () => this.toggleAnchor())] },
        { group: 'Test', items: test },
      ],
      MODEL: [
        { group: 'Tools', items: tools },
        { group: 'Snap to Grid', items: [{ custom: () => this.snapControls() }] },
        { group: 'Parts', items: ['Block', 'Sphere', 'Wedge', 'CornerWedge', 'Cylinder', 'Truss', 'Spawn', 'Seat'].map((s) => b(`p-${s}`, s, { Block: 'part', Sphere: 'sphere', Wedge: 'wedge', CornerWedge: 'wedge', Cylinder: 'cylinder', Truss: 'truss', Spawn: 'spawn', Seat: 'part' }[s], () => this.insertPart(s))) },
        { group: 'Edit', items: [b('m-group', 'Group', 'group', () => this.group()), b('m-ungroup', 'Ungroup', 'ungroup', () => this.ungroup()), b('m-anchor', 'Anchor', 'anchor', () => this.toggleAnchor()), b('m-lock', 'Lock', 'lock', () => this.toggleLock()), b('m-color', 'Color', 'color', (e) => this.colorMenu(e)), b('m-mat', 'Material', 'material', (e) => this.materialMenu(e))] },
        { group: 'Constraints', items: [b('weld', 'Weld', 'weld', () => this.weldSelection()), b('attach', 'Attachment', 'dot', () => this.insertObject('Attachment'))] },
        { group: 'Advanced', items: [b('script', 'Script', 'script', () => this.insertObject('Script')), b('lscript', 'LocalScript', 'script', () => this.insertObject('LocalScript')), b('mscript', 'ModuleScript', 'script', () => this.insertObject('ModuleScript'))] },
        { group: 'Effects', items: ['PointLight', 'SpotLight', 'ParticleEmitter', 'Fire', 'Smoke', 'Sparkles', 'Sound'].map((c) => b(`e-${c}`, c.replace('Emitter', ''), c === 'Sound' ? 'speaker' : c.includes('Light') ? 'bulb' : 'sparkles', () => this.insertObject(c))) },
      ],
      TEST: [
        { group: 'Simulation', items: test },
        { group: 'Multiplayer', items: [b('host', 'Host Game', 'network', () => this.hostDialog()), b('join', 'Join Game', 'wifi', () => this.joinDialog()), b('localtest', 'Local Test', 'users', () => this.localTestDialog())] },
        { group: 'View', items: [b('clientserver', 'Client/Server', 'server', () => this.toggleClientServer()), b('console', 'Console', 'terminal', () => this.togglePanel('console'))] },
        { group: 'Avatar', items: [b('avatar', 'Avatar', 'avatar', () => this.openSettings('Avatar'))] },
      ],
      VIEW: [
        { group: 'Show', items: [b('v-explorer', 'Explorer', 'explorer', () => this.togglePanel('explorer')), b('v-props', 'Properties', 'properties', () => this.togglePanel('properties')), b('v-output', 'Output', 'output', () => this.togglePanel('output')), b('v-cmd', 'Command Bar', 'terminal', () => this.togglePanel('cmd')), b('v-toolbox', 'Toolbox', 'toolbox', () => this.togglePanel('toolbox')), b('v-console', 'Server Console', 'network', () => this.togglePanel('console'))] },
        { group: 'Camera', items: [b('focus', 'Focus', 'focus', () => this.viewport.focusSelection()), b('resetcam', 'Reset', 'camera', () => this.resetCamera())] },
        { group: 'Assets', items: [b('assetmgr', 'Asset Manager', 'image', () => this.openAssetManager()), b('extload', 'External Load', 'cloud', () => this.openSettings('External Load'))] },
      ],
      PLUGINS: [
        { group: 'Manage', items: [b('plugins', 'Manage Plugins', 'plugin', () => this.pluginsDialog()), b('plugin-install', 'Install…', 'download', () => this.installPluginDialog())] },
        { group: 'Installed', id: 'plugin-toolbars', items: [] },
      ],
    };
  }

  buildRibbon() {
    const defs = this.ribbonDefs();
    this.ribbonTabs.replaceChildren(...Object.keys(defs).map((k) => h('button', { class: `rtab${k === (this.ribbonTab || 'HOME') ? ' active' : ''}`, onclick: () => { this.ribbonTab = k; this.buildRibbon(); } }, k)));
    const tab = defs[this.ribbonTab || 'HOME'];
    this.ribbonBody.replaceChildren(...tab.map((g) => {
      const items = g.id === 'plugin-toolbars' ? this.pluginToolbarItems() : g.items;
      return h('div', { class: 'rgroup' },
        h('div', { class: 'ritems' }, items.map((it) => {
          if (it.custom) return it.custom();
          return h('button', { class: `rbtn${it.cls ? ' ' + it.cls : ''}${it.toggle && this.viewport && this.viewport.tool === it.toggle ? ' on' : ''}`, id: `rb-${it.id}`, title: it.title || it.label, onclick: (e) => it.fn(e) }, it.img ? h('img', { src: it.img, alt: '', class: 'ico' }) : icon(it.icon), h('span', { text: it.label }));
        }), !items.length && g.id === 'plugin-toolbars' ? h('span', { class: 'muted small', text: 'No plugins installed' }) : null),
        h('div', { class: 'rlabel', text: g.group }));
    }));
    this.updateRibbonState();
  }
  pluginToolbarItems() { return this.pluginHost ? this.pluginHost.ribbonItems() : []; }

  snapControls() {
    const ms = h('input', { class: 'input tiny', type: 'number', step: '0.1', min: '0', value: this.settings.get('moveSnap') });
    const rs = h('input', { class: 'input tiny', type: 'number', step: '1', min: '0', value: this.settings.get('rotateSnap') });
    ms.addEventListener('change', () => { this.settings.set('moveSnap', Math.max(0, Number(ms.value) || 0)); this.viewport.refreshSelection(); });
    rs.addEventListener('change', () => { this.settings.set('rotateSnap', Math.max(0, Number(rs.value) || 0)); this.viewport.refreshSelection(); });
    for (const i of [ms, rs]) i.addEventListener('keydown', (e) => e.stopPropagation());
    return h('div', { class: 'snaps' }, h('label', {}, 'Move', ms, 'studs'), h('label', {}, 'Rotate', rs, '°'));
  }

  updateRibbonState() {
    const playing = !!this.session;
    for (const id of ['play', 'playhere', 'run']) { const el = document.getElementById(`rb-${id}`); if (el) el.disabled = playing; }
    const stop = document.getElementById('rb-stop'); if (stop) stop.disabled = !playing;
    for (const t of ['select', 'move', 'scale', 'rotate']) { const el = document.getElementById(`rb-tool-${t}`); if (el) el.classList.toggle('on', this.viewport?.tool === t); }
    this.titleEl.textContent = `${this.project.name}${this.project.dirty ? ' •' : ''}`;
    document.title = `${this.project.name} - Bloxlab Studio`;
    if (this.session) this.statusEl.textContent = this.session.statusText();
    else this.statusEl.textContent = '';
  }

  togglePanel(which) {
    const map = { explorer: this.explorerEl, properties: this.propertiesEl, output: this.outputEl, cmd: this.cmdEl, toolbox: this.toolboxEl, console: this.consoleEl };
    const el = map[which];
    el.classList.toggle('hidden');
    if (which === 'toolbox') { this.leftEl.classList.toggle('hidden', el.classList.contains('hidden')); if (!this.toolbox) import('./toolbox.js').then((m) => { this.toolbox = new m.Toolbox(this, this.toolboxEl); }); }
    if (which === 'console' && !el.classList.contains('hidden') && !this.console) import('./console.js').then((m) => { this.console = new m.HostConsole(this, this.consoleEl); });
    this.rightEl.classList.toggle('hidden', this.explorerEl.classList.contains('hidden') && this.propertiesEl.classList.contains('hidden'));
    this.viewport.resize();
  }

  // ================================================================ worlds
  makeEditWorld() {
    const w = new World({ kind: 'edit', app: this, name: 'edit' });
    w.onOutput((e) => this.output.add(e));
    w.loadObjectsSync = () => [];
    return w;
  }
  dm() { return this.editWorld.dm; }

  setPlace(dm, name) {
    if (this.session) this.stopPlay();
    const world = dm.world;
    if (this.editWorld && this.editWorld !== world) { this.editWorld.stop(); }
    if (this.editView) this.editView.dispose();
    this.editWorld = world;
    world.setGameGlobals(dm);
    this.history.attach(world);
    this.selection.clear();
    this.closeScriptTabs();
    this.editView = new SceneView(world, { assets: this.assets, edit: true });
    this.viewport.setView(this.editView, 'edit');
    this.explorer.setWorld(world);
    this.properties.setWorld(world);
    this.project.name = name || 'Place1';
    this.project.dirty = false;
    this.unwatchDirty?.();
    this.unwatchDirty = world.observe({ propChanged: () => this.markDirty(), added: () => this.markDirty(), removed: () => this.markDirty() });
    this.commandBar.setTarget('Edit');
    this.renderTabs();
    this.resetCamera();
    if (this.pluginHost) this.pluginHost.onPlaceChanged(world);
    this.updateRibbonState();
  }
  markDirty() { if (!this.project.dirty) { this.project.dirty = true; this.updateRibbonState(); } }

  resetCamera() {
    const cam = this.dm().findFirstChildOfClass('Workspace')?.props.CurrentCamera;
    if (cam && cam.props.CFrame) {
      const cf = cam.props.CFrame;
      this.viewport.camera.position.set(cf.X, cf.Y, cf.Z);
      const look = cf.LookVector;
      this.viewport.yaw = Math.atan2(-look.X, -look.Z);
      this.viewport.pitch = Math.asin(Math.max(-1, Math.min(1, look.Y)));
    } else { this.viewport.camera.position.set(0, 20, 34); this.viewport.yaw = 0; this.viewport.pitch = -0.45; }
    this.viewport.applyCameraAngles();
  }

  // ================================================================ main loop
  loop() {
    let last = performance.now();
    const frame = (t) => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      if (this.paused) return;
      try {
        if (this.session) this.session.tick(dt);
        else this.editWorld.scheduler.step(dt);
        this.viewport.update(dt);
        if (this.activeTab === null || this.activeTab.kind === 'viewport') this.viewport.render();
        if (this.pluginHost) this.pluginHost.tick(dt);
      } catch (e) { console.error(e); }
    };
    requestAnimationFrame(frame);
  }

  // ================================================================ center tabs (viewport + scripts)
  renderTabs() {
    const place = { kind: 'viewport', title: this.session ? `${this.project.name} (${this.session.mode === 'run' ? 'Run' : 'Play'})` : this.project.name };
    const all = [place, ...this.tabs];
    this.centerTabs.replaceChildren(...all.map((t) => h('div', {
      class: `ctab${(t.kind === 'viewport' ? this.activeTab === null || this.activeTab.kind === 'viewport' : this.activeTab === t) ? ' active' : ''}`,
      onclick: () => this.activateTab(t.kind === 'viewport' ? null : t),
      onauxclick: (e) => { if (e.button === 1 && t.kind !== 'viewport') this.closeTab(t); },
    }, t.kind === 'viewport' ? icon('globe') : classIcon(t.inst.ClassName), h('span', { text: t.kind === 'viewport' ? place.title : t.inst.props.Name }),
      t.kind !== 'viewport' ? h('button', { class: 'tab-x', title: 'Close', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, '×') : null)));
  }
  activateTab(t) {
    this.activeTab = t;
    const showEditor = t && t.kind === 'script';
    this.centerView.classList.toggle('hidden', !!showEditor);
    this.centerEditor.classList.toggle('hidden', !showEditor);
    if (showEditor) { this.centerEditor.replaceChildren(t.editor.el); t.editor.render(); setTimeout(() => t.editor.focus(), 0); }
    else this.viewport.resize();
    this.renderTabs();
  }
  openScript(inst, line) {
    let t = this.tabs.find((x) => x.inst === inst);
    if (!t) {
      const editor = new CodeEditor({
        value: inst.get('Source') || '',
        fontSize: this.settings.get('editorFontSize'),
        onChange: (v) => { inst.rawSet('Source', v); },
        onSave: () => this.saveToBrowser(),
      });
      t = { kind: 'script', inst, editor };
      this.tabs.push(t);
    }
    this.activateTab(t);
    if (line) setTimeout(() => t.editor.gotoLine(line), 30);
  }
  closeTab(t) {
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.activeTab === t) this.activateTab(this.tabs[this.tabs.length - 1] || null);
    else this.renderTabs();
  }
  closeScriptTabs() { this.tabs = []; this.activateTab(null); }
  openInstance(inst) {
    if (/Script$/.test(inst.ClassName) && inst.world === this.editWorld) this.openScript(inst);
    else { this.selection.set([inst]); this.viewport.focusSelection(); }
  }
  openScriptByName(fullName, line) {
    const parts = fullName.split('.');
    let cur = this.dm();
    for (const p of parts) { cur = cur && (cur.findFirstChild(p) || cur.children.find((c) => c.ClassName === p)); }
    if (cur && /Script$/.test(cur.ClassName)) this.openScript(cur, line);
    else toast(`Could not find script ${fullName} in the edit place`, 'warn');
  }

  // ================================================================ keyboard
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (k === 'F5' && e.shiftKey) { e.preventDefault(); this.stopPlay(); return; }
      if (k === 'F5') { e.preventDefault(); if (!this.session) this.play('play'); return; }
      if (k === 'F8') { e.preventDefault(); if (!this.session) this.play('run'); return; }
      if (this.session && this.session.capturesKeys && (e.target === this.viewport.canvas || e.target === document.body)) return;
      if (this.session) return;
      if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); const n = this.history.undo(); if (n) toast(`Undo ${n}`); }
      else if (ctrl && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) { e.preventDefault(); const n = this.history.redo(); if (n) toast(`Redo ${n}`); }
      else if (ctrl && k.toLowerCase() === 'c') { e.preventDefault(); this.copy(); }
      else if (ctrl && k.toLowerCase() === 'x') { e.preventDefault(); this.cut(); }
      else if (ctrl && k.toLowerCase() === 'v') { e.preventDefault(); this.paste(e.shiftKey ? this.selection.first() : undefined); }
      else if (ctrl && k.toLowerCase() === 'd') { e.preventDefault(); this.duplicate(); }
      else if (ctrl && k.toLowerCase() === 'g') { e.preventDefault(); this.group(); }
      else if (ctrl && k.toLowerCase() === 'u') { e.preventDefault(); this.ungroup(); }
      else if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); this.saveToBrowser(); }
      else if (ctrl && k.toLowerCase() === 'o') { e.preventDefault(); this.openFile(); }
      else if (ctrl && k.toLowerCase() === 'i') { e.preventDefault(); this.insertObjectDialog(); }
      else if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); this.selection.set(this.dm().findFirstChildOfClass('Workspace').children.filter((c) => !c.props.Locked && c.ClassName !== 'Camera' && c.ClassName !== 'Terrain')); }
      else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
      else if (ctrl && ['1', '2', '3', '4'].includes(k)) { e.preventDefault(); this.setTool(['select', 'move', 'scale', 'rotate'][Number(k) - 1]); }
      else if (k === 'F2' && this.selection.first()) { e.preventDefault(); this.explorer.startRename(this.selection.first()); }
      else if (ctrl && k.toLowerCase() === 'l') { e.preventDefault(); this.settings.set('localSpace', !this.settings.get('localSpace')); this.viewport.refreshSelection(); toast(`Transform: ${this.settings.get('localSpace') ? 'local' : 'world'} space`); }
      else if (ctrl && k.toLowerCase() === 'r') { e.preventDefault(); this.rotateSelection(0, 90, 0); }
      else if (ctrl && k.toLowerCase() === 't') { e.preventDefault(); this.rotateSelection(0, 0, 90); }
    });
  }
  setTool(t) { this.viewport.setTool(t); this.updateRibbonState(); }

  // ================================================================ geometry helpers
  partsOf(list) {
    const out = [];
    for (const i of list) { if (i.isA('BasePart')) out.push(i); for (const d of i.descendants()) if (d.isA('BasePart')) out.push(d); }
    return [...new Set(out)];
  }
  boundsOf(list) {
    const parts = this.partsOf(list);
    if (!parts.length) return null;
    let min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of parts) {
      const cf = p.props.CFrame, s = p.props.Size;
      const r = cf.r;
      const ex = Math.abs(r[0]) * s.X / 2 + Math.abs(r[1]) * s.Y / 2 + Math.abs(r[2]) * s.Z / 2;
      const ey = Math.abs(r[3]) * s.X / 2 + Math.abs(r[4]) * s.Y / 2 + Math.abs(r[5]) * s.Z / 2;
      const ez = Math.abs(r[6]) * s.X / 2 + Math.abs(r[7]) * s.Y / 2 + Math.abs(r[8]) * s.Z / 2;
      min = min.min(new Vector3(cf.X - ex, cf.Y - ey, cf.Z - ez));
      max = max.max(new Vector3(cf.X + ex, cf.Y + ey, cf.Z + ez));
    }
    return { center: min.add(max).mul(0.5), size: max.sub(min), min, max };
  }
  pivotOf(list) {
    if (list.length === 1) {
      const i = list[0];
      if (i.isA('BasePart')) return i.props.CFrame.mul(i.props.PivotOffset || CFrame.identity);
      if (i.isA('Model')) return i.get('WorldPivot') || this.bboxCF(list);
      if (i.ClassName === 'Attachment') return i.get('WorldCFrame') || CFrame.identity;
    }
    return this.bboxCF(list);
  }
  bboxCF(list) { const b = this.boundsOf(list); return b ? new CFrame(b.center.X, b.center.Y, b.center.Z) : CFrame.identity; }

  translateSelection(delta) {
    for (const p of this.partsOf(this.selection.list())) p.set('CFrame', p.props.CFrame.add(delta));
    for (const m of this.selection.list()) if (m.isA('Model') && m.props.WorldPivotData) m.rawSet('WorldPivotData', m.props.WorldPivotData.add(delta));
  }
  /** delta: world-space CFrame applied around the original pivot (base = [[inst, {cf}|{pivot}]]) */
  transformSelection(base, delta) {
    for (const [inst, st] of base) {
      if (inst.isA('BasePart')) inst.set('CFrame', delta.mul(st.cf));
      else {
        for (const p of this.partsOf([inst])) {
          const orig = this.gizmoOrigCF(p);
          p.set('CFrame', delta.mul(orig));
        }
        if (inst.isA('Model') && st.pivot) inst.rawSet('WorldPivotData', delta.mul(st.pivot));
      }
    }
  }
  gizmoOrigCF(p) {
    if (!this._origCF || this._origStamp !== this.viewport.gizmoStart) { this._origCF = new Map(); this._origStamp = this.viewport.gizmoStart; }
    if (!this._origCF.has(p)) this._origCF.set(p, p.props.CFrame);
    return this._origCF.get(p);
  }
  scaleSelection(base, s) {
    for (const [inst, st] of base) {
      if (!inst.isA('BasePart') || !st.size) continue;
      const snap = this.settings.get('moveSnap');
      const q = (v) => (snap > 0 ? Math.max(snap, Math.round(v / snap) * snap) : Math.max(0.05, v));
      const ns = new Vector3(q(st.size.X * s.x), q(st.size.Y * s.y), q(st.size.Z * s.z));
      inst.set('Size', ns);
    }
  }
  rotateSelection(x, y, z) {
    const sel = this.selection.list();
    if (!sel.length) return;
    this.history.run('Rotate', () => {
      const pivot = this.pivotOf(sel);
      const rot = pivot.mul(CFrame.angles(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180)).mul(pivot.inverse());
      for (const p of this.partsOf(sel)) p.set('CFrame', rot.mul(p.props.CFrame));
    });
    this.viewport.refreshSelection();
  }

  // ================================================================ editing operations
  insertTarget(parent, className) {
    if (parent) return parent;
    const first = this.selection.first();
    if (first && first.dm === this.dm() && first.ClassName !== 'DataModel') {
      if (/Script$|^(Folder|Model|Configuration)$/.test(first.ClassName) || !isA(className, 'BasePart')) return first.isA('LuaSourceContainer') ? first.parent : first;
    }
    if (isA(className, 'GuiBase2d') && className !== 'ScreenGui' && className !== 'BillboardGui' && className !== 'SurfaceGui') return this.dm().findFirstChildOfClass('StarterGui');
    return this.dm().findFirstChildOfClass('Workspace');
  }
  spawnPoint(size = new Vector3(4, 1, 2)) {
    const vp = this.viewport;
    const r = vp.canvas.getBoundingClientRect();
    const p = vp.groundPoint(r.left + r.width / 2, r.top + r.height / 2);
    const snap = this.settings.get('moveSnap') || 1;
    const dist = p.distanceTo(vp.camera.position);
    if (dist > 120) { const d = vp.rayDir(r.left + r.width / 2, r.top + r.height / 2); p.copy(vp.camera.position).addScaledVector(d, 30); }
    return new Vector3(Math.round(p.x / snap) * snap, p.y + size.Y / 2, Math.round(p.z / snap) * snap);
  }
  insertPart(shape = 'Block', parent) {
    const w = this.editWorld;
    let cls = 'Part';
    if (shape === 'Wedge') cls = 'WedgePart';
    else if (shape === 'CornerWedge') cls = 'CornerWedgePart';
    else if (shape === 'Truss') cls = 'TrussPart';
    else if (shape === 'Spawn') cls = 'SpawnLocation';
    else if (shape === 'Seat') cls = 'Seat';
    const p = new Instance(cls, w);
    let size = new Vector3(4, 1, 2);
    if (shape === 'Sphere') size = new Vector3(2, 2, 2);
    if (shape === 'Cylinder') size = new Vector3(2, 2, 2);
    if (shape === 'Truss') size = new Vector3(2, 10, 2);
    if (shape === 'Spawn') size = new Vector3(12, 1, 12);
    if (shape === 'Seat') size = new Vector3(2, 1, 2);
    if (shape === 'Wedge' || shape === 'CornerWedge') size = new Vector3(4, 1, 2);
    const pos = this.spawnPoint(size);
    Object.assign(p.props, {
      Size: size, CFrame: new CFrame(pos.X, pos.Y, pos.Z), Color: Color3.fromRGB(163, 162, 165),
      TopSurface: E('SurfaceType', 'Smooth'), BottomSurface: E('SurfaceType', 'Smooth'),
    });
    if (PART_SHAPES[shape] && cls === 'Part') p.props.Shape = E('PartType', PART_SHAPES[shape]);
    if (shape === 'Spawn') { p.props.Anchored = true; }
    this.history.run(`Insert ${shape}`, () => p.setParent(parent || this.dm().findFirstChildOfClass('Workspace')));
    this.selection.set([p]);
    return p;
  }
  insertObject(className, parent) {
    const w = this.editWorld;
    if (!isCreatable(className)) { toast(`${className} cannot be created`, 'error'); return null; }
    if (isA(className, 'BasePart')) return this.insertPart(className === 'Part' ? 'Block' : className.replace('Part', ''), parent);
    const inst = new Instance(className, w);
    if (className === 'Script') inst.props.Source = 'print("Hello world!")\n';
    if (className === 'LocalScript') inst.props.Source = 'print("Hello world!")\n';
    if (className === 'ModuleScript') inst.props.Source = 'local module = {}\n\nreturn module\n';
    if (className === 'Model') inst.props.Name = 'Model';
    const target = this.insertTarget(parent, className);
    try { this.history.run(`Insert ${className}`, () => inst.setParent(target)); } catch (e) { toast(e.message, 'error'); return null; }
    this.selection.set([inst]);
    if (/Script$/.test(className)) this.openScript(inst);
    return inst;
  }
  insertObjectDialog(parent) {
    const names = allClassNames().filter(isCreatable).sort();
    const list = h('div', { class: 'class-list' });
    const input = h('input', { class: 'input', placeholder: 'Search objects…' });
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const items = names.filter((n) => n.toLowerCase().includes(q)).slice(0, 300);
      list.replaceChildren(...items.map((n) => h('div', { class: 'class-item', onclick: () => { d.close(); this.insertObject(n, parent); } }, classIcon(n), h('span', { text: n }))));
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = list.querySelector('.class-item'); if (first) first.click(); } });
    const d = dialog({ title: 'Insert Object', body: h('div', { class: 'insert-dialog' }, input, list), buttons: [] });
    render();
  }
  partMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom, ['Block', 'Sphere', 'Wedge', 'CornerWedge', 'Cylinder', 'Truss', 'Spawn', 'Seat'].map((s) => ({ label: s, onClick: () => this.insertPart(s) })));
  }
  colorMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const colors = ['White', 'Institutional white', 'Medium stone grey', 'Dark stone grey', 'Black', 'Really red', 'Bright red', 'Bright orange', 'Bright yellow', 'New Yeller', 'Lime green', 'Bright green', 'Dark green', 'Cyan', 'Bright blue', 'Really blue', 'Navy blue', 'Bright violet', 'Magenta', 'Pink', 'Reddish brown', 'Brown', 'Nougat', 'Pastel brown', 'Sand red', 'Toothpaste', 'Teal', 'Olive'];
    const grid = h('div', { class: 'swatches' }, colors.map((n) => { const bc = BrickColor.fromName(n); return h('button', { class: 'swatch', title: n, style: { background: bc.Color.toCss() }, onclick: () => { this.applyToParts('Color', bc.Color); menu.remove(); } }); }),
      h('label', { class: 'swatch custom', title: 'Custom color' }, h('input', { type: 'color', oninput: (ev) => this.applyToParts('Color', Color3.fromHex(ev.target.value)) }), '+'));
    const menu = h('div', { class: 'ctx-menu pop' }, grid);
    document.body.append(menu);
    menu.style.left = `${r.left}px`; menu.style.top = `${r.bottom}px`;
    setTimeout(() => document.addEventListener('mousedown', (ev) => { if (!menu.contains(ev.target)) menu.remove(); }, { once: true }), 0);
  }
  materialMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const mats = ['Plastic', 'SmoothPlastic', 'Neon', 'Wood', 'WoodPlanks', 'Marble', 'Slate', 'Concrete', 'Granite', 'Brick', 'Pebble', 'Cobblestone', 'Rock', 'Sandstone', 'CorrodedMetal', 'DiamondPlate', 'Foil', 'Metal', 'Grass', 'LeafyGrass', 'Sand', 'Fabric', 'Snow', 'Ice', 'Glass', 'ForceField'];
    contextMenu(r.left, r.bottom, mats.map((m) => ({ label: m, onClick: () => this.applyToParts('Material', E('Material', m)) })));
  }
  applyToParts(prop, value) {
    const parts = this.partsOf(this.selection.list());
    if (!parts.length) { toast('Select parts first', 'warn'); return; }
    this.history.run(`Set ${prop}`, () => { for (const p of parts) p.set(prop, value); });
  }
  toggleAnchor() {
    const parts = this.partsOf(this.selection.list());
    if (!parts.length) return;
    const v = !parts.every((p) => p.props.Anchored);
    this.history.run('Anchor', () => parts.forEach((p) => p.set('Anchored', v)));
    toast(v ? 'Anchored' : 'Unanchored');
  }
  toggleLock() {
    const parts = this.partsOf(this.selection.list());
    if (!parts.length) return;
    const v = !parts.every((p) => p.props.Locked);
    this.history.run('Lock', () => parts.forEach((p) => p.set('Locked', v)));
    toast(v ? 'Locked' : 'Unlocked');
  }
  weldSelection() {
    const parts = this.partsOf(this.selection.list());
    if (parts.length < 2) { toast('Select two or more parts to weld', 'warn'); return; }
    this.history.run('Weld', () => {
      const root = parts[0];
      for (const p of parts.slice(1)) {
        const w = new Instance('WeldConstraint', this.editWorld);
        w.props.Part0 = root; w.props.Part1 = p; w.props.Name = 'WeldConstraint';
        w.setParent(root);
      }
    });
    toast(`Welded ${parts.length - 1} part(s) to ${parts[0].props.Name}`);
  }
  setProperty(insts, name, value) {
    this.history.run(`Set ${name}`, () => {
      for (const i of insts) {
        try { i.set(name, value); } catch (e) { toast(e.message, 'error'); }
      }
    });
  }
  deleteSelection() {
    const sel = this.selection.list().filter((i) => !i.isService && i.ClassName !== 'DataModel' && i.ClassName !== 'Terrain' && !(i.ClassName === 'Camera' && i.parent?.ClassName === 'Workspace'));
    if (!sel.length) return;
    this.history.run('Delete', () => { for (const i of sel) i.setParent(null); });
    for (const t of this.tabs.filter((t) => sel.some((s) => t.inst === s || t.inst.isDescendantOf(s)))) this.closeTab(t);
    this.selection.clear();
  }
  copy() {
    const sel = this.selection.list().filter((i) => !i.isService && i.ClassName !== 'DataModel');
    if (!sel.length) return;
    this.clipboard = sel.map((i) => i.clone(true));
    this.clipboardParent = sel[0].parent;
    try { navigator.clipboard?.writeText(sel.map((s) => s.getFullName()).join('\n')); } catch { /* ignore */ }
    toast(`Copied ${sel.length} object(s)`);
  }
  cut() { this.copy(); this.deleteSelection(); }
  paste(into) {
    if (!this.clipboard) return;
    const target = into || (this.clipboardParent && this.clipboardParent.dm ? this.clipboardParent : this.dm().findFirstChildOfClass('Workspace'));
    const items = this.clipboard.map((c) => c.clone(true, null, this.editWorld));
    this.history.run('Paste', () => { for (const c of items) c.setParent(target); });
    this.selection.set(items);
  }
  duplicate() {
    const sel = this.selection.list().filter((i) => !i.isService && i.ClassName !== 'DataModel');
    if (!sel.length) return;
    const copies = [];
    this.history.run('Duplicate', () => { for (const i of sel) { const c = i.clone(true, null, this.editWorld); c.setParent(i.parent); copies.push(c); } });
    this.selection.set(copies);
  }
  group() {
    const sel = this.selection.list().filter((i) => !i.isService && i.parent);
    if (!sel.length) return;
    const parent = sel[0].parent;
    const m = new Instance('Model', this.editWorld);
    m.props.Name = 'Model';
    this.history.run('Group', () => { m.setParent(parent); for (const i of sel) i.setParent(m); });
    this.selection.set([m]);
  }
  ungroup() {
    const sel = this.selection.list().filter((i) => i.ClassName === 'Model' || i.ClassName === 'Folder');
    if (!sel.length) return;
    const kids = [];
    this.history.run('Ungroup', () => { for (const m of sel) { for (const c of m.children.slice()) { c.setParent(m.parent); kids.push(c); } m.setParent(null); } });
    this.selection.set(kids);
  }
  reparent(list, target) {
    const ok = list.filter((i) => i !== target && !target.isDescendantOf(i) && !i.isService && i.ClassName !== 'DataModel');
    if (!ok.length) return;
    try { this.history.run('Reparent', () => { for (const i of ok) i.setParent(target); }); } catch (e) { toast(e.message, 'error'); }
    this.explorer.expanded.add(target);
    this.explorer.render();
  }
  pickInstance(cb) { this.pickCallback = cb; toast('Select an object in the Explorer or viewport'); }

  runCommand(src) {
    const target = this.session ? (this.commandTarget === 'client' ? this.session.clientWorld : this.session.serverWorld) || this.session.serverWorld : this.editWorld;
    this.output.add({ msg: `> ${src}`, kind: 'info', time: Date.now(), world: target.kind, worldName: target.name });
    if (!this.session) this.history.run('Command', () => target.exec(src, 'CommandBar'));
    else target.exec(src, 'CommandBar');
  }

  // ================================================================ files
  fileMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: 'New Baseplate', onClick: () => this.newPlace('baseplate') },
      { label: 'New Empty Place', onClick: () => this.newPlace('empty') },
      { label: 'Open File…', shortcut: 'Ctrl+O', onClick: () => this.openFile() },
      { label: 'Open from Roblox asset ID…', onClick: () => this.openPlaceAssetDialog() },
      { label: 'Recent Projects…', onClick: () => this.projectsDialog() },
      { sep: true },
      { label: 'Save', shortcut: 'Ctrl+S', onClick: () => this.saveToBrowser() },
      { label: 'Download as .rbxl', onClick: () => this.downloadPlace('rbxl') },
      { label: 'Download as .rbxlx', onClick: () => this.downloadPlace('rbxlx') },
      { label: 'Export Selection (.rbxm)…', onClick: () => this.exportSelection() },
      { label: 'Insert Model File…', onClick: () => this.insertFromFile() },
      { sep: true },
      { label: 'Rename Place…', onClick: async () => { const n = await prompt('Rename', 'Place name', this.project.name); if (n) { this.project.name = n; this.markDirty(); this.renderTabs(); this.updateRibbonState(); } } },
      { label: 'Studio Settings…', onClick: () => this.openSettings() },
    ]);
  }
  async newPlace(kind) {
    if (this.project.dirty && !(await confirmBox('New place', 'Discard unsaved changes to the current place?', 'Discard'))) return;
    const w = this.makeEditWorld();
    this.project.id = null;
    this.setPlace(kind === 'empty' ? newEmptyPlace(w) : newBaseplate(w), 'Place1');
  }
  async openFile() {
    const f = await pickFile('.rbxl,.rbxlx,.rbxm,.rbxmx,.lua,.luau');
    if (f) await this.openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  }
  async openBytes(bytes, name) {
    const lower = name.toLowerCase();
    try {
      if (/\.(lua|luau|txt)$/.test(lower)) {
        const s = this.insertObject('Script');
        if (s) { s.set('Source', utf8.dec.decode(bytes)); s.set('Name', name.replace(/\.\w+$/, '')); this.openScript(s); }
        return;
      }
      const doc = parseFile(bytes);
      const isPlace = /\.rbxlx?$/.test(lower) || doc.roots.some((r) => r.isService || r.className === 'Workspace');
      if (isPlace) {
        if (this.project.dirty && !(await confirmBox('Open place', 'Discard unsaved changes to the current place?', 'Discard'))) return;
        const w = this.makeEditWorld();
        const { dm, warnings } = loadPlace(bytes, w);
        this.project.id = null;
        this.setPlace(dm, name.replace(/\.\w+$/, ''));
        toast(`Opened ${name}`);
        if (warnings.length) this.output.add({ msg: `Loaded with ${warnings.length} warning(s): ${warnings.slice(0, 5).join('; ')}`, kind: 'warn', time: Date.now() });
      } else this.insertModelBytes(bytes, null, name);
    } catch (e) { console.error(e); toast(`Could not open ${name}: ${e.message}`, 'error', 6000); }
  }
  insertModelBytes(bytes, parent, name = 'model') {
    const { instances, warnings } = loadModel(bytes, this.editWorld);
    const target = parent || this.dm().findFirstChildOfClass('Workspace');
    this.history.run('Insert Model', () => { for (const i of instances) i.setParent(target); });
    this.selection.set(instances);
    if (warnings.length) this.output.add({ msg: `${name}: ${warnings.join('; ')}`, kind: 'warn', time: Date.now() });
    toast(`Inserted ${instances.length} object(s)`);
    return instances;
  }
  async insertFromFile(parent) {
    const files = await pickFile('.rbxm,.rbxmx,.rbxl,.rbxlx', true);
    for (const f of files || []) this.insertModelBytes(new Uint8Array(await f.arrayBuffer()), parent, f.name);
  }
  exportSelection() {
    const sel = this.selection.list();
    if (!sel.length) { toast('Select objects to export', 'warn'); return; }
    download(`${sel[0].props.Name}.rbxm`, serialize(sel, 'rbxm'));
  }
  downloadPlace(fmt) { download(`${this.project.name}.${fmt}`, serializePlace(this.dm(), fmt)); this.project.dirty = false; this.updateRibbonState(); }
  async saveToBrowser(silent = false) {
    if (this.session) { if (!silent) toast('Stop the game before saving', 'warn'); return; }
    const bytes = serializePlace(this.dm(), 'rbxl');
    if (!this.project.id) this.project.id = `p${Date.now().toString(36)}`;
    await idb.set('projects', this.project.id, { name: this.project.name, bytes, savedAt: Date.now() });
    this.project.dirty = false;
    this.updateRibbonState();
    if (!silent) toast(`Saved "${this.project.name}" in this browser`);
    if (this.nene) this.nene.projectSaved(this.project);
  }
  async projectsDialog() {
    const keys = await idb.keys('projects');
    const rows = [];
    for (const k of keys) { const p = await idb.get('projects', k); if (p) rows.push([k, p]); }
    rows.sort((a, b) => b[1].savedAt - a[1].savedAt);
    const list = h('div', { class: 'proj-list' }, rows.length ? rows.map(([k, p]) => h('div', { class: 'proj-row' },
      icon('globe'), h('div', { class: 'grow' }, h('b', { text: p.name }), h('div', { class: 'muted small', text: `${new Date(p.savedAt).toLocaleString()} · ${(p.bytes.length / 1024).toFixed(0)} KB` })),
      h('button', { class: 'btn small', onclick: () => { d.close(); this.openProject(k); } }, 'Open'),
      h('button', { class: 'btn small', onclick: () => download(`${p.name}.rbxl`, p.bytes) }, 'Download'),
      h('button', { class: 'icon-btn small', title: 'Delete', onclick: async () => { if (await confirmBox('Delete project', `Delete "${p.name}" from this browser?`, 'Delete')) { await idb.del('projects', k); d.close(); this.projectsDialog(); } } }, icon('trash')))) : h('p', { class: 'muted', text: 'No saved projects yet. Press Ctrl+S to save the current place in this browser.' }));
    const d = dialog({ title: 'Projects', body: list, wide: true });
  }
  async openProject(id) {
    const p = await idb.get('projects', id);
    if (!p) return;
    const w = this.makeEditWorld();
    const { dm } = loadPlace(p.bytes, w);
    this.setPlace(dm, p.name);
    this.project.id = id;
  }
  async openPlaceAssetDialog() {
    const id = await prompt('Open from Roblox', 'Place or model asset ID', '', { placeholder: 'e.g. 1818' });
    if (!id) return;
    try {
      const r = await this.assets.model(id.trim());
      await this.openBytes(r.bytes, `${id}.${r.type === 'model/rbxmx' ? 'rbxlx' : 'rbxl'}`);
    } catch (e) { toast(e.message, 'error', 7000); }
  }
  async insertAssetDialog(parent) {
    const id = await prompt('Insert from Roblox', 'Model asset ID (uses External Load)', '', { placeholder: 'rbxassetid://… or number' });
    if (!id) return;
    try {
      const r = await this.assets.model(id.trim());
      this.insertModelBytes(r.bytes, parent, `asset ${id}`);
    } catch (e) { toast(e.message, 'error', 7000); }
  }
  onViewportDrop(e, point) {
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) f.arrayBuffer().then((b) => this.openBytes(new Uint8Array(b), f.name));
    const item = e.dataTransfer?.getData('application/x-bloxlab-toolbox');
    if (item && this.toolbox) this.toolbox.dropAt(item, point);
  }

  // ================================================================ play
  async play(mode) {
    if (this.session) return;
    const { PlaySession } = await import('../game/session.js');
    const spawnAt = mode === 'here' ? this.viewport.cameraCFrame() : null;
    this.closeEditorFocus();
    this.session = new PlaySession(this, { mode: mode === 'run' ? 'run' : 'play', spawnAt });
    try { await this.session.start(); }
    catch (e) { console.error(e); toast(`Could not start: ${e.message}`, 'error'); this.session.stop(); this.session = null; return; }
    this.afterSessionStart();
  }
  afterSessionStart() {
    const s = this.session;
    this.commandBar.setTarget(s.clientWorld && this.commandTarget === 'client' ? 'Client' : 'Server');
    this.showWorldInPanels(s.clientWorld && this.viewClient !== false ? s.clientWorld : s.serverWorld);
    this.activateTab(null);
    this.renderTabs();
    this.updateRibbonState();
    this.root.classList.add('playing');
  }
  showWorldInPanels(world) {
    this.explorer.setWorld(world);
    this.properties.setWorld(world);
    this.selection.clear();
  }
  toggleClientServer() {
    if (!this.session) { toast('Start playing to switch between client and server views'); return; }
    const s = this.session;
    if (!s.clientWorld) { toast('Run mode has no client'); return; }
    this.viewClient = !(this.viewClient !== false);
    this.commandTarget = this.viewClient ? 'client' : 'server';
    this.commandBar.setTarget(this.viewClient ? 'Client' : 'Server');
    this.showWorldInPanels(this.viewClient ? s.clientWorld : s.serverWorld);
    s.setViewWorld(this.viewClient ? 'client' : 'server');
    toast(`Viewing the ${this.viewClient ? 'client' : 'server'}`);
  }
  stopPlay() {
    if (!this.session) return;
    this.session.stop();
    this.session = null;
    this.root.classList.remove('playing');
    this.viewport.setView(this.editView, 'edit');
    this.explorer.setWorld(this.editWorld);
    this.properties.setWorld(this.editWorld);
    this.selection.clear();
    this.commandBar.setTarget('Edit');
    this.renderTabs();
    this.updateRibbonState();
    if (document.pointerLockElement) document.exitPointerLock();
  }
  closeEditorFocus() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }

  // multiplayer dialogs live in net/ui.js (loaded on demand)
  async hostDialog() { (await import('../net/ui.js')).hostDialog(this); }
  async joinDialog() { (await import('../net/ui.js')).joinDialog(this); }
  async localTestDialog() { (await import('../net/ui.js')).localTestDialog(this); }

  // ================================================================ settings / plugins / assets
  async openSettings(tab) { (await import('./settings-ui.js')).openSettings(this, tab); }
  async openAssetManager() { (await import('./settings-ui.js')).openAssetManager(this); }
  async pluginsDialog() { await this.ensurePlugins(); this.pluginHost.manageDialog(); }
  async installPluginDialog() { await this.ensurePlugins(); this.pluginHost.installDialog(); }
  async ensurePlugins() {
    if (!this.pluginHost) { const { PluginHost } = await import('../plugins/host.js'); this.pluginHost = new PluginHost(this); await this.pluginHost.loadInstalled(); }
    return this.pluginHost;
  }
}

export { $, getEnum, rawToInstances };
