import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { VERSION as MAIN_VERSION, createServiceServer, startService } from '../../src/backend/main.js';
import { TOKEN, call, makeEnv, makeRoot, startService as startTestService } from './helpers.mjs';

test('importing the built entry is passive and exports the service surface', async () => {
  assert.equal(MAIN_VERSION, '0.3.1');
  assert.equal(typeof createServiceServer, 'function');
  assert.equal(typeof startService, 'function');
  // No listener was opened by the import: binding the same port must succeed.
  const service = createServiceServer({
    env: {
      HOME: '/tmp/opencode',
      OPENCHAMBER_SERVICE_DATA_DIR: fs.mkdtempSync('/tmp/opencode/passive-'),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    },
  });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  assert.equal(service.server.listening, true);
  await service.close();
});

test('startService refuses a missing port or token', async () => {
  await assert.rejects(() => startService({ env: {} }), /required/);
  await assert.rejects(() => startService({
    env: { OPENCHAMBER_SERVICE_PORT: '0', OPENCHAMBER_SERVICE_TOKEN: '' },
  }), /required/);
  await assert.rejects(() => startService({
    env: { OPENCHAMBER_SERVICE_PORT: 'nope', OPENCHAMBER_SERVICE_TOKEN: 'x' },
  }), /required/);
});

test('an explicit settings change validates every field and ignores inherited legacy env', async () => {
  const root = makeRoot('settings-shape');
  const env = makeEnv(root, {
    OMOS_CONFIG: '/tmp/opencode/legacy.jsonc',
    OPENCODE_BIN: '/tmp/opencode/legacy-bin',
    OPENCODE_CONFIG_DIR: '/tmp/opencode/legacy-config',
  });
  const context = await startTestService(env);
  try {
    const discovered = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(discovered.body.settings.configFile,
      path.join(env.XDG_CONFIG_HOME, 'opencode', 'oh-my-opencode-slim.jsonc'));
    assert.equal(discovered.body.settings.opencodeBin, 'opencode');
    assert.equal(discovered.body.settings.opencodeConfigDir, '');

    const valid = {
      configFile: path.join(root, 'config.jsonc'),
      opencodeBin: 'my-opencode',
      modelCwd: root,
      opencodeConfigDir: path.join(root, 'opencode-config'),
    };
    const saved = await call(context.baseUrl, 'POST', '/settings', { body: valid });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings, valid);

    const cases = [
      { ...valid, extra: true },
      { ...valid, configFile: 'relative.jsonc' },
      { ...valid, opencodeBin: '' },
      { ...valid, opencodeBin: 'bad/name' },
      { ...valid, modelCwd: 'relative' },
      { ...valid, opencodeConfigDir: 'relative' },
      { ...valid, configFile: `${root}/nul\u0000byte` },
    ];
    for (const body of cases) {
      const response = await call(context.baseUrl, 'POST', '/settings', { body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, 'INVALID_SETTINGS');
    }
    const missing = await call(context.baseUrl, 'POST', '/settings', {
      body: { configFile: valid.configFile, opencodeBin: 'opencode', modelCwd: root },
    });
    assert.equal(missing.status, 400);
    const unchanged = await call(context.baseUrl, 'GET', '/settings');
    assert.deepEqual(unchanged.body.settings, valid);
  } finally {
    await context.close();
  }
});

test('a corrupt settings store fails explicitly instead of falling back', async () => {
  const root = makeRoot('settings-corrupt');
  const env = makeEnv(root);
  fs.mkdirSync(env.OPENCHAMBER_SERVICE_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'settings.json'), '{not json');
  const context = await startTestService(env);
  try {
    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    const settings = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(settings.status, 500);
    assert.equal(settings.body.error.code, 'SETTINGS_CORRUPT');
  } finally {
    await context.close();
  }
});

test('private data files are written with 0600 and the directory with 0700', async () => {
  const root = makeRoot('settings-modes');
  const env = makeEnv(root);
  const context = await startTestService(env);
  try {
    await call(context.baseUrl, 'POST', '/settings', {
      body: {
        configFile: path.join(root, 'config.jsonc'),
        opencodeBin: 'opencode',
        modelCwd: root,
        opencodeConfigDir: '',
      },
    });
    const directoryMode = fs.statSync(env.OPENCHAMBER_SERVICE_DATA_DIR).mode & 0o777;
    const fileMode = fs.statSync(path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'settings.json')).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    await context.close();
  }
});

test('the data directory is mandatory, absolute and fail-closed', () => {
  assert.throws(() => createServiceServer({ env: { HOME: '/tmp/opencode' } }), /absolute/);
  assert.throws(() => createServiceServer({
    env: { HOME: '/tmp/opencode', OPENCHAMBER_SERVICE_DATA_DIR: 'relative/data' },
  }), /absolute/);
  assert.throws(() => createServiceServer({
    env: { HOME: '/tmp/opencode', OPENCHAMBER_SERVICE_DATA_DIR: '' },
  }), /absolute/);
});

test('a pre-created group-writable data directory is tightened, but parents are untouched', async () => {
  const root = makeRoot('data-modes');
  const env = makeEnv(root);
  const parent = path.join(root, 'parent');
  const dataDir = path.join(parent, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(parent, 0o755);
  fs.chmodSync(dataDir, 0o755);
  env.OPENCHAMBER_SERVICE_DATA_DIR = dataDir;
  const context = await startTestService(env);
  try {
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(parent).mode & 0o777, 0o755);
    const settings = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(settings.status, 200);
  } finally {
    await context.close();
  }
});

test('symlinked data directories and stores are rejected without following them', async () => {
  const root = makeRoot('data-symlink');
  const env = makeEnv(root);
  const realData = path.join(root, 'real-data');
  fs.mkdirSync(realData, { mode: 0o700 });
  const link = path.join(root, 'linked-data');
  fs.symlinkSync(realData, link);
  assert.throws(() => createServiceServer({ env: { ...env, OPENCHAMBER_SERVICE_DATA_DIR: link } }), /symlink/);

  fs.mkdirSync(env.OPENCHAMBER_SERVICE_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(env.OPENCHAMBER_SERVICE_DATA_DIR, 0o700);
  const target = path.join(root, 'outside-settings.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, generation: 'g', settings: null }));
  fs.symlinkSync(target, path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'settings.json'));
  const context = await startTestService(env);
  try {
    const health = await call(context.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    const settings = await call(context.baseUrl, 'GET', '/settings');
    assert.equal(settings.status, 500);
    assert.equal(settings.body.error.code, 'SETTINGS_CORRUPT');
  } finally {
    await context.close();
  }
});

test('partial or misshaped persisted settings records are corrupt, not defaults', async () => {
  const records = [
    {},
    { version: 1 },
    { version: 1, generation: 'g' },
    { version: 1, generation: '', settings: null },
    { version: 2, generation: 'g', settings: null },
    { version: 1, generation: 'g', settings: null, extra: true },
    { version: 1, generation: 'g', settings: { configFile: 'relative', opencodeBin: 'opencode', modelCwd: '/tmp', opencodeConfigDir: '' } },
  ];
  for (const [index, record] of records.entries()) {
    const root = makeRoot(`settings-record-${index}`);
    const env = makeEnv(root);
    fs.mkdirSync(env.OPENCHAMBER_SERVICE_DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(env.OPENCHAMBER_SERVICE_DATA_DIR, 0o700);
    fs.writeFileSync(path.join(env.OPENCHAMBER_SERVICE_DATA_DIR, 'settings.json'), JSON.stringify(record));
    const context = await startTestService(env);
    try {
      const health = await call(context.baseUrl, 'GET', '/health');
      assert.equal(health.status, 200, `record ${index} keeps health available`);
      const settings = await call(context.baseUrl, 'GET', '/settings');
      assert.equal(settings.status, 500, `record ${index}: ${JSON.stringify(record)}`);
      assert.equal(settings.body.error.code, 'SETTINGS_CORRUPT');
    } finally {
      await context.close();
    }
  }
});

test('startService requires a digit-only port string and a non-empty bearer', async () => {
  const root = makeRoot('port-validation');
  const env = makeEnv(root);
  await assert.rejects(() => startService({ env: { ...env, OPENCHAMBER_SERVICE_PORT: '' } }), /required/);
  await assert.rejects(() => startService({ env: { ...env, OPENCHAMBER_SERVICE_PORT: ' 80' } }), /required/);
  await assert.rejects(() => startService({ env: { ...env, OPENCHAMBER_SERVICE_PORT: '80x' } }), /required/);
  await assert.rejects(() => startService({ env: { ...env, OPENCHAMBER_SERVICE_PORT: '70000' } }), /required/);
  await assert.rejects(() => startService({ env: { ...env, OPENCHAMBER_SERVICE_TOKEN: '' } }), /required/);
});
