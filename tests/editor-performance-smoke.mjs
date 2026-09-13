import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// npm run build && node tests/editor-performance-smoke.mjs [300|1500]
// ALGOPRACTICE_PERF_DIST may point to another compiled dist for a before/after run.
// Measurements are observations, not hardware-independent frame-time guarantees.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const count = Number(process.argv[2] || 1500);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 5000);
const directory = await mkdtemp(join(tmpdir(), 'tilian-editor-performance-'));
const launchDirectory = join(directory, 'app'), dataDirectory = join(directory, 'data');
await mkdir(launchDirectory);
const dist = resolve(process.env.ALGOPRACTICE_PERF_DIST || join(root, 'dist'));
await cp(dist, join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
const fixture = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', join(root, 'tests/storage/fixtures/editor-performance-data.ts'), join(dataDirectory, 'practice.sqlite'), String(count)], { cwd: root, encoding: 'utf8' }));
const report = { directory, platform: process.platform, arch: process.arch, fixture, build: JSON.parse(await readFile(join(dist, 'build-info.json'), 'utf8')).sourceHash, errors: [], assertions: [] };
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = name => report.assertions.push(name);
async function until(check) { const end = Date.now() + 15000; while (!await check()) { if (Date.now() > end) throw new Error('Timed out waiting for a saved draft'); await delay(50); } }
async function paste(text) {
  await page.locator('.coding-pane .monaco-editor [role=textbox]').evaluate((element, content) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', content);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor(); await page.evaluate(() => document.fonts.ready);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => {
    window.editorPerf = { frames: [], keys: [], longTasks: [], ipc: [], phase: 'warmup', canvasReadbacks: 0, libraryChanges: 0 };
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) { window.editorPerf.canvasReadbacks++; return read.apply(this, args); };
    window.algo.onLibraryChanged(() => { if (window.editorPerf.phase === 'typing') window.editorPerf.libraryChanges++; });
    let last = performance.now();
    const frame = at => { window.editorPerf.frames.push({ phase: window.editorPerf.phase, ms: at - last }); last = at; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    new PerformanceObserver(list => window.editorPerf.longTasks.push(...list.getEntries().map(entry => ({ phase: window.editorPerf.phase, ms: entry.duration })))).observe({ type: 'longtask', buffered: false });
    document.addEventListener('keydown', () => { const start = performance.now(); requestAnimationFrame(() => window.editorPerf.keys.push({ phase: window.editorPerf.phase, ms: performance.now() - start })); }, true);
    window.editorPerf.ipcTimer = setInterval(async () => { const start = performance.now(); await window.algo.loadDraft('array-total', 'python'); window.editorPerf.ipc.push({ phase: window.editorPerf.phase, ms: performance.now() - start }); }, 1000);
  });
  await nav('练习工作台'); await page.locator('.coding-pane .monaco-editor').waitFor(); await delay(1500);
  const initial = (await api('loadDraft', 'array-total', 'python')).code;
  await page.locator('.coding-pane .monaco-editor').click({ position: { x: 100, y: 40 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.press('End');
  await page.evaluate(() => { window.editorPerf.phase = 'typing'; });
  const typed = Array.from({ length: 6 }, (_, index) => `# variable calculation ${index} = sums plus numbers\n`).join('');
  await page.keyboard.type(typed, { delay: 30 });
  await until(async () => (await api('loadDraft', 'array-total', 'python')).code.includes(typed));
  const afterTyping = (await api('loadDraft', 'array-total', 'python')).code;
  assert.equal(afterTyping.length, initial.length + typed.length);
  pass('All keystrokes are persisted through repeated autosave intervals');
  const originalEditor = await page.locator('.coding-pane .monaco-editor').elementHandle();
  const originalModel = await originalEditor.getAttribute('data-uri');
  assert.ok(originalModel);
  const switches = [];
  await page.evaluate(() => { window.editorPerf.phase = 'switching'; });
  for (let index = 0; index < 10; index++) {
    const start = performance.now(); await nav('题库'); await page.getByRole('table', { name: '题库' }).waitFor();
    await nav('练习工作台'); await page.locator('.coding-pane .monaco-editor').waitFor();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); switches.push(performance.now() - start);
  }
  report.switches = switches;
  assert.equal(await originalEditor.evaluate(element => element === document.querySelector('.coding-pane .monaco-editor')), true, 'Tab navigation must retain the existing editor instance');
  assert.equal(await page.locator('.coding-pane .monaco-editor').getAttribute('data-uri'), originalModel, 'Tab navigation must retain its text model');
  pass('Tab navigation retains the editor and text model');
  Object.assign(report, await page.evaluate(() => { clearInterval(window.editorPerf.ipcTimer); return window.editorPerf; }));
  assert.ok(report.canvasReadbacks <= 1, `Editor theme performed ${report.canvasReadbacks} synchronous pixel readbacks`);
  assert.equal(report.libraryChanges, 0, 'Autosave must not refresh the entire problem library');
  pass('Repeated navigation uses one theme conversion, and autosave sends no library refresh');
  const editor = page.locator('.coding-pane .monaco-editor');
  await editor.click({ position: { x: 100, y: 40 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.press('End');
  const beforeUndo = (await api('loadDraft', 'array-total', 'python')).code, marker = '\n# undo-redo-and-navigation-check\n';
  await paste(marker); await until(async () => (await api('loadDraft', 'array-total', 'python')).code.includes(marker));
  const withMarker = (await api('loadDraft', 'array-total', 'python')).code;
  await nav('题库'); await nav('练习工作台'); await editor.click({ position: { x: 100, y: 40 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await until(async () => (await api('loadDraft', 'array-total', 'python')).code === beforeUndo);
  await nav('题库'); await nav('练习工作台'); await editor.click({ position: { x: 100, y: 40 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'); await until(async () => (await api('loadDraft', 'array-total', 'python')).code === withMarker);
  await paste('# saved-on-navigation\n'); await nav('题库');
  assert.ok((await api('loadDraft', 'array-total', 'python')).code.includes('# saved-on-navigation'));
  pass('Undo and redo survive leaving the workbench; immediate navigation saves the exact draft');
  assert.deepEqual(report.errors, []); report.result = 'passed';
} catch (error) { report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; }
finally {
  if (app) {
    let closeTimer;
    try { await Promise.race([app.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Test instance did not exit within 15 seconds')), 15000); })]); }
    catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; app.process().kill('SIGKILL'); }
    finally { clearTimeout(closeTimer); }
  }
  const summarize = values => { const sorted = values.slice().sort((a, b) => a - b); return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }; };
  report.summary = Object.fromEntries(['keys', 'frames', 'ipc'].map(key => [key, summarize((report[key] || []).filter(value => value.phase === 'typing').map(value => value.ms))]));
  report.summary.switches = summarize(report.switches || []);
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions, summary: report.summary, canvasReadbacks: report.canvasReadbacks, libraryChanges: report.libraryChanges, failure: report.failure, report: join(directory, 'report.json') }, null, 2));
}
