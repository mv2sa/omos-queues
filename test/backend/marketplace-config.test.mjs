import assert from 'node:assert/strict';
import test from 'node:test';
import { enumerateGroupsFromText, parseConfigDocument, prepareConfigEdit } from '../../src/backend/config.js';
import {
  describeMarketplaceConfig,
  normalizeLiteralModels,
  planMarketplaceConfig,
} from '../../src/backend/marketplace-config.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const LONG_ID = `${'a'.repeat(64)}/${'b'.repeat(64)}`;
const TOO_LONG_ID = `${'a'.repeat(64)}/${'b'.repeat(65)}`;

const PACKAGES = [
  {
    id: 'acme/janitor',
    version: '1.2.3',
    agentName: 'janitor',
    displayName: 'Janitor',
    modelSource: 'session',
    digest: DIGEST_A,
    blockedReason: null,
  },
  {
    id: 'acme/chronicler',
    version: '1.0.0',
    agentName: 'chronicler',
    displayName: 'Chronicler',
    modelSource: 'session',
    digest: DIGEST_B,
    blockedReason: null,
  },
];

const catalog = (overrides = {}) => ({
  state: 'ready',
  generation: 'gen-1',
  fingerprint: 'fp-1',
  packages: PACKAGES.map(pkg => ({ ...pkg })),
  ...overrides,
});

const STRUCTURED = `{
  "marketplace": { "enabled": true },
  "presets": {
    "team": {
      "agents": {
        "docs": { "model": "openai/gpt-5-mini" }
      }
    }
  }
}
`;

const FLAT = `{
  "marketplace": { "enabled": true },
  "presets": {
    "solo": {
      "review": { "model": "openai/gpt-5" }
    }
  }
}
`;

const plan = (text, marketplace, options = {}) => planMarketplaceConfig({
  text,
  config: parseConfigDocument(text),
  groups: enumerateGroupsFromText(text),
  catalog: options.catalog ?? catalog(),
  marketplace,
});

const edit = (preset, packageIds, creations = []) => ({ preset, packageIds, creations });
const request = (edits) => ({ sourceGeneration: 'gen-1', catalogFingerprint: 'fp-1', edits });

function errorOf(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

test('describe projects structured and flat presets without derived runtime state', () => {
  const structured = describeMarketplaceConfig({
    text: STRUCTURED,
    groups: enumerateGroupsFromText(STRUCTURED),
    catalog: catalog(),
  });
  assert.equal(structured.masterEnabled, true);
  assert.equal(structured.activePreset, null);
  assert.equal(structured.presets.length, 1);
  const team = structured.presets[0];
  assert.equal(team.name, 'team');
  assert.equal(team.layout, 'structured');
  assert.equal(team.editable, true);
  assert.equal(team.reason, null);
  assert.equal(team.selectionPresent, false);
  assert.deepEqual(team.packageIds, []);
  assert.deepEqual(team.agents, [
    {
      packageId: 'acme/janitor',
      agentName: 'janitor',
      selected: false,
      existingGroupId: null,
      modelPath: ['presets', 'team', 'agents', 'janitor', 'model'],
      defaultVariant: '',
      canCreate: true,
      blockedReason: null,
    },
    {
      packageId: 'acme/chronicler',
      agentName: 'chronicler',
      selected: false,
      existingGroupId: null,
      modelPath: ['presets', 'team', 'agents', 'chronicler', 'model'],
      defaultVariant: '',
      canCreate: true,
      blockedReason: null,
    },
  ]);
  assert.equal(Object.hasOwn(team, 'marketplacePresets'), false);

  const withActive = STRUCTURED.replace(
    '"marketplace"',
    '"preset": "team",\n  "marketplace"',
  );
  assert.equal(describeMarketplaceConfig({
    text: withActive,
    groups: enumerateGroupsFromText(withActive),
    catalog: catalog(),
  }).activePreset, 'team');
  const withDecoy = STRUCTURED.replace(
    '"marketplace"',
    '"preset": "team",\n  "activePreset": "decoy",\n  "marketplace"',
  );
  assert.equal(describeMarketplaceConfig({
    text: withDecoy,
    groups: enumerateGroupsFromText(withDecoy),
    catalog: catalog(),
  }).activePreset, 'team');
  const withMissingActive = STRUCTURED.replace(
    '"marketplace"',
    '"preset": "missing",\n  "marketplace"',
  );
  assert.equal(describeMarketplaceConfig({
    text: withMissingActive,
    groups: enumerateGroupsFromText(withMissingActive),
    catalog: catalog(),
  }).activePreset, null);
  const withNonliteralActive = STRUCTURED.replace(
    '"marketplace"',
    '"preset": 42,\n  "marketplace"',
  );
  assert.equal(describeMarketplaceConfig({
    text: withNonliteralActive,
    groups: enumerateGroupsFromText(withNonliteralActive),
    catalog: catalog(),
  }).activePreset, null);

  const flat = describeMarketplaceConfig({
    text: FLAT,
    groups: enumerateGroupsFromText(FLAT),
    catalog: catalog(),
  });
  assert.equal(flat.presets[0].layout, 'flat');
  assert.deepEqual(flat.presets[0].agents.map(agent => agent.modelPath), [
    ['presets', 'solo', 'janitor', 'model'],
    ['presets', 'solo', 'chronicler', 'model'],
  ]);
  assert.equal(flat.presets[0].editable, true);
});

test('describe retains unknown selected ids unchanged with blocked metadata', () => {
  const text = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["acme/janitor", "ghost/unknown"] },
        "agents": { "docs": { "model": "openai/gpt-5-mini" } }
      }
    }
  }`;
  const result = describeMarketplaceConfig({
    text,
    groups: enumerateGroupsFromText(text),
    catalog: catalog(),
  });
  const team = result.presets[0];
  assert.equal(team.selectionPresent, true);
  assert.deepEqual(team.packageIds, ['acme/janitor', 'ghost/unknown']);
  const janitor = team.agents.find(agent => agent.packageId === 'acme/janitor');
  assert.equal(janitor.selected, true);
  const unknown = team.agents.find(agent => agent.packageId === 'ghost/unknown');
  assert.deepEqual(unknown, {
    packageId: 'ghost/unknown',
    agentName: null,
    selected: true,
    existingGroupId: null,
    modelPath: null,
    defaultVariant: '',
    canCreate: false,
    blockedReason: 'Unknown installed package identity.',
  });
});

test('describe exposes a truthful defaultVariant on every agent row', () => {
  const structured = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["acme/janitor", "ghost/unknown"] },
        "agents": {
          "janitor": { "model": "openai/gpt-5", "variant": "high" },
          "chronicler": { "prompt": "keep", "variant": "low" }
        }
      }
    }
  }`;
  const structuredCatalog = catalog({
    packages: [
      PACKAGES[0],
      PACKAGES[1],
      { ...PACKAGES[0], id: 'acme/fresh', agentName: 'fresh', displayName: 'Fresh' },
    ],
  });
  const team = describeMarketplaceConfig({
    text: structured,
    groups: enumerateGroupsFromText(structured),
    catalog: structuredCatalog,
  }).presets[0];
  assert.equal(team.editable, true);
  const byId = packageId => team.agents.find(agent => agent.packageId === packageId);
  assert.equal(byId('acme/janitor').defaultVariant, 'high');
  assert.equal(byId('acme/janitor').canCreate, false);
  assert.ok(byId('acme/janitor').existingGroupId);
  assert.equal(byId('acme/chronicler').defaultVariant, 'low');
  assert.equal(byId('acme/chronicler').canCreate, false);
  assert.match(byId('acme/chronicler').blockedReason, /custom definition/);
  assert.equal(byId('acme/fresh').defaultVariant, '');
  assert.equal(byId('acme/fresh').canCreate, true);
  assert.equal(byId('ghost/unknown').defaultVariant, '');
  assert.equal(byId('ghost/unknown').canCreate, false);
  const expectedKeys = ['packageId', 'agentName', 'selected', 'existingGroupId', 'modelPath', 'defaultVariant', 'canCreate', 'blockedReason'].sort();
  assert.equal(team.agents.every(agent => JSON.stringify(Object.keys(agent).sort()) === JSON.stringify(expectedKeys)), true);
  assert.equal(team.agents.every(agent => typeof agent.defaultVariant === 'string'), true);

  const flat = `{
    "marketplace": { "enabled": true },
    "presets": {
      "solo": {
        "review": { "model": "openai/gpt-5", "variant": "low" }
      }
    }
  }`;
  const flatCatalog = catalog({
    packages: [
      { ...PACKAGES[0], id: 'acme/reviewer', agentName: 'review' },
      PACKAGES[1],
    ],
  });
  const solo = describeMarketplaceConfig({
    text: flat,
    groups: enumerateGroupsFromText(flat),
    catalog: flatCatalog,
  }).presets[0];
  const review = solo.agents.find(agent => agent.agentName === 'review');
  assert.equal(review.defaultVariant, 'low');
  assert.equal(review.canCreate, false);
  assert.ok(review.existingGroupId);
  assert.equal(solo.agents.find(agent => agent.agentName === 'chronicler').defaultVariant, '');
  assert.equal(solo.agents.find(agent => agent.agentName === 'chronicler').canCreate, true);
  assert.equal(solo.agents.every(agent => JSON.stringify(Object.keys(agent).sort()) === JSON.stringify(expectedKeys)), true);

  for (const variant of ['${env:V}', 'x'.repeat(501), 7]) {
    const unresolved = JSON.stringify({
      marketplace: { enabled: true },
      presets: { team: { agents: { janitor: { prompt: 'keep', variant } } } },
    });
    const unresolvedTeam = describeMarketplaceConfig({
      text: unresolved,
      groups: enumerateGroupsFromText(unresolved),
      catalog: catalog(),
    }).presets[0];
    const janitor = unresolvedTeam.agents.find(agent => agent.agentName === 'janitor');
    assert.equal(janitor.defaultVariant, '', JSON.stringify(variant));
    assert.equal(janitor.canCreate, false, JSON.stringify(variant));
    assert.match(janitor.blockedReason, /unresolved or unsupported/, JSON.stringify(variant));
    const creation = errorOf(() => plan(unresolved, request([edit('team', ['acme/janitor'], [{
      packageId: 'acme/janitor',
      models: [{ id: 'openai/gpt-6', variant: '' }],
    }])])));
    assert.equal(creation?.code, 'MARKETPLACE_UNSUPPORTED', JSON.stringify(variant));
  }
});

test('describe and plan fail closed on ambiguous marketplace and agent namespaces', () => {
  const cases = [
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"review":{"model":"openai/gpt-5"},"marketplace":{"variant":"high"}}}}',
      reason: /non-activation/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"marketplace":{"prompt":"x"},"review":{"model":"openai/gpt-5"}}}}',
      reason: /non-activation/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"marketplace":{"options":{}},"review":{"model":"openai/gpt-5"}}}}',
      reason: /non-activation/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{"janitor":{"model":"openai/gpt-5"}},"sibling":{"prompt":"x"}}}}',
      reason: /top-level agent entries/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{"prompt":"x"}}}}',
      reason: /agent definition/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{"options":{}}}}}',
      reason: /agent definition/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{"variant":"high"}}}}',
      reason: /agent definition/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{"janitor":"scalar"}}}}',
      reason: /non-object agent definition/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"review":{"model":"openai/gpt-5"},"description":"x"}}}',
      reason: /non-agent top-level value/,
    },
  ];
  for (const item of cases) {
    const view = describeMarketplaceConfig({
      text: item.text,
      groups: enumerateGroupsFromText(item.text),
      catalog: catalog(),
    });
    assert.equal(view.presets[0].editable, false, item.text);
    assert.match(view.presets[0].reason, item.reason, item.text);
    const error = errorOf(() => plan(item.text, request([edit('p', [])])));
    assert.equal(error?.code, 'MARKETPLACE_UNSUPPORTED', item.text);
  }

  const valid = '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{"janitor":{"prompt":"keep"}}}}}';
  const validView = describeMarketplaceConfig({
    text: valid,
    groups: enumerateGroupsFromText(valid),
    catalog: catalog(),
  });
  assert.equal(validView.presets[0].layout, 'structured');
  assert.equal(validView.presets[0].editable, true);
  assert.match(
    validView.presets[0].agents.find(agent => agent.agentName === 'janitor').blockedReason,
    /custom definition/,
  );

  const empty = '{"marketplace":{"enabled":true},"presets":{"p":{"agents":{}}}}';
  const emptyView = describeMarketplaceConfig({
    text: empty,
    groups: enumerateGroupsFromText(empty),
    catalog: catalog(),
  });
  assert.equal(emptyView.presets[0].layout, 'structured');
  assert.equal(emptyView.presets[0].editable, true);
});

test('canonical 129-character package ids project and stage while 130-character ids never become installed', () => {
  const longCatalog = catalog({
    packages: [{
      ...PACKAGES[0],
      id: LONG_ID,
      agentName: 'long129',
      displayName: 'Long129',
    }],
  });
  const text = JSON.stringify({
    marketplace: { enabled: true },
    presets: { team: { agents: {} } },
  });
  const groups = enumerateGroupsFromText(text);
  const view = describeMarketplaceConfig({ text, groups, catalog: longCatalog });
  assert.equal(view.presets[0].agents.length, 1);
  assert.equal(view.presets[0].agents[0].packageId, LONG_ID);
  assert.equal(view.presets[0].agents[0].agentName, 'long129');
  assert.equal(view.presets[0].agents[0].canCreate, true);

  const prepared = prepareConfigEdit({
    text,
    groups,
    changes: [],
    marketplace: {
      sourceGeneration: 'gen-1',
      catalogFingerprint: 'fp-1',
      edits: [{
        preset: 'team',
        packageIds: [LONG_ID],
        creations: [{
          packageId: LONG_ID,
          models: [{ id: 'openai/gpt-6', variant: '' }],
        }],
      }],
    },
    marketplaceCatalog: longCatalog,
  });
  const after = parseConfigDocument(prepared.after);
  assert.deepEqual(after.presets.team.marketplace.agents, [LONG_ID]);
  assert.deepEqual(after.presets.team.agents.long129.model, [{ id: 'openai/gpt-6' }]);
  assert.equal(prepared.marketplaceCreations[0].packageId, LONG_ID);

  const badCatalog = catalog({
    packages: [{
      ...PACKAGES[0],
      id: TOO_LONG_ID,
      agentName: 'long130',
      displayName: 'Long130',
    }],
  });
  const badView = describeMarketplaceConfig({ text, groups, catalog: badCatalog });
  assert.equal(badView.presets[0].agents.length, 0);
  assert.equal(
    errorOf(() => plan(text, request([edit('team', [TOO_LONG_ID])]), { catalog: badCatalog }))?.code,
    'MARKETPLACE_UNSUPPORTED',
  );

  const retainedText = JSON.stringify({
    marketplace: { enabled: true },
    presets: {
      team: {
        marketplace: { agents: [TOO_LONG_ID] },
        agents: {},
      },
    },
  });
  const retainedGroups = enumerateGroupsFromText(retainedText);
  const retainedView = describeMarketplaceConfig({
    text: retainedText,
    groups: retainedGroups,
    catalog: badCatalog,
  });
  const retained = retainedView.presets[0].agents.find(agent => agent.packageId === TOO_LONG_ID);
  assert.equal(retained.agentName, null);
  assert.equal(retained.canCreate, false);
  assert.equal(
    errorOf(() => plan(retainedText, request([edit('team', [TOO_LONG_ID], [{
      packageId: TOO_LONG_ID,
      models: [{ id: 'openai/gpt-6', variant: '' }],
    }])]), { catalog: badCatalog }))?.code,
    'MARKETPLACE_UNSUPPORTED',
  );
});

test('retained opaque selection ids up to 500 characters stay retained but never authorize creation', () => {
  const opaque = 'x'.repeat(500);
  const text = JSON.stringify({
    marketplace: { enabled: true },
    presets: {
      team: {
        marketplace: { agents: [opaque] },
        agents: {},
      },
    },
  });
  const groups = enumerateGroupsFromText(text);
  const view = describeMarketplaceConfig({ text, groups, catalog: catalog() });
  const retained = view.presets[0].agents.find(agent => agent.packageId === opaque);
  assert.equal(retained.agentName, null);
  assert.equal(retained.canCreate, false);
  assert.equal(retained.defaultVariant, '');

  const prepared = prepareConfigEdit({
    text,
    groups,
    changes: [],
    marketplace: {
      sourceGeneration: 'gen-1',
      catalogFingerprint: 'fp-1',
      edits: [{ preset: 'team', packageIds: ['acme/janitor'], creations: [] }],
    },
    marketplaceCatalog: catalog(),
  });
  const after = parseConfigDocument(prepared.after);
  assert.deepEqual(after.presets.team.marketplace.agents, ['acme/janitor', opaque]);

  const creation = errorOf(() => prepareConfigEdit({
    text,
    groups,
    changes: [],
    marketplace: {
      sourceGeneration: 'gen-1',
      catalogFingerprint: 'fp-1',
      edits: [{
        preset: 'team',
        packageIds: ['acme/janitor', opaque],
        creations: [{
          packageId: opaque,
          models: [{ id: 'openai/gpt-6', variant: '' }],
        }],
      }],
    },
    marketplaceCatalog: catalog(),
  }));
  assert.equal(creation?.code, 'MARKETPLACE_UNSUPPORTED');
});

test('describe marks unsupported shapes, root overrides and disabled master read-only', () => {
  const cases = [
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"extends":"base","agents":{}}}}',
      reason: /extends/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"marketplace":{"agents_add":[]},"agents":{}}}}',
      reason: /non-activation/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"build":{"model":"openai/gpt-5"},"agents":{}}}}',
      reason: /top-level agent entries/,
    },
    {
      text: '{"marketplace":{"enabled":true},"presets":{"p":{"marketplace":{"model":"openai/gpt-5"}}}}',
      reason: /non-activation/,
    },
    {
      text: '{"marketplace":{"enabled":true,"agents":[]},"presets":{"p":{"agents":{}}}}',
      reason: /Root marketplace/,
      master: false,
    },
    {
      text: '{"marketplace":{"enabled":true},"marketplacePresets":{},"presets":{"p":{"agents":{}}}}',
      reason: /Root marketplace/,
      master: false,
    },
    {
      text: '{"marketplace":{"enabled":false},"presets":{"p":{"agents":{}}}}',
      reason: /master is disabled/,
      master: false,
    },
  ];
  for (const item of cases) {
    const result = describeMarketplaceConfig({
      text: item.text,
      groups: enumerateGroupsFromText(item.text),
      catalog: catalog(),
    });
    assert.equal(result.masterEnabled, item.master ?? true, item.text);
    assert.equal(result.presets[0].editable, false, item.text);
    assert.match(result.presets[0].reason, item.reason, item.text);
    assert.equal(result.presets[0].agents.every(agent => agent.canCreate === false), true, item.text);
  }
});

test('describe blocks duplicate agent names, custom definitions and root shadows', () => {
  const duplicateCatalog = catalog({
    packages: [
      PACKAGES[0],
      { ...PACKAGES[1], agentName: 'janitor', id: 'acme/other' },
    ],
  });
  const duplicate = describeMarketplaceConfig({
    text: STRUCTURED,
    groups: enumerateGroupsFromText(STRUCTURED),
    catalog: duplicateCatalog,
  });
  for (const agent of duplicate.presets[0].agents) {
    assert.equal(agent.canCreate, false);
    assert.match(agent.blockedReason, /not unique/);
  }

  const custom = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "agents": { "janitor": { "description": "custom" } }
      }
    }
  }`;
  const customView = describeMarketplaceConfig({
    text: custom,
    groups: enumerateGroupsFromText(custom),
    catalog: catalog(),
  });
  assert.match(
    customView.presets[0].agents.find(agent => agent.agentName === 'janitor').blockedReason,
    /custom definition/,
  );

  const shadow = `{
    "marketplace": { "enabled": true },
    "presets": { "team": { "agents": {} } },
    "agents": { "janitor": { "model": "openai/gpt-5" } }
  }`;
  const shadowView = describeMarketplaceConfig({
    text: shadow,
    groups: enumerateGroupsFromText(shadow),
    catalog: catalog(),
  });
  assert.match(
    shadowView.presets[0].agents.find(agent => agent.agentName === 'janitor').blockedReason,
    /root agent/,
  );
});

test('plan stages a selection only and returns the reviewed binding', () => {
  const result = plan(STRUCTURED, request([edit('team', ['acme/janitor'])]));
  assert.deepEqual(result.binding, { sourceGeneration: 'gen-1', catalogFingerprint: 'fp-1' });
  assert.deepEqual(result.mutations, [{
    path: ['presets', 'team', 'marketplace', 'agents'],
    value: ['acme/janitor'],
    label: 'preset team · marketplace selection',
    created: true,
  }]);
  assert.deepEqual(result.creations, []);
  assert.deepEqual(result.labels, ['preset team · marketplace selection']);
});

test('plan creates an explicit ladder only for a package selected in the result', () => {
  const result = plan(STRUCTURED, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor',
    models: [
      { id: 'openai/gpt-6', variant: 'high' },
      { id: 'openai/gpt-5', variant: '' },
    ],
  }])]));
  assert.equal(result.mutations.length, 2);
  assert.deepEqual(result.mutations[1], {
    path: ['presets', 'team', 'agents', 'janitor', 'model'],
    value: [{ id: 'openai/gpt-6', variant: 'high' }, { id: 'openai/gpt-5' }],
    label: 'preset team · janitor (created)',
    created: true,
  });
  assert.deepEqual(result.creations, [{
    preset: 'team',
    packageId: 'acme/janitor',
    agentName: 'janitor',
    path: ['presets', 'team', 'agents', 'janitor', 'model'],
    models: [
      { id: 'openai/gpt-6', variant: 'high' },
      { id: 'openai/gpt-5', variant: '' },
    ],
  }]);

  const notSelected = errorOf(() => plan(STRUCTURED, request([edit('team', [], [{
    packageId: 'acme/janitor',
    models: [{ id: 'openai/gpt-6', variant: '' }],
  }])])));
  assert.equal(notSelected.code, 'MARKETPLACE_UNSUPPORTED');
});

test('the same package can create one ladder per existing preset', () => {
  const text = `{
    "marketplace": { "enabled": true },
    "presets": {
      "structured": { "agents": {} },
      "flat": {}
    }
  }`;
  const result = plan(text, request([
    edit('structured', ['acme/janitor'], [{
      packageId: 'acme/janitor',
      models: [{ id: 'openai/gpt-6', variant: '' }],
    }]),
    edit('flat', ['acme/janitor'], [{
      packageId: 'acme/janitor',
      models: [{ id: 'openai/gpt-5', variant: '' }],
    }]),
  ]));
  assert.equal(result.creations.length, 2);
  assert.deepEqual(result.creations.map(creation => creation.path), [
    ['presets', 'structured', 'agents', 'janitor', 'model'],
    ['presets', 'flat', 'janitor', 'model'],
  ]);
  assert.equal(result.mutations.length, 4);
});

test('plan treats absent selection and an explicit empty result as semantic no-ops', () => {
  const absent = plan(STRUCTURED, request([edit('team', [])]));
  assert.deepEqual(absent.mutations, []);
  assert.deepEqual(absent.creations, []);
  assert.deepEqual(absent.binding, { sourceGeneration: 'gen-1', catalogFingerprint: 'fp-1' });

  const emptySelection = STRUCTURED.replace(
    '"agents": {',
    '"marketplace": { "agents": [] },\n      "agents": {',
  );
  const explicitEmpty = plan(emptySelection, request([edit('team', [])]));
  assert.deepEqual(explicitEmpty.mutations, []);

  const selected = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["acme/janitor"] },
        "agents": {}
      }
    }
  }`;
  const removal = plan(selected, request([edit('team', [])]));
  assert.equal(removal.mutations.length, 1);
  assert.deepEqual(removal.mutations[0].value, []);
  assert.equal(removal.mutations[0].created, false);
});

test('plan retains unknown existing selection ids and rejects new unknown ids', () => {
  const text = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["ghost/unknown"] },
        "agents": {}
      }
    }
  }`;
  const retained = plan(text, request([edit('team', ['acme/janitor'])]));
  assert.deepEqual(retained.mutations[0].value, ['acme/janitor', 'ghost/unknown']);

  const unknownNew = errorOf(() => plan(text, request([edit('team', ['ghost/new'])])));
  assert.equal(unknownNew.code, 'MARKETPLACE_UNSUPPORTED');
});

test('plan refuses stale or unavailable source bindings', () => {
  const staleGeneration = errorOf(() => plan(STRUCTURED, {
    sourceGeneration: 'gen-old',
    catalogFingerprint: 'fp-1',
    edits: [edit('team', ['acme/janitor'])],
  }));
  assert.equal(staleGeneration.status, 409);
  assert.equal(staleGeneration.code, 'MARKETPLACE_SOURCE_CHANGED');

  const staleCatalog = errorOf(() => plan(STRUCTURED, {
    sourceGeneration: 'gen-1',
    catalogFingerprint: 'fp-old',
    edits: [edit('team', ['acme/janitor'])],
  }));
  assert.equal(staleCatalog.status, 409);
  assert.equal(staleCatalog.code, 'MARKETPLACE_CATALOG_CHANGED');

  const unavailable = errorOf(() => plan(STRUCTURED, request([edit('team', [])]), {
    catalog: { state: 'unavailable', generation: 'gen-1', error: 'synthetic' },
  }));
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.code, 'MARKETPLACE_SOURCE_UNAVAILABLE');

  assert.equal(plan(STRUCTURED, null), null);
  assert.equal(plan(STRUCTURED, undefined), null);
});

test('plan rejects unsupported presets, orphan deselections and unsafe identities', () => {
  const extendsText = '{"marketplace":{"enabled":true},"presets":{"p":{"extends":"base","agents":{}}}}';
  assert.equal(
    errorOf(() => plan(extendsText, request([edit('p', [])]))).code,
    'MARKETPLACE_UNSUPPORTED',
  );

  const orphan = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["acme/janitor"] },
        "agents": { "janitor": { "model": "openai/gpt-5" } }
      }
    }
  }`;
  assert.equal(errorOf(() => plan(orphan, request([edit('team', [])]))).code, 'MARKETPLACE_ORPHAN');

  const custom = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["acme/janitor"] },
        "agents": { "janitor": { "description": "custom" } }
      }
    }
  }`;
  assert.equal(errorOf(() => plan(custom, request([edit('team', [])]))).code, 'MARKETPLACE_ORPHAN');

  const rootShadow = `{
    "marketplace": { "enabled": true },
    "presets": {
      "team": {
        "marketplace": { "agents": ["acme/janitor"] },
        "agents": {}
      }
    },
    "agents": { "janitor": { "model": "openai/gpt-5" } }
  }`;
  assert.equal(errorOf(() => plan(rootShadow, request([edit('team', [])]))).code, 'MARKETPLACE_ORPHAN');

  const unsafe = errorOf(() => plan(STRUCTURED, request([edit('team', ['__proto__/x'])])));
  assert.equal(unsafe.code, 'MARKETPLACE_UNSUPPORTED');

  const duplicatePreset = errorOf(() => plan(STRUCTURED, request([
    edit('team', ['acme/janitor']),
    edit('team', ['acme/chronicler']),
  ])));
  assert.equal(duplicatePreset.code, 'INVALID_MARKETPLACE');

  const duplicatePackage = errorOf(() => plan(STRUCTURED, request([
    edit('team', ['acme/janitor', 'acme/janitor']),
  ])));
  assert.equal(duplicatePackage.code, 'INVALID_MARKETPLACE');

  const duplicateCreation = errorOf(() => plan(STRUCTURED, request([edit('team', ['acme/janitor'], [
    { packageId: 'acme/janitor', models: [{ id: 'openai/gpt-6', variant: '' }] },
    { packageId: 'acme/janitor', models: [{ id: 'openai/gpt-5', variant: '' }] },
  ])])));
  assert.equal(duplicateCreation.code, 'INVALID_MARKETPLACE');
});

test('plan rejects creation when a model node, custom definition or root shadow exists', () => {
  const existingModel = `{
    "marketplace": { "enabled": true },
    "presets": { "team": { "agents": { "janitor": { "model": "openai/gpt-5" } } } }
  }`;
  assert.equal(errorOf(() => plan(existingModel, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor',
    models: [{ id: 'openai/gpt-6', variant: '' }],
  }])]))).code, 'MARKETPLACE_UNSUPPORTED');

  const custom = `{
    "marketplace": { "enabled": true },
    "presets": { "team": { "agents": { "janitor": { "description": "custom" } } } }
  }`;
  assert.equal(errorOf(() => plan(custom, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor',
    models: [{ id: 'openai/gpt-6', variant: '' }],
  }])]))).code, 'MARKETPLACE_UNSUPPORTED');

  const shadow = `{
    "marketplace": { "enabled": true },
    "presets": { "team": { "agents": {} } },
    "agents": { "janitor": { "model": "openai/gpt-5" } }
  }`;
  assert.equal(errorOf(() => plan(shadow, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor',
    models: [{ id: 'openai/gpt-6', variant: '' }],
  }])]))).code, 'MARKETPLACE_UNSUPPORTED');
});

test('plan refuses blocked packages and disabled master', () => {
  const blocked = catalog({
    packages: [{ ...PACKAGES[0], blockedReason: 'Package extends a built-in agent.' }, PACKAGES[1]],
  });
  assert.equal(errorOf(() => plan(STRUCTURED, request([edit('team', ['acme/janitor'])]), {
    catalog: blocked,
  })).code, 'MARKETPLACE_UNSUPPORTED');
  assert.equal(errorOf(() => plan(STRUCTURED, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor',
    models: [{ id: 'openai/gpt-6', variant: '' }],
  }])]), { catalog: blocked })).code, 'MARKETPLACE_UNSUPPORTED');

  const disabled = '{"marketplace":{"enabled":false},"presets":{"p":{"agents":{}}}}';
  assert.equal(errorOf(() => plan(disabled, request([edit('p', [])]))).code, 'MARKETPLACE_UNSUPPORTED');
});

test('plan rejects malformed marketplace request shapes', () => {
  assert.equal(errorOf(() => plan(STRUCTURED, {
    sourceGeneration: 'gen-1',
    catalogFingerprint: 'fp-1',
    edits: [edit('team', [])],
    extra: true,
  })).code, 'INVALID_MARKETPLACE');

  assert.equal(errorOf(() => plan(STRUCTURED, {
    sourceGeneration: 'gen-1',
    catalogFingerprint: 'fp-1',
    edits: [],
  })).code, 'INVALID_MARKETPLACE');

  assert.equal(errorOf(() => plan(STRUCTURED, request([{
    preset: 'team', packageIds: [], creations: [], extra: true,
  }]))).code, 'INVALID_MARKETPLACE');

  assert.equal(errorOf(() => plan(STRUCTURED, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor', models: [{ id: 'openai/gpt-6', variant: '' }], extra: true,
  }])]))).code, 'INVALID_MARKETPLACE');

  assert.equal(errorOf(() => plan(STRUCTURED, request([{
    preset: 'team', packageIds: 'acme/janitor', creations: [],
  }]))).code, 'INVALID_MARKETPLACE');
});

test('literal model validation is shared and enforces the 1..50 bounds', () => {
  const accepted = normalizeLiteralModels([
    { id: 'openai/gpt-6', variant: 'high' },
    { id: 'anthropic/claude-sonnet-4', variant: '' },
  ], 'queue');
  assert.deepEqual(accepted, [
    { id: 'openai/gpt-6', variant: 'high' },
    { id: 'anthropic/claude-sonnet-4', variant: '' },
  ]);

  for (const models of [
    [],
    Array.from({ length: 51 }, () => ({ id: 'openai/gpt-5', variant: '' })),
    [{ id: 'openai/{env:MODEL}', variant: '' }],
    [{ id: 'not-a-model', variant: '' }],
    [{ id: 'openai/gpt-5', variant: 'x'.repeat(501) }],
    [{ id: 'openai/gpt-5' }],
  ]) {
    assert.equal(errorOf(() => normalizeLiteralModels(models, 'queue')).code, 'INVALID_MODELS');
  }

  assert.equal(errorOf(() => plan(STRUCTURED, request([edit('team', ['acme/janitor'], [{
    packageId: 'acme/janitor',
    models: Array.from({ length: 51 }, () => ({ id: 'openai/gpt-5', variant: '' })),
  }])]))).code, 'INVALID_MODELS');
});
