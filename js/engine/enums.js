// Enum / EnumItem objects built lazily from the reflection database.
import reflection from './reflection.js';

export class EnumItem {
  constructor(enumType, name, value) { this.EnumType = enumType; this.Name = name; this.Value = value; }
  toString() { return `Enum.${this.EnumType.name}.${this.Name}`; }
}

export class EnumType {
  constructor(name, items) {
    this.name = name;
    this.byName = new Map();
    this.byValue = new Map();
    for (const [n, v] of Object.entries(items).sort((a, b) => a[1] - b[1])) {
      const it = new EnumItem(this, n, v);
      this.byName.set(n, it);
      if (!this.byValue.has(v)) this.byValue.set(v, it);
    }
  }
  get(name) { return this.byName.get(name); }
  fromValue(v) { return this.byValue.get(v); }
  items() { return [...new Set(this.byName.values())]; }
  toString() { return this.name; }
}

const cache = new Map();
// Extra enums that are not part of the serialized-property database but are used by scripts.
const EXTRA = {};

export function getEnum(name) {
  let e = cache.get(name);
  if (e) return e;
  const items = reflection.enums[name] || EXTRA[name];
  if (!items) return null;
  e = new EnumType(name, items);
  cache.set(name, e);
  return e;
}
export const enumNames = () => [...new Set([...Object.keys(reflection.enums), ...Object.keys(EXTRA)])];

/** Enum.<type>.<name> shortcut: E('Material', 'Plastic') */
export function E(type, name) {
  const it = getEnum(type)?.get(name);
  if (!it) throw new Error(`Unknown enum ${type}.${name}`);
  return it;
}
export function enumFromValue(type, value) {
  const e = getEnum(type);
  return e ? e.fromValue(value) || new EnumItem(e, String(value), value) : null;
}
