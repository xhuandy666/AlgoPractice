import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// Real React hook with a deliberately deferred installer. No runtime, network or user code runs.
// ALGOPRACTICE_TEST_BROWSER=chrome reuses an installed Chrome instead of downloading a browser.
const compiled = await build({ stdin: { resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx', sourcefile: 'runtime-gate-fixture.tsx', contents: `
  import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {useRuntimeGate} from './src/renderer/useRuntimeGate';
  const root=createRoot(document.getElementById('root'));
  let serial=0, token=0, fingerprint=0, auto=false;
  const ready=new Set(), jobs=new Map(), calls=[], executed=[], errors=[];
  const runtime=language=>({status:ready.has(language)?'ready':'missing',source:null,path:null,version:null,message:'fixture',managedInstalled:false,installedBytes:null,artifact:null});
  const api={
    prepareRun:async(id,language,code)=>{const key='token-'+(++token);calls.push(['prepare',language,key,code]);return {token:key,runtime:runtime(language),autoInstall:auto};},
    cancelPreparedRun:async key=>{calls.push(['cancel',key]);},
    installRuntime:async language=>{calls.push(['install',language]);return new Promise(resolve=>jobs.set(language,()=>{ready.add(language);resolve(true);}));},
    runtimePreflight:async language=>runtime(language),
    onRuntimeProgress:()=>()=>{},onClosing:()=>()=>{},onMaintenance:()=>()=>{},
  };
  function Fixture(){const [code,setCode]=useState('original'),[language,setLanguage]=useState('python');
    const gate=useRuntimeGate(api,()=>String(fingerprint),error=>errors.push(error));
    const request=async(target=language)=>gate.request({problemId:'fixture',language:target,code,scope:'practice',version:'v1',answerFormat:'acm',fingerprint:String(fingerprint)},async key=>{executed.push({language:target,code,token:key});});
    window.gui={request,install:()=>gate.install(),dismiss:gate.dismiss,state:()=>({installing:gate.installing,pending:gate.pending?.prepared.token,intentCurrent:gate.intentCurrent}),
      edit(next){fingerprint++;gate.invalidate();setCode(next);}};
    return <><textarea aria-label="code" value={code} onChange={event=>window.gui.edit(event.target.value)}/>
      <select aria-label="language" value={language} onChange={event=>{fingerprint++;gate.invalidate();setLanguage(event.target.value);}}><option>python</option><option>java</option></select>
      <button disabled={gate.installing[language]} onClick={()=>void request()}>{gate.installing[language]?'环境安装中…':'运行'}</button></>;
  }
  window.fixture={calls,executed,errors,reset(options={}){serial++;token=0;fingerprint++;auto=options.auto===true;ready.clear();jobs.clear();calls.length=0;executed.length=0;errors.length=0;root.render(<Fixture key={serial}/>);},finish(language){const done=jobs.get(language);if(!done)throw Error('No deferred installation');jobs.delete(language);done();},ready(language){ready.add(language);}};
  window.fixture.reset();
` }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' });
const browser = await chromium.launch({headless:true,...(process.env.ALGOPRACTICE_TEST_BROWSER?{channel:process.env.ALGOPRACTICE_TEST_BROWSER}:{})});
const page = await browser.newPage(); const pageErrors=[]; page.on('pageerror', error=>pageErrors.push(error.message));
const wait = predicate=>page.waitForFunction(predicate);
const pass=[];
try {
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({content:compiled.outputFiles[0].text});
  await page.getByLabel('code',{exact:true}).waitFor();
  await page.evaluate(async()=>{await window.gui.request();void window.gui.install();});
  await wait(()=>window.gui.state().installing.python===true);
  await page.evaluate(async()=>{await window.gui.request();await window.gui.request();});
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='prepare').length),1);
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='install').length),1);
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='cancel').length),0);
  assert.equal(await page.getByRole('button',{name:'环境安装中…',exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('code',{exact:true}).isEnabled(),true);
  assert.equal(await page.getByLabel('language',{exact:true}).isEnabled(),true);
  await page.evaluate(()=>window.fixture.finish('python'));
  await wait(()=>!window.gui.state().installing.python && window.fixture.executed.length===1);
  assert.equal(await page.evaluate(()=>window.gui.state().pending),undefined);
  pass.push('Repeated requests during installation neither replace its token nor duplicate its continuation; unchanged code runs once');
  await page.evaluate(()=>window.fixture.reset());
  await wait(()=>window.gui.state().pending===undefined);
  await page.evaluate(async()=>{await window.gui.request();void window.gui.install();});
  await wait(()=>window.gui.state().installing.python===true);
  await page.getByLabel('code',{exact:true}).fill('edited');
  await page.evaluate(()=>window.gui.request());
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='prepare').length),1);
  await page.evaluate(()=>window.fixture.finish('python'));
  await wait(()=>!window.gui.state().installing.python);
  assert.deepEqual(await page.evaluate(()=>window.fixture.executed),[]);
  assert.equal(await page.evaluate(()=>window.gui.state().intentCurrent),false);
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await wait(()=>window.fixture.executed.length===1);
  assert.equal(await page.evaluate(()=>window.fixture.executed[0].code),'edited');
  pass.push('Editing invalidates the old continuation; requests stay blocked until installation finishes, then a fresh run uses the edited code');
  await page.evaluate(()=>{window.fixture.reset({auto:true});window.fixture.ready('java');});
  await wait(()=>window.gui.state().pending===undefined);
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await wait(()=>window.gui.state().installing.python===true);
  await page.evaluate(()=>window.gui.request());
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==='prepare').length),1);
  await page.getByLabel('language',{exact:true}).selectOption('java');
  assert.equal(await page.getByRole('button',{name:'运行',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await wait(()=>window.fixture.executed.length===1);
  assert.equal(await page.evaluate(()=>window.fixture.executed[0].language),'java');
  await page.evaluate(()=>window.fixture.finish('python'));
  await wait(()=>!window.gui.state().installing.python);
  assert.equal(await page.evaluate(()=>window.fixture.executed.length),1);
  pass.push('Automatic installation has the same duplicate guard; switching to ready Java remains usable and never replays old Python');
  assert.deepEqual(await page.evaluate(()=>window.fixture.errors),[]); assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({result:'passed',assertions:pass,pageErrors},null,2));
} finally {await browser.close();}
