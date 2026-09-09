import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger } from '../../src/desktop/logger.ts';

test('operational logs omit sensitive payload fields and bound large strings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p2-log-'));
  try {
    createLogger(directory)('run.finished', { language: 'python', code: 'private-code', Cookie: 'private-cookie', accessToken: 'private-token', sourceUrl: 'private-url', result: 'x'.repeat(200) });
    const raw = readFileSync(join(directory, 'application.jsonl'), 'utf8');
    const entry = JSON.parse(raw); assert.equal(entry.language, 'python'); assert.equal(entry.result.length, 120);
    assert.ok(!raw.includes('private-')); assert.ok(entry.at);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rotation bounds retained generations while keeping the latest event', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p2-log-'));
  try {
    const log = createLogger(directory), file = join(directory, 'application.jsonl');
    for (let index = 0; index < 7; index++) { writeFileSync(file, 'x'.repeat(1024 * 1024 + 1)); log('generation', { generation: index }); }
    assert.equal(readdirSync(directory).length, 5); assert.equal(JSON.parse(readFileSync(file, 'utf8')).generation, 6);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
