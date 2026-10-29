// Host console: live server output, client errors forwarded by remote players, joins / leaves / chat,
// a player list with kick / respawn / view, network stats, and a server-side Lua command line.
import { h, toast } from './ui.js';
import { icon } from './icons.js';

const time = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8);

export class HostConsole {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.session = null;
    this.off = null;
    this.lines = [];
    this.filter = 'all';
    this.logEl = h('div', { class: 'console-log' });
    this.playersEl = h('div', { class: 'console-players' });
    this.statsEl = h('div', { class: 'console-stats' });
    const filter = h('select', { class: 'input small', onchange: (e) => { this.filter = e.target.value; this.renderLog(); } },
      h('option', { value: 'all' }, 'Everything'), h('option', { value: 'server' }, 'Server output'), h('option', { value: 'clients' }, 'Client errors'), h('option', { value: 'events' }, 'Joins & chat'));
    this.cmd = h('input', { class: 'input small mono grow', placeholder: 'Run Luau on the server…  (prefix with "say " to announce to everyone)' });
    this.cmd.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !this.cmd.value.trim()) return;
      const v = this.cmd.value;
      this.cmd.value = '';
      this.run(v);
    });
    const head = el.querySelector('.panel-head');
    head.append(h('span', { class: 'spacer' }), filter, h('button', { class: 'icon-btn small', title: 'Clear', onclick: () => { this.lines = []; this.renderLog(); } }, icon('trash')));
    el.append(h('div', { class: 'console-body' }, h('div', { class: 'console-main' }, this.logEl, h('div', { class: 'console-cmd' }, h('span', { class: 'mono muted', text: '>' }), this.cmd)),
      h('div', { class: 'console-side' }, h('h4', { text: 'Players' }), this.playersEl, h('h4', { text: 'Server' }), this.statsEl)));
    this.timer = setInterval(() => this.refresh(), 500);
    this.refresh();
  }

  dispose() { clearInterval(this.timer); this.off?.(); }

  add(kind, text, src = 'server') {
    this.lines.push({ t: Date.now(), kind, text: String(text), src });
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
    if (this.visible(this.lines[this.lines.length - 1])) this.appendLine(this.lines[this.lines.length - 1]);
  }
  visible(l) {
    if (this.filter === 'all') return true;
    if (this.filter === 'server') return l.src === 'server';
    if (this.filter === 'clients') return l.src === 'client';
    return l.src === 'event';
  }
  appendLine(l) {
    const stick = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 20;
    this.logEl.append(h('div', { class: `out-row k-${l.kind}` }, h('span', { class: 'ts', text: time(l.t) }), h('span', { class: 'msg', text: l.text })));
    while (this.logEl.childNodes.length > 1500) this.logEl.firstChild.remove();
    if (stick) this.logEl.scrollTop = this.logEl.scrollHeight;
  }
  renderLog() { this.logEl.replaceChildren(); for (const l of this.lines) if (this.visible(l)) this.appendLine(l); }

  attach(s) {
    this.off?.();
    this.off = null;
    this.session = s;
    if (!s) return;
    this.add('info', s.mode === 'join' ? 'Connected to a remote game (you are a client: only your own client output is shown)' : `Server started (${s.mode})`, 'event');
    this.off = s.on((type, d) => {
      switch (type) {
        case 'serverlog': if (d.kind !== 'trace' || this.filter !== 'events') this.add(d.kind === 'output' ? 'output' : d.kind, d.msg, 'server'); break;
        case 'join': this.add('info', `${d.player.props.Name} joined${d.conn.transport.local ? ' (local)' : d.conn.remote ? ` via ${d.conn.remote.kind}` : ''}`, 'event'); break;
        case 'leave': this.add('info', `${d.player.props.Name} left${d.reason ? ` (${d.reason})` : ''}`, 'event'); break;
        case 'chat': this.add('output', `[chat] ${d.player.props.Name}: ${d.text}`, 'event'); break;
        case 'clientlog': this.add(d.kind === 'output' ? 'output' : d.kind, `[${d.player ? d.player.props.Name : '?'}] ${d.msg}`, 'client'); break;
        case 'kick': this.add('warn', `Kicked ${d.player.props.Name}${d.msg ? `: ${d.msg}` : ''}`, 'event'); break;
        case 'died': this.add('info', `${d.player.props.Name} died`, 'event'); break;
        case 'relay': this.add('info', `Relayed ${d.what} (${Math.round(d.size / 1024)} KB) for ${d.player ? d.player.props.Name : '?'}`, 'event'); break;
        case 'remote': this.add('info', `Incoming connection (${d.info.kind || 'remote'})`, 'event'); break;
        case 'hosting': this.add('info', `Hosting${d.code ? ` with code ${d.code}` : d.room ? ` for tabs (room ${d.room})` : ''}`, 'event'); break;
        case 'stopped': this.add('info', 'Session ended', 'event'); break;
        default: break;
      }
    });
  }

  run(src) {
    const s = this.app.session;
    if (!s || !s.server) { toast('No server is running', 'warn'); return; }
    if (/^say\s+/i.test(src)) { const msg = src.replace(/^say\s+/i, ''); s.server.system(msg, 'announce'); this.add('info', `[announce] ${msg}`, 'event'); return; }
    this.add('info', `> ${src}`, 'server');
    s.server.world.exec(src, 'Console');
  }

  refresh() {
    const s = this.app.session;
    if (s !== this.session) this.attach(s);
    if (!s) {
      this.playersEl.replaceChildren(h('div', { class: 'muted small', text: 'Not running. Press Play, or Host Game to let others join.' }));
      this.statsEl.replaceChildren();
      return;
    }
    const srv = s.server;
    if (!srv) {
      this.playersEl.replaceChildren(h('div', { class: 'muted small', text: 'You joined someone else\'s game.' }));
      const c = s.active;
      this.statsEl.replaceChildren(h('div', { class: 'stat' }, 'Ping', h('b', { text: c && c.replicator.ping ? `${Math.round(c.replicator.ping)} ms` : '—' })));
      return;
    }
    const rows = [];
    for (const [player, st] of srv.players) {
      const conn = st.conn;
      const local = s.clients.find((c) => c.localPlayer && c.localPlayer.props.Name === player.props.Name && conn.transport.local);
      const hum = player.props.Character && player.props.Character.findFirstChildOfClass('Humanoid');
      const hp = hum ? `${Math.round(hum.props.Health ?? 0)} hp` : 'no character';
      rows.push(h('div', { class: 'player-row' }, h('span', { class: `dot${conn.transport.local ? ' local' : ''}` }),
        h('span', { class: 'grow', title: `${hp}${conn.ping ? ` · ${Math.round(conn.ping)} ms` : ''}` }, player.props.Name, h('span', { class: 'muted small', text: ` ${conn.transport.local ? 'local' : conn.ping ? `${Math.round(conn.ping)}ms` : 'remote'}` })),
        local && local !== s.active ? h('button', { class: 'btn small', title: 'Control this player', onclick: () => s.setActive(local) }, 'View') : null,
        h('button', { class: 'btn small', title: 'Respawn', onclick: () => srv.loadCharacter(player) }, '↻'),
        h('button', { class: 'btn small danger', title: 'Kick', onclick: () => srv.kick(player, 'Kicked by the host') }, 'Kick')));
    }
    if (!rows.length) rows.push(h('div', { class: 'muted small', text: 'No players yet' }));
    rows.push(h('button', { class: 'btn small', onclick: () => s.addTestPlayer().then(() => toast('Test player added')) }, '+ Test player'));
    this.playersEl.replaceChildren(...rows);
    let parts = 0, scripts = 0;
    srv.world.dm.forTree((d) => { if (d.isA('BasePart')) parts++; else if (d.ClassName === 'Script') scripts++; });
    const conns = [...srv.replicator.conns.values()];
    const up = Math.floor((performance.now() - s.started) / 1000);
    const bytesIn = conns.reduce((a, c) => a + (c.transport.bytesIn || 0), 0), bytesOut = conns.reduce((a, c) => a + (c.transport.bytesOut || 0), 0);
    const stat = (k, v) => h('div', { class: 'stat' }, k, h('b', { text: String(v) }));
    this.statsEl.replaceChildren(
      stat('Uptime', `${Math.floor(up / 60)}m ${up % 60}s`),
      stat('Players', srv.players.size),
      stat('Parts', parts),
      stat('Running scripts', srv.world.contexts.size),
      stat('Scripts', scripts),
      stat('Hosting', s.hosts.length ? s.hosts.map((x) => x.code || (x.room ? `tab:${x.room}` : 'manual')).join(', ') : 'local only'),
      stat('Network in / out', `${(bytesIn / 1024).toFixed(0)} / ${(bytesOut / 1024).toFixed(0)} KB`),
    );
  }
}
