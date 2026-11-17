import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blake2b } from '@noble/hashes/blake2.js';
// @ts-expect-error Standalone packaging tools are deliberately plain Node.js.
import { platformUpdateArtifacts, updateMetadataName, validateUpdateArtifacts } from '../../scripts/update-artifacts.mjs';
// @ts-expect-error Standalone packaging tools are deliberately plain Node.js.
import { desktopPackageConfiguration } from '../../scripts/package-desktop.mjs';
// @ts-expect-error Standalone packaging tools are deliberately plain Node.js.
import * as packaging from '../../scripts/package-desktop.mjs';

const version = '0.96.0';
type Target = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';
async function fixture(t: { after(fn: () => Promise<void>): void }, target: Target = 'darwin-arm64') {
  const directory = await mkdtemp(join(tmpdir(), 'algopractice-update-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files: string[] = platformUpdateArtifacts(version, target);
  const references = files.filter(name => target === 'win32-x64' ? name.endsWith('.exe') : /\.(?:dmg|zip)$/.test(name));
  const metadata = { version, files: [] as { url: string; size: number; sha512: string }[], path: references[0], sha512: '' };
  for (const file of files.filter(name => /\.(?:exe|zip|dmg)$/.test(name))) await writeFile(join(directory, file), `synthetic bytes for ${file}`);
  for (const name of references) {
    const bytes = await readFile(join(directory, name));
    metadata.files.push({ url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') });
  }
  metadata.sha512 = metadata.files[0].sha512;
  for (const name of files.filter(name => name.endsWith('.blockmap'))) {
    const bytes = await readFile(join(directory, name.slice(0, -'.blockmap'.length)));
    await writeFile(join(directory, name), gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0,
      sizes: [bytes.length], checksums: [Buffer.from(blake2b(bytes, { dkLen: 18 })).toString('base64')] }] })));
  }
  const saveMetadata = () => writeFile(join(directory, updateMetadataName(target)), JSON.stringify(metadata));
  await saveMetadata();
  return { directory, target, files, metadata, saveMetadata, validate: () => validateUpdateArtifacts(directory, { version, target }) };
}

test('each architecture has its own channel using the installed updater 6 provider naming contract', () => {
  const { Provider } = createRequire(import.meta.url)('electron-updater/out/providers/Provider.js');
  const provider = new Provider({ platform: 'darwin', executor: {} });
  for (const arch of ['arm64', 'x64']) assert.equal(`${provider.getCustomChannelName(`latest-${arch}`)}.yml`, updateMetadataName(`darwin-${arch}`));
  assert.notEqual(updateMetadataName('darwin-arm64'), updateMetadataName('darwin-x64'));
  assert.equal(updateMetadataName('win32-x64'), 'latest.yml');
  assert.throws(() => updateMetadataName('darwin-universal'));
});

for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const) test(`${target}: metadata and every blockmap agree with complete artifact bytes`, async t => {
  const f = await fixture(t, target), result = await f.validate();
  assert.deepEqual(result.files, f.files);
  assert.equal(result.blockmaps.length, target === 'win32-x64' ? 1 : 2);
});

test('metadata rejects incorrect versions, foreign references, duplicate files, sizes, digests and legacy aliases', async t => {
  const f = await fixture(t), original = structuredClone(f.metadata);
  const invalid = [
    { ...original, version: '0.95.0' },
    { ...original, files: [{ ...original.files[0], url: '../outside.zip' }, ...original.files.slice(1)] },
    { ...original, files: [{ ...original.files[0], url: original.files[0].url.replace('arm64', 'x64') }, ...original.files.slice(1)] },
    { ...original, files: [original.files[0], original.files[0]] },
    { ...original, files: [{ ...original.files[0], size: original.files[0].size + 1 }, ...original.files.slice(1)] },
    { ...original, files: [{ ...original.files[0], sha512: Buffer.alloc(64).toString('base64') }, ...original.files.slice(1)] },
    { ...original, files: [{ ...original.files[0], sha512: 'not base64' }, ...original.files.slice(1)] },
    { ...original, path: 'foreign.zip' }, { ...original, sha512: Buffer.alloc(64).toString('base64') },
  ];
  for (const metadata of invalid) {
    await writeFile(join(f.directory, updateMetadataName(f.target)), JSON.stringify(metadata));
    await assert.rejects(f.validate());
  }
});

test('missing maps, stale chunk checksums and incomplete blockmap coverage stop artifact validation', async t => {
  const f = await fixture(t), name = f.files.find(name => name.endsWith('.blockmap'))!;
  const path = join(f.directory, name), original = await readFile(path);
  const map = JSON.parse(gunzipSync(original).toString('utf8'));
  map.files[0].checksums[0] = Buffer.alloc(18).toString('base64');
  await writeFile(path, gzipSync(JSON.stringify(map)));
  await assert.rejects(f.validate(), /checksum differs/);
  map.files[0].sizes[0] += 1;
  await writeFile(path, gzipSync(JSON.stringify(map)));
  await assert.rejects(f.validate(), /beyond its archive/);
  await rm(path);
  await assert.rejects(f.validate(), /ENOENT/);
});

test('packaging uses ad-hoc macOS signing without credentials and requires an identity when credentials exist', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const before = structuredClone(pkg);
  const unsigned = desktopPackageConfiguration(pkg, 'darwin', 'arm64', {});
  assert.equal(unsigned.mac.identity, '-');
  assert.equal(unsigned.publish.channel, 'latest-arm64');
  for (const link of ['', ' \t\r\n ']) {
    const empty = desktopPackageConfiguration(pkg, 'darwin', 'arm64', { CSC_LINK: link });
    assert.equal(empty.mac.identity, '-', 'an empty or whitespace-only CI secret is not a certificate');
    assert.notEqual(empty.forceCodeSigning, true);
  }
  const signed = desktopPackageConfiguration(pkg, 'darwin', 'x64', { CSC_LINK: 'fixture-certificate-location' });
  assert.equal(signed.mac.identity, undefined); assert.equal(signed.forceCodeSigning, true);
  assert.equal(signed.publish.channel, 'latest-x64');
  const windows = desktopPackageConfiguration(pkg, 'win32', 'x64', {});
  assert.equal(windows.publish.channel, 'latest');
  assert.ok([unsigned, signed, windows].every(config => config.win?.verifyUpdateCodeSignature !== false));
  assert.deepEqual(pkg, before, 'packaging must not mutate source package configuration');
  assert.throws(() => desktopPackageConfiguration(pkg, 'win32', 'arm64', {}));
});

test('empty CI certificate links are absent to the real builder while nonempty links and empty passwords survive', async () => {
  const require = createRequire(import.meta.url); require('app-builder-lib');
  const { PlatformPackager } = require('app-builder-lib/out/platformPackager.js');
  const { importCertificate } = require('app-builder-lib/out/codeSign/codesign.js');
  const context = { info: { config: {} }, platformSpecificBuildOptions: {} };
  const keys = ['CSC_LINK', 'CSC_INSTALLER_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_INSTALLER_KEY_PASSWORD'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { CSC_LINK: '', CSC_INSTALLER_LINK: ' \t ', WIN_CSC_LINK: '\n', CSC_KEY_PASSWORD: '', CSC_INSTALLER_KEY_PASSWORD: '' });
    assert.equal(PlatformPackager.prototype.getCscLink.call(context), '', 'the actual builder preserves the CI empty-string bug');
    await assert.rejects(importCertificate('', { getTempFile() { throw new Error('no temporary certificate expected'); } }, process.cwd()), /not a file/);
    packaging.normalizeSigningEnvironment(process.env);
    for (const key of keys.slice(0, 3)) assert.equal(Object.hasOwn(process.env, key), false);
    assert.equal(PlatformPackager.prototype.getCscLink.call(context), undefined, 'builder must no longer attempt to import the project directory');
    assert.equal(PlatformPackager.prototype.getCscLink.call(context, 'WIN_CSC_LINK'), undefined);
    assert.equal(process.env.CSC_KEY_PASSWORD, ''); assert.equal(process.env.CSC_INSTALLER_KEY_PASSWORD, '');
    process.env.CSC_LINK = 'definitely-missing-signing-fixture.p12';
    process.env.CSC_INSTALLER_LINK = ' https://certificate.fixture.invalid/installer.p12 ';
    process.env.WIN_CSC_LINK = 'fixture-windows-certificate.p12';
    packaging.normalizeSigningEnvironment(process.env);
    assert.equal(process.env.CSC_INSTALLER_LINK, ' https://certificate.fixture.invalid/installer.p12 ', 'nonempty secrets are never rewritten or downgraded');
    assert.equal(PlatformPackager.prototype.getCscLink.call(context), 'definitely-missing-signing-fixture.p12');
    assert.equal(PlatformPackager.prototype.getCscLink.call(context, 'WIN_CSC_LINK'), 'fixture-windows-certificate.p12');
    await assert.rejects(importCertificate(process.env.CSC_LINK, { getTempFile() { throw new Error('no temporary certificate expected'); } }, process.cwd()), /doesn't exist/);
  } finally { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } }
});

test('the real packaging CLI keeps a nonzero failure status after builder temporary-file exit hooks run', { timeout: 20_000 }, async t => {
  const root = fileURLToPath(new URL('../..', import.meta.url)), temporary = await mkdtemp(join(tmpdir(), 'algopractice-signing-exit-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const preload = `import {createRequire} from 'node:module'; const {TmpDir}=createRequire(${JSON.stringify(pathToFileURL(join(root, 'package.json')).href)})('temp-file'); await new TmpDir('packaging-exit-test').createTempDir();`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`, join(root, 'scripts/package-desktop.mjs'), '--invalid'], {
    cwd: root, env: { ...process.env, APP_BUILDER_TMP_DIR: temporary }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.signal, null, result.stderr); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Use --platform/);
});

test('the builder 26 API merges the architecture channel into the actual package provider configuration', async () => {
  const { getConfig } = createRequire(import.meta.url)('app-builder-lib/out/util/config/config.js');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const arch of ['arm64', 'x64']) {
    const config = await getConfig(process.cwd(), null, desktopPackageConfiguration(pkg, 'darwin', arch, {}));
    assert.deepEqual(config.publish, [{ provider: 'github', owner: 'xhuandy666', repo: 'AlgoPractice', channel: `latest-${arch}` }]);
    assert.equal(config.mac.identity, '-');
  }
});

test('sparse packaging overrides preserve static configuration and copy the Windows helper exactly once', async () => {
  const { getConfig } = createRequire(import.meta.url)('app-builder-lib/out/util/config/config.js');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const baseline = await getConfig(process.cwd(), null, {});
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const config = await getConfig(process.cwd(), null, desktopPackageConfiguration(pkg, platform, arch, {}));
    assert.equal(config.win.extraResources.filter((resource: { to: string }) => resource.to === 'windows-job-helper.exe').length, 1,
      'duplicate Windows helper matchers race while copying to the same destination');
    assert.deepEqual(config.win.extraResources, baseline.win.extraResources);
    assert.deepEqual(config.files, baseline.files);
    assert.deepEqual(config.mac.target, baseline.mac.target); assert.deepEqual(config.win.target, baseline.win.target);
    assert.equal(config.mac.icon, pkg.build.mac.icon); assert.equal(config.win.icon, pkg.build.win.icon);
    assert.equal(config.mac.hardenedRuntime, true); assert.equal(config.mac.minimumSystemVersion, pkg.build.mac.minimumSystemVersion);
    assert.notEqual(config.win.verifyUpdateCodeSignature, false);
    assert.deepEqual(config.nsis, baseline.nsis);
    assert.equal(config.publish[0].channel, platform === 'darwin' ? `latest-${arch}` : 'latest');
  }
});
