// Async, single-flight model catalog jobs. A request never waits on the CLI: it
// starts at most one job and answers the current state immediately. Late
// completions, retry waits and children are fenced by job identity, scope and
// shutdown; the CLI child receives a small allowlisted environment only.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonStore, writeJsonStore } from './store.js';
import { isModelId } from './model-id.js';

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const CHILD_TIMEOUT_MS = 60 * 1000;
export const CHILD_MAX_BUFFER = 8 * 1024 * 1024;
const PLUGIN_STARTUP = /Location plugins did not finish activating/i;
const RETRY_DELAY_MS = 750;
// Stay below the supported host's 5-second service termination grace.
const TERM_GRACE_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 3000;

// Only host-provided system context reaches the CLI child; bearer tokens,
// callback URLs and extension service variables never do.
const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
];

const stripAnsi = text => String(text ?? '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]/g, '');

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

function parseFlat(stdout) {
  return [...new Set(stripAnsi(stdout).split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => isModelId(line)))].sort();
}

function sanitizedFailure(error, executable) {
  if (error?.code === 'ENOENT') {
    return `Could not start ${executable}: the executable or working directory was not found.`;
  }
  if (error?.killed || error?.signal) {
    return `The model command was stopped after ${CHILD_TIMEOUT_MS / 1000} seconds.`;
  }
  if (typeof error?.code === 'number' || typeof error?.code === 'string') {
    return `The model command for ${executable} failed (exit ${error.code}).`;
  }
  return `The model command for ${executable} failed.`;
}

export function createCatalog({
  dataDir,
  env = process.env,
  now = Date.now,
  execFileImpl = execFile,
  logger = () => {},
} = {}) {
  const file = path.join(dataDir, 'models.json');
  let lastGood = null;
  let loaded = false;
  let currentScope = null;
  let job = null;
  let failure = null;
  let stopped = false;
  const children = new Set();
  const activeRecords = new Set();
  let shutdownPromise;

  function loadPersisted() {
    if (loaded) return;
    loaded = true;
    let record;
    try {
      record = readJsonStore(file, null);
    } catch {
      return;
    }
    if (!record || typeof record !== 'object' || typeof record.scope !== 'string'
      || !Array.isArray(record.flat) || typeof record.updatedAt !== 'number'
      || !Number.isFinite(record.updatedAt)) return;
    const flat = record.flat.filter(id => typeof id === 'string' && isModelId(id));
    if (flat.length !== record.flat.length) return;
    lastGood = { scope: record.scope, flat, updatedAt: record.updatedAt };
  }

  function persist(record) {
    try {
      writeJsonStore(file, { version: 1, ...record });
    } catch (error) {
      logger(`Could not persist the model catalog: ${error?.message ?? 'unknown error'}`);
    }
  }

  function childEnv(settings) {
    const next = { NO_COLOR: '1', TERM: 'dumb' };
    for (const key of CHILD_ENV_KEYS) {
      if (typeof env[key] === 'string') next[key] = env[key];
    }
    if (settings.opencodeConfigDir) next.OPENCODE_CONFIG_DIR = settings.opencodeConfigDir;
    return next;
  }

  function fence(record) {
    return stopped || record.cancelled || job !== record || record.scope !== currentScope;
  }

  function cancelRecord(record) {
    if (!record) return;
    record.cancelled = true;
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    const cancelWait = record.cancelWait;
    record.cancelWait = null;
    if (cancelWait) cancelWait();
    try { record.child?.kill('SIGTERM'); } catch { /* already settled */ }
  }

  function waitForRetry(record, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.timer = null;
        record.cancelWait = null;
        resolve();
      }, ms);
      record.timer = timer;
      record.cancelWait = () => {
        clearTimeout(timer);
        record.timer = null;
        reject(new Cancelled());
      };
    });
  }

  function runOnce(record, settings) {
    // Fence before spawn: a cancelled/shutdown/obsoleted job must not start work.
    if (fence(record)) return Promise.reject(new Cancelled());
    return new Promise((resolve, reject) => {
      const options = {
        cwd: settings.modelCwd,
        env: childEnv(settings),
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: CHILD_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      };
      const child = execFileImpl(settings.opencodeBin, ['models'], options, (error, stdout, stderr) => {
        if (child) children.delete(child);
        record.child = null;
        if (record.cancelled) {
          reject(new Cancelled());
          return;
        }
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout });
      });
      record.child = child ?? null;
      if (child) children.add(child);
    });
  }

  async function enumerate(record, settings) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { stdout } = await runOnce(record, settings);
        const flat = parseFlat(stdout);
        if (!flat.length) throw new Error('No provider/model lines returned.');
        return flat;
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        const retryable = attempt < 3
          && PLUGIN_STARTUP.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`);
        if (!retryable) throw error;
        await waitForRetry(record, RETRY_DELAY_MS);
        // Fence again after the wait; runOnce also fences before spawning.
        if (fence(record)) throw new Cancelled();
      }
    }
  }

  function start(settings, scope) {
    if (stopped) return;
    loadPersisted();
    const record = {
      id: randomUUID(), scope, child: null, settings, cancelled: false, timer: null, cancelWait: null,
    };
    job = record;
    activeRecords.add(record);
    record.done = enumerate(record, settings).then(flat => {
      if (fence(record)) return;
      job = null;
      const result = { scope: record.scope, flat, updatedAt: now() };
      lastGood = result;
      failure = null;
      persist(result);
    }, error => {
      if (job === record) job = null;
      if (record.cancelled || record.scope !== currentScope) return;
      const message = sanitizedFailure(error, record.settings.opencodeBin);
      failure = { scope: record.scope, message };
      logger(`Model catalog job failed: ${message}`);
    }).finally(() => activeRecords.delete(record));
  }

  function abortObsolete(scope) {
    if (job && job.scope !== scope) {
      cancelRecord(job);
      job = null;
    }
  }

  function body(scope, state, cache, stale, error) {
    return {
      state,
      flat: cache ? [...cache.flat] : [],
      updatedAt: cache ? cache.updatedAt : null,
      stale,
      error,
    };
  }

  function compute(scope) {
    loadPersisted();
    currentScope = scope;
    abortObsolete(scope);
    const cache = lastGood && lastGood.scope === scope ? lastGood : null;
    const cacheFresh = cache ? now() - cache.updatedAt < CACHE_TTL_MS : false;
    const stale = cache ? !cacheFresh : false;
    if (job && job.scope === scope) return body(scope, 'loading', cache, stale, null);
    if (failure && failure.scope === scope) {
      return body(scope, 'error', cache, cache !== null,
        { code: 'MODELS_UNAVAILABLE', message: failure.message });
    }
    if (cacheFresh) return body(scope, 'ready', cache, false, null);
    return body(scope, 'loading', cache, stale, null);
  }

  return {
    setScope(scope) {
      if (stopped) return;
      currentScope = scope;
      abortObsolete(scope);
    },
    status(settings, scope) {
      if (stopped) return body(scope, 'error', null, false,
        { code: 'MODELS_UNAVAILABLE', message: 'The service is stopping.' });
      loadPersisted();
      currentScope = scope;
      abortObsolete(scope);
      const cache = lastGood && lastGood.scope === scope ? lastGood : null;
      const cacheFresh = cache ? now() - cache.updatedAt < CACHE_TTL_MS : false;
      const shouldStart = !(job && job.scope === scope)
        && !(failure && failure.scope === scope)
        && !cacheFresh;
      if (shouldStart) start(settings, scope);
      return compute(scope);
    },
    refresh(settings, scope) {
      if (stopped) return body(scope, 'error', null, false,
        { code: 'MODELS_UNAVAILABLE', message: 'The service is stopping.' });
      loadPersisted();
      currentScope = scope;
      abortObsolete(scope);
      if (failure && failure.scope === scope) failure = null;
      if (!(job && job.scope === scope)) start(settings, scope);
      return compute(scope);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      stopped = true;
      currentScope = null;
      const records = [...activeRecords];
      for (const record of records) cancelRecord(record);
      job = null;
      const killTimer = setTimeout(() => {
        for (const child of children) {
          try { child.kill('SIGKILL'); } catch { /* await the actual callback */ }
        }
      }, TERM_GRACE_MS);
      let deadline;
      const drained = Promise.allSettled(records.map(record => record.done)).then(() => {
        if (children.size) throw new Error('Owned catalog children remain after shutdown.');
      });
      shutdownPromise = Promise.race([drained, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Catalog shutdown did not settle.')), SHUTDOWN_TIMEOUT_MS);
      })]).finally(() => {
        clearTimeout(killTimer);
        clearTimeout(deadline);
      });
      return shutdownPromise;
    },
  };
}
