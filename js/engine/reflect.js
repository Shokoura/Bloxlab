// Class database helpers built on top of the generated reflection data.
import reflection, { F, CF } from './reflection.js';
import { fromWire } from './values.js';

export { F, CF };
const classes = reflection.classes;
const infoCache = new Map();

/**
 * Merged view of a class: all properties (own + inherited), defaults converted to engine values,
 * events, methods and the serialization name map.
 */
export function classInfo(name) {
  let info = infoCache.get(name);
  if (info) return info;
  const raw = classes[name];
  const parent = raw && raw.s ? classInfo(raw.s) : null;
  info = {
    name,
    known: !!raw,
    superclass: parent,
    flags: raw ? raw.f : 0,
    props: parent ? Object.create(parent.props) : Object.create(null),
    events: new Set(parent ? parent.events : []),
    methods: new Set(parent ? parent.methods : []),
    serialToCanon: parent ? new Map(parent.serialToCanon) : new Map(),
    defaults: parent ? Object.create(parent.defaults) : Object.create(null),
    ancestry: new Set(parent ? parent.ancestry : []),
  };
  info.ancestry.add(name);
  if (raw) {
    for (const [pn, [type, flags, extra]] of Object.entries(raw.p)) {
      info.props[pn] = { name: pn, type, flags, extra };
      if (flags & F.SERIALIZES) info.serialToCanon.set(extra || pn, pn);
      else if (flags & F.ALIAS && extra) info.serialToCanon.set(pn, extra);
    }
    for (const [pn, w] of Object.entries(raw.d)) {
      const p = info.props[pn];
      if (!p) continue;
      try { info.defaults[pn] = fromWire(p.type, w); } catch { /* skip */ }
    }
    (raw.e || []).forEach((e) => info.events.add(e));
    (raw.m || []).forEach((m) => info.methods.add(m));
  }
  infoCache.set(name, info);
  return info;
}

export const isA = (className, base) => classInfo(className).ancestry.has(base);
export const classExists = (name) => !!classes[name];
export const isService = (name) => !!(classes[name] && classes[name].f & CF.SERVICE);
export const isCreatable = (name) => !!classes[name] && !(classes[name].f & CF.NOTCREATABLE) && !(classes[name].f & CF.SERVICE);
export const allClassNames = () => Object.keys(classes);
export function propInfo(className, prop) { return classInfo(className).props[prop] || null; }

/** Properties shown in the Studio properties panel, grouped & ordered. */
export function editableProps(className) {
  const info = classInfo(className);
  const out = [];
  for (const k in info.props) {
    const p = info.props[k];
    if (p.flags & (F.HIDDEN | F.NOTSCRIPTABLE | F.DEPRECATED | F.ALIAS | F.WRITEONLY)) continue;
    if (p.type === 'UniqueId' || p.type === 'SecurityCapabilities' || p.type === 'SharedString' || p.type === 'BinaryString' || p.type === 'Attributes' || p.type === 'Tags') continue;
    out.push(p);
  }
  return out;
}

/** Name the property is written under in files (or null when it is not serialized). */
export function serialName(className, prop) {
  const p = propInfo(className, prop);
  if (!p) return null;
  if (p.flags & F.SERIALIZES) return p.extra || prop;
  return null;
}

/** Studio property category (from the API dump), e.g. "Appearance", "Transform". */
export function propCategory(className, prop) {
  for (let c = classes[className]; c; c = classes[c.s]) {
    if (c.c && c.c[prop] !== undefined) return reflection.categories[c.c[prop]];
  }
  return 'Data';
}
