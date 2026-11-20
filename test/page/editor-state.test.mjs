import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clone, pathKey, createEditor, dirtyGroups, visibleGroups, selectQueue, setFilter, editLimit,
  replaceModels, movePosition, variantOptions, copyQueue, requestPaste, cancelPaste, confirmPaste,
  discardQueueSnapshot, canDiscardSnapshot,
  snapshot, previewBody, acceptPreview, beginCommit, acknowledgeSave, markUnknown, reconciliationKind,
  validCommitAcknowledgment,
  reconcile, makeDraft, recoveryStatus, recoverDraft, createReadyReceiver, catalogIds, validateChanges,
} from '../../src/page/editor-state.js';

const models = (id = 'synthetic/alpha', variant = '') => [{ id, variant }];
function fixture() {
  const queue = (name, section, extra = {}) => {
    const path = ['agents', name, 'model'];
    return { id: pathKey(path), path, name, label: `${section}/${name}`, section, kind: 'agent',
      defaultVariant: 'medium', models: models(), readOnlyReason: null, ...extra };
  };
  return { target: { path: '/scratch/omos.jsonc', logicalPath: '/scratch/omos.jsonc', generation: 'generation-a' }, baseHash: 'before',
    groups: [queue('builder', 'Agents'), queue('reviewer', 'Agents', { defaultVariant: 'high' }),
      queue('chair', 'Council', { models: models('synthetic/seat'), readOnlyReason: 'Unsupported placeholder.' })] };
}
const state = () => createEditor(fixture());
const firstId = editor => editor.groups[0].id;
function change(editor, id = firstId(editor), value = 'synthetic/beta') { replaceModels(editor, id, models(value)); }
function reviewed(editor) {
  const saved = snapshot(editor);
  const result = { target: clone(editor.target), baseHash: editor.baseHash, afterHash: 'after', diff: '+ model',
    changed: ['Agents/builder'], previewToken: 'opaque-token', expiresAt: Date.now() + 60000 };
  assert.equal(acceptPreview(editor, saved, result), true);
  return clone(editor.preview);
}

test('local edits are isolated from the config fixture and baselines', () => {
  const config = fixture(); const editor = createEditor(config);
  change(editor);
  assert.equal(dirtyGroups(editor).length, 1);
  assert.equal(editor.groups[0].original[0].id, 'synthetic/alpha');
  assert.equal(config.groups[0].models[0].id, 'synthetic/alpha');
  replaceModels(editor, firstId(editor), models());
  assert.equal(dirtyGroups(editor).length, 0);
});

test('filtering and queue navigation retain all dirty queues and selection', () => {
  const editor = state(); change(editor);
  const selected = editor.selectedId;
  setFilter(editor, 'reviewer');
  assert.equal(visibleGroups(editor).length, 1);
  assert.equal(editor.selectedId, selected);
  selectQueue(editor, editor.groups[1].id); change(editor, editor.groups[1].id, 'synthetic/review');
  assert.equal(snapshot(editor).changes.length, 2);
  setFilter(editor, 'not found');
  assert.deepEqual(visibleGroups(editor), []);
  assert.equal(dirtyGroups(editor).length, 2);
  selectQueue(editor, selected);
  assert.equal(editor.groups[0].models[0].id, 'synthetic/beta');
});

test('copy is a page-local immutable snapshot and cancel leaves destination untouched', () => {
  const editor = state();
  const copied = copyQueue(editor, firstId(editor));
  change(editor);
  assert.equal(copied.models[0].id, 'synthetic/alpha');
  const target = editor.groups[1]; const before = clone(target);
  requestPaste(editor, target.id); cancelPaste(editor);
  assert.equal(confirmPaste(editor), false);
  assert.deepEqual(target, before);
  assert.equal(requestPaste(editor, firstId(editor)), null);
});

test('confirmed paste preserves target identity, baseline, defaults and source snapshot', () => {
  const editor = state();
  replaceModels(editor, firstId(editor), models('synthetic/copied', 'custom-effort'));
  copyQueue(editor, firstId(editor));
  const target = editor.groups[1]; const identity = { path: clone(target.path), id: target.id, defaultVariant: target.defaultVariant, original: clone(target.original) };
  requestPaste(editor, target.id);
  // Changing the clipboard after the confirmation opens cannot replace the pending snapshot.
  editor.clipboard.models = models('synthetic/new-copy');
  assert.equal(confirmPaste(editor), true);
  assert.deepEqual(target.models, models('synthetic/copied', 'custom-effort'));
  for (const [key, value] of Object.entries(identity)) assert.deepEqual(target[key], value);
  target.models[0].id = 'synthetic/later';
  assert.equal(editor.groups[0].models[0].id, 'synthetic/copied');
});

test('edits while paste confirmation is pending invalidate that confirmation', () => {
  const editor = state(); copyQueue(editor, firstId(editor)); requestPaste(editor, editor.groups[1].id);
  change(editor);
  assert.equal(confirmPaste(editor), false);
});

test('blank inheritance stays blank and arbitrary custom variants are retained', () => {
  const editor = state();
  assert.equal(variantOptions('', 'high')[0].label, 'Inherit (high)');
  assert.equal(variantOptions('', '')[0].label, 'Inherit (no explicit variant)');
  assert.equal(variantOptions('custom-token', '').some(option => option.id === 'custom-token'), true);
  replaceModels(editor, firstId(editor), models('synthetic/alpha', 'custom-token'));
  assert.equal(snapshot(editor).changes[0].models[0].variant, 'custom-token');
  replaceModels(editor, firstId(editor), models('synthetic/alpha', ''));
  assert.equal(dirtyGroups(editor).length, 0);
  assert.equal(editor.groups[0].defaultVariant, 'medium');
});

test('read-only groups and queues over the editing limit stay visible and reject mutation', () => {
  const editor = state();
  assert.match(editLimit(editor.groups[2]), /placeholder/);
  assert.throws(() => change(editor, editor.groups[2].id), /read-only/);
  const config = fixture(); config.groups[0].models = Array.from({ length: 51 }, () => models()[0]);
  const long = createEditor(config);
  assert.equal(long.groups[0].models.length, 51);
  assert.match(editLimit(long.groups[0]), /50-position/);
  assert.throws(() => change(long), /read-only/);
  assert.equal(long.groups.length, 3);
});

test('reorder returns the correct focus position and enforces boundaries', () => {
  const editor = state();
  replaceModels(editor, firstId(editor), [...models('synthetic/one'), ...models('synthetic/two'), ...models('synthetic/three')]);
  assert.equal(movePosition(editor, firstId(editor), 0, -1), 0);
  const focusIndex = movePosition(editor, firstId(editor), 0, 1);
  assert.equal(focusIndex, 1);
  assert.equal(editor.groups[0].models[focusIndex].id, 'synthetic/one');
  assert.equal(movePosition(editor, firstId(editor), 2, 1), 2);
});

test('repeated readiness and keyboard-height snapshots apply theme without remounting', () => {
  const applied = []; let mounts = 0; const editor = state(); change(editor);
  const receive = createReadyReceiver(ready => applied.push(ready), () => { mounts += 1; });
  receive({ theme: 'light', device: { keyboard: 0 } });
  receive({ theme: 'dark', device: { keyboard: 300 } });
  receive({ theme: 'dark', device: { keyboard: 0 } });
  assert.equal(applied.length, 3); assert.equal(mounts, 1);
  assert.equal(editor.groups[0].models[0].id, 'synthetic/beta');
});

test('batch preview submits every dirty queue and commit submits only its token', () => {
  const editor = state(); change(editor); change(editor, editor.groups[1].id, 'synthetic/review');
  const saved = snapshot(editor); const body = previewBody(saved);
  assert.equal(body.changes.length, 2);
  assert.deepEqual(Object.keys(body).sort(), ['baseHash', 'changes', 'generation']);
  reviewed(editor);
  assert.deepEqual(beginCommit(editor), { previewToken: 'opaque-token' });
  assert.equal(beginCommit(editor), null);
});

test('a later edit survives the acknowledgment of an earlier save snapshot', () => {
  const editor = state(); change(editor);
  const submitted = reviewed(editor); beginCommit(editor);
  change(editor, firstId(editor), 'synthetic/later');
  acknowledgeSave(editor, submitted, { baseHash: 'after' });
  assert.equal(editor.groups[0].original[0].id, 'synthetic/beta');
  assert.equal(editor.groups[0].models[0].id, 'synthetic/later');
  assert.equal(editor.baseHash, 'after');
  assert.equal(dirtyGroups(editor).length, 1);
  const draft = makeDraft(editor, 'frame-a');
  assert.equal(draft.baseHash, 'after');
  assert.equal(draft.originals[0].models[0].id, 'synthetic/beta');
  assert.equal(draft.changes[0].models[0].id, 'synthetic/later');
});

test('commit acknowledgment must identify the reviewed output and target before clearing a draft', () => {
  const editor = state(); change(editor); const submitted = reviewed(editor);
  const result = { ok: true, baseHash: 'after', target: clone(editor.target), backup: '/scratch/backup', changed: ['builder'] };
  assert.equal(validCommitAcknowledgment(submitted, result), true);
  assert.equal(validCommitAcknowledgment(submitted, { ...result, baseHash: 'before' }), false);
  assert.equal(validCommitAcknowledgment(submitted, { ...result, target: { ...result.target, generation: 'other' } }), false);
  assert.equal(validCommitAcknowledgment(submitted, { ...result, changed: null }), false);
  assert.equal(validCommitAcknowledgment(submitted, { ...result, backup: undefined }), false);
});

test('saved snapshot acknowledgment leaves edits to a different queue dirty', () => {
  const editor = state(); change(editor); const submitted = reviewed(editor); beginCommit(editor);
  change(editor, editor.groups[1].id, 'synthetic/later');
  acknowledgeSave(editor, submitted, { baseHash: 'after' });
  assert.deepEqual(dirtyGroups(editor).map(group => group.id), [editor.groups[1].id]);
});

test('stale preview responses, edited previews, mismatched targets and expired tokens cannot commit', () => {
  const editor = state(); change(editor); const submitted = reviewed(editor);
  change(editor, firstId(editor), 'synthetic/later');
  assert.equal(editor.preview, null);
  assert.equal(acceptPreview(editor, submitted.saved, submitted.result), false);
  assert.equal(beginCommit(editor), null);
  const fresh = snapshot(editor);
  const wrong = { ...submitted.result, target: { ...editor.target, generation: 'generation-b' } };
  assert.equal(acceptPreview(editor, fresh, wrong), false);
  reviewed(editor);
  assert.equal(beginCommit(editor, Date.now() + 120000), null);
});

test('draft recovery is explicit, normalized, target-bound and requires a fresh review', () => {
  const editor = state(); change(editor); const draft = makeDraft(editor, 'frame-a');
  assert.deepEqual(Object.keys(draft).sort(), ['baseHash', 'changes', 'id', 'originals', 'targetPath']);
  const reopened = state();
  assert.equal(dirtyGroups(reopened).length, 0);
  assert.equal(recoveryStatus(reopened, draft), 'available');
  assert.equal(recoverDraft(reopened, draft), true);
  assert.equal(dirtyGroups(reopened).length, 1);
  assert.equal(reopened.preview, null);
  assert.equal(beginCommit(reopened), null);
  assert.equal(recoverDraft(reopened, draft), false);
  assert.equal(recoveryStatus(state(), { ...draft, baseHash: 'obsolete' }), 'stale');
  assert.equal(recoveryStatus(state(), { ...draft, targetPath: '/different/file' }), 'different-target');
});

test('recovery rejects duplicate paths, changed baselines and read-only paths', () => {
  const editor = state(); change(editor); const draft = makeDraft(editor, 'frame-a');
  draft.changes.push(clone(draft.changes[0]));
  assert.equal(recoveryStatus(state(), draft), 'stale');
  draft.changes.pop(); draft.originals[0].models = models('synthetic/wrong');
  assert.equal(recoverDraft(state(), draft), false);
  draft.changes[0].path = fixture().groups[2].path;
  assert.equal(recoveryStatus(state(), draft), 'stale');
});

test('draft snapshots are immutable and separate frame IDs are preserved', () => {
  const editor = state(); change(editor);
  const old = makeDraft(editor, 'frame-a');
  change(editor, firstId(editor), 'synthetic/newer');
  const newer = makeDraft(editor, 'frame-a');
  const separate = makeDraft(editor, 'frame-b');
  assert.equal(old.changes[0].models[0].id, 'synthetic/beta');
  assert.equal(newer.changes[0].models[0].id, 'synthetic/newer');
  assert.notEqual(separate.id, newer.id);
  assert.deepEqual(snapshot(editor).changes, newer.changes);
});

test('delayed discard clears only its acknowledged snapshot and preserves newer edits', () => {
  const editor = state(); change(editor);
  const discarded = clone(editor.groups[0].models);
  const allDiscarded = snapshot(editor);
  change(editor, firstId(editor), 'synthetic/newer');
  assert.equal(discardQueueSnapshot(editor, firstId(editor), discarded), false);
  assert.equal(canDiscardSnapshot(editor, allDiscarded), false);
  assert.equal(editor.groups[0].models[0].id, 'synthetic/newer');
  const current = clone(editor.groups[0].models);
  assert.equal(discardQueueSnapshot(editor, firstId(editor), current), true);
  assert.equal(dirtyGroups(editor).length, 0);
});

test('a discard of one queue does not discard later edits to another queue', () => {
  const editor = state(); change(editor); const discarded = clone(editor.groups[0].models);
  change(editor, editor.groups[1].id, 'synthetic/newer');
  assert.equal(discardQueueSnapshot(editor, firstId(editor), discarded), true);
  assert.deepEqual(dirtyGroups(editor).map(group => group.id), [editor.groups[1].id]);
});

test('unknown outcome blocks write retries until reconciliation', () => {
  const editor = state(); change(editor); reviewed(editor); beginCommit(editor); markUnknown(editor);
  assert.equal(editor.pendingCommit, null); assert.ok(editor.unknown);
  assert.equal(beginCommit(editor), null);
  const saved = snapshot(editor);
  assert.equal(acceptPreview(editor, saved, editor.unknown.result), false);
});

test('reconciliation maps reviewed output, baseline, conflict and changed target truthfully', () => {
  const editor = state(); change(editor); const submitted = reviewed(editor); beginCommit(editor); markUnknown(editor);
  const config = fixture();
  assert.equal(reconciliationKind(submitted, { ...config, baseHash: 'after' }), 'saved');
  assert.equal(reconciliationKind(submitted, config), 'baseline');
  assert.equal(reconciliationKind(submitted, { ...config, baseHash: 'external' }), 'conflict');
  assert.equal(reconciliationKind(submitted, { ...config, target: { ...config.target, generation: 'other' } }), 'unknown');
  assert.equal(reconcile(editor, config), 'baseline');
  assert.equal(editor.unknown, null); assert.equal(editor.preview, null);
  assert.equal(dirtyGroups(editor).length, 1);
  assert.equal(beginCommit(editor), null);
});

test('reconciled save preserves later edits and a conflict never overwrites the local draft', () => {
  const editor = state(); change(editor); reviewed(editor); beginCommit(editor); markUnknown(editor);
  change(editor, firstId(editor), 'synthetic/newer');
  assert.equal(reconcile(editor, { ...fixture(), baseHash: 'after' }), 'saved');
  assert.equal(editor.groups[0].models[0].id, 'synthetic/newer');
  assert.equal(editor.groups[0].original[0].id, 'synthetic/beta');
  reviewed(editor); beginCommit(editor); markUnknown(editor);
  assert.equal(reconcile(editor, { ...fixture(), baseHash: 'outside' }), 'conflict');
  assert.ok(editor.conflict);
  assert.equal(editor.groups[0].models[0].id, 'synthetic/newer');
  assert.equal(beginCommit(editor), null);
});

test('catalog updates and partial catalog errors do not change drafts, selection or filter', () => {
  const editor = state(); change(editor); setFilter(editor, 'builder');
  const before = clone(editor);
  assert.ok(catalogIds(editor, [], 'beta').includes('synthetic/beta'));
  assert.ok(catalogIds(editor, ['synthetic/new'], 'new').includes('synthetic/new'));
  assert.deepEqual(editor, before);
  replaceModels(editor, firstId(editor), models(''));
  assert.equal(validateChanges(editor), false);
  change(editor); assert.equal(validateChanges(editor), true);
});
