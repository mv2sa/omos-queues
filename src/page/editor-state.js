// Plain data only. The page and the Node tests use the same transitions.
import { isModelId, isValidVariant, hasPlaceholder } from '../backend/model-id.js';
export const clone = value => JSON.parse(JSON.stringify(value));
export const pathKey = path => JSON.stringify(path);
export const sameModels = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const normalizeModels = models => models.map(({ id, variant }) => ({ id, variant }));
export const isDirty = group => !sameModels(group.models, group.original);
export const editLimit = group => group.readOnlyReason || (group.original.length > 50
  ? 'This queue exceeds the 50-position editing limit. Its values are shown read-only.' : '');
export const validModelId = id => isModelId(id) && !hasPlaceholder(id);
export const validModels = models => Array.isArray(models) && models.length >= 1 && models.length <= 50
  && models.every(model => validModelId(model?.id) && isValidVariant(model.variant) && !hasPlaceholder(model.variant));

export function createEditor(config) {
  return {
    target: clone(config.target), baseHash: config.baseHash,
    groups: config.groups.map(group => ({ ...clone(group), original: clone(group.models) })),
    selectedId: config.groups[0]?.id ?? null, filter: '', revision: 0,
    preview: null, pendingCommit: null, unknown: null, conflict: null,
    clipboard: null, pendingPaste: null,
    marketplace: null, marketplaceView: null, marketplaceIssue: null, marketplaceUnavailable: false, draftVersion: 1,
    primarySlots: clone(config.primarySlots || []), primaryCreations: [],
  };
}
export const dirtyGroups = state => state.groups.filter(isDirty);
export const visibleGroups = state => state.groups.filter(group =>
  `${group.name} ${group.label} ${group.section}`.toLowerCase().includes(state.filter.trim().toLowerCase()));
export function selectQueue(state, id) {
  if (state.groups.some(group => group.id === id)) state.selectedId = id;
}
export function setFilter(state, query) { state.filter = query; }
export function touch(state) {
  state.revision += 1;
  state.preview = null;
  state.pendingPaste = null;
}
export function replaceModels(state, id, models) {
  const group = state.groups.find(item => item.id === id);
  if (!group || editLimit(group)) throw new Error('This queue is read-only.');
  if (!Array.isArray(models) || models.length < 1 || models.length > 50) throw new Error('Keep 1 to 50 positions.');
  const next = normalizeModels(models);
  if (!sameModels(group.models, next)) {
    group.models = next;
    if (group.marketplaceCreation && !group.marketplaceCreation.saved) {
      const { preset, packageId } = group.marketplaceCreation;
      const creation = state.marketplace?.edits.find(edit => edit.preset === preset)?.creations.find(item => item.packageId === packageId);
      if (!creation) throw new Error('The staged marketplace queue is no longer available.');
      creation.models = clone(next);
    }
    if (group.primaryCreation && !group.primaryCreation.saved) {
      const creation = state.primaryCreations.find(item => item.preset === group.primaryCreation.preset && item.agent === group.primaryCreation.agent);
      if (!creation) throw new Error('The staged primary queue is no longer available.');
      creation.models = clone(next);
    }
    touch(state);
  }
}
export function discardQueueSnapshot(state, id, expectedModels, target = state?.target) {
  if (!state || state.target.path !== target?.path || state.target.generation !== target?.generation) return false;
  const group = state.groups.find(item => item.id === id);
  if (!group || !sameModels(group.models, expectedModels)) return false;
  replaceModels(state, id, group.original);
  return true;
}
export function canDiscardSnapshot(state, saved) {
  return Boolean(state) && state.revision === saved.revision && state.baseHash === saved.baseHash
    && state.target.generation === saved.generation && state.target.path === saved.targetPath
    && !state.pendingCommit && !state.unknown;
}
export function movePosition(state, id, index, direction) {
  const group = state.groups.find(item => item.id === id);
  const target = index + direction;
  if (!group || index < 0 || target < 0 || index >= group.models.length || target >= group.models.length) return index;
  const models = clone(group.models);
  [models[index], models[target]] = [models[target], models[index]];
  replaceModels(state, id, models);
  return target;
}
export function variantOptions(current, defaultVariant) {
  const inherit = defaultVariant ? `Inherit (${defaultVariant})` : 'Inherit (no explicit variant)';
  return [ { id: '', label: inherit }, ...[...new Set(['low', 'medium', 'high', 'xhigh', 'max', current])]
    .filter(Boolean).map(id => ({ id, label: id })) ];
}
export function copyQueue(state, id) {
  const group = state.groups.find(item => item.id === id);
  if (!group || !validModels(group.models)) throw new Error('Only queues with 1 to 50 complete positions can be copied.');
  state.clipboard = { source: id, label: group.label, models: normalizeModels(group.models) };
  return state.clipboard;
}
export function requestPaste(state, id) {
  const target = state.groups.find(item => item.id === id);
  if (!target || editLimit(target) || !state.clipboard || state.clipboard.source === id) return null;
  state.pendingPaste = { targetId: id, label: state.clipboard.label, models: clone(state.clipboard.models), revision: state.revision };
  return state.pendingPaste;
}
export function cancelPaste(state) { state.pendingPaste = null; }
export function confirmPaste(state) {
  const pending = state.pendingPaste;
  if (!pending || pending.revision !== state.revision || !validModels(pending.models)) return false;
  replaceModels(state, pending.targetId, pending.models);
  state.pendingPaste = null;
  return true;
}
export function snapshot(state) {
  const ordinary = dirtyGroups(state).filter(group => !isPendingMarketplaceQueue(group) && !isPendingPrimaryQueue(group));
  return {
    revision: state.revision, targetPath: state.target.path, baseHash: state.baseHash, generation: state.target.generation,
    changes: ordinary.map(group => ({ path: clone(group.path), models: normalizeModels(group.models) })),
    originals: ordinary.map(group => ({ path: clone(group.path), models: normalizeModels(group.original) })),
    ...(state.marketplace ? { marketplace: clone(state.marketplace) } : {}),
    ...(state.primaryCreations?.length ? { primaryCreations: clone(state.primaryCreations) } : {}),
  };
}
export const previewBody = saved => ({ baseHash: saved.baseHash, generation: saved.generation, changes: clone(saved.changes),
  ...(saved.marketplace ? { marketplace: { sourceGeneration: saved.marketplace.sourceGeneration, catalogFingerprint: saved.marketplace.catalogFingerprint,
    edits: clone(saved.marketplace.edits) } } : {}),
  ...(saved.primaryCreations?.length ? { primaryCreations: clone(saved.primaryCreations) } : {}) });
export function acceptPreview(state, saved, result) {
  if (!result || typeof result.diff !== 'string' || !Array.isArray(result.changed) || typeof result.afterHash !== 'string'
    || (result.previewToken !== null && (typeof result.previewToken !== 'string' || !Number.isFinite(result.expiresAt)))) return false;
  if (state.unknown || state.pendingCommit || saved.revision !== state.revision || saved.baseHash !== state.baseHash
    || saved.generation !== state.target.generation || result.baseHash !== state.baseHash
    || result.target?.generation !== state.target.generation || result.target?.path !== state.target.path) return false;
  if (saved.marketplace && (!result.marketplaceBinding || result.marketplaceBinding.sourceGeneration !== saved.marketplace.sourceGeneration
    || result.marketplaceBinding.catalogFingerprint !== saved.marketplace.catalogFingerprint || marketplaceProblem(state))) return false;
  state.preview = { saved: clone(saved), result: clone(result) };
  return true;
}
export function validCommitAcknowledgment(submitted, result) {
  return result?.ok === true && result.baseHash === submitted.result.afterHash
    && result.target?.path === submitted.saved.targetPath && result.target?.generation === submitted.saved.generation
    && typeof result.backup === 'string' && Array.isArray(result.changed);
}
export function beginCommit(state, now = Date.now()) {
  const preview = state.preview;
  if (!preview || state.unknown || state.pendingCommit || state.conflict || !preview.result.previewToken
    || preview.saved.revision !== state.revision || now >= preview.result.expiresAt) return null;
  state.pendingCommit = clone(preview);
  state.preview = null;
  return { previewToken: preview.result.previewToken };
}
export function acknowledgeSave(state, submitted, result) {
  const changed = new Map(submitted.saved.changes.map(change => [pathKey(change.path), change.models]));
  for (const group of state.groups) {
    if (changed.has(pathKey(group.path))) group.original = clone(changed.get(pathKey(group.path)));
  }
  acknowledgeMarketplace(state, submitted.saved.marketplace);
  acknowledgePrimary(state, submitted.saved.primaryCreations);
  state.baseHash = result.baseHash;
  if (state.marketplaceView?.baseHash === submitted.saved.baseHash) state.marketplaceView.baseHash = result.baseHash;
  state.marketplaceIssue = marketplaceProblem(state);
  state.pendingCommit = null;
  state.unknown = null;
  state.preview = null;
  state.conflict = null;
}
export function markUnknown(state) {
  if (state.pendingCommit) state.unknown = clone(state.pendingCommit);
  state.pendingCommit = null;
  state.preview = null;
}
export function reconciliationKind(submitted, config) {
  if (!config?.target || typeof config.baseHash !== 'string'
    || config.target.generation !== submitted.saved.generation || config.target.path !== submitted.saved.targetPath) return 'unknown';
  if (config.baseHash === submitted.result.afterHash) return 'saved';
  if (config.baseHash === submitted.saved.baseHash) return 'baseline';
  return 'conflict';
}
export function reconcile(state, config) {
  if (!state.unknown) return 'unknown';
  const kind = reconciliationKind(state.unknown, config);
  if (kind === 'saved') {
    const created = state.unknown.saved.marketplace?.edits.some(edit => edit.creations.length)
      || state.unknown.saved.primaryCreations?.length;
    acknowledgeSave(state, state.unknown, { baseHash: config.baseHash });
    if (created) mergeSavedConfig(state, config);
  }
  if (kind === 'baseline') { state.unknown = null; state.preview = null; }
  if (kind === 'conflict') { state.conflict = clone(config); state.unknown = null; state.preview = null; }
  return kind;
}
export function makeDraft(state, id) {
  const saved = snapshot(state);
  return { id, targetPath: saved.targetPath, baseHash: saved.baseHash, originals: saved.originals, changes: saved.changes,
    ...(state.draftVersion >= 2 ? { version: state.draftVersion, revision: state.revision, marketplace: saved.marketplace || null,
      ...(state.draftVersion >= 3 ? { primaryCreations: saved.primaryCreations || [] } : {}) } : {}) };
}
const draftObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inspectionText = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);
function readOnlyDraft(draft) {
  return draftObject(draft) && ((Object.hasOwn(draft, 'readOnlyReason') && draft.readOnlyReason !== null && draft.readOnlyReason !== undefined)
    || ['readOnly', 'inspectOnly', 'inspectionOnly'].some(key => Object.hasOwn(draft, key) && ![false, null, undefined].includes(draft[key]))
    || ['inspect-only', 'inspection-only', 'read-only', 'unsupported-version'].includes(draft.status));
}
function inspectionEntries(value) {
  if (!Array.isArray(value) || value.length > 1000) return { entries: [], valid: false };
  const entries = [];
  for (const entry of value) {
    if (!draftObject(entry) || !Array.isArray(entry.path) || entry.path.length < 3 || entry.path.length > 100
      || !entry.path.every(part => inspectionText(part)) || entry.path.at(-1) !== 'model' || !validModels(entry.models)) continue;
    entries.push({ path: [...entry.path], models: normalizeModels(entry.models) });
  }
  return { entries, valid: entries.length === value.length };
}
function inspectionMarketplace(record) {
  if (!validMarketplaceRecord(record) || !inspectionText(record.sourceGeneration, 200) || !inspectionText(record.catalogFingerprint, 200)
    || record.edits.some(edit => !inspectionText(edit.preset, 128) || !edit.packageIds.every(id => inspectionText(id, 500))
      || edit.creations.some(creation => !inspectionText(creation.packageId, 129)))
    || record.originals.some(original => !inspectionText(original.preset, 128) || !original.packageIds.every(id => inspectionText(id, 500)))
    || record.identities.some(identity => !inspectionText(identity.id, 129) || !inspectionText(identity.version, 128) || !inspectionText(identity.agentName, 64))) return null;
  return {
    sourceGeneration: record.sourceGeneration, catalogFingerprint: record.catalogFingerprint,
    edits: record.edits.map(edit => ({ preset: edit.preset, packageIds: [...edit.packageIds],
      creations: edit.creations.map(creation => ({ packageId: creation.packageId, models: normalizeModels(creation.models) })) })),
    originals: record.originals.map(original => ({ preset: original.preset, selectionPresent: original.selectionPresent, packageIds: [...original.packageIds] })),
    identities: record.identities.map(identity => ({ id: identity.id, version: identity.version, agentName: identity.agentName, digest: identity.digest })),
  };
}
// Display projection only: never serialize an unvalidated stored draft or use
// this result to save, recover, rebind or delete the original record.
export function inspectableDraft(draft) {
  const header = {};
  if (!draftObject(draft)) return { status: 'invalid-header', readOnly: true, readOnlyReason: 'Draft details are unavailable. Inspection only.' };
  const version = draft.version === undefined ? 1 : draft.version;
  if (Number.isSafeInteger(version) && version > 0) header.version = version;
  if (typeof draft.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.id)) header.id = draft.id;
  if (inspectionText(draft.targetPath, 4096) && /^(?:\/|[a-z]:[\\/])/i.test(draft.targetPath)) header.targetPath = draft.targetPath;
  if (typeof draft.baseHash === 'string' && /^[0-9a-f]{64}$/i.test(draft.baseHash)) header.baseHash = draft.baseHash;
  if (Number.isSafeInteger(draft.revision) && draft.revision >= 0) header.revision = draft.revision;
  if (typeof draft.updatedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(draft.updatedAt)
    && Number.isFinite(Date.parse(draft.updatedAt))) header.updatedAt = draft.updatedAt;
  else if (typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt) && draft.updatedAt >= 0 && draft.updatedAt <= 8640000000000000) header.updatedAt = draft.updatedAt;
  if (version !== 1 && version !== 2 && version !== 3) return { ...header, status: 'unsupported-version', readOnly: true,
    readOnlyReason: 'Unsupported draft version. Only validated header details are shown.' };
  if (readOnlyDraft(draft)) return { ...header, status: 'read-only', readOnly: true,
    readOnlyReason: 'This stored draft is read-only. Only validated header details are shown.' };
  if (!header.targetPath || !header.baseHash || (version >= 2 && header.revision === undefined)) return { ...header, status: 'invalid-header', readOnly: true,
    readOnlyReason: 'Draft header is invalid or incomplete. Only validated header details are shown.' };
  const originals = inspectionEntries(draft.originals); const changes = inspectionEntries(draft.changes);
  const result = { ...header, status: originals.valid && changes.valid ? 'normalized-edits' : 'invalid-edits', readOnly: false,
    originals: originals.entries, changes: changes.entries };
  if (!originals.valid || !changes.valid) result.editsStatus = 'Invalid queue entries were withheld.';
  if ((version === 2 || version === 3) && draft.marketplace === null) result.marketplace = null;
  else if (draft.marketplace !== undefined) {
    const marketplace = version >= 2 ? inspectionMarketplace(draft.marketplace) : null;
    if (marketplace) result.marketplace = marketplace;
    else { result.status = 'invalid-edits'; result.marketplaceStatus = 'Invalid marketplace stages were withheld.'; }
  }
  if (version === 3) {
    const entries = draft.primaryCreations;
    const valid = Array.isArray(entries) && entries.length <= 64 && entries.every(item => draftObject(item)
      && Object.keys(item).every(key => ['preset', 'agent', 'models'].includes(key)) && inspectionText(item.preset, 128)
      && safePrimaryPreset(item.preset) && item.agent === 'orchestrator' && validModels(item.models)
      && item.models.every(model => Object.keys(model).every(key => ['id', 'variant'].includes(key))));
    if (valid) result.primaryCreations = entries.map(item => ({ preset: item.preset, agent: item.agent, models: normalizeModels(item.models) }));
    else { result.status = 'invalid-edits'; result.primaryStatus = 'Invalid primary queue stages were withheld.'; }
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) return { ...header, status: 'invalid-edits', readOnly: false,
    editsStatus: 'Draft details exceed inspection bounds and were withheld.' };
  return result;
}
export function recoveryStatus(state, draft) {
  if (!draft || typeof draft !== 'object') return 'invalid';
  if (draft.version !== undefined && draft.version !== 1 && draft.version !== 2 && draft.version !== 3) return 'unsupported-version';
  if (readOnlyDraft(draft)) return 'read-only';
  if (draft.targetPath !== state.target.path) return 'different-target';
  if (draft.baseHash !== state.baseHash) return 'stale';
  if (!Array.isArray(draft.changes) || !Array.isArray(draft.originals) || (!draft.changes.length && !draft.marketplace?.edits?.length && !draft.primaryCreations?.length)) return 'invalid';
  if ((draft.version === 2 || draft.version === 3) && (!Number.isSafeInteger(draft.revision) || draft.revision < 0)) return 'invalid';
  if (draft.version === 3 && (Object.keys(draft).some(key => !['id', 'targetPath', 'baseHash', 'originals', 'changes', 'updatedAt', 'version', 'revision', 'marketplace', 'primaryCreations'].includes(key))
    || new TextEncoder().encode(JSON.stringify(draft)).length > 64 * 1024)) return 'invalid';
  if (draft.version !== 2 && draft.version !== 3 && draft.marketplace) return 'invalid';
  if (draft.version === 3 && !validPrimaryDraft(state, draft.primaryCreations)) return 'stale';
  if (draft.version !== 3 && draft.primaryCreations) return 'invalid';
  const keys = new Set();
  for (const change of draft.changes) {
    const key = pathKey(change.path);
    const group = state.groups.find(item => pathKey(item.path) === key);
    const baseline = draft.originals.find(item => pathKey(item.path) === key);
    if (keys.has(key) || !group || editLimit(group) || !validModels(change.models) || !baseline
      || !sameModels(baseline.models, group.original)) return 'stale';
    keys.add(key);
  }
  if ((draft.version === 2 || draft.version === 3) && draft.marketplace) return marketplaceRecoveryStatus(state, draft.marketplace);
  return 'available';
}
export function recoverDraft(state, draft) {
  if (hasPendingEdits(state) || recoveryStatus(state, draft) !== 'available') return false;
  // Construct one validated recovery on detached data. Even if two kinds of
  // pending creation conflict, the live frame keeps all of its prior values.
  const next = clone(state);
  for (const change of draft.changes) {
    const group = next.groups.find(item => pathKey(item.path) === pathKey(change.path));
    group.models = normalizeModels(change.models);
  }
  if (draft.version === 2 || draft.version === 3) {
    next.draftVersion = Math.max(next.draftVersion, draft.version);
    if (draft.marketplace) {
      next.marketplace = clone(draft.marketplace);
      try {
        for (const edit of next.marketplace.edits) for (const creation of edit.creations) addPendingMarketplaceGroup(next, edit.preset, creation);
      } catch { return false; }
    }
    if (draft.version === 3) {
      const creations = clone(draft.primaryCreations);
      for (const creation of creations) if (!addPendingPrimaryGroup(next, creation)) return false;
      next.primaryCreations = creations;
    }
  }
  Object.assign(state,next);
  touch(state);
  return true;
}
// Every readiness snapshot applies the host theme. Only the first mounts controls.
export function createReadyReceiver(apply, mount) {
  let mounted = false;
  return ready => { apply(ready); if (!mounted) { mounted = true; mount(ready); } };
}
export function catalogIds(state, flat, query = '') {
  const configured = state.groups.flatMap(group => group.models.map(model => model.id));
  return [...new Set([...configured, ...flat])].filter(Boolean)
    .filter(id => id.toLowerCase().includes(query.trim().toLowerCase()));
}
export function validateChanges(state) {
  return validateDraftChanges(state) && !marketplaceProblem(state);
}
export function validateDraftChanges(state) {
  return dirtyGroups(state).every(group => !editLimit(group) && validModels(group.models))
    && (!state.marketplace || validMarketplaceRecord(state.marketplace))
    && state.primaryCreations.length <= 64
    && state.primaryCreations.every(creation => validPrimaryCreation(state, creation));
}

export const isPendingMarketplaceQueue = group => Boolean(group?.marketplaceCreation && !group.marketplaceCreation.saved);
export const hasPendingEdits = state => dirtyGroups(state).length > 0 || Boolean(state.marketplace?.edits.length || state.primaryCreations?.length);
export const draftHasOperations = draft => Boolean(draft.changes?.length || draft.marketplace?.edits?.length || draft.primaryCreations?.length);
export const marketplaceSelectionCount = state => state.marketplace?.edits.filter(edit => {
  const original = state.marketplace.originals.find(item => item.preset === edit.preset);
  return !sameModels(edit.packageIds, original?.packageIds);
}).length || 0;
const packageIdentity = item => ({ id: item.id, version: item.version, agentName: item.agentName, digest: item.digest });
const marketplacePreset = (state, name) => state.marketplaceView?.presets.find(item => item.name === name);
const marketplacePackage = (state, id) => state.marketplaceView?.catalog.packages?.find(item => item.id === id);
const marketplaceAgent = (state, preset, id) => marketplacePreset(state, preset)?.agents.find(item => item.packageId === id);
const originalSelection = (state, preset) => state.marketplace?.originals.find(item => item.preset === preset)
  || (() => { const view = marketplacePreset(state, preset); return view ? { preset, selectionPresent: view.selectionPresent, packageIds: clone(view.packageIds) } : null; })();
export const marketplacePackageIds = (state, preset) => clone(state.marketplace?.edits.find(edit => edit.preset === preset)?.packageIds || marketplacePreset(state, preset)?.packageIds || []);
export function marketplaceProblem(state) {
  if (!state.marketplace?.edits.length) return null;
  if (!validMarketplaceRecord(state.marketplace)) return 'Marketplace stages are invalid. Inspect and restage them.';
  if (state.marketplaceUnavailable) return 'Marketplace metadata is unavailable. Recheck or discard marketplace stages.';
  const view = state.marketplaceView; const staged = state.marketplace;
  if (!view || view.target.generation !== state.target.generation || view.target.path !== state.target.path || view.baseHash !== state.baseHash) return 'Marketplace stages need a matching configuration read.';
  if (view.catalog.state !== 'ready') return 'Marketplace metadata is unavailable. Recheck or discard marketplace stages.';
  if (!identitiesMatch(staged.identities, view.catalog.packages)) return 'A staged package identity changed. Inspect and restage marketplace changes.';
  if (!identityCoverage(staged, view.catalog.packages)) return 'Package identity information is incomplete. Inspect and restage.';
  if (view.catalog.generation !== staged.sourceGeneration || view.catalog.fingerprint !== staged.catalogFingerprint) return 'Installed packages changed. Recheck packages or discard marketplace stages.';
  if (view.masterEnabled !== true) return 'Marketplace staging is blocked by the file master setting.';
  for (const edit of staged.edits) {
    const preset = marketplacePreset(state, edit.preset); const original = staged.originals.find(item => item.preset === edit.preset);
    if (!preset?.editable || !original || preset.selectionPresent !== original.selectionPresent || !sameModels(preset.packageIds, original.packageIds)) return preset?.reason || 'The marketplace preset baseline changed. Inspect and restage.';
    for (const id of edit.packageIds) {
      const pkg = marketplacePackage(state, id); const agent = marketplaceAgent(state, edit.preset, id);
      if (!original.packageIds.includes(id) && (!pkg || pkg.blockedReason || !agent || agent.blockedReason || agent.existingGroupId)) return agent?.blockedReason || pkg?.blockedReason
        || (agent?.existingGroupId ? 'An explicit model queue already exists; edit it in the editor.' : 'A new package selection is not verified.');
    }
    for (const id of original.packageIds.filter(id => !edit.packageIds.includes(id))) {
      if (!marketplacePackage(state, id)) return 'Unknown selected packages must be retained unchanged.';
      if (marketplaceAgent(state, edit.preset, id)?.existingGroupId) return 'A saved model override would be orphaned. Keep its package selected.';
    }
    for (const creation of edit.creations) {
      const agent = marketplaceAgent(state, edit.preset, creation.packageId); const pkg = marketplacePackage(state, creation.packageId);
      if (!agent?.canCreate || agent.existingGroupId || agent.blockedReason || !pkg || pkg.blockedReason
        || !edit.packageIds.includes(creation.packageId) || !validModels(creation.models)) return agent?.blockedReason || pkg?.blockedReason || 'A staged model override is no longer eligible.';
    }
  }
  return null;
}
function identitiesMatch(identities, packages) {
  return Array.isArray(identities) && identities.every(identity => {
    const current = packages.find(item => item.id === identity.id);
    return current && sameModels(packageIdentity(current), identity);
  });
}
function identityCoverage(record, packages) {
  const relevant = new Set(record.edits.flatMap(edit => [...edit.packageIds, ...(record.originals.find(item => item.preset === edit.preset)?.packageIds || [])]));
  return [...relevant].every(id => !packages.some(item => item.id === id) || record.identities.some(item => item.id === id));
}
function ensureMarketplace(state, presetName) {
  if (state.conflict) throw new Error('Resolve the file conflict before staging marketplace changes.');
  const view = state.marketplaceView; const staged = state.marketplace;
  if (staged && (!view || view.catalog.state !== 'ready' || view.baseHash !== state.baseHash
    || view.catalog.generation !== staged.sourceGeneration || view.catalog.fingerprint !== staged.catalogFingerprint
    || !identitiesMatch(staged.identities, view.catalog.packages))) throw new Error(marketplaceProblem(state) || 'Recheck installed packages before staging more changes.');
  const preset = marketplacePreset(state, presetName);
  if (state.marketplaceUnavailable || state.marketplaceView?.catalog.state !== 'ready' || state.marketplaceView.masterEnabled !== true || !preset?.editable) throw new Error(preset?.reason || 'Choose a supported existing preset and a ready installed catalog.');
  return preset;
}
function writeMarketplaceEdit(state, presetName, packageIds, creations) {
  const original = originalSelection(state, presetName);
  const record = state.marketplace || { sourceGeneration: state.marketplaceView.catalog.generation, catalogFingerprint: state.marketplaceView.catalog.fingerprint,
    edits: [], originals: [], identities: [] };
  const edits = record.edits.filter(edit => edit.preset !== presetName);
  if (!sameModels(packageIds, original.packageIds) || creations.length) edits.push({ preset: presetName, packageIds: clone(packageIds), creations: clone(creations) });
  const originals = record.originals.filter(item => item.preset !== presetName);
  if (edits.some(edit => edit.preset === presetName)) originals.push(clone(original));
  const relevant = new Set(edits.flatMap(edit => [...edit.packageIds, ...(originals.find(item => item.preset === edit.preset)?.packageIds || []), ...edit.creations.map(item => item.packageId)]));
  const identities = [...relevant].map(id => record.identities.find(item => item.id === id)
    || (marketplacePackage(state, id) ? packageIdentity(marketplacePackage(state, id)) : null)).filter(Boolean);
  state.marketplace = edits.length ? { ...record, edits, originals, identities } : null;
  state.marketplaceIssue = marketplaceProblem(state); state.draftVersion = Math.max(state.draftVersion, 2);
}
export function stageMarketplaceSelection(state, presetName, packageId, selected) {
  const preset = ensureMarketplace(state, presetName); const pkg = marketplacePackage(state, packageId); const agent = marketplaceAgent(state, presetName, packageId);
  const ids = marketplacePackageIds(state, presetName); const exists = ids.includes(packageId);
  if (exists === selected) return false;
  const baselineSelected = originalSelection(state, presetName)?.packageIds.includes(packageId);
  if (!pkg || pkg.blockedReason || pkg.modelSource === 'builtin' || !agent
    || (agent.blockedReason && !(baselineSelected && agent.existingGroupId)) || (!baselineSelected && agent.existingGroupId)) throw new Error(agent?.blockedReason || pkg?.blockedReason
      || (agent?.existingGroupId ? 'An explicit model queue already exists; edit it in the editor.' : 'This package cannot be staged safely.'));
  const edit = state.marketplace?.edits.find(item => item.preset === presetName);
  if (!selected && (agent.existingGroupId || state.groups.some(group => group.marketplaceCreation?.saved && group.marketplaceCreation.preset === presetName && group.marketplaceCreation.packageId === packageId))) throw new Error('This package has a saved model override. Deselecting it would orphan that override.');
  if (!selected && edit?.creations.some(item => item.packageId === packageId)) throw new Error('Discard the staged model queue before deselecting this package.');
  const next = selected ? [...ids, packageId] : ids.filter(id => id !== packageId);
  if (next.length > 64) throw new Error('Keep at most 64 package selections per preset.');
  // Keep opaque existing selections; they are not editable package definitions.
  if (preset.packageIds.some(id => !marketplacePackage(state, id) && !next.includes(id))) throw new Error('Unknown selected packages must be retained unchanged.');
  writeMarketplaceEdit(state, presetName, next, edit?.creations || []); touch(state); return true;
}
function addPendingMarketplaceGroup(state, presetName, creation) {
  const agent = marketplaceAgent(state, presetName, creation.packageId); const pkg = marketplacePackage(state, creation.packageId);
  if (!agent?.modelPath || !pkg) throw new Error('The package model path is unavailable.');
  const id = pathKey(agent.modelPath);
  if (state.groups.some(group => group.id === id)) throw new Error('A model queue already exists at this package path.');
  const group = { id, path: clone(agent.modelPath), name: agent.agentName, label: `preset ${presetName} · ${agent.agentName}`, section: `Preset · ${presetName}`,
    kind: 'preset', defaultVariant: agent.defaultVariant, models: normalizeModels(creation.models), original: [], readOnlyReason: null,
    marketplaceCreation: { preset: presetName, packageId: creation.packageId, identity: packageIdentity(pkg), saved: false } };
  state.groups.push(group); return group;
}
export function beginMarketplacePick(state, preset, packageId) {
  ensureMarketplace(state, preset);
  const agent = marketplaceAgent(state, preset, packageId); const pkg = marketplacePackage(state, packageId);
  if (!agent?.canCreate || !validModels([{ id: 'check/default', variant: agent.defaultVariant }]) || !Array.isArray(agent.modelPath) || agent.existingGroupId || agent.blockedReason || !pkg || pkg.blockedReason || pkg.modelSource === 'builtin' || !marketplacePackageIds(state, preset).includes(packageId)
    || state.groups.some(group => pathKey(group.path) === pathKey(agent.modelPath))) throw new Error(agent?.blockedReason || pkg?.blockedReason || 'Select the package first, or edit its existing queue.');
  return { kind: 'marketplace', preset, packageId, revision: state.revision, generation: state.target.generation,
    sourceGeneration: state.marketplaceView.catalog.generation, catalogFingerprint: state.marketplaceView.catalog.fingerprint };
}
export function marketplaceAgentPresentation(state, presetName, packageId) {
  const preset = marketplacePreset(state, presetName); const pkg = marketplacePackage(state, packageId); const agent = marketplaceAgent(state, presetName, packageId);
  const group = state?.groups.find(item => item.marketplaceCreation?.preset === presetName && item.marketplaceCreation.packageId === packageId);
  const pending = isPendingMarketplaceQueue(group);
  const queueId = pending ? group.id : agent?.existingGroupId || (group?.marketplaceCreation.saved ? group.id : null);
  const selected = marketplacePackageIds(state, presetName).includes(packageId);
  const baselineSelected = originalSelection(state, presetName)?.packageIds.includes(packageId);
  const blockedReason = pkg?.blockedReason || (pkg?.modelSource === 'builtin' ? 'Built-in inheritance is not supported.' : '')
    || (preset && !preset.editable ? preset.reason : '') || (!(baselineSelected && agent?.existingGroupId) ? agent?.blockedReason : '')
    || (!baselineSelected && agent?.existingGroupId ? 'An explicit model queue already exists; edit it in the editor.' : '')
    || (!pkg ? 'Installed identity unavailable. Existing selection is retained.' : '');
  const canSelect = Boolean(preset && pkg && agent && !blockedReason && !state.marketplaceUnavailable
    && state.marketplaceView?.catalog.state === 'ready' && state.marketplaceView.masterEnabled === true);
  return { selected, pending, queueId, blockedReason, canSelect, deselectBlocked: selected && Boolean(queueId),
    canOverride: canSelect && selected && !queueId && Boolean(agent.canCreate) };
}
export function applyMarketplacePick(state, pending, id) {
  if (!validModelId(id) || state.revision !== pending?.revision || state.target.generation !== pending.generation
    || state.marketplaceView?.catalog.generation !== pending.sourceGeneration || state.marketplaceView?.catalog.fingerprint !== pending.catalogFingerprint) return null;
  beginMarketplacePick(state, pending.preset, pending.packageId);
  const creation = { packageId: pending.packageId, models: [{ id, variant: '' }] };
  const edit = state.marketplace?.edits.find(item => item.preset === pending.preset);
  writeMarketplaceEdit(state, pending.preset, marketplacePackageIds(state, pending.preset), [...(edit?.creations || []), creation]);
  const group = addPendingMarketplaceGroup(state, pending.preset, creation); touch(state); return group;
}
export function discardMarketplaceCreation(state, id) {
  const group = state.groups.find(item => item.id === id);
  if (!isPendingMarketplaceQueue(group) || state.unknown || state.pendingCommit) return false;
  const { preset, packageId } = group.marketplaceCreation;
  const edit = state.marketplace.edits.find(item => item.preset === preset);
  state.groups = state.groups.filter(item => item.id !== id);
  writeMarketplaceEdit(state, preset, edit.packageIds, edit.creations.filter(item => item.packageId !== packageId));
  if (state.selectedId === id) state.selectedId = state.groups[0]?.id || null;
  touch(state); return true;
}
export function discardMarketplaceStages(state) {
  if (state.unknown || state.pendingCommit) return false;
  state.groups = state.groups.filter(group => !isPendingMarketplaceQueue(group)); state.marketplace = null; state.marketplaceIssue = null;
  if (!state.groups.some(group => group.id === state.selectedId)) state.selectedId = state.groups[0]?.id || null;
  touch(state); return true;
}
export function bindMarketplaceView(state, view, { recheck = false } = {}) {
  if (!view?.target || view.target.path !== state.target.path || view.target.generation !== state.target.generation || view.baseHash !== state.baseHash) return false;
  state.marketplaceView = clone(view);
  state.marketplaceUnavailable = false;
  if (state.marketplace && recheck && view.catalog.state === 'ready') {
    const candidate = { ...clone(state.marketplace), sourceGeneration: view.catalog.generation, catalogFingerprint: view.catalog.fingerprint };
    const before = state.marketplace; state.marketplace = candidate;
    if (marketplaceProblem(state)) state.marketplace = before;
    else if (!sameModels(before, candidate)) touch(state);
  }
  state.marketplaceIssue = marketplaceProblem(state);
  if (state.marketplaceIssue) state.preview = null;
  return true;
}
export function markMarketplaceUnavailable(state) {
  state.marketplaceUnavailable = true;
  state.marketplaceIssue = marketplaceProblem(state);
  if (state.marketplace) state.preview = null;
}
function acknowledgeMarketplace(state, submitted) {
  if (!submitted) return;
  state.draftVersion = Math.max(state.draftVersion, 2);
  const desired = new Map(submitted.edits.map(edit => [edit.preset, marketplacePackageIds(state, edit.preset)]));
  const record = state.marketplace || { ...clone(submitted), edits: [], originals: [] };
  for (const edit of submitted.edits) {
    const preset = marketplacePreset(state, edit.preset);
    if (preset) {
      preset.packageIds = clone(edit.packageIds); preset.selectionPresent = true;
      for (const agent of preset.agents) agent.selected = edit.packageIds.includes(agent.packageId);
    }
    for (const creation of edit.creations) {
      let group = state.groups.find(item => item.marketplaceCreation?.preset === edit.preset && item.marketplaceCreation.packageId === creation.packageId);
      if (!group) group = addPendingMarketplaceGroup(state, edit.preset, creation);
      group.original = normalizeModels(creation.models); group.marketplaceCreation.saved = true;
      const agent = marketplaceAgent(state, edit.preset, creation.packageId);
      if (agent) { agent.existingGroupId = group.id; agent.canCreate = false; }
    }
    let original = record.originals.find(item => item.preset === edit.preset);
    if (!original) { original = { preset: edit.preset }; record.originals.push(original); }
    original.packageIds = clone(edit.packageIds); original.selectionPresent = true;
    let current = record.edits.find(item => item.preset === edit.preset);
    if (!current) { current = { preset: edit.preset, packageIds: clone(desired.get(edit.preset)), creations: [] }; record.edits.push(current); }
    current.creations = current.creations.filter(item => !edit.creations.some(creation => creation.packageId === item.packageId));
  }
  record.edits = record.edits.filter(edit => edit.creations.length || !sameModels(edit.packageIds, record.originals.find(item => item.preset === edit.preset)?.packageIds));
  record.originals = record.originals.filter(item => record.edits.some(edit => edit.preset === item.preset));
  const relevant = new Set(record.edits.flatMap(edit => [...edit.packageIds, ...(record.originals.find(item => item.preset === edit.preset)?.packageIds || [])]));
  const identities = new Map([...submitted.identities, ...record.identities].map(item => [item.id, item]));
  record.identities = [...identities.values()].filter(item => relevant.has(item.id));
  state.marketplace = record.edits.length ? record : null;
}
export function mergeSavedConfig(state, config) {
  if (config?.target?.path !== state.target.path || config.target.generation !== state.target.generation || config.baseHash !== state.baseHash) return false;
  const selected = state.selectedId;
  if (Array.isArray(config.primarySlots)) state.primarySlots = clone(config.primarySlots);
  for (const actual of config.groups) {
    const current = state.groups.find(group => group.id === actual.id);
    if (current) {
      const models = clone(current.models); const dirty = isDirty(current);
      Object.assign(current, clone(actual), { original: clone(actual.models), models: dirty ? models : clone(actual.models) });
      delete current.marketplaceCreation;
      delete current.primaryCreation;
    } else state.groups.push({ ...clone(actual), original: clone(actual.models) });
  }
  if (state.groups.some(group => group.id === selected)) state.selectedId = selected;
  return true;
}
function marketplaceRecoveryStatus(state, record, rebind = false) {
  const view = state.marketplaceView;
  if (!validMarketplaceRecord(record) || state.marketplaceUnavailable || !view || view.masterEnabled !== true || view.catalog.state !== 'ready'
    || !identitiesMatch(record.identities, view.catalog.packages) || !identityCoverage(record, view.catalog.packages)) return 'stale-marketplace';
  if (!rebind && (record.sourceGeneration !== view.catalog.generation || record.catalogFingerprint !== view.catalog.fingerprint)) return 'stale-marketplace';
  for (const edit of record.edits) {
    const preset = marketplacePreset(state, edit.preset); const original = record.originals.find(item => item.preset === edit.preset);
    if (!preset?.editable || !original || preset.selectionPresent !== original.selectionPresent || !sameModels(preset.packageIds, original.packageIds)
      || !Array.isArray(edit.packageIds) || new Set(edit.packageIds).size !== edit.packageIds.length || edit.packageIds.length > 64 || !Array.isArray(edit.creations)) return 'stale-marketplace';
    for (const id of edit.packageIds) {
      const pkg = marketplacePackage(state, id); const agent = marketplaceAgent(state, edit.preset, id);
      if (!original.packageIds.includes(id) && (!pkg || pkg.blockedReason || !agent || agent.blockedReason || agent.existingGroupId)) return 'stale-marketplace';
    }
    for (const id of original.packageIds.filter(id => !edit.packageIds.includes(id))) {
      if (!marketplacePackage(state, id) || marketplaceAgent(state, edit.preset, id)?.existingGroupId) return 'stale-marketplace';
    }
    for (const creation of edit.creations) {
      const agent = marketplaceAgent(state, edit.preset, creation.packageId);
      const pkg = marketplacePackage(state, creation.packageId);
      if (!agent?.canCreate || agent.existingGroupId || agent.blockedReason || !pkg || pkg.blockedReason || pkg.modelSource === 'builtin' || !edit.packageIds.includes(creation.packageId) || !validModels(creation.models)
        || state.groups.some(group => pathKey(group.path) === pathKey(agent.modelPath))) return 'stale-marketplace';
    }
  }
  return 'available';
}
export function validMarketplaceRecord(record) {
  const only = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
  const list = (value, limit, key) => Array.isArray(value) && value.length <= limit && new Set(value.map(key)).size === value.length;
  const ids = value => list(value, 64, item => item) && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500);
  if (!only(record, ['sourceGeneration', 'catalogFingerprint', 'edits', 'originals', 'identities']) || typeof record.sourceGeneration !== 'string' || !record.sourceGeneration || typeof record.catalogFingerprint !== 'string' || !record.catalogFingerprint
    || !list(record.edits, 64, item => item?.preset) || !record.edits.length || !list(record.originals, 64, item => item?.preset)
    || !list(record.identities, 64, item => item?.id)) return false;
  if (record.identities.some(item => !item || typeof item.id !== 'string' || typeof item.version !== 'string' || typeof item.agentName !== 'string'
    || typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(item.digest) || Object.keys(item).some(key => !['id', 'version', 'agentName', 'digest'].includes(key)))) return false;
  return record.edits.every(edit => only(edit, ['preset', 'packageIds', 'creations']) && typeof edit.preset === 'string' && ids(edit.packageIds) && list(edit.creations, 64, item => item?.packageId)
    && edit.creations.every(item => only(item, ['packageId', 'models']) && typeof item.packageId === 'string' && validModels(item.models)
      && item.models.every(model => only(model, ['id', 'variant'])) && edit.packageIds.includes(item.packageId))
    && record.originals.some(original => only(original, ['preset', 'selectionPresent', 'packageIds']) && original.preset === edit.preset && typeof original.selectionPresent === 'boolean' && ids(original.packageIds)))
    && record.originals.length === record.edits.length;
}
export function recheckMarketplaceDraft(state, draft) {
  if (!draft || readOnlyDraft(draft) || (draft.version !== 2 && draft.version !== 3) || !draft.marketplace || draft.targetPath !== state.target.path || draft.baseHash !== state.baseHash
    || marketplaceRecoveryStatus(state, draft.marketplace, true) !== 'available') throw new Error('Package identity, preset or file changed. Inspect and restage this draft.');
  const next = clone(draft); next.marketplace.sourceGeneration = state.marketplaceView.catalog.generation;
  next.marketplace.catalogFingerprint = state.marketplaceView.catalog.fingerprint; return next;
}

const primarySlot = (state, preset, agent) => state.primarySlots?.find(slot => slot.preset === preset && slot.agent === agent);
function primarySlotUsable(slot) {
  return Boolean(slot && safePrimaryPreset(slot.preset) && ['build', 'orchestrator'].includes(slot.agent)
    && typeof slot.defaultVariant === 'string' && (slot.blockedReason === null || typeof slot.blockedReason === 'string')
    && typeof slot.canCreate === 'boolean' && (slot.modelPath === null || Array.isArray(slot.modelPath))
    && (slot.existingGroupId === null || typeof slot.existingGroupId === 'string'));
}
function safePrimaryPreset(preset) {
  return inspectionText(preset, 128) && !['__proto__', 'prototype', 'constructor'].includes(preset);
}
function primaryPathValid(slot) {
  const prefix = ['presets', slot.preset];
  return sameModels(slot.modelPath, [...prefix, slot.agent, 'model'])
    || sameModels(slot.modelPath, [...prefix, 'agents', slot.agent, 'model']);
}
function validPrimaryCreation(state, creation, { allowStaged = true } = {}) {
  if (!creation || Object.keys(creation).some(key => !['preset', 'agent', 'models'].includes(key))
    || typeof creation.preset !== 'string' || !['build', 'orchestrator'].includes(creation.agent) || !validModels(creation.models)) return false;
  const slot = primarySlot(state, creation.preset, creation.agent);
  if (creation.agent === 'build') return false;
  const targetGroup = slot?.modelPath && state.groups.find(group => pathKey(group.path) === pathKey(slot.modelPath));
  const stagedMatch = allowStaged && targetGroup && isPendingPrimaryQueue(targetGroup)
    && targetGroup.primaryCreation.preset === creation.preset && targetGroup.primaryCreation.agent === creation.agent
    && sameModels(targetGroup.models, creation.models);
  return primarySlotUsable(slot) && slot.canCreate && !slot.blockedReason && primaryPathValid(slot)
    && !slot.existingGroupId && validModels([{ id: 'check/default', variant: slot.defaultVariant }])
    && (!targetGroup || stagedMatch);
}
function validPrimaryDraft(state, entries) {
  if (!Array.isArray(entries) || entries.length > 64) return false;
  const identities = new Set();
  for (const creation of entries) {
    const identity = `${creation?.preset}\u0000${creation?.agent}`;
    if (identities.has(identity) || !validPrimaryCreation(state, creation, { allowStaged: false })) return false;
    identities.add(identity);
  }
  return true;
}
export const isPendingPrimaryQueue = group => Boolean(group?.primaryCreation && !group.primaryCreation.saved);
export function beginPrimaryPick(state, preset, agent) {
  const slot = primarySlot(state, preset, agent);
  if (state.primaryCreations.length >= 64 || !primarySlotUsable(slot) || agent === 'build' || !slot.canCreate || slot.blockedReason || !primaryPathValid(slot)
    || !validModels([{ id: 'check/default', variant: slot.defaultVariant }]) || slot.existingGroupId
    || state.groups.some(group => pathKey(group.path) === pathKey(slot.modelPath))) return null;
  return { kind: 'primary', preset, agent, path: clone(slot.modelPath), revision: state.revision, generation: state.target.generation };
}
function addPendingPrimaryGroup(state, creation) {
  const slot = primarySlot(state, creation.preset, creation.agent);
  if (!primarySlotUsable(slot) || creation.agent === 'build' || !slot.canCreate || slot.blockedReason || !primaryPathValid(slot)
    || slot.existingGroupId || !validModels(creation.models) || state.groups.some(group => pathKey(group.path) === pathKey(slot.modelPath))) return null;
  const id = pathKey(slot.modelPath);
  const group = { id, path: clone(slot.modelPath), name: creation.agent, label: `preset ${creation.preset} · ${creation.agent}`,
    section: `Preset · ${creation.preset}`, kind: 'preset', defaultVariant: slot.defaultVariant,
    models: normalizeModels(creation.models), original: [], readOnlyReason: null,
    primaryCreation: { preset: creation.preset, agent: creation.agent, saved: false } };
  state.groups.push(group);
  return group;
}
export function applyPrimaryPick(state, pending, id) {
  if (!pending || pending.kind !== 'primary' || !validModelId(id) || state.revision !== pending.revision
    || state.target.generation !== pending.generation || !sameModels(pending.path, primarySlot(state, pending.preset, pending.agent)?.modelPath)
    || !beginPrimaryPick(state, pending.preset, pending.agent)) return null;
  const creation = { preset: pending.preset, agent: pending.agent, models: [{ id, variant: '' }] };
  if (!addPendingPrimaryGroup(state, creation)) return null;
  state.primaryCreations.push(creation); state.draftVersion = 3; touch(state);
  return state.groups.at(-1);
}
export function discardPrimaryCreation(state, groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!isPendingPrimaryQueue(group) || state.unknown || state.pendingCommit) return false;
  const { preset, agent } = group.primaryCreation;
  state.groups = state.groups.filter(item => item.id !== groupId);
  state.primaryCreations = state.primaryCreations.filter(item => item.preset !== preset || item.agent !== agent);
  if (state.selectedId === groupId) state.selectedId = state.groups[0]?.id || null;
  if (!state.primaryCreations.length && !state.marketplace) state.draftVersion = Math.max(state.draftVersion, 3);
  touch(state); return true;
}
function acknowledgePrimary(state, submitted = []) {
  for (const creation of submitted || []) {
    const group = state.groups.find(item => item.primaryCreation?.preset === creation.preset && item.primaryCreation.agent === creation.agent);
    if (!group) continue;
    group.original = clone(creation.models); group.primaryCreation.saved = true;
  }
  const sent = new Map((submitted || []).map(item => [`${item.preset}\u0000${item.agent}`, item]));
  state.primaryCreations = state.primaryCreations.filter(item => !sent.has(`${item.preset}\u0000${item.agent}`));
  for (const creation of submitted || []) {
    const slot = primarySlot(state, creation.preset, creation.agent);
    if (slot) slot.existingGroupId = pathKey(slot.modelPath);
  }
}
