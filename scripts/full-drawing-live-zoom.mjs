// Actual served workbench navigation, with isolated local storage and no server writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire('E:/CODEX_WORKPLACE/项目/spice-workbench/package.json');
const { chromium } = require('playwright-core');
const folder = resolve('docs/artifacts/drawing-learning-full-20261004', process.argv[2] ?? 'live-zoom-1');
if (existsSync(folder)) throw new Error('Choose a new evidence folder; preserve prior observations.');
mkdirSync(folder, { recursive: true });
const browserPath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const url = 'http://127.0.0.1:3032/';
const main = 'E:/CODEX_WORKPLACE/项目/spice-workbench';
const observedCheckoutRevision = execFileSync('E:/CODEX_WORKPLACE/项目/伏安软件/.tools/mingit/cmd/git.exe', ['rev-parse', 'HEAD'], { cwd: main, encoding: 'utf8' }).trim();
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.route('**/api/**', route => route.abort());
const page = await context.newPage();
const pageErrors = [], results = [];
page.on('pageerror', error => pageErrors.push(error.message));
const settle = async () => {
  await page.waitForTimeout(280);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const state = () => page.evaluate(() => {
  const svg = document.querySelector('.editor-canvas'), matrix = svg.getScreenCTM(), view = svg.viewBox.baseVal;
  const raw = localStorage.getItem('fuxian-project-library-v1');
  const library = raw && JSON.parse(raw);
  return {
    zoomText: document.querySelector('.zoom-controls span').textContent,
    matrix: { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f },
    viewBox: { x: view.x, y: view.y, width: view.width, height: view.height },
    minusDisabled: document.querySelector('button[aria-label="缩小画布"]').disabled,
    plusDisabled: document.querySelector('button[aria-label="放大画布"]').disabled,
    project: library?.entries.find(entry => entry.id === library.activeId)?.project,
  };
});
const world = point => page.evaluate(({ x, y }) => {
  const value = new DOMPoint(x, y).matrixTransform(document.querySelector('.editor-canvas').getScreenCTM().inverse());
  return { x: value.x, y: value.y };
}, point);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .02, `${message}: ${actual} != ${expected}`);
let beforeProject;
try {
  await page.goto(url);
  await page.locator('.editor-canvas').waitFor();
  await settle();
  beforeProject = (await state()).project;
  assert.ok(beforeProject?.drawing, 'The real app must have a saved initial drawing.');
  async function record(id, name, run) {
    const before = await state();
    try {
      const checks = await run();
      const after = await state();
      assert.deepEqual(after.project, beforeProject, 'Navigation must preserve the complete project.');
      assert.deepEqual(pageErrors, []);
      const screenshot = id + '.png';
      await page.screenshot({ path: join(folder, screenshot), fullPage: true });
      results.push({ id, category: 'zoom', name, passed: true, before, after, checks,
        screenshot, screenshotSha256: createHash('sha256').update(readFileSync(join(folder, screenshot))).digest('hex'),
        projectUnchanged: true });
    } catch (error) {
      const screenshot = id + '-failed.png';
      await page.screenshot({ path: join(folder, screenshot), fullPage: true });
      results.push({ id, category: 'zoom', name, passed: false, before, after: await state(), error: error.message,
        screenshot, screenshotSha256: createHash('sha256').update(readFileSync(join(folder, screenshot))).digest('hex') });
      throw error;
    }
  }
  const minus = page.getByRole('button', { name: '缩小画布', exact: true });
  const plus = page.getByRole('button', { name: '放大画布', exact: true });
  const fit = page.getByRole('button', { name: '适应整个原理图', exact: true });
  const reset = async () => { await fit.click(); await settle(); };
  await record('Z01', '工具栏缩小到5%并核对按钮状态', async () => {
    for (let i = 0; i < 45 && !(await minus.isDisabled()); i++) await minus.click();
    await settle();
    const value = await state();
    assert.equal(value.zoomText, '5%'); assert.equal(value.minusDisabled, true); assert.equal(value.plusDisabled, false);
    return { minimum: value.zoomText, disabledAtMinimum: true };
  });
  await record('Z02', '工具栏从5%立即反向放大', async () => {
    await plus.click(); await settle(); const value = await state();
    assert.equal(value.zoomText, '6%'); assert.equal(value.minusDisabled, false);
    return { reversedZoom: value.zoomText };
  });
  await record('Z03', '工具栏放大到2000%并核对按钮状态', async () => {
    for (let i = 0; i < 60 && !(await plus.isDisabled()); i++) await plus.click();
    await settle(); const value = await state();
    assert.equal(value.zoomText, '2000%'); assert.equal(value.plusDisabled, true); assert.equal(value.minusDisabled, false);
    return { maximum: value.zoomText, disabledAtMaximum: true };
  });
  await record('Z04', '工具栏从2000%立即反向缩小', async () => {
    await minus.click(); await settle(); const value = await state();
    assert.equal(value.zoomText, '1600%'); assert.equal(value.plusDisabled, false);
    return { reversedZoom: value.zoomText };
  });
  await reset();
  const box = await page.locator('.editor-canvas').boundingBox();
  // Native wheel coordinates are integer CSS pixels in Chromium. Measure the
  // same point delivered by the input protocol, especially at the 5% limit.
  const cursor = { x: Math.round(box.x + box.width * .43), y: Math.round(box.y + box.height * .38) };
  await page.mouse.move(cursor.x, cursor.y);
  await record('Z05', '原生滚轮缩小到5%且保持指针下的图面位置', async () => {
    const anchor = await world(cursor);
    for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 160);
    await settle(); const value = await state(), afterAnchor = await world(cursor);
    assert.equal(value.zoomText, '5%'); near(afterAnchor.x, anchor.x, 'anchor x'); near(afterAnchor.y, anchor.y, 'anchor y');
    return { cursor, anchor, afterAnchor, zoom: value.zoomText };
  });
  await record('Z06', '原生滚轮从5%立即反向且保持指针位置', async () => {
    const before = await state(), anchor = await world(cursor);
    await page.mouse.wheel(0, -80); await settle(); const value = await state(), afterAnchor = await world(cursor);
    assert.ok(value.matrix.a > before.matrix.a); assert.notEqual(value.zoomText, '5%');
    near(afterAnchor.x, anchor.x, 'anchor x'); near(afterAnchor.y, anchor.y, 'anchor y');
    return { cursor, anchor, afterAnchor, reversedZoom: value.zoomText };
  });
  await reset(); await page.mouse.move(cursor.x, cursor.y);
  await record('Z07', '原生滚轮放大到2000%且保持指针下的图面位置', async () => {
    const anchor = await world(cursor);
    for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -160);
    await settle(); const value = await state(), afterAnchor = await world(cursor);
    assert.equal(value.zoomText, '2000%'); near(afterAnchor.x, anchor.x, 'anchor x'); near(afterAnchor.y, anchor.y, 'anchor y');
    return { cursor, anchor, afterAnchor, zoom: value.zoomText };
  });
  await record('Z08', '原生滚轮从2000%立即反向且保持指针位置', async () => {
    const before = await state(), anchor = await world(cursor);
    await page.mouse.wheel(0, 80); await settle(); const value = await state(), afterAnchor = await world(cursor);
    assert.ok(value.matrix.a < before.matrix.a); assert.notEqual(value.zoomText, '2000%');
    near(afterAnchor.x, anchor.x, 'anchor x'); near(afterAnchor.y, anchor.y, 'anchor y');
    return { cursor, anchor, afterAnchor, reversedZoom: value.zoomText };
  });
} finally {
  writeFileSync(join(folder, 'evidence.json'), JSON.stringify({ checkedAt: new Date().toISOString(), url,
    observedCheckoutRevision, pinnedBuild: false, browserPath, viewport: { width: 1600, height: 1000 },
    method: 'Real served application, native browser mouse input and actual toolbar; fresh isolated browser context, server API writes blocked. No app/test API or fake SVG matrix.',
    scope: 'Eight zoom scenarios on the actual default RC circuit. Does not establish large-circuit speed, middle-button quick zoom, probe movement, saved restoration or source drawing comparison.',
    beforeProject, pageErrors, results, completed: results.filter(value => value.passed).length }, null, 2) + '\n');
  await context.close(); await browser.close();
}
console.log(JSON.stringify(results.map(({ id, name, passed, after }) => ({ id, name, passed, zoom: after.zoomText }))));
