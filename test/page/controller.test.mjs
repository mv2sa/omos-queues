import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequestFence, createOperations, createDraftController, discardEdits, changeSettings,
  beginModelPick, applyModelPick, handlePickerKey, queueActions, createDialogFocus,
  reloadDisposition, confirmPasteWithFeedback,
  completeDialogAction,
} from '../../src/page/controller.js';
import {
  clone, pathKey, createEditor, replaceModels, snapshot, canDiscardSnapshot,
  copyQueue, requestPaste, reconciliationKind, dirtyGroups,
  acknowledgeSave, beginPrimaryPick, applyPrimaryPick, discardPrimaryCreation,
} from '../../src/page/editor-state.js';

const positions = (id = 'fixture/model', variant = '') => [{ id, variant }];
function fixture() {
  const queue = name => {
    const path = ['agents', name, 'model'];
    return { id: pathKey(path), path, name, label: name, section: 'Agents', kind: 'agent',
      defaultVariant: 'medium', models: positions(), readOnlyReason: null };
  };
  return createEditor({ target: { path: '/isolated/omos.jsonc', logicalPath: '/isolated/omos.jsonc', generation: 'generation-a' },
    baseHash: 'a'.repeat(64), groups: [queue('builder'), queue('reviewer')] });
}
const changed = editor => replaceModels(editor, editor.groups[0].id, positions('fixture/edited'));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let next = 0;
  const callbacks = new Map();
  return {
    setTimer(fn) { const id = ++next; callbacks.set(id, fn); return id; },
    clearTimer(id) { callbacks.delete(id); },
    fire() { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(fn => fn()); },
    get size() { return callbacks.size; },
  };
}
function draftsFor(editor, request = async () => ({})) {
  const calls = []; const statuses = []; const timer = clock();
  let current = editor;
  const drafts = createDraftController({
    request: async (path, body, method) => { calls.push({ path, body: body && clone(body), method }); return request(path, body, method); },
    getState: () => current, getId: () => 'frame-a', onStatus: (...args) => statuses.push(args),
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  });
  return { drafts, calls, statuses, timer, setState: next => { current = next; } };
}
const settings = { configFile: '/isolated/missing.jsonc', opencodeBin: 'opencode', modelCwd: '/isolated', opencodeConfigDir: '' };
const settingsResult = () => ({ settings: clone(settings), generation: 'generation-b' });
function key(name, extra = {}) {
  return { key: name, defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}

test('Add stages its picker without a blank row, draft write, or cancel mutation', async () => {
  const editor = fixture(); changed(editor);
  const { drafts, calls } = draftsFor(editor);
  await drafts.persist();
  const before = clone(editor); const saved = clone(calls[0].body);
  let picker = beginModelPick(editor, editor.groups[0].id, 1, true);
  assert.ok(picker); assert.deepEqual(editor, before);
  picker = null; // Closing the actual picker only drops this staged descriptor.
  assert.equal(picker, null); assert.deepEqual(editor, before);
  assert.deepEqual(calls[0].body, saved); assert.equal(calls.length, 1);
  picker = beginModelPick(editor, editor.groups[0].id, 1, true);
  assert.equal(applyModelPick(editor, picker, 'fixture/new'), true);
  assert.deepEqual(editor.groups[0].models, [...positions('fixture/edited'), ...positions('fixture/new')]);
  await drafts.persist();
  assert.equal(calls[1].body.changes[0].models.length, 2);
  assert.ok(calls[1].body.changes[0].models.every(model => model.id));
});

test('staged model choices enforce current revision, index, read-only and 50-position bounds', () => {
  const editor = fixture(); const group = editor.groups[0];
  assert.equal(beginModelPick(editor, group.id, -1), null);
  const pending = beginModelPick(editor, group.id, 1, true);
  changed(editor);
  assert.equal(applyModelPick(editor, pending, 'fixture/new'), false);
  assert.equal(applyModelPick(editor, beginModelPick(editor, group.id, 1, true), ''), false);
  group.readOnlyReason = 'Unsupported value';
  assert.equal(beginModelPick(editor, group.id, 1, true), null);
  group.readOnlyReason = null;
  group.models = Array.from({ length: 50 }, () => positions()[0]);
  assert.equal(beginModelPick(editor, group.id, 50, true), null);
});

test('invalid or incomplete local state never overwrites a previously valid stored draft', async () => {
  const editor = fixture(); changed(editor);
  const { drafts, calls, statuses } = draftsFor(editor);
  assert.equal(await drafts.persist(), true);
  const stored = clone(calls[0].body);
  replaceModels(editor, editor.groups[0].id, positions(''));
  assert.equal(await drafts.persist(), false);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body, stored);
  assert.match(statuses.at(-1)[0], /earlier stored draft is unchanged/);
  replaceModels(editor, editor.groups[0].id, positions('fixture/valid', 'x'.repeat(501)));
  assert.equal(await drafts.persist(), false); assert.equal(calls.length, 1);
});

test('clean frames do not DELETE drafts that were never stored', async () => {
  const { drafts, calls } = draftsFor(fixture());
  await drafts.persist(); await drafts.remove();
  assert.deepEqual(calls, []);
});

test('target request fencing suppresses stale config/draft failures and finalizers', async () => {
  const requests = createRequestFence();
  const config = deferred(); const stored = deferred(); const old = requests.begin();
  const effects = { target: 'old', conflict: null, notice: '', finished: 0 };
  const configRead = requests.run(old, () => config.promise, {
    success: value => { effects.target = value; }, failure: error => { effects.conflict = error.message; },
    finished: () => { effects.finished += 1; },
  });
  const draftsRead = requests.run(old, () => stored.promise, { failure: error => { effects.notice = error.message; } });
  const fresh = requests.begin();
  await requests.run(fresh, async () => 'new-target', { success: value => { effects.target = value; } });
  config.reject(new Error('old unreadable file')); stored.reject(new Error('old draft failure'));
  await Promise.all([configRead, draftsRead]);
  assert.deepEqual(effects, { target: 'new-target', conflict: null, notice: '', finished: 0 });
});

test('late successful reads from a previous settings generation cannot publish either', async () => {
  const requests = createRequestFence(); const result = deferred(); let published = false;
  const read = requests.run(requests.begin(), () => result.promise, { success: () => { published = true; } });
  requests.invalidate(); result.resolve({ stale: true }); await read;
  assert.equal(published, false);
});

test('explicit discard cancels debounce without POSTing a draft just to delete it', async () => {
  const editor = fixture(); changed(editor); const saved = snapshot(editor);
  const { drafts, calls, timer } = draftsFor(editor);
  drafts.schedule(); assert.equal(timer.size, 1);
  const operationNames = []; const operations = createOperations(name => operationNames.push(name));
  const result = discardEdits({ drafts, operations, stillCurrent: () => canDiscardSnapshot(editor, saved),
    apply: () => replaceModels(editor, editor.groups[0].id, editor.groups[0].original) });
  assert.equal(operations.name, 'discard'); assert.equal(timer.size, 0);
  assert.equal(await result, true); assert.equal(dirtyGroups(editor).length, 0);
  assert.deepEqual(calls, []); assert.deepEqual(operationNames, ['discard', '']);
});

test('discard drains an inflight draft before deleting it and never races a new POST', async () => {
  const editor = fixture(); changed(editor); const saved = snapshot(editor);
  const pending = deferred();
  const { drafts, calls } = draftsFor(editor, async path => path === '/drafts' ? pending.promise : {});
  const write = drafts.persist(); await Promise.resolve();
  const operations = createOperations(); let applied = false;
  const discard = discardEdits({ drafts, operations, stillCurrent: () => canDiscardSnapshot(editor, saved),
    apply() { applied = true; replaceModels(editor, editor.groups[0].id, editor.groups[0].original); } });
  assert.equal(operations.name, 'discard'); assert.equal(applied, false);
  pending.resolve({}); await write; await discard;
  assert.equal(applied, true);
  assert.deepEqual(calls.map(call => [call.path, call.method]), [['/drafts', undefined], ['/drafts/frame-a', 'DELETE']]);
  assert.equal(drafts.hasStored('frame-a'), false);
});

test('a later revision prevents a delayed discard and remains scheduled for storage', async () => {
  const editor = fixture(); changed(editor); const saved = snapshot(editor); const pending = deferred();
  const { drafts, timer } = draftsFor(editor, () => pending.promise);
  const write = drafts.persist(); await Promise.resolve();
  let applied = false;
  const discard = discardEdits({ drafts, operations: createOperations(), stillCurrent: () => canDiscardSnapshot(editor, saved), apply: () => { applied = true; } });
  replaceModels(editor, editor.groups[0].id, positions('fixture/newer'));
  pending.resolve({}); await write;
  assert.equal(await discard, false); assert.equal(applied, false); assert.equal(timer.size, 1);
  assert.equal(editor.groups[0].models[0].id, 'fixture/newer');
});

test('new edits during draft deletion prevent a destructive reload afterward', async () => {
  const editor = fixture(); changed(editor); const saved = snapshot(editor);
  const deleting = deferred(); const deleteStarted = deferred();
  const { drafts, timer } = draftsFor(editor, async (path, body, method) => {
    if (method === 'DELETE') { deleteStarted.resolve(); return deleting.promise; }
    return {};
  });
  await drafts.persist(); let afterDiscard; let reloaded = false;
  const discard = discardEdits({ drafts, operations: createOperations(), stillCurrent: () => canDiscardSnapshot(editor, saved),
    apply() { replaceModels(editor, editor.groups[0].id, editor.groups[0].original); afterDiscard = snapshot(editor); },
    afterIsCurrent: () => canDiscardSnapshot(editor, afterDiscard), after: () => { reloaded = true; },
  });
  await deleteStarted.promise;
  replaceModels(editor, editor.groups[0].id, positions('fixture/newer'));
  deleting.resolve({});
  assert.equal(await discard, false); assert.equal(reloaded, false); assert.equal(timer.size, 1);
  assert.equal(editor.groups[0].models[0].id, 'fixture/newer');
});

test('settings invalidate pending loads/catalog before posting and discard without a draft POST', async () => {
  const editor = fixture(); changed(editor);
  const { drafts, calls, timer } = draftsFor(editor); drafts.schedule();
  const requests = createRequestFence(); const old = requests.begin();
  const operations = createOperations(); let catalogInvalidated = false; let applied = false;
  const transition = changeSettings({ drafts, operations, requests, values: settings,
    invalidateCatalog: () => { catalogInvalidated = true; },
    async post(values) {
      assert.deepEqual(values, settings); assert.equal(requests.current(old), false);
      assert.equal(catalogInvalidated, true); assert.equal(timer.size, 0);
      return settingsResult();
    },
    apply: () => { applied = true; },
  });
  assert.equal(operations.name, 'settings');
  await transition; assert.equal(applied, true); assert.deepEqual(calls, []);
});

test('draft storage failure cannot deadlock explicit settings discard', async () => {
  const editor = fixture(); changed(editor);
  const { drafts, calls } = draftsFor(editor, async () => { throw new Error('storage full'); });
  assert.equal(await drafts.persist(), false);
  let settingsPosted = false;
  await changeSettings({ drafts, operations: createOperations(), requests: createRequestFence(), values: settings,
    invalidateCatalog() {}, post: async () => { settingsPosted = true; return settingsResult(); }, apply() {},
  });
  assert.equal(settingsPosted, true); assert.equal(calls.length, 1);
});

test('an old transition finalizer cannot finish a newer load operation', async () => {
  const operations = createOperations();
  const { drafts } = draftsFor(fixture());
  let newer;
  await changeSettings({ drafts, operations, requests: createRequestFence(), values: settings,
    invalidateCatalog() {}, post: async () => settingsResult(), apply() { newer = operations.begin('load'); },
  });
  assert.equal(operations.name, 'load'); assert.equal(operations.owns(newer), true);
  operations.finish(newer); assert.equal(operations.name, '');
});

test('unknown outcome stays blocked until acknowledged settings rotation and keeps its stored draft', async () => {
  const editor = fixture(); changed(editor); editor.unknown = { token: 'old-save' };
  const { drafts, calls } = draftsFor(editor); await drafts.persist();
  const posted = deferred(); const operations = createOperations();
  const transition = changeSettings({ drafts, operations, requests: createRequestFence(), values: settings,
    preserveDraft: true, expectedGeneration: editor.target.generation, invalidateCatalog() {},
    post: () => posted.promise, apply() { editor.unknown = null; },
  });
  assert.equal(reloadDisposition(editor, ''), 'unknown');
  await Promise.resolve(); assert.ok(editor.unknown);
  posted.resolve(settingsResult()); await transition;
  assert.equal(editor.unknown, null); assert.equal(drafts.hasStored('frame-a'), true);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('failed or unverified settings rotation never clears an unknown outcome', async () => {
  const editor = fixture(); changed(editor); editor.unknown = { token: 'old-save' };
  const { drafts } = draftsFor(editor, async () => { throw new Error('draft store unavailable'); });
  let preserved;
  await assert.rejects(changeSettings({ drafts, operations: createOperations(), requests: createRequestFence(), values: settings,
    preserveDraft: true, expectedGeneration: 'generation-a', invalidateCatalog() {},
    post: async () => ({ settings, generation: 'generation-a' }), apply() { editor.unknown = null; },
  }), /generation change could not be verified/);
  assert.ok(editor.unknown);
  await changeSettings({ drafts, operations: createOperations(), requests: createRequestFence(), values: settings,
    preserveDraft: true, expectedGeneration: 'generation-a', invalidateCatalog() {}, post: async () => settingsResult(),
    apply(result, status) { preserved = status.preserved; },
  });
  assert.equal(preserved, false); // The caller must display the storage warning; rotation still works.
});

test('unknown recovery with a now-clean editor retains an earlier stored recovery draft', async () => {
  const editor = fixture(); changed(editor); const { drafts, calls } = draftsFor(editor); await drafts.persist();
  replaceModels(editor, editor.groups[0].id, editor.groups[0].original); editor.unknown = {};
  await changeSettings({ drafts, operations: createOperations(), requests: createRequestFence(), values: settings,
    preserveDraft: true, invalidateCatalog() {}, post: async () => settingsResult(), apply() {},
  });
  assert.equal(calls.length, 1); assert.equal(drafts.hasStored('frame-a'), true);
});

test('picker honors SDK-consumed Escape and closes on the next Escape from input, list or header', () => {
  let closes = 0;
  const options = { fromSearch: true, query: '', ids: [], navigate: () => false, pick() {}, close: () => { closes += 1; } };
  assert.equal(handlePickerKey(key('Escape', { defaultPrevented: true }), options), false);
  assert.equal(closes, 0);
  assert.equal(handlePickerKey(key('Escape'), options), true);
  handlePickerKey(key('Escape'), { ...options, fromSearch: false }); // list or header
  assert.equal(closes, 2);
});

test('Enter in search picks the exact/current or first match without a synthetic ArrowDown', () => {
  const picked = []; let navigations = 0;
  const options = { fromSearch: true, query: '', ids: ['fixture/current', 'fixture/second'],
    navigate: () => { navigations += 1; return true; }, pick: id => picked.push(id), close() {} };
  handlePickerKey(key('Enter'), options);
  handlePickerKey(key('Enter'), { ...options, query: 'fixture/second' });
  handlePickerKey(key('Enter'), { ...options, query: 'other/explicit', ids: [] });
  handlePickerKey(key('Enter'), { ...options, query: 'invalid id', ids: [] });
  assert.deepEqual(picked, ['fixture/current', 'fixture/second', 'other/explicit']); assert.equal(navigations, 0);
});

test('picker navigation forwards arrow/Ctrl+N/P to the SDK and leaves IME entry alone', () => {
  const forwarded = [];
  const options = { fromSearch: true, query: '', ids: [], navigate: event => { forwarded.push([event.key, event.ctrlKey]); return true; }, pick() {}, close() {} };
  for (const event of [key('ArrowDown'), key('ArrowUp'), key('n', { ctrlKey: true }), key('p', { ctrlKey: true })]) handlePickerKey(event, options);
  handlePickerKey(key('Enter', { isComposing: true }), options);
  handlePickerKey(key('Escape', { isComposing: true }), options);
  assert.deepEqual(forwarded, [['ArrowDown', undefined], ['ArrowUp', undefined], ['n', true], ['p', true]]);
});

test('per-queue actions exclude Reload and track paste readiness, variant edits, save acknowledgments and unknown outcomes', () => {
  const editor = fixture(); const group = editor.groups[0];
  const item = id => queueActions(editor, group, '').find(item => item.id === id);
  assert.deepEqual(queueActions(editor, group, '').map(item => item.id), ['copy', 'paste', 'reset']);
  assert.equal(item('paste').disabled, true);
  copyQueue(editor, editor.groups[1].id);
  assert.equal(item('paste').disabled, false);
  assert.equal(item('reset').disabled, true);
  replaceModels(editor, group.id, positions('fixture/model', 'custom'));
  assert.equal(item('reset').disabled, false);
  acknowledgeSave(editor, { saved: snapshot(editor) }, { baseHash: 'b'.repeat(64) });
  assert.equal(item('reset').disabled, true);
  changed(editor);
  editor.unknown = {};
  assert.equal(item('reset').disabled, true);
  editor.unknown = null;
  assert.equal(item('reset').disabled, false);
  assert.equal(queueActions(editor, group, 'settings').find(item => item.id === 'copy').disabled, true);
});

test('v3 draft writes include a staged primary override, and its reset preserves all other edits', async () => {
  const editor = fixture(); changed(editor);
  editor.primarySlots = [{ preset: 'quality', agent: 'orchestrator', modelPath: ['presets', 'quality', 'orchestrator', 'model'],
    existingGroupId: null, defaultVariant: '', canCreate: true, blockedReason: null }];
  const staged = applyPrimaryPick(editor, beginPrimaryPick(editor, 'quality', 'orchestrator'), 'fixture/first');
  assert.equal(reloadDisposition(editor, ''), 'confirm');
  assert.equal(queueActions(editor, staged, '').find(item => item.id === 'reset').label, 'Reset staged queue');
  const { drafts, calls } = draftsFor(editor);
  assert.equal(await drafts.persist(), true);
  assert.equal(calls[0].body.version, 3);
  assert.deepEqual(calls[0].body.primaryCreations, [{ preset: 'quality', agent: 'orchestrator', models: positions('fixture/first') }]);
  const saved = snapshot(editor);
  assert.equal(await discardEdits({ drafts, operations: createOperations(), stillCurrent: () => canDiscardSnapshot(editor, saved),
    apply: () => discardPrimaryCreation(editor, staged.id) }), true);
  assert.equal(calls[1].body.version, 3);
  assert.deepEqual(calls[1].body.primaryCreations, []);
  assert.deepEqual(calls[1].body.changes, calls[0].body.changes);
});

test('malformed reconciliation snapshots remain unknown without throwing', () => {
  const submitted = { saved: { generation: 'generation-a', targetPath: '/isolated/omos.jsonc', baseHash: 'a' }, result: { afterHash: 'b' } };
  for (const value of [null, {}, { target: null }, { target: {} }, { target: { path: '/isolated/omos.jsonc', generation: 'generation-a' } }]) {
    assert.equal(reconciliationKind(submitted, value), 'unknown');
  }
});

test('dirty retries require confirmation and raw reload remains blocked for unknown outcomes', () => {
  const editor = fixture(); assert.equal(reloadDisposition(editor, ''), 'load');
  changed(editor); assert.equal(reloadDisposition(editor, ''), 'confirm');
  editor.unknown = {}; assert.equal(reloadDisposition(editor, ''), 'unknown');
  assert.equal(reloadDisposition(editor, 'settings'), 'busy');
});

test('nested dialog views retain the original page focus and stale paste reports a visible reason', () => {
  const root = { id: 'drafts-button' }; let active = root; let restored;
  const focus = createDialogFocus(() => active, value => { restored = value; });
  focus.capture(false); active = { id: 'inspect-button' }; focus.capture(true);
  active = { id: 'back-button' }; focus.capture(true); focus.restore();
  assert.equal(restored, root);
  const editor = fixture(); copyQueue(editor, editor.groups[0].id); requestPaste(editor, editor.groups[1].id); changed(editor);
  let feedback = '';
  assert.equal(confirmPasteWithFeedback(editor, message => { feedback = message; }), false);
  assert.match(feedback, /Nothing was pasted/);
});

test('an async discard completion cannot steal focus ownership from a newer settings dialog', () => {
  const oldOrigin = { id: 'reload-file' }; const newerOrigin = { id: 'settings' }; let restored;
  const focus = createDialogFocus(() => newerOrigin, value => { restored = value; });
  focus.capture(false);
  completeDialogAction(focus, { origin: oldOrigin, closedEpoch: 2, currentEpoch: 3, isOpen: true, reopensDialog: false });
  assert.equal(focus.origin, newerOrigin); assert.equal(restored, undefined);
  completeDialogAction(focus, { origin: oldOrigin, closedEpoch: 2, currentEpoch: 3, isOpen: true, reopensDialog: true });
  assert.equal(focus.origin, oldOrigin);
});
