import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCatalog } from '../../src/backend/catalog.js';
import {
  SAMPLE_CONFIG,
  call,
  configSnapshot,
  makeEnv,
  makeRoot,
  settingsFor,
  standardConfig,
  startService,
  waitFor,
  writeFile,
} from './helpers.mjs';

function fakeCli({ modeFile, countFile, markFile, envFile }) {
  return `#!/bin/sh
echo x >> '${countFile}'
mode=$(cat '${modeFile}' 2>/dev/null || echo fast)
case "$mode" in
  fail)
    echo "unexpected failure with secret-ish output" >&2
    exit 3
    ;;
  plugin)
    if [ ! -f '${markFile}' ]; then
      echo "Location plugins did not finish activating" >&2
      touch '${markFile}'
      exit 1
    fi
    echo "openai/gpt-5"
    echo "anthropic/claude-sonnet-4"
    ;;
  slow)
    sleep 1.2
    echo "old/model"
    ;;
  empty)
    exit 0
    ;;
  envdump)
    env > '${envFile}'
    echo "openai/gpt-5"
    ;;
  scoped)
    echo "@scope/model-name"
    echo "provider+tag/model@v1"
    ;;
  *)
    echo "openai/gpt-5"
    echo "anthropic/claude-sonnet-4"
    echo "openai/gpt-5"
    ;;
esac
`;
}

function counts(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function setup(env, root) {
  const modeFile = writeFile(path.join(root, 'catalog-mode'), 'fast');
  const countFile = path.join(root, 'catalog-count');
  const markFile = path.join(root, 'catalog-mark');
  const envFile = path.join(root, 'catalog-env');
  const bin = writeFile(path.join(root, 'bin', 'fake-opencode'),
    fakeCli({ modeFile, countFile, markFile, envFile }), 0o755);
  standardConfig(root);
  const config = {
    ...settingsFor(env),
    opencodeBin: bin,
  };
  return { bin, modeFile, countFile, markFile, envFile, config };
}

async function serviceWithCatalog(name) {
  const root = makeRoot(name);
  const env = makeEnv(root, {
    CATALOG_MODE_FILE: path.join(root, 'catalog-mode'),
    CATALOG_COUNT_FILE: path.join(root, 'catalog-count'),
    CATALOG_MARK_FILE: path.join(root, 'catalog-mark'),
    CATALOG_ENV_FILE: path.join(root, 'catalog-env'),
    CUSTOM_SECRET: 'must-not-reach-the-child',
    OPENCHAMBER_HOST_CALLBACK_URL: 'http://127.0.0.1:1/secret-callback',
  });
  const files = setup(env, root);
  const context = await startService(env, { logger: () => {} });
  const saved = await call(context.baseUrl, 'POST', '/settings', { body: files.config });
  assert.equal(saved.status, 200);
  return { root, env, files, ...context };
}

const listModels = baseUrl => call(baseUrl, 'GET', '/models');

test('first request returns loading immediately, then a sorted deduplicated catalog', async () => {
  const context = await serviceWithCatalog('catalog-ready');
  try {
    const started = Date.now();
    const first = await listModels(context.baseUrl);
    assert.ok(Date.now() - started < 1000, 'GET /models never waits on the child');
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'loading');
    assert.deepEqual(first.body.flat, []);
    assert.equal(first.body.updatedAt, null);

    const ready = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'ready catalog' });
    assert.deepEqual(ready.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    assert.equal(ready.stale, false);
    assert.equal(ready.error, null);
    assert.equal(typeof ready.updatedAt, 'number');
    assert.equal(counts(context.files.countFile), 1, 'one child run');

    const cached = await listModels(context.baseUrl);
    assert.equal(cached.body.state, 'ready');
    assert.equal(counts(context.files.countFile), 1, 'fresh cache is reused');

    const snapshot = await configSnapshot(context.baseUrl);
    assert.equal(snapshot.groups.length, 11, 'catalog work does not disturb config reads');
  } finally {
    await context.close();
  }
});

test('failures are honest, never respawn on read, and retry only on explicit refresh', async () => {
  const context = await serviceWithCatalog('catalog-failure');
  try {
    fs.writeFileSync(context.files.modeFile, 'fail');
    const startBody = await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    assert.equal(startBody.status, 200);
    assert.equal(startBody.body.state, 'loading');

    const failed = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'error' ? result.body : null;
    }, { label: 'catalog failure' });
    assert.equal(failed.error.code, 'MODELS_UNAVAILABLE');
    assert.doesNotMatch(failed.error.message, /unexpected failure/, 'child output is not echoed');
    assert.match(failed.error.message, /fake-opencode/);
    assert.deepEqual(failed.flat, []);
    assert.equal(failed.stale, false);
    const runsAfterFailure = counts(context.files.countFile);
    assert.equal(runsAfterFailure, 1);

    fs.writeFileSync(context.files.modeFile, 'fast');
    const stillFailed = await listModels(context.baseUrl);
    assert.equal(stillFailed.body.state, 'error');
    assert.equal(counts(context.files.countFile), runsAfterFailure, 'read never respawns');

    const refresh = await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    assert.equal(refresh.body.state, 'loading');
    const recovered = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'catalog recovery' });
    assert.deepEqual(recovered.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    assert.equal(recovered.error, null);
    assert.equal(counts(context.files.countFile), runsAfterFailure + 1);

    const config = await call(context.baseUrl, 'GET', '/config');
    assert.equal(config.status, 200, 'catalog failure never blocks editing');
  } finally {
    await context.close();
  }
});

test('concurrent refreshes coalesce into one job and settings changes re-scope the cache', async () => {
  const context = await serviceWithCatalog('catalog-refresh');
  try {
    const ready = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'initial catalog' });
    assert.deepEqual(ready.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    const before = counts(context.files.countFile);

    fs.writeFileSync(context.files.modeFile, 'slow');
    const [first, second] = await Promise.all([
      call(context.baseUrl, 'POST', '/models/refresh', { body: {} }),
      call(context.baseUrl, 'POST', '/models/refresh', { body: {} }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' && result.body.flat[0] === 'old/model' ? result.body : null;
    }, { label: 'coalesced refresh' });
    assert.equal(counts(context.files.countFile), before + 1, 'two refreshes started one child');

    const saved = await call(context.baseUrl, 'POST', '/settings', { body: context.files.config });
    assert.equal(saved.status, 200);
    fs.writeFileSync(context.files.modeFile, 'fast');
    const afterSettings = await listModels(context.baseUrl);
    assert.equal(afterSettings.body.state, 'loading');
    assert.deepEqual(afterSettings.body.flat, [], 'old generation cache is not reused');
    const rescoped = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'rescoped catalog' });
    assert.deepEqual(rescoped.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
  } finally {
    await context.close();
  }
});

test('a delayed job does not block health, config or drafts', async () => {
  const context = await serviceWithCatalog('catalog-slow');
  try {
    fs.writeFileSync(context.files.modeFile, 'slow');
    const start = await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    assert.equal(start.body.state, 'loading');

    const healthStart = Date.now();
    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.ok(Date.now() - healthStart < 800);
    const configStart = Date.now();
    const config = await call(context.baseUrl, 'GET', '/config');
    assert.equal(config.status, 200);
    assert.ok(Date.now() - configStart < 800);
    const drafts = await call(context.baseUrl, 'GET', '/drafts');
    assert.equal(drafts.status, 200);

    await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' && result.body.flat[0] === 'old/model' ? result.body : null;
    }, { label: 'slow catalog' });
  } finally {
    await context.close();
  }
});

test('the known plugin startup error is retried, bounded to three attempts', async () => {
  const context = await serviceWithCatalog('catalog-plugin');
  try {
    fs.writeFileSync(context.files.modeFile, 'plugin');
    const start = await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    assert.equal(start.body.state, 'loading');
    const ready = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'plugin retry catalog', timeout: 15_000 });
    assert.deepEqual(ready.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    assert.equal(counts(context.files.countFile), 2, 'one retry after the startup error');
    assert.ok(fs.existsSync(context.files.markFile));
  } finally {
    await context.close();
  }
});

test('an empty catalog is a failure, not a ready state', async () => {
  const context = await serviceWithCatalog('catalog-empty');
  try {
    fs.writeFileSync(context.files.modeFile, 'empty');
    await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    const failed = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'error' ? result.body : null;
    }, { label: 'empty catalog failure' });
    assert.equal(failed.error.code, 'MODELS_UNAVAILABLE');
  } finally {
    await context.close();
  }
});

test('a persisted last-good catalog survives a restart without a new child run', async () => {
  const root = makeRoot('catalog-persist');
  const env = makeEnv(root, {
    CATALOG_MODE_FILE: path.join(root, 'catalog-mode'),
    CATALOG_COUNT_FILE: path.join(root, 'catalog-count'),
    CATALOG_MARK_FILE: path.join(root, 'catalog-mark'),
  });
  const files = setup(env, root);
  let context = await startService(env, { logger: () => {} });
  let updatedAt;
  let flat;
  try {
    await call(context.baseUrl, 'POST', '/settings', { body: files.config });
    const ready = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'initial persisted catalog' });
    updatedAt = ready.updatedAt;
    flat = ready.flat;
  } finally {
    await context.close();
  }
  const runs = counts(files.countFile);

  context = await startService(env, { logger: () => {} });
  try {
    const restored = await listModels(context.baseUrl);
    assert.equal(restored.body.state, 'ready');
    assert.deepEqual(restored.body.flat, flat);
    assert.equal(restored.body.updatedAt, updatedAt);
    assert.equal(restored.body.stale, false);
    assert.equal(counts(files.countFile), runs, 'restart reuses the persisted cache');
  } finally {
    await context.close();
  }
});

test('a five-minute-old cache is labeled stale while one refresh runs', async () => {
  const root = makeRoot('catalog-stale');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let clock = 1_000;
  const pending = [];
  const catalog = createCatalog({
    dataDir,
    env: { PATH: process.env.PATH },
    now: () => clock,
    execFileImpl: (bin, args, options, callback) => {
      pending.push(callback);
      return { kill() {} };
    },
    logger: () => {},
  });
  const settings = { opencodeBin: 'opencode', modelCwd: root, opencodeConfigDir: '' };
  catalog.status(settings, 'scope');
  assert.equal(pending.length, 1);
  pending[0](null, 'openai/gpt-5\n');
  const ready = await waitFor(() => {
    const state = catalog.status(settings, 'scope');
    return state.state === 'ready' ? state : null;
  }, { label: 'first catalog' });
  assert.deepEqual(ready.flat, ['openai/gpt-5']);
  assert.equal(ready.stale, false);

  clock += 5 * 60 * 1000 + 1;
  const stale = catalog.status(settings, 'scope');
  assert.equal(stale.state, 'loading');
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.flat, ['openai/gpt-5']);
  assert.equal(pending.length, 2);
  pending[1](null, 'openai/gpt-6\n');
  const refreshed = await waitFor(() => {
    const state = catalog.status(settings, 'scope');
    return state.state === 'ready' ? state : null;
  }, { label: 'refreshed catalog' });
  assert.deepEqual(refreshed.flat, ['openai/gpt-6']);
  assert.equal(refreshed.stale, false);
  catalog.shutdown();
});

test('the catalog accepts OMOS-compatible provider tokens', async () => {
  const context = await serviceWithCatalog('catalog-scoped');
  try {
    fs.writeFileSync(context.files.modeFile, 'scoped');
    await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    const ready = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'scoped catalog' });
    assert.deepEqual(ready.flat, ['@scope/model-name', 'provider+tag/model@v1']);
  } finally {
    await context.close();
  }
});

test('the CLI child gets an allowlisted environment without service secrets', async () => {
  const context = await serviceWithCatalog('catalog-env');
  try {
    const configDir = path.join(context.root, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    const saved = await call(context.baseUrl, 'POST', '/settings', {
      body: { ...context.files.config, opencodeConfigDir: configDir },
    });
    assert.equal(saved.status, 200);
    fs.writeFileSync(context.files.modeFile, 'envdump');
    await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'env dump catalog' });
    const dump = fs.readFileSync(context.files.envFile, 'utf8');
    assert.doesNotMatch(dump, /^OPENCHAMBER_/m);
    assert.doesNotMatch(dump, /must-not-reach-the-child|127\.0\.0\.1:1/);
    assert.match(dump, /^PATH=/m);
    assert.match(dump, /^HOME=/m);
    assert.match(dump, new RegExp(`^OPENCODE_CONFIG_DIR=${configDir}$`, 'm'));
    assert.match(dump, /^NO_COLOR=1$/m);
    assert.match(dump, /^TERM=dumb$/m);
  } finally {
    await context.close();
  }
});

test('a retry wait is cancelled by a settings change and never spawns again', async () => {
  const context = await serviceWithCatalog('catalog-cancel');
  try {
    fs.writeFileSync(context.files.modeFile, 'plugin');
    const started = await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
    assert.equal(started.body.state, 'loading');
    await waitFor(() => counts(context.files.countFile) === 1 && fs.existsSync(context.files.markFile),
      { label: 'first plugin attempt' });

    const saved = await call(context.baseUrl, 'POST', '/settings', { body: context.files.config });
    assert.equal(saved.status, 200);
    await new Promise(resolve => { setTimeout(resolve, 1000); });
    assert.equal(counts(context.files.countFile), 1, 'the cancelled retry wait spawned nothing');

    fs.writeFileSync(context.files.modeFile, 'fast');
    const rescoped = await call(context.baseUrl, 'GET', '/models');
    assert.equal(rescoped.body.state, 'loading');
    const ready = await waitFor(async () => {
      const result = await listModels(context.baseUrl);
      return result.body.state === 'ready' ? result.body : null;
    }, { label: 'rescoped catalog after cancel' });
    assert.deepEqual(ready.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    assert.equal(counts(context.files.countFile), 2);
  } finally {
    await context.close();
  }
});

test('shutdown cancels a retry wait and leaves no child to spawn', async () => {
  const root = makeRoot('catalog-shutdown');
  const env = makeEnv(root, {
    CATALOG_MODE_FILE: path.join(root, 'catalog-mode'),
    CATALOG_COUNT_FILE: path.join(root, 'catalog-count'),
    CATALOG_MARK_FILE: path.join(root, 'catalog-mark'),
    CATALOG_ENV_FILE: path.join(root, 'catalog-env'),
  });
  const files = setup(env, root);
  const context = await startService(env, { logger: () => {} });
  await call(context.baseUrl, 'POST', '/settings', { body: files.config });
  fs.writeFileSync(files.modeFile, 'plugin');
  await call(context.baseUrl, 'POST', '/models/refresh', { body: {} });
  await waitFor(() => counts(files.countFile) === 1, { label: 'plugin attempt before shutdown' });
  await context.close();
  await new Promise(resolve => { setTimeout(resolve, 1000); });
  assert.equal(counts(files.countFile), 1, 'shutdown owns and cancels the pending retry');
});

test('late completions from an obsolete scope never publish', async () => {
  const root = makeRoot('catalog-fence');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const pending = [];
  const catalog = createCatalog({
    dataDir,
    env: { PATH: process.env.PATH },
    execFileImpl: (bin, args, options, callback) => {
      pending.push(callback);
      return { kill() { /* the fence, not the kill, must discard the result */ } };
    },
    logger: () => {},
  });
  const settings = { opencodeBin: 'opencode', modelCwd: root, opencodeConfigDir: '' };

  const first = catalog.status(settings, 'scope-a');
  assert.equal(first.state, 'loading');
  assert.equal(pending.length, 1);

  catalog.setScope('scope-b');
  pending[0](null, 'old/model\n');
  await new Promise(resolve => { setImmediate(resolve); });

  const second = catalog.status(settings, 'scope-b');
  assert.equal(second.state, 'loading');
  assert.equal(pending.length, 2);
  pending[1](null, 'openai/gpt-5\nanthropic/claude-sonnet-4\n');
  const ready = await waitFor(() => {
    const state = catalog.status(settings, 'scope-b');
    return state.state === 'ready' ? state : null;
  }, { label: 'fenced catalog' });
  assert.deepEqual(ready.flat, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
  catalog.shutdown();
});
