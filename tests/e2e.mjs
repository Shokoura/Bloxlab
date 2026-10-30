// Browser end-to-end tests (Playwright + Chromium):  node tests/e2e.mjs [--keep-screenshots dir]
// Starts the static server, then drives Studio: editing, Play, input, GUI, avatars through a mocked
// External Load proxy, plugins, terrain and two-tab multiplayer.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}/`;
const shotsDir = process.argv.includes('--keep-screenshots') ? process.argv[process.argv.indexOf('--keep-screenshots') + 1] : null;

const server = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

let total = 0, fails = 0;
const ok = (cond, name, extra = '') => { total++; if (cond) console.log(`  ok  ${name}`); else { fails++; console.log(`  FAIL ${name} ${extra}`); } };
const errorsOf = (logs) => logs.filter((l) => l.startsWith('[pageerror]') || (l.startsWith('[error]') && !/Failed to load resource|ERR_|status of 404/.test(l)));

async function open(ctx, url = BASE) {
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { if (!/GPU stall|WebGL|swiftshader/i.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.bloxlab && window.bloxlab.editWorld, null, { timeout: 20000 });
  return { page, logs };
}
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };
const hrp = (page) => page.evaluate(() => { const c = window.bloxlab.session.active.character.findFirstChild('HumanoidRootPart').props.CFrame; return { x: c.X, y: c.Y, z: c.Z }; });

try {
  // ---------------------------------------------------------------- editing
  console.log('studio');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const { page, logs } = await open(ctx);
    const r = await page.evaluate(() => {
      const app = window.bloxlab;
      const ws = app.dm().findFirstChildOfClass('Workspace');
      const before = ws.children.length;
      app.insertObject('Part');
      const after = ws.children.length;
      app.history.undo();
      const undone = ws.children.length;
      app.editWorld.exec('local g = Instance.new("ScreenGui", game.StarterGui) local t = Instance.new("TextLabel", g) t.Name = "Hello" t.Text = "Preview text" t.Size = UDim2.fromOffset(200, 40)');
      return { before, after, undone };
    });
    ok(r.after === r.before + 1 && r.undone === r.before, 'insert part and undo');
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => [...document.querySelectorAll('.game-ui.edit .TextLabel')].some((e) => e.textContent.includes('Preview text'))), 'StarterGui preview while editing');
    // save / reopen round trip
    const rt = await page.evaluate(async () => {
      const app = window.bloxlab;
      const { serializePlace } = await import('/js/engine/datamodel.js');
      const bytes = serializePlace(app.dm(), 'rbxl');
      app.project.dirty = false;
      await app.openBytes(bytes, 'Roundtrip.rbxl');
      return app.dm().findFirstChildOfClass('StarterGui').findFirstChild('ScreenGui')?.findFirstChild('Hello')?.props.Text;
    });
    ok(rt === 'Preview text', 'save and reopen .rbxl');
    // toolbox
    await page.evaluate(async () => { const app = window.bloxlab; app.togglePanel('toolbox'); });
    await page.waitForSelector('.tb-item');
    await page.evaluate(() => window.bloxlab.toolbox.insert('killbrick'));
    ok(await page.evaluate(() => !!window.bloxlab.dm().findFirstChildOfClass('Workspace').findFirstChild('KillBrick')), 'toolbox inserts a starter model');
    ok(errorsOf(logs).length === 0, 'no page errors while editing', errorsOf(logs).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------------- play
  console.log('play');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const { page, logs } = await open(ctx);
    await page.evaluate(() => {
      const app = window.bloxlab;
      app.editWorld.exec(`
local g = Instance.new("ScreenGui") g.Name = "Hud" g.Parent = game.StarterGui
local b = Instance.new("TextButton") b.Name = "Btn" b.Size = UDim2.fromOffset(160, 50) b.Position = UDim2.fromOffset(500, 400) b.Text = "Click me" b.Parent = g
local l = Instance.new("LocalScript") l.Source = [[script.Parent.MouseButton1Click:Connect(function() script.Parent.Text = "Clicked!" end)]] l.Parent = b
workspace.Terrain:FillBlock(CFrame.new(60, 4, 0), Vector3.new(20, 8, 20), Enum.Material.Grass)`, 'setup');
    });
    await page.keyboard.press('F5');
    await page.waitForFunction(() => window.bloxlab.session && window.bloxlab.session.running && window.bloxlab.session.active.character, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const p0 = await hrp(page);
    ok(p0.y > 2 && p0.y < 6, 'character spawned on the spawn location', JSON.stringify(p0));
    await page.locator('.viewport-canvas').click();
    await page.keyboard.down('w'); await page.waitForTimeout(800); await page.keyboard.up('w');
    const p1 = await hrp(page);
    ok(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 3, 'W walks', `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    ok((await hrp(page)).y > p1.y + 2, 'Space jumps');
    const btn = await page.$('.game-ui:not(.edit) .TextButton');
    ok(!!btn, 'ScreenGui button rendered');
    if (btn) await btn.click();
    const clicked = await page.waitForFunction(() => [...document.querySelectorAll('.game-ui .TextButton')].some((e) => e.textContent.includes('Clicked!')), null, { timeout: 5000 }).then(() => true, () => false);
    ok(clicked, 'GUI click runs the LocalScript');
    await page.evaluate(() => window.bloxlab.session.server.world.exec('game.Players:GetPlayers()[1].Character:PivotTo(CFrame.new(60, 20, 0))'));
    await page.waitForTimeout(1500);
    const p2 = await hrp(page);
    ok(Math.abs(p2.y - 11) < 1, 'stands on terrain', JSON.stringify(p2));
    await shot(page, 'play');
    await page.keyboard.press('Shift+F5');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => !window.bloxlab.session), 'Shift+F5 stops');
    ok(errorsOf(logs).length === 0, 'no page errors while playing', errorsOf(logs).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------------- avatars through a mocked External Load proxy
  console.log('avatars');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 } });
    const assets = {};
    const hits = [];
    await ctx.route('https://mock.proxy/**', async (route) => {
      const u = new URL(route.request().url());
      hits.push(u.pathname);
      if (u.pathname === '/api/users/v1/usernames/users') return route.fulfill({ json: { data: [{ id: 156, name: 'builderman', displayName: 'Builder' }] } });
      if (u.pathname === '/api/avatar/v1/users/156/avatar') return route.fulfill({ json: { playerAvatarType: 'R15', scales: {}, bodyColors: { headColorId: 125, torsoColorId: 23, leftArmColorId: 125, rightArmColorId: 125, leftLegColorId: 1, rightLegColorId: 1 }, assets: [{ id: 900001, assetType: { id: 11 } }, { id: 900003, assetType: { id: 8 } }] } });
      if (u.pathname === '/asset') { const a = assets[u.searchParams.get('id')]; if (a) return route.fulfill({ body: a, contentType: 'application/octet-stream' }); }
      return route.fulfill({ status: 404, body: 'missing' });
    });
    const { page } = await open(ctx);
    const made = await page.evaluate(async () => {
      const { Instance } = await import('/js/engine/instance.js');
      const { serialize } = await import('/js/engine/datamodel.js');
      const { Vector3, CFrame } = await import('/js/engine/datatypes.js');
      const w = window.bloxlab.editWorld;
      const b64 = (u8) => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s); };
      const shirt = new Instance('Shirt', w); shirt.props.Name = 'Shirt'; shirt.props.ShirtTemplate = 'rbxassetid://900011';
      const acc = new Instance('Accessory', w); acc.props.Name = 'TallHat';
      const handle = new Instance('Part', w); handle.props.Name = 'Handle'; handle.props.Size = new Vector3(1.2, 2, 1.2); handle.setParent(acc);
      const att = new Instance('Attachment', w); att.props.Name = 'HatAttachment'; att.props.CFrame = new CFrame(0, -0.9, 0); att.setParent(handle);
      const c = document.createElement('canvas'); c.width = 585; c.height = 559; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 585, 559);
      const png = await new Promise((res) => c.toBlob((bl) => bl.arrayBuffer().then((a) => res(b64(new Uint8Array(a)))), 'image/png'));
      return { shirt: b64(serialize([shirt], 'rbxm')), hat: b64(serialize([acc], 'rbxm')), png };
    });
    assets['900001'] = Buffer.from(made.shirt, 'base64');
    assets['900003'] = Buffer.from(made.hat, 'base64');
    assets['900011'] = Buffer.from(made.png, 'base64');
    const r = await page.evaluate(async () => {
      const app = window.bloxlab;
      app.settings.set('proxies', [{ name: 'mock', url: 'https://mock.proxy/asset?id={id}', enabled: true }]);
      app.settings.set('apiProxy', 'https://mock.proxy');
      app.settings.set('avatarMode', 'roblox');
      app.settings.set('avatarUser', 'builderman');
      app.settings.set('cacheAssets', false);
      await app.play('play');
      await new Promise((res) => setTimeout(res, 2000));
      const ch = app.session.active.character;
      return ch ? ch.children.map((c) => c.ClassName).join(',') : 'none';
    });
    ok(/Shirt/.test(r) && /Accessory/.test(r), 'Roblox avatar loads shirt and accessory through the proxy', r);
    ok(hits.includes('/api/avatar/v1/users/156/avatar') && hits.includes('/asset'), 'proxy used for API and assets');
    await shot(page, 'avatar');
    await ctx.close();
  }

  // ---------------------------------------------------------------- plugins
  console.log('plugins');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const { page, logs } = await open(ctx);
    await page.evaluate(async () => {
      const app = window.bloxlab;
      const host = await app.ensurePlugins();
      await host.install({ name: 'Painter', kind: 'lua', source: `
local b = plugin:CreateToolbar("Tools"):CreateButton("Paint", "Paint selection", "")
b.Click:Connect(function()
  for _, o in ipairs(game:GetService("Selection"):Get()) do o.Color = Color3.new(0, 0, 1) end
  game:GetService("ChangeHistoryService"):SetWaypoint("Paint")
end)` });
      await host.install({ name: 'Counter', kind: 'js', source: `bloxlab.button('c', { label: 'Count' }); bloxlab.on('click', async () => { const out = await bloxlab.lua('print(#workspace:GetChildren())'); bloxlab.print('count=' + out.join('')); });` });
      app.ribbonTab = 'PLUGINS'; app.buildRibbon();
      app.selection.set([app.dm().findFirstChildOfClass('Workspace').findFirstChild('SpawnLocation')]);
    });
    await page.waitForTimeout(500);
    const ids = await page.evaluate(() => window.bloxlab.pluginHost.plugins.map((p) => p.id));
    await page.click(`#rb-plg-${ids[0]}-Paint`);
    await page.click(`#rb-plg-${ids[1]}-c`);
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const app = window.bloxlab;
      const sp = app.dm().findFirstChildOfClass('Workspace').findFirstChild('SpawnLocation');
      const painted = sp.props.Color.B === 1;
      const u = app.history.undo();
      return { painted, undo: u, restored: sp.props.Color.B < 1, out: [...document.querySelectorAll('.out-row .msg')].map((e) => e.textContent).join(' / ') };
    });
    ok(r.painted, 'Lua plugin button runs');
    ok(r.undo === 'Paint' && r.restored, 'plugin waypoint can be undone', JSON.stringify(r));
    ok(/count=\d+/.test(r.out), 'sandboxed JS plugin talks to Studio', r.out.slice(-200));
    ok(errorsOf(logs).length === 0, 'no page errors with plugins', errorsOf(logs).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------------- multiplayer between two tabs
  console.log('multiplayer');
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    const host = await open(ctx);
    await host.page.evaluate(async () => {
      const app = window.bloxlab;
      app.settings.set('playerName', 'Host');
      app.editWorld.exec(`local e = Instance.new("RemoteEvent") e.Name = "Ping" e.Parent = game.ReplicatedStorage
local s = Instance.new("Script") s.Source = [[game.ReplicatedStorage.Ping.OnServerEvent:Connect(function(p, n) workspace:SetAttribute("Pinged", p.Name .. n) end)]] s.Parent = game.ServerScriptService
local l = Instance.new("LocalScript") l.Source = [[task.wait(0.5) game.ReplicatedStorage.Ping:FireServer(42)]] l.Parent = game.StarterPlayer.StarterPlayerScripts`, 'setup');
      await app.play('play');
      const { hostBroadcast } = await import('/js/net/transport.js');
      app.session.addHost(hostBroadcast('e2e', (ep, info) => app.session.accept(ep, info)));
    });
    const guest = await open(ctx, `${BASE}?join=tab:e2e`);
    await guest.page.waitForFunction(() => window.bloxlab.session && window.bloxlab.session.running && window.bloxlab.session.active.character, null, { timeout: 30000 });
    await guest.page.waitForTimeout(1500);
    const players = await host.page.evaluate(() => [...window.bloxlab.session.server.players.keys()].map((p) => p.props.Name).sort().join(','));
    ok(players.split(',').length === 2, 'guest joined the host', players);
    ok(await host.page.evaluate(() => /42$/.test(window.bloxlab.session.server.world.dm.findFirstChildOfClass('Workspace').getAttribute('Pinged') || '')), 'guest RemoteEvent reached the host server');
    await guest.page.bringToFront();
    await guest.page.locator('.viewport-canvas').click();
    const g0 = await hrp(guest.page);
    await guest.page.keyboard.down('w');
    // hold W until the guest has walked (software rendering can starve one of the two pages of frames)
    await guest.page.waitForFunction((p0) => { const r = window.bloxlab.session.active.character.findFirstChild('HumanoidRootPart').props.CFrame; return Math.hypot(r.X - p0.x, r.Z - p0.z) > 8; }, g0, { timeout: 10000 }).catch(() => {});
    await guest.page.keyboard.up('w');
    await guest.page.waitForTimeout(800);
    const g1 = await hrp(guest.page);
    const seen = await host.page.evaluate((name) => { const p = window.bloxlab.session.server.world.dm.findFirstChildOfClass('Players').children.find((x) => x.props.Name !== 'Host'); const c = p.props.Character.findFirstChild('HumanoidRootPart').props.CFrame; return { x: c.X, z: c.Z }; });
    ok(Math.hypot(g1.x - g0.x, g1.z - g0.z) > 5 && Math.hypot(seen.x - g1.x, seen.z - g1.z) < 1.5, 'guest movement replicates to the host', `${JSON.stringify(g1)} vs ${JSON.stringify(seen)}`);
    await shot(host.page, 'mp-host');
    ok(errorsOf(host.logs).length + errorsOf(guest.logs).length === 0, 'no page errors in multiplayer', [...errorsOf(host.logs), ...errorsOf(guest.logs)].join(' | '));
    await ctx.close();
  }
} catch (e) {
  fails++;
  console.log('  FAIL (exception)', e);
} finally {
  await browser.close();
  server.kill();
}
console.log(`${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
