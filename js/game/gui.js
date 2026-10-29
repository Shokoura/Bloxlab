// 2D GUI renderer: ScreenGui / BillboardGui / SurfaceGui trees are laid out the way Roblox does
// (UDim2, AnchorPoint, UI layouts and constraints, AutomaticSize) and drawn with DOM elements.
// Layout results are written back to AbsolutePosition / AbsoluteSize / TextBounds for scripts.
import { Vector2, UDim2, Color3, CFrame, Vector3 } from '../engine/datatypes.js';
import { E } from '../engine/enums.js';
import { toByteStr } from '../luau/runtime.js';
import { INSET } from './input.js';

const GUI_LAYOUT = new Set(['UIListLayout', 'UIGridLayout', 'UITableLayout', 'UIPageLayout']);
const UI_MODS = new Set(['UICorner', 'UIStroke', 'UIGradient', 'UIPadding', 'UIAspectRatioConstraint', 'UISizeConstraint', 'UITextSizeConstraint', 'UIScale', 'UIListLayout', 'UIGridLayout', 'UITableLayout', 'UIPageLayout', 'UIFlexItem']);

// ---------------------------------------------------------------- fonts
const FAMILIES = {
  SourceSansPro: '"Source Sans 3","Source Sans Pro","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  GothamSSm: 'Montserrat,Gotham,"Segoe UI",Roboto,Arial,sans-serif', Montserrat: 'Montserrat,Gotham,"Segoe UI",Arial,sans-serif',
  BuilderSans: '"Builder Sans","Segoe UI",Roboto,Arial,sans-serif', Arial: 'Arial,Helvetica,sans-serif', Arimo: 'Arimo,Arial,Helvetica,sans-serif', LegacyArial: 'Arial,Helvetica,sans-serif',
  Roboto: 'Roboto,"Segoe UI",Arial,sans-serif', RobotoCondensed: '"Roboto Condensed","Arial Narrow",sans-serif', RobotoMono: '"Roboto Mono",ui-monospace,Menlo,Consolas,monospace',
  Inconsolata: 'Inconsolata,ui-monospace,Menlo,Consolas,monospace', PressStart2P: '"Press Start 2P",ui-monospace,monospace', ComicNeueAngular: '"Comic Sans MS","Comic Neue",cursive',
  Merriweather: 'Merriweather,Georgia,serif', Guru: 'Georgia,serif', Accanthis: '"Bodoni 72","Didot",Georgia,serif', AccanthisADFStd: '"Bodoni 72","Didot",Georgia,serif',
  EBGaramond: 'Garamond,"EB Garamond",Georgia,serif', Michroma: 'Michroma,"Eurostile","Arial Black",sans-serif', Jura: 'Jura,"Arial Narrow",sans-serif', Oswald: 'Oswald,"Arial Narrow",Impact,sans-serif',
  TitilliumWeb: '"Titillium Web","Segoe UI",sans-serif', Ubuntu: 'Ubuntu,"Segoe UI",sans-serif', Nunito: 'Nunito,"Segoe UI",sans-serif', FredokaOne: '"Fredoka One",Fredoka,"Arial Rounded MT Bold",sans-serif',
  LuckiestGuy: '"Luckiest Guy",Impact,fantasy', Bangers: 'Bangers,Impact,fantasy', Creepster: 'Creepster,fantasy', DenkOne: '"Denk One",sans-serif', Fondamento: 'Fondamento,cursive',
  GrenzeGotisch: '"Grenze Gotisch",fantasy', IndieFlower: '"Indie Flower",cursive', JosefinSans: '"Josefin Sans",sans-serif', Kalam: 'Kalam,cursive', PatrickHand: '"Patrick Hand",cursive',
  PermanentMarker: '"Permanent Marker",cursive', Sarpanch: 'Sarpanch,sans-serif', SpecialElite: '"Special Elite",monospace', AmaticSC: '"Amatic SC",cursive', HighwayGothic: '"Highway Gothic","Arial Narrow",sans-serif',
  Zekton: 'Zekton,"Arial Narrow",sans-serif', Balthazar: 'Balthazar,Georgia,serif', Fantasy: 'fantasy',
};
const ENUM_FONTS = {
  Legacy: ['Arial', 400], Arial: ['Arial', 400], ArialBold: ['Arial', 700], SourceSans: ['SourceSansPro', 400], SourceSansBold: ['SourceSansPro', 700], SourceSansSemibold: ['SourceSansPro', 600],
  SourceSansLight: ['SourceSansPro', 300], SourceSansItalic: ['SourceSansPro', 400, 'italic'], Bodoni: ['Accanthis', 400], Garamond: ['EBGaramond', 400], Cartoon: ['ComicNeueAngular', 400],
  Code: ['Inconsolata', 400], Highway: ['HighwayGothic', 400], SciFi: ['Zekton', 400], Arcade: ['PressStart2P', 400], Fantasy: ['Balthazar', 400], Antique: ['Guru', 400],
  Gotham: ['GothamSSm', 400], GothamMedium: ['GothamSSm', 500], GothamBold: ['GothamSSm', 700], GothamBlack: ['GothamSSm', 900], GothamSemibold: ['GothamSSm', 600],
  BuilderSans: ['BuilderSans', 400], BuilderSansMedium: ['BuilderSans', 500], BuilderSansBold: ['BuilderSans', 700], BuilderSansExtraBold: ['BuilderSans', 800],
  Arimo: ['Arimo', 400], ArimoBold: ['Arimo', 700], Roboto: ['Roboto', 400], RobotoCondensed: ['RobotoCondensed', 400], RobotoMono: ['RobotoMono', 400], Montserrat: ['Montserrat', 400],
};
export function fontOf(inst) {
  const ff = inst.props.FontFace;
  if (ff && ff.Family) {
    const m = /families\/([^/.]+)\.json/i.exec(ff.Family);
    const fam = m ? m[1] : 'SourceSansPro';
    return { family: FAMILIES[fam] || `"${fam}",${FAMILIES.SourceSansPro}`, weight: ff.Weight || 400, style: ff.Style && ff.Style.Name === 'Italic' ? 'italic' : (ff.Style === 'Italic' ? 'italic' : 'normal') };
  }
  const f = inst.props.Font;
  const [fam, weight, style] = ENUM_FONTS[f ? f.Name : 'SourceSans'] || ENUM_FONTS.SourceSans;
  return { family: FAMILIES[fam] || FAMILIES.SourceSansPro, weight, style: style || 'normal' };
}

const mctx = (typeof document !== 'undefined' ? document.createElement('canvas') : null)?.getContext('2d');
const measureCache = new Map();
/** Text extents in pixels (wraps at maxW when given). */
export function measureText(text, font, size, maxW = Infinity, lineHeight = 1) {
  const key = `${font.family}|${font.weight}|${font.style}|${size}|${maxW}|${lineHeight}|${text}`;
  let r = measureCache.get(key);
  if (r) return r;
  if (!mctx) return { w: text.length * size * 0.5, h: size };
  mctx.font = `${font.style} ${font.weight} ${size}px ${font.family}`;
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (maxW === Infinity) { lines.push(mctx.measureText(raw).width); continue; }
    let line = '', lw = 0;
    for (const word of raw.split(/(\s+)/)) {
      const ww = mctx.measureText(word).width;
      if (lw + ww > maxW + 0.5 && line.trim()) { lines.push(lw); line = word.trimStart(); lw = mctx.measureText(line).width; }
      else { line += word; lw += ww; }
    }
    lines.push(lw);
  }
  r = { w: Math.ceil(Math.max(0, ...lines)), h: Math.ceil(lines.length * size * lineHeight), lines: lines.length };
  if (measureCache.size > 4000) measureCache.clear();
  measureCache.set(key, r);
  return r;
}

// ---------------------------------------------------------------- rich text
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const css = (c) => `rgb(${Math.round(c.R * 255)},${Math.round(c.G * 255)},${Math.round(c.B * 255)})`;
const rgba = (c, t = 0) => `rgba(${Math.round(c.R * 255)},${Math.round(c.G * 255)},${Math.round(c.B * 255)},${(1 - Math.max(0, Math.min(1, t))).toFixed(3)})`;
function richColor(v) {
  if (!v) return null;
  let m = /^#?([0-9a-f]{6})$/i.exec(v.trim()); if (m) return `#${m[1]}`;
  m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(v.trim()); if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  return /^[a-z]+$/i.test(v.trim()) ? v.trim() : null;
}
export function richToHtml(text) {
  let out = '';
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z]+)([^>]*)>|&(lt|gt|quot|apos|amp);|([^<&]+|[<&])/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[3]) { out += { lt: '&lt;', gt: '&gt;', quot: '&quot;', apos: '&#39;', amp: '&amp;' }[m[3]]; continue; }
    if (m[4] !== undefined) { out += esc(m[4]).replace(/\n/g, '<br>'); continue; }
    const tag = m[1].toLowerCase(), closing = m[0][1] === '/';
    const attrs = {};
    for (const a of m[2].matchAll(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g)) attrs[(a[1] || a[3]).toLowerCase()] = a[2] ?? a[4];
    const map = { b: 'b', i: 'i', u: 'u', s: 's', strike: 's', br: 'br', sc: 'span', smallcaps: 'span', uc: 'span', uppercase: 'span', font: 'span', stroke: 'span', mark: 'mark' };
    if (!(tag in map)) { out += esc(m[0]); continue; }
    if (tag === 'br') { out += '<br>'; continue; }
    if (closing) { const i = stack.lastIndexOf(tag); if (i >= 0) { while (stack.length > i) out += `</${map[stack.pop()]}>`; } continue; }
    let style = '';
    if (tag === 'font') {
      const c = richColor(attrs.color); if (c) style += `color:${c};`;
      if (attrs.size && /^\d+$/.test(attrs.size)) style += `font-size:${attrs.size}px;`;
      if (attrs.face) style += `font-family:${FAMILIES[attrs.face.replace(/\s/g, '')] || `"${attrs.face.replace(/["<>]/g, '')}"`};`;
      if (attrs.weight) style += `font-weight:${/^\d+$/.test(attrs.weight) ? attrs.weight : ({ thin: 100, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 900 }[attrs.weight.toLowerCase()] || 400)};`;
      if (attrs.transparency) style += `opacity:${1 - Math.max(0, Math.min(1, Number(attrs.transparency) || 0))};`;
    } else if (tag === 'stroke') {
      const c = richColor(attrs.color) || '#000';
      const t = Math.max(1, Math.min(10, Number(attrs.thickness) || 1));
      style += `-webkit-text-stroke:${t}px ${c};paint-order:stroke fill;`;
    } else if (tag === 'uc' || tag === 'uppercase') style += 'text-transform:uppercase;';
    else if (tag === 'sc' || tag === 'smallcaps') style += 'font-variant:small-caps;';
    else if (tag === 'mark') { const c = richColor(attrs.color) || '#ff0'; style += `background:${c};color:inherit;`; }
    stack.push(tag);
    out += `<${map[tag]}${style ? ` style="${style}"` : ''}>`;
  }
  while (stack.length) out += `</${map2(stack.pop())}>`;
  return out;
}
const map2 = (t) => ({ b: 'b', i: 'i', u: 'u', s: 's', strike: 's', mark: 'mark' }[t] || 'span');
const stripRich = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---------------------------------------------------------------- helpers
const ud = (v) => v || UDim2.fromOffset(0, 0);
const vis = (i) => i.props.Visible !== false;
const isGuiObject = (i) => i.isA('GuiObject');
const findMod = (i, cn) => { for (const c of i.children) if (c.ClassName === cn) return c; return null; };
const enumName = (v, d) => (v && v.Name) || d;
function setIf(inst, name, v) {
  const old = inst.props[name];
  if (old && v && old.eq ? old.eq(v) : old === v) return;
  inst.rawSet(name, v);
}

/** 4 points -> CSS matrix3d mapping a w x h box onto them (homography). */
function quadMatrix(w, h, p) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p; // top-left, top-right, bottom-right, bottom-left
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / den, hh = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  // scale from unit square to w x h
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1];
  return `matrix3d(${m.map((x) => +x.toFixed(9)).join(',')})`;
}

export class GuiRenderer {
  /**
   * @param owner ClientRuntime (play) or { world, app, viewport } (Studio edit preview)
   * @param container element the GUI root is appended to
   * @param opts { edit: bool }
   */
  constructor(owner, container, opts = {}) {
    this.owner = owner;
    this.world = owner.world;
    this.app = owner.app;
    this.edit = !!opts.edit;
    this.widget = !!opts.widget; // plugin widget: interactive, own roots and size, no world hooks
    this.rootsFn = opts.roots || null;
    this.sizeFn = opts.size || null;
    this.root = document.createElement('div');
    this.root.className = `game-ui${this.edit ? ' edit' : ''}`;
    container.append(this.root);
    this.nodes = new Map(); // inst -> node
    this.dirty = true;
    this.images = new Map(); // content -> { url, w, h } | Promise
    this.hovered = new Set();
    this.hasWorldGuis = false;
    this.unobserve = this.world.observe({
      added: (i) => this.touch(i), removed: (i) => this.touch(i), moved: (i) => this.touch(i),
      propChanged: (i, n) => { if (n === 'AbsolutePosition' || n === 'AbsoluteSize' || n === 'AbsoluteRotation' || n === 'TextBounds' || n === 'AbsoluteContentSize' || n === 'AbsoluteCanvasSize' || n === 'AbsoluteWindowSize') return; this.touch(i); },
      attrChanged: () => {},
    });
    const h = this.world.hooks;
    if (!this.edit && !this.widget) {
      h.guiObjectsAt = (x, y) => this.objectsAt(x, y);
      h.focusTextBox = (tb, on, submitted) => this.focusBox(tb, on, submitted);
      this.onMove = (e) => this.hoverAt(e);
      window.addEventListener('pointermove', this.onMove);
    }
    this.resizeObs = new ResizeObserver(() => { this.dirty = true; });
    this.resizeObs.observe(container);
  }
  dispose() {
    this.unobserve();
    this.resizeObs.disconnect();
    if (this.onMove) window.removeEventListener('pointermove', this.onMove);
    this.root.remove();
    this.nodes.clear();
  }
  touch(i) {
    if (this.dirty) return;
    if (i.isA('GuiBase2d') || UI_MODS.has(i.ClassName) || i.ClassName === 'PlayerGui' || i.ClassName === 'StarterGui' || i.ClassName === 'Player' || i.ClassName === 'Folder' || i.isA('LayerCollector')) this.dirty = true;
  }

  roots() {
    if (this.rootsFn) return this.rootsFn();
    const w = this.world;
    const out = [];
    if (this.edit) {
      const sg = w.dm.findFirstChildOfClass('StarterGui');
      if (sg && sg.props.ShowDevelopmentGui !== false) for (const g of sg.children) if (g.ClassName === 'ScreenGui') out.push(g);
    } else {
      const lp = w.localPlayer;
      const pg = lp && lp.findFirstChildOfClass('PlayerGui');
      if (pg) pg.forTree((d) => { if (d.ClassName === 'ScreenGui' && d !== pg) out.push(d); });
    }
    return out;
  }
  worldGuis() {
    const out = [];
    if (this.widget) return out;
    const w = this.world;
    const scan = (root) => root && root.forTree((d) => { if (d.ClassName === 'BillboardGui' || d.ClassName === 'SurfaceGui') out.push(d); });
    scan(w.dm.findFirstChildOfClass('Workspace'));
    if (this.edit) scan(w.dm.findFirstChildOfClass('StarterGui'));
    else { const lp = w.localPlayer; scan(lp && lp.findFirstChildOfClass('PlayerGui')); }
    return out;
  }

  // ------------------------------------------------------------ frame
  update() {
    const worldGuis = this.dirty || this.hasWorldGuis || this.worldScanAge++ > 30 ? this.worldGuis() : [];
    if (this.dirty || this.worldScanAge > 30) this.worldScanAge = 0;
    this.hasWorldGuis = worldGuis.length > 0;
    if (!this.dirty && !this.hasWorldGuis) return;
    this.dirty = false;
    const vp = this.owner.viewport || this.app.viewport;
    const sz = this.sizeFn ? this.sizeFn() : vp.size;
    const W = sz.w, H = sz.h;
    this.seen = new Set();
    const roots = this.roots().filter((g) => g.props.Enabled !== false).sort((a, b) => (a.props.DisplayOrder || 0) - (b.props.DisplayOrder || 0));
    roots.forEach((g, idx) => {
      const ignore = this.widget || g.props.IgnoreGuiInset === true || enumName(g.props.ScreenInsets, '') === 'None';
      const rect = ignore ? { x: 0, y: 0, w: W, h: H } : { x: 0, y: INSET, w: W, h: H - INSET };
      const node = this.layer(g, this.root);
      node.el.style.zIndex = String(10 + idx);
      this.style(node, `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;`);
      setIf(g, 'AbsoluteSize', new Vector2(rect.w, rect.h));
      setIf(g, 'AbsolutePosition', new Vector2(rect.x, ignore ? 0 : rect.y - INSET));
      this.layoutChildren(g, rect, rect, node.content, g.props.ZIndexBehavior && g.props.ZIndexBehavior.Name === 'Global');
    });
    for (const g of worldGuis) if (g.props.Enabled !== false) this.layoutWorldGui(g, vp, W, H);
    for (const [inst, node] of this.nodes) if (!this.seen.has(inst)) { node.el.remove(); this.nodes.delete(inst); this.hovered.delete(inst); }
  }

  layer(g, parentEl) {
    this.seen.add(g);
    let node = this.nodes.get(g);
    if (!node) {
      const el = document.createElement('div');
      el.className = 'gui-layer';
      node = { el, content: el, key: '' };
      this.nodes.set(g, node);
    }
    if (node.el.parentNode !== parentEl) parentEl.append(node.el);
    return node;
  }

  // ------------------------------------------------------------ world space guis
  layoutWorldGui(g, vp, W, H) {
    const cam = vp.camera;
    const P = g.props;
    const isBB = g.ClassName === 'BillboardGui';
    let adornee = P.Adornee || (g.parent && (g.parent.isA('BasePart') || g.parent.ClassName === 'Attachment') ? g.parent : null);
    if (!adornee && g.parent && g.parent.isA('Model')) adornee = g.parent.props.PrimaryPart;
    if (!adornee || !adornee.dm) return;
    if (isBB) {
      let base = adornee.ClassName === 'Attachment' ? adornee.get('WorldPosition') : adornee.isA('BasePart') ? adornee.props.CFrame.Position : null;
      if (!base) return;
      const camCF = this.world.dm.findFirstChildOfClass('Workspace').props.CurrentCamera?.props.CFrame;
      if (P.StudsOffsetWorldSpace) base = base.add(P.StudsOffsetWorldSpace);
      const so = P.StudsOffset || Vector3.zero;
      if (camCF) base = base.add(camCF.RightVector.mul(so.X)).add(camCF.UpVector.mul(so.Y)).add(camCF.LookVector.mul(-so.Z));
      if (P.ExtentsOffset && adornee.isA('BasePart')) { const s = adornee.props.Size; base = base.add(new Vector3(P.ExtentsOffset.X * s.X / 2, P.ExtentsOffset.Y * s.Y / 2, P.ExtentsOffset.Z * s.Z / 2)); }
      const dist = camCF ? camCF.Position.sub(base).Magnitude : 0;
      if (P.MaxDistance && P.MaxDistance > 0 && dist > P.MaxDistance) return;
      const v = { x: base.X, y: base.Y, z: base.Z };
      const p = toScreen(cam, v, W, H);
      if (!p) return;
      // size: scale component is studs (shrinks with distance), offset is pixels
      const size = ud(P.Size);
      const pxPerStud = H / (2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(0.1, p.depth));
      const w = size.X.Scale * pxPerStud + size.X.Offset, h = size.Y.Scale * pxPerStud + size.Y.Offset;
      const po = P.SizeOffset || Vector2.zero;
      const rect = { x: p.x - w / 2 + po.X * w, y: p.y - h / 2 - po.Y * h, w, h };
      const node = this.layer(g, this.root);
      node.el.style.zIndex = P.AlwaysOnTop ? '9' : '1';
      this.style(node, `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;${P.ClipsDescendants ? 'overflow:hidden;' : ''}`);
      setIf(g, 'AbsoluteSize', new Vector2(w, h));
      setIf(g, 'AbsolutePosition', new Vector2(rect.x, rect.y));
      this.layoutChildren(g, rect, rect, node.content, false);
      return;
    }
    // SurfaceGui: project the face's corners and map a pixel canvas onto them
    if (!adornee.isA('BasePart')) return;
    const face = enumName(P.Face, 'Front');
    const cf = adornee.props.CFrame, s = adornee.props.Size.mul(0.5);
    const F = {
      Front: [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1], [0, 0, -1], ['X', 'Y']], Back: [[1, 1, 1], [-1, 1, 1], [-1, -1, 1], [1, -1, 1], [0, 0, 1], ['X', 'Y']],
      Right: [[1, 1, -1], [1, 1, 1], [1, -1, 1], [1, -1, -1], [1, 0, 0], ['Z', 'Y']], Left: [[-1, 1, 1], [-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 0, 0], ['Z', 'Y']],
      Top: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0], ['X', 'Z']], Bottom: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0], ['X', 'Z']],
    }[face];
    const normal = cf.vectorToWorld(new Vector3(...F[4]));
    const center = cf.pointToWorld(new Vector3(F[4][0] * s.X, F[4][1] * s.Y, F[4][2] * s.Z));
    const camPos = cam.position;
    const toCam = new Vector3(camPos.x - center.X, camPos.y - center.Y, camPos.z - center.Z);
    if (normal.dot(toCam) <= 0) return;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const c = F[i];
      const wp = cf.pointToWorld(new Vector3(c[0] * s.X, c[1] * s.Y, c[2] * s.Z));
      const sp = toScreen(cam, { x: wp.X, y: wp.Y, z: wp.Z }, W, H);
      if (!sp) return;
      pts.push(sp.x, sp.y);
    }
    const studsW = adornee.props.Size[F[5][0]], studsH = adornee.props.Size[F[5][1]];
    const ppsMode = enumName(P.SizingMode, 'PixelsPerStud');
    let cw, ch;
    if (ppsMode === 'FixedSize') { const cs = P.CanvasSize || new Vector2(800, 600); cw = cs.X; ch = cs.Y; }
    else { const pps = P.PixelsPerStud ?? 50; cw = studsW * pps; ch = studsH * pps; }
    cw = Math.max(1, cw); ch = Math.max(1, ch);
    const m = quadMatrix(cw, ch, pts);
    if (!m) return;
    const node = this.layer(g, this.root);
    node.el.style.zIndex = P.AlwaysOnTop ? '9' : '0';
    this.style(node, `left:0;top:0;width:${cw}px;height:${ch}px;transform-origin:0 0;transform:${m};overflow:hidden;${P.Brightness !== undefined ? '' : ''}`);
    const rect = { x: 0, y: 0, w: cw, h: ch };
    setIf(g, 'AbsoluteSize', new Vector2(cw, ch));
    this.layoutChildren(g, rect, rect, node.content, false);
  }

  // ------------------------------------------------------------ layout
  /**
   * @param parent instance whose GuiObject children are laid out
   * @param box parent's absolute rect (border box)
   * @param content content rect children are positioned in (after padding / canvas)
   * @param el DOM element the children are appended to (positioned at `box` origin unless scrolling canvas)
   */
  layoutChildren(parent, box, content, el, global, origin = box) {
    const kids = parent.children.filter((c) => isGuiObject(c));
    if (!kids.length) return { w: 0, h: 0 };
    const layout = parent.children.find((c) => GUI_LAYOUT.has(c.ClassName));
    const items = kids.filter(vis);
    let rects;
    if (layout && (layout.ClassName === 'UIListLayout' || layout.ClassName === 'UITableLayout')) rects = this.listLayout(layout, items, content);
    else if (layout && layout.ClassName === 'UIGridLayout') rects = this.gridLayout(layout, items, content);
    else if (layout && layout.ClassName === 'UIPageLayout') rects = this.pageLayout(layout, items, content);
    else rects = new Map(items.map((c) => [c, this.placeFree(c, content)]));
    let maxX = 0, maxY = 0;
    for (const c of kids) {
      if (!vis(c)) { const n = this.nodes.get(c); if (n) this.seen.add(c); if (n) n.el.style.display = 'none'; continue; }
      const r = rects.get(c);
      if (!r) continue;
      this.renderObject(c, r, el, origin, global);
      maxX = Math.max(maxX, r.x + r.w - content.x);
      maxY = Math.max(maxY, r.y + r.h - content.y);
    }
    return { w: maxX, h: maxY };
  }

  /** Size of a GuiObject inside `content` (UDim2 + SizeConstraint + constraints + AutomaticSize text). */
  sizeOf(c, content) {
    const P = c.props;
    const s = ud(P.Size);
    let pw = content.w, ph = content.h;
    const sc = enumName(P.SizeConstraint, 'RelativeXY');
    if (sc === 'RelativeXX') ph = pw; else if (sc === 'RelativeYY') pw = ph;
    let w = s.X.Scale * pw + s.X.Offset, h = s.Y.Scale * ph + s.Y.Offset;
    const asp = findMod(c, 'UIAspectRatioConstraint');
    if (asp) {
      const ratio = Math.max(1e-3, asp.props.AspectRatio ?? 1);
      const type = enumName(asp.props.AspectType, 'FitWithinMaxSize');
      const dom = enumName(asp.props.DominantAxis, 'Width');
      if (type === 'ScaleWithParentSize') { if (dom === 'Width') h = w / ratio; else w = h * ratio; }
      else if (w / h > ratio) w = h * ratio; else h = w / ratio;
    }
    const sz = findMod(c, 'UISizeConstraint');
    if (sz) {
      const mn = sz.props.MinSize || Vector2.zero, mx = sz.props.MaxSize || new Vector2(Infinity, Infinity);
      w = Math.max(mn.X, Math.min(mx.X === 0 && mn.X === 0 ? Infinity : mx.X, w));
      h = Math.max(mn.Y, Math.min(mx.Y === 0 && mn.Y === 0 ? Infinity : mx.Y, h));
    }
    const auto = enumName(P.AutomaticSize, 'None');
    if (auto !== 'None' && 'Text' in P) {
      const font = fontOf(c);
      const pad = this.padding(c, { w, h });
      const txt = P.RichText ? stripRich(P.Text || '') : String(P.Text || '');
      const m = measureText(txt, font, P.TextSize ?? 14, auto === 'Y' && P.TextWrapped ? Math.max(1, w - pad.l - pad.r) : Infinity, P.LineHeight ?? 1);
      if (auto === 'X' || auto === 'XY') w = Math.max(w, m.w + pad.l + pad.r);
      if (auto === 'Y' || auto === 'XY') h = Math.max(h, m.h + pad.t + pad.b);
    }
    const scale = findMod(c, 'UIScale');
    if (scale) { w *= scale.props.Scale ?? 1; h *= scale.props.Scale ?? 1; }
    return { w: Math.max(0, w), h: Math.max(0, h) };
  }
  placeFree(c, content) {
    const { w, h } = this.sizeOf(c, content);
    const p = ud(c.props.Position);
    const a = c.props.AnchorPoint || Vector2.zero;
    return { x: content.x + p.X.Scale * content.w + p.X.Offset - a.X * w, y: content.y + p.Y.Scale * content.h + p.Y.Offset - a.Y * h, w, h };
  }
  padding(c, rect) {
    const pad = findMod(c, 'UIPadding');
    if (!pad) return { l: 0, r: 0, t: 0, b: 0 };
    const u = (v, base) => (v ? v.Scale * base + v.Offset : 0);
    return { l: u(pad.props.PaddingLeft, rect.w), r: u(pad.props.PaddingRight, rect.w), t: u(pad.props.PaddingTop, rect.h), b: u(pad.props.PaddingBottom, rect.h) };
  }
  sorted(layout, items) {
    const byName = enumName(layout.props.SortOrder, 'Name') === 'Name';
    const order = items.map((c, i) => [c, i]);
    order.sort((a, b) => (byName ? String(a[0].props.Name).localeCompare(String(b[0].props.Name)) : (a[0].props.LayoutOrder || 0) - (b[0].props.LayoutOrder || 0)) || a[1] - b[1]);
    return order.map((x) => x[0]);
  }
  listLayout(layout, items, content) {
    const P = layout.props;
    const horiz = enumName(P.FillDirection, 'Vertical') === 'Horizontal';
    const pad = P.Padding ? P.Padding.Scale * (horiz ? content.w : content.h) + P.Padding.Offset : 0;
    const list = this.sorted(layout, items);
    const sizes = list.map((c) => this.sizeOf(c, content));
    const total = sizes.reduce((s, z) => s + (horiz ? z.w : z.h), 0) + pad * Math.max(0, list.length - 1);
    const ha = enumName(P.HorizontalAlignment, 'Left'), va = enumName(P.VerticalAlignment, 'Top');
    let cur;
    if (horiz) cur = content.x + (ha === 'Center' ? (content.w - total) / 2 : ha === 'Right' ? content.w - total : 0);
    else cur = content.y + (va === 'Center' ? (content.h - total) / 2 : va === 'Bottom' ? content.h - total : 0);
    const out = new Map();
    let cross = 0;
    list.forEach((c, i) => {
      const s = sizes[i];
      if (horiz) {
        const y = content.y + (va === 'Center' ? (content.h - s.h) / 2 : va === 'Bottom' ? content.h - s.h : 0);
        out.set(c, { x: cur, y, w: s.w, h: s.h }); cur += s.w + pad; cross = Math.max(cross, s.h);
      } else {
        const x = content.x + (ha === 'Center' ? (content.w - s.w) / 2 : ha === 'Right' ? content.w - s.w : 0);
        out.set(c, { x, y: cur, w: s.w, h: s.h }); cur += s.h + pad; cross = Math.max(cross, s.w);
      }
    });
    setIf(layout, 'AbsoluteContentSize', horiz ? new Vector2(total, cross) : new Vector2(cross, total));
    return out;
  }
  gridLayout(layout, items, content) {
    const P = layout.props;
    const cs = P.CellSize || UDim2.fromOffset(100, 100), cp = P.CellPadding || UDim2.fromOffset(5, 5);
    let cw = cs.X.Scale * content.w + cs.X.Offset, ch = cs.Y.Scale * content.h + cs.Y.Offset;
    const px = cp.X.Scale * content.w + cp.X.Offset, py = cp.Y.Scale * content.h + cp.Y.Offset;
    const asp = findMod(layout, 'UIAspectRatioConstraint');
    if (asp) { const r = asp.props.AspectRatio ?? 1; if (cw / ch > r) cw = ch * r; else ch = cw / r; }
    const horiz = enumName(P.FillDirection, 'Horizontal') === 'Horizontal';
    let perLine = horiz ? Math.max(1, Math.floor((content.w + px) / (cw + px))) : Math.max(1, Math.floor((content.h + py) / (ch + py)));
    if (P.FillDirectionMaxCells > 0) perLine = Math.min(perLine, P.FillDirectionMaxCells);
    const list = this.sorted(layout, items);
    const lines = Math.ceil(list.length / perLine);
    const cols = horiz ? Math.min(perLine, list.length) : lines, rows = horiz ? lines : Math.min(perLine, list.length);
    const tw = cols * cw + Math.max(0, cols - 1) * px, th = rows * ch + Math.max(0, rows - 1) * py;
    const ha = enumName(P.HorizontalAlignment, 'Left'), va = enumName(P.VerticalAlignment, 'Top');
    const ox = content.x + (ha === 'Center' ? (content.w - tw) / 2 : ha === 'Right' ? content.w - tw : 0);
    const oy = content.y + (va === 'Center' ? (content.h - th) / 2 : va === 'Bottom' ? content.h - th : 0);
    const corner = enumName(P.StartCorner, 'TopLeft');
    const out = new Map();
    list.forEach((c, i) => {
      let col = horiz ? i % perLine : Math.floor(i / perLine), row = horiz ? Math.floor(i / perLine) : i % perLine;
      if (corner === 'TopRight' || corner === 'BottomRight') col = cols - 1 - col;
      if (corner === 'BottomLeft' || corner === 'BottomRight') row = rows - 1 - row;
      out.set(c, { x: ox + col * (cw + px), y: oy + row * (ch + py), w: cw, h: ch });
    });
    setIf(layout, 'AbsoluteCellSize', new Vector2(cw, ch));
    setIf(layout, 'AbsoluteCellCount', new Vector2(cols, rows));
    setIf(layout, 'AbsoluteContentSize', new Vector2(tw, th));
    return out;
  }
  pageLayout(layout, items, content) {
    const list = this.sorted(layout, items);
    const cur = layout.props.CurrentPage && list.includes(layout.props.CurrentPage) ? layout.props.CurrentPage : list[0];
    const idx = list.indexOf(cur);
    const horiz = enumName(layout.props.FillDirection, 'Horizontal') === 'Horizontal';
    const out = new Map();
    list.forEach((c, i) => { const s = this.sizeOf(c, content); out.set(c, { x: content.x + (horiz ? (i - idx) * content.w : 0), y: content.y + (horiz ? 0 : (i - idx) * content.h), w: s.w, h: s.h }); });
    return out;
  }

  // ------------------------------------------------------------ rendering one object
  node(c, parentEl) {
    let n = this.nodes.get(c);
    const kind = c.ClassName;
    if (!n || n.kind !== kind) {
      if (n) n.el.remove();
      let el;
      if (kind === 'TextBox') {
        el = document.createElement(c.props.MultiLine ? 'textarea' : 'input');
        el.spellcheck = false;
        el.addEventListener('input', () => { c.rawSet('Text', el.value); c.rawSet('ContentText', el.value); });
        el.addEventListener('focus', () => { if (c.props.ClearTextOnFocus !== false && !this.edit) { el.value = ''; c.rawSet('Text', ''); } this.setFocus(c, true); });
        el.addEventListener('blur', () => this.setFocus(c, false, n.enter));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !c.props.MultiLine) { n.enter = true; el.blur(); n.enter = false; } if (e.key === 'Escape') el.blur(); });
      } else el = document.createElement('div');
      el.className = `gui ${kind}`;
      n = { el, kind, key: '', content: el };
      if (kind === 'ScrollingFrame') {
        const canvas = document.createElement('div');
        canvas.className = 'gui-canvas';
        el.append(canvas);
        n.content = canvas;
        el.addEventListener('scroll', () => { n.fromScroll = true; c.rawSet('CanvasPosition', new Vector2(el.scrollLeft, el.scrollTop)); n.fromScroll = false; });
      }
      if (kind === 'TextLabel' || kind === 'TextButton') { n.text = document.createElement('span'); n.text.className = 'gui-text'; el.append(n.text); }
      if (!this.edit) this.bindEvents(c, n);
      this.nodes.set(c, n);
    }
    if (n.el.parentNode !== parentEl) parentEl.append(n.el);
    return n;
  }

  bindEvents(c, n) {
    const el = n.el;
    const button = c.isA('GuiButton');
    const io = (type, state, e) => {
      const inp = this.owner.input;
      const r = this.root.getBoundingClientRect();
      const o = inp ? inp.makeInput(type, state, 'Unknown', new Vector3(e.clientX - r.left, e.clientY - r.top - INSET, 0)) : null;
      return o;
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.interactive(c)) return;
      const x = e.clientX - this.root.getBoundingClientRect().left, y = e.clientY - this.root.getBoundingClientRect().top - INSET;
      const t = e.button === 2 ? 'MouseButton2' : 'MouseButton1';
      n.pressed = t;
      c.fire('InputBegan', io(t, 'Begin', e));
      if (button) {
        e.preventDefault(); e.stopPropagation();
        c.fire(e.button === 2 ? 'MouseButton2Down' : 'MouseButton1Down', x, y);
        if (c.props.AutoButtonColor !== false) el.classList.add('pressed');
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!n.pressed) return;
      const t = n.pressed;
      n.pressed = null;
      el.classList.remove('pressed');
      const x = e.clientX - this.root.getBoundingClientRect().left, y = e.clientY - this.root.getBoundingClientRect().top - INSET;
      c.fire('InputEnded', io(t, 'End', e));
      if (!button || !this.interactive(c)) return;
      e.stopPropagation();
      if (t === 'MouseButton1') {
        c.fire('MouseButton1Up', x, y);
        c.fire('MouseButton1Click');
        c.fire('Activated', io(t, 'End', e), 1);
      } else { c.fire('MouseButton2Up', x, y); c.fire('MouseButton2Click'); }
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (!this.interactive(c)) return;
      const x = e.clientX - this.root.getBoundingClientRect().left, y = e.clientY - this.root.getBoundingClientRect().top - INSET;
      c.fire(e.deltaY < 0 ? 'MouseWheelForward' : 'MouseWheelBackward', x, y);
      if (c.ClassName !== 'ScrollingFrame' && !el.closest('.ScrollingFrame')) e.preventDefault();
    }, { passive: false });
  }
  interactive(c) {
    if (c.props.Interactable === false) return false;
    for (let p = c; p; p = p.parent) if (p.props.Visible === false || (p.isA('LayerCollector') && p.props.Enabled === false)) return false;
    return true;
  }

  style(n, s) { if (n.key !== s) { n.key = s; n.el.style.cssText = s; } }

  renderObject(c, r, parentEl, origin, global) {
    this.seen.add(c);
    const P = c.props;
    const n = this.node(c, parentEl);
    setIf(c, 'AbsolutePosition', new Vector2(r.x, r.y - (origin.y >= INSET && !this.edit ? 0 : 0)));
    setIf(c, 'AbsoluteSize', new Vector2(r.w, r.h));
    if ((P.Rotation || 0) !== (c.props.AbsoluteRotation || 0)) setIf(c, 'AbsoluteRotation', P.Rotation || 0);
    const bgT = P.BackgroundTransparency ?? 0;
    const bg = P.BackgroundColor3 || new Color3(1, 1, 1);
    let st = `left:${r.x - origin.x}px;top:${r.y - origin.y}px;width:${r.w}px;height:${r.h}px;z-index:${P.ZIndex ?? 1};`;
    const grad = findMod(c, 'UIGradient');
    const gradOn = grad && grad.props.Enabled !== false;
    if (bgT < 1) st += gradOn ? `background:${gradientCss(grad, bg, bgT)};` : `background:${rgba(bg, bgT)};`;
    if (gradOn && grad.props.Transparency) st += `-webkit-mask-image:${transparencyMask(grad)};mask-image:${transparencyMask(grad)};`;
    const bsp = P.BorderSizePixel ?? 1;
    if (bsp > 0 && bgT < 1 && c.ClassName !== 'ScrollingFrame') {
      const mode = enumName(P.BorderMode, 'Outline');
      st += `box-shadow:${mode === 'Inset' ? 'inset ' : ''}0 0 0 ${bsp}px ${rgba(P.BorderColor3 || new Color3(0.1, 0.16, 0.2), bgT)};`;
    }
    if (P.Rotation) st += `transform:rotate(${P.Rotation}deg);`;
    const corner = findMod(c, 'UICorner');
    if (corner) { const cr = corner.props.CornerRadius; const rad = cr ? cr.Scale * Math.min(r.w, r.h) + cr.Offset : 8; st += `border-radius:${Math.max(0, rad)}px;`; }
    const stroke = c.children.find((x) => x.ClassName === 'UIStroke' && x.props.Enabled !== false && enumName(x.props.ApplyStrokeMode, 'Contextual') === 'Border');
    if (stroke) {
      const t = stroke.props.Thickness ?? 1;
      st += `outline:${t}px solid ${rgba(stroke.props.Color || new Color3(0, 0, 0), stroke.props.Transparency ?? 0)};outline-offset:0;`;
    }
    if (P.ClipsDescendants || c.ClassName === 'ScrollingFrame') st += 'overflow:hidden;';
    const interactive = !this.edit && (c.isA('GuiButton') || c.ClassName === 'TextBox' || c.ClassName === 'ScrollingFrame' || P.Active === true);
    st += interactive ? 'pointer-events:auto;' : '';
    if (c.ClassName === 'CanvasGroup') st += `opacity:${1 - (P.GroupTransparency ?? 0)};`;
    // text
    if ('Text' in P || c.cls.props.Text) st += this.textStyle(c, n, r, stroke);
    // images
    if (c.ClassName === 'ImageLabel' || c.ClassName === 'ImageButton') st += this.imageStyle(c, r);
    if (c.ClassName === 'ScrollingFrame') st += this.scrollStyle(c, n, r);
    if (c.ClassName === 'ViewportFrame' && bgT >= 1) st += 'background:rgba(0,0,0,0.05);';
    const scale = findMod(c, 'UIScale');
    if (scale && (scale.props.Scale ?? 1) !== 1) {
      // children were laid out in unscaled units; scale the subtree visually
      const k = scale.props.Scale ?? 1;
      st += `transform-origin:0 0;`;
      n.childScale = k;
    } else n.childScale = 1;
    if (c.isA('GuiButton') && P.AutoButtonColor !== false && !this.edit) n.el.classList.add('auto-color'); else n.el.classList.remove('auto-color');
    this.style(n, st);
    // children
    const pad = this.padding(c, r);
    let content = { x: r.x + pad.l, y: r.y + pad.t, w: Math.max(0, r.w - pad.l - pad.r), h: Math.max(0, r.h - pad.t - pad.b) };
    let childOrigin = r;
    if (c.ClassName === 'ScrollingFrame') {
      const cv = n.canvasRect;
      content = { x: r.x + pad.l, y: r.y + pad.t, w: cv.w - pad.l - pad.r, h: cv.h - pad.t - pad.b };
      childOrigin = { x: r.x, y: r.y };
    }
    const ext = this.layoutChildren(c, r, content, n.content, global, childOrigin);
    // AutomaticSize from children (frames) / AutomaticCanvasSize
    const auto = enumName(P.AutomaticSize, 'None');
    if (auto !== 'None' && !('Text' in P) && ext) {
      const nw = auto === 'Y' ? r.w : Math.max(r.w, ext.w + pad.l + pad.r), nh = auto === 'X' ? r.h : Math.max(r.h, ext.h + pad.t + pad.b);
      if (nw !== r.w || nh !== r.h) {
        r.w = nw; r.h = nh;
        setIf(c, 'AbsoluteSize', new Vector2(r.w, r.h));
        n.el.style.width = `${r.w}px`; n.el.style.height = `${r.h}px`;
        n.key = n.el.style.cssText;
      }
    }
    if (c.ClassName === 'ScrollingFrame' && ext) {
      const ac = enumName(P.AutomaticCanvasSize, 'None');
      if (ac !== 'None') {
        const cw = ac === 'Y' ? n.canvasRect.w : Math.max(r.w, ext.w + pad.l + pad.r), ch = ac === 'X' ? n.canvasRect.h : Math.max(r.h, ext.h + pad.t + pad.b);
        if (cw !== n.canvasRect.w || ch !== n.canvasRect.h) { n.content.style.width = `${cw}px`; n.content.style.height = `${ch}px`; setIf(c, 'AbsoluteCanvasSize', new Vector2(cw, ch)); }
      }
    }
  }

  textStyle(c, n, r, stroke) {
    const P = c.props;
    const font = fontOf(c);
    let size = P.TextSize ?? 14;
    const raw = String(P.Text ?? '');
    const plain = P.RichText ? stripRich(raw) : raw;
    const pad = this.padding(c, r);
    const iw = Math.max(1, r.w - pad.l - pad.r), ih = Math.max(1, r.h - pad.t - pad.b);
    const lh = P.LineHeight ?? 1;
    const tsc = findMod(c, 'UITextSizeConstraint');
    if (P.TextScaled) {
      let lo = 1, hi = Math.min(100, tsc ? tsc.props.MaxTextSize ?? 100 : 100);
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        const m = measureText(plain || ' ', font, mid, P.TextWrapped || plain.includes(' ') ? iw : Infinity, lh);
        if (m.w <= iw + 0.5 && m.h <= ih + 0.5) lo = mid; else hi = mid;
      }
      size = Math.floor(lo);
      if (tsc) size = Math.max(tsc.props.MinTextSize ?? 1, size);
    } else if (tsc) size = Math.max(tsc.props.MinTextSize ?? 1, Math.min(tsc.props.MaxTextSize ?? 100, size));
    const m = measureText(plain, font, size, P.TextWrapped || P.TextScaled ? iw : Infinity, lh);
    setIf(c, 'TextBounds', new Vector2(m.w, m.h));
    if (!c.props.ContentText || c.props.ContentText !== plain) c.rawSet('ContentText', plain);
    if (!c.props.TextFits !== !(m.w <= iw && m.h <= ih)) c.rawSet('TextFits', m.w <= iw && m.h <= ih);
    const color = P.TextColor3 || new Color3(0.1, 0.1, 0.1);
    const tt = P.TextTransparency ?? 0;
    const xa = enumName(P.TextXAlignment, 'Center'), ya = enumName(P.TextYAlignment, 'Center');
    let st = `font-family:${font.family};font-weight:${font.weight};font-style:${font.style};font-size:${size}px;line-height:${lh};color:${rgba(color, tt)};`;
    st += `padding:${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px;justify-content:${xa === 'Left' ? 'flex-start' : xa === 'Right' ? 'flex-end' : 'center'};align-items:${ya === 'Top' ? 'flex-start' : ya === 'Bottom' ? 'flex-end' : 'center'};text-align:${xa === 'Left' ? 'left' : xa === 'Right' ? 'right' : 'center'};`;
    st += `white-space:${P.TextWrapped || P.TextScaled ? 'pre-wrap' : 'pre'};`;
    const tst = P.TextStrokeTransparency ?? 1;
    const ctxStroke = c.children.find((x) => x.ClassName === 'UIStroke' && x.props.Enabled !== false && enumName(x.props.ApplyStrokeMode, 'Contextual') === 'Contextual');
    if (ctxStroke) { const t = ctxStroke.props.Thickness ?? 1; const sc = rgba(ctxStroke.props.Color || new Color3(0, 0, 0), ctxStroke.props.Transparency ?? 0); st += `text-shadow:${shadowRing(t, sc)};`; }
    else if (tst < 1) st += `text-shadow:${shadowRing(1, rgba(P.TextStrokeColor3 || new Color3(0, 0, 0), tst))};`;
    if (enumName(P.TextTruncate, 'None') === 'AtEnd') st += 'text-overflow:ellipsis;overflow:hidden;';
    void stroke;
    if (c.ClassName === 'TextBox') {
      const el = n.el;
      const v = String(P.Text ?? '');
      if (document.activeElement !== el && el.value !== v) el.value = v;
      el.placeholder = String(P.PlaceholderText ?? '');
      el.readOnly = P.TextEditable === false || this.edit;
      st += `--ph:${rgba(P.PlaceholderColor3 || new Color3(0.7, 0.7, 0.7), 0)};`;
      return st;
    }
    let shown = P.RichText ? richToHtml(raw) : null;
    const mvg = P.MaxVisibleGraphemes ?? -1;
    if (mvg >= 0) { shown = null; }
    const textKey = `${P.RichText ? 1 : 0}|${mvg}|${raw}`;
    if (n.textKey !== textKey) {
      n.textKey = textKey;
      if (shown !== null) n.text.innerHTML = shown;
      else n.text.textContent = mvg >= 0 ? [...plain].slice(0, mvg).join('') : plain;
    }
    return st;
  }

  imageStyle(c, r) {
    const P = c.props;
    const img = P.Image || '';
    if (!img) return '';
    const info = this.imageInfo(img);
    if (!info || !info.url) return '';
    const it = P.ImageTransparency ?? 0;
    const tint = P.ImageColor3 || new Color3(1, 1, 1);
    const type = enumName(P.ScaleType, 'Stretch');
    let st = '';
    const url = `url("${info.url}")`;
    const rectSize = P.ImageRectSize, rectOff = P.ImageRectOffset || Vector2.zero;
    let size = '100% 100%', pos = '0 0', repeat = 'no-repeat';
    if (rectSize && rectSize.X > 0 && rectSize.Y > 0 && info.w) {
      const sx = r.w / rectSize.X, sy = r.h / rectSize.Y;
      size = `${info.w * sx}px ${info.h * sy}px`;
      pos = `${-rectOff.X * sx}px ${-rectOff.Y * sy}px`;
    } else if (type === 'Fit') size = 'contain';
    else if (type === 'Crop') size = 'cover';
    else if (type === 'Tile') { const ts = P.TileSize || UDim2.fromScale(1, 1); size = `${ts.X.Scale * r.w + ts.X.Offset}px ${ts.Y.Scale * r.h + ts.Y.Offset}px`; repeat = 'repeat'; }
    if (type === 'Fit' || type === 'Crop') pos = 'center';
    if (type === 'Slice' && info.w) {
      const sc = P.SliceCenter;
      const scale = P.SliceScale ?? 1;
      if (sc) {
        const t = sc.Min.Y, l = sc.Min.X, b = info.h - sc.Max.Y, rr = info.w - sc.Max.X;
        return `border-style:solid;border-width:${t * scale}px ${rr * scale}px ${b * scale}px ${l * scale}px;border-image:${url} ${t} ${rr} ${b} ${l} fill stretch;box-sizing:border-box;${it > 0 ? `opacity:${1 - it};` : ''}`;
      }
    }
    const white = tint.R > 0.99 && tint.G > 0.99 && tint.B > 0.99;
    if (white) st += `--img:${url};--img-size:${size};--img-pos:${pos};--img-rep:${repeat};--img-op:${1 - it};`;
    else st += `--img:${url};--img-size:${size};--img-pos:${pos};--img-rep:${repeat};--img-op:${1 - it};--img-tint:${css(tint)};`;
    return st;
  }
  imageInfo(content) {
    let i = this.images.get(content);
    if (i) return i.url ? i : null;
    i = { url: null };
    this.images.set(content, i);
    const assets = this.app.assets;
    assets.imageUrl(content).then((url) => {
      const im = new Image();
      im.onload = () => { i.w = im.naturalWidth; i.h = im.naturalHeight; i.url = url; this.dirty = true; for (const n of this.nodes.values()) n.key = ''; };
      im.onerror = () => { i.url = url; this.dirty = true; };
      im.src = url;
    }).catch(() => { /* missing image: draw nothing */ });
    return null;
  }
  scrollStyle(c, n, r) {
    const P = c.props;
    const cs = P.CanvasSize || UDim2.new?.(0, 0, 2, 0) || new UDim2(0, 0, 2, 0);
    const cw = Math.max(r.w, cs.X.Scale * r.w + cs.X.Offset), ch = Math.max(r.h, cs.Y.Scale * r.h + cs.Y.Offset);
    n.canvasRect = { w: cw, h: ch };
    const key = `${cw}x${ch}`;
    if (n.canvasKey !== key) { n.canvasKey = key; n.content.style.width = `${cw}px`; n.content.style.height = `${ch}px`; setIf(c, 'AbsoluteCanvasSize', new Vector2(cw, ch)); setIf(c, 'AbsoluteWindowSize', new Vector2(r.w, r.h)); }
    const dir = enumName(P.ScrollingDirection, 'XY');
    const enabled = P.ScrollingEnabled !== false;
    const cp = P.CanvasPosition || Vector2.zero;
    if (!n.fromScroll) { if (Math.abs(n.el.scrollLeft - cp.X) > 1) n.el.scrollLeft = cp.X; if (Math.abs(n.el.scrollTop - cp.Y) > 1) n.el.scrollTop = cp.Y; }
    const thick = P.ScrollBarThickness ?? 12;
    return `overflow-x:${enabled && dir !== 'Y' ? 'auto' : 'hidden'};overflow-y:${enabled && dir !== 'X' ? 'auto' : 'hidden'};--sb:${thick}px;--sb-color:${rgba(P.ScrollBarImageColor3 || new Color3(0, 0, 0), P.ScrollBarImageTransparency ?? 0)};`;
  }

  // ------------------------------------------------------------ input helpers
  setFocus(tb, on, enter) {
    const inp = this.owner.input;
    if (on) {
      if (inp) inp.focusedTextBox = tb;
      tb.fire('Focused');
      this.world.dm.findFirstChildOfClass('UserInputService')?.fire('TextBoxFocused', tb);
    } else {
      if (inp && inp.focusedTextBox === tb) inp.focusedTextBox = null;
      tb.fire('FocusLost', !!enter, undefined);
      this.world.dm.findFirstChildOfClass('UserInputService')?.fire('TextBoxFocusReleased', tb);
      this.owner.viewport?.canvas.focus({ preventScroll: true });
    }
  }
  focusBox(tb, on, submitted) {
    const n = this.nodes.get(tb);
    if (!n) { this.dirty = true; return; }
    if (on) setTimeout(() => n.el.focus(), 0);
    else { n.enter = !!submitted; n.el.blur(); n.enter = false; }
  }
  objectsAt(x, y) {
    const out = [];
    for (const [inst] of this.nodes) {
      if (!inst.isA('GuiObject')) continue;
      const p = inst.props.AbsolutePosition, s = inst.props.AbsoluteSize;
      if (!p || !s) continue;
      if (x >= p.X && y >= p.Y - (this.edit ? 0 : 0) && x <= p.X + s.X && y <= p.Y + s.Y && this.interactive(inst)) out.push(inst);
    }
    out.sort((a, b) => (b.props.ZIndex ?? 1) - (a.props.ZIndex ?? 1));
    return out;
  }
  hoverAt(e) {
    const r = this.root.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return;
    const now = new Set();
    for (const [inst] of this.nodes) {
      if (!inst.isA('GuiObject')) continue;
      const p = inst.props.AbsolutePosition, s = inst.props.AbsoluteSize;
      if (!p || !s) continue;
      if (x >= p.X && y >= p.Y && x <= p.X + s.X && y <= p.Y + s.Y && this.interactive(inst)) now.add(inst);
    }
    const gy = y - INSET;
    for (const i of this.hovered) if (!now.has(i)) i.fire('MouseLeave', x, gy);
    for (const i of now) { if (!this.hovered.has(i)) i.fire('MouseEnter', x, gy); else i.fire('MouseMoved', x, gy); }
    this.hovered = now;
  }
}

function shadowRing(t, color) {
  const s = [];
  const n = Math.max(8, Math.ceil(t * 6));
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; s.push(`${(Math.cos(a) * t).toFixed(2)}px ${(Math.sin(a) * t).toFixed(2)}px 0 ${color}`); }
  return s.join(',');
}
function gradientCss(g, base, bgT) {
  const seq = g.props.Color;
  const kps = seq && seq.Keypoints ? seq.Keypoints : [{ Time: 0, Value: new Color3(1, 1, 1) }, { Time: 1, Value: new Color3(1, 1, 1) }];
  const rot = (g.props.Rotation || 0) + 90;
  const off = g.props.Offset || Vector2.zero;
  const stops = kps.map((k) => `${rgba(new Color3(base.R * k.Value.R, base.G * k.Value.G, base.B * k.Value.B), bgT)} ${((k.Time + off.X) * 100).toFixed(1)}%`);
  return `linear-gradient(${rot}deg, ${stops.join(', ')})`;
}
function transparencyMask(g) {
  const seq = g.props.Transparency;
  const kps = seq && seq.Keypoints ? seq.Keypoints : [];
  if (!kps.length) return 'none';
  const rot = (g.props.Rotation || 0) + 90;
  return `linear-gradient(${rot}deg, ${kps.map((k) => `rgba(0,0,0,${(1 - k.Value).toFixed(3)}) ${(k.Time * 100).toFixed(1)}%`).join(', ')})`;
}
function toScreen(cam, p, W, H) {
  const v = { x: p.x, y: p.y, z: p.z };
  const e = cam.matrixWorldInverse.elements;
  const x = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
  const y = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
  const z = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
  if (z > -0.05) return null;
  const f = 1 / Math.tan((cam.fov * Math.PI) / 360);
  const ndcX = (f / cam.aspect) * x / -z, ndcY = f * y / -z;
  return { x: (ndcX + 1) / 2 * W, y: (1 - ndcY) / 2 * H, depth: -z };
}
const toLuaText = (s) => toByteStr(s);

export { CFrame, E };
