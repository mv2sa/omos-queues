import test from 'node:test';
import assert from 'node:assert/strict';
import { describePrimarySlots } from '../../src/backend/primary-slots.js';
import {
  createEditor, beginPrimaryPick, applyPrimaryPick, replaceModels, snapshot, previewBody, makeDraft,
  recoveryStatus, recoverDraft, discardPrimaryCreation, isPendingPrimaryQueue, validateChanges,
  validateDraftChanges, acceptPreview, beginCommit, acknowledgeSave, markUnknown, reconcile,
} from '../../src/page/editor-state.js';

const slot = (agent = 'orchestrator', layout = 'structured', extra = {}) => ({
  preset: 'work', agent,
  modelPath: layout === 'flat' ? ['presets', 'work', agent, 'model'] : ['presets', 'work', 'agents', agent, 'model'],
  existingGroupId: null, defaultVariant: '', canCreate: true, blockedReason: null, ...extra,
});
const config = (slots = [slot()]) => ({ target: { path: '/scratch/config.jsonc', generation: 'g' }, baseHash: 'before',
  groups: [{ id: 'agent', path: ['agents', 'agent', 'model'], name: 'agent', label: 'agent', section: 'Agents',
    kind: 'agent', defaultVariant: '', models: [{ id: 'x/y', variant: '' }], readOnlyReason: null }], primarySlots: slots });
const pick = (editor, agent = 'orchestrator') => applyPrimaryPick(editor, beginPrimaryPick(editor, 'work', agent), 'provider/model');

test('backend-qualified preset names with spaces and non-ASCII stage and recover unchanged', () => {
  const preset = 'Fast modèles';
  const slots = describePrimarySlots({ text: JSON.stringify({presets:{[preset]:{agents:{}}}}), groups:[] });
  const fresh = () => createEditor(config(slots));
  const editor = fresh();
  const group = applyPrimaryPick(editor, beginPrimaryPick(editor,preset,'orchestrator'), 'provider/manual');
  assert.equal(group.path[1],preset);
  assert.equal(recoverDraft(fresh(), makeDraft(editor,'frame')),true);
});

test('only qualified orchestrator slot paths stage and staged groups validate for review', () => {
  for (const layout of ['structured', 'flat']) {
    const editor = createEditor(config([slot('orchestrator', layout)]));
    const group = pick(editor);
    assert.ok(isPendingPrimaryQueue(group));
    assert.equal(validateDraftChanges(editor), true);
    assert.equal(validateChanges(editor), true);
    assert.deepEqual(snapshot(editor).primaryCreations[0].models, [{ id: 'provider/model', variant: '' }]);
  }
  assert.equal(beginPrimaryPick(createEditor(config([slot('build')])), 'work', 'build'), null);
  assert.equal(beginPrimaryPick(createEditor(config([slot('build', 'flat', { blockedReason: null })])), 'work', 'build'), null);
});

test('forged paths, unsafe presets, stale picks, and duplicate creations are refused', () => {
  for (const path of [['elsewhere', 'model'], ['presets', 'work', 'agents', 'build', 'model']]) {
    assert.equal(beginPrimaryPick(createEditor(config([slot('orchestrator', 'structured', { modelPath: path })])), 'work', 'orchestrator'), null);
  }
  assert.equal(beginPrimaryPick(createEditor(config([slot('orchestrator', 'structured', { preset: '__proto__' })])), '__proto__', 'orchestrator'), null);
  const editor = createEditor(config());
  const pending = beginPrimaryPick(editor, 'work', 'orchestrator');
  editor.primarySlots[0].modelPath = ['unexpected', 'path'];
  assert.equal(applyPrimaryPick(editor, pending, 'provider/model'), null);
  const draft = { version: 3, revision: 0, targetPath: editor.target.path, baseHash: editor.baseHash,
    originals: [], changes: [], marketplace: null, primaryCreations: [
      { preset: 'work', agent: 'orchestrator', models: [{ id: 'provider/a', variant: '' }] },
      { preset: 'work', agent: 'orchestrator', models: [{ id: 'provider/b', variant: '' }] },
    ] };
  assert.equal(recoveryStatus(createEditor(config()), draft), 'stale');
  const fresh = createEditor(config());
  assert.equal(recoverDraft(fresh, draft), false);
  assert.deepEqual(fresh.groups.length, 1);
});

test('refuse a 65th first model while the 64 staged queues remain reviewable', () => {
  const presets = Object.fromEntries(Array.from({length:65}, (_, i) => [`p${i}`, {agents:{}}]));
  const editor = createEditor(config(describePrimarySlots({text:JSON.stringify({presets}), groups:[]})));
  for (let i=0; i<64; i++) assert.ok(applyPrimaryPick(editor,beginPrimaryPick(editor,`p${i}`,'orchestrator'),'provider/first'));
  assert.equal(beginPrimaryPick(editor,'p64','orchestrator'),null);
  assert.equal(validateDraftChanges(editor),true);
  assert.equal(validateChanges(editor),true);
  assert.equal(snapshot(editor).primaryCreations.length,64);
});

test('v3 recovery stages only once, and canceling primary retains promoted version and ordinary drafts', () => {
  const editor = createEditor(config());
  const group = pick(editor);
  replaceModels(editor, 'agent', [{ id: 'provider/ordinary', variant: '' }]);
  const draft = makeDraft(editor, 'frame');
  assert.equal(draft.version, 3);
  assert.equal(draft.marketplace, null);
  const recovered = createEditor(config());
  assert.equal(recoveryStatus(recovered, draft), 'available');
  assert.equal(recoverDraft(recovered, draft), true);
  const staged = recovered.groups.find(isPendingPrimaryQueue);
  assert.ok(staged);
  assert.equal(discardPrimaryCreation(recovered, staged.id), true);
  assert.equal(makeDraft(recovered, 'frame').version, 3);
  assert.equal(snapshot(recovered).changes.length, 1);
  assert.equal(isPendingPrimaryQueue(group), true);
});

test('adding a primary stage promotes an existing v2 marketplace draft without losing it', () => {
  const editor = createEditor(config());
  editor.draftVersion = 2;
  editor.marketplace = { sourceGeneration: 'source', catalogFingerprint: 'fingerprint',
    edits: [{ preset: 'work', packageIds: ['publisher/package'], creations: [] }],
    originals: [{ preset: 'work', selectionPresent: false, packageIds: [] }],
    identities: [{ id: 'publisher/package', version: '1.0.0', agentName: 'helper', digest: 'a'.repeat(64) }] };
  pick(editor);
  const draft = makeDraft(editor, 'frame');
  assert.equal(draft.version, 3);
  assert.deepEqual(draft.marketplace, editor.marketplace);
  assert.deepEqual(draft.primaryCreations, [{ preset: 'work', agent: 'orchestrator', models: [{ id: 'provider/model', variant: '' }] }]);
});

test('acknowledged primary creation becomes existing baseline; later edit is one ordinary change', () => {
  const editor = createEditor(config());
  const group = pick(editor);
  const saved = snapshot(editor);
  const target = { path: editor.target.path, generation: 'g' };
  assert.equal(acceptPreview(editor, saved, { diff: 'diff', changed: ['primary'], afterHash: 'after', baseHash: 'before',
    target, previewToken: 'token', expiresAt: Date.now() + 10000 }), true);
  assert.ok(beginCommit(editor));
  replaceModels(editor, group.id, [{ id: 'provider/later', variant: '' }]);
  acknowledgeSave(editor, { saved, result: { afterHash: 'after' } }, { baseHash: 'after' });
  const next = previewBody(snapshot(editor));
  assert.equal(Object.hasOwn(next, 'primaryCreations'), false);
  assert.equal(next.changes.length, 1);
  assert.deepEqual(next.changes[0], { path: slot().modelPath, models: [{ id: 'provider/later', variant: '' }] });
  assert.deepEqual(group.original, [{ id: 'provider/model', variant: '' }]);
});

test('unknown primary save reconciles afterHash without retry and hydrates existing slot', () => {
  const editor = createEditor(config());
  const group = pick(editor);
  const saved = snapshot(editor);
  const target = { path: editor.target.path, generation: 'g' };
  acceptPreview(editor, saved, { diff: 'diff', changed: ['primary'], afterHash: 'after', baseHash: 'before',
    target, previewToken: 'token', expiresAt: Date.now() + 10000 });
  beginCommit(editor);
  markUnknown(editor);
  const serverConfig = { ...config([slot('orchestrator', 'structured', { existingGroupId: group.id, canCreate: false })]),
    baseHash: 'after', groups: [...config().groups, { id: group.id, path: slot().modelPath, name: 'orchestrator',
      label: 'preset work · orchestrator', section: 'Preset · work', kind: 'preset', defaultVariant: '',
      models: [{ id: 'provider/model', variant: '' }], readOnlyReason: null }] };
  assert.equal(reconcile(editor, serverConfig), 'saved');
  assert.equal(editor.primaryCreations.length, 0);
  assert.equal(editor.primarySlots[0].existingGroupId, group.id);
  assert.equal(editor.groups.find(item => item.id === group.id).primaryCreation, undefined);
  assert.equal(beginPrimaryPick(editor, 'work', 'orchestrator'), null);
});
