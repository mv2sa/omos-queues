/**
 * Real host-UI helpers for the extension page frame.
 *
 * Everything here runs against the frame the real OpenChamber host mounted at
 * /api/guest-files/...; there is no second host implementation or fake
 * connectHost bridge. Pointer and keyboard input go through WebDriver BiDi.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const waitForSettingsForm = (browser, context, { timeoutMs = 8_000 } = {}) => browser.waitForExpression(`(() => {
  const dialog = document.querySelector('dialog.editor-dialog[open]');
  const inputs = [...(dialog?.querySelectorAll('.settings-fields input') ?? [])];
  return inputs.length === 4 && inputs.every(input => !input.disabled);
})()`, { context, timeoutMs });

export const readUiState = async (browser, context) => {
  const raw = await browser.evaluate(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const text = (root, selector) => root?.querySelector(selector)?.textContent ?? null;
    const mainDialog = document.querySelector('dialog.editor-dialog:not(.favorite-import-dialog)');
    const importDialog = document.querySelector('dialog.favorite-import-dialog');
    const picker = document.querySelector('#omos-model-picker');
    const footer = document.querySelector('.save-bar');
    const selectedOutline = document.querySelector('.queue-nav [data-queue][aria-current="location"]');
    const workspaces = [...document.querySelectorAll('.queue-workspace')].map((node, order) => {
      const id = node.dataset.queueId ?? null;
      const name = node.querySelector('.queue-name');
      return {
         id,
        primary: node.dataset.primaryAgent || null,
        anchorId: node.id || null,
        order,
        name: name?.textContent ?? null,
        headingFocused: document.activeElement === name,
        context: node.querySelector('.queue-context')?.textContent ?? null,
        dirty: node.querySelector('.queue-dirty')?.textContent ?? null,
        inheritance: node.querySelector('.queue-context')?.textContent ?? null,
        readonly: node.querySelector(':scope > .status-box')?.textContent ?? null,
        addVisible: Boolean(node.querySelector('.queue-footer button')),
        rows: [...node.querySelectorAll('.model-row')].map((row) => {
          const modelButton = row.querySelector('[data-action="model"]');
          const variantButton = row.querySelector('[data-action="variant"]');
          const controls = row.querySelector('.model-controls');
          return {
            index: Number(row.dataset.index),
            text: row.innerText,
            model: modelButton?.innerText ?? null,
            variant: variantButton?.innerText ?? null,
            modelDisabled: Boolean(modelButton?.disabled),
            removeDisabled: Boolean(row.querySelector('[data-action="remove"], button[aria-label^="Remove "]')?.disabled),
            hasModelControls: Boolean(controls),
            controlsButtons: [...(controls?.querySelectorAll('button') ?? [])].map((button) => {
              const rect = button.getBoundingClientRect();
              return {
                action: button.dataset.action ?? null,
                aria: button.getAttribute('aria-label') ?? null,
                width: rect.width,
                height: rect.height,
                disabled: Boolean(button.disabled),
                intent: button.dataset.intent ?? null,
                color: getComputedStyle(button).color,
                background: getComputedStyle(button).backgroundColor,
              };
            }),
          };
        }),
      };
    });
    const selectedId = selectedOutline?.dataset.queue ?? null;
    const selected = workspaces.find((row) => row.id === selectedId) ?? workspaces[0] ?? null;
    const phoneTrigger = document.querySelector('.phone-selector .oc-sdk-trigger-value');
    const active = document.activeElement;
    const activeRow = active?.closest?.('.model-row');
    const activeWorkspace = active?.closest?.('.queue-workspace');
    const pickerOpen = Boolean(picker && !picker.hidden && visible(picker));
    const pickerRect = pickerOpen ? picker.getBoundingClientRect() : null;
    const footerRect = footer ? footer.getBoundingClientRect() : null;
    const viewport = window.visualViewport;
    return JSON.stringify({
      queueName: selected?.name ?? null,
      queueContext: selected?.context ?? null,
      target: text(document, '.target-path') ?? text(document, '.target-name'),
      targetPath: (() => {
        const trigger = document.querySelector('.target-trigger');
        const title = trigger?.getAttribute('title') || '';
        const match = /(?:Configuration file|Selected path|Resolved target):\s*(.+)/.exec(title);
        return match ? match[1].trim() : (text(document, '.target-path') ?? null);
      })(),
      scope: text(document, '.scope-label'),
      inheritance: selected?.inheritance ?? null,
      rows: selected?.rows ?? [],
      workspace: {
        count: workspaces.length,
        ids: workspaces.map((row) => row.id),
        anchors: workspaces.map((row) => row.anchorId),
        order: workspaces.map((row) => row.id),
        selectedId,
        selectedName: selected?.name ?? null,
        allMounted: workspaces.length > 0 && workspaces.every(row => row.anchorId
          && (row.id ? row.rows.length > 0 : Boolean(row.primary))),
        outlineCurrent: selectedOutline?.dataset.queue ?? null,
        phoneLabel: phoneTrigger?.textContent ?? null,
        phoneOptions: [...document.querySelectorAll('.phone-selector [role="option"]')].map((row) => row.textContent),
      },
      queues: workspaces,
      footer: {
        visible: visible(footer),
        text: footer?.innerText ?? null,
        dirty: text(footer, '.dirty-count'),
        detail: text(footer, '.save-detail'),
        draft: text(footer, '.draft-status'),
      },
      notice: (() => {
        const node = document.querySelector('.status-box.page-notice');
        return {
          hidden: node ? Boolean(node.hidden) : true,
          tone: node?.dataset.tone ?? null,
          text: node ? (node.textContent || '').trim() : null,
        };
      })(),
      copyAck: (() => {
        const node = document.querySelector('[data-queue-action="copy"][data-copied="true"]');
        return node ? { visible: visible(node), queueId: node.closest('.queue-workspace')?.dataset.queueId,
          announcement: text(document, '#omos-editor-status') } : null;
      })(),
      picker: {
        hidden: !pickerOpen,
        title: text(picker, '.picker-header .muted') ?? text(picker, '.picker-header .queue-name'),
        query: document.querySelector('#omos-model-picker .model-search input')?.value ?? null,
        focused: document.activeElement?.getAttribute('aria-label') ?? null,
        meta: text(picker, '.model-result-summary'),
        guidance: pickerOpen ? picker.innerText : '',
        useId: (() => {
          const button = picker?.querySelector('.picker-use-id button');
          return Boolean(visible(button) && !button.disabled);
        })(),
        list: [...document.querySelectorAll('#omos-model-picker .model-results [role="option"]')].map((row) => ({
          id: row.id,
          text: row.innerText,
          selected: row.getAttribute('aria-selected'),
        })),
        stars: [...document.querySelectorAll('#omos-model-picker .favorite-stars [data-favorite-id]')].map((button) => ({
          id: button.dataset.favoriteId ?? null,
          pressed: button.getAttribute('aria-pressed'),
          aria: button.getAttribute('aria-label'),
          focused: document.activeElement === button,
        })),
        rect: pickerRect ? { left: pickerRect.left, top: pickerRect.top, right: pickerRect.right, bottom: pickerRect.bottom, width: pickerRect.width, height: pickerRect.height } : null,
        dialog: picker?.matches('dialog') ?? false,
        open: picker?.matches('dialog') ? picker.open : null,
        side: picker?.dataset.side ?? null,
        footerTop: footerRect ? footerRect.top : null,
        viewport: { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
          left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 },
      },
      dialog: {
        open: Boolean(mainDialog?.open),
        mode: mainDialog?.dataset.dialogMode ?? null,
        title: text(mainDialog, '.dialog-title'),
        body: text(mainDialog, '.dialog-body'),
        actions: [...(mainDialog?.querySelectorAll('.dialog-actions button') ?? [])].map((button) => ({
          text: (button.innerText || '').trim(),
          disabled: Boolean(button.disabled),
          intent: button.dataset.intent ?? null,
          background: getComputedStyle(button).backgroundColor,
          color: getComputedStyle(button).color,
        })),
        diff: [...(mainDialog?.querySelectorAll('.dialog-body .diff') ?? [])].map((node) => node.innerText).join('\\n'),
      },
      importDialog: {
        open: Boolean(importDialog?.open),
        title: text(importDialog, '.dialog-title'),
        body: text(importDialog, '.dialog-body'),
        list: [...(importDialog?.querySelectorAll('.favorite-import-list li code') ?? [])].map((node) => node.textContent),
        actions: [...(importDialog?.querySelectorAll('.dialog-actions button') ?? [])].map((button) => ({
          text: (button.innerText || '').trim(), disabled: Boolean(button.disabled), intent: button.dataset.intent ?? null,
          background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color,
        })),
      },
      settings: {
        open: Boolean(mainDialog?.open && mainDialog?.querySelector('.settings-fields')),
        favoritesDetailsOpen: Boolean(document.querySelector('details.settings-favorites[open]')),
        favoritesPanelMounted: Boolean(document.querySelector('details.settings-favorites .favorites-panel')),
        fields: [...document.querySelectorAll('.settings-fields .oc-sdk-field')].map((field) => ({
          label: field.querySelector('.oc-sdk-field-label')?.textContent ?? null,
          value: field.querySelector('input, textarea')?.value ?? null,
          disabled: Boolean(field.querySelector('input, textarea')?.disabled),
        })),
      },
      catalog: text(document, '.catalog-row'),
      catalogError: {
        visible: visible(document.querySelector('.catalog-error')),
        text: text(document, '.catalog-error'),
        role: document.querySelector('.catalog-error')?.getAttribute('role') ?? null,
        tone: document.querySelector('.catalog-error')?.dataset.tone ?? null,
        color: document.querySelector('.catalog-error') ? getComputedStyle(document.querySelector('.catalog-error')).color : null,
      },
      loadState: {
        visible: visible(document.querySelector('.load-state')),
        text: text(document, '.load-state'),
        role: document.querySelector('.load-state p')?.getAttribute('role') ?? null,
      },
      emptyState: {
        visible: visible(document.querySelector('.empty-state')),
        text: text(document, '.empty-state'),
      },
      active: {
        tag: active?.tagName ?? null,
        aria: active?.getAttribute?.('aria-label') ?? null,
        text: (active?.innerText || '').trim().slice(0, 120),
        action: active?.dataset?.action ?? null,
        rowIndex: activeRow ? Number(activeRow.dataset.index) : null,
        queueId: activeWorkspace?.dataset?.queueId ?? null,
        isHeading: Boolean(active?.classList?.contains('queue-name')),
      },
      overflow: {
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      normalTextColor: getComputedStyle(document.body).color,
      warningColor: (() => {
        const node = document.querySelector('.status-box[data-tone="warning"], .queue-dirty');
        return node ? getComputedStyle(node).color : null;
      })(),
    });
  })()`, { context });
  return JSON.parse(raw);
};
export const waitForLoadedQueue = async (browser, context, { timeoutMs = 20_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readUiState(browser, context).catch((error) => ({ error: error.message }));
    if (last && !last.error && last.queueName && last.rows?.length > 0 && last.footer?.visible
      && last.workspace?.count > 0 && last.workspace?.allMounted) return last;
    if (last?.emptyState?.visible) {
      throw new Error(`The page reports no explicit queues: ${last.emptyState.text}`);
    }
    await sleep(200);
  }
  throw new Error(`The queue page did not finish loading: ${JSON.stringify(last)}`);
};

export const clickText = (browser, context, text, options = {}) => (
  browser.pointerClickText(text, { context, ...options })
);

const queueScope = (queueId) => (queueId ? `.queue-workspace[data-queue-id=${JSON.stringify(queueId)}] ` : '');

export const clickRowAction = (browser, context, index, action, queueId = null) => (
  browser.pointerClick(`${queueScope(queueId)}.model-row[data-index="${index}"] [data-action="${action}"]`, { context })
);

export const clickRemove = (browser, context, index, queueId = null) => (
  browser.pointerClick(`${queueScope(queueId)}.model-row[data-index="${index}"] button[aria-label^="Remove "]`, { context })
);

export const openExtensionPage = async (browser, { baseUrl, pageTitle, mobile = false, timeoutMs = 30_000 }) => {
  await browser.waitForExpression('document.body && document.body.innerText.length > 0', { timeoutMs });
  await sleep(900);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (mobile) {
        await browser.clickByAria('Open sessions and projects', { timeoutMs: 10_000 }).catch(() => {});
        await sleep(650);
        await browser.clickByAria('More', { timeoutMs: 10_000 }).catch(() => {});
        await sleep(650);
      } else {
        const titleLiteral = JSON.stringify(pageTitle);
        await browser.waitForExpression(`document.body.innerText.includes(${titleLiteral})`, { timeoutMs });
        await sleep(500);
      }
      await browser.pointerClickText(pageTitle, { context: browser.context, timeoutMs: 12_000 });
      const frame = await browser.waitForFrame('/api/guest-files/', { timeoutMs: 12_000 });
      await sleep(500);
      const current = (await browser.frames()).find((row) => row.url.includes('/api/guest-files/'));
      return current ?? frame;
    } catch (error) {
      lastError = error;
      await sleep(700);
    }
  }
  throw lastError ?? new Error('The extension page did not open');
};

export const waitForPickerCatalog = async (browser, context, ids, { timeoutMs = 15_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readUiState(browser, context);
    const listed = new Set((last.picker?.list ?? []).map((row) => (row.text || '').trim()));
    if (ids.every((id) => listed.has(id))) return last;
    await sleep(200);
  }
  throw new Error(`Picker catalog did not list ${ids.join(', ')}: ${JSON.stringify(last?.picker)}`);
};

export const hashFile = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

export const countBackups = (directory) => (
  fs.readdirSync(directory).filter((name) => name.includes('.bak.pre-ui-')).length
);

export const draftIdsFor = async (serviceJson, targetPath) => {
  const result = await serviceJson('GET', '/drafts');
  return (result?.drafts ?? []).filter((draft) => draft.targetPath === targetPath);
};

export const waitForDraft = async (serviceJson, targetPath, { timeoutMs = 8_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await draftIdsFor(serviceJson, targetPath).catch(() => []);
    if (last.length > 0) return last;
    await sleep(200);
  }
  throw new Error(`A real UI edit did not persist a draft for ${targetPath}: ${JSON.stringify(last)}`);
};

const domFailure = (name, message, detail) => {
  const error = new Error(message);
  error.code = `DOM_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  error.details = { check: name, ...detail };
  return error;
};

/**
 * Drive the real page controls for add/pick/edit/review/save/draft recovery.
 * Returns the state after recovery is discarded, so the caller can capture it.
 */
export const runDomWorkflow = async ({
  browser,
  context,
  scratchFile,
  artifactsDir,
  serviceJson,
  baseUrl,
  pageTitle,
}) => {
  const checks = {};
  const artifacts = [];
  const initialHash = hashFile(scratchFile);
  const backupsBefore = countBackups(fsSyncDirname(scratchFile));
  const beforeDraftIds = (await draftIdsFor(serviceJson, scratchFile)).map((draft) => draft.id);
  const allDrafts = async () => draftIdsFor(serviceJson, scratchFile);
  const config = await serviceJson('GET', '/config');
  const expectedGroups = (config.groups ?? []).map((group) => ({ id: group.id, name: group.name, label: group.label, path: group.path }));
  let queueId = null;

  const check = (name, condition, detail = null) => {
    checks[name] = { ok: Boolean(condition), ...(detail ? { detail } : {}) };
    if (!condition) throw domFailure(name, `DOM check failed: ${name}`, detail);
  };
  const capture = async (name) => {
    const shot = await browser.screenshot(pathJoin(artifactsDir, `${name}.png`));
    artifacts.push({ name, ...shot });
    return shot;
  };
  const stateNow = () => readUiState(browser, context);
  const waitFor = async (predicate, { timeoutMs = 10_000, intervalMs = 120 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await stateNow().catch(() => null);
      if (last && predicate(last)) return last;
      await sleep(intervalMs);
    }
    throw domFailure('wait', 'A DOM condition did not settle in time', { last });
  };
  const waitClean = () => waitFor((state) => (
    state.footer.visible
    && state.footer.dirty === 'No unsaved changes'
    && state.dialog.open === false
    && state.picker.hidden === true
  ), { timeoutMs: 12_000 });
  const openPickerFromRow = async (index) => {
    await clickRowAction(browser, context, index, 'model', queueId);
    await waitFor((state) => state.picker.hidden === false && state.picker.focused === 'Search or enter model ID');
  };
  const chooseModel = async (modelId) => {
    await browser.typeText(modelId, { context });
    await waitFor((state) => state.picker.list.some((row) => (row.text || '').trim() === modelId), { timeoutMs: 10_000 });
    await browser.pressKey('Enter', { context });
    await waitFor((state) => state.picker.hidden === true && state.dialog.open === false, { timeoutMs: 10_000 });
  };
  const clickAdd = () => browser.pointerClick(`.queue-workspace[data-queue-id=${JSON.stringify(queueId)}] .queue-footer button`, { context });
  const queueAction = (id, action) => `.queue-workspace[data-queue-id=${JSON.stringify(id)}] [data-queue-action="${action}"]`;
  const navigateQueue = async id => {
    await browser.pointerClick(`.queue-nav [data-queue=${JSON.stringify(id)}]`, { context });
    return waitFor(row => row.workspace.selectedId === id);
  };
  const chooseVariant = async (index, label) => {
    const scope = `.queue-workspace[data-queue-id=${JSON.stringify(queueId)}] .model-row[data-index="${index}"] .variant-cell`;
    // Real pointer selection through the shared SDK-select helper: it settles
    // the row before opening and never scrolls the page while the popup is open.
    await browser.selectSdkOption(scope, label, { context, pointer: true });
    await waitFor((state) => state.rows[index]?.variant === label, { timeoutMs: 10_000 });
  };

  let state = await waitForLoadedQueue(browser, context, { timeoutMs: 25_000 });
  queueId = state.workspace.selectedId;
  check('loaded-queue-name', state.queueName === 'reviewer', { queueName: state.queueName });
  check('loaded-model-rows', state.rows.length === 2 && state.rows.every((row) => row.model), { rows: state.rows });
  check('loaded-footer', state.footer.visible && state.footer.dirty === 'No unsaved changes', { footer: state.footer });
  check('explicit-target', state.targetPath === scratchFile, { target: state.target, targetPath: state.targetPath, scratchFile });
  check('no-global-horizontal-overflow', state.overflow.documentWidth <= state.overflow.viewportWidth + 1, state.overflow);
  check('catalog-ready', /models/.test(state.catalog || ''), { catalog: state.catalog });
  check('workspace-all-queues-present', state.workspace.count >= expectedGroups.length
    && expectedGroups.every((group) => state.workspace.ids.includes(group.id)), {
    ids: state.workspace.ids, expectedOrdinary: expectedGroups.map((group) => group.id),
  });
  check('display-only-primary-queues-last', state.queues.at(-1)?.primary === 'orchestrator' && !state.queues.some(row => row.primary === 'build'), {
    names: state.queues.map(row => row.name),
  });
  check('workspace-stable-file-order', expectedGroups.every((group, index) => (
    state.workspace.ids.indexOf(group.id) >= 0
      && (index === 0 || state.workspace.ids.indexOf(group.id) > state.workspace.ids.indexOf(expectedGroups[index - 1].id))
  )), { ids: state.workspace.ids, expected: expectedGroups.map((group) => group.id) });
  check('workspace-outline-current', state.workspace.outlineCurrent === queueId && state.workspace.selectedId === queueId, {
    current: state.workspace.outlineCurrent, selected: state.workspace.selectedId,
  });
  check('workspace-phone-label', (state.workspace.phoneLabel || '').includes('reviewer'), { phoneLabel: state.workspace.phoneLabel });
  const firstRemove = state.rows[0]?.controlsButtons.find((button) => /^Remove /.test(button.aria || ''));
  check('remove-destructive-intent', firstRemove?.intent === 'destructive', { remove: firstRemove });
  const reviewerRowsBeforeJump = state.rows;
  const reviewerId = queueId;
  const plannerGroup = expectedGroups.find((group) => group.name === 'planner');
  if (plannerGroup) {
    await clickText(browser, context, 'planner');
    state = await waitFor((row) => row.workspace.selectedId === plannerGroup.id);
    check('jump-offscreen-heading-focus', state.active.isHeading && state.active.text === 'planner'
      && state.workspace.outlineCurrent === plannerGroup.id, { active: state.active, workspace: state.workspace });
    check('jump-keeps-all-workspaces', state.workspace.count >= expectedGroups.length
      && expectedGroups.every(group => state.workspace.ids.includes(group.id))
      && state.queues.find((row) => row.id === reviewerId)?.rows?.[0]?.model === reviewerRowsBeforeJump[0].model, {
      ids: state.workspace.ids, reviewer: state.queues.find((row) => row.id === reviewerId),
    });
    await clickText(browser, context, 'reviewer');
    state = await waitFor((row) => row.workspace.selectedId === reviewerId);
    queueId = reviewerId;
  }
  await capture('ui-workspace-list');

  // Header file disclosure: keyboard activation, path text, focus restore.
  await browser.evaluate(`document.querySelector('.target-trigger')?.focus()`, { context });
  await browser.pressKey('Enter', { context });
  state = await waitFor((row) => row.dialog.open === true && row.dialog.title === 'Global OMOS file');
  check('file-disclosure-keyboard', (state.dialog.body || '').includes(scratchFile), { dialog: state.dialog });
  await capture('ui-file-disclosure');
  await browser.pressKey('Escape', { context });
  state = await waitFor((row) => row.dialog.open === false);
  check('file-disclosure-focus-restore', (state.active.aria || '').includes('Show global OMOS file details'), { active: state.active });
  await capture('ui-loaded');

  // Add -> Back: no row, no dirty footer, no draft. The fixed model popup
  // must leave every queue mounted and stay inside the visual viewport.
  // A modal makes the workspace inert and can change focus/hover paint.
  // Compare every row's editable identity and value, not its computed colors.
  const positions = rows => rows.map(({ index, model, variant, modelDisabled, removeDisabled }) =>
    ({ index, model, variant, modelDisabled, removeDisabled }));
  const rowsBeforePicker = positions(state.rows);
  const workspacesBeforePicker = state.workspace.ids;
  await clickAdd();
  state = await waitFor((row) => row.picker.hidden === false && row.picker.focused === 'Search or enter model ID');
  check('add-position-opens-picker', /position 3/i.test(state.picker.title || ''), { picker: state.picker });
  check('picker-keeps-workspaces-mounted', JSON.stringify(state.workspace.ids) === JSON.stringify(workspacesBeforePicker)
    && JSON.stringify(positions(state.rows)) === JSON.stringify(rowsBeforePicker), { ids: state.workspace.ids, rows: positions(state.rows), before: rowsBeforePicker });
  const insideViewport = (picker) => Boolean(picker.rect && picker.viewport && (
    picker.rect.left >= picker.viewport.left - 1
    && picker.rect.top >= picker.viewport.top - 1
    && picker.rect.right <= picker.viewport.left + picker.viewport.width + 1
    && picker.rect.bottom <= picker.viewport.top + picker.viewport.height + 1
  ));
  check('picker-dialog-fills-viewport', state.picker.dialog && state.picker.open && state.picker.rect
    && Math.abs(state.picker.rect.width - state.picker.viewport.width) <= 2
    && Math.abs(state.picker.rect.height - state.picker.viewport.height) <= 2, { picker: state.picker });
  await browser.setViewport(1024, 720, 1);
  await sleep(350);
  state = await waitFor((row) => row.picker.hidden === false && row.picker.focused === 'Search or enter model ID');
  check('picker-resize-reflow', state.picker.dialog && state.picker.open && insideViewport(state.picker)
    && state.picker.query === '' && state.active.aria === 'Search or enter model ID', {
    picker: state.picker, active: state.active,
  });
  await browser.setViewport(1280, 800, 1);
  await sleep(250);
  await clickText(browser, context, 'Cancel');
  state = await waitFor((row) => row.picker.hidden === true);
  check('add-back-keeps-rows', state.rows.length === 2, { rows: state.rows });
  check('add-back-clean', state.footer.dirty === 'No unsaved changes', { footer: state.footer });
  check('clean-footer-not-duplicated', !/No pending draft|Changes require review/.test(state.footer.text || ''), { footer: state.footer });
  await sleep(900);
  const afterBackDrafts = await allDrafts();
  check('add-back-writes-no-draft', afterBackDrafts.length === beforeDraftIds.length, { drafts: afterBackDrafts.map((draft) => draft.id) });

  // Escape cancels the choice and restores focus even with a nonempty search.
  await openPickerFromRow(0);
  await browser.typeText('synthetic', { context });
  state = await waitFor((row) => row.picker.query === 'synthetic' && row.picker.list.length > 0);
  check('partial-search-only-shows-matches', !/not in the catalog|complete provider\/model/i.test(state.picker.guidance)
    && !state.picker.useId, { picker: state.picker });
  await browser.pressKey('Escape', { context });
  state = await waitFor((row) => row.picker.hidden === true);
  check('escape-cancels-picker', state.picker.hidden === true && state.footer.dirty === 'No unsaved changes', { picker: state.picker });
  check('escape-restores-row-focus', state.active.action === 'model' && state.active.rowIndex === 0, { active: state.active });

  await openPickerFromRow(0);
  await browser.typeText('zzquietmanual', { context });
  state = await waitFor((row) => row.picker.query === 'zzquietmanual' && row.picker.list.length === 0);
  check('incomplete-no-match-single-format-hint', (state.picker.guidance.match(/provider\/model/g) || []).length === 1
    && !state.picker.useId, { picker: state.picker });
  await browser.typeText('/manual-id', { context });
  state = await waitFor((row) => row.picker.query === 'zzquietmanual/manual-id');
  check('valid-typed-id-can-be-used', state.picker.list.length === 0 && state.picker.useId
    && !/complete provider\/model|not in the catalog/i.test(state.picker.guidance), { picker: state.picker });
  await browser.pressKey('Escape', { context });
  await waitClean();

  // Enter chooses the first result for a broad query, then the exact result when typed.
  await clickAdd();
  await waitForPickerCatalog(browser, context, ['synthetic/provider-alpha', 'synthetic/provider-beta', 'synthetic/provider-gamma']);
  await capture('ui-picker');
  await browser.typeText('synthetic/', { context });
  await waitFor((row) => row.picker.list.length >= 3);
  await browser.pressKey('Enter', { context });
  state = await waitFor((row) => row.picker.hidden === true && row.rows.length === 3, { timeoutMs: 10_000 });
  check('enter-chooses-first-result', state.rows[2].model === 'synthetic/provider-alpha', { rows: state.rows });
  check('enter-focuses-new-row-model', state.active.action === 'model' && state.active.rowIndex === 2, { active: state.active });

  await clickRowAction(browser, context, 2, 'model', queueId);
  await waitFor((row) => row.picker.hidden === false);
  await chooseModel('synthetic/provider-beta');
  state = await waitFor((row) => row.rows.length === 3 && row.rows[2].model === 'synthetic/provider-beta', { timeoutMs: 10_000 });
  check('enter-chooses-exact-result-not-second', state.rows[2].model === 'synthetic/provider-beta', { rows: state.rows });

  // Move and remove retain focus on the control the user acted on.
  await clickRowAction(browser, context, 2, 'up', queueId);
  state = await waitFor((row) => row.rows[1].model === 'synthetic/provider-beta');
  check('move-up-focus', state.active.action === 'up' && state.active.rowIndex === 1, { active: state.active });
  await clickRowAction(browser, context, 1, 'down', queueId);
  state = await waitFor((row) => row.rows[2].model === 'synthetic/provider-beta');
  check('move-down-focus', state.active.rowIndex === 2 && ['down', 'model'].includes(state.active.action), { active: state.active });
  await clickRemove(browser, context, 2, queueId);
  state = await waitFor((row) => row.rows.length === 2);
  check('remove-focus', state.active.action === 'model' && state.active.rowIndex === 1, { active: state.active });
  check('remove-returns-clean', state.footer.dirty === 'No unsaved changes', { footer: state.footer });

  // Variant-only edit makes discard available.
  await chooseVariant(0, 'high');
  state = await waitFor((row) => row.rows[0].variant === 'high');
  await browser.pressKey('Escape', { context }).catch(() => {});
  check('variant-only-edit', state.rows[0].model === 'anthropic/claude-sonnet-4-5:high' && state.rows[0].variant === 'high', { rows: state.rows });
  check('variant-marks-dirty', state.footer.dirty === '1 queue changed', { footer: state.footer });
  // Copy and paste positions across queues; cancellation precedes confirmation.
  const sourceQueueId = queueId;
  const sourcePositions = positions(state.rows);
  const sourceLabel = state.queueName;
  const pasteHashBefore = hashFile(scratchFile);
  const pasteBackupsBefore = countBackups(fsSyncDirname(scratchFile));
  await browser.pointerClick(queueAction(sourceQueueId, 'copy'), { context });
  state = await waitFor((row) => row.copyAck?.visible === true && /^Copied /.test(row.copyAck.announcement || ''), {
    timeoutMs: 10_000,
  });
  check('copy-ack-local-no-banner', state.copyAck.queueId === sourceQueueId && state.notice.hidden,
    { status: state.copyAck, notice: state.notice, sourceQueueId, sourceLabel });
  const buildGroup = expectedGroups.find((group) => group.name === 'planner');
  await navigateQueue(buildGroup.id);
  state = await waitFor((row) => row.workspace.selectedId === buildGroup?.id);
  queueId = buildGroup?.id ?? state.workspace.selectedId;
  const destinationBefore = state;
  check('destination-identity-before-paste', destinationBefore.queueName === 'planner', { queueName: destinationBefore.queueName });
  check('destination-differs-source', queueId !== sourceQueueId, { sourceQueueId, destinationQueueId: queueId });
  check('jump-build-keeps-reviewer-mounted', state.workspace.count >= expectedGroups.length
    && state.queues.find((row) => row.id === reviewerId)?.rows?.[0]?.model === reviewerRowsBeforeJump[0].model, {
    ids: state.workspace.ids,
  });
  check('paste-action-enabled', await browser.evaluate(`document.querySelector(${JSON.stringify(queueAction(queueId, 'paste'))})?.getAttribute('aria-disabled') === 'false'`, { context }));
  await browser.pointerClick(queueAction(queueId, 'paste'), { context });
  const pasteOpen = row => row.dialog.open && row.dialog.title?.startsWith('Replace ')
    && row.dialog.actions.some(action => action.text === 'Replace draft positions');
  state = await waitFor(pasteOpen);
  check('paste-confirm-specific', state.dialog.title.includes(sourceLabel) && state.dialog.title.includes('planner')
    && state.dialog.title.includes(`${sourcePositions.length} position`) && !state.dialog.body?.trim()
    && state.dialog.actions.some(action => action.text === 'Cancel')
    && state.dialog.actions.some(action => action.text === 'Replace draft positions'),
    { dialog: state.dialog });
  check('paste-dialog-not-document', state.dialog.mode !== 'document', { mode: state.dialog.mode });
  await clickText(browser, context, 'Cancel');
  state = await waitFor((row) => !row.dialog.open);
  check('paste-cancel-keeps-destination', state.workspace.selectedId === queueId
    && JSON.stringify(positions(state.rows)) === JSON.stringify(positions(destinationBefore.rows))
    && state.queueName === destinationBefore.queueName && state.inheritance === destinationBefore.inheritance
    && hashFile(scratchFile) === pasteHashBefore && countBackups(fsSyncDirname(scratchFile)) === pasteBackupsBefore,
    { before: destinationBefore, after: state });
  await browser.pointerClick(queueAction(queueId, 'paste'), { context });
  await waitFor(pasteOpen);
  await clickText(browser, context, 'Replace draft positions');
  state = await waitFor((row) => !row.dialog.open && JSON.stringify(positions(row.rows)) === JSON.stringify(sourcePositions));
  check('paste-applies-source-positions', JSON.stringify(positions(state.rows)) === JSON.stringify(sourcePositions)
    && state.queueName === destinationBefore.queueName && state.workspace.selectedId === queueId
    && state.inheritance?.split(' · ').filter(part => part.startsWith('Default variant:')).join() ===
      destinationBefore.inheritance?.split(' · ').filter(part => part.startsWith('Default variant:')).join()
    && state.footer.dirty === '2 queues changed'
    && state.queues.find(queue => queue.id === reviewerId)?.dirty === 'Unsaved changes',
    { rows: state.rows, footer: state.footer });
  check('paste-no-write-no-banner', hashFile(scratchFile) === pasteHashBefore
    && countBackups(fsSyncDirname(scratchFile)) === pasteBackupsBefore
    && state.notice.hidden,
    { notice: state.notice, hash: hashFile(scratchFile), backups: countBackups(fsSyncDirname(scratchFile)) });
  // Paste made the second queue dirty. Reset that queue only, then stage a
  // different planner variant for the same two-queue review.
  await browser.pointerClick(queueAction(buildGroup.id, 'reset'), { context });
  state = await waitFor(row => row.dialog.open && /^Reset edits to/.test(row.dialog.title || ''));
  await clickText(browser, context, 'Reset queue');
  state = await waitFor(row => !row.dialog.open && row.queues.find(queue => queue.id === buildGroup.id)?.dirty !== 'Unsaved changes');
  check('scoped-reset-preserves-first-dirty', state.queues.find(queue => queue.id === reviewerId)?.dirty === 'Unsaved changes'
    && state.queues.find(queue => queue.id === buildGroup.id)?.dirty !== 'Unsaved changes', { queues: state.queues.map(q => ({ id:q.id, dirty:q.dirty })) });
  queueId = buildGroup.id;
  await chooseVariant(0, 'high');
  state = await waitFor(row => row.rows[0]?.variant === 'high' && row.footer.dirty === '2 queues changed');
  await clickText(browser, context, 'reviewer');
  state = await waitFor((row) => row.workspace.selectedId === reviewerId);
  queueId = reviewerId;

  // New model + variant for the reviewed save.
  await clickAdd();
  await waitFor((row) => row.picker.hidden === false);
  await chooseModel('synthetic/provider-beta');
  await browser.pressKey('Escape', { context }).catch(() => {});
  await chooseVariant(2, 'low');
  state = await waitFor((row) => row.rows[2].variant === 'low');
  check('edit-before-review', state.rows[2].model === 'synthetic/provider-beta' && state.rows[2].variant === 'low', { rows: state.rows });
  const buildDraftRows = state.queues.find((queue) => queue.id === buildGroup?.id)?.rows ?? [];
  await openPickerFromRow(0);
  state = await waitFor((row) => row.picker.hidden === false);
  check('picker-keeps-other-draft-rows', state.rows.length === 3
    && JSON.stringify(positions(state.queues.find((queue) => queue.id === buildGroup?.id)?.rows ?? [])) === JSON.stringify(positions(buildDraftRows))
    && expectedGroups.every(group => state.workspace.ids.includes(group.id)), {
    ids: state.workspace.ids, buildRows: state.queues.find((queue) => queue.id === buildGroup?.id)?.rows,
  });
  await browser.pressKey('Escape', { context });
  state = await waitFor((row) => row.picker.hidden === true);
  const beforeReviewHash = hashFile(scratchFile);
  const beforeReviewBackups = countBackups(fsSyncDirname(scratchFile));
  check('review-dirty-footer', state.footer.dirty === '2 queues changed', { footer: state.footer });

  await clickText(browser, context, 'Review changes');
  state = await waitFor((row) => row.dialog.open === true && row.dialog.title === 'Review all changes');
  check('review-document-mode-no-generic-comments-warning', state.dialog.mode === 'document'
    && !/comments inside changed values/i.test(state.dialog.body || ''), { dialog: state.dialog });
  check('review-diff-has-model', (state.dialog.diff || '').includes('synthetic/provider-beta'), { diff: state.dialog.diff });
  check('review-batch-both-queues', (state.dialog.diff || '').includes('synthetic/provider-beta')
    && state.dialog.diff.includes('planner') && state.dialog.diff.includes('reviewer'), { diff: state.dialog.diff });
  const confirmAction = state.dialog.actions.find((action) => action.text === 'Confirm and save');
  const backAction = state.dialog.actions.find((action) => action.text === 'Back to editing');
  check('confirm-positive-intent', confirmAction?.intent === 'positive' && backAction?.intent === 'neutral', {
    confirm: confirmAction, back: backAction,
  });
  check('confirm-not-warning-color', Boolean(confirmAction?.background) && confirmAction.background !== state.warningColor, {
    background: confirmAction?.background, warning: state.warningColor,
  });
  check('review-does-not-write', hashFile(scratchFile) === beforeReviewHash && countBackups(fsSyncDirname(scratchFile)) === beforeReviewBackups, {
    hash: hashFile(scratchFile), beforeReviewHash, backups: countBackups(fsSyncDirname(scratchFile)), beforeReviewBackups,
  });
  await capture('ui-review');
  await clickText(browser, context, 'Back to editing');
  await waitFor((row) => row.dialog.open === false);
  state = await stateNow();
  check('back-to-editing-keeps-dirty', state.footer.dirty === '2 queues changed', { footer: state.footer });
  check('review-back-does-not-write', hashFile(scratchFile) === beforeReviewHash
    && countBackups(fsSyncDirname(scratchFile)) === beforeReviewBackups);

  await clickText(browser, context, 'Review changes');
  await waitFor((row) => row.dialog.open === true && row.dialog.title === 'Review all changes');
  await clickText(browser, context, 'Confirm and save');
  state = await waitClean();
  const savedText = fs.readFileSync(scratchFile, 'utf8');
  check('save-changed-file', savedText.includes('synthetic/provider-beta') && /openai\/gpt-5\.1/.test(savedText), { file: savedText.slice(0, 1_000) });
  check('save-created-backup', countBackups(fsSyncDirname(scratchFile)) === beforeReviewBackups + 1, {
    backups: countBackups(fsSyncDirname(scratchFile)), beforeReviewBackups,
  });
  check('save-footer-clean', state.footer.dirty === 'No unsaved changes', { footer: state.footer });
  await capture('desktop-light');

  // Real UI draft, reload, recovery.
  const beforeDraftHash = hashFile(scratchFile);
  await openPickerFromRow(0);
  await chooseModel('synthetic/provider-gamma');
  const draftIds = await waitForDraft(serviceJson, scratchFile);
  const draftHash = hashFile(scratchFile);
  check('draft-created', draftIds.length > 0, { drafts: draftIds.map((draft) => draft.id) });
  check('draft-does-not-write', draftHash === beforeDraftHash, { draftHash, beforeDraftHash });

  const reloaded = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false, timeoutMs: 30_000 });
  context = reloaded.context;
  state = await waitForLoadedQueue(browser, context, { timeoutMs: 20_000 });
  check('reload-keeps-saved-value', state.rows[0].model === 'anthropic/claude-sonnet-4-5:high', { rows: state.rows });
  check('stale-draft-not-autoapplied', !state.rows.some((row) => row.model === 'synthetic/provider-gamma'), { rows: state.rows });
  const draftButton = await browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => /^Drafts \\(\\d+\\)$/.test((item.innerText || '').trim())); return button ? (button.innerText || '').trim() : null; })()`, { context });
  check('draft-button-visible', Boolean(draftButton), { draftButton, state });
  if (!draftButton) throw domFailure('draft-button', 'No real Drafts button appeared after reload', { state });
  await clickText(browser, context, draftButton);
  state = await waitFor((row) => row.dialog.open === true && row.dialog.title === 'Stored drafts');
  check('draft-dialog-matches', (state.dialog.body || '').includes('Matches current file'), { dialog: state.dialog });
  await clickText(browser, context, 'Recover a copy');
  state = await waitFor((row) => row.dialog.open === false && row.rows[0].model === 'synthetic/provider-gamma');
  check('recover-restores-edit', state.rows[0].model === 'synthetic/provider-gamma', { rows: state.rows });
  check('recover-does-not-write', hashFile(scratchFile) === draftHash, { hash: hashFile(scratchFile), draftHash });
  const retainedIds = new Set((await allDrafts()).map(record => record.id));
  check('recover-copy-keeps-source-and-no-banner', draftIds.every(original => retainedIds.has(original.id))
    && !/draft was recovered/i.test(state.notice.hidden ? '' : state.notice.text || ''), { notice: state.notice });
  await capture('ui-draft-recovered');

  await browser.pointerClick(queueAction(reviewerId, 'reset'), { context });
  state = await waitFor((row) => row.dialog.open && row.dialog.title?.startsWith('Reset edits to'));
  await clickText(browser, context, 'Reset queue');
  state = await waitClean();
  check('discard-recovered-clean', state.footer.dirty === 'No unsaved changes', { footer: state.footer });
  check('discard-does-not-write', hashFile(scratchFile) === draftHash, { hash: hashFile(scratchFile), draftHash });

  // Optional bounded lost-ack scenario: forward the real commit through the
  // host page's fetch, receive the response, then throw once before the bridge
  // acknowledgement. The page must show unknown, not retry, and reconcile the
  // file that actually changed.
  let lostAck = { status: 'not-attempted' };
  try {
    await openPickerFromRow(0);
    await chooseModel('synthetic/provider-gamma');
    await clickText(browser, context, 'Review changes');
    await waitFor((row) => row.dialog.open === true && row.dialog.title === 'Review all changes');
    const lostHashBefore = hashFile(scratchFile);
    const lostBackupsBefore = countBackups(fsSyncDirname(scratchFile));
    const patched = await browser.evaluate(`(() => {
      const original = window.fetch;
      window.__omosLostAck = { used: false, original };
      window.fetch = async (...args) => {
        const [input, init] = args;
        const body = typeof init?.body === 'string' ? init.body : '';
        if (!window.__omosLostAck.used && String(input).includes('/service/request') && body.includes('"path":"/commit"')) {
          window.__omosLostAck.used = true;
          await original(...args);
          throw new Error('isolated test: lost bridge acknowledgement');
        }
        return original(...args);
      };
      return true;
    })()`);
    if (!patched) throw new Error('could not install isolated fetch wrapper');
    await clickText(browser, context, 'Confirm and save');
    let unknown = false;
    const unknownDeadline = Date.now() + 12_000;
    while (Date.now() < unknownDeadline) {
      state = await stateNow();
      if (/Save outcome unknown/i.test(state.footer.detail || '')) { unknown = true; break; }
      if (state.dialog.open === false && state.footer.dirty === 'No unsaved changes') break;
      await sleep(200);
    }
    const used = await browser.evaluate('window.__omosLostAck?.used === true');
    const lostHashAfter = hashFile(scratchFile);
    const lostBackupsAfter = countBackups(fsSyncDirname(scratchFile));
    if (!used) {
      lostAck = { status: 'unverified', reason: 'The host did not route the commit through the isolated window.fetch wrapper', unknown };
    } else if (!unknown) {
      lostAck = { status: 'unverified', reason: 'The commit ran but the page did not enter the unknown state', unknown };
    } else {
      check('lost-ack-unknown', unknown, { footer: state.footer });
      check('lost-ack-real-commit', lostHashAfter !== lostHashBefore && lostBackupsAfter === lostBackupsBefore + 1, {
        lostHashBefore, lostHashAfter, lostBackupsBefore, lostBackupsAfter,
      });
      await sleep(1_500);
      check('lost-ack-no-auto-retry', hashFile(scratchFile) === lostHashAfter && countBackups(fsSyncDirname(scratchFile)) === lostBackupsAfter, {
        hash: hashFile(scratchFile), backups: countBackups(fsSyncDirname(scratchFile)),
      });
      await clickText(browser, context, 'Check file outcome');
      state = await waitFor((row) => !/Save outcome unknown/i.test(row.footer.detail || ''), { timeoutMs: 12_000 });
      check('lost-ack-reconciles-saved', hashFile(scratchFile) === lostHashAfter && !/Save outcome unknown/i.test(state.footer.detail || ''), {
        hash: hashFile(scratchFile), footer: state.footer,
      });
      lostAck = { status: 'passed', unknown, lostHashBefore, lostHashAfter, lostBackupsBefore, lostBackupsAfter };
    }
  } catch (error) {
    lostAck = { status: 'unverified', reason: error.message };
  } finally {
    try {
      await browser.evaluate(`(() => { if (window.__omosLostAck?.original) window.fetch = window.__omosLostAck.original; return true; })()`);
    } catch { /* page may have navigated */ }
  }

  const frameConsoleErrors = await browser.consoleErrors(context);
  const hostConsoleErrors = await browser.consoleErrors(browser.context);
  check('no-frame-console-errors', frameConsoleErrors.length === 0, { frameConsoleErrors });

  return {
    checks,
    artifacts,
    context,
    childUrl: await browser.evaluate('location.href', { context }),
    initialHash,
    finalHash: hashFile(scratchFile),
    backupsBefore,
    backupsAfter: countBackups(fsSyncDirname(scratchFile)),
    draftIds: draftIds.map((draft) => draft.id),
    lostAck,
    frameConsoleErrors,
    hostConsoleErrors,
    finalState: state,
  };
};

const fsSyncDirname = (filePath) => {
  const separator = filePath.lastIndexOf('/');
  return separator > 0 ? filePath.slice(0, separator) : '.';
};

const pathJoin = (directory, name) => `${directory.replace(/\/+$/, '')}/${name}`;
