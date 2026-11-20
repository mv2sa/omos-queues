// Pure marketplace projection and staging planner. No store, filesystem or
// source-adapter I/O lives here: the verified catalog is supplied by the
// caller. Raw activation is presets.<preset>.marketplace.agents only.
import { findNodeAtLocation, parse, parseTree, printParseErrorCode } from 'jsonc-parser';
import { ServiceError, badRequest, conflict } from './errors.js';
import { MAX_MODEL_ID, hasPlaceholder, isModelId, isValidVariant } from './model-id.js';

export const MAX_MARKETPLACE_PRESETS = 256;
export const MAX_MARKETPLACE_EDITS = 64;
export const MAX_MARKETPLACE_SELECTIONS = 64;
export const MAX_MARKETPLACE_CREATIONS = 64;
export const MAX_POSITIONS = 50;

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const PACKAGE_ID_MAX = 129;
const OPAQUE_ID_MAX = 500;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MODEL_SOURCES = new Set(['session', 'orchestrator', 'explicit', 'builtin']);
// The OMOS preset agent override schema is strict. These keys mean an `agents`
// object is a legacy agent definition, not a structured container.
const AGENT_DEFINITION_KEYS = new Set([
  'model', 'inheritModelFrom', 'temperature', 'variant', 'skills', 'skills_add',
  'skills_remove', 'skills_include_local', 'mcps', 'prompt', 'orchestratorPrompt',
  'options', 'displayName', 'color', 'description', 'primary', 'subagents', 'permission',
]);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseText(text) {
  const errors = [];
  const config = parse(text, errors, PARSE_OPTIONS);
  if (errors.length || !isObject(config)) {
    const detail = errors.length
      ? `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`
      : 'expected the top level to be an object';
    throw new ServiceError(422, 'CONFIG_INVALID',
      `The config is not valid JSONC (${detail}). Nothing was written.`);
  }
  return config;
}

function safeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value) && !UNSAFE_KEYS.has(value);
}

// A canonical package id is at most 64 + "/" + 64 characters. Existing opaque
// selection ids are allowed to be longer so unknown selections can be retained.
function isCanonicalPackageId(value) {
  return typeof value === 'string' && value.length <= PACKAGE_ID_MAX
    && PACKAGE_ID.test(value)
    && !value.split('/').some(part => UNSAFE_KEYS.has(part));
}

function safeOpaqueId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= OPAQUE_ID_MAX
    && !/[\u0000-\u001f\u007f]/.test(value) && !UNSAFE_KEYS.has(value);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function modelPathFor(preset, layout, agentName) {
  if (layout === 'structured') return ['presets', preset, 'agents', agentName, 'model'];
  if (layout === 'flat') {
    // A flat agent must never overwrite marketplace activation or the
    // structured agents container.
    if (agentName === 'marketplace' || agentName === 'agents') return null;
    return ['presets', preset, agentName, 'model'];
  }
  return null;
}

function agentContainerHas(preset, layout, agentName) {
  if (layout === 'structured') {
    return isObject(preset.agents) && Object.hasOwn(preset.agents, agentName);
  }
  if (layout === 'flat') return Object.hasOwn(preset, agentName);
  return false;
}

function normalizeCatalog(catalog) {
  if (Array.isArray(catalog)) {
    return { ready: true, generation: null, fingerprint: null, packages: catalog };
  }
  if (isObject(catalog) && catalog.state === 'ready' && Array.isArray(catalog.packages)) {
    return {
      ready: true,
      generation: typeof catalog.generation === 'string' ? catalog.generation : null,
      fingerprint: typeof catalog.fingerprint === 'string' ? catalog.fingerprint : null,
      packages: catalog.packages,
    };
  }
  return { ready: false, generation: null, fingerprint: null, packages: [] };
}

function normalizePackage(raw) {
  if (!isObject(raw) || !isCanonicalPackageId(raw.id)
    || typeof raw.agentName !== 'string' || !AGENT_NAME.test(raw.agentName)) return null;
  const version = typeof raw.version === 'string' && raw.version.length > 0 && raw.version.length <= 128
    ? raw.version : '';
  const digest = typeof raw.digest === 'string' && DIGEST.test(raw.digest) ? raw.digest : '';
  let blockedReason = typeof raw.blockedReason === 'string' && raw.blockedReason
    ? raw.blockedReason.slice(0, 500) : null;
  if (['build', 'orchestrator'].includes(raw.agentName) ||
    ['build', 'orchestrator'].includes(String(raw.displayName || '').trim().toLowerCase())) {
    blockedReason ||= 'This package collides with a primary agent identity.';
  }
  if (!version) blockedReason = blockedReason || 'Package version is unavailable.';
  if (!digest) blockedReason = blockedReason || 'Package digest is unavailable.';
  return {
    id: raw.id,
    version,
    agentName: raw.agentName,
    displayName: typeof raw.displayName === 'string' && raw.displayName
      ? raw.displayName.slice(0, 200) : raw.agentName,
    modelSource: MODEL_SOURCES.has(raw.modelSource) ? raw.modelSource : 'builtin',
    digest,
    blockedReason,
  };
}

// Activation is the only first-slice meaning for a preset `marketplace` object.
// A legacy custom agent with prompt/variant/options fields must not be
// repurposed by adding `agents`.
function marketplaceActivationStatus(value) {
  if (value === undefined) return { ok: true };
  if (!isObject(value)) {
    return { ok: false, reason: 'The preset marketplace configuration is not an object.' };
  }
  if (Object.keys(value).some(key => key !== 'agents')) {
    return {
      ok: false,
      reason: 'The preset marketplace object contains non-activation fields.',
    };
  }
  return { ok: true };
}

// A structured `agents` wrapper is unambiguous only when every value is an
// object and no key is an agent-definition field. An agent-definition-shaped
// wrapper is a legacy agent named `agents`, so it must fail closed rather than
// be treated as a container.
function agentsContainerStatus(value) {
  if (!isObject(value)) {
    return { ok: false, reason: 'The preset agents container is not an object.' };
  }
  const keys = Object.keys(value);
  if (keys.some(key => AGENT_DEFINITION_KEYS.has(key))) {
    return {
      ok: false,
      reason: 'The preset agents object looks like an agent definition, not a structured container.',
    };
  }
  if (keys.some(key => !isObject(value[key]))) {
    return {
      ok: false,
      reason: 'The preset agents container has a non-object agent definition.',
    };
  }
  return { ok: true };
}

function existingAgentEntry(presetValue, layout, agentName) {
  if (layout === 'structured') {
    return isObject(presetValue.agents) && Object.hasOwn(presetValue.agents, agentName)
      ? presetValue.agents[agentName]
      : null;
  }
  if (layout === 'flat') {
    // `marketplace` is activation and `agents` is the structured container.
    // Never read either as a flat agent definition.
    if (agentName === 'marketplace' || agentName === 'agents') return null;
    return Object.hasOwn(presetValue, agentName) ? presetValue[agentName] : null;
  }
  return null;
}

function defaultVariantFor(existingGroup, existingEntry) {
  const variant = existingGroup
    ? existingGroup.defaultVariant
    : isObject(existingEntry) && Object.hasOwn(existingEntry, 'variant')
      ? existingEntry.variant
      : undefined;
  if (variant === undefined) return { value: '', valid: true };
  if (typeof variant !== 'string' || hasPlaceholder(variant) || !isValidVariant(variant)) {
    return {
      value: '',
      valid: false,
      reason: 'The existing agent default variant is unresolved or unsupported.',
    };
  }
  return { value: variant, valid: true };
}

// The file layout, unlike package admission, does not depend on a catalog.
export function inspectPresetLayout(presetValue) {
  let layout = 'flat';
  let shapeReason = null;
  if (!isObject(presetValue)) {
    layout = 'unsupported';
    shapeReason = 'Preset is not an object.';
  } else if (Object.hasOwn(presetValue, 'extends')) {
    layout = 'unsupported';
    shapeReason = 'Presets using extends are not supported.';
  } else if (Object.hasOwn(presetValue, 'marketplacePresets')) {
    layout = 'unsupported';
    shapeReason = 'Runtime-derived marketplacePresets cannot be staged.';
  } else {
    const activation = marketplaceActivationStatus(presetValue.marketplace);
    if (!activation.ok) {
      layout = 'unsupported';
      shapeReason = activation.reason;
    } else if (Object.hasOwn(presetValue, 'agents')) {
      const container = agentsContainerStatus(presetValue.agents);
      if (!container.ok) {
        layout = 'unsupported';
        shapeReason = container.reason;
      } else {
        const extra = Object.keys(presetValue)
          .filter(key => key !== 'agents' && key !== 'marketplace');
        if (extra.length) {
          layout = 'unsupported';
          shapeReason = 'The preset mixes structured and flat agents: top-level agent entries outside the agents container are ambiguous.';
        } else {
          layout = 'structured';
        }
      }
    } else {
      // Flat presets are a catchall of agent override objects plus optional
      // marketplace activation. A scalar top-level value is not an agent.
      const invalidFlatEntry = Object.entries(presetValue)
        .find(([key, value]) => key !== 'marketplace' && !isObject(value));
      if (invalidFlatEntry) {
        layout = 'unsupported';
        shapeReason = 'The flat preset contains a non-agent top-level value.';
      } else {
        layout = 'flat';
      }
    }
  }

  return { layout, shapeReason };
}

function inspectPreset(config, presetName, presetValue, groups, tree, catalog) {
  if (!safeName(presetName)) {
    return { name: presetName, layout: 'unsupported', editable: false,
      reason: 'Unsafe preset identity.', selectionPresent: false, packageIds: [], agents: [] };
  }
  const { layout, shapeReason } = inspectPresetLayout(presetValue);
  let selectionPresent = false;
  let selectionValid = true;
  let selectionReason = null;
  let packageIds = [];
  if (isObject(presetValue) && isObject(presetValue.marketplace)
    && Object.hasOwn(presetValue.marketplace, 'agents')) {
    selectionPresent = true;
    const raw = presetValue.marketplace.agents;
    if (!Array.isArray(raw) || raw.length > MAX_MARKETPLACE_SELECTIONS
      || raw.some(id => !safeOpaqueId(id))) {
      selectionValid = false;
      selectionReason = 'Marketplace selection is not a bounded package-id list.';
    } else if (new Set(raw).size !== raw.length) {
      selectionValid = false;
      selectionReason = 'Marketplace selection contains duplicate package ids.';
    } else {
      packageIds = [...raw];
    }
  }

  const packages = [];
  const packageIdsSet = new Set(packageIds);
  const packageById = new Map();
  for (const raw of catalog.packages) {
    const pkg = normalizePackage(raw);
    if (!pkg || packageById.has(pkg.id)) continue;
    packageById.set(pkg.id, pkg);
    packages.push(pkg);
  }
  const agentCounts = new Map();
  for (const pkg of packages) {
    agentCounts.set(pkg.agentName, (agentCounts.get(pkg.agentName) || 0) + 1);
  }

  const presetReason = (() => {
    if (shapeReason) return shapeReason;
    if (!catalog.ready) return 'Marketplace source is not ready.';
    if (!selectionValid) return selectionReason;
    return null;
  })();
  const editable = presetReason === null;

  const agents = packages.map(pkg => {
    const modelPath = modelPathFor(presetName, layout, pkg.agentName);
    const existingGroupId = modelPath ? JSON.stringify(modelPath) : null;
    const existingGroup = modelPath
      ? groups.find(group => group.id === existingGroupId) ?? null
      : null;
    const modelNode = modelPath && tree ? findNodeAtLocation(tree, modelPath) : null;
    const existingEntry = isObject(presetValue)
      ? existingAgentEntry(presetValue, layout, pkg.agentName)
      : null;
    const defaultVariant = defaultVariantFor(existingGroup, existingEntry);
    const parentHasAgent = isObject(presetValue) && agentContainerHas(presetValue, layout, pkg.agentName);
    const rootOverride = isObject(config.agents) && Object.hasOwn(config.agents, pkg.agentName);
    let blockedReason = pkg.blockedReason;
    if (!blockedReason && agentCounts.get(pkg.agentName) !== 1) {
      blockedReason = 'Agent name is not unique among installed packages.';
    }
    if (!blockedReason && !editable) blockedReason = presetReason;
    if (!blockedReason && !modelPath) {
      blockedReason = layout === 'flat'
        && (pkg.agentName === 'marketplace' || pkg.agentName === 'agents')
        ? 'Agent name collides with a reserved preset key.'
        : 'Preset layout is unsupported.';
    }
    if (!blockedReason && modelNode) {
      blockedReason = 'An explicit model queue already exists; edit it in the editor.';
    }
    if (!blockedReason && !defaultVariant.valid) {
      blockedReason = defaultVariant.reason;
    }
    if (!blockedReason && parentHasAgent && !modelNode) {
      blockedReason = 'Agent identity already has a custom definition.';
    }
    if (!blockedReason && rootOverride) {
      blockedReason = 'A root agent with this name would shadow the preset override.';
    }
    return {
      packageId: pkg.id,
      agentName: pkg.agentName,
      selected: packageIdsSet.has(pkg.id),
      existingGroupId: existingGroup ? existingGroup.id : null,
      modelPath,
      defaultVariant: defaultVariant.value,
      canCreate: blockedReason === null,
      blockedReason,
    };
  });

  for (const packageId of packageIds) {
    if (packageById.has(packageId)) continue;
    agents.push({
      packageId,
      agentName: null,
      selected: true,
      existingGroupId: null,
      modelPath: null,
      defaultVariant: '',
      canCreate: false,
      blockedReason: 'Unknown installed package identity.',
    });
  }

  return {
    name: presetName,
    layout,
    editable,
    reason: presetReason,
    selectionPresent,
    packageIds,
    agents,
    packageById,
    agentCounts,
    selectionValid,
  };
}

function rootState(config) {
  const root = config.marketplace;
  const present = Object.hasOwn(config, 'marketplace');
  const enabled = isObject(root) && Object.hasOwn(root, 'enabled') ? root.enabled : true;
  const rootUnsupported = (present && !isObject(root)) || typeof enabled !== 'boolean'
    || (isObject(root) && Object.hasOwn(root, 'agents'))
    || Object.hasOwn(config, 'marketplacePresets');
  return {
    masterEnabled: !rootUnsupported && enabled,
    rootUnsupported,
    reason: rootUnsupported ? 'Root marketplace configuration is unsupported.' : null,
  };
}

export function describeMarketplaceConfig({ text, groups, catalog } = {}) {
  const config = parseText(text);
  const tree = parseTree(text, [], PARSE_OPTIONS);
  const catalogView = normalizeCatalog(catalog);
  const root = rootState(config);
  if (isObject(config.presets) && Object.keys(config.presets).length > MAX_MARKETPLACE_PRESETS) {
    throw new ServiceError(422, 'MARKETPLACE_UNSUPPORTED',
      'The config has more presets than the marketplace view supports. Nothing was changed.');
  }
  const presets = [];
  if (isObject(config.presets)) {
    for (const [name, value] of Object.entries(config.presets)) {
      const inspected = inspectPreset(config, name, value, groups ?? [], tree, catalogView);
      const reason = root.rootUnsupported ? root.reason
        : !root.masterEnabled ? 'Marketplace master is disabled.'
          : inspected.reason;
      const editable = reason === null;
      presets.push({
        name,
        layout: inspected.layout,
        editable,
        reason,
        selectionPresent: inspected.selectionPresent,
        packageIds: [...inspected.packageIds],
        agents: inspected.agents.map(agent => ({
          ...agent,
          canCreate: editable && agent.canCreate,
          blockedReason: agent.blockedReason ?? (editable ? null : reason),
        })),
      });
    }
  }
  // Native OMOS stores the active preset in `preset`; `activePreset` is not the
  // file field and must never be guessed from it.
  const activePreset = typeof config.preset === 'string'
    && isObject(config.presets) && Object.hasOwn(config.presets, config.preset)
    ? config.preset
    : null;
  return {
    masterEnabled: root.masterEnabled,
    activePreset,
    presets,
  };
}

export function normalizeLiteralModels(models, label) {
  if (!Array.isArray(models) || models.length < 1 || models.length > MAX_POSITIONS) {
    throw badRequest(`${label}: use between 1 and ${MAX_POSITIONS} positions.`, 'INVALID_MODELS');
  }
  return models.map(model => {
    if (!isObject(model) || typeof model.id !== 'string' || typeof model.variant !== 'string') {
      throw badRequest(`${label}: each position needs a provider/model id and a variant string.`, 'INVALID_MODELS');
    }
    if (hasPlaceholder(model.id) || hasPlaceholder(model.variant)) {
      throw badRequest(`${label}: environment placeholders are not expanded; choose a literal model.`, 'INVALID_MODELS');
    }
    if (model.id.length > MAX_MODEL_ID || !isModelId(model.id)) {
      throw badRequest(`${label}: choose a provider/model id compatible with OMOS.`, 'INVALID_MODELS');
    }
    if (!isValidVariant(model.variant)) {
      throw badRequest(`${label}: choose a single-line variant within the supported bounds.`, 'INVALID_MODELS');
    }
    return { id: model.id, variant: model.variant };
  });
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export function planMarketplaceConfig({
  text, config, groups, catalog, marketplace,
} = {}) {
  if (marketplace === null || marketplace === undefined) return null;
  if (!exactKeys(marketplace, ['sourceGeneration', 'catalogFingerprint', 'edits'])) {
    throw badRequest('Marketplace input has unknown or missing fields.', 'INVALID_MARKETPLACE');
  }
  if (typeof marketplace.sourceGeneration !== 'string' || !marketplace.sourceGeneration
    || typeof marketplace.catalogFingerprint !== 'string' || !marketplace.catalogFingerprint) {
    throw badRequest('Marketplace source binding is required.', 'INVALID_MARKETPLACE');
  }
  const catalogView = normalizeCatalog(catalog);
  if (!catalogView.ready || !catalogView.generation || !catalogView.fingerprint) {
    throw conflict('Marketplace source is not ready. Nothing was written.', 'MARKETPLACE_SOURCE_UNAVAILABLE');
  }
  if (catalogView.generation !== marketplace.sourceGeneration) {
    throw conflict('The marketplace source generation changed. Nothing was written.', 'MARKETPLACE_SOURCE_CHANGED');
  }
  if (catalogView.fingerprint !== marketplace.catalogFingerprint) {
    throw conflict('The installed marketplace catalog changed. Nothing was written.', 'MARKETPLACE_CATALOG_CHANGED');
  }
  if (!Array.isArray(marketplace.edits) || marketplace.edits.length < 1
    || marketplace.edits.length > MAX_MARKETPLACE_EDITS) {
    throw badRequest(`Marketplace edits must contain 1 to ${MAX_MARKETPLACE_EDITS} presets.`, 'INVALID_MARKETPLACE');
  }
  const tree = parseTree(text, [], PARSE_OPTIONS);
  const root = rootState(config);
  if (root.rootUnsupported) throw badRequest(root.reason, 'MARKETPLACE_UNSUPPORTED');
  if (!root.masterEnabled) throw badRequest('Marketplace master is disabled.', 'MARKETPLACE_UNSUPPORTED');
  if (!isObject(config.presets)) throw badRequest('The config has no presets.', 'MARKETPLACE_UNSUPPORTED');
  if (Object.keys(config.presets).length > MAX_MARKETPLACE_PRESETS) {
    throw badRequest('The config has more presets than the marketplace stage supports.',
      'MARKETPLACE_UNSUPPORTED');
  }

  const mutations = [];
  const creations = [];
  const labels = [];
  const seenPresets = new Set();
  const seenCreations = new Set();

  for (const edit of marketplace.edits) {
    if (!exactKeys(edit, ['preset', 'packageIds', 'creations'])) {
      throw badRequest('Each marketplace edit needs only preset, packageIds and creations.', 'INVALID_MARKETPLACE');
    }
    if (!safeName(edit.preset) || !Object.hasOwn(config.presets, edit.preset) || seenPresets.has(edit.preset)) {
      throw badRequest('Marketplace edits require unique existing preset names.', 'INVALID_MARKETPLACE');
    }
    seenPresets.add(edit.preset);
    const presetValue = config.presets[edit.preset];
    const inspected = inspectPreset(config, edit.preset, presetValue, groups ?? [], tree, catalogView);
    if (!inspected.editable) {
      throw badRequest(inspected.reason || 'This preset cannot be staged.', 'MARKETPLACE_UNSUPPORTED');
    }
    if (!Array.isArray(edit.packageIds) || edit.packageIds.length > MAX_MARKETPLACE_SELECTIONS
      || edit.packageIds.some(id => !safeOpaqueId(id))
      || new Set(edit.packageIds).size !== edit.packageIds.length) {
      throw badRequest('packageIds must be unique bounded package ids.', 'INVALID_MARKETPLACE');
    }
    if (!Array.isArray(edit.creations) || edit.creations.length > MAX_MARKETPLACE_CREATIONS) {
      throw badRequest(`At most ${MAX_MARKETPLACE_CREATIONS} creations are allowed per preset.`, 'INVALID_MARKETPLACE');
    }
    const rawSelection = inspected.packageIds;
    const rawSet = new Set(rawSelection);
    for (const packageId of edit.packageIds) {
      const pkg = inspected.packageById.get(packageId);
      const alreadySelected = rawSet.has(packageId);
      if (!pkg) {
        if (!alreadySelected) {
          throw badRequest('A selected package is not installed.', 'MARKETPLACE_UNSUPPORTED');
        }
        continue;
      }
      if (alreadySelected) continue;
      if (pkg.blockedReason) {
        throw badRequest('A blocked package cannot be newly selected.', 'MARKETPLACE_UNSUPPORTED');
      }
      if (inspected.agentCounts.get(pkg.agentName) !== 1) {
        throw badRequest('Agent name is not unique among installed packages.', 'MARKETPLACE_UNSUPPORTED');
      }
      const modelPath = modelPathFor(edit.preset, inspected.layout, pkg.agentName);
      if (!modelPath) {
        throw badRequest(
          inspected.layout === 'flat'
            && (pkg.agentName === 'marketplace' || pkg.agentName === 'agents')
            ? 'Agent name collides with a reserved preset key.'
            : 'Preset layout is unsupported.',
          'MARKETPLACE_UNSUPPORTED',
        );
      }
      if (findNodeAtLocation(tree, modelPath)) {
        throw badRequest('An explicit model queue already exists; edit it in the editor.',
          'MARKETPLACE_UNSUPPORTED');
      }
      if (agentContainerHas(presetValue, inspected.layout, pkg.agentName)) {
        throw badRequest('Agent identity already has a custom definition.', 'MARKETPLACE_UNSUPPORTED');
      }
      if (isObject(config.agents) && Object.hasOwn(config.agents, pkg.agentName)) {
        throw badRequest('A root agent with this name would shadow the preset override.',
          'MARKETPLACE_UNSUPPORTED');
      }
    }
    const requested = new Set(edit.packageIds);
    // Known packages follow the requested resulting selection. Unknown already
    // selected ids can only be retained unchanged, never added or removed.
    const retainedUnknown = rawSelection.filter(packageId =>
      !inspected.packageById.has(packageId) && !requested.has(packageId));
    const resultSelection = [...edit.packageIds, ...retainedUnknown];
    if (resultSelection.length > MAX_MARKETPLACE_SELECTIONS) {
      throw badRequest(
        `At most ${MAX_MARKETPLACE_SELECTIONS} resulting package selections are allowed.`,
        'INVALID_MARKETPLACE',
      );
    }

    for (const packageId of rawSelection) {
      if (resultSelection.includes(packageId)) continue;
      const pkg = inspected.packageById.get(packageId);
      if (!pkg) continue;
      const modelPath = modelPathFor(edit.preset, inspected.layout, pkg.agentName);
      const modelNode = modelPath ? findNodeAtLocation(tree, modelPath) : null;
      const parentHasAgent = agentContainerHas(presetValue, inspected.layout, pkg.agentName);
      const rootOverride = isObject(config.agents) && Object.hasOwn(config.agents, pkg.agentName);
      if (modelNode || parentHasAgent || rootOverride) {
        throw badRequest('Deselecting this package would orphan an existing agent override.',
          'MARKETPLACE_ORPHAN');
      }
    }

    if (!sameArray(rawSelection, resultSelection)) {
      const path = ['presets', edit.preset, 'marketplace', 'agents'];
      mutations.push({
        path,
        value: resultSelection,
        label: `preset ${edit.preset} · marketplace selection`,
        created: !findNodeAtLocation(tree, path),
      });
      labels.push(`preset ${edit.preset} · marketplace selection`);
    }

    const selectedResult = new Set(resultSelection);
    for (const creation of edit.creations) {
      if (!exactKeys(creation, ['packageId', 'models'])) {
        throw badRequest('Each creation needs only packageId and models.', 'INVALID_MARKETPLACE');
      }
      if (typeof creation.packageId !== 'string' || !selectedResult.has(creation.packageId)) {
        throw badRequest('A creation package must be selected in the resulting preset.', 'MARKETPLACE_UNSUPPORTED');
      }
      const creationKey = `${edit.preset}\u0000${creation.packageId}`;
      if (seenCreations.has(creationKey)) {
        throw badRequest('A creation package appears more than once in one preset.', 'INVALID_MARKETPLACE');
      }
      seenCreations.add(creationKey);
      const pkg = inspected.packageById.get(creation.packageId);
      if (!pkg) throw badRequest('A creation package is not installed.', 'MARKETPLACE_UNSUPPORTED');
      if (pkg.blockedReason) throw badRequest(pkg.blockedReason, 'MARKETPLACE_UNSUPPORTED');
      if (inspected.agentCounts.get(pkg.agentName) !== 1) {
        throw badRequest('Agent name is not unique among installed packages.', 'MARKETPLACE_UNSUPPORTED');
      }
      const modelPath = modelPathFor(edit.preset, inspected.layout, pkg.agentName);
      if (!modelPath) {
        throw badRequest(
          inspected.layout === 'flat'
            && (pkg.agentName === 'marketplace' || pkg.agentName === 'agents')
            ? 'Agent name collides with a reserved preset key.'
            : 'Preset layout is unsupported.',
          'MARKETPLACE_UNSUPPORTED',
        );
      }
      if (findNodeAtLocation(tree, modelPath)) {
        throw badRequest('An explicit model queue already exists; edit it in the editor.',
          'MARKETPLACE_UNSUPPORTED');
      }
      if (agentContainerHas(presetValue, inspected.layout, pkg.agentName)) {
        throw badRequest('Agent identity already has a custom definition.', 'MARKETPLACE_UNSUPPORTED');
      }
      if (isObject(config.agents) && Object.hasOwn(config.agents, pkg.agentName)) {
        throw badRequest('A root agent with this name would shadow the preset override.',
          'MARKETPLACE_UNSUPPORTED');
      }
      const models = normalizeLiteralModels(creation.models, `preset ${edit.preset} · ${pkg.agentName}`);
      const stored = models.map(({ id, variant }) => (variant ? { id, variant } : { id }));
      mutations.push({
        path: modelPath,
        value: stored,
        label: `preset ${edit.preset} · ${pkg.agentName} (created)`,
        created: true,
      });
      labels.push(`preset ${edit.preset} · ${pkg.agentName} (created)`);
      creations.push({
        preset: edit.preset,
        packageId: pkg.id,
        agentName: pkg.agentName,
        path: modelPath,
        models,
      });
    }
  }

  return {
    binding: {
      sourceGeneration: marketplace.sourceGeneration,
      catalogFingerprint: marketplace.catalogFingerprint,
    },
    mutations,
    creations,
    labels,
  };
}
