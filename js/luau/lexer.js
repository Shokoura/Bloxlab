// Luau lexer. Produces tokens { t: type, v: value, line }.
// Types: 'name', 'kw', 'num', 'str', 'interp', 'op', 'eof'.
// String values are "byte strings" (one JS char per UTF-8 byte), the runtime's string representation.

export const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

const OPS3 = ['...', '//=', '..='];
const OPS2 = ['==', '~=', '<=', '>=', '..', '::', '->', '+=', '-=', '*=', '/=', '%=', '^=', '//'];
const OPS1 = '+-*/%^#&~|<>=(){}[];:,.@?';

export class LuauSyntaxError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

const enc = new TextEncoder();
/** Convert a JS (UTF-16) string to a byte string. */
export function toByteString(s) {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(s)) return s;
  const b = enc.encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 0x4000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x4000));
  return out;
}
function utf8Bytes(cp) {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 63));
  if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
}

export function tokenize(src, lineOffset = 0) {
  const toks = [];
  let i = 0;
  let line = 1 + lineOffset;
  const n = src.length;
  const err = (m) => { throw new LuauSyntaxError(m, line); };
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

  // [[ ... ]] / [==[ ... ]==] ; returns content or null if not a long bracket
  const longBracket = () => {
    let j = i + 1, level = 0;
    while (src[j] === '=') { level++; j++; }
    if (src[j] !== '[') return null;
    const close = ']' + '='.repeat(level) + ']';
    const end = src.indexOf(close, j + 1);
    if (end < 0) err('unfinished long string/comment');
    let body = src.slice(j + 1, end);
    for (const c of body) if (c === '\n') line++;
    if (body.startsWith('\r\n')) body = body.slice(2); else if (body[0] === '\n' || body[0] === '\r') body = body.slice(1);
    i = end + close.length;
    return body;
  };

  const readEscape = () => { // after the backslash
    const c = src[i];
    switch (c) {
      case 'n': i++; return '\n';
      case 't': i++; return '\t';
      case 'r': i++; return '\r';
      case 'a': i++; return '\x07';
      case 'b': i++; return '\b';
      case 'f': i++; return '\f';
      case 'v': i++; return '\v';
      case '\\': i++; return '\\';
      case '"': i++; return '"';
      case "'": i++; return "'";
      case '`': i++; return '`';
      case '{': i++; return '{';
      case '}': i++; return '}';
      case '\n': i++; line++; return '\n';
      case '\r': i++; if (src[i] === '\n') i++; line++; return '\n';
      case 'x': {
        const h = src.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) err('invalid hexadecimal escape');
        i += 3; return String.fromCharCode(parseInt(h, 16));
      }
      case 'z': {
        i++;
        while (i < n && /\s/.test(src[i])) { if (src[i] === '\n') line++; i++; }
        return '';
      }
      case 'u': {
        if (src[i + 1] !== '{') err('invalid unicode escape');
        const end = src.indexOf('}', i);
        const cp = parseInt(src.slice(i + 2, end), 16);
        if (!Number.isFinite(cp) || cp > 0x10ffff) err('invalid unicode escape');
        i = end + 1; return utf8Bytes(cp);
      }
      default:
        if (isDigit(c)) {
          let d = '';
          while (d.length < 3 && isDigit(src[i])) d += src[i++];
          const v = +d;
          if (v > 255) err('decimal escape too large');
          return String.fromCharCode(v);
        }
        err('invalid escape sequence \\' + c);
    }
    return '';
  };

  // reads raw source chars of a quoted string; converts non-ASCII source chars to UTF-8 bytes
  const pushChar = (out, ch) => {
    const cp = ch.codePointAt(0);
    return out + (cp < 0x80 ? ch : utf8Bytes(cp));
  };

  const readString = (q) => {
    i++;
    let out = '';
    while (true) {
      if (i >= n) err('unfinished string');
      const c = src[i];
      if (c === q) { i++; break; }
      if (c === '\n') err('unfinished string');
      if (c === '\\') { i++; out += readEscape(); continue; }
      const cp = src.codePointAt(i);
      out = pushChar(out, String.fromCodePoint(cp));
      i += cp > 0xffff ? 2 : 1;
    }
    return out;
  };

  // `text {expr} text` -> { parts: [str, {src, line}, str, ...] }
  const readInterp = () => {
    i++;
    const parts = [];
    let cur = '';
    while (true) {
      if (i >= n) err('unfinished interpolated string');
      const c = src[i];
      if (c === '`') { i++; break; }
      if (c === '\n') { line++; cur += '\n'; i++; continue; }
      if (c === '\\') { i++; cur += readEscape(); continue; }
      if (c === '{') {
        if (src[i + 1] === '{') err('double braces are not permitted within interpolated strings; did you mean \'\\{\'?');
        parts.push(cur); cur = '';
        const startLine = line;
        let depth = 1, j = i + 1;
        while (j < n && depth > 0) {
          const d = src[j];
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (!depth) break; }
          else if (d === '"' || d === "'") { const qq = d; j++; while (j < n && src[j] !== qq) { if (src[j] === '\\') j++; j++; } }
          else if (d === '`') { j++; let dd = 0; while (j < n && !(src[j] === '`' && dd === 0)) { if (src[j] === '\\') j++; else if (src[j] === '{') dd++; else if (src[j] === '}') dd--; j++; } }
          else if (d === '\n') line++;
          j++;
        }
        if (depth) err('unfinished interpolated string');
        parts.push({ src: src.slice(i + 1, j), line: startLine });
        i = j + 1;
        continue;
      }
      const cp = src.codePointAt(i);
      cur = pushChar(cur, String.fromCodePoint(cp));
      i += cp > 0xffff ? 2 : 1;
    }
    parts.push(cur);
    return parts;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      if (src[i] === '[') { const s = longBracket(); if (s !== null) continue; }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const startLine = line;
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && (isAlpha(src[j]) || isDigit(src[j]))) j++;
      const w = src.slice(i, j);
      toks.push({ t: KEYWORDS.has(w) ? 'kw' : 'name', v: w, line: startLine });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      let v;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j += 2; while (/[0-9a-fA-F_]/.test(src[j] || '')) j++;
        v = parseInt(src.slice(i + 2, j).replace(/_/g, ''), 16);
      } else if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        j += 2; while (/[01_]/.test(src[j] || '')) j++;
        v = parseInt(src.slice(i + 2, j).replace(/_/g, ''), 2);
      } else {
        while (/[0-9_]/.test(src[j] || '')) j++;
        if (src[j] === '.' && src[j + 1] !== '.') { j++; while (/[0-9_]/.test(src[j] || '')) j++; }
        if (src[j] === 'e' || src[j] === 'E') { j++; if (src[j] === '+' || src[j] === '-') j++; while (/[0-9]/.test(src[j] || '')) j++; }
        v = Number(src.slice(i, j).replace(/_/g, ''));
      }
      if (Number.isNaN(v) || isAlpha(src[j] || '')) err('malformed number near \'' + src.slice(i, j + 1) + '\'');
      toks.push({ t: 'num', v, line: startLine });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") { toks.push({ t: 'str', v: readString(c), line: startLine }); continue; }
    if (c === '`') { toks.push({ t: 'interp', v: readInterp(), line: startLine }); continue; }
    if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
      const s = longBracket();
      if (s !== null) { toks.push({ t: 'str', v: toByteString(s), line: startLine }); continue; }
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) { toks.push({ t: 'op', v: three, line }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { toks.push({ t: 'op', v: two, line }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ t: 'op', v: c, line }); i++; continue; }
    err(`unexpected symbol '${c}'`);
  }
  toks.push({ t: 'eof', v: '<eof>', line });
  return toks;
}
