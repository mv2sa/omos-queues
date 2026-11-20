// Host-managed loopback service. Every route is bearer-authenticated, JSON-only
// and no-store; handlers stay short and never wait on the model CLI.
import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createSettingsStore } from './settings.js';
import { ensurePrivateDir } from './store.js';
import {
  MAX_CHANGED_PATHS,
  createTargetResolver,
  hashText,
  prepareConfigEdit,
  readConfigDocument,
} from './config.js';
import { renderModelValueDiffs } from './diff.js';
import { createPreviewCache } from './previews.js';
import { commitConfig } from './commit.js';
import { createCatalog } from './catalog.js';
import { createDraftStore } from './drafts.js';
import { createFavoritesSourceStore } from './favorites-source.js';
import { createMarketplaceSourceStore } from './marketplace-source.js';
import { describeMarketplaceConfig } from './marketplace-config.js';
import { describePrimarySlots } from './primary-slots.js';
import { ServiceError, badRequest, notFound, toPublicError, unauthorized } from './errors.js';

export const VERSION = '0.3.1';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 8_000_000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function scopeKey(settings, generation) {
  return createHash('sha256')
    .update(JSON.stringify([generation, settings.opencodeBin, settings.modelCwd, settings.opencodeConfigDir]))
    .digest('hex');
}

function targetView(target, generation) {
  return { path: target.path, logicalPath: target.logicalPath, generation };
}

function authorized(header, token) {
  if (!token || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function sendJson(response, status, body) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_RESPONSE_BYTES) {
    const fallback = JSON.stringify({
      error: { code: 'RESPONSE_TOO_LARGE', message: 'The response exceeds the 8 MB service limit.' },
    });
    response.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(fallback);
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function readJsonBody(request) {
  const type = request.headers['content-type'];
  if (typeof type !== 'string' || !/^application\/json\b/i.test(type)) {
    throw new ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        settled = true;
        reject(new ServiceError(413, 'BODY_TOO_LARGE', 'The request body is larger than 256 KiB.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(badRequest('The request body is not valid JSON.', 'BAD_JSON'));
        return;
      }
      if (!isObject(body)) {
        reject(badRequest('The request body must be a JSON object.', 'BAD_JSON'));
        return;
      }
      resolve(body);
    });
    request.on('error', () => {
      if (settled) return;
      settled = true;
      reject(badRequest('The request body could not be read.', 'BAD_JSON'));
    });
  });
}

function requireKeys(body, allowed) {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) {
    throw badRequest(`Unknown fields: ${unknown.slice(0, 5).join(', ')}.`, 'UNKNOWN_FIELD');
  }
}

function requireNoQuery(url, label = 'This endpoint') {
  if ([...url.searchParams.keys()].length) {
    throw badRequest(`${label} does not accept query fields.`, 'INVALID_QUERY');
  }
}

function requireString(body, key) {
  if (typeof body[key] !== 'string' || !body[key].length) {
    throw badRequest(`${key} must be a non-empty string.`, 'INVALID_REQUEST');
  }
  return body[key];
}

export function createServiceServer({
  env = process.env,
  now = Date.now,
  commitHooks,
  execFileImpl,
  createMarketplaceSourceStoreImpl = createMarketplaceSourceStore,
  describeMarketplaceConfigImpl = describeMarketplaceConfig,
  describePrimarySlotsImpl = describePrimarySlots,
  logger = message => { console.error(message); },
} = {}) {
  // Fail closed on a missing or unsafe data directory; never fall back to a
  // shared temp path. The host always supplies an absolute per-extension folder.
  const dataDir = env.OPENCHAMBER_SERVICE_DATA_DIR;
  if (typeof dataDir !== 'string' || !dataDir || !path.isAbsolute(dataDir)) {
    throw new Error('OPENCHAMBER_SERVICE_DATA_DIR must be an absolute path.');
  }
  ensurePrivateDir(dataDir);
  const token = typeof env.OPENCHAMBER_SERVICE_TOKEN === 'string' ? env.OPENCHAMBER_SERVICE_TOKEN : '';

  const settingsStore = createSettingsStore({ dataDir, env });
  const targetResolver = createTargetResolver();
  const previews = createPreviewCache({ now });
  const catalog = createCatalog({ dataDir, env, now, execFileImpl, logger });
  const drafts = createDraftStore({ dataDir, now });
  const favoritesSource = createFavoritesSourceStore({ dataDir, now });
  let marketplaceSource = null;

  // The source store is constructed lazily: health, core settings and ordinary
  // editing must not touch marketplace source files or a source adapter.
  function marketplaceStore() {
    if (!marketplaceSource) {
      marketplaceSource = createMarketplaceSourceStoreImpl({ dataDir, now });
    }
    return marketplaceSource;
  }


  function current() {
    const state = settingsStore.get();
    const scope = scopeKey(state.settings, state.generation);
    return { state, scope };
  }

  // A regular config snapshot only reads config and the primary-slot projection.
  function configSnapshot() {
    const { state } = current();
    const target = targetResolver.resolve(state.settings, state.generation);
    const document = readConfigDocument(target);
    return {
      target: targetView(target, state.generation),
      baseHash: document.baseHash,
      groups: document.groups,
      primarySlots: describePrimarySlotsImpl({ config: document.config, groups: document.groups }),
    };
  }

  function marketplaceUnavailable() {
    return new ServiceError(409, 'MARKETPLACE_SOURCE_UNAVAILABLE',
      'The marketplace source is unavailable. Nothing was written.');
  }

  function validateMarketplacePreview(preview) {
    const binding = preview?.marketplaceBinding;
    if (!binding) return;
    let snapshot;
    try {
      snapshot = marketplaceStore().snapshot();
    } catch {
      throw marketplaceUnavailable();
    }
    if (!snapshot || snapshot.state !== 'ready') throw marketplaceUnavailable();
    if (snapshot.generation !== binding.sourceGeneration) {
      throw new ServiceError(409, 'MARKETPLACE_SOURCE_CHANGED',
        'The marketplace source generation changed. Nothing was written.');
    }
    if (snapshot.fingerprint !== binding.catalogFingerprint) {
      throw new ServiceError(409, 'MARKETPLACE_CATALOG_CHANGED',
        'The installed marketplace catalog changed. Nothing was written.');
    }
  }

  async function route(request, response) {
    if (request.headers.origin !== undefined) {
      throw new ServiceError(403, 'ORIGIN_REJECTED', 'Requests that carry a browser Origin are not accepted.');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ServiceError(403, 'CROSS_SITE_REJECTED', 'Cross-site requests are not accepted.');
    }
    if (!authorized(request.headers.authorization, token)) throw unauthorized();

    let url;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      throw badRequest('Invalid request URL.', 'BAD_PATH');
    }
    const method = request.method ?? 'GET';
    const routePath = url.pathname;

    if (routePath === '/health') {
      if (method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      sendJson(response, 200, { ok: true, version: VERSION });
      return;
    }

    if (routePath === '/settings') {
      if (method === 'GET') {
        const { state } = current();
        sendJson(response, 200, { settings: state.settings, generation: state.generation });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        const saved = settingsStore.update(body);
        // A commit is synchronous, so settings cannot interleave with it. A new
        // generation invalidates the pinned target, previews and catalog state.
        targetResolver.reset();
        previews.clear();
        catalog.setScope(scopeKey(saved.settings, saved.generation));
        sendJson(response, 200, { settings: saved.settings, generation: saved.generation });
        return;
      }
      throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    }

    if (routePath === '/marketplace/source') {
      requireNoQuery(url, 'The marketplace source endpoint');
      if (method === 'GET') {
        sendJson(response, 200, marketplaceStore().get());
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        requireKeys(body, ['rootPath']);
        sendJson(response, 200, marketplaceStore().update(body.rootPath));
        return;
      }
      throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    }

    if (routePath === '/marketplace/snapshot') {
      if (method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      requireNoQuery(url, 'The marketplace snapshot endpoint');
      sendJson(response, 200, marketplaceStore().snapshot());
      return;
    }

    if (routePath === '/marketplace/config') {
      if (method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      requireNoQuery(url, 'The marketplace config endpoint');
      const { state } = current();
      const target = targetResolver.resolve(state.settings, state.generation);
      const document = readConfigDocument(target);
      const catalog = marketplaceStore().snapshot();
      const projection = describeMarketplaceConfigImpl({
        text: document.text,
        groups: document.groups,
        catalog,
      });
      sendJson(response, 200, {
        target: targetView(target, state.generation),
        baseHash: document.baseHash,
        catalog,
        ...projection,
      });
      return;
    }

    if (routePath === '/config') {
      if (method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      sendJson(response, 200, configSnapshot());
      return;
    }

    if (routePath === '/preview') {
      if (method !== 'POST') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      const body = await readJsonBody(request);
      requireKeys(body, ['baseHash', 'generation', 'changes', 'marketplace', 'primaryCreations']);
      const { state } = current();
      const generation = requireString(body, 'generation');
      if (generation !== state.generation) {
        throw new ServiceError(409, 'TARGET_CHANGED',
          'The config target or settings changed. Reload before previewing.');
      }
      const baseHash = requireString(body, 'baseHash');
      if (!Array.isArray(body.changes)) throw badRequest('Expected a changes array.', 'INVALID_REQUEST');
      if (body.changes.length > MAX_CHANGED_PATHS) {
        throw badRequest(`At most ${MAX_CHANGED_PATHS} queues can be edited at once.`, 'TOO_MANY_CHANGES');
      }
      const target = targetResolver.resolve(state.settings, state.generation);
      const document = readConfigDocument(target);
      if (document.baseHash !== baseHash) {
        throw new ServiceError(409, 'BASE_HASH_MISMATCH',
          'The config changed on disk. Reload it and review your edits again.');
      }
      const hasMarketplace = Object.hasOwn(body, 'marketplace');
      const hasPrimaryCreations = Object.hasOwn(body, 'primaryCreations');
      const prepared = prepareConfigEdit({
        text: document.text,
        groups: document.groups,
        changes: body.changes,
        ...(hasMarketplace ? {
          marketplace: body.marketplace,
          marketplaceCatalog: marketplaceStore().snapshot(),
        } : {}),
        ...(hasPrimaryCreations ? { primaryCreations: body.primaryCreations } : {}),
      });
      const marketplaceBinding = hasMarketplace ? (prepared.marketplaceBinding ?? null) : undefined;
      const afterHash = hashText(prepared.after);
      if (!prepared.changed.length) {
        sendJson(response, 200, {
          target: targetView(target, state.generation),
          baseHash: document.baseHash,
          afterHash,
          diff: '',
          changed: [],
          previewToken: null,
          expiresAt: null,
          ...(hasMarketplace ? { marketplaceBinding } : {}),
        });
        return;
      }
      const diff = renderModelValueDiffs({
        fileName: path.basename(target.path),
        blocks: prepared.changedValues,
      });
      const preview = previews.add({
        target: Object.freeze(targetView(target, state.generation)),
        generation: state.generation,
        baseHash: document.baseHash,
        afterHash,
        after: prepared.after,
        changed: Object.freeze([...prepared.changed]),
        ...(hasMarketplace ? {
          marketplaceBinding,
          marketplaceCreations: prepared.marketplaceCreations,
        } : {}),
      });
      sendJson(response, 200, {
        target: preview.target,
        baseHash: preview.baseHash,
        afterHash: preview.afterHash,
        diff,
        changed: [...preview.changed],
        previewToken: preview.token,
        expiresAt: preview.expiresAt,
        ...(hasMarketplace ? { marketplaceBinding } : {}),
      });
      return;
    }

    if (routePath === '/commit') {
      if (method !== 'POST') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      const body = await readJsonBody(request);
      requireKeys(body, ['previewToken']);
      const tokenValue = requireString(body, 'previewToken');
      const { state } = current();
      const preview = previews.get(tokenValue);
      if (!preview) {
        throw new ServiceError(409, 'PREVIEW_INVALID',
          'That preview is missing, expired or already used. Preview the diff again.');
      }
      if (preview.generation !== state.generation) {
        previews.delete(tokenValue);
        throw new ServiceError(409, 'TARGET_CHANGED',
          'The config target or settings changed. Nothing was written.');
      }
      let target;
      try {
        target = targetResolver.resolve(state.settings, state.generation);
      } catch (error) {
        previews.delete(tokenValue);
        throw error;
      }
      if (target.path !== preview.target.path) {
        previews.delete(tokenValue);
        throw new ServiceError(409, 'TARGET_CHANGED',
          'The config target changed. Nothing was written.');
      }
      const document = readConfigDocument(target);
      if (document.baseHash !== preview.baseHash) {
        previews.delete(tokenValue);
        throw new ServiceError(409, 'BASE_HASH_MISMATCH',
          'The config changed after preview. Nothing was written; reload and preview again.');
      }
      // Consuming the token before the replacement guarantees at most one
      // backup/replacement per token, even when the caller never sees the answer.
      previews.take(tokenValue);
      const suppliedValidate = typeof commitHooks?.validatePreview === 'function'
        ? commitHooks.validatePreview
        : null;
      const hooks = {
        ...(commitHooks ?? {}),
        validatePreview(previewRecord) {
          if (suppliedValidate) suppliedValidate(previewRecord);
          validateMarketplacePreview(previewRecord);
        },
      };
      const { backup } = commitConfig({
        targetPath: target.path,
        before: document.text,
        after: preview.after,
        hooks,
        preview,
      });
      sendJson(response, 200, {
        ok: true,
        target: targetView(target, state.generation),
        baseHash: preview.afterHash,
        backup,
        changed: [...preview.changed],
      });
      return;
    }

    if (routePath === '/reconcile') {
      if (method !== 'POST') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      const body = await readJsonBody(request);
      requireKeys(body, ['previewToken', 'generation']);
      if (body.previewToken !== null && body.previewToken !== undefined
        && typeof body.previewToken !== 'string') {
        throw badRequest('previewToken must be a string or null.', 'INVALID_REQUEST');
      }
      // Revoke before generation, target resolution or a config read can throw:
      // a temporarily missing file must not leave the old token alive.
      if (typeof body.previewToken === 'string') previews.delete(body.previewToken);
      const generation = requireString(body, 'generation');
      const { state } = current();
      if (generation !== state.generation) {
        throw new ServiceError(409, 'TARGET_CHANGED',
          'The config target or settings changed. Reload before reconciling.');
      }
      const target = targetResolver.resolve(state.settings, state.generation);
      const document = readConfigDocument(target);
      sendJson(response, 200, {
        target: targetView(target, state.generation),
        baseHash: document.baseHash,
        groups: document.groups,
        primarySlots: describePrimarySlotsImpl({ config: document.config, groups: document.groups }),
      });
      return;
    }

    if (routePath === '/models') {
      if (method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      const { state, scope } = current();
      sendJson(response, 200, catalog.status(state.settings, scope));
      return;
    }

    if (routePath === '/models/refresh') {
      if (method !== 'POST') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      const body = await readJsonBody(request);
      requireKeys(body, []);
      const { state, scope } = current();
      sendJson(response, 200, catalog.refresh(state.settings, scope));
      return;
    }

    if (routePath === '/favorites/source') {
      if (method === 'GET') {
        sendJson(response, 200, favoritesSource.get());
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        requireKeys(body, ['filePath']);
        sendJson(response, 200, favoritesSource.update(body.filePath));
        return;
      }
      throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    }

    if (routePath === '/favorites/snapshot') {
      if (method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      sendJson(response, 200, favoritesSource.snapshot());
      return;
    }

    if (routePath === '/drafts') {
      if (method === 'GET') {
        sendJson(response, 200, drafts.list());
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        const { state } = current();
        const target = targetResolver.resolve(state.settings, state.generation);
        sendJson(response, 200, drafts.save(body, { targetPath: target.path }));
        return;
      }
      throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    }

    if (routePath.startsWith('/drafts/')) {
      if (method !== 'DELETE') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use DELETE.');
      let id;
      try {
        id = decodeURIComponent(routePath.slice('/drafts/'.length));
      } catch {
        throw badRequest('Invalid draft id.', 'INVALID_REQUEST');
      }
      sendJson(response, 200, drafts.remove(id));
      return;
    }

    throw notFound();
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch(error => {
      const publicError = toPublicError(error);
      if (!(error instanceof ServiceError)) {
        logger(`Service error ${publicError.code}: ${error?.stack ?? error}`);
      }
      sendJson(response, publicError.status, {
        error: { code: publicError.code, message: publicError.message },
      });
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  let closePromise;

  return {
    server,
    close() {
      if (closePromise) return closePromise;

      const start = operation => {
        try {
          return Promise.resolve(operation());
        } catch (error) {
          return Promise.reject(error);
        }
      };
      const starts = [];
      starts.push(start(() => catalog.shutdown()));
      starts.push(new Promise((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections?.(), 1000);
        server.close(error => {
          clearTimeout(timer);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
      }));
      closePromise = Promise.allSettled(starts).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
      return closePromise;
    },
  };
}

function parsePort(value) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

export async function startService({ env = process.env } = {}) {
  const port = parsePort(env.OPENCHAMBER_SERVICE_PORT);
  const token = env.OPENCHAMBER_SERVICE_TOKEN;
  if (port === null || typeof token !== 'string' || !token) {
    throw new Error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required.');
  }
  const service = createServiceServer({ env });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(port, '127.0.0.1', resolve);
  });
  const stop = () => {
    service.close().then(() => { process.exit(0); }, () => { process.exit(1); });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return service;
}
