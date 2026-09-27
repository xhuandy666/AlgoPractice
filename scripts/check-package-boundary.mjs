import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkPackageBoundary(root = process.cwd()) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const files = packageJson.build.files;
  if (JSON.stringify(files) !== JSON.stringify(['dist/**/*', 'package.json', 'LICENSE'])) throw new Error('Package allowlist changed; review private-data and runtime boundaries before packaging.');
  if (packageJson.build.extraResources || packageJson.build.mac?.extraResources
    || JSON.stringify(packageJson.build.win?.extraResources) !== JSON.stringify([{ from: '.runtime-tools/windows-job-helper.exe', to: 'windows-job-helper.exe' }])) throw new Error('Extra resources changed; explicitly review that no language runtime or private data will be shipped.');
  const output = join(root, 'dist'); let count = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = relative(output, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw new Error(`Unexpected link in application payload: ${name}`);
      if (/(^|\/)(?:\.aoci|\.runtime|\.local|docs|runtimes|credentials|backups)(\/|$)/i.test(name)
        || /(^|\/)(?:aoci(?:\.(?:meta|code))?\.txt|AGENTS\.md|python(?:3(?:\.\d+)?)?(?:\.exe)?|java(?:c)?(?:\.exe)?|libjvm\.[^/]+)$/i.test(name)
        || /\.(?:sqlite(?:-wal|-shm)?|algobak|tar(?:\.gz)?|tgz|zip)$/i.test(name)) throw new Error(`Private data or a language runtime entered application payload: ${name}`);
      if (entry.isDirectory()) await visit(path); else count++;
    }
  }
  await visit(output);
  const build = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  if (!build.runtimeManifest || !build.sourceInputs.some(input => input.path === 'runtime-manifest.json')) throw new Error('The pinned runtime manifest is missing from build provenance.');
  return { files: count, runtimesBundled: false };
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) console.log(JSON.stringify(await checkPackageBoundary()));
