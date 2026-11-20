import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_DRAFTS,
  createDraftStore,
} from '../../src/backend/drafts.js';
import { writeJsonStore } from '../../src/backend/store.js';

const TARGET = '/tmp/opencode/marketplace-draft-target.jsonc';
const OTHER_TARGET = '/tmp/opencode/marketplace-draft-other.jsonc';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function dataDir(name) {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  return fs.mkdtempSync(path.join('/tmp/opencode', `drafts-${name}-`));
}

function v1Input(overrides = {}) {
  return {
    targetPath: TARGET,
    baseHash: HASH,
    originals: [{
      path: ['agents', 'x', 'model'],
      models: [{ id: 'openai/gpt-5', variant: '' }],
    }],
    changes: [{
      path: ['agents', 'x', 'model'],
      models: [{ id: 'openai/gpt-6', variant: '' }],
    }],
    ...overrides,
  };
}

function marketplaceInput(overrides = {}) {
  return {
    sourceGeneration: 'gen-1',
    catalogFingerprint: 'fp-1',
    edits: [{
      preset: 'coding',
      packageIds: ['acme/janitor'],
      creations: [{
        packageId: 'acme/janitor',
        models: [{ id: 'openai/gpt-6', variant: 'high' }],
      }],
    }],
    originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
    identities: [{
      id: 'acme/janitor',
      version: '1.2.3',
      agentName: 'janitor',
      digest: DIGEST,
    }],
    ...overrides,
  };
}

function v2Input(overrides = {}) {
  return {
    targetPath: TARGET,
    baseHash: HASH,
    version: 2,
    revision: 1,
    originals: [],
    changes: [],
    marketplace: marketplaceInput(),
    ...overrides,
  };
}

function errorOf(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

test('v1 drafts stay in drafts.json and keep the legacy list/save/remove shape', () => {
  const dir = dataDir('v1');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  assert.deepEqual(store.list(), { drafts: [] });
  const saved = store.save(v1Input(), { targetPath: TARGET });
  assert.match(saved.draft.id, /^[0-9a-f-]{36}$/u);
  assert.equal(saved.draft.targetPath, TARGET);
  assert.deepEqual(store.list().drafts, [saved.draft]);
  assert.equal(fs.existsSync(path.join(dir, 'drafts.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'drafts-v2.json')), false);
  assert.equal(store.remove(saved.draft.id).ok, true);
  assert.deepEqual(store.list(), { drafts: [] });
  assert.throws(() => store.remove(saved.draft.id), error => error.code === 'DRAFT_NOT_FOUND');
});

test('v2 is stored separately and overlays the same UUID without rewriting v1', () => {
  const dir = dataDir('overlay');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const v1 = store.save(v1Input(), { targetPath: TARGET });
  const v1Bytes = fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8');

  const v2 = store.save(v2Input({ id: v1.draft.id }), { targetPath: TARGET });
  assert.equal(v2.draft.version, 2);
  assert.equal(v2.draft.id, v1.draft.id);
  const listed = store.list().drafts;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].version, 2);
  assert.equal(listed[0].revision, 1);
  assert.deepEqual(listed[0].marketplace, marketplaceInput());

  assert.equal(fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8'), v1Bytes);
  const v2File = JSON.parse(fs.readFileSync(path.join(dir, 'drafts-v2.json'), 'utf8'));
  assert.equal(v2File.version, 2);
  assert.equal(v2File.drafts.length, 1);
  assert.equal(v2File.drafts[0].id, v1.draft.id);
});

test('a promoted frame continues v2 even when marketplace edits become empty', () => {
  const dir = dataDir('promoted');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const v1 = store.save(v1Input(), { targetPath: TARGET });
  store.save(v2Input({ id: v1.draft.id, revision: 1 }), { targetPath: TARGET });
  const promoted = store.save(v2Input({
    id: v1.draft.id,
    revision: 2,
    marketplace: null,
    changes: v1Input().changes,
  }), { targetPath: TARGET });
  assert.equal(promoted.draft.version, 2);
  assert.equal(promoted.draft.marketplace, null);
  assert.equal(store.list().drafts[0].version, 2);
  assert.equal(store.list().drafts[0].marketplace, null);
});

test('v2 accepts marketplace-only drafts and refuses empty or malformed ones', () => {
  const dir = dataDir('validation');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const saved = store.save(v2Input(), { targetPath: TARGET });
  assert.deepEqual(saved.draft.changes, []);
  assert.equal(saved.draft.marketplace.edits.length, 1);

  const cases = [
    { changes: [], marketplace: null },
    { marketplace: marketplaceInput({ edits: [] }) },
    { marketplace: { ...marketplaceInput(), extra: true } },
    { marketplace: marketplaceInput({
      edits: [{
        preset: 'coding',
        packageIds: [],
        creations: [{
          packageId: 'acme/janitor',
          models: [{ id: 'openai/gpt-6', variant: '' }],
        }],
      }],
    }) },
    { marketplace: marketplaceInput({
      identities: [{ id: 'acme/janitor', version: '1.2.3', agentName: 'janitor', digest: 'not-hex' }],
    }) },
    { marketplace: marketplaceInput({
      originals: [{ preset: 'other', selectionPresent: false, packageIds: [] }],
    }) },
    { marketplace: marketplaceInput({
      originals: [{ preset: 'coding', selectionPresent: false, packageIds: ['acme/janitor'] }],
    }) },
    { revision: -1 },
    { revision: 1.5 },
    { version: 3 },
  ];
  for (const overrides of cases) {
    assert.equal(
      errorOf(() => store.save(v2Input(overrides), { targetPath: TARGET })).code,
      'INVALID_DRAFT',
      JSON.stringify(overrides),
    );
  }
  assert.equal(store.list().drafts.length, 1);
});

test('revision guards reject stale saves but allow an idempotent retry', () => {
  const dir = dataDir('revision');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const first = store.save(v2Input({ revision: 2 }), { targetPath: TARGET });
  const id = first.draft.id;
  assert.equal(
    errorOf(() => store.save(v2Input({ id, revision: 1 }), { targetPath: TARGET })).code,
    'DRAFT_REVISION_STALE',
  );
  assert.equal(store.save(v2Input({ id, revision: 2 }), { targetPath: TARGET }).draft.revision, 2);
  assert.equal(store.save(v2Input({ id, revision: 3 }), { targetPath: TARGET }).draft.revision, 3);
  assert.equal(store.list().drafts[0].revision, 3);
});

const READ_ONLY_REASON = 'This draft was saved by a newer extension version and is read-only.';

function unknownDraft(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    version: 4,
    targetPath: TARGET,
    baseHash: HASH,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('unknown v2 records expose only an allowlisted inspect header and stay on disk unchanged', () => {
  const dir = dataDir('unknown');
  const canary = 'DRAFT-CANARY-private-value';
  const unknown = unknownDraft({
    futureField: 'keep-me',
    rawConfig: { privatePrompt: canary, credentials: { token: canary } },
    marketplace: { secret: canary },
  });
  const malformed = unknownDraft({
    id: '22222222-2222-4222-8222-222222222222',
    version: 99,
    targetPath: 42,
    baseHash: 'not-a-digest',
    updatedAt: canary,
    futureField: canary,
  });
  const fileV2 = path.join(dir, 'drafts-v2.json');
  writeJsonStore(fileV2, { version: 2, drafts: [unknown, malformed] });
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });

  const listed = store.list().drafts;
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[0], {
    id: unknown.id,
    version: 4,
    targetPath: TARGET,
    baseHash: HASH,
    updatedAt: '2026-01-01T00:00:00.000Z',
    readOnlyReason: READ_ONLY_REASON,
  });
  assert.deepEqual(listed[1], {
    id: malformed.id,
    version: 99,
    readOnlyReason: READ_ONLY_REASON,
  });
  const serialized = JSON.stringify(listed);
  assert.doesNotMatch(serialized, new RegExp(canary));
  for (const field of ['futureField', 'rawConfig', 'marketplace', 'credentials']) {
    assert.equal(serialized.includes(`"${field}"`), false, field);
  }

  assert.equal(
    errorOf(() => store.save(v2Input({ id: unknown.id }), { targetPath: TARGET })).code,
    'DRAFT_UNSUPPORTED_VERSION',
  );
  assert.equal(errorOf(() => store.remove(unknown.id)).code, 'DRAFT_UNSUPPORTED_VERSION');
  assert.equal(errorOf(() => store.remove(malformed.id)).code, 'DRAFT_UNSUPPORTED_VERSION');

  const created = store.save(v2Input(), { targetPath: TARGET });
  assert.equal(store.list().drafts.length, 3);
  const stored = JSON.parse(fs.readFileSync(fileV2, 'utf8'));
  assert.deepEqual(stored.drafts.find(draft => draft.id === unknown.id), unknown);
  assert.deepEqual(stored.drafts.find(draft => draft.id === malformed.id), malformed);

  const reopened = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  assert.equal(reopened.list().drafts.length, 3);
  assert.equal(JSON.stringify(reopened.list().drafts).includes(canary), false);
  assert.deepEqual(reopened.list().drafts[0], listed[0]);

  reopened.remove(created.draft.id);
  const afterDelete = JSON.parse(fs.readFileSync(fileV2, 'utf8'));
  assert.equal(afterDelete.drafts.length, 2);
  assert.deepEqual(afterDelete.drafts.find(draft => draft.id === unknown.id), unknown);
  assert.deepEqual(afterDelete.drafts.find(draft => draft.id === malformed.id), malformed);
});

test('a future draft envelope refuses reads and mutations without touching stored bytes', () => {
  const dir = dataDir('envelope');
  const canary = 'ENVELOPE-CANARY-private';
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const v1 = store.save(v1Input(), { targetPath: TARGET });
  const fileV1 = path.join(dir, 'drafts.json');
  const v1Bytes = fs.readFileSync(fileV1);
  const fileV2 = path.join(dir, 'drafts-v2.json');
  writeJsonStore(fileV2, { version: 3, drafts: [], futureMetadata: { secret: canary } });
  const v2Bytes = fs.readFileSync(fileV2);
  const reopened = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });

  const operations = [
    () => reopened.list(),
    () => reopened.save(v1Input(), { targetPath: TARGET }),
    () => reopened.save(v2Input(), { targetPath: TARGET }),
    () => reopened.remove(v1.draft.id),
  ];
  for (const operation of operations) {
    const error = errorOf(operation);
    assert.equal(error?.code, 'DRAFT_UNSUPPORTED_ENVELOPE');
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, new RegExp(canary));
    assert.deepEqual(fs.readFileSync(fileV1), v1Bytes);
    assert.deepEqual(fs.readFileSync(fileV2), v2Bytes);
  }
});

test('v1 save cannot replace a promoted v2 frame', () => {
  const dir = dataDir('downgrade');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const v1 = store.save(v1Input(), { targetPath: TARGET });
  store.save(v2Input({ id: v1.draft.id }), { targetPath: TARGET });
  assert.equal(
    errorOf(() => store.save(v1Input({ id: v1.draft.id }), { targetPath: TARGET })).code,
    'DRAFT_VERSION_CONFLICT',
  );
});

test('the draft count is shared across v1 and v2 and overlays count once', () => {
  const dir = dataDir('count');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const ids = [];
  for (let index = 0; index < MAX_DRAFTS - 1; index += 1) {
    ids.push(store.save(v1Input(), { targetPath: TARGET }).draft.id);
  }
  store.save(v2Input({ id: ids[0] }), { targetPath: TARGET });
  assert.equal(store.list().drafts.length, MAX_DRAFTS - 1);
  store.save(v1Input(), { targetPath: TARGET });
  assert.equal(store.list().drafts.length, MAX_DRAFTS);
  assert.equal(
    errorOf(() => store.save(v1Input(), { targetPath: TARGET })).code,
    'DRAFT_LIMIT',
  );
  assert.equal(
    errorOf(() => store.save(v2Input(), { targetPath: TARGET })).code,
    'DRAFT_LIMIT',
  );
});

test('promoting an existing v1 UUID at exactly the draft limit keeps one merged frame', () => {
  const dir = dataDir('promote-limit');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const ids = [];
  for (let index = 0; index < MAX_DRAFTS; index += 1) {
    ids.push(store.save(v1Input(), { targetPath: TARGET }).draft.id);
  }
  assert.equal(store.list().drafts.length, MAX_DRAFTS);
  const fileV1 = path.join(dir, 'drafts.json');
  const v1Bytes = fs.readFileSync(fileV1);

  const promoted = store.save(v2Input({ id: ids[0], revision: 1 }), { targetPath: TARGET });
  assert.equal(promoted.draft.id, ids[0]);
  assert.deepEqual(fs.readFileSync(fileV1), v1Bytes);
  const merged = store.list().drafts;
  assert.equal(merged.length, MAX_DRAFTS);
  assert.equal(merged.filter(draft => draft.id === ids[0]).length, 1);
  assert.equal(merged.find(draft => draft.id === ids[0]).version, 2);

  const reopened = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  assert.equal(reopened.list().drafts.length, MAX_DRAFTS);
  assert.equal(reopened.list().drafts.find(draft => draft.id === ids[0]).version, 2);

  assert.equal(
    errorOf(() => store.save(v2Input(), { targetPath: TARGET })).code,
    'DRAFT_LIMIT',
  );
  assert.equal(
    errorOf(() => store.save(v1Input(), { targetPath: TARGET })).code,
    'DRAFT_LIMIT',
  );
  assert.equal(store.list().drafts.length, MAX_DRAFTS);
});

test('record size and total physical budget are shared bounds', () => {
  const dir = dataDir('size');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const longId = `openai/${'x'.repeat(480)}`;
  const largeChanges = Array.from({ length: 300 }, () => ({
    path: ['agents', 'x', 'model'],
    models: [{ id: longId, variant: '' }],
  }));
  assert.equal(
    errorOf(() => store.save(v2Input({ changes: largeChanges, marketplace: null }), {
      targetPath: TARGET,
    })).code,
    'DRAFT_TOO_LARGE',
  );

  const budgetChanges = Array.from({ length: 25 }, () => ({
    path: ['agents', 'x', 'model'],
    models: [{ id: longId, variant: '' }],
  }));
  let budgetError = null;
  for (let index = 0; index < MAX_DRAFTS; index += 1) {
    try {
      store.save(v2Input({ changes: budgetChanges, marketplace: null }), { targetPath: TARGET });
    } catch (error) {
      budgetError = error;
      break;
    }
  }
  assert.equal(budgetError?.code, 'DRAFT_LIMIT');
  assert.match(budgetError.message, /512 KiB/);
});

test('partial deletion removes the legacy copy first and reports honestly', () => {
  const dir = dataDir('partial');
  let failV2 = false;
  const store = createDraftStore({
    dataDir: dir,
    now: () => 1_700_000_000_000,
    hooks: {
      writeV2: (value) => {
        if (failV2) throw new Error('injected v2 write failure');
        writeJsonStore(path.join(dir, 'drafts-v2.json'), value);
      },
    },
  });
  const v1 = store.save(v1Input(), { targetPath: TARGET });
  store.save(v2Input({ id: v1.draft.id }), { targetPath: TARGET });

  failV2 = true;
  assert.equal(errorOf(() => store.remove(v1.draft.id)).code, 'DRAFT_PARTIAL_DELETE');
  const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8'));
  assert.deepEqual(legacy.drafts, []);
  const current = JSON.parse(fs.readFileSync(path.join(dir, 'drafts-v2.json'), 'utf8'));
  assert.equal(current.drafts.length, 1);
  const listed = store.list().drafts;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].version, 2);

  failV2 = false;
  assert.equal(store.remove(v1.draft.id).ok, true);
  assert.deepEqual(store.list(), { drafts: [] });

  const onlyV2 = store.save(v2Input(), { targetPath: TARGET });
  failV2 = true;
  assert.equal(errorOf(() => store.remove(onlyV2.draft.id)).code, 'DRAFT_STORAGE');
  assert.equal(store.list().drafts.length, 1);
});

test('a corrupt v2 store refuses reads and mutations instead of dropping records', () => {
  const dir = dataDir('corrupt');
  fs.writeFileSync(path.join(dir, 'drafts-v2.json'), '{not json');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  assert.equal(errorOf(() => store.list()).code, 'DRAFTS_CORRUPT');
  assert.equal(
    errorOf(() => store.save(v1Input(), { targetPath: TARGET })).code,
    'DRAFTS_CORRUPT',
  );
  assert.equal(errorOf(() => store.remove('11111111-1111-4111-8111-111111111111')).code,
    'DRAFTS_CORRUPT');
});

test('independent frames never merge and target changes are refused', () => {
  const dir = dataDir('frames');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const first = store.save(v1Input(), { targetPath: TARGET });
  const second = store.save(v1Input({
    changes: [{
      path: ['agents', 'y', 'model'],
      models: [{ id: 'openai/gpt-7', variant: '' }],
    }],
  }), { targetPath: TARGET });
  assert.equal(store.list().drafts.length, 2);
  assert.equal(
    errorOf(() => store.save(v1Input({ targetPath: OTHER_TARGET }), { targetPath: TARGET })).code,
    'TARGET_CHANGED',
  );
  assert.equal(
    errorOf(() => store.save(v2Input({ targetPath: OTHER_TARGET }), { targetPath: TARGET })).code,
    'TARGET_CHANGED',
  );
  assert.notEqual(first.draft.id, second.draft.id);
});

test('canonical 129 package ids persist and reopen; 130 and new opaque selections are refused', () => {
  const longId = `${'a'.repeat(64)}/${'b'.repeat(64)}`;
  const tooLongId = `${'a'.repeat(64)}/${'b'.repeat(65)}`;
  const opaque = 'x'.repeat(500);
  const models = [{ id: 'openai/gpt-6', variant: '' }];
  const dir = dataDir('long-id');
  const store = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });

  const saved = store.save(v2Input({
    marketplace: marketplaceInput({
      edits: [{
        preset: 'coding',
        packageIds: [longId],
        creations: [{ packageId: longId, models }],
      }],
      originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
      identities: [{ id: longId, version: '1.0.0', agentName: 'long129', digest: DIGEST }],
    }),
  }), { targetPath: TARGET });
  assert.deepEqual(saved.draft.marketplace.edits[0].packageIds, [longId]);
  assert.equal(saved.draft.marketplace.edits[0].creations[0].packageId, longId);
  assert.equal(saved.draft.marketplace.identities[0].id, longId);

  const reopened = createDraftStore({ dataDir: dir, now: () => 1_700_000_000_000 });
  const listed = reopened.list().drafts;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].marketplace.edits[0].packageIds, [longId]);
  assert.equal(listed[0].marketplace.identities[0].id, longId);

  const badCases = [
    {
      edits: [{ preset: 'coding', packageIds: [tooLongId], creations: [] }],
      originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
      identities: [],
    },
    {
      edits: [{
        preset: 'coding',
        packageIds: [longId, tooLongId],
        creations: [{ packageId: longId, models }],
      }],
      originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
      identities: [],
    },
    {
      edits: [{
        preset: 'coding',
        packageIds: [longId],
        creations: [{ packageId: longId, models }],
      }],
      originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
      identities: [{ id: tooLongId, version: '1.0.0', agentName: 'long130', digest: DIGEST }],
    },
    {
      edits: [{
        preset: 'coding',
        packageIds: [tooLongId, longId],
        creations: [{ packageId: tooLongId, models }],
      }],
      originals: [{ preset: 'coding', selectionPresent: true, packageIds: [tooLongId] }],
      identities: [],
    },
  ];
  for (const marketplace of badCases) {
    assert.equal(
      errorOf(() => store.save(v2Input({ marketplace: marketplaceInput(marketplace) }), {
        targetPath: TARGET,
      }))?.code,
      'INVALID_DRAFT',
      JSON.stringify(marketplace),
    );
  }

  const retained = store.save(v2Input({
    marketplace: marketplaceInput({
      edits: [{
        preset: 'coding',
        packageIds: [opaque, longId],
        creations: [{ packageId: longId, models }],
      }],
      originals: [{ preset: 'coding', selectionPresent: true, packageIds: [opaque] }],
      identities: [{ id: longId, version: '1.0.0', agentName: 'long129', digest: DIGEST }],
    }),
  }), { targetPath: TARGET });
  assert.deepEqual(retained.draft.marketplace.edits[0].packageIds, [opaque, longId]);

  const newOpaque = {
    edits: [{ preset: 'coding', packageIds: [opaque], creations: [] }],
    originals: [{ preset: 'coding', selectionPresent: false, packageIds: [] }],
    identities: [],
  };
  assert.equal(
    errorOf(() => store.save(v2Input({ marketplace: marketplaceInput(newOpaque) }), {
      targetPath: TARGET,
    }))?.code,
    'INVALID_DRAFT',
  );

  const opaqueCreation = {
    edits: [{
      preset: 'coding',
      packageIds: [opaque],
      creations: [{ packageId: opaque, models }],
    }],
    originals: [{ preset: 'coding', selectionPresent: true, packageIds: [opaque] }],
    identities: [],
  };
  assert.equal(
    errorOf(() => store.save(v2Input({ marketplace: marketplaceInput(opaqueCreation) }), {
      targetPath: TARGET,
    }))?.code,
    'INVALID_DRAFT',
  );
});
