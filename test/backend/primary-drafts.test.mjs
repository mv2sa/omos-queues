import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDraftStore } from '../../src/backend/drafts.js';
import { writeJsonStore } from '../../src/backend/store.js';

const TARGET = '/synthetic/config.jsonc';
const HASH = 'a'.repeat(64);
const MODELS = [{ id: 'openai/gpt-6', variant: '' }];
function dir(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-drafts-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
function input(overrides = {}) {
  return { version: 3, targetPath: TARGET, baseHash: HASH, revision: 1,
    originals: [], changes: [], marketplace: null,
    primaryCreations: [{ preset: 'coding', agent: 'orchestrator', models: MODELS }], ...overrides };
}
function caught(fn) { try { fn(); return null; } catch (error) { return error; } }

test('v3 primary draft create, replace, reopen, list and delete', t => {
  const dataDir = dir(t);
  const store = createDraftStore({ dataDir });
  const first = store.save(input(), { targetPath: TARGET }).draft;
  assert.equal(first.version, 3);
  assert.deepEqual(first.primaryCreations, input().primaryCreations);
  const replaced = store.save(input({ id: first.id, revision: 2 }), { targetPath: TARGET }).draft;
  assert.equal(replaced.revision, 2);
  const reopened = createDraftStore({ dataDir });
  assert.deepEqual(reopened.list().drafts, [replaced]);
  assert.deepEqual(reopened.remove(first.id), { ok: true, id: first.id });
  assert.deepEqual(reopened.list(), { drafts: [] });
});

test('v3 mixed recovery persists primary, ordinary and marketplace operation projections', t => {
  const dataDir = dir(t);
  const marketplace = {
    sourceGeneration: 'gen-1', catalogFingerprint: 'fp-1',
    edits: [{ preset: 'coding', packageIds: ['acme/janitor'], creations: [] }],
    originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
    identities: [{ id: 'acme/janitor', version: '1.2.3', agentName: 'janitor', digest: 'b'.repeat(64) }],
  };
  const file = path.join(dataDir, 'drafts-v2.json');
  writeJsonStore(file, { version: 2, drafts: [{
    ...input({ changes: [{ path: ['agents', 'worker', 'model'], models: MODELS }], marketplace }),
    id: '22222222-2222-4222-8222-222222222222',
    updatedAt: new Date().toISOString(),
  }] });
  const store = createDraftStore({ dataDir });
  const draft = store.list().drafts[0];
  assert.equal(draft.version, 3);
  assert.equal(draft.changes[0].path[1], 'worker');
  assert.deepEqual(draft.primaryCreations[0], input().primaryCreations[0]);
  assert.deepEqual(draft.marketplace, marketplace);
});

test('primary creation rejects Build, extras, unsafe/duplicate presets, invalid models and overlap', t => {
  const store = createDraftStore({ dataDir: dir(t) });
  const invalid = [
    [{ preset: 'coding', agent: 'build', models: MODELS }],
    [{ preset: '__proto__', agent: 'orchestrator', models: MODELS }],
    [{ preset: 'coding', agent: 'orchestrator', models: MODELS, path: ['x'] }],
    [{ preset: 'coding', agent: 'orchestrator', models: MODELS }, { preset: 'coding', agent: 'orchestrator', models: MODELS }],
    [{ preset: 'coding', agent: 'orchestrator', models: [] }],
  ];
  for (const primaryCreations of invalid) {
    assert.equal(caught(() => store.save(input({ primaryCreations }), { targetPath: TARGET }))?.code, 'INVALID_DRAFT');
  }
  assert.equal(caught(() => store.save(input({
    changes: [{ path: ['presets', 'coding', 'orchestrator', 'model'], models: MODELS }],
  }), { targetPath: TARGET }))?.code, 'INVALID_DRAFT');
  assert.equal(caught(() => store.save(input({
    changes: [{ path: ['presets', 'coding', 'agents', 'orchestrator', 'model'], models: MODELS }],
  }), { targetPath: TARGET }))?.code, 'INVALID_DRAFT');
  const buildPreset = store.save(input({ primaryCreations: [{
    preset: 'build', agent: 'orchestrator', models: MODELS,
  }] }), { targetPath: TARGET }).draft;
  assert.equal(buildPreset.primaryCreations[0].preset, 'build');
});

test('v3 may retain zero primary creations after promotion; downgrade and unknowns stay protected/private', t => {
  const dataDir = dir(t);
  const store = createDraftStore({ dataDir });
  const created = store.save(input(), { targetPath: TARGET }).draft;
  assert.equal(store.save(input({ id: created.id, revision: 2, primaryCreations: [],
    changes: [{ path: ['agents', 'worker', 'model'], models: MODELS }] }), { targetPath: TARGET }).draft.version, 3);
  assert.equal(caught(() => store.save({ ...input(), version: 2, id: created.id,
    marketplace: null, changes: [{ path: ['agents', 'worker', 'model'], models: MODELS }] },
  { targetPath: TARGET }))?.code, 'DRAFT_VERSION_CONFLICT');

  const unknown = { id: '11111111-1111-4111-8111-111111111111', version: 4, targetPath: TARGET,
    baseHash: HASH, updatedAt: new Date().toISOString(), secret: 'private-canary' };
  const file = path.join(dataDir, 'drafts-v2.json');
  writeJsonStore(file, { version: 2, drafts: [unknown] });
  const reopened = createDraftStore({ dataDir });
  const listed = reopened.list().drafts[0];
  assert.equal(listed.version, 4);
  assert.equal(JSON.stringify(listed).includes('private-canary'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).drafts[0], unknown);
  assert.equal(caught(() => reopened.remove(unknown.id))?.code, 'DRAFT_UNSUPPORTED_VERSION');
  const legacy = { id: '33333333-3333-4333-8333-333333333333', version: 3,
    targetPath: TARGET, baseHash: HASH, updatedAt: new Date().toISOString(),
    rawMetadata: { secret: 'legacy-canary' } };
  const legacyStore = createDraftStore({ dataDir: path.join(dataDir, 'legacy-v3') });
  writeJsonStore(path.join(dataDir, 'legacy-v3', 'drafts-v2.json'), { version: 2, drafts: [legacy] });
  const legacyListed = legacyStore.list().drafts[0];
  assert.equal(legacyListed.version, 3);
  assert.equal(JSON.stringify(legacyListed).includes('legacy-canary'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'legacy-v3', 'drafts-v2.json'), 'utf8')).drafts[0], legacy);
  assert.equal(caught(() => legacyStore.remove(legacy.id))?.code, 'DRAFT_UNSUPPORTED_VERSION');
});

test('extra fields on stored v3 are withheld as unknown and retained unchanged', t => {
  const dataDir = dir(t);
  const base = input({ id: '44444444-4444-4444-8444-444444444444' });
  base.updatedAt = new Date().toISOString();
  base.privateOuter = 'outer-secret';
  base.primaryCreations[0].privateNested = 'nested-secret';
  writeJsonStore(path.join(dataDir, 'drafts-v2.json'), { version: 2, drafts: [base] });
  const store = createDraftStore({ dataDir });
  const listed = store.list().drafts[0];
  assert.equal(listed.version, 3);
  assert.equal(JSON.stringify(listed).includes('secret'), false);
  assert.equal(caught(() => store.remove(base.id))?.code, 'DRAFT_UNSUPPORTED_VERSION');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'drafts-v2.json'), 'utf8')).drafts[0], base);
});
