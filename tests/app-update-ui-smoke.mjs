import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Renderer only: no network, installer, application exit, or user-data access.
const root = resolve(import.meta.dirname, '..');
const compiled = await build({
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'app-update-ui-fixture.tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppUpdateNotice, AppUpdateSection } from './src/renderer/AppUpdate';
    import './tokens.css'; import './src/renderer/styles.css'; import './src/renderer/runtime-preparation.css';
    let state = { currentVersion:'0.95.0',latestVersion:null,phase:'idle',mode:'installer',automatic:false,
      checkedAt:null,publishedAt:null,releaseUrl:null,progress:null,error:null };
    let listener = null, pending = {}, initial = null, showSection = true, normal = true, oldApi = false, holdAutomatic = false;
    const calls = [], counts = {subscribe:0,unsubscribe:0};
    const deferred = name => {calls.push([name]);return new Promise((resolve,reject)=>{pending[name]={resolve,reject};});};
    const api = {
      updateState:()=>new Promise(resolve=>{initial=resolve;}),
      onAppUpdate: callback=>{counts.subscribe++;listener=callback;return()=>{counts.unsubscribe++;listener=null;};},
      checkForAppUpdate:()=>deferred('check'), downloadAppUpdate:()=>deferred('download'), installAppUpdate:()=>deferred('install'),
      setAutomaticUpdates:async enabled=>{calls.push(['automatic',enabled]);if(holdAutomatic)return new Promise((resolve,reject)=>{pending.automatic={resolve,reject};});state={...state,automatic:enabled};listener?.(state);return structuredClone(state);},
      openWebLink:async url=>{calls.push(['link',url]);},
    };
    const app = createRoot(document.getElementById('root'));
    function render(){app.render(<>{normal&&<AppUpdateNotice api={oldApi?{}:api}/>} {showSection&&<AppUpdateSection api={oldApi?{}:api}/>}</>);}
    window.fixture={calls,counts,
      emit(change){state={...state,...change};listener?.(structuredClone(state));},
      resolveInitial(change={}){initial?.({...state,...change});},
      resolve(name,change={},stale=false){const reply={...state,...change};if(!stale)state=reply;pending[name]?.resolve(reply);delete pending[name];},
      reject(name,message){pending[name]?.reject(new Error(message));delete pending[name];},
      holdAutomatic(value){holdAutomatic=value;}, keepPending(name,key){pending[key]=pending[name];delete pending[name];},
      showSection(value){showSection=value;render();}, normal(value){normal=value;render();},
      legacy(value){oldApi=value;render();},
    };
    render();
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'app-update-ui-fixture.js', logLevel: 'silent',
});
const browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: 'reduce' });
const errors = [], passed = []; page.on('pageerror', error => errors.push(error.message));
const wait = predicate => page.waitForFunction(predicate);
const section = page.getByRole('region', { name: '版本与更新', exact: true });
const banner = page.getByRole('region', { name: '新版本已准备好', exact: true });
const screenshot = async name => {
  if (!process.env.ALGOPRACTICE_SCREENSHOT_DIR) return;
  const directory = resolve(process.env.ALGOPRACTICE_SCREENSHOT_DIR); await mkdir(directory, { recursive:true });
  await page.screenshot({ path:resolve(directory, name), fullPage:true });
};
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><label>当前草稿<textarea id="draft">print(1)</textarea></label><main id="root"></main></body></html>');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });
  await section.getByText('正在读取更新设置…', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.counts.subscribe), 1);
  await page.evaluate(() => window.fixture.emit({ phase:'downloading',latestVersion:'0.96.0',progress:{percent:35,transferred:350,total:1000} }));
  await section.getByRole('progressbar', { name: '应用更新下载进度' }).waitFor();
  await page.evaluate(() => window.fixture.resolveInitial({ phase:'idle',latestVersion:null,progress:null }));
  assert.equal(await section.getByRole('progressbar').getAttribute('value'), '35');
  passed.push('Two surfaces share one subscription; a late initial snapshot cannot overwrite download progress');

  await page.evaluate(() => window.fixture.emit({phase:'idle',latestVersion:null,progress:null}));
  await section.getByLabel('自动检查并下载新版本').check();
  await wait(() => window.fixture.calls.some(call => call[0] === 'automatic' && call[1] === true));
  await page.evaluate(() => {const button=[...document.querySelectorAll('.app-update-section button')].find(node=>node.textContent==='检查更新');button.click();button.click();});
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'check').length), 1);
  await page.evaluate(() => window.fixture.emit({phase:'checking'}));
  assert.equal(await section.getByLabel('自动检查并下载新版本').isEnabled(), true);
  await page.evaluate(() => {window.fixture.emit({phase:'available',latestVersion:'0.96.0',releaseUrl:'https://github.com/xhuandy666/AlgoPractice/releases/tag/v0.96.0'});window.fixture.resolve('check',{phase:'idle',latestVersion:null},true);});
  await section.getByRole('button', { name: '下载新版本', exact: true }).click();
  await page.evaluate(() => window.fixture.emit({phase:'downloading',progress:{percent:70,transferred:700,total:1000}}));
  assert.equal(await section.getByRole('progressbar').getAttribute('value'), '70');
  await screenshot('app-update-downloading.png');
  assert.equal(await section.getByLabel('自动检查并下载新版本').isEnabled(), true);
  await page.evaluate(() => {window.fixture.holdAutomatic(true);const checkbox=document.querySelector('.app-update-preference input');checkbox.click();checkbox.click();});
  await wait(() => window.fixture.calls.some(call => call[0] === 'automatic' && call[1] === false));
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'automatic' && call[1] === false).length), 1);
  assert.equal(await section.getByLabel('自动检查并下载新版本').isDisabled(), true);
  await page.getByLabel('当前草稿').focus();
  await page.evaluate(() => {window.fixture.emit({automatic:false,phase:'available',progress:null});window.fixture.resolve('automatic',{automatic:true,phase:'downloading'},true);window.fixture.keepPending('download','cancelled-download');});
  assert.equal(await section.getByLabel('自动检查并下载新版本').isChecked(), false);
  await section.getByRole('button', { name: '下载新版本', exact: true }).click();
  await page.evaluate(() => {window.fixture.holdAutomatic(false);window.fixture.emit({phase:'downloading',progress:{percent:30,transferred:300,total:1000}});window.fixture.resolve('cancelled-download',{automatic:true,phase:'downloaded'},true);});
  assert.equal(await section.getByLabel('自动检查并下载新版本').isChecked(), false);
  assert.equal(await section.getByRole('progressbar').getAttribute('value'), '30');
  assert.equal(await section.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
  assert.equal(await banner.count(), 0);
  passed.push('Automation can be disabled while checking/downloading; its own single-flight cancels the old action and stale preference/download replies cannot re-enable it or unlock a newer download');
  await page.getByLabel('当前草稿').focus();
  await page.evaluate(() => {window.fixture.emit({phase:'error',progress:null,error:'下载中断，请重试。'});window.fixture.reject('download','下载中断，请重试。');});
  await section.getByRole('alert').getByText('下载中断，请重试。').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'draft');
  await section.getByRole('button', { name: '重试更新', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'download').length), 3);
  passed.push('Preference is explicit, same-tick checks are single-flight, and download failure offers a download retry without moving focus');

  await page.getByLabel('当前草稿').focus();
  await page.evaluate(() => {window.fixture.emit({phase:'downloaded',error:null,progress:null});window.fixture.reject('download','迟到的旧下载错误');});
  await banner.getByText('v0.96.0 已下载完成。打开安装包将保存并退出题炼，请在安装包中完成更新。', { exact: true }).waitFor();
  assert.equal(await section.getByRole('alert').count(), 0);
  await screenshot('app-update-downloaded.png');
  await page.setViewportSize({ width:375,height:800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot('app-update-downloaded-narrow.png');
  await page.setViewportSize({ width:1000,height:800 });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'draft');
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'install').length), 0);
  await page.evaluate(() => window.fixture.showSection(false));
  await banner.getByRole('button', { name: '打开安装包', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.counts.unsubscribe), 0);
  await page.evaluate(() => {const button=document.querySelector('.app-update-notice .primary');button.click();button.click();});
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'install').length), 1);
  await page.evaluate(() => window.fixture.reject('install','当前有任务正在运行，请结束后重试。'));
  await banner.getByRole('alert').getByText('当前有任务正在运行，请结束后重试。').waitFor();
  await banner.getByRole('button', { name: '打开安装包', exact: true }).click();
  await page.evaluate(() => window.fixture.resolve('install'));
  await banner.getByRole('button', { name: '稍后', exact: true }).click();
  assert.equal(await banner.count(), 0);
  passed.push('Downloaded installer stays available across pages, ignores stale replies, never auto-installs, and installs only once per explicit click with retry');

  await page.evaluate(() => {window.fixture.normal(false);});
  await wait(() => window.fixture.counts.unsubscribe === 1);
  assert.equal(await banner.count(), 0);
  await page.evaluate(() => {window.fixture.emit({phase:'downloaded',mode:'native'});window.fixture.normal(true);});
  await wait(() => window.fixture.counts.subscribe === 2);
  await page.evaluate(() => window.fixture.resolveInitial());
  await banner.getByRole('button', { name: '重启并更新', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.normal(false));
  await wait(() => window.fixture.counts.unsubscribe === 2);
  passed.push('Leaving the normal app removes the subscription and notice; a later normal mount reloads native update state');

  await page.evaluate(() => {window.fixture.normal(true);window.fixture.showSection(true);});
  await wait(() => window.fixture.counts.subscribe === 3);
  await page.evaluate(() => window.fixture.resolveInitial({mode:'development',phase:'disabled',latestVersion:null,automatic:false}));
  await section.getByText('源码运行模式不会自动检查或下载更新。', { exact: false }).waitFor();
  assert.equal(await section.getByLabel('自动检查并下载新版本').isDisabled(), true);
  assert.equal(await section.getByRole('button', { name: '检查更新', exact: true }).isEnabled(), true);
  await page.evaluate(() => window.fixture.legacy(true));
  await section.getByText('当前为源码或界面预览模式', { exact: false }).waitFor();
  await wait(() => window.fixture.counts.unsubscribe === 3);
  await page.setViewportSize({ width:375,height:800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  passed.push('Source mode keeps manual checking but disables automation; older fixtures without updater APIs remain safe at 375px');
  await screenshot('app-update-source.png');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result:'passed',assertions:passed,pageErrors:errors }, null, 2));
} finally { await browser.close(); }
