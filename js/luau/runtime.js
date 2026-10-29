// Luau runtime: values, tables, metatables, calls, errors and coroutines.
//
// Value mapping:  nil=undefined  boolean  number  string(byte string)  LuaTable  function
//   Lua functions are JS generator functions flagged with `$g` (they may yield); native functions
//   are plain JS functions returning an array of results (or undefined for none).
//   Userdata are JS objects that implement `$index(key)` / `$newindex(key, value)` and may carry a
//   `$meta` object (arithmetic, __tostring, __eq, ...) on their prototype.

export const EMPTY = Object.freeze([]);

export class LuaTable {
  constructor(arr) { this.arr = arr || []; this.hash = null; this.mt = null; this.frozen = false; this.kv = 0; }
  get(k) {
    if (typeof k === 'number') {
      const a = this.arr;
      if (k > 0 && k <= a.length && (k | 0) === k) return a[k - 1];
    }
    return this.hash === null ? undefined : this.hash.get(k);
  }
  set(k, v) {
    if (typeof k === 'number') {
      const a = this.arr;
      const n = a.length;
      if ((k | 0) === k && k > 0) {
        if (k <= n) {
          a[k - 1] = v;
          if (v === undefined && k === n) { let m = n - 1; while (m > 0 && a[m - 1] === undefined) m--; a.length = m; }
          return;
        }
        if (k === n + 1) {
          if (v === undefined) { if (this.hash) this.hash.delete(k); return; }
          a.push(v);
          const h = this.hash;
          if (h !== null && h.size) {
            if (h.has(k)) h.delete(k);
            let nk = k + 1, nv;
            while ((nv = h.get(nk)) !== undefined) { a.push(nv); h.delete(nk); nk++; }
          }
          return;
        }
      } else if (k !== k) throw new LuaError('table index is NaN', 1);
    } else if (k === undefined || k === null) throw new LuaError('table index is nil', 1);
    if (v === undefined) { if (this.hash !== null) this.hash.delete(k); return; }
    if (this.hash === null) this.hash = new Map();
    else if (!this.hash.has(k)) this.kv++;
    this.hash.set(k, v);
  }
  length() { return this.arr.length; }
  // ordered key list for `next` (rebuilt only when new keys were inserted)
  keyList() {
    if (!this._keys || this._kv !== this.kv || this._ksize > this.hash.size + 64) {
      this._keys = this.hash ? [...this.hash.keys()] : [];
      this._kpos = new Map(this._keys.map((k, i) => [k, i]));
      this._kv = this.kv; this._ksize = this._keys.length;
    }
    return this._keys;
  }
}

export class LuaError extends Error {
  constructor(value, level = 1) {
    super(typeof value === 'string' ? value : 'error object');
    this.value = value;
    this.level = level;
    this.positioned = level === 0 || typeof value !== 'string';
    this.trace = [];
  }
}

// ---------------------------------------------------------------- shared state
/** Loop watchdog. `R.deadline` is set by the scheduler while a thread runs. */
export const BUDGET = {
  check() {
    if (R.deadline && performance.now() > R.deadline) {
      R.deadline = 0;
      throw new LuaError('Script timeout: exhausted allowed execution time', 1);
    }
  },
};

export const R = {
  deadline: 0,
  current: null, // running Coroutine
  noYield: 0,
  stringMeta: null, // LuaTable used for string methods
  onPrint: null,
  ids: new WeakMap(),
  nextId: 0x10000,
};

export function addressOf(o) {
  let id = R.ids.get(o);
  if (!id) { id = (R.nextId += 0x28 + ((R.nextId * 7) & 0x18)); R.ids.set(o, id); }
  return '0x' + id.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------- functions
export function mkfn(gen, name, line) { gen.$g = 1; gen.$name = name; gen.$line = line; return gen; }
/** Mark a native generator function (may yield). */
export function mkgen(gen, name) { gen.$g = 1; gen.$name = name; gen.$native = true; return gen; }
export const nat = (r) => (r === undefined ? EMPTY : r);
export const isCallable = (f) => typeof f === 'function' || (f instanceof LuaTable && f.mt && f.mt.get('__call') !== undefined);

export function* call(f, ...args) {
  if (typeof f === 'function') {
    if (f.$g) return yield* f(...args);
    const r = f(...args);
    return r === undefined ? EMPTY : r;
  }
  return yield* callx(f, '?', args);
}

export function* callx(f, name, args) {
  const h = metaOf(f, '__call');
  if (h !== undefined) return yield* call(h, f, ...args);
  if (name && name !== '?') {
    if (f === undefined) throw new LuaError(`attempt to call a nil value (${typeof name === 'string' ? `'${name}'` : 'field'})`, 1);
  }
  throw new LuaError(`attempt to call a ${typeName(f)} value`, 1);
}

/** Calls a Lua value from JS code that cannot yield (metamethods, sort comparators, gsub callbacks...). */
export function runSync(f, args) {
  if (typeof f === 'function' && !f.$g) return nat(f(...args));
  R.noYield++;
  try {
    const g = call(f, ...args);
    const r = g.next();
    if (!r.done) throw new LuaError('attempt to yield across metamethod/C-call boundary', 1);
    return r.value;
  } finally { R.noYield--; }
}

export function method(self, name) {
  const f = idx(self, name);
  if (f === undefined) {
    if (self === undefined) throw new LuaError(`attempt to index nil with '${name}'`, 1);
    throw new LuaError(`attempt to call missing method '${name}' of ${typeName(self)}`, 1);
  }
  return f;
}

// ---------------------------------------------------------------- errors
export const err = (msg) => new LuaError(msg, 1);

export function errorValue(e) {
  if (e instanceof LuaError) return e.value;
  if (isStackOverflow(e)) return 'stack overflow';
  return toByteStr(String(e && e.message ? e.message : e));
}

function isStackOverflow(e) {
  const m = e && e.message;
  return typeof m === 'string' && (m.indexOf('call stack') >= 0 || m.indexOf('too much recursion') >= 0);
}

export function rethrow(e, line, chunk) {
  if (e instanceof LuaError) {
    if (!e.positioned) {
      if (e.level <= 1) { e.value = `${chunk}:${line}: ${e.value}`; e.message = e.value; e.positioned = true; }
      else e.level--;
    }
    if (e.trace.length < 64) e.trace.push([chunk, line]);
    return e;
  }
  if (e && e.$kill) return e; // thread termination signal
  let msg;
  if (isStackOverflow(e)) msg = 'stack overflow';
  else if (e instanceof TypeError || e instanceof ReferenceError) msg = `${e.message}`;
  else msg = String(e && e.message !== undefined ? e.message : e);
  const le = new LuaError(`${chunk}:${line}: ${toByteStr(msg)}`, 0);
  le.positioned = true;
  le.js = e;
  le.trace.push([chunk, line]);
  return le;
}

// ---------------------------------------------------------------- type helpers
export function typeName(v) {
  if (v === undefined || v === null) return 'nil';
  switch (typeof v) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'string': return 'string';
    case 'function': return 'function';
    default:
      if (v instanceof LuaTable) return 'table';
      if (v instanceof Coroutine) return 'thread';
      if (v.$type === 'buffer') return 'buffer';
      if (v.$type === 'vector') return 'vector';
      return 'userdata';
  }
}

export function metaOf(v, event) {
  if (v instanceof LuaTable) { const mt = v.mt; return mt === null ? undefined : mt.get(event); }
  if (typeof v === 'string') return R.stringMeta ? R.stringMeta.get(event) : undefined;
  if (v !== null && typeof v === 'object') {
    if (v.$meta) return v.$meta[event];
    if (v.$mt) return v.$mt.get(event);
  }
  return undefined;
}

// ---------------------------------------------------------------- indexing
export function idx(o, k) {
  if (o instanceof LuaTable) {
    const v = o.get(k);
    if (v !== undefined) return v;
    const mt = o.mt;
    if (mt === null) return undefined;
    const h = mt.get('__index');
    if (h === undefined) return undefined;
    if (typeof h === 'function') return runSync(h, [o, k])[0];
    return idx(h, k);
  }
  if (typeof o === 'string') {
    const h = R.stringMeta && R.stringMeta.get('__index');
    return h ? idx(h, k) : undefined;
  }
  if (o !== null && typeof o === 'object' && o.$index !== undefined) return o.$index(k);
  const kd = typeof k === 'string' ? `'${k}'` : typeName(k);
  throw new LuaError(`attempt to index ${typeName(o)} with ${kd}`, 1);
}

export function setidx(o, k, v) {
  if (o instanceof LuaTable) {
    if (o.frozen) throw new LuaError('attempt to modify a readonly table', 1);
    const mt = o.mt;
    if (mt === null || o.get(k) !== undefined) { o.set(k, v); return; }
    const h = mt.get('__newindex');
    if (h === undefined) { o.set(k, v); return; }
    if (typeof h === 'function') { runSync(h, [o, k, v]); return; }
    setidx(h, k, v);
    return;
  }
  if (o !== null && typeof o === 'object' && o.$newindex !== undefined) { o.$newindex(k, v); return; }
  const kd = typeof k === 'string' ? `'${k}'` : typeName(k);
  throw new LuaError(`attempt to index ${typeName(o)} with ${kd}`, 1);
}

export function rawget(t, k) { return t.get(k); }

// ---------------------------------------------------------------- numbers & strings
const enc = new TextEncoder();
const dec = new TextDecoder();
/** JS string -> Lua byte string */
export function toByteStr(s) {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(s)) return s;
  const b = enc.encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 0x4000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x4000));
  return out;
}
/** Lua byte string -> JS string (invalid UTF-8 becomes U+FFFD) */
export function fromByteStr(s) {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(s)) return s;
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return dec.decode(b);
}
export function bytesOf(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
export function strOfBytes(b) { let out = ''; for (let i = 0; i < b.length; i += 0x4000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x4000)); return out; }

export function numToStr(n) {
  if (Number.isInteger(n)) {
    if (Object.is(n, -0)) return '-0';
    if (Math.abs(n) < 1e15) return String(n);
  }
  if (n !== n) return n > 0 ? 'nan' : '-nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  let s = String(n); // shortest round-trip digits
  // C-like exponent formatting: 1e+15, 1.5e-07
  const m = /^(-?)(\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(s);
  if (m) return `${m[1]}${m[2]}e${m[3]}${m[4].padStart(2, '0')}`;
  const abs = Math.abs(n);
  if (abs >= 1e15 || (abs < 1e-4 && abs > 0)) {
    s = n.toExponential();
    const e = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
    if (e) return `${e[1]}e${e[2]}${e[3].padStart(2, '0')}`;
  }
  return s;
}

export function tonum(v, base) {
  if (typeof v === 'number') return base === undefined ? v : undefined;
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (base !== undefined && base !== 10) {
    if (base < 2 || base > 36) throw new LuaError('invalid \'base\' argument', 1);
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    if (!s.length) return undefined;
    let n = 0;
    for (const c of s.toLowerCase()) {
      const d = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : 99;
      if (d >= base) return undefined;
      n = n * base + d;
    }
    return neg ? -n : n;
  }
  if (!s.length) return undefined;
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(s)) { const neg = s[0] === '-'; return (neg ? -1 : 1) * parseInt(s.replace(/^[-+]/, ''), 16); }
  if (/^[-+]?0[bB][01]+$/.test(s)) { const neg = s[0] === '-'; return (neg ? -1 : 1) * parseInt(s.replace(/^[-+]?0[bB]/, ''), 2); }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?(inf|nan)$/i.test(s)) return undefined;
  return undefined;
}

export function tostr(v) {
  switch (typeof v) {
    case 'string': return v;
    case 'number': return numToStr(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'undefined': return 'nil';
    case 'function': return (v.$builtin ? 'builtin: ' : 'function: ') + addressOf(v);
    default: {
      if (v === null) return 'nil';
      const h = metaOf(v, '__tostring');
      if (h !== undefined) {
        const r = typeof h === 'function' ? runSync(h, [v])[0] : h;
        if (typeof r !== 'string') { if (typeof r === 'number') return numToStr(r); throw new LuaError('\'__tostring\' must return a string', 1); }
        return r;
      }
      if (v instanceof LuaTable) { const n = v.mt && v.mt.get('__name'); return `${typeof n === 'string' ? n : 'table'}: ${addressOf(v)}`; }
      if (v instanceof Coroutine) return 'thread: ' + addressOf(v);
      if (typeof v.$tostring === 'function') return v.$tostring();
      return 'userdata: ' + addressOf(v);
    }
  }
}

// ---------------------------------------------------------------- operators
function arithNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = tonum(v); if (n !== undefined) return n; }
  return undefined;
}
function arith(ev, a, b) {
  const h = metaOf(a, ev) ?? metaOf(b, ev);
  if (h !== undefined) return runSync(h, [a, b])[0];
  const x = arithNum(a), y = arithNum(b);
  if (x !== undefined && y !== undefined) return [x, y];
  const op = ev.slice(2);
  const ta = typeName(a), tb = typeName(b);
  throw new LuaError(`attempt to perform arithmetic (${op}) on ${ta === tb ? ta : `${ta} and ${tb}`}`, 1);
}
const NUMS = (a, b) => typeof a === 'number' && typeof b === 'number';
export function add(a, b) { if (NUMS(a, b)) return a + b; const r = arith('__add', a, b); return Array.isArray(r) ? r[0] + r[1] : r; }
export function sub(a, b) { if (NUMS(a, b)) return a - b; const r = arith('__sub', a, b); return Array.isArray(r) ? r[0] - r[1] : r; }
export function mul(a, b) { if (NUMS(a, b)) return a * b; const r = arith('__mul', a, b); return Array.isArray(r) ? r[0] * r[1] : r; }
export function div(a, b) { if (NUMS(a, b)) return a / b; const r = arith('__div', a, b); return Array.isArray(r) ? r[0] / r[1] : r; }
export function idiv(a, b) { if (NUMS(a, b)) return Math.floor(a / b); const r = arith('__idiv', a, b); return Array.isArray(r) ? Math.floor(r[0] / r[1]) : r; }
const fmod = (a, b) => (b === Infinity ? (a >= 0 ? a : b) : b === -Infinity ? (a <= 0 ? a : b) : a - Math.floor(a / b) * b);
export function mod(a, b) { if (NUMS(a, b)) return fmod(a, b); const r = arith('__mod', a, b); return Array.isArray(r) ? fmod(r[0], r[1]) : r; }
export function pow(a, b) { if (NUMS(a, b)) return a ** b; const r = arith('__pow', a, b); return Array.isArray(r) ? r[0] ** r[1] : r; }
export function unm(a) {
  if (typeof a === 'number') return -a;
  const h = metaOf(a, '__unm');
  if (h !== undefined) return runSync(h, [a, a])[0];
  const n = arithNum(a);
  if (n !== undefined) return -n;
  throw new LuaError(`attempt to perform arithmetic (unm) on ${typeName(a)}`, 1);
}
export function concat(a, b) {
  const ta = typeof a, tb = typeof b;
  if ((ta === 'string' || ta === 'number') && (tb === 'string' || tb === 'number')) return (ta === 'string' ? a : numToStr(a)) + (tb === 'string' ? b : numToStr(b));
  const h = metaOf(a, '__concat') ?? metaOf(b, '__concat');
  if (h !== undefined) return runSync(h, [a, b])[0];
  throw new LuaError(`attempt to concatenate ${typeName(a)} with ${typeName(b)}`, 1);
}
export function concatn(parts, interp) {
  if (interp) return parts.join('');
  let s = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) s = concat(parts[i], s);
  return s;
}
export function len(v) {
  if (typeof v === 'string') return v.length;
  const h = metaOf(v, '__len');
  if (h !== undefined) return runSync(h, [v])[0];
  if (v instanceof LuaTable) return v.arr.length;
  throw new LuaError(`attempt to get length of a ${typeName(v)} value`, 1);
}
export function eq(a, b) {
  if (a === b) return true;
  const ta = typeof a;
  if (ta !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof LuaTable) {
    if (!(b instanceof LuaTable)) return false;
    const h = metaOf(a, '__eq') ?? metaOf(b, '__eq');
    return h !== undefined ? truthy(runSync(h, [a, b])[0]) : false;
  }
  const h = a.$meta && a.$meta.__eq;
  if (h !== undefined && b.$meta && b.$meta.__eq === h) return truthy(runSync(h, [a, b])[0]);
  return false;
}
function cmpError(a, b, op) {
  return new LuaError(`attempt to compare ${typeName(a)} ${op} ${typeName(b)}`, 1);
}
export function lt(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b;
  if (ta === 'string' && tb === 'string') return a < b;
  const h = metaOf(a, '__lt') ?? metaOf(b, '__lt');
  if (h !== undefined) return truthy(runSync(h, [a, b])[0]);
  throw cmpError(a, b, '<');
}
export function le(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a <= b;
  if (ta === 'string' && tb === 'string') return a <= b;
  const h = metaOf(a, '__le') ?? metaOf(b, '__le');
  if (h !== undefined) return truthy(runSync(h, [a, b])[0]);
  const h2 = metaOf(a, '__lt') ?? metaOf(b, '__lt');
  if (h2 !== undefined) return !truthy(runSync(h2, [b, a])[0]);
  throw cmpError(a, b, '<=');
}
export const gt = (a, b) => { try { return lt(b, a); } catch (e) { if (e instanceof LuaError && !e.positioned) throw cmpError(a, b, '>'); throw e; } };
export const ge = (a, b) => { try { return le(b, a); } catch (e) { if (e instanceof LuaError && !e.positioned) throw cmpError(a, b, '>='); throw e; } };
export const truthy = (v) => v !== undefined && v !== null && v !== false;

export function fornum(v, what) {
  if (typeof v === 'number') return v;
  const n = typeof v === 'string' ? tonum(v) : undefined;
  if (n === undefined) throw new LuaError(`invalid 'for' ${what} value (number expected, got ${typeName(v)})`, 1);
  return n;
}

// ---------------------------------------------------------------- tables & iteration
export function tbl(arr, hash) {
  const t = new LuaTable(arr);
  if (arr.length && arr[arr.length - 1] === undefined) { let m = arr.length; while (m > 0 && arr[m - 1] === undefined) m--; arr.length = m; }
  if (hash) for (let i = 0; i < hash.length; i += 2) { if (hash[i + 1] !== undefined) t.set(hash[i], hash[i + 1]); else if (hash[i] === undefined) throw new LuaError('table index is nil', 1); }
  return t;
}

export function next(t, k) {
  if (!(t instanceof LuaTable)) throw new LuaError(`invalid argument #1 to 'next' (table expected, got ${typeName(t)})`, 1);
  const a = t.arr;
  let i = 0;
  if (k !== undefined) {
    if (typeof k === 'number' && (k | 0) === k && k >= 1 && k <= a.length) i = k;
    else {
      if (!t.hash) return [undefined];
      const keys = t.keyList();
      let p = t._kpos.get(k);
      if (p === undefined) { if (!t.hash.has(k)) throw new LuaError('invalid key to \'next\'', 1); t._keys = null; t.keyList(); p = t._kpos.get(k); }
      for (let j = p + 1; j < keys.length; j++) { const v = t.hash.get(keys[j]); if (v !== undefined) return [keys[j], v]; }
      return [undefined];
    }
  }
  for (; i < a.length; i++) if (a[i] !== undefined) return [i + 1, a[i]];
  if (!t.hash) return [undefined];
  const keys = t.keyList();
  for (let j = 0; j < keys.length; j++) { const v = t.hash.get(keys[j]); if (v !== undefined) return [keys[j], v]; }
  return [undefined];
}

export function ipairsIter(t, i) {
  const n = i + 1;
  const v = t instanceof LuaTable ? t.get(n) : idx(t, n);
  return v === undefined ? [undefined] : [n, v];
}

function fastPairs(t) {
  let i = 0;
  const a = t.arr;
  let it = null;
  return () => {
    while (i < a.length) { const v = a[i++]; if (v !== undefined) return [i, v]; }
    if (t.hash === null) return undefined;
    if (it === null) it = t.hash.entries();
    for (;;) { const r = it.next(); if (r.done) return undefined; if (r.value[1] !== undefined) return r.value; }
  };
}
function fastIpairs(t) {
  let i = 0;
  return () => { const v = t.get(++i); return v === undefined ? undefined : [i, v]; };
}

export function forprep(r) {
  let f = r[0];
  const s = r[1], c = r[2];
  if (f === next && s instanceof LuaTable && c === undefined) return { fast: fastPairs(s) };
  if (f === ipairsIter && s instanceof LuaTable && c === 0) return { fast: fastIpairs(s) };
  if (f instanceof LuaTable) {
    const mt = f.mt;
    const iter = mt !== null ? mt.get('__iter') : undefined;
    if (iter !== undefined) return forprep(runSync(iter, [f]));
    if (mt === null || mt.get('__call') === undefined) return { fast: fastPairs(f) };
  }
  if (f !== null && typeof f === 'object' && !(f instanceof LuaTable)) {
    const iter = metaOf(f, '__iter');
    if (iter !== undefined) return forprep(runSync(iter, [f]));
    throw new LuaError(`attempt to iterate over a ${typeName(f)} value`, 1);
  }
  if (typeof f !== 'function' && !(f instanceof LuaTable)) throw new LuaError(`attempt to iterate over a ${typeName(f)} value`, 1);
  return { fast: null, f, s, c };
}

// ---------------------------------------------------------------- coroutines
export const SCHED = { sched: true }; // payload yielded to the task scheduler (wait, events...)

export class Coroutine {
  constructor(fn, owner) {
    this.fn = fn; this.gen = null; this.status = 'suspended';
    this.owner = owner || (R.current && R.current.owner) || null; // script / vm context
    this.waiting = false;
  }
}

function* callGen(f, args) { return yield* call(f, ...args); }

/** Resumes a coroutine. Returns [ok, ...values]; yields to the scheduler return [true]. */
export function resume(co, args = EMPTY) {
  if (co.status === 'dead') return [false, 'cannot resume dead coroutine'];
  if (co.status !== 'suspended') return [false, `cannot resume non-suspended coroutine`];
  const prev = R.current;
  if (prev) prev.status = 'normal';
  co.status = 'running';
  co.waiting = false;
  R.current = co;
  try {
    let r;
    if (co.gen === null) { co.gen = callGen(co.fn, args); r = co.gen.next(); }
    else r = co.gen.next(args);
    if (r.done) { co.status = 'dead'; co.gen = null; return [true, ...r.value]; }
    co.status = 'suspended';
    if (r.value === SCHED) { co.waiting = true; return [true]; }
    return [true, ...(r.value || EMPTY)];
  } catch (e) {
    co.status = 'dead';
    co.gen = null;
    if (e && e.$kill) return [true];
    co.error = e;
    return [false, errorValue(e), e];
  } finally {
    R.current = prev;
    if (prev) prev.status = 'running';
  }
}

export function close(co) {
  if (co.status === 'running' || co.status === 'normal') throw new LuaError('cannot close a running coroutine', 1);
  if (co.gen) { try { co.gen.return(EMPTY); } catch { /* ignore */ } }
  co.gen = null;
  const wasErr = co.error;
  co.status = 'dead';
  return wasErr ? [false, errorValue(wasErr)] : [true];
}

export function checkYieldable(what = 'yield') {
  if (!R.current) throw new LuaError(`attempt to ${what} from outside a coroutine`, 1);
  if (R.noYield) throw new LuaError('attempt to yield across metamethod/C-call boundary', 1);
}

/** Native coroutine.yield */
export const coYield = mkgen(function* (...args) {
  checkYieldable();
  const r = yield args;
  return r || EMPTY;
}, 'yield');

/** Yields the current coroutine to the scheduler; returns the values it is resumed with. */
export function* schedYield() {
  checkYieldable('yield');
  const r = yield SCHED;
  return r || EMPTY;
}
