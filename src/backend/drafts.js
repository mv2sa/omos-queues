// Server-side draft records. Each frame draft is independent: saving one never
// merges another, and stale drafts are kept for inspection, never auto-applied.
//
// Legacy v1 drafts stay in drafts.json, untouched and readable. Marketplace
// aware v2 drafts live separately in drafts-v2.json; the merged listing overlays
// a v2 record on an older same-UUID v1 record without rewriting the legacy file.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceError, badRequest, conflict } from './errors.js';
import { readJsonStore, writeJsonStore } from './store.js';
import { MAX_MODEL_ID, hasPlaceholder, isModelId, isValidVariant } from './model-id.js';
import {
  MAX_MARKETPLACE_CREATIONS,
  MAX_MARKETPLACE_EDITS,
  MAX_MARKETPLACE_SELECTIONS,
} from './marketplace-config.js';

export const MAX_DRAFTS = 50;
export const MAX_DRAFT_BYTES = 64 * 1024;
export const MAX_TOTAL_DRAFT_BYTES = 512 * 1024;
export const MAX_DRAFT_ENTRIES = 1000;
export const MAX_POSITIONS = 50;
export const DRAFT_VERSION_V2 = 2;
export const DRAFT_VERSION_V3 = 3;
const MAX_PRIMARY_CREATIONS = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const PACKAGE_ID_MAX = 129;
const OPAQUE_ID_MAX = 500;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function corrupt(fileName = 'drafts.json') {
  return new ServiceError(
    500,
    'DRAFTS_CORRUPT',
    `Saved drafts could not be read. Fix or remove ${fileName} in the extension data folder.`,
  );
}

function unsupportedEnvelope() {
  return new ServiceError(
    409,
    'DRAFT_UNSUPPORTED_ENVELOPE',
    'The draft store uses an unsupported envelope version. Nothing was changed.',
  );
}

function safeText(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !CONTROL.test(value) && !UNSAFE_KEYS.has(value);
}

function isCanonicalPackageId(value) {
  return typeof value === 'string' && value.length <= PACKAGE_ID_MAX
    && PACKAGE_ID.test(value)
    && !value.split('/').some(part => UNSAFE_KEYS.has(part));
}

function safeOpaqueId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= OPAQUE_ID_MAX
    && !CONTROL.test(value) && !UNSAFE_KEYS.has(value);
}

function normalizeModels(models, label) {
  if (!Array.isArray(models) || models.length < 1 || models.length > MAX_POSITIONS) {
    throw badRequest(`${label}: use between 1 and ${MAX_POSITIONS} positions.`, 'INVALID_DRAFT');
  }
  return models.map(model => {
    if (!exactKeys(model, ['id', 'variant']) || typeof model.id !== 'string' || typeof model.variant !== 'string') {
      throw badRequest(`${label}: each position needs a valid provider/model id and variant.`, 'INVALID_DRAFT');
    }
    if (hasPlaceholder(model.id) || hasPlaceholder(model.variant)) {
      throw badRequest(`${label}: environment placeholders are not expanded in drafts.`, 'INVALID_DRAFT');
    }
    if (!isModelId(model.id) || !isValidVariant(model.variant)) {
      throw badRequest(`${label}: each position needs a valid provider/model id and variant.`, 'INVALID_DRAFT');
    }
    return { id: model.id, variant: model.variant };
  });
}

function normalizeEntries(entries, label) {
  if (!Array.isArray(entries) || entries.length > MAX_DRAFT_ENTRIES) {
    throw badRequest(`${label} must be an array of at most ${MAX_DRAFT_ENTRIES} queues.`, 'INVALID_DRAFT');
  }
  return entries.map(entry => {
    if (!exactKeys(entry, ['path', 'models']) || !Array.isArray(entry.path)
      || entry.path.length < 3 || entry.path.length > 100
      || entry.path.some(part => typeof part !== 'string' || part.length > MAX_MODEL_ID)
      || entry.path[entry.path.length - 1] !== 'model') {
      throw badRequest(`${label}: each entry needs a model path ending in "model".`, 'INVALID_DRAFT');
    }
    return { path: [...entry.path], models: normalizeModels(entry.models, label) };
  });
}

function normalizeDraft(input, targetPath, at) {
  if (!isObject(input)) throw badRequest('Expected a draft object.', 'INVALID_DRAFT');
  let id;
  if (input.id === undefined || input.id === null) id = randomUUID();
  else if (typeof input.id === 'string' && UUID.test(input.id)) id = input.id;
  else throw badRequest('draft.id must be a generated UUID.', 'INVALID_DRAFT');

  if (typeof input.targetPath !== 'string' || input.targetPath !== targetPath) {
    throw conflict(
      'Drafts can only be saved for the current config target. Reload the page before saving this draft.',
      'TARGET_CHANGED',
    );
  }
  if (typeof input.baseHash !== 'string' || !/^[0-9a-f]{64}$/i.test(input.baseHash)) {
    throw badRequest('draft.baseHash must be a sha256 hex digest.', 'INVALID_DRAFT');
  }
  const originals = normalizeEntries(input.originals, 'draft.originals');
  const changes = normalizeEntries(input.changes, 'draft.changes');
  if (!changes.length) throw badRequest('A draft needs at least one changed queue.', 'INVALID_DRAFT');

  return {
    id,
    targetPath,
    baseHash: input.baseHash.toLowerCase(),
    originals,
    changes,
    updatedAt: new Date(at).toISOString(),
  };
}

function validStoredDraft(value) {
  if (!isObject(value) || typeof value.id !== 'string' || !UUID.test(value.id)) return false;
  if (typeof value.targetPath !== 'string' || typeof value.baseHash !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(value.baseHash)) return false;
  if (!Array.isArray(value.originals) || !Array.isArray(value.changes)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  try {
    normalizeEntries(value.originals, 'draft.originals');
    normalizeEntries(value.changes, 'draft.changes');
  } catch {
    return false;
  }
  return true;
}

function normalizeSelectionIds(ids, label) {
  if (!Array.isArray(ids) || ids.length > MAX_MARKETPLACE_SELECTIONS
    || ids.some(id => !safeOpaqueId(id)) || new Set(ids).size !== ids.length) {
    throw badRequest(`${label} must be unique bounded package ids.`, 'INVALID_DRAFT');
  }
  return [...ids];
}

function normalizeDraftMarketplace(marketplace) {
  if (marketplace === null || marketplace === undefined) return null;
  if (!exactKeys(marketplace, ['sourceGeneration', 'catalogFingerprint', 'edits', 'originals', 'identities'])) {
    throw badRequest('draft.marketplace has unknown or missing fields.', 'INVALID_DRAFT');
  }
  if (!safeText(marketplace.sourceGeneration, 200) || !safeText(marketplace.catalogFingerprint, 200)) {
    throw badRequest('draft.marketplace needs a source generation and catalog fingerprint.', 'INVALID_DRAFT');
  }
  if (!Array.isArray(marketplace.edits) || marketplace.edits.length < 1
    || marketplace.edits.length > MAX_MARKETPLACE_EDITS) {
    throw badRequest(
      `draft.marketplace.edits must contain 1 to ${MAX_MARKETPLACE_EDITS} presets.`,
      'INVALID_DRAFT',
    );
  }
  const seenPresets = new Set();
  const edits = marketplace.edits.map(edit => {
    if (!exactKeys(edit, ['preset', 'packageIds', 'creations'])) {
      throw badRequest('Each marketplace edit needs only preset, packageIds and creations.', 'INVALID_DRAFT');
    }
    if (!safeText(edit.preset) || seenPresets.has(edit.preset)) {
      throw badRequest('Marketplace edits need unique safe preset names.', 'INVALID_DRAFT');
    }
    seenPresets.add(edit.preset);
    const packageIds = normalizeSelectionIds(edit.packageIds, 'draft.marketplace.packageIds');
    if (!Array.isArray(edit.creations) || edit.creations.length > MAX_MARKETPLACE_CREATIONS) {
      throw badRequest(
        `At most ${MAX_MARKETPLACE_CREATIONS} marketplace creations are allowed per preset.`,
        'INVALID_DRAFT',
      );
    }
    const seenCreations = new Set();
    const creations = edit.creations.map(creation => {
      if (!exactKeys(creation, ['packageId', 'models'])) {
        throw badRequest('Each creation needs only packageId and models.', 'INVALID_DRAFT');
      }
      if (!isCanonicalPackageId(creation.packageId) || !packageIds.includes(creation.packageId)) {
        throw badRequest('A creation package must be a canonical selected package id.', 'INVALID_DRAFT');
      }
      if (seenCreations.has(creation.packageId)) {
        throw badRequest('A creation package appears more than once.', 'INVALID_DRAFT');
      }
      seenCreations.add(creation.packageId);
      return {
        packageId: creation.packageId,
        models: normalizeModels(creation.models, `preset ${edit.preset} · ${creation.packageId}`),
      };
    });
    return { preset: edit.preset, packageIds, creations };
  });

  if (!Array.isArray(marketplace.originals) || marketplace.originals.length !== edits.length) {
    throw badRequest('draft.marketplace.originals must describe each edited preset once.', 'INVALID_DRAFT');
  }
  const seenOriginals = new Set();
  const originals = marketplace.originals.map(original => {
    if (!exactKeys(original, ['preset', 'selectionPresent', 'packageIds'])) {
      throw badRequest('Each selection original needs preset, selectionPresent and packageIds.', 'INVALID_DRAFT');
    }
    if (!safeText(original.preset) || seenOriginals.has(original.preset)) {
      throw badRequest('Selection originals need unique safe preset names.', 'INVALID_DRAFT');
    }
    if (typeof original.selectionPresent !== 'boolean') {
      throw badRequest('selectionPresent must be a boolean.', 'INVALID_DRAFT');
    }
    const packageIds = normalizeSelectionIds(original.packageIds, 'draft.marketplace.original.packageIds');
    if (!original.selectionPresent && packageIds.length) {
      throw badRequest('An absent selection cannot carry package ids.', 'INVALID_DRAFT');
    }
    seenOriginals.add(original.preset);
    return { preset: original.preset, selectionPresent: original.selectionPresent, packageIds };
  });
  for (const preset of seenPresets) {
    if (!seenOriginals.has(preset)) {
      throw badRequest('draft.marketplace.originals must describe each edited preset once.', 'INVALID_DRAFT');
    }
  }
  // Retained opaque selections stay bounded but only canonical package ids may
  // be newly selected in a draft. Catalog membership is rechecked at preview.
  for (const edit of edits) {
    const original = originals.find(item => item.preset === edit.preset);
    for (const packageId of edit.packageIds) {
      if (original?.packageIds.includes(packageId)) continue;
      if (!isCanonicalPackageId(packageId)) {
        throw badRequest('A newly selected package id must be a canonical package id.', 'INVALID_DRAFT');
      }
    }
  }

  if (!Array.isArray(marketplace.identities) || marketplace.identities.length > MAX_MARKETPLACE_SELECTIONS) {
    throw badRequest(
      `draft.marketplace.identities must contain at most ${MAX_MARKETPLACE_SELECTIONS} entries.`,
      'INVALID_DRAFT',
    );
  }
  const seenIdentities = new Set();
  const identities = marketplace.identities.map(identity => {
    if (!exactKeys(identity, ['id', 'version', 'agentName', 'digest'])) {
      throw badRequest('Each identity needs only id, version, agentName and digest.', 'INVALID_DRAFT');
    }
    if (!isCanonicalPackageId(identity.id) || seenIdentities.has(identity.id)) {
      throw badRequest('Identity package ids must be unique canonical package ids.', 'INVALID_DRAFT');
    }
    if (!safeText(identity.version) || typeof identity.agentName !== 'string'
      || !AGENT_NAME.test(identity.agentName)
      || typeof identity.digest !== 'string' || !DIGEST.test(identity.digest)) {
      throw badRequest('Identity metadata is not a bounded verified projection.', 'INVALID_DRAFT');
    }
    seenIdentities.add(identity.id);
    return {
      id: identity.id,
      version: identity.version,
      agentName: identity.agentName,
      digest: identity.digest,
    };
  });

  return {
    sourceGeneration: marketplace.sourceGeneration,
    catalogFingerprint: marketplace.catalogFingerprint,
    edits,
    originals,
    identities,
  };
}

function normalizeDraftV2(input, targetPath, at, allowEmpty = false) {
  if (!isObject(input)) throw badRequest('Expected a draft object.', 'INVALID_DRAFT');
  let id;
  if (input.id === undefined || input.id === null) id = randomUUID();
  else if (typeof input.id === 'string' && UUID.test(input.id)) id = input.id;
  else throw badRequest('draft.id must be a generated UUID.', 'INVALID_DRAFT');

  if (typeof input.targetPath !== 'string' || input.targetPath !== targetPath) {
    throw conflict(
      'Drafts can only be saved for the current config target. Reload the page before saving this draft.',
      'TARGET_CHANGED',
    );
  }
  if (typeof input.baseHash !== 'string' || !/^[0-9a-f]{64}$/i.test(input.baseHash)) {
    throw badRequest('draft.baseHash must be a sha256 hex digest.', 'INVALID_DRAFT');
  }
  if (input.version !== DRAFT_VERSION_V2) {
    throw badRequest('draft.version must be 2 for a marketplace-aware draft.', 'INVALID_DRAFT');
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw badRequest('draft.revision must be a nonnegative safe integer.', 'INVALID_DRAFT');
  }
  const originals = normalizeEntries(input.originals, 'draft.originals');
  const changes = normalizeEntries(input.changes, 'draft.changes');
  const marketplace = normalizeDraftMarketplace(input.marketplace);
  if (!allowEmpty && !changes.length && !marketplace) {
    throw badRequest('A draft needs at least one staged queue or marketplace operation.', 'INVALID_DRAFT');
  }

  return {
    id,
    targetPath,
    baseHash: input.baseHash.toLowerCase(),
    version: DRAFT_VERSION_V2,
    revision: input.revision,
    originals,
    changes,
    marketplace,
    updatedAt: new Date(at).toISOString(),
  };
}

function normalizeDraftV3(input, targetPath, at) {
  if (!isObject(input) || input.version !== DRAFT_VERSION_V3) {
    throw badRequest('draft.version must be 3 for a primary-aware draft.', 'INVALID_DRAFT');
  }
  const base = normalizeDraftV2({ ...input, version: DRAFT_VERSION_V2 }, targetPath, at, true);
  if (!Array.isArray(input.primaryCreations) || input.primaryCreations.length > MAX_PRIMARY_CREATIONS) {
    throw badRequest('draft.primaryCreations must be a bounded array.', 'INVALID_DRAFT');
  }
  const seen = new Set();
  const primaryCreations = input.primaryCreations.map(item => {
    if (!exactKeys(item, ['preset', 'agent', 'models']) || !safeText(item.preset, 128)
      || item.agent !== 'orchestrator' || seen.has(item.preset)) {
      throw badRequest('Primary creations need unique safe existing preset Orchestrator identities.', 'INVALID_DRAFT');
    }
    seen.add(item.preset);
    return { preset: item.preset, agent: 'orchestrator',
      models: normalizeModels(item.models, `preset ${item.preset} · orchestrator`) };
  });
  const identities = new Set();
  for (const entry of [...base.originals, ...base.changes]) {
    const parts = entry.path;
    const preset = parts[0] === 'presets' ? parts[1] : null;
    const flat = preset !== null && parts.length === 4 && parts[2] === 'orchestrator';
    const structured = preset !== null && parts.length === 5
      && parts[2] === 'agents' && parts[3] === 'orchestrator';
    identities.add(JSON.stringify(flat ? ['presets', preset, 'orchestrator', 'model']
      : structured ? ['presets', preset, 'agents', 'orchestrator', 'model'] : parts));
  }
  for (const item of primaryCreations) {
    const candidates = [
      JSON.stringify(['presets', item.preset, 'orchestrator', 'model']),
      JSON.stringify(['presets', item.preset, 'agents', 'orchestrator', 'model']),
    ];
    if (candidates.some(identity => identities.has(identity))) {
      throw badRequest('Draft operations overlap the same logical model identity.', 'INVALID_DRAFT');
    }
    identities.add(candidates[0]);
    identities.add(candidates[1]);
  }
  if (!base.changes.length && !base.marketplace && !primaryCreations.length) {
    throw badRequest('A draft needs at least one staged operation.', 'INVALID_DRAFT');
  }
  return { ...base, version: DRAFT_VERSION_V3, primaryCreations };
}

function validStoredV3(value) {
  try {
    if (!exactKeys(value, ['id', 'targetPath', 'baseHash', 'version', 'revision', 'originals',
      'changes', 'marketplace', 'updatedAt', 'primaryCreations']) || typeof value.updatedAt !== 'string') return null;
    return normalizeDraftV3(value, value.targetPath, Date.parse(value.updatedAt));
  } catch { return false; }
}

function validStoredV2(value) {
  if (!isObject(value) || typeof value.id !== 'string' || !UUID.test(value.id)) return false;
  if (typeof value.targetPath !== 'string' || typeof value.baseHash !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(value.baseHash)) return false;
  if (value.version !== DRAFT_VERSION_V2) return false;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!Array.isArray(value.originals) || !Array.isArray(value.changes)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  try {
    normalizeDraftV2(value, value.targetPath, Date.parse(value.updatedAt));
  } catch {
    return false;
  }
  return true;
}

function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordBytes(record) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

function logicalIds(v1List, v2Entries) {
  const ids = new Set(v1List.map(draft => draft.id));
  for (const entry of v2Entries) ids.add(entry.value.id);
  return ids;
}

export function createDraftStore({ dataDir, now = Date.now, hooks = {} } = {}) {
  const fileV1 = path.join(dataDir, 'drafts.json');
  const fileV2 = path.join(dataDir, 'drafts-v2.json');
  const writeV1 = hooks.writeV1 ?? (value => writeJsonStore(fileV1, value));
  const writeV2 = hooks.writeV2 ?? (value => writeJsonStore(fileV2, value));
  let v1Drafts = null;
  let v2Entries = null;

  function loadV1() {
    if (v1Drafts) return v1Drafts;
    let record;
    try {
      record = readJsonStore(fileV1, { version: 1, drafts: [] });
    } catch {
      throw corrupt('drafts.json');
    }
    if (!isObject(record) || !Array.isArray(record.drafts)) throw corrupt('drafts.json');
    v1Drafts = record.drafts.filter(validStoredDraft);
    return v1Drafts;
  }

  function loadV2() {
    if (v2Entries) return v2Entries;
    let record;
    try {
      record = readJsonStore(fileV2, { version: 2, drafts: [] });
    } catch {
      throw corrupt('drafts-v2.json');
    }
    if (!isObject(record) || record.version !== 2 || !Array.isArray(record.drafts)) {
      if (isObject(record) && record.version !== 2) throw unsupportedEnvelope();
      throw corrupt('drafts-v2.json');
    }
    const entries = [];
    for (const value of record.drafts) {
      if (!isObject(value) || typeof value.id !== 'string' || !UUID.test(value.id)) {
        throw corrupt('drafts-v2.json');
      }
      if (value.version === DRAFT_VERSION_V2) {
        if (!validStoredV2(value)) throw corrupt('drafts-v2.json');
        entries.push({ kind: 'known', value });
      } else if (value.version === DRAFT_VERSION_V3) {
        const normalized = validStoredV3(value);
        if (normalized) entries.push({ kind: 'known', value: normalized });
        else entries.push({ kind: 'unknown', value });
      } else if (Number.isSafeInteger(value.version)) {
        // A newer version is retained verbatim and shown read-only. It is never
        // filtered out, overwritten or silently migrated.
        entries.push({ kind: 'unknown', value });
      } else {
        throw corrupt('drafts-v2.json');
      }
    }
    v2Entries = entries;
    return v2Entries;
  }

  function persistV1(next) {
    try {
      writeV1({ version: 1, drafts: next });
    } catch {
      throw new ServiceError(
        507,
        'DRAFT_STORAGE',
        'The draft could not be saved in the extension data folder. Existing drafts were kept.',
      );
    }
  }

  function persistV2(entries) {
    try {
      writeV2({ version: 2, drafts: entries.map(entry => entry.value) });
    } catch {
      throw new ServiceError(
        507,
        'DRAFT_STORAGE',
        'The draft could not be saved in the extension data folder. Existing drafts were kept.',
      );
    }
  }

  function payloadBytes(version, records) {
    return Buffer.byteLength(JSON.stringify({ version, drafts: records }, null, 2), 'utf8');
  }

  function totalBytes(v1List, entries) {
    // Count both files as they are physically written, so the shared 512 KiB
    // budget cannot hide pretty-print growth.
    return payloadBytes(1, v1List)
      + payloadBytes(2, entries.map(entry => entry.value));
  }

  function publicV2(entry) {
    if (entry.kind === 'unknown') {
      // Unknown records are inspect-only. Never spread the raw object: future
      // fields may contain private configuration, prompts or credentials.
      const value = entry.value;
      const header = {
        version: value.version,
        readOnlyReason: 'This draft was saved by a newer extension version and is read-only.',
      };
      if (typeof value.id === 'string' && UUID.test(value.id)) header.id = value.id;
      if (typeof value.targetPath === 'string' && value.targetPath.length > 0
        && value.targetPath.length <= 4096
        && !CONTROL.test(value.targetPath)) header.targetPath = value.targetPath;
      if (typeof value.baseHash === 'string' && /^[0-9a-f]{64}$/i.test(value.baseHash)) {
        header.baseHash = value.baseHash;
      }
      if (typeof value.updatedAt === 'string' && value.updatedAt.length <= 40
        && !Number.isNaN(Date.parse(value.updatedAt))
        && new Date(value.updatedAt).toISOString() === value.updatedAt) {
        header.updatedAt = value.updatedAt;
      }
      return header;
    }
    return cloneRecord(entry.value);
  }

  function merged() {
    const v1List = loadV1();
    const entries = loadV2();
    const byId = new Map(entries.map(entry => [entry.value.id, entry]));
    const listed = [];
    const seen = new Set();
    for (const draft of v1List) {
      seen.add(draft.id);
      const overlay = byId.get(draft.id);
      listed.push(overlay ? publicV2(overlay) : { ...draft });
    }
    for (const entry of entries) {
      if (seen.has(entry.value.id)) continue;
      listed.push(publicV2(entry));
    }
    return listed;
  }

  function saveV1(input, targetPath) {
    const currentV1 = loadV1();
    const currentV2 = loadV2();
    const draft = normalizeDraft(input, targetPath, now());
    if (currentV2.some(entry => entry.value.id === draft.id)) {
      throw conflict(
        'This draft has a newer staged format. Reload the page; an older-format save cannot replace it.',
        'DRAFT_VERSION_CONFLICT',
      );
    }
    if (recordBytes(draft) > MAX_DRAFT_BYTES) {
      throw new ServiceError(507, 'DRAFT_TOO_LARGE',
        'This draft record is larger than the 64 KiB draft limit.');
    }
    const index = currentV1.findIndex(item => item.id === draft.id);
    const logical = logicalIds(currentV1, currentV2);
    if (!logical.has(draft.id) && logical.size >= MAX_DRAFTS) {
      throw new ServiceError(507, 'DRAFT_LIMIT',
        `At most ${MAX_DRAFTS} drafts can be stored. Delete one before saving another.`);
    }
    const next = [...currentV1];
    if (index === -1) next.push(draft);
    else next[index] = draft;
    if (totalBytes(next, currentV2) > MAX_TOTAL_DRAFT_BYTES) {
      throw new ServiceError(507, 'DRAFT_LIMIT',
        'Stored drafts exceed the 512 KiB draft budget. Delete one before saving another.');
    }
    persistV1(next);
    v1Drafts = next;
    return { draft: { ...draft } };
  }

  function saveV2(input, targetPath) {
    const currentV1 = loadV1();
    const currentV2 = loadV2();
    const draft = input.version === DRAFT_VERSION_V3
      ? normalizeDraftV3(input, targetPath, now())
      : normalizeDraftV2(input, targetPath, now());
    const legacy = currentV1.find(item => item.id === draft.id);
    if (legacy && legacy.targetPath !== targetPath) {
      throw conflict(
        'The older copy of this draft belongs to a different config target. Reload before saving.',
        'TARGET_CHANGED',
      );
    }
    const index = currentV2.findIndex(entry => entry.value.id === draft.id);
    const existing = index === -1 ? null : currentV2[index];
    if (existing?.kind === 'known' && existing.value.targetPath !== targetPath) {
      throw conflict(
        'This draft belongs to a different config target. Reload before saving.',
        'TARGET_CHANGED',
      );
    }
    if (existing?.kind === 'unknown') {
      throw conflict(
        'This draft was saved by a newer extension version and cannot be replaced.',
        'DRAFT_UNSUPPORTED_VERSION',
      );
    }
    if (existing?.kind === 'known' && existing.value.version > draft.version) {
      throw conflict('A newer staged format cannot be replaced by an older-format save.', 'DRAFT_VERSION_CONFLICT');
    }
    if (existing?.kind === 'known' && draft.revision < existing.value.revision) {
      throw conflict(
        'A newer revision of this draft is already stored. Reload before saving.',
        'DRAFT_REVISION_STALE',
      );
    }
    if (recordBytes(draft) > MAX_DRAFT_BYTES) {
      throw new ServiceError(507, 'DRAFT_TOO_LARGE',
        'This draft record is larger than the 64 KiB draft limit.');
    }
    const logical = logicalIds(currentV1, currentV2);
    if (!logical.has(draft.id) && logical.size >= MAX_DRAFTS) {
      throw new ServiceError(507, 'DRAFT_LIMIT',
        `At most ${MAX_DRAFTS} drafts can be stored. Delete one before saving another.`);
    }
    const next = [...currentV2];
    const entry = { kind: 'known', value: draft };
    if (index === -1) next.push(entry);
    else next[index] = entry;
    if (totalBytes(currentV1, next) > MAX_TOTAL_DRAFT_BYTES) {
      throw new ServiceError(507, 'DRAFT_LIMIT',
        'Stored drafts exceed the 512 KiB draft budget. Delete one before saving another.');
    }
    // The legacy v1 file is intentionally not rewritten: it stays until the
    // explicit acknowledged delete, while the merged view shows this v2 frame.
    persistV2(next);
    v2Entries = next;
    return { draft: cloneRecord(draft) };
  }

  return {
    list() {
      return { drafts: merged() };
    },
    save(input, { targetPath }) {
      if (!isObject(input)) throw badRequest('Expected a draft object.', 'INVALID_DRAFT');
      if (input.version === DRAFT_VERSION_V2 || input.version === DRAFT_VERSION_V3) return saveV2(input, targetPath);
      if (input.version !== undefined && input.version !== 1) {
        throw badRequest('Unsupported draft version.', 'INVALID_DRAFT');
      }
      return saveV1(input, targetPath);
    },
    remove(id) {
      const currentV1 = loadV1();
      const currentV2 = loadV2();
      const v1Index = currentV1.findIndex(item => item.id === id);
      const v2Index = currentV2.findIndex(entry => entry.value.id === id);
      if (v1Index === -1 && v2Index === -1) {
        throw new ServiceError(404, 'DRAFT_NOT_FOUND', 'That draft no longer exists.');
      }
      if (v2Index !== -1 && currentV2[v2Index].kind === 'unknown') {
        throw conflict(
          'This draft was saved by a newer extension version and is read-only.',
          'DRAFT_UNSUPPORTED_VERSION',
        );
      }
      const nextV1 = currentV1.filter(item => item.id !== id);
      const nextV2 = currentV2.filter(entry => entry.value.id !== id);
      let removedV1 = false;
      // Delete the legacy copy first so a later v2 failure cannot resurrect it
      // in the merged view. A partial failure is reported honestly.
      if (v1Index !== -1) {
        persistV1(nextV1);
        v1Drafts = nextV1;
        removedV1 = true;
      }
      if (v2Index !== -1) {
        try {
          persistV2(nextV2);
          v2Entries = nextV2;
        } catch (error) {
          if (removedV1) {
            throw new ServiceError(
              507,
              'DRAFT_PARTIAL_DELETE',
              'The older copy was removed, but the current draft could not be deleted. It is still listed; retry the delete.',
            );
          }
          throw error;
        }
      }
      return { ok: true, id };
    },
  };
}
