import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  SAMPLE_CONFIG,
  TOKEN,
  call,
  configSnapshot,
  makeEnv,
  makeRoot,
  previewChange,
  settingsFor,
  standardConfig,
  startService,
  writeFile,
} from './helpers.mjs';

async function withService(name, setup, run) {
  const root = makeRoot(name);
  const env = makeEnv(root);
  const extra = setup ? await setup({ root, env }) : {};
  const context = await startService(env);
  try {
    await run({ root, env, ...extra, ...context });
  } finally {
    await context.close();
  }
}

const findGroup = (snapshot, name) => snapshot.groups.find(group => group.name === name);

test('health needs the host bearer, rejects browser origins and is always available', async () => {
  await withService('health', null, async ({ baseUrl, env }) => {
    const missing = await call(baseUrl, 'GET', '/health', { token: '' });
    assert.equal(missing.status, 401);
    const wrong = await call(baseUrl, 'GET', '/health', { token: 'nope' });
    assert.equal(wrong.status, 401);
    const health = await call(baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, version: '0.3.1' });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    const origin = await call(baseUrl, 'GET', '/health', { headers: { origin: 'http://evil.example' } });
    assert.equal(origin.status, 403);
    assert.equal(origin.body.error.code, 'ORIGIN_REJECTED');
    const crossSite = await call(baseUrl, 'GET', '/health', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    assert.equal(env.OPENCHAMBER_SERVICE_TOKEN, TOKEN);
  });
});

test('config projects primary slots and stages only an explicit orchestrator creation transaction', async () => {
  const root = makeRoot('primary-creation');
  const env = makeEnv(root);
  const configFile = settingsFor(env).configFile;
  writeFile(configFile, '{ "presets": { "SAFE": { "review": { "model": "openai/gpt-5" } } } }\n');
  let cliCalls = 0;
  const context = await startService(env, { execFileImpl() { cliCalls += 1; throw new Error('unexpected CLI'); } });
  try {
    const { baseUrl } = context;
    const snapshot = await configSnapshot(baseUrl);
    assert.equal((await call(baseUrl, 'GET', '/health')).body.version, '0.3.1');
    assert.ok(snapshot.primarySlots.some(slot => slot.preset === 'SAFE' && slot.agent === 'orchestrator' && slot.canCreate));
    const original = fs.readFileSync(configFile, 'utf8');
    const request = {
      baseHash: snapshot.baseHash, generation: snapshot.target.generation, changes: [],
      primaryCreations: [{ preset: 'SAFE', agent: 'orchestrator', models: [{ id: 'openai/gpt-5-mini', variant: '' }] }],
    };
    const preview = await call(baseUrl, 'POST', '/preview', { body: request });
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.body.diff, /orchestrator/);
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    const rejected = await call(baseUrl, 'POST', '/preview', {
      body: { ...request, primaryCreations: [{ preset: 'SAFE', agent: 'build', models: [{ id: 'openai/gpt-5' }] }] },
    });
    assert.equal(rejected.status, 400);
    const generic = await call(baseUrl, 'POST', '/preview', {
      body: { ...request, primaryCreations: [{ preset: 'absent', agent: 'orchestrator', models: [{ id: 'openai/gpt-5' }] }] },
    });
    assert.equal(generic.status, 400);
    const committed = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(committed.status, 200, committed.text);
    const reconciled = await call(baseUrl, 'POST', '/reconcile', {
      body: { previewToken: preview.body.previewToken, generation: snapshot.target.generation },
    });
    assert.equal(reconciled.status, 200);
    assert.deepEqual(reconciled.body.primarySlots, (await configSnapshot(baseUrl)).primarySlots);
    assert.equal(cliCalls, 0);
  } finally { await context.close(); }
});

test('settings discover the standard path and stay editable with a broken or missing config', async () => {
  await withService('bootstrap', null, async ({ baseUrl, env, root }) => {
    const settings = await call(baseUrl, 'GET', '/settings');
    assert.equal(settings.status, 200);
    assert.deepEqual(settings.body.settings, settingsFor(env));
    assert.equal(typeof settings.body.generation, 'string');

    const missing = await call(baseUrl, 'GET', '/config');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'CONFIG_MISSING');

    const configFile = settingsFor(env).configFile;
    writeFile(configFile, '{ "agents": { broken');
    const health = await call(baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    const stillSettings = await call(baseUrl, 'GET', '/settings');
    assert.equal(stillSettings.status, 200);
    const broken = await call(baseUrl, 'GET', '/config');
    assert.equal(broken.status, 422);
    assert.equal(broken.body.error.code, 'CONFIG_INVALID');
    assert.doesNotMatch(broken.text, /agents/);

    const saved = await call(baseUrl, 'POST', '/settings', {
      body: { ...settings.body.settings, modelCwd: path.join(root, 'elsewhere') },
    });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.body.generation, settings.body.generation);
    assert.equal(saved.body.settings.modelCwd, path.join(root, 'elsewhere'));
  });

  // A JSON file is discovered only when the JSONC file is absent.
  const root = makeRoot('discover-json');
  const env = makeEnv(root);
  const jsonPath = writeFile(path.join(root, 'xdg', 'opencode', 'oh-my-opencode-slim.json'), '{}');
  const context = await startService(env);
  try {
    const settings = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(settings.body.settings.configFile, jsonPath);
  } finally {
    await context.close();
  }
});

test('explicit invalid settings never fall back to the discovered file', async () => {
  await withService('explicit', ({ root, env }) => {
    const discovered = writeFile(settingsFor(env).configFile, SAMPLE_CONFIG);
    const explicit = path.join(root, 'chosen', 'missing.jsonc');
    return { discovered, explicit };
  }, async ({ baseUrl, root, discovered, explicit }) => {
    const saved = await call(baseUrl, 'POST', '/settings', {
      body: { configFile: explicit, opencodeBin: 'opencode', modelCwd: root, opencodeConfigDir: '' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.configFile, explicit);
    const config = await call(baseUrl, 'GET', '/config');
    assert.equal(config.status, 404);
    assert.equal(config.body.error.code, 'CONFIG_MISSING');
    assert.match(fs.readFileSync(discovered, 'utf8'), /team settings/);
  });
});

test('preview and commit replace only reviewed values, with one backup and no replay', async () => {
  await withService('commit', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl, env }) => {
    const configFile = settingsFor(env).configFile;
    const original = fs.readFileSync(configFile, 'utf8');
    const snapshot = await configSnapshot(baseUrl);
    assert.equal(snapshot.target.logicalPath, configFile);
    assert.equal(snapshot.target.path, fs.realpathSync(configFile));
    assert.equal(snapshot.groups.length, 11);
    assert.match(snapshot.baseHash, /^[0-9a-f]{64}$/);

    const build = findGroup(snapshot, 'review');
    fs.chmodSync(configFile, 0o640);
    const want = [
      { id: 'openai/gpt-5', variant: 'high' },
      { id: 'anthropic/claude-sonnet-4', variant: '' },
    ];

    const noop = await previewChange(baseUrl, { path: build.path, models: build.models }, snapshot);
    assert.equal(noop.status, 200);
    assert.equal(noop.body.previewToken, null);
    assert.equal(noop.body.diff, '');
    assert.deepEqual(noop.body.changed, []);
    assert.equal(noop.body.afterHash, snapshot.baseHash);

    const preview = await previewChange(baseUrl, { path: build.path, models: want }, snapshot);
    assert.equal(preview.status, 200);
    assert.match(preview.body.previewToken, /^[0-9a-f-]{36}$/);
    assert.deepEqual(preview.body.changed, ['preset coding · review']);
    assert.notEqual(preview.body.afterHash, snapshot.baseHash);
    assert.match(preview.body.diff, /^--- .*\(current\)\n\+\+\+ .*\(edited\)\n/m);
    assert.match(preview.body.diff, /openai\/gpt-5/);
    assert.doesNotMatch(preview.body.diff, /"agents"/);
    assert.equal(typeof preview.body.expiresAt, 'number');

    const replayBody = await call(baseUrl, 'POST', '/commit', {
      body: { previewToken: preview.body.previewToken, changes: [] },
    });
    assert.equal(replayBody.status, 400, 'commit accepts only a token');

    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.ok, true);
    assert.equal(commit.body.baseHash, preview.body.afterHash);
    assert.deepEqual(commit.body.changed, ['preset coding · review']);
    assert.match(commit.body.target.path, /oh-my-opencode-slim\.jsonc$/);
    assert.match(commit.body.backup, /\.bak\.pre-ui-\d{14}(\.\d+)?$/);
    assert.equal(fs.readFileSync(commit.body.backup, 'utf8'), original);
    assert.equal(fs.statSync(commit.body.backup).mode & 0o777, 0o640);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o640, 'target mode preserved');

    const written = fs.readFileSync(configFile, 'utf8');
    assert.notEqual(written, original);
    assert.equal((await configSnapshot(baseUrl)).baseHash, commit.body.baseHash);
    const after = await configSnapshot(baseUrl);
    assert.deepEqual(findGroup(after, 'review').models, want);
    assert.deepEqual(findGroup(after, 'plain').models, findGroup(snapshot, 'plain').models);
    assert.match(written, /\/\/ team settings/);
    assert.match(written, /"variant": "high"/, 'queue default variant preserved');

    const replay = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'PREVIEW_INVALID');

    const reconciled = await call(baseUrl, 'POST', '/reconcile', {
      body: { previewToken: preview.body.previewToken, generation: after.target.generation },
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.baseHash, commit.body.baseHash);
    const late = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'PREVIEW_INVALID');
  });
});

test('a second client on changed bytes is a conflict, never an overwrite', async () => {
  await withService('conflict', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl, env }) => {
    const configFile = settingsFor(env).configFile;
    const snapshot = await configSnapshot(baseUrl);
    const plain = findGroup(snapshot, 'plain');
    const preview = await previewChange(baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, snapshot);
    assert.equal(preview.status, 200);

    const external = SAMPLE_CONFIG.replace('"plain": { "model": "openai/gpt-5" }',
      '"plain": { "model": "other/model" }');
    fs.writeFileSync(configFile, external);

    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'BASE_HASH_MISMATCH');
    assert.equal(fs.readFileSync(configFile, 'utf8'), external);

    const stalePreview = await previewChange(baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-7', variant: '' }] }, snapshot);
    assert.equal(stalePreview.status, 409);
    assert.equal(stalePreview.body.error.code, 'BASE_HASH_MISMATCH');
  });
});

test('a settings change invalidates the target, old generations and previews', async () => {
  await withService('generation', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl, env }) => {
    const first = await configSnapshot(baseUrl);
    const plain = findGroup(first, 'plain');
    const preview = await previewChange(baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, first);
    assert.equal(preview.status, 200);

    const saved = await call(baseUrl, 'POST', '/settings', { body: settingsFor(env) });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.body.generation, first.target.generation);

    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'PREVIEW_INVALID');

    const staleGeneration = await call(baseUrl, 'POST', '/preview', {
      body: { baseHash: first.baseHash, generation: first.target.generation, changes: [] },
    });
    assert.equal(staleGeneration.status, 409);
    assert.equal(staleGeneration.body.error.code, 'TARGET_CHANGED');
    assert.equal(fs.readFileSync(settingsFor(env).configFile, 'utf8'), SAMPLE_CONFIG);
  });
});

test('symlinks are pinned to their canonical pathname for the generation', async () => {
  await withService('symlink', ({ root, env }) => {
    const real = writeFile(path.join(root, 'real', 'config.jsonc'), SAMPLE_CONFIG);
    const link = path.join(root, 'xdg', 'opencode', 'oh-my-opencode-slim.jsonc');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const other = writeFile(path.join(root, 'other', 'config.jsonc'), SAMPLE_CONFIG.replace('gpt-5', 'gpt-6'));
    return { real, link, other };
  }, async ({ baseUrl, real, link, other }) => {
    const snapshot = await configSnapshot(baseUrl);
    assert.equal(snapshot.target.path, fs.realpathSync(real));
    assert.equal(snapshot.target.logicalPath, link);

    fs.unlinkSync(link);
    fs.symlinkSync(other, link);
    const retargeted = await call(baseUrl, 'GET', '/config');
    assert.equal(retargeted.status, 409);
    assert.equal(retargeted.body.error.code, 'TARGET_CHANGED');
  });
});

test('read-only queues and unknown paths are refused before preview', async () => {
  await withService('readonly', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl }) => {
    const snapshot = await configSnapshot(baseUrl);
    const explore = findGroup(snapshot, 'explore');
    assert.match(explore.readOnlyReason, /placeholders/);
    const helper = findGroup(snapshot, 'helper');
    assert.match(helper.readOnlyReason, /model entry properties/i);
    const custom = findGroup(snapshot, 'custom');
    assert.equal(custom.readOnlyReason, null);

    const readOnly = await previewChange(baseUrl,
      { path: explore.path, models: [{ id: 'openai/gpt-5', variant: '' }] }, snapshot);
    assert.equal(readOnly.status, 400);
    assert.equal(readOnly.body.error.code, 'READ_ONLY_PATH');

    const unknown = await previewChange(baseUrl,
      { path: ['agents', 'missing', 'model'], models: [{ id: 'openai/gpt-5', variant: '' }] }, snapshot);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'UNKNOWN_PATH');
  });
});

test('drafts persist independently, survive restart and reject stale targets', async () => {
  const root = makeRoot('drafts');
  const env = makeEnv(root);
  standardConfig(root);
  let context = await startService(env);
  try {
    const empty = await call(context.baseUrl, 'GET', '/drafts');
    assert.deepEqual(empty.body, { drafts: [] });

    const snapshot = await configSnapshot(context.baseUrl);
    const plain = findGroup(snapshot, 'plain');
    const build = findGroup(snapshot, 'review');
    const base = {
      targetPath: snapshot.target.path,
      baseHash: snapshot.baseHash,
      originals: [{ path: plain.path, models: plain.models }],
      changes: [{ path: plain.path, models: [{ id: 'openai/gpt-6', variant: 'high' }] }],
    };
    const first = await call(context.baseUrl, 'POST', '/drafts', { body: base });
    assert.equal(first.status, 200);
    assert.match(first.body.draft.id, /^[0-9a-f-]{36}$/);
    assert.equal(first.body.draft.targetPath, snapshot.target.path);

    const second = await call(context.baseUrl, 'POST', '/drafts', {
      body: {
        ...base,
        originals: [{ path: build.path, models: build.models }],
        changes: [{ path: build.path, models: [{ id: 'openai/gpt-5-mini', variant: '' }] }],
      },
    });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.draft.id, first.body.draft.id);

    const updated = await call(context.baseUrl, 'POST', '/drafts', {
      body: { ...base, id: first.body.draft.id, changes: [{ path: plain.path, models: [{ id: 'openai/gpt-7', variant: '' }] }] },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.draft.id, first.body.draft.id);
    const listed = await call(context.baseUrl, 'GET', '/drafts');
    assert.equal(listed.body.drafts.length, 2);

    const stale = await call(context.baseUrl, 'POST', '/drafts', {
      body: { ...base, targetPath: path.join(root, 'old.jsonc') },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'TARGET_CHANGED');

    const invalid = await call(context.baseUrl, 'POST', '/drafts', {
      body: { ...base, changes: [{ path: plain.path, models: [{ id: 'not a model', variant: '' }] }] },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_DRAFT');

    for (const model of [
      { id: 'openai/${env:MODEL}', variant: '' },
      { id: 'openai/gpt-5', variant: '{env:VARIANT}' },
    ]) {
      const placeholder = await call(context.baseUrl, 'POST', '/drafts', {
        body: { ...base, changes: [{ path: plain.path, models: [model] }] },
      });
      assert.equal(placeholder.status, 400, JSON.stringify(model));
      assert.equal(placeholder.body.error.code, 'INVALID_DRAFT');
    }

    const removed = await call(context.baseUrl, 'DELETE', `/drafts/${first.body.draft.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.id, first.body.draft.id);
    const again = await call(context.baseUrl, 'DELETE', `/drafts/${first.body.draft.id}`);
    assert.equal(again.status, 404);
  } finally {
    await context.close();
  }

  context = await startService(env);
  try {
    const listed = await call(context.baseUrl, 'GET', '/drafts');
    assert.equal(listed.body.drafts.length, 1);
    assert.equal(listed.body.drafts[0].targetPath,
      fs.realpathSync(settingsFor(env).configFile));
  } finally {
    await context.close();
  }
});

test('editing a queue with legitimate agent metadata keeps metadata out of the diff', async () => {
  await withService('metadata', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl, env }) => {
    const snapshot = await configSnapshot(baseUrl);
    const custom = findGroup(snapshot, 'custom');
    assert.equal(custom.readOnlyReason, null);
    const preview = await previewChange(baseUrl,
      { path: custom.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, snapshot);
    assert.equal(preview.status, 200);
    assert.match(preview.body.diff, /openai\/gpt-6/);
    assert.doesNotMatch(preview.body.diff, /Custom agent|synthetic-private-text|skills|temperature/);
    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 200);
    const written = fs.readFileSync(settingsFor(env).configFile, 'utf8');
    assert.match(written, /"description": "Custom agent",/);
    assert.match(written, /"prompt": "synthetic-private-text",/);
    assert.match(written, /"options": \{ "temperature": 0\.2 \}/);
  });
});

test('reconcile revokes the old token even when the target read fails', async () => {
  await withService('reconcile-revoke', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl, env }) => {
    const configFile = settingsFor(env).configFile;
    const snapshot = await configSnapshot(baseUrl);
    const plain = findGroup(snapshot, 'plain');
    const preview = await previewChange(baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, snapshot);
    assert.equal(preview.status, 200);

    const moved = `${configFile}.moved`;
    fs.renameSync(configFile, moved);
    const reconcile = await call(baseUrl, 'POST', '/reconcile', {
      body: { previewToken: preview.body.previewToken, generation: snapshot.target.generation },
    });
    assert.equal(reconcile.status, 404);
    assert.equal(reconcile.body.error.code, 'CONFIG_MISSING');

    fs.renameSync(moved, configFile);
    const late = await call(baseUrl, 'POST', '/commit', {
      body: { previewToken: preview.body.previewToken },
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'PREVIEW_INVALID');
  });
});

test('preview tokens expire after fifteen minutes and cannot commit', async () => {
  const root = makeRoot('expiry');
  const env = makeEnv(root);
  standardConfig(root);
  let clock = Date.now();
  const context = await startService(env, { now: () => clock, logger: () => {} });
  try {
    const snapshot = await configSnapshot(context.baseUrl);
    const plain = findGroup(snapshot, 'plain');
    const preview = await previewChange(context.baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, snapshot);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.expiresAt, clock + 15 * 60 * 1000);

    clock += 15 * 60 * 1000 + 1;
    const commit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: preview.body.previewToken },
    });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'PREVIEW_INVALID');
    assert.equal(fs.readFileSync(settingsFor(env).configFile, 'utf8'), SAMPLE_CONFIG);
  } finally {
    await context.close();
  }
});

test('body bounds, media type and unknown routes fail explicitly', async () => {
  await withService('bounds', ({ root, env }) => {
    standardConfig(root);
  }, async ({ baseUrl }) => {
    const large = await call(baseUrl, 'POST', '/preview', {
      body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(large.status, 413);
    assert.equal(large.body.error.code, 'BODY_TOO_LARGE');

    const text = await call(baseUrl, 'POST', '/preview', {
      body: 'not json', headers: { 'content-type': 'text/plain' },
    });
    assert.equal(text.status, 415);

    const bad = await call(baseUrl, 'POST', '/preview', { body: '{' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_JSON');

    const unknown = await call(baseUrl, 'GET', '/nope');
    assert.equal(unknown.status, 404);
    const method = await call(baseUrl, 'PUT', '/settings');
    assert.equal(method.status, 405);
  });
});
