import { mountButton, mountTextField } from '@openchamber/sdk/ui';
import { modelRefId, favoriteButtonProps } from './favorites.js';

const el = (tag, className = '', text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function action(root, label, onClick) {
  const slot = el('div', 'button-slot'); root.append(slot);
  const handle = mountButton(slot, { label, onClick, variant: 'outline', size: 'sm' });
  return { slot, handle, button: slot.querySelector('button') };
}
const stamp = value => {
  if (value === null || value === undefined) return 'Unknown';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
};
export function favoritesStatus(local) {
  return local.readError || local.writeError || (local.reading ? 'Reading extension favorites'
    : local.saving ? 'Saving extension favorites'
      : local.loaded ? local.record.models.length === 64 ? '64 extension favorites. Remove one before starring another.'
        : `${local.record.models.length} extension ${local.record.models.length === 1 ? 'favorite' : 'favorites'}` : 'Extension favorites have not loaded');
}

export function mountFavoritesPanel(root, { favorites, source, getCatalog, onImport }) {
  const localStatus = el('p', 'favorites-status'); localStatus.setAttribute('role', 'status');
  const retryActions = el('div', 'inline-actions');
  const retryRead = action(retryActions, 'Retry favorites read', () => { void favorites.load({ retry: true }); });
  const retryWrite = action(retryActions, 'Retry favorites save', () => { void favorites.retryWrite(); });
  const list = el('div', 'local-favorite-list'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', 'Extension favorites in saved order');
  root.append(localStatus, retryActions, list);
  const section = el('section', 'favorite-source');
  section.append(el('h3', 'section-caption', 'Read from OpenChamber'),
    el('p', 'muted favorites-explanation', 'Refresh previews the profile. Import replaces extension favorites.'));
  let savedPath = source.getState().settings?.filePath;
  let pathValue = savedPath || ''; let pathDirty = false;
  const field = mountTextField(section, { label: 'Saved profile preferences file', value: pathValue, mono: true,
    helper: 'Absolute preferences.json path; no guessing. Blank disconnects.',
    onChange(value) { pathValue = value; pathDirty = true; updateCurrentSource(); },
  });
  const sourceActions = el('div', 'inline-actions favorite-source-actions');
  const save = action(sourceActions, 'Save source', async () => {
    const submitted = pathValue;
    await source.configure(submitted);
    if (pathValue === submitted && !source.getState().error) pathDirty = false;
    update();
  });
  const refresh = action(sourceActions, 'Refresh source', () => { void source.refresh(); });
  const review = action(sourceActions, 'Review import', onImport);
  const sourceStatus = el('p', 'favorites-status'); sourceStatus.setAttribute('role', 'status');
  const currentSource = el('p', 'favorite-current-source');
  const currentSourceLabel = el('span', 'muted', 'Current source');
  const currentSourcePath = el('code'); currentSourcePath.dir = 'ltr'; currentSource.append(currentSourceLabel, currentSourcePath);
  const metadata = el('p', 'muted favorite-source-metadata');
  const staleNotice = el('p', 'favorite-source-stale'); staleNotice.setAttribute('role', 'status');
  const preview = el('div', 'favorite-source-preview');
  const help = el('details', 'ui-help');
  help.append(el('summary', '', 'Source details'), metadata, el('p', '', 'Use the active OpenChamber data root, including custom locations. Read-only previews may lag profile autosave.'));
  section.append(sourceActions, sourceStatus, currentSource, staleNotice, preview, help); root.append(section);
  const handles = [field, retryRead.handle, retryWrite.handle, save.handle, refresh.handle, review.handle];
  let rowHandles = []; let rowsSignature = ''; let previewSignature = ''; let disposed = false;
  function updateCurrentSource() {
    currentSource.hidden = savedPath === undefined || pathValue === savedPath;
    currentSourcePath.textContent = currentSource.hidden ? '' : savedPath || 'Not connected';
  }
  function update() {
    if (disposed) return;
    const local = favorites.getState(); const imported = source.getState(); const catalog = getCatalog();
    localStatus.textContent = favoritesStatus(local); localStatus.dataset.error = String(Boolean(local.readError || local.writeError));
    localStatus.setAttribute('role', local.readError || local.writeError ? 'alert' : 'status');
    retryRead.slot.hidden = !local.readError; retryRead.handle.update({ disabled: local.reading });
    retryWrite.slot.hidden = !local.writeError; retryWrite.handle.update({ disabled: local.saving });
    const signature = JSON.stringify([local.loaded, local.readError, local.record.models, catalog.state, catalog.stale, catalog.flat]);
    if (signature !== rowsSignature) {
      rowsSignature = signature;
      const activeId = list.contains(document.activeElement) ? document.activeElement.dataset.favoriteId : null;
      rowHandles.forEach(handle => handle.dispose()); rowHandles = []; list.replaceChildren();
      if (local.loaded && !local.record.models.length) list.append(el('p', 'muted', 'Star models in search.'));
      for (const ref of local.record.models) {
        const id = modelRefId(ref); const row = el('div', 'local-favorite-row'); row.setAttribute('role', 'listitem');
        const text = el('div', 'local-favorite-name'); const code = el('code', '', id); code.dir = 'ltr'; text.append(code);
        if (!catalog.flat.includes(id)) text.append(el('span', 'muted', catalog.state === 'ready' && !catalog.stale ? 'Unavailable in the current catalog' : 'Availability unverified.'));
        else if (catalog.state !== 'ready' || catalog.stale) text.append(el('span', 'muted', 'Cached catalog; availability unverified.'));
        row.append(text);
        const star = action(row, '★', () => { try { favorites.toggle(id); } catch (error) { localStatus.textContent = error.message; } });
        const props = favoriteButtonProps(id, true, !local.loaded || Boolean(local.readError));
        star.handle.update({ disabled: props.disabled }); star.button.setAttribute('aria-label', props.ariaLabel);
        star.button.setAttribute('aria-pressed', props.pressed); star.button.dataset.favoriteId = id;
        rowHandles.push(star.handle); list.append(row);
      }
      if (activeId) {
        const buttons = [...list.querySelectorAll('[data-favorite-id]')];
        const next = buttons.find(button => button.dataset.favoriteId === activeId) || buttons[0]
          || root.closest('dialog')?.querySelector('.dialog-actions button');
        next?.focus({ preventScroll: true });
      }
    }
    savedPath = imported.settings?.filePath;
    if (!pathDirty && savedPath !== undefined) pathValue = savedPath;
    // The SDK repaints its value even when an update only changes disabled state.
    field.update({ value: pathValue, disabled: Boolean(imported.busy) });
    save.handle.update({ disabled: Boolean(imported.busy), loading: imported.busy === 'configure' });
    refresh.handle.update({ disabled: Boolean(imported.busy), loading: imported.busy === 'refresh' });
    review.handle.update({ disabled: Boolean(imported.busy) || imported.snapshot?.state !== 'ready' || !local.loaded || Boolean(local.readError) });
    sourceStatus.textContent = imported.busy ? 'Reading profile'
      : imported.error || (imported.snapshot?.state === 'ready' ? imported.snapshot.favoriteModels.length
        ? `${imported.snapshot.favoriteModels.length} source ${imported.snapshot.favoriteModels.length === 1 ? 'model' : 'models'}` : 'Source empty. Import clears local stars.' : 'No source preview.');
    const sourceError = imported.error && imported.snapshot?.state !== 'not-configured';
    sourceStatus.dataset.error = String(Boolean(sourceError)); sourceStatus.setAttribute('role', sourceError ? 'alert' : 'status');
    updateCurrentSource();
    const good = imported.snapshot?.state === 'ready' ? imported.snapshot : imported.lastGood;
    const stale = Boolean(good && imported.snapshot?.state !== 'ready');
    staleNotice.hidden = !stale;
    staleNotice.textContent = stale ? `Stale read. ${good.favoriteModels.length ? 'Showing the previous preview.' : 'The previous preview was empty.'}` : '';
    metadata.hidden = !good;
    metadata.textContent = good ? `Read ${stamp(good.readAt)} · Profile updated ${stamp(good.updatedAt)}` : '';
    const nextPreview = JSON.stringify([good?.favoriteModels, stale]);
    if (nextPreview !== previewSignature) {
      previewSignature = nextPreview; preview.replaceChildren();
      if (good?.favoriteModels.length) {
        const ordered = el('ol', 'favorite-import-list'); ordered.setAttribute('aria-label', stale ? 'Previous source snapshot, stale' : 'Source favorites in saved order');
        for (const ref of good.favoriteModels) { const item = el('li'); item.append(el('code', '', modelRefId(ref))); ordered.append(item); }
        preview.append(ordered);
      }
    }
  }
  update();
  return { update, dispose() { disposed = true; [...handles, ...rowHandles].forEach(handle => handle.dispose()); root.replaceChildren(); } };
}
