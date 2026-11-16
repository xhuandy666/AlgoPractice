import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { load } from 'js-yaml';
import { blake2b } from '@noble/hashes/blake2.js';

const targets = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);
function targetSuffix(target) {
  assert.ok(targets.has(target), 'Unsupported update artifact target');
  return target.replace('darwin-', 'mac-').replace('win32-', 'win-');
}
export function updateMetadataName(target) {
  targetSuffix(target);
  return target === 'win32-x64' ? 'latest.yml' : `latest-${target.slice('darwin-'.length)}-mac.yml`;
}
export function platformUpdateArtifacts(version, target) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const stem = `AlgoPractice-${version}-${targetSuffix(target)}`;
  return target === 'win32-x64'
    ? [`${stem}.exe`, `${stem}.zip`, `${stem}.exe.blockmap`, updateMetadataName(target)]
    : [`${stem}.dmg`, `${stem}.zip`, `${stem}.dmg.blockmap`, `${stem}.zip.blockmap`, updateMetadataName(target)];
}
async function digest(file, algorithm = 'sha512') {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('base64');
}
function sha512(value) {
  assert.equal(typeof value, 'string', 'Update SHA512 is missing');
  assert.equal(Buffer.from(value, 'base64').length, 64, 'Update SHA512 has the wrong length');
  assert.equal(Buffer.from(value, 'base64').toString('base64'), value, 'Update SHA512 is not canonical base64');
}

/** Validate the map against its actual archive, including the 18-byte BLAKE2b checksums builder 26 emits. */
async function validateBlockmap(mapPath, archivePath) {
  const compressed = await readFile(mapPath);
  assert.ok(compressed.length > 0 && compressed.length <= 16 * 1024 * 1024, 'Blockmap is missing or oversized');
  const map = JSON.parse(gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
  assert.equal(map.version, '2', 'Unexpected blockmap format');
  assert.equal(map.files?.length, 1, 'Blockmap must describe one complete archive');
  const file = map.files[0];
  assert.equal(file.name, 'file'); assert.equal(file.offset, 0);
  assert.ok(Array.isArray(file.sizes) && file.sizes.length > 0);
  assert.equal(file.checksums?.length, file.sizes.length, 'Blockmap chunk counts differ');
  const input = await open(archivePath, 'r');
  try {
    let position = 0;
    for (let i = 0; i < file.sizes.length; i++) {
      const size = file.sizes[i];
      assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 32 * 1024, 'Invalid blockmap chunk size');
      const buffer = Buffer.alloc(size); let received = 0;
      while (received < size) {
        const { bytesRead } = await input.read(buffer, received, size - received, position + received);
        assert.ok(bytesRead > 0, 'Blockmap extends beyond its archive'); received += bytesRead;
      }
      const checksum = Buffer.from(blake2b(buffer, { dkLen: 18 })).toString('base64');
      assert.equal(file.checksums[i], checksum, 'Blockmap chunk checksum differs from its archive');
      position += size;
    }
    assert.equal(position, (await input.stat()).size, 'Blockmap does not cover its complete archive');
  } finally { await input.close(); }
}

/** Called after packaging and again before release: metadata, maps and the referenced bytes must agree. */
export async function validateUpdateArtifacts(directory, { version, target }) {
  const files = platformUpdateArtifacts(version, target), metadataName = updateMetadataName(target);
  for (const name of files) {
    const info = await lstat(join(directory, name));
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0, `Missing ordinary update artifact: ${name}`);
  }
  const metadataBytes = await readFile(join(directory, metadataName));
  assert.ok(metadataBytes.length <= 1024 * 1024, 'Update metadata is oversized');
  const metadata = load(metadataBytes.toString('utf8'));
  assert.equal(metadata?.version, version, 'Update metadata version differs from the package');
  const referenced = files.filter(name => target === 'win32-x64' ? name.endsWith('.exe') : /\.(?:zip|dmg)$/.test(name));
  assert.ok(Array.isArray(metadata.files), 'Update metadata files are missing');
  assert.deepEqual(metadata.files.map(file => file.url).sort(), [...referenced].sort(), 'Update metadata references foreign, missing or duplicate artifacts');
  for (const file of metadata.files) {
    sha512(file.sha512);
    const archive = join(directory, file.url), info = await lstat(archive);
    assert.equal(file.size, info.size, 'Update metadata size differs from its artifact');
    assert.equal(await digest(archive), file.sha512, 'Update metadata SHA512 differs from its artifact');
  }
  const primary = metadata.files.find(file => file.url === metadata.path);
  assert.ok(primary, 'Update metadata legacy path is not a listed artifact');
  sha512(metadata.sha512); assert.equal(metadata.sha512, primary.sha512, 'Update metadata legacy SHA512 differs');
  const blockmaps = files.filter(name => name.endsWith('.blockmap'));
  for (const name of blockmaps) await validateBlockmap(join(directory, name), join(directory, name.slice(0, -'.blockmap'.length)));
  return { metadata, files, blockmaps };
}
