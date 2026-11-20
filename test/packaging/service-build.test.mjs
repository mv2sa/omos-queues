// The service gate must be observable, not a specifier regex. These tests build
// the real backend entry with the production build wrapper, import the real
// artifact from a directory without node_modules, and prove the gate rejects the
// UMD jsonc-parser bundle that shipped with "Cannot find module './impl/format'".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { assertPassiveServiceImport } from '../../scripts/lib/bundles.mjs';
import { packageExtension } from '../../scripts/package-extension.mjs';
import { REPO_ROOT, createFixture, createScratchRepository } from './helpers/fixture.mjs';

const BUILD_SERVICE = path.join(REPO_ROOT, 'scripts/build-service.mjs');
const SDK_BUNDLER = path.join(REPO_ROOT, 'node_modules/@openchamber/sdk/scripts/bundle-guest.ts');

const tempRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'omos-service-test-'));

const buildService = (out, timeout = 120_000) => spawnSync('bun', [BUILD_SERVICE, '--root', REPO_ROOT, '--out', out], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  timeout,
  env: process.env,
});

const buildWithSdk = (out) => spawnSync('bun', ['--no-install', SDK_BUNDLER, '--node',
  path.join(REPO_ROOT, 'src/backend/main.js'), out], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  timeout: 120_000,
  env: process.env,
});

const buildFrom = (out, { cwd = REPO_ROOT, root = REPO_ROOT } = {}) => spawnSync('bun', [
  BUILD_SERVICE, '--root', root, '--out', out,
], {
  cwd,
  encoding: 'utf8',
  timeout: 180_000,
  env: process.env,
});

const writeService = async (directory, source) => {
  const file = path.join(directory, 'service/main.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
  return file;
};

test('the production build makes the real service importable without node_modules', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'service/main.js');

  const result = buildService(out);
  assert.equal(result.status, 0, `build-service failed:\n${result.stderr}`);
  assert.match(result.stdout, /Verified by importing it from a relocated directory without node_modules/);

  const code = await fs.readFile(out, 'utf8');
  assert.match(code, /jsonc-parser\/lib\/esm\//, 'the ESM entry of jsonc-parser is bundled');
  assert.doesNotMatch(code, /jsonc-parser\/lib\/umd\//, 'the UMD entry is never bundled');
  assert.doesNotMatch(code, /require2?\(\s*["']\.\/impl\//, 'no unresolved impl require survives');
  assert.doesNotMatch(code, /\b__require\b/, 'no CommonJS require shim survives');
  assert.match(code, /OPENCHAMBER_SERVICE_PORT/, 'the host can still reach the service');

  // The production gate itself: plain Node, relocated, no node_modules.
  await assertPassiveServiceImport(out);
});

test('the real service builds byte-identically from any working directory, without personal paths', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const fromRepo = path.join(base, 'from-repo.js');
  const fromTemp = path.join(base, 'from-temp.js');

  assert.equal(buildFrom(fromRepo, { cwd: REPO_ROOT }).status, 0);
  assert.equal(buildFrom(fromTemp, { cwd: os.tmpdir() }).status, 0);
  const [repoBytes, tempBytes] = await Promise.all([fs.readFile(fromRepo), fs.readFile(fromTemp)]);
  assert.deepEqual(tempBytes, repoBytes, 'the working directory must not change the bytes');
  for (const bytes of [repoBytes, tempBytes]) {
    const code = bytes.toString('utf8');
    assert.doesNotMatch(code, /\/home\/|\/Users\/|\/root\/|\/tmp\//, 'no personal module-header paths');
    assert.match(code, /^\/\/ src\/backend\/main\.js$/m, 'module headers are relative to the package');
  }
  await assertPassiveServiceImport(fromTemp);
});

test('a package outside the cwd builds with relative headers and identical bytes', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = await createScratchRepository({ version: '0.1.0' });
  t.after(repo.cleanup);
  const fromRepo = path.join(base, 'scratch-from-repo.js');
  const fromScratch = path.join(base, 'scratch-from-root.js');

  assert.equal(buildFrom(fromRepo, { root: repo.root, cwd: REPO_ROOT }).status, 0);
  assert.equal(buildFrom(fromScratch, { root: repo.root, cwd: repo.root }).status, 0);
  const [a, b] = await Promise.all([fs.readFile(fromRepo), fs.readFile(fromScratch)]);
  assert.deepEqual(a, b, '--root gives the same bytes from a different cwd');
  const code = a.toString('utf8');
  assert.doesNotMatch(code, /\/tmp\/|\/home\//, 'no absolute package paths leak as comments');
  assert.match(code, /^\/\/ src\/backend\/main\.js$/m);
  await assertPassiveServiceImport(fromRepo);
});

test('the gate rejects the broken UMD bundle that shipped, and so does packaging', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'broken/service/main.js');
  await fs.mkdir(path.dirname(out), { recursive: true });

  const result = buildWithSdk(out);
  assert.equal(result.status, 0, `SDK bundler failed:\n${result.stderr}`);
  const code = await fs.readFile(out, 'utf8');
  if (!code.includes('jsonc-parser/lib/umd/')) {
    t.skip('the SDK bundler no longer resolves jsonc-parser to UMD; the known defect is gone');
    return;
  }

  await assert.rejects(assertPassiveServiceImport(out), /failed a passive import|Cannot find module/);

  // The same bytes in a package payload must be refused by the real packager.
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fs.copyFile(out, path.join(fixture.root, 'service/main.js'));
  // The UMD bundle fails either the earlier node_modules reference check or the
  // import gate, depending on which marker it kept; both refuse the payload.
  await assert.rejects(packageExtension(fixture), /failed a passive import|Cannot find module|references a node_modules path/);
});

test('the passive import gate observes listeners, children, state reads and missing modules', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const probe = async (name, source, pattern) => {
    const file = await writeService(path.join(base, name), source);
    await assert.rejects(assertPassiveServiceImport(file), pattern, `${name} must be refused`);
  };

  await probe('missing', 'import "./missing.js";\nexport const startService = () => null;\n',
    /failed a passive import/);
  await probe('listener', [
    'import http from "node:http";',
    'http.createServer(() => {}).listen(0);',
    'export const startService = () => null;',
    '',
  ].join('\n'), /failed a passive import|did not exit/);
  await probe('child', [
    'import { spawn } from "node:child_process";',
    'spawn("true");',
    'export const startService = () => null;',
    '',
  ].join('\n'), /failed a passive import/);
  await probe('state-read', [
    'import fs from "node:fs";',
    'fs.readFileSync("/etc/passwd");',
    'export const startService = () => null;',
    '',
  ].join('\n'), /failed a passive import/);
  await probe('no-api', 'export const answer = 42;\n', /failed a passive import/);
});

test('the real service still exposes the host entry points when imported', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'service/main.js');
  const result = buildService(out);
  assert.equal(result.status, 0, result.stderr);

  // Relocate exactly the built file plus a type:module manifest, far from the
  // repository, and import it with Node. Exit code 0 is the acceptance check.
  const relocated = path.join(base, 'relocated');
  await fs.mkdir(path.join(relocated, 'service'), { recursive: true });
  await fs.copyFile(out, path.join(relocated, 'service/main.js'));
  await fs.writeFile(path.join(relocated, 'package.json'), '{"type":"module"}\n');
  const probe = [
    `const guest = await import(${JSON.stringify(pathToFileURL(path.join(relocated, 'service/main.js')).href)});`,
    'if (typeof guest.startService !== "function") process.exit(7);',
    'if (typeof guest.createServiceServer !== "function") process.exit(8);',
    'if (typeof guest.VERSION !== "string") process.exit(9);',
  ].join('\n');
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: relocated,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: path.join(relocated, 'home') },
  });
  assert.equal(imported.status, 0, `relocated import failed:\n${imported.stderr}`);
});

test('a service build refuses an entry that needs the UMD resolver', async (t) => {
  const base = await tempRoot();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const fixture = await createScratchRepository({ version: '0.1.0' });
  t.after(fixture.cleanup);
  await fs.writeFile(path.join(fixture.root, 'src/backend/main.js'), [
    'import { parse } from "jsonc-parser";',
    'export const startService = () => null;',
    'export const parsed = () => parse("{}");',
    'export const listenPort = () => Number(process.env.OPENCHAMBER_SERVICE_PORT);',
    '',
  ].join('\n'));

  const out = path.join(base, 'service/main.js');
  const result = spawnSync('bun', [BUILD_SERVICE, '--root', fixture.root, '--out', out], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const code = await fs.readFile(out, 'utf8');
  assert.doesNotMatch(code, /jsonc-parser\/lib\/umd\//);
  await assertPassiveServiceImport(out);
});
