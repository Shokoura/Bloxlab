// Undo / redo for the edit world. Changes are recorded by hooks in Instance (world.recorder).
export class History {
  constructor(world, onChange) {
    this.world = world;
    this.undoStack = [];
    this.redoStack = [];
    this.current = null;
    this.depth = 0;
    this.onChange = onChange || (() => {});
    this.suspended = false;
  }
  attach(world) { this.world = world; this.undoStack = []; this.redoStack = []; this.current = null; this.depth = 0; this.world.recorder = null; this.onChange(); }

  begin(name = 'Change') {
    if (this.depth++ > 0) return;
    this.current = { name, ops: [], seen: new Set() };
    const rec = this.current;
    this.world.recorder = {
      prop: (inst, prop, old) => { const k = `p${inst.id}:${prop}`; if (rec.seen.has(k)) return; rec.seen.add(k); rec.ops.push({ t: 'prop', inst, prop, old }); },
      attr: (inst, name, old) => { const k = `a${inst.id}:${name}`; if (rec.seen.has(k)) return; rec.seen.add(k); rec.ops.push({ t: 'attr', inst, name, old }); },
      parent: (inst, old, index) => { const k = `r${inst.id}`; if (rec.seen.has(k)) return; rec.seen.add(k); rec.ops.push({ t: 'parent', inst, old, index }); },
    };
  }
  commit() {
    if (this.depth === 0) return;
    if (--this.depth > 0) return;
    const rec = this.current;
    this.current = null;
    this.world.recorder = null;
    if (!rec || !rec.ops.length) return;
    for (const op of rec.ops) {
      if (op.t === 'prop') op.now = op.inst.props[op.prop];
      else if (op.t === 'attr') op.now = op.inst.getAttribute(op.name);
      else op.now = op.inst.parent;
    }
    this.undoStack.push(rec);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.onChange();
  }
  /** Runs fn inside a waypoint. */
  run(name, fn) {
    this.begin(name);
    try { return fn(); } finally { this.commit(); }
  }
  apply(rec, undo) {
    const ops = undo ? [...rec.ops].reverse() : rec.ops;
    for (const op of ops) {
      const v = undo ? op.old : op.now;
      try {
        if (op.t === 'prop') op.inst.rawSet(op.prop, v);
        else if (op.t === 'attr') op.inst.setAttribute(op.name, v);
        else {
          op.inst.parentLocked = false;
          op.inst.destroyed = false;
          op.inst.setParent(v || null);
          if (undo && v && op.index >= 0) { const ch = v.children; const i = ch.indexOf(op.inst); if (i >= 0 && i !== op.index) { ch.splice(i, 1); ch.splice(Math.min(op.index, ch.length), 0, op.inst); } }
        }
      } catch (e) { console.warn('history', e); }
    }
  }
  undo() { const r = this.undoStack.pop(); if (!r) return null; this.apply(r, true); this.redoStack.push(r); this.onChange(); return r.name; }
  redo() { const r = this.redoStack.pop(); if (!r) return null; this.apply(r, false); this.undoStack.push(r); this.onChange(); return r.name; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
