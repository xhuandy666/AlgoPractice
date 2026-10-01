import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const privateAsset = /(?:^|\/)(?:\.aoci|\.local|\.runtime|docs|credentials|backups|runtimes|logs)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|aoci(?:\.code|\.meta)?\.txt|\.mcp\.json|\.env(?:\.[^/]*)?|python(?:3(?:\.\d+)?)?(?:\.exe)?|java(?:c)?(?:\.exe)?|libjvm\.[^/]+)$|\.(?:sqlite(?:3)?|db|algobak|log|tar(?:\.gz)?|tgz|zip)(?:$|-wal$|-shm$)/i;
const platforms = [
  { key: 'macos-arm64', artifact: 'macos-arm64-packages', job: 'macOS Apple Silicon', suffix: 'mac-arm64', target: 'darwin-arm64' },
  { key: 'macos-x64', artifact: 'macos-x64-packages', job: 'macOS Intel', suffix: 'mac-x64', target: 'darwin-x64' },
  { key: 'windows', artifact: 'windows-packages', job: 'Windows x64', suffix: 'win-x64', target: 'win32-x64' },
];

export function releaseConfiguration(argv, env, pkg) {
  assert.equal(argv.length, 4, 'Use --ci-run-id ID --release-tag TAG');
  assert.equal(argv[0], '--ci-run-id'); assert.equal(argv[2], '--release-tag');
  assert.match(argv[1], /^[1-9][0-9]*$/, 'CI run ID must be numeric');
  assert.ok(Number.isSafeInteger(Number(argv[1])), 'CI run ID is out of range');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(argv[3], `v${pkg.version}`, 'Release tag must match package.json');
  assert.equal(env.GITHUB_REF_NAME, 'main', 'Only main can prepare a draft');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'A full checkout SHA is required');
  assert.equal(env.GH_REPO, 'xhuandy666/AlgoPractice', 'Unexpected release repository');
  assert.equal(pkg.repository?.url, `git+https://github.com/${env.GH_REPO}.git`);
  assert.ok(env.GH_TOKEN, 'GH_TOKEN is required');
  return { runId: argv[1], tag: argv[3], sha: env.GITHUB_SHA, repo: env.GH_REPO, version: pkg.version };
}

export function validateCiEvidence(run, jobs, artifacts, configuration, now = Date.now()) {
  const { sha, repo, runId } = configuration;
  assert.equal(String(run.id), runId); assert.equal(run.name, 'Desktop checks');
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, sha);
  assert.equal(run.repository?.full_name, repo); assert.equal(run.head_repository?.full_name, repo);
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'PR builds are not release evidence');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  for (const platform of platforms) {
    const matchingJobs = jobs.filter(job => job.name === platform.job);
    assert.equal(matchingJobs.length, 1, `Missing or duplicate ${platform.job} job`);
    const job = matchingJobs[0];
    assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
    assert.equal(job.head_sha, sha); assert.equal(job.run_attempt, run.run_attempt);
  }
  return platforms.map(platform => {
    const name = `${platform.artifact}-${sha}`;
    const matches = artifacts.filter(artifact => artifact.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate artifact: ${name}`);
    const artifact = matches[0];
    assert.equal(artifact.expired, false); assert.ok(artifact.size_in_bytes > 0);
    assert.ok(Date.parse(artifact.expires_at) > now, 'Artifact has expired');
    assert.equal(artifact.workflow_run?.id, run.id);
    assert.equal(artifact.workflow_run?.head_sha, sha);
    assert.equal(artifact.workflow_run?.head_branch, 'main');
    assert.equal(artifact.workflow_run?.repository_id, run.repository.id);
    assert.equal(artifact.workflow_run?.head_repository_id, run.repository.id);
    return { ...platform, name };
  });
}

export function assertSafePaths(entries, boundary = true) {
  assert.ok(entries.length > 0, 'Archive is empty');
  const unique = new Set();
  for (const input of entries) {
    const path = input.replaceAll('\\', '/');
    assert.ok(path && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.split('/').includes('..') && !/[\0\r\n]/.test(path), 'Unsafe archive path');
    assert.ok(!unique.has(path), 'Duplicate archive path'); unique.add(path);
    if (boundary) assert.ok(!privateAsset.test(path), 'Private data, development assets or language runtimes entered the application');
  }
}

export async function collectSourceInputs(root) {
  async function walk(directory) {
    const result = [];
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = `${directory}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), 'Source provenance cannot contain links');
      if (entry.isDirectory()) result.push(...await walk(path)); else if (entry.isFile()) result.push(path);
    }
    return result;
  }
  const paths = [...await walk('src'), 'build/icon.png', 'build/icon.icns', 'build/icon.ico', 'runtime-manifest.json', 'tokens.css', 'LICENSE', 'package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/check-package-boundary.mjs', 'scripts/prepare-windows-helper.mjs', 'vite.config.ts', 'tsconfig.json', 'index.html'].sort();
  const inputs = [];
  for (const path of paths) {
    assert.ok((await lstat(join(root, path))).isFile(), 'Source provenance requires ordinary files');
    inputs.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  return inputs;
}

export function validateBuildInfo(build, expected) {
  assert.equal(build.application, expected.pkg.name); assert.equal(build.version, expected.pkg.version);
  assert.deepEqual(build.sourceInputs, expected.inputs, 'Build source inputs do not match checked-out HEAD');
  assert.equal(build.sourceHash, sha256(JSON.stringify(expected.inputs)), 'Build source hash does not match HEAD');
  assert.deepEqual(build.runtimeManifest, expected.manifest, 'Build runtime manifest changed');
  assert.deepEqual(build.dependencies, expected.pkg.devDependencies, 'Build dependencies changed');
  assert.ok(Array.isArray(build.noticeInventory) && build.noticeInventory.length > 0, 'Third-party notices are missing');
}

export function runtimeAssets(manifest) {
  const assets = [];
  for (const language of ['python', 'java']) for (const { target } of platforms) {
    const artifact = manifest[language]?.targets?.[target];
    assert.ok(artifact && Number.isSafeInteger(artifact.size) && artifact.size > 0);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    const url = new URL(artifact.url);
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'github.com');
    assert.ok(!url.username && !url.password && !url.port && !url.search && !url.hash);
    assert.ok(url.pathname.startsWith(language === 'python' ? '/astral-sh/python-build-standalone/releases/download/' : '/adoptium/temurin25-binaries/releases/download/'));
    const upstreamName = decodeURIComponent(basename(url.pathname));
    assert.ok(['tar.gz', 'zip'].includes(artifact.archive), 'Unexpected runtime archive format');
    assert.match(upstreamName, /^[A-Za-z0-9_+.\-]+\.(?:tar\.gz|zip)$/);
    assert.ok(upstreamName.endsWith(`.${artifact.archive}`), 'Runtime URL and archive format differ');
    const name = `AlgoPractice-runtime-${language}-${target}.${artifact.archive}`;
    assets.push({ ...artifact, language, target, name });
  }
  assert.equal(new Set(assets.map(asset => asset.name)).size, 6, 'Runtime asset names must be unique');
  return assets;
}

export function expectedReleaseAssets(version, manifest) {
  return [...platforms.flatMap(platform => [`AlgoPractice-${version}-${platform.suffix}.${platform.key === 'windows' ? 'exe' : 'dmg'}`, `AlgoPractice-${version}-${platform.suffix}.zip`]), ...runtimeAssets(manifest).map(asset => asset.name), 'runtime-manifest.json', 'SHA256SUMS.txt'];
}

async function command(program, args, options = {}) {
  try {
    return (await execute(program, args, { encoding: 'utf8', maxBuffer: 12_000_000, timeout: 120_000, ...options })).stdout;
  } catch {
    // Child errors can contain authorization headers, temporary URLs or private paths.
    throw new Error(`${program} failed during release preparation`);
  }
}

async function fileDigest(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

async function fileTree(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    files.push(path);
    if (entry.isDirectory()) files.push(...await fileTree(root, path));
  }
  return files;
}

function verifyPayload(path, expected, asar) {
  const pkg = JSON.parse(asar.extractFile(path, 'package.json').toString('utf8'));
  assert.equal(pkg.name, expected.pkg.name); assert.equal(pkg.version, expected.pkg.version);
  assert.equal(pkg.productName, '题炼'); assert.equal(pkg.main, 'dist/main.cjs');
  const build = JSON.parse(asar.extractFile(path, 'dist/build-info.json').toString('utf8'));
  validateBuildInfo(build, expected);
  const files = asar.listPackage(path).map(file => file.replace(/^\//, ''));
  assertSafePaths(files);
  for (const file of files) {
    assert.ok(file === 'package.json' || file === 'LICENSE' || file === 'dist' || file.startsWith('dist/'), 'Application payload escaped its allowlist');
    assert.ok(!asar.statFile(path, file).link, 'Application payload contains a link');
  }
  for (const file of ['dist/main.cjs', 'dist/preload.cjs', 'dist/assets/icon.png', 'dist/THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(file));
  assert.ok(files.some(file => /^dist\/licenses\/electron-[^/]+\/LICENSES\.chromium\.html$/.test(file)));
  for (const item of build.noticeInventory) for (const notice of item.notices) {
    assert.match(notice.sha256, /^[a-f0-9]{64}$/);
    assert.ok(files.includes(`dist/${notice.file}`));
    assert.equal(sha256(asar.extractFile(path, `dist/${notice.file}`)), notice.sha256, 'Third-party notice hash changed');
  }
  return { sourceHash: build.sourceHash, payloadFiles: files.length };
}

function verifyPe(bytes, x64) {
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ', 'Expected a PE executable');
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset >= 64 && offset + 6 <= bytes.length);
  assert.equal(bytes.subarray(offset, offset + 4).toString('hex'), '50450000');
  assert.ok(x64 ? bytes.readUInt16LE(offset + 4) === 0x8664 : [0x14c, 0x8664].includes(bytes.readUInt16LE(offset + 4)), 'Wrong executable architecture');
}

async function verifyZip(archive, platform, expected, temporary, asar) {
  await command('unzip', ['-tq', archive]);
  const entries = (await command('unzip', ['-Z1', archive])).trim().split('\n');
  assertSafePaths(entries);
  const payloads = entries.filter(entry => /(?:^|\/)resources\/app\.asar$|\.app\/Contents\/Resources\/app\.asar$/.test(entry));
  assert.equal(payloads.length, 1, 'Archive must contain exactly one application payload');
  const folder = await mkdtemp(join(temporary, `${platform.key}-zip-`));
  await command('unzip', ['-j', archive, payloads[0], '-d', folder]);
  const payload = join(folder, 'app.asar');
  const result = verifyPayload(payload, expected, asar);
  const executable = entries.filter(entry => platform.key === 'windows' ? /(?:^|\/)题炼\.exe$/.test(entry) : entry.endsWith('.app/Contents/MacOS/题炼'));
  assert.equal(executable.length, 1);
  await command('unzip', ['-j', archive, executable[0], '-d', folder]);
  if (platform.key === 'windows') {
    verifyPe(await readFile(join(folder, '题炼.exe')), true);
    assert.equal(entries.filter(entry => /(?:^|\/)resources\/windows-job-helper\.exe$/.test(entry)).length, 1);
  } else {
    assert.equal((await command('lipo', ['-archs', join(folder, '题炼')])).trim(), platform.target === 'darwin-arm64' ? 'arm64' : 'x86_64');
    const icons = entries.filter(entry => entry.endsWith('.app/Contents/Resources/icon.icns'));
    assert.equal(icons.length, 1); await command('unzip', ['-j', archive, icons[0], '-d', folder]);
    assert.equal(await fileDigest(join(folder, 'icon.icns')), expected.iconHash, 'macOS icon differs from HEAD');
  }
  return { ...result, payloadHash: await fileDigest(payload) };
}

async function sevenZipEntries(archive) {
  const listing = await command('7zz', ['l', '-slt', '-ba', archive]);
  const entries = [...listing.matchAll(/^Path = (.+)$/gm)].map(match => match[1]);
  assert.ok(!/^Symbolic Link = /m.test(listing), 'Installer payload contains a link');
  assertSafePaths(entries); return entries;
}

async function verifyInstaller(archive, platform, expected, portable, temporary, asar) {
  if (platform.key === 'windows') {
    verifyPe(await readFile(archive), false);
    await command('7zz', ['t', archive]);
    const entries = await sevenZipEntries(archive);
    const nested = entries.filter(entry => /(?:^|[\\/])app-64\.7z$/.test(entry));
    assert.equal(nested.length, 1, 'NSIS installer must contain one x64 application archive');
    const folder = await mkdtemp(join(temporary, 'nsis-'));
    await command('7zz', ['x', archive, nested[0], `-o${folder}`, '-y']);
    const inner = join(folder, ...nested[0].replaceAll('\\', '/').split('/'));
    await sevenZipEntries(inner); await command('7zz', ['t', inner]);
    const payloadFolder = await mkdtemp(join(temporary, 'nsis-payload-'));
    await command('7zz', ['x', inner, 'resources/app.asar', `-o${payloadFolder}`, '-y']);
    const payload = join(payloadFolder, 'resources/app.asar');
    verifyPayload(payload, expected, asar);
    assert.equal(await fileDigest(payload), portable.payloadHash, 'Installer and portable archive application payloads differ');
    return;
  }
  await command('hdiutil', ['verify', archive]);
  const mountpoint = await mkdtemp(join(temporary, `${platform.key}-dmg-`));
  await command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, archive]);
  try {
    const entries = await fileTree(mountpoint); assertSafePaths(entries);
    const payloads = entries.filter(entry => entry.endsWith('.app/Contents/Resources/app.asar'));
    assert.equal(payloads.length, 1);
    const payload = join(mountpoint, payloads[0]); verifyPayload(payload, expected, asar);
    assert.equal(await fileDigest(payload), portable.payloadHash, 'DMG and ZIP application payloads differ');
    const resources = join(payload, '..');
    assert.equal(await fileDigest(join(resources, 'icon.icns')), expected.iconHash);
    await command('codesign', ['--verify', '--deep', '--strict', join(resources, '../..')]);
  } finally { await command('hdiutil', ['detach', mountpoint]); }
}

export function releaseCreateArguments(configuration, files, notesPath) {
  assert.equal(files.length, 14, 'Expected exactly 14 release assets');
  assert.equal(new Set(files.map(path => basename(path))).size, 14, 'Duplicate release asset name');
  return ['release', 'create', configuration.tag, '--repo', configuration.repo, '--draft', '--target', configuration.sha, '--title', `题炼 ${configuration.tag}`, '--notes-file', notesPath, ...files];
}

export function releaseForTag(pages, tag) {
  assert.ok(Array.isArray(pages) && pages.length > 0, 'Release listing is incomplete');
  assert.ok(pages.every(page => Array.isArray(page)), 'Release listing has an unexpected shape');
  const releases = pages.flat();
  assert.ok(releases.every(release => Number.isSafeInteger(release.id) && release.id > 0 && typeof release.tag_name === 'string'), 'Release identity is invalid');
  const matching = releases.filter(release => release.tag_name === tag);
  assert.ok(matching.length <= 1, 'Multiple releases use the requested tag');
  return matching[0] ?? null;
}

export async function prepareReleaseDraft(argv = process.argv.slice(2), env = process.env, root = process.cwd()) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const configuration = releaseConfiguration(argv, env, pkg);
  assert.equal(process.platform, 'darwin', 'Draft preparation requires a macOS runner');
  assert.equal((await command('git', ['rev-parse', 'HEAD'], { cwd: root })).trim(), configuration.sha);
  const { tag, repo, sha, runId, version } = configuration;
  const api = async (path, ...options) => JSON.parse(await command('gh', ['api', path, ...options], { env }));
  // The tag-name REST endpoint only returns published releases. An authenticated
  // paginated listing also includes drafts, which may not have a Git tag yet.
  const findRelease = async () => releaseForTag(await api(`repos/${repo}/releases?per_page=100`, '--paginate', '--slurp'), tag);
  async function ensureReleaseAbsent() {
    assert.equal(await findRelease(), null, 'Release or draft already exists; refusing to overwrite it');
  }
  async function ensureAbsent(path) {
    try { await execute('gh', ['api', path], { env, timeout: 30_000 }); }
    catch (error) { if (String(error.stderr).includes('HTTP 404')) return; throw new Error('Cannot verify that the release/tag is absent'); }
    throw new Error('Release or tag already exists; refusing to overwrite it');
  }
  await ensureReleaseAbsent(); await ensureAbsent(`repos/${repo}/git/ref/tags/${tag}`);
  const run = await api(`repos/${repo}/actions/runs/${runId}`);
  const jobs = await api(`repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const artifactList = await api(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  assert.equal(jobs.total_count, jobs.jobs.length, 'Paginated job evidence is incomplete');
  assert.equal(artifactList.total_count, artifactList.artifacts.length, 'Paginated artifact evidence is incomplete');
  const selected = validateCiEvidence(run, jobs.jobs, artifactList.artifacts, configuration);
  const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'));
  const expected = { pkg, manifest, inputs: await collectSourceInputs(root), iconHash: await fileDigest(join(root, 'build/icon.icns')) };
  assert.deepEqual(pkg.build.files, ['dist/**/*', 'package.json', 'LICENSE']);
  assert.ok(!pkg.build.extraResources && !pkg.build.mac.extraResources);
  assert.deepEqual(pkg.build.win.extraResources, [{ from: '.runtime-tools/windows-job-helper.exe', to: 'windows-job-helper.exe' }]);
  const temporary = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'algopractice-release-draft-'));
  const assetsDirectory = join(temporary, 'assets'); await mkdir(assetsDirectory);
  const asar = createRequire(join(root, 'package.json'))('@electron/asar');
  const verified = [];
  for (const platform of selected) {
    const destination = join(temporary, platform.key); await mkdir(destination);
    await command('gh', ['run', 'download', runId, '--repo', repo, '--name', platform.name, '--dir', destination], { env, timeout: 300_000 });
    const entries = await fileTree(destination); assertSafePaths(entries, false);
    for (const entry of entries) assert.ok(!(await lstat(join(destination, entry))).isSymbolicLink(), 'CI artifact contains a link');
    validateBuildInfo(JSON.parse(await readFile(join(destination, 'dist/build-info.json'), 'utf8')), expected);
    const installerName = `AlgoPractice-${version}-${platform.suffix}.${platform.key === 'windows' ? 'exe' : 'dmg'}`;
    const zipName = `AlgoPractice-${version}-${platform.suffix}.zip`;
    assert.deepEqual(entries.filter(entry => !entry.endsWith('/') && /\.(?:dmg|zip|exe)$/.test(entry)).sort(), [`release/${installerName}`, `release/${zipName}`].sort(), 'Unexpected application assets');
    const portable = await verifyZip(join(destination, 'release', zipName), platform, expected, temporary, asar);
    await verifyInstaller(join(destination, 'release', installerName), platform, expected, portable, temporary, asar);
    for (const name of [installerName, zipName]) await copyFile(join(destination, 'release', name), join(assetsDirectory, name));
    verified.push({ platform: platform.key, ...portable });
  }
  // No authorization header is sent to upstream URLs or their CDN redirects.
  const downloadEnvironment = { ...env }; delete downloadEnvironment.GH_TOKEN; delete downloadEnvironment.GITHUB_TOKEN;
  for (const runtime of runtimeAssets(manifest)) {
    const destination = join(assetsDirectory, runtime.name);
    await command('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5', '--max-time', '300', '--output', destination, runtime.url], { env: downloadEnvironment, timeout: 310_000 });
    assert.equal((await lstat(destination)).size, runtime.size, 'Runtime archive size differs from pinned manifest');
    assert.equal(await fileDigest(destination), runtime.sha256, 'Runtime archive hash differs from pinned manifest');
  }
  await copyFile(join(root, 'runtime-manifest.json'), join(assetsDirectory, 'runtime-manifest.json'));
  const names = expectedReleaseAssets(version, manifest);
  assert.deepEqual((await readdir(assetsDirectory)).sort(), names.filter(name => name !== 'SHA256SUMS.txt').sort());
  const hashes = [], digests = new Map();
  for (const name of names.filter(name => name !== 'SHA256SUMS.txt').sort()) {
    const digest = await fileDigest(join(assetsDirectory, name)); digests.set(name, digest);
    hashes.push(`${digest}  ${name}`);
  }
  await writeFile(join(assetsDirectory, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
  digests.set('SHA256SUMS.txt', await fileDigest(join(assetsDirectory, 'SHA256SUMS.txt')));
  assert.deepEqual((await readdir(assetsDirectory)).sort(), [...names].sort());
  const notesPath = join(temporary, 'release-notes.md');
  await writeFile(notesPath, `题炼 ${tag} 草稿。\n\n构建提交：${sha}\n三平台验证：[Desktop checks](https://github.com/${repo}/actions/runs/${runId})\n\n包含 macOS Apple Silicon、macOS Intel 与 Windows x64 的安装器和便携包，以及独立的 Python 3.14 与 Java 25 离线运行时；应用不内置语言运行环境。\n\nmacOS 使用临时签名，未进行开发者签名或公证；Windows 安装器未签名。升级前请先导出本机学习备份。AI 使用自带 Key，费用由所选服务商决定。\n\n本工具仅创建草稿，不发布、不覆盖已有版本。\n`);
  // Recheck immediately before the only release mutation.
  await ensureReleaseAbsent(); await ensureAbsent(`repos/${repo}/git/ref/tags/${tag}`);
  await command('gh', releaseCreateArguments(configuration, names.map(name => join(assetsDirectory, name)), notesPath), { env, timeout: 600_000 });
  const created = await findRelease(); assert.ok(created, 'Created release is missing from the authenticated listing');
  const release = await api(`repos/${repo}/releases/${created.id}`);
  assert.equal(release.draft, true); assert.equal(release.target_commitish, sha); assert.equal(release.tag_name, tag);
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...names].sort());
  for (const asset of release.assets) {
    assert.equal(asset.state, 'uploaded', 'Release asset upload is incomplete');
    assert.equal(asset.size, (await lstat(join(assetsDirectory, asset.name))).size);
    assert.equal(asset.digest, `sha256:${digests.get(asset.name)}`, 'Remote release asset digest differs');
  }
  console.log(JSON.stringify({ result: 'draft-created', tag, commit: sha, ciRun: runId, applications: verified, assets: release.assets.map(asset => ({ name: asset.name, size: asset.size, sha256: digests.get(asset.name) })) }, null, 2));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) prepareReleaseDraft().catch(error => {
  console.error(`Release draft preparation stopped: ${error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message}`);
  process.exitCode = 1;
});
