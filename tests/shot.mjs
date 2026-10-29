// node tests/shot.mjs <url> <out.png> [waitMs] [script.js]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [url, out, wait = '2500', scriptFile] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForTimeout(Number(wait));
if (scriptFile) {
  const fs = await import('node:fs');
  const code = fs.readFileSync(scriptFile, 'utf8');
  const r = await page.evaluate(code);
  if (r !== undefined) console.log('eval:', typeof r === 'string' ? r : JSON.stringify(r));
  await page.waitForTimeout(Number(wait));
}
await page.screenshot({ path: out });
console.log(logs.join('\n'));
await browser.close();
