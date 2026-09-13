import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { AiService } from '../../src/ai/service.ts';
import { answer, config, context, input, jsonCompletion, mockVault } from '../ai/helpers.ts';

test('A final validation failure persists its safe reason across SQLite reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tilian-ai-validation-'));
  const path = join(directory, 'practice.sqlite');
  let store = new PracticeStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const attempt = store.startAttempt({ problemId: 'p1', problemVersion: 'v1', language: 'python' });
  const source = { ...context(), attemptId: attempt.id, problemId: 'p1', problemVersion: 'v1', run: null, notes: [], conversation: [] };
  const request = { ...input(), attemptId: attempt.id };
  const response = answer(request, source);
  response.evidence = [{ kind: 'official', runId: 'invented-submission', quote: 'PRIVATE-UNVERIFIED-REPLY' }];
  let calls = 0;
  const service = new AiService({ repository: store, vault: mockVault(), resolveContext: () => source, resolveProvider: config,
    fetchImpl: async () => { calls++; return jsonCompletion(JSON.stringify(response)); } });
  const record = await service.request(request);
  assert.equal(calls, 2, 'only one bounded repair follows the first rejection');
  assert.equal(record.status, 'failed');
  assert.equal(record.error?.validationReason, 'officialRun');
  assert.equal(record.response, null);
  assert.ok(!JSON.stringify(record).includes('PRIVATE-UNVERIFIED-REPLY'));
  store.close(); store = new PracticeStore(path);
  assert.deepEqual(store.getAIRequest(record.id), record);
  assert.equal(store.getAIRequest(record.id)?.error?.validationReason, 'officialRun');
  store.integrityCheck();
});
