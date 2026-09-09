import { build as bundle } from 'esbuild';
import { build as frontend } from 'vite';
import { mkdir, readFile, readdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
const root = process.cwd();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const main = await bundle({ entryPoints: ['src/desktop/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: true, metafile: true });
const preload = await bundle({ entryPoints: ['src/desktop/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: true, metafile: true });
const renderer = await frontend();
const moduleIds = new Set([...Object.keys(main.metafile.inputs), ...Object.keys(preload.metafile.inputs)]);
for (const result of Array.isArray(renderer) ? renderer : [renderer]) for (const output of result.output ?? []) if (output.type === 'chunk') for (const id of Object.keys(output.modules)) moduleIds.add(id);
const packagePaths = new Set(['node_modules/@fontsource/inter', 'node_modules/@fontsource/space-grotesk', 'node_modules/@fontsource/jetbrains-mono', 'node_modules/electron', 'node_modules/monaco-editor/node_modules/marked']);
for (let id of moduleIds) {
  id = relative(root, resolve(id)).replaceAll('\\', '/');
  const offset = id.lastIndexOf('node_modules/'); if (offset < 0) continue;
  const segments = id.slice(offset + 'node_modules/'.length).split('/');
  packagePaths.add(id.slice(0, offset) + 'node_modules/' + segments.slice(0, segments[0].startsWith('@') ? 2 : 1).join('/'));
}
const inventory = [];
for (const path of [...packagePaths].sort()) {
  const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const target = join('dist/licenses', `${metadata.name.replaceAll('/', '__')}-${metadata.version}`);
  await mkdir(target, { recursive: true });
  const notices = [];
  for (const file of (await readdir(path)).sort()) if (/^(licen[sc]e|copying|notice|third.?party)/i.test(file)) {
    const source = join(path, file); const stat = await import('node:fs/promises').then(fs => fs.stat(source)); if (!stat.isFile()) continue;
    await copyFile(source, join(target, file)); notices.push({ file: relative('dist', join(target, file)), sha256: hash(await readFile(source)) });
  }
  if (metadata.name === 'electron') for (const file of ['LICENSE', 'LICENSES.chromium.html']) {
    const outputName = file === 'LICENSE' ? 'ELECTRON_RUNTIME_LICENSE' : file;
    await copyFile(join(path, 'dist', file), join(target, outputName)); notices.push({ file: relative('dist', join(target, outputName)), sha256: hash(await readFile(join(path, 'dist', file))) });
  }
  if (!notices.length) throw new Error(`Missing third-party notices for bundled package ${metadata.name}`);
  inventory.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? 'See notices', packagePath: path, notices });
}
async function walk(path) {
  const files = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const child = join(path, entry.name); if (entry.isDirectory()) files.push(...await walk(child)); else if (entry.isFile()) files.push(child);
  }
  return files;
}
const sourcePaths = [...await walk('src'), 'runtime-manifest.json', 'tokens.css', 'LICENSE', 'package.json', 'package-lock.json', 'scripts/build.mjs', 'vite.config.ts', 'tsconfig.json', 'index.html'].sort();
const inputs = [];
for (const path of sourcePaths) inputs.push({ path, sha256: hash(await readFile(path)) });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const sourceHash = hash(JSON.stringify(inputs));
await writeFile('dist/build-info.json', JSON.stringify({ application: pkg.name, version: pkg.version, sourceHash, sourceInputs: inputs, dependencies: pkg.devDependencies, runtimeManifest: JSON.parse(await readFile('runtime-manifest.json', 'utf8')), noticeInventory: inventory }, null, 2) + '\n');
await writeFile('dist/THIRD_PARTY_NOTICES.md', `# Third-party notices\n\nAlgoPractice ${pkg.version}. Source SHA-256: ${sourceHash}.\n\nThis directory contains the upstream notices for packages included in the application bundle and the Electron runtime. Build-only dependencies remain described in package-lock.json. Python and Temurin are installed separately from the pinned runtime manifest; their original license files remain in each installation.\n\n` + inventory.map(item => `- ${item.name} ${item.version} (${item.license}): ${item.notices.map(notice => `[${notice.file}](${notice.file})`).join(', ')}`).join('\n') + '\n');
console.log(`Build ${pkg.version}: ${sourceHash}; ${inventory.length} third-party packages with original notices.`);
