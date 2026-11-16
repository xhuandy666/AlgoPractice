import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';

// Real packaged Electron/IPC/SQLite and actual streamed files. Only the future GitHub response and OS installer launch
// are doubles. Never installs a fabricated package, writes a user profile, changes an installed app, or contacts GitHub.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const packaged = process.env.ALGOPRACTICE_PACKAGED_APP;
const directory = await mkdtemp(join(os.tmpdir(), '题炼-应用更新验收-')), dataDirectory = join(directory, 'data');
const launchDirectory = join(directory, 'app'), receipt = join(directory, 'install-receipt.json');
await mkdir(dataDirectory);
if (!packaged) { await mkdir(launchDirectory); await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true }); await cp(join(root, 'package.json'), join(launchDirectory, 'package.json')); }
const payload = Buffer.from('authored future installer; not executable\n'.repeat(5000));
const platform = process.platform, arch = process.arch, version = '99.0.0';
const name = `AlgoPractice-${version}-${platform === 'darwin' ? 'mac' : 'win'}-${arch}.${platform === 'darwin' ? 'dmg' : 'exe'}`;
const assetUrl = `https://github.com/xhuandy666/AlgoPractice/releases/download/v${version}/${name}`;
const release = { tag_name: `v${version}`, html_url: `https://github.com/xhuandy666/AlgoPractice/releases/tag/v${version}`,
  draft: false, prerelease: false, published_at: '2026-11-17T00:00:00Z', assets: [{ name, size: payload.length,
    browser_download_url: assetUrl, digest: 'sha256:' + createHash('sha256').update(payload).digest('hex') }] };
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime')) };
delete env.ELECTRON_RUN_AS_NODE; delete env.ALGOPRACTICE_DISABLE_AUTO_UPDATE;
const report = { platform, arch, executable: packaged || require('electron'), dataDirectory, syntheticFutureRelease: true,
  assertions: [], rendererErrors: [], limitations: ['Future release bytes and OS installer launch are synthetic; no native Windows/signed-Mac replacement is performed.'] };
let app, page;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const pass = name => { report.assertions.push(name); console.log('PASS', name); };
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  app = await electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : [launchDirectory], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await app.evaluate(async ({ net, shell }, fixture) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite'), fs = process.getBuiltinModule('node:fs');
    const original = net.fetch.bind(net), bytes = Buffer.from(fixture.payload, 'base64');
    globalThis.updateSmoke = { requests: [], corrupt: true, failOpen: true, opened: 0 };
    net.fetch = async (input, options) => {
      const url = String(input); if (!/^https?:/.test(url)) return original(input, options);
      globalThis.updateSmoke.requests.push(url);
      if (url === 'https://api.github.com/repos/xhuandy666/AlgoPractice/releases/latest') return new Response(JSON.stringify(fixture.release));
      if (url !== fixture.assetUrl) throw new Error('Unexpected external request blocked');
      const body = Buffer.from(bytes); if (globalThis.updateSmoke.corrupt) body[70_000] ^= 0xff;
      return new Response(body, { headers: { 'content-length': String(body.length) } });
    };
    // The production update transport uses ClientRequest: Electron net.fetch rejects manual redirects.
    const { EventEmitter } = process.getBuiltinModule('node:events'), { Readable } = process.getBuiltinModule('node:stream');
    net.request = options => {
      const request = new EventEmitter(), controller = new AbortController(), headers = { ...options.headers };
      let aborted = false, body;
      request.setHeader = (name, value) => { headers[name] = value; };
      request.end = () => {
        void net.fetch(options.url, { headers, signal: controller.signal }).then(response => {
          if (aborted) return;
          body = Readable.fromWeb(response.body);
          body.statusCode = response.status; body.statusMessage = response.statusText;
          body.headers = Object.fromEntries(response.headers);
          request.emit('response', body);
        }).catch(error => { if (!aborted) request.emit('error', error); });
      };
      request.abort = () => { if (aborted) return; aborted = true; controller.abort(); body?.destroy(); request.emit('abort'); };
      return request;
    };
    shell.openPath = async path => {
      globalThis.updateSmoke.opened++;
      if (globalThis.updateSmoke.failOpen) return 'Synthetic installer open failure';
      const db = new DatabaseSync(fixture.database, { readOnly: true });
      try {
        const draft = db.prepare("SELECT code FROM drafts WHERE problem_id='array-total' AND language='python' AND scope_id='practice'").get();
        fs.writeFileSync(fixture.receipt, JSON.stringify({ path, codeAtOpen: draft?.code, requests: globalThis.updateSmoke.requests }), { mode: 0o600 });
      } finally { db.close(); }
      return '';
    };
  }, { payload: payload.toString('base64'), release, assetUrl, database: join(dataDirectory, 'practice.sqlite'), receipt });
  const initial = await api('updateState'); report.mode = initial.mode;
  if (initial.mode === 'development') {
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(await app.evaluate(() => globalThis.updateSmoke.requests), []);
    assert.equal((await api('checkForAppUpdate')).phase, 'available');
    assert.equal((await api('downloadAppUpdate')).phase, 'available');
    await assert.rejects(api('installAppUpdate'), /先完成/);
    pass('Source runs never auto-check/download/install; explicit version discovery remains available');
  } else if (initial.mode === 'native') {
    await api('setAutomaticUpdates', false);
    pass('Native installation is detected and automatic work can be disabled; native replacement is covered separately by engine tests');
  } else {
    assert.equal(initial.mode, 'installer'); assert.equal(initial.automatic, true);
    await until(async () => (await api('updateState')).phase === 'error', 'scheduled automatic update and corrupt download rejection', 60000);
    assert.deepEqual(await readdir(join(dataDirectory, 'updates')), []);
    assert.equal(await app.evaluate(() => globalThis.updateSmoke.opened), 0);
    pass('Packaged startup automatically discovers the future release and rejects a damaged download without publishing it');
    await app.evaluate(() => { globalThis.updateSmoke.corrupt = false; });
    assert.equal((await api('downloadAppUpdate')).phase, 'downloaded');
    await page.getByRole('region', { name: '新版本已准备好' }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.updateSmoke.opened), 0);
    pass('Retry streams and verifies the full installer; readiness is a non-modal notice and never auto-installs');
    await api('startPractice', 'array-total', 'python');
    await page.evaluate(() => {
      globalThis.updateRunEvents = []; globalThis.updateRunDone = false;
      const remove = window.algo.onRunEvent(event => globalThis.updateRunEvents.push(event));
      const code = 'class Solution:\n    def arrayTotal(self, nums):\n        import time\n        time.sleep(1)\n        return sum(nums)\n';
      void window.algo.run('array-total', 'python', code).then(run => { globalThis.updateRunResult = run; })
        .catch(error => { globalThis.updateRunError = String(error); }).finally(() => { globalThis.updateRunDone = true; remove(); });
    });
    await until(() => page.evaluate(() => globalThis.updateRunEvents.some(event => event.phase === 'run')), 'real Python user program starts');
    await assert.rejects(api('installAppUpdate'), /代码运行/);
    await until(() => page.evaluate(() => globalThis.updateRunDone), 'the Python run finishes without updater interruption');
    assert.equal(await page.evaluate(() => globalThis.updateRunResult?.result.status), 'passed');
    pass('An active real Python run blocks installation and finishes normally');
    await page.evaluate(() => { globalThis.rejectUpdateFlush = window.algo.onMaintenance(id => window.algo.maintenanceReady(id, 'authored failure')); });
    await assert.rejects(api('installAppUpdate'), /更新暂未安装/);
    await page.evaluate(() => globalThis.rejectUpdateFlush());
    assert.equal((await api('updateState')).phase, 'downloaded'); assert.equal(await app.evaluate(() => globalThis.updateSmoke.opened), 0);
    pass('A failed draft flush cancels installation and keeps the app and downloaded update usable');
    await assert.rejects(api('installAppUpdate'), /更新暂未安装/);
    assert.equal((await api('updateState')).phase, 'downloaded');
    pass('OS installer launch failure releases the maintenance gate and supports a later retry');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '题库', exact: true }).click();
    await page.getByRole('table', { name: '题库' }).getByRole('button', { name: '数组求和', exact: true }).click();
    await page.locator('.coding-pane .monaco-editor').waitFor();
    await app.evaluate(() => { globalThis.updateSmoke.failOpen = false; });
    const code = 'class Solution:\n    def arrayTotal(self, nums):\n        return sum(nums) # saved by update flush\n';
    const editor = page.locator('.coding-pane .monaco-editor');
    await editor.locator('.view-lines').click({ position: { x: 60, y: 15 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await editor.locator('[role=textbox]').evaluate((element, text) => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, code);
    const installing = api('installAppUpdate').catch(() => {}), child = app.process();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'app quits only after a successful installer launch', 30000);
    await installing;
    const saved = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(saved.codeAtOpen, code); assert.equal(saved.path, join(dataDirectory, 'updates', name));
    assert.ok((await readFile(saved.path)).equals(payload)); report.installReceipt = saved;
    app = null;
    pass('A real editor draft is committed to SQLite before the checked installer is opened and the app exits');
  }
  assert.deepEqual(report.rendererErrors, []); report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  if (app) {
    const timer = setTimeout(() => app?.process().kill('SIGKILL'), 15000);
    await app.close().catch(error => { report.cleanupError = String(error); process.exitCode = 1; }); clearTimeout(timer);
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log('Update report:', join(directory, 'report.json'));
}
