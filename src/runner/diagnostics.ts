import type { Diagnostic, RunRequest } from './types.ts';

export const JAVA_USER_PREFIX_LINES = 2;
const USER_FILE = (request: Pick<RunRequest, 'language' | 'mode'>) => request.language === 'python'
  ? request.mode === 'function' ? 'solution.py' : 'main.py'
  : request.mode === 'function' ? 'Solution.java' : 'Main.java';

export function javaDiagnostics(stderr: string, phase: 'compile' | 'run', request: Pick<RunRequest, 'language' | 'mode' | 'code'>): Diagnostic[] {
  const userFile = USER_FILE(request), lineOffset = request.mode === 'function' ? JAVA_USER_PREFIX_LINES : 0;
  const lines=request.code.split(/\r?\n/);
  const validLine = (line: number) => line > 0 && line <= lines.length;
  const editorColumn=(line:number,compilerColumn:number)=>{
    // javac expands tabs to 8-column stops; editors count UTF-16 code units.
    let display=1,index=0;const source=lines[line-1];
    while(index<source.length&&display<compilerColumn){display=source[index]==='\t'?(Math.floor((display-1)/8)+1)*8+1:display+1;index++;}
    return index+1;
  };
  if (phase === 'compile') {
    const diagnostics: Diagnostic[] = [];
    // -XDrawDiagnostics exposes stable filename/line/column/error-code fields, independently of locale.
    for (const match of stderr.matchAll(/^(.+?\.java):(\d+):(\d+):\s+(compiler\.(?:err|warn)\.[^: ]+)(?::\s*(.*))?$/gm)) {
      const file = match[1].split(/[\\/]/).at(-1)!;
      const line = Number(match[2]) - lineOffset;
      const user = file === userFile && validLine(line);
      diagnostics.push({ phase, source: user ? 'user' : 'runner', file, ...(user ? { line, column: editorColumn(line,Number(match[3])) } : {}), code: match[4], message: match[5] ? `${match[4]}: ${match[5]}` : match[4] });
    }
    if (diagnostics.length) return diagnostics;
  } else {
    if (/Main\$RunnerOutputLimitException/.test(stderr)) return [{ phase, source: 'user', file: userFile, code: 'output_limit', message: 'Structured result exceeds the task output limit.' }];
    if (/Main\$InvalidReturnException/.test(stderr)) return [{ phase, source: 'user', file: userFile, code: 'invalid_return', message: stderr.split('\n')[0] }];
    const frames = [...stderr.matchAll(/\bat\s+[^\s(]+\(([^():]+\.java):(\d+)\)/g)];
    const frame = frames.find(m => m[1] === userFile && validLine(Number(m[2]) - lineOffset));
    if (frame) return [{ phase, source: 'user', file: userFile, line: Number(frame[2]) - lineOffset, message: stderr.split('\n')[0] || 'Java runtime exception' }];
    if (frames.length && request.mode === 'function') return [{ phase, source: 'runner', file: frames[0][1], code: 'wrapper_failure', message: stderr.split('\n')[0] || 'Generated wrapper failed.' }];
  }
  return [{ phase, source: phase === 'compile' && request.mode === 'function' ? 'runner' : 'user', message: stderr || `Java ${phase} failed without diagnostic output.` }];
}

export function readPythonDiagnostic(value: unknown, request: Pick<RunRequest, 'mode' | 'code'>, phase: 'compile' | 'run'): Diagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.message !== 'string' || !['user', 'runner'].includes(String(input.source))) return undefined;
  const file = request.mode === 'function' ? 'solution.py' : 'main.py';
  const source = input.source as 'user' | 'runner';
  const out: Diagnostic = { phase, source, file: source === 'user' ? file : typeof input.file === 'string' ? input.file.split(/[\\/]/).at(-1) : undefined, message: input.message.slice(0, 16384), code: typeof input.code === 'string' ? input.code.slice(0, 100) : undefined };
  const lines = request.code.split(/\r?\n/);
  if (source === 'user' && Number.isInteger(input.line) && Number(input.line) >= 1 && Number(input.line) <= lines.length) {
    out.line = Number(input.line);
    if (Number.isInteger(input.column) && Number(input.column) >= 1 && Number(input.column) <= lines[out.line - 1].length + 1) out.column = Number(input.column);
    if (Number.isInteger(input.endLine) && Number(input.endLine) >= out.line && Number(input.endLine) <= lines.length) out.endLine = Number(input.endLine);
    if (out.endLine && Number.isInteger(input.endColumn) && Number(input.endColumn) >= 1 && Number(input.endColumn) <= lines[out.endLine - 1].length + 1) out.endColumn = Number(input.endColumn);
  }
  return out;
}

export const PYTHON_COMPILE_CHECK = `import sys,json,pathlib,traceback
source=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
try:
    compile(source,sys.argv[1],'exec')
except SyntaxError as error:
    lines=source.splitlines()
    def column(line,offset):
        if line is None or offset is None or line<1 or line>len(lines): return None
        return len(lines[line-1][:max(0,offset-1)].encode('utf-16-le'))//2+1
    diagnostic={'phase':'compile','source':'user','file':sys.argv[1],'line':error.lineno,'column':column(error.lineno,error.offset),'endLine':error.end_lineno,'endColumn':column(error.end_lineno,error.end_offset),'message':type(error).__name__+': '+error.msg,'code':'syntax_error'}
    pathlib.Path(sys.argv[2]).write_text(json.dumps(diagnostic),encoding='utf-8')
    traceback.print_exception(error)
    sys.exit(1)
`;

export function pythonDiagnosticPrelude(userFile: 'main.py' | 'solution.py', argument: number): string {
  return `import sys as _ap_sys, json as _ap_json, pathlib as _ap_pathlib, traceback as _ap_traceback
_ap_diagnostic_path=_ap_sys.argv[${argument}]
_ap_user_file='${userFile}'
class _APInvalidReturnError(Exception): pass
class _APOutputLimitError(Exception): pass
def _ap_hook(kind,value,tb):
    frames=_ap_traceback.extract_tb(tb)
    user=[f for f in frames if _ap_pathlib.Path(f.filename).name==_ap_user_file]
    frame=user[-1] if user else None
    invalid_return=isinstance(value,_APInvalidReturnError)
    output_limit=isinstance(value,_APOutputLimitError)
    d={'phase':'run','source':'user' if frame or invalid_return or output_limit else 'runner','file':_ap_user_file if frame or invalid_return or output_limit else (frames[-1].filename if frames else 'wrapper.py'),'message':kind.__name__+': '+str(value),'code':'output_limit' if output_limit else 'invalid_return' if invalid_return else 'runtime_exception' if frame else 'wrapper_failure'}
    if frame:
        d['line']=frame.lineno
        lines=_ap_pathlib.Path(frame.filename).read_text(encoding='utf-8').splitlines()
        def column(line,offset):
            if offset is None or line<1 or line>len(lines):return None
            text=lines[line-1].encode('utf-8')[:offset].decode('utf-8',errors='ignore')
            return len(text.encode('utf-16-le'))//2+1
        d['column']=column(frame.lineno,frame.colno)
        if frame.end_lineno:d['endLine']=frame.end_lineno;d['endColumn']=column(frame.end_lineno,frame.end_colno)
    try:_ap_pathlib.Path(_ap_diagnostic_path).write_text(_ap_json.dumps(d),encoding='utf-8')
    except Exception:pass
    _ap_traceback.print_exception(kind,value,tb)
_ap_sys.excepthook=_ap_hook
`;
}
export const PYTHON_ACM_WRAPPER = `${pythonDiagnosticPrelude('main.py', 1)}
import runpy as _ap_runpy
_ap_sys.argv=['main.py']
_ap_runpy.run_path('main.py',run_name='__main__')
`;
