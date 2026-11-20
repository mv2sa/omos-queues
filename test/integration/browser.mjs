#!/usr/bin/env node
/**
 * Small, dependency-free WebDriver BiDi driver for the stock Firefox binary.
 *
 * The harness never downloads a browser or a driver: it starts Firefox with an
 * explicit, owned profile and talks the WebDriver BiDi protocol over the
 * built-in WebSocket client. Every process, profile and artifact lives under a
 * unique run directory below --output (default /tmp/opencode).
 *
 * Usage:
 *   node test/integration/browser.mjs --help
 *   node test/integration/browser.mjs --self-test --firefox /usr/bin/firefox \
 *     --output /tmp/opencode/omos-browser-proof
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_OUTPUT = '/tmp/opencode/omos-browser-proof';
const DEFAULT_TIMEOUT_MS = 20_000;
const CLOSE_WAIT_MS = 8_000;

const HELP = `OMOS queues integration browser driver (stock Firefox, WebDriver BiDi)

Usage:
  node test/integration/browser.mjs --self-test --firefox <path> [--output <dir>]
  node test/integration/browser.mjs --firefox <path> --url <http(s)://...> [options]

Required:
  --firefox <path>     Firefox executable. A snap wrapper is resolved to the
                       stock binary inside the snap mount so an explicit
                       profile under /tmp can be used.
  --output <dir>       Parent directory for unique run directories.
                       Default: ${DEFAULT_OUTPUT}

Modes:
  --self-test          Prove navigate + evaluate + captureScreenshot on
                       about:blank, then prove owned process/profile cleanup.
  --url <url>          Navigate to a URL and leave a screenshot in the run dir.

Options:
  --screenshot <file>  Screenshot file name for --url (default screenshot.png).
  --evaluate <expr>    Evaluate a JavaScript expression after --url navigation.
  --width <px>         Viewport width (default 1280).
  --height <px>        Viewport height (default 800).
  --dark               Launch with the OS color scheme set to dark.
  --keep-profile       Keep the Firefox profile for diagnostics.
  --timeout <ms>       Command/navigation timeout (default ${DEFAULT_TIMEOUT_MS}).
  --help               Print this help and exit 0.

The driver never touches an existing profile, never kills an unrelated
process, and only removes the profile directory it created.
`;

class BrowserError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Absolute deadline helper: an expired budget never resets to a fresh slice. */
export const remainingBudget = (deadline, now = Date.now()) => {
  const left = deadline - now;
  return { expired: left <= 0, left: Math.max(0, left) };
};

const isExecutableFile = (candidate) => {
  try {
    return fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const startsWithSnapWrapper = (filePath) => {
  try {
    const head = fs.readFileSync(filePath, { encoding: 'utf8' }).slice(0, 800);
    return head.startsWith('#!') && head.includes('snap');
  } catch {
    return false;
  }
};

const findSnapFirefoxBinary = () => {
  const candidates = [path.join('/snap/firefox/current/usr/lib/firefox/firefox')];
  try {
    const versions = fs.readdirSync('/snap/firefox', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => b - a);
    for (const version of versions) {
      candidates.push(path.join('/snap/firefox', String(version), 'usr/lib/firefox/firefox'));
    }
  } catch {
    // Not a snap host.
  }
  return candidates.find(isExecutableFile) ?? null;
};

/**
 * Resolve the executable Firefox to start. On Ubuntu the package command is a
 * snap wrapper that cannot read an owned profile under /tmp; the stock binary
 * inside the snap mount can. Nothing user-specific is hard-coded.
 */
export const resolveFirefoxBinary = (requested) => {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new BrowserError('FIREFOX_MISSING', 'A Firefox executable is required (--firefox).');
  }
  const resolved = path.resolve(requested);
  if (!isExecutableFile(resolved)) {
    throw new BrowserError('FIREFOX_MISSING', `Firefox executable is not usable: ${requested}`);
  }
  if (startsWithSnapWrapper(resolved)) {
    const snapBinary = findSnapFirefoxBinary();
    if (snapBinary) {
      return { executable: snapBinary, requested: resolved, resolvedVia: 'snap-mount' };
    }
    throw new BrowserError(
      'FIREFOX_PROFILE_ACCESS',
      `${requested} is a snap wrapper and no stock snap Firefox binary was found.`,
    );
  }
  return { executable: resolved, requested: resolved, resolvedVia: 'requested-path' };
};

const writeProfilePrefs = (profileDir, { dark = false, mobile = false } = {}) => {
  const prefs = [];
  if (dark) {
    prefs.push('user_pref("ui.systemUsesDarkTheme", 1);');
    prefs.push('user_pref("layout.css.prefers-color-scheme.content-override", 0);');
  }
  if (mobile) {
    prefs.push('user_pref("ui.primaryPointerCapabilities", 1);');
    prefs.push('user_pref("ui.allPointerCapabilities", 1);');
  }
  if (prefs.length > 0) fs.writeFileSync(path.join(profileDir, 'user.js'), `${prefs.join('\n')}\n`);
};

const remoteValue = (value) => {
  if (value == null || typeof value !== 'object') return value;
  switch (value.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'array':
    case 'set':
      return Array.isArray(value.value) ? value.value.map(remoteValue) : [];
    case 'object': {
      const object = {};
      for (const [key, item] of value.value ?? []) object[key] = remoteValue(item);
      return object;
    }
    case 'map': {
      const object = {};
      for (const [key, item] of value.value ?? []) object[String(remoteValue(key))] = remoteValue(item);
      return object;
    }
    default:
      return value.value;
  }
};

class WebSocketPeer {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.onEvent = null;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id) {
        try { this.onEvent?.(message); } catch { /* diagnostics must not break commands */ }
        return;
      }
      if (!this.pending.has(message.id)) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.type === 'success') entry.resolve(message.result);
      else entry.reject(new BrowserError('BIDI_ERROR', message.message ?? 'WebDriver BiDi command failed', message));
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new BrowserError('BIDI_CLOSED', 'WebDriver BiDi socket closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new BrowserError('BIDI_CLOSED', 'WebDriver BiDi socket is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError('BIDI_TIMEOUT', `WebDriver BiDi command timed out: ${method}`, { method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

const waitForBiDiServerFile = async (profileDir, isAlive, timeoutMs) => {
  const serverFile = path.join(profileDir, 'WebDriverBiDiServer.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(serverFile)) {
      try {
        const info = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
        if (info?.ws_host && Number.isInteger(info.ws_port) && info.ws_port > 0) return info;
      } catch {
        // The file is written just before the listener; retry.
      }
    }
    if (!isAlive()) {
      throw new BrowserError('FIREFOX_EXITED', 'Firefox exited before its WebDriver BiDi server was ready');
    }
    await sleep(100);
  }
  throw new BrowserError('FIREFOX_BIDI_TIMEOUT', `Firefox did not open WebDriver BiDi within ${timeoutMs}ms`);
};

const connectWebSocket = (url, timeoutMs) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => {
    try { socket.close(); } catch { /* ignore */ }
    reject(new BrowserError('BIDI_CONNECT_TIMEOUT', `WebSocket connect timed out: ${url}`));
  }, timeoutMs);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    resolve(socket);
  }, { once: true });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    reject(new BrowserError('BIDI_CONNECT_FAILED', `WebSocket connect failed: ${url}`));
  }, { once: true });
});

/**
 * A browser session that owns exactly one Firefox process and one profile.
 * Call close() in a finally block; it is idempotent.
 */
export class FirefoxBrowser {
  constructor({ child, peer, sessionId, context, executable, requested, resolvedVia, profileDir, outputDir, logs, keepProfile }) {
    this.child = child;
    this.peer = peer;
    this.sessionId = sessionId;
    this.context = context;
    this.executable = executable;
    this.requested = requested;
    this.resolvedVia = resolvedVia;
    this.profileDir = profileDir;
    this.outputDir = outputDir;
    this.keepProfile = keepProfile;
    this.logs = logs;
    this.consoleEntries = [];
    this.closed = false;
    this.closeResult = null;
  }

  async command(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.peer.send(method, params, timeoutMs);
  }

  async navigate(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.command('browsingContext.navigate', {
      context: this.context,
      url,
      wait: 'complete',
    }, timeoutMs);
    return result;
  }

  async evaluate(expression, { context = this.context, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.command('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    }, timeoutMs);
    if (result?.type === 'exception') {
      throw new BrowserError('EVALUATE_FAILED', result.exceptionDetails?.text ?? 'Evaluation failed', result.exceptionDetails);
    }
    return remoteValue(result?.result);
  }

  async setViewport(width, height, devicePixelRatio = 1) {
    await this.command('browsingContext.setViewport', {
      context: this.context,
      viewport: { width, height, devicePixelRatio },
    });
  }

  async screenshot(filePath, { context = this.context } = {}) {
    const result = await this.command('browsingContext.captureScreenshot', {
      context,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    const buffer = Buffer.from(result.data, 'base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer, { flag: 'wx' });
    return { path: filePath, bytes: buffer.length };
  }

  async frames() {
    const tree = await this.command('browsingContext.getTree', {});
    const rows = [];
    const walk = (node, depth = 0) => {
      rows.push({ context: node.context, url: node.url, depth, parent: node.parent ?? null });
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    for (const node of tree.contexts ?? []) walk(node);
    return rows;
  }

  async waitForExpression(expression, { timeoutMs = 15_000, intervalMs = 150, context = this.context } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression, { context, timeoutMs: Math.min(5_000, timeoutMs) });
        if (last) return last;
      } catch (error) {
        last = { error: error.message };
      }
      await sleep(intervalMs);
    }
    throw new BrowserError('WAIT_TIMEOUT', `Condition did not become true within ${timeoutMs}ms`, { expression, context, last });
  }

  async waitForFrame(matchText, { timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastFrames = [];
    while (Date.now() < deadline) {
      lastFrames = await this.frames().catch(() => []);
      const match = lastFrames.find((frame) => frame.url.includes(matchText));
      if (match) return match;
      await sleep(150);
    }
    throw new BrowserError('FRAME_TIMEOUT', `Frame containing ${matchText} did not appear`, { frames: lastFrames });
  }

  async clickByText(text, { timeoutMs = 15_000 } = {}) {
    const wanted = JSON.stringify(text);
    const expression = `(() => {
      const wanted = ${wanted};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const controls = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')];
      const exact = controls.find((el) => visible(el) && (el.innerText || '').trim() === wanted);
      let target = exact || controls.find((el) => visible(el) && (el.innerText || '').includes(wanted));
      if (!target) {
        // Mobile page entries are plain spans inside a menu, not buttons.
        const candidates = [...document.querySelectorAll('span,div,li')]
          .filter((el) => visible(el) && (el.innerText || '').trim() === wanted);
        candidates.sort((a, b) => a.childElementCount - b.childElementCount);
        target = candidates[0] ?? null;
      }
      if (!target) return JSON.stringify({ ok: false, reason: 'not-found' });
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return JSON.stringify({ ok: true, tag: target.tagName, text: (target.innerText || '').trim() });
    })()`;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const raw = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      try {
        last = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        last = { ok: false, reason: 'unreadable-result', raw };
      }
      if (last?.ok) return last;
      await sleep(250);
    }
    throw new BrowserError('CLICK_TIMEOUT', `Could not click visible control with text: ${text}`, { last });
  }

  async clickByAria(label, { timeoutMs = 10_000 } = {}) {
    const wanted = JSON.stringify(label);
    const expression = `(() => {
      const wanted = ${wanted};
      const candidate = [...document.querySelectorAll('[aria-label]')].find((el) => {
        const rect = el.getBoundingClientRect();
        return el.getAttribute('aria-label') === wanted && rect.width > 0 && rect.height > 0;
      });
      if (!candidate) return JSON.stringify({ ok: false, reason: 'not-found' });
      candidate.click();
      return JSON.stringify({ ok: true, tag: candidate.tagName, aria: wanted });
    })()`;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const raw = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      last = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (last?.ok) return last;
      await sleep(250);
    }
    throw new BrowserError('ARIA_CLICK_TIMEOUT', `Could not click visible aria-label: ${label}`, { last });
  }

  /** Pointer-click one element by CSS selector in a browsing context. */
  async pointerClick(selector, { context = this.context, index = 0, timeoutMs = 10_000, pointerType = 'mouse', scroll = true } = {}) {
    const literal = JSON.stringify(selector);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const raw = await this.evaluate(`(async () => {
        const all = [...document.querySelectorAll(${literal})];
        const element = all[${index}];
        if (!element) return JSON.stringify({ ok: false, reason: 'not-found', count: all.length });
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return JSON.stringify({ ok: false, reason: 'not-visible' });
        ${scroll ? "element.scrollIntoView({ block: 'center', inline: 'center' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));" : ''}
        const next = element.getBoundingClientRect();
        if (!element.isConnected || next.width <= 0 || next.height <= 0) return JSON.stringify({ ok: false, reason: 'detached-after-scroll' });
        {
          const hit = document.elementFromPoint(next.x + next.width / 2, next.y + next.height / 2);
          if (!hit || !element.contains(hit)) return JSON.stringify({ ok: false, reason: 'obscured', hit: hit?.tagName ?? null });
        }
        return JSON.stringify({ ok: true, x: next.x + next.width / 2, y: next.y + next.height / 2, tag: element.tagName, text: (element.innerText || '').trim() });
      })()`, { context }).catch((error) => ({ error: error.message }));
      try {
        last = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        last = { ok: false, reason: 'unreadable-result', raw };
      }
      if (last?.ok) {
        await this.command('input.performActions', {
          context,
          actions: [{
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType },
            actions: [
              { type: 'pointerMove', x: last.x, y: last.y, origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
        await this.command('input.releaseActions', { context }).catch(() => {});
        return last;
      }
      await sleep(200);
    }
    throw new BrowserError('POINTER_CLICK_TIMEOUT', `Could not pointer-click ${selector}`, { last });
  }

  /** Pointer-click a visible exact-text control inside a frame. */
  async pointerClickText(text, { context = this.context, timeoutMs = 10_000 } = {}) {
    const wanted = JSON.stringify(text);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const raw = await this.evaluate(`(async () => {
        const wanted = ${wanted};
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none';
        };
        const all = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],a')]
          .filter((element) => visible(element) && (element.innerText || '').trim() === wanted);
        let element = all[0];
        if (!element) {
          const fallback = [...document.querySelectorAll('span,div,li')]
            .filter((candidate) => visible(candidate) && (candidate.innerText || '').trim() === wanted);
          fallback.sort((a, b) => a.childElementCount - b.childElementCount);
          element = fallback[0] ?? null;
        }
        if (!element) return JSON.stringify({ ok: false, reason: 'not-found' });
        element.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (!element.isConnected || rect.width <= 0 || rect.height <= 0 || !hit || !element.contains(hit)) return JSON.stringify({ ok: false, reason: 'obscured-after-scroll', hit: hit?.tagName ?? null });
        return JSON.stringify({ ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: element.tagName, text: (element.innerText || '').trim() });
      })()`, { context }).catch((error) => ({ error: error.message }));
      try {
        last = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        last = { ok: false, reason: 'unreadable-result', raw };
      }
      if (last?.ok) {
        await this.command('input.performActions', {
          context,
          actions: [{
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: last.x, y: last.y, origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
        await this.command('input.releaseActions', { context }).catch(() => {});
        return last;
      }
      await sleep(200);
    }
    throw new BrowserError('POINTER_TEXT_TIMEOUT', `Could not pointer-click visible text: ${text}`, { last });
  }

  /** Pointer-click an exact-text option inside a scoped popup/list. */
  async pointerClickIn(scopeSelector, text, { context = this.context, timeoutMs = 10_000 } = {}) {
    const scope = JSON.stringify(scopeSelector);
    const wanted = JSON.stringify(text);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const raw = await this.evaluate(`(() => {
        const scope = document.querySelector(${scope});
        if (!scope) return JSON.stringify({ ok: false, reason: 'scope-not-found' });
        const candidates = [...scope.querySelectorAll('[role="option"],button,[role="menuitem"]')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (element.innerText || '').trim() === ${wanted};
          });
        const element = candidates[0];
        if (!element) return JSON.stringify({ ok: false, reason: 'option-not-found' });
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (element.innerText || '').trim() });
      })()`, { context }).catch((error) => ({ error: error.message }));
      try {
        last = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        last = { ok: false, reason: 'unreadable-result', raw };
      }
      if (last?.ok) {
        await this.command('input.performActions', {
          context,
          actions: [{
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: last.x, y: last.y, origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
        await this.command('input.releaseActions', { context }).catch(() => {});
        return last;
      }
      await sleep(200);
    }
    throw new BrowserError('POINTER_SCOPE_TIMEOUT', `Could not pointer-click ${text} inside ${scopeSelector}`, { last });
  }

  /**
   * Scroll an SDK popup trigger into view and let its geometry settle before the
   * popup opens. The SDK closes popups on any window-capture scroll, so a scroll
   * event that lands after open is a real hazard; shared by select and menu.
   */
  async prepareSdkPopupTrigger(scopeSelector, { context = this.context, deadline = Date.now() + 10_000, code = 'SDK_POPUP' } = {}) {
    const scope = JSON.stringify(scopeSelector);
    const remaining = remainingBudget(deadline);
    if (remaining.expired) {
      throw new BrowserError(`${code}_TIMEOUT`, `No time left to prepare ${scopeSelector}`, { scope: scopeSelector });
    }
    const prepared = JSON.parse(await this.evaluate(`(async () => {
      const scope = document.querySelector(${scope});
      if (!scope) return JSON.stringify({ ok: false, reason: 'scope-not-found' });
      const trigger = scope.querySelector('button[aria-haspopup]') ?? scope.querySelector('button');
      if (!trigger) return JSON.stringify({ ok: false, reason: 'trigger-not-found' });
      const rect = trigger.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return JSON.stringify({ ok: false, reason: 'trigger-not-visible' });
      trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Let the trigger geometry stay put across frames: a scroll event from
      // this or any ancestor scroller that arrives after the popup opens would
      // close it. Window scrollY alone misses inner scrolling panels.
      let lastTop = trigger.getBoundingClientRect().top;
      let stable = 0;
      for (let step = 0; step < 30 && stable < 3; step += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const top = trigger.getBoundingClientRect().top;
        if (Math.abs(top - lastTop) < 0.5) stable += 1;
        else { stable = 0; lastTop = top; }
      }
      trigger.focus({ preventScroll: true });
      return JSON.stringify({ ok: true, stable, scrollY: window.scrollY, top: lastTop });
    })()`, { context, timeoutMs: remaining.left }));
    if (!prepared?.ok) throw new BrowserError(code, `Could not prepare ${scopeSelector}`, { prepared });
    if (prepared.stable < 3) {
      throw new BrowserError(code, `${scopeSelector} trigger geometry did not settle before opening`, { prepared });
    }
    return prepared;
  }

  /**
   * Choose one option in an SDK select with real input.
   *
   * The SDK popup closes on any window scroll event, so a page scroll while it
   * is open closes it. This helper scrolls and settles the trigger BEFORE
   * opening, then clicks/keys only inside the popup with page scrolling off.
   * `pointer: false` exercises the keyboard path with a neutral pointer.
   */
  /**
   * Choose one option in an SDK select with real input.
   *
   * The SDK popup closes on any window scroll event, so a page scroll while it
   * is open closes it. This helper scrolls and settles the trigger BEFORE
   * opening, then clicks/keys only inside the popup with page scrolling off.
   * `pointer: false` exercises the keyboard path with a neutral pointer.
   */
  async selectSdkOption(scopeSelector, optionLabel, {
    context = this.context, pointer = true, pointerType = 'mouse', timeoutMs = 10_000,
  } = {}) {
    const scope = JSON.stringify(scopeSelector);
    const label = JSON.stringify(optionLabel);
    const triggerSelector = JSON.stringify(`${scopeSelector} .oc-sdk-trigger`);
    const triggerValueSelector = JSON.stringify(`${scopeSelector} .oc-sdk-trigger-value`);
    const listboxSelector = JSON.stringify(`${scopeSelector} .oc-sdk-popup [role="listbox"]`);
    const optionLabelsSelector = JSON.stringify(`${scopeSelector} .oc-sdk-popup .oc-sdk-option-label`);
    const deadline = Date.now() + timeoutMs;
    let phase = 'prepare';
    const budget = () => {
      const remaining = remainingBudget(deadline);
      if (remaining.expired) {
        throw new BrowserError('SDK_SELECT_TIMEOUT',
          `SDK select ${scopeSelector} exceeded its ${timeoutMs}ms deadline`,
          { phase, scope: scopeSelector, timeoutMs });
      }
      return remaining.left;
    };
    const diagnostics = async () => {
      try {
        return JSON.parse(await this.evaluate(`(() => {
          const scope = document.querySelector(${scope});
          const trigger = scope?.querySelector('.oc-sdk-trigger');
          const popup = scope?.querySelector('.oc-sdk-popup');
          return JSON.stringify({
            mode: ${pointer ? "'pointer'" : "'keyboard'"}, scope: ${scope}, expected: ${label}, phase,
            scopeFound: Boolean(scope), expanded: trigger?.getAttribute('aria-expanded') ?? null,
            value: scope?.querySelector('.oc-sdk-trigger-value')?.textContent ?? null,
            popupPresent: Boolean(popup),
            labels: [...(scope?.querySelectorAll('.oc-sdk-popup .oc-sdk-option-label') ?? [])].map((node) => node.textContent.trim()),
            activeOption: popup?.querySelector('[data-active="true"] .oc-sdk-option-label')?.textContent ?? null,
            active: { tag: document.activeElement?.tagName ?? null, role: document.activeElement?.getAttribute('role') ?? null },
            scrollY: window.scrollY,
            popupRect: popup?.getBoundingClientRect().toJSON() ?? null,
          });
        })()`, { context }));
      } catch {
        return null;
      }
    };
    try {
      budget();
      await this.prepareSdkPopupTrigger(scopeSelector, { context, deadline, code: 'SDK_SELECT' });
      phase = 'open';
      if (pointer) {
        await this.pointerClick(`${scopeSelector} .oc-sdk-trigger`, { context, pointerType, scroll: false, timeoutMs: budget() });
      } else {
        await this.command('input.performActions', {
          context,
          actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
            actions: [{ type: 'pointerMove', x: 2, y: 2, origin: 'viewport' }] }],
        });
        await this.command('input.releaseActions', { context }).catch(() => {});
        await this.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', { context });
        await this.waitForExpression(`document.activeElement === document.querySelector(${triggerSelector})`, {
          context, timeoutMs: budget(),
        });
        await this.pressKey('ArrowDown', { context });
      }
      phase = 'popup';
      await this.waitForExpression(`(() => {
        const scope = document.querySelector(${scope});
        return Boolean(scope?.querySelector('.oc-sdk-trigger')?.getAttribute('aria-expanded') === 'true'
          && scope.querySelector('.oc-sdk-popup [role="option"]'));
      })()`, { context, timeoutMs: budget() });
      const labels = JSON.parse(await this.evaluate(
        `JSON.stringify([...document.querySelectorAll(${optionLabelsSelector})].map((node) => node.textContent.trim()))`,
        { context },
      ));
      const index = labels.indexOf(optionLabel);
      if (index < 0) throw new BrowserError('SDK_SELECT', `No option ${optionLabel} in ${scopeSelector}`, { labels });
      phase = 'pick';
      if (pointer) {
        await this.pointerClick(`${scopeSelector} .oc-sdk-popup [role="option"]`, {
          context, index, pointerType, scroll: false, timeoutMs: budget(),
        });
      } else {
        await this.waitForExpression(`document.activeElement === document.querySelector(${listboxSelector})`, {
          context, timeoutMs: budget(),
        });
        await this.pressKey('Home', { context });
        for (let step = 0; step < index; step += 1) await this.pressKey('ArrowDown', { context });
        await this.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', { context });
        await this.waitForExpression(`(() => {
          const scope = document.querySelector(${scope});
          return scope?.querySelector('.oc-sdk-trigger')?.getAttribute('aria-expanded') === 'true'
            && document.activeElement === scope.querySelector('.oc-sdk-popup [role="listbox"]')
            && scope.querySelector('.oc-sdk-popup [data-active="true"] .oc-sdk-option-label')?.textContent === ${label};
        })()`, { context, timeoutMs: budget() });
        await this.pressKey('Enter', { context });
      }
      phase = 'confirm';
      await this.waitForExpression(`document.querySelector(${triggerValueSelector})?.textContent === ${label}`, {
        context, timeoutMs: budget(),
      });
      return { value: optionLabel, mode: pointer ? 'pointer' : 'keyboard', labels };
    } catch (error) {
      const state = await diagnostics();
      if (error instanceof BrowserError) error.details = { ...error.details, sdkSelect: state };
      else error.details = { ...(error.details ?? {}), sdkSelect: state };
      throw error;
    }
  }

  /** Read the open SDK menu: label, disabled and visibility per item. */
  async readSdkMenuItems(scopeSelector, { context = this.context } = {}) {
    const scope = JSON.stringify(scopeSelector);
    return JSON.parse(await this.evaluate(`(() => {
      const scope = document.querySelector(${scope});
      const popup = scope?.querySelector('.oc-sdk-popup');
      return JSON.stringify({
        scope: ${scope},
        expanded: scope?.querySelector('.oc-sdk-menu button')?.getAttribute('aria-expanded') ?? null,
        items: [...(popup?.querySelectorAll('[role="menuitem"]') ?? [])].map((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            label: node.querySelector('.oc-sdk-option-label')?.textContent?.trim() ?? (node.innerText || '').trim(),
            disabled: Boolean(node.disabled),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          };
        }),
        popupRect: popup?.getBoundingClientRect().toJSON() ?? null,
        scrollY: window.scrollY,
        active: { tag: document.activeElement?.tagName ?? null, role: document.activeElement?.getAttribute('role') ?? null },
      });
    })()`, { context }));
  }

  /**
   * Open an SDK menu with the shared pre-open preparation and no page scroll
   * while it is open. Returns the item list for decisive enabled/visible checks.
   */
  async openSdkMenu(scopeSelector, { context = this.context, timeoutMs = 10_000 } = {}) {
    const scope = JSON.stringify(scopeSelector);
    const deadline = Date.now() + timeoutMs;
    let phase = 'prepare';
    const budget = () => {
      const remaining = remainingBudget(deadline);
      if (remaining.expired) {
        throw new BrowserError('SDK_MENU_TIMEOUT',
          `SDK menu ${scopeSelector} exceeded its ${timeoutMs}ms deadline`,
          { phase, scope: scopeSelector, timeoutMs });
      }
      return remaining.left;
    };
    try {
      budget();
      await this.prepareSdkPopupTrigger(scopeSelector, { context, deadline, code: 'SDK_MENU' });
      phase = 'open';
      await this.pointerClick(`${scopeSelector} .oc-sdk-menu button`, { context, scroll: false, timeoutMs: budget() });
      phase = 'popup';
      await this.waitForExpression(`(() => {
        const scope = document.querySelector(${scope});
        return Boolean(scope?.querySelector('.oc-sdk-menu button')?.getAttribute('aria-expanded') === 'true'
          && scope.querySelector('.oc-sdk-popup [role="menuitem"]'));
      })()`, { context, timeoutMs: budget() });
      phase = 'open';
      return await this.readSdkMenuItems(scopeSelector, { context });
    } catch (error) {
      const state = await this.readSdkMenuItems(scopeSelector, { context }).catch(() => null);
      error.details = { ...(error.details ?? {}), sdkMenu: { scope: scopeSelector, phase, state } };
      throw error;
    }
  }

  /** Click one exact-label menu item in an already open SDK menu. */
  async clickSdkMenuItem(scopeSelector, itemLabel, { context = this.context, timeoutMs = 10_000 } = {}) {
    const scope = JSON.stringify(scopeSelector);
    const label = JSON.stringify(itemLabel);
    const deadline = Date.now() + timeoutMs;
    let phase = 'inspect';
    const budget = () => {
      const remaining = remainingBudget(deadline);
      if (remaining.expired) {
        throw new BrowserError('SDK_MENU_TIMEOUT',
          `SDK menu item ${itemLabel} in ${scopeSelector} exceeded its ${timeoutMs}ms deadline`,
          { phase, scope: scopeSelector, expected: itemLabel, timeoutMs });
      }
      return remaining.left;
    };
    try {
      budget();
      const menu = await this.readSdkMenuItems(scopeSelector, { context });
      const index = menu.items.findIndex((item) => item.label === itemLabel);
      if (index < 0) throw new BrowserError('SDK_MENU', `No menu item ${itemLabel} in ${scopeSelector}`, { menu });
      const item = menu.items[index];
      if (!item.visible) throw new BrowserError('SDK_MENU', `Menu item ${itemLabel} is not visible`, { menu });
      if (item.disabled) throw new BrowserError('SDK_MENU', `Menu item ${itemLabel} is disabled`, { menu });
      phase = 'click';
      await this.pointerClick(`${scopeSelector} .oc-sdk-popup [role="menuitem"]`, {
        context, index, scroll: false, timeoutMs: budget(),
      });
      phase = 'close';
      await this.waitForExpression(`document.querySelector(${JSON.stringify(`${scopeSelector} .oc-sdk-menu button`)})?.getAttribute('aria-expanded') !== 'true'`, {
        context, timeoutMs: budget(),
      });
      return { label: itemLabel, items: menu.items };
    } catch (error) {
      const state = await this.readSdkMenuItems(scopeSelector, { context }).catch(() => null);
      error.details = { ...(error.details ?? {}), sdkMenu: { scope: scopeSelector, phase, expected: itemLabel, state } };
      throw error;
    }
  }

  /** Open an SDK menu and click one exact-label item in it. */
  async selectSdkMenuItem(scopeSelector, itemLabel, options = {}) {
    await this.openSdkMenu(scopeSelector, options);
    return this.clickSdkMenuItem(scopeSelector, itemLabel, options);
  }

  /** Press one key through WebDriver BiDi input actions. */
  async pressKey(key, { context = this.context } = {}) {
    const values = {
      Enter: '\uE007', Escape: '\uE00C', Tab: '\uE004', Backspace: '\uE003',
      ArrowUp: '\uE013', ArrowDown: '\uE015', ArrowLeft: '\uE012', ArrowRight: '\uE014',
      Delete: '\uE017', Home: '\uE011', End: '\uE010', Space: ' ',
    };
    const value = values[key] ?? key;
    await this.command('input.performActions', {
      context,
      actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }],
    });
    await this.command('input.releaseActions', { context }).catch(() => {});
  }

  /** Type text as real key events into the focused element. */
  async typeText(text, { context = this.context } = {}) {
    const actions = [];
    for (const character of Array.from(text)) {
      actions.push({ type: 'keyDown', value: character }, { type: 'keyUp', value: character });
    }
    if (actions.length === 0) return;
    await this.command('input.performActions', {
      context,
      actions: [{ type: 'key', id: 'keyboard', actions }],
    });
    await this.command('input.releaseActions', { context }).catch(() => {});
  }

  consoleEntriesFor(context) {
    return this.consoleEntries.filter((entry) => !context || entry.context === context);
  }

  async consoleErrors(context = this.context) {
    try {
      const value = await this.evaluate('window.__omosConsoleErrors || []', { context });
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  async close() {
    if (this.closed) return this.closeResult;
    this.closed = true;
    const result = {
      sessionEnded: false,
      browserExited: false,
      profileRemoved: false,
      exitCode: null,
      signal: null,
    };
    let exitInfo = null;
    const exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        exitInfo = { code, signal };
        resolve(exitInfo);
      });
    });
    try {
      await this.command('session.end', {}, 5_000);
      result.sessionEnded = true;
    } catch {
      // The browser may already have gone; the process checks below decide.
    }
    try { this.peer.socket.close(); } catch { /* ignore */ }
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    const graceful = await Promise.race([exited, sleep(CLOSE_WAIT_MS).then(() => null)]);
    if (!graceful) {
      try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      await Promise.race([exited, sleep(3_000)]);
    }
    result.browserExited = Boolean(exitInfo);
    result.exitCode = exitInfo?.code ?? null;
    result.signal = exitInfo?.signal ?? null;
    if (!result.browserExited) {
      try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    if (!this.keepProfile) {
      try {
        fs.rmSync(this.profileDir, { recursive: true, force: true });
        result.profileRemoved = !fs.existsSync(this.profileDir);
      } catch {
        result.profileRemoved = false;
      }
    }
    result.firefoxLog = this.logs.slice(-4_000);
    this.closeResult = result;
    return result;
  }
}

/**
 * Start one owned headless Firefox and return a ready BiDi session.
 */
export const launchFirefox = async ({
  firefox,
  output,
  dark = false,
  mobile = false,
  keepProfile = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = 'browser',
} = {}) => {
  const resolved = resolveFirefoxBinary(firefox);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(path.resolve(output ?? DEFAULT_OUTPUT), `run-${label}-${stamp}-${process.pid}`);
  const profileDir = path.join(runDir, 'profile');
  const homeDir = path.join(runDir, 'home');
  const tempDir = path.join(runDir, 'tmp');
  for (const dir of [runDir, profileDir, homeDir, tempDir]) fs.mkdirSync(dir, { recursive: true });
  if (dark || mobile) writeProfilePrefs(profileDir, { dark, mobile });

  const logs = { stdout: '', stderr: '' };
  const child = spawn(resolved.executable, [
    '--headless',
    '-no-remote',
    '--profile', profileDir,
    '--remote-debugging-port=0',
    'about:blank',
  ], {
    env: {
      HOME: homeDir,
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      XDG_CACHE_HOME: path.join(homeDir, '.cache'),
      TMPDIR: tempDir,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      MOZ_CRASHREPORTER_DISABLE: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (key) => (chunk) => {
    logs[key] = (logs[key] + String(chunk)).slice(-20_000);
  };
  child.stdout.on('data', append('stdout'));
  child.stderr.on('data', append('stderr'));

  let peer = null;
  try {
    const info = await waitForBiDiServerFile(profileDir, () => child.exitCode === null, timeoutMs);
    const socket = await connectWebSocket(`ws://${info.ws_host}:${info.ws_port}/session`, timeoutMs);
    peer = new WebSocketPeer(socket);
    const session = await peer.send('session.new', { capabilities: { alwaysMatch: {} } }, timeoutMs);
    try {
      await peer.send('session.subscribe', { events: ['log.entryAdded'] }, timeoutMs);
    } catch {
      // Console capture is diagnostic; navigation and evaluation must still work.
    }
    try {
      await peer.send('script.addPreloadScript', {
        functionDeclaration: `() => {
          const bucket = [];
          Object.defineProperty(window, '__omosConsoleErrors', { value: bucket, configurable: true });
          const stringify = (value) => {
            try {
              if (typeof value === 'string') return value;
              if (value instanceof Error) return value.stack || value.message;
              return JSON.stringify(value);
            } catch { return String(value); }
          };
          const originalError = console.error.bind(console);
          console.error = (...args) => {
            if (bucket.length < 100) bucket.push({ level: 'error', text: args.map(stringify).join(' ') });
            originalError(...args);
          };
          window.addEventListener('error', (event) => {
            if (bucket.length < 100) bucket.push({ level: 'error', text: String(event.message || event.error || 'window error') });
          });
          window.addEventListener('unhandledrejection', (event) => {
            if (bucket.length < 100) bucket.push({ level: 'error', text: stringify(event.reason) });
          });
        }`,
      }, timeoutMs);
    } catch {
      // Older hosts/browsers may not expose preload scripts.
    }
    const created = await peer.send('browsingContext.create', { type: 'tab' }, timeoutMs);
    const browser = new FirefoxBrowser({
      child,
      peer,
      sessionId: session.sessionId,
      context: created.context,
      executable: resolved.executable,
      requested: resolved.requested,
      resolvedVia: resolved.resolvedVia,
      profileDir,
      outputDir: runDir,
      logs: logs.stdout + logs.stderr,
      keepProfile,
    });
    peer.onEvent = (message) => {
      if (message.method !== 'log.entryAdded') return;
      const entry = message.params?.entry;
      if (!entry) return;
      browser.consoleEntries.push({
        level: entry.level ?? null,
        type: entry.type ?? null,
        text: String(entry.text ?? '').slice(0, 2_000),
        url: entry.source?.url ?? null,
        context: entry.source?.context ?? null,
        timestamp: entry.timestamp ?? null,
      });
      if (browser.consoleEntries.length > 200) browser.consoleEntries.shift();
    };
    browser.socketInfo = info;
    return browser;
  } catch (error) {
    try { peer?.socket.close(); } catch { /* ignore */ }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
    if (!keepProfile) fs.rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }
};

export const parseArgs = (argv) => {
  const options = {
    selfTest: false,
    firefox: null,
    output: DEFAULT_OUTPUT,
    url: null,
    screenshot: 'screenshot.png',
    evaluate: null,
    width: 1280,
    height: 800,
    dark: false,
    keepProfile: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new BrowserError('ARGS', `Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--firefox') options.firefox = next();
    else if (arg === '--output') options.output = next();
    else if (arg === '--url') options.url = next();
    else if (arg === '--screenshot') options.screenshot = next();
    else if (arg === '--evaluate') options.evaluate = next();
    else if (arg === '--width') options.width = Number(next());
    else if (arg === '--height') options.height = Number(next());
    else if (arg === '--dark') options.dark = true;
    else if (arg === '--keep-profile') options.keepProfile = true;
    else if (arg === '--timeout') options.timeoutMs = Number(next());
    else throw new BrowserError('ARGS', `Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.width) || options.width < 1) throw new BrowserError('ARGS', '--width must be positive');
  if (!Number.isFinite(options.height) || options.height < 1) throw new BrowserError('ARGS', '--height must be positive');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new BrowserError('ARGS', '--timeout must be positive');
  return options;
};

const printJson = (value) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const runSelfTest = async (options) => {
  const startedAt = new Date().toISOString();
  const browser = await launchFirefox({
    firefox: options.firefox,
    output: options.output,
    keepProfile: options.keepProfile,
    timeoutMs: options.timeoutMs,
    label: 'self-test',
  });
  let closeResult = null;
  try {
    await browser.setViewport(options.width, options.height);
    const navigation = await browser.navigate('about:blank', { timeoutMs: options.timeoutMs });
    const arithmetic = await browser.evaluate('JSON.stringify({ sum: 2 + 2, ready: document.readyState, parentIsSelf: window.parent === window })');
    const parsed = JSON.parse(arithmetic);
    const screenshot = await browser.screenshot(path.join(browser.outputDir, 'about-blank.png'));
    const png = fs.readFileSync(screenshot.path).subarray(0, 8).toString('hex');
    const checks = {
      navigated: navigation?.url === 'about:blank',
      evaluated: parsed.sum === 4,
      documentComplete: parsed.ready === 'complete',
      topLevel: parsed.parentIsSelf === true,
      screenshotPng: png === '89504e470d0a1a0a',
      screenshotBytes: screenshot.bytes,
    };
    closeResult = await browser.close();
    const checksWithCleanup = {
      ...checks,
      browserExited: closeResult.browserExited,
      profileRemoved: closeResult.profileRemoved,
    };
    const ok = Object.entries(checksWithCleanup)
      .filter(([key]) => key !== 'screenshotBytes')
      .every(([, value]) => value === true);
    const report = {
      ok,
      mode: 'self-test',
      startedAt,
      finishedAt: new Date().toISOString(),
      firefox: {
        requested: browser.requested,
        executable: browser.executable,
        resolvedVia: browser.resolvedVia,
        port: browser.socketInfo?.ws_port ?? null,
      },
      runDir: browser.outputDir,
      checks: checksWithCleanup,
      screenshot,
      cleanup: closeResult,
    };
    fs.writeFileSync(path.join(browser.outputDir, 'self-test.json'), `${JSON.stringify(report, null, 2)}\n`);
    printJson(report);
    if (!ok) process.exitCode = 1;
  } finally {
    if (!browser.closed) await browser.close();
  }
};

const runUrlMode = async (options) => {
  const browser = await launchFirefox({
    firefox: options.firefox,
    output: options.output,
    dark: options.dark,
    keepProfile: options.keepProfile,
    timeoutMs: options.timeoutMs,
    label: 'url',
  });
  try {
    await browser.setViewport(options.width, options.height);
    const navigation = await browser.navigate(options.url, { timeoutMs: options.timeoutMs });
    const evaluated = options.evaluate ? await browser.evaluate(options.evaluate) : null;
    const screenshot = await browser.screenshot(path.join(browser.outputDir, options.screenshot));
    printJson({
      ok: true,
      mode: 'url',
      url: navigation?.url ?? options.url,
      evaluated,
      screenshot,
      runDir: browser.outputDir,
    });
  } finally {
    await browser.close();
  }
};

export const main = async (argv) => {
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
  if (!options.firefox) {
    process.stderr.write(`--firefox is required\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (!options.selfTest && !options.url) {
    process.stderr.write(`Choose --self-test or --url\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    if (options.selfTest) await runSelfTest(options);
    else await runUrlMode(options);
  } catch (error) {
    printJson({
      ok: false,
      code: error.code ?? 'ERROR',
      message: error.message,
      details: error.details ?? null,
      firefoxLog: error.firefoxLog ?? null,
    });
    process.exitCode = 1;
  }
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
