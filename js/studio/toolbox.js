// Toolbox: ready-made starter models (with scripts) and a Roblox marketplace search that inserts
// models through External Load.
import { h, toast } from './ui.js';
import { icon } from './icons.js';
import { Instance } from '../engine/instance.js';
import { Vector3, CFrame, Color3, BrickColor, UDim2, Vector2 } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { buildRig } from '../game/characters.js';

function part(w, props) {
  const p = new Instance(props.ClassName || 'Part', w);
  delete props.ClassName;
  Object.assign(p.props, { Anchored: true, TopSurface: E('SurfaceType', 'Smooth'), BottomSurface: E('SurfaceType', 'Smooth'), ...props });
  return p;
}
function add(parent, child) { child.parent = parent; parent.children.push(child); return child; }
function script(w, cls, name, src) { const s = new Instance(cls, w); s.props.Name = name; s.props.Source = src.trim(); return s; }
function model(w, name, ...kids) { const m = new Instance('Model', w); m.props.Name = name; for (const k of kids) add(m, k); return m; }

const ITEMS = [
  { id: 'killbrick', name: 'Kill Brick', icon: 'bolt', make: (w) => { const p = part(w, { Name: 'KillBrick', Size: new Vector3(8, 1, 8), Color: Color3.fromRGB(255, 0, 0), Material: E('Material', 'Neon') }); add(p, script(w, 'Script', 'Kill', `
script.Parent.Touched:Connect(function(hit)
\tlocal hum = hit.Parent:FindFirstChildOfClass("Humanoid")
\tif hum then hum.Health = 0 end
end)`)); return p; } },
  { id: 'jumppad', name: 'Jump Pad', icon: 'arrows', make: (w) => { const p = part(w, { Name: 'JumpPad', Size: new Vector3(6, 0.6, 6), Color: Color3.fromRGB(0, 255, 120), Material: E('Material', 'Neon') }); add(p, script(w, 'Script', 'Launch', `
local debounce = {}
script.Parent.Touched:Connect(function(hit)
\tlocal root = hit.Parent:FindFirstChild("HumanoidRootPart")
\tif root and not debounce[root] then
\t\tdebounce[root] = true
\t\troot.AssemblyLinearVelocity = Vector3.new(0, 120, 0)
\t\ttask.wait(0.5)
\t\tdebounce[root] = nil
\tend
end)`)); return p; } },
  { id: 'spinner', name: 'Spinner', icon: 'rotate', make: (w) => { const p = part(w, { Name: 'Spinner', Size: new Vector3(16, 1, 1), Color: Color3.fromRGB(255, 170, 0) }); add(p, script(w, 'Script', 'Spin', `
local part = script.Parent
local origin = part.CFrame
local angle = 0
game:GetService("RunService").Heartbeat:Connect(function(dt)
\tangle += dt * 2
\tpart.CFrame = origin * CFrame.Angles(0, angle, 0)
end)`)); return p; } },
  { id: 'coin', name: 'Coin + Leaderstats', icon: 'sun', make: (w) => {
    const coin = part(w, { Name: 'Coin', Shape: E('PartType', 'Cylinder'), Size: new Vector3(0.4, 3, 3), Color: Color3.fromRGB(255, 200, 0), Material: E('Material', 'Neon'), CanCollide: false });
    coin.props.CFrame = CFrame.angles(0, 0, Math.PI / 2);
    add(coin, script(w, 'Script', 'Collect', `
local coin = script.Parent
local Players = game:GetService("Players")
local function stats(player)
\tlocal ls = player:FindFirstChild("leaderstats")
\tif not ls then
\t\tls = Instance.new("Folder") ls.Name = "leaderstats" ls.Parent = player
\t\tlocal c = Instance.new("IntValue") c.Name = "Coins" c.Parent = ls
\tend
\treturn ls
end
Players.PlayerAdded:Connect(stats)
for _, p in ipairs(Players:GetPlayers()) do stats(p) end
local taken = false
coin.Touched:Connect(function(hit)
\tlocal player = Players:GetPlayerFromCharacter(hit.Parent)
\tif player and not taken then
\t\ttaken = true
\t\tstats(player).Coins.Value += 1
\t\tcoin.Transparency = 1
\t\ttask.wait(5)
\t\tcoin.Transparency = 0
\t\ttaken = false
\tend
end)`));
    return coin;
  } },
  { id: 'door', name: 'Door (Prompt)', icon: 'square', make: (w) => {
    const d = part(w, { Name: 'Door', Size: new Vector3(6, 9, 1), Color: Color3.fromRGB(105, 64, 40), Material: E('Material', 'Wood') });
    const pp = add(d, new Instance('ProximityPrompt', w)); pp.props.Name = 'ProximityPrompt'; pp.props.ActionText = 'Open'; pp.props.ObjectText = 'Door';
    add(d, script(w, 'Script', 'DoorScript', `
local door = script.Parent
local prompt = door.ProximityPrompt
local TweenService = game:GetService("TweenService")
local closed = door.CFrame
local open = closed * CFrame.new(-3, 0, -3) * CFrame.Angles(0, math.rad(90), 0)
local isOpen = false
prompt.Triggered:Connect(function()
\tisOpen = not isOpen
\tprompt.ActionText = isOpen and "Close" or "Open"
\tTweenService:Create(door, TweenInfo.new(0.5, Enum.EasingStyle.Quad), { CFrame = isOpen and open or closed }):Play()
end)`));
    return d;
  } },
  { id: 'teleporter', name: 'Teleporters', icon: 'link', make: (w) => {
    const a = part(w, { Name: 'TeleA', Size: new Vector3(5, 0.5, 5), Color: Color3.fromRGB(80, 120, 255), Material: E('Material', 'Neon') });
    const b = part(w, { Name: 'TeleB', Size: new Vector3(5, 0.5, 5), Color: Color3.fromRGB(255, 80, 200), Material: E('Material', 'Neon'), CFrame: new CFrame(30, 0, 0) });
    const m = model(w, 'Teleporters', a, b);
    add(m, script(w, 'Script', 'Teleport', `
local a, b = script.Parent.TeleA, script.Parent.TeleB
local cooldown = {}
local function link(from, to)
\tfrom.Touched:Connect(function(hit)
\t\tlocal char = hit.Parent
\t\tif char:FindFirstChildOfClass("Humanoid") and not cooldown[char] then
\t\t\tcooldown[char] = true
\t\t\tchar:PivotTo(to.CFrame + Vector3.new(0, 4, 0))
\t\t\ttask.wait(1)
\t\t\tcooldown[char] = nil
\t\tend
\tend)
end
link(a, b) link(b, a)`));
    return m;
  } },
  { id: 'sword', name: 'Sword Tool', icon: 'hammer', make: (w) => {
    const tool = new Instance('Tool', w); tool.props.Name = 'Sword'; tool.props.Grip = new CFrame(0, -1.5, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0);
    const handle = add(tool, part(w, { Name: 'Handle', Anchored: false, CanCollide: false, Size: new Vector3(0.6, 4, 0.3), Color: Color3.fromRGB(200, 200, 210), Material: E('Material', 'Metal') }));
    void handle;
    add(tool, script(w, 'Script', 'SwordScript', `
local tool = script.Parent
local handle = tool:WaitForChild("Handle")
local swinging = false
tool.Activated:Connect(function()
\tif swinging then return end
\tswinging = true
\tlocal hum = tool.Parent:FindFirstChildOfClass("Humanoid")
\tlocal conn = handle.Touched:Connect(function(hit)
\t\tlocal other = hit.Parent:FindFirstChildOfClass("Humanoid")
\t\tif other and other ~= hum then other:TakeDamage(20) end
\tend)
\ttask.wait(0.4)
\tconn:Disconnect()
\tswinging = false
end)`));
    return tool;
  }, parent: 'StarterPack' },
  { id: 'npc', name: 'R15 Dummy', icon: 'person', make: (w) => { const m = buildRig(w, 'R15', { name: 'Dummy' }); return m; } },
  { id: 'npc6', name: 'R6 Dummy', icon: 'person', make: (w) => buildRig(w, 'R6', { name: 'Dummy' }) },
  { id: 'walker', name: 'Walking NPC', icon: 'users', make: (w) => {
    const m = buildRig(w, 'R15', { name: 'Walker' });
    add(m, script(w, 'Script', 'Wander', `
local hum = script.Parent:WaitForChild("Humanoid")
local root = script.Parent:WaitForChild("HumanoidRootPart")
local home = root.Position
while true do
\thum:MoveTo(home + Vector3.new(math.random(-20, 20), 0, math.random(-20, 20)))
\thum.MoveToFinished:Wait()
\ttask.wait(math.random() * 2)
end`));
    return m;
  } },
  { id: 'daynight', name: 'Day/Night Cycle', icon: 'sun', make: (w) => script(w, 'Script', 'DayNight', `
local Lighting = game:GetService("Lighting")
local minutesPerSecond = 4
game:GetService("RunService").Heartbeat:Connect(function(dt)
\tLighting.ClockTime = (Lighting.ClockTime + dt * minutesPerSecond / 60) % 24
end)`), parent: 'ServerScriptService' },
  { id: 'checkpoint', name: 'Checkpoint', icon: 'spawn', make: (w) => { const p = part(w, { ClassName: 'SpawnLocation', Name: 'Checkpoint', Size: new Vector3(8, 1, 8), Color: Color3.fromRGB(80, 200, 80), Neutral: true }); add(p, script(w, 'Script', 'SetCheckpoint', `
script.Parent.Touched:Connect(function(hit)
\tlocal player = game:GetService("Players"):GetPlayerFromCharacter(hit.Parent)
\tif player then player.RespawnLocation = script.Parent end
end)`)); return p; } },
  { id: 'gui', name: 'Button GUI', icon: 'monitor', make: (w) => {
    const g = new Instance('ScreenGui', w); g.props.Name = 'ClickerGui'; g.props.ResetOnSpawn = false;
    const b = add(g, new Instance('TextButton', w)); Object.assign(b.props, { Name: 'Button', Size: UDim2.fromOffset(180, 50), Position: new UDim2(0.5, 0, 1, -110), AnchorPoint: new Vector2(0.5, 0), Text: 'Clicks: 0', TextSize: 22, BackgroundColor3: Color3.fromRGB(61, 155, 255), TextColor3: Color3.new(1, 1, 1), Font: E('Font', 'GothamBold') });
    const c = add(b, new Instance('UICorner', w)); c.props.Name = 'UICorner';
    add(b, script(w, 'LocalScript', 'Clicker', `
local button = script.Parent
local clicks = 0
button.MouseButton1Click:Connect(function()
\tclicks += 1
\tbutton.Text = "Clicks: " .. clicks
end)`));
    return g;
  }, parent: 'StarterGui' },
  { id: 'music', name: 'Background Music', icon: 'speaker', make: (w) => { const s = new Instance('Sound', w); Object.assign(s.props, { Name: 'Music', SoundId: 'rbxassetid://1837849285', Looped: true, Playing: true, Volume: 0.4 }); return s; }, parent: 'Workspace' },
  { id: 'lava', name: 'Rising Lava', icon: 'layers', make: (w) => { const p = part(w, { Name: 'Lava', Size: new Vector3(200, 2, 200), Color: Color3.fromRGB(255, 90, 0), Material: E('Material', 'Neon'), CFrame: new CFrame(0, -6, 0), CanCollide: false }); add(p, script(w, 'Script', 'Rise', `
local lava = script.Parent
lava.Touched:Connect(function(hit) local h = hit.Parent:FindFirstChildOfClass("Humanoid") if h then h.Health = 0 end end)
while true do
\tlava.Position += Vector3.new(0, 0.05, 0)
\tif lava.Position.Y > 30 then lava.Position = Vector3.new(0, -6, 0) end
\ttask.wait()
end`)); return p; } },
];

export class Toolbox {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.tab = 'starter';
    this.query = h('input', { class: 'input small', placeholder: 'Search the Roblox marketplace…' });
    this.query.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.search(); });
    this.grid = h('div', { class: 'toolbox-grid' });
    const tabs = h('div', { class: 'seg tb-tabs' },
      h('button', { class: 'btn small on', dataset: { t: 'starter' }, onclick: (e) => this.switch('starter', e.target) }, 'Starter'),
      h('button', { class: 'btn small', dataset: { t: 'market' }, onclick: (e) => this.switch('market', e.target) }, 'Marketplace'));
    this.searchRow = h('div', { class: 'hrow hidden' }, this.query, h('button', { class: 'btn small', onclick: () => this.search() }, icon('search')));
    el.append(tabs, this.searchRow, this.grid);
    this.renderStarter();
  }
  switch(t, btn) {
    this.tab = t;
    for (const b of btn.parentElement.children) b.classList.toggle('on', b === btn);
    this.searchRow.classList.toggle('hidden', t !== 'market');
    if (t === 'starter') this.renderStarter(); else { this.grid.replaceChildren(h('div', { class: 'muted small', text: 'Search free models by keyword, or paste an asset id. Models download through Settings → External Load.' })); }
  }
  renderStarter() {
    this.grid.replaceChildren(...ITEMS.map((it) => {
      const el = h('div', { class: 'tb-item', title: `Insert ${it.name}`, draggable: 'true', onclick: () => this.insert(it.id) }, icon(it.icon), h('span', { text: it.name }));
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-bloxlab-toolbox', it.id); });
      return el;
    }));
  }

  build(id) {
    const it = ITEMS.find((x) => x.id === id);
    if (!it) return null;
    return { inst: it.make(this.app.editWorld), parent: it.parent };
  }
  insert(id, point) {
    const app = this.app;
    const r = this.build(id);
    if (!r) return;
    const dm = app.dm();
    const parent = r.parent ? dm.findFirstChildOfClass(r.parent) : dm.findFirstChildOfClass('Workspace');
    const inst = r.inst;
    // place in front of the camera (or where it was dropped)
    const at = point ? new Vector3(point.x, point.y, point.z) : (() => { const cf = app.viewport.cameraCFrame(); const p = cf.Position.add(cf.LookVector.mul(20)); return new Vector3(p.X, Math.max(0, p.Y - 6), p.Z); })();
    const parts = inst.isA('BasePart') ? [inst] : inst.descendants().filter((d) => d.isA('BasePart'));
    if (parts.length && parent.ClassName === 'Workspace') {
      let minY = Infinity, cx = 0, cz = 0;
      for (const p of parts) { minY = Math.min(minY, p.props.CFrame.Y - p.props.Size.Y / 2); cx += p.props.CFrame.X; cz += p.props.CFrame.Z; }
      cx /= parts.length; cz /= parts.length;
      const delta = new CFrame(at.X - cx, at.Y - minY, at.Z - cz);
      for (const p of parts) p.props.CFrame = delta.mul(p.props.CFrame);
    }
    app.history.run(`Insert ${inst.props.Name}`, () => inst.setParent(parent));
    app.selection.set([inst]);
    toast(`Inserted ${inst.props.Name}${parent.ClassName !== 'Workspace' ? ` into ${parent.ClassName}` : ''}`);
  }
  dropAt(id, point) { this.insert(id, point); }

  async search() {
    const q = this.query.value.trim();
    if (!q) return;
    const app = this.app;
    if (/^\d+$/.test(q)) { this.insertAsset(q); return; }
    this.grid.replaceChildren(h('div', { class: 'muted small', text: 'Searching…' }));
    try {
      const j = await app.assets.api('apis', `/toolbox-service/v1/marketplace/10?limit=30&pageNumber=0&keyword=${encodeURIComponent(q)}&includeOnlyVerifiedCreators=false`);
      const ids = (j.data || []).map((d) => d.id).slice(0, 30);
      if (!ids.length) { this.grid.replaceChildren(h('div', { class: 'muted small', text: 'No results' })); return; }
      let details = [];
      try { const d = await app.assets.api('apis', `/toolbox-service/v1/items/details?assetIds=${ids.join(',')}`); details = d.data || []; } catch { /* names are optional */ }
      const nameOf = (id) => { const d = details.find((x) => x.asset && x.asset.id === id); return d ? d.asset.name : `Model ${id}`; };
      this.grid.replaceChildren(...ids.map((id) => {
        const img = h('img', { alt: '', class: 'tb-thumb' });
        app.assets.imageUrl(`rbxthumb://type=Asset&id=${id}&w=150&h=150`).then((u) => { img.src = u; }).catch(() => img.remove());
        return h('div', { class: 'tb-item', title: `rbxassetid://${id}`, onclick: () => this.insertAsset(id) }, img, h('span', { text: nameOf(id) }));
      }));
    } catch (e) {
      this.grid.replaceChildren(h('div', { class: 'muted small', text: `Marketplace search needs an API proxy (Settings → External Load). ${e.message}` }));
    }
  }
  async insertAsset(id) {
    try {
      const r = await this.app.assets.model(`rbxassetid://${id}`);
      this.app.insertModelBytes(r.bytes, null, `asset ${id}`);
    } catch (e) { toast(`Could not load model ${id}: ${e.message}`, 'error', 7000); }
  }
}
