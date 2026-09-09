import test from 'node:test';
import assert from 'node:assert/strict';
import { runCode } from '../../src/runner/index.ts';
import { runProcess } from '../../src/runner/process.ts';
import { quoteWindowsArgument } from '../../src/runner/windows-job.ts';
import { inspectRuntime } from '../../src/runner/runtime-inspect.ts';
import type { RunEvent, RunRequest } from '../../src/runner/types.ts';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp,readFile,rm,stat } from 'node:fs/promises';

const identity=(language:'python'|'java'):RunRequest=>({language,mode:'function',code:language==='python'?'class Solution:\n    def solve(self,x):\n        return x':'class Solution {\n    public int solve(int x) {\n        return x;\n    }\n}',adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[1],expected:1},{args:[2]}]});
for(const language of ['python','java'] as const){
 test(`${language}: ordered events carry run ID and one terminal state`,async()=>{
  const events:RunEvent[]=[];const r=await runCode(identity(language),{runId:'archive-123',onEvent:e=>events.push(e)});
  assert.equal(r.status,'completed');assert.deepEqual(r.caseResults.map(c=>c.status),['passed','completed']);
  assert.deepEqual(events.map(e=>e.phase),['queued','compile','run','run','finished']);
  assert.deepEqual(events.filter(e=>e.phase==='run').map(e=>e.caseIndex),[0,1]);
  assert.ok(events.every((e,i)=>e.runId==='archive-123'&&e.sequence===i+1&&Number.isFinite(Date.parse(e.at))));
  assert.equal(events.at(-1)?.status,r.status);
 });
 for(const phase of ['queued','compile','run'] as const)test(`${language}: cancellation at ${phase} resolves once`,async()=>{
  const controller=new AbortController(),events:RunEvent[]=[];
  const r=await runCode(identity(language),{signal:controller.signal,onEvent:e=>{events.push(e);if(e.phase===phase){controller.abort();controller.abort();}}});
  assert.equal(r.status,'cancelled',JSON.stringify(r));assert.equal(events.filter(e=>e.phase==='finished').length,1);assert.equal(events.at(-1)?.status,'cancelled');
  assert.ok(!events.some(e=>e.phase==='run'&&e.caseIndex===1));
 });
 test(`${language}: compilation maps original source line and column`,async()=>{
  const q=identity(language);q.code=language==='python'?'class Solution:\n    def solve(self,x):\n        return (x + )':'class Solution {\n    public int solve(int x) {\n        return missingValue;\n    }\n}';
  const r=await runCode(q);assert.equal(r.status,'compile_error',JSON.stringify(r));
  assert.ok(r.diagnostics.some(d=>d.source==='user'&&d.line===3&&typeof d.column==='number'&&d.column>0),JSON.stringify(r.diagnostics));
 });
 test(`${language}: exception maps original source frame`,async()=>{
  const q=identity(language);q.code=language==='python'?'class Solution:\n    def solve(self,x):\n        文本="🌳"; return 1/0':'class Solution {\n    public int solve(int x) {\n        throw new IllegalStateException("test");\n    }\n}';
  const r=await runCode(q);assert.equal(r.status,'runtime_error',JSON.stringify(r));const d=r.diagnostics[0];assert.equal(d.source,'user');assert.equal(d.line,3);
  if(language==='python'){assert.equal(d.column,q.code.split('\n')[2].indexOf('1/0')+1);assert.equal(d.endColumn,d.column!+3);}else assert.equal(d.column,undefined);
 });
 test(`${language}: wrapper signature failure has no editor position`,async()=>{
  const q=identity(language);q.adapter!.method='missing';const r=await runCode(q);
  assert.equal(r.status,'internal_error',JSON.stringify(r));assert.ok(r.diagnostics.every(d=>d.source==='runner'&&d.line===undefined&&d.column===undefined));
 });
 test(`${language}: structured output is included in output limit`,async()=>{
  const q=identity(language);q.adapter={method:'solve',params:['int'],returns:'string'};q.outputLimitBytes=4096;q.cases=[{args:[1]}];q.code=language==='python'?'class Solution:\n    def solve(self,x): return "🌳"*10000':'class Solution {public String solve(int x){return "🌳".repeat(10000);}}';
  const r=await runCode(q);assert.equal(r.status,'output_limit',JSON.stringify(r));assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=4096);
 });
 test(`${language}: normalized ACM preserves meaningful leading whitespace`,async()=>{
  const r=await runCode({language,mode:'acm',code:language==='python'?'print("  42  ")':'public class Main {public static void main(String[] a){System.out.println("  42  ");}}',cases:[{expected:'42'}]});assert.equal(r.status,'wrong_answer');
 });
 test(`${language}: int32 limits and int64 upper limit roundtrip`,async()=>{
  const q=identity(language);q.cases=[{args:[-2147483648],expected:-2147483648},{args:[2147483647],expected:2147483647}];assert.equal((await runCode(q)).status,'passed');
  q.adapter={method:'solve',params:['int64'],returns:'int64'};q.cases=[{args:['9223372036854775807'],expected:'9223372036854775807'}];if(language==='java')q.code='class Solution {public long solve(long x){return x;}}';assert.equal((await runCode(q)).status,'passed');
 });
 test(`${language}: reject out-of-range types before running`,async()=>{
  const events:RunEvent[]=[];const q=identity(language);q.cases=[{args:[2147483648]}];const r=await runCode(q,{onEvent:e=>events.push(e)});assert.equal(r.status,'invalid_request');assert.deepEqual(events.map(e=>e.phase),['queued','finished']);
  q.adapter={method:'solve',params:['int64'],returns:'int64'};q.cases=[{args:['9223372036854775808']}];assert.equal((await runCode(q)).status,'invalid_request');
 });
 test(`${language}: nested arrays of generic lists roundtrip`,async()=>{
  const q=identity(language);const kind={array:{list:{list:'int' as const}}};q.adapter={method:'solve',params:[kind],returns:kind};q.cases=[{args:[[[[1,2]],[]]],expected:[[[1,2]],[]]},{args:[[]],expected:[]}];if(language==='java')q.code='class Solution {public List<List<Integer>>[] solve(List<List<Integer>>[] x){return x;}}';const r=await runCode(q);assert.equal(r.status,'passed',JSON.stringify(r));
 });
 test(`${language}: list containing a single string array preserves nesting`,async()=>{
  const q=identity(language);const kind={list:{array:'string' as const}};q.adapter={method:'solve',params:[kind],returns:kind};q.cases=[{args:[[['a','🌳']]],expected:[['a','🌳']]},{args:[[[]]],expected:[[]]}];if(language==='java')q.code='class Solution {public List<String[]> solve(List<String[]> x){return x;}}';const r=await runCode(q);assert.equal(r.status,'passed',JSON.stringify(r));
 });
}
test('run request is snapshotted before asynchronous work',async()=>{
 const request=identity('python');const pending=runCode(request);request.code='invalid !';request.cases![0].args![0]=999;const r=await pending;assert.equal(r.status,'completed');assert.equal(r.caseResults[0].actual,1);
});
test('observer exceptions do not alter final state',async()=>{assert.equal((await runCode(identity('python'),{onEvent:()=>{throw new Error('observer');}})).status,'completed');});
test('Python syntax column uses editor UTF16 offsets',async()=>{
 const code='class Solution:\n    def solve(self,x):\n        文本="🌳"; return (x + )';const r=await runCode({...identity('python'),code});assert.equal(r.status,'compile_error');assert.equal(r.diagnostics[0].line,3);assert.equal(r.diagnostics[0].column,code.split('\n')[2].indexOf(')')+1);
});
test('Java compiler tab columns map to editor UTF16 offsets',async()=>{
 const code='class Solution {\n\tpublic int solve(int x) {\n\t\tString 文本="🌳"; return missing;\n\t}\n}';const r=await runCode({...identity('java'),code});assert.equal(r.status,'compile_error');assert.equal(r.diagnostics[0].line,3);assert.equal(r.diagnostics[0].column,code.split('\n')[2].indexOf('missing')+1);
});
test('invalid UTF8 cannot expand captured strings beyond output budget',async()=>{
 const r=await runProcess(process.execPath,['-e','process.stdout.write(Buffer.alloc(3000,255))'],{cwd:os.tmpdir(),timeoutMs:10000,outputLimitBytes:4096});assert.equal(r.reason,'output_limit');assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=4096);
});
test('output budget allows the exact limit and rejects one extra byte',async()=>{
 for(const length of [4096,4097]){const r=await runProcess(process.execPath,['-e',`process.stdout.write('x'.repeat(${length}))`],{cwd:os.tmpdir(),timeoutMs:20000,outputLimitBytes:4096});assert.equal(r.reason,length===4096?undefined:'output_limit');assert.equal(Buffer.byteLength(r.stdout),4096);}
});
test('inspection of a missing installation returns diagnostics',async()=>{const r=await inspectRuntime('java',{runtimePath:'/does-not-exist/bin/java'});assert.equal(r.status,'missing');assert.equal(r.diagnostics[0].source,'runner');});
test('inspection cancellation is a structured result',async()=>{const r=await inspectRuntime('python',{signal:AbortSignal.abort()});assert.equal(r.status,'cancelled');});
test('Windows argument quoting escapes quotes and trailing slashes',()=>{
 assert.equal(quoteWindowsArgument(''),'""');assert.equal(quoteWindowsArgument('a b'),'"a b"');assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');assert.equal(quoteWindowsArgument('C:\\中文\\'),'"C:\\中文\\\\"');assert.throws(()=>quoteWindowsArgument('a\0b'),/NUL/);
});
test('cancellation removes an active ordinary grandchild process',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-tree-')),marker=path.join(root,'survived'),flag=path.join(root,'ready'),controller=new AbortController();
 const leaf=`require('node:fs').writeFileSync(${JSON.stringify(flag)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),1000)`;
 const middle=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
 const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
 const pending=runProcess(process.execPath,['-e',parent],{cwd:root,timeoutMs:20000,outputLimitBytes:16384,signal:controller.signal});
 try{
  const deadline=Date.now()+15000;while(!(await stat(flag).then(()=>true,()=>false))){assert.ok(Date.now()<deadline,'grandchild never became ready');await new Promise(r=>setTimeout(r,20));}
  controller.abort();const r=await pending;assert.equal(r.reason,'cancelled');await new Promise(r=>setTimeout(r,1200));assert.equal(await stat(marker).then(()=>true,()=>false),false);
 }finally{controller.abort();await pending;if(await stat(flag).then(()=>true,()=>false)){try{process.kill(Number(await readFile(flag,'utf8')),'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});}
});
