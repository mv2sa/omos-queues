import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFavoritesSnapshot } from '../../src/backend/favorites-source.js';
import {
  call,
  configSnapshot,
  makeEnv,
  makeRoot,
  settingsFor,
  standardConfig,
  startService,
  writeFile,
} from './helpers.mjs';

const A = { providerID: 'anthropic', modelID: 'claude-sonnet-4' };
const B = { providerID: 'openai', modelID: 'gpt-5' };
const C = { providerID: 'google', modelID: 'gemini-2.5-pro' };
const CANARY = 'SECRET_CANARY_DO_NOT_RETURN';

function preferences(value, {
  version = 1,
  updatedAt = 1_700_000_000_123,
  omitUpdatedAt = false,
  extraFields = { otherPreferences: { value: CANARY } },
} = {}) {
  const favoriteModels = { value };
  if (!omitUpdatedAt) favoriteModels.updatedAt = updatedAt;
  return JSON.stringify({ version, fields: { favoriteModels, ...extraFields } });
}

function writeProfile(root, text, name = 'preferences.json', mode) {
  return writeFile(path.join(root, 'profile', name), text, mode);
}

async function withService(name, fn, { config = true } = {}) {
  const root = makeRoot(name);
  const env = makeEnv(root);
  if (config) standardConfig(root);
  const context = await startService(env, { logger: () => {} });
  try {
    await fn({ root, env, ...context });
  } finally {
    await context.close();
  }
}

async function configure(context, filePath) {
  const response = await call(context.baseUrl, 'POST', '/favorites/source', { body: { filePath } });
  assert.equal(response.status, 200, response.text);
  return response.body;
}

async function snapshot(context) {
  const response = await call(context.baseUrl, 'GET', '/favorites/snapshot');
  assert.equal(response.status, 200, response.text);
  return response.body;
}

const READY_KEYS = ['favoriteModels', 'fingerprint', 'generation', 'readAt', 'sourceKind', 'state', 'updatedAt'];
const UNREADY_KEYS = ['error', 'generation', 'state'];

test('favorites routes require the bearer and strict JSON bodies', async () => {
  await withService('favorite-auth', async context => {
    const unauthorized = [
      await call(context.baseUrl, 'GET', '/favorites/source', { token: '' }),
      await call(context.baseUrl, 'POST', '/favorites/source', { token: '', body: { filePath: '' } }),
      await call(context.baseUrl, 'GET', '/favorites/snapshot', { token: '' }),
    ];
    for (const response of unauthorized) {
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'UNAUTHORIZED');
    }

    const content = await call(context.baseUrl, 'POST', '/favorites/source', {
      body: '{}', headers: { 'content-type': 'text/plain' },
    });
    assert.equal(content.status, 415);

    const extra = await call(context.baseUrl, 'POST', '/favorites/source', {
      body: { filePath: path.join(context.root, 'profile.json'), extra: true },
    });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error.code, 'UNKNOWN_FIELD');

    for (const body of [
      { filePath: 'relative/preferences.json' },
      {},
      { filePath: 5 },
      { filePath: `${context.root}/bad\u0000path` },
    ]) {
      const response = await call(context.baseUrl, 'POST', '/favorites/source', { body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, 'INVALID_FAVORITES_SOURCE');
    }

    assert.equal((await call(context.baseUrl, 'PUT', '/favorites/source')).status, 405);
    assert.equal((await call(context.baseUrl, 'POST', '/favorites/snapshot', { body: {} })).status, 405);

    const origin = await call(context.baseUrl, 'GET', '/favorites/source', {
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(origin.status, 403);
    assert.equal(origin.body.error.code, 'ORIGIN_REJECTED');
    const stored = await call(context.baseUrl, 'GET', '/favorites/source');
    assert.equal(stored.headers.get('cache-control'), 'no-store');
  });
});

test('default source is empty and not-configured, with health independent', async () => {
  await withService('favorite-default', async context => {
    const source = await call(context.baseUrl, 'GET', '/favorites/source');
    assert.equal(source.status, 200);
    assert.deepEqual(Object.keys(source.body).sort(), ['filePath', 'generation']);
    assert.equal(source.body.filePath, '');
    assert.equal(typeof source.body.generation, 'string');

    const snap = await snapshot(context);
    assert.deepEqual(Object.keys(snap).sort(), UNREADY_KEYS);
    assert.equal(snap.state, 'not-configured');
    assert.equal(snap.generation, source.body.generation);
    assert.equal(snap.error.code, 'FAVORITES_SOURCE_NOT_CONFIGURED');
    assert.equal(Object.hasOwn(snap, 'favoriteModels'), false);

    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
  });
});

test('favorites source works without a loadable OMOS config', async () => {
  await withService('favorite-no-config', async context => {
    const profile = writeProfile(context.root, preferences([A]));
    const source = await call(context.baseUrl, 'GET', '/favorites/source');
    assert.equal(source.status, 200);
    const saved = await configure(context, profile);
    assert.equal(saved.filePath, profile);
    const snap = await snapshot(context);
    assert.equal(snap.state, 'ready');
    assert.deepEqual(snap.favoriteModels, [A]);
    const config = await call(context.baseUrl, 'GET', '/config');
    assert.equal(config.status, 404);
    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
  }, { config: false });
});

test('persists source settings privately and survives restart without touching OMOS state', async () => {
  const root = makeRoot('favorite-persist');
  const env = makeEnv(root);
  standardConfig(root);
  const configFile = settingsFor(env).configFile;
  const profile = writeProfile(root, preferences([A, B]));
  let context = await startService(env, { logger: () => {} });
  try {
    const beforeConfig = await configSnapshot(context.baseUrl);
    const beforeSettings = await call(context.baseUrl, 'GET', '/settings');
    const beforeBytes = fs.readFileSync(configFile);

    const saved = await configure(context, profile);
    assert.deepEqual(Object.keys(saved).sort(), ['filePath', 'generation']);
    assert.equal(saved.filePath, profile);
    assert.match(saved.generation, /^[0-9a-f-]{36}$/);
    assert.notEqual(saved.generation, beforeSettings.body.generation);

    const sourceFile = path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'favorites-source.json');
    const stat = fs.statSync(sourceFile);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.statSync(env.OPENCHAMBER_SERVICE_DATA_DIR).mode & 0o777, 0o700);
    const record = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    assert.deepEqual(record, { version: 1, filePath: profile, generation: saved.generation });

    const snap = await snapshot(context);
    assert.equal(snap.state, 'ready');
    assert.equal(snap.generation, saved.generation);
    assert.deepEqual(snap.favoriteModels, [A, B]);

    const afterConfig = await configSnapshot(context.baseUrl);
    const afterSettings = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(afterConfig.baseHash, beforeConfig.baseHash);
    assert.equal(afterConfig.target.generation, beforeConfig.target.generation);
    assert.equal(afterSettings.body.generation, beforeSettings.body.generation);
    assert.deepEqual(fs.readFileSync(configFile), beforeBytes);
  } finally {
    await context.close();
  }

  context = await startService(env, { logger: () => {} });
  try {
    const persistedBefore = JSON.parse(
      fs.readFileSync(path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'favorites-source.json'), 'utf8'),
    );
    const source = await call(context.baseUrl, 'GET', '/favorites/source');
    assert.deepEqual(source.body, { filePath: profile, generation: persistedBefore.generation });
    const snap = await snapshot(context);
    assert.equal(snap.state, 'ready');
    assert.equal(snap.generation, persistedBefore.generation);
    assert.deepEqual(snap.favoriteModels, [A, B]);

    const settingsBeforeClear = await call(context.baseUrl, 'GET', '/settings');
    const cleared = await configure(context, '');
    assert.equal(cleared.filePath, '');
    assert.notEqual(cleared.generation, persistedBefore.generation);
    const afterClear = await snapshot(context);
    assert.equal(afterClear.state, 'not-configured');
    assert.equal(afterClear.generation, cleared.generation);
    assert.equal(Object.hasOwn(afterClear, 'favoriteModels'), false);
    const settingsAfterClear = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(settingsAfterClear.body.generation, settingsBeforeClear.body.generation);
  } finally {
    await context.close();
  }
});

test('fresh reads observe additions, removals, reorder and empty without leaking other preferences', async () => {
  await withService('favorite-fresh', async context => {
    const profile = writeProfile(context.root, preferences([A, B, A, C]));
    await configure(context, profile);
    const bytesBefore = fs.readFileSync(profile);
    const modeBefore = fs.statSync(profile).mode & 0o777;

    const first = await snapshot(context);
    assert.deepEqual(Object.keys(first).sort(), READY_KEYS);
    assert.equal(first.state, 'ready');
    assert.deepEqual(first.favoriteModels, [A, B, C]);
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(typeof first.readAt, 'number');
    assert.equal(first.updatedAt, 1_700_000_000_123);
    assert.equal(first.sourceKind, 'openchamber-preferences-v1');
    assert.equal(JSON.stringify(first).includes(CANARY), false);
    assert.equal(JSON.stringify(first).includes('otherPreferences'), false);
    assert.deepEqual(fs.readFileSync(profile), bytesBefore);
    assert.equal(fs.statSync(profile).mode & 0o777, modeBefore);

    // Formatting and unrelated preference changes must not alter the projected fingerprint.
    const noisy = JSON.stringify({
      version: 1,
      fields: {
        favoriteModels: { value: [A, B, A, C], updatedAt: 1_700_000_000_123 },
        otherPreferences: { value: `${CANARY}-changed` },
        padding: ' '.repeat(128),
      },
    }, null, 2);
    fs.writeFileSync(profile, noisy);
    const projected = await snapshot(context);
    assert.equal(projected.state, 'ready');
    assert.deepEqual(projected.favoriteModels, [A, B, C]);
    assert.equal(projected.fingerprint, first.fingerprint);
    assert.equal(JSON.stringify(projected).includes(CANARY), false);

    fs.writeFileSync(profile, preferences([A, B, A, C], { updatedAt: 1_700_000_000_124 }));
    const stamped = await snapshot(context);
    assert.deepEqual(stamped.favoriteModels, [A, B, C]);
    assert.notEqual(stamped.fingerprint, first.fingerprint);
    assert.equal(stamped.updatedAt, 1_700_000_000_124);

    fs.writeFileSync(profile, preferences([C, A]));
    const reordered = await snapshot(context);
    assert.deepEqual(reordered.favoriteModels, [C, A]);
    assert.notEqual(reordered.fingerprint, first.fingerprint);
    assert.equal(reordered.generation, first.generation);

    fs.writeFileSync(profile, preferences([]));
    const empty = await snapshot(context);
    assert.equal(empty.state, 'ready');
    assert.deepEqual(empty.favoriteModels, []);
    assert.match(empty.fingerprint, /^[0-9a-f]{64}$/);

    fs.unlinkSync(profile);
    const missing = await snapshot(context);
    assert.deepEqual(Object.keys(missing).sort(), UNREADY_KEYS);
    assert.equal(missing.state, 'unavailable');
    assert.equal(missing.error.code, 'FAVORITES_SOURCE_MISSING');
    assert.equal(Object.hasOwn(missing, 'favoriteModels'), false);

    fs.writeFileSync(profile, preferences([B]));
    const restored = await snapshot(context);
    assert.deepEqual(restored.favoriteModels, [B]);
    assert.equal(restored.generation, first.generation);
  });
});

test('malformed, oversized, unsupported and unreadable sources are declared unready', async () => {
  await withService('favorite-unready', async context => {
    const profile = writeProfile(context.root, preferences([A]));
    await configure(context, profile);

    const cases = [
      ['{not json ' + CANARY, 'unavailable', 'FAVORITES_SOURCE_MALFORMED'],
      ['[]', 'unavailable', 'FAVORITES_SOURCE_MALFORMED'],
      ['', 'unavailable', 'FAVORITES_SOURCE_MALFORMED'],
      [JSON.stringify({ version: 2, fields: { favoriteModels: { value: [A], updatedAt: 1 } } }),
        'unsupported', 'FAVORITES_SOURCE_VERSION_UNSUPPORTED'],
      [JSON.stringify({ version: 1, fields: {} }), 'unsupported', 'FAVORITES_SOURCE_SCHEMA_UNSUPPORTED'],
      [JSON.stringify({ version: 1, fields: { favoriteModels: { updatedAt: 1 } } }),
        'unsupported', 'FAVORITES_SOURCE_SCHEMA_UNSUPPORTED'],
      [JSON.stringify({ version: 1, fields: { favoriteModels: { value: 'x', updatedAt: 1 } } }),
        'unsupported', 'FAVORITES_SOURCE_SCHEMA_UNSUPPORTED'],
      ['x'.repeat(2 * 1024 * 1024 + 1), 'unavailable', 'FAVORITES_SOURCE_TOO_LARGE'],
    ];
    for (const [text, state, code] of cases) {
      fs.writeFileSync(profile, text);
      const response = await call(context.baseUrl, 'GET', '/favorites/snapshot');
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.body).sort(), UNREADY_KEYS);
      assert.equal(response.body.state, state, code);
      assert.equal(response.body.error.code, code);
      assert.equal(Object.hasOwn(response.body, 'favoriteModels'), false);
      assert.equal(response.text.includes(CANARY), false);
    }

    fs.writeFileSync(profile, preferences([A]));
    fs.chmodSync(profile, 0o000);
    if (process.getuid?.() !== 0) {
      const unreadable = await snapshot(context);
      assert.equal(unreadable.state, 'unavailable');
      assert.equal(unreadable.error.code, 'FAVORITES_SOURCE_UNREADABLE');
      assert.equal(Object.hasOwn(unreadable, 'favoriteModels'), false);
    }
    fs.chmodSync(profile, 0o600);

    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
  });
});

test('normalizes profile stamps without rejecting a valid favorites list', async () => {
  await withService('favorite-stamps', async context => {
    const profile = writeProfile(context.root, preferences([A, B]));
    await configure(context, profile);

    const rawInfinity = '{"version":1,"fields":{"favoriteModels":{"value":[],"updatedAt":1e999}}}';
    const cases = [
      ['absent', null, null],
      ['null', null, null],
      ['iso', '2026-01-02T03:04:05.000Z', null],
      ['object', { at: 1 }, null],
      ['negative', -1, null],
      ['zero', 0, 0],
      ['positive', 1_700_000_000_999, 1_700_000_000_999],
    ];
    const fingerprints = [];
    for (const [name, updatedAt, expected] of cases) {
      fs.writeFileSync(profile, name === 'absent'
        ? preferences([A, B], { omitUpdatedAt: true })
        : preferences([A, B], { updatedAt }));
      const result = await snapshot(context);
      assert.equal(result.state, 'ready', name);
      assert.deepEqual(result.favoriteModels, [A, B], name);
      assert.equal(result.updatedAt, expected, name);
      assert.equal(Number.isFinite(result.readAt), true, name);
      assert.equal(result.readAt >= 0, true, name);
      assert.equal(result.sourceKind, 'openchamber-preferences-v1');
      fingerprints.push(result.fingerprint);
    }
    // Missing/invalid/ISO/negative stamps normalize to null and share a projection.
    assert.equal(new Set(fingerprints.slice(0, 5)).size, 1);
    assert.notEqual(fingerprints[5], fingerprints[6]);
    assert.notEqual(fingerprints[0], fingerprints[6]);

    fs.writeFileSync(profile, rawInfinity);
    const infinite = await snapshot(context);
    assert.equal(infinite.state, 'ready');
    assert.equal(infinite.updatedAt, null);
    assert.deepEqual(infinite.favoriteModels, []);
  });
});

test('final symlinks, directories and FIFOs are refused without blocking', async t => {
  await withService('favorite-types', async context => {
    const root = context.root;
    const real = writeProfile(root, preferences([A]), 'real.json');
    const link = path.join(root, 'profile', 'link.json');
    fs.symlinkSync(real, link);
    await configure(context, link);
    const symlink = await snapshot(context);
    assert.equal(symlink.state, 'unsupported');
    assert.equal(symlink.error.code, 'FAVORITES_SOURCE_NOT_REGULAR');
    assert.equal(fs.readFileSync(real, 'utf8'), preferences([A]));

    const directory = path.join(root, 'profile', 'directory');
    fs.mkdirSync(directory);
    await configure(context, directory);
    const directoryResult = await snapshot(context);
    assert.equal(directoryResult.state, 'unsupported');
    assert.equal(directoryResult.error.code, 'FAVORITES_SOURCE_NOT_REGULAR');

    const fifo = path.join(root, 'profile', 'favorites.fifo');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (made.status !== 0) {
      t.skip('mkfifo is unavailable');
      return;
    }
    await configure(context, fifo);
    const result = await Promise.race([
      snapshot(context),
      new Promise((_, reject) => { setTimeout(() => reject(new Error('FIFO snapshot blocked')), 2000); }),
    ]);
    assert.equal(result.state, 'unsupported');
    assert.equal(result.error.code, 'FAVORITES_SOURCE_NOT_REGULAR');
  });
});

test('validates, deduplicates and bounds favorite references', async () => {
  await withService('favorite-refs', async context => {
    const profile = writeProfile(context.root, preferences([A, B, A, C]));
    await configure(context, profile);

    const deduped = await snapshot(context);
    assert.deepEqual(deduped.favoriteModels, [A, B, C]);

    fs.writeFileSync(profile, preferences([{ ...A, displayName: CANARY }, B]));
    const extra = await snapshot(context);
    assert.equal(extra.state, 'ready');
    assert.deepEqual(extra.favoriteModels, [A, B]);
    assert.equal(JSON.stringify(extra).includes(CANARY), false);
    assert.deepEqual(Object.keys(extra.favoriteModels[0]).sort(), ['modelID', 'providerID']);

    const acceptedProviders = ['@scope', 'provider+tag', 'a.b_c-d'];
    fs.writeFileSync(profile, preferences(
      acceptedProviders.map(providerID => ({ providerID, modelID: 'model' })),
    ));
    const providers = await snapshot(context);
    assert.equal(providers.state, 'ready');
    assert.deepEqual(providers.favoriteModels,
      acceptedProviders.map(providerID => ({ providerID, modelID: 'model' })));

    fs.writeFileSync(profile, preferences([{ providerID: 'openrouter', modelID: 'anthropic/claude' }]));
    const nestedModel = await snapshot(context);
    assert.equal(nestedModel.state, 'ready');
    assert.deepEqual(nestedModel.favoriteModels,
      [{ providerID: 'openrouter', modelID: 'anthropic/claude' }]);

    const atLimit = { providerID: 'p', modelID: 'm'.repeat(498) };
    assert.equal(atLimit.providerID.length + 1 + atLimit.modelID.length, 500);
    fs.writeFileSync(profile, preferences([atLimit]));
    const boundary = await snapshot(context);
    assert.equal(boundary.state, 'ready');
    assert.deepEqual(boundary.favoriteModels, [atLimit]);

    const overLimit = { providerID: 'p', modelID: 'm'.repeat(499) };
    assert.equal(overLimit.providerID.length + 1 + overLimit.modelID.length, 501);
    fs.writeFileSync(profile, preferences([overLimit]));
    const refused = await snapshot(context);
    assert.equal(refused.state, 'unsupported');
    assert.equal(refused.error.code, 'FAVORITES_SOURCE_REFS_UNSUPPORTED');

    const invalidRefs = [
      [null],
      ['anthropic/claude-sonnet-4'],
      [{ providerID: '', modelID: 'm' }],
      [{ providerID: 'a/b', modelID: 'm' }],
      [{ providerID: 'a b', modelID: 'm' }],
      [{ providerID: 'a\u0000b', modelID: 'm' }],
      [{ providerID: '${env:PROVIDER}', modelID: 'm' }],
      [{ providerID: 'a', modelID: 'm n' }],
      [{ providerID: 'a', modelID: 'm\u0000n' }],
      [{ providerID: 'a', modelID: '${env:MODEL}' }],
      [{ providerID: 'a${b', modelID: 'c}' }],
      [{ providerID: 'a{env:b', modelID: 'c}' }],
    ];
    for (const value of invalidRefs) {
      fs.writeFileSync(profile, preferences(value));
      const response = await snapshot(context);
      assert.equal(response.state, 'unsupported', JSON.stringify(value));
      assert.equal(response.error.code, 'FAVORITES_SOURCE_REFS_UNSUPPORTED');
      assert.equal(Object.hasOwn(response, 'favoriteModels'), false);
      assert.equal(JSON.stringify(response).includes(CANARY), false);
    }

    const sixtyFour = Array.from({ length: 64 }, (_, index) => ({
      providerID: `provider-${index}`,
      modelID: `model-${index}`,
    }));
    fs.writeFileSync(profile, preferences(sixtyFour));
    const bounded = await snapshot(context);
    assert.equal(bounded.state, 'ready');
    assert.equal(bounded.favoriteModels.length, 64);
    assert.deepEqual(bounded.favoriteModels, sixtyFour);

    fs.writeFileSync(profile, preferences([
      ...sixtyFour,
      { providerID: 'provider-64', modelID: 'model-64' },
    ]));
    const tooMany = await snapshot(context);
    assert.equal(tooMany.state, 'unsupported');
    assert.equal(tooMany.error.code, 'FAVORITES_SOURCE_TOO_MANY');
    assert.equal(Object.hasOwn(tooMany, 'favoriteModels'), false);
  });
});

test('growth or truncation during the read is detected, not silently accepted', async () => {
  await withService('favorite-growth', async context => {
    const profile = writeProfile(context.root, preferences([A, B]));
    const normal = readFavoritesSnapshot({ filePath: profile, generation: 'gen', now: () => 42 });
    assert.equal(normal.state, 'ready');
    assert.equal(normal.readAt, 42);
    assert.deepEqual(normal.favoriteModels, [A, B]);
    const later = readFavoritesSnapshot({ filePath: profile, generation: 'gen', now: () => 99 });
    assert.equal(later.readAt, 99);
    assert.equal(later.fingerprint, normal.fingerprint, 'readAt is excluded from the fingerprint');

    const grown = readFavoritesSnapshot({
      filePath: profile,
      generation: 'gen',
      now: () => 42,
      io: {
        afterFirstStat(file) {
          fs.appendFileSync(file, ' ');
        },
      },
    });
    assert.equal(grown.state, 'unavailable');
    assert.equal(grown.error.code, 'FAVORITES_SOURCE_CHANGED');
    assert.equal(Object.hasOwn(grown, 'favoriteModels'), false);

    const truncated = readFavoritesSnapshot({
      filePath: profile,
      generation: 'gen',
      now: () => 42,
      io: {
        afterFirstStat(file) {
          fs.truncateSync(file, 0);
        },
      },
    });
    assert.equal(truncated.state, 'unavailable');
    assert.equal(truncated.error.code, 'FAVORITES_SOURCE_CHANGED');

    const swapped = writeProfile(context.root, preferences([{ providerID: 'aaaa', modelID: 'model' }]), 'swap.json');
    const replacement = preferences([{ providerID: 'bbbb', modelID: 'model' }]);
    assert.equal(replacement.length, preferences([{ providerID: 'aaaa', modelID: 'model' }]).length);
    const replaced = readFavoritesSnapshot({
      filePath: swapped,
      generation: 'gen',
      now: () => 42,
      io: {
        afterFirstStat(file) {
          const temporary = `${file}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, replacement);
          fs.renameSync(temporary, file);
        },
      },
    });
    assert.equal(replaced.state, 'unavailable');
    assert.equal(replaced.error.code, 'FAVORITES_SOURCE_CHANGED');
  });
});

test('source generation changes never publish a stale snapshot', async () => {
  await withService('favorite-generation', async context => {
    const root = context.root;
    const profileA = writeProfile(root, preferences([A]), 'a.json');
    const profileB = writeProfile(root, preferences([C]), 'b.json');

    const savedA = await configure(context, profileA);
    const first = await snapshot(context);
    assert.equal(first.generation, savedA.generation);
    assert.deepEqual(first.favoriteModels, [A]);
    assert.equal(first.generation, (await call(context.baseUrl, 'GET', '/favorites/source')).body.generation);

    const savedB = await configure(context, profileB);
    assert.notEqual(savedB.generation, savedA.generation);
    const second = await snapshot(context);
    assert.equal(second.generation, savedB.generation);
    assert.deepEqual(second.favoriteModels, [C]);
    assert.notEqual(second.generation, first.generation);

    const concurrent = await Promise.all(Array.from({ length: 10 }, () => snapshot(context)));
    for (const result of concurrent) {
      assert.equal(result.state, 'ready');
      assert.equal(result.generation, savedB.generation);
      assert.deepEqual(result.favoriteModels, [C]);
    }

    // External atomic replacement changes bytes/fingerprint, not the source setting generation.
    const temporary = `${profileB}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, preferences([A, C]));
    fs.renameSync(temporary, profileB);
    const replaced = await snapshot(context);
    assert.equal(replaced.generation, savedB.generation);
    assert.deepEqual(replaced.favoriteModels, [A, C]);
    assert.notEqual(replaced.fingerprint, second.fingerprint);

    const savedA2 = await configure(context, profileA);
    assert.notEqual(savedA2.generation, savedB.generation);
    const last = await snapshot(context);
    assert.equal(last.generation, savedA2.generation);
    assert.deepEqual(last.favoriteModels, [A]);

    const settingsBefore = await call(context.baseUrl, 'GET', '/settings');
    const rotated = await call(context.baseUrl, 'POST', '/settings', {
      body: settingsFor(context.env),
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.generation, settingsBefore.body.generation);
    const sourceAfterSettings = await call(context.baseUrl, 'GET', '/favorites/source');
    assert.equal(sourceAfterSettings.body.generation, savedA2.generation);
    const snapshotAfterSettings = await snapshot(context);
    assert.equal(snapshotAfterSettings.generation, savedA2.generation);
    assert.deepEqual(snapshotAfterSettings.favoriteModels, [A]);
  });
});

test('corrupt persisted source settings fail explicitly while health stays up', async () => {
  const root = makeRoot('favorite-corrupt');
  const env = makeEnv(root);
  standardConfig(root);
  const storePath = path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'favorites-source.json');
  fs.mkdirSync(env.OPENCHAMBER_SERVICE_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(storePath, '{not json ' + CANARY);
  const context = await startService(env, { logger: () => {} });
  try {
    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    for (const route of ['/favorites/source', '/favorites/snapshot']) {
      const response = await call(context.baseUrl, 'GET', route);
      assert.equal(response.status, 500, route);
      assert.equal(response.body.error.code, 'FAVORITES_SOURCE_CORRUPT');
      assert.equal(response.text.includes(CANARY), false);
    }
    const put = await call(context.baseUrl, 'POST', '/favorites/source', { body: { filePath: '' } });
    assert.equal(put.status, 200, 'an explicit reset repairs the source setting');
    assert.equal((await call(context.baseUrl, 'GET', '/favorites/source')).status, 200);
  } finally {
    await context.close();
  }
});

test('source reads and settings writes never modify the profile file mode or bytes', async () => {
  await withService('favorite-readonly', async context => {
    const profile = writeProfile(context.root, preferences([A]), 'preferences.json', 0o640);
    const bytes = fs.readFileSync(profile);
    const mode = fs.statSync(profile).mode & 0o777;
    await configure(context, profile);
    await snapshot(context);
    await snapshot(context);
    assert.deepEqual(fs.readFileSync(profile), bytes);
    assert.equal(fs.statSync(profile).mode & 0o777, mode);
    const leftovers = fs.readdirSync(path.dirname(profile)).filter(name => name.startsWith('preferences.json.'));
    assert.deepEqual(leftovers, []);
  });
});
