// Studio selection set.
export class Selection {
  constructor() { this.items = []; this.listeners = new Set(); }
  list() { return this.items.filter((i) => i.dm && !i.destroyed); }
  has(i) { return this.items.includes(i); }
  first() { return this.list()[0] || null; }
  set(list) {
    const next = [...new Set(list.filter(Boolean))];
    if (next.length === this.items.length && next.every((x, i) => x === this.items[i])) return;
    this.items = next;
    this.emit();
  }
  add(i) { if (!this.has(i)) { this.items.push(i); this.emit(); } }
  remove(i) { const n = this.items.indexOf(i); if (n >= 0) { this.items.splice(n, 1); this.emit(); } }
  toggle(i) { if (this.has(i)) this.remove(i); else this.add(i); }
  clear() { this.set([]); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) f(this.list()); }
}
