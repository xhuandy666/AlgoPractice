import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';

// Isolated React UI fixtures only: mocked bridge, authored answers, no provider,
// user credentials, runtime downloads, personal data, or real official submissions.
const root = resolve(import.meta.dirname, '..');
const output = process.env.AI_CHAT_UI_EVIDENCE_DIR ? resolve(process.env.AI_CHAT_UI_EVIDENCE_DIR) : await mkdtemp(join(os.tmpdir(), 'algopractice-ai-chat-ui-'));
await mkdir(output, { recursive: true });
const compiled = await build({
  plugins: [{ name: 'authored-code-comparison', setup(build) {
    build.onResolve({ filter: /^\.\/CodeComparison$/ }, () => ({ path: 'authored-comparison', namespace: 'ui-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'ui-fixture' }, () => ({ contents: "import React from 'react'; export function CodeComparison({before,after,label}) {return <div aria-label={label}><pre>{before}</pre><pre>{after}</pre></div>;}", loader: 'tsx', resolveDir: root }));
  } }],
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'ai-chat-ui-fixture.tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './tokens.css';
    import './src/renderer/styles.css';
    import { AiPanel } from './src/renderer/AiPanel';
    import { setEditsFrozen } from './src/renderer/pending-saves';
    const calls = [], aiListeners = new Set(), libraryListeners = new Set(), records = new Map(), pending = new Map();
    const configuration = {id:'authored-ui',model:'authored-ui-model'};
    let provider = {config:configuration,hasKey:true,secureStorageAvailable:true,autoAnalyzeOfficial:false};
    let attempt = {id:'attempt-1',problemId:'problem-1',isActive:true,mode:'practice'}, active = true, reviewMode = false;
    let holdFlush = false, releaseFlush, autoFailure = false, autoDelay = false, releaseAuto;
    const code = 'print(1)';
    const app = createRoot(document.getElementById('root'));
    let counter = 0;
    if (!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:()=> 'authored-request-'+(++counter)});
    const emit = event => aiListeners.forEach(callback=>callback(event));
    const changed = () => libraryListeners.forEach(callback=>callback());
    function makeRecord(input, status='pending', createdAt=new Date().toISOString()) {
      return {id:input.requestId,attemptId:input.attemptId,status,createdAt,finishedAt:null,response:null,error:null,usage:null,cachedFromRequestId:null,
        snapshot:{attemptId:input.attemptId,question:input.question,kind:input.kind,code,provider:configuration,previousRun:null,officialSubmissionId:input.officialSubmissionId,
          ...(input.officialSubmissionId?{conversationMemory:{status:'degraded'}}:{})}};
    }
    function answer(input) {
      return {schemaVersion:2,kind:input.kind,title:'合成教学回答',explanation:'这是本机界面替身回答：'+(input.question||input.kind),nextSteps:['用一个短输入验证你的思路。'],evidence:[],inferences:[],
        patch:input.kind==='diagnosis'?{baseCodeHash:'authored',edits:[]}:null,completeSolution:null,
        noteDraft:input.kind==='note-draft'?{title:'合成笔记草稿',markdown:'## 自建复盘\\n\\n需要本人确认。',tags:[]}:null};
    }
    function finish(id, fail=false) {
      const request = pending.get(id); if (!request) throw new Error('No pending authored UI request');
      pending.delete(id);
      const record = {...request.record,status:fail?'failed':'completed',finishedAt:new Date().toISOString(),response:fail?null:answer(request.input),error:fail?{code:'NETWORK',message:'网络不可用，请重试。',retryable:true}:null};
      records.set(id,record);emit({requestId:id,attemptId:record.attemptId,phase:record.status});request.resolve(record);
    }
    const api = {
      aiProvider:async()=>({...provider}),
      aiRequests:async id=>[...records.values()].filter(record=>record.attemptId===id).reverse(),
      onLibraryChanged:callback=>{libraryListeners.add(callback);return()=>libraryListeners.delete(callback);},
      onAiEvent:callback=>{aiListeners.add(callback);return()=>aiListeners.delete(callback);},
      askAi:input=>{calls.push(['ask',input]);const record=makeRecord(input);records.set(input.requestId,record);emit({requestId:input.requestId,attemptId:input.attemptId,phase:'connecting'});return new Promise((resolve,reject)=>pending.set(input.requestId,{input,record,resolve,reject}));},
      cancelAi:async id=>{calls.push(['cancel',id]);const request=pending.get(id);if(request){pending.delete(id);const record={...request.record,status:'cancelled'};records.set(id,record);emit({requestId:id,attemptId:record.attemptId,phase:'cancelled'});request.resolve(record);}},
      saveAiAutoAnalysis:async enabled=>{calls.push(['auto',enabled]);if(autoDelay)await new Promise(resolve=>releaseAuto=resolve);if(autoFailure)throw new Error('设置保存失败。');provider={...provider,autoAnalyzeOfficial:enabled};return {...provider};},
      previewAiPatch:async id=>{calls.push(['preview',id]);return {requestId:id,attemptId:attempt.id,code:'print(2)',language:'python'};},
      saveAiNoteDraft:async id=>{calls.push(['note',id]);return {id:'authored-note'};},
      openWebLink:async url=>calls.push(['link',url]),
    };
    const onError = error=>calls.push(['error',error]);
    const flush = async()=>{calls.push(['flush']);if(holdFlush)await new Promise(resolve=>releaseFlush=resolve);};
    const onApply = async id=>{calls.push(['apply',id]);};
    const onNoteSaved = note=>{calls.push(['note-saved',note.id]);};
    function render() {app.render(<aside className='history-pane'><AiPanel api={api} attempt={attempt} code={code} selectedRun={null} flush={flush} reviewMode={reviewMode} active={active} onApply={onApply} onNoteSaved={onNoteSaved} onSettings={()=>calls.push(['settings'])} onError={onError}/></aside>);}
    window.fixture={calls,records,pending,
      finish(fail=false){finish([...pending.keys()].at(-1),fail);},
      finishId(id,fail=false){finish(id,fail);},
      reject(){const id=[...pending.keys()].at(-1),request=pending.get(id);pending.delete(id);records.delete(id);request.reject(new Error('草稿保存或请求启动失败。'));},
      show(id='attempt-1',options={}){attempt={id,problemId:'problem-'+id,isActive:options.ended?false:true,mode:options.strict?'strict':'practice'};active=options.hidden?false:true;reviewMode=Boolean(options.review);render();},
      holdFlush(enabled){holdFlush=enabled;},release(){holdFlush=false;releaseFlush?.();},
      configure(enabled){provider={...provider,hasKey:enabled,config:enabled?configuration:null};changed();},
      autoFail(enabled){autoFailure=enabled;},
      delayAuto(enabled){autoDelay=enabled;},releaseAuto(){releaseAuto?.();},
      unmount(){app.render(<aside className='history-pane'/>);},
      officialFailure(){const input={requestId:'failed-official',attemptId:attempt.id,kind:'official-review',question:'',officialSubmissionId:'authored-submitted-code'};const record=makeRecord(input,'failed');record.error={code:'NETWORK',message:'官方分析网络失败，请重试。',retryable:true};records.set(record.id,record);changed();},
      freeze(enabled){setEditsFrozen(enabled,'ui-fixture');},
      history(count){records.clear();for(let i=0;i<count;i++){const input={requestId:'history-'+i,attemptId:attempt.id,kind:'chat',question:'历史提问 '+i};const record=makeRecord(input,'completed',new Date(Date.UTC(2026,0,1,0,0,i)).toISOString());record.response={...answer(input),explanation:Array(6).fill('这是用于滚动验证的自建长回答。内容不会被当作真实学习记录。').join('\\n\\n')};records.set(record.id,record);}changed();},
      append(){const input={requestId:'external-official',attemptId:attempt.id,kind:'official-review',question:''};const record=makeRecord(input,'completed');record.response={...answer(input),explanation:'外部官方分析新回答。'};records.set(record.id,record);emit({requestId:record.id,attemptId:attempt.id,phase:'completed'});},
    };
    render();
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'ai-chat-fixture.js', logLevel: 'silent',
});
const browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, reducedMotion: 'reduce' });
const report = { synthetic: true, scope: 'isolated-renderer-mocked-bridge', limitations: ['Bridge and responses are authored substitutes; CodeComparison is a read-only preview fixture, not a Monaco integration test.'], externalRequests: [], rendererErrors: [], assertions: [], screenshots: [], result: 'running' };
page.on('pageerror', error => report.rendererErrors.push(error.message));
await page.route(/^https?:\/\//, route => { report.externalRequests.push(route.request().url()); return route.abort(); });
const pass = name => { report.assertions.push({ name, passed: true }); console.log('PASS', name); };
const askCalls = () => page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'ask'));
const wait = predicate => page.waitForFunction(predicate);
const input = page.getByRole('textbox', { name: 'AI 提问', exact: true });
const finish = async (failed = false) => { await page.evaluate(failed => window.fixture.finish(failed), failed); await page.getByRole('button', { name: '发送', exact: true }).waitFor(); };
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="root"></main></body></html>');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addStyleTag({ content: '#root{height:840px;padding:24px}.history-pane{height:790px;width:420px;display:flex;flex-direction:column;padding:16px;border:1px solid var(--color-rule)}@media(max-width:500px){#root{padding:8px;height:840px}.history-pane{width:100%;height:800px;padding:12px}}' });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });
  await page.getByRole('button', { name: '给点提示', exact: true }).waitFor();
  await wait(() => !document.querySelector('.ai-quick-actions button').disabled);
  assert.equal(await page.getByText('本次发送的上下文', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('搜索引用笔记').count(), 0);
  assert.equal(await page.getByLabel('提交后自动分析', { exact: true }).isChecked(), false);
  assert.equal((await askCalls()).length, 0);
  pass('Natural chat mounts with two shortcuts, no context selectors, opt-in auto-analysis off, and no automatic request');

  await input.fill('先保留我的自由问题');
  await page.evaluate(() => { const button = document.querySelector('.ai-quick-actions button'); button.click(); button.click(); });
  await wait(() => window.fixture.pending.size === 1);
  let calls = await askCalls(); assert.equal(calls.length, 1); assert.equal(calls[0][1].kind, 'hint'); assert.equal(calls[0][1].question, '');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['attemptId', 'kind', 'question', 'requestId']);
  assert.equal(await page.locator('.ai-chat-user .ai-question').last().textContent(), '给点提示');
  assert.equal(await page.getByRole('button', { name: '停止 AI 请求', exact: true }).isVisible(), true);
  await finish(); assert.equal(await input.inputValue(), '先保留我的自由问题');
  pass('Hint shortcut sends an empty hint once per same-tick click pair and shows the optimistic user/progress without consuming typed text');

  await page.getByRole('button', { name: '检查代码', exact: true }).click(); await wait(() => window.fixture.pending.size === 1);
  calls = await askCalls(); assert.equal(calls.at(-1)[1].kind, 'diagnosis'); assert.equal(calls.at(-1)[1].question, '');
  await finish();
  await page.getByRole('button', { name: '预览修改建议', exact: true }).click();
  await page.getByRole('button', { name: '应用到当前草稿', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'apply').length), 0);
  await page.getByRole('button', { name: '应用到当前草稿', exact: true }).click();
  await wait(() => window.fixture.calls.some(call => call[0] === 'apply'));
  pass('Code check is a distinct empty diagnosis, and applying a suggestion still requires explicit preview then apply');

  await input.fill('自由问题第一行'); await input.press('Shift+Enter'); await input.press('End'); await input.type('第二行');
  assert.equal((await askCalls()).length, 2); assert.ok((await input.inputValue()).includes('\n'));
  await input.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })); });
  assert.equal((await askCalls()).length, 2);
  await input.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); });
  assert.equal((await askCalls()).length, 2);
  const question = await input.inputValue(); await input.press('Enter'); await wait(() => window.fixture.pending.size === 1);
  calls = await askCalls(); assert.equal(calls.at(-1)[1].kind, 'chat'); assert.equal(calls.at(-1)[1].question, question);
  await finish(); assert.equal(await input.inputValue(), '');
  const userTexts = await page.locator('.ai-chat-user .ai-question').allTextContents();
  assert.deepEqual(userTexts, ['给点提示', '检查代码', question]);
  pass('Shift+Enter inserts a newline, Chinese IME Enter does not send, plain Enter sends chat, and chronological rounds remain user then assistant');

  await input.fill('失败后保留的问题'); await input.press('Enter'); await wait(() => window.fixture.pending.size === 1); await finish(true);
  assert.equal(await input.inputValue(), '失败后保留的问题');
  await page.getByRole('button', { name: '重试这次提问', exact: true }).click(); await wait(() => window.fixture.pending.size === 1); await finish();
  await input.fill('请求启动失败仍保留'); await input.press('Enter'); await wait(() => window.fixture.pending.size === 1);
  await page.evaluate(() => window.fixture.reject()); await page.getByRole('alert').filter({ hasText: '草稿保存或请求启动失败' }).waitFor();
  assert.equal(await input.inputValue(), '请求启动失败仍保留');
  pass('Persisted failure and bridge rejection both retain the input and expose an accessible retry');

  const beforeFlushCancel = (await askCalls()).length;
  await page.evaluate(() => window.fixture.holdFlush(true)); await input.fill('保存草稿时停止'); await input.press('Enter');
  await page.locator('.ai-chat-user .ai-question').filter({ hasText: '保存草稿时停止' }).waitFor();
  assert.equal((await askCalls()).length, beforeFlushCancel);
  await page.getByRole('button', { name: '停止 AI 请求', exact: true }).click(); await page.evaluate(() => window.fixture.release());
  await page.getByRole('button', { name: '发送', exact: true }).waitFor(); assert.equal((await askCalls()).length, beforeFlushCancel);
  pass('Optimistic user/progress appears before draft flush, and stopping during flush prevents the backend call');

  const toggle = page.getByLabel('提交后自动分析', { exact: true });
  await page.evaluate(() => window.fixture.delayAuto(true));
  const beforeToggle = (await askCalls()).length; await toggle.check(); await wait(() => window.fixture.calls.some(call => call[0] === 'auto' && call[1] === true));
  assert.equal(await toggle.isChecked(), true); assert.equal(await toggle.isDisabled(), true); assert.equal((await askCalls()).length, beforeToggle);
  await page.evaluate(() => window.fixture.releaseAuto()); await wait(() => !document.querySelector('.ai-auto-analysis input').disabled);
  await page.evaluate(() => window.fixture.autoFail(true)); await toggle.click();
  assert.equal(await toggle.isChecked(), false); assert.equal(await toggle.isDisabled(), true);
  await page.evaluate(() => window.fixture.releaseAuto());
  await page.getByRole('alert').filter({ hasText: '设置保存失败' }).waitFor(); assert.equal(await toggle.isChecked(), true);
  await page.evaluate(() => { window.fixture.autoFail(false); window.fixture.delayAuto(false); }); await toggle.uncheck(); await wait(() => !document.querySelector('.ai-auto-analysis input').checked);
  pass('Delayed auto-analysis saving shows optimistic state and disables the checkbox; failure rolls back, and toggling never starts analysis');

  await page.getByRole('button', { name: '总结为笔记草稿', exact: true }).click(); await wait(() => window.fixture.pending.size === 1); await finish();
  await page.getByText('笔记草稿', { exact: true }).click(); await page.getByRole('button', { name: '保存为笔记草稿', exact: true }).click();
  await wait(() => window.fixture.calls.some(call => call[0] === 'note-saved'));
  pass('Note-draft generation and explicit saving remain available as secondary actions');

  await page.evaluate(() => window.fixture.officialFailure());
  await page.locator('[data-request-id="failed-official"]').getByRole('button', { name: '重试这次提问', exact: true }).click();
  await wait(() => window.fixture.pending.size === 1);
  const officialRetry = (await askCalls()).at(-1)[1]; assert.equal(officialRetry.kind, 'official-review'); assert.equal(officialRetry.officialSubmissionId, 'authored-submitted-code');
  await finish();
  await page.locator('[data-request-id="' + officialRetry.requestId + '"]').getByText('回答详情', { exact: true }).click();
  await page.getByText('历史对话有部分省略；本次分析仍以本次代码快照为准。', { exact: true }).waitFor();
  pass('Official-analysis retry retains its immutable submission ID, and degraded history is disclosed only in answer details');

  await input.fill('同题还没发送的问题'); await page.evaluate(() => window.fixture.show('attempt-1', { hidden: true }));
  await page.getByRole('region', { name: 'AI 教练', exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => window.fixture.show('attempt-1')); await wait(() => !document.querySelector('.ai-quick-actions button').disabled);
  assert.equal(await input.inputValue(), '同题还没发送的问题');
  await page.evaluate(() => window.fixture.unmount()); await page.getByRole('region', { name: 'AI 教练', exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => window.fixture.show('attempt-1')); await wait(() => !document.querySelector('.ai-quick-actions button').disabled);
  assert.equal(await input.inputValue(), '同题还没发送的问题');
  pass('Unsent input survives hiding or unmounting the same-attempt AI tab using bounded in-memory UI drafts');

  await input.fill('旧练习迟到回答'); await input.press('Enter'); await wait(() => window.fixture.pending.size === 1);
  const oldRequestId = (await askCalls()).at(-1)[1].requestId;
  await page.evaluate(() => window.fixture.show('attempt-2')); await wait(() => !document.querySelector('.ai-quick-actions button').disabled);
  await page.evaluate(id => window.fixture.finishId(id), oldRequestId);
  assert.equal(await page.getByText('旧练习迟到回答', { exact: true }).count(), 0); assert.equal(await input.inputValue(), '');
  await input.fill('隐藏面板的迟到回答'); await input.press('Enter'); await wait(() => window.fixture.pending.size === 1);
  const hiddenRequestId = (await askCalls()).at(-1)[1].requestId;
  await page.evaluate(() => window.fixture.show('attempt-2', { hidden: true })); await page.getByRole('region', { name: 'AI 教练', exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(id => window.fixture.finishId(id), hiddenRequestId); await page.evaluate(() => window.fixture.show('attempt-3'));
  await wait(() => !document.querySelector('.ai-quick-actions button').disabled);
  assert.equal(await page.getByText('隐藏面板的迟到回答', { exact: true }).count(), 0);
  pass('Switching attempt or hiding the panel invalidates late responses without polluting the next conversation');

  await page.evaluate(() => window.fixture.history(16)); await wait(() => document.querySelectorAll('.ai-chat-turn').length === 16);
  assert.equal(await page.locator('.ai-chat-user .ai-question').first().textContent(), '历史提问 0');
  assert.equal(await page.locator('.ai-chat-user .ai-question').last().textContent(), '历史提问 15');
  const composerBefore = await page.locator('.ai-composer').boundingBox();
  await page.locator('.ai-conversation').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '查看最新消息', exact: true }).waitFor(); await page.evaluate(() => window.fixture.append());
  await page.getByText('外部官方分析新回答。', { exact: true }).waitFor();
  assert.equal(await page.locator('.ai-conversation').evaluate(element => element.scrollTop), 0);
  const composerAfter = await page.locator('.ai-composer').boundingBox();
  assert.ok(Math.abs(composerAfter.y + composerAfter.height - composerBefore.y - composerBefore.height) < 2);
  await page.getByRole('button', { name: '查看最新消息', exact: true }).click();
  assert.ok(await page.locator('.ai-conversation').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 4));
  pass('History loads chronologically and at the bottom; new responses do not interrupt reading history, and the composer stays fixed');
  await page.screenshot({ path: join(output, 'ai-chat-desktop.png'), fullPage: true }); report.screenshots.push('ai-chat-desktop.png');

  await page.evaluate(() => window.fixture.show('review-attempt', { ended: true, strict: true, review: true }));
  await wait(() => !document.querySelector('.ai-quick-actions button').disabled); await page.getByRole('button', { name: '检查代码', exact: true }).click();
  await wait(() => window.fixture.pending.size === 1); await finish();
  assert.equal(await page.getByRole('button', { name: '预览修改建议', exact: true }).count(), 0);
  await page.evaluate(() => window.fixture.show('strict-attempt', { strict: true })); await page.getByText('严格面试进行中，AI 教练暂不可用。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '给点提示', exact: true }).isDisabled(), true); assert.equal(await input.isDisabled(), true);
  await page.evaluate(() => window.fixture.show('unconfigured-attempt')); await page.evaluate(() => window.fixture.configure(false)); await page.getByRole('button', { name: '配置 AI', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '检查代码', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.fixture.configure(true)); await wait(() => !document.querySelector('.ai-quick-actions button').disabled);
  await page.evaluate(() => window.fixture.freeze(true)); assert.equal(await input.isDisabled(), true); await page.evaluate(() => window.fixture.freeze(false));
  pass('Ended strict-session review can ask without offering patch application; active strict, missing configuration, and edit freeze disable requests');

  for (const width of [1440, 820, 375, 320]) {
    await page.setViewportSize({ width, height: 920 }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const dimensions = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.root <= width && dimensions.body <= width, JSON.stringify(dimensions));
    await input.focus(); const focus = await input.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
    assert.equal(focus.outline, 'solid'); assert.equal(focus.width, '2px');
  }
  pass('Chat has no horizontal overflow at 1440/820/375/320 px and exposes visible keyboard focus with reduced motion');
  assert.equal(report.externalRequests.length, 0); assert.deepEqual(report.rendererErrors, []); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; console.error(error);
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close(); await writeFile(join(output, 'ui.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions.length, output, ...(report.failure ? { failure: report.failure } : {}) }));
}
