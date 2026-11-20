// Marketplace service composition tests. Synthetic source factory and synthetic
// config only; no real OMOS store, selected file mutation, native process or
// provider is used here. Parent runs this after all backend modules settle.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ServiceError } from '../../src/backend/errors.js';
import { normalizeMarketplaceConfig } from '../../src/page/marketplace.js';
import {
  call,
  configSnapshot,
  makeEnv,
  makeRoot,
  settingsFor,
  startService,
  writeFile,
} from './helpers.mjs';

const MARKET_CONFIG = `{
  "marketplace": { "enabled": true },
  "preset": "coding",
  "presets": {
    "coding": {
      "agents": {
        "worker": { "model": "openai/gpt-5" }
      }
    }
  }
}
`;

const PACKAGE = {
  id: 'acme/janitor',
  version: '1.0.0',
  agentName: 'janitor',
  displayName: 'Janitor',
  modelSource: 'session',
  digest: 'a'.repeat(64),
  blockedReason: null,
};

const PROJECTION = {
  masterEnabled: true,
  activePreset: 'coding',
  presets: [{
    name: 'coding',
    layout: 'structured',
    editable: true,
    reason: null,
    selectionPresent: false,
    packageIds: [],
    agents: [],
  }],
};

function makeSource() {
  const state = {
    rootPath: '/synthetic/marketplace',
    generation: 'source-generation-1',
    fingerprint: 'b'.repeat(64),
    packages: [PACKAGE],
    snapshotCalls: 0,
    updates: [],
    failure: null,
    snapshotOverride: null,
  };
  const view = () => ({
    state: 'ready',
    adapterVersion: 'omos-marketplace-lock-v2',
    generation: state.generation,
    fingerprint: state.fingerprint,
    readAt: 1,
    packages: state.packages.map(pkg => ({ ...pkg })),
  });
  const store = {
    get() { return { rootPath: state.rootPath, generation: state.generation }; },
    update(rootPath) {
      if (typeof rootPath !== 'string' || (rootPath && !path.isAbsolute(rootPath))) {
        throw new ServiceError(400, 'INVALID_MARKETPLACE_SOURCE', 'rootPath must be an absolute path or empty.');
      }
      state.rootPath = rootPath;
      state.generation = `source-generation-${state.updates.length + 2}`;
      state.updates.push(rootPath);
      return this.get();
    },
    snapshot() {
      state.snapshotCalls += 1;
      if (state.failure) throw state.failure;
      if (state.snapshotOverride) return state.snapshotOverride;
      return view();
    },
  };
  return { factory: () => store, state, view };
}

function marketDescribe() {
  return { ...PROJECTION, presets: PROJECTION.presets.map(preset => ({ ...preset, packageIds: [], agents: [] })) };
}

async function withService(name, setup, run, options = {}) {
  const root = makeRoot(name);
  const env = makeEnv(root);
  const source = options.source ?? makeSource();
  const configFile = writeFile(settingsFor(env).configFile, options.config ?? MARKET_CONFIG, 0o600);
  const extra = setup ? await setup({ root, env }) : {};
  const context = await startService(env, {
    createMarketplaceSourceStoreImpl: source.factory,
    ...(options.realDescribe ? {} : { describeMarketplaceConfigImpl: marketDescribe }),
    ...options.serviceOptions,
  });
  try {
    await run({ root, env, source, configFile, ...extra, ...context });
  } finally {
    await context.close();
  }
}

const configFileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const group = (snapshot, name) => snapshot.groups.find(item => item.name === name);

test('marketplace routes enforce auth, origin, method, query and exact source body', async () => {
  await withService('marketplace-auth', null, async ({ baseUrl, source, configFile }) => {
    const hash = configFileHash(configFile);
    assert.equal((await call(baseUrl, 'GET', '/marketplace/source', { token: '' })).status, 401);
    const origin = await call(baseUrl, 'GET', '/marketplace/source', { headers: { origin: 'http://evil.example' } });
    assert.equal(origin.status, 403);
    assert.equal(origin.body.error.code, 'ORIGIN_REJECTED');
    assert.equal((await call(baseUrl, 'PUT', '/marketplace/source')).status, 405);
    assert.equal((await call(baseUrl, 'GET', '/marketplace/source?x=1')).status, 400);
    assert.equal((await call(baseUrl, 'GET', '/marketplace/snapshot?x=1')).status, 400);
    assert.equal((await call(baseUrl, 'GET', '/marketplace/config?x=1')).status, 400);
    assert.equal((await call(baseUrl, 'POST', '/marketplace/source', { body: {} })).status, 400);
    assert.equal((await call(baseUrl, 'POST', '/marketplace/source', { body: { rootPath: '/synthetic', extra: true } })).status, 400);
    assert.equal((await call(baseUrl, 'POST', '/marketplace/source', { body: { rootPath: 'relative' } })).status, 400);
    assert.equal(source.state.updates.length, 0);
    assert.equal(configFileHash(configFile), hash);
    const sourceRead = await call(baseUrl, 'GET', '/marketplace/source');
    assert.equal(sourceRead.status, 200);
    assert.equal(sourceRead.headers.get('cache-control'), 'no-store');
    assert.deepEqual(sourceRead.body, { rootPath: '/synthetic/marketplace', generation: 'source-generation-1' });
  });
});

test('health, settings and ordinary config stay independent of unconfigured or corrupt marketplace source', async () => {
  const unconfigured = makeSource();
  unconfigured.state.snapshotOverride = {
    state: 'not-configured',
    generation: 'source-generation-1',
    error: { code: 'MARKETPLACE_SOURCE_NOT_CONFIGURED', message: 'Not configured.' },
  };
  await withService('marketplace-unconfigured', null, async ({ baseUrl }) => {
    assert.equal((await call(baseUrl, 'GET', '/health')).status, 200);
    assert.equal((await call(baseUrl, 'GET', '/settings')).status, 200);
    assert.equal((await call(baseUrl, 'GET', '/config')).status, 200);
    assert.equal((await call(baseUrl, 'GET', '/drafts')).status, 200);
    const snapshot = await call(baseUrl, 'GET', '/marketplace/snapshot');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.state, 'not-configured');
    const projection = await call(baseUrl, 'GET', '/marketplace/config');
    assert.equal(projection.status, 200);
    assert.equal(projection.body.catalog.state, 'not-configured');
  }, { source: unconfigured });

  await withService('marketplace-corrupt', null, async ({ baseUrl, source }) => {
    source.state.failure = new ServiceError(500, 'MARKETPLACE_SOURCE_CORRUPT', 'Saved marketplace source settings could not be read.');
    assert.equal((await call(baseUrl, 'GET', '/health')).status, 200);
    assert.equal((await call(baseUrl, 'GET', '/config')).status, 200);
    assert.equal((await call(baseUrl, 'GET', '/settings')).status, 200);
    const snapshot = await call(baseUrl, 'GET', '/marketplace/snapshot');
    assert.equal(snapshot.status, 500);
    assert.equal(snapshot.body.error.code, 'MARKETPLACE_SOURCE_CORRUPT');
    const projection = await call(baseUrl, 'GET', '/marketplace/config');
    assert.equal(projection.status, 500);
    assert.equal(projection.body.error.code, 'MARKETPLACE_SOURCE_CORRUPT');
  });
});

test('source configuration is private and does not mutate the selected config', async () => {
  await withService('marketplace-source', null, async ({ baseUrl, source, configFile }) => {
    const hash = configFileHash(configFile);
    const updated = await call(baseUrl, 'POST', '/marketplace/source', { body: { rootPath: '/synthetic/changed' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.rootPath, '/synthetic/changed');
    assert.equal(updated.body.generation, 'source-generation-2');
    assert.equal(configFileHash(configFile), hash);
    assert.equal(source.state.updates.length, 1);
    const snapshot = await call(baseUrl, 'GET', '/marketplace/snapshot');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.generation, 'source-generation-2');
    assert.equal(snapshot.body.packages[0].id, 'acme/janitor');
  });
});

test('marketplace projection reuses the pinned target and satisfies the client contract', async () => {
  await withService('marketplace-projection', null, async ({ baseUrl }) => {
    const core = await configSnapshot(baseUrl);
    const projection = await call(baseUrl, 'GET', '/marketplace/config');
    assert.equal(projection.status, 200);
    assert.deepEqual(projection.body.target, core.target);
    assert.equal(projection.body.baseHash, core.baseHash);
    assert.equal(projection.body.catalog.state, 'ready');
    assert.equal(projection.body.masterEnabled, true);
    assert.equal(projection.body.activePreset, 'coding');
    assert.equal(projection.body.presets[0].name, 'coding');
    // The real HTTP DTO must pass the same pure validator the page uses. This
    // intentionally does not stub or relax the client contract.
    const normalized = normalizeMarketplaceConfig(projection.body);
    assert.deepEqual(normalized.target, projection.body.target);
    assert.equal(normalized.baseHash, projection.body.baseHash);
    assert.equal(normalized.presets[0].name, 'coding');
    assert.equal(typeof projection.body.presets[0].agents[0].defaultVariant, 'string');
  }, { realDescribe: true });
});

test('mixed model and marketplace preview uses one binding and one commit', async () => {
  await withService('marketplace-mixed', null, async ({ baseUrl, source, configFile }) => {
    const before = await configSnapshot(baseUrl);
    const build = group(before, 'worker');
    const marketplace = {
      sourceGeneration: source.state.generation,
      catalogFingerprint: source.state.fingerprint,
      edits: [{ preset: 'coding', packageIds: [PACKAGE.id], creations: [] }],
    };
    const preview = await call(baseUrl, 'POST', '/preview', {
      body: {
        baseHash: before.baseHash,
        generation: before.target.generation,
        changes: [{ path: build.path, models: [{ id: 'openai/gpt-5', variant: 'high' }] }],
        marketplace,
      },
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.marketplaceBinding, {
      sourceGeneration: source.state.generation,
      catalogFingerprint: source.state.fingerprint,
    });
    assert.ok(preview.body.changed.some(label => label.includes('marketplace selection')));
    assert.ok(preview.body.previewToken);
    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 200);
    const written = fs.readFileSync(configFile, 'utf8');
    assert.match(written, /marketplace/);
    assert.match(written, /acme\/janitor/);
    assert.match(written, /"variant": "high"/);
    assert.equal((await call(baseUrl, 'GET', '/marketplace/snapshot')).status, 200);
  });
});

test('legacy preview omits the marketplace binding and marketplace no-op has no token', async () => {
  await withService('marketplace-legacy', null, async ({ baseUrl, source }) => {
    const before = await configSnapshot(baseUrl);
    const build = group(before, 'worker');
    const legacy = await call(baseUrl, 'POST', '/preview', {
      body: {
        baseHash: before.baseHash,
        generation: before.target.generation,
        changes: [{ path: build.path, models: [{ id: 'openai/gpt-5', variant: 'low' }] }],
      },
    });
    assert.equal(legacy.status, 200);
    assert.equal(Object.hasOwn(legacy.body, 'marketplaceBinding'), false);
    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: legacy.body.previewToken } });
    assert.equal(commit.status, 200);

    const current = await configSnapshot(baseUrl);
    const noop = await call(baseUrl, 'POST', '/preview', {
      body: {
        baseHash: current.baseHash,
        generation: current.target.generation,
        changes: [],
        marketplace: {
          sourceGeneration: source.state.generation,
          catalogFingerprint: source.state.fingerprint,
          edits: [{ preset: 'coding', packageIds: [], creations: [] }],
        },
      },
    });
    assert.equal(noop.status, 200);
    assert.equal(noop.body.previewToken, null);
    assert.equal(noop.body.marketplaceBinding, null);
  });
});

test('source change before commit rejects the bound preview without writing', async () => {
  await withService('marketplace-stale', null, async ({ baseUrl, source, configFile }) => {
    const before = await configSnapshot(baseUrl);
    const preview = await call(baseUrl, 'POST', '/preview', {
      body: {
        baseHash: before.baseHash,
        generation: before.target.generation,
        changes: [],
        marketplace: {
          sourceGeneration: source.state.generation,
          catalogFingerprint: source.state.fingerprint,
          edits: [{ preset: 'coding', packageIds: [PACKAGE.id], creations: [] }],
        },
      },
    });
    assert.equal(preview.status, 200);
    const hash = configFileHash(configFile);
    const sourceUpdate = await call(baseUrl, 'POST', '/marketplace/source', { body: { rootPath: '/synthetic/changed' } });
    assert.equal(sourceUpdate.status, 200);
    assert.equal(sourceUpdate.body.generation, 'source-generation-2');
    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'MARKETPLACE_SOURCE_CHANGED');
    assert.equal(configFileHash(configFile), hash);
  });
});

test('source change between backup and replacement is rejected by the second guard', async () => {
  const source = makeSource();
  let flushes = 0;
  const serviceOptions = {
    commitHooks: {
      flush(descriptor, label) {
        fs.fsyncSync(descriptor);
        flushes += 1;
        if (label === 'temporary') {
          source.state.generation = 'source-generation-during-save';
        }
      },
    },
  };
  await withService('marketplace-during-save', null, async ({ baseUrl, configFile }) => {
    const before = await configSnapshot(baseUrl);
    const preview = await call(baseUrl, 'POST', '/preview', {
      body: {
        baseHash: before.baseHash,
        generation: before.target.generation,
        changes: [],
        marketplace: {
          sourceGeneration: source.state.generation,
          catalogFingerprint: source.state.fingerprint,
          edits: [{ preset: 'coding', packageIds: [PACKAGE.id], creations: [] }],
        },
      },
    });
    assert.equal(preview.status, 200);
    const hash = configFileHash(configFile);
    const commit = await call(baseUrl, 'POST', '/commit', { body: { previewToken: preview.body.previewToken } });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'MARKETPLACE_SOURCE_CHANGED');
    assert.equal(configFileHash(configFile), hash);
    assert.ok(flushes >= 2);
  }, { source, serviceOptions });
});

test('draft v1 and v2 HTTP roundtrip remains version-aware', async () => {
  await withService('marketplace-drafts', null, async ({ baseUrl }) => {
    const config = await configSnapshot(baseUrl);
    const build = group(config, 'worker');
    const common = {
      targetPath: config.target.path,
      baseHash: config.baseHash,
      originals: [{ path: build.path, models: build.models }],
      changes: [{ path: build.path, models: [{ id: 'openai/gpt-5', variant: 'high' }] }],
    };
    const v1 = await call(baseUrl, 'POST', '/drafts', {
      body: { id: crypto.randomUUID(), ...common },
    });
    assert.equal(v1.status, 200);
    const v2 = await call(baseUrl, 'POST', '/drafts', {
      body: {
        id: crypto.randomUUID(), version: 2, revision: 0,
        marketplace: null, ...common,
      },
    });
    assert.equal(v2.status, 200);
    const listed = await call(baseUrl, 'GET', '/drafts');
    assert.equal(listed.status, 200);
    const versions = listed.body.drafts.map(draft => draft.version ?? 1).sort();
    assert.deepEqual(versions, [1, 2]);
    for (const draft of listed.body.drafts) {
      assert.equal((await call(baseUrl, 'DELETE', `/drafts/${draft.id}`)).status, 200);
    }
    assert.deepEqual((await call(baseUrl, 'GET', '/drafts')).body.drafts, []);
  });
});

test('unknown draft versions are exposed only as a safe HTTP header', async () => {
  const canary = 'HTTP-DRAFT-CANARY-private-value';
  const unknown = {
    id: '33333333-3333-4333-8333-333333333333',
    version: 3,
    targetPath: '/synthetic/config.jsonc',
    baseHash: 'c'.repeat(64),
    updatedAt: '2026-02-02T00:00:00.000Z',
    futureField: canary,
    rawConfig: { privatePrompt: canary, credentials: { token: canary } },
    marketplace: { secret: canary },
  };
  await withService('marketplace-unknown-draft', ({ env }) => {
    const dataDir = env.OPENCHAMBER_SERVICE_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });
    const fileV2 = path.join(dataDir, 'drafts-v2.json');
    writeFile(fileV2, JSON.stringify({ version: 2, drafts: [unknown] }), 0o600);
    return { fileV2, bytes: fs.readFileSync(fileV2) };
  }, async ({ baseUrl, fileV2, bytes }) => {
    const listed = await call(baseUrl, 'GET', '/drafts');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.drafts.length, 1);
    assert.deepEqual(listed.body.drafts[0], {
      id: unknown.id,
      version: 3,
      targetPath: unknown.targetPath,
      baseHash: unknown.baseHash,
      updatedAt: unknown.updatedAt,
      readOnlyReason: 'This draft was saved by a newer extension version and is read-only.',
    });
    assert.doesNotMatch(listed.text, new RegExp(canary));
    for (const field of ['futureField', 'rawConfig', 'marketplace', 'credentials', 'privatePrompt']) {
      assert.equal(listed.text.includes(field), false, field);
    }

    const remove = await call(baseUrl, 'DELETE', `/drafts/${unknown.id}`);
    assert.equal(remove.status, 409);
    assert.equal(remove.body.error.code, 'DRAFT_UNSUPPORTED_VERSION');
    assert.doesNotMatch(remove.text, new RegExp(canary));
    assert.deepEqual(fs.readFileSync(fileV2), bytes);

    const config = await configSnapshot(baseUrl);
    const save = await call(baseUrl, 'POST', '/drafts', {
      body: {
        id: unknown.id,
        version: 2,
        revision: 1,
        targetPath: config.target.path,
        baseHash: config.baseHash,
        originals: [],
        changes: [{
          path: ['agents', 'x', 'model'],
          models: [{ id: 'openai/gpt-5', variant: '' }],
        }],
        marketplace: null,
      },
    });
    assert.equal(save.status, 409);
    assert.equal(save.body.error.code, 'DRAFT_UNSUPPORTED_VERSION');
    assert.doesNotMatch(save.text, new RegExp(canary));
    assert.deepEqual(fs.readFileSync(fileV2), bytes);
  });
});

test('optimizer endpoints are authenticated unknown routes and never launch native code', async () => {
  await withService('marketplace-optimizer-path', null, async ({ baseUrl }) => {
    for (const [method, route] of [
      ['GET', '/optimizer/context'], ['POST', '/optimizer/context/refresh'],
      ['POST', '/optimizer/generate'], ['GET', '/optimizer/status?jobId=some-id'],
      ['POST', '/optimizer/apply-validation'],
    ]) {
      const response = await call(baseUrl, method, route, method === 'POST' ? { body: {} } : {});
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'NOT_FOUND');
      const unauthenticated = await call(baseUrl, method, route, {
        token: '', ...(method === 'POST' ? { body: {} } : {}),
      });
      assert.equal(unauthenticated.status, 401);
    }
  });
});
