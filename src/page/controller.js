import {
  clone, editLimit, isDirty, validModels, validModelId, replaceModels, makeDraft, validateChanges,
  confirmPaste,
  selectQueue, hasPendingEdits,
  draftHasOperations, validateDraftChanges, isPendingMarketplaceQueue,
} from './editor-state.js';

// Used by every target-scoped read, including its failure and completion paths.
export function createRequestFence() {
  let version = 0;
  const current = token => token === version;
  return {
    begin: () => ++version,
    invalidate: () => ++version,
    current,
    token: () => version,
    async run(token, request, { success, failure, finished } = {}) {
      try {
        const result = await request();
        if (current(token)) await success?.(result);
      } catch (error) {
        if (current(token)) await failure?.(error);
      } finally {
        if (current(token)) await finished?.();
      }
    },
  };
}

export function createOperations(onChange = () => {}) {
  let active = null;
  return {
    begin(name) { active = { name }; onChange(name); return active; },
    owns(token) { return token === active; },
    finish(token) {
      if (token !== active) return false;
      active = null; onChange(''); return true;
    },
    get name() { return active?.name || ''; },
  };
}

function storableDraft(draft) {
  const entries = [...draft.changes, ...draft.originals, ...(draft.marketplace?.edits.flatMap(edit => edit.creations) || []),
    ...(draft.primaryCreations || [])];
  return draft.changes.length <= 1000 && entries.every(entry => validModels(entry.models)
    && entry.models.every(model => model.variant.length <= 500 && !/[\r\n\0]/.test(model.variant)))
    && new TextEncoder().encode(JSON.stringify(draft)).length <= 64 * 1024;
}

// One serial queue per frame. A discard drains prior writes; it never creates a
// new write just to delete it. Invalid state cannot replace the last valid draft.
export function createDraftController({ request, getState, getId, onStatus = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, delay = 650 }) {
  let chain = Promise.resolve(true);
  let timer;
  const stored = new Set();
  const cancel = () => { clearTimer(timer); timer = undefined; };
  const enqueue = action => { chain = chain.catch(() => false).then(action); return chain; };
  const current = (editor, revision, id) => getState() === editor && editor.revision === revision && getId() === id;
  async function remove(id = getId()) {
    return enqueue(async () => {
      if (!stored.has(id)) return true;
      try {
        await request(`/drafts/${encodeURIComponent(id)}`, undefined, 'DELETE');
        stored.delete(id);
        return true;
      } catch (error) {
        if (id === getId()) onStatus(`Stored draft could not be removed. ${error.message}`, true);
        return false;
      }
    });
  }
  function persist({ keepStoredWhenClean = false } = {}) {
    cancel();
    const editor = getState();
    if (!editor) return chain;
    const revision = editor.revision;
    const id = getId();
    const draft = makeDraft(editor, id);
    if (!validateDraftChanges(editor) || !storableDraft(draft)) {
      onStatus('This draft cannot be stored yet. The earlier stored draft is unchanged. Complete valid model IDs and supported draft values before closing this page.', true);
      return Promise.resolve(false);
    }
    if (!draftHasOperations(draft)) {
      if (keepStoredWhenClean) return chain;
      return remove(id).then(ok => {
        if (ok && current(editor, revision, id)) onStatus('No pending draft');
        return ok;
      });
    }
    return enqueue(async () => {
      try {
        await request('/drafts', draft);
        stored.add(id);
        if (current(editor, revision, id)) onStatus('Draft stored on server');
        return true;
      } catch (error) {
        if (current(editor, revision, id)) onStatus(`Draft could not be stored. ${error.message} Keep this page open or save explicitly.`, true);
        return false;
      }
    });
  }
  return {
    persist, remove, cancel,
    hasStored: id => stored.has(id),
    schedule() { cancel(); onStatus('Draft waiting to be stored'); timer = setTimer(() => { void persist(); }, delay); },
    async drain() { cancel(); await chain; },
  };
}

export async function discardEdits({ drafts, operations, stillCurrent, apply, afterIsCurrent = () => true, after }) {
  const task = operations.begin('discard');
  try {
    await drafts.drain();
    if (!stillCurrent()) { drafts.schedule(); return false; }
    apply();
    await drafts.persist();
    if (!afterIsCurrent()) { drafts.schedule(); return false; }
    await after?.();
    return true;
  } finally { operations.finish(task); }
}

export async function changeSettings({ drafts, operations, requests, invalidateCatalog, values,
  preserveDraft = false, expectedGeneration, stillCurrent = () => true, post, apply }) {
  const task = operations.begin('settings');
  requests.invalidate();
  invalidateCatalog();
  try {
    await drafts.drain();
    if (!stillCurrent()) throw new Error('The draft changed while preparing settings. Newer edits were kept. Review the settings change again.');
    // Unknown writes keep their recovery record. A failed best-effort store must
    // not trap the user on a missing file or an obsolete settings generation.
    const preserved = preserveDraft ? await drafts.persist({ keepStoredWhenClean: true }) : true;
    if (!stillCurrent()) throw new Error('The draft changed while preparing settings. Newer edits were kept. Review the settings change again.');
    const result = await post(clone(values));
    if (!result?.settings || !['configFile', 'opencodeBin', 'modelCwd', 'opencodeConfigDir']
      .every(key => typeof result.settings[key] === 'string') || typeof result.generation !== 'string'
      || !result.generation || result.generation === expectedGeneration) {
      throw new Error('The settings generation change could not be verified. The earlier save outcome remains unknown if a check was pending. Inspect Settings and confirm the switch again.');
    }
    await apply(result, { preserved });
    return result;
  } finally { operations.finish(task); }
}

export function beginModelPick(editor, groupId, index, adding = false) {
  const group = editor?.groups.find(group => group.id === groupId);
  if (!group || editLimit(group) || !Number.isInteger(index)
    || (adding ? index !== group.models.length || index >= 50 : index < 0 || index >= group.models.length)) return null;
  return { groupId, index, adding, revision: editor.revision, generation: editor.target.generation };
}
export function applyModelPick(editor, pending, id) {
  const group = editor?.groups.find(group => group.id === pending?.groupId);
  if (!pending || !group || !validModelId(id) || editLimit(group)
    || pending.revision !== editor.revision || pending.generation !== editor.target.generation
    || (pending.adding ? pending.index !== group.models.length || group.models.length >= 50
      : pending.index < 0 || pending.index >= group.models.length)) return false;
  const models = clone(group.models);
  if (pending.adding) models.push({ id, variant: '' });
  else models[pending.index].id = id;
  replaceModels(editor, group.id, models);
  return true;
}

export function handlePickerKey(event, { fromSearch, query, ids, navigate, pick, close }) {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.key === 'Escape') { event.preventDefault(); close(); return true; }
  if (!fromSearch) return false;
  if (event.key === 'Enter') {
    const typed = query.trim();
    const id = ids.find(id => id === typed) || ids[0] || (validModelId(typed) ? typed : null);
    if (id) { event.preventDefault(); pick(id); return true; }
    return false;
  }
  // The SDK owns the actual arrow/Ctrl+N/P mapping and active list selection.
  return navigate(event);
}

export function queueActions(editor, group, operation) {
  if (!editor || !group) return [];
  const busy = Boolean(operation);
  const pendingCreation = isPendingMarketplaceQueue(group) || (group.primaryCreation && !group.primaryCreation.saved);
  return [
    { id: 'copy', label: 'Copy queue', disabled: busy || !validModels(group.models) },
    { id: 'paste', label: 'Paste copied queue', disabled: busy || Boolean(editLimit(group)) || !editor.clipboard || editor.clipboard.source === group.id },
    { id: 'reset', label: pendingCreation ? 'Reset staged queue' : 'Reset queue edits', disabled: busy || !isDirty(group) || Boolean(editor.unknown || editor.pendingCommit) },
  ];
}

export function reloadDisposition(editor, operation) {
  if (operation) return 'busy';
  if (editor?.unknown || editor?.pendingCommit) return 'unknown';
  return editor && hasPendingEdits(editor) ? 'confirm' : 'load';
}

export function confirmPasteWithFeedback(editor, report) {
  if (editor && confirmPaste(editor)) return true;
  report('The destination draft changed while this confirmation was open. Nothing was pasted. Cancel and paste again to review the current destination.');
  return false;
}

export function createDialogFocus(getActive, focus) {
  let origin = null;
  return {
    capture(nested) { if (!nested) origin = getActive(); },
    get origin() { return origin; },
    set origin(value) { origin = value; },
    restore() { if (origin) focus(origin); origin = null; },
  };
}

export function completeDialogAction(focus, { origin, closedEpoch, currentEpoch, isOpen, reopensDialog }) {
  if (reopensDialog && isOpen) focus.origin = origin;
  else if (!isOpen && currentEpoch === closedEpoch) { focus.origin = origin; focus.restore(); }
}

export function jumpToQueue(editor, id, view) {
  if (!editor?.groups.some(group => group.id === id) || !view) return false;
  selectQueue(editor, id);
  view.section.scrollIntoView({ block: 'start', inline: 'nearest' });
  view.name.focus({ preventScroll: true });
  return true;
}
export function actionPresentation({ variant = 'outline', intent } = {}) {
  const resolved = intent || (variant === 'destructive' ? 'destructive' : variant === 'default' ? 'positive' : 'neutral');
  return { intent: resolved, variant: resolved === 'destructive' ? 'destructive' : resolved === 'positive' ? 'default' : variant === 'default' ? 'outline' : variant };
}
export function pickerViewport(viewport, width, height, { keyboard = 0, unobscuredHeight = height } = {}) {
  const positive = (current, fallback) => Number.isFinite(current) && current > 0 ? current : fallback;
  const offset = current => Number.isFinite(current) ? current : 0;
  // The host may already have resized its iframe or the visual viewport. The
  // keyboard is a cap from the unobscured height, not a second subtraction.
  const keyboardCap = keyboard > 0 && unobscuredHeight > keyboard ? unobscuredHeight - keyboard : Infinity;
  return { left: offset(viewport?.offsetLeft), top: offset(viewport?.offsetTop),
    width: positive(viewport?.width, width), height: Math.min(positive(viewport?.height, height), keyboardCap) };
}

export function pickerTabWrap(event, active, stops) {
  if (event.key !== 'Tab' || event.defaultPrevented || !stops.length) return false;
  const first = stops[0]; const last = stops.at(-1);
  if (stops.includes(active) && active !== (event.shiftKey ? first : last)) return false;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
  return true;
}
