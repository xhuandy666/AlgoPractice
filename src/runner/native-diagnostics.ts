import type { Diagnostic, RunRequest } from './types.ts';

function basename(file: string): string { return file.split(/[\\/]/).at(-1)!; }
/** Go and Clang columns are byte offsets. Monaco positions are UTF-16 code units. */
export function byteColumnToEditor(source: string, column: number): number {
  return Buffer.from(source, 'utf8').subarray(0, Math.max(0, column - 1)).toString('utf8').length + 1;
}
export function nativeDiagnostics(stderr: string, phase: 'compile' | 'run', request: Pick<RunRequest, 'language' | 'mode' | 'code'>): Diagnostic[] {
  const suffix = request.language === 'go' ? 'go' : 'cpp';
  const userFile = `${request.mode === 'function' ? 'solution' : 'main'}.${suffix}`;
  const sourceLines = request.code.split(/\r?\n/);
  const validLine = (line: number) => line > 0 && line <= sourceLines.length;
  if (phase === 'compile') {
    const out: Diagnostic[] = [];
    for (const match of stderr.matchAll(/^(.+?):(\d+)(?::(\d+))?:[ \t]*(.*)$/gm)) {
      const file = basename(match[1]), line = Number(match[2]);
      // Include-stack context is not a diagnostic and must not consume the next source line.
      if (!match[4].trim() || match[1].startsWith('In file included from ')) continue;
      if (!file.endsWith(`.${suffix}`) && !/\.(?:h|hpp)$/.test(file)) continue;
      const user = file === userFile && validLine(line);
      out.push({ phase, source: user ? 'user' : 'runner', file, code: /\bnote:/.test(match[4]) ? 'compiler_note' : 'compile_error', message: match[4], ...(user ? { line, ...(match[3] ? { column: byteColumnToEditor(sourceLines[line - 1], Number(match[3])) } : {}) } : {}) });
    }
    if (out.length) return out;
    // A linker/import/dependency diagnostic without a trusted source position is still visible.
    return [{ phase, source: 'user', code: 'compile_error', message: stderr || 'Compilation failed without diagnostic output.' }];
  }
  const marker = /^ALGOPRACTICE_ERROR:(output_limit|invalid_return|runtime_exception):([^\r\n]*)/m.exec(stderr);
  if (marker && marker[1] !== 'runtime_exception') return [{ phase, source: 'user', file: userFile, code: marker[1], message: marker[2] }];
  if (request.language === 'go') {
    for (const match of stderr.matchAll(/^\s*(.+?\.go):(\d+)(?:\s|$)/gm)) {
      const line = Number(match[2]);
      if (basename(match[1]) === userFile && validLine(line)) return [{ phase, source: 'user', file: userFile, line, code: 'runtime_exception', message: marker?.[2] ?? stderr.split(/\r?\n/).find(line => /^panic:|^fatal error:/.test(line)) ?? 'Go runtime exception' }];
    }
  }
  // Native signals and C++ exceptions need not provide a trustworthy editor position.
  return [{ phase, source: 'user', file: userFile, code: marker?.[1] ?? 'runtime_exception', message: marker?.[2] || stderr || 'Native program exited abnormally without diagnostic output.' }];
}
