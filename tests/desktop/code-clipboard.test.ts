import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeCodeToClipboard } from '../../src/desktop/code-clipboard.ts';

test('code copy preserves whitespace, Unicode and line endings exactly using the injected clipboard writer', () => {
  const writes: string[] = [], clipboard = { writeText: (text: string) => { writes.push(text); } };
  const code = '  # 中文与 emoji 🧪\r\n\tprint("keep spacing")\r\n  ';
  writeCodeToClipboard(code, clipboard); writeCodeToClipboard('', clipboard);
  assert.deepEqual(writes, [code, '']);
});

test('code copy validates the UTF-8 byte limit before any clipboard write and reveals no rejected payload', () => {
  const writes: string[] = [], clipboard = { writeText: (text: string) => { writes.push(text); } };
  const boundary = '🧪'.repeat(1048576 / 4);
  writeCodeToClipboard(boundary, clipboard);
  assert.equal(writes[0], boundary);
  for (const input of [null, undefined, 1, { code: 'PRIVATE_PAYLOAD' }, ['PRIVATE_PAYLOAD'], boundary + 'x', 'PRIVATE_PAYLOAD' + 'x'.repeat(1048576)]) {
    assert.throws(() => writeCodeToClipboard(input, clipboard), error => error instanceof Error && /1 MiB/.test(error.message) && !/PRIVATE_PAYLOAD/.test(error.message));
  }
  assert.equal(writes.length, 1);
});

test('a clipboard failure reaches the caller instead of reporting a successful copy', () => {
  assert.throws(() => writeCodeToClipboard('synthetic', { writeText: () => { throw new Error('clipboard unavailable'); } }), /clipboard unavailable/);
});
