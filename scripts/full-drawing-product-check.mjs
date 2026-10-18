// Exercise the actual served application in an isolated browser context.
// A rejected import is retained as a gap; it never counts as a drawing pass.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire('E:/CODEX_WORKPLACE/项目/spice-workbench/package.json');
const { chromium } = require('playwright-core');
const browserPath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const folder = resolve('docs/artifacts/drawing-learning-full-20261004', process.argv[2] ?? 'product-import-check-1');
if (existsSync(folder)) throw new Error('Preserve the previous evidence; choose a new check folder.');
mkdirSync(folder, { recursive: true });
const available = [
  ['LT0107', 'C:/Users/23983/AppData/Local/LTspice/examples/Applications/AD8066.asc'],
  ['LT0139', 'C:/Users/23983/AppData/Local/LTspice/examples/Applications/AD8421.asc'],
  ['LT0102', 'C:/Users/23983/AppData/Local/LTspice/examples/Applications/AD8039.asc'],
  ['LT0125', 'C:/Users/23983/AppData/Local/LTspice/examples/Applications/AD8233.asc'],
];
const ids = process.argv.slice(3);
const cases = ids.length ? ids.map(id => {
  const value = available.find(row => row[0] === id);
  if (!value) throw new Error('Unknown reviewed case: ' + id);
  return value;
}) : available.slice(0, 2);
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const results = [];
try {
  for (const [id, source] of cases) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    // Import and canvas state are client-side. Avoid server project/chat writes.
    await context.route('**/api/**', route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:3032/');
    await page.locator('.editor-canvas').waitFor();
    await page.waitForTimeout(800);
    const snapshot = () => page.evaluate(() => {
      const raw = localStorage.getItem('fuxian-project-library-v1');
      const collection = raw && JSON.parse(raw);
      return collection?.entries.find(entry => entry.id === collection.activeId)?.project;
    });
    const before = await snapshot();
    await page.locator('input[type=file][accept=".json,.asc,.cir,.net,.sp,.spice"]').setInputFiles(source);
    await page.waitForFunction(() => !!document.querySelector('.exchange-notice,.import-preview'));
    const notice = await page.locator('.exchange-notice,.import-preview').innerText();
    await page.waitForTimeout(300);
    const after = await snapshot();
    const rejected = await page.locator('.exchange-notice').count() > 0 && notice.includes('导入失败');
    await page.screenshot({ path: join(folder, id + '-actual-product.png'), fullPage: true });
    const bytes = readFileSync(source);
    results.push({ id, source, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      outcome: rejected ? 'unsupported_import_retained_in_denominator' : 'import_preview_needs_drawing_comparison',
      notice, projectUnchanged: JSON.stringify(before) === JSON.stringify(after),
      before, after, pageErrors: errors, screenshot: id + '-actual-product.png',
      productDrawingComparisonComplete: false, simulationExecuted: false });
    await context.close();
  }
} finally { await browser.close(); }
writeFileSync(join(folder, 'evidence.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), url: 'http://127.0.0.1:3032/',
  method: 'Actual production UI file input; isolated headless browser, server API writes blocked. Screenshots are import outcomes, not successful renders of these circuits.',
  results,
}, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ id, outcome, notice, projectUnchanged }) => ({ id, outcome, notice, projectUnchanged }))));
