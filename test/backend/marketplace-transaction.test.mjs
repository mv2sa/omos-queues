import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enumerateGroupsFromText,
  parseConfigDocument,
  prepareConfigEdit,
} from '../../src/backend/config.js';
import { renderModelValueDiffs } from '../../src/backend/diff.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
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
const catalog = () => ({
  state: 'ready',
  generation: 'gen-1',
  fingerprint: 'fp-1',
  packages: PACKAGES.map(pkg => ({ ...pkg })),
});
const binding = () => ({
  sourceGeneration: 'gen-1',
  catalogFingerprint: 'fp-1',
});
const marketplace = edits => ({ ...binding(), edits });
const stage = (text, { changes = [], edits, catalogValue = catalog() } = {}) => prepareConfigEdit({
  text,
  groups: enumerateGroupsFromText(text),
  changes,
  marketplace: edits === undefined ? undefined : marketplace(edits),
  marketplaceCatalog: catalogValue,
});

const MIXED = `{
  // root comment
  "marketplace": { "enabled": true },
  "presets": {
    "coding": {
      "agents": {
        "docs": { "model": "openai/gpt-5-mini", "prompt": "SECRET-PROMPT" }
      }
    }
  },
  "agents": { "root": { "model": "openai/gpt-5" } }
}
`;

const MIXED_EXPECTED = `{
  // root comment
  "marketplace": { "enabled": true },
  "presets": {
    "coding": {
      "agents": {
        "docs": { "model": [
            {
              "id": "openai/gpt-6"
            }
          ], "prompt": "SECRET-PROMPT" },
        "janitor": {
          "model": [
            {
              "id": "openai/gpt-6",
              "variant": "high"
            }
          ]
        }
      },
      "marketplace": {
        "agents": [
          "acme/janitor",
          "acme/chronicler"
        ]
      }
    }
  },
  "agents": { "root": { "model": "openai/gpt-5" } }
}
`;

const FLAT = `{
  "marketplace": { "enabled": true },
  "presets": {
    "solo": {
      // keep this comment
      "review": { "model": "openai/gpt-5", "prompt": "SECRET-FLAT" }
    }
  }
}
`;

const FLAT_EXPECTED = `{
  "marketplace": { "enabled": true },
  "presets": {
    "solo": {
      // keep this comment
      "review": { "model": "openai/gpt-5", "prompt": "SECRET-FLAT" },
      "marketplace": {
        "agents": [
          "acme/chronicler"
        ]
      },
      "chronicler": {
        "model": [
          {
            "id": "openai/gpt-6",
            "variant": "high"
          }
        ]
      }
    }
  }
}
`;

const STRUCTURED_CRLF = '{\r\n\t"marketplace": { "enabled": true },\r\n\t"presets": {\r\n\t\t"team": {\r\n\t\t\t"agents": {\r\n\t\t\t\t"docs": { "model": "openai/gpt-5-mini", "prompt": "SECRET-STRUCT" }\r\n\t\t\t}\r\n\t\t}\r\n\t}\r\n}\r\n';
const STRUCTURED_CRLF_EXPECTED = [
  '{',
  '\t"marketplace": { "enabled": true },',
  '\t"presets": {',
  '\t\t"team": {',
  '\t\t\t"agents": {',
  '\t\t\t\t"docs": { "model": "openai/gpt-5-mini", "prompt": "SECRET-STRUCT" },',
  '\t\t\t\t"janitor": {',
  '\t\t\t\t\t"model": [',
  '\t\t\t\t\t\t{',
  '\t\t\t\t\t\t\t"id": "openai/gpt-6",',
  '\t\t\t\t\t\t\t"variant": "low"',
  '\t\t\t\t\t\t},',
  '\t\t\t\t\t\t{',
  '\t\t\t\t\t\t\t"id": "openai/gpt-5"',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t]',
  '\t\t\t\t}',
  '\t\t\t},',
  '\t\t\t"marketplace": {',
  '\t\t\t\t"agents": [',
  '\t\t\t\t\t"acme/janitor"',
  '\t\t\t\t]',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\r\n');

const SELECTION_ONLY = `{
  "marketplace": { "enabled": true },
  "presets": {
    "p": {
      "marketplace": {
        "agents": [
          "acme/janitor"
        ]
      },
      // untouched neighbor
      "keep": { "model": "openai/gpt-5" }
    }
  }
}
`;

const SELECTION_ONLY_EXPECTED = `{
  "marketplace": { "enabled": true },
  "presets": {
    "p": {
      "marketplace": {
        "agents": [
          "acme/chronicler"
        ]
      },
      // untouched neighbor
      "keep": { "model": "openai/gpt-5" }
    }
  }
}
`;

const EMPTY_PRESET = `{
  "marketplace": { "enabled": true },
  "presets": {
    "solo": {
      // empty preset
    }
  }
}
`;

const EMPTY_PRESET_EXPECTED = `{
  "marketplace": { "enabled": true },
  "presets": {
    "solo": {
      "marketplace": {
        "agents": [
          "acme/chronicler"
        ]
      },
      "chronicler": {
        "model": [
          {
            "id": "openai/gpt-6"
          }
        ]
      }
      // empty preset
    }
  }
}
`;

test('mixed ordinary edit, selection and creation apply to one reviewed buffer', () => {
  const result = stage(MIXED, {
    changes: [{
      path: ['presets', 'coding', 'agents', 'docs', 'model'],
      models: [{ id: 'openai/gpt-6', variant: '' }],
    }],
    edits: [{
      preset: 'coding',
      packageIds: ['acme/janitor', 'acme/chronicler'],
      creations: [{
        packageId: 'acme/janitor',
        models: [{ id: 'openai/gpt-6', variant: 'high' }],
      }],
    }],
  });
  assert.equal(result.after, MIXED_EXPECTED);
  assert.deepEqual(result.marketplaceBinding, binding());
  assert.deepEqual(result.marketplaceCreations, [{
    preset: 'coding',
    packageId: 'acme/janitor',
    agentName: 'janitor',
    path: ['presets', 'coding', 'agents', 'janitor', 'model'],
    models: [{ id: 'openai/gpt-6', variant: 'high' }],
  }]);
  assert.deepEqual(result.changed, [
    'preset coding · docs',
    'preset coding · marketplace selection',
    'preset coding · janitor (created)',
  ]);
  assert.deepEqual(result.changedIds, [
    '["presets","coding","agents","docs","model"]',
    '["presets","coding","marketplace","agents"]',
    '["presets","coding","agents","janitor","model"]',
  ]);
  const creation = result.changedValues[2];
  assert.equal(creation.before, '');
  assert.equal(creation.label, 'preset coding · janitor (created)');
  assert.ok(result.after.includes(creation.after));

  const parsed = parseConfigDocument(result.after);
  assert.deepEqual(parsed.presets.coding.marketplace.agents,
    ['acme/janitor', 'acme/chronicler']);
  assert.deepEqual(parsed.presets.coding.agents.janitor.model,
    [{ id: 'openai/gpt-6', variant: 'high' }]);
  assert.equal(parsed.presets.coding.agents.docs.prompt, 'SECRET-PROMPT');
  assert.equal(parsed.agents.root.model, 'openai/gpt-5');
});

test('ordinary, primary and marketplace creations in one preset preserve distinct model values and private neighbors', () => {
  const models = id => [{id,variant:''}];
  const request = {
    text: MIXED, groups: enumerateGroupsFromText(MIXED),
    changes: [{path:['presets','coding','agents','docs','model'],models:models('synthetic/docs')}],
    primaryCreations: [{preset:'coding',agent:'orchestrator',models:models('synthetic/primary')}],
    marketplace: marketplace([{preset:'coding',packageIds:['acme/janitor'],creations:[{packageId:'acme/janitor',models:models('synthetic/package')}]}]),
    marketplaceCatalog:catalog(),
  };
  const result = prepareConfigEdit(request);
  const expected = parseConfigDocument(MIXED);
  const preset = expected.presets.coding;
  preset.agents.docs.model = [{id:'synthetic/docs'}];
  preset.agents.orchestrator = {model:[{id:'synthetic/primary'}]};
  preset.agents.janitor = {model:[{id:'synthetic/package'}]};
  preset.marketplace = {agents:['acme/janitor']};
  assert.deepEqual(parseConfigDocument(result.after),expected);
  assert.equal(new Set(result.changedIds).size,4);
  assert.deepEqual(result.marketplaceBinding,binding());
  assert.ok(result.after.includes(', "prompt": "SECRET-PROMPT"'));
  assert.ok(!result.changedValues.some(({before,after}) => `${before}${after}`.includes('SECRET-PROMPT')));
  for (const [name, displayName] of [['build','Other'],['other','Orchestrator']]) {
    const fakeCatalog = catalog();
    Object.assign(fakeCatalog.packages[0],{agentName:name,displayName});
    assert.throws(() => prepareConfigEdit({...request,marketplaceCatalog:fakeCatalog}), {code:'MARKETPLACE_UNSUPPORTED'});
  }
});

test('flat preset creation and selection match an independently written document', () => {
  const result = stage(FLAT, {
    edits: [{
      preset: 'solo',
      packageIds: ['acme/chronicler'],
      creations: [{
        packageId: 'acme/chronicler',
        models: [{ id: 'openai/gpt-6', variant: 'high' }],
      }],
    }],
  });
  assert.equal(result.after, FLAT_EXPECTED);
  assert.equal(result.after.includes('// keep this comment'), true);
  assert.equal(result.after.includes('SECRET-FLAT'), true);
  assert.deepEqual(result.marketplaceCreations[0].path,
    ['presets', 'solo', 'chronicler', 'model']);
});

test('structured tab and CRLF staging preserves line endings and indentation', () => {
  const result = stage(STRUCTURED_CRLF, {
    edits: [{
      preset: 'team',
      packageIds: ['acme/janitor'],
      creations: [{
        packageId: 'acme/janitor',
        models: [
          { id: 'openai/gpt-6', variant: 'low' },
          { id: 'openai/gpt-5', variant: '' },
        ],
      }],
    }],
  });
  assert.equal(result.after, STRUCTURED_CRLF_EXPECTED);
  assert.equal(/(^|[^\r])\n/u.test(result.after), false, 'all line endings stay CRLF');
  assert.equal((result.after.match(/\r\n/gu) || []).length,
    (STRUCTURED_CRLF_EXPECTED.match(/\r\n/gu) || []).length);
  assert.equal(result.after.includes('\t\t\t\t"janitor"'), true);
  assert.equal(result.after.includes('SECRET-STRUCT'), true);
});

test('selection-only update preserves comments, neighbors and ordering', () => {
  const result = stage(SELECTION_ONLY, {
    edits: [{ preset: 'p', packageIds: ['acme/chronicler'], creations: [] }],
  });
  assert.equal(result.after, SELECTION_ONLY_EXPECTED);
  assert.deepEqual(result.changed, ['preset p · marketplace selection']);
  assert.deepEqual(result.marketplaceCreations, []);
  assert.equal(result.changedValues[0].before, '[\n          "acme/janitor"\n        ]');
});

test('missing marketplace and agent parents are created around an empty preset comment', () => {
  const result = stage(EMPTY_PRESET, {
    edits: [{
      preset: 'solo',
      packageIds: ['acme/chronicler'],
      creations: [{
        packageId: 'acme/chronicler',
        models: [{ id: 'openai/gpt-6', variant: '' }],
      }],
    }],
  });
  assert.equal(result.after, EMPTY_PRESET_EXPECTED);
  assert.equal(result.after.includes('// empty preset'), true);
  assert.deepEqual(parseConfigDocument(result.after).presets.solo.marketplace.agents,
    ['acme/chronicler']);
});

test('a semantic marketplace no-op returns the original bytes and a null binding', () => {
  const result = stage(FLAT, {
    edits: [{ preset: 'solo', packageIds: [], creations: [] }],
  });
  assert.equal(result.after, FLAT);
  assert.equal(result.marketplaceBinding, null);
  assert.deepEqual(result.marketplaceCreations, []);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.changedValues, []);
});

test('ordinary-only calls keep legacy bytes and add only null marketplace metadata', () => {
  const text = `{
  "agents": {
    "plain": { "model": "openai/gpt-5" }
  }
}
`;
  const result = prepareConfigEdit({
    text,
    groups: enumerateGroupsFromText(text),
    changes: [{ path: ['agents', 'plain', 'model'], models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  assert.equal(result.after, `{
  "agents": {
    "plain": { "model": [
        {
          "id": "openai/gpt-6"
        }
      ] }
  }
}
`);
  assert.deepEqual(result.changed, ['agent · plain']);
  assert.deepEqual(result.changedValues, [{
    path: ['agents', 'plain', 'model'],
    label: 'agent · plain',
    before: '"openai/gpt-5"',
    after: '[\n        {\n          "id": "openai/gpt-6"\n        }\n      ]',
  }]);
  assert.equal(result.marketplaceBinding, null);
  assert.deepEqual(result.marketplaceCreations, []);
});

test('creation diff has an empty before, an explicit path label and no neighbor leak', () => {
  const result = stage(MIXED, {
    edits: [{
      preset: 'coding',
      packageIds: ['acme/janitor'],
      creations: [{
        packageId: 'acme/janitor',
        models: [{ id: 'openai/gpt-6', variant: 'high' }],
      }],
    }],
  });
  const diff = renderModelValueDiffs({
    fileName: 'config.jsonc',
    blocks: result.changedValues,
  });
  const blocks = diff.split(/^--- /mu).slice(1);
  const creation = blocks.find(block => block.startsWith(
    'config.jsonc presets.coding.agents.janitor.model (current)',
  ));
  assert.ok(creation, diff);
  const removed = creation.split('\n').filter(line => line.startsWith('-'));
  assert.deepEqual(removed, []);
  assert.match(creation, /^\+.*"openai\/gpt-6"/mu);
  assert.doesNotMatch(diff, /SECRET-PROMPT|"prompt"|root comment/u);
});

test('a creation on an existing model queue is rejected without changing bytes', () => {
  const text = `{
    "marketplace": { "enabled": true },
    "presets": { "team": { "agents": { "janitor": { "model": "openai/gpt-5" } } } }
  }`;
  assert.throws(() => stage(text, {
    edits: [{
      preset: 'team',
      packageIds: ['acme/janitor'],
      creations: [{
        packageId: 'acme/janitor',
        models: [{ id: 'openai/gpt-6', variant: '' }],
      }],
    }],
  }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'MARKETPLACE_UNSUPPORTED');
    return true;
  });
});

test('a stale source binding refuses the preview before any bytes are produced', () => {
  const text = FLAT;
  assert.throws(() => prepareConfigEdit({
    text,
    groups: enumerateGroupsFromText(text),
    changes: [],
    marketplace: {
      sourceGeneration: 'gen-old',
      catalogFingerprint: 'fp-1',
      edits: [{ preset: 'solo', packageIds: ['acme/chronicler'], creations: [] }],
    },
    marketplaceCatalog: catalog(),
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'MARKETPLACE_SOURCE_CHANGED');
    return true;
  });
});

function errorOf(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

test('a new selection is blocked by preset and root identities even without a creation', () => {
  const custom = '{"marketplace":{"enabled":true},"presets":{"team":{"agents":{"janitor":{"prompt":"keep"}}}}}';
  assert.equal(errorOf(() => stage(custom, {
    edits: [{ preset: 'team', packageIds: ['acme/janitor'], creations: [] }],
  }))?.code, 'MARKETPLACE_UNSUPPORTED');

  const root = '{"marketplace":{"enabled":true},"presets":{"team":{"agents":{}}},"agents":{"chronicler":{"model":"openai/gpt-5"}}}';
  assert.equal(errorOf(() => stage(root, {
    edits: [{ preset: 'team', packageIds: ['acme/chronicler'], creations: [] }],
  }))?.code, 'MARKETPLACE_UNSUPPORTED');

  const explicitQueue = '{"marketplace":{"enabled":true},"presets":{"team":{"agents":{"janitor":{"model":"openai/gpt-5"}}}}}';
  assert.equal(errorOf(() => stage(explicitQueue, {
    edits: [{ preset: 'team', packageIds: ['acme/janitor'], creations: [] }],
  }))?.code, 'MARKETPLACE_UNSUPPORTED');

  const retained = '{"marketplace":{"enabled":true},"presets":{"team":{"marketplace":{"agents":["acme/janitor"]},"agents":{"janitor":{"prompt":"keep"}}}}}';
  assert.equal(stage(retained, {
    edits: [{ preset: 'team', packageIds: ['acme/janitor'], creations: [] }],
  }).after, retained);

  const edited = stage(explicitQueue, {
    changes: [{
      path: ['presets', 'team', 'agents', 'janitor', 'model'],
      models: [{ id: 'openai/gpt-6', variant: '' }],
    }],
  });
  assert.match(edited.after, /openai\/gpt-6/);
  assert.equal(edited.marketplaceBinding, null);
});

test('the resulting selection cannot exceed 64 after retained unknown ids are appended', () => {
  const unknowns = count => Array.from({ length: count }, (_, index) => `legacy-${index}`);
  const text = ids => JSON.stringify({
    marketplace: { enabled: true },
    presets: { team: { marketplace: { agents: ids }, agents: {} } },
  });
  const edit = { preset: 'team', packageIds: ['acme/janitor'], creations: [] };

  assert.equal(errorOf(() => stage(text(unknowns(64)), { edits: [edit] }))?.code,
    'INVALID_MARKETPLACE');

  const prepared = stage(text(unknowns(63)), { edits: [edit] });
  const after = parseConfigDocument(prepared.after);
  assert.equal(after.presets.team.marketplace.agents.length, 64);
  assert.equal(after.presets.team.marketplace.agents[0], 'acme/janitor');
  assert.deepEqual(after.presets.team.marketplace.agents.slice(1), unknowns(63));

  assert.equal(errorOf(() => stage(text(unknowns(63)), {
    edits: [{
      preset: 'team',
      packageIds: ['acme/janitor'],
      creations: [{
        packageId: 'legacy-0',
        models: [{ id: 'openai/gpt-6', variant: '' }],
      }],
    }],
  }))?.code, 'MARKETPLACE_UNSUPPORTED');
});
