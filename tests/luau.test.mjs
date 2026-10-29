// node tests/luau.test.mjs  — runs Luau snippets and compares printed output.
import { VM } from '../js/luau/stdlib.js';
import { Coroutine, resume } from '../js/luau/runtime.js';

let failures = 0, total = 0;
function run(src) {
  const out = [];
  const vm = new VM({ print: (m, kind) => out.push(kind === 'warn' ? 'W:' + m : m) });
  try {
    const f = vm.load(src, 'test');
    const co = new Coroutine(f);
    const r = resume(co, []);
    if (!r[0]) out.push('ERR:' + r[1]);
  } catch (e) { out.push('COMPILE:' + e.message + (e.line ? ' @' + e.line : '')); }
  return out.join('\n');
}
function t(name, src, expected) {
  total++;
  const got = run(src);
  if (got !== expected.trim()) {
    failures++;
    console.log(`FAIL ${name}\n--- expected\n${expected.trim()}\n--- got\n${got}\n`);
  }
}

t('arith', `print(1 + 2, 7 // 2, 7 % 3, -7 % 3, 2 ^ 10, 10 / 4, "10" + 5, 1e15, 2^53, 0.1, 1/0, -1/0, 100, -0.0)`,
  '3 3 1 2 1024 2.5 15 1e+15 9.007199254740992e+15 0.1 inf -inf 100 -0');
t('strings', `
local s = "Hello"
print(#s, s:upper(), s:lower(), s:rep(2, "-"), s:sub(2, 3), s:sub(-3), s:byte(1), string.char(72, 105))
print(("%d|%5.2f|%s|%q|%x|%-5s|%05d|%g|%g"):format(42, 3.14159, "hi", 'a"b', 255, "ab", 42, 0.0001, 1e20))
print(string.find("hello world", "o w"), string.find("hello", "l+"), string.match("key=val", "(%w+)=(%w+)"))
print(string.gsub("hello world", "o", "0"), string.gsub("abc", "%w", "%0%0"), ("x"):rep(3))
for w in string.gmatch("one two three", "%a+") do io = w end print(io)
print(string.format("%s %s", 1, true), tostring(nil), tostring(12.5))
print(("a,b,,c"):split(",")[3] == "", #("a,b,,c"):split(","))
print(string.gsub("hello", "(l)(l)", "%2%1"), string.match("  trim  ", "^%s*(.-)%s*$"))
print(string.find("a.b", ".", 1, true), string.find("abc", "b", -1), ("%bxy"):len())
print(string.format("%3d|%-3d|%+d", 5, 5, 5), string.format("%.3s", "abcdef"))
print(string.gsub("abc", "", "-"))
`, `5 HELLO hello Hello-Hello el llo 72 Hi
42| 3.14|hi|"a\\"b"|ff|ab   |00042|0.0001|1e+20
5 3 key val
hell0 w0rld aabbcc xxx
three
1 true nil 12.5
true 4
hello trim
2 nil 4
  5|5  |+5 abc
-a-b-c- 4`);
t('utf8 strings', `local s = "한글" print(#s, utf8.len(s), s:byte(1)) for p, c in utf8.codes(s) do print(p, c) end print(utf8.char(72, 54620))`,
  '6 2 237\n1 54620\n4 44544\nH한');
t('closures & varargs', `
local function counter() local n = 0 return function() n += 1 return n end end
local c = counter() c() c() print(c())
local function va(...) return select('#', ...), ... end
print(va(1, nil, 3))
local function tail(...) local t = {...} return #t, table.unpack(t) end
print(tail(4, 5, 6))
print(select(-1, 1, 2, 3), select(2, "a", "b", "c"))
local fns = {} for i = 1, 3 do fns[i] = function() return i end end print(fns[1](), fns[3]())
`, '3\n3 1 nil 3\n3 4 5 6\n3 b c\n1 3');
t('tables', `
local t = {10, 20, 30, x = 1, ["y"] = 2}
table.insert(t, 40) table.insert(t, 1, 5)
print(#t, t[1], t[5], table.remove(t), #t, table.concat(t, ","))
local keys = {} for k, v in pairs({a = 1, b = 2, c = 3}) do table.insert(keys, k) end table.sort(keys) print(table.concat(keys))
local arr = {5, 2, 8, 1} table.sort(arr, function(a, b) return a > b end) print(table.concat(arr, " "))
print(table.find(arr, 8), table.unpack({1, 2, 3}, 2))
local p = table.pack(1, nil, 3) print(p.n, p[3])
local cl = table.clone({1, 2}) print(#cl)
local f = table.freeze({1}) print(pcall(function() f[1] = 2 end))
print(next({}), rawlen({1, 2}), rawequal(t, t))
local m = {} m[1] = 1 m[3] = 3 m[2] = 2 print(#m)
for i, v in ipairs({1, 2, nil, 4}) do io = i end print(io)
local cnt = 0 for k, v in {a = 1, 2, 3} do cnt += 1 end print(cnt)
`, `5 5 40 40 4 5,10,20,30
abc
8 5 2 1
1 2 3
3 3
2
false test:10: attempt to modify a readonly table
nil 2 true
3
2
3`);
t('metatables', `
local V = {} V.__index = V
function V.new(x, y) return setmetatable({x = x, y = y}, V) end
V.__add = function(a, b) return V.new(a.x + b.x, a.y + b.y) end
V.__eq = function(a, b) return a.x == b.x and a.y == b.y end
V.__tostring = function(v) return "(" .. v.x .. ", " .. v.y .. ")" end
V.__lt = function(a, b) return a.x < b.x end
V.__len = function() return 2 end
V.__call = function(self, k) return self[k] end
V.__concat = function(a, b) return tostring(a) .. tostring(b) end
function V:mag() return math.sqrt(self.x ^ 2 + self.y ^ 2) end
local a, b = V.new(1, 2), V.new(3, 4)
print(tostring(a + b), a == V.new(1, 2), a < b, #a, a("x"), b:mag(), a .. b)
local ro = setmetatable({}, { __newindex = function(t, k, v) rawset(t, k, v * 2) end, __index = function(t, k) return k .. "!" end })
ro.z = 5 print(ro.z, ro.q)
print(getmetatable(setmetatable({}, {__metatable = "locked"})))
local iter = setmetatable({}, {__iter = function(t) return next, {7, 8} end})
for k, v in iter do print(k, v) end
`, `(4, 6) true true 2 1 5 (1, 2)(3, 4)
10 q!
locked
1 7
2 8`);
t('control flow', `
local out = {}
for i = 1, 10 do if i % 2 == 0 then continue end if i > 7 then break end table.insert(out, i) end
print(table.concat(out, ","))
local i = 0 repeat local j = i i += 1 until j >= 3 print(i)
local n = 0 while true do n += 1 if n == 5 then break end end print(n)
for i = 10, 1, -3 do io = (io or "") .. i .. ";" end print(io)
local x = if n > 3 then "big" elseif n > 1 then "mid" else "small" print(x)
local s = \`n = {n}, n*2 = {n * 2} {"nested"}\` print(s)
local a, b, c = 1 print(a, b, c)
local k = 0 repeat k += 1 if k < 3 then continue end until k >= 5 print(k)
print(not nil, not 0, nil and 1, false or "x", 1 and 2, nil or false)
`, `1,3,5,7
4
5
10;7;4;1;
big
n = 5, n*2 = 10 nested
1 nil nil
5
true false nil x 2 false`);
t('types are ignored', `
type Point = { x: number, y: number }
export type Fn<T> = (T, ...any) -> (boolean, string?)
local function add(a: number, b: number): number return a + b end
local p: Point = { x = 1, y = 2 }
local q = (p :: any) :: Point
local function gen<T>(x: T): {T} return {x} end
local f: (number) -> () = function(n: number) end
print(add(p.x, q.y), #gen(5))
local type = type print(type(5))
`, '3 1\nnumber');
t('errors', `
print(pcall(error, "boom"))
print(pcall(function() error("lvl1") end))
print(pcall(function() error("nolvl", 0) end))
print(select(2, pcall(function() error({code = 5}) end)).code)
print(select(2, pcall(function() local x = nil; return x.y end)))
print(select(2, pcall(function() return 1 + {} end)))
print(select(2, pcall(function() return #nil end)))
print(select(2, pcall(function() undefinedfn() end)))
print(xpcall(function() error("E") end, function(e) return "handled: " .. e end))
local ok, e = pcall(function() local t = {} t.a.b = 1 end) print(e)
print(select(2, pcall(function() return 1 < "x" end)))
print(pcall(assert, false, "assert msg"), pcall(assert, 1, 2))
`, `false boom
false test:3: lvl1
false nolvl
5
test:6: attempt to index nil with 'y'
test:7: attempt to perform arithmetic (add) on number and table
test:8: attempt to get length of a nil value
test:9: attempt to call a nil value ('undefinedfn')
false handled: test:10: E
test:11: attempt to index nil with 'b'
test:12: attempt to compare number < string
false true 1 2`);
t('coroutines', `
local co = coroutine.create(function(a, b)
  print("start", a, b)
  local c = coroutine.yield(a + b)
  print("got", c)
  local d, e = coroutine.yield(c * 2)
  return d + e
end)
print(coroutine.resume(co, 1, 2))
print(coroutine.status(co))
print(coroutine.resume(co, 10))
print(coroutine.resume(co, 3, 4))
print(coroutine.status(co), coroutine.resume(co))
local gen = coroutine.wrap(function() for i = 1, 3 do coroutine.yield(i) end end)
print(gen(), gen(), gen())
local co2 = coroutine.create(function() error("inside") end)
print(coroutine.resume(co2))
print(coroutine.isyieldable(), coroutine.running() ~= nil)
local function producer() return coroutine.wrap(function() for _, v in ipairs({"a", "b"}) do coroutine.yield(v) end end) end
for v in producer() do print(v) end
`, `start 1 2
true 3
suspended
got 10
true 20
true 7
dead false cannot resume dead coroutine
1 2 3
false test:16: inside
true true
a
b`);
t('math', `
print(math.floor(3.7), math.ceil(3.2), math.abs(-4), math.max(1, 5, 3), math.min(2, -1), math.clamp(15, 0, 10), math.sign(-3), math.round(2.5), math.round(-2.5))
print(math.huge, math.pi == math.pi, math.sqrt(16), math.fmod(7, 3), math.fmod(-7, 3), math.modf(3.7))
math.randomseed(42) local r = math.random(1, 10) print(r >= 1 and r <= 10, math.random() < 1)
print(math.noise(0.5, 0.5, 0.5) ~= nil, math.log(8, 2), math.log10(1000))
print(bit32.band(0xFF, 0x0F), bit32.bor(1, 2), bit32.bxor(3, 1), bit32.lshift(1, 4), bit32.rshift(256, 4), bit32.bnot(0), bit32.extract(0xF0, 4, 4))
print(tonumber("0x10"), tonumber("  12  "), tonumber("1e2"), tonumber("abc"), tonumber("ff", 16), tonumber("z", 36), tonumber(""))
print(7 // 0, -7 // 0, 0/0 ~= 0/0, 2^0.5 > 1.41)
`, `3 4 4 5 -1 10 -1 3 -3
inf true 4 1 -1 3 0.7000000000000002
true true
true 3 3
15 3 2 16 16 4294967295 15
16 12 100 nil 255 35 nil
inf -inf true true`);
t('buffer & os', `
local b = buffer.create(8)
buffer.writeu32(b, 0, 0xDEADBEEF) buffer.writef32(b, 4, 1.5)
print(buffer.len(b), string.format("%X", buffer.readu32(b, 0)), buffer.readf32(b, 4), typeof(b))
print(buffer.tostring(buffer.fromstring("hey")), pcall(buffer.readu8, b, 99))
print(type(os.time()), type(os.clock()), os.date("!%Y", 0))
`, `8 DEADBEEF 1.5 buffer
hey false buffer access out of bounds
number number 1970`);
t('generic for custom iterators', `
local function range(n) local i = 0 return function() i += 1 if i <= n then return i end end end
local s = 0 for v in range(5) do s += v end print(s)
local function iter(t, i) i += 1 if t[i] then return i, t[i] end end
for i, v in iter, {"x", "y"}, 0 do print(i, v) end
local t = {1, 2, 3} for k, v in next, t do io = k end print(io)
`, '15\n1 x\n2 y\n3');
t('string methods on literal & numbers', `print(("abc"):len(), #"abc" .. 1, 10 .. "", ("x"):byte())`, '3 31 10 120');
t('long strings & escapes', 'print([[line1\nline2]], "tab\\there", "\\65\\066", "\\x41", "\\u{48}i", [==[a]]b]==])', 'line1\nline2 tab\there AB A Hi a]]b');
t('method definitions', `
local Account = {} Account.__index = Account
function Account.new(b) local self = setmetatable({}, Account) self.balance = b return self end
function Account:deposit(v) self.balance += v return self end
local a = Account.new(100) a:deposit(50):deposit(25) print(a.balance)
local obj = { inner = { val = 3 } } function obj.inner.get() return obj.inner.val end print(obj.inner.get())
`, '175\n3');
t('compound assign with index', `local t = {a = {n = 1}} t.a.n += 4 t.a.n *= 2 t["a"].n -= 1 t.a.n ..= "!" print(t.a.n) local s = "x" s ..= "y" print(s)`, '9!\nxy');
t('syntax error reporting', 'local x = = 1', 'COMPILE:Expected identifier when parsing expression, got \'=\' @1');
t('recursion', 'local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end print(fib(20))', '6765');
t('deep recursion overflow', 'local function f(n) return f(n + 1) + 1 end print(pcall(f, 1))', 'false test:1: stack overflow');
t('integer keys float', 'local t = {} t[1.0] = "a" t[2] = "b" print(#t, t[1], t[2.0])', '2 a b');
t('nested coroutine wrap inside pcall', `
local w = coroutine.wrap(function() local ok, e = pcall(function() coroutine.yield(1) error("x") end) coroutine.yield(ok) end)
print(w(), w())`, '1 false');

// performance smoke test
{
  const t0 = performance.now();
  const r = run(`local s = 0 for i = 1, 3000000 do s += i % 7 end print(s)
local function f(x) return x + 1 end local n = 0 for i = 1, 1000000 do n = f(n) end print(n)
local t = {} for i = 1, 200000 do t[i] = i * 2 end local sum = 0 for _, v in ipairs(t) do sum += v end print(sum)`);
  console.log('perf:', r.replace(/\n/g, ' '), `${(performance.now() - t0).toFixed(0)}ms`);
}
console.log(`${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
