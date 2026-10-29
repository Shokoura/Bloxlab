// node tests/engine.test.mjs — headless engine tests (no renderer / physics)
import '../js/engine/classes/index.js';
import { World } from '../js/engine/world.js';
import { newBaseplate, serializePlace, loadPlace } from '../js/engine/datamodel.js';
import { Instance } from '../js/engine/instance.js';

let fails = 0, total = 0;
function makeWorld(kind = 'server') {
  const w = new World({ kind });
  const out = [];
  w.onOutput((e) => out.push((e.kind === 'output' ? '' : e.kind[0].toUpperCase() + ':') + e.msg));
  const dm = newBaseplate(w);
  w.setGameGlobals(dm);
  return { w, dm, out };
}
function runScript(src, { steps = 0, dt = 1 / 60, setup } = {}) {
  const { w, dm, out } = makeWorld();
  if (setup) setup(dm, w);
  const s = new Instance('Script', w);
  s.props.Name = 'TestScript';
  s.props.Source = src;
  s.setParent(dm.findFirstChildOfClass('ServerScriptService'));
  w.start();
  for (let i = 0; i < steps; i++) w.scheduler.step(dt);
  w.stop();
  return out.filter((l) => !l.startsWith('T:')).join('\n');
}
function t(name, src, expected, opts) {
  total++;
  const got = runScript(src, opts);
  if (got !== expected.trim()) { fails++; console.log(`FAIL ${name}\n--- expected\n${expected.trim()}\n--- got\n${got}\n`); }
}

t('basics', `
print(game.Name, workspace.Name, game:GetService("Workspace") == workspace, script.Name, script.Parent.Name)
local p = Instance.new("Part")
p.Name = "Brick" p.Size = Vector3.new(4, 2, 1) p.Anchored = true p.Parent = workspace
print(workspace.Brick.Size, workspace:FindFirstChild("Brick") == p, p:IsA("BasePart"), p.ClassName, typeof(p), tostring(p))
print(p.Material, p.Material == Enum.Material.Plastic, p.Transparency, p.CanCollide, p:GetFullName())
p.Material = "Neon" print(p.Material.Name) p.Material = Enum.Material.Wood print(p.Material.Value)
print(pcall(function() p.Size = 5 end))
print(pcall(function() return p.NotAThing end))
print(#workspace:GetChildren() >= 3, workspace.Baseplate.Anchored)
`, `Game Workspace true TestScript ServerScriptService
4, 2, 1 true true Part Instance Brick
Enum.Material.Plastic true 0 true Workspace.Brick
Neon
512
false ServerScriptService.TestScript:8: Unable to assign property Size. Vector3 expected, got number
false ServerScriptService.TestScript:9: NotAThing is not a valid member of Part "Workspace.Brick"
true true`);
t('events', `
local f = Instance.new("Folder")
f.ChildAdded:Connect(function(c) print("added", c.Name) end)
f.Changed:Connect(function(prop) print("changed", prop) end)
local v = Instance.new("IntValue") v.Name = "Score"
v.Changed:Connect(function(n) print("value", n) end)
v:GetPropertyChangedSignal("Value"):Connect(function() print("pcs", v.Value) end)
v.Parent = f
v.Value = 10 v.Value = 10 v.Value = 11
f.Name = "Stuff"
local c = f.AncestryChanged:Connect(function() print("anc") end)
f.Parent = workspace c:Disconnect() f.Parent = nil
print(c.Connected)
local be = Instance.new("BindableEvent")
be.Event:Connect(function(a, b) print("bind", a, b) end)
be:Fire(1, "x")
local d = Instance.new("Part") d.Destroying:Connect(function() print("destroying") end) d:Destroy()
print(pcall(function() d.Parent = workspace end))
`, `added Score
value 10
pcs 10
value 11
pcs 11
changed Name
anc
changed Parent
changed Parent
false
bind 1 x
destroying
false ServerScriptService.TestScript:18: The Parent property of Part is locked, current parent: NULL, new parent Workspace`);
t('threads', `
print("a")
task.spawn(function() print("spawned") task.wait(0.1) print("after wait") end)
task.defer(function() print("deferred") end)
task.delay(0.05, function() print("delayed") end)
local t0 = time()
local dt = wait(0.2)
print("woke", dt >= 0.2, time() - t0 >= 0.19)
local co = coroutine.wrap(function() wait(0.05) print("wrapped resumed by scheduler") end)
co()
print("b")
`, `a
spawned
deferred
delayed
after wait
woke true true
b
wrapped resumed by scheduler`, { steps: 30 });
t('WaitForChild & require', `
local folder = Instance.new("Folder") folder.Name = "F" folder.Parent = workspace
task.delay(0.1, function() local m = Instance.new("ModuleScript") m.Name = "Mod" m.Source = "local M = {} M.x = 42 function M.hi() return 'hi' end return M" m.Parent = folder end)
local m = folder:WaitForChild("Mod")
local M = require(m)
print(M.x, M.hi(), require(m) == M)
print(folder:WaitForChild("Nope", 0.05))
local bad = Instance.new("ModuleScript") bad.Source = "return 1, 2" print(pcall(require, bad))
`, `42 hi true
nil
E:ModuleScript: Module code did not return exactly one value
false Requested module experienced an error while loading`, { steps: 30 });
t('attributes & tags & clone', `
local p = Instance.new("Part")
p:SetAttribute("Health", 100) p:SetAttribute("Name2", "x") p:SetAttribute("Pos", Vector3.new(1,2,3))
p:GetAttributeChangedSignal("Health"):Connect(function() print("hp", p:GetAttribute("Health")) end)
p:SetAttribute("Health", 50)
print(p:GetAttribute("Health"), p:GetAttribute("Pos"), p:GetAttribute("Missing"))
print(pcall(function() p:SetAttribute("Bad", {}) end))
p:AddTag("Lava") print(p:HasTag("Lava"), #p:GetTags())
local m = Instance.new("Model") p.Parent = m local w = Instance.new("WeldConstraint") w.Part0 = p w.Parent = m
local c = m:Clone()
print(#c:GetChildren(), c.WeldConstraint.Part0 == c.Part, c.Part:GetAttribute("Health"), c.Part:HasTag("Lava"))
`, `hp 50
50 1, 2, 3 nil
false ServerScriptService.TestScript:7: table is not a supported attribute type
true 1
2 true 50 true`);
t('runtime error with trace', `local x = nil\nprint(x.y)`, `E:ServerScriptService.TestScript:2: attempt to index nil with 'y'`);
t('syntax error', `print("a"`, `E:ServerScriptService.TestScript:1: Expected ')' to close function call arguments, got '<eof>'`);

// save / load round trip
{
  total++;
  const { w, dm } = makeWorld('edit');
  const s = new Instance('Script', w); s.props.Name = 'Hello'; s.props.Source = 'print("hi")'; s.setParent(dm.findFirstChildOfClass('ServerScriptService'));
  const p = new Instance('Part', w); p.props.Name = 'Red'; p.setAttribute('A', 5); p.addTag('T'); p.setParent(dm.findFirstChildOfClass('Workspace'));
  for (const fmt of ['rbxl', 'rbxlx']) {
    const bytes = serializePlace(dm, fmt);
    const w2 = new World({ kind: 'edit' });
    const { dm: dm2 } = loadPlace(bytes, w2);
    const red = dm2.findFirstChildOfClass('Workspace').findFirstChild('Red');
    const ok = red && red.getAttribute('A') === 5 && red.hasTag('T') && dm2.findFirstChildOfClass('ServerScriptService').findFirstChild('Hello').get('Source') === 'print("hi")'
      && dm2.findFirstChildOfClass('Workspace').findFirstChild('Baseplate').get('Size').X === 2048
      && dm2.findFirstChildOfClass('Workspace').findFirstChild('Baseplate').findFirstChildOfClass('Texture').get('Texture') === 'rbxassetid://6372755229';
    if (!ok) { fails++; console.log('FAIL save/load', fmt); }
  }
}
// load real test place
{
  total++;
  const fs = await import('node:fs');
  const f = '/tmp/rbxtest/places/baseplate-566/binary.rbxl';
  if (fs.existsSync(f)) {
    const w = new World({ kind: 'edit' });
    const { dm } = loadPlace(new Uint8Array(fs.readFileSync(f)), w);
    const bp = dm.findFirstChildOfClass('Workspace').findFirstChild('Baseplate');
    if (!bp || bp.get('Size').X !== 2048) { fails++; console.log('FAIL real place load', bp && bp.get('Size')); }
  }
}
console.log(`${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
