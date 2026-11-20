// Read-only favorites import source. Separate from the OMOS target generation:
// this adapter only persists an explicitly configured profile path and opens it
// fresh on every snapshot request. It never writes, chmods or repairs the source.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonStore, writeJsonStore } from './store.js';
import { ServiceError, badRequest } from './errors.js';
import { hasPlaceholder, isModelId } from './model-id.js';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_FAVORITE_MODELS = 64;
export const MAX_RAW_REFS = 1024;
export const SOURCE_KIND = 'openchamber-preferences-v1';
const MAX_FILE_PATH = 4096;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validFilePath(value) {
  return typeof value === 'string'
    && (value === '' || (value.length <= MAX_FILE_PATH
      && !/[\0\r\n]/.test(value)
      && path.isAbsolute(value)));
}

function invalidFilePath() {
  return badRequest('filePath must be an absolute path or an empty string.', 'INVALID_FAVORITES_SOURCE');
}

function corruptSourceSettings() {
  return new ServiceError(
    500,
    'FAVORITES_SOURCE_CORRUPT',
    'Saved favorites source settings could not be read. Fix or remove favorites-source.json in the extension data folder.',
  );
}

function unready(generation, state, code, message) {
  return { state, generation, error: { code, message } };
}

function classifyOpenError(error) {
  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return { state: 'unavailable', code: 'FAVORITES_SOURCE_MISSING', message: 'The configured favorites source was not found.' };
    case 'ELOOP':
    case 'EISDIR':
      return { state: 'unsupported', code: 'FAVORITES_SOURCE_NOT_REGULAR', message: 'The favorites source must be a regular file.' };
    case 'EACCES':
    case 'EPERM':
      return { state: 'unavailable', code: 'FAVORITES_SOURCE_UNREADABLE', message: 'The configured favorites source could not be read.' };
    default:
      return { state: 'unavailable', code: 'FAVORITES_SOURCE_UNAVAILABLE', message: 'The configured favorites source could not be read.' };
  }
}

// The combined providerID/modelID string uses the same shared OMOS validator as
// the page, so eligibility cannot drift. The tuple itself is preserved; only
// the provider token is separately required to contain no slash.
function normalizeRef(entry) {
  if (!isObject(entry)) return null;
  const { providerID, modelID } = entry;
  if (typeof providerID !== 'string' || typeof modelID !== 'string') return null;
  if (!providerID.length || providerID.includes('/')) return null;
  const id = `${providerID}/${modelID}`;
  if (!isModelId(id) || hasPlaceholder(id)) return null;
  return { providerID, modelID };
}

// Safe projection only: normalized ordered refs and the normalized profile
// stamp. Formatting, other preferences and readAt never change it.
function favoriteFingerprint(models, updatedAt) {
  return createHash('sha256').update(JSON.stringify({
    sourceKind: SOURCE_KIND,
    favoriteModels: models.map(({ providerID, modelID }) => [providerID, modelID]),
    updatedAt,
  }), 'utf8').digest('hex');
}

function readTimestamp(now) {
  const value = now();
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function parseFavoritePreferences(text, generation, now) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return unready(generation, 'unavailable', 'FAVORITES_SOURCE_MALFORMED',
      'The favorites source is not valid JSON.');
  }
  if (!isObject(document)) {
    return unready(generation, 'unavailable', 'FAVORITES_SOURCE_MALFORMED',
      'The favorites source is not a supported JSON object.');
  }
  if (document.version !== 1) {
    return unready(generation, 'unsupported', 'FAVORITES_SOURCE_VERSION_UNSUPPORTED',
      'The favorites source version is not supported.');
  }
  const fields = document.fields;
  if (!isObject(fields) || !Object.hasOwn(fields, 'favoriteModels')) {
    return unready(generation, 'unsupported', 'FAVORITES_SOURCE_SCHEMA_UNSUPPORTED',
      'The favorites source does not contain base favorite models.');
  }
  const favoriteModels = fields.favoriteModels;
  if (!isObject(favoriteModels) || !Object.hasOwn(favoriteModels, 'value')) {
    return unready(generation, 'unsupported', 'FAVORITES_SOURCE_SCHEMA_UNSUPPORTED',
      'The favorites source does not contain base favorite models.');
  }
  if (!Array.isArray(favoriteModels.value)) {
    return unready(generation, 'unsupported', 'FAVORITES_SOURCE_SCHEMA_UNSUPPORTED',
      'The favorites source favoriteModels value is not a list.');
  }
  if (favoriteModels.value.length > MAX_RAW_REFS) {
    return unready(generation, 'unsupported', 'FAVORITES_SOURCE_TOO_MANY',
      `The favorites source contains more than ${MAX_FAVORITE_MODELS} favorite models.`);
  }

  // The profile stamp is metadata only: missing, non-numeric, ISO, negative or
  // otherwise invalid values normalize to null without invalidating the list.
  let updatedAt = null;
  if (Object.hasOwn(favoriteModels, 'updatedAt')) {
    const value = favoriteModels.updatedAt;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      updatedAt = value;
    }
  }

  const seen = new Set();
  const models = [];
  for (const entry of favoriteModels.value) {
    const ref = normalizeRef(entry);
    if (!ref) {
      return unready(generation, 'unsupported', 'FAVORITES_SOURCE_REFS_UNSUPPORTED',
        'The favorites source contains an unsupported model reference.');
    }
    const key = `${ref.providerID}\u0000${ref.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(ref);
    if (models.length > MAX_FAVORITE_MODELS) {
      return unready(generation, 'unsupported', 'FAVORITES_SOURCE_TOO_MANY',
        `The favorites source contains more than ${MAX_FAVORITE_MODELS} favorite models.`);
    }
  }

  return {
    state: 'ready',
    generation,
    favoriteModels: models,
    fingerprint: favoriteFingerprint(models, updatedAt),
    readAt: readTimestamp(now),
    updatedAt,
    sourceKind: SOURCE_KIND,
  };
}

// Always opens the configured path afresh. O_NOFOLLOW rejects a final symlink,
// O_NONBLOCK prevents a FIFO open from blocking, and the second fstat detects
// growth or truncation during the read. io is a test-only failure-injection seam.
export function readFavoritesSnapshot({ filePath, generation, now = Date.now, io = {} } = {}) {
  if (!filePath) {
    return unready(generation, 'not-configured', 'FAVORITES_SOURCE_NOT_CONFIGURED',
      'No favorites source is configured.');
  }
  const open = io.open ?? fs.openSync;
  const fstat = io.fstat ?? fs.fstatSync;
  const read = io.read ?? fs.readSync;
  const close = io.close ?? fs.closeSync;
  const lstat = io.lstat ?? fs.lstatSync;
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);

  let descriptor;
  try {
    descriptor = open(filePath, flags);
  } catch (error) {
    const classified = classifyOpenError(error);
    return unready(generation, classified.state, classified.code, classified.message);
  }

  try {
    const first = fstat(descriptor);
    if (!first.isFile()) {
      return unready(generation, 'unsupported', 'FAVORITES_SOURCE_NOT_REGULAR',
        'The favorites source must be a regular file.');
    }
    if (first.size > MAX_SOURCE_BYTES) {
      return unready(generation, 'unavailable', 'FAVORITES_SOURCE_TOO_LARGE',
        'The favorites source is larger than 2 MiB.');
    }
    if (typeof io.afterFirstStat === 'function') io.afterFirstStat(filePath);
    const buffer = Buffer.allocUnsafe(first.size);
    let offset = 0;
    while (offset < first.size) {
      const bytes = read(descriptor, buffer, offset, first.size - offset, offset);
      if (bytes <= 0) break;
      offset += bytes;
    }
    const second = fstat(descriptor);
    if (!second.isFile() || second.size !== first.size || offset !== first.size
      || second.mtimeMs !== first.mtimeMs || second.ctimeMs !== first.ctimeMs) {
      return unready(generation, 'unavailable', 'FAVORITES_SOURCE_CHANGED',
        'The favorites source changed while it was read. Try again.');
    }
    // A concurrent atomic replacement keeps the open descriptor coherent but
    // would hand the caller a stale version. Detect it by path identity.
    let current;
    try {
      current = lstat(filePath);
    } catch {
      return unready(generation, 'unavailable', 'FAVORITES_SOURCE_CHANGED',
        'The favorites source changed while it was read. Try again.');
    }
    if (!current.isFile() || current.dev !== second.dev || current.ino !== second.ino) {
      return unready(generation, 'unavailable', 'FAVORITES_SOURCE_CHANGED',
        'The favorites source changed while it was read. Try again.');
    }
    const text = buffer.subarray(0, offset).toString('utf8');
    return parseFavoritePreferences(text, generation, now);
  } catch {
    return unready(generation, 'unavailable', 'FAVORITES_SOURCE_UNAVAILABLE',
      'The configured favorites source could not be read.');
  } finally {
    try { close(descriptor); } catch { /* descriptor already closed */ }
  }
}

export function createFavoritesSourceStore({ dataDir, now = Date.now } = {}) {
  const file = path.join(dataDir, 'favorites-source.json');
  let cached = null;

  function load() {
    if (cached) return cached;
    let record;
    try {
      record = readJsonStore(file, null);
    } catch {
      throw corruptSourceSettings();
    }
    if (record === null) {
      cached = { filePath: '', generation: randomUUID() };
      return cached;
    }
    if (!isObject(record) || record.version !== 1
      || !validFilePath(record.filePath)
      || typeof record.generation !== 'string'
      || !record.generation.length || record.generation.length > 200) {
      throw corruptSourceSettings();
    }
    cached = { filePath: record.filePath, generation: record.generation };
    return cached;
  }

  return {
    get() {
      const state = load();
      return { filePath: state.filePath, generation: state.generation };
    },
    update(filePath) {
      if (!validFilePath(filePath)) throw invalidFilePath();
      const generation = randomUUID();
      try {
        writeJsonStore(file, { version: 1, filePath, generation });
      } catch {
        throw new ServiceError(
          500,
          'FAVORITES_SOURCE_NOT_SAVED',
          'The favorites source setting could not be saved in the extension data folder. Nothing changed.',
        );
      }
      cached = { filePath, generation };
      return { filePath, generation };
    },
    snapshot() {
      const state = load();
      return readFavoritesSnapshot({ filePath: state.filePath, generation: state.generation, now });
    },
  };
}
