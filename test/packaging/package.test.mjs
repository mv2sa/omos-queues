import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { sha256, listTree } from '../../scripts/lib/fs-util.mjs';
import { archivePathIn, installPathIn, verifyPackage } from '../../scripts/lib/package-artifact.mjs';
import { PAYLOAD_FILES } from '../../scripts/lib/payload.mjs';
import { packageExtension } from '../../scripts/package-extension.mjs';
import { createFixture, remove, rewrite } from './helpers/fixture.mjs';
import { crc32, inspectZip } from './helpers/zip-inspect.mjs';

const withFixture = (testContext, options) => createFixture(options).then((fixture) => {
  testContext.after(fixture.cleanup);
  return fixture;
});

const relativeFiles = async (directory) => (await listTree(directory))
  .map((file) => path.relative(directory, file).split(path.sep).join('/')).sort();

const failWith = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
};

test('the install payload is the exact whitelist staged from identical bytes', async (t) => {
  const fixture = await withFixture(t);
  await packageExtension(fixture);

  const install = installPathIn(fixture.out);
  assert.deepEqual(await relativeFiles(install), [...PAYLOAD_FILES].sort());
  for (const memberPath of PAYLOAD_FILES) {
    const staged = await fs.readFile(path.join(install, memberPath));
    const source = await fs.readFile(path.join(fixture.root, memberPath));
    assert.deepEqual(staged, source, `${memberPath} must be copied byte for byte`);
    const info = await fs.stat(path.join(install, memberPath));
    assert.equal(info.mode & 0o777, 0o644);
  }
  assert.equal(await fs.stat(install).then((info) => info.isDirectory()), true);

  const inspected = inspectZip(await fs.readFile(archivePathIn(fixture.out, '0.1.0')));
  assert.deepEqual(inspected.entries.map((entry) => entry.path), [...PAYLOAD_FILES]);
  for (const entry of inspected.entries) {
    assert.equal(entry.path.includes('node_modules'), false);
    assert.equal(entry.path.endsWith('.ts'), false);
    assert.equal(entry.path.startsWith('src/'), false);
  }
});

test('the archive is deterministic and every CRC and hash matches the extracted bytes', async (t) => {
  const fixture = await withFixture(t);
  const first = await packageExtension(fixture);
  const firstArchive = await fs.readFile(archivePathIn(fixture.out, '0.1.0'));
  const firstReceipt = await fs.readFile(path.join(fixture.out, 'receipt.json'));

  const second = await packageExtension(fixture);
  assert.deepEqual(second.archive, first.archive);
  assert.deepEqual(await fs.readFile(path.join(fixture.out, 'receipt.json')), firstReceipt);
  assert.equal(sha256(firstArchive), first.receipt.archive.sha256);

  const inspected = inspectZip(firstArchive);
  const members = new Map(first.receipt.members.map((member) => [member.path, member]));
  for (const entry of inspected.entries) {
    assert.equal(entry.crc, crc32(entry.data), `${entry.path} CRC`);
    assert.equal(entry.compressed, entry.uncompressed);
    const member = members.get(entry.path);
    assert.ok(member, `${entry.path} must be in the receipt`);
    assert.equal(member.bytes, entry.data.length);
    assert.equal(member.sha256, sha256(entry.data));
    assert.deepEqual(entry.data, await fs.readFile(path.join(installPathIn(fixture.out), entry.path)));
  }
  assert.deepEqual([...members.keys()], [...PAYLOAD_FILES]);

  // The same content packaged from a different directory must produce the same
  // archive: no path, timestamp or order leaks into the bytes.
  const other = await withFixture(t);
  const third = await packageExtension(other);
  assert.deepEqual(third.archive, first.archive);
  assert.deepEqual(third.receipt.members, first.receipt.members);
});

test('the receipt binds the version, payload bytes and an explicitly uncommitted source', async (t) => {
  const fixture = await withFixture(t);
  const { receipt } = await packageExtension(fixture);
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.package, {
    name: 'omos-queues-extension', version: '0.1.0', extensionId: 'omos-queues',
  });
  assert.deepEqual(receipt.host, { sdk: '2.7.1', engine: '>=2.7.1' });
  assert.deepEqual(receipt.source, { state: 'uncommitted', commit: null, dirty: true });
  assert.equal(receipt.archive.file, 'omos-queues-0.1.0.zip');
  assert.equal(receipt.archive.bytes, (await fs.stat(archivePathIn(fixture.out, '0.1.0'))).size);
  for (const check of ['manifest', 'whitelist', 'deterministic', 'sdkChecker', 'runtimeImports']) {
    assert.equal(receipt.checks[check], 'passed', `${check} must pass`);
  }

  const receiptText = await fs.readFile(path.join(fixture.out, 'receipt.json'), 'utf8');
  assert.match(receiptText, /"state": "uncommitted"/);
  assert.doesNotMatch(receiptText, /\/home\/|\/root\/|\/Users\/|[A-Za-z]:\\\\Users/);

  await verifyPackage({ root: fixture.root, out: fixture.out });
  await failWith(verifyPackage({ root: fixture.root, out: fixture.out, expectCommit: 'a'.repeat(40) }),
    /not built from/);
});

test('a version bump drives the archive and receipt without touching identity', async (t) => {
  const fixture = await withFixture(t, { version: '0.1.1' });
  const { receipt, archive } = await packageExtension(fixture);
  assert.equal(receipt.package.version, '0.1.1');
  assert.equal(receipt.archive.file, 'omos-queues-0.1.1.zip');
  assert.equal(receipt.archive.bytes, archive.length);
  const archiveFile = await fs.readFile(archivePathIn(fixture.out, '0.1.1'));
  assert.equal(sha256(archiveFile), receipt.archive.sha256);
  const staged = JSON.parse(await fs.readFile(path.join(installPathIn(fixture.out), 'package.json'), 'utf8'));
  assert.equal(staged.version, '0.1.1');
  assert.equal(staged.private, true);
  assert.equal(staged.name, 'omos-queues-extension');
  assert.equal(staged.openchamber.contributes.panel.id, 'omos-queues');
  assert.deepEqual(staged.openchamber.engines, { openchamber: '>=2.7.1' });
  assert.equal(await fs.access(archivePathIn(fixture.out, '0.1.0')).then(() => true, () => false), false,
    'no archive is written under a stale version name');
});

test('a missing, empty or stale bundle is refused', async (t) => {
  const missing = await withFixture(t);
  await remove(missing.root, 'service/main.js');
  await failWith(packageExtension(missing), /service\/main\.js is missing/);

  const empty = await withFixture(t);
  await rewrite(empty.root, 'page/main.js', '');
  await failWith(packageExtension(empty), /page\/main\.js is empty/);

  const stale = await withFixture(t);
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(stale.root, 'src/page/main.js'), future, future);
  await failWith(packageExtension(stale), /page\/main\.js is stale/);

  const noSource = await withFixture(t);
  await remove(noSource.root, 'src/backend/main.js');
  await failWith(packageExtension(noSource), /src\/backend is missing/);
});

test('the page document may not load network or source resources', async (t) => {
  const fixture = await withFixture(t);
  await rewrite(fixture.root, 'page/index.html',
    '<!doctype html><html><head><script src="https://cdn.example.com/app.js"></script></head><body></body></html>\n');
  await failWith(packageExtension(fixture), /external resource https:\/\/cdn\.example\.com/);

  const typescript = await withFixture(t);
  await rewrite(typescript.root, 'page/index.html',
    '<!doctype html><html><head><script src="main.ts"></script></head><body></body></html>\n');
  await failWith(packageExtension(typescript), /load the built \.js bundle/);
});

test('payload bytes carrying a local absolute path are refused', async (t) => {
  const fixture = await withFixture(t);
  await rewrite(fixture.root, 'page/styles.css', ':root { --fixture: "/home/someone/project"; }\n');
  await failWith(packageExtension(fixture), /contains a local absolute path/);
});

test('a bundle that still needs node_modules is refused', async (t) => {
  const fixture = await withFixture(t);
  await rewrite(fixture.root, 'service/main.js',
    'import { parse } from "jsonc-parser";\nprocess.env.OPENCHAMBER_SERVICE_PORT;\nexport const parseJson = parse;\n');
  await failWith(packageExtension(fixture), /needs node_modules/);
});

test('the staged payload resolves and runs from a relocated directory without node_modules', async (t) => {
  const fixture = await withFixture(t);
  await packageExtension(fixture);

  const relocated = path.join(fixture.base, 'relocated-install');
  await fs.cp(installPathIn(fixture.out), relocated, { recursive: true });
  assert.deepEqual(await relativeFiles(relocated), [...PAYLOAD_FILES].sort());
  assert.equal((await relativeFiles(relocated)).some((file) => file.startsWith('node_modules')), false);

  const service = path.join(relocated, 'service/main.js');
  const page = path.join(relocated, 'page/main.js');
  const code = await fs.readFile(service, 'utf8');
  const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'the fixture service has real imports');
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:|\.{1,2}\/)/, `${specifier} must resolve without node_modules`);
  }
  const pageCode = await fs.readFile(page, 'utf8');
  assert.doesNotMatch(pageCode, /(?:^|[;\s])(?:import|export)\s/);

  execFileSync(process.execPath, ['--check', service], { cwd: relocated });
  execFileSync(process.execPath, ['--check', page], { cwd: relocated });

  // Executing the relocated service proves Node resolves it with no
  // node_modules on any ancestor path: its only imports are builtins.
  const probe = [
    `const guest = await import(${JSON.stringify(pathToFileURL(service).href)});`,
    'if (typeof guest.startService !== "function") process.exit(7);',
    'if (guest.nameOf("/a/b.txt") !== "b.txt") process.exit(8);',
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: relocated,
    env: { PATH: process.env.PATH, HOME: relocated },
    timeout: 20_000,
  });
});

test('verification reads the staged and archived bytes, not gitignore state', async (t) => {
  const fixture = await withFixture(t);
  const { receipt } = await packageExtension(fixture);

  const install = installPathIn(fixture.out);
  await fs.appendFile(path.join(install, 'page/main.js'), '\n');
  await failWith(verifyPackage({ root: fixture.root, out: fixture.out }), /staged page\/main\.js differs/);

  await packageExtension(fixture);
  const archiveFile = archivePathIn(fixture.out, '0.1.0');
  const archive = await fs.readFile(archiveFile);
  const tampered = Buffer.from(archive);
  const entry = inspectZip(archive).entries.find((candidate) => candidate.path === 'service/main.js');
  const target = tampered.indexOf(entry.data);
  tampered[target] ^= 0xff;
  await fs.writeFile(archiveFile, tampered);
  await failWith(verifyPackage({ root: fixture.root, out: fixture.out }), /CRC|digest|differs/);

  await packageExtension(fixture);
  const receiptPath = path.join(fixture.out, 'receipt.json');
  const stored = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(stored.archive.sha256, receipt.archive.sha256);
  stored.archive.sha256 = 'b'.repeat(64);
  await fs.writeFile(receiptPath, `${JSON.stringify(stored, null, 2)}\n`);
  await failWith(verifyPackage({ root: fixture.root, out: fixture.out }), /archive digest/);
});

test('the payload never contains the generated bundle source tree', async (t) => {
  const fixture = await withFixture(t);
  await packageExtension(fixture);
  const inspected = inspectZip(await fs.readFile(archivePathIn(fixture.out, '0.1.0')));
  for (const entry of inspected.entries) {
    // package.json names its build entries on purpose; shipped code must not.
    if (!entry.path.endsWith('.js') && !entry.path.endsWith('.html') && !entry.path.endsWith('.css')) continue;
    const text = entry.data.toString('utf8');
    assert.doesNotMatch(text, /src\/page|src\/backend|test\/packaging/);
    assert.doesNotMatch(text, /\.ts["')\s]/, `${entry.path} must not reference TypeScript sources`);
  }
});
