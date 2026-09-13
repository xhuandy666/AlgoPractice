import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './process.ts';
import { compare, normalizeTyped, observedType, validateType, validateValue } from './values.ts';
import { javaWrapper, pythonWrapper, JAVA_NODES } from './wrappers.ts';
import { javaDiagnostics, PYTHON_ACM_WRAPPER, PYTHON_COMPILE_CHECK, readPythonDiagnostic } from './diagnostics.ts';
import { compilerPath, defaultRuntimePath } from './runtime-paths.ts';
import { inspectRuntime } from './runtime-inspect.ts';
import type { Diagnostic, RunEvent, RunOptions, RunRequest, RunResult, RunStatus, WireValue } from './types.ts';
export type * from './types.ts';
export { defaultRuntimePath } from './runtime-paths.ts';
export { inspectRuntime } from './runtime-inspect.ts';
function validate(request: RunRequest): void {
  if (!request || !['python','java'].includes(request.language) || !['acm','function'].includes(request.mode)) throw new Error('Unsupported language or mode');
  if (typeof request.code !== 'string' || Buffer.byteLength(request.code) > 1048576) throw new Error('Code must be a string at most 1 MiB');
  for (const [name, value, maximum] of [['timeoutMs',request.timeoutMs,120000],['compileTimeoutMs',request.compileTimeoutMs,120000],['outputLimitBytes',request.outputLimitBytes,1048576]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) throw new Error(`Invalid ${name}`);
  }
  if (request.stdin !== undefined && (typeof request.stdin !== 'string' || Buffer.byteLength(request.stdin) > 1048576)) throw new Error('stdin exceeds 1 MiB');
  if(request.acmCompare!==undefined && !['normalized','exact'].includes(request.acmCompare))throw new Error('Unsupported ACM comparator');
  if (request.cases && (!Array.isArray(request.cases) || request.cases.length > 100)) throw new Error('At most 100 test cases');
  if (Buffer.byteLength(JSON.stringify(request)) > 4194304) throw new Error('Request exceeds 4 MiB');
  if (request.mode === 'function') {
    const adapter = request.adapter;
    if (!adapter || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(adapter.method) || !Array.isArray(adapter.params) || adapter.params.length > 20) throw new Error('Function adapter requires a valid method and parameter types');
    adapter.params.forEach(t => validateType(t)); if(adapter.returns!=='void')validateType(adapter.returns);
    if (adapter.inPlaceArg !== undefined && (!Number.isInteger(adapter.inPlaceArg) || adapter.inPlaceArg < 0 || adapter.inPlaceArg >= adapter.params.length)) throw new Error('Invalid in-place argument index');
    const outputType=observedType(adapter);
    if(adapter.inPlaceRange){
      const range=adapter.inPlaceRange;
      if(adapter.inPlaceArg===undefined || typeof adapter.params[adapter.inPlaceArg]==='string')throw new Error('In-place range requires an array/list parameter');
      if(range.start!==undefined && (!Number.isInteger(range.start)||range.start<0))throw new Error('Invalid range start');
      if(range.end!=='return' && (!Number.isInteger(range.end)||range.end<(range.start??0)))throw new Error('Invalid range end');
      if(range.end==='return' && adapter.returns!=='int')throw new Error('Active prefix requires an int return type');
    }
    if (adapter.compare) {
      if (!['exact','float','multiset'].includes(adapter.compare.kind)) throw new Error('Unsupported comparator');
      for (const n of [adapter.compare.absoluteTolerance, adapter.compare.relativeTolerance]) if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new Error('Tolerance must be finite and nonnegative');
    }
    if (!request.cases?.length) throw new Error('Function mode requires cases');
    for (const test of request.cases) {
      if (!Array.isArray(test.args) || test.args.length !== adapter.params.length) throw new Error('Argument count mismatch');
      test.args.forEach((v,i) => validateValue(v,adapter.params[i]));
      if (test.expected !== undefined) validateValue(test.expected, outputType);
    }
  } else {
    for (const test of request.cases ?? []) {
      if (test.stdin !== undefined && (typeof test.stdin !== 'string' || Buffer.byteLength(test.stdin) > 1048576)) throw new Error('Invalid case stdin');
      if (test.expected !== undefined && typeof test.expected !== 'string') throw new Error('ACM expected must be a string');
    }
  }
}
const normalizeOutput = (s: string) => s.replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,'').replace(/\n+$/,'');
export async function runCode(request: RunRequest, options: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const runId = options.runId ?? randomUUID(); let sequence = 0;
  const emit = (phase: RunEvent['phase'], extra: Partial<RunEvent> = {}) => {
    try { options.onEvent?.({ runId, sequence: ++sequence, at: new Date().toISOString(), phase, ...extra }); } catch { /* Observers cannot change a run's state. */ }
  };
  const result: RunResult = { status:'internal_error', diagnostics:[], stdout:'', stderr:'', caseResults:[], runtimeVersion:'', durationMs:0, executionScope:'local-user-code-not-sandboxed', hostPlatform:`${process.platform}-${process.arch}` };
  let directory: string | undefined;
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    emit('queued');
    try { validate(request); request = structuredClone(request); } catch(error) { result.status='invalid_request';result.diagnostics.push({phase:'request',source:'runner',message:String(error)});return result; }
    if (options.signal?.aborted) { result.status='cancelled';return result; }
    directory = await mkdtemp(path.join(os.tmpdir(),'algopractice-run-'));
    const executable = request.runtimePath ?? defaultRuntimePath(request.language);
    const compiler = compilerPath(executable);
    const processOptions = { cwd:directory,timeoutMs:request.timeoutMs ?? 10000,outputLimitBytes:request.outputLimitBytes ?? 1048576,signal:options.signal };
    const inspection = await inspectRuntime(request.language, { runtimePath: executable, signal: options.signal });
    result.runtimeVersion=inspection.runtimeVersion;
    if(inspection.status!=='ready'){result.status=inspection.status==='cancelled'?'cancelled':'environment_error';result.diagnostics.push(...inspection.diagnostics);return result;}
    const tests=request.cases?.length ? request.cases : [{stdin:request.stdin ?? ''}];
    if(request.language==='python') {
      await writeFile(path.join(directory,request.mode==='acm'?'main.py':'solution.py'),request.code);
      await writeFile(path.join(directory,'compile-check.py'),PYTHON_COMPILE_CHECK);
      await writeFile(path.join(directory,'wrapper.py'),request.mode==='function'?pythonWrapper(request.adapter!,tests):PYTHON_ACM_WRAPPER);
    } else {
      if(request.mode==='acm') await writeFile(path.join(directory,'Main.java'),request.code);
      else {
        await writeFile(path.join(directory,'Solution.java'),'import java.util.*;\nimport java.math.*;\n'+request.code);
        await writeFile(path.join(directory,'Nodes.java'),JAVA_NODES);
        await writeFile(path.join(directory,'Main.java'),javaWrapper(request.adapter!,tests));
      }
    }
    const diagnosticsFrom = async (file: string, stderr: string, phase: 'compile' | 'run'): Promise<Diagnostic[]> => {
      if(request.language==='java') return javaDiagnostics(stderr,phase,request);
      try { if((await stat(file)).size<=32768){const diagnostic=readPythonDiagnostic(JSON.parse(await readFile(file,'utf8')),request,phase);if(diagnostic)return [diagnostic];} } catch {}
      return [{phase,source:'user',message:stderr||`${phase} failed without diagnostic output`}];
    };
    const compileDiagnostic=path.join(directory,'compile-diagnostic.json');
    emit('compile');
    const compilation = await runProcess(request.language==='python'?executable:compiler,
      request.language==='python'?['-I','-X','utf8','compile-check.py',request.mode==='acm'?'main.py':'solution.py',compileDiagnostic]:['-XDrawDiagnostics','-encoding','UTF-8','-proc:none',...(request.mode==='acm'?['Main.java']:['Main.java','Solution.java','Nodes.java'])],
      {...processOptions,timeoutMs:request.compileTimeoutMs ?? 30000});
    result.stdout=compilation.stdout;result.stderr=compilation.stderr;
    if(compilation.reason || compilation.code!==0) {
      result.status=compilation.reason==='spawn_error'?'environment_error':compilation.reason ?? 'compile_error';
      result.diagnostics.push(...await diagnosticsFrom(compileDiagnostic,compilation.stderr,'compile'));
      if(result.status==='compile_error' && result.diagnostics.every(d=>d.source==='runner'))result.status='internal_error';
      return result;
    }
    const executionDeadline = new AbortController();
    executionTimer=setTimeout(()=>executionDeadline.abort(),request.timeoutMs ?? 10000);
    const executionSignal=options.signal?AbortSignal.any([options.signal,executionDeadline.signal]):executionDeadline.signal;
    let structuredBytes=0;
    for(let index=0;index<tests.length;index++) {
      const remaining=(request.outputLimitBytes ?? 1048576)-Buffer.byteLength(result.stdout)-Buffer.byteLength(result.stderr)-structuredBytes;
      if(remaining<=0){result.status='output_limit';return result;}
      const output=path.join(directory,`result-${index}.json`);
      const diagnosticFile=path.join(directory,`diagnostic-${index}.json`);
      const args=request.language==='python'
        ? request.mode==='acm'?['-I','-X','utf8','wrapper.py',diagnosticFile]:['-I','-X','utf8','wrapper.py',String(index),output,String(remaining),diagnosticFile]
        : request.mode==='acm'?['-Xmx256m','-cp',directory,'Main']:['-Xmx256m','-cp',directory,'Main',String(index),output,String(remaining)];
      emit('run',{caseIndex:index});
      const run=await runProcess(executable,args,{...processOptions,signal:executionSignal,stdin:tests[index].stdin ?? request.stdin,outputLimitBytes:remaining});
      result.stdout+=run.stdout;result.stderr+=run.stderr;
      let status:RunStatus=run.reason==='spawn_error'?'environment_error':run.reason ?? (run.code===0?'completed':'runtime_error');
      if(status==='cancelled' && executionDeadline.signal.aborted && !options.signal?.aborted) status='timeout';
      let diagnostics:Diagnostic[]=[];
      if(status==='runtime_error'){
        diagnostics=await diagnosticsFrom(diagnosticFile,run.stderr,'run');
        if(diagnostics.some(d=>d.code==='output_limit'))status='output_limit';
        else if(diagnostics.every(d=>d.source==='runner'))status='internal_error';
      }
      let actual:WireValue|undefined;
      if(status==='completed') {
        if(request.mode==='function') {
          try {
            const size=(await stat(output)).size;
            if(size+Buffer.byteLength(run.stdout)+Buffer.byteLength(run.stderr)>remaining) { status='output_limit'; }
            else {
              structuredBytes+=size;
              actual=JSON.parse(await readFile(output,'utf8')) as WireValue;
              validateValue(actual,observedType(request.adapter!));
            }
          } catch(error) {status=(error as NodeJS.ErrnoException).code==='ENOENT'?'internal_error':'runtime_error';diagnostics.push({phase:'run',source:status==='internal_error'?'runner':'user',code:status==='internal_error'?'wrapper_protocol':'invalid_return',message:`Invalid structured result: ${String(error)}`});}
        } else actual=run.stdout;
        if(status==='completed' && tests[index].expected!==undefined) {
          const kind=request.mode==='function'?observedType(request.adapter!):undefined;
          const passed=request.mode==='function'?compare(normalizeTyped(actual!,kind!),normalizeTyped(tests[index].expected!,kind!),request.adapter!.compare):request.acmCompare==='exact'?actual===tests[index].expected:normalizeOutput(actual as string)===normalizeOutput(tests[index].expected as string);
          status=passed?'passed':'wrong_answer';
        }
      }
      result.caseResults.push({index,status,actual,expected:tests[index].expected,stdout:run.stdout,stderr:run.stderr,durationMs:run.durationMs});
      if(!['passed','completed','wrong_answer'].includes(status)) {
        result.status=status;result.diagnostics.push(...(diagnostics.length?diagnostics:[{phase:'run' as const,message:run.stderr || status,source:status==='environment_error'?'runner' as const:'user' as const}]));return result;
      }
    }
    result.status=result.caseResults.some(c=>c.status==='wrong_answer')?'wrong_answer':result.caseResults.every(c=>c.status==='passed')?'passed':'completed';
    return result;
  } catch(error) {result.status='internal_error';result.diagnostics.push({phase:'run',source:'runner',message:String(error)});return result;}
  finally {
    if(executionTimer)clearTimeout(executionTimer);
    if(directory)try{await rm(directory,{recursive:true,force:true});}catch(error){result.status='internal_error';result.diagnostics.push({phase:'run',source:'runner',code:'cleanup_failed',message:String(error)});}
    result.durationMs=performance.now()-started;
    emit('finished',{status:result.status});
  }
}
