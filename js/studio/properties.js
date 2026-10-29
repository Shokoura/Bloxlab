// Properties panel: typed editors for the selected instances, attributes and tags.
import { h, debounce, toast } from './ui.js';
import { icon } from './icons.js';
import { classInfo, editableProps, propCategory, F } from '../engine/reflect.js';
import { mergedBehavior } from '../engine/instance.js';
import {
  Vector3, Vector2, CFrame, Color3, BrickColor, UDim, UDim2, Rect, NumberRange, NumberSequence, NumberSequenceKeypoint,
  ColorSequence, ColorSequenceKeypoint, PhysicalProperties, Faces, Axes, Font,
} from '../engine/datatypes.js';
import { getEnum, EnumItem } from '../engine/enums.js';
import { materialPhysics } from '../engine/bridge.js';

const CAT_ORDER = ['Data', 'Appearance', 'Text', 'Image', 'Transform', 'Pivot', 'Behavior', 'Collision', 'Part', 'Shape', 'Assembly', 'Character', 'Physics', 'Controls', 'Camera', 'Game', 'Jump Settings', 'Image', 'Scrolling', 'Localization', 'Input', 'Surface', 'Surface Inputs', 'Attachments', 'Limits', 'Emission', 'Motion', 'Particles', 'Playback', 'Regions', 'Sound', 'State', 'Derived Data'];
const SKIP = new Set(['Source', 'ClassName', 'Parent', 'Archivable', 'archivable', 'className', 'RobloxLocked', 'AttributesSerialize', 'Tags', 'Capabilities', 'Sandboxed', 'DefinesCapabilities', 'UniqueId', 'HistoryId', 'SourceAssetId', 'LinkedSource', 'ScriptGuid']);
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(4)));
const PANEL_EXTRA = { BasePart: ['Position', 'Orientation'], Attachment: ['Position', 'Orientation', 'WorldPosition'], Model: ['WorldPivot'] };

export class Properties {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.collapsed = new Set(['Surface', 'Surface Inputs', 'Derived Data', 'Derived World Data']);
    this.filterInput = h('input', { class: 'input search', placeholder: 'Filter properties', oninput: debounce(() => this.render(), 120) });
    this.body = h('div', { class: 'props' });
    el.append(h('div', { class: 'panel-tools' }, this.filterInput), this.body);
    this.refresh = debounce(() => this.updateValues(), 60);
    app.selection.onChange(() => this.render());
    this.fields = [];
  }
  setWorld(world) {
    if (this.unobserve) this.unobserve();
    this.world = world;
    this.unobserve = world.observe({
      propChanged: (inst) => { if (this.targets && this.targets.includes(inst)) this.refresh(); },
      attrChanged: (inst) => { if (this.targets && this.targets.includes(inst)) this.render(); },
    });
    this.render();
  }

  propsFor(inst) {
    const info = classInfo(inst.ClassName);
    const list = editableProps(inst.ClassName).filter((p) => !SKIP.has(p.name));
    const beh = mergedBehavior(inst.ClassName);
    for (const [base, extra] of Object.entries(PANEL_EXTRA)) {
      if (!inst.isA(base)) continue;
      for (const n of extra) if (!list.some((p) => p.name === n) && (beh.props[n] || info.props[n])) list.push({ name: n, type: (info.props[n] && info.props[n].type) || 'Vector3', flags: 0 });
    }
    if (inst.isA('BasePart')) {
      const i = list.findIndex((p) => p.name === 'CFrame'); if (i >= 0) list.splice(i, 1);
    }
    return list;
  }

  render() {
    const sel = this.app.selection.list();
    this.targets = sel;
    this.fields = [];
    const filter = this.filterInput.value.trim().toLowerCase();
    if (!sel.length) { this.body.replaceChildren(h('div', { class: 'empty', text: 'Select an object to see its properties.' })); return; }
    const first = sel[0];
    let props = this.propsFor(first);
    if (sel.length > 1) {
      const sets = sel.slice(1).map((i) => new Set(this.propsFor(i).map((p) => p.name)));
      props = props.filter((p) => sets.every((s) => s.has(p.name)));
    }
    if (filter) props = props.filter((p) => p.name.toLowerCase().includes(filter));
    const groups = new Map();
    for (const p of props) {
      const cat = propCategory(first.ClassName, p.name) || 'Data';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(p);
    }
    const cats = [...groups.keys()].sort((a, b) => (CAT_ORDER.indexOf(a) < 0 ? 99 : CAT_ORDER.indexOf(a)) - (CAT_ORDER.indexOf(b) < 0 ? 99 : CAT_ORDER.indexOf(b)));
    const frag = document.createDocumentFragment();
    frag.append(h('div', { class: 'props-title' }, h('b', { text: sel.length > 1 ? `${sel.length} objects` : first.props.Name }), h('span', { class: 'muted', text: ` ${sel.length > 1 ? '' : first.ClassName}` })));
    for (const cat of cats) {
      const open = !this.collapsed.has(cat);
      const head = h('div', { class: `prop-cat${open ? ' open' : ''}`, onclick: () => { if (open) this.collapsed.add(cat); else this.collapsed.delete(cat); this.render(); } }, icon('chevron'), h('span', { text: cat }));
      frag.append(head);
      if (!open) continue;
      for (const p of groups.get(cat).sort((a, b) => a.name.localeCompare(b.name))) frag.append(this.row(sel, p));
    }
    // attributes
    if (!filter || 'attributes'.includes(filter)) frag.append(this.attributesSection(first));
    if (!filter || 'tags'.includes(filter)) frag.append(this.tagsSection(first));
    this.body.replaceChildren(frag);
  }

  row(sel, p) {
    const inst = sel[0];
    const readonly = !!(p.flags & F.READONLY) && !mergedBehavior(inst.ClassName).props[p.name]?.set;
    const editor = this.editor(sel, p, readonly);
    const r = h('div', { class: `prop-row${readonly ? ' ro' : ''}`, title: `${p.name} (${p.type})` }, h('label', { text: p.name }), editor.el);
    this.fields.push(editor);
    return r;
  }

  commit(sel, name, value) {
    this.app.setProperty(sel, name, value);
  }

  editor(sel, p, readonly) {
    const inst = sel[0];
    const get = () => inst.get(p.name);
    const t = p.type;
    let el, update;
    const text = (toStr, parse) => {
      const input = h('input', { class: 'pinput', readonly: readonly ? '' : null });
      update = () => { if (document.activeElement !== input) { const v = get(); input.value = v === undefined || v === null ? '' : toStr(v); } };
      const go = () => {
        let v;
        try { v = parse(input.value, get()); } catch (e) { toast(`Invalid value: ${e.message}`, 'error'); update(); return; }
        if (v !== undefined) this.commit(sel, p.name, v);
      };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { go(); input.blur(); } if (e.key === 'Escape') { update(); input.blur(); } });
      input.addEventListener('change', go);
      el = input;
    };
    const nums = (s, n) => { const a = s.split(/[,\s]+/).filter(Boolean).map(Number); if (a.length < n || a.some(Number.isNaN)) throw new Error(`expected ${n} numbers`); return a; };
    if (t.startsWith('Enum:')) {
      const e = getEnum(t.slice(5));
      const s = h('select', { class: 'pinput', disabled: readonly ? '' : null }, (e ? e.items() : []).map((it) => h('option', { value: String(it.Value), text: it.Name })));
      update = () => { const v = get(); s.value = v instanceof EnumItem ? String(v.Value) : String(v ?? ''); };
      s.addEventListener('change', () => { const it = e.fromValue(Number(s.value)); if (it) this.commit(sel, p.name, it); });
      el = s;
    } else switch (t) {
      case 'Bool': {
        const c = h('input', { type: 'checkbox', class: 'pcheck', disabled: readonly ? '' : null });
        update = () => { c.checked = !!get(); };
        c.addEventListener('change', () => this.commit(sel, p.name, c.checked));
        el = h('div', { class: 'pbool' }, c);
        break;
      }
      case 'Int32': case 'Int64': text((v) => String(v), (s) => { const n = Number(s); if (Number.isNaN(n)) throw new Error('not a number'); return Math.trunc(n); }); break;
      case 'Float32': case 'Float64': text((v) => fmt(v), (s) => { const n = Number(s.replace(/,/g, '.')); if (Number.isNaN(n)) throw new Error('not a number'); return n; }); break;
      case 'String': case 'Content': case 'ContentId': text((v) => String(v), (s) => s); break;
      case 'Vector3': text((v) => `${fmt(v.X)}, ${fmt(v.Y)}, ${fmt(v.Z)}`, (s) => new Vector3(...nums(s, 3))); break;
      case 'Vector2': text((v) => `${fmt(v.X)}, ${fmt(v.Y)}`, (s) => new Vector2(...nums(s, 2))); break;
      case 'CFrame': text((v) => `${fmt(v.X)}, ${fmt(v.Y)}, ${fmt(v.Z)}`, (s, old) => { const [x, y, z] = nums(s, 3); return CFrame.fromPosRot(x, y, z, (old || CFrame.identity).r); }); break;
      case 'UDim': text((v) => `${fmt(v.Scale)}, ${v.Offset}`, (s) => new UDim(...nums(s, 2))); break;
      case 'UDim2': text((v) => `{${fmt(v.X.Scale)}, ${v.X.Offset}},{${fmt(v.Y.Scale)}, ${v.Y.Offset}}`, (s) => new UDim2(...nums(s.replace(/[{}]/g, ' '), 4))); break;
      case 'Rect': text((v) => `${fmt(v.Min.X)}, ${fmt(v.Min.Y)}, ${fmt(v.Max.X)}, ${fmt(v.Max.Y)}`, (s) => new Rect(...nums(s, 4))); break;
      case 'NumberRange': text((v) => `${fmt(v.Min)} ${fmt(v.Max)}`, (s) => { const a = nums(s, 1); return new NumberRange(a[0], a[1] ?? a[0]); }); break;
      case 'NumberSequence': text((v) => v.Keypoints.length === 2 && v.Keypoints[0].Value === v.Keypoints[1].Value ? fmt(v.Keypoints[0].Value) : v.Keypoints.map((k) => `${fmt(k.Time)} ${fmt(k.Value)}`).join('; '), (s) => {
        if (!s.includes(';') && s.trim().split(/\s+/).length === 1) return new NumberSequence(Number(s));
        const kps = s.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b, c] = x.split(/[\s,]+/).map(Number); return new NumberSequenceKeypoint(a, b, c || 0); });
        return new NumberSequence(kps);
      }); break;
      case 'ColorSequence': text((v) => v.Keypoints.map((k) => `${fmt(k.Time)} #${k.Value.toHex()}`).join('; '), (s) => {
        const kps = s.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b] = x.split(/\s+/); return new ColorSequenceKeypoint(Number(a), Color3.fromHex(b)); });
        if (kps.length === 1) return new ColorSequence(kps[0].Value);
        return new ColorSequence(kps);
      }); break;
      case 'Color3': case 'Color3uint8': {
        const sw = h('input', { type: 'color', class: 'pswatch', disabled: readonly ? '' : null });
        const input = h('input', { class: 'pinput' });
        update = () => { const v = get(); if (!v) return; sw.value = '#' + v.toHex(); if (document.activeElement !== input) input.value = `${Math.round(v.R * 255)}, ${Math.round(v.G * 255)}, ${Math.round(v.B * 255)}`; };
        sw.addEventListener('input', () => this.commit(sel, p.name, Color3.fromHex(sw.value)));
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
        input.addEventListener('change', () => { try { const [r, g, b] = nums(input.value, 3); this.commit(sel, p.name, Color3.fromRGB(r, g, b)); } catch { update(); } });
        el = h('div', { class: 'pcolor' }, sw, input);
        break;
      }
      case 'BrickColor': {
        const input = h('input', { class: 'pinput', list: 'bloxlab-brickcolors' });
        ensureBrickList();
        update = () => { if (document.activeElement !== input) input.value = (get() || BrickColor.fromNumber(194)).Name; };
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => this.commit(sel, p.name, BrickColor.fromName(input.value)));
        el = input;
        break;
      }
      case 'Ref': {
        const b = h('button', { class: 'pref', disabled: readonly ? '' : null });
        update = () => { const v = get(); b.textContent = v ? v.props.Name : ''; b.title = v ? v.getFullName() : 'Click, then select an object in the Explorer'; };
        b.addEventListener('click', () => {
          b.textContent = 'Select an object…';
          this.app.pickInstance((target) => this.commit(sel, p.name, target || null));
        });
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.commit(sel, p.name, null); });
        el = b;
        break;
      }
      case 'PhysicalProperties': {
        const c = h('input', { type: 'checkbox', class: 'pcheck' });
        const input = h('input', { class: 'pinput', placeholder: 'density, friction, elasticity, fw, ew' });
        update = () => { const v = get(); c.checked = !!v; input.disabled = !v; if (document.activeElement !== input) input.value = v ? v.toArray().map(fmt).join(', ') : ''; };
        c.addEventListener('change', () => this.commit(sel, p.name, c.checked ? materialPhysics(inst.get('Material') || getEnum('Material').get('Plastic')) : null));
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => { try { this.commit(sel, p.name, new PhysicalProperties(...nums(input.value, 5))); } catch { update(); } });
        el = h('div', { class: 'pcolor' }, c, input);
        break;
      }
      case 'Faces': case 'Axes': {
        const names = t === 'Faces' ? ['Right', 'Top', 'Back', 'Left', 'Bottom', 'Front'] : ['X', 'Y', 'Z'];
        const boxes = names.map((n, i) => { const c = h('input', { type: 'checkbox', title: n }); c.addEventListener('change', () => { let bits = 0; boxes.forEach((bx, j) => { if (bx.checked) bits |= 1 << j; }); this.commit(sel, p.name, t === 'Faces' ? new Faces(bits) : new Axes(bits)); }); void i; return c; });
        update = () => { const v = get(); boxes.forEach((bx, j) => { bx.checked = !!(v && v.bits & (1 << j)); }); };
        el = h('div', { class: 'pfaces' }, names.map((n, i) => h('label', {}, boxes[i], n[0])));
        break;
      }
      case 'Font': {
        const fams = ['SourceSansPro', 'GothamSSm', 'BuilderSans', 'Montserrat', 'Roboto', 'RobotoMono', 'Arial', 'LegacyArial', 'Oswald', 'Ubuntu', 'Nunito', 'FredokaOne', 'Bangers', 'Creepster', 'PressStart2P', 'Inconsolata', 'PermanentMarker', 'IndieFlower', 'LuckiestGuy', 'TitilliumWeb', 'Merriweather', 'Jura', 'Michroma', 'DenkOne', 'AmaticSC', 'PatrickHand', 'SpecialElite', 'Kalam', 'Sarpanch', 'GrenzeGotisch', 'Fondamento', 'Zekton', 'Guru', 'HighwayGothic', 'RomanAntique', 'Balthazar', 'AccanthisADFStd', 'ComicNeueAngular', 'JosefinSans'];
        const fam = h('select', { class: 'pinput' }, fams.map((f) => h('option', { value: f, text: f })));
        const wt = h('select', { class: 'pinput narrow' }, [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => h('option', { value: String(w), text: String(w) })));
        const st = h('select', { class: 'pinput narrow' }, ['Normal', 'Italic'].map((s) => h('option', { value: s, text: s })));
        update = () => { const v = get() || new Font(); fam.value = v.familyName; wt.value = String(v.Weight); st.value = v.Style; };
        const go = () => this.commit(sel, p.name, new Font(`rbxasset://fonts/families/${fam.value}.json`, Number(wt.value), st.value));
        fam.addEventListener('change', go); wt.addEventListener('change', go); st.addEventListener('change', go);
        el = h('div', { class: 'pfont' }, fam, wt, st);
        break;
      }
      default: text((v) => String(v && v.toString ? v.toString() : v), () => undefined);
    }
    update();
    return { el, update };
  }

  updateValues() { for (const f of this.fields) { try { f.update(); } catch { /* ignore */ } } }

  attributesSection(inst) {
    const wrap = h('div', { class: 'attr-section' });
    const head = h('div', { class: 'prop-cat open' }, icon('chevron'), h('span', { text: 'Attributes' }));
    wrap.append(head);
    const attrs = inst.attrs ? [...inst.attrs] : [];
    for (const [name, v] of attrs) {
      let input;
      if (typeof v === 'boolean') { input = h('input', { type: 'checkbox', checked: v ? '' : null }); input.addEventListener('change', () => this.app.history.run('Attribute', () => inst.setAttribute(name, input.checked))); }
      else {
        input = h('input', { class: 'pinput', value: typeof v === 'number' ? fmt(v) : v && v.toHex ? '#' + v.toHex() : String(v) });
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => {
          let nv = input.value;
          if (typeof v === 'number') nv = Number(nv);
          else if (v instanceof Color3) nv = Color3.fromHex(nv);
          else if (v instanceof Vector3) nv = new Vector3(...nv.split(/[,\s]+/).map(Number));
          this.app.history.run('Attribute', () => inst.setAttribute(name, nv));
        });
      }
      const del = h('button', { class: 'icon-btn small', title: 'Remove attribute', onclick: () => this.app.history.run('Attribute', () => inst.setAttribute(name, undefined)) }, icon('x'));
      wrap.append(h('div', { class: 'prop-row' }, h('label', { text: name }), h('div', { class: 'pcolor' }, input, del)));
    }
    const nameIn = h('input', { class: 'pinput', placeholder: 'name' });
    const typeSel = h('select', { class: 'pinput narrow' }, ['string', 'number', 'boolean', 'Color3', 'Vector3'].map((x) => h('option', { value: x, text: x })));
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    const add = h('button', { class: 'btn small', onclick: () => {
      const n = nameIn.value.trim();
      if (!/^[A-Za-z0-9_]{1,100}$/.test(n)) { toast('Attribute names may only contain letters, digits and _', 'error'); return; }
      const def = { string: '', number: 0, boolean: false, Color3: new Color3(1, 1, 1), Vector3: new Vector3() }[typeSel.value];
      this.app.history.run('Add Attribute', () => inst.setAttribute(n, def));
    } }, '+ Add');
    wrap.append(h('div', { class: 'prop-row add' }, nameIn, h('div', { class: 'pcolor' }, typeSel, add)));
    return wrap;
  }

  tagsSection(inst) {
    const wrap = h('div', { class: 'attr-section' });
    wrap.append(h('div', { class: 'prop-cat open' }, icon('chevron'), h('span', { text: 'Tags' })));
    const chips = h('div', { class: 'chips' }, [...(inst.tags || [])].map((tg) => h('span', { class: 'chip' }, tg, h('button', { class: 'chip-x', onclick: () => { this.app.history.run('Remove Tag', () => inst.removeTag(tg)); this.render(); } }, '×'))));
    const input = h('input', { class: 'pinput', placeholder: 'Add tag…' });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && input.value.trim()) { this.app.history.run('Add Tag', () => inst.addTag(input.value.trim())); this.render(); } });
    wrap.append(chips, h('div', { class: 'prop-row add' }, input));
    return wrap;
  }
}

let brickList = null;
function ensureBrickList() {
  if (brickList) return;
  brickList = h('datalist', { id: 'bloxlab-brickcolors' }, BrickColor.all().map((b) => h('option', { value: b[1] })));
  document.body.append(brickList);
}
