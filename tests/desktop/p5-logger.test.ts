import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger } from '../../src/desktop/logger.ts';

test('P5 logs preserve operational metadata and exclude payloads and reserved field overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p5-log-'));
  try {
    const log = createLogger(directory);
    log('run.finished', { language: 'python', result: 'passed', durationMs: 123.5, interrupted: false,
      statement: '题目正文隐私', problemTitle: '私密题目标题', prompt: 'private-prompt', code: 'print("private-code")',
      stdin: 'private-input', stdout: 'private-output', expected: 'private-answer', apiKey: 'sk-private-key',
      message: 'private-error', at: 'spoofed-time', event: 'spoofed-event' });
    log('ipc.failed', { operation: 'runner:run', category: 'TypeError', status: 'sk-private-key', result: 'private problem text' });
    log('题目正文 print("private-code")', { durationMs: Infinity, count: Number.NaN });
    const raw = readFileSync(join(directory, 'application.jsonl'), 'utf8');
    const [run, failure, invalid] = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(run.event, 'run.finished'); assert.equal(run.language, 'python'); assert.equal(run.result, 'passed');
    assert.equal(run.durationMs, 123.5); assert.equal(run.interrupted, false); assert.ok(Number.isFinite(Date.parse(run.at)));
    assert.deepEqual(Object.keys(run).sort(), ['at', 'durationMs', 'event', 'interrupted', 'language', 'result']);
    assert.equal(failure.operation, 'runner:run'); assert.equal(failure.category, 'TypeError');
    assert.equal(invalid.event, 'invalid.event'); assert.equal(invalid.count, undefined);
    assert.ok(!/private|隐私|私密|正文|spoofed/.test(raw));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('P5 rotates before a record would cross 1 MiB', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p5-log-'));
  try {
    const file = join(directory, 'application.jsonl');
    writeFileSync(file, 'x'.repeat(1024 * 1024 - 1));
    createLogger(directory)('run.finished', { result: 'passed' });
    assert.equal(statSync(`${file}.1`).size, 1024 * 1024 - 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).event, 'run.finished');
    assert.ok(statSync(file).size < 1024);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('P5 sustained logging retains at most 5 MiB in complete records and retains newest counters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p5-log-'));
  try {
    const log = createLogger(directory), long = 'x'.repeat(200);
    for (let count = 0; count < 11000; count++) log('run.finished', { result: long, operation: long, category: long, version: long, count });
    const files = readdirSync(directory); assert.equal(files.length, 5);
    let size = 0, retained = 0;
    for (const name of files) {
      const file = join(directory, name), bytes = statSync(file).size; size += bytes;
      assert.ok(bytes <= 1024 * 1024, `${name} exceeds 1 MiB`);
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) { const row = JSON.parse(line); assert.equal(row.event, 'run.finished'); retained++; }
      if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.ok(size <= 5 * 1024 * 1024); assert.ok(retained > 0 && retained < 11000);
    const latest = readFileSync(join(directory, 'application.jsonl'), 'utf8').trim().split('\n').at(-1)!;
    assert.equal(JSON.parse(latest).count, 10999);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('P5 arbitrary field floods do not expand a log record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p5-log-'));
  try {
    createLogger(directory)('run.finished', Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`field${index}`, 'x'.repeat(200)])));
    const raw = readFileSync(join(directory, 'application.jsonl'), 'utf8');
    assert.ok(Buffer.byteLength(raw) < 128); assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['at', 'event']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
