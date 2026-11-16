import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platformUpdateArtifacts, validateUpdateArtifacts } from './update-artifacts.mjs';

/** Keep one architecture per channel, and require a real signing identity whenever credentials were supplied. */
export function desktopPackageConfiguration(pkg, platform, arch, env = process.env) {
  assert.ok((platform === 'darwin' && ['arm64', 'x64'].includes(arch)) || (platform === 'win32' && arch === 'x64'), 'Unsupported desktop package target');
  const config = structuredClone(pkg.build);
  // builder 26 merges an API publish override into the first package.json provider: it must be an object, not an array.
  config.publish = { provider: 'github', owner: 'xhuandy666', repo: 'AlgoPractice', channel: platform === 'darwin' ? `latest-${arch}` : 'latest' };
  if (platform === 'darwin') {
    if (env.CSC_LINK) {
      delete config.mac.identity;
      if (env.CSC_NAME) config.mac.identity = env.CSC_NAME;
      config.forceCodeSigning = true;
    } else config.mac.identity = '-';
  }
  return config;
}

export async function packageDesktop(argv = process.argv.slice(2), env = process.env, root = process.cwd()) {
  assert.equal(argv.length, 4, 'Use --platform darwin|win32 --arch arm64|x64');
  assert.equal(argv[0], '--platform'); assert.equal(argv[2], '--arch');
  const [, platform, , arch] = argv;
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const config = desktopPackageConfiguration(pkg, platform, arch, env);
  const { build, Platform, Arch } = await import('electron-builder');
  const target = platform === 'darwin' ? Platform.MAC : Platform.WINDOWS;
  await build({ projectDir: root, config, targets: target.createTarget(platform === 'darwin' ? ['dmg', 'zip'] : ['nsis', 'zip'], Arch[arch]), publish: 'never' });
  const targetId = `${platform}-${arch}`;
  await validateUpdateArtifacts(join(root, config.directories.output), { version: pkg.version, target: targetId });
  console.log(JSON.stringify({ result: 'update-artifacts-verified', target: targetId, assets: platformUpdateArtifacts(pkg.version, targetId) }));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) packageDesktop().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
