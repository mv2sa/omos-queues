import { mountButton, mountCheckbox, mountSelect, mountTextField } from '@openchamber/sdk/ui';
import { marketplacePackageIds, marketplaceProblem, stageMarketplaceSelection, isPendingMarketplaceQueue, marketplaceAgentPresentation } from './editor-state.js';

const el = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const slot = (root, className = '') => { const node = el('div', className); root.append(node); return node; };
function action(root, label, onClick, handles, props = {}) {
  const host = slot(root, 'button-slot'); const handle = mountButton(host, { label, onClick, size: 'sm', variant: 'outline', ...props });
  handles.push(handle); return { handle, slot: host, node: host.querySelector('button') };
}
const inheritance = source => ({ session: 'Session model', orchestrator: 'Orchestrator model', explicit: 'Package model', builtin: 'Built-in inheritance' })[source] || 'Unknown inheritance';
export function marketplaceSourceStatus(state) {
  // A later transport failure can leave the last catalog in place. Do not mask it as a disconnect.
  const disconnected = state.source?.rootPath === '' && state.catalog?.state === 'not-configured'
    && (!state.error || state.error === state.catalog.error?.message);
  return { disconnected, error: disconnected ? '' : state.error || '' };
}
export function mountMarketplacePanel(root, { source, getEditor, isLocked, onEdited, onOverride, onJump, onDiscardQueue, onDiscardStages, onSettings }) {
  let presetName = null; let signature = ''; let disposed = false; let rowHandles = []; const handles = [];
  const header = slot(root, 'marketplace-header'); header.append(el('h2', 'queue-name', 'Installed agents'));
  const actions = slot(header, 'inline-actions');
  const refresh = action(actions, 'Refresh', () => { void source.refresh(); }, handles, { variant: 'ghost' });
  const settings = action(actions, 'Source settings', onSettings, handles, { variant: 'ghost' });
  const scope = el('p', 'muted marketplace-scope'); root.append(scope);
  const selectHost = slot(root, 'marketplace-preset');
  const select = mountSelect(selectHost, { label: 'Preset view', value: null, options: [], placeholder: 'Choose an existing preset',
    onChange(value) { presetName = value; update(); } }); handles.push(select);
  const status = el('p', 'marketplace-status'); status.setAttribute('role', 'status'); root.append(status);
  const stageActions = slot(root, 'inline-actions marketplace-stage-actions');
  const recheck = action(stageActions, 'Recheck packages', () => { void source.refresh({ recheck: true }); }, handles);
  const discard = action(stageActions, 'Discard marketplace stages', onDiscardStages, handles, { variant: 'destructive' });
  const rows = slot(root, 'marketplace-agents'); rows.setAttribute('role', 'list'); rows.setAttribute('aria-label', 'Installed marketplace agents');
  function update() {
    if (disposed) return;
    const editor = getEditor(); const current = source.getState(); const view = editor?.marketplaceView;
    const { disconnected, error } = marketplaceSourceStatus(current);
    if (!view?.presets.some(item => item.name === presetName)) presetName = null;
    const showPresets = Boolean(view?.presets.length && (!disconnected || presetName !== null
      || editor?.marketplace || view.presets.some(item => item.packageIds.length)));
    selectHost.hidden = !showPresets;
    select.update({ value: presetName, options: (view?.presets || []).map(item => ({ id: item.name, label: item.name })), disabled: !view?.presets.length });
    refresh.slot.hidden = disconnected;
    refresh.handle.update({ disabled: Boolean(current.busy), loading: Boolean(current.busy) });
    settings.handle.update({ label: disconnected ? 'Connect source' : 'Source settings', variant: disconnected ? 'outline' : 'ghost' });
    scope.hidden = !view || (disconnected && !showPresets && view.masterEnabled === true);
    scope.textContent = !scope.hidden ? `File preset: ${view.activePreset ?? 'unset'} · Marketplace ${view.masterEnabled === true ? 'enabled' : view.masterEnabled === false ? 'disabled' : 'unsupported'}` : '';
    const issue = editor ? marketplaceProblem(editor) : null;
    const preset = view?.presets.find(item => item.name === presetName);
    status.textContent = [...new Set([error, issue, preset && !preset.editable ? preset.reason : ''].filter(Boolean))].join(' ')
      || (current.busy ? 'Reading installed agents' : view && !disconnected && !view.presets.length ? 'No existing presets in this file.' : '');
    status.hidden = !status.textContent;
    status.dataset.error = String(Boolean(issue || error));
    status.setAttribute('role', status.dataset.error === 'true' ? 'alert' : 'status');
    stageActions.hidden = !editor?.marketplace;
    recheck.handle.update({ disabled: Boolean(current.busy) || isLocked() });
    discard.handle.update({ disabled: isLocked() || Boolean(editor?.unknown || editor?.pendingCommit) });
    const catalog = view?.catalog.state === 'ready' ? view.catalog : current.catalog?.state === 'ready' ? current.catalog : null;
    const selected = editor && presetName ? marketplacePackageIds(editor, presetName) : [];
    const pending = editor?.groups.filter(group => group.marketplaceCreation).map(group => [group.id, group.marketplaceCreation.saved]) || [];
    const next = JSON.stringify([presetName, catalog, preset, selected, pending, isLocked(), Boolean(editor?.marketplaceUnavailable), editor?.marketplace?.edits, Boolean(current.error), disconnected, Boolean(error)]);
    if (next === signature) return;
    signature = next;
    const active = rows.contains(document.activeElement) ? { id: document.activeElement.dataset.packageId, action: document.activeElement.dataset.marketplaceAction } : null;
    rowHandles.forEach(handle => handle.dispose()); rowHandles = []; rows.replaceChildren();
    const packages = new Map((catalog?.packages || []).map(pkg => [pkg.id, pkg]));
    const ids = [...packages.keys(), ...(preset?.agents.filter(agent => !packages.has(agent.packageId)).map(agent => agent.packageId) || [])];
    if (!ids.length && catalog) rows.append(el('p', 'muted', 'No installed packages in this source.'));
    for (const id of ids) {
      const rowPreset = presetName;
      const pkg = packages.get(id); const agent = preset?.agents.find(item => item.packageId === id);
      const group = editor?.groups.find(item => item.marketplaceCreation?.preset === presetName && item.marketplaceCreation.packageId === id);
      const presentation = editor ? marketplaceAgentPresentation(editor, rowPreset, id) : null;
      const currentId = presentation?.queueId;
      const row = el('section', 'marketplace-agent'); row.setAttribute('role', 'listitem'); row.dataset.packageId = id;
      const label = el('div', 'marketplace-agent-name');
      const blocked = (!pkg && agent?.selected ? (disconnected ? 'Source not connected. Existing selection is retained.'
        : error || !catalog || editor?.marketplaceUnavailable ? 'Source not verified. Existing selection is retained.' : 'Not in the current source. Existing selection is retained.')
        : presentation?.blockedReason || pkg?.blockedReason) || '';
      const available = presentation?.canSelect && !current.error;
      if (available) {
        const check = mountCheckbox(label, { label: pkg.displayName || agent.agentName, checked: selected.includes(id),
          disabled: isLocked() || presentation.deselectBlocked,
          onChange(value) {
            try { stageMarketplaceSelection(editor, rowPreset, id, value); onEdited({ structure: false }); }
            catch (error) { status.textContent = error.message; status.hidden = false; status.dataset.error = 'true'; status.setAttribute('role', 'alert'); check.update({ checked: marketplacePackageIds(editor, rowPreset).includes(id) }); }
          } }); rowHandles.push(check);
        const node = label.querySelector('button'); node.dataset.packageId = id; node.dataset.marketplaceAction = 'selection';
        node.setAttribute('aria-describedby', `marketplace-agent-status-${ids.indexOf(id)}`);
      } else label.append(el('h3', '', pkg?.displayName || agent?.agentName || id));
      const baselineSelected = preset?.packageIds.includes(id);
      const staged = preset && (baselineSelected !== selected.includes(id) || isPendingMarketplaceQueue(group));
      const selection = !preset ? '' : staged ? `Staged · ${selected.includes(id) ? 'Selected' : 'Not selected'}` : selected.includes(id) ? 'Selected' : 'Not selected';
      const model = currentId ? isPendingMarketplaceQueue(group) ? 'New model queue' : 'Explicit model queue'
        : pkg ? `${preset ? 'Keep inherited · ' : ''}${inheritance(pkg.modelSource)}` : '';
      const stateLabel = el('p', 'marketplace-agent-state', [selection, model].filter(Boolean).join(' · '));
      stateLabel.id = `marketplace-agent-status-${ids.indexOf(id)}`;
      label.append(el('p', 'muted', `${id}${pkg ? ` · ${pkg.version}` : ''}`), stateLabel);
      if (blocked) label.append(el('p', 'marketplace-blocked', blocked));
      else if (currentId && selected.includes(id)) label.append(el('p', 'muted', isPendingMarketplaceQueue(group) ? 'Discard the staged queue before deselecting.' : 'Saved model override keeps this package selected.'));
      const tools = el('div', 'inline-actions marketplace-agent-actions'); row.append(label, tools);
      if (currentId) {
        const edit = action(tools, 'Edit queue', () => onJump(currentId), rowHandles, { disabled: !editor?.groups.some(item => item.id === currentId) });
        edit.node.dataset.packageId = id; edit.node.dataset.marketplaceAction = 'edit';
        if (isPendingMarketplaceQueue(group)) action(tools, 'Keep inherited', () => onDiscardQueue(currentId), rowHandles,
          { disabled: isLocked() || Boolean(editor?.unknown || editor?.pendingCommit), variant: 'ghost' });
      } else if (preset && pkg) {
        const override = action(tools, 'Override model', () => onOverride(rowPreset, id, override.node), rowHandles,
          { disabled: !available || !presentation?.canOverride || isLocked() });
        override.node.dataset.packageId = id; override.node.dataset.marketplaceAction = 'override';
        override.node.setAttribute('aria-haspopup', 'dialog'); override.node.setAttribute('aria-controls', 'omos-model-picker'); override.node.setAttribute('aria-expanded', 'false');
      }
      rows.append(row);
    }
    if (active) [...rows.querySelectorAll('[data-marketplace-action]')].find(node => node.dataset.packageId === active.id && node.dataset.marketplaceAction === active.action)?.focus({ preventScroll: true });
  }
  update();
  return { update,
    focusPackage(id) {
      const controls = [...rows.querySelectorAll('[data-marketplace-action]')].filter(node => node.dataset.packageId === id && !node.disabled);
      (controls.find(node => node.dataset.marketplaceAction === 'override') || controls[0]
        || (!selectHost.hidden && selectHost.querySelector('button')) || root).focus({ preventScroll: true });
    },
    dispose() { disposed = true; [...handles, ...rowHandles].forEach(handle => handle.dispose()); root.replaceChildren(); } };
}

export function mountMarketplaceSource(root, { source }) {
  let value = source.getState().source?.rootPath || ''; let dirty = false; let disposed = false; const handles = [];
  const field = mountTextField(root, { label: 'Installed marketplace folder', value, mono: true, helper: 'Absolute store root. Read only; blank disconnects.', onChange(next) { value = next; dirty = true; } }); handles.push(field);
  const actions = slot(root, 'inline-actions');
  const save = action(actions, 'Save source', async () => { const submitted = value; await source.configure(submitted); if (!source.getState().error && submitted === value) dirty = false; update(); }, handles);
  const refresh = action(actions, 'Refresh source', () => { void source.refresh(); }, handles);
  const status = el('p', 'marketplace-status'); status.setAttribute('role', 'status'); root.append(status);
  function update() {
    if (disposed) return;
    const state = source.getState();
    const { disconnected, error } = marketplaceSourceStatus(state);
    if (!dirty && state.source && value !== state.source.rootPath) { value = state.source.rootPath; field.update({ value }); }
    field.update({ value, disabled: Boolean(state.busy) }); save.handle.update({ disabled: Boolean(state.busy), loading: state.busy === 'save' }); refresh.handle.update({ disabled: Boolean(state.busy) });
    refresh.slot.hidden = disconnected;
    status.textContent = error || (state.busy ? 'Reading installed metadata' : state.catalog?.state === 'ready' ? `${state.catalog.packages.length} installed packages` : '');
    status.hidden = !status.textContent;
    status.dataset.error = String(Boolean(error)); status.setAttribute('role', error ? 'alert' : 'status');
  }
  update();
  return { update, dispose() { disposed = true; handles.forEach(handle => handle.dispose()); root.replaceChildren(); } };
}
