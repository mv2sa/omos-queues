import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { call, makeEnv, makeRoot, settingsFor, startService } from './helpers.mjs';

async function bounded(promise, message, milliseconds = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, { ignoreTerm = false } = {}) {
  const root = makeRoot('child-settlement');
  const env = makeEnv(root);
  const records = [];
  let context;
  t.after(async () => {
    // Cleanup is registered before any spawn and never trusts kill() as exit.
    for (const record of records) if (!record.closed) record.child.kill('SIGKILL');
    await bounded(Promise.all(records.map(record => record.done)), 'Owned test child did not close');
    await context?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `
    process.on('SIGTERM', () => {
      process.stdout.write('TERM\\n');
      ${ignoreTerm ? '' : "setTimeout(() => { process.stdout.write('synthetic/late\\n'); process.exit(0); }, 100);"}
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  context = await startService(env, { logger: () => {},
    execFileImpl(_binary, _args, options, callback) {
      const record = { closed: false, callbackObserved: false };
      let readyResolve;
      let readyReject;
      let termResolve;
      record.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      record.term = new Promise(resolve => { termResolve = resolve; });
      record.child = execFile(process.execPath, ['-e', script], options, (...args) => {
        record.callbackObserved = true;
        callback(...args);
      });
      record.done = new Promise(resolve => record.child.once('close', () => {
        record.closed = true;
        readyReject(new Error('Child closed before readiness'));
        resolve();
      }));
      record.child.stdout.on('data', chunk => {
        if (String(chunk).includes('READY')) readyResolve();
        if (String(chunk).includes('TERM')) termResolve();
      });
      records.push(record);
      return record.child;
    },
  });
  const begin = async () => {
    const response = await call(context.baseUrl, 'GET', '/models');
    assert.equal(response.status, 200);
    const record = records.at(-1);
    assert.ok(record, 'catalog spawned a synthetic child');
    await bounded(record.ready, 'Synthetic child did not become ready');
    return record;
  };
  return { root, env, context, records, begin };
}

test('shutdown awaits the real graceful child callback and close', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const child = await f.begin();
  let settled = false;
  const closing = f.context.service.close().then(() => { settled = true; });
  await bounded(child.term, 'Child did not receive SIGTERM');
  assert.equal(settled, false, 'HTTP close must not abandon the still-running child');
  await bounded(closing, 'Service did not finish graceful shutdown');
  assert.equal(child.callbackObserved, true);
  assert.equal(child.closed, true);
  assert.equal(child.child.exitCode, 0);
  assert.equal(child.child.signalCode, null);
  assert.equal(fs.existsSync(path.join(f.env.OPENCHAMBER_SERVICE_DATA_DIR, 'models.json')), false);
});

test('shutdown escalates an ignored SIGTERM and awaits actual exit', { timeout: 8000 }, async t => {
  const f = await fixture(t, { ignoreTerm: true });
  const child = await f.begin();
  const closing = f.context.service.close();
  assert.equal(f.context.service.close(), closing, 'repeated close shares ownership');
  await bounded(closing, 'Service abandoned or failed to terminate its child');
  assert.equal(child.callbackObserved, true);
  assert.equal(child.closed, true);
  assert.equal(child.child.signalCode, 'SIGKILL');
  assert.equal(f.context.service.server.listening, false);
});

test('shutdown settles obsolete and current children without publishing late results', { timeout: 8000 }, async t => {
  const f = await fixture(t, { ignoreTerm: true });
  await f.begin();
  assert.equal((await call(f.context.baseUrl, 'POST', '/settings', { body: settingsFor(f.env) })).status, 200);
  await f.begin();
  assert.equal(f.records.length, 2);
  await bounded(f.context.service.close(), 'Obsolete and current jobs did not settle');
  assert.equal(f.records.every(record => record.closed && record.callbackObserved), true);
  assert.equal(f.records.every(record => record.child.signalCode === 'SIGKILL'), true);
  assert.equal(f.records.length, 2, 'shutdown cannot start another attempt');
  assert.equal(fs.existsSync(path.join(f.env.OPENCHAMBER_SERVICE_DATA_DIR, 'models.json')), false);
});
