/**
 * Real host-page favorites proof for the extension page frame.
 *
 * The page is mounted by the stock OpenChamber host. Local favorites are read
 * and written through the page's real @openchamber/sdk host.storage bridge; the
 * import source is read through the page's real host.serviceRequest bridge. The
 * harness only changes the synthetic stock-host profile through the host's own
 * settings HTTP route. Input goes through WebDriver BiDi pointer/key actions.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  clickText,
  countBackups,
  hashFile,
  openExtensionPage,
  readUiState,
  waitForDraft,
  waitForLoadedQueue,
  waitForSettingsForm,
} from './ui-flow.mjs';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
export const FAVORITES_KEY = 'omos-queues.favorites.v1';
const modelRefId = (ref) => `${ref.providerID}/${ref.modelID}`;
const sameOrder = (left, right) => JSON.stringify(left) === JSON.stringify(right);

class FavoritesFlowError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FavoritesFlowError';
    this.code = code;
    this.details = details;
  }
}

const readExpression = `(() => {
  const text = (root, selector) => root?.querySelector(selector)?.textContent ?? null;
  const dialog = document.querySelector('dialog.editor-dialog:not(.favorite-import-dialog)');
  const importDialog = document.querySelector('dialog.favorite-import-dialog');
  const details = document.querySelector('details.settings-favorites');
  const panel = details?.querySelector('.favorites-panel') ?? null;
  const rows = panel ? [...panel.querySelectorAll('.local-favorite-list .local-favorite-row')].map((row) => {
    const button = row.querySelector('[data-favorite-id]');
    return {
      id: button?.dataset.favoriteId ?? null,
      text: (row.innerText || '').trim(),
      pressed: button?.getAttribute('aria-pressed') ?? null,
      ariaLabel: button?.getAttribute('aria-label') ?? null,
      disabled: Boolean(button?.disabled),
    };
  }) : [];
  const actions = [...(dialog?.querySelectorAll('.dialog-actions button') ?? [])].map((button) => ({
    text: (button.innerText || '').trim(),
    disabled: Boolean(button.disabled),
  }));
  const source = panel?.querySelector('.favorite-source') ?? null;
  const field = source?.querySelector('input.oc-sdk-input') ?? null;
  const current = panel?.querySelector('.favorite-current-source') ?? null;
  const metadata = source?.querySelector('.favorite-source-metadata');
  const sourceDetails = metadata?.closest('details.ui-help');
  const staleNotice = source?.querySelector('.favorite-source-stale');
  const previewList = panel?.querySelector('.favorite-source-preview ol') ?? null;
  return JSON.stringify({
    open: Boolean(dialog?.open),
    title: text(dialog, '.dialog-title'),
    body: text(dialog, '.dialog-body'),
    dialogError: dialog?.querySelector('.status-box[role="alert"]')?.textContent ?? null,
    settingsOpen: Boolean(dialog?.open && dialog?.querySelector('.settings-fields')),
    favoritesDetailsOpen: Boolean(details?.open),
    panel: Boolean(panel),
    localStatus: panel?.querySelector(':scope > .favorites-status')?.textContent ?? null,
    retryReadVisible: panel ? Boolean(panel.querySelector(':scope > .inline-actions .button-slot:not([hidden])')) : null,
    rows,
    field: field?.value ?? null,
    fieldDisabled: Boolean(field?.disabled),
    sourceStatus: source?.querySelector('.favorites-status')?.textContent ?? null,
    sourceBusy: Boolean(source?.querySelector('button[aria-busy="true"]')),
    currentPath: current?.querySelector('code')?.textContent ?? null,
    currentHidden: Boolean(current?.hidden),
    metadata: metadata?.textContent ?? null,
    metadataDisclosure: sourceDetails?.querySelector('summary')?.textContent ?? null,
    metadataExpanded: sourceDetails?.open ?? null,
    visibleStaleNotice: staleNotice?.getClientRects().length ? staleNotice.textContent : null,
    previewLabel: previewList?.getAttribute('aria-label') ?? null,
    preview: previewList ? [...previewList.querySelectorAll('li code')].map((node) => node.textContent) : [],
    reviewDisabled: (() => {
      const review = [...(source?.querySelectorAll('button') ?? [])]
        .find((button) => (button.innerText || '').trim() === 'Review import');
      return review ? Boolean(review.disabled) : null;
    })(),
    actions,
    settingsFields: [...(dialog?.querySelectorAll('.settings-fields .oc-sdk-field') ?? [])].map((fieldNode) => ({
      label: fieldNode.querySelector('.oc-sdk-field-label')?.textContent ?? null,
      value: fieldNode.querySelector('input, textarea')?.value ?? null,
      disabled: Boolean(fieldNode.querySelector('input, textarea')?.disabled),
    })),
    importOpen: Boolean(importDialog?.open),
    importTitle: text(importDialog, '.dialog-title'),
    importBody: text(importDialog, '.dialog-body'),
    importList: [...(importDialog?.querySelectorAll('.favorite-import-list li code') ?? [])].map((node) => node.textContent),
    importLabel: importDialog?.querySelector('.favorite-import-list')?.getAttribute('aria-label') ?? null,
    importActions: [...(importDialog?.querySelectorAll('.dialog-actions button') ?? [])].map((button) => ({
      text: (button.innerText || '').trim(), disabled: Boolean(button.disabled), intent: button.dataset.intent ?? null,
    })),
    activeFavoriteId: document.activeElement?.dataset?.favoriteId ?? null,
    activeAria: document.activeElement?.getAttribute?.('aria-label') ?? null,
    activeText: (document.activeElement?.innerText || '').trim().slice(0, 120),
  });
})()`;
const pickerExpression = `(() => {
  const picker = document.querySelector('.model-picker');
  return JSON.stringify({
    visible: picker ? !picker.hidden : false,
    search: document.querySelector('.model-search input')?.value ?? null,
    queryFocused: document.activeElement === document.querySelector('.model-search input'),
    options: [...document.querySelectorAll('.model-options [role="option"]')].map((row) => ({
      id: row.title || null,
      title: (row.querySelector('.oc-sdk-row-title')?.textContent || '').trim(),
      meta: (row.querySelector('.oc-sdk-row-meta')?.textContent || '').trim(),
      selected: row.getAttribute('aria-selected'),
    })),
    stars: [...document.querySelectorAll('.favorite-stars [data-favorite-id]')].map((button) => ({
      id: button.dataset.favoriteId ?? null,
      pressed: button.getAttribute('aria-pressed'),
      ariaLabel: button.getAttribute('aria-label'),
      disabled: Boolean(button.disabled),
      focused: document.activeElement === button,
    })),
    status: document.querySelector('.picker-favorites-status')?.textContent ?? null,
    activeFavoriteId: document.activeElement?.dataset?.favoriteId ?? null,
  });
})()`;

export const readFavoritesState = async (browser, context) => (
  JSON.parse(await browser.evaluate(readExpression, { context }))
);

export const readPickerFavoritesState = async (browser, context) => (
  JSON.parse(await browser.evaluate(pickerExpression, { context }))
);

export const openFavoritesPanel = async (browser, context, { pointerType = 'mouse', timeoutMs = 15_000 } = {}) => {
  let state = await readFavoritesState(browser, context);
  if (!state.settingsOpen) {
    await clickText(browser, context, 'Settings');
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      state = await readFavoritesState(browser, context);
      if (state.settingsOpen) break;
      await sleep(150);
    }
  }
  await waitForSettingsForm(browser, context);
  state = await readFavoritesState(browser, context);
  if (!state.favoritesDetailsOpen) {
    await browser.evaluate(`new Promise(resolve => {
      document.querySelector('details.settings-favorites > summary').scrollIntoView({block:'center',inline:'nearest'});
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`, { context });
    await browser.pointerClick('details.settings-favorites > summary', { context, pointerType, scroll: false, timeoutMs: 10_000 });
  }
  await browser.evaluate(`document.querySelector('details.settings-favorites')?.scrollIntoView({ block: 'start', inline: 'nearest' })`, { context });
  return waitForFavorites(browser, context, (stateNow) => (
    stateNow.settingsOpen
    && stateNow.favoritesDetailsOpen
    && stateNow.panel
    && /^\d+ extension favorites?\b/.test(stateNow.localStatus || '')
  ), { timeoutMs, label: 'the Settings favorites panel' });
};

const waitForFavorites = async (browser, context, predicate, { timeoutMs = 15_000, label = 'a favorites state' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readFavoritesState(browser, context).catch((error) => ({ error: error.message }));
    if (!last?.error && predicate(last)) return last;
    await sleep(150);
  }
  throw new FavoritesFlowError('FAVORITES_WAIT', `${label} did not settle in time`, { last });
};

const waitForPicker = async (browser, context, predicate, { timeoutMs = 12_000, label = 'the model picker' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPickerFavoritesState(browser, context).catch((error) => ({ error: error.message }));
    if (!last?.error && predicate(last)) return last;
    await sleep(150);
  }
  throw new FavoritesFlowError('PICKER_WAIT', `${label} did not settle in time`, { last });
};

const openRowPicker = async (browser, context, index = 0, { pointerType = 'mouse', queueId = null } = {}) => {
  const queue = queueId ?? (await readUiState(browser, context)).workspace?.selectedId;
  await browser.pointerClick(`.queue-workspace[data-queue-id=${JSON.stringify(queue)}] .model-row[data-index="${index}"] [data-action="model"]`, { context, pointerType });
  return waitForPicker(browser, context, (state) => state.visible && state.queryFocused, {
    label: 'the model picker from row model control',
  });
};

const starSelector = (scope, id) => `${scope} [data-favorite-id=${JSON.stringify(id)}]`;

const clickStar = async (browser, context, scope, id, { pointerType = 'mouse' } = {}) => {
  const before = await waitForPicker(browser, context, row => row.visible && row.stars.some(star => star.id === id), { label: `the ${id} star before pointer input` });
  try { await browser.pointerClick(starSelector(scope, id), { context, pointerType }); }
  catch (error) { error.details = { ...error.details, before, after: await readPickerFavoritesState(browser, context) }; throw error; }
  return waitForPicker(browser, context, (state) => state.stars.some((star) => star.id === id), {
    label: `the ${id} favorite control`,
  });
};

const setSourceField = async (browser, context, value, { checkName = 'source-field' } = {}) => {
  await browser.pointerClick('.favorite-source input.oc-sdk-input', { context });
  await browser.evaluate(`(() => {
    const input = document.querySelector('.favorite-source input.oc-sdk-input');
    if (!input) return false;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, { context });
  if (value) await browser.typeText(value, { context });
  return waitForFavorites(browser, context, (state) => state.field === value, {
    label: `${checkName} value ${value || '(empty)'}`,
  });
};

const saveSource = async (browser, context) => {
  await clickText(browser, context, 'Save source');
  return waitForFavorites(browser, context, (state) => (
    state.sourceStatus != null
    && !state.sourceBusy
    && !state.fieldDisabled
    && state.sourceStatus !== 'Reading profile'
  ), { timeoutMs: 15_000, label: 'the saved profile source result' });
};

const refreshSource = async (browser, context) => {
  await clickText(browser, context, 'Refresh source');
  return waitForFavorites(browser, context, (state) => (
    state.sourceStatus != null
    && !state.sourceBusy
    && state.sourceStatus !== 'Reading profile'
  ), { timeoutMs: 15_000, label: 'the refreshed profile source' });
};

const sourceReady = (state) => /^\d+ source models?\b/.test(state.sourceStatus || '')
  || state.sourceStatus === 'Source empty. Import clears local stars.';

export const closeSettings = async (browser, context) => {
  const marked = await browser.evaluate(`(() => {
    const dialog = document.querySelector('dialog.editor-dialog:not(.favorite-import-dialog)[open]');
    const button = [...(dialog?.querySelectorAll('.dialog-actions button') ?? [])]
      .find((node) => (node.innerText || '').trim() === 'Cancel');
    if (!button) return false;
    button.dataset.omosSettingsCancel = '1';
    return true;
  })()`, { context });
  if (!marked) throw new FavoritesFlowError('FAVORITES_SETTINGS_CLOSE', 'No Settings Cancel action');
  await browser.pointerClick('[data-omos-settings-cancel="1"]', { context });
  await browser.evaluate(`document.querySelector('[data-omos-settings-cancel="1"]')?.removeAttribute('data-omos-settings-cancel')`, { context });
  return waitForFavorites(browser, context, (state) => !state.open, { label: 'the closed Settings dialog' });
};

const clickImportAction = async (browser, context, label) => {
  const marked = await browser.evaluate(`(() => {
    const dialog = document.querySelector('dialog.favorite-import-dialog[open]');
    const button = [...(dialog?.querySelectorAll('.dialog-actions button') ?? [])]
      .find((node) => (node.innerText || '').trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.dataset.omosImportAction = '1';
    return true;
  })()`, { context });
  if (!marked) throw new FavoritesFlowError('FAVORITES_IMPORT_ACTION', `No import dialog action ${label}`);
  await browser.pointerClick('[data-omos-import-action="1"]', { context });
  await browser.evaluate(`document.querySelector('[data-omos-import-action="1"]')?.removeAttribute('data-omos-import-action')`, { context });
};

const setSettingsField = async (browser, context, label, value) => {
  const deadline = Date.now() + 10_000;
  let marked = false;
  while (Date.now() < deadline && !marked) {
    marked = await browser.evaluate(`(() => {
      const field = [...document.querySelectorAll('.settings-fields .oc-sdk-field')]
        .find((node) => (node.querySelector('.oc-sdk-field-label')?.textContent || '').trim() === ${JSON.stringify(label)});
      const input = field?.querySelector('input, textarea');
      if (!input) return false;
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dataset.omosUnsaved = '1';
      return true;
    })()`, { context });
    if (!marked) await sleep(150);
  }
  if (!marked) throw new FavoritesFlowError('FAVORITES_SETTINGS', `No Settings field labelled ${label}`);
  if (value) await browser.typeText(value, { context });
  return waitForFavorites(browser, context, (state) => (
    state.settingsFields.find((field) => field.label === label)?.value === value
  ), { label: `the unsaved Settings field ${label}` });
};

export const runFavoritesDomWorkflow = async ({
  browser,
  context,
  configFile,
  preferencesPath,
  missingPreferencesPath,
  storagePath,
  artifactsDir,
  serviceJson,
  baseUrl,
  pageTitle,
  hostFavorites,
  initialHostFavorites,
  updatedHostFavorites,
  baselineHash,
  baselineGeneration,
}) => {
  const checks = {};
  const artifacts = [];
  const check = (name, condition, detail = null) => {
    checks[name] = { ok: Boolean(condition), ...(detail ? { detail } : {}) };
    if (!condition) {
      const error = new FavoritesFlowError('FAVORITES_CHECK', `Favorites DOM check failed: ${name}`, detail);
      error.check = name;
      throw error;
    }
  };
  const capture = async (name) => {
    const shot = await browser.screenshot(path.join(artifactsDir, `${name}.png`));
    artifacts.push({ name, ...shot });
    return shot;
  };
  const hash = () => hashFile(configFile);
  const backupCount = () => countBackups(path.dirname(configFile));
  const storageDocument = () => {
    try { return JSON.parse(fs.readFileSync(storagePath, 'utf8')); } catch { return null; }
  };
  const storedModels = () => {
    const document = storageDocument();
    const record = document?.[FAVORITES_KEY];
    return Array.isArray(record?.models) ? record.models.map(modelRefId) : [];
  };
  const waitForStorage = async (expected, { timeoutMs = 10_000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = storedModels();
      if (sameOrder(last, expected)) return last;
      await sleep(150);
    }
    throw new FavoritesFlowError('FAVORITES_STORAGE', 'The real SDK storage did not record the expected favorites order', {
      expected, actual: last, storagePath,
    });
  };
  const inline = async (name, fn) => {
    try { return await fn(); } catch (error) {
      if (error instanceof FavoritesFlowError && error.code === 'FAVORITES_CHECK') throw error;
      throw new FavoritesFlowError('FAVORITES_STAGE', `${name}: ${error.message}`, error.details ?? null);
    }
  };

  const startHash = hash();
  const startBackups = backupCount();
  check('favorites-baseline-hash', startHash === baselineHash, { startHash, baselineHash });
  const initialConfig = await serviceJson('GET', '/config');
  check('favorites-baseline-generation', initialConfig?.target?.generation === baselineGeneration, {
    generation: initialConfig?.target?.generation, baselineGeneration,
  });

  // Star two real catalog refs from the picker with pointer input. Starring is
  // extension storage only: no queue edit and no file write.
  await inline('picker-star-initial', async () => {
    const picker = await openRowPicker(browser, context, 0);
    check('favorites-start-empty', picker.stars.length === picker.options.length
      && picker.stars.every((star) => star.pressed === 'false'), { stars: picker.stars });
    await clickStar(browser, context, '.favorite-stars', 'synthetic/provider-gamma');
    let state = await waitForPicker(browser, context, (row) => (
      row.stars.find((star) => star.id === 'synthetic/provider-gamma')?.pressed === 'true'
    ), { label: 'the gamma star pressed state' });
    check('favorites-star-pressed', state.stars.find((star) => star.id === 'synthetic/provider-gamma')?.pressed === 'true', { stars: state.stars });
    check('favorites-star-focus-retained', state.activeFavoriteId === 'synthetic/provider-gamma', { activeFavoriteId: state.activeFavoriteId });
    await clickStar(browser, context, '.favorite-stars', 'synthetic/provider-alpha');
    state = await waitForPicker(browser, context, (row) => (
      row.stars.find((star) => star.id === 'synthetic/provider-alpha')?.pressed === 'true'
    ), { label: 'the alpha star pressed state' });
    check('favorites-star-label', /Remove synthetic\/provider-alpha from extension favorites/.test(
      state.stars.find((star) => star.id === 'synthetic/provider-alpha')?.ariaLabel || '',
    ), { stars: state.stars });
    const stored = await waitForStorage(['synthetic/provider-gamma', 'synthetic/provider-alpha']);
    check('favorites-sdk-storage-order', sameOrder(stored, ['synthetic/provider-gamma', 'synthetic/provider-alpha']), { stored });
    await browser.pressKey('Escape', { context });
    await waitForPicker(browser, context, (row) => !row.visible, { label: 'the closed model picker' });
    check('favorites-star-does-not-dirty-queue', (await readUiState(browser, context)).footer.dirty === 'No unsaved changes');
  });

  // The panel reads the real SDK storage; keyboard Space toggles the same
  // control, keeps focus and updates the accessible pressed state.
  let panel = await openFavoritesPanel(browser, context);
  check('favorites-panel-local-order', sameOrder(panel.rows.map((row) => row.id), ['synthetic/provider-gamma', 'synthetic/provider-alpha']), {
    rows: panel.rows,
  });
  await inline('keyboard-unstar', async () => {
    const alpha = 'synthetic/provider-alpha';
    await browser.evaluate(`document.querySelector('.local-favorite-list [data-favorite-id=${JSON.stringify(alpha)}]')?.focus()`, { context });
    await waitForFavorites(browser, context, row => row.favoritesDetailsOpen && row.activeFavoriteId === alpha, { label: 'the focused alpha star' });
    await browser.pressKey('Space', { context });
    panel = await waitForFavorites(browser, context, (state) => (
      !state.rows.some((row) => row.id === alpha) && state.activeFavoriteId === 'synthetic/provider-gamma'
    ), { label: 'the keyboard unstar result' });
    check('favorites-keyboard-unstar', !panel.rows.some((row) => row.id === alpha)
      && panel.rows.find((row) => row.id === 'synthetic/provider-gamma')?.ariaLabel
        === 'Remove synthetic/provider-gamma from extension favorites', { rows: panel.rows, active: panel.activeFavoriteId });
    await waitForStorage(['synthetic/provider-gamma']);
    await browser.evaluate(`document.querySelector('.local-favorite-list [data-favorite-id="synthetic/provider-gamma"]')?.focus()`, { context });
    await waitForFavorites(browser, context, row => row.favoritesDetailsOpen && row.activeFavoriteId === 'synthetic/provider-gamma', { label: 'the focused gamma star' });
    await browser.pressKey('Space', { context });
    panel = await waitForFavorites(browser, context, (state) => (
      state.rows.length === 0 && /^0 extension favorites\b/.test(state.localStatus || '')
    ), { label: 'the keyboard empty result' });
    check('favorites-keyboard-unstar-last', panel.rows.length === 0 && /^0 extension favorites\b/.test(panel.localStatus || ''), {
      rows: panel.rows, localStatus: panel.localStatus,
    });
    await waitForStorage([]);
    await closeSettings(browser, context);
    await waitForFavorites(browser, context, (state) => !state.open, { label: 'the closed favorites panel' });
    // Restore the saved order used by the rest of the proof from the picker.
    await openRowPicker(browser, context, 0);
    for (const id of ['synthetic/provider-gamma', 'synthetic/provider-alpha']) {
      await clickStar(browser, context, '.favorite-stars', id);
      await waitForPicker(browser, context, (state) => (
        state.stars.find((star) => star.id === id)?.pressed === 'true'
      ), { label: `the ${id} restored picker star` });
    }
    await waitForStorage(['synthetic/provider-gamma', 'synthetic/provider-alpha']);
    await browser.pressKey('Escape', { context });
    await waitForPicker(browser, context, (state) => !state.visible, { label: 'the closed picker' });
    panel = await openFavoritesPanel(browser, context);
    check('favorites-restored-order', sameOrder(panel.rows.map((row) => row.id),
      ['synthetic/provider-gamma', 'synthetic/provider-alpha']), { rows: panel.rows });
    await closeSettings(browser, context);
    await waitForFavorites(browser, context, (state) => !state.open, { label: 'the closed favorites panel' });
  });

  // Favorites come first in the picker, in saved order, with accessible
  // pressed state; the star group and the option list share that order.
  await inline('picker-favorites-first', async () => {
    const picker = await openRowPicker(browser, context, 0);
    const ids = picker.options.map((option) => option.title);
    check('favorites-picker-first', sameOrder(ids.slice(0, 2), ['synthetic/provider-gamma', 'synthetic/provider-alpha']), { ids });
    check('favorites-picker-star-order', sameOrder(
      picker.stars.slice(0, 2).map((star) => star.id),
      ['synthetic/provider-gamma', 'synthetic/provider-alpha'],
    ), { stars: picker.stars });
    check('favorites-picker-pressed', picker.stars.slice(0, 2).every((star) => star.pressed === 'true'), { stars: picker.stars });
    check('favorites-picker-meta', /Favorite/.test(picker.options[0]?.meta || ''), { option: picker.options[0] });
    await capture('favorites-picker-desktop-light');
    await browser.pressKey('Escape', { context });
    await waitForPicker(browser, context, (row) => !row.visible, { label: 'the closed picker' });
  });

  // Reload proves persistence through the real SDK storage, not page memory.
  await browser.navigate(baseUrl, { timeoutMs: 30_000 });
  const reloaded = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
  context = reloaded.context;
  await waitForLoadedQueue(browser, context, { timeoutMs: 25_000 });
  await inline('reload-persistence', async () => {
    check('favorites-storage-before-reload', sameOrder(storedModels(), ['synthetic/provider-gamma', 'synthetic/provider-alpha']), {
      stored: storedModels(),
    });
    const picker = await openRowPicker(browser, context, 0);
    check('favorites-reload-picker-star', picker.stars.slice(0, 2).every((star) => star.pressed === 'true')
      && sameOrder(picker.stars.slice(0, 2).map((star) => star.id), ['synthetic/provider-gamma', 'synthetic/provider-alpha']), { stars: picker.stars });
    check('favorites-reload-order', sameOrder(picker.options.slice(0, 2).map((option) => option.title),
      ['synthetic/provider-gamma', 'synthetic/provider-alpha']), { options: picker.options });
    await browser.pressKey('Escape', { context });
    await waitForPicker(browser, context, (row) => !row.visible, { label: 'the closed reloaded picker' });
  });

  // Configure the import source through the real page bridge. The field starts
  // empty because the harness reset the source before this browser session.
  panel = await openFavoritesPanel(browser, context);
  check('favorites-source-unconfigured', panel.field === '' && panel.currentHidden === true, {
    field: panel.field, currentHidden: panel.currentHidden, sourceStatus: panel.sourceStatus,
  });
  await inline('configure-source', async () => {
    panel = await setSourceField(browser, context, preferencesPath);
    panel = await saveSource(browser, context);
    check('favorites-source-configured', (await serviceJson('GET', '/favorites/source')).filePath === preferencesPath
      && panel.field === preferencesPath && panel.currentHidden, {
      field: panel.field, currentHidden: panel.currentHidden,
    });
    check('favorites-source-ready', sourceReady(panel), { sourceStatus: panel.sourceStatus });
    check('favorites-source-preview-order', sameOrder(panel.preview, initialHostFavorites), {
      preview: panel.preview, expected: initialHostFavorites,
    });
    check('favorites-source-timestamps-disclosed', /Read .+ · Profile updated /.test(panel.metadata || '')
      && panel.metadataDisclosure === 'Source details' && panel.metadataExpanded === false, {
      metadata: panel.metadata, disclosure: panel.metadataDisclosure, expanded: panel.metadataExpanded,
    });
    const unsavedSource = path.join(artifactsDir, 'another-synthetic-preferences.json');
    panel = await setSourceField(browser, context, unsavedSource);
    check('favorites-unsaved-source-path-visible', panel.field === unsavedSource && !panel.currentHidden
      && panel.currentPath === preferencesPath && (await serviceJson('GET', '/favorites/source')).filePath === preferencesPath,
    { field: panel.field, currentPath: panel.currentPath, currentHidden: panel.currentHidden });
    panel = await setSourceField(browser, context, preferencesPath);
    check('favorites-reverted-source-hides-duplicate', panel.currentHidden && panel.field === preferencesPath);
    check('favorites-configure-keeps-stars', sameOrder(panel.rows.map((row) => row.id), ['synthetic/provider-gamma', 'synthetic/provider-alpha']), {
      rows: panel.rows,
    });
    check('favorites-configure-no-write', hash() === baselineHash, { hash: hash(), baselineHash });
    await capture('favorites-panel-desktop-light');
  });

  // A host-profile change reaches a fresh refresh without touching local stars,
  // a queue draft or the OMOS file.
  await inline('source-change-propagation', async () => {
    const before = panel;
    const write = await hostFavorites(updatedHostFavorites);
    check('favorites-host-profile-write', write?.status === 200, { status: write?.status, response: write?.json ?? null });
    panel = await refreshSource(browser, context);
    check('favorites-refresh-order', sameOrder(panel.preview, updatedHostFavorites), {
      preview: panel.preview, expected: updatedHostFavorites,
    });
    check('favorites-refresh-ready', sourceReady(panel), { sourceStatus: panel.sourceStatus });
    check('favorites-refresh-new-stamp', panel.metadata !== before.metadata, { before: before.metadata, after: panel.metadata });
    check('favorites-refresh-keeps-stars', sameOrder(panel.rows.map((row) => row.id), ['synthetic/provider-gamma', 'synthetic/provider-alpha']), {
      rows: panel.rows,
    });
    check('favorites-refresh-no-write', hash() === baselineHash, { hash: hash(), baselineHash });
  });

  // Cancel then confirm: only the explicit confirmation replaces local stars.
  // An unsaved Settings path field must stay mounted and unchanged across both
  // import dialogs; the settings form is never submitted here.
  await inline('import-cancel-confirm', async () => {
    const localBefore = panel.rows.map((row) => row.id);
    const unsavedPath = path.join(artifactsDir, 'synthetic-unsaved-opencode.jsonc');
    panel = await setSettingsField(browser, context, 'OMOS configuration file', unsavedPath);
    const generationBefore = (await serviceJson('GET', '/config'))?.target?.generation ?? null;
    const backupsBefore = countBackups(path.dirname(configFile));
    check('favorites-settings-field-unsaved', panel.settingsFields.find((field) => field.label === 'OMOS configuration file')?.value === unsavedPath, {
      fields: panel.settingsFields,
    });
    await clickText(browser, context, 'Review import');
    let dialog = await waitForFavorites(browser, context, (state) => (
      state.importOpen && state.importTitle === 'Replace extension favorites?'
    ), { label: 'the import review dialog' });
    check('favorites-import-list-order', sameOrder(dialog.importList, updatedHostFavorites), {
      importList: dialog.importList, expected: updatedHostFavorites,
    });
    check('favorites-import-keeps-local-before-confirm', sameOrder(localBefore, ['synthetic/provider-gamma', 'synthetic/provider-alpha']), {
      localBefore,
    });
    check('favorites-import-settings-mounted', dialog.settingsOpen && dialog.favoritesDetailsOpen && dialog.panel, {
      settingsOpen: dialog.settingsOpen, details: dialog.favoritesDetailsOpen, panel: dialog.panel,
    });
    await capture('favorites-import-desktop-light');
    await clickImportAction(browser, context, 'Cancel');
    panel = await waitForFavorites(browser, context, (state) => (
      state.settingsOpen && state.favoritesDetailsOpen && state.panel && !state.importOpen
    ), { label: 'the Settings favorites panel after import cancel' });
    check('favorites-import-cancel-keeps-stars', sameOrder(panel.rows.map((row) => row.id), localBefore), { rows: panel.rows });
    check('favorites-import-cancel-keeps-unsaved-field', panel.settingsFields.find((field) => field.label === 'OMOS configuration file')?.value === unsavedPath, {
      fields: panel.settingsFields,
    });
    check('favorites-import-cancel-no-write', hash() === baselineHash && countBackups(path.dirname(configFile)) === backupsBefore, { hash: hash() });

    await clickText(browser, context, 'Review import');
    await waitForFavorites(browser, context, (state) => state.importOpen && state.importTitle === 'Replace extension favorites?', {
      label: 'the re-opened import review dialog',
    });
    await clickImportAction(browser, context, 'Replace extension favorites');
    panel = await waitForFavorites(browser, context, (state) => (
      state.settingsOpen && state.favoritesDetailsOpen && state.panel && !state.importOpen
      && sameOrder(state.rows.map((row) => row.id), updatedHostFavorites)
    ), { label: 'the confirmed imported favorites' });
    check('favorites-import-confirm-order', sameOrder(panel.rows.map((row) => row.id), updatedHostFavorites), { rows: panel.rows });
    check('favorites-import-confirm-storage', sameOrder(await waitForStorage(updatedHostFavorites), updatedHostFavorites), { stored: storedModels() });
    check('favorites-import-confirm-keeps-unsaved-field', panel.settingsFields.find((field) => field.label === 'OMOS configuration file')?.value === unsavedPath, {
      fields: panel.settingsFields,
    });
    check('favorites-import-confirm-settings-mounted', panel.settingsOpen && panel.favoritesDetailsOpen && panel.panel, {
      settingsOpen: panel.settingsOpen, details: panel.favoritesDetailsOpen,
    });
    check('favorites-import-confirm-no-write', hash() === baselineHash
      && countBackups(path.dirname(configFile)) === backupsBefore
      && (await serviceJson('GET', '/config'))?.target?.generation === generationBefore, {
      hash: hash(), baselineHash, backups: countBackups(path.dirname(configFile)), backupsBefore, generationBefore,
    });
    const footer = (await readUiState(browser, context)).footer;
    check('favorites-import-footer-clean', footer.dirty === 'No unsaved changes', { footer });
  });

  // Source refresh must not replace a real queue draft (or write the file).
  await inline('refresh-preserves-draft', async () => {
    await closeSettings(browser, context);
    await waitForFavorites(browser, context, (state) => !state.open, { label: 'the closed favorites panel' });
    await openRowPicker(browser, context, 0);
    await browser.typeText('synthetic/provider-beta', { context });
    await waitForPicker(browser, context, (state) => state.options.some((option) => option.title === 'synthetic/provider-beta'));
    await browser.pressKey('Enter', { context });
    await waitForPicker(browser, context, (state) => !state.visible, { label: 'the picker after choosing a draft model' });
    const draftIds = (await waitForDraft(serviceJson, configFile)).map((draft) => draft.id);
    const dirty = (await readUiState(browser, context)).footer;
    check('favorites-draft-created', draftIds.length > 0 && dirty.dirty === '1 queue changed', { draftIds, footer: dirty });
    panel = await openFavoritesPanel(browser, context);
    panel = await refreshSource(browser, context);
    const afterDrafts = (await serviceJson('GET', '/drafts')).drafts
      .filter((draft) => draft.targetPath === configFile)
      .map((draft) => draft.id);
    const afterFooter = (await readUiState(browser, context)).footer;
    check('favorites-refresh-keeps-draft', draftIds.every((id) => afterDrafts.includes(id)) && afterDrafts.length >= draftIds.length, {
      draftIds, afterDrafts,
    });
    check('favorites-refresh-keeps-dirty', afterFooter.dirty === '1 queue changed', { footer: afterFooter });
    check('favorites-refresh-keeps-stars-2', sameOrder(panel.rows.map((row) => row.id), updatedHostFavorites), { rows: panel.rows });
    check('favorites-refresh-draft-no-write', hash() === baselineHash, { hash: hash(), baselineHash });
    await closeSettings(browser, context);
    await waitForFavorites(browser, context, (state) => !state.open, { label: 'the closed favorites panel' });
    const queueId = (await readUiState(browser, context)).workspace.selectedId;
    await browser.pointerClick(`.queue-workspace[data-queue-id=${JSON.stringify(queueId)}] [data-queue-action="reset"]`, { context });
    await waitForFavorites(browser, context, (state) => state.open && state.title?.startsWith('Reset edits to'), {
      label: 'the reset confirmation',
    });
    await clickText(browser, context, 'Reset queue');
    const clean = await (async () => {
      const deadline = Date.now() + 12_000;
      let state = null;
      while (Date.now() < deadline) {
        state = await readUiState(browser, context);
        if (!state.dialog.open && state.footer.dirty === 'No unsaved changes') return state;
        await sleep(150);
      }
      throw new FavoritesFlowError('FAVORITES_WAIT', 'The queue did not return to a clean footer after discard', { state });
    })();
    check('favorites-draft-discarded-clean', clean.footer.dirty === 'No unsaved changes', { footer: clean.footer });
    check('favorites-draft-discarded-no-write', hash() === baselineHash, { hash: hash(), baselineHash });
  });

  // A stale/error source keeps the last good preview visible, disables import
  // and never erases local stars.
  await inline('stale-source-blocks-import', async () => {
    panel = await openFavoritesPanel(browser, context);
    const local = panel.rows.map((row) => row.id);
    panel = await setSourceField(browser, context, missingPreferencesPath);
    panel = await saveSource(browser, context);
    check('favorites-source-error-blocked', panel.reviewDisabled === true, { panel });
    check('favorites-source-error-stale-label', /stale/i.test(panel.visibleStaleNotice || '')
      && /stale/i.test(panel.previewLabel || ''), { staleNotice: panel.visibleStaleNotice, previewLabel: panel.previewLabel });
    check('favorites-source-error-keeps-preview', sameOrder(panel.preview, updatedHostFavorites), { preview: panel.preview });
    check('favorites-source-error-keeps-stars', sameOrder(panel.rows.map((row) => row.id), local), { rows: panel.rows });
    check('favorites-source-error-no-write', hash() === baselineHash, { hash: hash(), baselineHash });
    await capture('favorites-source-error-desktop-light');
    panel = await setSourceField(browser, context, preferencesPath);
    panel = await saveSource(browser, context);
    check('favorites-source-restored', sourceReady(panel) && panel.field === preferencesPath && panel.currentHidden, {
      sourceStatus: panel.sourceStatus, field: panel.field,
    });
  });

  // Empty source: import is possible only through the explicit confirmation.
  await inline('empty-import-explicit', async () => {
    const write = await hostFavorites([]);
    check('favorites-empty-host-write', write?.status === 200, { status: write?.status });
    panel = await refreshSource(browser, context);
    const unsavedEmpty = path.join(artifactsDir, 'synthetic-empty-import-unsaved.jsonc');
    panel = await setSettingsField(browser, context, 'OMOS configuration file', unsavedEmpty);
    check('favorites-empty-ready', sourceReady(panel) && sameOrder(panel.preview, []), {
      sourceStatus: panel.sourceStatus, preview: panel.preview,
    });
    check('favorites-empty-import-enabled', panel.reviewDisabled === false, { panel });
    const localBefore = panel.rows.map((row) => row.id);
    await clickText(browser, context, 'Review import');
    let dialog = await waitForFavorites(browser, context, (state) => (
      state.importOpen && state.importTitle === 'Replace extension favorites?'
    ), { label: 'the empty import confirmation' });
    check('favorites-empty-dialog-explicit', /source is empty|clears all extension favorites/i.test(dialog.importBody || '')
      && dialog.importActions.some((action) => action.text === 'Clear extension favorites'), {
      body: dialog.importBody, actions: dialog.importActions,
    });
    await capture('favorites-import-empty-desktop-light');
    await clickImportAction(browser, context, 'Cancel');
    panel = await waitForFavorites(browser, context, (state) => (
      state.settingsOpen && state.favoritesDetailsOpen && state.panel && !state.importOpen
    ), { label: 'the panel after empty cancel' });
    check('favorites-empty-cancel-keeps-stars', sameOrder(panel.rows.map((row) => row.id), localBefore), { rows: panel.rows });
    check('favorites-empty-cancel-keeps-unsaved-field', panel.settingsFields.find((field) => field.label === 'OMOS configuration file')?.value === unsavedEmpty
      && panel.settingsOpen && panel.favoritesDetailsOpen, { fields: panel.settingsFields });
    await clickText(browser, context, 'Review import');
    await waitForFavorites(browser, context, (state) => state.importOpen && state.importTitle === 'Replace extension favorites?', {
      label: 'the re-opened empty confirmation',
    });
    await clickImportAction(browser, context, 'Clear extension favorites');
    panel = await waitForFavorites(browser, context, (state) => (
      state.settingsOpen && state.favoritesDetailsOpen && state.panel && !state.importOpen && state.rows.length === 0
    ), { label: 'the explicitly cleared favorites' });
    check('favorites-empty-confirm-clears', panel.rows.length === 0, { rows: panel.rows });
    check('favorites-empty-storage-cleared', sameOrder(await waitForStorage([]), []), { stored: storedModels() });
    check('favorites-empty-confirm-keeps-unsaved-field', panel.settingsFields.find((field) => field.label === 'OMOS configuration file')?.value === unsavedEmpty
      && panel.settingsOpen && panel.favoritesDetailsOpen, { fields: panel.settingsFields });
    check('favorites-empty-no-write', hash() === baselineHash, { hash: hash(), baselineHash });
    await closeSettings(browser, context);
    await waitForFavorites(browser, context, (state) => !state.open, { label: 'the closed favorites panel' });
  });

  // Final integrity: clean footer, unchanged baseline file/generation/backups.
  const finalConfig = await serviceJson('GET', '/config');
  const finalState = await readUiState(browser, context);
  check('favorites-footer-clean', finalState.footer.dirty === 'No unsaved changes' && !finalState.dialog.open, {
    footer: finalState.footer, dialog: finalState.dialog,
  });
  check('favorites-omos-hash-unchanged', hash() === baselineHash, { hash: hash(), baselineHash });
  check('favorites-omos-generation-unchanged', finalConfig?.target?.generation === baselineGeneration, {
    generation: finalConfig?.target?.generation, baselineGeneration,
  });
  check('favorites-no-new-backup', backupCount() === startBackups, { backups: backupCount(), startBackups });
  check('favorites-storage-has-record', storageDocument()?.[FAVORITES_KEY]?.version === 1, { storagePath });

  const frameConsoleErrors = await browser.consoleErrors(context);
  check('favorites-no-frame-console-errors', frameConsoleErrors.length === 0, { frameConsoleErrors });

  return {
    checks,
    artifacts,
    context,
    initialStorage: storedModels(),
    finalState,
    frameConsoleErrors,
    baselineHash,
    finalHash: hash(),
    baselineGeneration,
    finalGeneration: finalConfig?.target?.generation ?? null,
    pageUrl: await browser.evaluate('location.href', { context }),
  };
};

/**
 * Load the page in one mobile/dark variant, optionally star one model through
 * a touch pointer, then capture the loaded favorites panel.
 */
export const runFavoritesVariant = async ({
  browser,
  context,
  label,
  mobile,
  dark,
  artifactsDir,
  starId = null,
}) => {
  const checks = {};
  const artifacts = [];
  const check = (name, condition, detail = null) => {
    checks[name] = { ok: Boolean(condition), ...(detail ? { detail } : {}) };
    if (!condition) throw new FavoritesFlowError('FAVORITES_VARIANT', `${label} favorites check failed: ${name}`, detail);
  };
  const pointerType = mobile ? 'touch' : 'mouse';
  const state = await waitForLoadedQueue(browser, context, { timeoutMs: 25_000 });
  const themeClass = await browser.evaluate('document.documentElement.className');
  check('variant-theme', !dark || /(^|\s)dark(\s|$)/.test(themeClass), { themeClass });
  check('variant-mobile', !mobile || /(^|\s)device-mobile(\s|$)/.test(themeClass), { themeClass });

  if (starId) {
    await openRowPicker(browser, context, 0, { pointerType });
    let picker = await waitForPicker(browser, context, (row) => row.visible && row.queryFocused, { label: `${label} model picker` });
    check('variant-picker-stars', picker.stars.length > 0, { stars: picker.stars });
    await browser.pointerClick(starSelector('.favorite-stars', starId), { context, pointerType });
    picker = await waitForPicker(browser, context, (row) => (
      row.stars.find((star) => star.id === starId)?.pressed === 'true'
    ), { label: `${label} touched star` });
    check('variant-touch-star', picker.stars.find((star) => star.id === starId)?.pressed === 'true', { stars: picker.stars });
    check('variant-touch-focus', picker.activeFavoriteId === starId, { activeFavoriteId: picker.activeFavoriteId });
    check('variant-favorites-first', picker.options[0]?.title === starId, { options: picker.options.slice(0, 3) });
    const shot = await browser.screenshot(path.join(artifactsDir, `favorites-picker-${label}.png`));
    artifacts.push({ name: `favorites-picker-${label}`, ...shot });
    await browser.pressKey('Escape', { context });
    await waitForPicker(browser, context, (row) => !row.visible, { label: `${label} closed picker` });
  }

  const panel = await openFavoritesPanel(browser, context, { pointerType });
  check('variant-panel-loaded', panel.panel && /^\d+ extension favorites?\b/.test(panel.localStatus || ''),
    { rows: panel.rows, status: panel.localStatus });
  check('variant-panel-source', panel.field != null, { field: panel.field });
  if (starId) {
    check('variant-star-persisted', panel.rows.some((row) => row.id === starId), { rows: panel.rows });
  }
  const shot = await browser.screenshot(path.join(artifactsDir, `favorites-panel-${label}.png`));
  artifacts.push({ name: `favorites-panel-${label}`, ...shot });
  const overflow = state.overflow;
  check('variant-no-global-overflow', overflow.documentWidth <= overflow.viewportWidth + 1, overflow);
  const frameConsoleErrors = await browser.consoleErrors(context);
  check('variant-no-console-errors', frameConsoleErrors.length === 0, { frameConsoleErrors });
  return { checks, artifacts, state: panel, themeClass, frameConsoleErrors };
};
