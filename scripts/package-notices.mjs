import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exact upstream SPDX declarations for the one package whose published archive omits a LICENSE file. */
export async function supplementalPackageNotices(root, metadata) {
  if (metadata.name !== 'lazy-val' || metadata.version !== '1.0.5') return [];
  const directory = join(root, 'build/third-party-notices/lazy-val-1.0.5');
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  for (const key of ['license', 'author', 'repository']) assert.equal(metadata[key], provenance[key], 'Supplemental notice does not match the installed package');
  assert.equal(provenance.package, metadata.name); assert.equal(provenance.version, metadata.version);
  assert.equal(provenance.npmGitHead, 'b69ad4119f1b19bdab13c61ee2fcc88d46b89071');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/lazy-val'].integrity, provenance.npmIntegrity, 'Supplemental notice package integrity changed');
  assert.deepEqual(provenance.files.map(file => file.file).sort(), ['MIT.txt', 'NOTICE.md', 'upstream-package.json']);
  for (const file of provenance.files) {
    const path = join(directory, file.file);
    assert.ok((await lstat(path)).isFile(), 'Supplemental notice is not a regular file');
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), file.sha256, 'Supplemental notice hash changed');
  }
  const upstream = JSON.parse(await readFile(join(directory, 'upstream-package.json'), 'utf8'));
  for (const key of ['name', 'version', 'license', 'author', 'repository']) assert.equal(upstream[key], metadata[key], 'Upstream license declaration does not match the installed package');
  return [...provenance.files.map(file => ({ source: join(directory, file.file), file: file.file })), { source: join(directory, 'provenance.json'), file: 'provenance.json' }];
}
