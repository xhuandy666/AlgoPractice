import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installRuntime } from '../../src/runner/managed-runtime.ts';
const evidence:object[]=[];

test('checksum failure preserves existing runtime and removes staging',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-install-check-')); await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python/sentinel'),'existing runtime');
 const original=globalThis.fetch;
 globalThis.fetch=(async()=>new Response('deliberately incorrect archive',{status:200})) as typeof fetch;
 try{
  await assert.rejects(installRuntime('python',{root}),/checksum\/size mismatch/);
  assert.equal(await readFile(path.join(root,'python/sentinel'),'utf8'),'existing runtime');assert.deepEqual(await readdir(root),['python']);
  evidence.push({name:'checksum failure',method:'fault-injected fetch; no real artifact executed',existingRuntimePreserved:true,stagingRemoved:true,passed:true});
 }finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true});}
});
test('download cancellation preserves existing runtime and removes staging',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-install-cancel-'));await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python/sentinel'),'existing runtime');
 const original=globalThis.fetch;const controller=new AbortController();
 globalThis.fetch=(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024));c.enqueue(new Uint8Array(1024));c.close();}}))) as typeof fetch;
 try{
  await assert.rejects(installRuntime('python',{root,signal:controller.signal,onProgress:p=>{if(p.phase==='download')controller.abort();}}),/abort/i);
  assert.equal(await readFile(path.join(root,'python/sentinel'),'utf8'),'existing runtime');assert.deepEqual(await readdir(root),['python']);
  evidence.push({name:'download cancellation',method:'fault-injected fetch stream',existingRuntimePreserved:true,stagingRemoved:true,passed:true});
 }finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true});}
});
after(async()=>{await writeFile('evidence/runtime-install-faults.json',JSON.stringify({createdAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,evidence},null,2)+'\n');});
