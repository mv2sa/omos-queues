import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { commitConfig } from '../../src/backend/commit.js';
import { ServiceError } from '../../src/backend/errors.js';
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
  waitFor,
} from './helpers.mjs';

async function fixture(name, options = {}) {
  const root = makeRoot(name);
  const env = makeEnv(root);
  standardConfig(root);
  const context = await startService(env, { logger: () => {}, ...options });
  const snapshot = await configSnapshot(context.baseUrl);
  const plain = snapshot.groups.find(group => group.name === 'plain');
  const preview = await previewChange(context.baseUrl,
    { path: plain.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, snapshot);
  assert.equal(preview.status, 200);
  return { root, env, snapshot, preview, configFile: settingsFor(env).configFile, ...context };
}

function temporaryFiles(directory) {
  return fs.readdirSync(directory).filter(name => name.includes('.ui-') && name.endsWith('.tmp'));
}

test('a source write failure leaves the config byte-identical and no temporary files', async () => {
  const context = await fixture('fault-write');
  const directory = path.dirname(context.configFile);
  try {
    fs.chmodSync(directory, 0o500);
    const commit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: context.preview.body.previewToken },
    });
    assert.equal(commit.status, 500);
    assert.equal(commit.body.error.code, 'COMMIT_FAILED');
    assert.doesNotMatch(commit.text, /\//, 'no raw filesystem detail is echoed');
    assert.equal(fs.readFileSync(context.configFile, 'utf8'), SAMPLE_CONFIG);
  } finally {
    fs.chmodSync(directory, 0o700);
    await context.close();
  }
  assert.deepEqual(temporaryFiles(directory), []);
});

test('a flush failure before rename keeps the old bytes and cleans up', async () => {
  const context = await fixture('fault-flush', {
    commitHooks: {
      flush: (descriptor, phase) => {
        if (phase === 'temporary') throw new Error('injected flush failure');
        fs.fsyncSync(descriptor);
      },
    },
  });
  try {
    const commit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: context.preview.body.previewToken },
    });
    assert.equal(commit.status, 500);
    assert.equal(commit.body.error.code, 'COMMIT_FAILED');
    assert.equal(fs.readFileSync(context.configFile, 'utf8'), SAMPLE_CONFIG);
    assert.equal(commit.body.backup, undefined, 'no incomplete backup is advertised');
  } finally {
    await context.close();
  }
  assert.deepEqual(temporaryFiles(path.dirname(context.configFile)), []);
});

test('a backup write failure changes nothing', async () => {
  const context = await fixture('fault-backup', {
    commitHooks: {
      flush: (descriptor, phase) => {
        if (phase === 'backup') throw new Error('injected backup failure');
        fs.fsyncSync(descriptor);
      },
    },
  });
  try {
    const commit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: context.preview.body.previewToken },
    });
    assert.equal(commit.status, 500);
    assert.equal(commit.body.error.code, 'COMMIT_FAILED');
    assert.match(commit.body.error.message, /backup/);
    assert.equal(fs.readFileSync(context.configFile, 'utf8'), SAMPLE_CONFIG);
  } finally {
    await context.close();
  }
});

test('a rename failure changes nothing and leaves no temporary file', async () => {
  const context = await fixture('fault-rename', {
    commitHooks: {
      rename: () => { throw new Error('injected rename failure'); },
    },
  });
  try {
    const commit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: context.preview.body.previewToken },
    });
    assert.equal(commit.status, 500);
    assert.equal(commit.body.error.code, 'COMMIT_FAILED');
    assert.equal(fs.readFileSync(context.configFile, 'utf8'), SAMPLE_CONFIG);
  } finally {
    await context.close();
  }
  assert.deepEqual(temporaryFiles(path.dirname(context.configFile)), []);
});

test('an edit that lands during save is detected before rename', async () => {
  const external = SAMPLE_CONFIG.replace('"plain": { "model": "openai/gpt-5" }',
    '"plain": { "model": "late/writer" }');
  const context = await fixture('fault-race', {
    commitHooks: {
      flush: (descriptor, phase) => {
        if (phase === 'temporary') fs.writeFileSync(context.configFile, external);
        fs.fsyncSync(descriptor);
      },
    },
  });
  try {
    const commit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: context.preview.body.previewToken },
    });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'BASE_HASH_MISMATCH');
    assert.equal(fs.readFileSync(context.configFile, 'utf8'), external);
    const after = await call(context.baseUrl, 'GET', '/config');
    assert.equal(after.status, 200);
    assert.match(after.body.groups.find(group => group.name === 'plain').models[0].id, /late\/writer/);
  } finally {
    await context.close();
  }
  assert.deepEqual(temporaryFiles(path.dirname(context.configFile)), []);
});

test('two accepted commits create distinct exclusive backups', async () => {
  const root = makeRoot('fault-backups');
  const env = makeEnv(root);
  standardConfig(root);
  const context = await startService(env, { logger: () => {} });
  try {
    const first = await configSnapshot(context.baseUrl);
    const plain = first.groups.find(group => group.name === 'plain');
    const firstPreview = await previewChange(context.baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-6', variant: '' }] }, first);
    const firstCommit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: firstPreview.body.previewToken },
    });
    assert.equal(firstCommit.status, 200);

    const second = await configSnapshot(context.baseUrl);
    const secondPreview = await previewChange(context.baseUrl,
      { path: plain.path, models: [{ id: 'openai/gpt-7', variant: '' }] }, second);
    const secondCommit = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: secondPreview.body.previewToken },
    });
    assert.equal(secondCommit.status, 200);

    assert.notEqual(secondCommit.body.backup, firstCommit.body.backup);
    assert.equal(fs.readFileSync(firstCommit.body.backup, 'utf8'), SAMPLE_CONFIG);
    assert.match(fs.readFileSync(secondCommit.body.backup, 'utf8'), /openai\/gpt-6/);
  } finally {
    await context.close();
  }
});

test('a lost commit acknowledgement reconciles and revokes a late token', async () => {
  const context = await fixture('lost-ack');
  try {
    const body = JSON.stringify({ previewToken: context.preview.body.previewToken });
    const address = new URL(context.baseUrl);
    await new Promise(resolve => {
      const request = http.request({
        host: address.hostname,
        port: address.port,
        path: '/commit',
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      request.on('error', () => resolve());
      request.on('response', response => { response.resume(); resolve(); });
      request.end(body);
      // Drop the answer: the page never learns whether the write landed.
      request.on('socket', socket => {
        socket.once('connect', () => {
          setTimeout(() => { request.destroy(); resolve(); }, 50);
        });
      });
    });

    const changed = await waitFor(() => fs.readFileSync(context.configFile, 'utf8') !== SAMPLE_CONFIG,
      { label: 'lost commit write', timeout: 5000 });
    assert.equal(changed, true);
    const after = await configSnapshot(context.baseUrl);
    assert.notEqual(after.baseHash, context.snapshot.baseHash);

    const reconciled = await call(context.baseUrl, 'POST', '/reconcile', {
      body: { previewToken: context.preview.body.previewToken, generation: after.target.generation },
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.baseHash, after.baseHash);

    const late = await call(context.baseUrl, 'POST', '/commit', {
      body: { previewToken: context.preview.body.previewToken },
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'PREVIEW_INVALID');
  } finally {
    await context.close();
  }
});

function backupFiles(directory) {
  return fs.readdirSync(directory).filter(name => name.includes('.bak.pre-ui-'));
}

test('the source guard runs before the backup and again immediately before replacement', () => {
  const root = makeRoot('guard-order');
  const target = path.join(root, 'config.jsonc');
  const before = '{"agents":{"a":{"model":"openai/gpt-5"}}}\n';
  const after = '{"agents":{"a":{"model":"openai/gpt-6"}}}\n';
  fs.writeFileSync(target, before);
  const record = { token: 'preview-token', marketplaceBinding: { sourceGeneration: 'g', catalogFingerprint: 'f' } };
  const calls = [];
  const result = commitConfig({
    targetPath: target,
    before,
    after,
    preview: record,
    hooks: {
      validatePreview: (preview) => {
        calls.push({
          preview,
          backups: backupFiles(root).length,
          temporary: temporaryFiles(root).length,
          current: fs.readFileSync(target, 'utf8'),
        });
      },
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].preview, record);
  assert.equal(calls[0].backups, 0);
  assert.equal(calls[0].temporary, 0);
  assert.equal(calls[1].preview, record);
  assert.equal(calls[1].backups, 1);
  assert.equal(calls[1].temporary, 1);
  assert.equal(calls[1].current, before);
  assert.equal(fs.readFileSync(target, 'utf8'), after);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
  assert.deepEqual(temporaryFiles(root), []);
});

test('a pre-backup guard failure writes nothing and creates no backup', () => {
  const root = makeRoot('guard-pre');
  const target = path.join(root, 'config.jsonc');
  const before = '{"agents":{"a":{"model":"openai/gpt-5"}}}\n';
  const after = '{"agents":{"a":{"model":"openai/gpt-6"}}}\n';
  fs.writeFileSync(target, before);
  assert.throws(() => commitConfig({
    targetPath: target,
    before,
    after,
    preview: { token: 'preview-token' },
    hooks: {
      validatePreview: () => {
        throw new ServiceError(409, 'MARKETPLACE_SOURCE_CHANGED',
          'The marketplace source changed. Nothing was written.');
      },
    },
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'MARKETPLACE_SOURCE_CHANGED');
    return true;
  });
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.deepEqual(backupFiles(root), []);
  assert.deepEqual(temporaryFiles(root), []);
});

test('a late guard failure keeps the target and a truthful backup', () => {
  const root = makeRoot('guard-late');
  const target = path.join(root, 'config.jsonc');
  const before = '{"agents":{"a":{"model":"openai/gpt-5"}}}\n';
  const after = '{"agents":{"a":{"model":"openai/gpt-6"}}}\n';
  fs.writeFileSync(target, before);
  let calls = 0;
  assert.throws(() => commitConfig({
    targetPath: target,
    before,
    after,
    preview: { token: 'preview-token' },
    hooks: {
      validatePreview: () => {
        calls += 1;
        if (calls === 2) {
          throw new ServiceError(409, 'MARKETPLACE_CATALOG_CHANGED',
            'The installed marketplace catalog changed. Nothing was written.');
        }
      },
    },
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'MARKETPLACE_CATALOG_CHANGED');
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  const backups = backupFiles(root);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]), 'utf8'), before);
  assert.deepEqual(temporaryFiles(root), []);
});

test('an external write during the late source guard is not overwritten', () => {
  const root = makeRoot('guard-race');
  const target = path.join(root, 'config.jsonc');
  const before = '{"agents":{"a":{"model":"openai/gpt-5"}}}\n';
  const after = '{"agents":{"a":{"model":"openai/gpt-6"}}}\n';
  const external = '{"agents":{"a":{"model":"external/writer"}}}\n';
  fs.writeFileSync(target, before);
  let calls = 0;
  let renames = 0;
  assert.throws(() => commitConfig({
    targetPath: target,
    before,
    after,
    preview: { token: 'preview-token' },
    hooks: {
      validatePreview: () => {
        calls += 1;
        if (calls === 2) fs.writeFileSync(target, external);
      },
      rename: () => { renames += 1; },
    },
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'BASE_HASH_MISMATCH');
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(renames, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), external);
  const backups = backupFiles(root);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]), 'utf8'), before);
  assert.deepEqual(temporaryFiles(root), []);
});

test('an ordinary commit without a bound preview keeps the default no-op guard', () => {
  const root = makeRoot('guard-default');
  const target = path.join(root, 'config.jsonc');
  const before = '{"agents":{"a":{"model":"openai/gpt-5"}}}\n';
  const after = '{"agents":{"a":{"model":"openai/gpt-6"}}}\n';
  fs.writeFileSync(target, before);
  const result = commitConfig({ targetPath: target, before, after });
  assert.equal(fs.readFileSync(target, 'utf8'), after);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
  assert.deepEqual(temporaryFiles(root), []);
});
