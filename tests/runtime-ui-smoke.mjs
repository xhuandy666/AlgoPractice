import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// Isolated renderer checks only: no main-process IPC, downloads, or user-code execution.
// Use ALGOPRACTICE_TEST_BROWSER=chrome to reuse an already installed Chrome.
const root = resolve(import.meta.dirname, '..');
const compiled = await build({
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'runtime-ui-fixture.tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { EnvironmentPage } from './src/renderer/EnvironmentPage';
    import { RuntimePreparation } from './src/renderer/RuntimePreparation';
    import { AcmInputPanel } from './src/renderer/AcmInputPanel';
    import { SubmissionHistory } from './src/renderer/SubmissionHistory';
    import './tokens.css';
    import './src/renderer/styles.css';
    const artifact = { version: 'fixture-version', source: 'Official fixture source', downloadBytes: 1024*1024*25, expandedBytes: null, peakBytes: null };
    const missing = { status: 'missing', source: null, path: null, version: null, message: '尚未找到兼容环境，代码已保留。', managedInstalled: true, installedBytes: 2048, artifact };
    const ready = { ...missing, status: 'ready', source: 'discovered', version: '25.0.4', path: '/a/long/local/runtime/path/java', message: 'Java 已就绪', managedInstalled: false };
    const snapshot = { platform:'darwin', arch:'arm64', electron:'fixture', node:'fixture', sqlite:'fixture', python:null, java:'25.0.4', dataDirectory:'/tmp/runtime-ui-fixture', runtimeNotices:[], installation:null, installations:{}, runtimeStates:{ python:missing, java:ready }, autoInstallRuntimes:false, notificationSupported:true, reminder:null };
    let progressListener = () => {}; const pending = {}; const calls = [];
    const api = {
      environment: async () => structuredClone(snapshot),
      onRuntimeProgress: listener => { progressListener = listener; return () => { progressListener = () => {}; }; },
      installRuntime: async language => {
        calls.push(['install',language]);
        const progress = { language, phase:'download', receivedBytes:25, totalBytes:100 };
        snapshot.installations[language] = { progress }; progressListener(progress);
        return new Promise((resolve,reject) => { pending[language] = {resolve,reject}; });
      },
      cancelInstall: async language => { calls.push(['cancel',language]); delete snapshot.installations[language]; pending[language]?.resolve(); delete pending[language]; },
      runtimePreflight: async language => { calls.push(['preflight',language]); return snapshot.runtimeStates[language]; },
      setRuntime: async language => { calls.push(['select',language]); },
      resetRuntime: async language => { calls.push(['reset',language]); },
      uninstallRuntime: async language => { calls.push(['uninstall',language]); },
      setAutoInstallRuntimes: async enabled => { calls.push(['auto',enabled]); snapshot.autoInstallRuntimes=enabled; },
      onLibraryChanged: () => () => {}, onMaintenanceEnd: () => () => {},
      submissionHistory: async filter => { calls.push(['history',filter]); return { total:0, items:[] }; },
    };
    let config = {version:1,compare:'normalized',cases:[{stdin:''}]}; let disabled=false;
    let runtime = { language:'python', state:missing, autoInstall:false, intentCurrent:true, installing:false, onInstall:()=>calls.push(['prepareInstall']), onSelect:()=>calls.push(['prepareSelect']), onOffline:()=>calls.push(['prepareOffline']), onCancel:()=>calls.push(['prepareCancel']), onDismiss:()=>calls.push(['prepareDismiss']), onAutoInstallChange: enabled=>{runtime.autoInstall=enabled;render();} };
    const app=createRoot(document.getElementById('root')); let view='environment';
    function render() { app.render(view==='environment' ? <EnvironmentPage api={api} onChanged={()=>{}} onError={error=>calls.push(['error',error])} /> : view==='runtime' ? <RuntimePreparation {...runtime}/> : view==='history' ? <SubmissionHistory api={api} problemId="fixture" language="python" answerFormat="acm" refreshKey="fixture" busy={false} active={true} onSelect={()=>{}} onArchives={()=>{}}/> : <AcmInputPanel config={config} disabled={disabled} inputDescription="每组输入结束后关闭 stdin。" outputDescription="未设置期望输出时只查看输出。" onChange={next=>{config=next;render();}}/>); }
    window.fixture={ calls, show(next){view=next;render();}, setRuntime(next){Object.assign(runtime,next);render();}, setConfig(next){config=next;render();}, getConfig(){return config;}, setDisabled(next){disabled=next;render();}, failInstall(language){delete snapshot.installations[language];pending[language]?.reject(new Error('下载超时，请显式重试或导入离线包。'));delete pending[language];} };
    render();
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'runtime-ui-fixture.js', logLevel: 'silent',
});
const browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const passed = [];
const wait = async predicate => page.waitForFunction(predicate);
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><label>保留的草稿<textarea id="draft">print(1)</textarea></label><main id="root"></main></body></html>');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });
  await page.getByRole('heading', { name: '运行环境' }).waitFor();
  await wait(() => document.querySelector('.runtime-state-label[data-state=ready]'));
  const auto = page.getByLabel('运行时自动安装缺失的语言环境', { exact: false });
  assert.equal(await auto.isChecked(), false);
  await auto.check(); await wait(() => window.fixture.calls.some(call => call[0]==='auto' && call[1]===true));
  assert.equal(await auto.isChecked(), true);
  passed.push('Auto-install starts unchecked and changes only through explicit opt-in');
  const python = page.locator('.runtime-environment-card').nth(0), java = page.locator('.runtime-environment-card').nth(1);
  await python.getByRole('button', { name: '修复托管环境', exact: true }).click();
  await python.getByText('25 B / 100 B · 下载 25%').waitFor();
  assert.equal(await java.getByRole('button', { name: '重新检测', exact: true }).isEnabled(), true);
  await java.getByRole('button', { name: '重新检测', exact: true }).click();
  await wait(() => window.fixture.calls.some(call => call[0]==='preflight' && call[1]==='java'));
  await python.getByRole('button', { name: '取消安装', exact: true }).click();
  await wait(() => window.fixture.calls.some(call => call[0]==='cancel' && call[1]==='python'));
  await python.getByRole('button', { name: '修复托管环境', exact: true }).waitFor({ state: 'visible' });
  await wait(() => !document.querySelector('.runtime-environment-card button.button').disabled);
  passed.push('Python installation does not block Java; cancellation names the correct language');
  await python.getByRole('button', { name: '修复托管环境', exact: true }).click();
  await page.evaluate(() => window.fixture.failInstall('python'));
  await python.getByRole('alert').getByText('下载超时，请显式重试或导入离线包。').waitFor();
  assert.equal(await java.getByRole('alert').count(), 0);
  await python.getByText('Python 下载信息与更多操作', {exact:true}).click();
  await python.getByRole('button', {name:'卸载 Python 托管环境…',exact:true}).click();
  await wait(() => window.fixture.calls.some(call => call[0]==='uninstall' && call[1]==='python'));
  passed.push('Failures remain inline per language, with explicit managed-uninstall action');
  await page.evaluate(() => window.fixture.show('runtime'));
  await page.getByRole('button', { name: '安装并运行', exact: true }).waitFor();
  assert.equal(await page.getByText('尚未测量', {exact:true}).count(), 2);
  await page.getByLabel('保留的草稿').fill('print("keep editing")'); await page.getByLabel('保留的草稿').focus();
  await page.evaluate(() => window.fixture.setRuntime({installing:true,progress:{language:'python',phase:'verify',receivedBytes:100,totalBytes:100}}));
  await page.getByText('Python · 正在校验下载包', {exact:true}).waitFor();
  assert.equal(await page.locator('progress').getAttribute('value'), null);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'draft');
  assert.equal(await page.getByLabel('保留的草稿').inputValue(), 'print("keep editing")');
  await page.evaluate(() => window.fixture.setRuntime({progress:{language:'python',phase:'commit',receivedBytes:100,totalBytes:100}}));
  assert.equal(await page.getByRole('button', {name:'安全收尾中',exact:true}).isDisabled(), true);
  await page.evaluate(() => window.fixture.setRuntime({installing:false,intentCurrent:false,state:{status:'ready',message:'ready'}}));
  await page.getByText('草稿或工作区已经变化，请重新点击运行；不会执行之前等待的代码。').waitFor();
  passed.push('Preparation keeps editor focus and content; verification is indeterminate; stale intent cannot auto-run');
  await page.evaluate(() => window.fixture.show('acm'));
  const stdin = page.getByLabel('标准输入 stdin', {exact:false});
  assert.equal(await stdin.inputValue(), '');
  await page.getByLabel('比较期望输出', {exact:false}).check();
  assert.deepEqual(await page.evaluate(() => window.fixture.getConfig().cases[0]), {stdin:'',expected:''});
  await page.getByLabel('期望输出 stdout', {exact:false}).fill('42\n');
  await page.getByLabel('比较期望输出', {exact:false}).uncheck();
  assert.deepEqual(await page.evaluate(() => window.fixture.getConfig().cases[0]), {stdin:''});
  assert.equal(await page.getByLabel('期望输出 stdout', {exact:false}).count(), 0);
  await page.getByRole('button', {name:'新增用例',exact:true}).click();
  await stdin.fill('1 2\n');
  await page.getByLabel('输出比较规则', {exact:true}).selectOption('exact');
  await page.getByRole('button', {name:'用例 1',exact:true}).click();
  assert.equal(await stdin.inputValue(), '');
  await page.getByRole('button', {name:'用例 2',exact:true}).click();
  assert.equal(await stdin.inputValue(), '1 2\n');
  await page.getByRole('button', {name:'删除当前用例',exact:true}).click();
  assert.equal(await page.getByRole('button', {name:'删除当前用例',exact:true}).isDisabled(), true);
  passed.push('ACM preserves separate cases, permits empty stdin, and distinguishes missing from empty expected output');
  await page.getByLabel('比较期望输出', {exact:false}).check();
  await stdin.fill('2 4 6\n');
  const expectedOutput = page.getByLabel('期望输出 stdout', {exact:false});
  await expectedOutput.fill('12\n');
  let inputBounds = await stdin.boundingBox(), outputBounds = await expectedOutput.boundingBox();
  assert.ok(outputBounds.x > inputBounds.x && Math.abs(outputBounds.y - inputBounds.y) < 2);
  await page.setViewportSize({width:375,height:850});
  inputBounds = await stdin.boundingBox(); outputBounds = await expectedOutput.boundingBox();
  assert.ok(outputBounds.y >= inputBounds.y + inputBounds.height);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => window.fixture.getConfig().cases[0]), {stdin:'2 4 6\n',expected:'12\n'});
  await page.setViewportSize({width:1100,height:900});
  passed.push('ACM input/output align side by side only with enough panel width; narrow layout stacks without losing edits');
  await page.evaluate(() => window.fixture.setDisabled(true));
  await wait(() => document.querySelector('.acm-case-fields').disabled);
  assert.equal(await stdin.isDisabled(), true);
  assert.equal(await page.getByLabel('输出比较规则', {exact:true}).isDisabled(), true);
  await page.evaluate(() => {window.fixture.setDisabled(false);window.fixture.setConfig({version:1,compare:'normalized',cases:Array.from({length:50},()=>({stdin:''}))});});
  await wait(() => document.querySelectorAll('.acm-case-picker button').length===50);
  assert.equal(await page.getByRole('button', {name:'新增用例',exact:true}).isDisabled(), true);
  await page.setViewportSize({width:375,height:850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  passed.push('ACM enforces 1–50 cases, freezes editing when disabled, and reflows at 375px');
  await page.evaluate(() => window.fixture.show('history'));
  await wait(() => window.fixture.calls.some(call => call[0]==='history' && call[1].answerFormat==='acm'));
  await page.getByLabel('答题格式筛选', {exact:true}).selectOption('function');
  await wait(() => window.fixture.calls.some(call => call[0]==='history' && call[1].answerFormat==='function'));
  await page.getByLabel('答题格式筛选', {exact:true}).selectOption('all');
  await wait(() => window.fixture.calls.some(call => call[0]==='history' && call[1].answerFormat===undefined));
  passed.push('History defaults to current format and can explicitly request the other or all formats');
  if (process.env.ALGOPRACTICE_UI_SCREENSHOT_DIR) {
    const directory = resolve(process.env.ALGOPRACTICE_UI_SCREENSHOT_DIR); await mkdir(directory, {recursive:true});
    await page.evaluate(() => {window.fixture.setConfig({version:1,compare:'normalized',cases:[{stdin:'3\n1 2 3\n',expected:'6\n'}]});window.fixture.show('acm');});
    await page.getByRole('heading', {name:'标准输入与测试',exact:true}).waitFor();
    await page.screenshot({path:resolve(directory,'acm-narrow.png'),fullPage:true});
    await page.setViewportSize({width:1100,height:900}); await page.evaluate(() => window.fixture.show('environment'));
    await page.getByRole('heading', {name:'运行环境',exact:true}).waitFor();
    await wait(() => document.querySelector('.runtime-state-label[data-state=ready]'));
    await page.screenshot({path:resolve(directory,'environment.png'),fullPage:true});
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result:'passed', assertions:passed, pageErrors:errors }, null, 2));
} finally { await browser.close(); }
