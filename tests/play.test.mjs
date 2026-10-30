// node --import ./tests/node-loader.mjs tests/play.test.mjs
// Headless play session: server + loopback client, replication, remotes, characters, movement.
import '../js/engine/classes/index.js';
import { World } from '../js/engine/world.js';
import { Instance } from '../js/engine/instance.js';
import { newBaseplate } from '../js/engine/datamodel.js';
import { Vector3, CFrame } from '../js/engine/datatypes.js';
import { GameServer } from '../js/game/server.js';
import { ClientRuntime } from '../js/game/client.js';
import { loopbackPair, StringEndpoint } from '../js/net/transport.js';

let fails = 0, total = 0;
const ok = (cond, name, extra = '') => { total++; if (!cond) { fails++; console.log(`FAIL ${name} ${extra}`); } };

const logs = [];
const settings = { values: { avatarRig: 'R15', shareWithPeers: true }, get(k) { return this.values[k]; }, set(k, v) { this.values[k] = v; } };
const app = { output: { add: (e) => logs.push(`[${e.worldName}${e.kind === 'output' ? '' : `:${e.kind}`}] ${e.msg}`) }, settings, assets: { bytes: async () => { throw new Error('offline'); } } };

function makePlace() {
  const w = new World({ kind: 'edit', name: 'edit' });
  const dm = newBaseplate(w);
  w.setGameGlobals(dm);
  const add = (cls, parent, props) => { const i = new Instance(cls, w); Object.assign(i.props, props); i.setParent(parent); return i; };
  const sss = dm.findFirstChildOfClass('ServerScriptService');
  add('Script', sss, { Name: 'Main', Source: `
local RS = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local ev = Instance.new("RemoteEvent") ev.Name = "Ping" ev.Parent = RS
local fn = Instance.new("RemoteFunction") fn.Name = "Add" fn.Parent = RS
fn.OnServerInvoke = function(player, a, b) return a + b, player.Name end
ev.OnServerEvent:Connect(function(player, msg, t)
  print("server got", player.Name, msg, t.x, typeof(t.v))
  ev:FireClient(player, "pong", workspace.Ball)
end)
Players.PlayerAdded:Connect(function(p)
  print("joined", p.Name)
  local ls = Instance.new("Folder") ls.Name = "leaderstats" ls.Parent = p
  local c = Instance.new("IntValue") c.Name = "Coins" c.Value = 5 c.Parent = ls
  p.CharacterAdded:Connect(function(ch) print("server char", ch.Name, ch:FindFirstChildOfClass("Humanoid") ~= nil) end)
end)
local ball = Instance.new("Part") ball.Name = "Ball" ball.Shape = Enum.PartType.Ball ball.Size = Vector3.new(2,2,2)
ball.Position = Vector3.new(20, 30, 0) ball.Parent = workspace
task.wait(1)
print("ball y", math.floor(ball.Position.Y))
` });
  const sps = dm.findFirstChildOfClass('StarterPlayer').findFirstChildOfClass('StarterPlayerScripts');
  add('LocalScript', sps, { Name: 'Client', Source: `
local RS = game:GetService("ReplicatedStorage")
local player = game:GetService("Players").LocalPlayer
print("local player", player.Name)
local ev = RS:WaitForChild("Ping")
ev.OnClientEvent:Connect(function(msg, ball) print("client got", msg, ball and ball.Name) end)
ev:FireServer("hello", { x = 42, v = Vector3.new(1, 2, 3) })
print("invoke", RS:WaitForChild("Add"):InvokeServer(2, 3))
local ch = player.Character or player.CharacterAdded:Wait()
print("client char", ch.Name, ch:WaitForChild("HumanoidRootPart") ~= nil)
print("coins", player:WaitForChild("leaderstats"):WaitForChild("Coins").Value)
` });
  add('LocalScript', dm.findFirstChildOfClass('StarterPlayer').findFirstChildOfClass('StarterCharacterScripts'), { Name: 'CharScript', Source: 'print("character script runs on", game:GetService("Players").LocalPlayer.Name)' });
  const sg = dm.findFirstChildOfClass('StarterGui');
  const gui = add('ScreenGui', sg, { Name: 'Hud' });
  add('TextLabel', gui, { Name: 'Label', Text: 'hi' });
  add('LocalScript', gui, { Name: 'GuiScript', Source: 'print("gui script", script.Parent.Label.Text)' });
  const tool = add('Tool', dm.findFirstChildOfClass('StarterPack'), { Name: 'Sword' });
  add('Part', tool, { Name: 'Handle', Size: new Vector3(1, 4, 1) });
  return dm;
}

async function run(clientTransport) {
  logs.length = 0;
  const server = new GameServer(app, makePlace());
  await server.start();
  const [a, b] = clientTransport ? clientTransport() : loopbackPair();
  server.replicator.addConnection(a);
  const client = new ClientRuntime(app, b, { name: 'Tester', label: 'Client' });
  const tick = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) { server.tick(dt); client.tick(dt); } };
  await new Promise((r) => setTimeout(r, 50));
  tick(5);
  await new Promise((r) => setTimeout(r, 10));
  tick(180);
  return { server, client, tick };
}

const { server, client, tick } = await run();
const has = (s) => logs.some((l) => l.includes(s));
ok(has('[Server] joined Tester'), 'player joined');
ok(has('[Client] local player Tester'), 'local player');
ok(has('[Server] server got Tester hello 42 Vector3'), 'FireServer with table + Vector3', logs.filter((l) => l.includes('server got')).join('|'));
ok(has('[Client] client got pong Ball'), 'FireClient with instance ref');
ok(has('[Client] invoke 5 Tester'), 'InvokeServer', logs.filter((l) => l.includes('invoke')).join('|'));
ok(has('[Server] server char Tester true'), 'server CharacterAdded');
ok(has('[Client] client char Tester true'), 'client CharacterAdded');
ok(has('[Client] coins 5'), 'leaderstats replicate');
ok(has('[Client] character script runs on Tester'), 'StarterCharacterScripts LocalScript runs on owner');
ok(has('[Client] gui script hi'), 'PlayerGui LocalScript');
ok(has('[Server] ball y'), 'server script continued');
const cBall = client.world.dm.findFirstChildOfClass('Workspace').findFirstChild('Ball');
const sBall = server.world.dm.findFirstChildOfClass('Workspace').findFirstChild('Ball');
ok(cBall && sBall && Math.abs(cBall.props.CFrame.Y - sBall.props.CFrame.Y) < 0.01 && sBall.props.CFrame.Y < 20, 'physics poses replicate', `${cBall?.props.CFrame.Y} vs ${sBall?.props.CFrame.Y}`);
// character
const ch = client.character;
ok(!!ch && !!client.humanoid && !!client.humanoid.controller, 'client controls its character');
const hrp = ch && ch.findFirstChild('HumanoidRootPart');
const y0 = hrp ? hrp.props.CFrame.Y : 0;
ok(hrp && y0 > 2 && y0 < 6, 'character stands on the spawn', `y=${y0}`);
const bp = client.localPlayer.findFirstChildOfClass('Backpack');
ok(bp && bp.findFirstChild('Sword'), 'StarterPack tool in backpack');
// walk forward
client.humanoid.moveDir = new Vector3(0, 0, -1);
const z0 = hrp.props.CFrame.Z;
tick(60);
client.humanoid.moveDir = Vector3.zero;
tick(5);
const z1 = hrp.props.CFrame.Z;
ok(z0 - z1 > 12 && z0 - z1 < 20, 'walks ~16 studs/s', `dz=${z0 - z1}`);
const sHrp = server.playerFromCharacter ? [...server.players.keys()][0].props.Character.findFirstChild('HumanoidRootPart') : null;
ok(sHrp && Math.abs(sHrp.props.CFrame.Z - z1) < 0.01, 'server sees the client pose', `${sHrp?.props.CFrame.Z} vs ${z1}`);
// jump
const yj = hrp.props.CFrame.Y;
client.humanoid.jumpRequest = true;
let peak = 0;
for (let i = 0; i < 40; i++) { tick(1); peak = Math.max(peak, hrp.props.CFrame.Y - yj); }
ok(peak > 6.5 && peak < 7.6, 'jump height ~7.2', `peak=${peak}`);
tick(60);
// equip tool
client.equip(bp.findFirstChild('Sword'));
tick(3);
const sTool = [...server.players.keys()][0].props.Character.findFirstChild('Sword');
ok(!!sTool && !!ch.findFirstChild('Sword') && !!ch.findFirstChild('RightHand').findFirstChild('RightGrip'), 'tool equipped on server and replicated grip');
// server teleport reaches the owner
const sChar = [...server.players.keys()][0].props.Character;
server.world.exec('local p = game.Players:GetPlayers()[1] p.Character:PivotTo(CFrame.new(50, 10, 50))');
tick(3);
ok(Math.abs(hrp.props.CFrame.X - 50) < 1 && Math.abs(hrp.props.CFrame.Z - 50) < 1, 'server PivotTo moves the owner', `${hrp.props.CFrame.X},${hrp.props.CFrame.Z}`);
// terrain filled by a server script replicates and is solid on both sides
server.world.exec('workspace.Terrain:FillBlock(CFrame.new(80, 10, 80), Vector3.new(24, 4, 24), Enum.Material.Grass) game.Players:GetPlayers()[1].Character:PivotTo(CFrame.new(80, 20, 80))');
tick(90);
ok(Math.abs(hrp.props.CFrame.Y - 15) < 0.6, 'stands on scripted terrain', `y=${hrp.props.CFrame.Y}`);
ok((client.world.dm.findFirstChildOfClass('Workspace').findFirstChildOfClass('Terrain').props.Voxels || []).length === 1, 'terrain fill replicated');
// damage + death + respawn
server.world.exec('game.Players:GetPlayers()[1].Character.Humanoid.Health = 0');
tick(2);
ok(client.humanoid.state === 'Dead', 'client sees death', client.humanoid.state);
tick(60 * 6);
await new Promise((r) => setTimeout(r, 5));
tick(10);
ok(client.character && client.character !== ch && client.humanoid.state !== 'Dead', 'respawned');
void sChar;
server.stop(); client.stop();

// same game through the JSON/chunking transport used for network play
const strPair = () => {
  let ea, eb;
  ea = new StringEndpoint({ send: (s) => queueMicrotask(() => eb.receiveRaw(s)), close: () => eb.markClosed() });
  eb = new StringEndpoint({ send: (s) => queueMicrotask(() => ea.receiveRaw(s)), close: () => ea.markClosed() });
  return [ea, eb];
};
const r2 = await run(strPair);
for (let i = 0; i < 20; i++) { r2.tick(10); await new Promise((r) => setTimeout(r, 1)); }
ok(logs.some((l) => l.includes('[Client] coins 5')) && logs.some((l) => l.includes('[Client] invoke 5 Tester')), 'works over the string transport', logs.filter((l) => /error|warn/.test(l)).slice(0, 5).join(' | '));
r2.server.stop(); r2.client.stop();

// a constraint car: Seat:Sit on the server, network ownership, ControlModule steering on the client
{
  logs.length = 0;
  const w = new World({ kind: 'edit', name: 'edit' });
  const dm = newBaseplate(w);
  w.setGameGlobals(dm);
  const add = (cls, parent, props) => { const i = new Instance(cls, w); Object.assign(i.props, props); i.setParent(parent); return i; };
  add('Script', dm.findFirstChildOfClass('ServerScriptService'), { Name: 'Cars', Source: `
local ms = game.MarketplaceService
local f = Instance.new("Folder") f.Name = "Stages" f.Parent = workspace
local s1 = Instance.new("Part") s1.Name = "1" s1.Anchored = true s1.Parent = f
print("numeric child", workspace.Stages[1] == s1, ms.ClassName)
local car = Instance.new("Model") car.Name = "Car"
local chassis = Instance.new("Part") chassis.Name = "Chassis" chassis.Size = Vector3.new(6, 1, 10) chassis.CFrame = CFrame.new(40, 3, 0) chassis.Parent = car
local seat = Instance.new("VehicleSeat") seat.Name = "VehicleSeat" seat.Size = Vector3.new(2, 1, 2) seat.CFrame = CFrame.new(40, 4, 0) seat.Parent = car
local weld = Instance.new("WeldConstraint") weld.Part0 = chassis weld.Part1 = seat weld.Parent = chassis
local motors = Instance.new("Folder") motors.Name = "Motors" motors.Parent = car
for _, x in ipairs({ -3.6, 3.6 }) do for _, z in ipairs({ -3.5, 3.5 }) do
  local wheel = Instance.new("Part") wheel.Shape = Enum.PartType.Cylinder wheel.Size = Vector3.new(1, 3, 3) wheel.CFrame = CFrame.new(40 + x, 1.5, z) wheel.Parent = car
  local a0 = Instance.new("Attachment") a0.Position = Vector3.new(x, -1.5, z) a0.Parent = chassis
  local a1 = Instance.new("Attachment") a1.Parent = wheel
  local h = Instance.new("HingeConstraint") h.Attachment0 = a0 h.Attachment1 = a1 h.ActuatorType = Enum.ActuatorType.Motor h.MotorMaxTorque = 5000 h.Parent = motors
end end
car.Parent = workspace
game.Players.PlayerAdded:Connect(function(p)
  p.CharacterAdded:Connect(function(ch)
    seat:Sit(ch:WaitForChild("Humanoid"))
    for _, d in ipairs(car:GetDescendants()) do if d:IsA("BasePart") then d:SetNetworkOwner(p) end end
  end)
end)` });
  add('LocalScript', dm.findFirstChildOfClass('StarterPlayer').findFirstChildOfClass('StarterPlayerScripts'), { Name: 'Drive', Source: `
local controls = require(game.Players.LocalPlayer.PlayerScripts:WaitForChild("PlayerModule"):WaitForChild("ControlModule"))
local motors = workspace:WaitForChild("Car"):WaitForChild("Motors")
game:GetService("RunService").RenderStepped:Connect(function()
  for _, h in ipairs(motors:GetChildren()) do h.AngularVelocity = 20 * controls:GetMoveVector().Z end
end)` });
  const server = new GameServer(app, dm);
  await server.start();
  const [a, b] = loopbackPair();
  server.replicator.addConnection(a);
  const client = new ClientRuntime(app, b, { name: 'Driver' });
  const tick = async (n) => { for (let i = 0; i < n; i++) { server.tick(1 / 60); client.tick(1 / 60); if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0)); } };
  await new Promise((r) => setTimeout(r, 30));
  await tick(120);
  ok(logs.some((l) => l.includes('numeric child true MarketplaceService')), 'folder[number] and game.Service indexing', logs.filter((l) => /numeric|error/.test(l)).join(' | '));
  ok(client.humanoid && client.humanoid.seat && client.humanoid.seat.ClassName === 'VehicleSeat', 'server Seat:Sit seats the player');
  const car = server.world.dm.findFirstChildOfClass('Workspace').findFirstChild('Car').findFirstChild('Chassis');
  const z0 = car.props.CFrame.Z;
  for (let i = 0; i < 150; i++) { client.moveVector = new Vector3(0, 0, -1); await tick(1); }
  const moved = Math.abs(car.props.CFrame.Z - z0);
  ok(moved > 8, 'client ControlModule input drives the owned car', `moved ${moved.toFixed(1)}`);
  const hrpC = client.character.findFirstChild('HumanoidRootPart');
  ok(Math.abs(hrpC.props.CFrame.Z - car.props.CFrame.Z) < 3, 'driver rides along on the client', `${hrpC.props.CFrame.Z} vs ${car.props.CFrame.Z}`);
  server.stop(); client.stop();
}

const errors = logs.filter((l) => /:error\]/.test(l));
if (errors.length) console.log('script errors:\n' + errors.join('\n'));
console.log(`${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
