import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  ADAPTER_VERSION,
  canonicalizeMarketplaceValue,
  createMarketplaceSourceStore,
  digestMarketplaceBundle,
  readMarketplaceSnapshot,
} from '../../src/backend/marketplace-source.js';

const CANARY = 'PRIVATE_SOURCE_CANARY_DO_NOT_EXPOSE';

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omos-market-${label}-`));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function bundle({ id = 'acme/alpha', version = '1.2.3', agentName = 'alpha', displayName = 'Alpha', schemaVersion = 3, model = { source: 'session' }, extendsValue } = {}) {
  const manifest = {
    schemaVersion,
    id,
    version,
    displayName,
    description: `Synthetic ${CANARY}`,
    agentName,
    prompt: `SECRET_PROMPT_${CANARY}`,
    skills: ['private-skill'],
    mcps: ['private-mcp'],
    tools: [],
    author: { name: 'Synthetic' },
    tags: ['synthetic'],
    license: 'MIT',
    compatibility: { plugin: '^1.0.0' },
    model,
    routing: schemaVersion === 3
      ? { lane: 'synthetic', stats: ['synthetic'], delegateWhen: ['synthetic'], avoid: ['synthetic'] }
      : { description: 'synthetic', when: 'synthetic', keywords: ['synthetic'] },
  };
  if (extendsValue !== undefined) manifest.extends = extendsValue;
  return { manifest };
}

function entryFor(id, version, domain, digest, sourcePath) {
  return {
    manifestSchemaVersion: domain === 'marketplace-agent-bundle-v3' ? 3 : 2,
    manifestVersion: version,
    source: { kind: 'local', path: sourcePath },
    digest: { algorithm: 'sha256', domain, value: digest },
  };
}

function writePackage(root, item) {
  const { id, version } = item.manifest;
  const [publisher, name] = id.split('/');
  const dir = path.join(root, 'packages', publisher, name, version);
  fs.mkdirSync(dir, { recursive: true });
  const digest = digestMarketplaceBundle(item);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(item));
  fs.writeFileSync(path.join(dir, 'sha256'), `${digest}\n`);
  return { digest, dir, domain: item.manifest.schemaVersion === 3 ? 'marketplace-agent-bundle-v3' : 'marketplace-agent-bundle-v2' };
}

function writeStore(root, items, { lockExtra = {}, lockText = null } = {}) {
  const packages = {};
  for (const item of items) {
    const written = writePackage(root, item);
    packages[item.manifest.id] = {
      ...entryFor(item.manifest.id, item.manifest.version, written.domain, written.digest, root),
      ...(lockExtra[item.manifest.id] ?? {}),
    };
  }
  const lock = { schemaVersion: 2, packages, ...lockExtra.__lock };
  fs.writeFileSync(path.join(root, 'lock.json'), lockText ?? JSON.stringify(lock, null, 2));
  return lock;
}

function snapshot(root) {
  return readMarketplaceSnapshot({ rootPath: root, generation: 'generation-a', now: () => 1_700_000_000_000 });
}

test('canonical marketplace JSON uses UTF-16 key order and a manual byte golden', () => {
  const value = { b: 1, '2': [true, { 'é': 'x' }], '10': 'z', a: null };
  const canonical = '{"10":"z","2":[true,{"é":"x"}],"a":null,"b":1}';
  assert.equal(canonicalizeMarketplaceValue(value), canonical);
  assert.equal(digestMarketplaceBundle(value), createHash('sha256').update(canonical, 'utf8').digest('hex'));
  assert.equal(canonicalizeMarketplaceValue({ a: undefined }), '{}');
  assert.throws(() => canonicalizeMarketplaceValue([, 1]), /holes|undefined/);
  assert.throws(() => canonicalizeMarketplaceValue({ a: Number.NaN }), /non-finite/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalizeMarketplaceValue(cycle), /circular/);
});

test('ready snapshot projects only safe installed package fields and keeps formatting stable', () => {
  const root = tempRoot('ready');
  try {
    const first = bundle({ id: 'acme/alpha', agentName: 'alpha', displayName: 'Alpha', model: { source: 'session' } });
    const second = bundle({ id: 'acme/beta', version: '2.0.0', agentName: 'beta', displayName: 'Beta',
      model: { source: 'explicit', candidates: [{ id: 'synthetic/provider-alpha', variant: 'high' }] } });
    const third = bundle({ id: 'acme/gamma', version: '3.0.0', agentName: 'gamma', displayName: 'Gamma',
      model: { source: 'session' }, extendsValue: { builtin: 'explorer', promptMode: 'append' } });
    writeStore(root, [first, second, third]);
    const before = snapshot(root);
    assert.equal(before.state, 'ready');
    assert.equal(before.adapterVersion, ADAPTER_VERSION);
    assert.equal(before.generation, 'generation-a');
    assert.equal(before.readAt, 1_700_000_000_000);
    assert.equal(before.packages.length, 3);
    assert.deepEqual(Object.keys(before.packages[0]).sort(), ['agentName', 'blockedReason', 'digest', 'displayName', 'id', 'modelSource', 'version']);
    assert.equal(before.packages.find(item => item.id === 'acme/beta').modelSource, 'explicit');
    assert.match(before.packages.find(item => item.id === 'acme/beta').digest, /^[a-f0-9]{64}$/);
    assert.equal(before.packages.find(item => item.id === 'acme/gamma').blockedReason,
      'Extends a builtin agent; selection is blocked in this release.');
    assert.equal(JSON.stringify(before).includes(CANARY), false);
    assert.equal(JSON.stringify(before).includes('SECRET_PROMPT'), false);
    assert.equal(JSON.stringify(before).includes(root), false);
    assert.equal(JSON.stringify(before).includes('private-skill'), false);

    // Formatting-only rewrite preserves the safe fingerprint.
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'lock.json'), 'utf8'));
    fs.writeFileSync(path.join(root, 'lock.json'), JSON.stringify(lock));
    const after = snapshot(root);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.equal(after.packages.length, 3);
  } finally { cleanup(root); }
});

test('empty lock is ready, absent source is not-configured and store settings are private and persistent', () => {
  const dataDir = tempRoot('settings');
  try {
    const store = createMarketplaceSourceStore({ dataDir, now: () => 123 });
    const initialGeneration = store.get().generation;
    assert.equal(store.get().rootPath, '');
    const empty = store.snapshot();
    assert.equal(empty.state, 'not-configured');
    assert.equal(Object.hasOwn(empty, 'packages'), false);

    const root = tempRoot('empty-lock');
    try {
      fs.writeFileSync(path.join(root, 'lock.json'), JSON.stringify({ schemaVersion: 2, packages: {} }));
      const saved = store.update(root);
      assert.equal(saved.rootPath, root);
      assert.notEqual(saved.generation, initialGeneration);
      const ready = store.snapshot();
      assert.equal(ready.state, 'ready');
      assert.deepEqual(ready.packages, []);
      const file = path.join(dataDir, 'marketplace-source.json');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rootPath, root);
      const rotated = store.update('');
      assert.equal(rotated.rootPath, '');
      assert.notEqual(rotated.generation, saved.generation);
      assert.equal(store.snapshot().state, 'not-configured');
    } finally { cleanup(root); }
  } finally { cleanup(dataDir); }
});

test('invalid settings paths are rejected and persistence failures are explicit', () => {
  const dataDir = tempRoot('bad-settings');
  try {
    const store = createMarketplaceSourceStore({ dataDir });
    assert.throws(() => store.update('relative/path'), error => error.code === 'INVALID_MARKETPLACE_SOURCE');
    assert.throws(() => store.update(`${dataDir}/bad\0path`), error => error.code === 'INVALID_MARKETPLACE_SOURCE');
    const blocker = path.join(dataDir, 'marketplace-source.json');
    fs.mkdirSync(blocker, { recursive: true });
    assert.throws(() => store.update(''), error => error.code === 'MARKETPLACE_SOURCE_NOT_SAVED');
  } finally { cleanup(dataDir); }
});

test('lock schema, domain and manifest identity mismatches fail closed without packages', () => {
  const root = tempRoot('schema');
  try {
    const item = bundle({ model: { source: 'session' } });
    writeStore(root, [item]);
    const original = fs.readFileSync(path.join(root, 'lock.json'), 'utf8');
    const mutations = [
      text => ({ ...JSON.parse(text), schemaVersion: 3 }),
      text => { const lock = JSON.parse(text); lock.packages['acme/alpha'].digest.domain = 'marketplace-agent-bundle-v2'; return lock; },
      text => { const lock = JSON.parse(text); lock.packages['acme/alpha'].manifestVersion = '9.9.9'; return lock; },
      text => { const lock = JSON.parse(text); lock.packages['acme/alpha'].digest.value = '0'.repeat(64); return lock; },
    ];
    for (const mutate of mutations) {
      fs.writeFileSync(path.join(root, 'lock.json'), JSON.stringify(mutate(original)));
      const result = snapshot(root);
      assert.notEqual(result.state, 'ready');
      assert.equal(Object.hasOwn(result, 'packages'), false);
    }
    fs.writeFileSync(path.join(root, 'lock.json'), original);
    const bundlePath = path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    parsed.manifest.schemaVersion = 99;
    fs.writeFileSync(bundlePath, JSON.stringify(parsed));
    assert.notEqual(snapshot(root).state, 'ready');
  } finally { cleanup(root); }
});

test('sidecar, digest, duplicate keys and duplicate agent identities fail closed', () => {
  const root = tempRoot('integrity');
  try {
    const item = bundle();
    writeStore(root, [item]);
    const sidecar = path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'sha256');
    fs.writeFileSync(sidecar, `${'0'.repeat(64)}\n`);
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_INTEGRITY');

    writeStore(root, [item]);
    const lockPath = path.join(root, 'lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, JSON.stringify(lock).replace('"packages":{', '"packages":{"acme/alpha":' + JSON.stringify(lock.packages['acme/alpha']) + ','));
    assert.equal(snapshot(root).state, 'unsupported');

    const root2 = tempRoot('duplicate-agent');
    try {
      writeStore(root2, [bundle({ id: 'acme/one', agentName: 'same' }), bundle({ id: 'acme/two', agentName: 'same' })]);
      assert.equal(snapshot(root2).error.code, 'MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED');
    } finally { cleanup(root2); }
  } finally { cleanup(root); }
});

function leaseEntry(root, kind, { pid = process.pid, ageMs = 0, name = null } = {}) {
  const container = path.join(root, 'marketplace.lock');
  fs.mkdirSync(container, { recursive: true });
  const entryName = name ?? `${pid}.123e4567-e89b-42d3-a456-426614174000.${kind}`;
  const file = path.join(container, entryName);
  fs.writeFileSync(file, '');
  if (ageMs > 0) fs.utimesSync(file, new Date(1_700_000_000_000 - ageMs), new Date(1_700_000_000_000 - ageMs));
  return file;
}

test('lease protocol allows absent/empty/stale containers and rejects active or malformed entries', () => {
  const root = tempRoot('lease');
  try {
    const item = bundle();
    writeStore(root, [item]);
    const container = path.join(root, 'marketplace.lock');
    fs.mkdirSync(container);
    assert.equal(snapshot(root).state, 'ready');
    fs.rmdirSync(container);
    assert.equal(snapshot(root).state, 'ready');

    const activeCandidate = leaseEntry(root, 'candidate');
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_LEASED');
    fs.rmSync(activeCandidate);
    const activeLease = leaseEntry(root, 'lease');
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_LEASED');
    fs.rmSync(activeLease);

    const staleCandidate = leaseEntry(root, 'candidate', { ageMs: 61_000 });
    const staleLease = leaseEntry(root, 'lease', { pid: spawnSync(process.execPath, ['-e', '']).pid, ageMs: 61_000 });
    const beforeStale = fs.readFileSync(staleCandidate);
    assert.equal(snapshot(root).state, 'ready');
    assert.deepEqual(fs.readFileSync(staleCandidate), beforeStale);
    assert.equal(fs.existsSync(staleLease), true);
    fs.rmSync(staleCandidate);
    fs.rmSync(staleLease);

    for (const [name, setup] of [
      ['bad-name', () => leaseEntry(root, 'lease', { name: 'not-a-lease' })],
      ['bad-pid', () => leaseEntry(root, 'lease', { pid: 0 })],
      ['nonzero', () => { const file = leaseEntry(root, 'lease'); fs.writeFileSync(file, 'x'); return file; }],
      ['directory', () => { const file = leaseEntry(root, 'lease'); fs.rmSync(file); fs.mkdirSync(file); return file; }],
    ]) {
      const file = setup();
      const result = snapshot(root);
      assert.equal(result.state, 'unsupported', name);
      fs.rmSync(file, { recursive: true, force: true });
    }
    const symlinkEntry = path.join(container, '1.123e4567-e89b-42d3-a456-426614174000.lease');
    fs.symlinkSync(path.join(root, 'lock.json'), symlinkEntry);
    assert.equal(snapshot(root).state, 'unsupported');
    fs.rmSync(symlinkEntry);
    for (let index = 0; index < 129; index += 1) leaseEntry(root, 'lease', { pid: index + 1, ageMs: 61_000 });
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_LEASE_COUNT');
  } finally { cleanup(root); }
});

test('duplicate JSON keys, symlink components and FIFOs are refused', () => {
  const root = tempRoot('unsafe');
  try {
    const item = bundle();
    writeStore(root, [item]);
    const lockPath = path.join(root, 'lock.json');
    const lock = fs.readFileSync(lockPath, 'utf8');
    fs.writeFileSync(lockPath, lock.replace('"schemaVersion": 2,', '"schemaVersion": 2,"schemaVersion": 2,'));
    assert.equal(snapshot(root).state, 'unsupported');

    writeStore(root, [item]);
    const realPackages = path.join(root, 'packages');
    const moved = path.join(root, 'packages-real');
    fs.renameSync(realPackages, moved);
    fs.symlinkSync(moved, realPackages);
    assert.equal(snapshot(root).state, 'unsupported');

    const fifoRoot = tempRoot('fifo');
    try {
      writeStore(fifoRoot, [bundle()]);
      const sidecar = path.join(fifoRoot, 'packages', 'acme', 'alpha', '1.2.3', 'sha256');
      fs.rmSync(sidecar);
      const made = spawnSync('mkfifo', [sidecar], { encoding: 'utf8' });
      if (made.status === 0) {
        assert.equal(snapshot(fifoRoot).state, 'unsupported');
      }
    } finally { cleanup(fifoRoot); }
  } finally { cleanup(root); }
});

test('bounds, depth and unknown package counts are refused without truncation', () => {
  const root = tempRoot('bounds');
  try {
    const item = bundle();
    writeStore(root, [item]);
    const lockPath = path.join(root, 'lock.json');
    const lock = fs.readFileSync(lockPath, 'utf8');
    fs.writeFileSync(lockPath, lock.padEnd(2 * 1024 * 1024 + 1, ' '));
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_TOO_LARGE');

    const deepRoot = tempRoot('depth');
    try {
      writeStore(deepRoot, [item]);
      let nested = {};
      let cursor = nested;
      for (let index = 0; index < 70; index += 1) { cursor.next = {}; cursor = cursor.next; }
      const bundlePath = path.join(deepRoot, 'packages', 'acme', 'alpha', '1.2.3', 'package.json');
      const parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      parsed.manifest.deep = nested;
      fs.writeFileSync(bundlePath, JSON.stringify(parsed));
      assert.notEqual(snapshot(deepRoot).state, 'ready');
    } finally { cleanup(deepRoot); }
  } finally { cleanup(root); }
});

test('fingerprint changes with verified identity/digest but not file formatting or root spelling', () => {
  const root = tempRoot('fingerprint');
  try {
    writeStore(root, [bundle()]);
    const first = snapshot(root);
    assert.equal(first.state, 'ready');
    const lockPath = path.join(root, 'lock.json');
    fs.writeFileSync(lockPath, JSON.stringify(JSON.parse(fs.readFileSync(lockPath, 'utf8'))));
    const second = snapshot(root);
    assert.equal(second.fingerprint, first.fingerprint);

    const bundlePath = path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    parsed.manifest.displayName = 'Alpha Renamed';
    const nextDigest = digestMarketplaceBundle(parsed);
    fs.writeFileSync(bundlePath, JSON.stringify(parsed));
    fs.writeFileSync(path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'sha256'), nextDigest);
    const lockPath2 = path.join(root, 'lock.json');
    const nextLock = JSON.parse(fs.readFileSync(lockPath2, 'utf8'));
    nextLock.packages['acme/alpha'].digest.value = nextDigest;
    fs.writeFileSync(lockPath2, JSON.stringify(nextLock));
    const third = snapshot(root);
    assert.notEqual(third.fingerprint, first.fingerprint);
    assert.equal(third.state, 'ready');
  } finally { cleanup(root); }
});

test('source and settings files are never written or chmodded by snapshots', () => {
  const root = tempRoot('no-write');
  try {
    writeStore(root, [bundle()]);
    const lockPath = path.join(root, 'lock.json');
    const beforeLock = fs.statSync(lockPath);
    const beforeText = fs.readFileSync(lockPath);
    const result = snapshot(root);
    assert.equal(result.state, 'ready');
    const afterLock = fs.statSync(lockPath);
    assert.deepEqual(fs.readFileSync(lockPath), beforeText);
    assert.equal(afterLock.mode, beforeLock.mode);
    assert.equal(afterLock.mtimeMs, beforeLock.mtimeMs);
    assert.equal(fs.existsSync(path.join(root, 'marketplace.lock')), false);
  } finally { cleanup(root); }
});


test('malformed JSON and a missing configured root are fixed sanitized unready states', () => {
  const root = tempRoot('malformed');
  try {
    fs.writeFileSync(path.join(root, 'lock.json'), '{ not json');
    const malformed = snapshot(root);
    assert.equal(malformed.state, 'unavailable');
    assert.equal(malformed.error.code, 'MARKETPLACE_SOURCE_MALFORMED');
    assert.equal(Object.hasOwn(malformed, 'packages'), false);
    const missing = snapshot(path.join(root, 'missing-root'));
    assert.equal(missing.state, 'unavailable');
    assert.equal(missing.error.code, 'MARKETPLACE_SOURCE_MISSING');
    assert.equal(JSON.stringify(malformed).includes('not json'), false);
  } finally { cleanup(root); }
});

test('unknown lock sources, bundle duplicate keys and package/sidecar bounds fail closed', () => {
  const root = tempRoot('sources');
  try {
    writeStore(root, [bundle()]);
    const lockPath = path.join(root, 'lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['acme/alpha'].source = { kind: 'remote', url: 'https://example.invalid' };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    assert.equal(snapshot(root).state, 'unsupported');

    writeStore(root, [bundle()]);
    const bundlePath = path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'package.json');
    const original = fs.readFileSync(bundlePath, 'utf8');
    fs.writeFileSync(bundlePath, original.replace('{"manifest":', '{"manifest":{},"manifest":'));
    assert.equal(snapshot(root).state, 'unsupported');

    writeStore(root, [bundle()]);
    fs.writeFileSync(path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'sha256'), 'a'.repeat(129));
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_TOO_LARGE');

    writeStore(root, [bundle()]);
    fs.writeFileSync(bundlePath, 'x'.repeat(512 * 1024 + 1));
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_TOO_LARGE');
  } finally { cleanup(root); }
});

test('more than 64 installed packages are refused instead of truncated', () => {
  const root = tempRoot('count');
  try {
    const items = [];
    for (let index = 0; index < 65; index += 1) {
      items.push(bundle({ id: `acme/pkg-${index}`, agentName: `agent-${index}` }));
    }
    writeStore(root, items);
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_TOO_MANY');
  } finally { cleanup(root); }
});

test('bundle and sidecar modes/mtimes are unchanged after a snapshot', () => {
  const root = tempRoot('file-mode');
  try {
    writeStore(root, [bundle()]);
    const files = [
      path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'package.json'),
      path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'sha256'),
    ];
    const before = files.map(file => ({ file, stats: fs.statSync(file), bytes: fs.readFileSync(file) }));
    assert.equal(snapshot(root).state, 'ready');
    for (const item of before) {
      const after = fs.statSync(item.file);
      assert.equal(after.mode, item.stats.mode);
      assert.equal(after.mtimeMs, item.stats.mtimeMs);
      assert.deepEqual(fs.readFileSync(item.file), item.bytes);
    }
  } finally { cleanup(root); }
});

test('reserved agent names are rejected unconditionally; extends still yields a blocked safe projection', () => {
  const root = tempRoot('reserved');
  try {
    for (const name of ['build', 'orchestrator', 'council', 'councillor', 'explore', 'frontend-ui-ux-engineer']) {
      writeStore(root, [bundle({ agentName: name })]);
      assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED', name);
    }
    writeStore(root, [bundle({ agentName: 'explorer', extendsValue: { builtin: 'explorer', promptMode: 'append' } })]);
    assert.equal(snapshot(root).error.code, 'MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED');
    writeStore(root, [bundle({ agentName: 'custom-agent', extendsValue: { builtin: 'explorer', promptMode: 'append' } })]);
    const ready = snapshot(root);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.packages[0].blockedReason, 'Extends a builtin agent; selection is blocked in this release.');
  } finally { cleanup(root); }
});

test('ready package order is stable when lock keys are reversed', () => {
  const root = tempRoot('order');
  try {
    writeStore(root, [bundle({ id: 'acme/zeta', agentName: 'zeta' }), bundle({ id: 'acme/alpha', agentName: 'alpha' })]);
    const lockPath = path.join(root, 'lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages = Object.fromEntries(Object.entries(lock.packages).reverse());
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const result = snapshot(root);
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.packages.map(item => item.id), ['acme/alpha', 'acme/zeta']);
  } finally { cleanup(root); }
});

test('root or intermediate retargeting during the last sidecar read is rejected', () => {
  const root = tempRoot('retarget');
  const moved = `${root}-moved`;
  try {
    writeStore(root, [bundle()]);
    const originalRead = fs.readSync;
    let triggered = false;
    fs.readSync = (fd, ...args) => {
      if (!triggered) {
        let target = '';
        try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* non-linux or closed */ }
        if (target.includes(`${path.sep}sha256`)) {
          triggered = true;
          fs.renameSync(root, moved);
          fs.symlinkSync(moved, root);
        }
      }
      return originalRead(fd, ...args);
    };
    try {
      const result = snapshot(root);
      assert.equal(triggered, true);
      assert.equal(result.state, 'unavailable');
      assert.equal(result.error.code, 'MARKETPLACE_SOURCE_CHANGED');
    } finally {
      fs.readSync = originalRead;
    }
  } finally {
    try { if (fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root); } catch { /* absent */ }
    try { if (fs.existsSync(moved)) fs.renameSync(moved, root); } catch { /* cleanup best effort */ }
    cleanup(root);
  }
});

test('aggregate cap is applied before an oversized later bundle is read or allocated', () => {
  const root = tempRoot('aggregate');
  try {
    const items = [];
    for (let index = 0; index < 17; index += 1) {
      const item = bundle({ id: `acme/pkg-${String(index).padStart(2, '0')}`, agentName: `agent-${index}` });
      item.manifest.padding = 'x'.repeat(520_000);
      items.push(item);
    }
    writeStore(root, items);
    const originalRead = fs.readSync;
    let readOversizedPayload = false;
    fs.readSync = (fd, ...args) => {
      try {
        const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (target.includes('pkg-16') && target.endsWith('package.json')) readOversizedPayload = true;
      } catch { /* non-linux or closed */ }
      return originalRead(fd, ...args);
    };
    try {
      const result = snapshot(root);
      assert.equal(result.error.code, 'MARKETPLACE_SOURCE_TOO_LARGE');
      assert.equal(readOversizedPayload, false);
    } finally {
      fs.readSync = originalRead;
    }
  } finally { cleanup(root); }
});

test('intermediate packages directory retargeted to a symlink during the last sidecar read is rejected', () => {
  const root = tempRoot('retarget-packages');
  const packages = path.join(root, 'packages');
  const moved = path.join(root, 'packages-moved');
  try {
    writeStore(root, [bundle()]);
    const originalRead = fs.readSync;
    let triggered = false;
    fs.readSync = (fd, ...args) => {
      if (!triggered) {
        let target = '';
        try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* non-linux or closed */ }
        if (target.includes(`${path.sep}sha256`)) {
          triggered = true;
          fs.renameSync(packages, moved);
          fs.symlinkSync(moved, packages);
        }
      }
      return originalRead(fd, ...args);
    };
    try {
      const result = snapshot(root);
      assert.equal(triggered, true);
      assert.equal(result.state, 'unavailable');
      assert.equal(result.error.code, 'MARKETPLACE_SOURCE_CHANGED');
    } finally { fs.readSync = originalRead; }
  } finally {
    try { if (fs.lstatSync(packages).isSymbolicLink()) fs.rmSync(packages); } catch { /* absent */ }
    try { if (fs.existsSync(moved)) fs.renameSync(moved, packages); } catch { /* cleanup best effort */ }
    cleanup(root);
  }
});

test('a stale lease entry removed during the read is detected as a changed container', () => {
  const root = tempRoot('lease-change');
  try {
    writeStore(root, [bundle()]);
    const stale = leaseEntry(root, 'lease', { pid: spawnSync(process.execPath, ['-e', '']).pid, ageMs: 61_000 });
    const originalRead = fs.readSync;
    let triggered = false;
    fs.readSync = (fd, ...args) => {
      if (!triggered) {
        let target = '';
        try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* non-linux or closed */ }
        if (target.includes(`${path.sep}sha256`)) {
          triggered = true;
          fs.rmSync(stale);
        }
      }
      return originalRead(fd, ...args);
    };
    try {
      const result = snapshot(root);
      assert.equal(triggered, true);
      assert.equal(result.state, 'unavailable');
      assert.equal(result.error.code, 'MARKETPLACE_SOURCE_CHANGED');
    } finally { fs.readSync = originalRead; }
  } finally { cleanup(root); }
});

test('mutating the first package or lock during the second package read fails as changed', () => {
  const root = tempRoot('two-package-change');
  try {
    writeStore(root, [bundle({ id: 'acme/alpha', agentName: 'alpha' }), bundle({ id: 'acme/beta', agentName: 'beta' })]);
    const firstBundle = path.join(root, 'packages', 'acme', 'alpha', '1.2.3', 'package.json');
    const originalRead = fs.readSync;
    let triggered = false;
    fs.readSync = (fd, ...args) => {
      if (!triggered) {
        let target = '';
        try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* non-linux or closed */ }
        if (target.includes('acme/beta') && target.endsWith('sha256')) {
          triggered = true;
          const parsed = JSON.parse(fs.readFileSync(firstBundle, 'utf8'));
          parsed.manifest.displayName = 'Changed after first read';
          fs.writeFileSync(firstBundle, JSON.stringify(parsed));
        }
      }
      return originalRead(fd, ...args);
    };
    try {
      const result = snapshot(root);
      assert.equal(triggered, true);
      assert.equal(result.state, 'unavailable');
      assert.equal(result.error.code, 'MARKETPLACE_SOURCE_CHANGED');
    } finally { fs.readSync = originalRead; }
  } finally { cleanup(root); }
});
