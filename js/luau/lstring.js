// Lua string library: patterns (port of lstrlib.c), string.format and friends.
// Strings are byte strings (charCodeAt(i) is a byte).
import { LuaError, LuaTable, EMPTY, runSync, tostr, numToStr, typeName, truthy, mkgen, idx } from './runtime.js';

const MAXCCALLS = 200;
const CAP_UNFINISHED = -1;
const CAP_POSITION = -2;
const L_ESC = 37; // '%'
const SPECIALS = /[\^$*+?.()[\]%-]/;

const isalpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isdigit = (c) => c >= 48 && c <= 57;
const islower = (c) => c >= 97 && c <= 122;
const isupper = (c) => c >= 65 && c <= 90;
const isspace = (c) => c === 32 || (c >= 9 && c <= 13);
const iscntrl = (c) => c < 32 || c === 127;
const isgraph = (c) => c > 32 && c < 127;
const ispunct = (c) => isgraph(c) && !isalpha(c) && !isdigit(c);
const isalnum = (c) => isalpha(c) || isdigit(c);
const isxdigit = (c) => isdigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);

function matchClass(c, cl) {
  let res;
  switch (cl | 0x20) {
    case 97: res = isalpha(c); break; // a
    case 99: res = iscntrl(c); break; // c
    case 100: res = isdigit(c); break; // d
    case 103: res = isgraph(c); break; // g
    case 108: res = islower(c); break; // l
    case 112: res = ispunct(c); break; // p
    case 115: res = isspace(c); break; // s
    case 117: res = isupper(c); break; // u
    case 119: res = isalnum(c); break; // w
    case 120: res = isxdigit(c); break; // x
    default: return cl === c;
  }
  return isupper(cl) ? !res : res;
}

class MatchState {
  constructor(src, pat) {
    this.src = src; this.pat = pat; this.level = 0; this.capture = []; this.matchdepth = MAXCCALLS;
    this.slen = src.length; this.plen = pat.length;
  }
  s(i) { return this.src.charCodeAt(i); }
  p(i) { return this.pat.charCodeAt(i); }
}

function classEnd(ms, p) {
  if (p >= ms.plen) throw new LuaError('malformed pattern (ends with \'%\')', 1);
  const c = ms.p(p++);
  if (c === L_ESC) {
    if (p >= ms.plen) throw new LuaError('malformed pattern (ends with \'%\')', 1);
    return p + 1;
  }
  if (c === 91) { // '['
    if (ms.p(p) === 94) p++;
    do {
      if (p >= ms.plen) throw new LuaError('malformed pattern (missing \']\')', 1);
      const cc = ms.p(p++);
      if (cc === L_ESC && p < ms.plen) p++;
    } while (ms.p(p) !== 93);
    return p + 1;
  }
  return p;
}

function matchBracketClass(ms, c, p, ec) {
  let sig = true;
  if (ms.p(p + 1) === 94) { sig = false; p++; }
  while (++p < ec) {
    const pc = ms.p(p);
    if (pc === L_ESC) { p++; if (matchClass(c, ms.p(p))) return sig; }
    else if (ms.p(p + 1) === 45 && p + 2 < ec) { // range a-z
      p += 2;
      if (pc <= c && c <= ms.p(p)) return sig;
    } else if (pc === c) return sig;
  }
  return !sig;
}

function singleMatch(ms, s, p, ep) {
  if (s >= ms.slen) return false;
  const c = ms.s(s);
  const pc = ms.p(p);
  switch (pc) {
    case 46: return true; // '.'
    case L_ESC: return matchClass(c, ms.p(p + 1));
    case 91: return matchBracketClass(ms, c, p, ep - 1);
    default: return pc === c;
  }
}

function matchBalance(ms, s, p) {
  if (p + 1 >= ms.plen) throw new LuaError('malformed pattern (missing arguments to \'%b\')', 1);
  if (s >= ms.slen || ms.s(s) !== ms.p(p)) return -1;
  const b = ms.p(p), e = ms.p(p + 1);
  let cont = 1;
  while (++s < ms.slen) {
    const c = ms.s(s);
    if (c === e) { if (--cont === 0) return s + 1; }
    else if (c === b) cont++;
  }
  return -1;
}

function maxExpand(ms, s, p, ep) {
  let i = 0;
  while (singleMatch(ms, s + i, p, ep)) i++;
  while (i >= 0) {
    const res = doMatch(ms, s + i, ep + 1);
    if (res !== -1) return res;
    i--;
  }
  return -1;
}

function minExpand(ms, s, p, ep) {
  for (;;) {
    const res = doMatch(ms, s, ep + 1);
    if (res !== -1) return res;
    if (singleMatch(ms, s, p, ep)) s++;
    else return -1;
  }
}

function startCapture(ms, s, p, what) {
  ms.capture[ms.level] = { init: s, len: what };
  ms.level++;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.level--;
  return res;
}

function captureToClose(ms) {
  let level = ms.level;
  for (level--; level >= 0; level--) if (ms.capture[level].len === CAP_UNFINISHED) return level;
  throw new LuaError('invalid pattern capture', 1);
}

function endCapture(ms, s, p) {
  const l = captureToClose(ms);
  ms.capture[l].len = s - ms.capture[l].init;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.capture[l].len = CAP_UNFINISHED;
  return res;
}

function checkCapture(ms, l) {
  l -= 49; // '1'
  if (l < 0 || l >= ms.level || ms.capture[l].len === CAP_UNFINISHED) throw new LuaError(`invalid capture index %${l + 1}`, 1);
  return l;
}

function matchCapture(ms, s, l) {
  l = checkCapture(ms, l);
  const len = ms.capture[l].len;
  const cap = ms.src.substr(ms.capture[l].init, len);
  if (ms.slen - s >= len && ms.src.substr(s, len) === cap) return s + len;
  return -1;
}

function doMatch(ms, s, p) {
  if (ms.matchdepth-- === 0) throw new LuaError('pattern too complex', 1);
  try {
    for (;;) {
      if (p === ms.plen) return s;
      const pc = ms.p(p);
      switch (pc) {
        case 40: // '('
          if (ms.p(p + 1) === 41) return startCapture(ms, s, p + 2, CAP_POSITION);
          return startCapture(ms, s, p + 1, CAP_UNFINISHED);
        case 41: return endCapture(ms, s, p + 1); // ')'
        case 36: // '$'
          if (p + 1 === ms.plen) return s === ms.slen ? s : -1;
          break;
        case L_ESC: {
          const nc = ms.p(p + 1);
          if (nc === 98) { // b
            s = matchBalance(ms, s, p + 2);
            if (s !== -1) { p += 4; continue; }
            return -1;
          }
          if (nc === 102) { // f
            p += 2;
            if (ms.p(p) !== 91) throw new LuaError('missing \'[\' after \'%f\' in pattern', 1);
            const ep = classEnd(ms, p);
            const prev = s === 0 ? 0 : ms.s(s - 1);
            const cur = s < ms.slen ? ms.s(s) : 0;
            if (!matchBracketClass(ms, prev, p, ep - 1) && matchBracketClass(ms, cur, p, ep - 1)) { p = ep; continue; }
            return -1;
          }
          if (isdigit(nc)) {
            s = matchCapture(ms, s, nc);
            if (s !== -1) { p += 2; continue; }
            return -1;
          }
          break;
        }
        default: break;
      }
      // default: single char class + optional suffix
      const ep = classEnd(ms, p);
      const epc = ep < ms.plen ? ms.p(ep) : 0;
      if (!singleMatch(ms, s, p, ep)) {
        if (epc === 42 || epc === 63 || epc === 45) { p = ep + 1; continue; } // * ? -
        return -1;
      }
      switch (epc) {
        case 63: { // ?
          const res = doMatch(ms, s + 1, ep + 1);
          if (res !== -1) return res;
          p = ep + 1; continue;
        }
        case 43: return maxExpand(ms, s + 1, p, ep); // +
        case 42: return maxExpand(ms, s, p, ep); // *
        case 45: return minExpand(ms, s, p, ep); // -
        default: s++; p = ep; continue;
      }
    }
  } finally { ms.matchdepth++; }
}

function getOneCapture(ms, i, s, e) {
  if (i >= ms.level) {
    if (i === 0) return ms.src.slice(s, e);
    throw new LuaError(`invalid capture index %${i + 1}`, 1);
  }
  const { init, len } = ms.capture[i];
  if (len === CAP_UNFINISHED) throw new LuaError('unfinished capture', 1);
  if (len === CAP_POSITION) return init + 1;
  return ms.src.substr(init, len);
}
function getCaptures(ms, s, e, wholeIfNone) {
  const n = ms.level === 0 && wholeIfNone ? 1 : ms.level;
  const out = [];
  for (let i = 0; i < n; i++) out.push(getOneCapture(ms, i, s, e));
  return out;
}

const str = (v, n, fname) => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numToStr(v);
  throw new LuaError(`invalid argument #${n} to '${fname}' (string expected, got ${typeName(v)})`, 1);
};
const int = (v, n, fname, def) => {
  if (v === undefined && def !== undefined) return def;
  let x = v;
  if (typeof x === 'string') x = Number(x);
  if (typeof x !== 'number' || Number.isNaN(x)) throw new LuaError(`invalid argument #${n} to '${fname}' (number expected, got ${typeName(v)})`, 1);
  return Math.trunc(x);
};
const posrelat = (pos, len) => (pos >= 0 ? pos : -pos > len ? 0 : len + pos + 1);

function strFindAux(find, s, p, init, plain) {
  const ls = s.length;
  init = posrelat(init ?? 1, ls);
  if (init < 1) init = 1;
  if (init > ls + 1) return [undefined];
  if (find && (truthy(plain) || !SPECIALS.test(p))) {
    const i = s.indexOf(p, init - 1);
    return i < 0 ? [undefined] : [i + 1, i + p.length];
  }
  const ms = new MatchState(s, p);
  let pi = 0;
  const anchor = p.charCodeAt(0) === 94;
  if (anchor) pi = 1;
  let si = init - 1;
  do {
    ms.level = 0; ms.matchdepth = MAXCCALLS;
    const e = doMatch(ms, si, pi);
    if (e !== -1) {
      if (find) return [si + 1, e, ...getCaptures(ms, null, null, false)];
      return getCaptures(ms, si, e, true);
    }
    si++;
  } while (si <= ls && !anchor);
  return [undefined];
}

function gmatch(s, p) {
  s = str(s, 1, 'gmatch'); p = str(p, 2, 'gmatch');
  let si = 0, lastMatch = -1;
  const ms = new MatchState(s, p);
  const anchor = p.charCodeAt(0) === 94;
  const pi = anchor ? 1 : 0;
  const it = () => {
    for (; si <= s.length; si++) {
      ms.level = 0; ms.matchdepth = MAXCCALLS;
      const e = doMatch(ms, si, pi);
      if (e !== -1 && e !== lastMatch) {
        const start = si;
        si = lastMatch = e;
        return getCaptures(ms, start, e, true);
      }
      if (anchor) { si = s.length + 1; break; }
    }
    return [undefined];
  };
  it.$name = 'gmatch_iterator';
  return [it];
}

function addValue(ms, b, s, e, repl, tr) {
  let value;
  if (tr === 'function') {
    const caps = getCaptures(ms, s, e, true);
    value = runSync(repl, caps)[0];
  } else if (tr === 'table') {
    const k = getOneCapture(ms, 0, s, e);
    value = idx(repl, k);
  } else {
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      const c = repl.charCodeAt(i);
      if (c === L_ESC) {
        i++;
        const d = repl.charCodeAt(i);
        if (d === L_ESC) out += '%';
        else if (isdigit(d)) {
          if (d === 48) out += ms.src.slice(s, e);
          else { const cap = getOneCapture(ms, d - 49, s, e); out += typeof cap === 'number' ? numToStr(cap) : cap; }
        } else throw new LuaError('invalid use of \'%\' in replacement string', 1);
      } else out += repl[i];
    }
    return out;
  }
  if (value === undefined || value === false) return ms.src.slice(s, e);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numToStr(value);
  throw new LuaError(`invalid replacement value (a ${typeName(value)})`, 1);
}

function gsub(s, p, repl, maxN) {
  s = str(s, 1, 'gsub'); p = str(p, 2, 'gsub');
  const tr = typeof repl === 'number' ? 'string' : typeof repl === 'string' ? 'string' : typeof repl === 'function' ? 'function' : repl instanceof LuaTable ? 'table' : null;
  if (!tr) throw new LuaError(`invalid argument #3 to 'gsub' (string/function/table expected, got ${typeName(repl)})`, 1);
  if (typeof repl === 'number') repl = numToStr(repl);
  const maxS = maxN === undefined ? s.length + 1 : int(maxN, 4, 'gsub');
  const anchor = p.charCodeAt(0) === 94;
  const pi = anchor ? 1 : 0;
  const ms = new MatchState(s, p);
  let si = 0, n = 0, out = '';
  while (n < maxS) {
    ms.level = 0; ms.matchdepth = MAXCCALLS;
    const e = doMatch(ms, si, pi);
    if (e !== -1) { n++; out += addValue(ms, out, si, e, repl, tr); }
    if (e !== -1 && e > si) si = e;
    else if (si < s.length) out += s[si++];
    else break;
    if (anchor) break;
  }
  if (si < s.length) out += s.slice(si);
  return [out, n];
}

// ---------------------------------------------------------------- string.format
function fmtExp(x, prec, upper) {
  let s = x.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}
function fmtG(x, prec, alt, upper) {
  if (prec === 0) prec = 1;
  if (x === 0) return alt ? (0).toFixed(prec - 1) : '0';
  const ex = Number(x.toExponential(prec - 1).split('e')[1]);
  let s;
  if (ex < -4 || ex >= prec) {
    s = x.toExponential(prec - 1);
    if (!alt) s = s.replace(/\.?0+e/, 'e');
    s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  } else {
    s = x.toFixed(Math.max(0, prec - 1 - ex));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return upper ? s.toUpperCase() : s;
}
function quoteString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += '\\\\';
    else if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 0) out += (isdigit(s.charCodeAt(i + 1)) ? '\\000' : '\\0');
    else if (iscntrl(c)) out += '\\' + (isdigit(s.charCodeAt(i + 1)) ? String(c).padStart(3, '0') : c);
    else out += s[i];
  }
  return out + '"';
}

export function format(fmt, ...args) {
  fmt = str(fmt, 1, 'format');
  let out = '';
  let argi = 0;
  const re = /%([-+ #0]*)(\d*)(?:\.(\d*))?([diouxXeEfFgGqscaA%*])/y;
  for (let i = 0; i < fmt.length;) {
    const c = fmt[i];
    if (c !== '%') { const j = fmt.indexOf('%', i); const end = j < 0 ? fmt.length : j; out += fmt.slice(i, end); i = end; continue; }
    re.lastIndex = i;
    const m = re.exec(fmt);
    if (!m) throw new LuaError(`invalid conversion '${fmt.slice(i, i + 5)}' to 'format'`, 1);
    i = re.lastIndex;
    const [, flags, width, precS, conv] = m;
    if (conv === '%') { out += '%'; continue; }
    const argn = argi + 2;
    if (argi >= args.length && conv !== '%') throw new LuaError(`bad argument #${argn} to 'format' (${conv === 's' || conv === '*' ? 'value' : 'number'} expected, got no value)`, 1);
    const v = args[argi++];
    const prec = precS === undefined ? undefined : precS === '' ? 0 : Number(precS);
    const num = () => {
      let x = v;
      if (typeof x === 'string') { const n = Number(x.trim()); if (x.trim() !== '' && !Number.isNaN(n)) x = n; }
      if (typeof x !== 'number') throw new LuaError(`invalid argument #${argn} to 'format' (number expected, got ${typeName(v)})`, 1);
      return x;
    };
    let s;
    switch (conv) {
      case 'd': case 'i': {
        const x = num();
        if (!Number.isFinite(x)) { s = numToStr(x); break; }
        const n = Math.trunc(x);
        s = String(Math.abs(n));
        if (prec !== undefined) s = s.padStart(prec, '0');
        if (n < 0 || Object.is(n, -0) && false) s = '-' + s;
        else if (flags.includes('+')) s = '+' + s;
        else if (flags.includes(' ')) s = ' ' + s;
        break;
      }
      case 'u': s = String(Math.trunc(num()) >>> 0); break;
      case 'o': s = (BigInt.asUintN(64, BigInt(Math.trunc(num())))).toString(8); if (flags.includes('#')) s = '0' + s; break;
      case 'x': case 'X': {
        const x = Math.trunc(num());
        s = (x < 0 ? BigInt.asUintN(64, BigInt(x)) : BigInt(x)).toString(16);
        if (prec !== undefined) s = s.padStart(prec, '0');
        if (flags.includes('#') && x !== 0) s = '0x' + s;
        if (conv === 'X') s = s.toUpperCase();
        break;
      }
      case 'c': s = String.fromCharCode(Math.trunc(num()) & 255); break;
      case 'e': case 'E': { const x = num(); s = Number.isFinite(x) ? fmtExp(x, prec ?? 6, conv === 'E') : numToStr(x); break; }
      case 'f': case 'F': {
        const x = num();
        if (!Number.isFinite(x)) { s = numToStr(x); break; }
        s = Math.abs(x) < 1e21 ? x.toFixed(prec ?? 6) : BigInt(Math.round(x)).toString() + ((prec ?? 6) > 0 ? '.' + '0'.repeat(prec ?? 6) : '');
        if (x >= 0 && flags.includes('+')) s = '+' + s; else if (x >= 0 && flags.includes(' ')) s = ' ' + s;
        break;
      }
      case 'g': case 'G': {
        const x = num();
        s = Number.isFinite(x) ? fmtG(x, prec ?? 6, flags.includes('#'), conv === 'G') : numToStr(x);
        if (x >= 0 && flags.includes('+')) s = '+' + s;
        break;
      }
      case 'a': case 'A': { const x = num(); s = x.toString(16); break; }
      case 'q': {
        if (typeof v === 'string') s = quoteString(v);
        else if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : v === Infinity ? '1e9999' : v === -Infinity ? '-1e9999' : v !== v ? '(0/0)' : String(v);
        else if (v === undefined || typeof v === 'boolean') s = tostr(v);
        else throw new LuaError('value has no literal form', 1);
        break;
      }
      case 's': case '*': {
        s = tostr(v);
        if (prec !== undefined && conv === 's') s = s.slice(0, prec);
        break;
      }
      default: throw new LuaError(`invalid conversion '%${conv}' to 'format'`, 1);
    }
    const w = width ? Number(width) : 0;
    if (s.length < w) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && 'diouxXeEfFgG'.includes(conv) && !/[a-z]{3}/i.test(s)) {
        const sign = /^[-+ ]/.test(s) ? s[0] : '';
        const pre = /^[-+ ]?0[xX]/.test(s) ? s.slice(sign.length, sign.length + 2) : '';
        const body = s.slice(sign.length + pre.length);
        s = sign + pre + body.padStart(w - sign.length - pre.length, '0');
      } else s = s.padStart(w);
    }
    out += s;
  }
  return out;
}

// ---------------------------------------------------------------- library
export function makeStringLib(mkTable) {
  const lib = {
    len: (s) => [str(s, 1, 'len').length],
    sub: (s, i, j) => {
      s = str(s, 1, 'sub');
      const l = s.length;
      let a = posrelat(int(i, 2, 'sub', 1), l);
      let b = posrelat(int(j, 3, 'sub', -1), l);
      if (a < 1) a = 1;
      if (b > l) b = l;
      return [a > b ? '' : s.slice(a - 1, b)];
    },
    upper: (s) => [str(s, 1, 'upper').replace(/[a-z]+/g, (m) => m.toUpperCase())],
    lower: (s) => [str(s, 1, 'lower').replace(/[A-Z]+/g, (m) => m.toLowerCase())],
    rep: (s, n, sep) => {
      s = str(s, 1, 'rep'); n = int(n, 2, 'rep');
      if (n <= 0) return [''];
      const total = (s.length + (sep ? sep.length : 0)) * n;
      if (total > 1e9) throw new LuaError('resulting string too large', 1);
      if (sep === undefined || sep === '') return [s.repeat(n)];
      return [Array(n).fill(s).join(str(sep, 3, 'rep'))];
    },
    reverse: (s) => [str(s, 1, 'reverse').split('').reverse().join('')],
    byte: (s, i, j) => {
      s = str(s, 1, 'byte');
      const l = s.length;
      const a0 = int(i, 2, 'byte', 1);
      let a = posrelat(a0, l);
      let b = posrelat(int(j, 3, 'byte', a0 < 0 ? a0 : a), l);
      if (j === undefined) b = a;
      if (a < 1) a = 1;
      if (b > l) b = l;
      const out = [];
      for (let k = a; k <= b; k++) out.push(s.charCodeAt(k - 1));
      return out;
    },
    char: (...codes) => {
      let out = '';
      codes.forEach((c, i) => {
        const n = int(c, i + 1, 'char');
        if (n < 0 || n > 255) throw new LuaError(`invalid argument #${i + 1} to 'char' (value out of range)`, 1);
        out += String.fromCharCode(n);
      });
      return [out];
    },
    find: (s, p, init, plain) => strFindAux(true, str(s, 1, 'find'), str(p, 2, 'find'), init === undefined ? undefined : int(init, 3, 'find'), plain),
    match: (s, p, init) => strFindAux(false, str(s, 1, 'match'), str(p, 2, 'match'), init === undefined ? undefined : int(init, 3, 'match')),
    gmatch,
    gsub,
    format: (...a) => [format(...a)],
    split: (s, sep) => {
      s = str(s, 1, 'split');
      sep = sep === undefined ? ',' : str(sep, 2, 'split');
      const parts = sep === '' ? s.split('') : s.split(sep);
      return [mkTable(parts)];
    },
    pack: () => { throw new LuaError('string.pack is not supported', 1); },
    packsize: () => { throw new LuaError('string.packsize is not supported', 1); },
    unpack: () => { throw new LuaError('string.unpack is not supported', 1); },
  };
  return lib;
}

export { strFindAux, gsub as stringGsub, EMPTY, mkgen };
