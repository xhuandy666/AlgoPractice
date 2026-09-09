import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { AiService } from '../../src/ai/service.ts';
import { CredentialVault } from '../../src/ai/credential-vault.ts';
import { canonicalJson, completionEndpoint, normalizeProviderConfig } from '../../src/ai/canonical.ts';
import { buildRequestSnapshot, requestHash } from '../../src/ai/context.ts';
import { BackupService } from '../../src/desktop/backup-service.ts';
import { AI_PROVIDER_SETTINGS_FILE, DEFAULT_REMINDER_SETTINGS } from '../../src/shared/maintenance.ts';
import { AI_PROVIDER_PRESETS, createAiProviderPreset, type AiProviderConfig, type AiRequestSeed } from '../../src/shared/ai.ts';
import { answer, config, context, input, jsonCompletion } from '../ai/helpers.ts';

// Real SQLite, file-backed CredentialVault and complete .algobak operations.
// SafeStorage encryption and HTTP replies are explicit test doubles: no external request or real Key.
const providers = [
  ...AI_PROVIDER_PRESETS.map(preset => ({ name: preset.id, provider: createAiProviderPreset(preset.id, `sqlite-${preset.id}`) })),
  { name: 'legacy-without-compatibility', provider: config() },
];
for (const { name, provider } of providers) test(`AI ${name} completes through SQLite and survives reopen and full backup restore`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'p5-ai-storage 中文 '));
  const origin = join(root, 'origin'), destination = join(root, 'fresh restore');
  await mkdir(origin); await mkdir(destination);
  const originPath = join(origin, 'practice.sqlite');
  let store: PracticeStore | undefined = new PracticeStore(originPath);
  let restored: PracticeStore | undefined;
  t.after(async () => { store?.close(); restored?.close(); await rm(root, { recursive: true, force: true }); });
  const attempt = store.startAttempt({ problemId: 'p1', problemVersion: 'v1', language: 'python' });
  const source = { ...context(), attemptId: attempt.id, problemId: 'p1', problemVersion: 'v1', run: null, notes: [], conversation: [] };
  const request = { ...input('L0'), attemptId: attempt.id };
  const normalized = normalizeProviderConfig(provider);
  const snapshot = buildRequestSnapshot(request, source, normalized);
  const originalHash = requestHash(snapshot);
  if (name === 'legacy-without-compatibility') {
    assert.equal(Object.hasOwn(normalized, 'compatibility'), false);
    assert.equal(canonicalJson(normalized), canonicalJson(provider));
    assert.equal(originalHash, requestHash(buildRequestSnapshot(request, source, provider)), 'old settings keep the exact snapshot/hash');
  }
  const secret = 'synthetic-p5-storage-key';
  const vault = new CredentialVault({ directory: join(origin, 'credentials'), platform: 'darwin', safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0x5a)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 0x5a)).toString(),
  } });
  await vault.setKey(normalized, secret);
  assert.equal(await vault.withKey({ ...normalized, compatibility: 'openai-compatible' }, async key => key), secret, 'protocol-only edits preserve endpoint-bound credentials');
  assert.equal(await vault.hasKey({ ...normalized, baseUrl: 'https://different.example.invalid/v1' }), false);
  let calls = 0;
  const serviceOptions = {
    vault, resolveContext: () => source, resolveProvider: () => normalized,
    fetchImpl: (async (url, init) => {
      calls++;
      assert.equal(String(url), completionEndpoint(normalized));
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, normalized.model);
      if (normalized.compatibility === 'qwen') assert.equal(body.enable_thinking, false);
      if (normalized.compatibility === 'glm' || normalized.compatibility === 'deepseek') assert.deepEqual(body.thinking, { type: 'disabled' });
      return jsonCompletion(JSON.stringify(answer(request, source)));
    }) as typeof fetch,
  };
  const service = new AiService({ ...serviceOptions, repository: store });
  const record = await service.request(request);
  assert.equal(record.status, 'completed'); assert.equal(calls, 1);
  assert.deepEqual(record.snapshot.provider, normalized);
  assert.equal(record.requestHash, originalHash);
  assert.deepEqual(store.getAIRequest(record.id), record);
  assert.deepEqual(store.listAIRequests(attempt.id), [record]);
  assert.ok(!canonicalJson(record).includes(secret));
  store.close(); store = new PracticeStore(originPath);
  assert.deepEqual(store.getAIRequest(record.id), record);
  assert.deepEqual(await new AiService({ ...serviceOptions, repository: store }).request(request), record);
  assert.equal(calls, 1, 'reopened completed record is reused without HTTP');
  const onlinePath = join(root, 'online-copy.sqlite');
  await store.backupTo(onlinePath);
  const onlineCopy = new PracticeStore(onlinePath);
  try { assert.deepEqual(onlineCopy.getAIRequest(record.id), record); onlineCopy.integrityCheck(); } finally { onlineCopy.close(); }
  const makeBackup = (directory: string, current: () => PracticeStore, close: () => void, open: () => void, settings: AiProviderConfig | null) => new BackupService({
    dataDirectory: directory, appVersion: '0.5.0', snapshotDatabase: path => current().backupTo(path),
    inspectSnapshot: PracticeStore.inspectBackupSnapshot, getReminderSettings: () => ({ ...DEFAULT_REMINDER_SETTINGS }), getAiProvider: () => settings,
    lifecycle: { hasActiveInterview: () => false, enterMaintenance: async () => {}, closeDatabase: close, openDatabase: open,
      clearCredentials: async () => { await rm(join(directory, 'credentials'), { recursive: true, force: true }); }, leaveMaintenance: () => {} },
  });
  const backups = makeBackup(origin, () => store!, () => { store!.close(); store = undefined; }, () => { store = new PracticeStore(originPath); }, normalized);
  const backup = await backups.create();
  assert.ok(!backup.manifest.files.some(file => file.path.includes('credential')));
  assert.ok(!(await readFile(backup.path)).includes(Buffer.from(secret)));
  restored = new PracticeStore(join(destination, 'practice.sqlite'));
  const restoreService = makeBackup(destination, () => restored!, () => { restored!.close(); restored = undefined; }, () => { restored = new PracticeStore(join(destination, 'practice.sqlite')); }, null);
  const inspected = await restoreService.inspect(backup.path);
  assert.deepEqual(inspected.manifest, backup.manifest);
  assert.equal((await restoreService.restore(backup.path, backup.manifest)).restored, true);
  assert.deepEqual(restored!.getAIRequest(record.id), record);
  assert.deepEqual(restored!.listAIRequests(attempt.id), [record]);
  const restoredProvider = JSON.parse(await readFile(join(destination, AI_PROVIDER_SETTINGS_FILE), 'utf8'));
  assert.deepEqual(restoredProvider, normalized);
  const restoredService = new AiService({ ...serviceOptions, repository: restored!, resolveProvider: () => restoredProvider });
  assert.deepEqual(await restoredService.request(request), record);
  const cached = await restoredService.request({ ...request, requestId: `${request.requestId}-cached` });
  assert.equal(cached.status, 'completed'); assert.equal(cached.cachedFromRequestId, record.id);
  assert.equal(cached.requestHash, originalHash); assert.equal(calls, 1, 'restored original and cached answer keep their original hash without HTTP');
  assert.equal(Object.hasOwn(restoredProvider, 'compatibility'), name !== 'legacy-without-compatibility');
  restored!.integrityCheck();
});

test('AI SQLite snapshot rejects invalid compatibility values and still excludes provider secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p5-ai-storage-reject-'));
  const store = new PracticeStore(join(root, 'practice.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const attempt = store.startAttempt({ problemId: 'p1', problemVersion: 'v1', language: 'python' });
  const request = { ...input('L0'), attemptId: attempt.id };
  const source = { ...context(), attemptId: attempt.id, problemId: 'p1', problemVersion: 'v1', run: null };
  const snapshot = buildRequestSnapshot(request, source, normalizeProviderConfig(config()));
  const seed = { id: request.requestId, attemptId: attempt.id, snapshot, requestHash: requestHash(snapshot) };
  for (const compatibility of ['unknown-provider', 'synthetic-secret-value', null, 42, {}]) {
    const invalid = { ...seed, snapshot: { ...snapshot, provider: { ...snapshot.provider, compatibility } } } as unknown as AiRequestSeed;
    assert.throws(() => store.beginAIRequest(invalid), /Invalid AI provider compatibility/);
  }
  for (const key of ['apiKey', 'authorization', 'extra_body']) {
    const invalid = { ...seed, snapshot: { ...snapshot, provider: { ...snapshot.provider, [key]: 'synthetic-secret-value' } } } as AiRequestSeed;
    assert.throws(() => store.beginAIRequest(invalid), /Credentials or unknown fields/);
  }
  assert.deepEqual(store.listAIRequests(attempt.id), []);
});
