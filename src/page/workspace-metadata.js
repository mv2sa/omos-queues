import { editLimit, isPendingMarketplaceQueue, isPendingPrimaryQueue, pathKey, validModelId } from './editor-state.js';

export const INSTALLED_AGENTS_ID = 'omos-installed-agents';
const PRIMARY_CREATION_LIMIT = 64;
export const primaryName = agent => agent === 'orchestrator' ? 'Orchestrator' : undefined;
const isPrimaryAgentKey = agent => agent === 'build' || agent === 'orchestrator';

// Match only exact OMOS agent paths, never a similarly named council seat.
function primaryPath(path = []) {
  if (path.at(-1) !== 'model') return null;
  if (path.length === 3 && path[0] === 'agents') return isPrimaryAgentKey(path[1]) ? { agent: path[1], preset: null } : null;
  if (path[0] !== 'presets' || !(path.length === 4 || (path.length === 5 && path[2] === 'agents'))) return null;
  const agent = path.at(-2);
  return isPrimaryAgentKey(agent) ? { agent, preset: path[1] } : null;
}

const hiddenBuildQueue = group => primaryPath(group.path)?.agent === 'build';

function workspaceGroup(group, slotsByGroup, packagesByGroup) {
  const primary = group.primaryCreation || slotsByGroup.get(group.id) || primaryPath(group.path);
  const pkg = group.marketplaceCreation || packagesByGroup.get(group.id);
  const category = primary?.agent || (pkg ? 'marketplace' : 'regular');
  const preset = primary?.preset ?? pkg?.preset ?? (group.path[0] === 'presets' ? group.path[1] : group.path[0] === 'council' ? group.path[2] : null);
  return { type: 'queue', group, category, preset, id: group.id, anchorId: `omos-queue-${encodeURIComponent(group.id)}`,
    name: primary ? primaryName(primary.agent) : group.name.trim() || group.path.at(-2) || 'Unnamed queue',
    section: category === 'regular' ? group.section : category === 'marketplace' ? 'Marketplace' : 'Primary agents',
    qualifier: preset || group.section };
}

function primaryPlaceholder(agent, slot = null) {
  const id = `primary:${JSON.stringify([slot?.preset ?? null, agent])}`;
  return { type: 'primary-slot', category: agent, slot, id, preset: slot?.preset ?? null,
    anchorId: `omos-${encodeURIComponent(id)}`, name: primaryName(agent), section: 'Primary agents',
    qualifier: slot?.preset || 'Primary agents' };
}

// One plan drives headings, desktop outline and phone jump. Never sort regular
// queues alphabetically and never classify an installed package by an agent-name match alone.
export function queueWorkspacePlan(editor) {
  if (!editor) return [];
  // Build is not editable here. Hide its exact OMOS agent paths from the shared
  // presentation without changing the config snapshot or its read-only guard.
  const groups = editor.groups.filter(group => !hiddenBuildQueue(group));
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const slots = editor.primarySlots || [];
  const primaryOrder = new Map(slots.filter(slot => slot.agent === 'orchestrator').map((slot, index) => [slot.preset, index]));
  const slotsByGroup = new Map();
  const matchedSlots = new Set();
  for (const slot of slots) {
    if (slot.agent !== 'orchestrator') continue;
    const group = groupsById.get(slot.existingGroupId) || (slot.modelPath && groupsById.get(pathKey(slot.modelPath)))
      || groups.find(group => {
        const identity = group.primaryCreation || primaryPath(group.path);
        return identity?.agent === slot.agent && identity.preset === slot.preset;
      });
    if (group) { slotsByGroup.set(group.id, slot); matchedSlots.add(slot); }
  }
  const packagesByGroup = new Map();
  const view = editor.marketplaceView;
  if (!editor.marketplaceUnavailable && view?.catalog.state === 'ready') {
    const installed = new Map(view.catalog.packages.map(pkg => [pkg.id, pkg]));
    for (const preset of view.presets) for (const agent of preset.agents) {
      const pkg = installed.get(agent.packageId);
      const group = groupsById.get(agent.existingGroupId);
      if (agent.selected === true && pkg && pkg.agentName === agent.agentName && group && agent.modelPath && pathKey(group.path) === pathKey(agent.modelPath)) {
        packagesByGroup.set(group.id, { preset: preset.name });
      }
    }
  }
  const buckets = { regular: [], orchestrator: [], marketplace: [] };
  for (const group of groups) {
    const entry = workspaceGroup(group, slotsByGroup, packagesByGroup);
    buckets[entry.category].push(entry);
  }
  for (const slot of slots) if (slot.agent === 'orchestrator' && !matchedSlots.has(slot)) buckets[slot.agent].push(primaryPlaceholder(slot.agent, slot));
  if (!buckets.orchestrator.length) buckets.orchestrator.push(primaryPlaceholder('orchestrator'));
  const primaryRank = entry => entry.preset === null ? -1 : (primaryOrder.get(entry.preset) ?? primaryOrder.size);
  buckets.orchestrator.sort((a, b) => primaryRank(a) - primaryRank(b));
  const plan = [...buckets.regular, ...buckets.orchestrator, ...buckets.marketplace,
    { type: 'marketplace', category: 'marketplace', id: INSTALLED_AGENTS_ID, anchorId: INSTALLED_AGENTS_ID,
      name: 'Installed agents', section: 'Marketplace', qualifier: 'Marketplace' }];

  const counts = (entries, key) => {
    const result = new Map();
    for (const entry of entries) { const value = key(entry).toLowerCase(); result.set(value, (result.get(value) || 0) + 1); }
    return result;
  };
  const names = counts(plan, entry => entry.name);
  for (const entry of plan) {
    const duplicate = names.get(entry.name.toLowerCase()) > 1;
    entry.label = duplicate ? `${entry.name} · ${entry.qualifier}` : entry.name;
  }
  const labels = counts(plan, entry => entry.label);
  for (const entry of plan) if (labels.get(entry.label.toLowerCase()) > 1) {
    const qualifier = [entry.qualifier, entry.group?.kind === 'council' ? 'council' : entry.group?.kind === 'agent' ? 'global' : entry.group?.kind === 'preset' ? 'preset' : entry.section];
    entry.label = `${entry.name} · ${[...new Set(qualifier)].join(' / ')}`;
  }
  const expandedLabels = counts(plan, entry => entry.label);
  for (const entry of plan) if (expandedLabels.get(entry.label.toLowerCase()) > 1 && entry.group?.kind === 'preset') {
    entry.label += entry.group.path.length === 5 ? ' / structured' : ' / flat';
  }
  return plan;
}

export function queueContext(entry) {
  const { group, preset, category } = entry;
  const scope = category === 'regular' ? group.section : preset ? `Preset ${preset}` : 'Global agents';
  return [scope, `${group.models.length} ${group.models.length === 1 ? 'position' : 'positions'}`,
    group.defaultVariant ? `Default variant: ${group.defaultVariant}` : ''].filter(Boolean).join(' · ');
}

export function pickerSearchPresentation(query, ids, shown) {
  const typed = query.trim();
  const valid = validModelId(typed);
  const useEnteredId = valid && !ids.includes(typed);
  const count = ids.length;
  const status = count > shown ? `${count} matches. Showing ${shown}. Refine the search.`
    : count ? `${count} ${count === 1 ? 'model' : 'models'}`
      : typed && !valid ? 'Enter a complete provider/model ID.'
        : typed ? 'No matching models.' : 'No models to show.';
  return { status, useEnteredId };
}

export function phoneJumpProps(plan, currentId) {
  // SDK Select suppresses onChange for its current value. Queue jumps are
  // repeatable actions; the placeholder reports the current destination.
  return { value: null, placeholder: plan.find(entry => entry.id === currentId)?.label ?? 'Choose a destination',
    options: plan.map(({ id, label }) => ({ id, label })) };
}

export function visibleWorkspaceSelection(plan, currentId, editorSelectedId) {
  if (plan.some(entry => entry.id === currentId)) return currentId;
  if (plan.some(entry => entry.id === editorSelectedId)) return editorSelectedId;
  return plan[0]?.id ?? null;
}

export function queueReadOnlyReason(entry) {
  return (entry?.group && editLimit(entry.group)) || null;
}

export function emptyWorkspaceNote(editor) {
  if (!editor || editor.unknown || editor.conflict) return '';
  const explicit = editor.groups.filter(group => !isPendingPrimaryQueue(group) && !isPendingMarketplaceQueue(group));
  if (!explicit.length) return 'No explicit queues in this file.';
  return explicit.every(hiddenBuildQueue) ? 'No editable model queues in this file.' : '';
}

export function primarySlotAtLimit(entry, editor) {
  return entry?.category === 'orchestrator' && entry.slot?.canCreate === true
    && (editor?.primaryCreations?.length ?? 0) >= PRIMARY_CREATION_LIMIT;
}

export function primarySlotExplanation(entry, editor) {
  if (primarySlotAtLimit(entry, editor)) return `You've staged ${PRIMARY_CREATION_LIMIT} Orchestrator overrides. Review and save, or reset one before staging another.`;
  if (entry.slot?.canCreate) return 'Choose a first model to stage an override for this preset. Running sessions can still use a different model.';
  return entry.slot?.blockedReason || (entry.preset !== null
    ? 'No explicit model queue in this preset. This preset does not support staging an override.'
    : 'No explicit queue or supported preset is available for this agent in this file.');
}

export function primaryReviewNotice(snapshot) {
  return snapshot?.primaryCreations?.length
    ? 'A new Orchestrator default in the global file can also change the model for agents in that preset that inherit it.' : '';
}
