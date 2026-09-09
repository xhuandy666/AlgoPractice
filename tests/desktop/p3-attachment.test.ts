import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AttachmentService, MAX_ATTACHMENT_BYTES, contentHash } from '../../src/desktop/attachment-service';
import type { Attachment } from '../../src/shared/learning';
async function fixture(t: test.TestContext, failRegister = false) {
  const root = await mkdtemp(join(tmpdir(), 'p3-attachment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const records = new Map<string, Attachment>(); const registrations: Attachment[] = []; const pendingDeletion = new Set<string>();
  const service = new AttachmentService({ directory: join(root, 'attachments'), getAttachment: hash => records.get(hash), registerAttachment: attachment => {
    assert.equal(contentHash(readFileSync(join(root, 'attachments', attachment.hash))), attachment.hash);
    registrations.push(attachment);
    if (failRegister) throw new Error('simulated database rejection'); records.set(attachment.hash, attachment); pendingDeletion.delete(attachment.hash); return attachment;
  } });
  return { root, records, service, registrations, pendingDeletion };
}
test('attachment publication precedes DB registration and identical contents deduplicate', async t => {
  const f = await fixture(t), selected = join(f.root, '思路.md'); await writeFile(selected, '# 二分边界\n先写不变量。');
  const attachment = await f.service.addFile(selected), second = await f.service.addFile(selected);
  assert.deepEqual(second, attachment); assert.equal(f.records.size, 1); assert.equal(f.registrations.length, 2);
  assert.equal(contentHash(await readFile(join(f.service.directory, attachment.hash))), attachment.hash);
  assert.equal((await readdir(f.service.directory)).filter(name => name.endsWith('.partial')).length, 0);
  assert.equal((await f.service.read(attachment.hash)).bytes.toString(), '# 二分边界\n先写不变量。');
});
test('failed DB registration only leaves an unreferenced complete blob', async t => {
  const f = await fixture(t, true), selected = join(f.root, 'note.txt'); await writeFile(selected, 'durable first');
  await assert.rejects(f.service.addFile(selected), /database rejection/); assert.equal(f.records.size, 0);
  const hash = contentHash(Buffer.from('durable first')); assert.equal((await readFile(join(f.service.directory, hash))).toString(), 'durable first');
  await assert.rejects(f.service.read(hash), /不存在/);
});
test('attachments reject executable/html/svg, wrong signatures, invalid UTF-8 and source symlinks', async t => {
  const f = await fixture(t);
  for (const [name, bytes] of [['x.exe', Buffer.from('MZ')], ['x.html', Buffer.from('<script>1</script>')], ['x.svg', Buffer.from('<svg/>')], ['x.png', Buffer.from('not png')], ['x.txt', Buffer.from([255, 254])]] as const) {
    const file = join(f.root, name); await writeFile(file, bytes); await assert.rejects(f.service.addFile(file));
  }
  const real = join(f.root, 'real.txt'), alias = join(f.root, 'alias.txt'); await writeFile(real, 'allowed text');
  await symlink(real, alias); await assert.rejects(f.service.addFile(alias)); assert.equal(f.records.size, 0);
});
test('oversized attachments and arbitrary hash/path requests cannot access files', async t => {
  const f = await fixture(t), file = join(f.root, 'large.txt'); await writeFile(file, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 65));
  await assert.rejects(f.service.addFile(file), /不超过/);
  await assert.rejects(f.service.read('../private.txt'), /标识无效/); await assert.rejects(f.service.read('a'.repeat(64)), /不存在/);
});
test('tampering prevents read/export; code attachments open only under a text association', async t => {
  const f = await fixture(t), file = join(f.root, 'solution.py'); await writeFile(file, 'print(1)\n'); const attachment = await f.service.addFile(file);
  const preview = await f.service.openablePath(attachment.hash); assert.ok(preview.endsWith('.txt')); assert.equal((await readFile(preview)).toString(), 'print(1)\n');
  const destination = join(f.root, 'export.py'); await f.service.exportFile(attachment.hash, destination); assert.equal((await readFile(destination)).toString(), 'print(1)\n');
  await assert.rejects(f.service.exportFile(attachment.hash, destination), /EEXIST/);
  await writeFile(join(f.service.directory, attachment.hash), 'print(2)\n');
  await assert.rejects(f.service.read(attachment.hash), /校验失败/); await assert.rejects(f.service.exportFile(attachment.hash, join(f.root, 'bad.py')));
});

test('adding a previously registered hash invokes registration again so deletion candidates can be cancelled', async t => {
  const f = await fixture(t), selected = join(f.root, 'note.txt'), renamed = join(f.root, 'renamed.txt');
  await writeFile(selected, 'same durable content'); const attachment = await f.service.addFile(selected);
  f.pendingDeletion.add(attachment.hash); await writeFile(renamed, 'same durable content');
  const reattached = await f.service.addFile(renamed);
  assert.deepEqual(reattached, attachment); assert.equal(reattached.name, 'note.txt');
  assert.equal(f.registrations.length, 2); assert.deepEqual(f.registrations[1], attachment);
  assert.equal(f.pendingDeletion.has(attachment.hash), false); assert.equal(f.records.size, 1);
});
