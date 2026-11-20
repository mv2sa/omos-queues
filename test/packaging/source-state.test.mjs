// Production-path source provenance: a receipt may name a commit only when the
// package root is its own clean git repository. These tests build a real package
// and run the real verifier for a dirty existing HEAD (untracked and tracked
// changes) and for a package folder nested inside an unrelated clean checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { verifyPackage } from '../../scripts/lib/package-artifact.mjs';
import { readSourceState } from '../../scripts/lib/provenance.mjs';
import { packageExtension } from '../../scripts/package-extension.mjs';
import { createFixture, createScratchRepository } from './helpers/fixture.mjs';

const UNCOMMITTED = { state: 'uncommitted', commit: null, dirty: true };

const withScratch = async (testContext, options) => {
  const repo = await createScratchRepository(options);
  testContext.after(repo.cleanup);
  return repo;
};

const buildScratch = (repo) => {
  const result = spawnSync('bun', ['run', 'build'], { cwd: repo.root, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.status, 0, `scratch build failed:\n${result.stderr}`);
};

const packageWithReceipt = async (packageRoot) => {
  const { receipt } = await packageExtension(packageRoot);
  return receipt;
};

test('a clean own-repository HEAD is the only committed receipt', async (t) => {
  const repo = await withScratch(t);
  buildScratch(repo);
  const head = repo.head();
  const state = readSourceState(repo.root);
  assert.deepEqual(state, { repository: true, commit: head, dirty: false });

  const receipt = await packageWithReceipt(repo);
  assert.deepEqual(receipt.source, { state: 'committed', commit: head, dirty: false });
  await verifyPackage({ root: repo.root, out: repo.out, expectCommit: head });
});

for (const [label, dirty] of [
  ['untracked', async (root) => fs.writeFile(path.join(root, 'local-notes.txt'), 'not part of the package\n')],
  ['tracked', async (root) => fs.appendFile(path.join(root, 'README.md'), '\nlocal edit\n')],
]) {
  test(`a dirty existing HEAD (${label} change) packages honestly as uncommitted`, async (t) => {
    const repo = await withScratch(t);
    buildScratch(repo);
    const head = repo.head();
    await dirty(repo.root);

    const state = readSourceState(repo.root);
    assert.equal(state.repository, true, 'the directory is still the repository root');
    assert.equal(state.commit, head, 'HEAD exists and is visible');
    assert.equal(state.dirty, true);

    const receipt = await packageWithReceipt(repo);
    assert.deepEqual(receipt.source, UNCOMMITTED);
    assert.equal(JSON.stringify(receipt.source).includes(head), false, 'the receipt never names a dirty HEAD');

    // Development packaging must pass its own verifier, and must never look
    // like a release build of an approved revision.
    await verifyPackage({ root: repo.root, out: repo.out });
    await assert.rejects(verifyPackage({ root: repo.root, out: repo.out, expectCommit: head }), /not built from/);
  });
}

test('a package folder nested in a clean checkout does not borrow its HEAD', async (t) => {
  const parent = await withScratch(t);
  const nested = await createFixture({ within: parent.root });
  t.after(nested.cleanup);
  parent.commitAll('add nested package');
  assert.equal(parent.git(['status', '--porcelain']), '', 'the unrelated ancestor is clean');

  const state = readSourceState(nested.root);
  assert.deepEqual(state, { repository: false, commit: null, dirty: true },
    'the ancestor HEAD and cleanliness are not borrowed');

  const receipt = await packageWithReceipt(nested);
  assert.deepEqual(receipt.source, UNCOMMITTED);
  await verifyPackage({ root: nested.root, out: nested.out });
  assert.equal(parent.git(['status', '--porcelain']), '', 'the ancestor stays clean after packaging');
});
