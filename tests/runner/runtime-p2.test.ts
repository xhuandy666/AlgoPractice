import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,utimes,open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { installRuntime,recoverRuntimeInstallations,runtimeManifest,inspectRuntime } from '../../src/runner/managed-runtime.ts';
import type { InstallProgress } from '../../src/runner/managed-runtime.ts';

const temp=()=>mkdtemp(path.join(os.tmpdir(),'algopractice-p2-install-'));
const read=(p:string)=>readFile(p,'utf8');
const present=async(p:string)=>stat(p).then(()=>true,()=>false);
async function fixture(root:string,phase='prepared'){
 const id=randomUUID(),staging=`.python-install-${id}`,backup=`.python-backup-${id}`;
 await mkdir(path.join(root,staging));await writeFile(path.join(root,staging,'partial'),'partial');
 const journal={schema:1,id,pid:2147483647,language:'python',staging,backup,phase,createdAt:new Date().toISOString()};
 await writeFile(path.join(root,'.python-install.json'),JSON.stringify(journal));
 await writeFile(path.join(root,'.python-install.lock'),JSON.stringify({pid:2147483647}));return journal;
}
for(const state of ['prepared','old-moved','new-moved','committed','conflicting-destination'] as const)test(`recovery fixture: ${state} preserves an installation`,async()=>{
 const root=await temp();try{
  const j=await fixture(root,state==='prepared'?'prepared':state==='committed'?'committed':'switching');
  const old=path.join(root,state==='prepared'?'python':j.backup);await mkdir(old);await writeFile(path.join(old,'sentinel'),'old');
  if(['new-moved','committed','conflicting-destination'].includes(state)){
   await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python/sentinel'),'new');
   if(state!=='conflicting-destination')await writeFile(path.join(root,'python/.algopractice-runtime.json'),JSON.stringify({installationId:j.id}));
  }
  const result=(await recoverRuntimeInstallations(root))[0];
  assert.equal(result.status,state==='prepared'?'discarded':state==='old-moved'?'rolled_back':state==='conflicting-destination'?'needs_attention':'committed');
  assert.equal(await read(path.join(root,'python/sentinel')),state==='prepared'||state==='old-moved'?'old':'new');
  if(state==='conflicting-destination'){assert.equal(await read(path.join(root,j.backup,'sentinel')),'old');assert.equal(await present(path.join(root,j.staging)),true);}
  else {assert.deepEqual((await readdir(root)).sort(),['python']);assert.equal((await recoverRuntimeInstallations(root))[0].status,'none');}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('recovery refuses journal paths outside the installation root',async()=>{
 const root=await temp();try{const j=await fixture(root);await writeFile(path.join(root,'.python-install.json'),JSON.stringify({...j,staging:'../unowned'}));const before=(await readdir(root)).sort();assert.equal((await recoverRuntimeInstallations(root))[0].status,'needs_attention');assert.deepEqual((await readdir(root)).sort(),before);}finally{await rm(root,{recursive:true,force:true});}
});
test('recovery leaves a live installer untouched',async()=>{
 const root=await temp();try{await fixture(root);await writeFile(path.join(root,'.python-install.lock'),JSON.stringify({pid:process.pid}));const before=(await readdir(root)).sort();assert.equal((await recoverRuntimeInstallations(root))[0].status,'active');assert.deepEqual((await readdir(root)).sort(),before);}finally{await rm(root,{recursive:true,force:true});}
});
test('empty new lock is active; abandoned old lock is recoverable',async()=>{
 const root=await temp();try{const lock=path.join(root,'.python-install.lock');await writeFile(lock,'');assert.equal((await recoverRuntimeInstallations(root))[0].status,'active');const past=new Date(Date.now()-60000);await utimes(lock,past,past);assert.equal((await recoverRuntimeInstallations(root))[0].status,'none');assert.deepEqual(await readdir(root),[]);}finally{await rm(root,{recursive:true,force:true});}
});
test('wrong-size offline archive is refused before extraction',async()=>{
 const root=await temp();const archive=path.join(root,'bad.tar.gz');try{await writeFile(archive,'bad');await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python/sentinel'),'old');await assert.rejects(installRuntime('python',{root,localArchive:archive}),/size/);assert.equal(await read(path.join(root,'python/sentinel')),'old');assert.deepEqual((await readdir(root)).sort(),['bad.tar.gz','python']);}finally{await rm(root,{recursive:true,force:true});}
});
test('same-size wrong-hash offline archive is refused before extraction',async()=>{
 const root=await temp(),archive=path.join(root,'bad.tar.gz');try{
  const target=`${process.platform}-${process.arch}` as keyof typeof runtimeManifest.python.targets;const item=runtimeManifest.python.targets[target];if(!item)return;
  const file=await open(archive,'w');await file.truncate(item.size);await file.close();
  const phases:string[]=[];await assert.rejects(installRuntime('python',{root,localArchive:archive,onProgress:p=>phases.push(p.phase)}),/checksum/);assert.ok(phases.includes('verify'));assert.ok(!phases.includes('extract'));assert.deepEqual(await readdir(root),['bad.tar.gz']);
 }finally{await rm(root,{recursive:true,force:true});}
});
const archiveRoot=process.env.ALGOPRACTICE_OFFLINE_ARCHIVES;
for(const language of ['python','java'] as const)test(`${language}: real pinned offline archive installs without fetch`,{skip:!archiveRoot?'Set ALGOPRACTICE_OFFLINE_ARCHIVES to a directory containing python.tar.gz and java.tar.gz':false},async()=>{
 const root=await temp(),original=globalThis.fetch;globalThis.fetch=(async()=>{throw new Error('Network forbidden in offline test');}) as typeof fetch;
 try{
  await mkdir(path.join(root,language));await writeFile(path.join(root,language,'sentinel'),'old');const phases:InstallProgress['phase'][]=[];
  const installed=await installRuntime(language,{root,localArchive:path.join(archiveRoot!,`${language}.tar.gz`),onProgress:p=>{phases.push(p.phase);if(p.phase==='copy')throw new Error('observer failure');}});
  assert.equal(installed.source,'offline-archive');assert.equal((await inspectRuntime(language,{root})).status,'ready');assert.equal(await present(path.join(root,language,'sentinel')),false);
  assert.deepEqual([...new Set(phases)],['copy','verify','extract','validate','commit','ready']);assert.deepEqual(await readdir(root),[language]);
 }finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true});}
});
for(const phase of ['copy','extract','validate'] as const)test(`real offline cancellation at ${phase} preserves existing installation`,{skip:!archiveRoot?'Requires pinned offline archive':false},async()=>{
 const root=await temp();try{await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python/sentinel'),'old');const controller=new AbortController();await assert.rejects(installRuntime('python',{root,localArchive:path.join(archiveRoot!,'python.tar.gz'),signal:controller.signal,onProgress:p=>{if(p.phase===phase)controller.abort();}}),/abort/i);assert.equal(await read(path.join(root,'python/sentinel')),'old');assert.deepEqual(await readdir(root),['python']);}finally{await rm(root,{recursive:true,force:true});}
});
test('real installer process termination is recovered on next launch',{skip:!archiveRoot?'Requires pinned offline archive':false},async()=>{
 const root=await temp();try{
  await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python/sentinel'),'old');
  const source=`import {installRuntime} from ${JSON.stringify(new URL('../../src/runner/managed-runtime.ts',import.meta.url).href)}; await installRuntime('python',{root:${JSON.stringify(root)},localArchive:${JSON.stringify(path.join(archiveRoot!,'python.tar.gz'))},onProgress:p=>{if(p.phase==='validate')process.exit(23)}});`;
  const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'pipe'});let error='';child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('close',c=>c===23?resolve(c):reject(new Error(`Installer exit ${c}: ${error}`)));});assert.equal(code,23);
  assert.equal(await present(path.join(root,'.python-install.json')),true);assert.equal((await recoverRuntimeInstallations(root))[0].status,'discarded');assert.equal(await read(path.join(root,'python/sentinel')),'old');assert.deepEqual(await readdir(root),['python']);
 }finally{await rm(root,{recursive:true,force:true});}
});
