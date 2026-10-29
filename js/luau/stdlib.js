// Luau standard library + VM (globals, chunk loading).
import * as RT from './runtime.js';
import {
  LuaTable, LuaError, EMPTY, R, call, mkgen, runSync, tostr, tonum, typeName, truthy, idx, setidx,
  next, ipairsIter, lt, eq, Coroutine, resume, close, coYield, errorValue, numToStr, toByteStr, fromByteStr,
} from './runtime.js';
import { makeStringLib } from './lstring.js';
import { compileToJS } from './compiler.js';
import { LuauSyntaxError } from './lexer.js';

const argErr = (n, fname, msg) => new LuaError(`invalid argument #${n} to '${fname}' (${msg})`, 1);
const checkTable = (t, n, fname) => { if (!(t instanceof LuaTable)) throw argErr(n, fname, `table expected, got ${typeName(t)}`); return t; };
const checkNum = (v, n, fname) => {
  if (typeof v === 'number') return v;
  const x = typeof v === 'string' ? tonum(v) : undefined;
  if (x === undefined) throw argErr(n, fname, `number expected, got ${v === undefined ? 'no value' : typeName(v)}`);
  return x;
};
const optNum = (v, n, fname, d) => (v === undefined ? d : checkNum(v, n, fname));
const checkInt = (v, n, fname) => Math.trunc(checkNum(v, n, fname));
const U32 = (x) => (Math.trunc(x) % 4294967296 + 4294967296) % 4294967296 >>> 0;

/** Build a LuaTable from a plain object of natives (functions get debug names). */
export function libTable(obj, name) {
  const t = new LuaTable();
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function' && !v.$name) v.$name = name ? `${name}.${k}` : k;
    if (typeof v === 'function') v.$builtin = true;
    t.set(k, v);
  }
  return t;
}
export const arrTable = (arr) => new LuaTable(arr.slice());

// ---------------------------------------------------------------- Perlin noise (math.noise)
const PERM = (() => {
  const p = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180];
  return [...p, ...p];
})();
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h, x, y, z) => { h &= 15; const u = h < 8 ? x : y; const v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
const mix = (a, b, t) => a + t * (b - a);
function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z, B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  return mix(mix(mix(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u), mix(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u), v),
    mix(mix(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u), mix(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u), v), w);
}

// ---------------------------------------------------------------- PRNG for math.random (xoshiro128**)
function makeRng(seed) {
  let a = seed >>> 0 || 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = 0xdeadbeef;
  const rng = () => {
    const t = b << 9;
    let r = Math.imul(b, 5); r = ((r << 7) | (r >>> 25)) >>> 0; r = Math.imul(r, 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r / 4294967296;
  };
  for (let i = 0; i < 16; i++) rng();
  return rng;
}

// ---------------------------------------------------------------- buffer
export class LuaBuffer {
  constructor(n) { this.u8 = new Uint8Array(n); this.dv = new DataView(this.u8.buffer); }
  get $type() { return 'buffer'; }
  $tostring() { return 'buffer: ' + RT.addressOf(this); }
}
const checkBuf = (b, n, f) => { if (!(b instanceof LuaBuffer)) throw argErr(n, f, `buffer expected, got ${typeName(b)}`); return b; };
const bufRange = (b, off, size) => { if (off < 0 || off + size > b.u8.length || !Number.isInteger(off)) throw new LuaError('buffer access out of bounds', 1); };

// ---------------------------------------------------------------- os.date
function strftime(fmt, d, utc) {
  const g = (m) => (utc ? d[`getUTC${m}`]() : d[`get${m}`]());
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return fmt.replace(/%(.)/g, (m, c) => {
    switch (c) {
      case 'a': return days[g('Day')].slice(0, 3);
      case 'A': return days[g('Day')];
      case 'b': return months[g('Month')].slice(0, 3);
      case 'B': return months[g('Month')];
      case 'c': return `${days[g('Day')].slice(0, 3)} ${months[g('Month')].slice(0, 3)} ${pad(g('Date'))} ${pad(g('Hours'))}:${pad(g('Minutes'))}:${pad(g('Seconds'))} ${g('FullYear')}`;
      case 'd': return pad(g('Date'));
      case 'H': return pad(g('Hours'));
      case 'I': return pad(((g('Hours') + 11) % 12) + 1);
      case 'j': { const start = utc ? Date.UTC(g('FullYear'), 0, 1) : new Date(g('FullYear'), 0, 1).getTime(); return pad(Math.floor((d - start) / 864e5) + 1, 3); }
      case 'm': return pad(g('Month') + 1);
      case 'M': return pad(g('Minutes'));
      case 'p': return g('Hours') < 12 ? 'AM' : 'PM';
      case 'S': return pad(g('Seconds'));
      case 'w': return String(g('Day'));
      case 'x': return `${pad(g('Month') + 1)}/${pad(g('Date'))}/${pad(g('FullYear') % 100)}`;
      case 'X': return `${pad(g('Hours'))}:${pad(g('Minutes'))}:${pad(g('Seconds'))}`;
      case 'y': return pad(g('FullYear') % 100);
      case 'Y': return String(g('FullYear'));
      case 'Z': return utc ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
      case '%': return '%';
      default: return m;
    }
  });
}

// ---------------------------------------------------------------- VM
const HELPERS = {
  $idx: RT.idx, $setidx: RT.setidx, $mkfn: RT.mkfn, $nat: RT.nat, $callx: RT.callx, $call: RT.call, $method: RT.method,
  $rethrow: RT.rethrow, $err: RT.err, $E: RT.EMPTY, $add: RT.add, $sub: RT.sub, $mul: RT.mul, $div: RT.div, $idiv: RT.idiv,
  $mod: RT.mod, $pow: RT.pow, $concat: RT.concat, $concatn: RT.concatn, $eq: RT.eq, $lt: RT.lt, $le: RT.le, $gt: RT.gt, $ge: RT.ge,
  $unm: RT.unm, $len: RT.len, $tbl: RT.tbl, $forprep: RT.forprep, $fornum: RT.fornum, $tostr: RT.tostr, $B: RT.BUDGET,
};
const PROLOGUE = `const {${Object.keys(HELPERS).join(', ')}} = $R;\n`;
const jsCache = new Map(); // source -> compiled JS (shared by all VMs)

export class VM {
  /**
   * @param {{ print?: (msg, kind, thread) => void }} opts
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.output = opts.print || ((m) => console.log(m));
    this.loadstringEnabled = opts.loadstring ?? true;
    this.globals = new LuaTable();
    this.G = new LuaTable(); // _G (shared between scripts)
    this.shared = new LuaTable();
    this.rng = makeRng(Date.now());
    this.installBase();
  }

  /** Compile Luau source to a callable Lua function. Throws LuauSyntaxError. */
  load(src, chunkName, env = null) {
    let js = jsCache.get(src);
    if (!js) {
      js = compileToJS(src, chunkName);
      if (jsCache.size > 500) jsCache.clear();
      jsCache.set(src, js);
    }
    // eslint-disable-next-line no-new-func
    const factory = new Function('$R', '$env', '$chunk', PROLOGUE + js);
    const main = factory(HELPERS, env || this.newEnv(), chunkName);
    return RT.mkfn(main, chunkName, 0);
  }

  /** Per-script environment whose missing keys fall through to the globals. */
  newEnv(extra) {
    const env = new LuaTable();
    const mt = new LuaTable();
    mt.set('__index', this.globals);
    env.mt = mt;
    if (extra) for (const [k, v] of Object.entries(extra)) env.set(k, v);
    return env;
  }

  setGlobal(name, v) { this.globals.set(name, v); }

  print(kind, args, thread) {
    const msg = args.map((a) => fromByteStr(tostr(a))).join(' ');
    this.output(msg, kind, thread || R.current);
  }

  installBase() {
    const vm = this;
    const G = this.globals;
    const set = (k, v) => { if (typeof v === 'function') { v.$name = v.$name || k; v.$builtin = true; } G.set(k, v); };

    set('print', (...a) => { vm.print('output', a); });
    set('warn', (...a) => { vm.print('warn', a); });
    set('error', (v, level) => { throw new LuaError(v, level === undefined ? 1 : checkInt(level, 2, 'error')); });
    set('assert', (...a) => {
      if (!truthy(a[0])) {
        if (a.length < 1) throw argErr(1, 'assert', 'value expected');
        throw new LuaError(a.length > 1 ? a[1] : 'assertion failed!', 1);
      }
      return a;
    });
    set('type', (...a) => { if (!a.length) throw argErr(1, 'type', 'value expected'); return [typeName(a[0])]; });
    set('typeof', (v) => [v != null && typeof v === 'object' && v.$typeof ? v.$typeof : typeName(v)]);
    set('tostring', (v) => [tostr(v)]);
    set('tonumber', (v, base) => [tonum(v, base === undefined ? undefined : checkInt(base, 2, 'tonumber'))]);
    set('rawget', (t, k) => [checkTable(t, 1, 'rawget').get(k)]);
    set('rawset', (t, k, v) => { checkTable(t, 1, 'rawset').set(k, v); return [t]; });
    set('rawequal', (a, b) => [a === b]);
    set('rawlen', (v) => { if (v instanceof LuaTable) return [v.arr.length]; if (typeof v === 'string') return [v.length]; throw argErr(1, 'rawlen', 'table or string expected'); });
    set('setmetatable', (t, mt) => {
      checkTable(t, 1, 'setmetatable');
      if (mt !== undefined && !(mt instanceof LuaTable)) throw argErr(2, 'setmetatable', 'nil or table expected');
      if (t.mt && t.mt.get('__metatable') !== undefined) throw new LuaError('cannot change a protected metatable', 1);
      if (t.frozen) throw new LuaError('attempt to modify a readonly table', 1);
      t.mt = mt || null;
      return [t];
    });
    set('getmetatable', (v) => {
      if (v instanceof LuaTable) { if (!v.mt) return [undefined]; const p = v.mt.get('__metatable'); return [p !== undefined ? p : v.mt]; }
      if (typeof v === 'string') return [R.stringMeta];
      if (v && v.$mt) { const p = v.$mt.get('__metatable'); return [p !== undefined ? p : v.$mt]; }
      if (v && typeof v === 'object' && v.$meta) return ['The metatable is locked'];
      return [undefined];
    });
    set('next', (t, k) => next(t, k));
    set('pairs', (t) => {
      if (!(t instanceof LuaTable)) throw argErr(1, 'pairs', `table expected, got ${t === undefined ? 'nil' : typeName(t)}`);
      return [next, t, undefined];
    });
    set('ipairs', (t) => {
      if (!(t instanceof LuaTable) && !(t && t.$index)) throw argErr(1, 'ipairs', `table expected, got ${t === undefined ? 'nil' : typeName(t)}`);
      return [ipairsIter, t, 0];
    });
    G.get('next').$name = 'next';
    set('select', (n, ...a) => {
      if (n === '#') return [a.length];
      let i = checkInt(n, 1, 'select');
      if (i < 0) { i = a.length + i; if (i < 0) throw argErr(1, 'select', 'index out of range'); return a.slice(i); }
      if (i === 0) throw argErr(1, 'select', 'index out of range');
      return a.slice(i - 1);
    });
    const unpack = (t, i, j) => {
      i = i === undefined ? 1 : checkInt(i, 2, 'unpack');
      j = j === undefined ? RT.len(t) : checkInt(j, 3, 'unpack');
      if (j - i >= 8000000) throw new LuaError('too many results to unpack', 1);
      const out = [];
      for (let k = i; k <= j; k++) out.push(t instanceof LuaTable ? t.get(k) : idx(t, k));
      return out;
    };
    set('unpack', unpack);
    set('pcall', mkgen(function* (f, ...args) {
      try { const r = yield* call(f, ...args); return [true, ...r]; }
      catch (e) { if (e && e.$kill) throw e; return [false, errorValue(e)]; }
    }, 'pcall'));
    set('xpcall', mkgen(function* (f, handler, ...args) {
      try { const r = yield* call(f, ...args); return [true, ...r]; }
      catch (e) {
        if (e && e.$kill) throw e;
        vm.lastError = e;
        const h = yield* call(handler, errorValue(e));
        return [false, ...h];
      }
    }, 'xpcall'));
    set('newproxy', (withMeta) => {
      const p = { $type: 'userdata', $mt: truthy(withMeta) ? new LuaTable() : null };
      p.$index = (k) => { const h = p.$mt && p.$mt.get('__index'); if (h === undefined) throw new LuaError(`attempt to index userdata with '${tostr(k)}'`, 1); return typeof h === 'function' ? runSync(h, [p, k])[0] : idx(h, k); };
      p.$newindex = (k, v) => { const h = p.$mt && p.$mt.get('__newindex'); if (h === undefined) throw new LuaError('attempt to index userdata', 1); if (typeof h === 'function') runSync(h, [p, k, v]); else setidx(h, k, v); };
      return [p];
    });
    set('collectgarbage', (opt) => (opt === 'count' ? [(performance.memory ? performance.memory.usedJSHeapSize : 32e6) / 1024] : [0]));
    set('gcinfo', () => [(performance.memory ? performance.memory.usedJSHeapSize : 32e6) / 1024]);
    set('loadstring', (src, name) => {
      if (!vm.loadstringEnabled) throw new LuaError('loadstring() is not available', 1);
      try {
        const env = R.current && R.current.owner && R.current.owner.env;
        return [vm.load(String(src), typeof name === 'string' ? name.replace(/^[=@]/, '') : '[string]', env)];
      } catch (e) {
        if (e instanceof LuauSyntaxError) return [undefined, `[string]:${e.line}: ${e.message}`];
        return [undefined, String(e.message)];
      }
    });
    set('getfenv', () => [(R.current && R.current.owner && R.current.owner.env) || G]);
    set('setfenv', (f) => [f]);
    G.set('_G', this.G);
    G.set('shared', this.shared);
    G.set('_VERSION', 'Luau');

    // ---------------------------------------------------------- string
    const strlib = libTable(makeStringLib(arrTable), 'string');
    G.set('string', strlib);
    const smeta = new LuaTable();
    smeta.set('__index', strlib);
    R.stringMeta = smeta;

    // ---------------------------------------------------------- table
    G.set('table', libTable({
      insert: (...args) => {
        const [t, a, b] = args;
        checkTable(t, 1, 'insert');
        if (t.frozen) throw new LuaError('attempt to modify a readonly table', 1);
        const n = t.arr.length;
        if (args.length > 3) throw new LuaError('wrong number of arguments to \'insert\'', 1);
        if (args.length <= 2) {
          if (args.length < 2) throw new LuaError('wrong number of arguments to \'insert\'', 1);
          if (t.hash === null || t.hash.size === 0) { if (a !== undefined) t.arr.push(a); return; }
          t.set(RT.len(t) + 1, a); return;
        }
        const pos = checkInt(a, 2, 'insert');
        if (pos < 1 || pos > n + 1) throw argErr(2, 'insert', 'position out of bounds');
        if (pos === n + 1) { t.set(pos, b); return; }
        if (b === undefined) { for (let i = n; i >= pos; i--) t.set(i + 1, t.get(i)); t.set(pos, b); return; }
        t.arr.splice(pos - 1, 0, b);
      },
      remove: (t, pos) => {
        checkTable(t, 1, 'remove');
        if (t.frozen) throw new LuaError('attempt to modify a readonly table', 1);
        const n = t.arr.length;
        if (pos === undefined) {
          if (n === 0) return [undefined];
          const v = t.arr[n - 1]; t.set(n, undefined); return [v];
        }
        pos = checkInt(pos, 2, 'remove');
        if (n === 0 && (pos === 0 || pos === n)) return [t.get(pos)];
        if (n + 1 === pos) { const v = t.get(pos); t.set(pos, undefined); return [v]; }
        if (pos < 1 || pos > n + 1) throw argErr(2, 'remove', 'position out of bounds');
        const v = t.arr.splice(pos - 1, 1)[0];
        while (t.arr.length && t.arr[t.arr.length - 1] === undefined) t.arr.pop();
        return [v];
      },
      concat: (t, sep, i, j) => {
        checkTable(t, 1, 'concat');
        sep = sep === undefined ? '' : String(typeof sep === 'number' ? numToStr(sep) : sep);
        i = i === undefined ? 1 : checkInt(i, 3, 'concat');
        j = j === undefined ? t.arr.length : checkInt(j, 4, 'concat');
        const parts = [];
        for (let k = i; k <= j; k++) {
          const v = t.get(k);
          if (typeof v === 'string') parts.push(v);
          else if (typeof v === 'number') parts.push(numToStr(v));
          else throw new LuaError(`invalid value (at index ${k}) in table for 'concat'`, 1);
        }
        return [parts.join(sep)];
      },
      sort: (t, comp) => {
        checkTable(t, 1, 'sort');
        if (t.frozen) throw new LuaError('attempt to modify a readonly table', 1);
        const n = t.arr.length;
        const a = [];
        for (let k = 1; k <= n; k++) a.push(t.get(k));
        let cmp;
        if (comp === undefined) cmp = (x, y) => (lt(x, y) ? -1 : lt(y, x) ? 1 : 0);
        else {
          if (typeof comp !== 'function') throw argErr(2, 'sort', 'function expected');
          cmp = (x, y) => (truthy(runSync(comp, [x, y])[0]) ? -1 : truthy(runSync(comp, [y, x])[0]) ? 1 : 0);
        }
        a.sort(cmp);
        for (let k = 0; k < n; k++) t.set(k + 1, a[k]);
      },
      unpack,
      pack: (...a) => { const t = new LuaTable(a.slice()); while (t.arr.length && t.arr[t.arr.length - 1] === undefined) t.arr.pop(); a.forEach((v, i) => { if (v !== undefined && i >= t.arr.length) t.set(i + 1, v); }); t.set('n', a.length); return [t]; },
      find: (t, v, init) => {
        checkTable(t, 1, 'find');
        for (let k = init === undefined ? 1 : checkInt(init, 3, 'find'); k <= t.arr.length; k++) if (t.get(k) === v) return [k];
        return [undefined];
      },
      clear: (t) => { checkTable(t, 1, 'clear'); if (t.frozen) throw new LuaError('attempt to modify a readonly table', 1); t.arr.length = 0; t.hash = null; t.kv++; },
      create: (n, v) => { n = checkInt(n, 1, 'create'); if (n < 0) throw argErr(1, 'create', 'size out of range'); return [new LuaTable(v === undefined ? [] : new Array(n).fill(v))]; },
      clone: (t) => { checkTable(t, 1, 'clone'); const c = new LuaTable(t.arr.slice()); if (t.hash) c.hash = new Map(t.hash); c.mt = t.mt; return [c]; },
      freeze: (t) => { checkTable(t, 1, 'freeze'); t.frozen = true; return [t]; },
      isfrozen: (t) => [checkTable(t, 1, 'isfrozen').frozen],
      maxn: (t) => { let m = t.arr.length; if (t.hash) for (const k of t.hash.keys()) if (typeof k === 'number' && k > m) m = k; return [m]; },
      move: (a1, f, e, tt, a2) => {
        checkTable(a1, 1, 'move');
        a2 = a2 === undefined ? a1 : a2;
        f = checkInt(f, 2, 'move'); e = checkInt(e, 3, 'move'); tt = checkInt(tt, 4, 'move');
        if (e >= f) {
          if (tt > e || tt <= f || a1 !== a2) for (let i = 0; i <= e - f; i++) a2.set(tt + i, a1.get(f + i));
          else for (let i = e - f; i >= 0; i--) a2.set(tt + i, a1.get(f + i));
        }
        return [a2];
      },
      getn: (t) => [checkTable(t, 1, 'getn').arr.length],
      foreach: mkgen(function* (t, f) { for (const [k, v] of [...(t.hash || new Map()), ...t.arr.map((v, i) => [i + 1, v])]) { const r = yield* call(f, k, v); if (r[0] !== undefined) return [r[0]]; } return EMPTY; }),
      foreachi: mkgen(function* (t, f) { for (let i = 1; i <= t.arr.length; i++) { const r = yield* call(f, i, t.get(i)); if (r[0] !== undefined) return [r[0]]; } return EMPTY; }),
    }, 'table'));

    // ---------------------------------------------------------- math
    const m1 = (fn, name) => (x) => [fn(checkNum(x, 1, name))];
    G.set('math', libTable({
      abs: m1(Math.abs, 'abs'), acos: m1(Math.acos, 'acos'), asin: m1(Math.asin, 'asin'), ceil: m1(Math.ceil, 'ceil'),
      cos: m1(Math.cos, 'cos'), cosh: m1(Math.cosh, 'cosh'), deg: m1((x) => (x * 180) / Math.PI, 'deg'), exp: m1(Math.exp, 'exp'),
      floor: m1(Math.floor, 'floor'), rad: m1((x) => (x * Math.PI) / 180, 'rad'), sin: m1(Math.sin, 'sin'), sinh: m1(Math.sinh, 'sinh'),
      sqrt: m1(Math.sqrt, 'sqrt'), tan: m1(Math.tan, 'tan'), tanh: m1(Math.tanh, 'tanh'), log10: m1(Math.log10, 'log10'),
      atan: (y, x) => [x === undefined ? Math.atan(checkNum(y, 1, 'atan')) : Math.atan2(checkNum(y, 1, 'atan'), checkNum(x, 2, 'atan'))],
      atan2: (y, x) => [Math.atan2(checkNum(y, 1, 'atan2'), checkNum(x, 2, 'atan2'))],
      log: (x, b) => [b === undefined ? Math.log(checkNum(x, 1, 'log')) : b === 2 ? Math.log2(checkNum(x, 1, 'log')) : b === 10 ? Math.log10(checkNum(x, 1, 'log')) : Math.log(checkNum(x, 1, 'log')) / Math.log(checkNum(b, 2, 'log'))],
      pow: (a, b) => [checkNum(a, 1, 'pow') ** checkNum(b, 2, 'pow')],
      fmod: (a, b) => { a = checkNum(a, 1, 'fmod'); b = checkNum(b, 2, 'fmod'); return [a % b]; },
      modf: (x) => { x = checkNum(x, 1, 'modf'); const i = x >= 0 ? Math.floor(x) : Math.ceil(x); return [i, Number.isFinite(x) ? x - i : 0]; },
      frexp: (x) => { x = checkNum(x, 1, 'frexp'); if (x === 0 || !Number.isFinite(x)) return [x, 0]; const e = Math.floor(Math.log2(Math.abs(x))) + 1; return [x / 2 ** e, e]; },
      ldexp: (m, e) => [checkNum(m, 1, 'ldexp') * 2 ** checkInt(e, 2, 'ldexp')],
      max: (...a) => { if (!a.length) throw argErr(1, 'max', 'number expected, got no value'); let r = checkNum(a[0], 1, 'max'); for (let i = 1; i < a.length; i++) { const v = checkNum(a[i], i + 1, 'max'); if (v > r || v !== v) r = v; } return [r]; },
      min: (...a) => { if (!a.length) throw argErr(1, 'min', 'number expected, got no value'); let r = checkNum(a[0], 1, 'min'); for (let i = 1; i < a.length; i++) { const v = checkNum(a[i], i + 1, 'min'); if (v < r || v !== v) r = v; } return [r]; },
      clamp: (x, lo, hi) => { x = checkNum(x, 1, 'clamp'); lo = checkNum(lo, 2, 'clamp'); hi = checkNum(hi, 3, 'clamp'); if (lo > hi) throw argErr(3, 'clamp', 'max must be greater than or equal to min'); return [Math.min(Math.max(x, lo), hi)]; },
      sign: (x) => { x = checkNum(x, 1, 'sign'); return [x > 0 ? 1 : x < 0 ? -1 : 0]; },
      round: (x) => { x = checkNum(x, 1, 'round'); return [x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5)]; },
      noise: (x, y, z) => [noise3(optNum(x, 1, 'noise', 0), optNum(y, 2, 'noise', 0), optNum(z, 3, 'noise', 0))],
      map: (x, a, b, c, d) => [c + ((checkNum(x, 1, 'map') - a) * (d - c)) / (b - a)],
      lerp: (a, b, t) => [checkNum(a, 1, 'lerp') + (checkNum(b, 2, 'lerp') - a) * checkNum(t, 3, 'lerp')],
      isnan: (x) => [x !== x], isinf: (x) => [x === Infinity || x === -Infinity], isfinite: (x) => [Number.isFinite(x)],
      random: (a, b) => {
        const r = vm.rng();
        if (a === undefined) return [r];
        let lo = 1, hi;
        if (b === undefined) hi = checkInt(a, 1, 'random');
        else { lo = checkInt(a, 1, 'random'); hi = checkInt(b, 2, 'random'); }
        if (lo > hi) throw argErr(b === undefined ? 1 : 2, 'random', 'interval is empty');
        return [lo + Math.floor(r * (hi - lo + 1))];
      },
      randomseed: (s) => { vm.rng = makeRng(Math.trunc(optNum(s, 1, 'randomseed', Date.now()))); },
      huge: Infinity, pi: Math.PI,
    }, 'math'));

    // ---------------------------------------------------------- bit32
    const bu = (v, n, f) => U32(checkNum(v, n, f));
    G.set('bit32', libTable({
      band: (...a) => [a.reduce((r, v, i) => (r & bu(v, i + 1, 'band')) >>> 0, 0xffffffff)],
      bor: (...a) => [a.reduce((r, v, i) => (r | bu(v, i + 1, 'bor')) >>> 0, 0)],
      bxor: (...a) => [a.reduce((r, v, i) => (r ^ bu(v, i + 1, 'bxor')) >>> 0, 0)],
      btest: (...a) => [a.reduce((r, v, i) => (r & bu(v, i + 1, 'btest')) >>> 0, 0xffffffff) !== 0],
      bnot: (x) => [~bu(x, 1, 'bnot') >>> 0],
      lshift: (x, d) => { x = bu(x, 1, 'lshift'); d = checkInt(d, 2, 'lshift'); return [d >= 32 || d <= -32 ? 0 : d >= 0 ? (x << d) >>> 0 : x >>> -d]; },
      rshift: (x, d) => { x = bu(x, 1, 'rshift'); d = checkInt(d, 2, 'rshift'); return [d >= 32 || d <= -32 ? 0 : d >= 0 ? x >>> d : (x << -d) >>> 0]; },
      arshift: (x, d) => { x = bu(x, 1, 'arshift'); d = checkInt(d, 2, 'arshift'); if (d < 0) return [(x << -d) >>> 0]; return [(d >= 32 ? (x & 0x80000000 ? 0xffffffff : 0) : (x | 0) >> d) >>> 0]; },
      lrotate: (x, d) => { x = bu(x, 1, 'lrotate'); d = ((checkInt(d, 2, 'lrotate') % 32) + 32) % 32; return [((x << d) | (x >>> (32 - d))) >>> 0]; },
      rrotate: (x, d) => { x = bu(x, 1, 'rrotate'); d = ((checkInt(d, 2, 'rrotate') % 32) + 32) % 32; return [((x >>> d) | (x << (32 - d))) >>> 0]; },
      extract: (x, f, w) => { x = bu(x, 1, 'extract'); f = checkInt(f, 2, 'extract'); w = w === undefined ? 1 : checkInt(w, 3, 'extract'); if (f < 0 || w <= 0 || f + w > 32) throw new LuaError('trying to access non-existent bits', 1); return [w === 32 ? x : (x >>> f) & ((1 << w) - 1) >>> 0]; },
      replace: (x, v, f, w) => { x = bu(x, 1, 'replace'); v = bu(v, 2, 'replace'); f = checkInt(f, 3, 'replace'); w = w === undefined ? 1 : checkInt(w, 4, 'replace'); if (f < 0 || w <= 0 || f + w > 32) throw new LuaError('trying to access non-existent bits', 1); const m = (w === 32 ? 0xffffffff : ((1 << w) - 1)) >>> 0; return [((x & ~(m << f)) | ((v & m) << f)) >>> 0]; },
      countlz: (x) => [Math.clz32(bu(x, 1, 'countlz'))],
      countrz: (x) => { x = bu(x, 1, 'countrz'); if (x === 0) return [32]; let n = 0; while (!(x & 1)) { x >>>= 1; n++; } return [n]; },
      byteswap: (x) => { x = bu(x, 1, 'byteswap'); return [(((x & 255) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0]; },
    }, 'bit32'));

    // ---------------------------------------------------------- utf8
    const decodeAt = (s, i) => { // returns [codepoint, length] or null
      const c = s.charCodeAt(i);
      if (c < 0x80) return [c, 1];
      let n, cp;
      if (c >= 0xc2 && c < 0xe0) { n = 1; cp = c & 0x1f; } else if (c >= 0xe0 && c < 0xf0) { n = 2; cp = c & 0x0f; } else if (c >= 0xf0 && c < 0xf5) { n = 3; cp = c & 0x07; } else return null;
      for (let k = 1; k <= n; k++) { const d = s.charCodeAt(i + k); if ((d & 0xc0) !== 0x80) return null; cp = (cp << 6) | (d & 0x3f); }
      return [cp, n + 1];
    };
    const utf8char = (cp) => String.fromCodePoint(cp);
    G.set('utf8', libTable({
      char: (...cps) => [cps.map((c, i) => toByteStr(utf8char(checkInt(c, i + 1, 'char')))).join('')],
      charpattern: '[\x00-\x7F\xC2-\xFD][\x80-\xBF]*',
      codes: (s) => {
        if (typeof s !== 'string') throw argErr(1, 'codes', `string expected, got ${typeName(s)}`);
        const it = (str, i) => {
          let p = i === 0 ? 0 : i - 1;
          if (i > 0) { const d = decodeAt(str, p); p += d ? d[1] : 1; }
          if (p >= str.length) return [undefined];
          const d = decodeAt(str, p);
          if (!d) throw new LuaError('invalid UTF-8 code', 1);
          return [p + 1, d[0]];
        };
        return [it, s, 0];
      },
      codepoint: (s, i, j) => {
        i = i === undefined ? 1 : checkInt(i, 2, 'codepoint');
        if (i < 0) i = s.length + i + 1;
        j = j === undefined ? i : checkInt(j, 3, 'codepoint');
        if (j < 0) j = s.length + j + 1;
        const out = [];
        for (let p = i - 1; p < j;) { const d = decodeAt(s, p); if (!d) throw new LuaError('invalid UTF-8 code', 1); out.push(d[0]); p += d[1]; }
        return out;
      },
      len: (s, i, j) => {
        i = i === undefined ? 1 : checkInt(i, 2, 'len');
        if (i < 0) i = Math.max(1, s.length + i + 1);
        j = j === undefined ? -1 : checkInt(j, 3, 'len');
        if (j < 0) j = s.length + j + 1;
        let n = 0;
        for (let p = i - 1; p < j;) { const d = decodeAt(s, p); if (!d) return [undefined, p + 1]; p += d[1]; n++; }
        return [n];
      },
      offset: (s, n, i) => {
        n = checkInt(n, 2, 'offset');
        i = i === undefined ? (n >= 0 ? 1 : s.length + 1) : checkInt(i, 3, 'offset');
        if (i < 0) i = s.length + i + 1;
        let p = i - 1;
        const cont = (k) => (s.charCodeAt(k) & 0xc0) === 0x80;
        if (n === 0) { while (p > 0 && cont(p)) p--; return [p + 1]; }
        if (cont(p)) throw new LuaError('initial position is a continuation byte', 1);
        if (n < 0) { while (n < 0 && p > 0) { do p--; while (p > 0 && cont(p)); n++; } }
        else { n--; while (n > 0 && p < s.length) { do p++; while (cont(p)); n--; } }
        return n === 0 ? [p + 1] : [undefined];
      },
      graphemes: (s) => G.get('utf8').get('codes')(s),
      nfcnormalize: (s) => [toByteStr(fromByteStr(s).normalize('NFC'))],
      nfdnormalize: (s) => [toByteStr(fromByteStr(s).normalize('NFD'))],
    }, 'utf8'));

    // ---------------------------------------------------------- os
    const t0 = performance.now();
    G.set('os', libTable({
      time: (t) => {
        if (t instanceof LuaTable) {
          const g = (k, d) => { const v = t.get(k); return v === undefined ? d : Number(v); };
          return [Math.floor(new Date(g('year', 1970), g('month', 1) - 1, g('day', 1), g('hour', 12), g('min', 0), g('sec', 0)).getTime() / 1000)];
        }
        return [Math.floor(Date.now() / 1000)];
      },
      clock: () => [(performance.now() - t0) / 1000],
      difftime: (a, b) => [checkNum(a, 1, 'difftime') - optNum(b, 2, 'difftime', 0)],
      date: (fmt, t) => {
        fmt = fmt === undefined ? '%c' : String(fmt);
        const d = new Date(t === undefined ? Date.now() : checkNum(t, 2, 'date') * 1000);
        let utc = false;
        if (fmt[0] === '!') { utc = true; fmt = fmt.slice(1); }
        if (fmt.startsWith('*t')) {
          const g = (m) => (utc ? d[`getUTC${m}`]() : d[`get${m}`]());
          const r = new LuaTable();
          const start = utc ? Date.UTC(g('FullYear'), 0, 1) : new Date(g('FullYear'), 0, 1).getTime();
          for (const [k, v] of [['year', g('FullYear')], ['month', g('Month') + 1], ['day', g('Date')], ['hour', g('Hours')], ['min', g('Minutes')], ['sec', g('Seconds')], ['wday', g('Day') + 1], ['yday', Math.floor((d - start) / 864e5) + 1], ['isdst', false]]) r.set(k, v);
          return [r];
        }
        return [toByteStr(strftime(fmt, d, utc))];
      },
    }, 'os'));

    // ---------------------------------------------------------- coroutine
    G.set('coroutine', libTable({
      create: (f) => { if (typeof f !== 'function') throw argErr(1, 'create', 'function expected'); return [new Coroutine(f)]; },
      resume: (co, ...args) => { if (!(co instanceof Coroutine)) throw argErr(1, 'resume', 'coroutine expected'); const r = resume(co, args); return r.length > 2 && !r[0] ? [false, r[1]] : r; },
      yield: coYield,
      status: (co) => { if (!(co instanceof Coroutine)) throw argErr(1, 'status', 'coroutine expected'); return [co.status]; },
      running: () => [R.current, false],
      isyieldable: () => [!!R.current && !R.noYield],
      wrap: (f) => {
        if (typeof f !== 'function') throw argErr(1, 'wrap', 'function expected');
        const co = new Coroutine(f);
        const w = (...args) => {
          const r = resume(co, args);
          if (!r[0]) { const e = r[2] instanceof LuaError ? r[2] : new LuaError(r[1], 0); e.positioned = true; throw e; }
          return r.slice(1);
        };
        w.$co = co;
        return [w];
      },
      close: (co) => close(co),
    }, 'coroutine'));

    // ---------------------------------------------------------- buffer
    const rd = (name, size, fn) => [name, (b, off) => { checkBuf(b, 1, name); off = checkInt(off, 2, name); bufRange(b, off, size); return [fn(b.dv, off)]; }];
    const wr = (name, size, fn) => [name, (b, off, v) => { checkBuf(b, 1, name); off = checkInt(off, 2, name); bufRange(b, off, size); fn(b.dv, off, checkNum(v, 3, name)); }];
    G.set('buffer', libTable({
      create: (n) => { n = checkInt(n, 1, 'create'); if (n < 0 || n > 1073741824) throw argErr(1, 'create', 'size out of range'); return [new LuaBuffer(n)]; },
      fromstring: (s) => { const b = new LuaBuffer(s.length); for (let i = 0; i < s.length; i++) b.u8[i] = s.charCodeAt(i); return [b]; },
      tostring: (b) => { checkBuf(b, 1, 'tostring'); return [RT.strOfBytes(b.u8)]; },
      len: (b) => [checkBuf(b, 1, 'len').u8.length],
      ...Object.fromEntries([
        rd('readi8', 1, (d, o) => d.getInt8(o)), rd('readu8', 1, (d, o) => d.getUint8(o)),
        rd('readi16', 2, (d, o) => d.getInt16(o, true)), rd('readu16', 2, (d, o) => d.getUint16(o, true)),
        rd('readi32', 4, (d, o) => d.getInt32(o, true)), rd('readu32', 4, (d, o) => d.getUint32(o, true)),
        rd('readf32', 4, (d, o) => d.getFloat32(o, true)), rd('readf64', 8, (d, o) => d.getFloat64(o, true)),
        wr('writei8', 1, (d, o, v) => d.setInt8(o, v)), wr('writeu8', 1, (d, o, v) => d.setUint8(o, v)),
        wr('writei16', 2, (d, o, v) => d.setInt16(o, v, true)), wr('writeu16', 2, (d, o, v) => d.setUint16(o, v, true)),
        wr('writei32', 4, (d, o, v) => d.setInt32(o, v, true)), wr('writeu32', 4, (d, o, v) => d.setUint32(o, v, true)),
        wr('writef32', 4, (d, o, v) => d.setFloat32(o, v, true)), wr('writef64', 8, (d, o, v) => d.setFloat64(o, v, true)),
      ]),
      readstring: (b, off, n) => { checkBuf(b, 1, 'readstring'); off = checkInt(off, 2, 'readstring'); n = checkInt(n, 3, 'readstring'); bufRange(b, off, n); return [RT.strOfBytes(b.u8.subarray(off, off + n))]; },
      writestring: (b, off, s, n) => {
        checkBuf(b, 1, 'writestring'); off = checkInt(off, 2, 'writestring');
        n = n === undefined ? s.length : checkInt(n, 4, 'writestring');
        bufRange(b, off, n);
        for (let i = 0; i < n; i++) b.u8[off + i] = s.charCodeAt(i);
      },
      copy: (t, toff, s, soff, n) => {
        checkBuf(t, 1, 'copy'); checkBuf(s, 3, 'copy');
        soff = soff === undefined ? 0 : checkInt(soff, 4, 'copy');
        n = n === undefined ? s.u8.length - soff : checkInt(n, 5, 'copy');
        toff = checkInt(toff, 2, 'copy');
        bufRange(s, soff, n); bufRange(t, toff, n);
        t.u8.set(s.u8.slice(soff, soff + n), toff);
      },
      fill: (b, off, v, n) => {
        checkBuf(b, 1, 'fill'); off = checkInt(off, 2, 'fill');
        n = n === undefined ? b.u8.length - off : checkInt(n, 4, 'fill');
        bufRange(b, off, n); b.u8.fill(checkInt(v, 3, 'fill') & 255, off, off + n);
      },
    }, 'buffer'));

    // ---------------------------------------------------------- debug
    G.set('debug', libTable({
      traceback: (msg, level) => {
        if (msg instanceof Coroutine) msg = level;
        const e = vm.lastError;
        let s = msg === undefined ? '' : tostr(msg) + '\n';
        if (e && e.trace) s += e.trace.map(([c, l]) => `${c}:${l}`).join('\n');
        return [s];
      },
      info: (f, what) => {
        if (typeof f !== 'function') { if (typeof what === 'string' && what.includes('s')) return ['[C]', -1]; return [undefined]; }
        const out = [];
        for (const ch of String(what || 'sln')) {
          if (ch === 's') out.push(f.$builtin ? '[C]' : RT.toByteStr(String(f.$chunk || '[string]')));
          else if (ch === 'l') out.push(f.$line ?? -1);
          else if (ch === 'n') out.push(f.$name || undefined);
          else if (ch === 'a') out.push(f.length, true);
          else if (ch === 'f') out.push(f);
        }
        return out;
      },
      profilebegin: () => {}, profileend: () => {}, setmemorycategory: () => {}, resetmemorycategory: () => {},
      dumpheap: () => {}, getmemorycategory: () => ['main'],
    }, 'debug'));
  }
}

export { LuaTable, LuaError, EMPTY, R, tostr, toByteStr, fromByteStr, RT };
