// node tests/formats.test.mjs [path-to-rbx-test-files]
// Compares binary vs XML readings of the rbx-test-files corpus and round-trips both writers.
import fs from 'node:fs';
import path from 'node:path';
import { readBinary, writeBinary } from '../js/formats/binary.js';
import { readXml, writeXml } from '../js/formats/xml.js';

const dir = process.argv[2] || '/tmp/rbxtest';
let fails = 0, checks = 0;
const close = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b || Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
function eqVal(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return close(a, b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.className && b.className) return a.className === b.className; // refs
    if (a.constructor !== b.constructor) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!eqVal(a[k], b[k])) return false;
    return true;
  }
  return false;
}
const BINARY_ONLY_DIFFS = new Set(['UniqueId', 'HistoryId', 'SourceAssetId', 'Capabilities', 'DefinesCapabilities', 'ScriptGuid']);
function compare(a, b, where) {
  checks++;
  if (a.className !== b.className) { fails++; console.log(`  ${where}: class ${a.className} vs ${b.className}`); return; }
  for (const [k, ea] of a.props) {
    const eb = b.props.get(k);
    if (!eb) { if (!BINARY_ONLY_DIFFS.has(k)) console.log(`  ${where}.${a.className}.${k}: missing in second (${ea.t})`); continue; }
    if (!eqVal(ea.v, eb.v) && !BINARY_ONLY_DIFFS.has(k)) {
      fails++;
      console.log(`  ${where}.${a.className}.${k}: ${ea.t} ${String(ea.v)} != ${eb.t} ${String(eb.v)}`);
    }
  }
  if (a.children.length !== b.children.length) { fails++; console.log(`  ${where}: ${a.children.length} vs ${b.children.length} children`); return; }
  a.children.forEach((c, i) => compare(c, b.children[i], where + '/' + c.className));
}
const cases = [];
for (const group of ['models', 'places', 'edge-cases']) {
  const g = path.join(dir, group);
  if (!fs.existsSync(g)) continue;
  for (const name of fs.readdirSync(g)) cases.push(path.join(g, name));
}
for (const c of cases) {
  const bin = ['binary.rbxm', 'binary.rbxl'].map((f) => path.join(c, f)).find(fs.existsSync);
  const xml = ['xml.rbxmx', 'xml.rbxlx'].map((f) => path.join(c, f)).find(fs.existsSync);
  const label = path.relative(dir, c);
  try {
    let b, x;
    if (bin) { b = readBinary(new Uint8Array(fs.readFileSync(bin))); if (b.warnings.length) console.log(`${label} binary warnings:`, b.warnings); }
    if (xml) { x = readXml(fs.readFileSync(xml, 'utf8')); if (x.warnings.length) console.log(`${label} xml warnings:`, x.warnings); }
    if (b && x) {
      if (b.roots.length !== x.roots.length) { fails++; console.log(`${label}: roots ${b.roots.length} vs ${x.roots.length}`); }
      else b.roots.forEach((r, i) => compare(r, x.roots[i], label));
    }
    for (const src of [b, x].filter(Boolean)) {
      const rb = readBinary(writeBinary(src.roots));
      src.roots.forEach((r, i) => compare(r, rb.roots[i], label + '[bin-rt]'));
      const rx = readXml(writeXml(src.roots));
      src.roots.forEach((r, i) => compare(r, rx.roots[i], label + '[xml-rt]'));
    }
  } catch (err) { fails++; console.log(`${label}: ERROR ${err.stack}`); }
}
console.log(`${cases.length} cases, ${checks} instance comparisons, ${fails} failures`);
process.exit(fails ? 1 : 0);
