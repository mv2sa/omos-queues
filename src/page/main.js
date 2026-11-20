import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady, mountButton, mountTextField, mountSearchField, mountList,
  mountSelect, mountCheckbox, navigationKey,
} from '@openchamber/sdk/ui';
import {
  clone, createEditor, createReadyReceiver, isDirty, dirtyGroups, selectQueue, setFilter,
  replaceModels, movePosition, variantOptions, copyQueue, requestPaste, cancelPaste,
  discardQueueSnapshot, canDiscardSnapshot,
  snapshot, previewBody, acceptPreview, beginCommit, acknowledgeSave, markUnknown, reconcile,
  validCommitAcknowledgment,
  recoveryStatus, recoverDraft, catalogIds, validateChanges,
  hasPendingEdits, marketplaceProblem, marketplaceSelectionCount, isPendingMarketplaceQueue,
  beginMarketplacePick, applyMarketplacePick, discardMarketplaceCreation, discardMarketplaceStages, mergeSavedConfig, recheckMarketplaceDraft,
  beginPrimaryPick, applyPrimaryPick, isPendingPrimaryQueue, discardPrimaryCreation,
  inspectableDraft, validMarketplaceRecord,
} from './editor-state.js';
import {
  createRequestFence, createOperations, createDraftController, discardEdits, changeSettings,
  beginModelPick, applyModelPick, handlePickerKey, queueActions, createDialogFocus,
  reloadDisposition, confirmPasteWithFeedback,
  completeDialogAction,
  jumpToQueue, actionPresentation, pickerViewport, pickerTabWrap,
} from './controller.js';
import { describeTarget } from './target-context.js';
import { createDraftId } from './draft-id.js';
import {
  createFavoritesController, createFavoriteSourceController, favoriteFirst, modelRefId, favoriteButtonProps,
} from './favorites.js';
import { mountFavoritesPanel, favoritesStatus } from './favorites-panel.js';
import { createMarketplaceController } from './marketplace.js';
import { mountMarketplacePanel, mountMarketplaceSource } from './marketplace-panel.js';
import { queueWorkspacePlan, queueContext, queueReadOnlyReason, emptyWorkspaceNote, phoneJumpProps, visibleWorkspaceSelection,
  primarySlotAtLimit, primarySlotExplanation, primaryReviewNotice, primaryName, pickerSearchPresentation, INSTALLED_AGENTS_ID } from './workspace-metadata.js';

const el = (tag, className = '', text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const slot = (parent, className = '') => { const node = el('div', className); parent.append(node); return node; };
const host = connectHost({ requestTimeoutMs: 20000 });
let state = null;
let settings = null;
let catalog = { state: 'loading', flat: [], stale: false, error: null };
let drafts = [];
let draftId = createDraftId();
let catalogTimer;
let operation = '';
let picker = null;
let dialogCleanup = [];
let dialogCancel = null;
let dialogBack = null;
let dialogEpoch = 0;
let navHandles = [];
let navSignature = '';
let workspacePlan = [];
let workspaceSelectedId = null;
let starHandles = [];
let importHandles = [];
let importReturnFocus = null;
let viewportFrame = null;
let documentViewport;
let hostKeyboard = 0;
let copyFeedback = null;
let announcement;
const queueViews = new Map();
let favoritesPanel = null;
let favoriteRenderSignature = '';
let marketplacePanel = null;
let marketplaceSourcePanel = null;
const ui = {};
const marketplace = createMarketplaceController({ request: api, getEditor: () => state, onChange({ changed } = {}) {
  marketplacePanel?.update(); marketplaceSourcePanel?.update();
  if (ui.layout) { if (state) renderPresentation(); updateStatus(); if (changed) scheduleDraft(); }
} });
const favorites = createFavoritesController({ storage: host.storage, onChange: () => renderFavoriteState() });
const favoriteSource = createFavoriteSourceController({ request: api, onChange: () => favoritesPanel?.update() });
const requests = createRequestFence();
const operations = createOperations(name => { operation = name; if (ui.layout) updateStatus(); });
const draftController = createDraftController({ request: api, getState: () => state, getId: () => draftId, onStatus: draftNote });
const dialogFocus = createDialogFocus(() => document.activeElement, target => {
  if (target?.isConnected && !target.disabled) target.focus({ preventScroll: true });
});
const editingLocked = () => !state || ['load', 'discard', 'settings', 'draft-delete'].includes(operation);

async function api(path, body, method = body === undefined ? 'GET' : 'POST', query) {
  const response = await host.serviceRequest({ method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(query ? { query } : {}) });
  let data;
  try { data = JSON.parse(response.body); }
  catch { throw new Error('The service returned an unreadable response.'); }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(data.error?.message || `Service request failed (${response.status}).`);
    error.code = data.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}
function button(parent, label, onClick, props = {}, handles) {
  const node = slot(parent, 'button-slot');
  const { intent, ...sdkProps } = props;
  const appearance = actionPresentation({ variant: props.variant || 'outline', intent });
  const handle = mountButton(node, { label, onClick, size: 'sm', ...sdkProps, variant: appearance.variant });
  const control = node.querySelector('button');
  control.dataset.intent = appearance.intent;
  handles?.push(handle);
  return { handle, node: control, slot: node };
}
function message(text, tone = 'info') {
  ui.notice.textContent = text;
  ui.notice.dataset.tone = tone;
  ui.notice.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  ui.notice.hidden = !text;
}
function draftNote(text, error = false) {
  ui.draftStatus.textContent = !error && text === 'No pending draft' ? '' : text;
  ui.draftStatus.dataset.error = String(error);
  updateDraftStatus(Boolean(state && hasPendingEdits(state)));
}
function updateDraftStatus(pending) {
  ui.draftStatus.hidden = !ui.draftStatus.textContent || (!pending && ui.draftStatus.dataset.error !== 'true');
}
function clearEditorAnnouncement(origin) {
  if (!announcement || (origin && announcement.origin !== origin)) return;
  clearTimeout(announcement.timer);
  announcement = null;
}
function announceEditorStatus(text, origin) {
  clearEditorAnnouncement();
  ui.rowStatus.textContent = '';
  announcement = { origin, timer: setTimeout(() => {
    announcement = null;
    if (!origin || origin.isConnected) ui.rowStatus.textContent = text;
  }, 50) };
}
function scheduleDraft() {
  draftController.schedule();
}
function flushDraft() {
  return draftController.persist();
}
function edited({ rebuild = false, focus, groupId } = {}) {
  if (rebuild) renderRows(focus, groupId);
  updateNavMarks();
  updateStatus();
  scheduleDraft();
}
function updateStatus() {
  ui.layout.inert = editingLocked();
  const emptyNote = operation === 'load' ? '' : emptyWorkspaceNote(state);
  if (ui.emptyState.textContent !== emptyNote) ui.emptyState.textContent = emptyNote;
  ui.emptyState.hidden = !emptyNote;
  updateTarget();
  const dirty = state ? dirtyGroups(state).length : 0;
  const selections = state ? marketplaceSelectionCount(state) : 0;
  const pending = state ? hasPendingEdits(state) : false;
  const canReview = pending && validateChanges(state);
  ui.dirtyCount.textContent = [dirty ? `${dirty} ${dirty === 1 ? 'queue' : 'queues'} changed` : '', selections ? `${selections} ${selections === 1 ? 'preset selection' : 'preset selections'} staged` : ''].filter(Boolean).join(' · ') || (pending ? 'Unsaved changes' : 'No unsaved changes');
  const saveDetail = state?.unknown ? 'Save outcome unknown. Check the file before another save.'
    : state?.conflict ? 'The file changed outside this page. Draft edits are retained.'
      : (state && marketplaceProblem(state)) || (pending && !canReview ? 'Choose a complete model ID for each position.' : '');
  ui.saveDetail.textContent = saveDetail;
  ui.saveDetail.hidden = !saveDetail;
  ui.saveDetail.dataset.critical = String(Boolean(saveDetail));
  updateDraftStatus(pending);
  ui.review.handle.update({ disabled: !canReview || Boolean(operation) || Boolean(state?.unknown || state?.conflict), loading: operation === 'preview' });
  ui.reload.handle.update({ disabled: Boolean(operation) || Boolean(state?.unknown) });
  ui.check.slot.hidden = !state?.unknown;
  ui.check.handle.update({ disabled: Boolean(operation), loading: operation === 'reconcile' });
  ui.settings.node.disabled = Boolean(operation) && operation !== 'load';
  ui.recovery.slot.hidden = drafts.length === 0;
  ui.recovery.handle.update({ label: `Drafts (${drafts.length})`, disabled: Boolean(operation) });
  ui.footer.hidden = !state;
  updateQueueActions();
  marketplacePanel?.update();
}
function targetContext() {
  return describeTarget({ target: state?.target, selectedPath: settings?.configFile,
    loading: operation === 'load', unreadable: Boolean(state?.conflict?.unreadable) });
}
function updateTarget() {
  const context = targetContext();
  ui.target.handle.update({ label: context.name, disabled: Boolean(operation) && operation !== 'load' });
  ui.target.node.setAttribute('aria-label', context.accessibleLabel);
  ui.target.node.title = context.paths.map(path => `${path.label}: ${path.value}`).join('\n');
}
function openTargetDetails() {
  if (operation && operation !== 'load') return;
  const context = targetContext();
  openDialog('Global OMOS file', context.description);
  const paths = el('dl', 'target-details');
  for (const path of context.paths) {
    paths.append(el('dt', '', path.label));
    const value = el('dd');
    const code = el('code', '', path.value); code.dir = 'ltr';
    value.append(code); paths.append(value);
  }
  ui.dialogBody.append(paths);
  dialogButton('Close', () => closeDialog());
}
function updateQueueActions(groupId) {
  for (const [id, view] of queueViews) {
    if (groupId && id !== groupId) continue;
    if (view.type === 'primary-slot') {
      view.create.handle.update({ disabled: editingLocked() || Boolean(operation || state?.unknown || state?.conflict) || primarySlotAtLimit(view.entry, state) });
      const explanation = primarySlotExplanation(view.entry, state);
      if (view.explanation.textContent !== explanation) view.explanation.textContent = explanation;
      continue;
    }
    const group = state?.groups.find(group => group.id === id);
    const readonly = Boolean(queueReadOnlyReason(view.entry));
    for (const { id: action, label, disabled } of queueActions(state, group, operation)) {
      const { node } = view.actions[action];
      node.setAttribute('aria-disabled', String(disabled));
      node.setAttribute('aria-label', `${label}: ${view.entry?.label || group.name}`);
      node.title = label;
    }
    view.add.handle.update({ disabled: editingLocked() || !group || readonly || group.models.length >= 50 });
    view.refreshInfo.slot.hidden = !(group?.marketplaceCreation?.saved || group?.primaryCreation?.saved);
    view.footer.hidden = !group || (readonly && view.refreshInfo.slot.hidden);
    view.add.slot.hidden = !group || readonly;
  }
}
function renderNav() {
  const query = state?.filter.trim().toLowerCase() || '';
  const visible = workspacePlan.filter(entry => !query || [entry.label, entry.section, entry.group?.label, entry.preset]
    .some(text => text?.toLowerCase().includes(query)));
  const visibleIds = new Set(visible.map(entry => entry.id));
  const signature = JSON.stringify(workspacePlan.map(entry => [entry.id, entry.label, entry.section, visibleIds.has(entry.id)]));
  if (signature === navSignature) { updateNavMarks(); return; }
  navSignature = signature;
  const active = ui.nav.contains(document.activeElement) ? document.activeElement.dataset.queue : null;
  navHandles.forEach(handle => handle.dispose());
  navHandles = [];
  ui.nav.replaceChildren();
  if (!state) return;
  let section = null; let sectionKey = '';
  for (const entry of visible) {
    if (sectionKey !== entry.section) {
      sectionKey = entry.section;
      section = el('section', 'nav-section');
      section.append(el('h2', 'section-caption', entry.section));
      ui.nav.append(section);
    }
    const item = button(section, entry.label, () => navigate(entry.id), { variant: 'ghost' }, navHandles);
    item.node.dataset.queue = entry.id;
    item.node.title = entry.group?.label || entry.label;
  }
  if (!visible.length) ui.nav.append(el('p', 'muted empty-nav', 'No queues match this search.'));
  // Filtering narrows the outline only. Every queue remains in the workspace.
  ui.phoneSelect.update(phoneJumpProps(workspacePlan, workspaceSelectedId));
  if (active) [...ui.nav.querySelectorAll('[data-queue]')].find(item => item.dataset.queue === active)?.focus({ preventScroll: true });
  updateNavMarks();
}
function updateNavMarks() {
  if (!state) return;
  const entries = new Map(workspacePlan.map(entry => [entry.id, entry]));
  for (const item of ui.nav.querySelectorAll('[data-queue]')) {
    const entry = entries.get(item.dataset.queue);
    if (!entry) continue;
    const dirty = Boolean(entry.group && isDirty(entry.group));
    const readonly = entry.group ? Boolean(queueReadOnlyReason(entry)) : entry.type === 'primary-slot' && !entry.slot?.canCreate;
    item.setAttribute('aria-current', entry.id === workspaceSelectedId ? 'location' : 'false');
    item.dataset.dirty = String(dirty);
    item.dataset.readonly = String(readonly);
    item.setAttribute('aria-label', `${entry.label}${dirty ? ', unsaved changes' : ''}${readonly ? ', read-only' : ''}`);
  }
  for (const group of state.groups) {
    const view = queueViews.get(group.id);
    if (view) view.dirty.textContent = isPendingPrimaryQueue(group) || isPendingMarketplaceQueue(group) ? 'Staged model queue'
      : group.marketplaceCreation?.saved || group.primaryCreation?.saved ? 'Saved · queue info pending' : isDirty(group) ? 'Unsaved changes' : '';
  }
}
function activateQueue(id) {
  if (!state || id === workspaceSelectedId) return;
  workspaceSelectedId = id;
  selectQueue(state, id);
  ui.phoneSelect.update(phoneJumpProps(workspacePlan, id));
  updateNavMarks();
}
function navigate(id) {
  if (editingLocked()) return;
  closePicker(false);
  const view = queueViews.get(id);
  if (view?.type === 'queue') {
    if (jumpToQueue(state, id, view)) activateQueue(id);
    return;
  }
  const target = id === INSTALLED_AGENTS_ID ? ui.marketplaceRoot : view?.section;
  if (!target) return;
  activateQueue(id);
  target.scrollIntoView({ block: 'start', inline: 'nearest' });
  (view?.name || target).focus({ preventScroll: true });
}
function renderPresentation({ reset = false } = {}) {
  if (!state) return;
  if (reset) {
    closePicker(false);
    for (const [id, view] of queueViews) unmountQueue(id, view);
  }
  workspacePlan = queueWorkspacePlan(state);
  const selected = visibleWorkspaceSelection(workspacePlan, workspaceSelectedId, state.selectedId);
  if (workspaceSelectedId !== selected) {
    workspaceSelectedId = selected;
    navSignature = ''; // The jump value changed even if the labels didn't.
  }
  if (!workspacePlan.some(entry => entry.id === state.selectedId)) state.selectedId = null;
  selectQueue(state, workspaceSelectedId);
  const ids = new Set(workspacePlan.map(entry => entry.id));
  for (const [id, view] of queueViews) if (!ids.has(id)) unmountQueue(id, view);
  for (const entry of workspacePlan) {
    if (entry.type === 'marketplace') {
      ui.marketplaceRoot.querySelector('h2').textContent = entry.label;
      continue;
    }
    const view = queueViews.get(entry.id) || mountQueue(entry);
    view.entry = entry;
    view.name.textContent = entry.label;
    view.name.title = entry.group?.label || entry.label;
    if (entry.type === 'primary-slot') {
      view.context.textContent = entry.preset !== null ? `Preset ${entry.preset} · ${entry.slot?.canCreate ? 'No model override' : 'Read only'}` : 'Read only';
      view.create.slot.hidden = !entry.slot?.canCreate || entry.category !== 'orchestrator';
      view.create.node.setAttribute('aria-label', `Add ${entry.name} model override${entry.preset !== null ? ` in ${entry.preset}` : ''}`);
    } else {
      view.context.textContent = queueContext(entry);
      if (view.rowSignature !== rowSignature(entry) || view.group !== entry.group) renderRows(undefined, entry.id);
      else if (view.rowLabel !== entry.group.label) updateRowLabels(view, entry.group);
    }
  }
  // Move only sections out of order. Focused controls retain their identity,
  // value and focus even when a verified marketplace refresh moves a section.
  const active = document.activeElement;
  let next = null;
  for (const entry of [...workspacePlan].reverse()) {
    const section = entry.type === 'marketplace' ? ui.marketplaceRoot : queueViews.get(entry.id).section;
    if (section.parentNode !== ui.queues || section.nextElementSibling !== next) {
      if (section.parentNode === ui.queues && typeof ui.queues.moveBefore === 'function') ui.queues.moveBefore(section, next);
      else ui.queues.insertBefore(section, next);
    }
    next = section;
  }
  if (active !== document.activeElement && active?.isConnected && ui.queues.contains(active) && !active.disabled) active.focus({ preventScroll: true });
  renderNav();
  updateQueueActions();
}
function unmountQueue(id, view) {
  if (view.actions) {
    const origin = view.actions.copy.node;
    if (copyFeedback?.node === origin) clearCopyFeedback();
    clearEditorAnnouncement(origin);
  }
  [...view.handles, ...view.rowHandles].forEach(handle => handle.dispose());
  view.section.remove(); queueViews.delete(id);
}
function mountQueue(entry) {
    const { id, group, anchorId, type, category } = entry;
    const section = el('section', 'queue-workspace'); section.id = anchorId;
    if (group) section.dataset.queueId = group.id;
    if (category === 'orchestrator') {
      section.dataset.primaryAgent = category;
      if (entry.preset !== null) section.dataset.preset = entry.preset;
    }
    const header = el('div', 'queue-header'); const heading = slot(header, 'queue-heading');
    const name = el('h2', 'queue-name', entry.label); name.dir = 'auto'; name.tabIndex = -1; name.id = `${anchorId}-title`;
    section.setAttribute('aria-labelledby', name.id);
    const context = el('p', 'muted queue-context'); const dirty = el('span', 'queue-dirty');
    const metadata = el('div', 'queue-metadata'); metadata.append(context, dirty);
    heading.append(name, metadata);
    const tools = slot(header, 'queue-tools'); const handles = [];
    section.addEventListener('focusin', () => { if (!editingLocked()) activateQueue(id); });
    if (type === 'primary-slot') {
      section.classList.add('primary-slot');
      const create = button(tools, 'Add model override', () => {
        const current = queueViews.get(id)?.entry;
        if (current?.slot?.canCreate) openPrimaryPicker(current.slot, create.node);
      }, {}, handles);
      create.node.dataset.primaryAction = 'create';
      modelPickerTrigger(create.node);
      const explanation = el('p', 'muted primary-explanation');
      explanation.id = `${anchorId}-help`; create.node.setAttribute('aria-describedby', explanation.id);
      section.append(header, explanation);
      const view = { type, section, name, context, create, explanation, handles, rowHandles: [] };
      queueViews.set(id, view); return view;
    }
    const actions = {};
    for (const action of ['copy', 'paste', 'reset']) {
      const control = button(tools, '', () => {
        if (editingLocked() || control.node.getAttribute('aria-disabled') === 'true') return;
        activateQueue(id);
        if (action === 'copy') {
          try { copyQueue(state, id); updateQueueActions(); acknowledgeCopy(control.node, queueName(id)); }
          catch (error) { message(error.message, 'error'); }
        } else if (action === 'paste') pasteQueue(id);
        else discardQueue(id);
      }, { variant: 'ghost' }, handles);
      control.node.classList.add('queue-action');
      control.node.dataset.queueAction = action;
      control.node.prepend(queueActionIcon(action));
      actions[action] = control;
    }
    const readonly = el('p', 'status-box'); readonly.dataset.tone = 'warning'; readonly.hidden = true;
    const rows = el('div', 'queue-rows'); const footer = el('div', 'queue-footer');
    const add = button(footer, 'Add position', () => {
      const current = state?.groups.find(item => item.id === id);
      if (editingLocked() || !current) return;
      activateQueue(id); openPicker(current.models.length, true, id, add.node);
    }, {}, handles);
    const refreshInfo = button(footer, 'Refresh queue info', () => { void refreshSavedQueues(); }, { variant: 'ghost' }, handles);
    modelPickerTrigger(add.node);
    section.append(header, readonly, rows, footer);
    const view = { type, section, name, context, dirty, readonly, rows, footer, add, refreshInfo, actions, handles, rowHandles: [] };
    queueViews.set(id, view); return view;
}
function iconPath(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('move-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path); return svg;
}
function queueActionIcon(action) {
  return iconPath({ copy: copyIcon, paste: 'M9 5H6v15h12V5h-3 M9 3h6v5H9z M9 13h6m-6 3h5',
    reset: 'M4 10a8 8 0 1 1 1 7 M4 4v6h6' }[action]);
}
const copyIcon = 'M8 8h12v12H8z M16 8V4H4v12h4';
const queueName = (id, fallback) => queueViews.get(id)?.entry.label || fallback;
function clearCopyFeedback() {
  if (!copyFeedback) return;
  const { node, path, timer } = copyFeedback;
  clearTimeout(timer);
  delete node.dataset.copied;
  path.setAttribute('d', copyIcon);
  copyFeedback = null;
}
function acknowledgeCopy(node, label) {
  clearCopyFeedback();
  const path = node.querySelector('.move-icon path');
  node.dataset.copied = 'true';
  path.setAttribute('d', 'M5 12l4 4L19 6');
  copyFeedback = { node, path, timer: setTimeout(clearCopyFeedback, 1600) };
  announceEditorStatus(`Copied ${label}.`, node);
}
function modelPickerTrigger(node) {
  node.setAttribute('aria-haspopup', 'dialog'); node.setAttribute('aria-expanded', 'false'); node.setAttribute('aria-controls', 'omos-model-picker');
}
const rowSignature = entry => JSON.stringify([entry.group.models, entry.group.defaultVariant, queueReadOnlyReason(entry)]);
function updateRowLabels(view, group) {
  view.rowLabel = group.label;
  [...view.rows.children].forEach((row, index) => {
    row.querySelector('.model-trigger').setAttribute('aria-label', `${group.label}, position ${index + 1}, model ${group.models[index].id || 'not selected'}. Change model`);
    for (const word of ['up', 'down']) row.querySelector(`[data-action="${word}"]`).setAttribute('aria-label', `Move ${group.label} position ${index + 1} ${word}`);
    row.querySelector('[data-action="remove"]').setAttribute('aria-label', `Remove ${group.label} position ${index + 1}`);
  });
}
function renderRows(focus, groupId) {
  if (!state) return;
  if (!groupId) { for (const group of state.groups) renderRows(group.id === state.selectedId ? focus : undefined, group.id); return; }
  const group = state.groups.find(group => group.id === groupId); const view = queueViews.get(groupId);
  if (!group || !view) return;
  view.rowSignature = rowSignature(view.entry); view.group = group;
  view.rowHandles.forEach(handle => handle.dispose()); view.rowHandles = []; view.rows.replaceChildren();
  const rowHandles = view.rowHandles;
  view.context.textContent = queueContext(view.entry);
  const reason = queueReadOnlyReason(view.entry);
  view.readonly.hidden = !reason; view.readonly.textContent = reason;
  const readonly = Boolean(reason);
  updateQueueActions(groupId);
  group.models.forEach((model, index) => {
    const row = el('div', 'model-row');
    row.dataset.index = index;
    const order = el('div', 'position');
    order.append(el('span', 'position-number', String(index + 1).padStart(2, '0')), el('span', 'muted position-kind', index === 0 ? 'Primary' : 'Fallback'));
    const modelSlot = slot(row, 'model-cell');
    const choose = button(modelSlot, model.id || 'Choose model', () => {
      activateQueue(group.id); openPicker(index, false, group.id, choose.node);
    }, { disabled: readonly, variant: 'outline', size: 'default' }, rowHandles);
    choose.node.classList.add('model-trigger');
    choose.node.dataset.action = 'model';
    choose.node.title = model.id || 'Choose model';
    modelPickerTrigger(choose.node);
    const controls = slot(row, 'model-controls');
    const variantSlot = slot(controls, 'variant-cell');
    const options = variantOptions(model.variant, group.defaultVariant);
    let customId = '\u0000custom';
    while (options.some(option => option.id === customId)) customId += '\u0000';
    const variant = mountSelect(variantSlot, {
      label: `Position ${index + 1} variant`, value: model.variant,
      options: [...options, { id: customId, label: 'Custom variant...' }], disabled: readonly,
      onChange: value => {
        if (editingLocked()) return;
        activateQueue(group.id);
        if (value === customId) { openCustomVariant(index, group.id); return; }
        const models = clone(group.models); models[index].variant = value;
        replaceModels(state, group.id, models);
        variant.update({ value });
        view.rowSignature = rowSignature(view.entry);
        edited();
      },
    });
    rowHandles.push(variant);
    variantSlot.querySelector('button').dataset.action = 'variant';
    const actions = slot(controls, 'row-actions');
    for (const [direction, word] of [[-1, 'up'], [1, 'down']]) {
      const move = button(actions, '', () => {
        if (editingLocked()) return;
        activateQueue(group.id);
        const target = movePosition(state, group.id, index, direction);
        edited({ rebuild: true, groupId: group.id, focus: { index: target, action: word } });
        announceEditorStatus(`Moved position ${index + 1} to ${target + 1}.`);
      }, { variant: 'outline', size: 'default', disabled: readonly || index + direction < 0 || index + direction >= group.models.length }, rowHandles);
      move.node.classList.add('move-button'); move.node.prepend(iconPath(direction < 0 ? 'M6 14l6-6 6 6' : 'M6 10l6 6 6-6'));
      move.node.dataset.action = word;
      move.node.title = `Move ${word}`;
    }
    const remove = button(actions, 'Remove', () => {
      if (editingLocked()) return;
      activateQueue(group.id);
      const models = clone(group.models); models.splice(index, 1);
      replaceModels(state, group.id, models);
      edited({ rebuild: true, groupId: group.id, focus: { index: Math.min(index, models.length - 1), action: 'model' } });
    }, { variant: 'destructive', size: 'default', disabled: readonly || group.models.length === 1 }, rowHandles);
    remove.node.dataset.action = 'remove';
    row.prepend(order);
    view.rows.append(row);
  });
  updateRowLabels(view, group);
  if (focus) {
    const row = view.rows.children[focus.index];
    const control = row?.querySelector(`[data-action="${focus.action}"]:not(:disabled)`) || row?.querySelector('button:not(:disabled)');
    control?.focus({ preventScroll: true });
  }
}
function openPicker(index, adding = false, groupId = state?.selectedId, anchor = document.activeElement) {
  const group = state?.groups.find(group => group.id === groupId);
  if (editingLocked() || !group || queueReadOnlyReason(queueViews.get(groupId)?.entry)) return;
  const pending = beginModelPick(state, group.id, index, adding);
  if (!pending) return;
  showModelPicker(pending, `${group.label} · ${adding ? 'Add position' : 'Position'} ${index + 1}`, anchor);
}
function openMarketplacePicker(preset, packageId, anchor) {
  if (editingLocked()) return;
  try { showModelPicker(beginMarketplacePick(state, preset, packageId), `${packageId} · Preset ${preset} · New override`, anchor); }
  catch (error) { message(error.message, 'error'); }
}
function openPrimaryPicker(slot, anchor) {
  if (editingLocked() || operation || state.unknown || state.conflict || slot.agent !== 'orchestrator') return;
  try {
    const entry = { category: slot.agent, slot };
    if (primarySlotAtLimit(entry, state)) throw new Error(primarySlotExplanation(entry, state));
    const pending = beginPrimaryPick(state, slot.preset, slot.agent);
    if (!pending) throw new Error('This preset no longer supports a new Orchestrator override.');
    showModelPicker(pending, `${primaryName(slot.agent)} · Preset ${slot.preset} · First override`, anchor);
  } catch (error) { message(error.message, 'error'); }
}
function showModelPicker(pending, context, anchor) {
  closePicker(false);
  picker = { ...pending, query: '', returnTo: anchor };
  ui.pickerContext.textContent = context;
  ui.pickerError.hidden = true;
  anchor?.setAttribute('aria-expanded', 'true');
  ui.modelSearch.update({ value: '' });
  ui.modelList.update({ items: [], selectedId: null });
  renderPicker();
  sizeFullViewport(ui.picker, picker);
  ui.picker.hidden = false;
  ui.picker.showModal();
  ui.picker.scrollTop = 0;
  ui.modelResults.scrollTop = 0;
  ui.modelInput.focus({ preventScroll: true });
  scheduleFullViewport();
}
function closePicker(restore = true) {
  if (!picker) return;
  const { returnTo: target, groupId, index, adding, kind, packageId } = picker;
  picker = null;
  target?.setAttribute('aria-expanded', 'false');
  if (ui.picker.open) ui.picker.close();
  ui.picker.hidden = true;
  if (!restore) return;
  if ((!target?.isConnected || target.disabled) && kind === 'marketplace') {
    marketplacePanel?.focusPackage(packageId);
    return;
  }
  const view = queueViews.get(groupId);
  const fallback = adding ? view?.add.node : view?.rows?.children[index]?.querySelector('.model-trigger');
  const focus = target?.isConnected && !target.disabled ? target : fallback && !fallback.disabled ? fallback : view?.name || ui.target.node;
  focus.focus({ preventScroll: true });
}
function sizeFullViewport(dialog, layout) {
  const { innerWidth: width, innerHeight: height } = window;
  if (layout.width !== width) { layout.width = width; layout.height = height; }
  layout.height = Math.max(layout.height, height);
  const root = document.documentElement;
  const frame = pickerViewport(window.visualViewport, root.clientWidth || width, root.clientHeight || height,
    { keyboard: hostKeyboard, unobscuredHeight: layout.height });
  // The frame's client box excludes any classic scrollbar on the workspace.
  if (root.clientWidth > frame.left) frame.width = Math.min(frame.width, root.clientWidth - frame.left);
  if (root.clientHeight > frame.top) frame.height = Math.min(frame.height, root.clientHeight - frame.top);
  for (const [key, value] of Object.entries(frame)) dialog.style.setProperty(`--modal-${key}`, `${value}px`);
}
function scheduleFullViewport() {
  if (viewportFrame !== null || (!picker && ui.dialog?.dataset.dialogMode !== 'document')) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = null;
    if (picker) sizeFullViewport(ui.picker, picker);
    if (ui.dialog.open && documentViewport) sizeFullViewport(ui.dialog, documentViewport);
  });
}
function pickerError(text) {
  ui.pickerError.textContent = text;
  ui.pickerError.hidden = false;
  ui.pickerError.scrollIntoView({ block: 'nearest' });
}
function pickModel(id) {
  if (editingLocked() || !picker) return;
  if (picker.kind === 'marketplace' || picker.kind === 'primary') {
    try {
      const created = picker.kind === 'primary' ? applyPrimaryPick(state, picker, id) : applyMarketplacePick(state, picker, id);
      if (!created) throw new Error('The queue or draft changed. Close this picker and choose the override again.');
      closePicker(false); renderPresentation(); edited(); navigate(created.id);
      queueViews.get(created.id)?.rows.querySelector('.model-trigger')?.focus();
    } catch (error) { pickerError(error.message); }
    return;
  }
  const { index, groupId } = picker;
  if (!applyModelPick(state, picker, id)) {
    pickerError('The model choice is no longer valid for this queue. Close this picker and try again.');
    return;
  }
  closePicker(false);
  edited({ rebuild: true, groupId, focus: { index, action: 'model' } });
}
function pickerIds() {
  return favoriteFirst(catalogIds(state, catalog.flat, picker?.query || ''), favorites.getState().record.models);
}
function renderFavoriteState() {
  favoritesPanel?.update();
  if (!ui.favoriteStatus) return;
  const local = favorites.getState();
  ui.favoriteStatus.textContent = favoritesStatus(local);
  ui.favoriteStatus.dataset.error = String(Boolean(local.readError || local.writeError));
  ui.favoriteStatus.hidden = !(local.readError || local.writeError || local.reading || local.saving);
  const error = local.readError || local.writeError;
  ui.favoritesNotice.textContent = error ? `${error} Open Settings to retry.` : '';
  ui.favoritesNotice.hidden = !error;
  const signature = JSON.stringify([local.loaded, local.readError, local.record.models]);
  if (signature !== favoriteRenderSignature) { favoriteRenderSignature = signature; renderPicker(); }
}
function pickerStars() {
  return [...ui.favoriteStars.querySelectorAll('[data-favorite-id]:not(:disabled)')];
}
function setPickerStar(id, controls = pickerStars()) {
  const active = controls.find(button => button.dataset.favoriteId === id) || controls[0];
  if (picker) picker.favoriteId = active?.dataset.favoriteId;
  controls.forEach(button => { button.tabIndex = button === active ? 0 : -1; });
  return active;
}
function renderPicker() {
  if (!picker) return;
  const ids = picker.ids = pickerIds();
  const local = favorites.getState(); const favoriteIds = new Set(local.record.models.map(modelRefId));
  const configured = state.groups.find(group => group.id === picker.groupId)?.models[picker.index]?.id;
  const visible = ids.slice(0, 300);
  ui.modelGrid.style.setProperty('--result-rows', String(Math.max(1, visible.length)));
  const searchScrollTop = document.activeElement === ui.modelInput ? ui.picker.scrollTop : null;
  ui.modelList.update({ items: visible.map(id => ({ id, title: id,
    subtitle: favoriteIds.has(id) && (catalog.state !== 'ready' || catalog.stale || !catalog.flat.includes(id))
      ? catalog.state === 'ready' && !catalog.stale ? 'Configured ID, unavailable in the current catalog' : 'Availability is not verified by a current catalog'
      : undefined,
    meta: [favoriteIds.has(id) ? 'Favorite' : '', id === configured ? 'Current' : ''].filter(Boolean).join(' · ') })), selectedId: configured });
  if (searchScrollTop !== null) ui.picker.scrollTop = searchScrollTop;
  const activeFavorite = ui.favoriteStars.contains(document.activeElement) ? document.activeElement.dataset.favoriteId : null;
  starHandles.forEach(handle => handle.dispose()); starHandles = []; ui.favoriteStars.replaceChildren();
  const options = [...ui.modelOptions.querySelectorAll('[role="option"]')];
  const firstOther = visible.findIndex(id => !favoriteIds.has(id));
  visible.forEach((id, index) => {
    const starRow = slot(ui.favoriteStars, 'favorite-star-row');
    const separated = firstOther > 0 && index === firstOther;
    starRow.dataset.firstOther = String(separated);
    if (options[index]) { options[index].dataset.firstOther = String(separated); options[index].title = id; }
    const selected = favoriteIds.has(id);
    const props = favoriteButtonProps(id, selected, !local.loaded || Boolean(local.readError) || (!selected && local.record.models.length >= 64));
    const star = button(starRow, props.label, () => {
      try { favorites.toggle(id); } catch (error) { pickerError(error.message); }
    }, { variant: 'ghost', disabled: props.disabled }, starHandles);
    star.node.dataset.favoriteId = id;
    star.node.tabIndex = -1;
    star.node.setAttribute('aria-label', props.ariaLabel); star.node.setAttribute('aria-pressed', props.pressed);
  });
  const focusedStar = setPickerStar(activeFavorite || picker.favoriteId || configured);
  if (activeFavorite) {
    const active = focusedStar || ui.modelInput;
    active.focus({ preventScroll: true }); active.scrollIntoView({ block: 'nearest' });
  }
  const search = pickerSearchPresentation(picker.query, ids, visible.length);
  ui.modelResult.textContent = search.status;
  ui.useId.slot.hidden = !search.useEnteredId;
  ui.useId.handle.update({ disabled: !search.useEnteredId });
}
function renderCatalog() {
  const available = `${catalog.flat.length} models`;
  ui.catalogText.textContent = catalog.state === 'loading'
    ? `Loading model catalog${catalog.flat.length ? `. ${available} cached` : ''}`
    : catalog.state === 'error' ? `Catalog unavailable${catalog.flat.length ? `. ${available} cached` : ''}`
      : `${available}${catalog.stale ? ' · Cached catalog is stale' : ''}`;
  ui.catalogText.dataset.tone = catalog.state === 'error' ? 'error' : catalog.stale ? 'warning' : 'neutral';
  ui.catalogText.title = catalog.error?.message || '';
  ui.catalogError.textContent = catalog.error?.message || '';
  ui.catalogError.hidden = !catalog.error;
  ui.pickerCatalog.textContent = catalog.error?.message || (catalog.state === 'loading' || catalog.stale ? ui.catalogText.textContent : '');
  ui.pickerCatalog.setAttribute('role', catalog.error ? 'alert' : 'status');
  ui.pickerCatalog.dataset.tone = ui.catalogText.dataset.tone;
  ui.pickerCatalog.hidden = !ui.pickerCatalog.textContent;
  ui.refresh.handle.update({ disabled: catalog.state === 'loading', loading: false });
  renderPicker();
  favoritesPanel?.update();
}
function marketplaceEdited({ structure = false } = {}) {
  if (structure) renderPresentation();
  edited(); marketplacePanel?.update();
}
function requestDiscardMarketplace() {
  if (!state?.marketplace || operation || state.unknown) return;
  confirmAction('Discard marketplace stages?', 'Staged selections and new model queues are removed. Existing queue edits stay.', 'Discard stages', async () => {
    const saved = snapshot(state);
    const applied = await discardEdits({ drafts: draftController, operations, stillCurrent: () => canDiscardSnapshot(state, saved),
      apply() { discardMarketplaceStages(state); renderPresentation(); updateStatus(); } });
    if (applied) ui.marketplaceRoot.focus({ preventScroll: true });
  });
}
async function refreshSavedQueues() {
  if (!state) return;
  const editor = state; const generation = editor.target.generation; const hash = editor.baseHash;
  try {
    const config = await api('/config');
    if (state !== editor || editor.target.generation !== generation || editor.baseHash !== hash) return;
    if (!mergeSavedConfig(editor, config)) { editor.conflict = config; message('The file changed again. Local edits are retained; reload before another save.', 'error'); }
    else renderPresentation();
  } catch (error) {
    if (state === editor && editor.baseHash === hash) message(`Saved queue information could not be refreshed. ${error.message}`, 'error');
  } finally { if (state === editor) updateStatus(); }
}
function openFavorites() {
  void openSettings({ favoritesOpen: true });
}
function reviewFavoriteImport() {
  let preview;
  try { preview = favorites.prepareImport(favoriteSource.getState().snapshot); }
  catch (error) { dialogError(error); return; }
  closeFavoriteImport(false);
  importReturnFocus = document.activeElement;
  const dialog = ui.favoriteImportDialog;
  dialog.replaceChildren();
  const header = el('header', 'dialog-header'); const title = el('h2', 'dialog-title', 'Replace extension favorites?');
  title.id = 'favorite-import-title'; header.append(title); dialog.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'dialog-body');
  body.append(el('p', 'dialog-description', preview.models.length
    ? `${preview.models.length} ${preview.models.length === 1 ? 'model' : 'models'} in source order. Your local stars will be replaced.`
    : 'The source is empty. This clears all extension favorites.'));
  const ordered = el('ol', 'favorite-import-list'); ordered.setAttribute('aria-label', 'Favorites to import in source order');
  for (const ref of preview.models) { const item = el('li'); item.append(el('code', '', modelRefId(ref))); ordered.append(item); }
  const error = el('p', 'status-box'); error.dataset.tone = 'error'; error.setAttribute('role', 'alert'); error.hidden = true;
  body.append(ordered, error); const actions = el('footer', 'dialog-actions');
  button(actions, 'Cancel', () => closeFavoriteImport(), {}, importHandles);
  button(actions, preview.models.length ? 'Replace extension favorites' : 'Clear extension favorites', () => {
    try { favorites.applyImport(preview, favoriteSource.getState().snapshot); closeFavoriteImport(); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; }
  }, { intent: preview.models.length ? 'positive' : 'destructive' }, importHandles);
  dialog.append(header, body, actions); dialog.showModal();
}
function closeFavoriteImport(restore = true) {
  if (!ui.favoriteImportDialog) return;
  importHandles.forEach(handle => handle.dispose()); importHandles = [];
  if (ui.favoriteImportDialog.open) ui.favoriteImportDialog.close();
  if (restore && importReturnFocus?.isConnected && !importReturnFocus.disabled) importReturnFocus.focus({ preventScroll: true });
  importReturnFocus = null;
}
async function loadCatalog(refresh = false, sequence = requests.token()) {
  clearTimeout(catalogTimer);
  return requests.run(sequence, () => api(refresh ? '/models/refresh' : '/models', refresh ? {} : undefined), {
    success(result) {
      catalog = result;
      renderCatalog();
      if (catalog.state === 'loading') catalogTimer = setTimeout(() => { void loadCatalog(false, sequence); }, 1400);
    },
    failure(error) {
      catalog = { ...catalog, state: 'error', stale: Boolean(catalog.flat.length), error: { message: error.message } };
      renderCatalog();
    },
  });
}
async function loadDrafts(sequence = requests.token()) {
  return requests.run(sequence, () => api('/drafts'), {
    success(result) { drafts = result.drafts.filter(draft => draft?.id !== draftId); updateStatus(); },
    failure(error) { draftNote(`Stored drafts could not be loaded. ${error.message}`, true); },
  });
}
async function load() {
  // Only startup and confirmed reload/settings transitions call this method.
  // An unknown token must first settle through reconcile or settings rotation.
  if (state?.unknown || state?.pendingCommit) return;
  const sequence = requests.begin();
  const task = operations.begin('load');
  ui.loadState.hidden = false;
  ui.loadText.textContent = 'Loading global queues';
  ui.retry.slot.hidden = true;
  if (!state) ui.layout.hidden = true;
  updateStatus();
  void requests.run(sequence, () => api('/settings'), {
    success(result) {
      settings = result.settings;
      updateTarget();
    },
    failure(error) {
      updateTarget();
      message(`Server settings could not be loaded. ${error.message}`, 'error');
    },
  });
  void loadCatalog(false, sequence);
  void loadDrafts(sequence);
  return requests.run(sequence, () => api('/config'), {
    success(config) {
      const previous = state;
      state = createEditor(config);
      if (previous) { selectQueue(state, previous.selectedId); state.filter = previous.filter; state.clipboard = previous.clipboard; }
      updateTarget();
      ui.loadState.hidden = true;
      ui.layout.hidden = false;
      closePicker(false);
      renderPresentation({ reset: true });
      void marketplace.refresh();
    },
    failure(error) {
      ui.loadText.textContent = error.message;
      ui.retry.slot.hidden = false;
      if (!state) {
        ui.layout.hidden = true;
      } else {
        ui.loadState.hidden = true;
        state.conflict = { unreadable: true };
        message(`The file could not be read. ${error.message} Existing drafts are retained. Resolve the error or discard and reload.`, 'error');
      }
    },
    finished() { operations.finish(task); updateStatus(); },
  });
}
function openDialog(title, body, { documentMode = false } = {}) {
  const pickerOrigin = picker?.returnTo;
  closePicker(false); closeFavoriteImport(false);
  const nested = ui.dialog.open;
  dialogFocus.capture(nested);
  if (!nested && pickerOrigin?.isConnected) dialogFocus.origin = pickerOrigin;
  if (nested) closeDialog(false);
  dialogEpoch += 1;
  ui.dialogTitle.textContent = title;
  ui.dialogBody.replaceChildren(); ui.dialogActions.replaceChildren();
  ui.dialogError.textContent = '';
  ui.dialogError.hidden = true;
  dialogCleanup = [];
  dialogCancel = null;
  dialogBack = null;
  ui.dialog.dataset.dialogMode = documentMode ? 'document' : 'normal';
  let context = ui.dialogBody;
  if (documentMode) {
    context = slot(ui.dialogBody, 'document-context');
    documentViewport = {};
    sizeFullViewport(ui.dialog, documentViewport);
  }
  if (body) context.append(el('p', 'dialog-description', body));
  ui.dialog.showModal();
  ui.dialog.scrollTop = 0; ui.dialog.scrollLeft = 0;
  ui.dialogBody.scrollTop = 0;
  if (documentMode) scheduleFullViewport();
  const epoch = dialogEpoch;
  queueMicrotask(() => {
    if (ui.dialog.open && dialogEpoch === epoch && (documentMode || document.activeElement === ui.dialog)) {
      const focus = (documentMode && ui.dialogBody.querySelector('.diff'))
        || [...ui.dialog.querySelectorAll('input, textarea, button')].find(node => !node.disabled && node.getClientRects().length);
      focus?.focus({ preventScroll: true });
    }
  });
  return context;
}
function dialogButton(label, action, props) {
  return button(ui.dialogActions, label, action, props, dialogCleanup);
}
function closeDialog(restore = true, acknowledged = false) {
  if (!acknowledged && (operation === 'commit' || operation === 'settings')) return;
  closeFavoriteImport(false);
  dialogEpoch += 1;
  dialogCancel?.(); dialogCancel = null;
  dialogBack = null;
  dialogCleanup.forEach(handle => handle.dispose()); dialogCleanup = [];
  ui.dialog.close();
  ui.dialog.dataset.dialogMode = 'normal';
  documentViewport = undefined;
  if (restore) dialogFocus.restore();
}
function dialogError(error) { ui.dialogError.textContent = error.message || error; ui.dialogError.hidden = false; }
function confirmAction(title, body, label, action, { reopensDialog = false } = {}) {
  openDialog(title, body);
  dialogButton('Cancel', () => closeDialog());
  dialogButton(label, async () => {
    const origin = dialogFocus.origin;
    closeDialog(false);
    const closedEpoch = dialogEpoch;
    await action();
    completeDialogAction(dialogFocus, { origin, closedEpoch, currentEpoch: dialogEpoch, isOpen: ui.dialog.open, reopensDialog });
  }, { variant: 'destructive' });
}
function discardQueue(groupId = state?.selectedId) {
  const group = state?.groups.find(group => group.id === groupId);
  if (operation || !group || !isDirty(group) || state.unknown) return;
  const primary = isPendingPrimaryQueue(group) ? group.primaryCreation : null;
  const marketplaceCreation = isPendingMarketplaceQueue(group) ? group.marketplaceCreation : null;
  if (primary || marketplaceCreation) {
    confirmAction('Reset staged model queue?', primary ? `Remove the staged ${primaryName(primary.agent)} override in ${primary.preset}? Other queue drafts stay unchanged.`
      : 'The package selection stays staged. Other queue edits stay unchanged.', 'Remove staged queue', async () => {
      const saved = snapshot(state);
      const applied = await discardEdits({ drafts: draftController, operations, stillCurrent: () => canDiscardSnapshot(state, saved),
        apply() {
          if (primary) discardPrimaryCreation(state, group.id);
          else discardMarketplaceCreation(state, group.id);
          renderPresentation(); updateStatus();
        } });
      if (!applied) { message('The queue changed while preparing to reset it. Newer edits were kept.', 'warning'); return; }
      if (primary) {
        const entry = workspacePlan.find(entry => entry.type === 'primary-slot' && entry.preset === primary.preset && entry.category === primary.agent);
        const view = queueViews.get(entry?.id);
        if (view) {
          navigate(entry.id);
          if (!view.create.slot.hidden && !view.create.node.disabled) view.create.node.focus({ preventScroll: true });
        }
      } else marketplacePanel?.focusPackage(marketplaceCreation.packageId);
    });
    return;
  }
  confirmAction(`Reset edits to ${queueName(group.id, group.label)}?`, '', 'Reset queue', async () => {
    const discarded = clone(group.models);
    const target = clone(state.target);
    const revision = state.revision;
    const applied = await discardEdits({ drafts: draftController, operations,
      stillCurrent: () => state?.revision === revision && !state.unknown && !state.pendingCommit
        && state.target.path === target.path && state.target.generation === target.generation,
      apply() { discardQueueSnapshot(state, group.id, discarded, target); renderRows(undefined, group.id); updateNavMarks(); updateStatus(); },
    });
    if (!applied) message('The queue changed while preparing to discard it. Newer edits were kept.', 'warning');
  });
}
function pasteQueue(groupId = state?.selectedId) {
  if (editingLocked()) return;
  const group = state?.groups.find(group => group.id === groupId);
  if (!group) return;
  const pending = requestPaste(state, group.id);
  if (!pending) return;
  const count = pending.models.length;
  const destination = queueName(group.id, group.label);
  const source = queueName(state.clipboard.source, pending.label);
  openDialog(`Replace ${destination}’s draft with ${count} ${count === 1 ? 'position' : 'positions'} from ${source}?`);
  dialogCancel = () => cancelPaste(state);
  dialogButton('Cancel', () => closeDialog());
  dialogButton('Replace draft positions', () => {
    if (!confirmPasteWithFeedback(state, dialogError)) return;
    dialogCancel = null;
    closeDialog(false); edited({ rebuild: true, groupId: group.id });
    queueViews.get(group.id)?.actions.paste.node.focus();
    announceEditorStatus(`Pasted into ${destination}.`);
  });
}
function openCustomVariant(index, groupId = state?.selectedId) {
  if (editingLocked()) return;
  const group = state?.groups.find(group => group.id === groupId);
  if (!group || !group.models[index]) return;
  openDialog('Custom variant', 'Enter a variant supported by this model. An empty value inherits the queue default.');
  let value = group.models[index].variant;
  const field = mountTextField(ui.dialogBody, { label: 'Variant', value, mono: true, onChange: next => { value = next; } });
  dialogCleanup.push(field);
  dialogButton('Cancel', () => closeDialog());
  dialogButton('Use variant', () => {
    const models = clone(group.models); models[index].variant = value;
    replaceModels(state, group.id, models);
    closeDialog(false); edited({ rebuild: true, groupId: group.id, focus: { index, action: 'variant' } });
  });
  ui.dialogBody.querySelector('input').focus();
}
async function prepareReview() {
  if (!state || operation || state.unknown || state.conflict) return;
  const saved = snapshot(state);
  if (!hasPendingEdits(state) || !validateChanges(state)) return;
  const task = operations.begin('preview');
  try {
    const result = await api('/preview', previewBody(saved));
    if (!acceptPreview(state, saved, result)) { message('The draft changed while preparing the review. Review the current edits again.', 'warning'); return; }
    const count = result.changed.length;
    const context = openDialog('Review all changes', `${count} ${count === 1 ? 'change' : 'changes'} · ${result.target.path}`, { documentMode: true });
    // The preview request temporarily disables the button and can clear native focus.
    dialogFocus.origin = ui.review.node;
    dialogCancel = () => { state.preview = null; };
    const inheritance = primaryReviewNotice(saved);
    if (inheritance) context.append(el('p', 'document-note', inheritance));
    const diff = el('pre', 'diff'); diff.dir = 'ltr'; diff.tabIndex = 0; diff.setAttribute('aria-label', 'Configuration changes');
    for (const line of (result.diff || 'No changes to save.').split('\n')) {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'added'
        : line.startsWith('-') && !line.startsWith('---') ? 'removed' : '';
      diff.append(el('span', `diff-line ${kind}`, line || ' '));
    }
    ui.dialogBody.append(diff);
    dialogButton('Back to editing', () => closeDialog());
    dialogButton('Confirm and save', commit, { variant: 'default', disabled: !result.previewToken });
  } catch (error) { message(error.message, 'error'); }
  finally { operations.finish(task); }
}
async function commit() {
  if (operation || !state) return;
  const body = beginCommit(state);
  if (!body) { dialogError('This review is no longer valid. Close it and review the current changes again.'); return; }
  const submitted = clone(state.pendingCommit);
  const task = operations.begin('commit');
  ui.dialogActions.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const result = await api('/commit', body);
    if (!validCommitAcknowledgment(submitted, result)) throw new Error('The save acknowledgment could not be verified.');
    acknowledgeSave(state, submitted, result);
    operations.finish(task); closeDialog();
    message(`Saved ${result.changed.length} changes. Reload OMOS to use them. Backup ${result.backup}`, 'success');
    updateNavMarks();
    if (submitted.saved.marketplace || submitted.saved.primaryCreations?.length) void refreshSavedQueues();
    if (submitted.saved.marketplace) void marketplace.refresh();
    await flushDraft();
  } catch (error) {
    markUnknown(state);
    operations.finish(task); closeDialog();
    message(`Save outcome unknown. ${error.message} Check the file before another save. The write will not be retried automatically.`, 'warning');
  } finally { operations.finish(task); updateStatus(); }
}
async function checkOutcome() {
  if (!state?.unknown || operation) return;
  const task = operations.begin('reconcile');
  try {
    const unknown = state.unknown;
    const config = await api('/reconcile', { previewToken: unknown.result.previewToken, generation: unknown.saved.generation });
    const kind = reconcile(state, config);
    if (kind === 'saved') {
      message('The file matches the reviewed changes. Reload OMOS to use them. Later local edits remain in the draft.', 'success');
      if (unknown.saved.marketplace || unknown.saved.primaryCreations?.length) renderPresentation();
      if (unknown.saved.marketplace) void marketplace.refresh();
      await flushDraft();
    } else if (kind === 'baseline') message('The file matches the earlier baseline. A previous write may still have occurred. Review the draft again before any new save.', 'warning');
    else if (kind === 'conflict') message('The file differs from both the baseline and reviewed changes. Your draft is retained. Inspect it, then discard and reload to use the current file.', 'error');
    else message('The selected target changed. The save outcome is still unknown. Inspect Settings to explicitly abandon this check and switch targets. The earlier save may have completed.', 'warning');
    updateNavMarks();
  } catch (error) { message(`Save outcome is still unknown. ${error.message} Settings can explicitly abandon this check and switch targets. The earlier save may have completed.`, 'warning'); }
  finally { operations.finish(task); }
}
function requestReload() {
  const action = reloadDisposition(state, operation);
  if (action === 'busy' || action === 'unknown') return;
  if (action === 'confirm') {
    confirmAction('Discard drafts and reload?', 'All unsaved queue edits and marketplace stages on this page will be discarded. The current file will be loaded again.', 'Discard and reload', async () => {
      const discarded = snapshot(state);
      let afterDiscard;
      const applied = await discardEdits({ drafts: draftController, operations,
        stillCurrent: () => canDiscardSnapshot(state, discarded),
        apply() {
           for (const group of [...state.groups]) {
             if (isPendingPrimaryQueue(group)) discardPrimaryCreation(state, group.id);
             else if (isDirty(group) && !isPendingMarketplaceQueue(group)) replaceModels(state, group.id, group.original);
           }
           if (state.marketplace) discardMarketplaceStages(state);
           closePicker(false); renderPresentation(); updateStatus();
          afterDiscard = snapshot(state);
        },
        afterIsCurrent: () => canDiscardSnapshot(state, afterDiscard),
        after: load,
      });
      if (!applied) message('The draft changed while preparing to reload. Newer edits were kept.', 'warning');
    });
  } else void load();
}
function openDrafts({ focusDraft, scrollTop = 0 } = {}) {
  openDialog('Stored drafts', 'Stored on this server, separate from the OMOS file.');
  let focusInspect;
  if (!drafts.length) ui.dialogBody.append(el('p', 'muted', 'No stored drafts.'));
  for (const draft of drafts) {
    const inspection = inspectableDraft(draft);
    const status = inspection.readOnly ? inspection.status : state ? recoveryStatus(state, draft) : 'unavailable';
    const count = inspection.changes?.length || 0;
    const details = inspection.readOnly ? ''
      : [`${count} queue ${count === 1 ? 'edit' : 'edits'}`, inspection.primaryCreations?.length ? `${inspection.primaryCreations.length} primary overrides` : '',
        inspection.marketplace?.edits.length ? `${inspection.marketplace.edits.length} marketplace presets` : ''].filter(Boolean).join(' · ');
    const statusText = inspection.readOnly ? inspection.readOnlyReason : inspection.status === 'invalid-edits' ? 'Invalid details withheld'
      : status === 'available' ? 'Matches current file' : status === 'different-target' ? 'Different target'
        : status === 'stale' ? 'Stale · does not match the current file' : 'Cannot recover on this baseline';
    const row = el('section', 'recovery-row');
    const timestamp = inspection.updatedAt !== undefined ? new Date(inspection.updatedAt).toLocaleString() : '';
    row.append(el('p', 'recovery-path', inspection.targetPath || 'Target details unavailable'), el('p', 'muted', [details, timestamp, statusText].filter(Boolean).join(' · ')));
    const actions = slot(row, 'inline-actions');
    const inspect = button(actions, 'Inspect', () => {
      const returnScroll = ui.dialog.scrollTop;
      openDialog('Stored draft details', statusText, { documentMode: true });
      const code = el('pre', 'diff', JSON.stringify(inspection, null, 2));
      code.dir = 'ltr'; code.tabIndex = 0; code.setAttribute('aria-label', 'Stored draft data'); ui.dialogBody.append(code);
      dialogBack = () => openDrafts({ focusDraft: draft, scrollTop: returnScroll });
      dialogButton('Back to drafts', dialogBack);
    }, {}, dialogCleanup);
    if (focusDraft === draft) focusInspect = inspect.node;
    button(actions, 'Recover a copy', () => {
      if (inspection.readOnly || inspection.status !== 'normalized-edits' || !state || !recoverDraft(state, draft)) return;
      closeDialog(); renderPresentation(); edited();
      announceEditorStatus('Draft copy recovered. The saved file is unchanged.');
    }, { disabled: inspection.readOnly || inspection.status !== 'normalized-edits' || status !== 'available'
      || Boolean(state && hasPendingEdits(state)) || Boolean(state?.unknown || state?.conflict) }, dialogCleanup);
     const versionSupportsMarketplace = inspection.version === 2 || inspection.version === 3;
     const canRecheck = !inspection.readOnly && inspection.status === 'normalized-edits' && versionSupportsMarketplace && validMarketplaceRecord(draft.marketplace);
     if (versionSupportsMarketplace && inspection.marketplace) button(actions, 'Recheck packages', async () => {
      if (!canRecheck || !state || state.unknown) return;
      await marketplace.refresh();
      try { const checked = recheckMarketplaceDraft(state, draft); drafts = drafts.map(item => item === draft ? checked : item); openDrafts(); }
      catch (error) { dialogError(error); }
    }, { disabled: !canRecheck || !state || Boolean(state.unknown) }, dialogCleanup);
    button(actions, 'Delete', () => {
      if (inspection.readOnly || !inspection.id) return;
      confirmAction('Delete stored draft?', 'This removes this stored draft only. Current page edits and the OMOS file stay unchanged.', 'Delete draft', async () => {
        const task = operations.begin('draft-delete');
        try { await api(`/drafts/${encodeURIComponent(inspection.id)}`, undefined, 'DELETE'); drafts = drafts.filter(item => item?.id !== inspection.id); operations.finish(task); openDrafts(); }
        catch (error) { message(error.message, 'error'); }
        finally { operations.finish(task); }
      }, { reopensDialog: true });
    }, { variant: 'ghost', disabled: inspection.readOnly || !inspection.id }, dialogCleanup);
    ui.dialogBody.append(row);
  }
  dialogButton('Close', () => closeDialog());
  if (focusInspect) {
    ui.dialog.scrollTop = scrollTop;
    focusInspect.focus({ preventScroll: true });
  }
}
async function openSettings({ favoritesOpen = false, marketplaceOpen = false } = {}) {
  if (operation && operation !== 'load') return;
  openDialog('Server settings', 'Paths refer to the machine running OpenChamber. Changes select the global OMOS file and the context used by the model catalog.');
  const requestedDialog = dialogEpoch;
  dialogButton('Cancel', () => closeDialog());
  const form = slot(ui.dialogBody, 'settings-fields');
  const loading = el('p', 'muted', 'Reading server settings');
  loading.setAttribute('role', 'status'); form.append(loading);
  const favoriteDetails = el('details', 'ui-help settings-favorites'); favoriteDetails.open = favoritesOpen;
  favoriteDetails.append(el('summary', '', 'Favorites and profile import'), el('p', '', 'Stars only affect this extension.'));
  const favoriteRoot = slot(favoriteDetails, 'favorites-panel'); ui.dialogBody.append(favoriteDetails);
  const favoritePanel = mountFavoritesPanel(favoriteRoot, { favorites, source: favoriteSource, getCatalog: () => catalog, onImport: reviewFavoriteImport });
  favoritesPanel = favoritePanel;
  dialogCleanup.push({ dispose() { favoritePanel.dispose(); if (favoritesPanel === favoritePanel) favoritesPanel = null; } });
  const marketDetails = el('details', 'ui-help settings-marketplace'); marketDetails.open = marketplaceOpen;
  marketDetails.append(el('summary', '', 'Marketplace source'));
  const marketRoot = slot(marketDetails); ui.dialogBody.append(marketDetails);
  const marketSource = mountMarketplaceSource(marketRoot, { source: marketplace }); marketplaceSourcePanel = marketSource;
  let marketReadStarted = marketplaceOpen;
  const refreshMarketDetails = () => {
    if (marketDetails.open && !marketReadStarted) { marketReadStarted = true; void marketplace.refresh(); }
    if (!marketDetails.open) marketReadStarted = false;
  };
  marketDetails.addEventListener('toggle', refreshMarketDetails);
  dialogCleanup.push({ dispose() { marketDetails.removeEventListener('toggle', refreshMarketDetails); marketSource.dispose(); if (marketplaceSourcePanel === marketSource) marketplaceSourcePanel = null; } });
  if (marketplaceOpen) {
    void marketplace.refresh();
    (marketDetails.querySelector('input:not(:disabled)') || marketDetails.querySelector('summary'))?.focus();
  }
  if (favoritesOpen) (favoriteDetails.querySelector('input:not(:disabled)') || favoriteDetails.querySelector('summary'))?.focus();
  try {
    const result = await api('/settings');
    if (!ui.dialog.open || dialogEpoch !== requestedDialog) return;
    settings = result.settings;
  } catch (error) {
    if (!ui.dialog.open || dialogEpoch !== requestedDialog) return;
    dialogError(`Settings could not be read. ${error.message} Check every field before saving a replacement.`);
  }
  if (!ui.dialog.open || dialogEpoch !== requestedDialog) return;
  loading.remove();
  const values = { configFile: '', opencodeBin: 'opencode', modelCwd: '', opencodeConfigDir: '', ...settings };
  const fields = [];
  for (const [key, label, helper] of [
    ['configFile', 'OMOS configuration file', 'Absolute server path to the global JSONC or JSON file.'],
    ['opencodeBin', 'OpenCode executable', 'Executable name or absolute server path.'],
    ['modelCwd', 'Model working directory', 'Absolute server directory used for model enumeration.'],
    ['opencodeConfigDir', 'OpenCode configuration directory', 'Optional absolute server path. Empty uses the standard OpenCode context.'],
  ]) {
    const field = mountTextField(form, { label, helper, value: values[key], mono: true, onChange: value => { values[key] = value; } });
    fields.push(field);
    dialogCleanup.push(field);
  }
  const hasDraft = Boolean(state && hasPendingEdits(state));
  const unknown = Boolean(state?.unknown);
  if (unknown) {
    const warning = el('p', 'status-box', 'The earlier save may have completed. Saving these settings explicitly abandons this save check and revokes old previews by changing the settings generation. Any stored recovery draft is kept. The earlier file may need inspection.');
    warning.dataset.tone = 'warning'; form.append(warning);
  }
  let discard = !hasDraft && !unknown;
  if (hasDraft || unknown) {
    if (!unknown) {
      const warning = el('p', 'status-box', 'Changing settings invalidates the current review and discards this page\'s unsaved stages.'); warning.dataset.tone = 'warning'; form.append(warning);
    }
    const check = mountCheckbox(form, { label: unknown
      ? 'Abandon this save check and switch target. The earlier save may have completed.'
       : 'Discard this page\'s unsaved stages when settings are saved', checked: false,
      onChange: checked => { discard = checked; check.update({ checked }); save.handle.update({ disabled: !checked }); } });
    fields.push(check);
    dialogCleanup.push(check);
  }
  const save = dialogButton(unknown ? 'Abandon check and save settings' : 'Save settings', async () => {
    if (!discard || (operation && operation !== 'load')) return;
    const submittedSettings = clone(values);
    const editor = state;
    const saved = state ? snapshot(state) : null;
    const oldId = draftId;
    save.handle.update({ loading: true });
    fields.forEach(field => field.update({ disabled: true }));
    try {
      await changeSettings({ drafts: draftController, operations, requests, values: submittedSettings, preserveDraft: unknown, expectedGeneration: saved?.generation,
        invalidateCatalog() { clearTimeout(catalogTimer); if (state) state.preview = null; },
        stillCurrent: () => state === editor && (!state || (state.revision === saved.revision
          && state.baseHash === saved.baseHash && state.target.generation === saved.generation && !state.pendingCommit)),
        post: next => api('/settings', next),
        async apply(result, { preserved }) {
          settings = result.settings;
          if (!unknown) await draftController.remove(oldId);
          closePicker(false);
          state = null; draftId = createDraftId();
          ui.layout.hidden = true;
          message(unknown
            ? `Server settings changed and old previews were revoked. The earlier save may have completed. ${preserved ? 'Any recovery draft is retained for inspection.' : 'The latest draft could not be stored. Earlier stored drafts are retained.'} Inspect the earlier file before relying on its contents.`
            : 'Server settings saved.', unknown ? 'warning' : 'success');
          catalog = { state: 'loading', flat: [], stale: false, error: null }; renderCatalog();
          // Start the replacement load before restoring page focus, so the
          // Settings trigger is enabled again when the native dialog closes.
          const loading = load();
          closeDialog(true, true);
          await loading;
        },
      });
    } catch (error) {
      if (ui.dialog.open && dialogEpoch === requestedDialog) dialogError(error);
      if (!state) {
        ui.loadState.hidden = false;
        ui.loadText.textContent = 'The selected file has not loaded. Try reloading it or check Settings.';
        ui.retry.slot.hidden = false;
        updateTarget();
      }
    }
    finally {
      if (ui.dialog.open && dialogEpoch === requestedDialog) {
        save.handle.update({ loading: false });
        fields.forEach(field => field.update({ disabled: false }));
      }
      updateStatus();
    }
  }, { variant: 'default', disabled: !discard });
  if (!ui.dialogBody.contains(document.activeElement)) (favoritesOpen ? favoriteDetails.querySelector('input:not(:disabled)') : form.querySelector('input'))?.focus();
}
function mount() {
  const app = document.getElementById('app');
  app.replaceChildren();
  const header = el('header', 'page-header');
  const identity = slot(header, 'target-summary');
  ui.target = button(identity, 'Loading file', openTargetDetails, { variant: 'ghost' });
  ui.target.slot.classList.add('target-disclosure');
  ui.target.node.classList.add('target-trigger');
  ui.target.node.setAttribute('aria-haspopup', 'dialog');
  const targetName = ui.target.node.querySelector('span');
  targetName.classList.add('target-name'); targetName.dir = 'ltr';
  ui.scope = el('span', 'scope-label', 'Global OMOS file');
  const disclosure = el('span', 'target-disclosure-mark', '⌄'); disclosure.setAttribute('aria-hidden', 'true');
  ui.target.node.prepend(ui.scope); ui.target.node.append(disclosure);
  const headerActions = slot(header, 'header-actions');
  ui.recovery = button(headerActions, 'Drafts', openDrafts, { variant: 'ghost' }); ui.recovery.slot.hidden = true;
  ui.reload = button(headerActions, 'Reload', requestReload, { variant: 'ghost' });
  ui.reload.node.setAttribute('aria-label', 'Reload file');
  ui.settings = button(headerActions, 'Settings', openSettings, { variant: 'ghost' });
  ui.notice = el('div', 'status-box page-notice'); ui.notice.hidden = true; ui.notice.setAttribute('role', 'status');
  ui.loadState = el('section', 'load-state');
  ui.loadText = el('p', '', 'Loading global queues'); ui.loadText.setAttribute('role', 'status');
  ui.loadState.append(ui.loadText);
  ui.retry = button(ui.loadState, 'Try again', requestReload); ui.retry.slot.hidden = true;
  ui.layout = el('div', 'editor-layout'); ui.layout.hidden = true;
  const sidebar = el('aside', 'queue-sidebar'); sidebar.setAttribute('aria-label', 'Queues');
  const navSearch = slot(sidebar, 'queue-search');
  ui.queueSearch = mountSearchField(navSearch, { label: 'Filter queue outline', placeholder: 'Filter outline', value: '', onChange: value => {
    ui.queueSearch.update({ value });
    if (state) { setFilter(state, value); renderNav(); }
  } });
  ui.nav = el('nav', 'queue-nav'); ui.nav.setAttribute('aria-label', 'Model queues'); sidebar.append(ui.nav);
  const workspace = el('main', 'workspace');
  const phone = slot(workspace, 'phone-selector');
  ui.phoneSelect = mountSelect(phone, { label: 'Jump to queue', ...phoneJumpProps([], null), onChange: navigate });
  const phoneJumpValue = phone.querySelector('.oc-sdk-trigger-value');
  phoneJumpValue.id = 'omos-phone-jump-current';
  phone.querySelector('.oc-sdk-trigger').setAttribute('aria-describedby', phoneJumpValue.id);
  ui.queues = el('div', 'queue-workspaces');
  ui.marketplaceRoot = el('section', 'marketplace-workspace'); ui.marketplaceRoot.id = INSTALLED_AGENTS_ID; ui.marketplaceRoot.tabIndex = -1;
  ui.marketplaceRoot.setAttribute('aria-label', 'Installed marketplace agents');
  ui.marketplaceRoot.addEventListener('focusin', () => { if (!editingLocked()) activateQueue(INSTALLED_AGENTS_ID); });
  marketplacePanel = mountMarketplacePanel(ui.marketplaceRoot, { source: marketplace, getEditor: () => state,
    isLocked: () => editingLocked() || Boolean(operation), onEdited: marketplaceEdited, onOverride: openMarketplacePicker,
    onJump: navigate, onDiscardQueue: discardQueue, onDiscardStages: requestDiscardMarketplace,
    onSettings: () => { void openSettings({ marketplaceOpen: true }); } });
  ui.rowStatus = el('span', 'sr-only'); ui.rowStatus.id = 'omos-editor-status'; ui.rowStatus.setAttribute('role', 'status');
  ui.picker = el('dialog', 'oc-sdk model-picker'); ui.picker.id = 'omos-model-picker'; ui.picker.hidden = true;
  ui.picker.setAttribute('aria-labelledby', 'omos-model-picker-title');
  ui.picker.setAttribute('aria-describedby', 'omos-model-picker-context');
  ui.picker.addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
  const shell = slot(ui.picker, 'picker-shell');
  const pickerHeader = el('header', 'picker-header');
  const pickerHeading = slot(pickerHeader, 'picker-heading');
  const pickerTitle = el('h2', 'dialog-title', 'Choose model'); pickerTitle.id = 'omos-model-picker-title';
  ui.pickerContext = el('p', 'muted picker-context'); ui.pickerContext.id = 'omos-model-picker-context';
  pickerHeading.append(pickerTitle, ui.pickerContext);
  button(pickerHeader, 'Cancel', () => closePicker(), { variant: 'outline' });
  shell.append(pickerHeader);
  const search = slot(shell, 'model-search');
  ui.modelSearch = mountSearchField(search, { label: 'Search or enter model ID', placeholder: 'Search or enter provider/model', value: '', onChange: value => {
    if (!picker) return;
    picker.query = value; ui.modelSearch.update({ value });
    ui.pickerError.hidden = true;
    renderPicker();
  } });
  ui.modelInput = search.querySelector('input');
  ui.modelInput.setAttribute('autofocus', ''); ui.modelInput.setAttribute('autocapitalize', 'none');
  const modelMeta = slot(shell, 'model-result-summary'); ui.modelResult = el('span', 'muted'); modelMeta.append(ui.modelResult);
  ui.modelResult.setAttribute('role', 'status');
  const pickerActions = slot(modelMeta, 'inline-actions picker-actions');
  button(pickerActions, 'Profile import', openFavorites, { variant: 'ghost' }).node.setAttribute('aria-label', 'Favorite settings and profile import');
  ui.useId = button(pickerActions, 'Use entered model ID', () => pickModel(picker?.query.trim()), { variant: 'outline' }); ui.useId.slot.hidden = true;
  ui.useId.slot.classList.add('picker-use-id');
  ui.pickerError = el('p', 'status-box picker-error'); ui.pickerError.dataset.tone = 'error';
  ui.pickerError.setAttribute('role', 'alert'); ui.pickerError.hidden = true;
  ui.pickerCatalog = el('p', 'muted picker-catalog'); ui.pickerCatalog.hidden = true;
  ui.favoriteStatus = el('p', 'favorites-status picker-favorites-status'); ui.favoriteStatus.setAttribute('role', 'status');
  shell.append(ui.pickerError, ui.pickerCatalog, ui.favoriteStatus);
  ui.modelResults = slot(shell, 'model-results');
  const modelGrid = slot(ui.modelResults, 'favorite-model-grid'); ui.modelGrid = modelGrid;
  const modelListSlot = slot(modelGrid, 'model-options'); ui.modelOptions = modelListSlot;
  ui.modelList = mountList(modelListSlot, { items: [], onSelect: pickModel, ariaLabel: 'Model search results', emptyText: '' });
  ui.favoriteStars = slot(modelGrid, 'favorite-stars'); ui.favoriteStars.setAttribute('role', 'group'); ui.favoriteStars.setAttribute('aria-label', 'Extension favorite controls for model search results');
  const starHelp = el('p', 'sr-only', 'Use Up and Down to move between favorite buttons. Press Space to toggle a favorite.');
  starHelp.id = 'omos-picker-star-help'; shell.append(starHelp);
  ui.favoriteStars.setAttribute('aria-describedby', starHelp.id);
  modelListSlot.addEventListener('keydown', event => {
    if (!picker || !navigationKey(event)) return;
    const active = modelListSlot.querySelector('[data-active="true"]');
    if (active) setPickerStar(active.title);
  });
  ui.favoriteStars.addEventListener('focusin', event => {
    if (event.target.dataset.favoriteId) setPickerStar(event.target.dataset.favoriteId);
  });
  ui.favoriteStars.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !event.target.dataset.favoriteId) return;
    const controls = pickerStars();
    const current = controls.indexOf(event.target);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : Math.max(0, Math.min(controls.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
    if (!controls[index]) return;
    event.preventDefault();
    controls[index].focus();
  });
  ui.picker.addEventListener('keydown', event => {
    if (!picker) return;
    // Capture Escape before the search primitive can consume it to clear text.
    // Native modality keeps focus in the iframe dialog; wrap its own Tab cycle too.
    if (event.key === 'Tab' && pickerTabWrap(event, document.activeElement,
      [...ui.picker.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]')]
        .filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length))) return;
    const handled = handlePickerKey(event, {
      fromSearch: event.target === ui.modelInput, query: picker.query,
      ids: picker.ids, pick: pickModel, close: closePicker,
      navigate(keyEvent) {
        if (!navigationKey(keyEvent)) return false;
        keyEvent.preventDefault();
        const list = modelListSlot.querySelector('[role="listbox"]');
        list.focus();
        list.dispatchEvent(new KeyboardEvent('keydown', { key: keyEvent.key, ctrlKey: keyEvent.ctrlKey, bubbles: true }));
        return true;
      },
    });
    if (handled && event.key === 'Escape') event.stopPropagation();
  }, { capture: true });
  window.addEventListener('resize', scheduleFullViewport);
  window.visualViewport?.addEventListener('resize', scheduleFullViewport);
  window.visualViewport?.addEventListener('scroll', scheduleFullViewport);
  const catalogRow = el('div', 'catalog-row');
  ui.catalogText = el('span', 'muted', 'Loading model catalog'); ui.catalogText.setAttribute('role', 'status');
  catalogRow.append(ui.catalogText);
  ui.refresh = button(catalogRow, 'Refresh models', () => { void loadCatalog(true); }, { variant: 'ghost' });
  ui.catalogError = el('p', 'catalog-error'); ui.catalogError.setAttribute('role', 'alert'); ui.catalogError.hidden = true;
  ui.favoritesNotice = el('p', 'favorites-status'); ui.favoritesNotice.dataset.error = 'true'; ui.favoritesNotice.hidden = true;
  ui.favoritesNotice.setAttribute('role', 'status');
  ui.emptyState = el('p', 'muted empty-state'); ui.emptyState.setAttribute('role', 'status'); ui.emptyState.hidden = true;
  workspace.append(catalogRow, ui.catalogError, ui.favoritesNotice, ui.emptyState, ui.queues, ui.rowStatus);
  ui.layout.append(sidebar, workspace);
  ui.footer = el('footer', 'save-bar'); ui.footer.hidden = true;
  const saveText = slot(ui.footer, 'save-summary');
  ui.dirtyCount = el('strong', 'dirty-count'); ui.saveDetail = el('span', 'muted save-detail'); ui.draftStatus = el('span', 'muted draft-status');
  ui.saveDetail.hidden = true; ui.draftStatus.hidden = true;
  saveText.append(ui.dirtyCount, ui.saveDetail, ui.draftStatus);
  const saveActions = slot(ui.footer, 'save-actions');
  ui.check = button(saveActions, 'Check file outcome', checkOutcome); ui.check.slot.hidden = true;
  ui.review = button(saveActions, 'Review changes', prepareReview, { variant: 'default', disabled: true });
  ui.dialog = el('dialog', 'editor-dialog');
  ui.dialog.dataset.dialogMode = 'normal';
  const dialogHeader = el('header', 'dialog-header');
  ui.dialogTitle = el('h2', 'dialog-title'); ui.dialogTitle.id = 'dialog-title';
  dialogHeader.append(ui.dialogTitle);
  ui.dialog.setAttribute('aria-labelledby', 'dialog-title');
  ui.dialogBody = el('div', 'dialog-body');
  ui.dialogError = el('p', 'status-box'); ui.dialogError.dataset.tone = 'error'; ui.dialogError.setAttribute('role', 'alert'); ui.dialogError.hidden = true;
  ui.dialogActions = el('footer', 'dialog-actions');
  ui.dialog.append(dialogHeader, ui.dialogBody, ui.dialogError, ui.dialogActions);
  ui.dialog.addEventListener('cancel', event => { event.preventDefault(); if (dialogBack) dialogBack(); else closeDialog(); });
  ui.favoriteImportDialog = el('dialog', 'editor-dialog favorite-import-dialog');
  ui.favoriteImportDialog.addEventListener('cancel', event => { event.preventDefault(); closeFavoriteImport(); });
  app.append(header, ui.notice, ui.loadState, ui.layout, ui.footer, ui.picker, ui.dialog, ui.favoriteImportDialog);
  if (typeof ResizeObserver === 'function') {
    const sizes = new ResizeObserver(() => {
      app.style.setProperty('--page-header-height', `${header.getBoundingClientRect().height}px`);
      app.style.setProperty('--phone-selector-height', `${phone.getBoundingClientRect().height}px`);
      document.documentElement.style.setProperty('--save-bar-height', `${ui.footer.getBoundingClientRect().height}px`);
      scheduleFullViewport();
    });
    for (const node of [header, phone, ui.footer]) sizes.observe(node);
  }
  renderFavoriteState();
  void favorites.load();
  void favoriteSource.refresh();
  void load();
}

host.onReady(createReadyReceiver(ready => {
  applyHostReady(ready, document.documentElement);
  hostKeyboard = Number.isFinite(ready.device?.keyboard) ? ready.device.keyboard : 0;
  scheduleFullViewport();
}, mount));
window.addEventListener('pagehide', () => {
  clearCopyFeedback();
  clearEditorAnnouncement();
  if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
  viewportFrame = null;
  if (editingLocked()) void draftController.drain();
  else void flushDraft();
});
