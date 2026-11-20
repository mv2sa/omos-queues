import { parse } from 'jsonc-parser';
import { inspectPresetLayout, MAX_MARKETPLACE_PRESETS } from './marketplace-config.js';
import { hasPlaceholder, isValidVariant } from './model-id.js';

export const BUILD_REASON = 'OpenCode manages Build; adding an OMOS queue could register a different agent.';
export const MAX_PRIMARY_CREATIONS = 64;
const names = ['build', 'orchestrator'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePreset = name => name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(name)
  && !['__proto__', 'prototype', 'constructor'].includes(name);
const identity = name => typeof name === 'string' ? name.trim().toLowerCase() : '';
const scopeReason = 'This preset does not have an unambiguous Orchestrator model setting.';
const inheritanceReason = 'This identity inherits its model; changing its queue could change that policy.';
const shadowReason = 'A root agent setting shadows this preset default.';
const aliasReason = 'An agent name or display name makes the primary identity ambiguous.';

function ambiguousIdentity(agents) {
  return Object.entries(agents || {}).some(([name, entry]) =>
    (name !== 'orchestrator' && (identity(name) === 'orchestrator' || identity(entry?.displayName) === 'orchestrator'))
    || (name === 'orchestrator' && entry?.displayName !== undefined && identity(entry.displayName) !== 'orchestrator'));
}

function entryProblem(entry) {
  if (entry === undefined) return null;
  if (!record(entry)) return scopeReason;
  if (Object.hasOwn(entry, 'inheritModelFrom')) return inheritanceReason;
  if (Object.hasOwn(entry, 'variant') && (!isValidVariant(entry.variant) || hasPlaceholder(entry.variant))) {
    return 'The default variant is unresolved or unsupported.';
  }
  if (entry.primary === false) return aliasReason;
  return null;
}

// slots describe the selected global file, not the current host/session model.
export function describePrimarySlots({ text, config = parse(text), groups }) {
  if (!record(config?.presets)) return [];
  const presets = Object.entries(config.presets);
  if (presets.length > MAX_MARKETPLACE_PRESETS) return []; // Never offer a partial set.
  const existing = new Map(groups.map(group => [group.id, group]));
  const rootAgents = config.agents;
  const rootEntry = record(rootAgents) ? rootAgents.orchestrator : undefined;
  const rootProblem = rootAgents !== undefined && !record(rootAgents) ? scopeReason
    : ambiguousIdentity(rootAgents) ? aliasReason : entryProblem(rootEntry)
      || (rootEntry && ['model', 'variant'].some(key => Object.hasOwn(rootEntry, key)) ? shadowReason : null);
  const slots = [];
  for (const [preset, value] of presets) {
    if (!safePreset(preset)) continue;
    const { layout, shapeReason } = inspectPresetLayout(value);
    const container = layout === 'structured' ? value.agents : layout === 'flat' ? value : null;
    const conflict = shapeReason || rootProblem || (ambiguousIdentity(container) ? aliasReason : null);
    for (const agent of names) {
      const path = !container ? null : layout === 'structured'
        ? ['presets', preset, 'agents', agent, 'model'] : ['presets', preset, agent, 'model'];
      const group = path && existing.get(JSON.stringify(path));
      const entry = container?.[agent];
      const blockedReason = agent === 'build' ? BUILD_REASON : conflict || entryProblem(entry)
        || group?.readOnlyReason || (entry && Object.hasOwn(entry, 'model') && !group ? scopeReason : null);
      slots.push({ preset, agent, modelPath: path, existingGroupId: group?.id ?? null,
        defaultVariant: typeof entry?.variant === 'string' && isValidVariant(entry.variant) && !hasPlaceholder(entry.variant) ? entry.variant : '',
        canCreate: Boolean(path && !group && !blockedReason), blockedReason: blockedReason || null });
    }
  }
  return slots;
}

// Ordinary `changes` must obey the same identity rules as missing-model creation.
// Only an actual primary agent is qualified here, never a similarly named council seat.
export function qualifyPrimaryGroups(config, groups) {
  // OMOS normalizes agent display names when generating registration aliases.
  // Never treat a case/display alias of Build or Orchestrator as an ordinary
  // custom model path, regardless of the name shown in navigation.
  const primaries = groups.filter(group => {
    if (group.kind === 'council') return false;
    const entry = group.path.slice(0, -1).reduce((node, key) => node && Object.hasOwn(node,key) ? node[key] : undefined, config);
    if (!names.includes(group.name) && [group.name,entry?.displayName].some(name => names.includes(identity(name)))) {
      group.readOnlyReason ||= aliasReason;
      return false;
    }
    return names.includes(group.name);
  });
  if (primaries.length === 0) return groups;
  const byGroup = new Map(describePrimarySlots({ config, groups }).filter(slot => slot.existingGroupId)
    .map(slot => [slot.existingGroupId, slot]));
  for (const group of primaries) {
    if (group.readOnlyReason) continue;
    if (group.name === 'build') group.readOnlyReason = BUILD_REASON;
    else if (group.kind === 'preset') group.readOnlyReason = byGroup.get(group.id)?.blockedReason
      || (!byGroup.has(group.id) ? Object.keys(config.presets || {}).length > MAX_MARKETPLACE_PRESETS
        ? `This file exceeds the ${MAX_MARKETPLACE_PRESETS}-preset primary override limit.` : scopeReason : null);
    else group.readOnlyReason = entryProblem(config.agents?.orchestrator) || (ambiguousIdentity(config.agents) ? aliasReason : null);
  }
  return groups;
}
