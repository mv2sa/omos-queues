import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clone, createEditor, replaceModels, snapshot, previewBody, makeDraft, recoveryStatus, recoverDraft,
  dirtyGroups, hasPendingEdits, draftHasOperations, marketplacePackageIds, marketplaceProblem,
  stageMarketplaceSelection, beginMarketplacePick, applyMarketplacePick, discardMarketplaceCreation, discardMarketplaceStages,
  bindMarketplaceView, markMarketplaceUnavailable, isPendingMarketplaceQueue, marketplaceAgentPresentation,
  validateChanges, validateDraftChanges, acceptPreview, beginCommit, acknowledgeSave, markUnknown, reconcile,
  mergeSavedConfig, recheckMarketplaceDraft, validMarketplaceRecord, inspectableDraft,
} from '../../src/page/editor-state.js';
import { createDraftController, reloadDisposition } from '../../src/page/controller.js';
import { normalizeMarketplaceCatalog, normalizeMarketplaceConfig, createMarketplaceController } from '../../src/page/marketplace.js';

const A = 'fixture/cleaner'; const B = 'fixture/scribe';
const models = (id = 'fixture/model', variant = '') => [{ id, variant }];
const pkg = (id, name, digit, modelSource = 'session') => ({ id, version: '1.2.3', agentName: name, displayName: `${name} package`,
  modelSource, digest: digit.repeat(64), blockedReason: null });
const catalog = () => ({ state: 'ready', adapterVersion: 'omos-marketplace-lock-v2', generation: 'source-a', fingerprint: '1'.repeat(64), readAt: 1234,
  packages: [pkg(A, 'cleaner', 'a'), pkg(B, 'scribe', 'b', 'orchestrator')] });
function config() {
  const path = ['agents', 'regular', 'model'];
  return { target: { path: '/isolated/omos.jsonc', logicalPath: '/isolated/omos.jsonc', generation: 'target-a' }, baseHash: 'a'.repeat(64),
    groups: [{ id: JSON.stringify(path), path, name: 'regular', label: 'regular', section: 'Agents', kind: 'agent', models: models(), defaultVariant: 'high', readOnlyReason: null }] };
}
function projection(base = config()) {
  const installed = catalog();
  return { target: clone(base.target), baseHash: base.baseHash, catalog: installed, masterEnabled: true, activePreset: 'base',
    presets: ['base', 'other'].map((name, index) => ({ name, layout: index ? 'flat' : 'structured', editable: true, reason: null,
      selectionPresent: false, packageIds: [], agents: installed.packages.map(item => ({ packageId: item.id, agentName: item.agentName, selected: false,
        existingGroupId: null, modelPath: index ? ['presets', name, item.agentName, 'model'] : ['presets', name, 'agents', item.agentName, 'model'], defaultVariant: '', canCreate: true, blockedReason: null })) })) };
}
function editor() { const state = createEditor(config()); assert.equal(bindMarketplaceView(state, projection()), true); return state; }
const existingQueueReason = 'An explicit model queue already exists; edit it in the editor.';
function existingOverride(state, { selected = false } = {}) {
  const view = projection(); const preset = view.presets[0]; const agent = preset.agents[0];
  const path = clone(agent.modelPath); const id = JSON.stringify(path);
  state.groups.push({ id, path, name: 'cleaner', label: 'preset base · cleaner', section: 'Preset base', kind: 'preset',
    models: models(), original: models(), readOnlyReason: null, defaultVariant: '' });
  preset.selectionPresent = selected; preset.packageIds = selected ? [A] : [];
  Object.assign(agent, { selected, existingGroupId: id, canCreate: false, blockedReason: existingQueueReason });
  assert.equal(bindMarketplaceView(state, normalizeMarketplaceConfig(view)), true);
  return id;
}
function select(state, id = A, preset = 'base') { stageMarketplaceSelection(state, preset, id, true); }
function create(state, id = A, preset = 'base', model = 'fixture/new') { return applyMarketplacePick(state, beginMarketplacePick(state, preset, id), model); }
function reviewed(state) {
  const saved = snapshot(state); const result = { target: clone(state.target), baseHash: state.baseHash, afterHash: 'b'.repeat(64), diff: '+ staged marketplace change', changed: ['Marketplace base'],
    previewToken: 'opaque-token', expiresAt: Date.now() + 60000, ...(saved.marketplace ? { marketplaceBinding: {
      sourceGeneration: saved.marketplace.sourceGeneration, catalogFingerprint: saved.marketplace.catalogFingerprint } } : {}) };
  assert.equal(acceptPreview(state, saved, result), true); return clone(state.preview);
}
function actualAfter(state, submitted) {
  const result = config(); result.baseHash = submitted.result.afterHash;
  for (const edit of submitted.saved.marketplace?.edits || []) for (const creation of edit.creations) {
    const staged = state.groups.find(group => group.marketplaceCreation?.preset === edit.preset && group.marketplaceCreation.packageId === creation.packageId);
    const group = clone(staged); delete group.marketplaceCreation; delete group.original; group.models = clone(creation.models); result.groups.push(group);
  }
  return result;
}
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const frameId = '12345678-1234-4234-8234-123456789abc';

test('installed metadata projection is bounded, versioned and excludes private package content', () => {
  const value = normalizeMarketplaceConfig(projection());
  assert.equal(value.catalog.packages[0].agentName, 'cleaner'); assert.equal(value.presets[1].layout, 'flat');
  const extra = catalog(); extra.packages[0].prompt = 'PRIVATE_CANARY';
  assert.throws(() => normalizeMarketplaceCatalog(extra), error => !error.message.includes('PRIVATE_CANARY'));
  const duplicate = catalog(); duplicate.packages.push(clone(duplicate.packages[0]));
  assert.throws(() => normalizeMarketplaceCatalog(duplicate), /invalid or too large/);
  const unsafe = catalog(); unsafe.packages[0].id = '../escape'; assert.throws(() => normalizeMarketplaceCatalog(unsafe));
  const badPath = projection(); badPath.presets[0].agents[0].modelPath = ['agents', 'arbitrary', 'model'];
  assert.throws(() => normalizeMarketplaceConfig(badPath), /not qualified/);
});

test('unready catalogs never become authoritative empty package lists', () => {
  for (const state of ['not-configured', 'unavailable', 'unsupported']) {
    const value = normalizeMarketplaceCatalog({ state, generation: 'source-a', error: { code: 'EXPECTED', message: state } });
    assert.equal(Object.hasOwn(value, 'packages'), false);
    assert.throws(() => normalizeMarketplaceCatalog({ ...value, packages: [] }));
  }
});

test('selecting a package stages only a selection, shares revision and creates no inherited model node', () => {
  const state = editor(); const before = clone(state.marketplaceView); select(state);
  assert.equal(state.revision, 1); assert.equal(state.groups.length, 1); assert.equal(state.draftVersion, 2);
  assert.deepEqual(snapshot(state).changes, []); assert.deepEqual(previewBody(snapshot(state)).marketplace.edits,
    [{ preset: 'base', packageIds: [A], creations: [] }]);
  assert.deepEqual(state.marketplaceView, before);
  assert.equal(state.marketplaceView.activePreset, 'base'); assert.equal(state.marketplaceView.masterEnabled, true);
  assert.equal(hasPendingEdits(state), true); assert.equal(reloadDisposition(state, ''), 'confirm'); assert.equal(validateChanges(state), true);
});

test('an unchanged package check is a no-op and absent selection stays absent on local revert', () => {
  const state = editor(); assert.equal(stageMarketplaceSelection(state, 'base', A, false), false);
  assert.equal(state.revision, 0); assert.equal(state.draftVersion, 1);
  select(state); stageMarketplaceSelection(state, 'base', A, false);
  assert.equal(state.marketplace, null); assert.equal(state.marketplaceView.presets[0].selectionPresent, false);
  assert.equal(state.draftVersion, 2); assert.equal(draftHasOperations(makeDraft(state, 'frame-a')), false);
});

test('override creation is staged in the picker until a valid model is chosen', () => {
  const state = editor(); select(state); const before = clone(state);
  const pending = beginMarketplacePick(state, 'base', A); assert.equal(state.groups.length, 1);
  assert.equal(applyMarketplacePick(state, pending, ''), null); assert.deepEqual(state, before);
  const group = applyMarketplacePick(state, pending, 'fixture/valid');
  assert.ok(isPendingMarketplaceQueue(group)); assert.deepEqual(group.models, models('fixture/valid')); assert.deepEqual(group.original, []);
  assert.equal(group.defaultVariant, ''); assert.equal(state.marketplace.edits[0].creations.length, 1);
  assert.deepEqual(snapshot(state).changes, []);
});

test('a later edit invalidates an open package picker without losing either queue or selection', () => {
  const state = editor(); select(state); const pending = beginMarketplacePick(state, 'base', A);
  replaceModels(state, state.groups[0].id, models('fixture/later'));
  assert.equal(applyMarketplacePick(state, pending, 'fixture/stale'), null);
  assert.equal(state.groups.length, 1); assert.deepEqual(marketplacePackageIds(state, 'base'), [A]);
  assert.equal(state.groups[0].models[0].id, 'fixture/later');
});

test('new queues use normal model normalization and join selection/ordinary edits in one strict preview body', () => {
  const state = editor(); select(state); const group = create(state);
  replaceModels(state, group.id, [{ id: 'fixture/one', variant: 'low', extra: 'not persisted' }, { id: 'fixture/two', variant: '' }]);
  replaceModels(state, state.groups[0].id, models('fixture/ordinary', 'high'));
  const body = previewBody(snapshot(state));
  assert.equal(body.changes.length, 1); assert.equal(body.marketplace.edits.length, 1);
  assert.deepEqual(Object.keys(body.marketplace).sort(), ['catalogFingerprint', 'edits', 'sourceGeneration']);
  assert.deepEqual(body.marketplace.edits[0].creations[0], { packageId: A, models: [{ id: 'fixture/one', variant: 'low' }, { id: 'fixture/two', variant: '' }] });
  assert.equal(body.changes.some(change => JSON.stringify(change.path) === group.id), false);
});

test('multiple preset stages remain independent and never change active preset/master', () => {
  const state = editor(); select(state); create(state); select(state, B, 'other'); create(state, B, 'other', 'fixture/second');
  const saved = snapshot(state);
  assert.equal(saved.marketplace.edits.length, 2); assert.equal(saved.marketplace.originals.length, 2); assert.equal(saved.marketplace.identities.length, 2);
  assert.equal(state.marketplaceView.activePreset, 'base'); assert.equal(state.marketplaceView.masterEnabled, true);
  assert.deepEqual(state.groups[2].path, ['presets', 'other', 'scribe', 'model']);
});

test('blocked presets, root shadows, custom collisions, built-ins and unavailable sources have no staging checkbox', () => {
  const changes = [
    view => { view.presets[0].editable = false; view.presets[0].reason = 'Preset uses extends.'; },
    view => { view.masterEnabled = false; },
    view => { view.presets[0].agents[0].canCreate = false; view.presets[0].agents[0].blockedReason = 'Root override shadows this agent.'; },
    view => { view.presets[0].agents[0].canCreate = false; view.presets[0].agents[0].blockedReason = 'Custom identity collision.'; },
    view => { view.catalog.packages[0].modelSource = 'builtin'; view.catalog.packages[0].blockedReason = 'Built-in inheritance is unsupported.'; },
  ];
  for (const change of changes) {
    const state = editor(); const view = projection(); change(view); bindMarketplaceView(state, view);
    assert.equal(marketplaceAgentPresentation(state, 'base', A).canSelect, false);
    assert.throws(() => select(state)); assert.equal(hasPendingEdits(state), false);
  }
  const state = editor(); markMarketplaceUnavailable(state);
  assert.throws(() => select(state)); assert.equal(marketplaceAgentPresentation(state, 'base', A).canSelect, false);
});

test('already-selected overrides retain their selection and queue link while blocking orphaning or duplicate creation', () => {
  const state = editor(); const id = existingOverride(state, { selected: true }); const before = clone(state);
  assert.equal(stageMarketplaceSelection(state, 'base', A, true), false); assert.deepEqual(state, before);
  const presentation = marketplaceAgentPresentation(state, 'base', A);
  assert.equal(presentation.queueId, id); assert.equal(presentation.selected, true); assert.equal(presentation.canSelect, true);
  assert.equal(presentation.blockedReason, ''); assert.equal(presentation.canOverride, false); assert.equal(presentation.deselectBlocked, true);
  replaceModels(state, id, models('fixture/ordinary-override-edit')); select(state, B);
  const draft = makeDraft(state, frameId); const staged = clone(state);
  assert.equal(marketplaceProblem(state), null); assert.equal(validateChanges(state), true);
  assert.throws(() => stageMarketplaceSelection(state, 'base', A, false), /orphan/);
  assert.throws(() => beginMarketplacePick(state, 'base', A)); assert.deepEqual(state, staged);
  assert.equal(stageMarketplaceSelection(state, 'base', A, true), false); assert.deepEqual(state, staged);
  const reopened = editor(); existingOverride(reopened, { selected: true });
  assert.equal(recoveryStatus(reopened, draft), 'available'); assert.equal(recoverDraft(reopened, draft), true);
  assert.deepEqual(marketplacePackageIds(reopened, 'base'), [A, B]);
  assert.deepEqual(reopened.groups.find(group => group.id === id).models, models('fixture/ordinary-override-edit'));
});

test('unselected packages with an explicit queue cannot stage selection but keep ordinary editing and Edit queue identity', () => {
  const state = editor(); const id = existingOverride(state);
  replaceModels(state, state.groups[0].id, models('fixture/unrelated-draft')); const before = clone(state);
  const presentation = marketplaceAgentPresentation(state, 'base', A);
  assert.equal(presentation.selected, false); assert.equal(presentation.canSelect, false); assert.equal(presentation.canOverride, false);
  assert.equal(presentation.blockedReason, existingQueueReason); assert.equal(presentation.queueId, id);
  assert.throws(() => select(state), { message: existingQueueReason }); assert.deepEqual(state, before);
  assert.equal(stageMarketplaceSelection(state, 'base', A, false), false); assert.deepEqual(state, before);
  replaceModels(state, id, models('fixture/edit-existing-only'));
  assert.deepEqual(snapshot(state).changes.map(change => change.models[0].id), ['fixture/unrelated-draft', 'fixture/edit-existing-only']);
  assert.equal(snapshot(state).marketplace, undefined); assert.equal(validateChanges(state), true);
  assert.equal(marketplaceAgentPresentation(state, 'base', A).queueId, id);
});

test('a stale draft newly selecting a colliding explicit queue stays inspectable but cannot recover or rebind', () => {
  const prior = editor(); select(prior); const draft = makeDraft(prior, frameId); const original = clone(draft);
  const reopened = editor(); const id = existingOverride(reopened); const before = clone(reopened);
  assert.equal(inspectableDraft(draft).status, 'normalized-edits');
  assert.equal(recoveryStatus(reopened, draft), 'stale-marketplace'); assert.equal(recoverDraft(reopened, draft), false);
  assert.throws(() => recheckMarketplaceDraft(reopened, draft), /restage/);
  assert.deepEqual(reopened, before); assert.deepEqual(draft, original);
  assert.equal(marketplaceAgentPresentation(reopened, 'base', A).queueId, id);
});

test('current staged checks do not override the on-disk baseline for collision eligibility or review', () => {
  const state = editor(); select(state); reviewed(state); const stage = clone(state.marketplace);
  const id = existingOverride(state);
  assert.deepEqual(marketplacePackageIds(state, 'base'), [A]); assert.deepEqual(state.marketplace.originals[0].packageIds, []);
  const presentation = marketplaceAgentPresentation(state, 'base', A);
  assert.equal(presentation.selected, true); assert.equal(presentation.canSelect, false); assert.equal(presentation.queueId, id);
  assert.equal(presentation.blockedReason, existingQueueReason); assert.equal(marketplaceProblem(state), existingQueueReason);
  assert.equal(validateChanges(state), false); assert.equal(state.preview, null); assert.deepEqual(state.marketplace, stage);
  const before = clone(state); assert.equal(stageMarketplaceSelection(state, 'base', A, true), false); assert.deepEqual(state, before);
  assert.throws(() => stageMarketplaceSelection(state, 'base', A, false), { message: existingQueueReason }); assert.deepEqual(state, before);
  const toggled = editor(); select(toggled); stageMarketplaceSelection(toggled, 'base', A, false);
  existingOverride(toggled); const reverted = clone(toggled);
  assert.throws(() => select(toggled), { message: existingQueueReason }); assert.deepEqual(toggled, reverted);
});

test('a late creation acknowledgment advances selection eligibility to retained while preserving newer drafts', () => {
  const state = editor(); select(state); const group = create(state); const submitted = reviewed(state); beginCommit(state);
  select(state, B); replaceModels(state, state.groups[0].id, models('fixture/later-ordinary'));
  acknowledgeSave(state, submitted, { baseHash: submitted.result.afterHash });
  assert.deepEqual(state.marketplace.originals[0].packageIds, [A]);
  assert.equal(state.marketplaceView.presets[0].agents[0].selected, true);
  const view = clone(state.marketplaceView); Object.assign(view.presets[0].agents[0], { blockedReason: existingQueueReason, canCreate: false });
  assert.equal(bindMarketplaceView(state, normalizeMarketplaceConfig(view)), true);
  const presentation = marketplaceAgentPresentation(state, 'base', A);
  assert.equal(presentation.selected, true); assert.equal(presentation.canSelect, true); assert.equal(presentation.blockedReason, '');
  assert.equal(presentation.deselectBlocked, true); assert.equal(presentation.queueId, group.id);
  assert.equal(validateChanges(state), true); assert.equal(marketplaceProblem(state), null);
  const before = clone(state); assert.equal(stageMarketplaceSelection(state, 'base', A, true), false); assert.deepEqual(state, before);
  assert.throws(() => stageMarketplaceSelection(state, 'base', A, false), /orphan/); assert.deepEqual(state, before);
  assert.deepEqual(marketplacePackageIds(state, 'base'), [A, B]);
  assert.deepEqual(state.groups[0].models, models('fixture/later-ordinary'));
});

test('unknown existing selections are retained unchanged while a verified package can be staged', () => {
  const state = editor(); const view = projection(); const preset = view.presets[0];
  preset.selectionPresent = true; preset.packageIds = ['legacy-id'];
  preset.agents.push({ packageId: 'legacy-id', agentName: null, selected: true, existingGroupId: null, modelPath: null, defaultVariant: '', canCreate: false, blockedReason: 'Unknown installed package identity.' });
  bindMarketplaceView(state, normalizeMarketplaceConfig(view)); select(state);
  assert.deepEqual(marketplacePackageIds(state, 'base'), ['legacy-id', A]);
  assert.equal(marketplaceAgentPresentation(state, 'base', 'legacy-id').canSelect, false);
  assert.throws(() => stageMarketplaceSelection(state, 'base', 'legacy-id', false));
});

test('pending queues preserve qualified preset variant inheritance without inventing explicit variants', () => {
  const state = editor(); const view = projection(); view.presets[0].agents[0].defaultVariant = 'high';
  bindMarketplaceView(state, normalizeMarketplaceConfig(view)); select(state); const group = create(state);
  assert.equal(group.defaultVariant, 'high'); assert.deepEqual(group.models, models('fixture/new', ''));
  assert.deepEqual(snapshot(state).marketplace.edits[0].creations[0].models, models('fixture/new', ''));
  view.presets[0].agents[0].defaultVariant = '${UNRESOLVED}';
  assert.throws(() => normalizeMarketplaceConfig(view), /default variant/);
});

test('discarding a pending creation is explicit, leaves its selection and keeps ordinary drafts', () => {
  const state = editor(); replaceModels(state, state.groups[0].id, models('fixture/ordinary')); select(state); const group = create(state);
  assert.throws(() => stageMarketplaceSelection(state, 'base', A, false), /Discard the staged/);
  assert.equal(discardMarketplaceCreation(state, group.id), true); assert.equal(state.groups.length, 1);
  assert.deepEqual(marketplacePackageIds(state, 'base'), [A]); assert.equal(state.groups[0].models[0].id, 'fixture/ordinary');
  stageMarketplaceSelection(state, 'base', A, false);
  const draft = makeDraft(state, 'frame-a'); assert.equal(draft.version, 2); assert.equal(draft.marketplace, null); assert.equal(draft.changes.length, 1);
});

test('discard-all marketplace stages preserves ordinary edits and promotes no global config setting', () => {
  const state = editor(); select(state); create(state); replaceModels(state, state.groups[0].id, models('fixture/ordinary'));
  discardMarketplaceStages(state);
  assert.equal(state.marketplace, null); assert.equal(state.groups.length, 1); assert.equal(dirtyGroups(state).length, 1); assert.equal(state.draftVersion, 2);
  assert.equal(state.marketplaceView.masterEnabled, true); assert.equal(state.marketplaceView.activePreset, 'base');
});

test('marketplace preview must bind the catalog, and every new stage invalidates a prior review', () => {
  const state = editor(); select(state); const reviewedSnapshot = reviewed(state);
  state.preview = null;
  assert.equal(acceptPreview(state, reviewedSnapshot.saved, { ...reviewedSnapshot.result, marketplaceBinding: null }), false);
  assert.equal(acceptPreview(state, reviewedSnapshot.saved, reviewedSnapshot.result), true);
  select(state, B); assert.equal(state.preview, null);
  assert.equal(acceptPreview(state, reviewedSnapshot.saved, reviewedSnapshot.result), false);
  assert.equal(beginCommit(state), null);
});

test('commit remains token-only and does not discard a newer package check on acknowledgment', () => {
  const state = editor(); select(state); const submitted = reviewed(state);
  assert.deepEqual(beginCommit(state), { previewToken: 'opaque-token' });
  select(state, B);
  acknowledgeSave(state, submitted, { baseHash: submitted.result.afterHash });
  assert.deepEqual(marketplacePackageIds(state, 'base'), [A, B]);
  assert.deepEqual(state.marketplace.originals[0], { preset: 'base', selectionPresent: true, packageIds: [A] });
  assert.equal(hasPendingEdits(state), true); assert.equal(validateChanges(state), true);
});

test('a later unchecked selection that matched the old baseline remains dirty after the earlier save', () => {
  const state = editor(); select(state); const submitted = reviewed(state); beginCommit(state);
  stageMarketplaceSelection(state, 'base', A, false); assert.equal(state.marketplace, null);
  acknowledgeSave(state, submitted, { baseHash: submitted.result.afterHash });
  assert.deepEqual(state.marketplace.edits[0].packageIds, []); assert.deepEqual(state.marketplace.originals[0].packageIds, [A]);
  assert.equal(hasPendingEdits(state), true);
});

test('a late selection acknowledgment retains identity coverage when newer intent moved to another preset', () => {
  const state = editor(); select(state); const submitted = reviewed(state); beginCommit(state);
  stageMarketplaceSelection(state, 'base', A, false); select(state, B, 'other');
  acknowledgeSave(state, submitted, { baseHash: submitted.result.afterHash });
  assert.deepEqual(marketplacePackageIds(state, 'base'), []); assert.deepEqual(marketplacePackageIds(state, 'other'), [B]);
  assert.deepEqual(new Set(state.marketplace.identities.map(item => item.id)), new Set([A, B]));
  assert.equal(validateChanges(state), true);
  assert.equal(recoveryStatus(Object.assign(editor(), { baseHash: state.baseHash, marketplaceView: clone(state.marketplaceView) }), makeDraft(state, 'frame-a')), 'available');
});

test('late creation acknowledgment advances only its model snapshot and leaves newer queues staged', () => {
  const state = editor(); select(state); const first = create(state, A, 'base', 'fixture/reviewed'); const submitted = reviewed(state); beginCommit(state);
  replaceModels(state, first.id, models('fixture/later', 'low'));
  select(state, B); const second = create(state, B, 'base', 'fixture/second');
  acknowledgeSave(state, submitted, { baseHash: submitted.result.afterHash });
  assert.equal(first.marketplaceCreation.saved, true); assert.deepEqual(first.original, models('fixture/reviewed')); assert.deepEqual(first.models, models('fixture/later', 'low'));
  assert.ok(isPendingMarketplaceQueue(second));
  const body = previewBody(snapshot(state));
  assert.deepEqual(body.changes, [{ path: first.path, models: first.models }]);
  assert.deepEqual(body.marketplace.edits[0].creations.map(item => item.packageId), [B]);
  assert.equal(validateChanges(state), true);
});

test('acknowledged new queues become ordinary existing queues and hydration preserves later edits', () => {
  const state = editor(); select(state); const group = create(state); const submitted = reviewed(state);
  assert.equal(isPendingMarketplaceQueue(group), true);
  beginCommit(state);
  acknowledgeSave(state, submitted, { baseHash: submitted.result.afterHash });
  assert.equal(group.marketplaceCreation.saved, true);
  replaceModels(state, group.id, models('fixture/later'));
  assert.equal(mergeSavedConfig(state, actualAfter(state, submitted)), true);
  assert.equal(group.marketplaceCreation, undefined); assert.equal(group.models[0].id, 'fixture/later');
  assert.deepEqual(snapshot(state).changes, [{ path: group.path, models: group.models }]);
  assert.equal(state.draftVersion, 2);
});

test('unknown marketplace saves block retry and reconcile baseline/after/conflict without applying newer intent', () => {
  for (const kind of ['baseline', 'after', 'conflict']) {
    const state = editor(); select(state); const group = create(state); const submitted = reviewed(state); beginCommit(state); markUnknown(state);
    replaceModels(state, group.id, models('fixture/later'));
    assert.equal(beginCommit(state), null);
    const current = kind === 'after' ? actualAfter(state, submitted) : config();
    if (kind === 'conflict') current.baseHash = 'c'.repeat(64);
    assert.equal(reconcile(state, current), kind === 'after' ? 'saved' : kind);
    assert.equal(group.models[0].id, 'fixture/later');
    if (kind === 'after') assert.equal(group.marketplaceCreation, undefined);
    else assert.ok(state.marketplace);
    if (kind === 'conflict') assert.ok(state.conflict);
  }
});

test('source changes preserve inspection/stored intent and require explicit identity-safe recheck', () => {
  const state = editor(); select(state); create(state); reviewed(state);
  const before = clone(state.marketplace); const next = projection(); next.catalog.generation = 'source-b'; next.catalog.fingerprint = '2'.repeat(64);
  bindMarketplaceView(state, next);
  assert.deepEqual(state.marketplace, before); assert.equal(state.preview, null); assert.equal(validateChanges(state), false); assert.equal(validateDraftChanges(state), true);
  const revision = state.revision; bindMarketplaceView(state, next, { recheck: true });
  assert.equal(state.marketplace.sourceGeneration, 'source-b'); assert.equal(state.revision, revision + 1); assert.equal(validateChanges(state), true);
  const changed = clone(next); changed.catalog.packages[0].digest = 'c'.repeat(64); changed.catalog.fingerprint = '3'.repeat(64);
  bindMarketplaceView(state, changed, { recheck: true });
  assert.equal(state.marketplace.catalogFingerprint, '2'.repeat(64)); assert.match(marketplaceProblem(state), /identity changed/);
});

test('v2 drafts store only normalized stages, selection originals and safe identities', () => {
  const state = editor(); select(state); create(state); const draft = makeDraft(state, 'frame-a');
  assert.equal(draft.version, 2); assert.equal(draft.revision, state.revision); assert.deepEqual(draft.changes, []);
  assert.deepEqual(draft.marketplace.originals, [{ preset: 'base', selectionPresent: false, packageIds: [] }]);
  assert.deepEqual(Object.keys(draft.marketplace.identities[0]).sort(), ['agentName', 'digest', 'id', 'version']);
  const text = JSON.stringify(draft);
  assert.equal(text.includes('displayName'), false); assert.equal(text.includes('modelSource'), false); assert.equal(text.includes('rootPath'), false);
});

test('v1 recovery is unchanged; v2 recovery stages only and does not enable packages or write config', () => {
  const state = editor(); replaceModels(state, state.groups[0].id, models('fixture/ordinary')); const v1 = makeDraft(state, 'old-frame');
  const old = editor(); assert.equal(recoveryStatus(old, v1), 'available'); assert.equal(recoverDraft(old, v1), true);
  assert.equal(old.draftVersion, 1);
  select(state); create(state); const v2 = makeDraft(state, 'new-frame'); const reopened = editor();
  assert.equal(recoveryStatus(reopened, v2), 'available'); assert.equal(recoverDraft(reopened, v2), true);
  assert.equal(reopened.groups.length, 2); assert.equal(reopened.draftVersion, 2); assert.ok(isPendingMarketplaceQueue(reopened.groups[1]));
  assert.deepEqual(reopened.marketplaceView.presets[0].packageIds, []); assert.equal(reopened.marketplaceView.activePreset, 'base');
  assert.equal(beginCommit(reopened), null); assert.equal(reopened.preview, null);
});

test('stale target/hash/package identity blocks v2 recovery; generation-only rebind is explicit and identity checked', () => {
  const state = editor(); select(state); create(state); const draft = makeDraft(state, 'frame-a');
  const reopened = editor();
  assert.equal(recoveryStatus(reopened, { ...draft, targetPath: '/different' }), 'different-target');
  assert.equal(recoveryStatus(reopened, { ...draft, baseHash: 'changed' }), 'stale');
  const view = projection(); view.catalog.generation = 'source-b'; view.catalog.fingerprint = '2'.repeat(64); bindMarketplaceView(reopened, view);
  assert.equal(recoveryStatus(reopened, draft), 'stale-marketplace'); assert.equal(recoverDraft(reopened, draft), false);
  const checked = recheckMarketplaceDraft(reopened, draft); assert.equal(checked.marketplace.sourceGeneration, 'source-b');
  assert.equal(draft.marketplace.sourceGeneration, 'source-a'); assert.equal(recoveryStatus(reopened, checked), 'available');
  view.catalog.packages[0].digest = 'c'.repeat(64); bindMarketplaceView(reopened, view);
  assert.throws(() => recheckMarketplaceDraft(reopened, draft), /restage/);
});

test('unknown draft versions and malformed/private stage data remain inspect-only', () => {
  const state = editor(); const future = { version: 99, targetPath: state.target.path, baseHash: state.baseHash, changes: [], originals: [] };
  assert.equal(recoveryStatus(state, future), 'unsupported-version'); assert.equal(recoverDraft(state, future), false);
  select(state); const bad = makeDraft(state, 'frame-a'); bad.marketplace.privatePrompt = 'CANARY';
  assert.equal(validMarketplaceRecord(bad.marketplace), false);
  assert.equal(recoveryStatus(editor(), bad), 'stale-marketplace');
});

test('draft persistence promotes v1 to v2, preserves stale stages for inspection and skips empty records', async () => {
  const state = editor(); const calls = [];
  const drafts = createDraftController({ getState: () => state, getId: () => 'frame-a', request: async (path, body, method) => { calls.push({ path, body: body && clone(body), method }); } });
  replaceModels(state, state.groups[0].id, models('fixture/ordinary')); await drafts.persist(); assert.equal(calls[0].body.version, undefined);
  select(state); create(state); markMarketplaceUnavailable(state);
  await drafts.persist(); assert.equal(calls[1].body.version, 2); assert.equal(calls[1].body.marketplace.sourceGeneration, 'source-a');
  discardMarketplaceStages(state); await drafts.persist(); assert.equal(calls[2].body.version, 2); assert.equal(calls[2].body.marketplace, null);
  replaceModels(state, state.groups[0].id, state.groups[0].original); await drafts.persist(); assert.equal(calls.at(-1).method, 'DELETE');
});

test('a delayed draft acknowledgment cannot replace newer package or model intent', async () => {
  const state = editor(); select(state); const started = deferred(); const pending = deferred(); const writes = [];
  const drafts = createDraftController({ getState: () => state, getId: () => 'frame-a', request: async (path, body) => {
    writes.push(clone(body)); if (writes.length === 1) { started.resolve(); await pending.promise; }
  } });
  const first = drafts.persist(); await started.promise; select(state, B); const group = create(state, B); replaceModels(state, group.id, models('fixture/later'));
  const second = drafts.persist(); pending.resolve(); await Promise.all([first, second]);
  assert.deepEqual(writes.at(-1).marketplace.edits[0].packageIds, [A, B]);
  assert.deepEqual(writes.at(-1).marketplace.edits[0].creations[0].models, models('fixture/later'));
});

test('marketplace read/settings routes are explicit and staging performs no source/config/context writes', async () => {
  const state = editor(); const calls = [];
  const source = createMarketplaceController({ getEditor: () => state, request: async (path, body) => {
    calls.push({ path, body }); if (path === '/marketplace/source') return { rootPath: '/isolated/store', generation: 'source-a' };
    return projection();
  } });
  assert.deepEqual(calls, []); await source.refresh();
  select(state); create(state); assert.deepEqual(calls.map(call => call.path), ['/marketplace/source', '/marketplace/config']);
  assert.equal(calls.some(call => call.body), false);
  assert.equal(state.marketplaceView.masterEnabled, true); assert.equal(state.marketplaceView.activePreset, 'base');
});

test('source settings use only rootPath; a failed refresh is not empty success or a core editing failure', async () => {
  const state = editor(); const calls = []; let broken = false;
  const source = createMarketplaceController({ getEditor: () => state, request: async (path, body) => {
    calls.push({ path, body }); if (broken) throw new Error('source unavailable');
    return path === '/marketplace/source' ? { rootPath: body?.rootPath || '/isolated/store', generation: 'source-a' } : projection();
  } });
  await source.configure('/isolated/store'); assert.deepEqual(calls[0], { path: '/marketplace/source', body: { rootPath: '/isolated/store' } });
  broken = true; await source.refresh(); assert.match(source.getState().error, /source unavailable/);
  replaceModels(state, state.groups[0].id, models('fixture/ordinary')); assert.equal(validateChanges(state), true);
  assert.equal(source.getState().catalog.state, 'ready'); // Retained metadata is not accepted for new stages.
  assert.throws(() => select(state));
});

test('stale marketplace failure cannot poison a newer editor target', async () => {
  let state = editor(); const pending = deferred(); const started = deferred();
  const source = createMarketplaceController({ getEditor: () => state, request: async () => { started.resolve(); return pending.promise; } });
  const reading = source.refresh(); await started.promise;
  state = editor(); state.target.generation = 'target-b'; pending.reject(new Error('old failure')); await reading;
  assert.equal(state.marketplaceUnavailable, false); assert.equal(source.getState().error, null);
});

test('v1 inspection explicitly normalizes entries and drops all unknown nested fields without mutating input', () => {
  const state = editor(); replaceModels(state, state.groups[0].id, models('fixture/edited', 'low'));
  const draft = makeDraft(state, frameId); draft.updatedAt = '2026-11-16T12:00:00.000Z'; draft.privatePrompt = 'ROOT_CANARY';
  for (const entry of [...draft.originals, ...draft.changes]) {
    entry.credentials = { token: 'ENTRY_CANARY' }; entry.models[0].extra = { privatePrompt: 'MODEL_CANARY' };
  }
  const before = clone(draft); const inspection = inspectableDraft(draft);
  assert.equal(inspection.status, 'normalized-edits'); assert.equal(inspection.version, 1); assert.equal(inspection.id, frameId);
  assert.equal(inspection.updatedAt, draft.updatedAt); assert.deepEqual(inspection.changes, [{ path: state.groups[0].path, models: models('fixture/edited', 'low') }]);
  assert.deepEqual(inspection.originals, [{ path: state.groups[0].path, models: models() }]);
  assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.deepEqual(draft, before);
  inspection.changes[0].models[0].id = 'fixture/display-only'; inspection.changes[0].path[0] = 'display-only';
  assert.deepEqual(draft, before);
});

test('valid v2 inspection projects allowed fields at every marketplace level, without invoking toJSON', () => {
  const state = editor(); select(state); create(state); const draft = makeDraft(state, frameId); let calls = 0;
  for (const object of [draft, draft.marketplace, draft.marketplace.edits[0], draft.marketplace.edits[0].creations[0],
    draft.marketplace.edits[0].creations[0].models[0], draft.marketplace.originals[0], draft.marketplace.identities[0]]) {
    Object.defineProperty(object, 'toJSON', { value: () => { calls += 1; return { privatePrompt: 'SERIALIZER_CANARY' }; } });
  }
  assert.equal(validMarketplaceRecord(draft.marketplace), true);
  const inspection = inspectableDraft(draft); assert.equal(inspection.status, 'normalized-edits'); assert.equal(calls, 0);
  assert.deepEqual(Object.keys(inspection.marketplace).sort(), ['catalogFingerprint', 'edits', 'identities', 'originals', 'sourceGeneration']);
  assert.deepEqual(inspection.marketplace.edits[0], { preset: 'base', packageIds: [A], creations: [{ packageId: A, models: models('fixture/new') }] });
  assert.deepEqual(inspection.marketplace.originals[0], { preset: 'base', selectionPresent: false, packageIds: [] });
  assert.deepEqual(inspection.marketplace.identities[0], { id: A, version: '1.2.3', agentName: 'cleaner', digest: 'a'.repeat(64) });
  assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.equal(calls, 0);
  inspection.marketplace.edits[0].packageIds.push(B); inspection.marketplace.edits[0].creations[0].models[0].variant = 'high';
  inspection.marketplace.identities[0].digest = 'c'.repeat(64); inspection.marketplace.originals[0].packageIds.push(B);
  assert.deepEqual(draft.marketplace.edits[0].packageIds, [A]); assert.equal(draft.marketplace.edits[0].creations[0].models[0].variant, '');
  assert.equal(draft.marketplace.identities[0].digest, 'a'.repeat(64)); assert.deepEqual(draft.marketplace.originals[0].packageIds, []);
});

test('inspection retains a 129-character canonical package across selection, creation and verified identity', () => {
  const packageId = `${'a'.repeat(64)}/${'b'.repeat(64)}`; assert.equal(packageId.length, 129);
  const state = editor(); const view = projection(); view.catalog.packages[0].id = packageId;
  for (const preset of view.presets) preset.agents[0].packageId = packageId;
  bindMarketplaceView(state, normalizeMarketplaceConfig(view)); select(state, packageId); create(state, packageId);
  const draft = makeDraft(state, frameId); draft.privatePrompt = 'BOUNDARY_ROOT_CANARY'; const before = clone(draft);
  assert.equal(validMarketplaceRecord(draft.marketplace), true);
  const inspection = inspectableDraft(draft); assert.equal(inspection.status, 'normalized-edits');
  assert.deepEqual(inspection.marketplace.edits[0].packageIds, [packageId]);
  assert.equal(inspection.marketplace.edits[0].creations[0].packageId, packageId);
  assert.equal(inspection.marketplace.identities[0].id, packageId);
  assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.deepEqual(draft, before);
});

test('inspection shows 500-character retained opaque selection IDs without granting creation authority', () => {
  const opaque = 'legacy-'.padEnd(500, 'x'); assert.equal(opaque.length, 500);
  const state = editor(); const view = projection(); const preset = view.presets[0];
  preset.selectionPresent = true; preset.packageIds = [opaque];
  preset.agents.push({ packageId: opaque, agentName: null, selected: true, existingGroupId: null, modelPath: null,
    defaultVariant: '', canCreate: false, blockedReason: 'Unknown installed package identity.' });
  bindMarketplaceView(state, normalizeMarketplaceConfig(view)); select(state); create(state);
  const draft = makeDraft(state, frameId); const before = clone(draft); const inspection = inspectableDraft(draft);
  assert.equal(inspection.status, 'normalized-edits');
  assert.deepEqual(inspection.marketplace.edits[0].packageIds, [opaque, A]);
  assert.deepEqual(inspection.marketplace.originals[0].packageIds, [opaque]);
  assert.deepEqual(inspection.marketplace.edits[0].creations.map(creation => creation.packageId), [A]);
  assert.deepEqual(inspection.marketplace.identities.map(identity => identity.id), [A]);
  assert.throws(() => beginMarketplacePick(state, 'base', opaque));
  assert.throws(() => stageMarketplaceSelection(state, 'base', opaque, false));
  assert.equal(state.groups.length, 2); assert.deepEqual(draft, before);
});

test('boundary-aligned inspection still withholds oversized or invalid creation bodies and secret extra fields', () => {
  const state = editor(); select(state); create(state);
  for (const inject of [
    draft => { const id = 'x'.repeat(130); draft.marketplace.edits[0].packageIds.push(id); draft.marketplace.edits[0].creations[0].packageId = id; },
    draft => { const id = 'legacy-'.padEnd(500, 'x'); draft.marketplace.edits[0].packageIds.push(id); draft.marketplace.edits[0].creations[0].packageId = id; },
    draft => { draft.marketplace.edits[0].packageIds.push('x'.repeat(501)); },
    draft => { draft.marketplace.edits[0].creations[0].models = []; },
    draft => { draft.marketplace.edits[0].creations[0].privatePrompt = 'CREATION_CANARY'; },
    draft => { draft.marketplace.edits[0].creations[0].models[0].extra = { credentials: 'NESTED_BOUNDARY_CANARY' }; },
  ]) {
    const draft = makeDraft(state, frameId); inject(draft); const before = clone(draft); const inspection = inspectableDraft(draft);
    assert.equal(inspection.status, 'invalid-edits'); assert.equal(Object.hasOwn(inspection, 'marketplace'), false);
    assert.equal(inspection.marketplaceStatus, 'Invalid marketplace stages were withheld.');
    assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.deepEqual(draft, before);
  }
});

test('invalid marketplace inspection withholds the entire raw stage but retains safe ordinary edits', () => {
  const state = editor(); replaceModels(state, state.groups[0].id, models('fixture/ordinary')); select(state); create(state);
  for (const inject of [
    draft => { draft.marketplace.privatePrompt = 'MARKETPLACE_CANARY'; },
    draft => { draft.marketplace.edits[0].creations[0].models[0].extra = { privatePrompt: 'NESTED_CANARY' }; },
    draft => { draft.marketplace.identities[0].credentials = 'IDENTITY_CANARY'; },
    draft => { draft.marketplace.sourceGeneration = 'OVERSIZE_CANARY'.repeat(500); },
  ]) {
    const draft = makeDraft(state, frameId); inject(draft); const before = clone(draft); const inspection = inspectableDraft(draft);
    assert.equal(inspection.status, 'invalid-edits'); assert.equal(Object.hasOwn(inspection, 'marketplace'), false);
    assert.equal(inspection.marketplaceStatus, 'Invalid marketplace stages were withheld.');
    assert.deepEqual(inspection.changes, [{ path: state.groups[0].path, models: models('fixture/ordinary') }]);
    assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.deepEqual(draft, before);
  }
});

test('future-version inspection exposes only validated headers, never body arrays, credentials or raw configuration', () => {
  const future = { version: 99, id: frameId, targetPath: '/isolated/omos.jsonc', baseHash: 'a'.repeat(64), revision: 3,
    updatedAt: '2026-11-16T12:00:00.000Z', rawConfig: 'RAW_CANARY', credentials: { token: 'TOKEN_CANARY' },
    originals: [{ privatePrompt: 'ORIGINAL_CANARY' }], changes: [{ privatePrompt: 'CHANGE_CANARY' }], marketplace: { privatePrompt: 'MARKETPLACE_CANARY' } };
  const before = clone(future); const inspection = inspectableDraft(future);
  assert.equal(inspection.version, 99); assert.equal(inspection.status, 'unsupported-version'); assert.equal(inspection.readOnly, true);
  assert.equal(inspection.targetPath, future.targetPath); assert.equal(inspection.baseHash, future.baseHash);
  assert.equal(Object.values(inspection).some(value => typeof value === 'object'), false);
  for (const key of ['rawConfig', 'credentials', 'marketplace', 'originals', 'changes']) assert.equal(Object.hasOwn(inspection, key), false);
  assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.deepEqual(future, before);
});

test('object-valued, private, oversized and invalid header values are not copied or serialized', () => {
  let calls = 0; const privateHeader = { credentials: 'HEADER_CANARY', toJSON() { calls += 1; return 'SERIALIZED_CANARY'; } };
  const malformed = { version: privateHeader, targetPath: privateHeader, baseHash: privateHeader, id: privateHeader,
    updatedAt: privateHeader, revision: privateHeader, readOnlyReason: privateHeader, changes: privateHeader, marketplace: privateHeader };
  const inspection = inspectableDraft(malformed); assert.equal(inspection.readOnly, true);
  assert.equal(JSON.stringify(inspection).includes('CANARY'), false); assert.equal(calls, 0);
  for (const key of ['version', 'targetPath', 'baseHash', 'id', 'updatedAt', 'revision']) assert.equal(Object.hasOwn(inspection, key), false);
  const oversized = inspectableDraft({ version: 1, targetPath: `/${'PATH_CANARY'.repeat(500)}`, baseHash: 'HASH_CANARY'.repeat(500),
    id: 'ID_CANARY'.repeat(500), updatedAt: 'DATE_CANARY'.repeat(500), revision: Number.MAX_SAFE_INTEGER + 1,
    changes: [], originals: [] });
  assert.equal(oversized.status, 'invalid-header'); assert.equal(JSON.stringify(oversized).includes('CANARY'), false);
  assert.deepEqual(inspectableDraft(null), { status: 'invalid-header', readOnly: true, readOnlyReason: 'Draft details are unavailable. Inspection only.' });
});

test('read-only headers and inspect-only markers block recovery and recheck even on known-looking versions', () => {
  const state = editor(); select(state); create(state); const draft = makeDraft(state, frameId);
  for (const marker of [{ readOnlyReason: 'PRIVATE_REASON_CANARY' }, { inspectOnly: true }, { inspectionOnly: true }, { readOnly: true }, { status: 'inspect-only' }]) {
    const marked = { ...clone(draft), ...marker }; const before = clone(marked); const reopened = editor();
    const inspection = inspectableDraft(marked); assert.equal(inspection.status, 'read-only'); assert.equal(inspection.readOnly, true);
    assert.equal(Object.hasOwn(inspection, 'marketplace'), false); assert.equal(Object.hasOwn(inspection, 'changes'), false);
    assert.equal(JSON.stringify(inspection).includes('CANARY'), false);
    assert.equal(recoveryStatus(reopened, marked), 'read-only'); assert.equal(recoverDraft(reopened, marked), false);
    assert.throws(() => recheckMarketplaceDraft(reopened, marked), /restage/); assert.deepEqual(marked, before);
    assert.equal(hasPendingEdits(reopened), false);
  }
  const knownHeader = { version: 1, id: frameId, targetPath: draft.targetPath, baseHash: draft.baseHash, readOnlyReason: 'Stored format is unsupported.' };
  assert.equal(inspectableDraft(knownHeader).status, 'read-only'); assert.equal(recoveryStatus(editor(), knownHeader), 'read-only');
});

test('malformed queue entries and over-bound details get fixed inspection markers, not raw payloads', () => {
  const state = editor(); replaceModels(state, state.groups[0].id, models('fixture/edited')); const draft = makeDraft(state, frameId);
  draft.changes.push(null, { path: { privatePrompt: 'PATH_CANARY' }, models: models() },
    { path: ['agents', 'unsafe', 'model'], models: [{ id: { token: 'MODEL_CANARY' }, variant: '' }] });
  const inspection = inspectableDraft(draft); assert.equal(inspection.status, 'invalid-edits');
  assert.equal(inspection.changes.length, 1); assert.equal(inspection.editsStatus, 'Invalid queue entries were withheld.');
  assert.equal(JSON.stringify(inspection).includes('CANARY'), false);
  const large = inspectableDraft({ ...draft, changes: Array(1001).fill({ privatePrompt: 'MANY_CANARY' }) });
  assert.equal(large.status, 'invalid-edits'); assert.deepEqual(large.changes, []); assert.equal(JSON.stringify(large).includes('CANARY'), false);
});
