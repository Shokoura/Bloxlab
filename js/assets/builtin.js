// Stand-ins for rbxasset:// content that ships with the Roblox client (generated at runtime).
const cache = new Map();

async function canvasPng(w, h, draw) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/png' }) : await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

const GENERATORS = {
  // classic smile
  'textures/face.png': () => canvasPng(256, 256, (g) => {
    g.fillStyle = '#000';
    g.beginPath(); g.ellipse(88, 96, 16, 30, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(168, 96, 16, 30, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = 14; g.lineCap = 'round'; g.strokeStyle = '#000';
    g.beginPath(); g.arc(128, 128, 70, Math.PI * 0.2, Math.PI * 0.8); g.stroke();
  }),
  'textures/SpawnLocation.png': () => canvasPng(256, 256, (g) => {
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 18;
    g.beginPath(); g.arc(128, 128, 90, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(128, 60); g.lineTo(128, 196); g.moveTo(60, 128); g.lineTo(196, 128); g.stroke();
  }),
  'textures/blackBkg_square.png': () => canvasPng(4, 4, (g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 4, 4); }),
  'textures/whiteCircle.png': () => canvasPng(128, 128, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill(); }),
  'textures/particles/sparkles_main.dds': () => sparkle(),
  'textures/particles/fire_main.dds': () => softDot('#ffffff'),
  'textures/particles/smoke_main.dds': () => softDot('#ffffff'),
  // default Studio baseplate grid (rbxassetid://6372755229)
  'bloxlab/grid.png': () => canvasPng(256, 256, (g) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#000000'; g.fillRect(0, 0, 256, 6); g.fillRect(0, 0, 6, 256);
  }),
};
function softDot(color) {
  return canvasPng(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}
function sparkle() {
  return canvasPng(64, 64, (g) => {
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(32, 0); g.lineTo(38, 26); g.lineTo(64, 32); g.lineTo(38, 38); g.lineTo(32, 64); g.lineTo(26, 38); g.lineTo(0, 32); g.lineTo(26, 26); g.closePath(); g.fill();
  });
}

/** Well known asset ids that get a generated stand-in when they cannot be downloaded. */
export const FALLBACK_IDS = { 6372755229: 'bloxlab/grid.png', 1080011474: 'bloxlab/grid.png' };

export async function builtinContent(path) {
  const p = path.replace(/^\/+/, '').replace(/\\/g, '/');
  const key = Object.keys(GENERATORS).find((k) => k.toLowerCase() === p.toLowerCase());
  if (!key) return null;
  let v = cache.get(key);
  if (!v) { v = GENERATORS[key]().then((bytes) => ({ bytes, type: 'image/png' })); cache.set(key, v); }
  return v;
}
