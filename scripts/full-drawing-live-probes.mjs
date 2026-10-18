import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire('E:/CODEX_WORKPLACE/项目/spice-workbench/package.json');
const { chromium } = require('playwright-core');
const folder = resolve('docs/artifacts/drawing-learning-full-20261004', process.argv[2] ?? 'live-probes-1');
if (existsSync(folder)) throw new Error('Use a new folder to preserve all observations.');
mkdirSync(folder, { recursive: true });
const url = 'http://127.0.0.1:3032/';
const observedCheckoutRevision = execFileSync('E:/CODEX_WORKPLACE/项目/伏安软件/.tools/mingit/cmd/git.exe', ['rev-parse', 'HEAD'], { cwd: 'E:/CODEX_WORKPLACE/项目/spice-workbench', encoding: 'utf8' }).trim();
const browserPath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.route('**/api/**', route => route.abort());
let page = await context.newPage();
const results = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const settle = async () => {
  await page.waitForTimeout(280);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const state = () => page.evaluate(() => {
  const raw = localStorage.getItem('fuxian-project-library-v1'), library = raw && JSON.parse(raw);
  const project = library?.entries.find(entry => entry.id === library.activeId)?.project;
  const geometry = selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const matrix = node.getScreenCTM();
    return { transform: node.getAttribute('transform'), screen: { x: matrix.e, y: matrix.f }, scale: matrix.a };
  };
  return { project, zoomText: document.querySelector('.zoom-controls span').textContent,
    marker: geometry('.measurement-marker'), badge: geometry('.measurement-marker .probe-badge'),
    targetPreview: !!document.querySelector('.probe-target-preview'),
    markerPointerEvents: document.querySelector('.measurement-marker') ? getComputedStyle(document.querySelector('.measurement-marker')).pointerEvents : null };
});
const screen = point => page.evaluate(({ x, y }) => {
  const p = new DOMPoint(x, y).matrixTransform(document.querySelector('.editor-canvas').getScreenCTM());
  return { x: p.x, y: p.y };
}, point);
const integerPoint = point => ({ x: Math.round(point.x), y: Math.round(point.y) });
const nearPoint = (actual, expected, label) => {
  assert.ok(Math.abs(actual.x - expected.x) < .15 && Math.abs(actual.y - expected.y) < .15,
    `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};
const probes = value => value.project.probes;
let originalDrawing, beforeProject;
const screenshot = async name => {
  const file = name + '.png';
  await page.screenshot({ path: join(folder, file), fullPage: true });
  return { screenshot: file, screenshotSha256: createHash('sha256').update(readFileSync(join(folder, file))).digest('hex') };
};
async function record(id, category, name, run) {
  const before = await state();
  try {
    const checks = await run(); const after = await state();
    assert.deepEqual(after.project.drawing, originalDrawing, 'Probe interactions must preserve every electrical object and wire.');
    assert.deepEqual(pageErrors, []);
    results.push({ id, category, name, passed: true, before, after, checks, ...await screenshot(id), drawingUnchanged: true });
  } catch (error) {
    results.push({ id, category, name, passed: false, before, after: await state(), error: error.message, ...await screenshot(id + '-failed') });
    throw error;
  }
}
const undo = async () => { await page.getByRole('button', { name: '撤销', exact: true }).click(); await settle(); };
const redo = async () => { await page.getByRole('button', { name: '重做', exact: true }).click(); await settle(); };
const selectMode = async () => { await page.getByRole('button', { name: '选择 / 移动 (V)', exact: true }).click(); };
const fit = async () => { await page.getByRole('button', { name: '适应整个原理图', exact: true }).click(); await settle(); };
async function badgeStart() {
  return integerPoint(await page.locator('.measurement-marker .probe-badge').evaluate(node => {
    const p = new DOMPoint(18, 18).matrixTransform(node.getScreenCTM());
    return { x: p.x, y: p.y };
  }));
}
async function dragBadge(id, zoom) {
  if (zoom) {
    await fit();
    const box = await page.locator('.editor-canvas').boundingBox();
    const cursor = integerPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const scale = await page.locator('.editor-canvas').evaluate(svg => svg.getScreenCTM().a);
    await page.mouse.move(cursor.x, cursor.y); await page.mouse.wheel(0, -400 * Math.log(zoom / scale)); await settle();
  }
  const before = await state(), start = await badgeStart(), frames = [];
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (const delta of [{ x: 11, y: -7 }, { x: 23, y: -13 }, { x: 37, y: 17 }]) {
    await page.mouse.move(start.x + delta.x, start.y + delta.y); await settle();
    const live = await state();
    nearPoint(live.badge.screen, { x: before.badge.screen.x + delta.x, y: before.badge.screen.y + delta.y }, 'Live badge follows native pointer');
    assert.deepEqual(probes(live), probes(before), 'Pointer movement must not persist the preview.');
    assert.deepEqual(live.project.drawing, originalDrawing);
    frames.push({ delta, live, ...await screenshot(id + '-frame-' + frames.length) });
  }
  await page.mouse.up(); await settle(); const after = await state();
  assert.notDeepEqual(probes(after), probes(before), 'Release saves the changed badge position.');
  nearPoint(after.badge.screen, frames.at(-1).live.badge.screen, 'Release retains the painted badge position');
  return { zoomText: after.zoomText, frames, nativePointerStart: start, savedBefore: probes(before), savedAfter: probes(after) };
}
async function tipMove(delta, release = true) {
  const before = await state(), start = integerPoint({ x: before.marker.screen.x + 3, y: before.marker.screen.y - 2 });
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y); await settle();
  const live = await state();
  nearPoint(live.marker.screen, { x: before.marker.screen.x + delta.x, y: before.marker.screen.y + delta.y }, 'Live tip follows native pointer, including grab offset');
  assert.deepEqual(probes(live), probes(before), 'Live tip preview does not change saved attachment.');
  if (release) { await page.mouse.up(); await settle(); }
  return { before, live, start, delta };
}
try {
  await page.goto(url); await page.locator('.editor-canvas').waitFor(); await settle();
  beforeProject = (await state()).project; originalDrawing = beforeProject.drawing;
  assert.equal(originalDrawing.devices.length, 5, 'Use the actual default RC drawing, not an injected fixture.');
  await page.getByRole('button', { name: '测量探针 (P)', exact: true }).click();
  const point = await screen({ x: 640, y: 200 });
  await page.mouse.click(point.x, point.y); await settle();
  assert.equal(await page.locator('.measurement-marker').count(), 1);
  await selectMode();
  const originalProbe = probes(await state());
  let firstMoved;
  await record('P01', 'probe', '适应图面比例下标牌连续实时跟随，松手才保存', async () => {
    const checks = await dragBadge('P01'); firstMoved = probes(await state()); return checks;
  });
  await record('R01', 'restoration', '一次撤销恢复整次标牌拖动', async () => {
    await undo(); assert.deepEqual(probes(await state()), originalProbe); return { restored: originalProbe };
  });
  await record('R02', 'restoration', '一次重做恢复标牌最终位置', async () => {
    await redo(); assert.deepEqual(probes(await state()), firstMoved); return { restored: firstMoved };
  });
  await record('R03', 'restoration', '真实页面重载恢复已保存标牌', async () => {
    await page.reload(); await page.locator('.measurement-marker').waitFor(); await settle();
    assert.deepEqual(probes(await state()), firstMoved); return { restored: firstMoved };
  });
  await selectMode();
  await record('P02', 'probe', '约50%缩放下标牌实时跟随并保存', () => dragBadge('P02', .5));
  await record('P03', 'probe', '约200%缩放下标牌实时跟随并保存', () => dragBadge('P03', 2));
  await fit(); await selectMode();
  await record('P04', 'probe', '探针端点经过空白区实时跟随且松手保留原绑定', async () => {
    const checks = await tipMove({ x: 29, y: 89 }, false);
    assert.equal(checks.live.markerPointerEvents, 'none');
    const frame = await screenshot('P04-live');
    await page.mouse.up(); await settle();
    assert.deepEqual(probes(await state()), probes(checks.before));
    nearPoint((await state()).marker.screen, checks.before.marker.screen, 'Invalid blank drop restores tip');
    return { ...checks, ...frame };
  });
  let priorAttachment, movedAttachment;
  await record('P05', 'probe', '探针端点实时移动到另一导线，松手后绑定该处', async () => {
    const before = await state(); priorAttachment = probes(before);
    const start = integerPoint(before.marker.screen), target = integerPoint(await screen({ x: 200, y: 250 }));
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(target.x, target.y); await settle();
    const live = await state();
    nearPoint(live.marker.screen, { x: before.marker.screen.x + target.x - start.x, y: before.marker.screen.y + target.y - start.y }, 'Tip at target');
    assert.deepEqual(probes(live), priorAttachment); assert.equal(live.targetPreview, true);
    const frame = await screenshot('P05-live');
    await page.mouse.up(); await settle(); const after = await state(); movedAttachment = probes(after);
    assert.notDeepEqual(movedAttachment, priorAttachment);
    assert.equal(movedAttachment[0].positiveLayout.anchor.wireId, 'W1');
    // Drop projects the moving tip onto the real conductor, preserving the grab
    // offset. Its x may differ from the rounded native pointer by a fraction of
    // a screen pixel; compare with the conductor and live tip, not cursor center.
    const conductor = await screen({ x: 200, y: 250 });
    nearPoint(after.marker.screen, { x: conductor.x, y: live.marker.screen.y }, 'Saved attachment uses target conductor');
    return { start, target, live, ...frame, saved: movedAttachment };
  });
  await record('R04', 'restoration', '一次撤销恢复探针原导线绑定', async () => {
    await undo(); assert.deepEqual(probes(await state()), priorAttachment); return { restored: priorAttachment };
  });
  await record('R05', 'restoration', '一次重做恢复探针新导线绑定', async () => {
    await redo(); assert.deepEqual(probes(await state()), movedAttachment); return { restored: movedAttachment };
  });
  await record('R06', 'restoration', '真实页面重载同时恢复绑定和标牌位置', async () => {
    await page.reload(); await page.locator('.measurement-marker').waitFor(); await settle();
    assert.deepEqual(probes(await state()), movedAttachment); return { restored: movedAttachment };
  });
  await selectMode();
  await record('P06', 'probe', '端点拖到不可测空白处松手后复原', async () => {
    const checks = await tipMove({ x: 51, y: 43 }); const after = await state();
    assert.deepEqual(probes(after), probes(checks.before)); nearPoint(after.marker.screen, checks.before.marker.screen, 'Invalid drop restores saved tip');
    return checks;
  });
  await record('P07', 'probe', '端点拖动中Esc取消并复原', async () => {
    const checks = await tipMove({ x: 33, y: 73 }, false);
    const frame = await screenshot('P07-live');
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    const after = await state(); assert.deepEqual(probes(after), probes(checks.before)); nearPoint(after.marker.screen, checks.before.marker.screen, 'Escape restores tip');
    return { ...checks, ...frame };
  });
  await record('P08', 'probe', '标牌拖动中Esc取消并恢复原位置', async () => {
    const before = await state(), start = await badgeStart();
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 37, start.y - 19); await settle();
    const live = await state(); nearPoint(live.badge.screen, { x: before.badge.screen.x + 37, y: before.badge.screen.y - 19 }, 'Badge before Escape');
    assert.deepEqual(probes(live), probes(before)); const frame = await screenshot('P08-live');
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    const after = await state(); assert.deepEqual(probes(after), probes(before)); nearPoint(after.badge.screen, before.badge.screen, 'Escape restores badge');
    return { start, live, ...frame };
  });
  await record('R07', 'restoration', '同一隔离会话的新页面恢复完整探针状态', async () => {
    const saved = probes(await state()), previousPage = page;
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url); await page.locator('.measurement-marker').waitFor(); await settle();
    assert.deepEqual(probes(await state()), saved); await previousPage.close(); return { restored: saved };
  });
  await selectMode();
  await record('R08', 'restoration', '删除探针后一次撤销恢复绑定和标牌', async () => {
    const saved = probes(await state()), start = await badgeStart();
    await page.mouse.click(start.x, start.y); await page.keyboard.press('Delete'); await settle();
    assert.equal(await page.locator('.measurement-marker').count(), 0);
    const removed = await state(), frame = await screenshot('R08-deleted');
    await undo(); assert.deepEqual(probes(await state()), saved); assert.equal(await page.locator('.measurement-marker').count(), 1);
    return { deleted: removed, ...frame, restored: saved };
  });
} finally {
  writeFileSync(join(folder, 'evidence.json'), JSON.stringify({ checkedAt: new Date().toISOString(), url, observedCheckoutRevision,
    pinnedBuild: false, browserPath, viewport: { width: 1600, height: 1000 }, beforeProject, pageErrors,
    method: 'Actual served UI, native mouse and keyboard, actual SVG screen matrices and saved local storage. Fresh isolated browser context; all server API writes blocked. No fake transforms, injected fixture or app test API.',
    scope: 'Single voltage probe on actual default RC drawing. Eight probe scenarios and eight restoration scenarios. No differential/current-probe coverage, large-circuit speed claim, simulation accuracy validation or source drawing comparison. The app may auto-run its default RC analysis; this script never clicks Run and does not validate that result.',
    results, completed: results.filter(value => value.passed).length }, null, 2) + '\n');
  await context.close(); await browser.close();
}
console.log(JSON.stringify(results.map(({ id, name, passed }) => ({ id, name, passed }))));
