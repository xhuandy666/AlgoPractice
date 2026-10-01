import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// The release entry point is intentionally plain Node.js for the manual workflow.
// @ts-expect-error The standalone .mjs tool has no TypeScript declaration.
import { assertSafePaths, collectSourceInputs, expectedReleaseAssets, extractZipEntry, listZipEntries, releaseConfiguration, releaseCreateArguments, releaseForTag, runtimeAssets, validateBuildInfo, validateCiEvidence } from '../../scripts/prepare-release-draft.mjs';

const sha = 'a'.repeat(40);
const configuration = { runId: '123456', tag: 'v0.90.0', sha, repo: 'xhuandy666/AlgoPractice', version: '0.90.0' };
const pkg = { name: 'algopractice', version: '0.90.0', repository: { url: 'git+https://github.com/xhuandy666/AlgoPractice.git' }, devDependencies: { electron: '44.2.0' } };
const env = { GH_REPO: configuration.repo, GITHUB_SHA: sha, GITHUB_REF_NAME: 'main', GH_TOKEN: 'fixture-not-a-real-token' };
const argv = ['--ci-run-id', configuration.runId, '--release-tag', configuration.tag];
const manifest = JSON.parse(await readFile(new URL('../../runtime-manifest.json', import.meta.url), 'utf8'));

function evidence() {
  const run = { id: 123456, name: 'Desktop checks', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: sha, repository: { full_name: configuration.repo, id: 123 }, head_repository: { full_name: configuration.repo }, event: 'push', run_attempt: 2 };
  const jobs = ['macOS Apple Silicon', 'macOS Intel', 'Windows x64'].map(name => ({ name, status: 'completed', conclusion: 'success', head_sha: sha, run_attempt: 2 }));
  const artifacts = ['macos-arm64-packages', 'macos-x64-packages', 'windows-packages'].map(name => ({ name: `${name}-${sha}`, expired: false, size_in_bytes: 100, expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: 123456, head_sha: sha, head_branch: 'main', repository_id: 123, head_repository_id: 123 } }));
  return { run, jobs, artifacts };
}

test('manual draft inputs require the exact version, repository, main branch and full checkout SHA', () => {
  assert.deepEqual(releaseConfiguration(argv, env, pkg), configuration);
  for (const altered of [['--ci-run-id', '12;echo unsafe', '--release-tag', configuration.tag], ['--ci-run-id', '123', '--release-tag', 'v0.85.0'], [...argv, '--publish'], ['--ci-run-id', '999999999999999999', '--release-tag', configuration.tag]]) assert.throws(() => releaseConfiguration(altered, env, pkg));
  for (const patch of [{ GITHUB_REF_NAME: 'topic' }, { GITHUB_SHA: 'abc' }, { GH_REPO: 'other/AlgoPractice' }, { GH_TOKEN: '' }]) assert.throws(() => releaseConfiguration(argv, { ...env, ...patch }, pkg));
});

test('all three successful current-attempt jobs and unexpired exact-SHA artifacts are required', () => {
  const { run, jobs, artifacts } = evidence();
  assert.deepEqual(validateCiEvidence(run, jobs, artifacts, configuration).map((item: { name: string }) => item.name), artifacts.map(item => item.name));
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { head_branch: 'other' }, { head_sha: 'b'.repeat(40) }, { path: '.github/workflows/other.yml' }, { event: 'pull_request' }, { repository: { full_name: 'other/AlgoPractice', id: 123 } }, { head_repository: { full_name: 'other/AlgoPractice' } }]) assert.throws(() => validateCiEvidence({ ...run, ...patch }, jobs, artifacts, configuration));
  assert.throws(() => validateCiEvidence(run, jobs.slice(1), artifacts, configuration));
  assert.throws(() => validateCiEvidence(run, [...jobs, jobs[0]], artifacts, configuration));
  for (const patch of [{ conclusion: 'failure' }, { head_sha: 'b'.repeat(40) }, { run_attempt: 1 }]) assert.throws(() => validateCiEvidence(run, [{ ...jobs[0], ...patch }, ...jobs.slice(1)], artifacts, configuration));
});

test('expired, duplicate, missing or foreign artifacts cannot be transferred', () => {
  const { run, jobs, artifacts } = evidence();
  assert.throws(() => validateCiEvidence(run, jobs, artifacts.slice(1), configuration));
  assert.throws(() => validateCiEvidence(run, jobs, [...artifacts, artifacts[0]], configuration));
  for (const patch of [{ expired: true }, { size_in_bytes: 0 }, { expires_at: '2020-01-01T00:00:00Z' }, { workflow_run: { ...artifacts[0].workflow_run, head_sha: 'b'.repeat(40) } }, { workflow_run: { ...artifacts[0].workflow_run, head_repository_id: 456 } }, { workflow_run: { ...artifacts[0].workflow_run, id: 999 } }]) assert.throws(() => validateCiEvidence(run, jobs, [{ ...artifacts[0], ...patch }, ...artifacts.slice(1)], configuration));
});

test('payload boundaries reject traversal, duplicate paths, private data and bundled language runtimes', () => {
  assert.doesNotThrow(() => assertSafePaths(['题炼.app/', '题炼.app/Contents/Resources/app.asar', '题炼.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib']));
  for (const path of ['/absolute', '../outside', 'resources/../outside', 'C:\\outside', 'resources/.aoci/state', 'resources/.mcp.json', 'resources/.env', 'resources/backups/old.algobak', 'resources/learning.sqlite-wal', 'resources/python3.14', 'resources/java.exe', 'resources/libjvm.dylib', 'dist/aoci.code.txt', 'dist/AGENTS.md', 'dist/old.zip', 'dist/logs/trace']) assert.throws(() => assertSafePaths([path]), path);
  assert.throws(() => assertSafePaths(['dist/file', 'dist/file']));
  assert.throws(() => assertSafePaths([]));
  assert.doesNotThrow(() => assertSafePaths(['release/AlgoPractice-0.90.0-win-x64.zip'], false));
});

test('macOS ZIP inspection preserves exact Chinese member names and binary contents', { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'algopractice-release-unicode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, '题炼.app'), zip = join(directory, 'unicode.zip'), destination = join(directory, 'extracted');
  const members = ['Contents/Resources/app.asar', 'Contents/MacOS/题炼', 'Contents/Resources/icon.icns'];
  const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await mkdir(join(app, 'Contents/MacOS')); await mkdir(destination);
  for (const member of members) await writeFile(join(app, member), bytes);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  const entries: string[] = await listZipEntries(zip);
  for (const member of members) {
    const entry = `题炼.app/${member}`; assert.ok(entries.includes(entry));
    assert.deepEqual(await readFile(await extractZipEntry(zip, entry, destination)), bytes);
  }
  await assert.rejects(extractZipEntry(zip, '../outside', destination));
  await assert.rejects(extractZipEntry(zip, '题炼.app/Contents/*', destination));
});

test('build verification binds every individual source input, runtime manifest and dependency version', () => {
  const inputs = [{ path: 'src/main.ts', sha256: '1'.repeat(64) }, { path: 'runtime-manifest.json', sha256: '2'.repeat(64) }];
  const build = { application: pkg.name, version: pkg.version, sourceInputs: inputs, sourceHash: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), runtimeManifest: manifest, dependencies: pkg.devDependencies, noticeInventory: [{ name: 'electron' }] };
  const expected = { pkg, inputs, manifest };
  assert.doesNotThrow(() => validateBuildInfo(build, expected));
  for (const patch of [{ version: '0.85.0' }, { application: 'other' }, { sourceHash: '3'.repeat(64) }, { sourceInputs: inputs.slice(1) }, { sourceInputs: [{ ...inputs[0], sha256: '4'.repeat(64) }, inputs[1]] }, { runtimeManifest: { schemaVersion: 99 } }, { dependencies: { electron: '1' } }, { noticeInventory: [] }]) assert.throws(() => validateBuildInfo({ ...build, ...patch }, expected));
});

test('source inputs are rehashed from current files using the build provenance contract', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const inputs: { path: string; sha256: string }[] = await collectSourceInputs(root);
  assert.ok(inputs.length > 100);
  assert.deepEqual(inputs.map(item => item.path), inputs.map(item => item.path).sort());
  assert.equal(new Set(inputs.map(item => item.path)).size, inputs.length);
  for (const path of ['src/desktop/main.ts', 'runtime-manifest.json', 'package-lock.json', 'scripts/build.mjs', 'build/icon.icns']) {
    const input = inputs.find(item => item.path === path);
    assert.ok(input); assert.equal(input.sha256, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'));
  }
  assert.ok(inputs.every(item => !item.path.startsWith('.local/') && !item.path.startsWith('.aoci/')));
});

test('six standalone runtime archives are pinned to trusted HTTPS sources with unique names', () => {
  const assets: { language: string; target: string; name: string; sha256: string; size: number }[] = runtimeAssets(manifest);
  assert.equal(assets.length, 6); assert.equal(new Set(assets.map(asset => asset.name)).size, 6);
  assert.equal(assets.filter(asset => asset.language === 'python').length, 3);
  assert.ok(assets.every(asset => asset.size > 0 && /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(assets.every(asset => asset.name.startsWith(`AlgoPractice-runtime-${asset.language}-${asset.target}.`)));
  const target = manifest.python.targets['darwin-arm64'];
  for (const patch of [{ url: 'http://github.com/unsafe.tar.gz' }, { url: 'https://user:password@github.com/unsafe.tar.gz' }, { url: 'https://evil.example/unsafe.tar.gz' }, { sha256: 'not a digest' }, { size: 0 }, { archive: 'exe' }, { archive: 'zip' }]) {
    const changed = structuredClone(manifest); changed.python.targets['darwin-arm64'] = { ...target, ...patch };
    assert.throws(() => runtimeAssets(changed));
  }
});

test('release command enumerates exactly 14 known assets and can only create a draft at the verified commit', () => {
  const names: string[] = expectedReleaseAssets(pkg.version, manifest);
  assert.equal(names.length, 14); assert.equal(new Set(names).size, 14);
  assert.equal(names.filter(name => name.startsWith('AlgoPractice-0.90.0-')).length, 6);
  assert.equal(names.filter(name => name.startsWith('AlgoPractice-runtime-')).length, 6);
  assert.equal(names.filter(name => name.endsWith('.dmg')).length, 2);
  assert.equal(names.filter(name => name.endsWith('-win-x64.exe')).length, 1);
  const files = names.map(name => `/isolated-assets/${name}`);
  const args: string[] = releaseCreateArguments(configuration, files, '/isolated-notes/release.md');
  assert.deepEqual(args.slice(-14), files);
  assert.ok(args.includes('--draft')); assert.equal(args[args.indexOf('--target') + 1], sha);
  for (const flag of ['--latest', '--clobber', '--generate-notes', '--prerelease']) assert.ok(!args.includes(flag));
  assert.throws(() => releaseCreateArguments(configuration, files.slice(1), '/notes'));
  assert.throws(() => releaseCreateArguments(configuration, [...files.slice(1), files[1]], '/notes'));
});

test('release lookup includes untagged drafts across pages and rejects incomplete or duplicate identities', () => {
  const published = { id: 10, tag_name: 'v0.85.0', draft: false };
  const draft = { id: 20, tag_name: configuration.tag, draft: true };
  assert.equal(releaseForTag([[published], [draft]], configuration.tag), draft);
  assert.equal(releaseForTag([[published]], configuration.tag), null);
  assert.equal(releaseForTag([[]], configuration.tag), null);
  assert.throws(() => releaseForTag([], configuration.tag));
  assert.throws(() => releaseForTag([published], configuration.tag));
  assert.throws(() => releaseForTag([[draft], [{ ...draft, id: 21 }]], configuration.tag));
  assert.throws(() => releaseForTag([[{ ...draft, id: '20' }]], configuration.tag));
});
