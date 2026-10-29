// Players, Player, Mouse, Teams, spawn locations and interactive objects.
import { defineBehavior, Instance } from '../instance.js';
import { methods, lerr, S, L, arr, toEnum, awaitPromise, plainToLua, luaTypeof } from '../bridge.js';
import { Vector3, Vector2, CFrame, BrickColor, Ray, UDim2, TweenInfo } from '../datatypes.js';
import { E } from '../enums.js';
import { LuaTable, toByteStr, R } from '../../luau/runtime.js';

const worldOf = (self) => self.world || (R.current && R.current.owner && R.current.owner.world);

defineBehavior('Players', {
  props: {
    LocalPlayer: { get: (p) => (p.world && p.world.localPlayer) || null, readonly: true, type: 'Ref' },
    localPlayer: { get: (p) => (p.world && p.world.localPlayer) || null, readonly: true, type: 'Ref' },
    NumPlayers: { get: (p) => p.children.filter((c) => c.ClassName === 'Player').length, readonly: true, type: 'Int32' },
    CharacterAutoLoads: { get: (p) => p.props.CharacterAutoLoads !== false, set: (p, v) => p.rawSet('CharacterAutoLoads', !!v), type: 'Bool' },
    RespawnTime: { get: (p) => p.props.RespawnTime ?? 5, set: (p, v) => p.rawSet('RespawnTime', Number(v) || 0), type: 'Float32' },
  },
  methods: methods({
    GetPlayers: (self) => [arr(self.children.filter((c) => c.ClassName === 'Player'))],
    getPlayers: (self) => [arr(self.children.filter((c) => c.ClassName === 'Player'))],
    GetPlayerFromCharacter: (self, model) => [self.children.find((c) => c.ClassName === 'Player' && model && c.props.Character === model) || undefined],
    getPlayerFromCharacter: (self, model) => [self.children.find((c) => c.ClassName === 'Player' && model && c.props.Character === model) || undefined],
    GetPlayerByUserId: (self, id) => [self.children.find((c) => c.ClassName === 'Player' && Number(c.props.UserId) === Number(id)) || undefined],
    *GetUserIdFromNameAsync(self, name) {
      const n = S(name);
      const local = self.children.find((c) => c.ClassName === 'Player' && c.props.Name.toLowerCase() === n.toLowerCase());
      if (local) return [local.props.UserId];
      const app = worldOf(self)?.app;
      if (!app) throw lerr('User not found');
      const j = yield* awaitPromise(app.assets.lookupUser(n), 'GetUserIdFromNameAsync');
      if (!j) throw lerr('User not found');
      return [j.id];
    },
    *GetNameFromUserIdAsync(self, id) {
      const local = self.children.find((c) => c.ClassName === 'Player' && Number(c.props.UserId) === Number(id));
      if (local) return [toByteStr(local.props.Name)];
      const app = worldOf(self)?.app;
      if (!app) throw lerr('User not found');
      const j = yield* awaitPromise(app.assets.api('users', `/v1/users/${Number(id)}`), 'GetNameFromUserIdAsync');
      return [toByteStr(j.name)];
    },
    *GetUserThumbnailAsync(self, id, type, size) {
      const t = type ? toEnum('ThumbnailType', type).Name : 'HeadShot';
      const sz = size ? toEnum('ThumbnailSize', size).Name.replace('Size', '') : '150x150';
      const [w, h] = sz.split('x');
      const map = { HeadShot: 'AvatarHeadShot', AvatarBust: 'AvatarBust', AvatarThumbnail: 'Avatar' };
      return [`rbxthumb://type=${map[t] || 'AvatarHeadShot'}&id=${Number(id)}&w=${w}&h=${h}`, true];
    },
    *GetHumanoidDescriptionFromUserId(self, id) {
      const w = worldOf(self);
      if (!w.hooks.descriptionFromUserId) throw lerr('Avatar loading is not available');
      return [yield* awaitPromise(w.hooks.descriptionFromUserId(Number(id)), 'GetHumanoidDescriptionFromUserId')];
    },
    *GetHumanoidDescriptionFromOutfitId(self, id) { return [new Instance('HumanoidDescription', self.world)]; },
    *CreateHumanoidModelFromDescription(self, desc, rig) {
      const w = worldOf(self);
      if (!w.hooks.createCharacterModel) throw lerr('not available');
      return [yield* awaitPromise(w.hooks.createCharacterModel(desc, rig ? toEnum('HumanoidRigType', rig).Name : 'R15'), 'CreateHumanoidModelFromDescription')];
    },
    *CreateHumanoidModelFromUserId(self, id) {
      const w = worldOf(self);
      if (!w.hooks.createCharacterModel) throw lerr('not available');
      const desc = w.hooks.descriptionFromUserId ? yield* awaitPromise(w.hooks.descriptionFromUserId(Number(id)), 'CreateHumanoidModelFromUserId') : null;
      return [yield* awaitPromise(w.hooks.createCharacterModel(desc, 'R15'), 'CreateHumanoidModelFromUserId')];
    },
    *GetFriendsAsync(self) { const p = new Instance('FriendPages', self.world); p.entries = []; p.pageSize = 50; p.page = 0; return [p]; },
    *GetCharacterAppearanceInfoAsync(self) { return [plainToLua({ assets: [], bodyColors: {}, scales: {}, playerAvatarType: 'R15' })]; },
    *BanAsync(self, cfg) { const w = worldOf(self); w.output('Players:BanAsync() is simulated (kick only)', 'warn'); return []; },
    *UnbanAsync() { return []; },
    Chat: (self, msg) => { const w = worldOf(self); if (w && w.localPlayer) w.hooks.sendChat?.(S(msg)); },
    SetChatStyle: () => {},
  }),
});

defineBehavior('Player', {
  props: {
    Character: {
      get: (p) => p.props.Character || null,
      set: (p, v) => { p.rawSet('Character', v); p.world?.hooks.characterChanged?.(p, v); },
      type: 'Ref',
    },
    character: { get: (p) => p.props.Character || null, readonly: true, type: 'Ref' },
    UserId: { get: (p) => p.props.UserId ?? 0, readonly: true, type: 'Int64' },
    userId: { get: (p) => p.props.UserId ?? 0, readonly: true, type: 'Int64' },
    DisplayName: { get: (p) => p.props.DisplayName || p.props.Name, set: (p, v) => p.rawSet('DisplayName', String(v)), type: 'String' },
    AccountAge: { get: (p) => p.props.AccountAge ?? 365, readonly: true, type: 'Int32' },
    MembershipType: { get: () => E('MembershipType', 'None'), readonly: true, type: 'Enum:MembershipType' },
    LocaleId: { get: () => (typeof navigator !== 'undefined' ? navigator.language : 'en-us').toLowerCase(), readonly: true, type: 'String' },
    TeamColor: { get: (p) => p.props.TeamColor || BrickColor.fromName('White'), set: (p, v) => { p.rawSet('TeamColor', v); const teams = p.world?.dm?.findFirstChildOfClass('Teams'); const t = teams && teams.children.find((c) => c.ClassName === 'Team' && c.props.TeamColor && c.props.TeamColor.Number === v.Number); if (t && p.props.Team !== t) p.set('Team', t); }, type: 'BrickColor' },
    Team: {
      get: (p) => p.props.Team || null,
      set: (p, v) => {
        const old = p.props.Team;
        p.rawSet('Team', v || null);
        if (v && v.props.TeamColor) p.rawSet('TeamColor', v.props.TeamColor);
        p.rawSet('Neutral', !v);
        if (old && old !== v) old.fire('PlayerRemoved', p);
        if (v && old !== v) v.fire('PlayerAdded', p);
      },
      type: 'Ref',
    },
    FollowUserId: { get: () => 0, readonly: true, type: 'Int64' },
    GameplayPaused: { get: () => false, readonly: true, type: 'Bool' },
    PartyId: { get: () => '', readonly: true, type: 'String' },
  },
  methods: methods({
    LoadCharacter: (self) => {
      const w = worldOf(self);
      if (!w || w.kind !== 'server') throw lerr('LoadCharacter can only be called by the backend server');
      w.hooks.loadCharacter?.(self);
    },
    LoadCharacterAsync: (self) => { worldOf(self)?.hooks.loadCharacter?.(self); },
    LoadCharacterBlocking: (self) => { worldOf(self)?.hooks.loadCharacter?.(self); },
    LoadCharacterWithHumanoidDescription: (self, desc) => { worldOf(self)?.hooks.loadCharacter?.(self, desc); },
    RemoveCharacter: (self) => { const c = self.props.Character; if (c) c.destroy(); self.set('Character', null); },
    Kick: (self, msg) => { const w = worldOf(self); w?.hooks.kick?.(self, msg === undefined ? '' : S(msg)); },
    GetMouse: (self) => {
      const w = worldOf(self);
      if (!w || w.kind !== 'client' || w.localPlayer !== self) return [undefined];
      return [w.input ? w.input.mouseObject() : undefined];
    },
    IsInGroup: () => [false],
    *IsInGroupAsync() { return [false]; },
    GetRankInGroup: () => [0], *GetRankInGroupAsync() { return [0]; },
    GetRoleInGroup: () => ['Guest'], *GetRoleInGroupAsync() { return ['Guest']; },
    *GetFriendsOnline() { return [new LuaTable()]; },
    *GetFriendsOnlineAsync() { return [new LuaTable()]; },
    *IsFriendsWith() { return [false]; },
    *IsFriendsWithAsync() { return [false]; },
    *IsBestFriendsWith() { return [false]; },
    HasAppearanceLoaded: () => [true],
    DistanceFromCharacter: (self, pos) => {
      const c = self.props.Character;
      const head = c && (c.findFirstChild('Head') || c.findFirstChild('HumanoidRootPart'));
      return [head ? head.props.CFrame.Position.sub(pos).Magnitude : 0];
    },
    GetJoinData: () => [plainToLua({ SourcePlaceId: 0, Members: [], TeleportData: null, LaunchData: '' })],
    GetNetworkPing: (self) => [(self.ping || 0) / 1000],
    ClearCharacterAppearance: (self) => {
      const c = self.props.Character;
      if (c) for (const d of c.children.slice()) if (d.isA('Accoutrement') || d.isA('Clothing') || d.ClassName === 'ShirtGraphic' || d.ClassName === 'BodyColors' || d.ClassName === 'CharacterMesh') d.destroy();
    },
    LoadCharacterAppearance: () => {},
    *RequestStreamAroundAsync() { return []; },
    Move: (self, dir, rel) => { const h = self.props.Character && self.props.Character.findFirstChildOfClass('Humanoid'); if (h) h.beh.methods.Move(h, dir, rel); },
    SetSuperSafeChat: () => {}, SetAccountAge: () => {}, SetMembershipType: () => {},
    GetUnder13: () => [false], GetFriendStatus: () => [E('FriendStatus', 'NotFriend')],
    *CanSendGameInviteAsync() { return [false]; },
    AddReplicationFocus: () => {}, RemoveReplicationFocus: () => {},
  }),
  events: ['CharacterAdded', 'CharacterRemoving', 'CharacterAppearanceLoaded', 'Chatted', 'Idled', 'OnTeleport'],
});

// The mouse object returned by Player:GetMouse() (values are filled in by game/input.js every frame)
defineBehavior('PlayerMouse', {
  props: {
    Hit: { get: (m) => m.hit || CFrame.identity, readonly: true, type: 'CFrame' },
    hit: { get: (m) => m.hit || CFrame.identity, readonly: true, type: 'CFrame' },
    Origin: { get: (m) => m.origin || CFrame.identity, readonly: true, type: 'CFrame' },
    Target: { get: (m) => m.target || null, readonly: true, type: 'Ref' },
    target: { get: (m) => m.target || null, readonly: true, type: 'Ref' },
    TargetSurface: { get: (m) => m.targetSurface || E('NormalId', 'Top'), readonly: true, type: 'Enum:NormalId' },
    UnitRay: { get: (m) => m.unitRay || new Ray(), readonly: true, type: 'Ray' },
    X: { get: (m) => m.x || 0, readonly: true, type: 'Int32' },
    Y: { get: (m) => m.y || 0, readonly: true, type: 'Int32' },
    ViewSizeX: { get: (m) => m.viewW || 0, readonly: true, type: 'Int32' },
    ViewSizeY: { get: (m) => m.viewH || 0, readonly: true, type: 'Int32' },
    TargetFilter: { get: (m) => m.targetFilter || null, set: (m, v) => { m.targetFilter = v; }, type: 'Ref' },
    Icon: { get: (m) => m.icon || '', set: (m, v) => { m.icon = String(v); m.world?.hooks.setMouseIconImage?.(m.icon); }, type: 'ContentId' },
  },
  events: ['Button1Down', 'Button1Up', 'Button2Down', 'Button2Up', 'Move', 'Idle', 'WheelForward', 'WheelBackward', 'KeyDown', 'KeyUp'],
});

defineBehavior('Teams', {
  methods: methods({ GetTeams: (self) => [arr(self.children.filter((c) => c.ClassName === 'Team'))], RebalanceTeams: () => {} }),
});
defineBehavior('Team', {
  methods: methods({
    GetPlayers: (self) => {
      const players = self.world?.dm?.findFirstChildOfClass('Players');
      return [arr(players ? players.children.filter((p) => p.ClassName === 'Player' && p.props.Team === self) : [])];
    },
  }),
  events: ['PlayerAdded', 'PlayerRemoved'],
});

// ------------------------------------------------------------------ interactive objects
defineBehavior('ClickDetector', {
  events: ['MouseClick', 'RightMouseClick', 'MouseHoverEnter', 'MouseHoverLeave', 'MouseActionReplicated'],
});
defineBehavior('ProximityPrompt', {
  methods: methods({
    InputHoldBegin: (self) => { self.world?.hooks.promptHoldBegin?.(self); },
    InputHoldEnd: (self) => { self.world?.hooks.promptHoldEnd?.(self); },
  }),
  events: ['Triggered', 'TriggerEnded', 'PromptButtonHoldBegan', 'PromptButtonHoldEnded', 'PromptShown', 'PromptHidden'],
});
defineBehavior('DragDetector', { events: ['DragStart', 'DragContinue', 'DragEnd'] });

// ------------------------------------------------------------------ Sound
const soundHook = (s, what, arg) => { const w = s.world; if (w && w.hooks.sound) w.hooks.sound(s, what, arg); };
defineBehavior('Sound', {
  props: {
    Playing: { get: (s) => !!s.props.Playing, set: (s, v) => { const was = !!s.props.Playing; if (s.rawSet('Playing', !!v)) { soundHook(s, v ? 'play' : 'pause'); if (v && !was) s.fire('Played', s.props.SoundId || ''); } }, type: 'Bool' },
    IsPlaying: { get: (s) => !!s.props.Playing, readonly: true, type: 'Bool' },
    IsPaused: { get: (s) => !s.props.Playing && (s.props.TimePosition || 0) > 0, readonly: true, type: 'Bool' },
    IsLoaded: { get: (s) => s.loaded !== false, readonly: true, type: 'Bool' },
    isPlaying: { get: (s) => !!s.props.Playing, readonly: true, type: 'Bool' },
    TimeLength: { get: (s) => s.timeLength || 0, readonly: true, type: 'Float64' },
    TimePosition: { get: (s) => (s.world?.hooks.soundTime ? s.world.hooks.soundTime(s) : s.props.TimePosition || 0), set: (s, v) => { s.rawSet('TimePosition', Math.max(0, Number(v) || 0)); soundHook(s, 'seek', v); }, type: 'Float64' },
    PlaybackLoudness: { get: (s) => (s.world?.hooks.soundLoudness ? s.world.hooks.soundLoudness(s) : 0), readonly: true, type: 'Float64' },
  },
  methods: methods({
    Play: (self) => { self.rawSet('TimePosition', 0); self.set('Playing', false); self.set('Playing', true); soundHook(self, 'restart'); },
    play: (self) => { self.rawSet('TimePosition', 0); self.set('Playing', true); },
    Stop: (self) => { const was = self.props.Playing; self.set('Playing', false); self.rawSet('TimePosition', 0); soundHook(self, 'stop'); if (was) self.fire('Stopped', self.props.SoundId || ''); },
    stop: (self) => { self.set('Playing', false); self.rawSet('TimePosition', 0); },
    Pause: (self) => { if (self.props.Playing) { self.set('Playing', false); self.fire('Paused', self.props.SoundId || ''); } },
    Resume: (self) => { if (!self.props.Playing) { self.set('Playing', true); self.fire('Resumed', self.props.SoundId || ''); } },
  }),
  events: ['Played', 'Ended', 'Loaded', 'Paused', 'Resumed', 'Stopped', 'DidLoop'],
});

// ------------------------------------------------------------------ effects
defineBehavior('Explosion', {
  added: (e) => { const w = e.world; if (w && w.kind !== 'edit' && w.hooks.explode) w.scheduler.timer(0, () => { if (e.dm && !e.exploded) { e.exploded = true; w.hooks.explode(e); } }); },
  events: ['Hit'],
});
defineBehavior('ParticleEmitter', {
  methods: methods({ Emit: (self, n) => { self.world?.hooks.emitParticles?.(self, Number(n) || 16); }, Clear: (self) => { self.world?.hooks.clearParticles?.(self); }, FastForward: () => {} }),
});
defineBehavior('GuiObject', {
  methods: methods({
    TweenPosition: (self, pos, dir, style, time, override, cb) => [guiTween(self, { Position: pos }, dir, style, time, override, cb)],
    TweenSize: (self, size, dir, style, time, override, cb) => [guiTween(self, { Size: size }, dir, style, time, override, cb)],
    TweenSizeAndPosition: (self, size, pos, dir, style, time, override, cb) => [guiTween(self, { Size: size, Position: pos }, dir, style, time, override, cb)],
  }),
});
function guiTween(self, goals, dir, style, time, override, cb) {
  const w = self.world;
  if (!w) return false;
  const ts = w.dm.serviceFactory('TweenService');
  const busy = w.tweens && [...w.tweens].some((t) => t.target === self && t.goals.some((g) => g.name in goals));
  if (busy && !override) return false;
  const info = new TweenInfo(typeof time === 'number' ? time : 1, style ? toEnum('EasingStyle', style) : E('EasingStyle', 'Quad'), dir ? toEnum('EasingDirection', dir) : E('EasingDirection', 'Out'), 0, false, 0);
  const goalsTable = new LuaTable();
  for (const [k, v] of Object.entries(goals)) if (v instanceof UDim2) goalsTable.set(k, v);
  const [tw] = ts.beh.methods.Create(ts, self, info, goalsTable);
  tw.beh.methods.Play(tw);
  if (typeof cb === 'function') tw.signal('Completed').connect((state) => { w.scheduler.spawn(cb, [state]); });
  return true;
}

defineBehavior('TextBox', {
  methods: methods({
    CaptureFocus: (self) => { self.world?.hooks.focusTextBox?.(self, true); },
    ReleaseFocus: (self, submitted) => { self.world?.hooks.focusTextBox?.(self, false, !!submitted); },
    IsFocused: (self) => [self.world?.input?.focusedTextBox === self],
  }),
  events: ['FocusLost', 'Focused', 'ReturnPressedFromOnScreenKeyboard'],
});
defineBehavior('GuiButton', { events: ['Activated', 'MouseButton1Click', 'MouseButton1Down', 'MouseButton1Up', 'MouseButton2Click', 'MouseButton2Down', 'MouseButton2Up'] });
defineBehavior('LayerCollector', {
  methods: methods({ GetLayoutNodeTree: () => [undefined] }),
});
defineBehavior('BasePlayerGui', {
  methods: methods({
    GetGuiObjectsAtPosition: (self, x, y) => [arr(self.world?.hooks.guiObjectsAt ? self.world.hooks.guiObjectsAt(x, y) : [])],
  }),
});
defineBehavior('PlayerGui', {
  methods: methods({
    SetTopbarTransparency: () => {}, GetTopbarTransparency: () => [0.5],
  }),
});

export { Vector2, Vector3, L, luaTypeof };
