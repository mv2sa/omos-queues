// Reading, enumerating and editing the selected OMOS JSONC document. Writes are
// byte-preserving edits of existing model values; unsupported queues stay
// visible and read-only instead of failing unrelated queues.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parse, parseTree, printParseErrorCode } from 'jsonc-parser';
import { ServiceError, badRequest, conflict } from './errors.js';
import { MAX_MODEL_ID, MAX_VARIANT, hasPlaceholder, isModelId, isValidVariant } from './model-id.js';
import { normalizeLiteralModels, planMarketplaceConfig } from './marketplace-config.js';
import { BUILD_REASON, describePrimarySlots, MAX_PRIMARY_CREATIONS, qualifyPrimaryGroups } from './primary-slots.js';

export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
export const MAX_CHANGED_PATHS = 1000;
export const MAX_POSITIONS = 50;

export { MAX_MODEL_ID, MAX_VARIANT };

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function hashText(text) {
  return sha256(text);
}

function invalidConfig(detail) {
  return new ServiceError(422, 'CONFIG_INVALID', `The config is not valid JSONC (${detail}). Nothing was written.`);
}

// Detects duplicate object keys, which JSONC parsers otherwise accept with the
// last value winning. Such a file must never be edited.
export function findDuplicateKeys(text) {
  const errors = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  const duplicates = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children || []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        if (!keyNode || keyNode.type !== 'string') continue;
        const key = keyNode.value;
        if (seen.has(key)) duplicates.push({ path: trail.join('.'), key });
        seen.add(key);
        walk(valueNode, [...trail, key]);
      }
      return;
    }
    if (node.type === 'array') {
      for (const child of node.children || []) walk(child, trail);
    }
  };
  walk(root, []);
  return duplicates;
}

export function parseConfigDocument(text) {
  const errors = [];
  const config = parse(text, errors, PARSE_OPTIONS);
  if (errors.length) {
    const first = errors[0];
    throw invalidConfig(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  if (!isObject(config)) throw invalidConfig('expected the top level to be an object');
  const duplicates = findDuplicateKeys(text);
  if (duplicates.length) {
    const first = duplicates[0];
    const where = first.path ? ` near ${first.path}` : '';
    throw new ServiceError(
      422,
      'CONFIG_DUPLICATE_KEYS',
      `The config repeats the key "${first.key}"${where}. Remove the duplicate before editing. Nothing was written.`,
    );
  }
  return config;
}

function modelList(value) {
  const entries = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries)) {
    return { models: [], problem: 'Model must be a provider/model string or a list of them.' };
  }
  let problem = null;
  const models = entries.map(entry => {
    if (typeof entry === 'string') {
      const model = { id: entry, variant: '' };
      if (hasPlaceholder(entry)) problem = problem || 'Contains unexpanded environment placeholders.';
      else if (!isModelId(entry)) problem = problem || 'Contains an entry that is not a provider/model id.';
      return model;
    }
    if (isObject(entry) && typeof entry.id === 'string'
      && (entry.variant === undefined || typeof entry.variant === 'string')) {
      const model = { id: entry.id, variant: entry.variant ?? '' };
      if (hasPlaceholder(entry.id) || hasPlaceholder(model.variant)) {
        problem = problem || 'Contains unexpanded environment placeholders.';
      } else if (!isModelId(entry.id)) {
        problem = problem || 'Contains an entry that is not a provider/model id.';
      } else if (!isValidVariant(model.variant)) {
        problem = problem || 'Contains a variant outside the supported single-line bounds.';
      }
      if (Object.keys(entry).some(key => key !== 'id' && key !== 'variant')) {
        problem = problem || 'Contains unsupported model entry properties.';
      }
      return model;
    }
    problem = problem || 'Contains a model entry with an unsupported shape.';
    return { id: '', variant: '' };
  });
  return { models, problem };
}

function buildGroup({ path, name, label, section, kind, entry }) {
  // Properties outside `model` (description, prompt, skills, options, ...) are
  // legitimate agent settings: never edit them, never return them and never make
  // the queue read-only because of them.
  const reasons = [];
  let defaultVariant = '';
  if (typeof entry.variant === 'string') {
    defaultVariant = entry.variant;
    if (hasPlaceholder(entry.variant)) reasons.push('Contains unexpanded environment placeholders.');
    else if (!isValidVariant(entry.variant)) reasons.push('The default variant is outside the supported single-line bounds.');
  } else if (Object.hasOwn(entry, 'variant')) {
    reasons.push('The default variant must be a string.');
  }
  const { models, problem } = modelList(entry.model);
  if (problem) reasons.push(problem);
  if (!models.length) reasons.push('This queue has no positions to edit.');
  if (models.length > MAX_POSITIONS) {
    reasons.push(`This queue exceeds the ${MAX_POSITIONS}-position editing limit. Its values are shown read-only.`);
  }
  return {
    id: JSON.stringify(path),
    path,
    name,
    label,
    section,
    kind,
    defaultVariant,
    models,
    readOnlyReason: reasons[0] ?? null,
  };
}

function addQueues(groups, container, parentPath, section, kind, labelFor) {
  if (!isObject(container)) return;
  for (const [name, value] of Object.entries(container)) {
    if (!isObject(value) || !Object.hasOwn(value, 'model')) continue;
    groups.push(buildGroup({
      path: [...parentPath, name, 'model'],
      name,
      label: labelFor(name),
      section,
      kind,
      entry: value,
    }));
  }
}

// Object-based enumeration used for verification after edits. Container order
// follows the parsed object, which is sufficient because ids are compared.
export function enumerateGroups(config) {
  const groups = [];
  if (isObject(config.presets)) {
    for (const [preset, presetValue] of Object.entries(config.presets)) {
      if (!isObject(presetValue)) continue;
      const section = `Preset · ${preset}`;
      for (const [name, value] of Object.entries(presetValue)) {
        if (!isObject(value)) continue;
        if (Object.hasOwn(value, 'model')) {
          groups.push(buildGroup({
            path: ['presets', preset, name, 'model'],
            name,
            label: `preset ${preset} · ${name}`,
            section,
            kind: 'preset',
            entry: value,
          }));
        }
        if (name === 'agents' && isObject(value)) {
          addQueues(groups, value, ['presets', preset, 'agents'], section, 'preset',
            agent => `preset ${preset} · ${agent}`);
        }
      }
    }
  }
  addQueues(groups, config.agents, ['agents'], 'Agents', 'agent', name => `agent · ${name}`);
  if (isObject(config.council?.presets)) {
    for (const [preset, seats] of Object.entries(config.council.presets)) {
      addQueues(groups, seats, ['council', 'presets', preset], `Council seats · ${preset}`, 'council',
        name => `council ${preset} seat · ${name}`);
    }
  }
  return qualifyPrimaryGroups(config, groups);
}

// File-order enumeration walks the parsed tree, so numeric-looking queue names
// stay in the order they appear in the document rather than object-key order.
export function enumerateGroupsFromText(text) {
  const errors = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  if (!root || root.type !== 'object') return [];
  const groups = [];

  const properties = node => {
    if (!node || node.type !== 'object') return [];
    return (node.children || []).map(property => ({
      key: property.children?.[0]?.value,
      node: property.children?.[1],
    }));
  };
  const propertyOf = (node, key) => properties(node).find(entry => entry.key === key)?.node;
  const entryOf = node => (node ? getNodeValue(node) : null);
  const hasModel = node => node?.type === 'object' && Boolean(propertyOf(node, 'model'));

  for (const preset of properties(propertyOf(root, 'presets'))) {
    if (preset.node?.type !== 'object') continue;
    const section = `Preset · ${preset.key}`;
    for (const member of properties(preset.node)) {
      if (member.node?.type !== 'object') continue;
      if (hasModel(member.node)) {
        groups.push(buildGroup({
          path: ['presets', preset.key, member.key, 'model'],
          name: member.key,
          label: `preset ${preset.key} · ${member.key}`,
          section,
          kind: 'preset',
          entry: entryOf(member.node),
        }));
      }
      if (member.key === 'agents') {
        for (const agent of properties(member.node)) {
          if (!hasModel(agent.node)) continue;
          groups.push(buildGroup({
            path: ['presets', preset.key, 'agents', agent.key, 'model'],
            name: agent.key,
            label: `preset ${preset.key} · ${agent.key}`,
            section,
            kind: 'preset',
            entry: entryOf(agent.node),
          }));
        }
      }
    }
  }
  for (const agent of properties(propertyOf(root, 'agents'))) {
    if (!hasModel(agent.node)) continue;
    groups.push(buildGroup({
      path: ['agents', agent.key, 'model'],
      name: agent.key,
      label: `agent · ${agent.key}`,
      section: 'Agents',
      kind: 'agent',
      entry: entryOf(agent.node),
    }));
  }
  for (const preset of properties(propertyOf(propertyOf(root, 'council'), 'presets'))) {
    for (const seat of properties(preset.node)) {
      if (!hasModel(seat.node)) continue;
      groups.push(buildGroup({
        path: ['council', 'presets', preset.key, seat.key, 'model'],
        name: seat.key,
        label: `council ${preset.key} seat · ${seat.key}`,
        section: `Council seats · ${preset.key}`,
        kind: 'council',
        entry: entryOf(seat.node),
      }));
    }
  }
  return qualifyPrimaryGroups(getNodeValue(root), groups);
}

function formattingFor(text) {
  const indentation = text.match(/\n([ \t]+)"/u)?.[1] || '  ';
  const tabs = indentation.includes('\t');
  return {
    insertSpaces: !tabs,
    tabSize: tabs ? 1 : indentation.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return text.slice(lineStart, offset).match(/^[ \t]*/u)?.[0] ?? '';
}

function indentUnit(formattingOptions) {
  return formattingOptions.insertSpaces ? ' '.repeat(formattingOptions.tabSize) : '\t';
}

function prettyValue(value, unit, eol, baseIndent) {
  return JSON.stringify(value, null, unit)
    .split('\n')
    .map((line, index) => (index === 0 ? line : baseIndent + line))
    .join(eol);
}

function wrapMissingSegments(segments, value) {
  let wrapped = value;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    wrapped = { [segments[index]]: wrapped };
  }
  return wrapped;
}

// Finds the first comma after the last property, skipping whitespace and
// comments, so a trailing comma in the source is not duplicated.
function trailingCommaOffset(text, from, to) {
  let index = from;
  while (index < to) {
    const character = text[index];
    if (character === ',') return index;
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      index = newline === -1 ? to : newline + 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? to : close + 2;
      continue;
    }
    if (!/\s/u.test(character)) return -1;
    index += 1;
  }
  return -1;
}

// Inserts a new object property without jsonc-parser's line reformatting, which
// would expand unrelated inline values and comments inside the parent object.
function insertPropertyAtPath(text, tree, path, value, formattingOptions) {
  let parent = null;
  let remaining = null;
  for (let length = path.length - 1; length > 0; length -= 1) {
    const candidate = findNodeAtLocation(tree, path.slice(0, length));
    if (candidate) {
      parent = candidate;
      remaining = path.slice(length);
      break;
    }
  }
  if (!parent || parent.type !== 'object' || !Array.isArray(parent.children)
    || !remaining || typeof remaining[0] !== 'string') {
    throw new ServiceError(500, 'APPLY_MISMATCH',
      'The reviewed marketplace value could not be located. Nothing was written.');
  }
  const key = remaining[0];
  const inserted = wrapMissingSegments(remaining.slice(1), value);
  const unit = indentUnit(formattingOptions);
  const eol = formattingOptions.eol;
  const parentIndent = lineIndentAt(text, parent.offset);
  const children = parent.children;
  const childIndent = children.length
    ? lineIndentAt(text, children[0].children?.[0]?.offset ?? parent.offset)
    : parentIndent + unit;
  const pretty = prettyValue(inserted, unit, eol, childIndent);
  const property = `${JSON.stringify(key)}: ${pretty}`;
  const close = parent.offset + parent.length - 1;
  let offset;
  let content;
  if (!children.length) {
    offset = parent.offset + 1;
    content = eol + childIndent + property;
    if (text[offset] === '}') content += eol + parentIndent;
  } else {
    const last = children[children.length - 1];
    const comma = trailingCommaOffset(text, last.offset + last.length, close);
    if (comma === -1) {
      offset = last.offset + last.length;
      content = ',' + eol + childIndent + property;
    } else {
      offset = comma + 1;
      content = eol + childIndent + property;
    }
  }
  // All original bytes survive an insertion. Only the AST-selected object's
  // next property and its necessary punctuation/whitespace may be added.
  if (offset < parent.offset + 1 || offset > close) throw badRequest('Invalid property insertion span.', 'APPLY_MISMATCH');
  return checkedSplice(text, offset, 0, content);
}

function checkedSplice(text, offset, length, content) {
  const after = applyEdits(text, [{ offset, length, content }]);
  if (after.length !== text.length - length + content.length
    || after.slice(0, offset) !== text.slice(0, offset)
    || after.slice(offset + content.length) !== text.slice(offset + length)) {
    throw new ServiceError(500, 'APPLY_MISMATCH', 'The edit changed bytes outside its reviewed span. Nothing was written.');
  }
  return after;
}

function prettyReplacement(text, offset, value, formattingOptions) {
  const baseIndent = lineIndentAt(text, offset);
  return JSON.stringify(value, null, indentUnit(formattingOptions))
    .split('\n')
    .map((line, index) => (index === 0 ? line : baseIndent + line))
    .join(formattingOptions.eol);
}

function applyValueMutation(text, mutation, formattingOptions) {
  const tree = parseTree(text, [], PARSE_OPTIONS);
  const existing = findNodeAtLocation(tree, mutation.path);
  if (Boolean(existing) === Boolean(mutation.created)) {
    throw new ServiceError(500, 'APPLY_MISMATCH', 'The reviewed value no longer has its expected presence. Nothing was written.');
  }
  if (existing) {
    // Replace only the reviewed value slice. jsonc-parser's formatting would
    // reformat the whole line, including unrelated inline neighbors.
    return checkedSplice(text, existing.offset, existing.length,
      prettyReplacement(text, existing.offset, mutation.value, formattingOptions));
  }
  return insertPropertyAtPath(text, tree, mutation.path, mutation.value, formattingOptions);
}

// Delegates to the marketplace planner's validator so ordinary queue edits and
// marketplace-created queues cannot drift apart on literal id/variant rules.
function normalizeChangeModels(models, label) {
  return normalizeLiteralModels(models, label);
}

function sameModels(a, b) {
  if (a.length !== b.length) return false;
  return a.every((model, index) => model.id === b[index].id && model.variant === b[index].variant);
}

// Applies requested models to existing queue paths, optionally applies a
// marketplace selection/creation plan to the same buffer, verifies the whole
// semantic result, and returns the reviewed bytes.
export function prepareConfigEdit({
  text, groups, changes, marketplace, marketplaceCatalog, primaryCreations,
}) {
  if (!Array.isArray(changes)) throw badRequest('Expected a changes array.', 'INVALID_CHANGES');
  if (changes.length > MAX_CHANGED_PATHS) {
    throw badRequest(`At most ${MAX_CHANGED_PATHS} queues can be edited at once.`, 'TOO_MANY_CHANGES');
  }
  const byId = new Map(groups.map(group => [group.id, group]));
  const seen = new Set();
  const edits = [];
  const tree = parseTree(text, [], PARSE_OPTIONS);
  const primary = primaryCreations === undefined ? [] : primaryCreations;
  if (!Array.isArray(primary) || primary.length > MAX_PRIMARY_CREATIONS || primary.length + changes.length > MAX_CHANGED_PATHS) {
    throw badRequest('Expected a bounded primaryCreations array.', 'INVALID_PRIMARY_CREATIONS');
  }
  const slots = primary.length ? describePrimarySlots({ text, groups }) : [];
  const primaryEdits = [];
  const primarySeen = new Set();
  for (const creation of primary) {
    if (!isObject(creation) || Object.keys(creation).length !== 3
      || !Object.hasOwn(creation, 'preset') || !Object.hasOwn(creation, 'agent')
      || !Object.hasOwn(creation, 'models')
      || typeof creation.preset !== 'string' || !['build', 'orchestrator'].includes(creation.agent)) {
      throw badRequest('Each primary creation needs only preset, agent and models.', 'INVALID_PRIMARY_CREATIONS');
    }
    const slotKey = `${creation.preset}\u0000${creation.agent}`;
    if (primarySeen.has(slotKey)) throw badRequest('A primary slot appears twice.', 'DUPLICATE_PATH');
    primarySeen.add(slotKey);
    if (creation.agent === 'build') {
      throw badRequest(BUILD_REASON, 'READ_ONLY_PATH');
    }
    const slot = slots.find(item => item.preset === creation.preset && item.agent === creation.agent);
    if (!slot || !slot.canCreate || !slot.modelPath) {
      throw badRequest(slot?.blockedReason || 'That primary preset slot cannot be created.', 'PRIMARY_SLOT_BLOCKED');
    }
    const models = normalizeChangeModels(creation.models, `preset ${creation.preset} · orchestrator`);
    const stored = models.map(({ id, variant }) => variant ? { id, variant } : { id });
    primaryEdits.push({
      path: slot.modelPath, models, stored, value: stored, label: `preset ${creation.preset} · orchestrator`,
      id: JSON.stringify(slot.modelPath), created: true,
    });
  }
  for (const edit of primaryEdits) {
    if (seen.has(edit.id)) throw badRequest('The same queue is staged through multiple operations.', 'PRIMARY_OVERLAP');
    seen.add(edit.id);
  }

  for (const change of changes) {
    if (!isObject(change) || !Array.isArray(change.path)
      || change.path.length < 3 || change.path.length > 100
      || change.path.some(part => typeof part !== 'string' || part.length > MAX_MODEL_ID)
      || change.path[change.path.length - 1] !== 'model') {
      throw badRequest('Each change needs a model path ending in "model".', 'INVALID_CHANGES');
    }
    const key = JSON.stringify(change.path);
    if (seen.has(key)) throw badRequest('The same queue appears twice in one preview.', 'DUPLICATE_PATH');
    seen.add(key);
    const group = byId.get(key);
    if (!group) throw badRequest('Unknown queue path. Only existing queues can be edited.', 'UNKNOWN_PATH');
    if (group.readOnlyReason) throw badRequest(`${group.label}: ${group.readOnlyReason}`, 'READ_ONLY_PATH');
    const models = normalizeChangeModels(change.models, group.label);
    if (sameModels(models, group.models)) continue;
    const stored = models.map(({ id, variant }) => (variant ? { id, variant } : { id }));
    const node = findNodeAtLocation(tree, change.path);
    if (!node) throw new ServiceError(500, 'APPLY_MISMATCH', 'The reviewed queue could not be located. Nothing was written.');
    edits.push({
      path: change.path,
      models,
      stored,
      label: group.label,
      id: key,
      before: text.slice(node.offset, node.offset + node.length),
    });
  }

  const hasMarketplace = marketplace !== null && marketplace !== undefined;
  let beforeConfig = null;
  let plan = null;
  if (hasMarketplace) {
    beforeConfig = parseConfigDocument(text);
    plan = planMarketplaceConfig({
      text,
      config: beforeConfig,
      groups,
      catalog: marketplaceCatalog,
      marketplace,
    });
    if (plan) {
      const ordinaryPaths = new Set(edits.map(edit => edit.id));
      for (const mutation of plan.mutations) {
        if (ordinaryPaths.has(JSON.stringify(mutation.path))) {
          throw badRequest(
            'The same queue is edited directly and by the marketplace stage. Use one of them.',
            'MARKETPLACE_OVERLAP',
          );
        }
      }
      for (const mutation of plan.mutations) {
        if (primaryEdits.some(edit => JSON.stringify(edit.path) === JSON.stringify(mutation.path))) {
          throw badRequest('The same path is staged through multiple operations.', 'PRIMARY_OVERLAP');
        }
      }
    }
  }

  let current = text;
  const formattingOptions = formattingFor(text);
  for (const edit of edits) {
    // Preserve the ordinary editor's value formatting but never allow the
    // formatter to rewrite neighboring bytes on the same line.
    const old = findNodeAtLocation(parseTree(current, [], PARSE_OPTIONS), edit.path);
    const formatted = applyEdits(current, modify(current, edit.path, edit.stored, { formattingOptions }));
    const node = findNodeAtLocation(parseTree(formatted, [], PARSE_OPTIONS), edit.path);
    if (!old || !node) throw badRequest('The reviewed value could not be found.', 'APPLY_MISMATCH');
    current = checkedSplice(current, old.offset, old.length, formatted.slice(node.offset, node.offset + node.length));
  }
  for (const edit of primaryEdits) {
    current = applyValueMutation(current, edit, formattingOptions);
  }
  if (plan) {
    for (const mutation of plan.mutations) {
      current = applyValueMutation(current, mutation, formattingOptions);
    }
  }
  const after = current;

  const hasPlanMutations = Boolean(plan && plan.mutations.length);
  const hasPrimaryMutations = primaryEdits.length > 0;
  if (edits.length && !hasPlanMutations && !hasPrimaryMutations) {
    const expected = new Map(edits.map(edit => [edit.id, edit.models]));
    verifyEditedDocument(after, groups, expected);
  }
  if (hasPlanMutations || hasPrimaryMutations) {
    // The whole-document check also covers any ordinary edits applied above.
    const combined = {
      mutations: [...(plan?.mutations ?? []), ...primaryEdits],
    };
    verifyMarketplaceResult({ text, after, beforeConfig: beforeConfig ?? parseConfigDocument(text), plan: combined, edits, tree });
  }

  let afterTree = null;
  const treeAfter = () => {
    if (!afterTree) afterTree = parseTree(after, [], PARSE_OPTIONS);
    return afterTree;
  };
  const changedValues = [];
  const changed = [];
  const changedIds = [];
  for (const edit of edits) {
    const node = findNodeAtLocation(treeAfter(), edit.path);
    if (!node) {
      throw new ServiceError(500, 'APPLY_MISMATCH',
        'The reviewed queue could not be located after the edit. Nothing was written.');
    }
    changed.push(edit.label);
    changedIds.push(edit.id);
    changedValues.push({
      path: edit.path,
      label: edit.label,
      before: edit.before,
      after: after.slice(node.offset, node.offset + node.length),
    });
  }
  if (plan) {
    for (const mutation of plan.mutations) {
      const node = findNodeAtLocation(treeAfter(), mutation.path);
      if (!node) {
        throw new ServiceError(500, 'APPLY_MISMATCH',
          'The reviewed marketplace value could not be located after the edit. Nothing was written.');
      }
      const original = mutation.created ? null : findNodeAtLocation(tree, mutation.path);
      changed.push(mutation.label);
      changedIds.push(JSON.stringify(mutation.path));
      changedValues.push({
        path: mutation.path,
        label: mutation.label,
        before: original ? text.slice(original.offset, original.offset + original.length) : '',
        after: after.slice(node.offset, node.offset + node.length),
      });
    }
  }
  for (const edit of primaryEdits) {
    const node = findNodeAtLocation(treeAfter(), edit.path);
    if (!node) throw new ServiceError(500, 'APPLY_MISMATCH', 'The reviewed primary queue could not be located after the edit. Nothing was written.');
    changed.push(edit.label);
    changedIds.push(edit.id);
    changedValues.push({ path: edit.path, label: edit.label, before: '', after: after.slice(node.offset, node.offset + node.length) });
  }
  return {
    after,
    changed,
    changedIds,
    changedValues,
    marketplaceBinding: plan && plan.mutations.length ? plan.binding : null,
    marketplaceCreations: plan ? plan.creations : [],
  };
}

function sliceWithoutRanges(source, ranges) {
  let result = source;
  for (const range of [...ranges].sort((left, right) => right.offset - left.offset)) {
    result = result.slice(0, range.offset) + result.slice(range.offset + range.length);
  }
  return result;
}

function diffChangedPaths(before, after, base, out) {
  if (isObject(after)) {
    if (isObject(before)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        if (!Object.hasOwn(after, key)) {
          out.push([...base, key]);
        } else if (!Object.hasOwn(before, key)) {
          diffChangedPaths(undefined, after[key], [...base, key], out);
        } else {
          diffChangedPaths(before[key], after[key], [...base, key], out);
        }
      }
      return;
    }
    for (const key of Object.keys(after)) {
      diffChangedPaths(undefined, after[key], [...base, key], out);
    }
    return;
  }
  if (Array.isArray(after)) {
    if (!isDeepStrictEqual(before, after)) out.push(base);
    return;
  }
  if (isObject(before) || Array.isArray(before)) {
    out.push(base);
    return;
  }
  if (!isDeepStrictEqual(before, after)) out.push(base);
}

function setExpectedPath(root, path, value) {
  let node = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!isObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

// Independent whole-document check for marketplace edits: deep-compare against
// an expected document built from the original parse, then audit that every
// changed leaf is exactly an allowed edit. Existing-node-only edits also prove
// the untouched bytes survive by removing both value ranges and comparing.
function verifyMarketplaceResult({ text, after, beforeConfig, plan, edits, tree }) {
  const mismatch = () => new ServiceError(
    500,
    'APPLY_MISMATCH',
    'The reviewed marketplace edit could not be verified against its intended result. Nothing was written.',
  );
  let afterConfig;
  try {
    afterConfig = parseConfigDocument(after);
  } catch {
    throw mismatch();
  }
  const expected = structuredClone(beforeConfig);
  for (const edit of edits) {
    setExpectedPath(expected, edit.path, structuredClone(edit.stored));
  }
  for (const mutation of plan.mutations) {
    setExpectedPath(expected, mutation.path, structuredClone(mutation.value));
  }
  if (!isDeepStrictEqual(afterConfig, expected)) throw mismatch();

  const allowed = new Set([
    ...edits.map(edit => edit.id),
    ...plan.mutations.map(mutation => JSON.stringify(mutation.path)),
  ]);
  const changedPaths = [];
  diffChangedPaths(beforeConfig, afterConfig, [], changedPaths);
  for (const path of changedPaths) {
    if (!allowed.has(JSON.stringify(path))) throw mismatch();
  }

  if (plan.mutations.some(mutation => mutation.created)) return;
  const afterTree = parseTree(after, [], PARSE_OPTIONS);
  const beforeRanges = [];
  const afterRanges = [];
  for (const edit of edits) {
    const beforeNode = findNodeAtLocation(tree, edit.path);
    const afterNode = findNodeAtLocation(afterTree, edit.path);
    if (!beforeNode || !afterNode) throw mismatch();
    beforeRanges.push(beforeNode);
    afterRanges.push(afterNode);
  }
  for (const mutation of plan.mutations) {
    const beforeNode = findNodeAtLocation(tree, mutation.path);
    const afterNode = findNodeAtLocation(afterTree, mutation.path);
    if (!beforeNode || !afterNode) throw mismatch();
    beforeRanges.push(beforeNode);
    afterRanges.push(afterNode);
  }
  if (sliceWithoutRanges(text, beforeRanges) !== sliceWithoutRanges(after, afterRanges)) {
    throw mismatch();
  }
}

function verifyEditedDocument(afterText, beforeGroups, expected) {
  const mismatch = () => new ServiceError(
    500,
    'APPLY_MISMATCH',
    'The reviewed edit could not be verified against its intended result. Nothing was written.',
  );
  let afterConfig;
  try {
    afterConfig = parseConfigDocument(afterText);
  } catch {
    throw mismatch();
  }
  const afterGroups = new Map(enumerateGroups(afterConfig).map(group => [group.id, group]));
  if (afterGroups.size !== beforeGroups.length) throw mismatch();
  for (const group of beforeGroups) {
    const next = afterGroups.get(group.id);
    if (!next) throw mismatch();
    const wanted = expected.get(group.id);
    if (wanted) {
      if (next.readOnlyReason !== null) throw mismatch();
      if (!sameModels(next.models, wanted)) throw mismatch();
    } else if (!sameModels(next.models, group.models)
      || next.readOnlyReason !== group.readOnlyReason
      || next.defaultVariant !== group.defaultVariant) {
      throw mismatch();
    }
    // The queue's own default variant is never part of an edit.
    if (next.defaultVariant !== group.defaultVariant) throw mismatch();
  }
}

// A settings generation pins the canonical pathname, not an inode. The logical
// link is re-checked so retargeting never redirects an existing generation.
export function createTargetResolver() {
  let pinned = null;
  return {
    resolve(settings, generation) {
      if (pinned && pinned.generation === generation) {
        let current;
        try {
          current = fs.realpathSync(settings.configFile);
        } catch {
          throw new ServiceError(404, 'CONFIG_MISSING',
            'The selected config file is missing. Choose a config file in Settings.');
        }
        if (current !== pinned.path) {
          throw conflict(
            'The selected config link now points to a different file. Reload the page or update Settings before editing.',
            'TARGET_CHANGED',
          );
        }
        return { ...pinned };
      }
      let canonical;
      try {
        canonical = fs.realpathSync(settings.configFile);
      } catch {
        throw new ServiceError(404, 'CONFIG_MISSING',
          'The selected config file is missing. Choose a config file in Settings.');
      }
      pinned = { generation, path: canonical, logicalPath: settings.configFile };
      return { ...pinned };
    },
    reset() {
      pinned = null;
    },
  };
}

export function readConfigDocument(target) {
  let stat;
  try {
    stat = fs.statSync(target.path);
  } catch {
    throw new ServiceError(404, 'CONFIG_MISSING',
      'The selected config file is missing. Choose a config file in Settings.');
  }
  if (!stat.isFile()) {
    throw new ServiceError(422, 'CONFIG_INVALID', 'The selected config path is not a regular file.');
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new ServiceError(413, 'CONFIG_TOO_LARGE',
      'The config file is larger than the 2 MiB editing limit. It was not read or changed.');
  }
  let text;
  try {
    text = fs.readFileSync(target.path, 'utf8');
  } catch {
    throw new ServiceError(500, 'CONFIG_UNREADABLE',
      'The selected config file could not be read. Check its permissions and try again.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ServiceError(413, 'CONFIG_TOO_LARGE',
      'The config file is larger than the 2 MiB editing limit. It was not read or changed.');
  }
  const config = parseConfigDocument(text);
  return { text, config, baseHash: hashText(text), groups: enumerateGroupsFromText(text) };
}
