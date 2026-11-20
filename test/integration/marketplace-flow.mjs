/**
 * Actual stock-host marketplace vertical slice for the isolated integration lane.
 *
 * Synthetic installed-store fixture + real service routes + real extension UI.
 * No OMOS runtime/store import, no package install, no network, no provider and
 * no live configuration: everything runs under the caller's owned synthetic
 * HOME/XDG/data/target.
 *
 * This module has no top-level filesystem or process side effects so packaging
 * tests can import it and compile its browser expressions without a DOM.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

import { openExtensionPage, readUiState, waitForSettingsForm } from './ui-flow.mjs';

export const JANITOR_ID = 'fixture/janitor';
export const CHRONICLER_ID = 'acme/chronicler';
export const PRESET = 'flat';
export const STRUCTURED_PRESET = 'solo';
export const LEGACY_PRESET = 'legacy';
export const UNKNOWN_SELECTION = 'unknown/retained';
export const OVERRIDE_MODEL = 'synthetic/provider-alpha';
export const ORDINARY_MODEL = 'openai/gpt-5.1:low';
export const DEFAULT_VARIANT = 'high';

export class MarketplaceFlowError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'MarketplaceFlowError';
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const canonical = (value, ancestors = new Set(), depth = 0) => {
  if (depth > 64) throw new Error('Canonical JSON nesting is too deep.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON does not support non-finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('Canonical JSON only supports JSON values.');
  if (ancestors.has(value)) throw new Error('Canonical JSON does not support cycles.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, ancestors, depth + 1)).join(',')}]`;
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort(compareCodeUnits)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key], ancestors, depth + 1)}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
};

/** Fixture-only canonical bundle digest (contract domain marketplace-agent-bundle-v3). */
export const marketplaceBundleDigest = (bundle) => (
  createHash('sha256').update(canonical(bundle), 'utf8').digest('hex')
);

const packageManifest = ({ id, version, agentName, displayName, canary }) => ({
  schemaVersion: 3,
  id,
  version,
  agentName,
  displayName,
  description: `Synthetic ${displayName} fixture ${canary}`,
  prompt: `SYNTHETIC_PROMPT_CANARY_${canary}`,
  tools: [`synthetic_tool_${canary}`],
  mcp: [{ name: `synthetic_mcp_${canary}` }],
  model: { source: 'session' },
});

/** Write the owned synthetic store: lock.json, bundles, sidecars, empty lease dir. */
export function writeMarketplaceStore({ root, canary = 'MKP' }) {
  const packages = [
    { id: JANITOR_ID, version: '1.0.0', agentName: 'janitor', displayName: 'Janitor' },
    { id: CHRONICLER_ID, version: '1.0.0', agentName: 'chronicler', displayName: 'Chronicler' },
  ];
  const lock = { schemaVersion: 2, packages: {} };
  const written = [];
  for (const spec of packages) {
    const manifest = packageManifest({ ...spec, canary });
    const bundle = { manifest };
    const digest = marketplaceBundleDigest(bundle);
    const [publisher, name] = spec.id.split('/');
    const dir = path.join(root, 'packages', publisher, name, spec.version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(bundle, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'sha256'), `${digest}\n`);
    lock.packages[spec.id] = {
      manifestSchemaVersion: 3,
      manifestVersion: spec.version,
      source: { kind: 'in-memory', label: 'synthetic' },
      digest: { algorithm: 'sha256', domain: 'marketplace-agent-bundle-v3', value: digest },
    };
    written.push({ id: spec.id, version: spec.version, digest, bundlePath: path.join(dir, 'package.json') });
  }
  fs.writeFileSync(path.join(root, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  // The real OMOS store keeps marketplace.lock as a permanent lease container
  // directory; an empty one is the ready state this slice must handle.
  fs.mkdirSync(path.join(root, 'marketplace.lock'), { recursive: true });
  return { root, lock, packages: written };
}

/** Write the synthetic global OMOS JSONC target with canaries and preservation cases. */
export function writeMarketplaceConfig({ file, canaries }) {
  const text = `{
  // Synthetic global OMOS target for the isolated marketplace proof.
  "unrelatedRootCanary": ${JSON.stringify(canaries.root)},
  "presets": {
    "flat": {
      "neighbor": {
        "model": "openai/gpt-5.1:low",
        "prompt": ${JSON.stringify(canaries.neighbor)}
      },
      "docs": {
        "model": "anthropic/claude-sonnet-4-5",
        "description": ${JSON.stringify(canaries.docs)}
      }
    },
    "solo": {
      "agents": {
        "reviewer": {
          "model": [
            "anthropic/claude-sonnet-4-5:high",
            { "id": "openai/gpt-5.1", "variant": "low" }
          ],
          "variant": "high",
          "description": ${JSON.stringify(canaries.reviewer)}
        },
        "docs-writer": {
          "model": "anthropic/claude-sonnet-4-5"
        }
      }
    },
    "legacy": {
      "marketplace": { "agents": ["${UNKNOWN_SELECTION}"] },
      "janitor": { "model": "synthetic/custom-janitor" },
      "keep": {
        "model": "openai/gpt-5.1:low",
        "prompt": ${JSON.stringify(canaries.legacy)}
      }
    }
  },
  "agents": {
    "build": {
      "model": "openai/gpt-5.1:low",
      "prompt": ${JSON.stringify(canaries.build)}
    }
  }
}
`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { text, expected: { creationModelIndent: 8, selectionItemIndent: 10 } };
}

const pngInfo = (filePath) => {
  const bytes = fs.readFileSync(filePath);
  return { path: filePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: bytes.subarray(0, 8).toString('hex') };
};

export const hashMarketplaceTree = (root) => {
  const rows = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) rows.push({ path: path.relative(root, full), sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
    }
  };
  walk(root);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};

/** One VM-compilable expression for the marketplace page + source settings + queue state. */
export const readMarketplaceState = async (browser, context) => JSON.parse(await browser.evaluate(`(() => {
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const text = (root, selector) => root?.querySelector(selector)?.textContent?.trim() ?? null;
  const panel = document.querySelector('#omos-installed-agents');
  const presetSelect = panel?.querySelector('.marketplace-preset .oc-sdk-select');
  const sourceDetails = document.querySelector('details.settings-marketplace');
  const sourceField = sourceDetails?.querySelector('.oc-sdk-field');
  const dialog = document.querySelector('dialog.editor-dialog');
  const notice = document.querySelector('.status-box.page-notice');
  const picker = document.querySelector('#omos-model-picker');
  const pickerRect = picker && !picker.hidden ? picker.getBoundingClientRect() : null;
  const footer = document.querySelector('.save-bar');
  const workspaces = [...document.querySelectorAll('.queue-workspace')].map((workspace) => {
    const aiButton = [...workspace.querySelectorAll('.queue-tools button')].find((node) => /AI suggestion/.test(node.innerText || ''));
    return {
      id: workspace.dataset.queueId ?? null,
      primary: workspace.dataset.primaryAgent ?? null,
      dirty: text(workspace, '.queue-dirty'),
      rows: [...workspace.querySelectorAll('.model-row')].map((row) => ({
        index: Number(row.dataset.index),
        model: (row.querySelector('.model-cell button')?.textContent || '').trim(),
        variant: text(row, '.variant-cell .oc-sdk-trigger-value'),
      })),
      ai: aiButton ? { visible: visible(aiButton), disabled: Boolean(aiButton.disabled) } : null,
      aiControlCount: workspace.querySelectorAll('.queue-tools button').length,
      refreshInfo: (() => {
        const slot = [...workspace.querySelectorAll('.queue-tools .button-slot')]
          .find((node) => /queue info|Refresh/i.test(node.innerText || ''));
        return slot ? !slot.hidden : null;
      })(),
    };
  });
  return JSON.stringify({
    panel: panel ? {
      present: true,
      scope: text(panel, '.marketplace-scope'),
      status: text(panel, '.marketplace-status'),
      statusError: panel.querySelector('.marketplace-status')?.dataset.error ?? null,
      statusRole: panel.querySelector('.marketplace-status')?.getAttribute('role') ?? null,
      presetValue: text(presetSelect, '.oc-sdk-trigger-value'),
      presetExpanded: presetSelect?.querySelector('.oc-sdk-trigger')?.getAttribute('aria-expanded') ?? null,
      presetOptions: [...(presetSelect?.querySelectorAll('.oc-sdk-popup .oc-sdk-option-label') ?? [])].map((node) => node.textContent.trim()),
      buttons: [...panel.querySelectorAll('button')].map((node) => ({ text: (node.innerText || '').trim(), disabled: Boolean(node.disabled), visible: visible(node) })),
      rows: [...panel.querySelectorAll('.marketplace-agent[data-package-id]')].map((row) => {
        const selection = row.querySelector('button[data-marketplace-action="selection"]');
        return {
          packageId: row.dataset.packageId,
          name: text(row, '.oc-sdk-check-label') ?? text(row, '.marketplace-agent-name h3'),
          state: text(row, '.marketplace-agent-state'),
          blocked: text(row, '.marketplace-blocked'),
          checked: selection?.getAttribute('aria-checked') ?? null,
          selectionDisabled: selection ? Boolean(selection.disabled) : null,
          actions: [...row.querySelectorAll('button[data-marketplace-action]')].map((node) => ({
            action: node.dataset.marketplaceAction, text: (node.innerText || '').trim(), disabled: Boolean(node.disabled), visible: visible(node),
          })),
        };
      }),
    } : { present: false },
    source: sourceDetails ? {
      open: Boolean(sourceDetails.open),
      field: sourceField ? {
        label: text(sourceField, '.oc-sdk-field-label'),
        value: sourceField.querySelector('input')?.value ?? null,
        disabled: Boolean(sourceField.querySelector('input')?.disabled),
      } : null,
      status: text(sourceDetails, '.marketplace-status'),
      statusError: sourceDetails.querySelector('.marketplace-status')?.dataset.error ?? null,
      statusRole: sourceDetails.querySelector('.marketplace-status')?.getAttribute('role') ?? null,
      buttons: [...sourceDetails.querySelectorAll('button')].map((node) => ({ text: (node.innerText || '').trim(), disabled: Boolean(node.disabled), visible: visible(node) })),
    } : null,
    dialog: dialog ? {
      open: Boolean(dialog.open),
      title: text(dialog, '.dialog-title'),
      diff: [...dialog.querySelectorAll('.dialog-body .diff')].map((node) => node.innerText).join('\\n'),
      error: text(dialog, 'p.status-box[role="alert"]'),
      errorVisible: visible(dialog.querySelector('p.status-box[role="alert"]')),
      actions: [...dialog.querySelectorAll('.dialog-actions button')].map((node) => ({ text: (node.innerText || '').trim(), disabled: Boolean(node.disabled) })),
      body: text(dialog, '.dialog-body'),
    } : { open: false },
    notice: notice ? { hidden: Boolean(notice.hidden), tone: notice.dataset.tone ?? null, text: (notice.textContent || '').trim() } : null,
    picker: picker ? {
      hidden: Boolean(picker.hidden),
      query: picker.querySelector('.model-search input')?.value ?? null,
      rect: pickerRect ? { left: pickerRect.left, top: pickerRect.top, right: pickerRect.right, bottom: pickerRect.bottom, width: pickerRect.width, height: pickerRect.height } : null,
      dialog: picker.matches('dialog'),
      open: picker.matches('dialog') ? picker.open : null,
      clipped: (() => {
        if (!pickerRect) return false;
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft ?? 0;
        const top = viewport?.offsetTop ?? 0;
        return pickerRect.left < left - 1 || pickerRect.top < top - 1
          || pickerRect.right > left + (viewport?.width ?? innerWidth) + 1
          || pickerRect.bottom > top + (viewport?.height ?? innerHeight) + 1;
      })(),
      footerTop: footer?.getBoundingClientRect().top ?? null,
      viewport: { width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight },
    } : null,
    settings: {
      open: Boolean(dialog?.open && document.querySelector('.settings-fields')),
      fields: [...document.querySelectorAll('.settings-fields .oc-sdk-field')].map((field) => ({
        label: text(field, '.oc-sdk-field-label'),
        value: field.querySelector('input, textarea')?.value ?? null,
      })),
    },
    workspaces,
    active: { tag: document.activeElement?.tagName ?? null, packageId: document.activeElement?.dataset?.packageId ?? null,
      action: document.activeElement?.dataset?.marketplaceAction ?? null, aria: document.activeElement?.getAttribute?.('aria-label') ?? null },
    overflow: { documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth },
  });
})()`, { context }));

export const waitForMarketplaceState = async (browser, context, predicate, { timeoutMs = 25_000, label = 'the marketplace UI' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readMarketplaceState(browser, context).catch((error) => ({ error: error.message }));
    if (!last?.error && predicate(last)) return last;
    await sleep(150);
  }
  throw new MarketplaceFlowError('MARKETPLACE_WAIT', `${label} did not settle in time`, { last });
};

export const waitForDraftV2 = async (serviceJson, configFile, predicate, { timeoutMs = 25_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await serviceJson('GET', '/drafts').catch((error) => ({ error: error.message }));
    const drafts = Array.isArray(last?.drafts) ? last.drafts : [];
    const match = drafts.find((draft) => draft?.targetPath === configFile && draft.version === 2 && predicate(draft));
    if (match) return match;
    await sleep(200);
  }
  throw new MarketplaceFlowError('MARKETPLACE_DRAFT', 'No current v2 marketplace draft was stored', { last });
};

/** Host-page fetch counter: records guest service-envelope paths only. */
export const installMarketplaceCallCounter = async (browser) => {
  const installed = await browser.evaluate(`(() => {
    if (window.__omosMarketplaceFetch) { window.__omosMarketplaceFetch.calls.length = 0; return true; }
    const original = window.fetch;
    const calls = [];
    window.__omosMarketplaceFetch = { original, calls };
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/api/guests/') && url.includes('/service/request') && typeof init?.body === 'string') {
        try {
          const envelope = JSON.parse(init.body);
          if (typeof envelope?.path === 'string') calls.push({ at: Date.now(), path: envelope.path });
        } catch { /* not a service envelope */ }
      }
      return original(...args);
    };
    return true;
  })()`);
  if (!installed) throw new MarketplaceFlowError('MARKETPLACE_INSTRUMENT', 'Could not install the host service-call counter');
};

export const readMarketplaceCalls = async (browser) => JSON.parse(
  await browser.evaluate('JSON.stringify(window.__omosMarketplaceFetch?.calls ?? [])'),
);

export const resetMarketplaceCalls = async (browser) => {
  await browser.evaluate('(() => { if (window.__omosMarketplaceFetch) window.__omosMarketplaceFetch.calls.length = 0; return true; })()');
};

const clickButtonText = async (browser, context, text) => {
  const clicked = await browser.pointerClickText(text, { context, timeoutMs: 12_000 });
  return clicked;
};

const capture = async (browser, artifactsDir, name, artifacts) => {
  const shot = await browser.screenshot(path.join(artifactsDir, `${name}.png`));
  const row = { name, ...pngInfo(shot.path) };
  artifacts.push(row);
  return row;
};

const markField = async (browser, context, selector, attribute) => {
  const marked = await browser.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.setAttribute(${JSON.stringify(attribute)}, '1');
    return true;
  })()`, { context });
  if (!marked) throw new MarketplaceFlowError('MARKETPLACE_FIELD', `No field for ${selector}`);
};

const markSettingsField = async (browser, context, label, attribute) => {
  await waitForSettingsForm(browser, context);
  const marked = await browser.evaluate(`(() => {
    const field = [...document.querySelectorAll('.settings-fields .oc-sdk-field')]
      .find((node) => (node.querySelector('.oc-sdk-field-label')?.textContent || '').trim() === ${JSON.stringify(label)});
    const input = field?.querySelector('input, textarea');
    if (!input) return false;
    input.setAttribute(${JSON.stringify(attribute)}, '1');
    return true;
  })()`, { context });
  if (!marked) throw new MarketplaceFlowError('MARKETPLACE_FIELD', `No settings field labelled ${label}`);
};

const typeIntoMarked = async (browser, context, attribute, value) => {
  const selector = `[${attribute}="1"]`;
  await browser.waitForExpression(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`, { context });
  await browser.evaluate(`new Promise(resolve => {
    document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center'});
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`, { context });
  await browser.pointerClick(selector, { context, scroll: false, timeoutMs: 10_000 });
  await browser.waitForExpression(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`, { context });
  await browser.command('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard', actions: [
    { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'a' },
    { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '\uE009' },
  ] }] });
  await browser.command('input.releaseActions', { context });
  await browser.typeText(value, { context });
};

/**
 * Full desktop marketplace slice. The caller has already set the synthetic
 * target/settings and opened the real extension page.
 */
export const runMarketplaceDomWorkflow = async ({
  browser, context, baseUrl, pageTitle, serviceJson, configFile, sourceRoot,
  artifactsDir, baseline, expected,
}) => {
  const checks = {};
  const artifacts = [];
  const callsAcrossReload = [];
  const check = (name, condition, details = null) => {
    checks[name] = { ok: Boolean(condition), ...(details ? { detail: details } : {}) };
    if (!condition) throw new MarketplaceFlowError(`MARKETPLACE_CHECK_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      `Marketplace DOM check failed: ${name}`, details);
  };
  const stateNow = () => readMarketplaceState(browser, context);
  const wait = (predicate, options) => waitForMarketplaceState(browser, context, predicate, options);
  const configJson = async () => serviceJson('GET', '/config');
  const marketplaceConfig = async () => serviceJson('GET', '/marketplace/config');
  const currentDraft = async () => (await serviceJson('GET', '/drafts'))?.drafts ?? [];

  const sourceTreeBefore = hashMarketplaceTree(sourceRoot);
  const fileTextBefore = fs.readFileSync(configFile, 'utf8');
  const baselineConfig = await configJson();
  const baselineMarketplace = await marketplaceConfig();
  check('baseline-master-enabled', baselineMarketplace?.masterEnabled === true, baselineMarketplace);
  check('baseline-active-preset-null', baselineMarketplace?.activePreset === null, baselineMarketplace);
  check('baseline-presets-include-flat-solo-legacy',
    ['flat', STRUCTURED_PRESET, LEGACY_PRESET].every(name => (baselineMarketplace?.presets ?? []).some(preset => preset.name === name)),
    baselineMarketplace?.presets?.map(preset => ({ name: preset.name, layout: preset.layout, editable: preset.editable })));

  // 1. Start with one actionable disconnect prompt, then check an unsaved
  // core field survives configuring the source and canceling Settings.
  const disconnected = await wait(row => row.panel.buttons?.some(button => button.visible && button.text === 'Connect source'),
    { label: 'the disconnected marketplace source control' });
  check('disconnected-single-source-control', disconnected.panel.buttons.filter(button => button.visible && /^(?:Connect source|Source settings)$/.test(button.text)).length === 1
    && !disconnected.panel.status && disconnected.panel.rows.length === 0, disconnected.panel);
  await clickButtonText(browser, context, 'Connect source');
  await wait((state) => state.settings.open && state.source?.open, { label: 'the marketplace source settings' });
  const coreCanary = `SYNTHETIC_CORE_SETTING_${Date.now()}`;
  await markSettingsField(browser, context, 'Model working directory', 'data-omos-core-field');
  await typeIntoMarked(browser, context, 'data-omos-core-field', coreCanary);
  let state = await stateNow();
  check('settings-core-field-preserved', state.settings.fields.some(field => field.value === coreCanary), state.settings.fields);
  await markField(browser, context, 'details.settings-marketplace .oc-sdk-field input', 'data-omos-marketplace-source');
  await typeIntoMarked(browser, context, 'data-omos-marketplace-source', sourceRoot);
  state = await stateNow();
  check('source-field-typed', state.source?.field?.value === sourceRoot, state.source);
  const sourceSaveMarked = await browser.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('details.settings-marketplace button')]
      .filter(button => button.textContent.trim() === 'Save source' && !button.disabled);
    if (buttons.length !== 1) return false;
    buttons[0].dataset.omosMarketplaceSave = '1'; return true;
  })()`, { context });
  check('source-save-scoped', sourceSaveMarked);
  await browser.pointerClick('[data-omos-marketplace-save="1"]', { context });
  // Pointer dispatch is not acknowledgment: configure() crosses the host bridge.
  // The fixture starts disconnected; these two verified packages appear only
  // after the submitted folder has been persisted and read back by the page.
  state = await wait((row) => /2 installed packages/.test(row.source?.status ?? ''), { label: 'the installed source read' });
  const persistedSource = await serviceJson('GET', '/marketplace/source');
  check('source-path-persisted', persistedSource.rootPath === sourceRoot, persistedSource);
  check('source-field-retained', state.source?.field?.value === sourceRoot, state.source);
  check('source-status-ready', /2 installed packages/.test(state.source.status), state.source);
  check('source-settings-error-clear', state.source.statusError === 'false' || state.source.statusError === null, state.source);
  await clickButtonText(browser, context, 'Cancel');
  await wait((row) => !row.settings.open, { label: 'the closed settings dialog' });
  const settingsAfter = await serviceJson('GET', '/settings');
  check('settings-core-field-not-persisted', settingsAfter?.settings?.modelCwd === baseline.settings.modelCwd,
    { before: baseline.settings.modelCwd, after: settingsAfter?.settings?.modelCwd, coreCanary });
  const sourceAfter = await serviceJson('GET', '/marketplace/source');
  check('source-configured', sourceAfter?.rootPath === sourceRoot && typeof sourceAfter?.generation === 'string', sourceAfter);
  const sourceBinding = await marketplaceConfig();
  check('source-catalog-ready', sourceBinding?.catalog?.state === 'ready' && sourceBinding.catalog.packages?.length === 2,
    sourceBinding?.catalog);

  // 2. Installed rows are visible before any selection; choosing the preset view
  // must not change the file.
  state = await wait((row) => row.panel?.present && row.panel.rows?.length === 2, { label: 'the installed agent rows' });
  check('installed-rows-require-preset-view', state.panel.rows.every(row => row.checked === null), state.panel.rows);
  check('installed-single-preset-prompt', /choose an existing preset/i.test(state.panel.presetValue || '')
    && !state.panel.status && state.panel.rows.every(row => !/choose.*preset/i.test(row.state || '')), state.panel);
  check('installed-rows-product-names', state.panel.rows.some(row => row.name === 'Janitor') && state.panel.rows.some(row => row.name === 'Chronicler'),
    state.panel.rows.map(row => row.name));
  // A file-defined, unselected agent can have the same preset path that an
  // installed package would use. It stays in file order, not in Marketplace.
  const customId = JSON.stringify(['presets', LEGACY_PRESET, 'janitor', 'model']);
  const customPosition = state.workspaces.findIndex(row => row.id === customId);
  const primaryPosition = state.workspaces.findIndex(row => row.primary === 'orchestrator');
  const collision = sourceBinding.presets.find(preset => preset.name === LEGACY_PRESET)?.agents.find(agent => agent.packageId === JANITOR_ID);
  check('unselected-package-collision-keeps-custom-queue', collision?.selected === false
    && collision.existingGroupId === customId && customPosition >= 0 && primaryPosition > customPosition
    && state.workspaces[customPosition].rows[0]?.model === 'synthetic/custom-janitor');
  check('existing-build-is-hidden-not-deleted', baselineConfig.groups.some(group => group.id === JSON.stringify(['agents','build','model']) && group.readOnlyReason)
    && !state.workspaces.some(row => row.id === JSON.stringify(['agents','build','model']) || row.primary === 'build'));
  check('scope-master-enabled', /Marketplace enabled/.test(state.panel.scope ?? ''), state.panel.scope);
  await browser.prepareSdkPopupTrigger('#omos-installed-agents .marketplace-preset', { context });
  await browser.pointerClick('#omos-installed-agents .marketplace-preset .oc-sdk-trigger', { context, scroll: false });
  state = await wait((row) => row.panel.presetExpanded === 'true' && row.panel.presetOptions.length > 0,
    { label: 'the open preset options' });
  check('preset-options', ['flat', STRUCTURED_PRESET, LEGACY_PRESET].every(name => state.panel.presetOptions.includes(name)), state.panel.presetOptions);
  await browser.pressKey('Escape', { context });
  await capture(browser, artifactsDir, 'marketplace-installed-unselected', artifacts);
  await browser.selectSdkOption('#omos-installed-agents .marketplace-preset', PRESET, { context, pointer: true });
  state = await wait((row) => row.panel.presetValue === PRESET, { label: 'the explicit preset view' });
  check('preset-view-selected', state.panel.presetValue === PRESET, state.panel.presetValue);
  check('installed-rows-unselected', state.panel.rows.every(row => row.checked === 'false'), state.panel.rows);
  check('ready-marketplace-no-generic-save-instruction', !/Review changes|Confirm and save/.test(state.panel.status || ''), state.panel.status);
  check('preset-view-does-not-write', fs.readFileSync(configFile, 'utf8') === fileTextBefore
    && fs.statSync(configFile).mtimeMs === baseline.mtimeMs && fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length === baseline.backups,
  { hash: baseline.hash, backups: baseline.backups });
  check('master-flag-not-materialized', !/"marketplace"\s*:\s*\{\s*"enabled"/.test(fs.readFileSync(configFile, 'utf8')));

  // 3. Select both installed packages with real pointer checkbox input. This is
  // staging only: no model node and no file write.
  for (const packageId of [JANITOR_ID, CHRONICLER_ID]) {
    await browser.pointerClick(`.marketplace-agent[data-package-id=${JSON.stringify(packageId)}] button[data-marketplace-action="selection"]`,
      { context, timeoutMs: 10_000 });
  }
  state = await wait((row) => row.panel.rows.every(item => item.checked === 'true'), { label: 'both package selections' });
  check('both-packages-selected', state.panel.rows.length === 2 && state.panel.rows.every(row => row.checked === 'true'), state.panel.rows);
  check('selection-is-staged-only', fs.readFileSync(configFile, 'utf8') === fileTextBefore
    && (await configJson())?.groups?.every(group => group.id !== JSON.stringify(['presets', PRESET, 'janitor', 'model'])), { hash: baseline.hash });
  check('chronicler-inherited-no-node', !/"chronicler"\s*:\s*\{/.test(fs.readFileSync(configFile, 'utf8')));

  // 4. Override Janitor through the full-viewport model dialog.
  await browser.pointerClick(`.marketplace-agent[data-package-id=${JSON.stringify(JANITOR_ID)}] button[data-marketplace-action="override"]`,
    { context, timeoutMs: 10_000 });
  state = await wait((row) => row.picker && row.picker.hidden === false, { label: 'the model picker dialog' });
  const picker = state.picker;
  check('override-picker-is-dialog', picker.dialog === true && picker.open === true, picker);
  check('override-picker-fills-viewport', Boolean(picker.rect) && !picker.clipped
    && picker.rect.width >= picker.viewport.width - 2 && picker.rect.height >= picker.viewport.height - 2, picker);
  await browser.typeText(OVERRIDE_MODEL, { context });
  await browser.waitForExpression(`Boolean(document.querySelector('#omos-model-picker .model-results [role="option"]'))`, { context, timeoutMs: 12_000 });
  await browser.pressKey('Enter', { context });
  const pendingPath = ['presets', PRESET, 'janitor', 'model'];
  const pendingId = JSON.stringify(pendingPath);
  state = await wait((row) => row.workspaces.some(workspace => workspace.id === pendingId), { label: 'the pending model queue' });
  const pending = state.workspaces.find(workspace => workspace.id === pendingId);
  check('pending-queue-created', Boolean(pending) && pending.rows.length === 1 && pending.rows[0].model === OVERRIDE_MODEL, pending);
  check('pending-queue-staged-label', pending.dirty === 'Staged model queue', pending.dirty);
  check('pending-queue-no-ai-control', pending.ai === null, pending.ai);
  await browser.selectSdkOption(`.queue-workspace[data-queue-id=${JSON.stringify(pendingId)}] .model-row[data-index="0"] .variant-cell`,
    DEFAULT_VARIANT, { context, pointer: true });
  state = await wait((row) => row.workspaces.find(workspace => workspace.id === pendingId)?.rows[0]?.variant === DEFAULT_VARIANT,
    { label: 'the pending queue variant' });
  check('pending-queue-variant', state.workspaces.find(workspace => workspace.id === pendingId)?.rows[0]?.variant === DEFAULT_VARIANT,
    state.workspaces.find(workspace => workspace.id === pendingId)?.rows[0]);
  await capture(browser, artifactsDir, 'marketplace-staged-pending-queue', artifacts);

  // 5. Ordinary existing queue edit joins the same transaction.
  const flatNeighbor = (baselineConfig.groups ?? []).find(group => JSON.stringify(group.path) === JSON.stringify(['presets', PRESET, 'neighbor', 'model']));
  check('flat-neighbor-group', Boolean(flatNeighbor?.id), flatNeighbor);
  await browser.selectSdkOption(`.queue-workspace[data-queue-id=${JSON.stringify(flatNeighbor.id)}] .model-row[data-index="0"] .variant-cell`,
    DEFAULT_VARIANT, { context, pointer: true });
  state = await wait((row) => row.workspaces.find(workspace => workspace.id === flatNeighbor.id)?.rows[0]?.variant === DEFAULT_VARIANT,
    { label: 'the ordinary queue edit' });
  check('ordinary-edit-staged', state.workspaces.find(workspace => workspace.id === flatNeighbor.id)?.rows[0]?.variant === DEFAULT_VARIANT);
  check('staging-writes-nothing', fs.readFileSync(configFile, 'utf8') === fileTextBefore
    && fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length === baseline.backups);

  // 6. Exact v2 draft record for this frame.
  const draft = await waitForDraftV2(serviceJson, configFile, (candidate) => {
    const edit = candidate.marketplace?.edits?.find(item => item.preset === PRESET);
    const creation = edit?.creations?.find(item => item.packageId === JANITOR_ID);
    return candidate.baseHash === baseline.baseHash
      && edit && [JANITOR_ID, CHRONICLER_ID].every(id => edit.packageIds.includes(id))
      && creation?.models?.length === 1 && creation.models[0].id === OVERRIDE_MODEL
      && candidate.changes?.some(change => JSON.stringify(change.path) === JSON.stringify(['presets', PRESET, 'neighbor', 'model']));
  });
  const draftEdit = draft.marketplace.edits.find(item => item.preset === PRESET);
  check('draft-v2-version', draft.version === 2 && draft.revision >= 0, { version: draft.version, revision: draft.revision });
  check('draft-v2-source-binding', draft.marketplace.sourceGeneration === sourceBinding.catalog.generation
    && draft.marketplace.catalogFingerprint === sourceBinding.catalog.fingerprint, draft.marketplace);
  check('draft-v2-full-creation-models', JSON.stringify(draftEdit.creations.find(item => item.packageId === JANITOR_ID)?.models)
    === JSON.stringify([{ id: OVERRIDE_MODEL, variant: DEFAULT_VARIANT }]), draftEdit.creations);

  // 7. Reload does not auto-recover and writes nothing; explicit Recover restores staging.
  callsAcrossReload.push(...await readMarketplaceCalls(browser));
  await browser.navigate(baseUrl, { timeoutMs: 30_000 });
  const reloadedFrame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
  await installMarketplaceCallCounter(browser);
  const recoveredContext = reloadedFrame.context;
  state = await waitForMarketplaceState(browser, recoveredContext, (row) => row.panel?.present, { label: 'the reloaded page' });
  check('reload-no-auto-recover', state.workspaces.every(workspace => workspace.dirty !== 'Staged model queue')
    && state.panel.rows.every(row => row.checked !== 'true'), { rows: state.panel.rows });
  check('reload-writes-nothing', fs.readFileSync(configFile, 'utf8') === fileTextBefore);
  const draftsAfterReload = await currentDraft();
  check('draft-retained-across-reload', draftsAfterReload.some(item => item.id === draft.id), draftsAfterReload.map(item => item.id));
  const draftButton = await browser.evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find((item) => /^Drafts \\(\\d+\\)$/.test((item.innerText || '').trim()));
    return node ? (node.innerText || '').trim() : null;
  })()`, { context: recoveredContext });
  check('draft-button-visible', Boolean(draftButton), draftButton);
  await browser.pointerClickText(draftButton, { context: recoveredContext, timeoutMs: 10_000 });
  await waitForMarketplaceState(browser, recoveredContext, (row) => row.dialog.open && row.dialog.title === 'Stored drafts', { label: 'the stored drafts dialog' });
  const recover = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll('.recovery-row')].filter(row =>
      row.querySelector('.recovery-path')?.textContent === ${JSON.stringify(configFile)}
      && [...row.querySelectorAll('button')].some(button => button.textContent.trim() === 'Recover a copy' && !button.disabled));
    if (matches.length !== 1) return false;
    const button = [...matches[0].querySelectorAll('button')].find(button => button.textContent.trim() === 'Recover a copy' && !button.disabled);
    button.dataset.omosMarketplaceRecover = '1'; return true;
  })()`, { context: recoveredContext });
  check('recover-target-is-unambiguous', recover);
  await browser.pointerClick('[data-omos-marketplace-recover="1"]', { context: recoveredContext, timeoutMs: 10_000 });
  state = await waitForMarketplaceState(browser, recoveredContext,
    (row) => row.workspaces.some(workspace => workspace.id === pendingId && workspace.dirty === 'Staged model queue'), { label: 'recovered pending staging' });
  check('recover-restores-pending-without-ai', state.workspaces.find(workspace => workspace.id === pendingId)?.ai === null,
    state.workspaces.find(workspace => workspace.id === pendingId));
  const context2 = recoveredContext;

  // 8. Review: narrow combined diff, no canaries, exact reviewed indentation.
  await browser.pointerClickText('Review changes', { context: context2, timeoutMs: 12_000 });
  state = await waitForMarketplaceState(browser, context2, (row) => row.dialog.open && row.dialog.title === 'Review all changes',
    { label: 'the combined review' });
  const reviewDiff = state.dialog.diff;
  check('review-has-selection', reviewDiff.includes(JANITOR_ID) && reviewDiff.includes(CHRONICLER_ID), reviewDiff.slice(0, 2000));
  check('review-has-override-model', reviewDiff.includes(OVERRIDE_MODEL), reviewDiff.slice(0, 2000));
  check('review-has-ordinary-value', reviewDiff.includes(ORDINARY_MODEL), reviewDiff.slice(0, 2000));
  check('review-no-private-canaries', !/SYNTHETIC_(PROMPT|MCP|TOOL|ROOT|NEIGHBOR|DOCS|REVIEWER|LEGACY|BUILD)_CANARY/.test(reviewDiff)
    && !reviewDiff.includes('SYNTHETIC_PROMPT_CANARY'), reviewDiff.slice(0, 2000));
  check('review-no-unknown-selection-change', !reviewDiff.includes(UNKNOWN_SELECTION), reviewDiff.slice(0, 2000));
  check('review-no-fake-two-space-indent', !/^\+ {2}"(?:alvin\/janitor|acme\/chronicler|model)"/m.test(reviewDiff), reviewDiff.slice(0, 2000));
  const reviewAction = state.dialog.actions.find(action => action.text === 'Confirm and save');
  check('review-confirm-enabled', Boolean(reviewAction && reviewAction.disabled === false), state.dialog.actions);
  await capture(browser, artifactsDir, 'marketplace-review-green-cta', artifacts);
  await browser.pointerClickText('Back to editing', { context: context2, timeoutMs: 10_000 });
  await waitForMarketplaceState(browser, context2, (row) => !row.dialog.open, { label: 'the cancelled review' });
  check('review-cancel-writes-nothing', fs.readFileSync(configFile, 'utf8') === fileTextBefore
    && fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length === baseline.backups);

  // 9. Source generation rotates between preview and Confirm: stale token is
  // refused, stages stay, explicit Recheck then a fresh preview succeeds.
  await browser.pointerClickText('Review changes', { context: context2, timeoutMs: 12_000 });
  await waitForMarketplaceState(browser, context2, (row) => row.dialog.open && row.dialog.title === 'Review all changes', { label: 'the first review' });
  const rotated = await serviceJson('POST', '/marketplace/source', { rootPath: sourceRoot });
  check('source-generation-rotated', rotated?.generation !== sourceAfter.generation, rotated);
  await browser.pointerClickText('Confirm and save', { context: context2, timeoutMs: 12_000 });
  state = await waitForMarketplaceState(browser, context2, (row) => !row.dialog.open && /Save outcome unknown/.test(row.notice?.text ?? ''),
    { label: 'the refused stale preview' });
  check('stale-source-refused', /changed|generation|Recheck/i.test(state.notice?.text ?? ''), state.notice);
  check('stale-source-zero-write', fs.readFileSync(configFile, 'utf8') === fileTextBefore
    && fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length === baseline.backups);
  check('stale-source-draft-retained', (await currentDraft()).some(item => item.id === draft.id));
  await browser.pointerClickText('Check file outcome', { context: context2, timeoutMs: 10_000 });
  await waitForMarketplaceState(browser, context2, row => /matches the earlier baseline/.test(row.notice?.text ?? ''),
    { label: 'the explicit baseline reconciliation' });
  await browser.pointerClickText('Recheck packages', { context: context2, timeoutMs: 12_000 });
  await waitForDraftV2(serviceJson, configFile, candidate => candidate.marketplace?.sourceGeneration === rotated.generation
    && candidate.marketplace?.catalogFingerprint === sourceBinding.catalog.fingerprint
    && candidate.marketplace.edits.some(edit => edit.preset === PRESET && edit.creations.some(creation => creation.packageId === JANITOR_ID
      && creation.models[0]?.id === OVERRIDE_MODEL && creation.models[0]?.variant === DEFAULT_VARIANT)));
  await browser.pointerClickText('Review changes', { context: context2, timeoutMs: 12_000 });
  state = await waitForMarketplaceState(browser, context2, (row) => row.dialog.open && row.dialog.title === 'Review all changes',
    { label: 'the rechecked review' });
  const recheckedAction = state.dialog.actions.find(action => action.text === 'Confirm and save');
  check('recheck-fresh-preview', Boolean(recheckedAction && recheckedAction.disabled === false), state.dialog.actions);

  // 10. Confirm exactly one write and one backup.
  const backupsBefore = fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length;
  await browser.pointerClickText('Confirm and save', { context: context2, timeoutMs: 12_000 });
  state = await waitForMarketplaceState(browser, context2, (row) => !row.dialog.open
    && row.workspaces.some(workspace => workspace.id === pendingId && workspace.dirty !== 'Staged model queue'
    && workspace.rows?.[0]?.model === OVERRIDE_MODEL && workspace.ai === null),
  { label: 'the saved marketplace transaction and hydrated queue' });
  const afterText = fs.readFileSync(configFile, 'utf8');
  const expectedDocument = parseJsonc(fileTextBefore);
  expectedDocument.presets[PRESET].neighbor.model = [{ id: ORDINARY_MODEL, variant: DEFAULT_VARIANT }];
  expectedDocument.presets[PRESET].marketplace = { agents: [JANITOR_ID, CHRONICLER_ID] };
  expectedDocument.presets[PRESET].janitor = { model: [{ id: OVERRIDE_MODEL, variant: DEFAULT_VARIANT }] };
  check('whole-document-allowed-mutations-only', isDeepStrictEqual(parseJsonc(afterText), expectedDocument),
    { verified: 'Only the staged selection, Janitor queue and neighbor model value may differ.' });
  const afterHash = hashMarketplaceTree(path.dirname(configFile));
  const backupsAfter = fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length;
  check('confirm-one-write', afterText !== fileTextBefore, { before: baseline.hash, after: afterHash });
  check('confirm-one-backup', backupsAfter === backupsBefore + 1, { backupsBefore, backupsAfter });
  const backupNames = fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-'));
  check('backup-is-exact-baseline', backupNames.length === 1
    && fs.readFileSync(path.join(path.dirname(configFile), backupNames[0]), 'utf8') === fileTextBefore);
  check('source-store-untouched', hashMarketplaceTree(sourceRoot) === sourceTreeBefore);
  const afterConfig = await configJson();
  const afterMarketplace = await marketplaceConfig();
  check('created-group-exists', (afterConfig.groups ?? []).some(group => JSON.stringify(group.path) === JSON.stringify(pendingPath)),
    (afterConfig.groups ?? []).map(group => group.path));
  check('projection-created-not-pending', (afterMarketplace.presets ?? []).find(preset => preset.name === PRESET)?.agents
    ?.some(agent => agent.packageId === JANITOR_ID && agent.existingGroupId && agent.canCreate === false), afterMarketplace.presets);
  check('unknown-selection-preserved', JSON.stringify(afterMarketplace.presets?.find(preset => preset.name === LEGACY_PRESET)?.packageIds) === JSON.stringify([UNKNOWN_SELECTION])
    && afterText.includes(UNKNOWN_SELECTION));
  check('structured-preset-untouched', afterText.includes('"solo"') && afterText.includes('anthropic/claude-sonnet-4-5:high'));
  for (const line of reviewDiff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    if (/alvin\/janitor|acme\/chronicler|synthetic\/provider-alpha|openai\/gpt-5\.1:high/.test(added)) {
      check('review-indent-matches-committed', afterText.split('\n').includes(added), { added });
    }
  }
  const savedPending = state.workspaces.find(workspace => workspace.id === pendingId);
  check('post-save-queue-hydrated-without-ai', savedPending?.rows?.[0]?.model === OVERRIDE_MODEL && savedPending?.ai === null,
    { ai: savedPending?.ai, rows: savedPending?.rows });
  await capture(browser, artifactsDir, 'marketplace-after-save', artifacts);

  // Later local edits stay dirty and are not auto-written.
  await browser.selectSdkOption(`.queue-workspace[data-queue-id=${JSON.stringify(pendingId)}] .model-row[data-index="0"] .variant-cell`,
    'low', { context: context2, pointer: true });
  state = await waitForMarketplaceState(browser, context2,
    (row) => row.workspaces.find(workspace => workspace.id === pendingId)?.rows[0]?.variant === 'low', { label: 'the later local edit' });
  check('later-edit-retained', fs.readFileSync(configFile, 'utf8') === afterText
    && /changed/.test((await readUiState(browser, context2)).footer?.dirty ?? ''), (await readUiState(browser, context2)).footer);

  // 11. Target conflict between preview and Confirm: never overwrite the file.
  await browser.pointerClickText('Review changes', { context: context2, timeoutMs: 12_000 });
  await waitForMarketplaceState(browser, context2, (row) => row.dialog.open && row.dialog.title === 'Review all changes', { label: 'the conflict review' });
  const externalCanary = `SYNTHETIC_EXTERNAL_CONFLICT_${Date.now()}`;
  fs.appendFileSync(configFile, `\n// ${externalCanary}\n`);
  const externalHash = createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
  const backupsBeforeConflict = fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length;
  await browser.pointerClickText('Confirm and save', { context: context2, timeoutMs: 12_000 });
  state = await waitForMarketplaceState(browser, context2, (row) => !row.dialog.open && /Save outcome unknown/.test(row.notice?.text ?? ''),
    { label: 'the refused target conflict' });
  check('target-conflict-refused', /changed|conflict|Reload|baseline/i.test(state.notice?.text ?? ''), state.notice);
  await browser.pointerClickText('Check file outcome', { context: context2, timeoutMs: 10_000 });
  state = await waitForMarketplaceState(browser, context2, row => /differs from both/.test(row.notice?.text ?? '') && row.notice?.tone === 'error',
    { label: 'the explicit external-conflict reconciliation' });
  check('target-conflict-no-overwrite', createHash('sha256').update(fs.readFileSync(configFile)).digest('hex') === externalHash
    && fs.readFileSync(configFile, 'utf8').includes(externalCanary));
  check('target-conflict-no-backup', fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length === backupsBeforeConflict);
  check('target-conflict-draft-retained', (await currentDraft()).length > 0);
  await capture(browser, artifactsDir, 'marketplace-conflict-error', artifacts);

  callsAcrossReload.push(...await readMarketplaceCalls(browser));
  check('service-counter-observed-preview-and-commit', ['/preview', '/commit'].every(endpoint => callsAcrossReload.some(call => call.path === endpoint)),
    { observedPaths: [...new Set(callsAcrossReload.map(call => call.path))] });

  return {
    checks,
    artifacts,
    calls: callsAcrossReload,
    context: context2,
    reviewDiff,
    draft: { id: draft.id, version: draft.version, revision: draft.revision },
    final: {
      fileHashBefore: baseline.hash,
      fileHashAfter: createHash('sha256').update(afterText).digest('hex'),
      fileHashExternal: externalHash,
      backupsBefore,
      backupsAfter,
      sourceTreeBefore,
      sourceTreeAfter: hashMarketplaceTree(sourceRoot),
      sourceGeneration: rotated.generation,
      pendingId,
      unknownSelection: UNKNOWN_SELECTION,
    },
    saved: { pendingId, ai: savedPending?.ai ?? null },
  };
};

/** Phone/dark/short-viewport capture pass; no second full semantic flow. */
export const runMarketplaceVariant = async ({ browser, context, label, mobile, dark, artifactsDir, sourceRoot }) => {
  const checks = {};
  const artifacts = [];
  const check = (name, condition, details = null) => {
    checks[name] = { ok: Boolean(condition), ...(details ? { detail: details } : {}) };
    if (!condition) throw new MarketplaceFlowError(`MARKETPLACE_VARIANT_${name.toUpperCase()}`, `Marketplace variant check failed: ${name}`, details);
  };
  const state = await waitForMarketplaceState(browser, context, (row) => row.panel?.present && row.panel.rows?.length === 2,
    { label: `the ${label} loaded marketplace panel` });
  check('rows-present', state.panel.rows?.length === 2, state.panel.rows);
  check('no-global-overflow', state.overflow.documentWidth <= state.overflow.viewportWidth + 1, state.overflow);
  await browser.selectSdkOption('#omos-installed-agents .marketplace-preset', STRUCTURED_PRESET, { context, pointer: true });
  const selected = await waitForMarketplaceState(browser, context, (row) => row.panel.presetValue === STRUCTURED_PRESET,
    { label: `the ${label} preset view` });
  check('preset-view', selected.panel.presetValue === STRUCTURED_PRESET, selected.panel.presetValue);
  const janitor = `.marketplace-agent[data-package-id=${JSON.stringify(JANITOR_ID)}]`;
  await browser.pointerClick(`${janitor} button[data-marketplace-action="selection"]`, { context, timeoutMs: 10_000 });
  const staged = await waitForMarketplaceState(browser, context,
    (row) => row.panel.rows.find(item => item.packageId === JANITOR_ID)?.checked === 'true', { label: `the ${label} package selection` });
  check('pointer-selection-focus', staged.active.packageId === JANITOR_ID && staged.active.action === 'selection', staged.active);
  await capture(browser, artifactsDir, `marketplace-${label}-selected-row`, artifacts);
  await browser.pointerClick(`${janitor} button[data-marketplace-action="override"]`, { context, timeoutMs: 10_000 });
  const picker = await waitForMarketplaceState(browser, context, (row) => row.picker && row.picker.hidden === false,
    { label: `the ${label} model picker dialog` });
  const rect = picker.picker.rect;
  check('picker-is-dialog', picker.picker.dialog === true && picker.picker.open === true, picker.picker);
  check('picker-fills-viewport', Boolean(rect) && !picker.picker.clipped
    && rect.width >= picker.picker.viewport.width - 2 && rect.height >= picker.picker.viewport.height - 2, picker.picker);
  await capture(browser, artifactsDir, `marketplace-${label}-picker-dialog`, artifacts);
  await browser.pressKey('Escape', { context });
  await browser.pointerClickText('Discard marketplace stages', { context, timeoutMs: 10_000 }).catch(() => {});
  await browser.pointerClickText('Discard stages', { context, timeoutMs: 10_000 }).catch(() => {});
  await waitForMarketplaceState(browser, context, (row) => row.panel.rows.every(item => item.checked !== 'true'), { label: `the ${label} cleaned stages` }).catch(() => {});
  const themeClass = await browser.evaluate('document.documentElement.className');
  return { checks, artifacts, label, mobile, dark, sourceRoot, themeClass };
};
