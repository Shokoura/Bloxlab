// The Instance object model: properties, hierarchy, events, attributes, tags, cloning.
import { classInfo, isA, F } from './reflect.js';
import { Signal } from './signal.js';
import { sameValue } from './values.js';

let NEXT_ID = 1;
const behaviors = new Map(); // className -> spec
const mergedCache = new Map();

/**
 * Registers engine behaviour for a class (inherited by subclasses).
 * spec: { props: { Name: { get(inst), set(inst, v) } }, methods: { Name(self, ...args) -> array }, events: [...],
 *         init(inst), added(inst), removed(inst) }
 */
export function defineBehavior(className, spec) {
  const prev = behaviors.get(className);
  if (prev) {
    behaviors.set(className, {
      ...prev, ...spec,
      props: { ...prev.props, ...spec.props },
      methods: { ...prev.methods, ...spec.methods },
      events: [...(prev.events || []), ...(spec.events || [])],
    });
  } else behaviors.set(className, spec);
  mergedCache.clear();
}

export function mergedBehavior(className) {
  let m = mergedCache.get(className);
  if (m) return m;
  const chain = [];
  for (let c = classInfo(className); c; c = c.superclass) chain.unshift(c.name);
  if (!classInfo(className).known && !chain.includes('Instance')) chain.unshift('Instance');
  m = { props: {}, methods: {}, events: new Set(), inits: [], added: [], removed: [] };
  for (const cn of chain) {
    const b = behaviors.get(cn);
    if (!b) continue;
    Object.assign(m.props, b.props || {});
    Object.assign(m.methods, b.methods || {});
    (b.events || []).forEach((e) => m.events.add(e));
    if (b.init) m.inits.push(b.init);
    if (b.added) m.added.push(b.added);
    if (b.removed) m.removed.push(b.removed);
  }
  mergedCache.set(className, m);
  return m;
}

export class Instance {
  constructor(className, world = null) {
    this.ClassName = className;
    this.cls = classInfo(className);
    this.beh = mergedBehavior(className);
    this.props = Object.create(this.cls.defaults);
    if (!('Name' in this.cls.defaults)) this.props.Name = className;
    this.props.Name = className;
    this.parent = null;
    this.children = [];
    this.world = world; // world this instance was created in (set when parented into a DataModel)
    this.dm = null; // DataModel root when inside one
    this.id = NEXT_ID++;
    this.signals = null;
    this.propSignals = null;
    this.attrSignals = null;
    this.attrs = null;
    this.tags = null;
    this.destroyed = false;
    this.parentLocked = false;
    this.archivable = true;
    this.extra = null; // unknown / unserializable raw props kept for round-trips: name -> {t, v}
    for (const f of this.beh.inits) f(this);
  }

  get Name() { return this.props.Name; }
  set Name(v) { this.set('Name', v); }
  get Parent() { return this.parent; }
  isA(c) { return isA(this.ClassName, c); }
  toString() { return this.props.Name; }
  get $typeof() { return 'Instance'; }

  // ------------------------------------------------------------ properties
  hasProp(name) { return !!this.cls.props[name] || !!this.beh.props[name]; }
  get(name) {
    const acc = this.beh.props[name];
    if (acc && acc.get) return acc.get(this);
    return this.props[name];
  }
  /** Engine-level property write (value already converted). Fires change notifications. */
  set(name, value, opts) {
    const acc = this.beh.props[name];
    if (acc && acc.set && !(opts && opts.raw)) { acc.set(this, value, opts); return; }
    const old = this.props[name];
    if (sameValue(old, value)) return;
    const rec = this.dm && this.dm.world && this.dm.world.recorder;
    if (rec) rec.prop(this, name, old);
    this.props[name] = value;
    this.changed(name, opts);
  }
  /** Sets the stored value without behaviour/accessors (used by accessors themselves). */
  rawSet(name, value, opts) {
    const old = this.props[name];
    if (sameValue(old, value)) return false;
    const rec = this.dm && this.dm.world && this.dm.world.recorder;
    if (rec) rec.prop(this, name, old);
    this.props[name] = value;
    this.changed(name, opts);
    return true;
  }
  changed(name, opts) {
    const w = this.dm && this.dm.world;
    if (w) w.propChanged(this, name, opts);
    this.fireChanged(name);
  }
  fireChanged(name) {
    if (this.signals) {
      const c = this.signals.get('Changed');
      if (c && c.hasListeners) {
        if (this.isA('ValueBase')) { if (name === 'Value') c.fire(this.get('Value')); }
        else c.fire(name);
      }
    }
    if (this.propSignals) {
      const s = this.propSignals.get(name);
      if (s && s.hasListeners) s.fire();
    }
  }

  // ------------------------------------------------------------ events
  signal(name) {
    if (!this.signals) this.signals = new Map();
    let s = this.signals.get(name);
    if (!s) { s = new Signal(name); this.signals.set(name, s); }
    return s;
  }
  fire(name, ...args) {
    const s = this.signals && this.signals.get(name);
    if (s && s.hasListeners) s.fire(...args);
  }
  hasEvent(name) { return this.cls.events.has(name) || this.beh.events.has(name); }
  propertySignal(name) {
    if (!this.propSignals) this.propSignals = new Map();
    let s = this.propSignals.get(name);
    if (!s) { s = new Signal(`${name}Changed`); this.propSignals.set(name, s); }
    return s;
  }

  // ------------------------------------------------------------ hierarchy
  setParent(p, opts) {
    if (p === this.parent) return;
    if (this.parentLocked) throw new Error(`The Parent property of ${this.props.Name} is locked, current parent: NULL, new parent ${p ? p.props.Name : 'NULL'}`);
    if (p === this) throw new Error(`Attempt to set ${this.getFullName()} as its own parent`);
    if (p && p.isDescendantOf(this)) throw new Error(`Attempt to set parent of ${this.getFullName()} to ${p.getFullName()} would result in circular reference`);
    if (p && p.destroyed && p.parentLocked) throw new Error(`The Parent property of ${this.props.Name} is locked`);
    const old = this.parent;
    const oldDm = this.dm;
    const rec = (oldDm && oldDm.world && oldDm.world.recorder) || (p && p.dm && p.dm.world && p.dm.world.recorder);
    if (rec) rec.parent(this, old, old ? old.children.indexOf(this) : -1);
    if (old) {
      for (let a = old; a; a = a.parent) a.fire('DescendantRemoving', this);
      const i = old.children.indexOf(this);
      if (i >= 0) old.children.splice(i, 1);
    }
    this.parent = p || null;
    if (p) p.children.push(this);
    const newDm = p ? (p.ClassName === 'DataModel' && !p.parent ? p : p.dm) : null;
    if (oldDm !== newDm) {
      if (oldDm) this.forTree((d) => { for (const f of d.beh.removed) f(d, oldDm); });
      if (oldDm && oldDm.world) oldDm.world.instanceRemoved(this, old, opts);
      this.forTree((d) => { d.dm = newDm; if (newDm) d.world = newDm.world; });
      if (newDm && newDm.world) newDm.world.instanceAdded(this, opts);
      if (newDm) this.forTree((d) => { for (const f of d.beh.added) f(d, newDm); });
    } else if (newDm && newDm.world) newDm.world.instanceMoved(this, old, opts);
    if (old) old.fire('ChildRemoved', this);
    if (p) {
      p.fire('ChildAdded', this);
      for (let a = p; a; a = a.parent) {
        if (a.signals && a.signals.has('DescendantAdded')) { const s = a.signals.get('DescendantAdded'); if (s.hasListeners) this.forTree((d) => s.fire(d)); }
      }
    }
    this.forTree((d) => d.fire('AncestryChanged', this, p || undefined));
    this.fireChanged('Parent');
  }
  forTree(fn) { fn(this); for (const c of this.children.slice()) c.forTree(fn); }
  descendants(out = []) { for (const c of this.children) { out.push(c); c.descendants(out); } return out; }
  isDescendantOf(a) { for (let p = this.parent; p; p = p.parent) if (p === a) return true; return false; }
  isAncestorOf(d) { return !!d && d.isDescendantOf(this); }
  findFirstChild(name, recursive = false) {
    for (const c of this.children) if (c.props.Name === name) return c;
    if (recursive) for (const c of this.children) { const r = c.findFirstChild(name, true); if (r) return r; }
    return null;
  }
  findFirstChildOfClass(cn) { return this.children.find((c) => c.ClassName === cn) || null; }
  findFirstChildWhichIsA(cn, recursive = false) {
    for (const c of this.children) if (c.isA(cn)) return c;
    if (recursive) for (const c of this.children) { const r = c.findFirstChildWhichIsA(cn, true); if (r) return r; }
    return null;
  }
  findFirstAncestor(name) { for (let p = this.parent; p; p = p.parent) if (p.props.Name === name) return p; return null; }
  findFirstAncestorOfClass(cn) { for (let p = this.parent; p; p = p.parent) if (p.ClassName === cn) return p; return null; }
  findFirstAncestorWhichIsA(cn) { for (let p = this.parent; p; p = p.parent) if (p.isA(cn)) return p; return null; }
  getFullName() {
    const parts = [];
    for (let p = this; p && !(p.ClassName === 'DataModel' && !p.parent); p = p.parent) parts.unshift(p.props.Name);
    return parts.join('.');
  }

  destroy() {
    if (this.destroyed) return;
    this.fire('Destroying');
    this.destroyed = true;
    for (const c of this.children.slice()) c.destroy();
    if (this.parent) this.setParent(null);
    this.parentLocked = true;
    if (this.signals) for (const s of this.signals.values()) s.disconnectAll();
    if (this.propSignals) for (const s of this.propSignals.values()) s.disconnectAll();
    if (this.attrSignals) for (const s of this.attrSignals.values()) s.disconnectAll();
  }
  clearAllChildren() { for (const c of this.children.slice()) c.destroy(); }

  /**
   * Deep copy. `all` copies non-Archivable instances too (used by Play).
   * Ref properties pointing inside the copied tree are remapped.
   */
  clone(all = false, map = null, world = this.world) {
    if (!all && !this.archivable) return null;
    const top = !map;
    if (top) map = new Map();
    const c = new Instance(this.ClassName, world);
    map.set(this, c);
    for (const k of Object.keys(this.props)) c.props[k] = this.props[k];
    if (this.extra) c.extra = new Map(this.extra);
    if (this.attrs) c.attrs = new Map(this.attrs);
    if (this.tags) c.tags = new Set(this.tags);
    c.archivable = this.archivable;
    for (const ch of this.children) {
      const cc = ch.clone(all, map, world);
      if (cc) { cc.parent = c; c.children.push(cc); }
    }
    if (top) {
      // remap references that point inside the copied subtree
      for (const [src, dst] of map) {
        for (const k of Object.keys(src.props)) {
          const v = src.props[k];
          if (v instanceof Instance && map.has(v)) dst.props[k] = map.get(v);
        }
      }
      for (const dst of map.values()) for (const f of dst.beh.cloned || []) f(dst);
    }
    return c;
  }

  // ------------------------------------------------------------ attributes & tags
  getAttribute(name) { return this.attrs ? this.attrs.get(name) : undefined; }
  setAttribute(name, v) {
    if (!this.attrs) this.attrs = new Map();
    const old = this.attrs.get(name);
    if (sameValue(old, v)) return;
    const rec = this.dm && this.dm.world && this.dm.world.recorder;
    if (rec) rec.attr(this, name, old);
    if (v === undefined || v === null) this.attrs.delete(name); else this.attrs.set(name, v);
    const w = this.dm && this.dm.world;
    if (w) w.attrChanged(this, name);
    this.fire('AttributeChanged', name);
    const s = this.attrSignals && this.attrSignals.get(name);
    if (s) s.fire();
  }
  attributeSignal(name) {
    if (!this.attrSignals) this.attrSignals = new Map();
    let s = this.attrSignals.get(name);
    if (!s) { s = new Signal(`${name}AttributeChanged`); this.attrSignals.set(name, s); }
    return s;
  }
  addTag(t) {
    if (!this.tags) this.tags = new Set();
    if (this.tags.has(t)) return;
    this.tags.add(t);
    const w = this.dm && this.dm.world;
    if (w) w.tagChanged(this, t, true);
  }
  removeTag(t) {
    if (!this.tags || !this.tags.delete(t)) return;
    const w = this.dm && this.dm.world;
    if (w) w.tagChanged(this, t, false);
  }
  hasTag(t) { return !!this.tags && this.tags.has(t); }

  /** Value of a property suitable for the property panel (falls back to defaults). */
  isPropModified(name) { return Object.prototype.hasOwnProperty.call(this.props, name); }
  resetProp(name) { if (this.isPropModified(name)) { delete this.props[name]; this.changed(name); } }
  scriptable(name) {
    const p = this.cls.props[name];
    return !!this.beh.props[name] || (!!p && !(p.flags & F.NOTSCRIPTABLE));
  }
}

/** Creates an instance (does not run Lua-visible validation). */
export function create(className, props, parent, world) {
  const i = new Instance(className, world || (parent && parent.world) || null);
  if (props) for (const [k, v] of Object.entries(props)) i.set(k, v);
  if (parent) i.setParent(parent);
  return i;
}
