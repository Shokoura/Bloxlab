// Luau AST -> JavaScript. Every Lua function becomes a JS generator function so that
// coroutines / wait() can suspend the whole Lua call stack (`yield*` delegation).
import { parse } from './parser.js';

const BIN = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '//': 'idiv', '%': 'mod', '^': 'pow', '..': 'concat', '==': 'eq', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const BOOLISH = new Set(['==', '~=', '<', '<=', '>', '>=']);
// watchdog: lets the scheduler abort scripts stuck in endless loops
const CHK = 'if ((++$w & 0xffff) === 0) $B.check();';

const jsStr = (s) => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += '\\\\';
    else if (c >= 32 && c < 127) out += s[i];
    else if (c === 10) out += '\\n';
    else out += '\\x' + c.toString(16).padStart(2, '0');
  }
  return out + '"';
};
const jsNum = (v) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : Object.is(v, -0) ? '-0' : String(v));

class FuncState {
  constructor(parent, vararg) { this.parent = parent; this.vararg = vararg; this.temps = 0; this.loops = []; }
}

class Scope {
  constructor(parent) { this.parent = parent; this.vars = new Map(); }
  lookup(name) { for (let s = this; s; s = s.parent) { const v = s.vars.get(name); if (v) return v; } return null; }
}

export class Compiler {
  constructor(chunkName) { this.chunk = chunkName; this.uid = 0; this.fs = null; this.scope = null; }

  temp() { return '$' + (++this.fs.temps); }
  declare(name) { const id = `${name}$${++this.uid}`; this.scope.vars.set(name, id); return id; }
  pushScope() { this.scope = new Scope(this.scope); }
  popScope() { this.scope = this.scope.parent; }

  compileChunk(ast) {
    this.fs = new FuncState(null, true);
    this.pushScope();
    const body = this.block(ast, false);
    this.popScope();
    const temps = this.tempDecl();
    return `return function* $main(...$va) {\n let $ln = 0, $w = 0${temps};\n try {\n${body}\n } catch ($e) { throw $rethrow($e, $ln, $chunk); }\n return $E;\n}`;
  }

  tempDecl() { let s = ''; for (let i = 1; i <= this.fs.temps; i++) s += `, $${i}`; return s; }

  block(b, newScope = true) {
    if (newScope) this.pushScope();
    const out = b.stats.map((s) => this.stat(s)).join('\n');
    if (newScope) this.popScope();
    return out;
  }

  // ---------------------------------------------------------------- statements
  // `hoist`: when compiling the top level of a repeat body, locals are declared before the
  // body (so `until` can see them) and the statements only assign.
  stat(s, hoist = null) {
    const ln = `$ln = ${s.line};`;
    const let_ = (id) => { if (hoist) { hoist.push(id); return id; } return `let ${id}`; };
    switch (s.k) {
      case 'Local': {
        const { names, exprs } = s;
        if (exprs.length === 0) return ln + names.map((n) => `${let_(this.declare(n))} = undefined;`).join(' ');
        if (names.length === 1 && exprs.length === 1) {
          const v = this.expr1(exprs[0]);
          return `${ln} ${let_(this.declare(names[0]))} = ${v};`;
        }
        const vals = this.exprListFixed(exprs, names.length);
        const t = this.temp();
        const ids = names.map((n) => this.declare(n));
        return `${ln} ${t} = ${vals}; ${ids.map((id, i) => `${let_(id)} = ${t}[${i}];`).join(' ')}`;
      }
      case 'LocalFunction': {
        const id = this.declare(s.name);
        if (hoist) { hoist.push(id); return `${ln} ${id} = ${this.func(s.func)};`; }
        return `${ln} let ${id}; ${id} = ${this.func(s.func)};`;
      }
      case 'Function': return `${ln} ${this.assignTo(s.target, this.func(s.func))};`;
      case 'Assign': {
        if (s.targets.length === 1 && s.exprs.length === 1) return `${ln} ${this.assignTo(s.targets[0], this.expr1(s.exprs[0]))};`;
        // evaluate target prefixes, then values, then assign
        const pre = [];
        const targets = s.targets.map((tg) => {
          if (tg.k === 'Index') {
            const o = this.temp(), k = this.temp();
            pre.push(`${o} = ${this.expr1(tg.obj)}, ${k} = ${this.expr1(tg.key)}`);
            return { index: true, o, k };
          }
          return { node: tg };
        });
        const vals = this.temp();
        pre.push(`${vals} = ${this.exprListFixed(s.exprs, s.targets.length)}`);
        const assigns = targets.map((tg, i) => (tg.index ? `$setidx(${tg.o}, ${tg.k}, ${vals}[${i}])` : this.assignTo(tg.node, `${vals}[${i}]`)));
        return `${ln} ${pre.join(', ')}; ${assigns.join('; ')};`;
      }
      case 'OpAssign': {
        const fn = '$' + BIN[s.op];
        if (s.target.k === 'Name') {
          const cur = this.expr1(s.target);
          return `${ln} ${this.assignTo(s.target, `${fn}(${cur}, ${this.expr1(s.expr)})`)};`;
        }
        const o = this.temp(), k = this.temp();
        return `${ln} ${o} = ${this.expr1(s.target.obj)}; ${k} = ${this.expr1(s.target.key)}; $setidx(${o}, ${k}, ${fn}($idx(${o}, ${k}), ${this.expr1(s.expr)}));`;
      }
      case 'CallStat': return `${ln} ${this.call(s.call)};`;
      case 'Do': return `{ ${this.block(s.body)} }`;
      case 'While': {
        this.fs.loops.push({ kind: 'while' });
        const body = this.block(s.body);
        this.fs.loops.pop();
        return `while (($ln = ${s.line}, ${this.cond(s.cond)})) { ${CHK}\n${body}\n}`;
      }
      case 'Repeat': {
        const label = `$rep${++this.uid}`;
        this.fs.loops.push({ kind: 'repeat', label });
        // body locals stay visible in the `until` condition
        this.pushScope();
        const hoisted = [];
        const stats = s.body.stats.map((st) => this.stat(st, hoisted)).join('\n');
        this.fs.loops.pop();
        const cond = this.cond(s.cond);
        this.popScope();
        return `while (true) { ${CHK}\n${hoisted.length ? `let ${hoisted.join(', ')};` : ''}\n${label}: {\n${stats}\n}\n$ln = ${s.line}; if (${cond}) break;\n}`;
      }
      case 'If': {
        let out = '';
        s.clauses.forEach((c, i) => {
          out += `${i ? ' else ' : `${ln} `}if (${this.cond(c.cond)}) {\n${this.block(c.body)}\n}`;
        });
        if (s.orelse) out += ` else {\n${this.block(s.orelse)}\n}`;
        return out;
      }
      case 'NumFor': {
        const a = this.temp(), b = this.temp(), st = this.temp();
        const init = `${a} = $fornum(${this.expr1(s.start)}, "initial"); ${b} = $fornum(${this.expr1(s.end)}, "limit"); `;
        let loop;
        this.fs.loops.push({ kind: 'for' });
        this.pushScope();
        const id = this.declare(s.name);
        const body = this.block(s.body);
        this.popScope();
        this.fs.loops.pop();
        if (!s.step || (s.step.k === 'Num' && s.step.v > 0)) {
          loop = `${init}for (${st} = ${s.step ? jsNum(s.step.v) : 1}; ${a} <= ${b}; ${a} += ${st}) { ${CHK} let ${id} = ${a};\n${body}\n}`;
        } else {
          loop = `${init}${st} = $fornum(${this.expr1(s.step)}, "step"); if (${st} === 0) throw $err("for step is zero"); for (; ${st} > 0 ? ${a} <= ${b} : ${a} >= ${b}; ${a} += ${st}) { ${CHK} let ${id} = ${a};\n${body}\n}`;
        }
        return `${ln} ${loop}`;
      }
      case 'GenFor': {
        const it = this.temp(), nx = this.temp();
        const init = `${it} = $forprep(${this.exprListFixed(s.exprs, 3)});`;
        this.fs.loops.push({ kind: 'for' });
        this.pushScope();
        const ids = s.names.map((n) => this.declare(n));
        const body = this.block(s.body);
        this.popScope();
        this.fs.loops.pop();
        const binds = ids.map((id, i) => `let ${id} = ${nx}[${i}];`).join(' ');
        return `${ln} ${init}\nwhile (true) { ${CHK}\n if (${it}.fast) { ${nx} = ${it}.fast(); if (${nx} === undefined) break; }\n else { ${nx} = (yield* $call(${it}.f, ${it}.s, ${it}.c)); if (${nx}[0] === undefined || ${nx}[0] === null) break; ${it}.c = ${nx}[0]; }\n ${binds}\n${body}\n}`;
      }
      case 'Return': {
        if (!s.exprs.length) return `${ln} return $E;`;
        if (s.exprs.length === 1 && (s.exprs[0].k === 'Call' || s.exprs[0].k === 'MCall')) return `${ln} return ${this.call(s.exprs[0])};`;
        return `${ln} return ${this.exprListMulti(s.exprs)};`;
      }
      case 'Break': return 'break;';
      case 'Continue': {
        const loop = this.fs.loops[this.fs.loops.length - 1];
        if (!loop) throw new SyntaxError('continue outside a loop');
        return loop.kind === 'repeat' ? `break ${loop.label};` : 'continue;';
      }
      default: throw new Error('unknown statement ' + s.k);
    }
  }

  assignTo(target, value) {
    if (target.k === 'Name') {
      const id = this.scope.lookup(target.name);
      if (id) return `${id} = ${value}`;
      return `$setidx($env, ${jsStr(target.name)}, ${value})`;
    }
    return `$setidx(${this.expr1(target.obj)}, ${this.expr1(target.key)}, ${value})`;
  }

  // ---------------------------------------------------------------- functions
  func(f) {
    const saved = this.fs;
    this.fs = new FuncState(saved, f.vararg);
    const savedLoops = saved.loops;
    this.pushScope();
    const params = f.params.map((p) => this.declare(p));
    const body = this.block(f.body, false);
    this.popScope();
    const temps = this.tempDecl();
    this.fs = saved;
    saved.loops = savedLoops;
    const args = [...params, '...$va'].join(', ');
    return `$mkfn(function* (${args}) {\n let $ln = ${f.line}, $w = 0${temps};\n try {\n${body}\n } catch ($e) { throw $rethrow($e, $ln, $chunk); }\n return $E;\n}, ${jsStr(f.name || 'anonymous')}, ${f.line})`;
  }

  // ---------------------------------------------------------------- expressions
  isMulti(e) { return e.k === 'Call' || e.k === 'MCall' || e.k === 'Vararg'; }

  // single value
  expr1(e) {
    switch (e.k) {
      case 'Nil': return 'undefined';
      case 'True': return 'true';
      case 'False': return 'false';
      case 'Num': return jsNum(e.v);
      case 'Str': return jsStr(e.v);
      case 'Vararg': if (!this.fs.vararg) throw new SyntaxError('Cannot use \'...\' outside of a vararg function'); return '$va[0]';
      case 'Func': return this.func(e);
      case 'Name': {
        const id = this.scope.lookup(e.name);
        return id || `$idx($env, ${jsStr(e.name)})`;
      }
      case 'Index': return `$idx(${this.expr1(e.obj)}, ${this.expr1(e.key)})`;
      case 'Call': case 'MCall': return `${this.call(e)}[0]`;
      case 'Paren': return this.expr1(e.e);
      case 'Table': return this.table(e);
      case 'Un': {
        const a = this.expr1(e.a);
        if (e.op === 'not') return `!${this.cond(e.a)}`;
        if (e.op === '-') return e.a.k === 'Num' ? `(${jsNum(-e.a.v)})` : `$unm(${a})`;
        return `$len(${a})`;
      }
      case 'Bin': {
        if (e.op === 'and' || e.op === 'or') {
          const t = this.temp();
          const a = this.expr1(e.a), b = this.expr1(e.b);
          return e.op === 'and'
            ? `((${t} = ${a}) == null || ${t} === false ? ${t} : ${b})`
            : `((${t} = ${a}) == null || ${t} === false ? ${b} : ${t})`;
        }
        if (e.op === '~=') return `!$eq(${this.expr1(e.a)}, ${this.expr1(e.b)})`;
        if (e.op === '..') {
          // flatten right-assoc chains a .. b .. c
          const parts = [];
          let n = e;
          while (n.k === 'Bin' && n.op === '..') { parts.push(n.a); n = n.b; }
          parts.push(n);
          if (parts.length > 2) return `$concatn([${parts.map((p) => this.expr1(p)).join(', ')}])`;
        }
        return `$${BIN[e.op]}(${this.expr1(e.a)}, ${this.expr1(e.b)})`;
      }
      case 'IfE': {
        let out = '';
        for (const c of e.clauses) out += `${this.cond(c.cond)} ? ${this.expr1(c.value)} : `;
        return `(${out}${this.expr1(e.orelse)})`;
      }
      case 'Interp': return `$concatn([${e.parts.map((p) => (typeof p === 'string' ? jsStr(p) : `$tostr(${this.expr1(p)})`)).join(', ')}], true)`;
      default: throw new Error('unknown expression ' + e.k);
    }
  }

  // JS boolean
  cond(e) {
    if (e.k === 'True') return 'true';
    if (e.k === 'False' || e.k === 'Nil') return 'false';
    if (e.k === 'Bin' && BOOLISH.has(e.op)) return this.expr1(e);
    if (e.k === 'Un' && e.op === 'not') return `!${this.cond(e.a)}`;
    if (e.k === 'Bin' && e.op === 'and') return `(${this.cond(e.a)} && ${this.cond(e.b)})`;
    if (e.k === 'Bin' && e.op === 'or') return `(${this.cond(e.a)} || ${this.cond(e.b)})`;
    if (e.k === 'Paren') return this.cond(e.e);
    const t = this.temp();
    return `((${t} = ${this.expr1(e)}) != null && ${t} !== false)`;
  }

  // JS array expression producing all values
  multi(e) {
    if (e.k === 'Call' || e.k === 'MCall') return this.call(e);
    if (e.k === 'Vararg') { if (!this.fs.vararg) throw new SyntaxError('Cannot use \'...\' outside of a vararg function'); return '$va'; }
    return `[${this.expr1(e)}]`;
  }

  // comma separated JS argument list, last expression expanded
  argList(list) {
    if (!list.length) return '';
    const parts = list.map((e, i) => {
      if (i === list.length - 1 && this.isMulti(e)) return `...${this.multi(e)}`;
      return this.expr1(e);
    });
    return parts.join(', ');
  }
  exprListMulti(list) {
    if (list.length === 1 && this.isMulti(list[0])) return this.multi(list[0]);
    return `[${this.argList(list)}]`;
  }
  // array with at least `n` meaningful slots
  exprListFixed(list, n) {
    void n;
    return this.exprListMulti(list);
  }

  table(e) {
    const arr = [], hash = [];
    e.items.forEach((it, i) => {
      if (it.type === 'pos') {
        if (i === e.items.length - 1 && this.isMulti(it.value)) arr.push(`...${this.multi(it.value)}`);
        else arr.push(this.expr1(it.value));
      } else if (it.type === 'named') hash.push(jsStr(it.key), this.expr1(it.value));
      else hash.push(this.expr1(it.key), this.expr1(it.value));
    });
    if (!hash.length) return `$tbl([${arr.join(', ')}])`;
    return `$tbl([${arr.join(', ')}], [${hash.join(', ')}])`;
  }

  // JS expression evaluating to the array of results
  call(e) {
    const f = this.temp();
    const pre = [];
    let self = null;
    if (e.k === 'MCall') {
      self = this.temp();
      pre.push(`${self} = ${this.expr1(e.obj)}`);
      pre.push(`${f} = $method(${self}, ${jsStr(e.name)})`);
    } else pre.push(`${f} = ${this.expr1(e.fn)}`);
    // evaluate args into temps so the dispatch below can mention them twice
    const args = [];
    if (self) args.push(self);
    e.args.forEach((a, i) => {
      if (a.k === 'Nil' || a.k === 'True' || a.k === 'False' || a.k === 'Num' || a.k === 'Str') { args.push(this.expr1(a)); return; }
      const t = this.temp();
      if (i === e.args.length - 1 && this.isMulti(a)) { pre.push(`${t} = ${this.multi(a)}`); args.push(`...${t}`); }
      else { pre.push(`${t} = ${this.expr1(a)}`); args.push(t); }
    });
    const a = args.join(', ');
    const fname = e.k === 'MCall' ? jsStr(e.name) : e.fn.k === 'Name' ? jsStr(e.fn.name) : e.fn.k === 'Index' && e.fn.key.k === 'Str' ? jsStr(e.fn.key.v) : '"?"';
    return `(${pre.join(', ')}, $ln = ${e.line}, (typeof ${f} === "function" ? (${f}.$g ? (yield* ${f}(${a})) : $nat(${f}(${a}))) : (yield* $callx(${f}, ${fname}, [${a}]))))`;
  }
}

/** Compile Luau source into the JS source of a factory body. */
export function compileToJS(src, chunkName = 'chunk') {
  const ast = parse(src, chunkName);
  return new Compiler(chunkName).compileChunk(ast);
}
