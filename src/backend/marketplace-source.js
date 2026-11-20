// Versioned read-only adapter for the installed OMOS marketplace store.
//
// This module deliberately does not import OMOS runtime/store code: even a
// list operation there reconciles and writes under a lease. It reads the
// explicitly configured lock and immutable package bundles, verifies their
// canonical SHA-256 integrity, and exposes only a small safe projection.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseTree } from 'jsonc-parser';
import { readJsonStore, writeJsonStore } from './store.js';
import { ServiceError, badRequest } from './errors.js';

export const ADAPTER_VERSION = 'omos-marketplace-lock-v2';
export const MAX_LOCK_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 512 * 1024;
export const MAX_SIDECAR_BYTES = 128;
export const MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;
export const MAX_PACKAGES = 64;
export const MAX_DEPTH = 64;
export const MAX_ROOT_PATH = 4096;
export const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HEX_RE = /^[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const EXTENDABLE_BUILTINS = new Set(['explorer', 'oracle', 'designer', 'fixer', 'observer', 'librarian']);
const RESERVED_AGENT_NAMES = new Set([
  'build', 'orchestrator', 'explorer', 'oracle', 'designer', 'fixer', 'observer', 'council',
  'councillor', 'librarian', 'explore', 'frontend-ui-ux-engineer',
]);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const LEASE_ENTRY_RE = /^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(candidate|lease)$/;
const MAX_LEASE_ENTRIES = 128;
const LEASE_STALE_MS = 60_000;
const MAX_PID = 2_147_483_647;
const MODEL_SOURCES = new Set(['session', 'orchestrator', 'explicit', 'builtin']);
const LOCK_KEYS = ['schemaVersion', 'packages'];
const ENTRY_KEYS = ['manifestSchemaVersion', 'manifestVersion', 'source', 'digest'];
const DIGEST_KEYS = ['algorithm', 'domain', 'value'];
const SOURCE_KEYS = {
  local: ['kind', 'path'],
  registry: ['kind', 'registry', 'indexUrl', 'packageUrl'],
  'in-memory': ['kind', 'label'],
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

class SnapshotError extends Error {
  constructor(state, code, message) {
    super(message);
    this.state = state;
    this.code = code;
  }
}

const unavailable = (code, message) => new SnapshotError('unavailable', code, message);
const unsupported = (code, message) => new SnapshotError('unsupported', code, message);
const changed = () => unavailable('MARKETPLACE_SOURCE_CHANGED', 'The marketplace source changed while it was read. Try again.');
const malformed = () => unavailable('MARKETPLACE_SOURCE_MALFORMED', 'The marketplace source is not valid JSON.');
const tooLarge = () => unavailable('MARKETPLACE_SOURCE_TOO_LARGE', 'The marketplace source exceeds its size bound.');
const leased = () => unavailable('MARKETPLACE_SOURCE_LEASED', 'The marketplace store has an active lease. Try again later.');

function validRootPath(value) {
  return typeof value === 'string'
    && (value === '' || (value.length <= MAX_ROOT_PATH
      && path.isAbsolute(value)
      && !/[\0\r\n]/.test(value)));
}

function corruptSettings() {
  return new ServiceError(
    500,
    'MARKETPLACE_SOURCE_CORRUPT',
    'Saved marketplace source settings could not be read. Fix or remove marketplace-source.json in the extension data folder.',
  );
}

function invalidRootPath() {
  return badRequest('rootPath must be an absolute path or an empty string.', 'INVALID_MARKETPLACE_SOURCE');
}

function notSaved() {
  return new ServiceError(
    500,
    'MARKETPLACE_SOURCE_NOT_SAVED',
    'The marketplace source setting could not be saved in the extension data folder. Nothing changed.',
  );
}

// Recursively checks every existing component. A symlink anywhere below the
// filesystem root is rejected, including the configured root itself.
function assertNoSymlinkComponents(target, { missing = 'unavailable' } = {}) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        if (missing === 'unsupported') throw unsupported('MARKETPLACE_SOURCE_MISSING', 'A marketplace bundle file was not found.');
        throw unavailable('MARKETPLACE_SOURCE_MISSING', 'The configured marketplace source was not found.');
      }
      throw unavailable('MARKETPLACE_SOURCE_UNREADABLE', 'The configured marketplace source could not be read.');
    }
    if (stats.isSymbolicLink()) {
      throw unsupported('MARKETPLACE_SOURCE_NOT_REGULAR', 'The marketplace source must not contain symlinks.');
    }
  }
  return resolved;
}

function childPath(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw unsupported('MARKETPLACE_SOURCE_PATH', 'The marketplace store contains an escaped path.');
  }
  return target;
}

function parseJson(text) {
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) throw malformed();
  const walk = (node, depth) => {
    if (depth > MAX_DEPTH) throw unsupported('MARKETPLACE_SOURCE_DEPTH', 'The marketplace source is nested too deeply.');
    if (!node) return;
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key === 'string') {
          if (keys.has(key)) throw unsupported('MARKETPLACE_SOURCE_DUPLICATE', 'The marketplace source repeats a JSON key.');
          keys.add(key);
        }
        walk(property.children?.[1], depth + 1);
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) walk(child, depth + 1);
    }
  };
  walk(tree, 1);
  try {
    return JSON.parse(text);
  } catch {
    throw malformed();
  }
}

function readRegularFile(file, maxBytes, { missing = 'unavailable' } = {}) {
  assertNoSymlinkComponents(file, { missing });
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW ?? 0)
      | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      if (missing === 'unsupported') throw unsupported('MARKETPLACE_SOURCE_MISSING', 'A marketplace bundle file was not found.');
      throw unavailable('MARKETPLACE_SOURCE_MISSING', 'The configured marketplace source was not found.');
    }
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR') {
      throw unsupported('MARKETPLACE_SOURCE_NOT_REGULAR', 'The marketplace source must be a regular file.');
    }
    throw unavailable('MARKETPLACE_SOURCE_UNREADABLE', 'The configured marketplace source could not be read.');
  }
  try {
    const first = fs.fstatSync(descriptor);
    if (!first.isFile()) throw unsupported('MARKETPLACE_SOURCE_NOT_REGULAR', 'The marketplace source must be a regular file.');
    if (first.size > maxBytes) throw tooLarge();
    const buffer = Buffer.allocUnsafe(first.size);
    let offset = 0;
    while (offset < first.size) {
      const bytes = fs.readSync(descriptor, buffer, offset, first.size - offset, offset);
      if (bytes <= 0) break;
      offset += bytes;
    }
    const second = fs.fstatSync(descriptor);
    if (!second.isFile() || second.size !== first.size || offset !== first.size
      || second.mtimeMs !== first.mtimeMs || second.ctimeMs !== first.ctimeMs
      || second.dev !== first.dev || second.ino !== first.ino) throw changed();
    let current;
    try { current = fs.lstatSync(file); } catch { throw changed(); }
    if (!current.isFile() || current.dev !== second.dev || current.ino !== second.ino) throw changed();
    return {
      text: buffer.subarray(0, offset).toString('utf8'),
      bytes: offset,
      identity: { dev: second.dev, ino: second.ino, size: second.size, mtimeMs: second.mtimeMs, ctimeMs: second.ctimeMs },
    };
  } finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
  }
}

function identityUnchanged(file, identity) {
  let stats;
  try { stats = fs.lstatSync(file); } catch { return false; }
  return stats.isFile()
    && stats.dev === identity.dev && stats.ino === identity.ino
    && stats.size === identity.size && stats.mtimeMs === identity.mtimeMs
    && stats.ctimeMs === identity.ctimeMs;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodePrimitive(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Canonical JSON cannot encode this value.');
  return encoded;
}

function canonicalize(value, ancestors, depth) {
  if (depth > MAX_DEPTH) throw new TypeError('Canonical JSON is nested too deeply.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return encodePrimitive(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.');
    return encodePrimitive(value);
  }
  if (typeof value !== 'object') throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not support circular references.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) {
        throw new TypeError('Canonical JSON does not support symbol keys.');
      }
      const elements = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
          throw new TypeError('Canonical JSON arrays cannot contain holes or undefined.');
        }
        elements.push(canonicalize(descriptor.value, ancestors, depth + 1));
      }
      const allowed = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (Reflect.ownKeys(value).some(key => !allowed.has(String(key)))) {
        throw new TypeError('Canonical JSON arrays cannot have extra properties.');
      }
      return `[${elements.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON only supports plain objects.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('Canonical JSON does not support symbol keys.');
    const entries = keys.flatMap(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('Canonical JSON does not support accessors.');
      }
      return descriptor.value === undefined ? [] : [[key, descriptor.value]];
    });
    entries.sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry, ancestors, depth + 1)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeMarketplaceValue(value) {
  return canonicalize(value, new Set(), 0);
}

export function digestMarketplaceBundle(bundle) {
  return createHash('sha256').update(canonicalizeMarketplaceValue(bundle), 'utf8').digest('hex');
}

function boundedText(value, max) {
  return typeof value === 'string' && value.trim().length > 0
    && value.trim().length <= max && !CONTROL_RE.test(value);
}

function validateSource(source) {
  if (!isObject(source) || typeof source.kind !== 'string' || !Object.hasOwn(SOURCE_KEYS, source.kind)) {
    throw unsupported('MARKETPLACE_SOURCE_SOURCE', 'The marketplace source metadata is not supported.');
  }
  if (!exactKeys(source, SOURCE_KEYS[source.kind])) {
    throw unsupported('MARKETPLACE_SOURCE_SOURCE', 'The marketplace source metadata is not supported.');
  }
  if (source.kind === 'local') {
    if (!boundedText(source.path, MAX_ROOT_PATH) || !path.isAbsolute(source.path) || CONTROL_RE.test(source.path)) {
      throw unsupported('MARKETPLACE_SOURCE_SOURCE', 'The marketplace source metadata is not supported.');
    }
  } else if (source.kind === 'registry') {
    if (!boundedText(source.registry, 200)
      || typeof source.indexUrl !== 'string' || typeof source.packageUrl !== 'string') {
      throw unsupported('MARKETPLACE_SOURCE_SOURCE', 'The marketplace source metadata is not supported.');
    }
    for (const url of [source.indexUrl, source.packageUrl]) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      } catch {
        throw unsupported('MARKETPLACE_SOURCE_SOURCE', 'The marketplace source metadata is not supported.');
      }
    }
  } else if (!boundedText(source.label, 120)) {
    throw unsupported('MARKETPLACE_SOURCE_SOURCE', 'The marketplace source metadata is not supported.');
  }
  return source;
}

function validateDigest(digest, expectedDomain) {
  if (!exactKeys(digest, DIGEST_KEYS) || digest.algorithm !== 'sha256'
    || digest.domain !== expectedDomain || typeof digest.value !== 'string' || !HEX_RE.test(digest.value)) {
    throw unsupported('MARKETPLACE_SOURCE_INTEGRITY', 'The marketplace package integrity metadata is not supported.');
  }
  return digest;
}

function validateModel(model, { hasExtends }) {
  if (!isObject(model) || typeof model.source !== 'string' || !MODEL_SOURCES.has(model.source)) {
    throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
  }
  if (model.source === 'explicit') {
    if (!exactKeys(model, ['source', 'candidates']) || !Array.isArray(model.candidates)
      || model.candidates.length < 1 || model.candidates.length > 16) {
      throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
    }
    for (const candidate of model.candidates) {
      if (typeof candidate === 'string') {
        if (!boundedText(candidate, 200)) throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
        continue;
      }
      if (!exactKeys(candidate, ['id', 'variant']) && !exactKeys(candidate, ['id'])) {
        throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
      }
      if (!boundedText(candidate.id, 200)
        || (candidate.variant !== undefined && !boundedText(candidate.variant, 100))) {
        throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
      }
    }
  } else if (!exactKeys(model, ['source'])) {
    throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
  }
  if (model.source === 'builtin' && !hasExtends) {
    throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package model source is not supported.');
  }
  return model.source;
}

function validateExtends(extendsValue, schemaVersion) {
  if (!isObject(extendsValue) || !exactKeys(extendsValue, ['builtin', 'promptMode'])
    || typeof extendsValue.builtin !== 'string' || !EXTENDABLE_BUILTINS.has(extendsValue.builtin)
    || !['append', 'replace'].includes(extendsValue.promptMode)
    || (schemaVersion === 3 && extendsValue.promptMode !== 'append')) {
    throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package extension metadata is not supported.');
  }
  return extendsValue;
}

function validateManifest(manifest, entry, id) {
  if (!isObject(manifest) || !Number.isInteger(manifest.schemaVersion)
    || ![2, 3].includes(manifest.schemaVersion) || manifest.schemaVersion !== entry.manifestSchemaVersion) {
    throw unsupported('MARKETPLACE_SOURCE_SCHEMA_UNSUPPORTED', 'The marketplace package schema is not supported.');
  }
  const expectedDomain = manifest.schemaVersion === 3 ? 'marketplace-agent-bundle-v3' : 'marketplace-agent-bundle-v2';
  validateDigest(entry.digest, expectedDomain);
  if (typeof manifest.id !== 'string' || !PACKAGE_ID_RE.test(manifest.id) || manifest.id !== id) {
    throw unsupported('MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED', 'The marketplace package identity is not supported.');
  }
  if (typeof manifest.version !== 'string' || manifest.version.length > 128
    || !VERSION_RE.test(manifest.version) || manifest.version !== entry.manifestVersion) {
    throw unsupported('MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED', 'The marketplace package identity is not supported.');
  }
  if (typeof manifest.agentName !== 'string' || !AGENT_NAME_RE.test(manifest.agentName)
    || RESERVED.has(manifest.agentName) || RESERVED_AGENT_NAMES.has(manifest.agentName)) {
    throw unsupported('MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED', 'The marketplace package identity is not supported.');
  }
  if (!boundedText(manifest.displayName, 120)) {
    throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace package display name is not supported.');
  }
  const hasExtends = manifest.extends !== undefined;
  if (hasExtends) validateExtends(manifest.extends, manifest.schemaVersion);
  const modelSource = validateModel(manifest.model, { hasExtends });
  return {
    id,
    version: manifest.version,
    agentName: manifest.agentName,
    displayName: manifest.displayName.trim(),
    modelSource,
    digest: entry.digest.value,
    blockedReason: hasExtends ? 'Extends a builtin agent; selection is blocked in this release.' : null,
  };
}

function pidIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code === 'EPERM') return false;
    throw unavailable('MARKETPLACE_SOURCE_LEASE_INSPECTION', 'The marketplace store lease could not be inspected safely.');
  }
}

// The OMOS release path unlinks only the inner lease entry; marketplace.lock is
// a permanent directory. An absent or empty real directory is therefore ready.
// We never unlink, repair or wait on entries: stale entries stay untouched.
function scanLeaseEntries(root, nowMs) {
  const containerPath = childPath(root, 'marketplace.lock');
  let container;
  try {
    container = fs.lstatSync(containerPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { present: false, path: containerPath, identity: null, entries: [] };
    }
    throw unavailable('MARKETPLACE_SOURCE_UNREADABLE', 'The marketplace store lease could not be checked.');
  }
  if (container.isSymbolicLink() || !container.isDirectory()) {
    throw unsupported('MARKETPLACE_SOURCE_LEASE_INVALID', 'The marketplace store lease container is not a real directory.');
  }
  const identity = { dev: container.dev, ino: container.ino, mtimeMs: container.mtimeMs, ctimeMs: container.ctimeMs };
  const names = [];
  let dir;
  try {
    dir = fs.opendirSync(containerPath);
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > MAX_LEASE_ENTRIES) {
        throw unsupported('MARKETPLACE_SOURCE_LEASE_COUNT', 'The marketplace store lease directory has too many entries.');
      }
    }
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw unavailable('MARKETPLACE_SOURCE_UNREADABLE', 'The marketplace store lease could not be checked.');
  } finally {
    try { dir?.closeSync(); } catch { /* already closed */ }
  }
  const entries = [];
  for (const name of names.sort(compareCodeUnits)) {
    const match = LEASE_ENTRY_RE.exec(name);
    if (!match) throw unsupported('MARKETPLACE_SOURCE_LEASE_INVALID', 'The marketplace store lease contains a malformed entry.');
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) {
      throw unsupported('MARKETPLACE_SOURCE_LEASE_INVALID', 'The marketplace store lease contains a malformed entry.');
    }
    const entryPath = childPath(containerPath, name);
    let stats;
    try { stats = fs.lstatSync(entryPath); } catch (error) {
      if (error?.code === 'ENOENT') throw changed();
      throw unavailable('MARKETPLACE_SOURCE_UNREADABLE', 'The marketplace store lease could not be checked.');
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== 0) {
      throw unsupported('MARKETPLACE_SOURCE_LEASE_INVALID', 'The marketplace store lease contains an unsupported entry.');
    }
    const stale = nowMs - stats.mtimeMs > LEASE_STALE_MS;
    const active = match[3] === 'candidate'
      ? !stale
      : (!stale || !pidIsDead(pid));
    if (active) throw leased();
    entries.push({ name, dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs });
  }
  let after;
  try { after = fs.lstatSync(containerPath); } catch { throw changed(); }
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== identity.dev || after.ino !== identity.ino
    || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs) throw changed();
  return { present: true, path: containerPath, identity, entries };
}

function leaseIdentity(scan) {
  return JSON.stringify({
    present: scan.present,
    identity: scan.identity,
    entries: scan.entries.map(entry => [entry.name, entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs]),
  });
}

function readLock(root) {
  const lockPath = childPath(root, 'lock.json');
  const lockFile = readRegularFile(lockPath, MAX_LOCK_BYTES);
  const lock = parseJson(lockFile.text);
  if (!exactKeys(lock, LOCK_KEYS) || lock.schemaVersion !== 2 || !isObject(lock.packages)) {
    throw unsupported('MARKETPLACE_SOURCE_SCHEMA_UNSUPPORTED', 'The marketplace lock schema is not supported.');
  }
  const ids = Object.keys(lock.packages);
  if (ids.length > MAX_PACKAGES) throw unsupported('MARKETPLACE_SOURCE_TOO_MANY', 'The marketplace store contains too many packages.');
  for (const id of ids) {
    if (!PACKAGE_ID_RE.test(id) || RESERVED.has(id.split('/')[0]) || RESERVED.has(id.split('/')[1])) {
      throw unsupported('MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED', 'The marketplace lock contains an unsupported package identity.');
    }
  }
  ids.sort(compareCodeUnits);
  return { lock, ids, lockFile, lockPath };
}

// Reads a fresh snapshot on every call. The lock and every bundle/sidecar are
// opened without following symlinks and their identities are rechecked before
// publishing. This is not a perfect cross-file CAS against an independent
// writer that swaps files between the final recheck and the caller's use.
export function readMarketplaceSnapshot({ rootPath, generation, now = Date.now } = {}) {
  const readAt = (() => {
    const value = now();
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  })();
  if (!rootPath) {
    return {
      state: 'not-configured', generation,
      error: { code: 'MARKETPLACE_SOURCE_NOT_CONFIGURED', message: 'No marketplace source is configured.' },
    };
  }
  let root;
  try {
    if (!validRootPath(rootPath)) {
      return {
        state: 'unsupported', generation,
        error: { code: 'MARKETPLACE_SOURCE_INVALID', message: 'The configured marketplace source path is not supported.' },
      };
    }
    root = assertNoSymlinkComponents(rootPath);
    let rootStats;
    try { rootStats = fs.lstatSync(root); } catch { throw unavailable('MARKETPLACE_SOURCE_MISSING', 'The configured marketplace source was not found.'); }
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw unsupported('MARKETPLACE_SOURCE_NOT_REGULAR', 'The configured marketplace source must be a real directory.');
    const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
    const leaseBefore = scanLeaseEntries(root, readAt);
    const { lock, ids, lockFile, lockPath } = readLock(root);
    const consumedPaths = [root, lockPath];
    if (leaseBefore.present) consumedPaths.push(leaseBefore.path);
    const packages = [];
    const identities = [];
    const agentNames = new Set();
    let aggregate = lockFile.bytes;
    for (const id of ids) {
      const entry = lock.packages[id];
      if (!exactKeys(entry, ENTRY_KEYS)
        || ![2, 3].includes(entry.manifestSchemaVersion)
        || typeof entry.manifestVersion !== 'string' || entry.manifestVersion.length > 128
        || !VERSION_RE.test(entry.manifestVersion)) {
        throw unsupported('MARKETPLACE_SOURCE_SCHEMA_UNSUPPORTED', 'The marketplace lock contains an unsupported package entry.');
      }
      validateSource(entry.source);
      const expectedDomain = entry.manifestSchemaVersion === 3 ? 'marketplace-agent-bundle-v3' : 'marketplace-agent-bundle-v2';
      validateDigest(entry.digest, expectedDomain);
      const [publisher, name] = id.split('/');
      const versionDir = childPath(root, 'packages', publisher, name, entry.manifestVersion);
      const bundlePath = childPath(versionDir, 'package.json');
      const sidecarPath = childPath(versionDir, 'sha256');
      consumedPaths.push(versionDir, bundlePath, sidecarPath);
      const remainingForBundle = MAX_AGGREGATE_BYTES - aggregate;
      if (remainingForBundle <= 0) throw tooLarge();
      const bundleFile = readRegularFile(bundlePath, Math.min(MAX_BUNDLE_BYTES, remainingForBundle), { missing: 'unsupported' });
      aggregate += bundleFile.bytes;
      const remainingForSidecar = MAX_AGGREGATE_BYTES - aggregate;
      if (remainingForSidecar <= 0) throw tooLarge();
      const sidecarFile = readRegularFile(sidecarPath, Math.min(MAX_SIDECAR_BYTES, remainingForSidecar), { missing: 'unsupported' });
      aggregate += sidecarFile.bytes;
      const bundle = parseJson(bundleFile.text);
      if (!exactKeys(bundle, ['manifest'])) {
        throw unsupported('MARKETPLACE_SOURCE_MANIFEST', 'The marketplace bundle wrapper is not supported.');
      }
      const manifest = bundle.manifest;
      const projection = validateManifest(manifest, entry, id);
      const digest = digestMarketplaceBundle(bundle);
      const sidecar = sidecarFile.text.trim();
      if (sidecar.length > MAX_SIDECAR_BYTES || !HEX_RE.test(sidecar)
        || sidecar !== digest || entry.digest.value !== digest
        || entry.digest.algorithm !== 'sha256' || entry.digest.domain !== expectedDomain) {
        throw unsupported('MARKETPLACE_SOURCE_INTEGRITY', 'A marketplace package failed its integrity check.');
      }
      if (agentNames.has(projection.agentName)) {
        throw unsupported('MARKETPLACE_SOURCE_IDENTITY_UNSUPPORTED', 'The marketplace store contains a duplicate agent identity.');
      }
      agentNames.add(projection.agentName);
      packages.push(projection);
      identities.push({ path: bundlePath, identity: bundleFile.identity }, { path: sidecarPath, identity: sidecarFile.identity });
    }
    // Recheck the root, every consumed path component and the lease container
    // before publishing. A parent retargeted to a symlink is rejected even when
    // the leaf inode is unchanged.
    let finalRoot;
    try { finalRoot = fs.lstatSync(root); } catch { throw changed(); }
    if (finalRoot.isSymbolicLink() || !finalRoot.isDirectory()
      || finalRoot.dev !== rootIdentity.dev || finalRoot.ino !== rootIdentity.ino) throw changed();
    for (const consumed of consumedPaths) {
      try { assertNoSymlinkComponents(consumed); } catch (error) {
        if (error instanceof SnapshotError) throw changed();
        throw error;
      }
    }
    const leaseAfter = scanLeaseEntries(root, readAt);
    if (leaseIdentity(leaseBefore) !== leaseIdentity(leaseAfter)) throw changed();
    if (!identityUnchanged(lockPath, lockFile.identity)
      || identities.some(item => !identityUnchanged(item.path, item.identity))) throw changed();
    packages.sort((left, right) => compareCodeUnits(left.id, right.id));
    const fingerprint = createHash('sha256').update(JSON.stringify({
      adapterVersion: ADAPTER_VERSION,
      packages: packages.map(item => ({
        id: item.id, version: item.version, agentName: item.agentName,
        displayName: item.displayName, modelSource: item.modelSource,
        digest: item.digest, blockedReason: item.blockedReason,
      })),
    }), 'utf8').digest('hex');
    return {
      state: 'ready', adapterVersion: ADAPTER_VERSION, generation,
      fingerprint, readAt, packages,
    };
  } catch (error) {
    if (error instanceof SnapshotError) {
      return { state: error.state, generation, error: { code: error.code, message: error.message } };
    }
    if (error instanceof ServiceError) throw error;
    return {
      state: 'unavailable', generation,
      error: { code: 'MARKETPLACE_SOURCE_UNAVAILABLE', message: 'The configured marketplace source could not be read.' },
    };
  }
}

export function createMarketplaceSourceStore({ dataDir, now = Date.now } = {}) {
  const file = path.join(dataDir, 'marketplace-source.json');
  let cached = null;
  function load() {
    if (cached) return cached;
    let record;
    try {
      record = readJsonStore(file, null);
    } catch {
      throw corruptSettings();
    }
    if (record === null) {
      cached = { rootPath: '', generation: randomUUID() };
      return cached;
    }
    if (!isObject(record) || record.version !== 1 || !validRootPath(record.rootPath)
      || typeof record.generation !== 'string' || !record.generation.length || record.generation.length > 200) {
      throw corruptSettings();
    }
    cached = { rootPath: record.rootPath, generation: record.generation };
    return cached;
  }
  return {
    get() {
      const state = load();
      return { rootPath: state.rootPath, generation: state.generation };
    },
    update(rootPath) {
      if (!validRootPath(rootPath)) throw invalidRootPath();
      const generation = randomUUID();
      try {
        writeJsonStore(file, { version: 1, rootPath, generation });
      } catch {
        throw notSaved();
      }
      cached = { rootPath, generation };
      return { rootPath, generation };
    },
    snapshot() {
      const state = load();
      return readMarketplaceSnapshot({ rootPath: state.rootPath, generation: state.generation, now });
    },
  };
}
