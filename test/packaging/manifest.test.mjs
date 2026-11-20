import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parse as parseJsonc } from 'jsonc-parser';

import {
  API_VERSION, CONTRIBUTION_KEYS, ENGINE, EXTENSION_ID, PACKAGE_NAME, PAGE_ENTRY,
  PAGE_TITLE, SDK_VERSION, SERVICE_ENTRY, manifestProblems, readManifest,
} from '../../scripts/lib/manifest.mjs';
import { PAYLOAD_FILES } from '../../scripts/lib/payload.mjs';
import { REPO_ROOT, createFixture } from './helpers/fixture.mjs';

const readJson = async (relative) => JSON.parse(await fs.readFile(path.join(REPO_ROOT, relative), 'utf8'));

test('package.json keeps the supported private identity and manifest', async () => {
  const document = await readJson('package.json');
  assert.equal(document.name, PACKAGE_NAME);
  assert.equal(document.version, '0.3.1');
  assert.equal(document.private, true, 'the package must never be publishable');
  assert.equal(document.type, 'module');

  const { manifest } = await readManifest(REPO_ROOT);
  assert.equal(manifest.apiVersion, API_VERSION);
  assert.deepEqual(manifest.engines, { openchamber: ENGINE });
  assert.equal(manifest.engines.openchamber, '>=2.7.1');

  assert.deepEqual(Object.keys(manifest.contributes).sort(), [...CONTRIBUTION_KEYS].sort());
  const { panel, page, service } = manifest.contributes;
  assert.deepEqual(panel, { id: EXTENSION_ID, name: PAGE_TITLE, icon: 'stack' });
  assert.equal('entry' in panel, false, 'panel is identity only; the page names its own entry');
  assert.deepEqual(page, { entry: PAGE_ENTRY, title: PAGE_TITLE, mobile: true });
  assert.deepEqual(service, {
    entry: SERVICE_ENTRY,
    runtime: 'host',
    permissions: { exec: ['opencode'] },
  });
  assert.equal(CONTRIBUTION_KEYS.length, 3, 'no other contribution is allowed');
});

test('the manifest identity check refuses drift in every direction', async () => {
  const document = await readJson('package.json');
  assert.deepEqual(manifestProblems(document), []);

  const mutations = [
    ['private', (copy) => { copy.private = false; }],
    ['type', (copy) => { copy.type = 'commonjs'; }],
    ['name', (copy) => { copy.name = 'openchamber-omos-queues'; }],
    ['apiVersion', (copy) => { copy.openchamber.apiVersion = 2; }],
    ['engine', (copy) => { copy.openchamber.engines.openchamber = '>=2.8.0'; }],
    ['panel entry', (copy) => { copy.openchamber.contributes.panel.entry = 'page/index.html'; }],
    ['panel icon', (copy) => { copy.openchamber.contributes.panel.icon = 'list-check'; }],
    ['extra contribution', (copy) => { copy.openchamber.contributes.capabilities = ['prompt']; }],
    ['page title', (copy) => { copy.openchamber.contributes.page.title = 'Queues'; }],
    ['page mobile', (copy) => { copy.openchamber.contributes.page.mobile = false; }],
    ['service runtime', (copy) => { copy.openchamber.contributes.service.runtime = 'cloud'; }],
    ['extra exec permission', (copy) => { copy.openchamber.contributes.service.permissions.exec.push('git'); }],
    ['extra dependency', (copy) => { copy.dependencies.zod = '4.6.7'; }],
    ['devDependency', (copy) => { copy.devDependencies = { typescript: '5.0.0' }; }],
    ['test script', (copy) => { copy.scripts.test = 'node --test "test/page/*.test.mjs"'; }],
    ['check script', (copy) => { copy.scripts.check = 'bun run test'; }],
  ];
  for (const [label, mutate] of mutations) {
    const copy = structuredClone(document);
    mutate(copy);
    assert.notDeepEqual(manifestProblems(copy), [], `${label} must be refused`);
  }
});

test('the package.json version is canonical: a bump is not identity drift', async () => {
  const document = await readJson('package.json');
  for (const version of ['0.1.1', '1.0.0', '2.3.4-test.1']) {
    assert.deepEqual(manifestProblems({ ...structuredClone(document), version }), [],
      `${version} must package with the same identity`);
  }
  // The SDK manifest schema, not a duplicated constant, still enforces semver.
  const fixture = await createFixture({ version: 'one' });
  try {
    await assert.rejects(readManifest(fixture.root), /invalid-version/);
  } finally {
    await fixture.cleanup();
  }
  const next = await createFixture({ version: '0.1.1' });
  try {
    const { version } = await readManifest(next.root);
    assert.equal(version, '0.1.1');
  } finally {
    await next.cleanup();
  }
});

test('scripts are the command source of truth for build, tests, SDK and packaging', async () => {
  const { scripts } = await readJson('package.json');
  assert.equal(scripts.build, 'bun run build:page && bun run build:service');
  assert.equal(scripts['build:zip'], 'bun install --frozen-lockfile && bun run build && bun run package');
  assert.match(scripts['build:page'], /node_modules\/@openchamber\/sdk\/scripts\/bundle-guest\.ts src\/page\/main\.js page\/main\.js$/);
  assert.equal(scripts['build:service'], 'mkdir -p service && bun scripts/build-service.mjs');
  assert.equal(scripts.test,
    'node --test "test/backend/*.test.mjs" "test/page/*.test.mjs" "test/packaging/*.test.mjs"');
  assert.equal(scripts['check:sdk'], 'bun --no-install node_modules/@openchamber/sdk/scripts/check-guest.ts .');
  assert.equal(scripts.package, 'node scripts/package-extension.mjs');
  assert.equal(scripts.check, 'bun run build && bun run check:syntax && bun run test && bun run check:sdk && bun run package');
  assert.equal(scripts['check:syntax'], 'node scripts/check-syntax.mjs');
});

test('dependencies and the lockfile are pinned to the approved versions', async () => {
  const document = await readJson('package.json');
  assert.deepEqual(document.dependencies, { '@openchamber/sdk': SDK_VERSION, 'jsonc-parser': '3.3.1' });
  assert.equal(document.devDependencies, undefined);

  const lockText = await fs.readFile(path.join(REPO_ROOT, 'bun.lock'), 'utf8');
  const errors = [];
  const lock = parseJsonc(lockText, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], 'bun.lock must parse as JSONC');
  const workspace = lock.workspaces[''];
  assert.deepEqual(workspace.dependencies, { '@openchamber/sdk': '2.7.1', 'jsonc-parser': '3.3.1' });
  assert.match(lock.packages['@openchamber/sdk'][0], /^@openchamber\/sdk@2\.7\.1$/);
  assert.match(lock.packages['jsonc-parser'][0], /^jsonc-parser@3\.3\.1$/);
  assert.match(lock.packages['@openchamber/sdk'][3], /^sha512-/);
  assert.match(lock.packages['jsonc-parser'][3], /^sha512-/);
});

test('the payload whitelist is exact and contains no source or dependencies', () => {
  assert.deepEqual(PAYLOAD_FILES, [
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'page/index.html',
    'page/main.js',
    'page/styles.css',
    'service/main.js',
  ]);
  for (const memberPath of PAYLOAD_FILES) {
    assert.equal(memberPath.startsWith('src/'), false, `${memberPath} is source, not payload`);
    assert.equal(memberPath.includes('node_modules'), false);
    assert.equal(memberPath.endsWith('.ts'), false);
  }
});

test('third-party notices cover every bundled dependency', async () => {
  const notices = await fs.readFile(path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const name of ['@openchamber/sdk 2.7.1', 'jsonc-parser 3.3.1', 'Permission is hereby granted']) {
    assert.ok(notices.includes(name), `THIRD_PARTY_NOTICES.md must mention ${name}`);
  }
});
