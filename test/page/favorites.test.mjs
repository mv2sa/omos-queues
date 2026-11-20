import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAVORITES_KEY, FAVORITES_SCOPE, normalizeFavoriteRefs, normalizeFavorites, modelRefId, modelIdRef,
  favoriteFirst, favoriteButtonProps, createFavoritesController, createFavoriteSourceController,
} from '../../src/page/favorites.js';
import { favoritesStatus } from '../../src/page/favorites-panel.js';
import { createEditor, createReadyReceiver, replaceModels, snapshot } from '../../src/page/editor-state.js';

const ref = (name = 'alpha') => ({ providerID: 'fixture', modelID: name });
const record = models => ({ version: 1, models, source: { kind: 'manual', importedAt: null } });
const ready = (models = [ref()], generation = 'source-a', extra = {}) => ({
  state: 'ready', generation, favoriteModels: models, fingerprint: `fingerprint-${JSON.stringify(models)}`,
  readAt: 1234, updatedAt: 1200, sourceKind: 'openchamber-preferences-v1', ...extra,
});
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function localController(initial, implementation = {}) {
  const calls = []; const states = [];
  const storage = {
    async get(key, options) { calls.push({ type: 'get', key, options }); return implementation.get ? implementation.get() : initial; },
    async set(key, value, options) { calls.push({ type: 'set', key, value, options }); return implementation.set?.(value); },
  };
  const local = createFavoritesController({ storage, now: () => 4000, onChange: state => states.push(state) });
  return { local, calls, states };
}

test('favorites validate refs, deduplicate in saved order and split only the first model slash', () => {
  assert.deepEqual(normalizeFavoriteRefs([ref('b'), ref('a'), ref('b')]), [ref('b'), ref('a')]);
  assert.deepEqual(modelIdRef('fixture/family/model'), { providerID: 'fixture', modelID: 'family/model' });
  assert.equal(modelRefId(modelIdRef('fixture/family/model')), 'fixture/family/model');
  for (const bad of [[{ providerID: 'bad/provider', modelID: 'model' }], [ref('')], [ref('has space')], [{ ...ref(), secret: 'not-allowed' }]]) {
    assert.throws(() => normalizeFavoriteRefs(bad), /invalid model reference/);
  }
});

test('favorite-first ordering is stable and never inserts unavailable local refs into the picker', () => {
  const favorites = [ref('b'), ref('missing'), ref('a')];
  const ids = ['fixture/c', 'fixture/a', 'fixture/c', 'fixture/b', 'fixture/d'];
  assert.deepEqual(favoriteFirst(ids, favorites), ['fixture/b', 'fixture/a', 'fixture/c', 'fixture/d']);
  assert.deepEqual(favorites.map(modelRefId), ['fixture/b', 'fixture/missing', 'fixture/a']);
  assert.deepEqual(ids, ['fixture/c', 'fixture/a', 'fixture/c', 'fixture/b', 'fixture/d']);
});

test('the exact favorites schema has 64 unique-ref and 64 KiB bounds without truncation', () => {
  const max = Array.from({ length: 64 }, (_, index) => ref(String(index)));
  assert.equal(normalizeFavorites(record(max)).models.length, 64);
  assert.throws(() => normalizeFavorites(record([...max, ref('65')])), /at most 64/);
  assert.throws(() => normalizeFavorites(record([ref('x'.repeat(70000))])), /64 KiB/);
  assert.throws(() => normalizeFavorites(record(max.map((_, index) => ref(`${'界'.repeat(480)}${index}`)))), /64 KiB/);
  assert.throws(() => normalizeFavorites({ ...record([]), version: 2 }), /invalid/);
  assert.throws(() => normalizeFavorites({ ...record([]), filePath: '/not-stored-here' }), /invalid/);
  assert.throws(() => normalizeFavorites(null), /invalid/);
  assert.deepEqual(normalizeFavorites(undefined), record([]));
});

test('an absent preference is a valid empty local list, read once with explicit instance scope', async () => {
  const { local, calls } = localController(undefined);
  await Promise.all([local.load(), local.load()]); await local.load();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { type: 'get', key: 'omos-queues.favorites.v1', options: { scope: 'instance' } });
  assert.equal(FAVORITES_KEY, 'omos-queues.favorites.v1'); assert.deepEqual(FAVORITES_SCOPE, { scope: 'instance' });
  assert.equal(local.getState().loaded, true); assert.deepEqual(local.getState().record.models, []);
});

test('read failure stays unavailable, blocks overwrite, and supports an explicit retry', async () => {
  let broken = true;
  const { local, calls } = localController(undefined, { get() { if (broken) throw new Error('storage unavailable'); return record([ref()]); } });
  await local.load();
  assert.equal(local.getState().loaded, false); assert.match(favoritesStatus(local.getState()), /could not be read/);
  assert.throws(() => local.toggle('fixture/beta'), /Read extension favorites successfully/);
  assert.throws(() => local.retryWrite(), /Read extension favorites successfully/);
  await local.load(); assert.equal(calls.length, 1);
  broken = false; await local.load({ retry: true });
  assert.equal(local.getState().loaded, true); assert.deepEqual(local.getState().record.models, [ref()]);
});

test('a synchronously throwing storage API also remains retryable', async () => {
  let broken = true;
  const local = createFavoritesController({ storage: { get() { if (broken) throw new Error('sync failure'); return undefined; }, async set() {} } });
  await local.load(); assert.match(local.getState().readError, /sync failure/);
  broken = false; await local.load({ retry: true }); assert.equal(local.getState().loaded, true);
});

test('oversized stored data fails visibly rather than becoming an empty success or new write', async () => {
  const { local, calls } = localController(record([ref('x'.repeat(70000))]));
  await local.load(); assert.equal(local.getState().loaded, false);
  assert.match(local.getState().readError, /64 KiB/);
  assert.equal(calls.some(call => call.type === 'set'), false);
});

test('writes are serialized and delayed acknowledgments cannot replace later star intent', async () => {
  const first = deferred(); const second = deferred(); const firstStarted = deferred(); const secondStarted = deferred(); let index = 0;
  const { local, calls } = localController(undefined, { set() {
    index += 1;
    if (index === 1) { firstStarted.resolve(); return first.promise; }
    secondStarted.resolve(); return second.promise;
  } });
  await local.load(); local.toggle('fixture/a'); await firstStarted.promise;
  local.toggle('fixture/b');
  assert.deepEqual(local.getState().record.models, [ref('a'), ref('b')]); assert.equal(index, 1);
  first.resolve(); await secondStarted.promise;
  assert.deepEqual(local.getState().record.models, [ref('a'), ref('b')]);
  assert.equal(local.getState().savedRevision, 1); assert.equal(local.getState().saving, true);
  second.resolve(); await local.drain();
  assert.equal(local.getState().savedRevision, 2); assert.equal(local.getState().saving, false);
  assert.deepEqual(calls.at(-1).value.models, [ref('a'), ref('b')]);
  assert.ok(calls.every(call => call.key === FAVORITES_KEY && call.options.scope === 'instance'));
});

test('failed writes retain local stars and retry saves the latest revision', async () => {
  let broken = true;
  const { local, calls } = localController(undefined, { set() { if (broken) throw new Error('full'); } });
  await local.load(); local.toggle('fixture/a'); await local.drain();
  assert.deepEqual(local.getState().record.models, [ref('a')]); assert.match(favoritesStatus(local.getState()), /could not be saved/);
  local.toggle('fixture/b'); await local.drain(); broken = false;
  await local.retryWrite();
  assert.deepEqual(calls.at(-1).value.models, [ref('a'), ref('b')]); assert.equal(local.getState().writeError, null);
});

test('an import queued behind an earlier star write remains the latest local and persisted intent', async () => {
  const pending = deferred(); const started = deferred(); let index = 0;
  const { local, calls } = localController(undefined, { set() { index += 1; if (index === 1) { started.resolve(); return pending.promise; } } });
  await local.load(); local.toggle('fixture/earlier'); await started.promise;
  const source = ready([ref('imported')]); local.applyImport(local.prepareImport(source), source);
  pending.resolve(); await local.drain();
  assert.deepEqual(local.getState().record.models, [ref('imported')]);
  assert.deepEqual(calls.at(-1).value.models, [ref('imported')]);
  assert.equal(local.getState().savedRevision, local.getState().revision);
});

test('a 65th manual star is rejected without changing the prior 64-ref record', async () => {
  const { local, calls } = localController(record(Array.from({ length: 64 }, (_, index) => ref(String(index)))));
  await local.load(); const before = local.getState();
  assert.throws(() => local.toggle('fixture/extra'), /at most 64/);
  assert.deepEqual(local.getState(), before); assert.equal(calls.some(call => call.type === 'set'), false);
});

test('repeated readiness never remounts or re-reads over local changes', async () => {
  const { local, calls } = localController(record([ref('a')])); let mounts = 0; let applies = 0;
  const receive = createReadyReceiver(() => { applies += 1; }, () => { mounts += 1; void local.load(); });
  receive({ theme: 'light' }); await local.load(); local.toggle('fixture/b'); await local.drain();
  receive({ theme: 'dark' }); receive({ keyboard: 300 }); await local.load({ retry: true });
  assert.equal(mounts, 1); assert.equal(applies, 3); assert.equal(calls.filter(call => call.type === 'get').length, 1);
  assert.deepEqual(local.getState().record.models, [ref('a'), ref('b')]);
});

test('source refreshes observe saved order, additions, removals and explicit empty without changing local stars', async () => {
  let models = [ref('a'), ref('b')]; const calls = [];
  const source = createFavoriteSourceController({ request: async path => {
    calls.push(path); return path === '/favorites/source' ? { filePath: '/isolated/profile/preferences.json', generation: 'source-a' } : ready(models);
  } });
  const { local } = localController(record([ref('local')])); await local.load();
  await source.refresh(); assert.deepEqual(source.getState().snapshot.favoriteModels, models);
  models = [ref('c'), ref('a')]; await source.refresh(); assert.deepEqual(source.getState().snapshot.favoriteModels, models);
  models = []; await source.refresh(); assert.deepEqual(source.getState().snapshot.favoriteModels, []);
  assert.equal(source.getState().snapshot.state, 'ready'); assert.deepEqual(local.getState().record.models, [ref('local')]);
  assert.equal(calls.filter(path => path === '/favorites/source').length, 3);
  assert.equal(calls.filter(path => path === '/favorites/snapshot').length, 3);
});

test('unavailable, unsupported and not-configured sources are never authoritative empty favorites', async () => {
  for (const state of ['unavailable', 'unsupported', 'not-configured']) {
    const source = createFavoriteSourceController({ request: async path => path === '/favorites/source'
      ? { filePath: '', generation: 'source-a' } : { state, generation: 'source-a', error: { code: 'EXPECTED', message: state } } });
    await source.refresh(); const result = source.getState();
    assert.equal(result.snapshot.state, state); assert.equal(Object.hasOwn(result.snapshot, 'favoriteModels'), false);
    const { local } = localController(record([ref('local')])); await local.load();
    assert.throws(() => local.prepareImport(result.snapshot), /fresh source snapshot/);
  }
});

test('a failed source refresh keeps last-good data explicitly stale and blocks import', async () => {
  let broken = false;
  const source = createFavoriteSourceController({ request: async path => {
    if (broken) throw new Error('read failed');
    return path === '/favorites/source' ? { filePath: '/isolated/preferences.json', generation: 'source-a' } : ready([ref('a')]);
  } });
  await source.refresh(); broken = true; await source.refresh(); const value = source.getState();
  assert.equal(value.snapshot.state, 'unavailable'); assert.match(value.error, /read failed/);
  assert.deepEqual(value.lastGood.favoriteModels, [ref('a')]); assert.equal(Object.hasOwn(value.snapshot, 'favoriteModels'), false);
});

test('source generation mismatch is unavailable rather than a mixed-source success', async () => {
  const source = createFavoriteSourceController({ request: async path => path === '/favorites/source'
    ? { filePath: '/isolated/preferences.json', generation: 'source-a' } : ready([ref()], 'source-b') });
  await source.refresh(); assert.equal(source.getState().snapshot.state, 'unavailable');
  assert.match(source.getState().error, /changed while it was being read/);
});

test('a stale snapshot failure cannot poison a newly configured source', async () => {
  const oldSnapshot = deferred(); const oldStarted = deferred(); let generation = 'source-a';
  const source = createFavoriteSourceController({ request: async (path, body) => {
    if (body) { generation = 'source-b'; return { filePath: body.filePath, generation }; }
    if (path === '/favorites/source') return { filePath: `/isolated/${generation}.json`, generation };
    if (generation === 'source-a') { oldStarted.resolve(); return oldSnapshot.promise; }
    return ready([ref('new')], generation);
  } });
  const old = source.refresh(); await oldStarted.promise;
  await source.configure('/isolated/new.json');
  oldSnapshot.reject(new Error('old source failed')); await old;
  assert.equal(source.getState().snapshot.state, 'ready'); assert.equal(source.getState().snapshot.generation, 'source-b');
  assert.deepEqual(source.getState().snapshot.favoriteModels, [ref('new')]); assert.equal(source.getState().error, null);
});

test('source settings writes are serialized and only the latest source publishes', async () => {
  const first = deferred(); const firstStarted = deferred(); const posted = []; let metadata = { filePath: '', generation: 'none' };
  const source = createFavoriteSourceController({ request: async (path, body) => {
    if (body) {
      posted.push(body.filePath);
      if (posted.length === 1) { firstStarted.resolve(); await first.promise; }
      metadata = { filePath: body.filePath, generation: body.filePath }; return metadata;
    }
    return path === '/favorites/source' ? metadata : ready([ref('current')], metadata.generation);
  } });
  const a = source.configure('/isolated/a'); await firstStarted.promise;
  const b = source.configure('/isolated/b'); assert.deepEqual(posted, ['/isolated/a']);
  first.resolve(); await Promise.all([a, b]);
  assert.deepEqual(posted, ['/isolated/a', '/isolated/b']);
  assert.equal(source.getState().settings.filePath, '/isolated/b'); assert.equal(source.getState().snapshot.generation, '/isolated/b');
});

test('a late source metadata read cannot replace the path of a newer source configuration', async () => {
  const oldMetadata = deferred(); const oldStarted = deferred(); let reads = 0;
  const source = createFavoriteSourceController({ request: async (path, body) => {
    if (body) return { filePath: body.filePath, generation: 'source-b' };
    if (path === '/favorites/source') {
      reads += 1;
      if (reads === 1) { oldStarted.resolve(); return oldMetadata.promise; }
      return { filePath: '/isolated/new.json', generation: 'source-b' };
    }
    return ready([ref('new')], 'source-b');
  } });
  const old = source.refresh(); await oldStarted.promise;
  await source.configure('/isolated/new.json');
  oldMetadata.resolve({ filePath: '/isolated/old.json', generation: 'source-a' }); await old;
  assert.equal(source.getState().settings.filePath, '/isolated/new.json');
  assert.equal(source.getState().snapshot.generation, 'source-b');
});

test('Refresh waits for a pending source setting write and reads its actual saved metadata', async () => {
  const pending = deferred(); const posted = deferred(); const calls = [];
  const source = createFavoriteSourceController({ request: async (path, body) => {
    calls.push([path, body]);
    if (body) { posted.resolve(); await pending.promise; return { filePath: body.filePath, generation: 'source-b' }; }
    return path === '/favorites/source' ? { filePath: '/isolated/new.json', generation: 'source-b' } : ready([], 'source-b');
  } });
  const configuration = source.configure('/isolated/new.json'); await posted.promise;
  const refresh = source.refresh(); assert.equal(calls.length, 1);
  pending.resolve(); await Promise.all([configuration, refresh]);
  assert.deepEqual(calls.map(([path]) => path), ['/favorites/source', '/favorites/source', '/favorites/snapshot']);
  assert.equal(source.getState().snapshot.state, 'ready'); assert.deepEqual(source.getState().snapshot.favoriteModels, []);
});

test('an explicit source configuration failure is visible and never falls back to guessed paths', async () => {
  const calls = [];
  const source = createFavoriteSourceController({ request: async (path, body) => { calls.push([path, body]); throw new Error('path rejected'); } });
  await source.configure('/isolated/missing-profile.json');
  assert.deepEqual(calls, [['/favorites/source', { filePath: '/isolated/missing-profile.json' }]]);
  assert.equal(source.getState().snapshot.state, 'unavailable'); assert.match(source.getState().error, /path rejected/);
});

test('import preview is frozen, ordered, explicit and carries independent local origin metadata', async () => {
  const { local, calls } = localController(record([ref('local')])); await local.load();
  const snapshot = ready([ref('b'), ref('a'), ref('b')]);
  const preview = local.prepareImport(snapshot);
  assert.deepEqual(preview.models, [ref('b'), ref('a')]); assert.ok(Object.isFrozen(preview.models[0]));
  assert.deepEqual(local.getState().record.models, [ref('local')]); assert.equal(calls.some(call => call.type === 'set'), false);
  local.applyImport(preview, snapshot); await local.drain();
  assert.deepEqual(local.getState().record, { version: 1, models: [ref('b'), ref('a')], source: { kind: 'openchamber-import', importedAt: 4000 } });
  local.toggle('fixture/manual'); await local.drain();
  assert.deepEqual(local.getState().record.source, { kind: 'manual', importedAt: null });
});

test('an empty source preview clears local favorites only on the explicit apply action', async () => {
  const { local } = localController(record([ref('local')])); await local.load(); const snapshot = ready([]);
  const preview = local.prepareImport(snapshot); assert.equal(local.getState().record.models.length, 1);
  local.applyImport(preview, snapshot); await local.drain(); assert.deepEqual(local.getState().record.models, []);
});

test('import confirmation rejects later local edits, new reads and source failures', async () => {
  const { local } = localController(undefined); await local.load(); const snapshot = ready([ref('imported')]);
  const staleLocal = local.prepareImport(snapshot); local.toggle('fixture/later');
  assert.throws(() => local.applyImport(staleLocal, snapshot), /changed/); await local.drain();
  const fresh = local.prepareImport(snapshot);
  assert.throws(() => local.applyImport(fresh, { ...snapshot, readAt: 5000 }), /changed/);
  assert.throws(() => local.applyImport(fresh, { state: 'unavailable' }), /changed/);
  assert.deepEqual(local.getState().record.models, [ref('later')]);
});

test('favorites never dirty the editor, reorder queue positions or invalidate its reviewed snapshot', async () => {
  const path = ['agents', 'custom-agent', 'model'];
  const editor = createEditor({ target: { path: '/isolated/omos.jsonc', generation: 'config-generation' }, baseHash: 'baseline',
    groups: [{ id: JSON.stringify(path), path, name: 'custom-agent', section: 'Agents', models: [{ id: 'fixture/a', variant: '' }], readOnlyReason: null }] });
  replaceModels(editor, editor.selectedId, [{ id: 'fixture/b', variant: 'high' }, { id: 'fixture/a', variant: '' }]);
  editor.preview = { reviewed: snapshot(editor), token: 'opaque-reviewed-token' };
  const before = structuredClone(editor);
  const { local } = localController(undefined); await local.load(); local.toggle('fixture/a'); await local.drain();
  const imported = ready([ref('b')]); local.applyImport(local.prepareImport(imported), imported); await local.drain();
  favoriteFirst(['fixture/a', 'fixture/b'], local.getState().record.models);
  assert.deepEqual(editor, before);
});

test('star semantics identify the model, extension-local scope and pressed state on any device', () => {
  assert.deepEqual(favoriteButtonProps('fixture/a', false), { label: '☆', ariaLabel: 'Add fixture/a to extension favorites', pressed: 'false', disabled: false });
  assert.deepEqual(favoriteButtonProps('fixture/a', true, true), { label: '★', ariaLabel: 'Remove fixture/a from extension favorites', pressed: 'true', disabled: true });
});

test('refreshForUse performs a fresh instance read after load and reconciles external stars with a new canonical revision', async () => {
  let saved = record([ref('a')]);
  const { local, calls } = localController(undefined, { get: () => saved });
  await local.load(); saved = record([ref('b'), ref('a')]);
  const fresh = await local.refreshForUse();
  assert.deepEqual(fresh.record.models, [ref('b'), ref('a')]); assert.equal(fresh.revision, 1); assert.equal(fresh.reading, false);
  assert.equal(calls.filter(call => call.type === 'get').length, 2);
  await local.refreshForUse(); assert.equal(local.getState().revision, 1);
});

test('refreshForUse drains owned pending writes before reading and blocks a failed write without losing local intent', async () => {
  const pending = deferred(); const started = deferred(); let saved;
  const { local, calls } = localController(undefined, { get: () => saved, async set(value) { started.resolve(); await pending.promise; saved = value; } });
  await local.load(); local.toggle('fixture/new'); await started.promise;
  const refreshing = local.refreshForUse(); assert.equal(calls.filter(call => call.type === 'get').length, 1);
  pending.resolve(); const fresh = await refreshing; assert.deepEqual(fresh.record.models, [ref('new')]);
  const broken = localController(undefined, { set() { throw new Error('write failed'); } });
  await broken.local.load(); broken.local.toggle('fixture/unsaved'); await broken.local.drain();
  await assert.rejects(broken.local.refreshForUse(), /could not be saved/);
  assert.deepEqual(broken.local.getState().record.models, [ref('unsaved')]);
  assert.equal(broken.calls.filter(call => call.type === 'get').length, 1);
});

test('a delayed fresh read cannot overwrite later local stars', async () => {
  const pending = deferred(); const started = deferred(); let reads = 0;
  const { local } = localController(undefined, { get() { if (++reads === 1) return record([ref('a')]); started.resolve(); return pending.promise; } });
  await local.load(); const refreshing = local.refreshForUse(); await started.promise;
  local.toggle('fixture/newer'); pending.resolve(record([ref('old-server-value')]));
  await assert.rejects(refreshing, /Newer stars were kept/); await local.drain();
  assert.deepEqual(local.getState().record.models, [ref('a'), ref('newer')]); assert.equal(local.getState().readError, null);
});

test('a failed fresh read blocks use but retains stars and allows an explicit read retry', async () => {
  let broken = false;
  const { local } = localController(undefined, { get() { if (broken) throw new Error('offline'); return record([ref('a')]); } });
  await local.load(); broken = true;
  await assert.rejects(local.refreshForUse(), /offline/);
  assert.deepEqual(local.getState().record.models, [ref('a')]); assert.match(local.getState().readError, /could not be refreshed/);
  broken = false; await local.load({ retry: true }); assert.equal(local.getState().readError, null);
});

test('source timestamp DTOs require finite numeric readAt and nonnegative finite updatedAt or null', async () => {
  for (const extra of [{ readAt: '2026-11-15T00:00:00Z' }, { readAt: Infinity }, { updatedAt: '2026-11-15T00:00:00Z' }, { updatedAt: -1 }, { updatedAt: Infinity }]) {
    const source = createFavoriteSourceController({ request: async path => path === '/favorites/source'
      ? { filePath: '/isolated/profile.json', generation: 'source-a' } : ready([ref()], 'source-a', extra) });
    await source.refresh(); assert.equal(source.getState().snapshot.state, 'unavailable');
  }
  const source = createFavoriteSourceController({ request: async path => path === '/favorites/source'
    ? { filePath: '/isolated/profile.json', generation: 'source-a' } : ready([], 'source-a', { readAt: 123, updatedAt: null }) });
  await source.refresh(); assert.equal(source.getState().snapshot.state, 'ready');
});
