import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { build as buildFrontend } from 'vite';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Real Electron main/preload/IPC, LearningController, AiService, CredentialVault,
// and SQLite. Only delayed context hook, OS encryption, and provider are authored
// substitutes. Official completed rows are synthetic, not judge-transport tests.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const directory = await mkdtemp(join(os.tmpdir(), 'algopractice-ai-lifecycle-'));
const launchDirectory = join(directory, 'app'), dataDirectory = join(directory, 'data');
await Promise.all([mkdir(join(launchDirectory, 'dist'), { recursive: true }), mkdir(dataDirectory)]);
await copyFile(join(root, 'package.json'), join(launchDirectory, 'package.json'));
const report = { startedAt: new Date().toISOString(), synthetic: true, directory, dataDirectory,
  scope: 'Real LearningController registration and ai:ask IPC handler/finally, production preload, AiService preparing/active cancellation, CredentialVault, SQLite, pause/rebind/resume, real AiPanel rendering of reference-selected and historical canonical evidence.',
  limitations: ['Context preparation is delayed through the existing interviewContext extension after the real database context is constructed; the private provider resolver is not replaced or separately delayed.',
    'SafeStorage and provider fetch are synthetic and deliberately ignore cancellation until released; this does not verify OS Keychain integration or model quality.',
    'Official-completed events use real persisted authored submission rows, not OfficialJudgeService transport.',
    'A consistent SQLite snapshot is swapped through pause/rebind/resume; this does not exercise archive file restoration or the full production main application maintenance UI.'],
  sourceHashes: {}, assertions: [], rendererErrors: [], result: 'running' };
for (const file of ['src/desktop/learning-controller.ts', 'src/desktop/learning-context.ts', 'src/desktop/official-ai-coach.ts', 'src/ai/context.ts', 'src/ai/evidence-catalog.ts', 'src/ai/policy.ts', 'src/ai/service.ts', 'src/ai/credential-vault.ts', 'src/desktop/preload.ts', 'src/renderer/AiPanel.tsx']) {
  report.sourceHashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
}
await build({ stdin: { resolveDir: root, sourcefile: 'authored-ai-lifecycle-main.ts', loader: 'ts', contents: `
  import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
  import { mkdirSync } from 'node:fs';
  import { join } from 'node:path';
  import { LearningController } from './src/desktop/learning-controller';
  import { PracticeStore } from './src/storage/practice-store';
  import { officialAnalysisRequestId } from './src/desktop/official-ai-coach';
  import { buildPracticeAiContext } from './src/desktop/learning-context';
  import { buildRequestSnapshot, requestHash, validateResponse, canonicalJson, sha256 } from './src/ai/index';
  const directory = process.env.AI_LIFECYCLE_DIRECTORY!;
  const dataDirectory = join(directory,'data');
  for(const name of ['electron-profile','electron-session'])mkdirSync(join(directory,name),{recursive:true});
  app.setPath('userData',join(directory,'electron-profile'));app.setPath('sessionData',join(directory,'electron-session'));
  app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-component-update');
  const test = {events:[],providerCalls:[],blockedHttp:[],logs:[],changes:0,contextCalls:0,lateReleases:0,
    contextNext:false,vaultNext:false,providerNext:false,contextGate:null,vaultGate:null,providerGate:null,stores:[],allowed:true,sequence:0,referenceKind:null};
  let controller, current, win;
  const code = 'class Solution:\\n    def twoSum(self, nums, target):\\n        return [0, 1]\\n';
  const problem = {id:'leetcode-cn:problem:two-sum',source:'leetcode-cn',sourceId:'1',sourceUrl:'https://leetcode.cn/problems/two-sum/',
    title:'AI生命周期合成题',difficulty:'简单',tags:['合成验收'],description:'自建样例：返回两个不同的位置。',descriptionFormat:'plain',constraints:['恰好有一个解'],mode:'function',
    adapter:{method:'twoSum',params:[{array:'int'},'int'],returns:{array:'int'}},cases:[{args:[[2,7],9],expected:[0,1]}],starter:{python:code}};
  function observeStore(path) {
    const real = new PracticeStore(path), state={path,closed:false,calls:0,postCloseAccess:[],methodCounts:{}};
    const proxy = new Proxy(real,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
      return (...args)=>{const method=String(key);if(state.closed){state.postCloseAccess.push(method);throw new Error('Authored guard: closed SQLite accessed');}
        state.calls++;state.methodCounts[method]=(state.methodCounts[method]||0)+1;const result=value.apply(target,args);if(method==='close')state.closed=true;return result;};}});
    test.stores.push(state);return {real,proxy,state};
  }
  const json = value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  function modelResponse(payload) {
    const answer={schemaVersion:2,kind:payload.kind,title:'AI生命周期合成回答',explanation:'先跟踪两个位置与目标和的关系。',nextSteps:[],evidence:[],inferences:[],patch:null,completeSolution:null,noteDraft:null};
    if(test.referenceKind){const reference=payload.learningContext.evidenceCatalog.find(entry=>entry.kind===test.referenceKind);
      if(!reference)throw new Error('Authored response lacks supplied '+test.referenceKind+' reference');answer.evidence=[{referenceId:reference.referenceId}];}
    return json({choices:[{index:0,message:{role:'assistant',content:JSON.stringify(answer)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
  }
  // No method here calls native encryption or the original fetch. Credentials are synthetic only.
  safeStorage.isEncryptionAvailable=()=>true;safeStorage.isAsyncEncryptionAvailable=async()=>true;
  safeStorage.getSelectedStorageBackend=()=> 'gnome_libsecret';
  safeStorage.encryptString=value=>Buffer.from('synthetic:'+value);safeStorage.encryptStringAsync=async value=>Buffer.from('synthetic:'+value);
  safeStorage.decryptString=value=>value.toString('utf8').replace(/^synthetic:/,'');
  safeStorage.decryptStringAsync=async bytes=>{
    const result=bytes.toString('utf8').replace(/^synthetic:/,'');
    if(test.vaultNext){test.vaultNext=false;return new Promise((resolve,reject)=>{test.vaultGate={resolve:()=>{test.lateReleases++;resolve({result,shouldReEncrypt:false});},reject};});}
    return {result,shouldReEncrypt:false};
  };
  globalThis.fetch=async (input,init)=>{
    const url=String(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url!=='https://lifecycle-provider.invalid/v1/chat/completions'){test.blockedHttp.push(url);throw new Error('Authored fixture forbids outbound HTTP');}
    const body=JSON.parse(init.body),payload=JSON.parse(body.messages.find(message=>message.role==='user').content);
    test.providerCalls.push({kind:payload.kind,question:payload.userRequest,attemptId:payload.learningContext.attemptId,
      evidenceCatalog:structuredClone(payload.learningContext.evidenceCatalog),
      selectedReferenceId:test.referenceKind?payload.learningContext.evidenceCatalog.find(entry=>entry.kind===test.referenceKind)?.referenceId:null});
    if(test.providerNext){test.providerNext=false;return new Promise((resolve,reject)=>{test.providerGate={resolve:()=>{test.lateReleases++;resolve(modelResponse(payload));},reject};});}
    return modelResponse(payload);
  };
  async function ready(){
    await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{test.blockedHttp.push(details.url);callback({cancel:true});});
    current=observeStore(join(dataDirectory,'practice.sqlite'));current.proxy.upsertProblem(problem);
    win=new BrowserWindow({width:800,height:500,show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const originalSend=win.webContents.send.bind(win.webContents);
    win.webContents.send=(channel,...args)=>{if(channel==='ai:event')test.events.push(structuredClone(args[0]));return originalSend(channel,...args);};
    controller=new LearningController({dataDirectory,version:'0.85.0',window:win,store:()=>current.proxy,
      handle:(channel,handler)=>ipcMain.handle(channel,(event,...args)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('Unexpected synthetic IPC sender');return handler(...args);}),
      changed:()=>test.changes++,reveal:()=>{},isIdle:()=>test.allowed,log:(event,data)=>test.logs.push({event,data}),
      interviewContext:context=>{test.contextCalls++;if(test.contextNext){test.contextNext=false;return new Promise((resolve,reject)=>{test.contextGate={resolve:()=>{test.lateReleases++;resolve(context);},reject};});}return context;},
      lifecycle:{hasActiveInterview:()=>false,enterMaintenance:async()=>{await controller.pause();},closeDatabase:()=>current.proxy.close(),openDatabase:()=>{},clearCredentials:async()=>{},leaveMaintenance:()=>{}}});
    await controller.reminders.updateSettings({enabled:false});
    globalThis.lifecycleHarness={
      createAttempt(id,draftCode=code){const saved=current.proxy.getProblem(problem.id);current.proxy.saveDraft({problemId:problem.id,language:'python',scopeId:'scope-'+id,code:draftCode});
        return current.proxy.startAttempt({id,problemId:problem.id,problemVersion:saved.version,language:'python',draftScopeId:'scope-'+id,mode:'practice'});},
      referenceKind(kind){test.referenceKind=kind;},
      compileRun(attemptId,id){const attempt=current.proxy.getAttempt(attemptId),draft=current.proxy.getDraft(problem.id,'python',attempt.draftScopeId,'function');
        const digest=sha256(JSON.stringify([problem.cases,'normalized']));
        current.proxy.beginRun({id,attemptId,code:draft.code,testSuiteVersion:digest,adapterVersion:'authored-adapter',runtimeVersion:'Python 3.14.7',
          testSnapshot:{cases:problem.cases,acmCompare:'normalized',answerFormat:'function',specVersion:attempt.specVersion,testConfigDigest:null}});
        return current.proxy.finishRun(id,{status:'compile_error',result:{status:'compile_error',diagnostics:[{phase:'compile',source:'user',file:'solution.py',code:'syntax_error',line:2,column:35,message:'SyntaxError: expected colon'}],
          caseResults:[],stdout:'',stderr:'SyntaxError: expected colon'}});},
      async historicalCanonical(attemptId,id){const input={requestId:id,attemptId,kind:'diagnosis',question:'查看旧版编译诊断记录'};
        const context=buildPracticeAiContext(current.proxy,input),provider=(await controller.ai.providerState()).config;
        const snapshot=buildRequestSnapshot(input,context,provider);delete snapshot.evidenceCatalog;snapshot.promptVersion='tilian-chat-coach-v2.4';
        snapshot.messages=[{role:'system',content:'Authored historical v2.4 canonical response fixture.'},
          {role:'user',content:canonicalJson({kind:input.kind,learningContext:{attemptId,codeHash:snapshot.codeHash,run:snapshot.run}})}];
        const response=validateResponse(JSON.stringify({schemaVersion:2,kind:'diagnosis',title:'旧版编译诊断记录',explanation:'旧版记录保留了原样编译诊断。',nextSteps:[],
          evidence:[{runId:context.run.id,kind:'compiler',quote:context.run.diagnostics[0].message}],inferences:[],patch:null,completeSolution:null,noteDraft:null}),snapshot);
        current.proxy.beginAIRequest({id,attemptId,requestHash:requestHash(snapshot),snapshot});
        return current.proxy.finishAIRequest(id,{status:'completed',response,error:null,usage:null,cachedFromRequestId:null});},
      arm(stage){test[stage+'Next']=true;test[stage+'Gate']=null;},
      release(stage,fail=false){const gate=test[stage+'Gate'];if(!gate)throw new Error('No '+stage+' gate');test[stage+'Gate']=null;if(fail)gate.reject(new Error('Authored delayed preparation failure'));else gate.resolve();},
      official(attemptId,id,verdict='accepted'){const attempt=current.proxy.getAttempt(attemptId),draft=current.proxy.getDraft(problem.id,'python',attempt.draftScopeId,'function');
        current.proxy.beginOfficialSubmission({requestId:id,attemptId,slug:'two-sum',sourceId:'1',code:draft.code});
        current.proxy.updateOfficialSubmission(id,{status:'judging',submissionId:String(980000000+(++test.sequence))});
        const row=current.proxy.updateOfficialSubmission(id,{status:'completed',result:verdict==='wrong_answer'
          ?{status:'wrong_answer',statusCode:11,statusMessage:'Wrong Answer',passedCases:0,totalCases:1,input:'[2,7],9',actualOutput:'null',expectedOutput:'[0,1]'}
          :{status:'accepted',statusCode:10,statusMessage:'Accepted',passedCases:1,totalCases:1}});
        controller.officialCompleted(row);return {id,autoId:officialAnalysisRequestId(id)};},
      inspect(attemptId,requestId){return {busy:controller.ai.isAttemptBusy(attemptId),record:current.proxy.getAIRequest(requestId)||null,records:current.proxy.listAIRequests(attemptId),
        gates:{context:Boolean(test.contextGate),vault:Boolean(test.vaultGate),provider:Boolean(test.providerGate)},providerCalls:structuredClone(test.providerCalls),events:structuredClone(test.events),changes:test.changes};},
      async turn(){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));},
      async swap(){test.allowed=false;await controller.pause();const old=current,nextPath=join(dataDirectory,'rebound-'+test.stores.length+'.sqlite');
        await old.proxy.backupTo(nextPath);old.proxy.close();current=observeStore(nextPath);controller.rebind();await controller.resume();test.allowed=true;
        return {oldPath:old.state.path,newPath:nextPath,eventsAtPause:test.events.length,oldCallsAtClose:old.state.calls};},
      summary(){return {providerCalls:structuredClone(test.providerCalls),events:structuredClone(test.events),blockedHttp:structuredClone(test.blockedHttp),logs:structuredClone(test.logs),
        contextCalls:test.contextCalls,lateReleases:test.lateReleases,stores:structuredClone(test.stores)};},
      async close(){test.allowed=false;await controller.stop();current.proxy.close();},
    };
    await win.loadFile(join(__dirname,'renderer/index.html'));
  }
  ready().catch(error=>{console.error(error);app.exit(1);});
` }, outfile: join(launchDirectory, 'dist/main.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], logLevel: 'silent' });
await build({ entryPoints: [join(root, 'src/desktop/preload.ts')], outfile: join(launchDirectory, 'dist/preload.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], logLevel: 'silent' });
// Bundle the production AiPanel and its real dependencies; only the fixture host is authored.
// The hidden window never renders an editor or applies a patch.
const rendererEntry = '\0authored-ai-lifecycle-renderer';
const rendererBuild = await buildFrontend({ configFile: join(root, 'vite.config.ts'), root, logLevel: 'silent',
  plugins: [{ name: 'authored-ai-lifecycle-renderer', resolveId(id) { if (id === rendererEntry) return id; }, load(id) {
    if (id !== rendererEntry) return;
    return `import {createElement} from 'react';import {createRoot} from 'react-dom/client';import {AiPanel} from ${JSON.stringify(join(root, 'src/renderer/AiPanel.tsx'))};
      const root=createRoot(document.getElementById('fixture'));window.lifecycleUiErrors=[];
      const onError=message=>window.lifecycleUiErrors.push(message),noop=()=>{};
      window.renderLifecycleAiPanel=(attempt,code)=>root.render(createElement('div',{'data-fixture-attempt':attempt.id},createElement(AiPanel,{key:attempt.id,api:window.algo,attempt,code,selectedRun:null,
        flush:async()=>{},onApply:async()=>{throw new Error('Fixture forbids applying a patch');},onNoteSaved:noop,onSettings:noop,onError})));`;
  } }], build: { outDir: join(launchDirectory, 'dist/renderer'), emptyOutDir: true, cssCodeSplit: false,
    rollupOptions: { input: rendererEntry, output: { entryFileNames: 'lifecycle-renderer.js' } } } });
const styles = (Array.isArray(rendererBuild) ? rendererBuild : [rendererBuild]).flatMap(result => result.output ?? [])
  .filter(entry => entry.type === 'asset' && entry.fileName.endsWith('.css')).map(entry => `<link rel="stylesheet" href="${entry.fileName}">`).join('');
await writeFile(join(launchDirectory, 'dist/renderer/index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Authored AI Lifecycle Fixture</title>${styles}
  <style>body{margin:16px;font:16px sans-serif}.ai-panel{height:450px;max-width:700px}button,textarea{font:inherit}</style></head>
  <body><main id="fixture"><p>Isolated real controller lifecycle fixture</p></main><script type="module" src="lifecycle-renderer.js"></script></body></html>`);

let app, page;
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const main = (method, ...args) => app.evaluate((_electron, { method, args }) => globalThis.lifecycleHarness[method](...args), { method, args });
const inspect = (attemptId, requestId) => main('inspect', attemptId, requestId);
async function until(check, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error('Timed out: ' + description);
}
async function begin(requestId, attemptId, question) {
  await page.evaluate(({ requestId, attemptId, question }) => {
    window.lifecycleOutcomes ??= {};
    window.algo.askAi({ requestId, attemptId, kind: 'chat', question }).then(record => { window.lifecycleOutcomes[requestId] = { record }; }, error => { window.lifecycleOutcomes[requestId] = { error: String(error) }; });
  }, { requestId, attemptId, question });
}
async function outcome(requestId) {
  await until(() => page.evaluate(id => Boolean(window.lifecycleOutcomes?.[id]), requestId), 'IPC settles ' + requestId);
  return page.evaluate(id => window.lifecycleOutcomes[id], requestId);
}
try {
  const env = { ...process.env, AI_LIFECYCLE_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.waitForFunction(() => typeof window.algo?.askAi === 'function');
  await page.evaluate(() => { window.lifecycleEvents = []; window.algo.onAiEvent(event => window.lifecycleEvents.push(event)); });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await api('saveAiProvider', { id: 'authored-lifecycle-provider', baseUrl: 'https://lifecycle-provider.invalid/v1', model: 'authored-model',
    temperature: 0, maxOutputTokens: 2048, timeoutMs: 30000, jsonMode: false, includeUsage: true }, 'synthetic-lifecycle-key-never-real');
  await api('saveAiAutoAnalysis', true);
  pass('Isolated real production preload and controller IPC configure a synthetic credential without native encryption or external traffic');

  for (const action of ['cancel', 'failure']) {
    const attemptId = 'preparing-' + action, requestId = 'manual-' + attemptId;
    await main('createAttempt', attemptId); await main('arm', 'context'); await begin(requestId, attemptId, '准备态-' + action);
    await until(async () => (await inspect(attemptId, requestId)).gates.context, 'real context preparation held');
    const official = await main('official', attemptId, 'official-' + attemptId); await main('turn');
    const waiting = await inspect(attemptId, requestId);
    assert.equal(waiting.busy, true); assert.equal(waiting.record, null); assert.equal(waiting.records.length, 0);
    assert.equal(waiting.providerCalls.filter(call => call.attemptId === attemptId).length, 0);
    if (action === 'cancel') await api('cancelAi', requestId); else await main('release', 'context', true);
    const settled = await outcome(requestId); assert.ok(settled.error, JSON.stringify(settled));
    await until(async () => (await inspect(attemptId, official.autoId)).record?.status === 'completed', 'finally wakes queued auto-analysis after preparation ' + action);
    const finished = await inspect(attemptId, official.autoId);
    assert.equal(finished.record.snapshot.kind, 'official-review'); assert.equal(finished.record.snapshot.officialSubmissionId, official.id);
    assert.equal(finished.providerCalls.filter(call => call.attemptId === attemptId).length, 1);
    assert.equal(finished.events.filter(event => event.requestId === requestId).length, 0);
    if (action === 'cancel') { await main('release', 'context'); await main('turn'); }
    const rendererEvents = await page.evaluate(id => window.lifecycleEvents.filter(event => event.requestId === id), official.autoId);
    assert.ok(rendererEvents.some(event => event.phase === 'completed'));
    pass('Manual context ' + action + ': busy includes pre-database preparation, automatic analysis waits, and the actual ai:ask finally wakes it',
      { noManualDatabaseSeed: true, automaticProviderCalls: 1, officialSubmissionId: official.id });
  }

  for (const stage of ['provider', 'vault']) {
    const attemptId = 'active-' + stage, requestId = 'manual-' + attemptId;
    await main('createAttempt', attemptId); await main('arm', stage); await begin(requestId, attemptId, '等待迟到-' + stage);
    await until(async () => (await inspect(attemptId, requestId)).gates[stage], 'active real service held in ' + stage);
    const before = await inspect(attemptId, requestId); assert.equal(before.record.status, 'streaming'); assert.equal(before.busy, true);
    const queued = await main('official', attemptId, 'queued-' + attemptId); await main('turn');
    assert.equal((await inspect(attemptId, queued.autoId)).record, null);
    const swapped = await main('swap');
    const cancelled = await outcome(requestId); assert.equal(cancelled.record.status, 'cancelled'); assert.equal(cancelled.record.response, null);
    const afterPause = await inspect(attemptId, queued.autoId); assert.equal(afterPause.record, null);
    const eventCount = afterPause.events.length, providerCount = afterPause.providerCalls.length;
    await main('release', stage); await main('turn');
    // The callback is genuinely released after old SQLite is closed, not simply abandoned.
    await until(async () => (await main('summary')).lateReleases >= (stage === 'provider' ? 2 : 3), 'late substitute actually released');
    const afterRelease = await inspect(attemptId, queued.autoId);
    assert.equal(afterRelease.record, null); assert.equal(afterRelease.events.length, eventCount); assert.equal(afterRelease.providerCalls.length, providerCount);
    assert.equal(afterRelease.events.some(event => event.requestId === requestId && event.phase === 'completed'), false);
    const snapshot = await main('summary'), old = snapshot.stores.find(store => store.path === swapped.oldPath);
    assert.equal(old.closed, true); assert.deepEqual(old.postCloseAccess, []); assert.equal(old.calls, swapped.oldCallsAtClose);
    // A new manual terminal event wakes the rebound controller but must not replay the old queue.
    const freshId = 'fresh-after-' + stage;
    await begin(freshId, attemptId, '换库后新的手动问题-' + stage); const fresh = await outcome(freshId);
    assert.equal(fresh.record.status, 'completed'); await main('turn');
    assert.equal((await inspect(attemptId, queued.autoId)).record, null);
    pass('Active ' + stage + ' wait: real pause cancels before SQLite swap/rebind; releasing late callback neither touches closed store nor publishes/replays old auto queue',
      { oldPath: swapped.oldPath, newPath: swapped.newPath, oldStoreCallsAfterClose: 0, freshRequestCompleted: true });
  }
  await page.waitForFunction(() => typeof window.renderLifecycleAiPanel === 'function');
  const compilerAttemptId = 'reference-compiler', compilerCode = 'class Solution:\n    def twoSum(self, nums, target)\n        return [0, 1]\n';
  const compilerAttempt = await main('createAttempt', compilerAttemptId, compilerCode);
  const compilerRun = await main('compileRun', compilerAttemptId, 'authored-compiler-run');
  const history = await main('historicalCanonical', compilerAttemptId, 'historical-canonical-compiler');
  await page.evaluate(({ attempt, code }) => window.renderLifecycleAiPanel(attempt, code), { attempt: compilerAttempt, code: compilerCode });
  const oldTurn = page.locator(`[data-request-id="${history.id}"][data-status="completed"]`);
  await oldTurn.waitFor(); await oldTurn.getByText('回答详情', { exact: true }).click();
  await oldTurn.getByText('使用的运行证据', { exact: true }).click();
  assert.equal(await oldTurn.locator('pre.diagnostic').textContent(), 'SyntaxError: expected colon');
  assert.equal(Object.hasOwn(history.snapshot, 'evidenceCatalog'), false);
  assert.equal(history.snapshot.promptVersion, 'tilian-chat-coach-v2.4');
  pass('Real AiPanel displays a persisted historical v2.4 canonical evidence record without reference catalog migration');

  await main('referenceKind', 'compiler');
  await page.getByRole('button', { name: '检查代码', exact: true }).click();
  await until(async () => (await inspect(compilerAttemptId, '')).records.some(record => record.id !== history.id && record.status === 'completed'), 'reference-selected compiler response completes');
  const compilerState = await inspect(compilerAttemptId, '');
  const compilerRecord = compilerState.records.find(record => record.id !== history.id);
  const compilerTurn = page.locator(`[data-request-id="${compilerRecord.id}"][data-status="completed"]`);
  await compilerTurn.waitFor(); await compilerTurn.getByText('回答详情', { exact: true }).click();
  await compilerTurn.getByText('使用的运行证据', { exact: true }).click();
  assert.equal(await compilerTurn.locator('pre.diagnostic').textContent(), 'SyntaxError: expected colon');
  assert.deepEqual(compilerRecord.response.evidence, [{ runId: compilerRun.id, kind: 'compiler', quote: 'SyntaxError: expected colon' }]);
  assert.equal(compilerRecord.usage.calls, 1);
  assert.equal(compilerState.events.some(event => event.requestId === compilerRecord.id && event.phase === 'repairing'), false);
  const compilerCall = compilerState.providerCalls.find(call => call.attemptId === compilerAttemptId);
  assert.deepEqual(compilerCall.evidenceCatalog, compilerRecord.snapshot.evidenceCatalog);
  assert.equal(compilerCall.selectedReferenceId, compilerRecord.snapshot.evidenceCatalog.find(entry => entry.kind === 'compiler').referenceId);
  pass('Real AiPanel 检查代码 completes a selected local compilation reference through IPC/service/SQLite in one call without repairing',
    { requestId: compilerRecord.id, canonicalEvidence: compilerRecord.response.evidence, selectedReferenceId: compilerCall.selectedReferenceId });

  const officialAttemptId = 'reference-official', officialAttempt = await main('createAttempt', officialAttemptId);
  await page.evaluate(({ attempt, code }) => window.renderLifecycleAiPanel(attempt, code), { attempt: officialAttempt, code: 'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]\n' });
  await page.locator(`[data-fixture-attempt="${officialAttemptId}"]`).waitFor();
  await until(async () => await page.getByRole('button', { name: '检查代码', exact: true }).isEnabled(), 'official panel context loads');
  await main('referenceKind', 'official');
  const official = await main('official', officialAttemptId, 'authored-reference-wa', 'wrong_answer');
  await until(async () => (await inspect(officialAttemptId, official.autoId)).record?.status === 'completed', 'reference-selected official WA response completes');
  const officialState = await inspect(officialAttemptId, official.autoId);
  const officialTurn = page.locator(`[data-request-id="${official.autoId}"][data-status="completed"]`);
  await officialTurn.waitFor(); await officialTurn.getByText('回答详情', { exact: true }).click();
  await officialTurn.getByText('使用的运行证据', { exact: true }).click();
  const officialCall = officialState.providerCalls.find(call => call.attemptId === officialAttemptId);
  const officialReference = officialCall.evidenceCatalog.find(entry => entry.referenceId === officialCall.selectedReferenceId);
  const { referenceId: _officialReferenceId, ...canonicalOfficial } = officialReference;
  assert.deepEqual(officialState.record.response.evidence, [canonicalOfficial]);
  assert.equal(canonicalOfficial.kind, 'official'); assert.equal(canonicalOfficial.runId, official.id);
  assert.equal(Object.hasOwn(canonicalOfficial, 'caseIndex'), false); assert.equal(Object.hasOwn(canonicalOfficial, 'referenceId'), false);
  assert.equal(JSON.parse(canonicalOfficial.quote).status, 'wrong_answer');
  assert.equal(await officialTurn.locator('pre.diagnostic').textContent(), canonicalOfficial.quote);
  assert.deepEqual(officialCall.evidenceCatalog, officialState.record.snapshot.evidenceCatalog);
  assert.equal(officialState.record.usage.calls, 1);
  assert.equal(officialState.events.some(event => event.requestId === official.autoId && event.phase === 'repairing'), false);
  assert.deepEqual(await page.evaluate(() => window.lifecycleUiErrors), []);
  pass('Real AiPanel automatically displays the exact official WA canonical citation selected from the sent reference catalog without repair',
    { requestId: official.autoId, canonicalEvidence: officialState.record.response.evidence, selectedReferenceId: officialCall.selectedReferenceId });
  await main('referenceKind', null);
  report.observed = await main('summary');
  assert.deepEqual(report.observed.blockedHttp, []); assert.deepEqual(report.rendererErrors, []);
  assert.ok(report.observed.stores.every(store => store.postCloseAccess.length === 0));
  await main('close'); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; console.error(error);
  if (app) { try { report.observed = await main('summary'); } catch {} }
} finally {
  if (app) await app.close().catch(() => {});
  report.finishedAt = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions.length, report: join(directory, 'report.json'), ...(report.failure ? { failure: report.failure } : {}) }));
}
