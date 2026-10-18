import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire('E:/CODEX_WORKPLACE/项目/spice-workbench/package.json');
const { chromium } = require('playwright-core');
const browserPath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!browserPath) throw new Error('No browser available for structural contact sheets.');
const folder = resolve(process.argv[2]);
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1600 }, deviceScaleFactor: 1 });
  for (const file of readdirSync(folder).filter(f => /^sheet-\d+\.html$/.test(f)).sort()) {
    await page.goto(pathToFileURL(join(folder, file)).href);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(i => i.decode())));
    await page.screenshot({ path: join(folder, file.replace('.html', '.png')), fullPage: true });
  }
  for (const id of process.argv.slice(3)) {
    if (!/^(LT|PS)\d+$/.test(id)) throw new Error('Expected corpus case identifier.');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(pathToFileURL(join(folder, id + '.svg')).href);
    await page.locator('svg').evaluate(svg => {
      svg.setAttribute('width', '1920');
      svg.setAttribute('height', '1080');
      svg.style.width = '1920px';
      svg.style.height = '1080px';
    });
    await page.screenshot({ path: join(folder, id + '-detail.png'), fullPage: false });
  }
} finally { await browser.close(); }
