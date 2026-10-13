import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cppWrapper, CPP_BITS_HEADER } from './cpp-wrapper.ts';
import { goFunctionSource, goNodes, goWrapper } from './go-wrapper.ts';
import type { RunRequest, TestCase } from './types.ts';

export interface NativeSources { binary: string; compileArgs: string[]; }
export async function nativeSources(directory: string, request: RunRequest, cases: TestCase[]): Promise<NativeSources> {
  const binary = path.join(directory, process.platform === 'win32' ? 'program.exe' : 'program');
  if (request.language === 'go') {
    if (request.mode === 'acm') {
      await writeFile(path.join(directory, 'main.go'), request.code);
      return { binary, compileArgs: ['-o', binary, 'main.go'] };
    }
    await writeFile(path.join(directory, 'solution.go'), goFunctionSource(request.code));
    await writeFile(path.join(directory, 'nodes.go'), goNodes(request.adapter!));
    await writeFile(path.join(directory, 'runner.go'), goWrapper(request.adapter!, cases));
    return { binary, compileArgs: ['-o', binary, 'solution.go', 'nodes.go', 'runner.go'] };
  }
  if (request.language !== 'cpp') throw new Error('Native driver requires Go or C++');
  const include = path.join(directory, 'compat');
  await mkdir(path.join(include, 'bits'), { recursive: true });
  await writeFile(path.join(include, 'bits', 'stdc++.h'), CPP_BITS_HEADER);
  const file = request.mode === 'acm' ? 'main.cpp' : 'runner.cpp';
  if (request.mode === 'function') await writeFile(path.join(directory, 'solution.cpp'), request.code);
  await writeFile(path.join(directory, file), request.mode === 'acm' ? request.code : cppWrapper(request.adapter!, cases));
  return { binary, compileArgs: ['-I', include, file, '-o', binary] };
}
