#!/usr/bin/env node
/**
 * Isolated, bounded smoke harness for the OMOS queues extension.
 *
 * It starts a sibling STOCK OpenChamber 2.7.1 host with an owned HOME/XDG/
 * OPENCHAMBER_DATA_DIR, verifies the isolated state is empty, installs the
 * package folder through the real /api/guests route, approves only the service
 * capability through the host API, exercises the service over the real
 * serviceRequest envelope against a scratch OMOS JSONC file, and opens the
 * actual extension page in the stock host UI with Firefox.
 *
 * Nothing here edits the caller's configuration, starts a live extension, or
 * calls a model. Every process, log and artifact lives under one unique run
 * directory below --output.
 *
 * Usage:
 *   node test/integration/host-smoke.mjs --help
 *   node test/integration/host-smoke.mjs \
 *     --host-root /path/to/@openchamber/web \
 *     --opencode /path/to/opencode2 \
 *     --firefox /usr/bin/firefox \
 *     --package . \
 *     --output /tmp/opencode/omos-queues-host-proof
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launchFirefox } from './browser.mjs';
import {
  clickText,
  countBackups,
  hashFile,
  openExtensionPage,
  readUiState,
  runDomWorkflow,
  waitForLoadedQueue,
  waitForSettingsForm,
} from './ui-flow.mjs';
import { runFavoritesDomWorkflow, runFavoritesVariant } from './favorites-flow.mjs';
import { runPrimaryDomWorkflow } from './manual-flow.mjs';
import {
  JANITOR_ID,
  CHRONICLER_ID,
  PRESET as MARKETPLACE_PRESET,
  UNKNOWN_SELECTION,
  hashMarketplaceTree,
  installMarketplaceCallCounter,
  readMarketplaceCalls,
  runMarketplaceDomWorkflow,
  runMarketplaceVariant,
  writeMarketplaceConfig,
  writeMarketplaceStore,
} from './marketplace-flow.mjs';
const DEFAULT_OUTPUT = '/tmp/opencode/omos-queues-host-proof';
const HOST_READY_TIMEOUT_MS = 30_000;
const SERVICE_READY_TIMEOUT_MS = 25_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const PNG_SIGNATURE = '89504e470d0a1a0a';

const HELP = `OMOS queues isolated host smoke harness

Starts a stock OpenChamber host in a synthetic HOME, installs the extension
package folder with the real /api/guests route, approves only "service", drives
the real service through /api/guests/:id/service/request against a scratch OMOS
JSONC file, and opens the real extension page in Firefox.

Usage:
  node test/integration/host-smoke.mjs --help
  node test/integration/host-smoke.mjs --host-root <dir> --opencode <path> \\
    --firefox <path> --package <dir> [--output <dir>] [options]

Required:
  --host-root <dir>    Installed @openchamber/web package root (the CLI is
                       resolved from its package.json bin.openchamber).
  --opencode <path>    Isolated OpenCode executable used only for host readiness.
  --firefox <path>     Stock Firefox executable for the real host UI.
  --package <dir>      Extension package folder to install.
  --output <dir>       Parent directory for the unique proof run.
                       Default: ${DEFAULT_OUTPUT}

Options:
  --guest-id <id>      Expected extension panel id (default omos-queues).
  --skip-ui            Skip the Firefox host UI proof. The service proof still
                       runs. Missing UI evidence is reported, never mocked.
  --marketplace        Also run the actual stock-host marketplace proof. This
                       requires the integrated marketplace service routes and a
                       build that includes the marketplace UI. No inference provider runs.
  --focus-marketplace  Diagnostic: service preflight + marketplace UI only.
  --focus-layout       Measure the same three-position queue at fixed desktop
                       and phone viewports. Produces captures, not release proof.
  --focus-secondary    Diagnostic: omit core UI, retain other requested UI stages.
                       Focus modes never qualify the full combined release proof.
  --keep               Keep the synthetic HOME and host data for inspection.
  --timeout <ms>       Host readiness timeout (default ${HOST_READY_TIMEOUT_MS}).
  --help               Print this help and exit 0.

Exit 0 means every requested stage passed. A package that is not complete yet
fails with its actual host response (for example invalid-manifest or
missing-build); the harness does not replace it with a mock.
`;

class SmokeError extends Error {
  constructor(stage, code, message, details = null) {
    super(message);
    this.name = 'SmokeError';
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const isExecutableFile = (candidate) => {
  try {
    return fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const parseArgs = (argv) => {
  const options = {
    help: false,
    hostRoot: null,
    opencode: null,
    firefox: null,
    packageDir: null,
    output: DEFAULT_OUTPUT,
    guestId: 'omos-queues',
    skipUi: false,
    marketplace: false,
    focusLayout: false,
    focusMarketplace: false,
    focusSecondary: false,
    keep: false,
    readyTimeoutMs: HOST_READY_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new SmokeError('args', 'ARGS', `Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--host-root') options.hostRoot = next();
    else if (arg === '--opencode') options.opencode = next();
    else if (arg === '--firefox') options.firefox = next();
    else if (arg === '--package') options.packageDir = next();
    else if (arg === '--output') options.output = next();
    else if (arg === '--guest-id') options.guestId = next();
    else if (arg === '--skip-ui') options.skipUi = true;
    else if (arg === '--marketplace') options.marketplace = true;
    else if (arg === '--focus-layout') options.focusLayout = true;
    else if (arg === '--focus-marketplace') options.focusMarketplace = true;
    else if (arg === '--focus-secondary') options.focusSecondary = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--timeout') options.readyTimeoutMs = Number(next());
    else throw new SmokeError('args', 'ARGS', `Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.readyTimeoutMs) || options.readyTimeoutMs < 1_000) {
    throw new SmokeError('args', 'ARGS', '--timeout must be at least 1000ms');
  }
  if (options.focusMarketplace && (!options.marketplace || options.skipUi)) {
    throw new SmokeError('args', 'ARGS', '--focus-marketplace is diagnostic-only and requires --marketplace without --skip-ui');
  }
  if (options.focusSecondary && (options.focusMarketplace || options.skipUi)) {
    throw new SmokeError('args', 'ARGS', '--focus-secondary is diagnostic-only and cannot combine with --focus-marketplace or --skip-ui');
  }
  if (options.focusLayout && (options.focusMarketplace || options.focusSecondary || options.skipUi || options.marketplace)) {
    throw new SmokeError('args', 'ARGS', '--focus-layout runs only the layout comparison.');
  }
  return options;
};

const findFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const collectProcesses = () => {
  const output = spawnSyncText('ps', ['-eo', 'pid=,ppid=']);
  const rows = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
};

const spawnSyncText = (command, args) => {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return result.stdout ?? '';
  } catch {
    return '';
  }
};

const descendantsOf = (rootPid) => {
  const rows = collectProcesses();
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const found = new Set();
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (found.has(pid)) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...found];
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const redact = (text, secrets = []) => {
  let value = String(text ?? '');
  for (const secret of secrets) {
    if (secret) value = value.split(String(secret)).join('[redacted]');
  }
  return value.slice(-8_000);
};

const httpJson = async (url, { method = 'GET', body, timeoutMs = 10_000 } = {}) => {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: response.status, json, text };
};

const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeError(label, 'BAD_JSON', `${label} returned unreadable JSON`, { preview: String(text).slice(0, 500) });
  }
};

const pngInfo = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  return {
    path: filePath,
    bytes: buffer.length,
    signature: buffer.subarray(0, 8).toString('hex'),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
};

const fileIdentity = (filePath) => {
  try {
    const bytes = fs.readFileSync(filePath);
    return { path: filePath, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { path: filePath, bytes: null, sha256: null };
  }
};

const writeExecutableStub = (filePath, source) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
};

// The extension catalog may enumerate models; any other command is a test failure.
const stubModelCliSource = () => `#!${process.execPath}
if (process.argv.length !== 3 || process.argv[2] !== 'models') process.exit(2);
process.stdout.write('synthetic/provider-alpha\\nsynthetic/provider-beta\\nsynthetic/provider-gamma\\nopenai/gpt-5.1\\nanthropic/claude-sonnet-4-5\\n');
`;

const makeScratchConfig = (configFile) => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const content = `{
  // Synthetic OMOS target used only by the isolated smoke harness.
  // Extra agent metadata and multiple positions are legitimate supported shapes.
  "presets": {
    "solo": {
      "agents": {
        "reviewer": {
          "model": [
            "anthropic/claude-sonnet-4-5:high",
            { "id": "openai/gpt-5.1", "variant": "low" }
          ],
          "variant": "high",
          "description": "Synthetic reviewer",
          "prompt": "Review synthetic code only.",
          "temperature": 0.2
        },
        "docs-writer": {
          "model": "anthropic/claude-sonnet-4-5",
          "description": "Synthetic docs"
        }
      }
    }
  },
  "agents": {
    "builder": {
      "model": "openai/gpt-5.1:low",
      "prompt": "Build synthetic code."
    },
    "planner": {
      "model": "anthropic/claude-sonnet-4-5:high",
      "temperature": 0.1
    }
  },
  "council": {
    "presets": {
      "panel": {
        "seat-one": { "model": "anthropic/claude-sonnet-4-5" },
        "seat-two": {
          "model": ["openai/gpt-5.1:high", "anthropic/claude-sonnet-4-5"]
        }
      }
    }
  }
}
`;
  fs.writeFileSync(configFile, content);
  return content;
};

async function provePhoneDocuments({ browser, context, configFile, artifactDir, serviceJson }) {
  const options = { context, pointerType: 'touch', timeoutMs: 12_000 };
  const tap = label => browser.pointerClickText(label, options);
  const wait = expression => browser.waitForExpression(expression, { context, timeoutMs: 12_000 });
  const modal = 'dialog.editor-dialog[open]';
  const documentMode = `${modal}[data-dialog-mode="document"]`;
  const before = { hash: hashFile(configFile), backups: countBackups(path.dirname(configFile)) };
  const noFileWrite = () => hashFile(configFile) === before.hash && countBackups(path.dirname(configFile)) === before.backups;
  const fail = (code, message, details) => { throw new SmokeError('ui-host-page', code, message, details); };
  const measure = (end = false) => browser.evaluate(`(() => {
    const dialog = document.querySelector(${JSON.stringify(documentMode)});
    const diff = dialog?.querySelector('.diff');
    if (!diff) return null;
    if (${end}) diff.scrollTo({ left: diff.scrollWidth, top: diff.scrollHeight, behavior: 'instant' });
    const v = window.visualViewport;
    const left = v?.offsetLeft ?? 0, top = v?.offsetTop ?? 0;
    const right = left + (v?.width ?? document.documentElement.clientWidth);
    const bottom = top + (v?.height ?? document.documentElement.clientHeight);
    const rect = node => { const r = node.getBoundingClientRect(); return {
      left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height,
    }; };
    return JSON.stringify({ viewport:{left,top,right,bottom}, dialog:rect(dialog), diff:rect(diff),
      title:dialog.querySelector('.dialog-title').textContent,
      commentWarning:/comments inside changed values/i.test(dialog.innerText),
      maxX:diff.scrollWidth - diff.clientWidth, maxY:diff.scrollHeight - diff.clientHeight,
      x:diff.scrollLeft, y:diff.scrollTop,
      actions:[...dialog.querySelectorAll('.dialog-actions button')].map(button => ({
        ...rect(button), text:button.textContent.trim(), disabled:button.disabled,
      })) });
  })()`, { context }).then(JSON.parse);
  const verify = (m, title, labels) => {
    const v = m?.viewport;
    if (!v || m.title !== title || m.commentWarning
      || !['left', 'top', 'right', 'bottom'].every(edge => Math.abs(m.dialog[edge] - v[edge]) <= 2)
      || m.diff.height <= 0 || !labels.every(text => m.actions.some(a => a.text === text && !a.disabled
        && a.width >= 44 && a.height >= 44 && a.left >= v.left - 1 && a.right <= v.right + 1
        && a.top >= m.diff.bottom - 1 && a.bottom <= v.bottom + 1))) {
      fail('PHONE_DOCUMENT_GEOMETRY', `${title} does not fill the viewport with accessible actions.`, m);
    }
  };
  const capture = async name => {
    const { path: file } = await browser.screenshot(path.join(artifactDir, `${name}.png`));
    return { name, ...pngInfo(file) };
  };
  const selected = (await readUiState(browser, context)).workspace.selectedId;
  const queue = `.queue-workspace[data-queue-id=${JSON.stringify(selected)}]`;
  const ids = ['synthetic/quiet-phone-review-custom-long-model-identifier', 'synthetic/quiet-phone-fallback-a', 'synthetic/quiet-phone-fallback-b'];
  for (const [index, id] of ids.entries()) {
    await browser.pointerClick(`${queue} ${index === 0 ? '.model-row[data-index="0"] .model-trigger' : '.queue-footer button'}`, options);
    await wait(`document.activeElement?.matches('#omos-model-picker[open] .model-search input')`);
    await browser.typeText(id, { context });
    await wait(`Boolean(document.querySelector('#omos-model-picker[open] .picker-use-id:not([hidden]) button:not(:disabled)'))`);
    await browser.pressKey('Enter', { context });
    await wait(`!document.querySelector('#omos-model-picker[open]') && [...document.querySelectorAll(${JSON.stringify(`${queue} .model-trigger`)})].some(node => node.textContent.trim() === ${JSON.stringify(id)})`);
  }
  await tap('Review changes');
  await wait(`Boolean(document.querySelector(${JSON.stringify(`${documentMode} .diff`)}))`);
  const actionLabels = ['Back to editing', 'Confirm and save'];
  const normal = await measure();
  verify(normal, 'Review all changes', actionLabels);
  if (normal.diff.height <= 0.6 * normal.dialog.height || !noFileWrite()) {
    fail('PHONE_REVIEW_SPACE', 'The normal review does not give the diff most of the viewport, or changed the file.', normal);
  }
  const artifacts = [await capture('quiet-phone-review')];
  await browser.setViewport(390, 320, 3);
  await wait(`(visualViewport?.height ?? innerHeight) <= 320`);
  await browser.evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`, { context });
  const short = await measure();
  const scrolled = await measure(true);
  verify(short, 'Review all changes', actionLabels);
  verify(scrolled, 'Review all changes', actionLabels);
  if (scrolled.maxX <= 1 || scrolled.maxY <= 1 || Math.abs(scrolled.x - scrolled.maxX) > 2
    || Math.abs(scrolled.y - scrolled.maxY) > 2 || JSON.stringify(scrolled.actions) !== JSON.stringify(short.actions)) {
    fail('PHONE_REVIEW_SCROLL', 'The diff did not reach both ends while the actions stayed fixed.', { short, scrolled });
  }
  await tap('Back to editing');
  await wait(`!document.querySelector(${JSON.stringify(modal)}) && document.querySelector('.dirty-count')?.textContent === '1 queue changed'`);
  const retained = (await readUiState(browser, context)).queues.find(row => row.id === selected);
  if (!ids.every(id => retained?.rows.some(row => row.model === id)) || !noFileWrite()) {
    fail('PHONE_REVIEW_BACK_NO_WRITE', 'Back did not retain the edits without writing.');
  }
  await browser.setViewport(390, 844, 3);
  await wait(`(visualViewport?.height ?? innerHeight) >= 760`);
  await browser.pointerClick(`${queue} [data-queue-action="reset"]`, options);
  await tap('Reset queue');
  await wait(`!document.querySelector(${JSON.stringify(modal)}) && document.querySelector('.dirty-count')?.textContent === 'No unsaved changes'`);

  // Inspect a real stored draft from the earlier desktop path, without recovery.
  const draftIds = async () => (await serviceJson('GET', '/drafts')).drafts.filter(row => row.targetPath === configFile).map(row => row.id).sort();
  const stored = await draftIds();
  const draftButton = await browser.evaluate(`([...document.querySelectorAll('.header-actions button')].find(button => button.textContent.trim().startsWith('Drafts (')))?.textContent.trim()`, { context });
  if (!stored.length || !draftButton) fail('PHONE_DRAFT_FIXTURE', 'No stored desktop draft was available for inspection.');
  await tap(draftButton);
  const inspectIndex = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('dialog[open] .recovery-row')];
    return rows.findIndex(row => row.querySelector('.recovery-path')?.textContent === ${JSON.stringify(configFile)});
  })()`, { context });
  if (inspectIndex < 0) fail('PHONE_DRAFT_FIXTURE', 'No draft row matched the synthetic target.');
  await browser.pointerClick(`${modal} .recovery-row:nth-of-type(${inspectIndex + 1}) .inline-actions button:first-of-type`, options);
  await wait(`Boolean(document.querySelector(${JSON.stringify(`${documentMode} .diff`)}))`);
  const details = await measure();
  verify(details, 'Stored draft details', ['Back to drafts']);
  artifacts.push(await capture('quiet-phone-draft-details'));
  await browser.pressKey('Escape', { context });
  await wait(`document.querySelector(${JSON.stringify(`${modal}[data-dialog-mode="normal"] .dialog-title`)})?.textContent === 'Stored drafts'
    && document.activeElement?.textContent.trim() === 'Inspect'`);
  await tap('Close');
  await wait(`!document.querySelector(${JSON.stringify(modal)})`);
  if (JSON.stringify(await draftIds()) !== JSON.stringify(stored) || !noFileWrite()) {
    fail('PHONE_DRAFT_NO_WRITE', 'Inspect modified the stored draft set or the OMOS file.');
  }
  return { normal, short, scrolled, details, hashUnchanged: true, backupsUnchanged: true, artifacts };
}

const main = async (argv) => {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  for (const [key, value] of [
    ['host-root', options.hostRoot],
    ['opencode', options.opencode],
    ['package', options.packageDir],
  ]) {
    if (!value) {
      process.stderr.write(`--${key} is required\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!options.skipUi && !options.firefox) {
    process.stderr.write(`--firefox is required unless --skip-ui is set\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.marketplace && options.skipUi) {
    process.stderr.write(`--marketplace requires the Firefox host UI proof; drop --skip-ui\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(path.resolve(options.output), `host-smoke-${stamp}-${process.pid}`);
  const dirs = {
    root: runDir,
    home: path.join(runDir, 'home'),
    config: path.join(runDir, 'config'),
    data: path.join(runDir, 'data'),
    cache: path.join(runDir, 'cache'),
    state: path.join(runDir, 'state'),
    tmp: path.join(runDir, 'tmp'),
    artifacts: path.join(runDir, 'artifacts'),
    logs: path.join(runDir, 'logs'),
    scratch: path.join(runDir, 'scratch'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const hostRoot = path.resolve(options.hostRoot);
  const opencodePath = path.resolve(options.opencode);
  const packageDir = path.resolve(options.packageDir);
  const hostPackageJsonPath = path.join(hostRoot, 'package.json');
  let hostCliPath;

  const report = {
    ok: false,
    kind: options.focusLayout ? 'layout-sample' : options.focusMarketplace ? 'marketplace-focused-smoke' : options.focusSecondary ? 'secondary-ui-focused-smoke' : 'host-smoke',
    startedAt: new Date().toISOString(),
    runDir,
    command: { argv: [...argv], cwd: process.cwd() },
    mode: {
      skipUi: options.skipUi,
      marketplace: options.marketplace,
      focusMarketplace: options.focusMarketplace,
      focusLayout: options.focusLayout,
      focusSecondary: options.focusSecondary,
      keep: options.keep,
      guestId: options.guestId,
      readyTimeoutMs: options.readyTimeoutMs,
    },
    versions: {
      node: process.version,
      firefoxRequested: options.firefox ?? null,
    },
    host: null,
    isolation: null,
    install: null,
    approval: null,
    service: null,
    configProof: null,
    drafts: null,
    favorites: null,
    favoritesUi: null,
    marketplaceUi: null,
    ui: null,
    cleanup: null,
    stages: [],
    missing: [],
    unverified: [],
  };
  const stage = async (name, action) => {
    const started = Date.now();
    try {
      const value = await action();
      report.stages.push({ name, ok: true, ms: Date.now() - started, summary: value?.summary ?? null });
      process.stdout.write(`[ok] ${name}${value?.summary ? `: ${value.summary}` : ''}\n`);
      return value;
    } catch (error) {
      error.stage = name;
      report.stages.push({
        name,
        ok: false,
        ms: Date.now() - started,
        error: {
          code: error.code ?? 'ERROR',
          message: redact(error.message),
          details: error.details ? JSON.parse(redact(JSON.stringify(error.details))) : null,
        },
      });
      throw error;
    }
  };

  const hostLogPath = path.join(dirs.logs, 'host.stdout.log');
  const hostErrPath = path.join(dirs.logs, 'host.stderr.log');
  const hostOut = fs.createWriteStream(hostLogPath, { flags: 'a' });
  const hostErr = fs.createWriteStream(hostErrPath, { flags: 'a' });
  let hostChild = null;
  let browser = null;
  let baseUrl = null;
  let hostPid = null;
  let ownedDescendants = [];
  let secrets = [];
  let favoritesBaseline = null;
  const preferencesPath = path.join(dirs.data, 'openchamber', 'preferences.json');
  const hostSettingsPath = path.join(dirs.data, 'openchamber', 'settings.json');
  const guestStoragePath = path.join(dirs.data, 'openchamber', 'guest-storage', `${options.guestId}.json`);
  const serviceDataPath = path.join(dirs.data, 'openchamber', 'guest-data', options.guestId);

  const api = (route, { method = 'GET', body, timeoutMs = 10_000 } = {}) => {
    if (!baseUrl) throw new SmokeError('api', 'HOST_NOT_READY', 'Host URL is not available');
    return httpJson(`${baseUrl}${route}`, { method, body, timeoutMs });
  };

  const serviceCall = async (method, route, body, { timeoutMs = 25_000 } = {}) => {
    const envelope = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/request`, {
      method: 'POST',
      body: { method, path: route, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      timeoutMs,
    });
    if (envelope.status !== 200 || !envelope.json) {
      const code = envelope.json?.error ?? `HTTP_${envelope.status}`;
      throw new SmokeError('service', 'SERVICE_PROXY_ERROR', `Service proxy refused ${method} ${route}: ${code}`, {
        status: envelope.status,
        body: envelope.text.slice(0, 1_000),
      });
    }
    const inner = envelope.json;
    const parsed = typeof inner.body === 'string' ? parseJson(inner.body, 'service') : inner.body;
    return { status: inner.status, data: parsed };
  };

  const serviceJson = async (method, route, body, { timeoutMs = 25_000, retries = false } = {}) => {
    const deadline = Date.now() + timeouts.serviceReadyMs;
    let last = null;
    do {
      try {
        const result = await serviceCall(method, route, body, { timeoutMs });
        if (result.status >= 200 && result.status < 300) return result.data;
        last = result;
        const code = result.data?.error?.code;
        if (!retries || !['SERVICE_FAILED', 'REQUEST_FAILED', 'NO_SERVICE', 'HOST_TIMEOUT'].includes(code)) {
          throw new SmokeError('service', code ?? 'SERVICE_HTTP', `Service answered ${result.status} for ${method} ${route}`, result.data);
        }
      } catch (error) {
        last = error;
        if (!retries) throw error;
      }
      await sleep(250);
    } while (Date.now() < deadline);
    throw new SmokeError('service', 'SERVICE_NOT_READY', `Service did not become ready for ${method} ${route}`, {
      last: last instanceof Error ? last.message : last,
    });
  };

  const timeouts = {
    hostReadyMs: options.readyTimeoutMs,
    serviceReadyMs: SERVICE_READY_TIMEOUT_MS,
  };

  const modelRef = (id) => {
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) throw new SmokeError('favorites', 'BAD_REF', `Not a provider/model ref: ${id}`);
    return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
  };
  const readOrderedRefs = (refs) => (Array.isArray(refs) ? refs.map((ref) => `${ref.providerID}/${ref.modelID}`) : null);
  // The stock host's own settings route is the only writer used for profile
  // favorites; this mirrors OpenChamber's Settings/Favorites UI save.
  const writeHostFavorites = (ids) => api('/api/config/settings', {
    method: 'PUT',
    body: { favoriteModels: ids.map(modelRef) },
    timeoutMs: 15_000,
  });

  try {
    await stage('preflight', async () => {
      if (!fs.existsSync(hostPackageJsonPath)) {
        throw new SmokeError('preflight', 'HOST_ROOT_INVALID', `No package.json under host root: ${hostRoot}`);
      }
      const hostManifest = parseJson(fs.readFileSync(hostPackageJsonPath, 'utf8'), 'host package.json');
      const declaredCli = hostManifest.bin?.openchamber;
      const realHost = fs.realpathSync(hostRoot);
      const entry = typeof declaredCli === 'string' && !path.isAbsolute(declaredCli) ? path.resolve(realHost, declaredCli) : null;
      hostCliPath = entry && fs.existsSync(entry) ? fs.realpathSync(entry) : null;
      if (hostManifest.name !== '@openchamber/web' || !hostCliPath?.startsWith(`${realHost}${path.sep}`)
        || !fs.statSync(hostCliPath).isFile()) {
        throw new SmokeError('preflight', 'HOST_ROOT_INVALID', `Expected an installed @openchamber/web package and its declared CLI under ${hostRoot}`);
      }
      if (!isExecutableFile(opencodePath)) {
        throw new SmokeError('preflight', 'OPENCODE_INVALID', `--opencode is not an executable file: ${opencodePath}`);
      }
      if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) {
        throw new SmokeError('preflight', 'PACKAGE_INVALID', `--package is not a directory: ${packageDir}`);
      }
      report.versions.host = { name: hostManifest.name, version: hostManifest.version };
      if (hostManifest.name !== '@openchamber/web' || hostManifest.version !== '2.7.1') {
        report.unverified.push(`Host is ${hostManifest.name}@${hostManifest.version}, expected @openchamber/web@2.7.1`);
      }
      report.host = { root: hostRoot, cli: hostCliPath, package: report.versions.host };
      report.bundles = {
        page: fileIdentity(path.join(packageDir, 'page', 'main.js')),
        styles: fileIdentity(path.join(packageDir, 'page', 'styles.css')),
        service: fileIdentity(path.join(packageDir, 'service', 'main.js')),
        manifest: fileIdentity(path.join(packageDir, 'package.json')),
      };
      return { summary: `${hostManifest.name}@${hostManifest.version}` };
    });

    await stage('host-start', async () => {
      const port = await findFreePort();
      baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        XDG_RUNTIME_DIR: path.join(dirs.state, 'runtime'),
        TMPDIR: dirs.tmp,
        PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        NO_COLOR: '1',
        TERM: 'dumb',
        USER: 'omos-smoke',
        LOGNAME: 'omos-smoke',
        OPENCHAMBER_DATA_DIR: path.join(dirs.data, 'openchamber'),
        OPENCODE_BINARY: opencodePath,
      };
      report.host.env = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, key === 'OPENCHAMBER_DATA_DIR' ? value : value]));
      report.host.port = port;
      report.host.command = `${process.execPath} ${hostCliPath} serve --port ${port} --host 127.0.0.1 --foreground --quiet`;

      hostChild = spawn(process.execPath, [
        hostCliPath,
        'serve',
        '--port', String(port),
        '--host', '127.0.0.1',
        '--foreground',
        '--quiet',
      ], {
        cwd: dirs.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      hostPid = hostChild.pid;
      hostChild.stdout.on('data', (chunk) => hostOut.write(chunk));
      hostChild.stderr.on('data', (chunk) => hostErr.write(chunk));
      hostChild.on('exit', (code, signal) => {
        report.host.exit = { code, signal, at: new Date().toISOString() };
      });

      const deadline = Date.now() + timeouts.hostReadyMs;
      let lastError = null;
      while (Date.now() < deadline) {
        if (!processAlive(hostPid)) {
          throw new SmokeError('host-start', 'HOST_EXITED', 'Host exited before becoming ready', {
            log: redact(fs.readFileSync(hostErrPath, 'utf8')),
          });
        }
        try {
          const health = await api('/health', { timeoutMs: 1_000 });
          if (health.status === 200 && (health.json?.status === 'ok' || health.json?.ok === true)) {
            report.host.health = health.json;
            report.host.readyAt = new Date().toISOString();
            return { summary: `pid ${hostPid} on ${baseUrl}` };
          }
          lastError = health.text.slice(0, 300);
        } catch (error) {
          lastError = error.message;
        }
        await sleep(200);
      }
      throw new SmokeError('host-start', 'HOST_READY_TIMEOUT', `Host did not answer /health within ${timeouts.hostReadyMs}ms`, {
        lastError,
        log: redact(fs.readFileSync(hostErrPath, 'utf8')),
      });
    });

    await stage('isolation-check', async () => {
      const guests = await api('/api/guests');
      if (guests.status !== 200 || !guests.json) {
        throw new SmokeError('isolation-check', 'GUESTS_UNAVAILABLE', 'Host did not list extensions', { status: guests.status });
      }
      const sessions = await api('/api/sessions/snapshot');
      const statusSessions = sessions.json?.statusSessions ?? null;
      const emptySessions = sessions.status === 200 && statusSessions && Object.keys(statusSessions).length === 0;
      let liveSessions = { available: false, count: null, error: null };
      try {
        const live = await api('/api/session', { timeoutMs: 3_000 });
        const rows = Array.isArray(live.json)
          ? live.json
          : (Array.isArray(live.json?.sessions)
            ? live.json.sessions
            : (Array.isArray(live.json?.data) ? live.json.data : null));
        if (live.status === 200 && rows) {
          liveSessions = { available: true, count: rows.length, error: null };
        } else {
          liveSessions = { available: false, count: null, error: `HTTP ${live.status}` };
        }
      } catch (error) {
        liveSessions = { available: false, count: null, error: redact(error.message) };
      }
      const emptyGuests = Array.isArray(guests.json.guests) && guests.json.guests.length === 0;
      report.isolation = {
        guestCount: guests.json.guests?.length ?? null,
        statusSessions,
        liveSessions,
        emptyGuests,
        emptySessions,
        dataDir: path.join(dirs.data, 'openchamber'),
      };
      if (!emptyGuests) {
        throw new SmokeError('isolation-check', 'GUESTS_NOT_EMPTY', 'Isolated host already has extensions; refusing to write', report.isolation);
      }
      if (!emptySessions) {
        throw new SmokeError('isolation-check', 'SESSIONS_NOT_EMPTY', 'Isolated host session snapshot is not empty; refusing to write', report.isolation);
      }
      if (liveSessions.available && liveSessions.count !== 0) {
        throw new SmokeError('isolation-check', 'SESSIONS_NOT_EMPTY', 'Isolated live OpenCode session list is not empty; refusing to write', report.isolation);
      }
      if (!liveSessions.available) throw new SmokeError('isolation-check', 'SESSION_LIST_UNVERIFIED',
        'Could not establish an empty isolated OpenCode session list before writes.', { error: liveSessions.error });
      return { summary: `0 extensions, 0 status sessions${liveSessions.available ? ', 0 live sessions' : ', live list not ready'}` };
    });

    await stage('install-package', async () => {
      const result = await api('/api/guests', {
        method: 'POST',
        body: { path: packageDir },
        timeoutMs: 20_000,
      });
      report.install = { requestedPath: packageDir, status: result.status, response: result.json };
      if (result.status !== 200 && result.status !== 201) {
        const code = result.json?.error ?? `HTTP_${result.status}`;
        const reason = result.json?.reason ? ` (${result.json.reason})` : '';
        throw new SmokeError('install-package', code, `Host refused the package: ${code}${reason}`, result.json ?? result.text.slice(0, 1_000));
      }
      const guest = result.json?.guest;
      if (!guest?.id) throw new SmokeError('install-package', 'BAD_INSTALL', 'Install response has no guest id', result.json);
      if (guest.id !== options.guestId) {
        throw new SmokeError('install-package', 'GUEST_ID_MISMATCH', `Installed guest id is ${guest.id}, expected ${options.guestId}`, guest);
      }
      report.install.guest = guest;
      return { summary: `${guest.id}@${guest.version ?? 'unversioned'}` };
    });

    await stage('capability-approval', async () => {
      const list = await api('/api/guests');
      const guest = list.json?.guests?.find((row) => row.id === options.guestId);
      if (!guest) throw new SmokeError('capability-approval', 'GUEST_MISSING', 'Installed guest is not in the catalog');
      const requested = guest.capabilities?.requested ?? [];
      const onlyService = requested.length === 1 && requested[0] === 'service';
      report.approval = { requested, onlyService, grantedBefore: guest.capabilities?.granted ?? [] };
      if (!onlyService) {
        throw new SmokeError(
          'capability-approval',
          'UNEXPECTED_CAPABILITIES',
          `Package requests ${JSON.stringify(requested)}; this harness approves only ["service"]`,
          { requested },
        );
      }
      const grant = await api(`/api/guests/${encodeURIComponent(options.guestId)}/capabilities`, {
        method: 'PUT',
        body: { granted: ['service'] },
      });
      if (grant.status !== 200) {
        throw new SmokeError('capability-approval', 'GRANT_FAILED', `Capability grant failed with HTTP ${grant.status}`, grant.json);
      }
      const granted = grant.json?.guest?.capabilities?.granted ?? [];
      report.approval.grantedAfter = granted;
      if (granted.length !== 1 || granted[0] !== 'service') {
        throw new SmokeError('capability-approval', 'GRANT_MISMATCH', 'Granted capabilities are not exactly ["service"]', { granted });
      }
      return { summary: 'granted ["service"]' };
    });

    await stage('service-health', async () => {
      const statusBefore = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/status`).catch(() => null);
      const failureBefore = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/failure`).catch(() => null);
      report.service = {
        statusBefore: statusBefore?.json ?? null,
        failureBefore: failureBefore?.json ?? null,
      };
      let health;
      try {
        health = await serviceJson('GET', '/health', undefined, { retries: true });
      } catch (error) {
        const statusAfter = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/status`).catch(() => null);
        const failureAfter = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/failure`).catch(() => null);
        report.service.statusAfter = statusAfter?.json ?? null;
        report.service.failureAfter = failureAfter?.json ?? null;
        error.details = {
          statusBefore: report.service.statusBefore,
          failureBefore: report.service.failureBefore,
          statusAfter: report.service.statusAfter,
          failureAfter: report.service.failureAfter,
          original: error.details ?? null,
        };
        throw error;
      }
      report.service.health = health;
      if (health?.ok !== true || health.version !== report.install.guest.version) {
        throw new SmokeError('service-health', 'BAD_HEALTH', 'Service /health did not report ok', health);
      }
      return { summary: `service ${health.version ?? 'unknown'}` };
    });

    await stage('configure-scratch-target', async () => {
      const scratchFile = path.join(dirs.scratch, 'opencode.jsonc');
      const scratchBefore = makeScratchConfig(scratchFile);
      const modelCwd = path.join(dirs.scratch, 'model-cwd');
      fs.mkdirSync(modelCwd, { recursive: true });
      const stub = path.join(dirs.scratch, 'bin', 'opencode-models-stub');
      writeExecutableStub(stub, stubModelCliSource());
      const settings = {
        configFile: scratchFile,
        opencodeBin: stub,
        modelCwd,
        opencodeConfigDir: '',
      };
      const saved = await serviceJson('POST', '/settings', settings);
      report.configProof = {
        scratchFile,
        scratchBefore,
        stub,
        settings,
        saved,
      };
      if (saved?.settings?.configFile !== scratchFile || saved?.settings?.opencodeBin !== stub) {
        throw new SmokeError('configure-scratch-target', 'SETTINGS_NOT_ECHOED', 'Service did not persist the explicit scratch settings', saved);
      }
      const current = await serviceJson('GET', '/settings');
      if (current?.settings?.configFile !== scratchFile) {
        throw new SmokeError('configure-scratch-target', 'SETTINGS_READBACK', 'Service /settings did not read the scratch target back', current);
      }
      return { summary: scratchFile };
    });

    await stage('config-load', async () => {
      const config = await serviceJson('GET', '/config');
      const groups = Array.isArray(config?.groups) ? config.groups : [];
      const editable = groups.filter((group) => group.readOnlyReason == null && Array.isArray(group.models) && group.models.length > 0);
      report.configProof.load = {
        target: config?.target ?? null,
        baseHash: config?.baseHash ?? null,
        groupCount: groups.length,
        editablePaths: editable.map((group) => group.path),
        kinds: [...new Set(groups.map((group) => group.kind))],
      };
      if (!config?.target?.path || !config?.baseHash || editable.length === 0) {
        throw new SmokeError('config-load', 'CONFIG_SHAPE', 'Scratch config did not yield an editable queue', report.configProof.load);
      }
      const realpath = fs.realpathSync(scratchFileOf(report));
      if (path.resolve(config.target.path) !== realpath) {
        throw new SmokeError('config-load', 'TARGET_MISMATCH', 'Pinned target is not the scratch file', {
          target: config.target.path,
          scratch: realpath,
        });
      }
      return { summary: `${groups.length} groups, ${editable.length} editable` };
    });

    await stage('preview-commit-replay', async () => {
      const config = await serviceJson('GET', '/config');
      const group = firstEditableGroup(config, []);
      if (!group) throw new SmokeError('preview-commit-replay', 'NO_GROUP', 'No editable group for preview');
      const newModel = 'omos-smoke/synthetic-model';
      const changes = [{
        path: group.path,
        models: group.models.map((model, index) => (index === 0 ? { id: newModel, variant: 'low' } : { ...model })),
      }];
      const preview = await serviceJson('POST', '/preview', {
        baseHash: config.baseHash,
        generation: config.target.generation,
        changes,
      });
      if (!preview?.previewToken || !preview?.diff) {
        throw new SmokeError('preview-commit-replay', 'NO_PREVIEW', 'Preview did not return a token and diff', preview);
      }
      const commit = await serviceJson('POST', '/commit', { previewToken: preview.previewToken });
      if (commit?.ok !== true) {
        throw new SmokeError('preview-commit-replay', 'COMMIT_FAILED', 'Commit did not report ok', commit);
      }
      const disk = fs.readFileSync(scratchFileOf(report), 'utf8');
      const afterConfig = await serviceJson('GET', '/config');
      const changedPath = JSON.stringify(group.path);
      const otherGroupsUnchanged = (config.groups ?? [])
        .filter((row) => JSON.stringify(row.path) !== changedPath)
        .every((row) => {
          const after = (afterConfig.groups ?? []).find((candidate) => JSON.stringify(candidate.path) === JSON.stringify(row.path));
          return after && JSON.stringify(after.models) === JSON.stringify(row.models);
        });
      const afterGroups = (afterConfig.groups ?? []).map((row) => ({ path: row.path, models: row.models, readOnlyReason: row.readOnlyReason }));
      const backupExists = typeof commit.backup === 'string' && fs.existsSync(commit.backup);
      report.configProof.commit = {
        preview: { previewToken: '[redacted]', changed: preview.changed, diff: preview.diff },
        commit,
        backupExists,
        diskContainsNewModel: disk.includes(newModel),
        commentsPreserved: disk.includes('// Synthetic OMOS target'),
        otherGroupsUnchanged,
        beforeGroups: (config.groups ?? []).map((row) => ({ path: row.path, models: row.models })),
        afterGroups,
      };
      if (!disk.includes(newModel)) {
        throw new SmokeError('preview-commit-replay', 'WRITE_MISSING', 'Committed model is not on disk');
      }
      if (!backupExists) {
        throw new SmokeError('preview-commit-replay', 'BACKUP_MISSING', 'Commit did not leave an existing backup', { backup: commit.backup });
      }
      if (!otherGroupsUnchanged) {
        throw new SmokeError('preview-commit-replay', 'UNRELATED_BYTES_LOST', 'Commit changed unrelated queues', report.configProof.commit);
      }
      if (!report.configProof.commit.commentsPreserved) {
        throw new SmokeError('preview-commit-replay', 'COMMENTS_LOST', 'Commit dropped unrelated comments from the scratch file');
      }

      const replay = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/request`, {
        method: 'POST',
        body: { method: 'POST', path: '/commit', body: JSON.stringify({ previewToken: preview.previewToken }) },
      });
      const replayData = replay.json?.body ? parseJson(replay.json.body, 'replay') : replay.json;
      report.configProof.replay = {
        httpStatus: replay.status,
        body: replay.json,
        rejected: replay.status >= 400 || replayData?.ok !== true,
      };
      if (!report.configProof.replay.rejected) {
        throw new SmokeError('preview-commit-replay', 'REPLAY_ACCEPTED', 'A used preview token was accepted again', replay.json);
      }
      return { summary: 'preview -> commit -> replay rejected' };
    });

    await stage('conflict-check', async () => {
      const config = await serviceJson('GET', '/config');
      const group = firstEditableGroup(config, []);
      if (!group) throw new SmokeError('conflict-check', 'NO_GROUP', 'No editable group for conflict preview');
      const changes = [{
        path: group.path,
        models: group.models.map((model, index) => (index === 0 ? { id: 'omos-smoke/conflict-model', variant: '' } : { ...model })),
      }];
      const preview = await serviceJson('POST', '/preview', {
        baseHash: config.baseHash,
        generation: config.target.generation,
        changes,
      });
      if (!preview?.previewToken) throw new SmokeError('conflict-check', 'NO_PREVIEW', 'Conflict preview has no token', preview);
      const scratchFile = scratchFileOf(report);
      fs.appendFileSync(scratchFile, `\n// external conflict ${Date.now()}\n`);
      const commit = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/request`, {
        method: 'POST',
        body: { method: 'POST', path: '/commit', body: JSON.stringify({ previewToken: preview.previewToken }) },
      });
      const commitData = commit.json?.body ? parseJson(commit.json.body, 'conflict') : commit.json;
      report.configProof.conflict = {
        httpStatus: commit.status,
        body: commit.json,
        rejected: commit.status >= 400 || commitData?.ok !== true,
        externalChangePreserved: fs.readFileSync(scratchFile, 'utf8').includes('external conflict'),
      };
      if (!report.configProof.conflict.rejected) {
        throw new SmokeError('conflict-check', 'CONFLICT_ACCEPTED', 'Commit accepted a stale preview after an external change', commit.json);
      }
      return { summary: 'stale preview rejected' };
    });

    await stage('draft-roundtrip', async () => {
      const config = await serviceJson('GET', '/config');
      const group = firstEditableGroup(config, []);
      if (!group) throw new SmokeError('draft-roundtrip', 'NO_GROUP', 'No editable group for a draft');
      const draft = {
        id: crypto.randomUUID(),
        targetPath: config.target.path,
        baseHash: config.baseHash,
        originals: [{ path: group.path, models: group.models.map((model) => ({ ...model })) }],
        changes: [{
          path: group.path,
          models: group.models.map((model, index) => (index === 0 ? { id: 'omos-smoke/draft-model', variant: 'high' } : { ...model })),
        }],
      };
      const created = await serviceJson('POST', '/drafts', draft);
      const listed = await serviceJson('GET', '/drafts');
      const ids = (listed?.drafts ?? []).map((row) => row.id);
      if (!ids.includes(draft.id)) {
        throw new SmokeError('draft-roundtrip', 'DRAFT_NOT_LISTED', 'Created draft is not in GET /drafts', { draftId: draft.id, ids });
      }
      const removedEnvelope = await api(`/api/guests/${encodeURIComponent(options.guestId)}/service/request`, {
        method: 'POST',
        body: { method: 'DELETE', path: `/drafts/${encodeURIComponent(draft.id)}` },
      });
      const removed = removedEnvelope.json?.body ? parseJson(removedEnvelope.json.body, 'draft-delete') : removedEnvelope.json;
      const after = await serviceJson('GET', '/drafts');
      const remaining = (after?.drafts ?? []).map((row) => row.id);
      report.drafts = {
        created,
        listedIds: ids,
        deleteStatus: removedEnvelope.status,
        deleteBody: removed,
        remaining,
      };
      if (remaining.includes(draft.id)) {
        throw new SmokeError('draft-roundtrip', 'DRAFT_NOT_DELETED', 'Deleted draft is still listed');
      }
      return { summary: `draft ${draft.id} persisted and removed` };
    });

    const uiFixture = {
      dir: path.join(dirs.root, 'ui'),
      configFile: path.join(dirs.root, 'ui', 'opencode.jsonc'),
      stub: path.join(dirs.root, 'ui', 'opencode-stub'),
      settings: null,
    };
    await stage('ui-fixture-setup', async () => {
      fs.mkdirSync(uiFixture.dir, { recursive: true });
      makeScratchConfig(uiFixture.configFile);
      if (options.focusLayout) {
        // Identical three-position input for both releases. No snapshot from a
        // later edit, device-specific width, or different font counts as the baseline.
        fs.writeFileSync(uiFixture.configFile, JSON.stringify({
          presets: { solo: { agents: { reviewer: {
            variant: 'high',
            model: ['synthetic/provider-gamma', { id: 'openai/gpt-5.1', variant: 'low' }, 'synthetic/provider-beta'],
          } } } },
        }, null, 2));
      }
      writeExecutableStub(uiFixture.stub, stubModelCliSource());
      uiFixture.settings = await serviceJson('POST', '/settings', {
        configFile: uiFixture.configFile,
        opencodeBin: uiFixture.stub,
        modelCwd: uiFixture.dir,
        opencodeConfigDir: '',
      });
      report.uiFixture = {
        configFile: uiFixture.configFile,
        stub: uiFixture.stub,
        settings: uiFixture.settings,
        backupsBefore: countBackups(uiFixture.dir),
        hashBefore: hashFile(uiFixture.configFile),
      };
      if (report.uiFixture.backupsBefore !== 0) {
        throw new SmokeError('ui-fixture-setup', 'UNEXPECTED_BACKUP', 'Fresh UI scratch directory already has backups');
      }
      return { summary: uiFixture.configFile };
    });

    const pageTitle = report.install?.guest?.pageTitle ?? report.install?.guest?.name ?? options.guestId;
    const pageEntry = report.install?.guest?.pageEntry ?? null;
    if (options.focusLayout) {
      await stage('layout-sample', async () => {
        report.layout = [];
        for (const [name, width, height, mobile] of [['desktop', 1280, 800, false], ['phone', 390, 844, true]]) {
          browser = await launchFirefox({ firefox: options.firefox, output: dirs.artifacts, dark: true, mobile,
            label: `layout-${name}`, timeoutMs: 20_000 });
          await browser.setViewport(width, height, mobile ? 3 : 1);
          await browser.navigate(baseUrl, { timeoutMs: 30_000 });
          const frame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile });
          await browser.waitForExpression(`document.querySelector('.queue-workspace[data-queue-id] .queue-name')?.textContent.toLowerCase() === 'reviewer'
            && document.querySelectorAll('.queue-workspace[data-queue-id] .model-row').length === 3`, { context: frame.context, timeoutMs: 15_000 });
          const metrics = JSON.parse(await browser.evaluate(`(() => {
            const section = document.querySelector('.queue-workspace[data-queue-id]');
            section.scrollIntoView({block:'start'});
            const models = Array.from(section.querySelectorAll('.model-trigger'));
            return JSON.stringify({queue:section.dataset.queueId, count:models.length,
              models:models.map(m => m.title), height:section.getBoundingClientRect().height, viewport:[innerWidth,innerHeight],
              rootFont:getComputedStyle(document.documentElement).fontSize, modelFont:getComputedStyle(models[0].querySelector('span') || models[0]).fontSize});
          })()`, { context: frame.context }));
          if (metrics.count !== 3 || !(metrics.height > 0)) throw new SmokeError('layout-sample', 'NO_GEOMETRY', 'Expected three measurable model positions.');
          const shot = await browser.screenshot(path.join(dirs.artifacts, `layout-${name}.png`));
          await browser.pointerClick('.queue-workspace[data-queue-id] .model-trigger', { context: frame.context, pointerType: mobile ? 'touch' : 'mouse' });
          await browser.waitForExpression(`!document.querySelector('#omos-model-picker').hidden && document.querySelector('#omos-model-picker [role="option"]')`, { context: frame.context });
          const pickerShot = await browser.screenshot(path.join(dirs.artifacts, `layout-${name}-picker.png`));
          const extra = {};
          if (report.install.guest.version !== '0.2.0') {
            // A scrollbar can reduce the *visual* viewport below innerWidth.
            // Check the selected glyph run against each vertically clipping
            // ancestor inside its button/option, at normal and enlarged text.
            const geometry = await browser.evaluate(`(async () => {
              const root = document.documentElement, prior = root.style.fontSize;
              const original = parseFloat(getComputedStyle(root).fontSize);
              function fits(label, control) {
                if (!label || !control || !label.firstChild) return false;
                const range = document.createRange(); range.selectNodeContents(label);
                const glyph = range.getBoundingClientRect();
                if (glyph.height <= 0) return false;
                let parent = label;
                while (parent) {
                  if (parent === control || /hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowY)) {
                    const box=parent.getBoundingClientRect();
                    if (glyph.top < box.top - 1 || glyph.bottom > box.bottom + 1) return false;
                  }
                  if (parent === control) break;
                  parent = parent.parentElement;
                }
                return true;
              }
              const read = () => {
                const button=document.querySelector('.queue-workspace[data-queue-id] .model-trigger');
                const row=document.querySelector('#omos-model-picker [role="option"][aria-selected="true"]');
                return {button:fits(button?.querySelector('span'),button), selected:fits(row?.querySelector('.oc-sdk-row-title'),row)};
              };
              try {
                const normal=read();root.style.fontSize=(original*1.5)+'px';
                await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
                return JSON.stringify({normal,enlarged:read()});
              } finally {root.style.fontSize=prior}
            })()`, {context:frame.context});
            extra.textFits = JSON.parse(geometry);
            if (![extra.textFits.normal, extra.textFits.enlarged].every(result => result.button && result.selected)) {
              throw new SmokeError('layout-sample','CLIPPED_MODEL','Selected model text is missing or clipped vertically.',extra.textFits);
            }
          }
          if (mobile && report.install.guest.version !== '0.2.0') {
            await browser.pressKey('Escape', { context:frame.context });
            const selectPrimary = () => browser.selectSdkOption('.phone-selector', 'Orchestrator', { context: frame.context, pointer:true, pointerType:'touch' });
            const ensurePrimaryVisible = () => browser.waitForExpression(`(() => {
              const heading = document.querySelector('.primary-slot[data-primary-agent="orchestrator"] .queue-name');
              const text = document.querySelector('.primary-slot[data-primary-agent="orchestrator"] .primary-explanation');
              return heading && text && document.activeElement === heading
                && heading.getBoundingClientRect().top >= document.querySelector('.phone-selector').getBoundingClientRect().bottom - 1
                && text.getBoundingClientRect().bottom <= document.querySelector('.save-bar').getBoundingClientRect().top;
            })()`, {context:frame.context, timeoutMs:5_000});
            await selectPrimary(); await ensurePrimaryVisible();
            await browser.evaluate('window.scrollTo(0,0)', { context:frame.context });
            await selectPrimary(); await ensurePrimaryVisible();
            extra.primary = pngInfo((await browser.screenshot(path.join(dirs.artifacts,'phone-orchestrator-clearance.png'))).path);
            extra.sameDestinationJump = true;
          }
          const close = await browser.close(); browser = null;
          if (!close?.browserExited || !close?.profileRemoved) throw new SmokeError('layout-sample', 'CLEANUP', 'The owned browser did not settle.');
          report.layout.push({name,...metrics,capture:pngInfo(shot.path),picker:pngInfo(pickerShot.path),...extra});
        }
        return { summary: report.layout.map(s => `${s.name} ${s.height.toFixed(1)} CSS px`).join('; ') };
      });
    } else if (options.skipUi) {
      report.missing.push('UI proof skipped by --skip-ui; no screenshot or frame evidence');
    } else {
      if (options.focusMarketplace) {
        report.ui = { allArtifacts: [], diagnosticOnly: true };
        report.unverified.push('Focused diagnostic runs only its named feature UI; not the combined release proof.');
      } else {
      if (options.focusSecondary) {
        report.ui = { allArtifacts: [], diagnosticOnly: true };
        report.unverified.push('Focused diagnostic omits core UI; not the combined release proof.');
      } else {
      const browserProof = await stage('ui-host-page', async () => {
        const sessions = [];
        const captures = [];
        const workflowArtifacts = [];
        let workflow = null;

        // Desktop light runs the full DOM workflow: add/cancel, picker keyboard,
        // focus, variant, copy/paste cancel, review/save, real draft recovery.
        browser = await launchFirefox({
          firefox: options.firefox,
          output: dirs.artifacts,
          label: 'host-desktop-light',
          timeoutMs: 20_000,
        });
        await browser.setViewport(1280, 800, 1);
        await browser.navigate(baseUrl, { timeoutMs: 30_000 });
        const desktopFrame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
        workflow = await runDomWorkflow({
          browser,
          context: desktopFrame.context,
          scratchFile: uiFixture.configFile,
          artifactsDir: dirs.artifacts,
          serviceJson,
          baseUrl,
          pageTitle,
        });
        workflowArtifacts.push(...workflow.artifacts);
        const workflowState = await readUiState(browser, workflow.context);
        const workflowThemeClass = await browser.evaluate('document.documentElement.className');
        const workflowExecutable = browser.executable;
        const workflowResolvedVia = browser.resolvedVia;
        const desktopCapture = workflow.artifacts.find((artifact) => artifact.name === 'desktop-light');
        captures.push({
          label: 'desktop-light',
          variant: { label: 'desktop-light', dark: false, mobile: false, width: 1280, height: 800 },
          viewport: '1280x800',
          ...pngInfo(desktopCapture.path),
        });
        const desktopClose = await browser.close();
        browser = null;
        sessions.push({
          label: 'desktop-light',
          variant: { label: 'desktop-light', dark: false, mobile: false, width: 1280, height: 800 },
          executable: workflowExecutable,
          resolvedVia: workflowResolvedVia,
          close: desktopClose,
          page: {
            childUrl: workflow.childUrl,
            childHasParent: true,
            themeClass: workflowThemeClass,
            checks: workflow.checks,
            workflow: {
              initialHash: workflow.initialHash,
              finalHash: workflow.finalHash,
              backupsBefore: workflow.backupsBefore,
              backupsAfter: workflow.backupsAfter,
              draftIds: workflow.draftIds,
              lostAck: workflow.lostAck,
              frameConsoleErrors: workflow.frameConsoleErrors,
              hostConsoleErrors: workflow.hostConsoleErrors,
            },
          },
        });

        // Mobile and dark verify the loaded page, host mobile classes, no global
        // overflow and frame console cleanliness; captures stay independent of
        // the interactive workflow above.
        for (const variant of [
          { label: 'mobile-light', dark: false, mobile: true, width: 390, height: 844 },
          { label: 'desktop-dark', dark: true, mobile: false, width: 1280, height: 800 },
          { label: 'mobile-dark', dark: true, mobile: true, width: 390, height: 844 },
        ]) {
          browser = await launchFirefox({
            firefox: options.firefox,
            output: dirs.artifacts,
            dark: variant.dark,
            mobile: variant.mobile,
            label: `host-${variant.label}`,
            timeoutMs: 20_000,
          });
          await browser.setViewport(variant.width, variant.height, variant.mobile ? 3 : 1);
          await browser.navigate(baseUrl, { timeoutMs: 30_000 });
          const frame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: variant.mobile });
          const state = await waitForLoadedQueue(browser, frame.context, { timeoutMs: 25_000 });
          let disclosure = null;
          if (variant.label === 'mobile-light') {
            await browser.pointerClick('.target-trigger', { context: frame.context, pointerType: 'touch' });
            let disclosed = await readUiState(browser, frame.context);
            const deadline = Date.now() + 8_000;
            while (Date.now() < deadline && !(disclosed.dialog.open && disclosed.dialog.title === 'Global OMOS file')) {
              await sleep(150);
              disclosed = await readUiState(browser, frame.context);
            }
            if (!disclosed.dialog.open || !(disclosed.dialog.body || '').includes(uiFixture.configFile)) {
              throw new SmokeError('ui-host-page', 'FILE_DISCLOSURE_TOUCH', 'Touch activation did not disclose the full OMOS path', { dialog: disclosed.dialog });
            }
            const disclosureShot = await browser.screenshot(path.join(dirs.artifacts, 'ui-file-disclosure-mobile.png'));
            workflowArtifacts.push({ name: 'ui-file-disclosure-mobile', ...pngInfo(disclosureShot.path) });
            disclosure = { dialog: disclosed.dialog, screenshot: disclosureShot };
            await browser.pressKey('Escape', { context: frame.context });
            await sleep(300);
          }
          let compactProof = null;
          if (variant.label === 'mobile-light') {
            const buttons = state.rows[0]?.controlsButtons ?? [];
            const expectedActions = ['variant', 'up', 'down'];
            const removeButton = buttons.find((button) => /^Remove /.test(button.aria || ''));
            const compactButtons = [...expectedActions.map((action) => buttons.find((button) => button.action === action)), removeButton].filter(Boolean);
            if (!state.rows[0]?.hasModelControls || compactButtons.length !== 4
              || compactButtons.some((button) => button.width < 44 || button.height < 44)) {
              throw new SmokeError('ui-host-page', 'COMPACT_TOUCH_GEOMETRY',
                'Compact variant/arrow/Remove controls are not in one model-controls row at 44 CSS px', {
                row: state.rows[0], buttons,
              });
            }
            if (removeButton?.intent !== 'destructive') {
              throw new SmokeError('ui-host-page', 'REMOVE_INTENT', 'Remove is not destructive in the mobile layout', { removeButton });
            }
            const compactShot = await browser.screenshot(path.join(dirs.artifacts, 'mobile-compact-controls.png'));
            workflowArtifacts.push({ name: 'mobile-compact-controls', ...pngInfo(compactShot.path) });
            await browser.pointerClick(`.queue-workspace[data-queue-id=${JSON.stringify(state.workspace.selectedId)}] .model-row[data-index="0"] [data-action="model"]`, {
              context: frame.context, pointerType: 'touch',
            });
            let pickerState = await readUiState(browser, frame.context);
            const pickerDeadline = Date.now() + 12_000;
            while (Date.now() < pickerDeadline && pickerState.picker.hidden) {
              await sleep(150);
              pickerState = await readUiState(browser, frame.context);
            }
            const inside = (picker) => Boolean(picker.rect && picker.viewport
              && Math.abs(picker.rect.left - picker.viewport.left) <= 1
              && Math.abs(picker.rect.top - picker.viewport.top) <= 1
              && Math.abs(picker.rect.width - picker.viewport.width) <= 1
              && Math.abs(picker.rect.height - picker.viewport.height) <= 1);
            if (pickerState.picker.hidden || !inside(pickerState.picker)) {
              throw new SmokeError('ui-host-page', 'MOBILE_PICKER_PLACEMENT', 'Touch model popup is not inside the visual viewport', {
                picker: pickerState.picker,
              });
            }
            const pickerShot = await browser.screenshot(path.join(dirs.artifacts, 'mobile-model-popup.png'));
            workflowArtifacts.push({ name: 'mobile-model-popup', ...pngInfo(pickerShot.path) });
            await browser.setViewport(390, 320, 3);
            await sleep(450);
            const shortState = await readUiState(browser, frame.context);
            if (shortState.picker.hidden || !inside(shortState.picker) || shortState.picker.query !== pickerState.picker.query
              || shortState.picker.focused !== 'Search or enter model ID') {
              throw new SmokeError('ui-host-page', 'MOBILE_SOFT_KEYBOARD_PICKER',
                'Short visual viewport lost the model popup query, focus or bounds', { picker: shortState.picker, active: shortState.active });
            }
            const shortShot = await browser.screenshot(path.join(dirs.artifacts, 'mobile-soft-keyboard.png'));
            workflowArtifacts.push({ name: 'mobile-soft-keyboard', ...pngInfo(shortShot.path) });
            await browser.pressKey('Escape', { context: frame.context });
            await browser.setViewport(variant.width, variant.height, 3);
            await sleep(300);
            const choosePhoneQueue = async (name) => {
              const matches = (await serviceJson('GET', '/config')).groups.filter(group => group.name === name);
              if (matches.length !== 1) throw new SmokeError('ui-host-page', 'PHONE_JUMP_OPTION', `No unique phone queue ${name}`);
              await browser.selectSdkOption('.phone-selector', matches[0].name, { context: frame.context, pointer: true, pointerType: 'touch' });
            };
            const reviewerBeforePhone = state.queues.find((queue) => queue.id === state.workspace.selectedId);
            const draftValues = (queue) => ({ dirty: queue?.dirty,
              rows: (queue?.rows ?? []).map(({ index, model, variant }) => ({ index, model, variant })) });
            await choosePhoneQueue('planner');
            let phoneState = await readUiState(browser, frame.context);
            const phoneDeadline = Date.now() + 8_000;
            while (Date.now() < phoneDeadline && !(phoneState.active.isHeading && phoneState.active.text === 'planner')) {
              await sleep(150);
              phoneState = await readUiState(browser, frame.context);
            }
            if (!phoneState.active.isHeading || phoneState.active.text !== 'planner'
              || phoneState.workspace.count !== state.workspace.count
              || JSON.stringify(phoneState.workspace.ids) !== JSON.stringify(state.workspace.ids)
              || JSON.stringify(draftValues(phoneState.queues.find((queue) => queue.id === reviewerBeforePhone?.id))) !== JSON.stringify(draftValues(reviewerBeforePhone))) {
              throw new SmokeError('ui-host-page', 'PHONE_JUMP', 'Phone jump replaced a workspace, lost focus or changed a draft', {
                active: phoneState.active, workspace: phoneState.workspace,
                before: draftValues(reviewerBeforePhone),
                after: draftValues(phoneState.queues.find((queue) => queue.id === reviewerBeforePhone?.id)),
              });
            }
            await choosePhoneQueue('reviewer');
            phoneState = await readUiState(browser, frame.context);
            const reviewerDeadline = Date.now() + 8_000;
            while (Date.now() < reviewerDeadline && !(phoneState.active.isHeading && phoneState.active.text === 'reviewer')) {
              await sleep(150);
              phoneState = await readUiState(browser, frame.context);
            }
            compactProof = { buttons: compactButtons, picker: pickerState.picker, shortPicker: shortState.picker,
              phoneJump: { active: phoneState.active, workspace: phoneState.workspace }, artifacts: [compactShot, pickerShot, shortShot] };
          }
          let quietReviewProof = null;
          if (variant.label === 'mobile-dark') {
            const quietHash = hashFile(uiFixture.configFile);
            const quietBackups = countBackups(path.dirname(uiFixture.configFile));
            quietReviewProof = await provePhoneDocuments({ browser, context: frame.context,
              configFile: uiFixture.configFile, artifactDir: dirs.artifacts, serviceJson });
            workflowArtifacts.push(...quietReviewProof.artifacts);
          }
          const variantRemove = state.rows[0]?.controlsButtons.find((button) => /^Remove /.test(button.aria || ''));
          if (variantRemove?.intent !== 'destructive') {
            throw new SmokeError('ui-host-page', 'VARIANT_REMOVE_INTENT',
              `Remove is not destructive for ${variant.label}`, { remove: variantRemove });
          }
          const themeClass = await browser.evaluate('document.documentElement.className');
          const consoleErrors = await browser.consoleErrors(frame.context);
          const hostConsoleErrors = await browser.consoleErrors(browser.context);
          const screenshot = await browser.screenshot(path.join(dirs.artifacts, `${variant.label}.png`));
          if (!state.queueName || state.rows.length === 0 || !state.footer.visible) {
            throw new SmokeError('ui-host-page', 'PAGE_NOT_LOADED', `The page did not show a loaded queue for ${variant.label}`, { state });
          }
          if (state.overflow.documentWidth > state.overflow.viewportWidth + 1) {
            throw new SmokeError('ui-host-page', 'GLOBAL_OVERFLOW', `The page has global horizontal overflow for ${variant.label}`, state.overflow);
          }
          if (consoleErrors.length > 0) {
            throw new SmokeError('ui-host-page', 'FRAME_CONSOLE_ERRORS', `The extension frame logged errors for ${variant.label}`, { consoleErrors });
          }
          const close = await browser.close();
          browser = null;
          captures.push({
            label: variant.label,
            variant: { ...variant },
            viewport: `${variant.width}x${variant.height}`,
            ...pngInfo(screenshot.path),
          });
          sessions.push({
            label: variant.label,
            variant: { ...variant },
            close,
            page: {
              childUrl: frame.url,
              childHasParent: true,
              themeClass,
              queueName: state.queueName,
              rowCount: state.rows.length,
              footer: state.footer,
              overflow: state.overflow,
              disclosure,
              compactProof,
              quietReviewProof,
              frameConsoleErrors: consoleErrors,
              hostConsoleErrors,
            },
          });
        }

        // Independent target with no marketplace source or explicit primary.
        // Reopen the page and exercise the same reviewed writer, not direct POSTs.
        const primaryDir = path.join(dirs.root, 'primary');
        fs.mkdirSync(primaryDir);
        const primaryFile = path.join(primaryDir, 'opencode.jsonc');
        fs.writeFileSync(primaryFile, JSON.stringify({presets: {work: {agents: {reviewer: {model: 'synthetic/provider-alpha'}}}},
          unrelatedRootCanary: 'preserve this exact synthetic value'}, null, 2));
        await serviceJson('POST', '/settings', { configFile: primaryFile, opencodeBin: uiFixture.stub, modelCwd: primaryDir, opencodeConfigDir: '' });
        browser = await launchFirefox({firefox: options.firefox, output: dirs.artifacts, label: 'primary-manual', timeoutMs: 20_000});
        await browser.setViewport(1280, 800, 1);
        await browser.navigate(baseUrl, {timeoutMs: 30_000});
        const primaryFrame = await openExtensionPage(browser, {baseUrl, pageTitle});
        const primary = await runPrimaryDomWorkflow({browser, context: primaryFrame.context, baseUrl, pageTitle,
          configFile: primaryFile, artifactsDir: dirs.artifacts, serviceJson});
        report.primary = { checks:primary.checks, slot:primary.slot, finalHash:primary.finalHash, close:await browser.close() };
        browser = null;
        if (!report.primary.close?.browserExited || !report.primary.close?.profileRemoved) throw new SmokeError('ui-host-page', 'PRIMARY_CLEANUP', 'Primary browser did not settle.');
        workflowArtifacts.push(...primary.artifacts);
        // Missing/broken target: Settings remains reachable and the full
        // selected path is explicit. Empty target: mobile keeps Reload
        // reachable even with no explicit queues.
        const missingConfig = path.join(uiFixture.dir, 'missing-opencode.jsonc');
        const emptyConfig = path.join(uiFixture.dir, 'empty.jsonc');
        const commonSettings = {
          opencodeBin: uiFixture.stub,
          modelCwd: uiFixture.dir,
          opencodeConfigDir: '',
        };
        fs.rmSync(missingConfig, { force: true });
        await serviceJson('POST', '/settings', { ...commonSettings, configFile: missingConfig });
        browser = await launchFirefox({
          firefox: options.firefox, output: dirs.artifacts, label: 'host-missing-config', timeoutMs: 20_000,
        });
        await browser.setViewport(1280, 800, 1);
        await browser.navigate(baseUrl, { timeoutMs: 30_000 });
        const missingFrame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
        let missingState = await readUiState(browser, missingFrame.context);
        const missingDeadline = Date.now() + 10_000;
        while (Date.now() < missingDeadline && !(missingState.loadState.visible && missingState.targetPath)) {
          await sleep(150);
          missingState = await readUiState(browser, missingFrame.context);
        }
        if (missingState.targetPath !== missingConfig && !String(missingState.targetPath || '').endsWith('missing-opencode.jsonc')) {
          throw new SmokeError('ui-host-page', 'MISSING_CONFIG_PATH', 'Missing-target state did not expose the selected path', { missingState });
        }
        if (!missingState.loadState.visible) {
          throw new SmokeError('ui-host-page', 'MISSING_CONFIG_NOT_EXPLAINED', 'Missing-target state did not show a load error', { missingState });
        }
        const missingShot = await browser.screenshot(path.join(dirs.artifacts, 'ui-missing-config.png'));
        await clickText(browser, missingFrame.context, 'Settings');
        let missingSettings = await readUiState(browser, missingFrame.context);
        const settingsDeadline = Date.now() + 8_000;
        while (Date.now() < settingsDeadline && !(missingSettings.dialog.open && missingSettings.dialog.title === 'Server settings')) {
          await sleep(150);
          missingSettings = await readUiState(browser, missingFrame.context);
        }
        await waitForSettingsForm(browser, missingFrame.context);
        let missingFieldValues = await browser.evaluate(`JSON.stringify([...document.querySelectorAll('.settings-fields input')].map((input) => input.value))`, { context: missingFrame.context });
        const fieldDeadline = Date.now() + 8_000;
        while (Date.now() < fieldDeadline && !JSON.parse(missingFieldValues).includes(missingConfig)) {
          await sleep(150);
          missingFieldValues = await browser.evaluate(`JSON.stringify([...document.querySelectorAll('.settings-fields input')].map((input) => input.value))`, { context: missingFrame.context });
        }
        if (!JSON.parse(missingFieldValues).includes(missingConfig)) {
          throw new SmokeError('ui-host-page', 'MISSING_CONFIG_SETTINGS', 'Settings did not expose the missing explicit path', { missingFieldValues });
        }
        const missingSettingsShot = await browser.screenshot(path.join(dirs.artifacts, 'ui-missing-config-settings.png'));
        await browser.pressKey('Escape', { context: missingFrame.context });
        const missingClose = await browser.close();
        browser = null;
        const missingProof = { path: missingConfig, state: missingState, settingsDialog: missingSettings.dialog, fields: JSON.parse(missingFieldValues), close: missingClose, artifacts: [missingShot, missingSettingsShot] };

        fs.writeFileSync(emptyConfig, '{}\n');
        await serviceJson('POST', '/settings', { ...commonSettings, configFile: emptyConfig });
        browser = await launchFirefox({
          firefox: options.firefox, output: dirs.artifacts, dark: false, mobile: true, label: 'host-empty-mobile', timeoutMs: 20_000,
        });
        await browser.setViewport(390, 844, 3);
        await browser.navigate(baseUrl, { timeoutMs: 30_000 });
        const emptyFrame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: true });
        let emptyState = await readUiState(browser, emptyFrame.context);
        const emptyDeadline = Date.now() + 10_000;
        while (Date.now() < emptyDeadline && !emptyState.emptyState.visible) {
          await sleep(150);
          emptyState = await readUiState(browser, emptyFrame.context);
        }
        if (!emptyState.emptyState.visible) {
          throw new SmokeError('ui-host-page', 'EMPTY_CONFIG_STATE', 'Empty target did not show the explicit empty state', { emptyState });
        }
        const reloadControl = await browser.evaluate(`(() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => ['Reload', 'Reload file'].includes((item.innerText || '').trim()) && item.offsetParent !== null);
          return button ? JSON.stringify({ text: (button.innerText || '').trim(), disabled: Boolean(button.disabled) }) : null;
        })()`, { context: emptyFrame.context });
        if (!reloadControl || JSON.parse(reloadControl).disabled) {
          throw new SmokeError('ui-host-page', 'EMPTY_CONFIG_RELOAD', 'Empty mobile state does not expose an enabled Reload control', { reloadControl });
        }
        const emptyShot = await browser.screenshot(path.join(dirs.artifacts, 'mobile-empty-reload.png'));
        await clickText(browser, emptyFrame.context, JSON.parse(reloadControl).text);
        await sleep(700);
        const emptyAfterReload = await readUiState(browser, emptyFrame.context);
        const emptyClose = await browser.close();
        browser = null;
        const emptyProof = { path: emptyConfig, state: emptyState, reload: JSON.parse(reloadControl), afterReload: emptyAfterReload.emptyState, close: emptyClose, artifacts: [emptyShot] };

        // Actual catalog error styling: a synthetic failing models executable
        // must produce an alert with error color distinct from normal text.
        const badStub = path.join(uiFixture.dir, 'bad-models-stub');
        writeExecutableStub(badStub, `#!${process.execPath}
process.stderr.write('synthetic catalog failure\n');
process.exit(3);
`);
        await serviceJson('POST', '/settings', { ...commonSettings, opencodeBin: badStub, configFile: uiFixture.configFile });
        browser = await launchFirefox({
          firefox: options.firefox, output: dirs.artifacts, label: 'host-catalog-error', timeoutMs: 20_000,
        });
        await browser.setViewport(1280, 800, 1);
        await browser.navigate(baseUrl, { timeoutMs: 30_000 });
        const errorFrame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
        let catalogErrorState = await readUiState(browser, errorFrame.context);
        const catalogDeadline = Date.now() + 20_000;
        while (Date.now() < catalogDeadline && !catalogErrorState.catalogError.visible) {
          await sleep(150);
          catalogErrorState = await readUiState(browser, errorFrame.context);
        }
        if (!catalogErrorState.catalogError.visible || catalogErrorState.catalogError.role !== 'alert') {
          throw new SmokeError('ui-host-page', 'CATALOG_ERROR_SEMANTICS', 'A failing synthetic catalog did not show an alert', {
            catalogError: catalogErrorState.catalogError,
          });
        }
        if (catalogErrorState.catalogError.color === catalogErrorState.normalTextColor) {
          throw new SmokeError('ui-host-page', 'CATALOG_ERROR_COLOR', 'Catalog error color equals normal text', {
            errorColor: catalogErrorState.catalogError.color, normal: catalogErrorState.normalTextColor,
          });
        }
        const catalogErrorShot = await browser.screenshot(path.join(dirs.artifacts, 'ui-catalog-error.png'));
        const catalogErrorClose = await browser.close();
        browser = null;
        const catalogErrorProof = {
          path: uiFixture.configFile,
          state: catalogErrorState,
          close: catalogErrorClose,
          artifacts: [{ name: 'ui-catalog-error', ...pngInfo(catalogErrorShot.path) }],
        };

        // Restore the rich synthetic target and the original settings after the
        // failure-state proof; no live file is touched.
        makeScratchConfig(uiFixture.configFile);
        await serviceJson('POST', '/settings', { ...commonSettings, configFile: uiFixture.configFile });
        const fixtureRestored = { configFile: uiFixture.configFile };

        const mandatory = captures.map((capture) => capture.sha256);
        const signatures = new Set(mandatory);
        const allPng = captures.every((capture) => capture.signature === PNG_SIGNATURE && capture.bytes > 0);
        const darkSessionsActuallyDark = sessions
          .filter((session) => session.variant.dark)
          .every((session) => /(^|\s)dark(\s|$)/.test(session.page?.themeClass ?? ''));
        const mobileSessionsActuallyMobile = sessions
          .filter((session) => session.variant.mobile)
          .every((session) => /(^|\s)device-mobile(\s|$)/.test(session.page?.themeClass ?? ''));
        const allPagesMounted = sessions.every((session) => session.page?.childHasParent === true);
        const overflowSafe = sessions
          .filter((session) => session.page?.overflow)
          .every((session) => session.page.overflow.documentWidth <= session.page.overflow.viewportWidth + 1);
        const workflowChecks = workflow.checks;
        report.ui = {
          pageTitle,
          pageEntry,
          scratchFile: uiFixture.configFile,
          captures,
          sessions,
          workflowArtifacts,
          workflowChecks,
          lostAck: workflow.lostAck,
          missingConfig: missingProof,
          emptyConfig: emptyProof,
          catalogError: catalogErrorProof,
          fixtureRestored,
          allArtifacts: [
            ...captures.map((capture) => ({ name: capture.label, path: capture.path, bytes: capture.bytes, sha256: capture.sha256 })),
            ...workflowArtifacts,
            ...missingProof.artifacts,
            ...emptyProof.artifacts,
            ...catalogErrorProof.artifacts,
          ],
          uniqueScreenshots: signatures.size === captures.length,
          allPng,
          darkSessionsActuallyDark,
          mobileSessionsActuallyMobile,
          allPagesMounted,
          overflowSafe,
          pageRenderedAfterHostBridge: Boolean(workflowState.queueName && workflowState.rows.length > 0),
          screenshotsKeptForIndependentReview: true,
        };
        // A mandatory view can also be a workflow checkpoint. Inventory that
        // same immutable capture once; the browser refuses actual overwrites.
        const artifactsByPath = new Map();
        for (const artifact of report.ui.allArtifacts) {
          const actual = pngInfo(artifact.path);
          if (artifact.bytes !== actual.bytes || (artifact.sha256 && artifact.sha256 !== actual.sha256)) {
            throw new SmokeError('ui-host-page', 'ARTIFACT_CHANGED', 'A captured screenshot changed after recording.');
          }
          if (!artifactsByPath.has(artifact.path)) artifactsByPath.set(artifact.path, { name: artifact.name, ...actual });
        }
        report.ui.allArtifacts = [...artifactsByPath.values()];
        if (!allPng || captures.length !== 4) {
          throw new SmokeError('ui-host-page', 'SCREENSHOT_INCOMPLETE', 'Did not capture four valid PNG screenshots', { captures });
        }
        if (signatures.size !== captures.length) {
          throw new SmokeError('ui-host-page', 'SCREENSHOTS_NOT_UNIQUE', 'Screenshot files are not unique', { captures });
        }
        if (!darkSessionsActuallyDark) {
          throw new SmokeError('ui-host-page', 'DARK_THEME_NOT_APPLIED', 'A dark browser session did not render the host dark theme', {
            themeClasses: sessions.map((session) => ({ label: session.label, themeClass: session.page?.themeClass })),
          });
        }
        if (!mobileSessionsActuallyMobile) {
          throw new SmokeError('ui-host-page', 'MOBILE_LAYOUT_NOT_APPLIED', 'A mobile browser session did not render the host mobile layout', {
            themeClasses: sessions.map((session) => ({ label: session.label, themeClass: session.page?.themeClass })),
          });
        }
        if (!allPagesMounted) {
          throw new SmokeError('ui-host-page', 'PAGE_NOT_MOUNTED', 'The extension page was not mounted in a child frame of the real host page');
        }
        if (!overflowSafe) {
          throw new SmokeError('ui-host-page', 'GLOBAL_OVERFLOW', 'A loaded page has global horizontal overflow', { sessions });
        }
        const failedChecks = Object.entries(workflowChecks).filter(([, value]) => !value.ok).map(([name]) => name);
        if (failedChecks.length > 0) {
          throw new SmokeError('ui-host-page', 'DOM_CHECK_FAILED', `DOM workflow checks failed: ${failedChecks.join(', ')}`, { workflowChecks });
        }
        if (workflow.lostAck?.status !== 'passed') {
          report.unverified.push(`Lost-ack DOM scenario: ${workflow.lostAck?.status ?? 'missing'}${workflow.lostAck?.reason ? ` (${workflow.lostAck.reason})` : ''}`);
        }
        return { summary: `${captures.length} screenshots; ${Object.keys(workflowChecks).length} DOM checks; page ${workflowState.target}` };
      });
      if (!browserProof) report.missing.push('UI proof did not complete');
      }

      // Favorites source API proof: change the synthetic stock-host profile
      // through the host's own settings route, then prove fresh adapter reads
      // observe addition/removal/reorder/empty without touching OMOS.
      await stage('favorites-profile-proof', async () => {
        const requireCheck = (condition, code, message, details = null) => {
          if (!condition) throw new SmokeError('favorites-profile-proof', code, message, details);
        };
        const configBefore = await serviceJson('GET', '/config');
        favoritesBaseline = {
          capturedAt: new Date().toISOString(),
          fileHash: hashFile(uiFixture.configFile),
          baseHash: configBefore?.baseHash ?? null,
          generation: configBefore?.target?.generation ?? null,
          backups: countBackups(uiFixture.dir),
        };
        requireCheck(favoritesBaseline.baseHash && favoritesBaseline.generation, 'BASELINE_MISSING',
          'Could not capture the OMOS baseline before favorites operations', configBefore);

        const canary = `OMOS_CANARY_${crypto.randomUUID()}`;
        const canaryWrite = await api('/api/config/settings', {
          method: 'PUT',
          body: { globalBehaviorPrompt: `Synthetic unrelated preference ${canary}` },
          timeoutMs: 15_000,
        });
        requireCheck(canaryWrite.status === 200, 'CANARY_WRITE', 'The stock host did not accept an unrelated profile preference', {
          status: canaryWrite.status, body: canaryWrite.text?.slice(0, 300) ?? null,
        });

        const sourceBefore = await serviceJson('GET', '/favorites/source');
        const configured = await serviceJson('POST', '/favorites/source', { filePath: preferencesPath });
        requireCheck(configured?.filePath === preferencesPath && typeof configured?.generation === 'string',
          'SOURCE_CONFIGURE', 'The service did not persist the explicit synthetic preferences path', { sourceBefore, configured });
        requireCheck(configured.generation !== sourceBefore?.generation, 'SOURCE_GENERATION',
          'Configuring the favorites source did not rotate its own generation', { sourceBefore, configured });

        const sourceSettingsPath = path.join(serviceDataPath, 'favorites-source.json');
        requireCheck(fs.existsSync(sourceSettingsPath), 'SOURCE_NOT_PERSISTED',
          'The service did not write favorites-source.json in its private data folder', { sourceSettingsPath });
        requireCheck(fs.readFileSync(sourceSettingsPath, 'utf8').includes(preferencesPath), 'SOURCE_PERSISTED_VALUE',
          'The persisted favorites source does not name the explicit preferences path', { sourceSettingsPath });

        const states = [
          ['addition', ['synthetic/provider-alpha', 'synthetic/provider-beta']],
          ['reorder', ['synthetic/provider-gamma', 'synthetic/provider-alpha', 'synthetic/provider-beta']],
          ['removal', ['synthetic/provider-gamma', 'synthetic/provider-beta']],
          ['empty', []],
        ];
        const results = [];
        let previousFingerprint = null;
        for (const [label, expected] of states) {
          const write = await writeHostFavorites(expected);
          requireCheck(write.status === 200, 'PROFILE_WRITE', `The stock host refused the ${label} favorites write`, {
            status: write.status, body: write.text?.slice(0, 500) ?? null,
          });
          requireCheck(fs.existsSync(preferencesPath), 'PROFILE_MISSING', 'The stock host did not write preferences.json', { preferencesPath });
          const profile = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
          const entry = profile?.fields?.favoriteModels;
          requireCheck(profile?.version === 1 && entry && Array.isArray(entry.value), 'PROFILE_SHAPE',
            `preferences.json has no profile favoriteModels entry after the ${label} write`, { entry });
          const profileOrder = readOrderedRefs(entry.value);
          requireCheck(JSON.stringify(profileOrder) === JSON.stringify(expected), 'PROFILE_ORDER',
            `The stock host stored an unexpected ${label} favorites order`, { profileOrder, expected });

          const snapshot = await serviceJson('GET', '/favorites/snapshot');
          const snapshotOrder = readOrderedRefs(snapshot?.favoriteModels);
          requireCheck(snapshot?.state === 'ready', 'SNAPSHOT_STATE', `Fresh snapshot was not ready after ${label}`, snapshot);
          requireCheck(snapshot.sourceKind === 'openchamber-preferences-v1', 'SNAPSHOT_KIND',
            `Snapshot sourceKind is not openchamber-preferences-v1 after ${label}`, { sourceKind: snapshot.sourceKind });
          requireCheck(snapshot.generation === configured.generation, 'SNAPSHOT_GENERATION',
            'Snapshot generation does not match the configured source generation', { snapshot: snapshot.generation, configured: configured.generation });
          requireCheck(JSON.stringify(snapshotOrder) === JSON.stringify(expected), 'SNAPSHOT_ORDER',
            `Fresh snapshot did not observe the ${label} order`, { snapshotOrder, expected, profileOrder });
          requireCheck(snapshot.updatedAt === entry.updatedAt, 'SNAPSHOT_STAMP',
            'Snapshot updatedAt does not match the preferences profile stamp', { snapshot: snapshot.updatedAt, profile: entry.updatedAt });
          requireCheck(typeof snapshot.readAt === 'number' && Number.isFinite(snapshot.readAt) && snapshot.readAt > 0,
            'SNAPSHOT_READ_AT', 'Snapshot readAt is not a finite Unix timestamp', { readAt: snapshot.readAt });
          requireCheck(typeof snapshot.fingerprint === 'string' && snapshot.fingerprint.length > 0, 'SNAPSHOT_FINGERPRINT',
            'Snapshot fingerprint is missing', { fingerprint: snapshot.fingerprint });
          if (previousFingerprint !== null) {
            requireCheck(snapshot.fingerprint !== previousFingerprint, 'SNAPSHOT_FINGERPRINT_CHANGE',
              `Snapshot fingerprint did not change for ${label}`, { previousFingerprint, fingerprint: snapshot.fingerprint });
          }
          previousFingerprint = snapshot.fingerprint;
          requireCheck(hashFile(uiFixture.configFile) === favoritesBaseline.fileHash, 'OMOS_HASH_CHANGED',
            `The OMOS file changed during the ${label} favorites operation`, {
              hash: hashFile(uiFixture.configFile), baseline: favoritesBaseline.fileHash,
            });
          const generationAfter = await serviceJson('GET', '/config');
          requireCheck(generationAfter?.target?.generation === favoritesBaseline.generation, 'OMOS_GENERATION_CHANGED',
            `The OMOS target generation changed during the ${label} favorites operation`, {
              generation: generationAfter?.target?.generation, baseline: favoritesBaseline.generation,
            });
          requireCheck(!JSON.stringify(snapshot).includes(canary), 'CANARY_LEAK',
            'The favorites snapshot disclosed the unrelated profile canary', { label });
          results.push({
            label,
            expected,
            snapshotOrder,
            profileOrder,
            sourceKind: snapshot.sourceKind,
            fingerprint: snapshot.fingerprint,
            readAt: snapshot.readAt,
            updatedAt: snapshot.updatedAt,
            profileUpdatedAt: entry.updatedAt,
            omosHash: hashFile(uiFixture.configFile),
            omosGeneration: generationAfter?.target?.generation ?? null,
          });
        }

        // A fresh empty read must be stable and still profile-driven.
        const emptyFresh = await serviceJson('GET', '/favorites/snapshot');
        requireCheck(emptyFresh?.state === 'ready' && JSON.stringify(readOrderedRefs(emptyFresh.favoriteModels)) === '[]',
          'EMPTY_FRESH', 'A second fresh read of the empty profile was not an empty ready snapshot', emptyFresh);
        requireCheck(emptyFresh.fingerprint === previousFingerprint, 'EMPTY_CACHE',
          'A fresh empty snapshot changed its fingerprint without a profile change', {
            first: previousFingerprint, second: emptyFresh.fingerprint,
          });

        // The profile wins over a stale legacy copy in settings.json. This is a
        // synthetic fixture of the host data root, not a profile write and not
        // an OMOS write; the extension source must keep reading preferences.
        const legacyDecoy = [
          { providerID: 'legacy-decoy', modelID: 'must-not-appear' },
          { providerID: 'legacy-decoy', modelID: 'also-ignored' },
        ];
        const legacySettings = JSON.parse(fs.readFileSync(hostSettingsPath, 'utf8'));
        legacySettings.favoriteModels = legacyDecoy;
        fs.writeFileSync(hostSettingsPath, `${JSON.stringify(legacySettings, null, 2)}\n`);
        const afterDecoy = await serviceJson('GET', '/favorites/snapshot');
        requireCheck(afterDecoy?.state === 'ready' && JSON.stringify(readOrderedRefs(afterDecoy.favoriteModels)) === '[]',
          'LEGACY_PRECEDENCE', 'The source followed a legacy settings.json copy instead of the profile', afterDecoy);
        requireCheck(afterDecoy.fingerprint === previousFingerprint, 'LEGACY_FINGERPRINT',
          'A legacy settings.json copy changed the profile fingerprint', {
            fingerprint: afterDecoy.fingerprint, previousFingerprint,
          });

        const profileText = fs.readFileSync(preferencesPath, 'utf8');
        requireCheck(profileText.includes(canary), 'CANARY_FIXTURE',
          'The unrelated profile canary was not present in preferences.json', { preferencesPath });
        const sourceResponse = await serviceJson('GET', '/favorites/source');
        requireCheck(!JSON.stringify(sourceResponse).includes(canary), 'CANARY_SOURCE_LEAK',
          'The favorites source settings response disclosed the unrelated profile canary');

        const configAfter = await serviceJson('GET', '/config');
        requireCheck(hashFile(uiFixture.configFile) === favoritesBaseline.fileHash, 'OMOS_HASH_FINAL',
          'The OMOS file changed across the favorites profile proof');
        requireCheck(configAfter?.target?.generation === favoritesBaseline.generation, 'OMOS_GENERATION_FINAL',
          'The OMOS target generation changed across the favorites profile proof');
        requireCheck(configAfter?.baseHash === favoritesBaseline.baseHash, 'OMOS_BASE_FINAL',
          'The OMOS base hash changed across the favorites profile proof');

        report.favorites = {
          baseline: favoritesBaseline,
          canary: { value: canary, projectedInSnapshot: false, inPreferences: true },
          preferencesPath,
          hostSettingsPath,
          source: { configured, settingsPath: sourceSettingsPath },
          states: results,
          emptyFresh: {
            state: emptyFresh.state,
            fingerprint: emptyFresh.fingerprint,
            updatedAt: emptyFresh.updatedAt,
            readAt: emptyFresh.readAt,
          },
          legacyDecoy: {
            appliedTo: hostSettingsPath,
            favoriteModels: legacyDecoy,
            ignoredBySnapshot: true,
            snapshotOrder: readOrderedRefs(afterDecoy.favoriteModels),
          },
          final: {
            fileHash: hashFile(uiFixture.configFile),
            baseHash: configAfter?.baseHash ?? null,
            generation: configAfter?.target?.generation ?? null,
            backups: countBackups(uiFixture.dir),
          },
        };
        return { summary: `${results.length} stock profile states, fresh source reads, OMOS unchanged` };
      });

      // Favorites page proof: local stars, source configure/refresh/import,
      // picker order, keyboard/touch state and reload persistence.
      await stage('favorites-ui-proof', async () => {
        const requireCheck = (condition, code, message, details = null) => {
          if (!condition) throw new SmokeError('favorites-ui-proof', code, message, details);
        };
        requireCheck(favoritesBaseline, 'BASELINE_MISSING', 'The favorites baseline was not captured');
        const resetSource = await serviceJson('POST', '/favorites/source', { filePath: '' });
        requireCheck(resetSource?.filePath === '', 'SOURCE_RESET', 'The favorites source was not reset for the page proof', resetSource);

        const initialOrder = ['synthetic/provider-beta', 'synthetic/provider-alpha', 'synthetic/provider-gamma'];
        const updatedOrder = ['synthetic/provider-gamma', 'synthetic/provider-beta', 'synthetic/provider-alpha'];
        const initialWrite = await writeHostFavorites(initialOrder);
        requireCheck(initialWrite.status === 200, 'INITIAL_PROFILE_WRITE',
          'The stock host refused the initial page-proof favorites', { status: initialWrite.status });

        const allChecks = {};
        const addChecks = (prefix, checks = {}) => {
          for (const [name, value] of Object.entries(checks)) {
            allChecks[`${prefix}:${name}`] = value;
          }
        };
        const artifacts = [];
        const sessions = [];
        const captureRows = [];
        const missingPreferencesPath = path.join(uiFixture.dir, 'missing-preferences.json');

        browser = await launchFirefox({
          firefox: options.firefox,
          output: dirs.artifacts,
          label: 'favorites-desktop-light',
          timeoutMs: 20_000,
        });
        await browser.setViewport(1280, 800, 1);
        await browser.navigate(baseUrl, { timeoutMs: 30_000 });
        let frame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
        const desktop = await runFavoritesDomWorkflow({
          browser,
          context: frame.context,
          configFile: uiFixture.configFile,
          preferencesPath,
          missingPreferencesPath,
          storagePath: guestStoragePath,
          artifactsDir: dirs.artifacts,
          serviceJson,
          baseUrl,
          pageTitle,
          hostFavorites: async (ids) => writeHostFavorites(ids),
          initialHostFavorites: initialOrder,
          updatedHostFavorites: updatedOrder,
          baselineHash: favoritesBaseline.fileHash,
          baselineGeneration: favoritesBaseline.generation,
        });
        addChecks('desktop-light', desktop.checks);
        artifacts.push(...desktop.artifacts);
        const desktopTheme = await browser.evaluate('document.documentElement.className');
        const desktopClose = await browser.close();
        browser = null;
        sessions.push({
          label: 'desktop-light',
          variant: { label: 'desktop-light', dark: false, mobile: false, width: 1280, height: 800 },
          close: desktopClose,
          page: {
            childUrl: desktop.pageUrl,
            themeClass: desktopTheme,
            footer: desktop.finalState.footer,
            frameConsoleErrors: desktop.frameConsoleErrors,
          },
        });
        for (const artifact of desktop.artifacts) captureRows.push({ session: 'desktop-light', name: artifact.name, ...pngInfo(artifact.path) });

        for (const variant of [
          { label: 'mobile-light', mobile: true, dark: false, width: 390, height: 844, starId: 'synthetic/provider-beta' },
          { label: 'desktop-dark', mobile: false, dark: true, width: 1280, height: 800, starId: null },
          { label: 'mobile-dark', mobile: true, dark: true, width: 390, height: 844, starId: null },
        ]) {
          browser = await launchFirefox({
            firefox: options.firefox,
            output: dirs.artifacts,
            dark: variant.dark,
            mobile: variant.mobile,
            label: `favorites-${variant.label}`,
            timeoutMs: 20_000,
          });
          await browser.setViewport(variant.width, variant.height, variant.mobile ? 3 : 1);
          await browser.navigate(baseUrl, { timeoutMs: 30_000 });
          frame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: variant.mobile });
          const proof = await runFavoritesVariant({
            browser,
            context: frame.context,
            label: variant.label,
            mobile: variant.mobile,
            dark: variant.dark,
            artifactsDir: dirs.artifacts,
            starId: variant.starId,
          });
          addChecks(variant.label, proof.checks);
          artifacts.push(...proof.artifacts);
          const close = await browser.close();
          browser = null;
          sessions.push({
            label: variant.label,
            variant: { ...variant },
            close,
            page: {
              childUrl: frame.url,
              themeClass: proof.themeClass,
              frameConsoleErrors: proof.frameConsoleErrors,
            },
          });
          for (const artifact of proof.artifacts) captureRows.push({ session: variant.label, name: artifact.name, ...pngInfo(artifact.path) });
        }

        const finalConfig = await serviceJson('GET', '/config');
        const finalHash = hashFile(uiFixture.configFile);
        const failed = Object.entries(allChecks).filter(([, value]) => !value.ok).map(([name]) => name);
        const allPng = captureRows.every((row) => row.signature === PNG_SIGNATURE && row.bytes > 0);
        const shaSet = new Set(captureRows.map((row) => row.sha256));
        const changedArtifacts = captureRows.filter((row) => {
          const actual = pngInfo(row.path);
          return actual.bytes !== row.bytes || actual.sha256 !== row.sha256;
        }).map((row) => row.path);
        requireCheck(changedArtifacts.length === 0, 'FAVORITES_ARTIFACT_CHANGED',
          'A favorites screenshot changed after it was recorded', { changedArtifacts });
        requireCheck(failed.length === 0, 'FAVORITES_CHECKS', `Favorites DOM checks failed: ${failed.join(', ')}`, { failed, checks: allChecks });
        requireCheck(finalHash === favoritesBaseline.fileHash, 'FAVORITES_OMOS_HASH',
          'The OMOS file changed across the favorites page proof', { finalHash, baseline: favoritesBaseline.fileHash });
        requireCheck(finalConfig?.target?.generation === favoritesBaseline.generation, 'FAVORITES_OMOS_GENERATION',
          'The OMOS generation changed across the favorites page proof', {
            generation: finalConfig?.target?.generation, baseline: favoritesBaseline.generation,
          });
        requireCheck(countBackups(uiFixture.dir) === favoritesBaseline.backups, 'FAVORITES_BACKUP',
          'The favorites page proof created an OMOS backup', {
            backups: countBackups(uiFixture.dir), baseline: favoritesBaseline.backups,
          });
        requireCheck(allPng && captureRows.length >= 9, 'FAVORITES_CAPTURES',
          'The favorites page proof did not capture every required state', { captureRows });
        requireCheck(shaSet.size === captureRows.length, 'FAVORITES_CAPTURE_DUPLICATE',
          'Favorites captures are not unique', { captureRows });

        report.favoritesUi = {
          baseline: favoritesBaseline,
          preferencesPath,
          initialOrder,
          updatedOrder,
          sessions,
          checks: allChecks,
          failedChecks: failed,
          captures: captureRows,
          final: {
            fileHash: finalHash,
            baseHash: finalConfig?.baseHash ?? null,
            generation: finalConfig?.target?.generation ?? null,
            backups: countBackups(uiFixture.dir),
          },
          allPng,
          uniqueCaptures: shaSet.size === captureRows.length,
        };
        report.ui.allArtifacts = [
          ...report.ui.allArtifacts,
          ...artifacts.map((artifact) => ({ name: artifact.name, path: artifact.path, ...pngInfo(artifact.path) })),
        ];
        report.ui.favorites = {
          checks: allChecks,
          captures: captureRows,
          final: report.favoritesUi.final,
        };
        return { summary: `${captureRows.length} favorites captures; ${Object.keys(allChecks).length} checks; OMOS unchanged` };
      });

      }
      if (options.marketplace) {
        await stage('marketplace-ui-proof', async () => {
          const requireCheck = (condition, code, message, details = null) => {
            if (!condition) throw new SmokeError('marketplace-ui-proof', code, message, details);
          };
          const marketplaceDir = path.join(dirs.root, 'marketplace');
          const storeRoot = path.join(marketplaceDir, 'store');
          const marketplaceConfigFile = path.join(marketplaceDir, 'opencode.jsonc');
          const marketplaceStub = path.join(marketplaceDir, 'bin', 'opencode-marketplace-stub');
          fs.mkdirSync(path.dirname(marketplaceStub), { recursive: true });
          const canaries = {
            root: `SYNTHETIC_ROOT_CANARY_${crypto.randomUUID()}`,
            neighbor: `SYNTHETIC_NEIGHBOR_CANARY_${crypto.randomUUID()}`,
            docs: `SYNTHETIC_DOCS_CANARY_${crypto.randomUUID()}`,
            reviewer: `SYNTHETIC_REVIEWER_CANARY_${crypto.randomUUID()}`,
            legacy: `SYNTHETIC_LEGACY_CANARY_${crypto.randomUUID()}`,
            build: `SYNTHETIC_BUILD_CANARY_${crypto.randomUUID()}`,
          };
          writeMarketplaceStore({ root: storeRoot, canary: 'MKP' });
          const configFixture = writeMarketplaceConfig({ file: marketplaceConfigFile, canaries });
          writeExecutableStub(marketplaceStub, stubModelCliSource());

          const marketplaceSettings = await serviceJson('POST', '/settings', {
            configFile: marketplaceConfigFile,
            opencodeBin: marketplaceStub,
            modelCwd: marketplaceDir,
            opencodeConfigDir: '',
          });
          requireCheck(marketplaceSettings?.settings?.configFile === marketplaceConfigFile, 'MARKETPLACE_SETTINGS',
            'The service did not persist the synthetic marketplace target', marketplaceSettings);
          const marketplaceConfig = await serviceJson('GET', '/config');
          const marketplaceSourceBefore = await serviceJson('GET', '/marketplace/source');
          requireCheck(marketplaceSourceBefore?.rootPath === '', 'MARKETPLACE_SOURCE_DISCONNECTED',
            'The marketplace source should start disconnected', marketplaceSourceBefore);
          const baseline = {
            capturedAt: new Date().toISOString(),
            settings: marketplaceSettings.settings,
            hash: hashFile(marketplaceConfigFile),
            baseHash: marketplaceConfig?.baseHash ?? null,
            generation: marketplaceConfig?.target?.generation ?? null,
            backups: countBackups(marketplaceDir),
            mtimeMs: fs.statSync(marketplaceConfigFile).mtimeMs,
          };
          requireCheck(baseline.baseHash && baseline.generation, 'MARKETPLACE_BASELINE',
            'Could not capture the synthetic marketplace baseline', marketplaceConfig);

          const artifacts = [];
          const sessions = [];
          const variantChecks = {};
          let workflow = null;
          let calls = [];
          try {
            browser = await launchFirefox({
              firefox: options.firefox,
              output: dirs.artifacts,
              label: 'marketplace-desktop-light',
              timeoutMs: 20_000,
            });
            await browser.setViewport(1280, 800, 1);
            await browser.navigate(baseUrl, { timeoutMs: 30_000 });
            const frame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: false });
            await installMarketplaceCallCounter(browser);
            workflow = await runMarketplaceDomWorkflow({
              browser,
              context: frame.context,
              baseUrl,
              pageTitle,
              serviceJson,
              configFile: marketplaceConfigFile,
              sourceRoot: storeRoot,
              artifactsDir: dirs.artifacts,
              baseline,
              expected: configFixture.expected,
            });
            calls = workflow.calls;
            report.marketplaceUi = { status: 'desktop-complete-variants-pending', checks: workflow.checks,
              captures: workflow.artifacts, draft: workflow.draft, final: workflow.final,
              calls: { total: calls.length, paths: [...new Set(calls.map(call => call.path))] } };
            artifacts.push(...workflow.artifacts);
            const theme = await browser.evaluate('document.documentElement.className');
            const close = await browser.close();
            browser = null;
            sessions.push({
              label: 'desktop-light',
              viewport: '1280x800',
              close,
              page: { childUrl: frame.url, themeClass: theme },
            });

            for (const variant of [
              { label: 'mobile-light', mobile: true, dark: false, width: 390, height: 844 },
              { label: 'desktop-dark', mobile: false, dark: true, width: 1280, height: 800 },
              { label: 'mobile-short', mobile: true, dark: true, width: 390, height: 520 },
            ]) {
              browser = await launchFirefox({
                firefox: options.firefox,
                output: dirs.artifacts,
                dark: variant.dark,
                mobile: variant.mobile,
                label: `marketplace-${variant.label}`,
                timeoutMs: 20_000,
              });
              await browser.setViewport(variant.width, variant.height, variant.mobile ? 3 : 1);
              await browser.navigate(baseUrl, { timeoutMs: 30_000 });
              const variantFrame = await openExtensionPage(browser, { baseUrl, pageTitle, mobile: variant.mobile });
              await installMarketplaceCallCounter(browser);
              const proof = await runMarketplaceVariant({
                browser,
                context: variantFrame.context,
                label: variant.label,
                mobile: variant.mobile,
                dark: variant.dark,
                artifactsDir: dirs.artifacts,
                sourceRoot: storeRoot,
              });
              artifacts.push(...proof.artifacts);
              calls.push(...await readMarketplaceCalls(browser));
              for (const [name, value] of Object.entries(proof.checks ?? {})) variantChecks[`${variant.label}:${name}`] = value;
              const close = await browser.close();
              browser = null;
              sessions.push({
                label: variant.label,
                viewport: `${variant.width}x${variant.height}`,
                close,
                page: { childUrl: variantFrame.url, themeClass: proof.themeClass ?? null },
              });
            }
          } finally {
            if (browser) {
              try { await browser.close(); } catch { /* owned browser close is best-effort */ }
              browser = null;
            }
          }

          const finalConfig = await serviceJson('GET', '/config');
          const finalMarketplace = await serviceJson('GET', '/marketplace/config');
          const finalSource = await serviceJson('GET', '/marketplace/source');
          const finalHash = hashFile(marketplaceConfigFile);
          const finalBackups = countBackups(marketplaceDir);
          const captureRows = artifacts.map((artifact) => ({ name: artifact.name, ...pngInfo(artifact.path) }));
          const shaSet = new Set(captureRows.map((row) => row.sha256));
          const forbidden = calls.filter((call) => /^\/(optimizer|native)|generate|models\/refresh/.test(call.path));
          requireCheck(captureRows.length >= 8, 'MARKETPLACE_CAPTURES', 'The marketplace proof did not capture every required state', { captureRows });
          requireCheck(shaSet.size === captureRows.length, 'MARKETPLACE_CAPTURE_DUPLICATE', 'Marketplace captures are not unique', { captureRows });
          requireCheck(captureRows.every((row) => row.signature === PNG_SIGNATURE && row.bytes > 0), 'MARKETPLACE_PNG', 'A marketplace capture is not a PNG', { captureRows });
          requireCheck(forbidden.length === 0, 'MARKETPLACE_FORBIDDEN_CALLS',
            'The marketplace flow called an optimizer, native, generate or refresh route', { forbidden });
          const sourceTreeAfter = hashMarketplaceTree(storeRoot);
          requireCheck(sourceTreeAfter === workflow.final.sourceTreeBefore, 'MARKETPLACE_SOURCE_WRITE',
            'The marketplace flow wrote the installed source store', { before: workflow.final.sourceTreeBefore, after: sourceTreeAfter });
          requireCheck(finalHash !== baseline.hash, 'MARKETPLACE_NO_SAVE', 'The marketplace Confirm did not write the target', {
            before: baseline.hash, after: finalHash,
          });
          requireCheck(finalBackups > baseline.backups, 'MARKETPLACE_NO_BACKUP', 'The marketplace Confirm did not create one backup', {
            before: baseline.backups, after: finalBackups,
          });
          requireCheck(finalSource?.rootPath === storeRoot, 'MARKETPLACE_SOURCE_LOST', 'The configured source did not survive the flow', finalSource);
          requireCheck((finalMarketplace?.presets ?? []).find((preset) => preset.name === MARKETPLACE_PRESET)?.agents
            ?.some((agent) => agent.packageId === JANITOR_ID && agent.existingGroupId && agent.canCreate === false), 'MARKETPLACE_PROJECTION',
          'The saved marketplace projection does not show the created queue', finalMarketplace);
          requireCheck(fs.readFileSync(marketplaceConfigFile, 'utf8').includes(UNKNOWN_SELECTION), 'MARKETPLACE_UNKNOWN_LOST',
            'The unknown retained selection was not preserved');

          const captureInventory = captureRows.map((row) => ({
            name: `marketplace/${row.name}`,
            path: row.path,
            bytes: row.bytes,
            sha256: row.sha256,
          }));
          report.ui.allArtifacts = [...report.ui.allArtifacts, ...captureInventory];
          report.marketplaceUi = {
            fixture: {
              storeRoot,
              configFile: marketplaceConfigFile,
              packageIds: [JANITOR_ID, CHRONICLER_ID],
              preset: MARKETPLACE_PRESET,
              unknownSelection: UNKNOWN_SELECTION,
              canariesSeeded: true,
            },
            source: { before: marketplaceSourceBefore, after: finalSource, generation: workflow.final.sourceGeneration },
            baseline,
            checks: workflow.checks,
            variantChecks,
            captures: captureRows,
            sessions,
            calls: {
              total: calls.length,
              paths: [...new Set(calls.map((call) => call.path))].sort(),
              forbidden,
              providerCalls: 0,
            },
            draft: workflow.draft,
            review: { diff: workflow.reviewDiff },
            final: {
              fileHash: finalHash,
              baseHash: finalConfig?.baseHash ?? null,
              generation: finalConfig?.target?.generation ?? null,
              backups: finalBackups,
              sourceTreeBefore: workflow.final.sourceTreeBefore,
              sourceTreeAfter,
              pendingId: workflow.final.pendingId,
              unknownSelection: UNKNOWN_SELECTION,
            },
            cleanup: {
              browserSessionsClosed: sessions.every((session) => session.close?.browserExited === true
                && session.close?.profileRemoved === true),
              sourceUntouched: sourceTreeAfter === workflow.final.sourceTreeBefore,
              providerStarted: false,
            },
          };
          return {
            summary: `${captureRows.length} marketplace captures; ${Object.keys(workflow.checks).length} checks; `
              + `${calls.length} service calls (0 optimizer/native/generate); source untouched`,
          };
        });
      }

    }

    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.failure = {
      stage: error.stage ?? 'unknown',
      code: error.code ?? 'ERROR',
      message: redact(error.message),
      details: error.details ?? null,
    };
    process.stderr.write(`[fail] ${report.failure.stage} ${report.failure.code}: ${report.failure.message}\n`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    const cleanup = {
      hostPid,
      hostAliveBeforeShutdown: hostPid ? processAlive(hostPid) : false,
      descendantsBeforeShutdown: [],
      hostExited: false,
      killEscalated: false,
      remainingOwnedPids: [],
      portClosed: null,
      syntheticStateKept: options.keep,
    };
    if (hostPid && processAlive(hostPid)) {
      ownedDescendants = descendantsOf(hostPid);
      cleanup.descendantsBeforeShutdown = ownedDescendants;
      try { hostChild.kill('SIGTERM'); } catch { /* ignore */ }
      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while (Date.now() < deadline && processAlive(hostPid)) await sleep(200);
      if (processAlive(hostPid)) {
        cleanup.killEscalated = true;
        try { hostChild.kill('SIGKILL'); } catch { /* ignore */ }
        await sleep(700);
      }
    }
    cleanup.hostExited = hostPid ? !processAlive(hostPid) : true;
    const leftover = [hostPid, ...ownedDescendants].filter((pid) => pid && processAlive(pid));
    if (leftover.length > 0) {
      for (const pid of ownedDescendants.filter((candidate) => processAlive(candidate))) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }
    const owned = [hostPid, ...ownedDescendants].filter(Boolean);
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline && owned.some(processAlive)) await sleep(75);
    cleanup.remainingOwnedPids = owned.filter(processAlive);
    if (baseUrl) {
      try {
        const port = Number(new URL(baseUrl).port);
        const probe = net.connect({ host: '127.0.0.1', port });
        cleanup.portClosed = await new Promise((resolve) => {
          probe.once('connect', () => { probe.destroy(); resolve(false); });
          probe.once('error', error => resolve(error.code === 'ECONNREFUSED'));
          setTimeout(() => { probe.destroy(); resolve(false); }, 1_000).unref();
        });
      } catch {
        cleanup.portClosed = null;
      }
    }
    hostOut.end();
    hostErr.end();
    const settled = cleanup.hostExited && cleanup.portClosed === true && cleanup.remainingOwnedPids.length === 0;
    cleanup.syntheticStateKept = Boolean(options.keep || !settled);
    if (!settled) {
      report.ok = false; process.exitCode = 1;
      report.failure ??= { stage:'cleanup', code:'CLEANUP_UNVERIFIED', message:'Host shutdown or port closure was not verified.' };
    }
    if (!cleanup.syntheticStateKept) {
      fs.rmSync(dirs.home, { recursive: true, force: true });
      fs.rmSync(dirs.config, { recursive: true, force: true });
      fs.rmSync(dirs.data, { recursive: true, force: true });
      fs.rmSync(dirs.cache, { recursive: true, force: true });
      fs.rmSync(dirs.state, { recursive: true, force: true });
      fs.rmSync(dirs.tmp, { recursive: true, force: true });
    }
    cleanup.hostLog = hostLogPath;
    cleanup.hostErrLog = hostErrPath;
    report.cleanup = cleanup;
    report.bundlesAfter = {
      page: fileIdentity(path.join(packageDir, 'page', 'main.js')),
      styles: fileIdentity(path.join(packageDir, 'page', 'styles.css')),
      service: fileIdentity(path.join(packageDir, 'service', 'main.js')),
      manifest: fileIdentity(path.join(packageDir, 'package.json')),
    };
    report.bundlesStable = ['page', 'styles', 'service', 'manifest'].every((key) => (
      report.bundles?.[key]?.sha256 && report.bundles[key].sha256 === report.bundlesAfter[key].sha256
    ));
    if (!report.bundlesStable && report.ok) {
      report.ok = false;
      report.failure = {
        stage: 'bundle-identity',
        code: 'BUNDLES_CHANGED',
        message: 'The page, service or manifest changed while the runtime proof was running; this result is stale.',
        details: { before: report.bundles, after: report.bundlesAfter },
      };
      process.exitCode = 1;
    } else if (!report.bundlesStable && !report.failure) {
      report.failure = {
        stage: 'bundle-identity',
        code: 'BUNDLES_CHANGED',
        message: 'The page, service or manifest changed while the runtime proof was running; this result is stale.',
        details: { before: report.bundles, after: report.bundlesAfter },
      };
    }
    report.finishedAt = new Date().toISOString();
    report.hostLogTail = fs.existsSync(hostLogPath) ? redact(fs.readFileSync(hostLogPath, 'utf8'), secrets) : null;
    report.hostErrTail = fs.existsSync(hostErrPath) ? redact(fs.readFileSync(hostErrPath, 'utf8'), secrets) : null;
    fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\n${JSON.stringify({
      ok: report.ok,
      runDir,
      result: path.join(runDir, 'result.json'),
      stages: report.stages.map((row) => ({ name: row.name, ok: row.ok, ms: row.ms })),
      failure: report.failure ?? null,
      bundles: report.bundles,
      bundlesAfter: report.bundlesAfter,
      bundlesStable: report.bundlesStable,
      artifacts: report.ui?.allArtifacts?.map((row) => row.path) ?? report.ui?.captures?.map((row) => row.path) ?? [],
      marketplaceUi: report.marketplaceUi ? {
        checks: Object.keys(report.marketplaceUi.checks).length,
        captures: report.marketplaceUi.captures.length,
        calls: report.marketplaceUi.calls,
        final: report.marketplaceUi.final,
        cleanup: report.marketplaceUi.cleanup,
      } : null,
      cleanup,
      missing: report.missing,
      unverified: report.unverified,
    }, null, 2)}\n`);
  }
};

const scratchFileOf = (report) => report.configProof?.scratchFile ?? null;

const firstEditableGroup = (config, usedPaths) => {
  const used = new Set(usedPaths);
  return (config?.groups ?? []).find((group) => (
    group.readOnlyReason == null
    && Array.isArray(group.models)
    && group.models.length > 0
    && !used.has(group.path)
  )) ?? null;
};

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  await main(process.argv.slice(2));
}
