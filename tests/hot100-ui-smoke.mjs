import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// Isolated renderer fixtures: no official requests, runtime downloads, or user database.
const root = resolve(import.meta.dirname, '..');
const compiled = await build({
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'hot100-ui-fixture.tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { HOT100 } from './src/shared/builtin-lists';
    import { Hot100Card } from './src/renderer/Hot100Card';
    import { LibraryPage } from './src/renderer/LibraryPage';
    import { ImportPage } from './src/renderer/ImportPage';
    import './tokens.css';
    import './src/renderer/styles.css';
    const calls = []; let lists = []; let jobs = []; let view = 'card'; let generation = 0;
    let pending; let failRefresh = false;
    const list = { id:HOT100.id, title:HOT100.title, source:'leetcode-cn', sourceUrl:HOT100.url, revision:1, chapters:[], items:[0,1,2].map(i=>({key:'k'+i, problemId:'p'+i,position:i})), createdAt:'2026-09-27T00:00:00Z', updatedAt:'2026-09-27T00:00:00Z' };
    function makeJob(status='running') { return {id:'fixture-job', requestKey:'fixture', title:HOT100.title, input:HOT100.url, source:'leetcode-cn', sourceUrl:HOT100.url, list, status, items:[], total:3, counts:{pending:1,running:0,imported:1,reused:0,link_only:0,restricted:0,failed:1,skipped:0}, error:null, createdAt:'2026-09-27T00:00:00Z',updatedAt:new Date().toISOString()}; }
    const api = {
      importHot100: () => { calls.push(['import']); return new Promise((resolve,reject)=>{pending={resolve,reject};}); },
      resumeImport: async (id,retry) => {calls.push(['resume',id,retry]);jobs=[{...jobs[0],status:'running',updatedAt:new Date().toISOString()}];return jobs[0];},
      pauseImport: async id => {calls.push(['pause',id]);jobs=[{...jobs[0],status:'paused',updatedAt:new Date().toISOString()}];},
      problemPage: async filter => {calls.push(['page',filter]);return {items:[],total:0,offset:0,limit:30,hasMore:false};},
      sourceSession: async () => ({hasSession:false}),
    };
    const app = createRoot(document.getElementById('root'));
    const onChanged = async () => {calls.push(['refresh']);if(failRefresh)throw new Error('本机状态暂时未刷新');render();};
    function render() {
      const common={api,onChanged,onError:error=>calls.push(['error',error])};
      app.render(view==='library'?<LibraryPage key={generation} {...common} data={{problems:[],totalProblems:0,lists,jobs}} onOpen={()=>{}} onImport={()=>{}}/>:view==='import'?<ImportPage key={generation} {...common} lists={lists} jobs={jobs} onOpenLibrary={()=>calls.push(['view'])}/>:<Hot100Card key={generation} {...common} lists={lists} jobs={jobs} onView={id=>calls.push(['view',id])}/>);
    }
    window.fixture={calls,HOT100,
      show(next){view=next;generation++;render();},
      fail(){pending.reject(new Error('网络不可用，请稍后重试'));},
      succeed(){lists=[list];jobs=[makeJob()];pending.resolve({listId:HOT100.id,job:jobs[0]});},
      state(status){lists=[list];jobs=status?[makeJob(status)]:[];generation++;render();},
      jobOnly(){lists=[];jobs=[makeJob('paused')];generation++;render();},
      empty(){lists=[];jobs=[];generation++;render();},
      failRefresh(next){failRefresh=next;},
      completed(){lists=[list];jobs=[{...makeJob('completed'),counts:{pending:0,running:0,imported:2,reused:1,link_only:0,restricted:0,failed:0,skipped:0}}];render();},
    };
    render();
  ` },
  bundle:true, platform:'browser', format:'iife', write:false, outfile:'hot100-ui-fixture.js', logLevel:'silent',
});
const browser = await chromium.launch({headless:true,...(process.env.ALGOPRACTICE_TEST_BROWSER ? {channel:process.env.ALGOPRACTICE_TEST_BROWSER} : {})});
const page = await browser.newPage({viewport:{width:1100,height:900},reducedMotion:'reduce'});
const errors=[]; page.on('pageerror',error=>errors.push(error.message)); const passed=[];
const wait = predicate => page.waitForFunction(predicate);
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><label>保留的草稿<textarea id="draft">print(1)</textarea></label><main id="root"></main></body></html>');
  await page.addStyleTag({content:compiled.outputFiles.find(file=>file.path.endsWith('.css')).text});
  await page.addScriptTag({content:compiled.outputFiles.find(file=>file.path.endsWith('.js')).text});
  await page.getByRole('button',{name:'一键导入 Hot100',exact:true}).waitFor();
  for(const view of ['library','import','card']) {
    await page.evaluate(view=>window.fixture.show(view),view);
    await page.getByRole('button',{name:'一键导入 Hot100',exact:true}).waitFor();
  }
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='import').length),0);
  passed.push('Card, library, and import page never start imports merely by mounting');
  await page.evaluate(()=>{const button=document.querySelector('.hot100-card button');button.click();button.click();});
  await page.getByRole('button',{name:'正在准备 Hot100…',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='import').length),1);
  assert.equal(await page.getByRole('button',{name:'正在准备 Hot100…',exact:true}).isDisabled(),true);
  await page.getByLabel('保留的草稿').fill('print("preserved")'); await page.getByLabel('保留的草稿').focus();
  await page.evaluate(()=>window.fixture.fail());
  await page.getByRole('alert').getByText('网络不可用，请稍后重试',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'draft');
  assert.equal(await page.getByLabel('保留的草稿').inputValue(),'print("preserved")');
  passed.push('Same-tick duplicate clicks are single-flight; offline errors stay inline without stealing focus');
  await page.getByRole('button',{name:'重试导入 Hot100',exact:true}).click();
  await page.evaluate(()=>window.fixture.succeed());
  await page.getByRole('button',{name:'暂停导入',exact:true}).waitFor();
  await page.getByRole('status').getByText('本机题单 3 道题',{exact:false}).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('max'),'3');
  assert.equal(await page.getByRole('progressbar').getAttribute('value'),'2');
  await page.getByText('最近任务 3 项：已缓存 1 · 待处理 1 · 失败 1 · 受限 0',{exact:true}).waitFor();
  await page.getByRole('button',{name:'查看 Hot100 题单',exact:true}).click();
  await wait(()=>window.fixture.calls.some(call=>call[0]==='view' && call[1]===window.fixture.HOT100.id));
  passed.push('Success exposes actual 3-member list and exact cache/failure counts, not a 100-item offline promise');
  await page.getByRole('button',{name:'暂停导入',exact:true}).click();
  await page.getByRole('button',{name:'继续导入 / 重试',exact:true}).waitFor();
  await page.evaluate(()=>window.fixture.show('card'));
  await page.getByRole('button',{name:'继续导入 / 重试',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='resume').length),0);
  await page.evaluate(()=>{const button=[...document.querySelectorAll('.hot100-card button')].find(b=>b.textContent==='继续导入 / 重试');button.click();button.click();});
  await page.getByRole('button',{name:'暂停导入',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='resume')),[['resume','fixture-job',true]]);
  passed.push('Paused jobs remain paused on remount; explicit resume and pause target the existing job');
  await page.evaluate(()=>{window.fixture.state(null);window.fixture.show('library');});
  await page.getByRole('button',{name:'查看 Hot100 题单',exact:true}).click();
  await wait(()=>window.fixture.calls.some(call=>call[0]==='page' && call[1].listId===window.fixture.HOT100.id));
  assert.equal(await page.getByRole('button',{name:'一键导入 Hot100',exact:true}).count(),0);
  passed.push('Previously saved list with no job is not re-imported; library action selects the exact list');
  await page.evaluate(()=>window.fixture.show('import'));
  await page.getByRole('button',{name:'前往题库',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看 Hot100 题单',exact:true}).count(),0);
  await page.evaluate(()=>{window.fixture.show('card');window.fixture.jobOnly();});
  await page.getByRole('button',{name:'继续导入 / 重试',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看 Hot100 题单',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'继续导入 / 重试',exact:true}).isEnabled(),true);
  passed.push('Import page labels navigation honestly; incomplete membership keeps view disabled while resume remains available');
  await page.evaluate(()=>{window.fixture.show('card');window.fixture.empty();window.fixture.failRefresh(true);});
  await page.getByRole('button',{name:'一键导入 Hot100',exact:true}).click();
  await page.evaluate(()=>window.fixture.succeed());
  await page.getByRole('button',{name:'刷新本机状态',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'一键导入 Hot100',exact:true}).count(),0);
  const importCount=await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='import').length);
  await page.evaluate(()=>window.fixture.failRefresh(false));
  await page.getByRole('button',{name:'刷新本机状态',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='import').length),importCount);
  passed.push('Failed local refresh after successful import offers refresh, never duplicate import');
  await page.evaluate(()=>window.fixture.completed());
  await page.getByRole('status').getByText('本次已缓存 3 / 3',{exact:false}).waitFor();
  await page.setViewportSize({width:375,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.getByText('100题已全部离线',{exact:false}).count(),0);
  assert.deepEqual(errors,[]);
  passed.push('Completed counts stay evidence-based and the card reflows at 375px with reduced motion');
  console.log(JSON.stringify({result:'passed',assertions:passed,pageErrors:errors},null,2));
} finally {await browser.close();}
