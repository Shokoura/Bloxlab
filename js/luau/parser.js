// Luau parser -> AST. Type annotations are parsed and discarded.
import { tokenize, LuauSyntaxError } from './lexer.js';

const BINPRI = {
  or: [1, 1], and: [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '..': [5, 4], '+': [6, 6], '-': [6, 6], '*': [7, 7], '/': [7, 7], '//': [7, 7], '%': [7, 7],
  '^': [10, 9],
};
const UNARY_PRI = 8;
const COMPOUND = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=']);

export function parse(src, chunkName = 'chunk') {
  const p = new Parser(tokenize(src), chunkName);
  const body = p.block();
  if (p.tok.t !== 'eof') p.error(`Expected <eof>, got '${p.tok.v}'`);
  return body;
}

class Parser {
  constructor(toks, chunk) { this.toks = toks; this.i = 0; this.chunk = chunk; }
  get tok() { return this.toks[this.i]; }
  peek(n = 1) { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }
  next() { return this.toks[this.i++]; }
  error(msg, line = this.tok.line) { throw new LuauSyntaxError(msg, line); }
  is(v) { const t = this.tok; return (t.t === 'op' || t.t === 'kw') && t.v === v; }
  accept(v) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v, ctx) {
    if (!this.is(v)) this.error(`Expected '${v}'${ctx ? ' ' + ctx : ''}, got '${this.tok.t === 'eof' ? '<eof>' : this.tok.v}'`);
    return this.next();
  }
  name() { if (this.tok.t !== 'name') this.error(`Expected identifier, got '${this.tok.v}'`); return this.next().v; }

  blockEnd() { const t = this.tok; return t.t === 'eof' || (t.t === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif' || t.v === 'until')); }

  block() {
    const stats = [];
    const line = this.tok.line;
    while (!this.blockEnd()) {
      if (this.accept(';')) continue;
      if (this.is('return')) {
        const l = this.next().line;
        const exprs = this.blockEnd() || this.is(';') ? [] : this.exprList();
        this.accept(';');
        stats.push({ k: 'Return', exprs, line: l });
        break;
      }
      const s = this.statement();
      if (s) stats.push(s);
    }
    return { stats, line };
  }

  statement() {
    const t = this.tok;
    const line = t.line;
    if (t.t === 'op' && t.v === '@') { this.skipAttributes(); return this.statement(); }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'local': {
          this.next();
          if (this.is('@')) this.skipAttributes();
          if (this.accept('function')) {
            const name = this.name();
            return { k: 'LocalFunction', name, func: this.funcBody(name, line), line };
          }
          const names = [], attrs = [];
          do {
            names.push(this.name());
            if (this.accept('<')) { attrs.push(this.name()); this.expect('>'); } else attrs.push(null);
            if (this.accept(':')) this.type();
          } while (this.accept(','));
          const exprs = this.accept('=') ? this.exprList() : [];
          return { k: 'Local', names, attrs, exprs, line };
        }
        case 'function': {
          this.next();
          let target = { k: 'Name', name: this.name(), line };
          let fname = target.name;
          let method = null;
          while (this.is('.') || this.is(':')) {
            const dot = this.next().v === '.';
            const key = this.name();
            fname += (dot ? '.' : ':') + key;
            if (dot) target = { k: 'Index', obj: target, key: { k: 'Str', v: key }, line };
            else { method = key; break; }
          }
          const func = this.funcBody(fname, line, !!method);
          if (method) target = { k: 'Index', obj: target, key: { k: 'Str', v: method }, line };
          return { k: 'Function', target, func, line };
        }
        case 'do': { this.next(); const body = this.block(); this.expect('end', 'to close \'do\''); return { k: 'Do', body, line }; }
        case 'while': {
          this.next(); const cond = this.expr(); this.expect('do');
          const body = this.block(); this.expect('end', 'to close \'while\''); return { k: 'While', cond, body, line };
        }
        case 'repeat': {
          this.next(); const body = this.block(); this.expect('until', 'to close \'repeat\'');
          return { k: 'Repeat', body, cond: this.expr(), line };
        }
        case 'if': {
          this.next();
          const clauses = [];
          let orelse = null;
          const cond = this.expr(); this.expect('then');
          clauses.push({ cond, body: this.block() });
          while (true) {
            if (this.accept('elseif')) { const c = this.expr(); this.expect('then'); clauses.push({ cond: c, body: this.block() }); continue; }
            if (this.accept('else')) orelse = this.block();
            break;
          }
          this.expect('end', 'to close \'if\'');
          return { k: 'If', clauses, orelse, line };
        }
        case 'for': {
          this.next();
          const n1 = this.name();
          if (this.accept(':')) this.type();
          if (this.accept('=')) {
            const start = this.expr(); this.expect(',');
            const end = this.expr();
            const step = this.accept(',') ? this.expr() : null;
            this.expect('do');
            const body = this.block(); this.expect('end', 'to close \'for\'');
            return { k: 'NumFor', name: n1, start, end, step, body, line };
          }
          const names = [n1];
          while (this.accept(',')) { names.push(this.name()); if (this.accept(':')) this.type(); }
          this.expect('in');
          const exprs = this.exprList();
          this.expect('do');
          const body = this.block(); this.expect('end', 'to close \'for\'');
          return { k: 'GenFor', names, exprs, body, line };
        }
        case 'break': this.next(); return { k: 'Break', line };
        default: break;
      }
    }
    if (t.t === 'name') {
      const nx = this.peek();
      if (t.v === 'continue' && !this.continuesExpr(nx)) { this.next(); return { k: 'Continue', line }; }
      if ((t.v === 'type' && nx.t === 'name') || (t.v === 'export' && nx.t === 'name' && nx.v === 'type')) {
        if (t.v === 'export') this.next();
        this.next();
        if (this.tok.t === 'name' && this.tok.v === 'function') { /* type function: skip body */ this.next(); this.name(); this.funcBody('type', line); return null; }
        this.name();
        if (this.is('<')) this.genericList(true);
        this.expect('=');
        this.type();
        return null;
      }
    }
    // expression statement: call or assignment
    const e = this.suffixed();
    if (this.is('=') || this.is(',')) {
      const targets = [e];
      while (this.accept(',')) targets.push(this.suffixed());
      this.expect('=');
      for (const tg of targets) if (tg.k !== 'Name' && tg.k !== 'Index') this.error('Assigned expression must be a variable or a field', line);
      return { k: 'Assign', targets, exprs: this.exprList(), line };
    }
    if (this.tok.t === 'op' && COMPOUND.has(this.tok.v)) {
      const op = this.next().v.slice(0, -1);
      if (e.k !== 'Name' && e.k !== 'Index') this.error('Assigned expression must be a variable or a field', line);
      return { k: 'OpAssign', target: e, op, expr: this.expr(), line };
    }
    if (e.k !== 'Call' && e.k !== 'MCall') this.error('Incomplete statement: expected assignment or a function call', line);
    return { k: 'CallStat', call: e, line };
  }

  continuesExpr(nx) {
    if (nx.t === 'str' || nx.t === 'interp') return true;
    if (nx.t !== 'op') return false;
    return ['(', '=', '.', '[', ':', ',', '{', '+=', '-=', '*=', '/=', '%=', '^=', '..=', '//='].includes(nx.v);
  }

  skipAttributes() {
    while (this.accept('@')) {
      if (this.accept('[')) { let d = 1; while (d && this.tok.t !== 'eof') { if (this.is('[')) d++; else if (this.is(']')) d--; this.next(); } }
      else this.name();
    }
  }

  funcBody(name, line, isMethod = false) {
    if (this.is('<')) this.genericList(false);
    this.expect('(', 'when parsing function');
    const params = isMethod ? ['self'] : [];
    let vararg = false;
    if (!this.is(')')) {
      do {
        if (this.accept('...')) { vararg = true; if (this.accept(':')) this.type(true); break; }
        params.push(this.name());
        if (this.accept(':')) this.type();
      } while (this.accept(','));
    }
    this.expect(')');
    if (this.accept(':')) this.returnType();
    const body = this.block();
    this.expect('end', `to close 'function' at line ${line}`);
    return { k: 'Func', name, params, vararg, body, line };
  }

  exprList() { const l = [this.expr()]; while (this.accept(',')) l.push(this.expr()); return l; }

  expr(limit = 0) {
    let left;
    const t = this.tok;
    if ((t.t === 'kw' && t.v === 'not') || (t.t === 'op' && (t.v === '-' || t.v === '#'))) {
      this.next();
      left = { k: 'Un', op: t.v, a: this.expr(UNARY_PRI), line: t.line };
    } else left = this.simple();
    while (true) {
      const o = this.tok;
      const op = (o.t === 'op' || o.t === 'kw') ? o.v : null;
      const pri = op && BINPRI[op];
      if (!pri || pri[0] <= limit) break;
      this.next();
      const right = this.expr(pri[1]);
      left = { k: 'Bin', op, a: left, b: right, line: o.line };
    }
    return left;
  }

  simple() {
    const t = this.tok;
    let e;
    switch (t.t) {
      case 'num': this.next(); e = { k: 'Num', v: t.v }; break;
      case 'str': this.next(); e = { k: 'Str', v: t.v }; break;
      case 'interp': this.next(); e = this.interp(t); break;
      case 'kw':
        if (t.v === 'nil') { this.next(); e = { k: 'Nil' }; break; }
        if (t.v === 'true') { this.next(); e = { k: 'True' }; break; }
        if (t.v === 'false') { this.next(); e = { k: 'False' }; break; }
        if (t.v === 'function') { this.next(); e = this.funcBody('anonymous', t.line); break; }
        if (t.v === 'if') { e = this.ifExpr(); break; }
        e = this.suffixed(); break;
      case 'op':
        if (t.v === '...') { this.next(); e = { k: 'Vararg' }; break; }
        if (t.v === '{') { e = this.table(); break; }
        if (t.v === '@') { this.skipAttributes(); return this.simple(); }
        e = this.suffixed(); break;
      default: e = this.suffixed();
    }
    while (this.is('::')) { this.next(); this.type(); }
    return e;
  }

  interp(t) {
    const parts = [];
    for (const p of t.v) {
      if (typeof p === 'string') { if (p) parts.push(p); continue; }
      const sub = new Parser(tokenize(p.src, p.line - 1), this.chunk);
      const ex = sub.expr();
      if (sub.tok.t !== 'eof') sub.error('Expected \'}\' after interpolated expression');
      parts.push(ex);
    }
    return { k: 'Interp', parts, line: t.line };
  }

  ifExpr() {
    const line = this.next().line;
    const clauses = [];
    const cond = this.expr(); this.expect('then');
    clauses.push({ cond, value: this.expr() });
    while (this.accept('elseif')) { const c = this.expr(); this.expect('then'); clauses.push({ cond: c, value: this.expr() }); }
    this.expect('else', 'in if-then-else expression');
    return { k: 'IfE', clauses, orelse: this.expr(), line };
  }

  primary() {
    const t = this.tok;
    if (t.t === 'name') { this.next(); return { k: 'Name', name: t.v, line: t.line }; }
    if (this.accept('(')) {
      const e = this.expr();
      this.expect(')');
      return { k: 'Paren', e, line: t.line };
    }
    this.error(`Expected identifier when parsing expression, got '${t.t === 'eof' ? '<eof>' : t.v}'`);
    return null;
  }

  suffixed() {
    let e = this.primary();
    while (true) {
      const t = this.tok;
      if (t.t === 'op') {
        if (t.v === '.') { this.next(); e = { k: 'Index', obj: e, key: { k: 'Str', v: this.name() }, line: t.line }; continue; }
        if (t.v === '[') { this.next(); const key = this.expr(); this.expect(']'); e = { k: 'Index', obj: e, key, line: t.line }; continue; }
        if (t.v === ':') {
          this.next(); const name = this.name();
          e = { k: 'MCall', obj: e, name, args: this.callArgs(), line: t.line }; continue;
        }
        if (t.v === '(' || t.v === '{') {
          if (t.v === '(' && t.line !== this.toks[this.i - 1].line && e.k !== 'Paren') {
            // Lua's ambiguity rule: f\n(...) is still a call; Luau warns but accepts. Keep accepting.
          }
          e = { k: 'Call', fn: e, args: this.callArgs(), line: t.line }; continue;
        }
        if (t.v === '<' && this.genericCallAhead()) { this.genericList(false); continue; }
      } else if (t.t === 'str' || t.t === 'interp') {
        e = { k: 'Call', fn: e, args: this.callArgs(), line: t.line }; continue;
      }
      return e;
    }
  }

  // explicit type instantiation f<<T>>(...) (Luau RFC) — rare; detect `<<`
  genericCallAhead() { return this.peek().t === 'op' && this.peek().v === '<'; }

  callArgs() {
    const t = this.tok;
    if (t.t === 'str') { this.next(); return [{ k: 'Str', v: t.v }]; }
    if (t.t === 'interp') { this.next(); return [this.interp(t)]; }
    if (this.is('{')) return [this.table()];
    this.expect('(');
    if (this.accept(')')) return [];
    const args = this.exprList();
    this.expect(')', 'to close function call arguments');
    return args;
  }

  table() {
    const line = this.expect('{').line;
    const items = [];
    while (!this.is('}')) {
      if (this.is('[')) {
        this.next(); const key = this.expr(); this.expect(']'); this.expect('=');
        items.push({ type: 'expr', key, value: this.expr() });
      } else if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === '=') {
        const key = this.next().v; this.next();
        items.push({ type: 'named', key, value: this.expr() });
      } else items.push({ type: 'pos', value: this.expr() });
      if (!this.accept(',') && !this.accept(';')) break;
    }
    this.expect('}', `to close table at line ${line}`);
    return { k: 'Table', items, line };
  }

  // ---------------------------------------------------------------- types (skipped)
  genericList(withDefaults) {
    this.expect('<');
    if (!this.is('>')) {
      do {
        if (this.tok.t === 'name') this.next();
        this.accept('...');
        if (withDefaults && this.accept('=')) this.type(true);
      } while (this.accept(','));
    }
    this.expect('>');
  }
  returnType() { this.type(true); }
  type(allowPack = false) {
    this.accept('|') || this.accept('&');
    this.simpleType(allowPack);
    while (true) {
      if (this.accept('?')) continue;
      if (this.accept('|') || this.accept('&')) { this.simpleType(allowPack); continue; }
      break;
    }
  }
  simpleType(allowPack) {
    const t = this.tok;
    if (t.t === 'kw' && (t.v === 'nil' || t.v === 'true' || t.v === 'false')) { this.next(); return; }
    if (t.t === 'str') { this.next(); return; }
    if (t.t === 'interp') { this.next(); return; }
    if (t.t === 'op' && t.v === '...') { this.next(); if (this.tok.t === 'name' || this.is('(') || this.is('{')) this.simpleType(true); return; }
    if (t.t === 'name') {
      this.next();
      if (t.v === 'typeof' && this.is('(')) { this.next(); this.expr(); this.expect(')'); return; }
      while (this.accept('.')) this.name();
      if (this.is('...')) { this.next(); return; } // generic pack T...
      if (this.is('<')) this.typeArgs();
      return;
    }
    if (t.t === 'op' && t.v === '{') {
      this.next();
      while (!this.is('}')) {
        if (this.tok.t === 'name' && (this.tok.v === 'read' || this.tok.v === 'write') && (this.peek().t === 'name' || (this.peek().t === 'op' && this.peek().v === '['))) this.next();
        if (this.is('[')) { this.next(); this.type(); this.expect(']'); this.expect(':'); this.type(); }
        else if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === ':') { this.next(); this.next(); this.type(); }
        else this.type();
        if (!this.accept(',') && !this.accept(';')) break;
      }
      this.expect('}');
      return;
    }
    if (t.t === 'op' && t.v === '<') { this.genericList(false); return this.simpleType(allowPack); }
    if (t.t === 'op' && t.v === '(') {
      this.next();
      if (!this.is(')')) {
        do {
          if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === ':') { this.next(); this.next(); }
          this.type(true);
        } while (this.accept(','));
      }
      this.expect(')');
      if (this.accept('->')) this.type(true);
      return;
    }
    if (t.t === 'kw' && t.v === 'function') { this.next(); return; }
    this.error(`Expected type, got '${t.v}'`);
  }
  typeArgs() {
    this.expect('<');
    if (!this.is('>')) {
      do {
        if (this.is('(')) { this.simpleType(true); continue; }
        this.type(true);
      } while (this.accept(','));
    }
    this.expect('>');
  }
}
