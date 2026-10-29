# Bloxlab plugins

Bloxlab runs two kinds of Studio plugins. Install them with **Plugins → Install…** (file, URL, Roblox asset
id or typed code). Installed plugins are stored in the browser and reload with every place.

## Roblox Studio plugins (Luau)

`.rbxm` / `.rbxmx` plugin models and single `.lua` files run their `Script`s against the place you are editing
with the usual `plugin` global. Supported:

| API | Notes |
| --- | --- |
| `plugin:CreateToolbar(name)` → `toolbar:CreateButton(id, tooltip, icon, text)` | Buttons appear in the **PLUGINS** tab. `Click`, `SetActive`, `Enabled`. |
| `plugin:CreateDockWidgetPluginGui(id, DockWidgetPluginGuiInfo.new(...))` | A floating window; GUI objects parented to it are rendered and interactive. `Title`, `Enabled`, `BindToClose`. |
| `plugin:GetSetting(key)` / `plugin:SetSetting(key, value)` | Persisted per plugin in the browser. |
| `plugin:GetMouse()` | `Hit`, `Target`, `UnitRay`, `X`, `Y`, `Button1Down/Up`, `Move` (while activated). |
| `plugin:Activate(exclusive)` / `Deactivate()` / `IsActivated()` | `Deactivation` fires when another plugin activates. |
| `plugin:CreatePluginAction(...)`, `plugin:CreatePluginMenu(...)` + `ShowAsync()` | Menus show at the mouse. |
| `plugin:OpenScript(script, line)`, `plugin:PromptSaveSelection(name)` | Opens the editor / downloads an `.rbxm`. |
| `game:GetService("Selection")` | `Get`, `Set`, `Add`, `Remove`, `SelectionChanged`. |
| `game:GetService("ChangeHistoryService")` | `SetWaypoint`, `TryBeginRecording` / `FinishRecording`, `Undo`, `Redo`, `OnUndo`, `OnRedo`. |
| `game:GetService("StudioService")` | `ActiveScript`, `GridSize`, `RotateIncrement`, `GetUserId`, `CopyToClipboard`. |

Not available: unions / negates, FBX import, publishing to Roblox, the Roblox toolbox UI.

## JavaScript plugins (sandboxed)

A `.js` file (or an `.html` page) runs inside a sandboxed iframe: it cannot read Bloxlab's page, storage or
your saved places, and can only use the message API below. Every call returns a promise.

```js
bloxlab.button('count', { label: 'Count Parts', tooltip: 'How many parts are there?' });
bloxlab.on('click', async (buttonId) => {
  const lines = await bloxlab.lua(`
    local n = 0
    for _, d in ipairs(workspace:GetDescendants()) do if d:IsA("BasePart") then n += 1 end end
    print(n)`);
  bloxlab.toast(`Parts: ${lines[0]}`);
});
```

| Call | Result |
| --- | --- |
| `bloxlab.button(id, { label, tooltip })` | Adds a button to the PLUGINS tab; clicks arrive as `click` events. |
| `bloxlab.on(event, handler)` | Events: `click` (button id), `selection` (array of `{ path, name, className }`). |
| `bloxlab.showPanel({ title, width, height })` / `hidePanel()` | Shows the plugin's own page in a floating window (put your UI in `document.body`). |
| `bloxlab.lua(source)` | Runs Luau in the edit place as one undo step; resolves with the printed lines. |
| `bloxlab.selection.get()` / `.set(paths)` | Selection as `{ path, name, className }`; paths look like `Workspace.Model.Part`. |
| `bloxlab.children(path)` | Children of an instance (or the DataModel). |
| `bloxlab.get(path, prop)` / `bloxlab.set(path, prop, value)` | Property values use the wire encoding: plain numbers / strings / booleans, or `{ $: 'v3', v: [x, y, z] }`, `{ $: 'c3', v: [r, g, b] }`, `{ $: 'cf', v: [12 numbers] }`, `{ $: 'e', t: 'Material', v: 'Neon' }`, `{ $: 'u2', v: [xs, xo, ys, yo] }`, `{ $: 'i', v: 'Workspace.Part' }`. |
| `bloxlab.insert(className, parentPath, props)` | Creates an instance; resolves with its path. |
| `bloxlab.toast(text)`, `bloxlab.print(...)` | Notifications / Output. |
| `bloxlab.exportPlace('rbxlx' \| 'rbxl')` | The place as XML text or base64 binary. |
