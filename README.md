# Bloxlab Studio

A Roblox Studio-style game editor and player that runs entirely in the browser. Open `.rbxl` / `.rbxm`
files, edit them with Studio tools, write Luau, press **Play**, and play together with friends
peer-to-peer. No build step, no server required. It also works as a [nenecookie](#nenecookie) game.

> Bloxlab is an independent project. It is not affiliated with or endorsed by Roblox Corporation.
> Roblox assets you load are fetched by your own browser or your own proxy.

## Features

- **Files**: reads and writes binary and XML places and models (`.rbxl`, `.rbxlx`, `.rbxm`, `.rbxmx`),
  including attributes, tags, shared strings and LZ4 / ZSTD chunks. Drag files onto the viewport, use
  *File → Open*, save to the browser (IndexedDB) or download.
- **Studio**: Explorer, Properties (with attributes and tags), a Luau script editor with syntax highlighting,
  Output, Command Bar, Select / Move / Scale / Rotate gizmos with snapping, undo / redo, copy / paste /
  duplicate, group / ungroup, anchor / lock, part / UI / object insertion, effects, welds, a Toolbox with
  starter models and a Roblox marketplace search, and StarterGui previews while editing.
- **Luau**: a Luau-to-JavaScript compiler and runtime (types, compound assignment, `continue`,
  string interpolation, generalized iteration, `buffer`, `task`, coroutines, metatables …) with the
  Roblox globals and a large part of the Roblox API: Instances, datatypes, events, `RunService`,
  `TweenService`, `CollectionService`, `UserInputService`, `ContextActionService`, `Players`, `Teams`,
  `RemoteEvent` / `RemoteFunction`, `DataStoreService` (simulated, stored in the browser),
  `HttpService`, `MarketplaceService` (simulated purchases), `PathfindingService`, `Debris`, …
- **Play / Run**: a real server/client split. *Play* (F5) runs a server world and a client world with
  replication and FilteringEnabled semantics; *Run* (F8) runs the server only; *Play Here* spawns at the
  camera; *Client/Server* switches what Explorer and the viewport show. *Local Test* starts several players
  in one tab (*Next Player* switches who you control).
- **Game runtime**: Rapier physics (assemblies, joints, constraints, body movers, collision groups,
  `Touched`), Roblox-style characters (R6 / R15, walking, jumping, climbing, sitting, swimming states,
  tools, respawning), the classic camera (zoom, first person, shift lock, collision), keyboard / mouse /
  touch / gamepad input, ScreenGui / BillboardGui / SurfaceGui rendering with UI layouts and constraints,
  animations (KeyframeSequences plus built-in default animations), sounds (2D / 3D), particles, fire,
  smoke, sparkles, beams, trails, explosions, ClickDetectors, ProximityPrompts, chat with bubbles, a
  player list with leaderstats, backpack hotbar and the core menu.
- **Roblox assets**: `rbxassetid://…` meshes, textures, decals, sounds, animations, models
  (`InsertService`, `require(id)`) load through **[External Load](#external-load)**.
- **Avatars**: play as a blocky character or as any public Roblox avatar (body colors, R15 body parts,
  faces, shirts / pants / t-shirts and accessories).
- **Multiplayer without a server**: the host's browser runs the game server and other players connect with
  WebRTC (PeerJS code, other tabs of the same browser, or fully manual copy / paste). The host gets a
  **live console**: server output, client errors from every player, joins / chat, a player list with
  kick / respawn, network stats and a server command line.
- **Plugins**: install Roblox Studio plugins (`.rbxm` / `.rbxmx` / `.lua`, or a plugin asset id) — they run
  with the `plugin` API (toolbars, buttons, dock widgets, settings, mouse, `Selection`,
  `ChangeHistoryService`) — or sandboxed JavaScript plugins ([PLUGINS.md](PLUGINS.md)).

## Running it

Bloxlab is a static site. Serve the repository root with any web server:

```sh
node tools/serve.mjs          # http://localhost:8080
# or: python3 -m http.server 8080
```

Keyboard: **F5** Play · **F8** Run · **Shift+F5** Stop · **Ctrl+Z / Ctrl+Y** undo / redo · **Ctrl+C / X / V / D**
clipboard and duplicate · **Ctrl+G / Ctrl+U** group / ungroup · **F** focus selection · right mouse + WASDQE fly
the camera. While playing: WASD / arrows, Space, mouse wheel / I / O zoom, right mouse to turn, `/` chat,
1–0 hotbar, Backspace drop tool, Tab player list, Esc menu.

URL options: `?open=<url of a place file>` opens a place, `?join=<code>` joins a multiplayer game.

## nenecookie

Bloxlab follows the nenecookie game folder contract (`index.html`, `game.json`, `icon.svg`, all paths
relative), so installing it is just copying the repository into the launcher's games folder:

```sh
cd nenecookie/games
git clone https://github.com/Shokoura/Bloxlab bloxlab
```

The game appears after the next game list refresh. Inside the launcher:

- your nenecookie username is used as your player name,
- **F3 → Save** stores the current place in your nenecookie cloud save (compressed; very large places are
  kept in the browser and the save keeps a reference to them) and *Continue* reopens it,
- the game pauses while the launcher overlay is open — unless you are in a multiplayer game, which keeps
  running so other players are not frozen.

Games are framed by the launcher, so invite links cannot be opened in a new tab there; use the
**Join Game** dialog with the host's code instead.

## External Load

Browsers cannot download Roblox assets directly: Roblox does not send CORS headers and asset delivery now
requires authentication. Bloxlab therefore resolves `rbxassetid://` content through a chain you control
(*Settings → External Load*):

```
player's browser  ⇄  [ uploaded files | browser cache | your proxy | the multiplayer host | Roblox ]  ⇄  Roblox
```

1. **Asset Manager** uploads: map any asset id to your own file (works offline; export / import asset packs
   to share them).
2. **Browser cache**: everything that loaded once is kept in IndexedDB.
3. **Proxies**: your own Bloxlab proxy (recommended), or a public mirror such as RoProxy. Each proxy is a URL
   template with `{id}`; use *Test* to check it.
4. **Multiplayer host relay**: players who cannot reach Roblox (school / office networks, blocked regions)
   ask the host's browser, which fetches through *its* proxies. Hosts can turn sharing off.
5. **Direct**: only works with a CORS-enabled network or browser extension.

The **API proxy** setting is used for avatars, user lookups, thumbnails and the marketplace search.

### Deploying your own proxy

`proxy/worker.mjs` is a self-contained proxy (asset delivery, Roblox web APIs, CDN files) with CORS and
caching.

**Cloudflare Workers (free tier is plenty):**

```sh
cd proxy
npx wrangler deploy                          # uses wrangler.toml
npx wrangler secret put ROBLOX_API_KEY       # see below
```

or paste `worker.mjs` into a new Worker in the Cloudflare dashboard and add the variables there.
Then add `https://<your-worker>.workers.dev/asset?id={id}` as a proxy and
`https://<your-worker>.workers.dev` as the API proxy.

**Node 18+ (any VPS, or your own PC on the LAN):**

```sh
ROBLOX_API_KEY=... node proxy/node-proxy.mjs 8787
```

Configuration (environment variables / Worker variables):

| Variable | Purpose |
| --- | --- |
| `ROBLOX_API_KEY` | Open Cloud API key used for asset delivery (create one at create.roblox.com → Credentials with asset read / legacy asset permissions). Recommended. |
| `ROBLOSECURITY` | Alternative: a `.ROBLOSECURITY` cookie of a **throwaway** account, used only for asset downloads. |
| `ALLOWED_ORIGINS` | Comma separated sites allowed to use the proxy (e.g. your nenecookie URL). Empty = anyone. |
| `CACHE_SECONDS` | Cache lifetime (default 86400). |

The proxy only forwards to Roblox hosts (an allow-list of API services and the Roblox CDN), never sends your
credentials to the web APIs, and is read-only.

## Avatars

*Settings → Avatar*: choose **Blocky** (no downloads, custom colors) or **My Roblox avatar** and enter a
username or user id. Avatars are built from public avatar data: body colors, R15 body parts, face, classic
clothing and accessories (layered clothing is attached rigidly). Hosts can choose whether other players'
avatars are loaded. Places can still force their own `StarterCharacter`.

## Multiplayer

*Test → Host Game* starts Play (if needed) and opens your game to others:

- **Online code**: a short code (and link) through a PeerJS broker. The broker only introduces the browsers;
  game traffic is peer-to-peer. You can run your own broker (`npx peerjs --port 9000`) and set it in
  *Settings → Network*.
- **This browser**: other tabs / windows of the same browser (testing).
- **Manual**: no third party at all — send the invitation text to a player, paste back their reply.

Players use *Test → Join Game*. If someone cannot connect (strict NAT), add a TURN server in
*Settings → Network* (`turn:host:3478|user|password`). The host runs every server script and owns
physics; each player simulates their own character, like Roblox network ownership.

The **Console** (Test → Console) is the host's live view of the server.

## Plugins

*Plugins → Install…* accepts Roblox Studio plugin files (`.rbxm`, `.rbxmx`, `.lua`), a plugin asset id
(downloaded through External Load), a URL, or code you type. Supported plugin API: `plugin:CreateToolbar`,
`toolbar:CreateButton` (`Click`, `SetActive`), `plugin:CreateDockWidgetPluginGui` with
`DockWidgetPluginGuiInfo.new` (GUI is rendered like game GUI), `GetSetting` / `SetSetting`, `GetMouse`,
`Activate` / `Deactivate`, `CreatePluginAction`, `CreatePluginMenu`, `OpenScript`, `PromptSaveSelection`,
and the services `Selection`, `ChangeHistoryService` (waypoints, recordings, undo / redo) and
`StudioService`. JavaScript plugins are described in [PLUGINS.md](PLUGINS.md).

## Limitations

- Terrain from place files is shown as 4-stud voxels (smooth terrain meshing is not implemented).
- Solid modeling (unions / negates), FBX import and publishing to Roblox are not available.
- Purchases, badges, groups and friends are simulated; DataStores are stored per browser (for a hosted game,
  in the host's browser).
- The host's computer runs the game for everybody, so very large games need a reasonably fast host.

## Development

No dependencies are needed to run Bloxlab. Tests:

```sh
node tests/luau.test.mjs                                       # Luau compiler / runtime
node tests/engine.test.mjs                                     # instances, services, scripts
node tests/formats.test.mjs                                    # rbxl / rbxm round trips (needs rbx-test-files)
node --import ./tests/node-loader.mjs tests/play.test.mjs      # headless server + client play session
node tests/e2e.mjs                                             # browser end-to-end (needs Playwright)
```

Layout:

```
index.html, game.json, icon.svg   entry point / nenecookie metadata
js/luau/        Luau lexer, parser, compiler and runtime
js/formats/     binary / XML file formats
js/engine/      instances, datatypes, reflection, services, scheduler, Lua bridge
js/render/      three.js scene, materials, lighting, clothing, effects
js/game/        play sessions: server, client, physics, characters, camera, input, GUI, HUD, sound
js/net/         replication protocol, transports (loopback, tabs, WebRTC), multiplayer dialogs
js/assets/      asset loading (External Load), meshes, avatars
js/studio/      the Studio UI
js/plugins/     plugin host
proxy/          External Load proxy (Cloudflare Worker / Node)
vendor/         three.js, Rapier, PeerJS, fzstd (see their LICENSE files)
```

`tools/build-reflection.mjs` regenerates `js/engine/reflection.js` from a Roblox API dump.
