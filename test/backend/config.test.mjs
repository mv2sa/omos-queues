import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enumerateGroups,
  enumerateGroupsFromText,
  hashText,
  parseConfigDocument,
  prepareConfigEdit,
} from '../../src/backend/config.js';
import { renderModelValueDiffs } from '../../src/backend/diff.js';
import { SAMPLE_CONFIG } from './helpers.mjs';

const group = (path, models, extra = {}) => ({
  id: JSON.stringify(path), path, models, readOnlyReason: null, ...extra,
});

test('enumerates every supported queue shape in file order with honest read-only reasons', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  assert.deepEqual(groups.map(item => ({
    path: item.path, label: item.label, section: item.section, kind: item.kind,
    defaultVariant: item.defaultVariant, models: item.models, readOnlyReason: item.readOnlyReason,
  })), [
    {
      path: ['presets', 'coding', 'build', 'model'], label: 'preset coding · build',
      section: 'Preset · coding', kind: 'preset', defaultVariant: 'high',
      models: [{ id: 'openai/gpt-5', variant: '' }],
      readOnlyReason: 'OpenCode manages Build; adding an OMOS queue could register a different agent.',
    },
    {
      path: ['presets', 'coding', 'review', 'model'], label: 'preset coding · review',
      section: 'Preset · coding', kind: 'preset', defaultVariant: '',
      models: [
        { id: 'anthropic/claude-sonnet-4', variant: '' },
        { id: 'google/gemini-2.5-pro', variant: 'low' },
      ],
      readOnlyReason: null,
    },
    {
      path: ['presets', 'coding', 'agents', 'docs', 'model'], label: 'preset coding · docs',
      section: 'Preset · coding', kind: 'preset', defaultVariant: '',
      models: [{ id: 'openai/gpt-5-mini', variant: '' }], readOnlyReason: null,
    },
    {
      path: ['presets', 'legacy', 'pair', 'model'], label: 'preset legacy · pair',
      section: 'Preset · legacy', kind: 'preset', defaultVariant: '',
      models: [{ id: 'openai/gpt-5', variant: '' }], readOnlyReason: null,
    },
    {
      path: ['presets', 'legacy', 'broken', 'model'], label: 'preset legacy · broken',
      section: 'Preset · legacy', kind: 'preset', defaultVariant: '',
      models: [], readOnlyReason: 'Model must be a provider/model string or a list of them.',
    },
    {
      path: ['agents', 'explore', 'model'], label: 'agent · explore', section: 'Agents',
      kind: 'agent', defaultVariant: 'low',
      models: [{ id: '${env:EXPLORE_MODEL}', variant: '' }],
      readOnlyReason: 'Contains unexpanded environment placeholders.',
    },
    {
      path: ['agents', 'custom', 'model'], label: 'agent · custom', section: 'Agents',
      kind: 'agent', defaultVariant: '',
      models: [{ id: 'openai/gpt-5', variant: '' }], readOnlyReason: null,
    },
    {
      path: ['agents', 'helper', 'model'], label: 'agent · helper', section: 'Agents',
      kind: 'agent', defaultVariant: '',
      models: [{ id: 'openai/gpt-5', variant: '' }],
      readOnlyReason: 'Contains unsupported model entry properties.',
    },
    {
      path: ['agents', 'plain', 'model'], label: 'agent · plain', section: 'Agents',
      kind: 'agent', defaultVariant: '',
      models: [{ id: 'openai/gpt-5', variant: '' }], readOnlyReason: null,
    },
    {
      path: ['council', 'presets', 'board', 'seat1', 'model'], label: 'council board seat · seat1',
      section: 'Council seats · board', kind: 'council', defaultVariant: '',
      models: [{ id: 'openai/gpt-5', variant: '' }], readOnlyReason: null,
    },
    {
      path: ['council', 'presets', 'board', 'seat2', 'model'], label: 'council board seat · seat2',
      section: 'Council seats · board', kind: 'council', defaultVariant: '',
      models: [{ id: 'anthropic/claude-sonnet-4', variant: '' }], readOnlyReason: null,
    },
  ]);
});

test('file-order enumeration matches the parsed view and keeps numeric names in file order', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  assert.deepEqual(enumerateGroupsFromText(SAMPLE_CONFIG), groups);

  const numeric = '{"agents":{"10":{"model":"openai/gpt-5"},"2":{"model":"openai/gpt-5"}}}';
  assert.deepEqual(enumerateGroupsFromText(numeric).map(group => group.name), ['10', '2']);
});

test('long queues stay visible and read-only instead of being truncated', () => {
  const models = Array.from({ length: 51 }, (_, index) => `openai/model-${index}`);
  const config = parseConfigDocument(JSON.stringify({ agents: { long: { model: models } } }));
  const [queue] = enumerateGroups(config);
  assert.equal(queue.models.length, 51);
  assert.match(queue.readOnlyReason, /50-position editing limit/);
});

test('malformed JSONC and duplicate keys prevent writes with actionable errors', () => {
  assert.throws(() => parseConfigDocument('{ "agents": {'), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'CONFIG_INVALID');
    return true;
  });
  assert.throws(() => parseConfigDocument('{ "agents": {}, "agents": {} }'), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'CONFIG_DUPLICATE_KEYS');
    assert.match(error.message, /"agents"/);
    return true;
  });
  assert.throws(() => parseConfigDocument('[]'), /top level/);
});

test('semantic no-ops return the original bytes untouched', () => {
  const config = parseConfigDocument(SAMPLE_CONFIG);
  const groups = enumerateGroups(config);
  const pair = groups.find(item => item.name === 'pair');
  const result = prepareConfigEdit({
    text: SAMPLE_CONFIG,
    groups,
    changes: [{ path: pair.path, models: pair.models }],
  });
  assert.equal(result.after, SAMPLE_CONFIG);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.changedValues, []);
});

test('nested two-space objects diff the exact edited AST slice with real indentation', () => {
  const text = `{
  "presets": {
    "coding": {
      "build": {
        "model": "openai/gpt-5",
        "variant": "high"
      },
      "review": {
        "model": [
          {
            "id": "anthropic/claude-sonnet-4"
          },
          {
            "id": "openai/gpt-5"
          }
        ]
      }
    }
  }
}
`;
  const groups = enumerateGroups(parseConfigDocument(text));
  const review = groups.find(item => item.name === 'review');
  const result = prepareConfigEdit({
    text,
    groups,
    changes: [{
      path: review.path,
      models: [
        { id: 'anthropic/claude-sonnet-4', variant: '' },
        { id: 'google/gemini-2.5-pro', variant: '' },
      ],
    }],
  });
  const slice = result.changedValues[0].after;
  assert.equal(slice, [
    '[',
    '          {',
    '            "id": "anthropic/claude-sonnet-4"',
    '          },',
    '          {',
    '            "id": "google/gemini-2.5-pro"',
    '          }',
    '        ]',
  ].join('\n'));
  assert.ok(result.after.includes(slice), 'changedValues.after is the actual final AST slice');
  const diff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: result.changedValues });
  const removed = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'));
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));
  assert.deepEqual(removed, ['-            "id": "openai/gpt-5"']);
  assert.deepEqual(added, ['+            "id": "google/gemini-2.5-pro"']);
  assert.equal(diff.includes('-  {'), false, 'no synthetic two-space serializer indentation');
  assert.equal(diff.includes('+  {'), false);
});

test('tab-indented CRLF council edits keep leading tabs and leak no carriage returns', () => {
  const text = '{\r\n\t"council": {\r\n\t\t"presets": {\r\n\t\t\t"board": {\r\n\t\t\t\t"seat1": {\r\n\t\t\t\t\t"model": [\r\n\t\t\t\t\t\t{\r\n\t\t\t\t\t\t\t"id": "openai/gpt-5"\r\n\t\t\t\t\t\t}\r\n\t\t\t\t\t]\r\n\t\t\t\t}\r\n\t\t\t}\r\n\t\t}\r\n\t}\r\n}\r\n';
  const groups = enumerateGroups(parseConfigDocument(text));
  const seat = groups.find(item => item.name === 'seat1');
  const result = prepareConfigEdit({
    text,
    groups,
    changes: [{ path: seat.path, models: [{ id: 'google/gemini-2.5-pro', variant: '' }] }],
  });
  const slice = result.changedValues[0].after;
  assert.equal(slice, [
    '[',
    '\t\t\t\t\t\t{',
    '\t\t\t\t\t\t\t\"id\": \"google/gemini-2.5-pro\"',
    '\t\t\t\t\t\t}',
    '\t\t\t\t\t]',
  ].join('\r\n'));
  assert.ok(result.after.includes(slice));
  assert.equal(/(^|[^\r])\n/.test(result.after), false, 'all line endings stay CRLF');
  assert.equal((result.after.match(/\r\n/g) || []).length, (text.match(/\r\n/g) || []).length);
  const diff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: result.changedValues });
  assert.equal(diff.includes('\r'), false, 'diff lines carry no carriage returns');
  const removed = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'));
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));
  assert.deepEqual(removed, ['-\t\t\t\t\t\t\t"id": "openai/gpt-5"']);
  assert.deepEqual(added, ['+\t\t\t\t\t\t\t"id": "google/gemini-2.5-pro"']);
  assert.equal(/^[-+] +\{/m.test(diff), false, 'no synthetic spaces before the edited value');
});

test('string-array edits use the actual expanded AST slice and real indentation', () => {
  const text = `{
  "presets": {
    "coding": {
      "review": {
        "model": [
          "anthropic/claude-sonnet-4",
          "openai/gpt-5"
        ]
      }
    }
  }
}
`;
  const groups = enumerateGroups(parseConfigDocument(text));
  const review = groups.find(item => item.name === 'review');
  const result = prepareConfigEdit({
    text,
    groups,
    changes: [{
      path: review.path,
      models: [
        { id: 'anthropic/claude-sonnet-4', variant: '' },
        { id: 'google/gemini-2.5-pro', variant: '' },
      ],
    }],
  });
  const slice = result.changedValues[0].after;
  assert.equal(slice, [
    '[',
    '          {',
    '            "id": "anthropic/claude-sonnet-4"',
    '          },',
    '          {',
    '            "id": "google/gemini-2.5-pro"',
    '          }',
    '        ]',
  ].join('\n'));
  assert.ok(result.after.includes(slice));
  const diff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: result.changedValues });
  assert.match(diff, /^\+          \{$/m);
  assert.match(diff, /^\+            "id": "google\/gemini-2\.5-pro"$/m);
  assert.equal(diff.includes('+  {'), false);
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));
  assert.ok(added.length > 1, 'string-to-object expansion stays legitimately multi-line');
});

test('one mixed-shape edit leaves every other queue byte and default unchanged', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  const seat = groups.find(item => item.name === 'seat1');
  const result = prepareConfigEdit({
    text: SAMPLE_CONFIG,
    groups,
    changes: [{ path: seat.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  assert.equal(result.changedValues.length, 1);
  assert.ok(result.after.includes(result.changedValues[0].after));
  assert.match(result.after, /"description": "Custom agent",/);
  assert.match(result.after, /"prompt": "synthetic-private-text",/);
  assert.match(result.after, /"docs": \{ "model": "openai\/gpt-5-mini" \}/);
  assert.match(result.after, /"pair": \{ "model": "openai\/gpt-5" \}/);

  const afterGroups = new Map(
    enumerateGroups(parseConfigDocument(result.after)).map(item => [item.id, item]),
  );
  for (const before of groups) {
    const next = afterGroups.get(before.id);
    assert.ok(next, before.id);
    if (before.id === seat.id) {
      assert.deepEqual(next.models, [{ id: 'openai/gpt-6', variant: '' }]);
      continue;
    }
    assert.deepEqual(next.models, before.models, before.id);
    assert.equal(next.defaultVariant, before.defaultVariant, before.id);
    assert.equal(next.readOnlyReason, before.readOnlyReason, before.id);
  }
  const diff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: result.changedValues });
  assert.match(diff, /^\+.*"openai\/gpt-6"/m);
  assert.doesNotMatch(diff, /Custom agent|synthetic-private-text|openai\/gpt-5-mini|pair/);
});

test('edits preserve CRLF, indentation, comments and untouched queues exactly', () => {
  const text = '{\r\n\t"presets": {\r\n\t\t"p": {\r\n\t\t\t"a": { "model": "openai/gpt-5", "variant": "high" } // keep\r\n\t\t}\r\n\t},\r\n\t"agents": {\r\n\t\t"b": { "model": "openai/gpt-5" }\r\n\t}\r\n}\r\n';
  const groups = enumerateGroups(parseConfigDocument(text));
  const result = prepareConfigEdit({
    text,
    groups,
    changes: [{
      path: ['presets', 'p', 'a', 'model'],
      models: [{ id: 'anthropic/claude', variant: '' }, { id: 'google/gemini', variant: 'low' }],
    }],
  });
  assert.equal(/(^|[^\r])\n/.test(result.after), false, 'all line endings stay CRLF');
  assert.match(result.after, /\/\/ keep/);
  assert.match(result.after, /"variant": "high"/);
  assert.match(result.after, /"agents": \{\r\n\t\t"b": \{ "model": "openai\/gpt-5" \}\r\n\t\}/);
  const after = enumerateGroups(parseConfigDocument(result.after));
  const agent = after.find(item => item.name === 'b');
  assert.deepEqual(agent.models, [{ id: 'openai/gpt-5', variant: '' }]);
  assert.deepEqual(after.find(item => item.name === 'a').models,
    [{ id: 'anthropic/claude', variant: '' }, { id: 'google/gemini', variant: 'low' }]);
  assert.deepEqual(result.changed, ['preset p · a']);
});

test('rejects unknown, repeated, read-only and over-limit edits', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  const build = groups.find(item => item.name === 'build');
  const editable = groups.find(item => item.name === 'review');
  const run = changes => {
    try {
      prepareConfigEdit({ text: SAMPLE_CONFIG, groups, changes });
      return null;
    } catch (error) {
      return error;
    }
  };
  assert.equal(run([{ path: ['agents', 'nope', 'model'], models: build.models }]).code, 'UNKNOWN_PATH');
  assert.equal(run([
    { path: ['council', 'presets', 'board', 'seat1', 'model'], models: [{ id: 'openai/gpt-5', variant: '' }] },
    { path: ['council', 'presets', 'board', 'seat1', 'model'], models: [{ id: 'openai/gpt-5', variant: '' }] },
  ]).code, 'DUPLICATE_PATH');
  assert.equal(run([{ path: ['agents', 'explore', 'model'], models: build.models }]).code, 'READ_ONLY_PATH');
  assert.equal(run([{ path: editable.path, models: Array.from({ length: 51 }, () => editable.models[0]) }]).code,
    'INVALID_MODELS');
  assert.equal(run([{ path: editable.path, models: [{ id: 'not-a-model', variant: '' }] }]).code,
    'INVALID_MODELS');
  assert.equal(run([{ path: editable.path, models: [{ id: 'openai/gpt-5' }] }]).code, 'INVALID_MODELS');
  assert.equal(run([{ path: editable.path, models: [{ id: 'openai/gpt-5', variant: 'x'.repeat(501) }] }]).code,
    'INVALID_MODELS');
});

test('diff shows only edited lines and no neighboring settings', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  const result = prepareConfigEdit({
    text: SAMPLE_CONFIG,
    groups,
    changes: [{ path: ['council', 'presets', 'board', 'seat1', 'model'], models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  const diff = renderModelValueDiffs({
    fileName: 'config.jsonc',
    blocks: result.changedValues,
  });
  assert.match(diff, /^--- config\.jsonc council\.presets\.board\.seat1\.model \(current\)\n\+\+\+ config\.jsonc council\.presets\.board\.seat1\.model \(edited\)\n/m);
  assert.match(diff, /^-"openai\/gpt-5"/m);
  assert.match(diff, /^\+.*openai\/gpt-6/m);
  assert.doesNotMatch(diff, /seat2/);
  assert.doesNotMatch(diff, /anthropic\/claude-sonnet-4/);
  assert.equal(renderModelValueDiffs({ fileName: 'config.jsonc', blocks: [] }), '');
});

test('legitimate agent metadata stays editable, byte-preserved and outside the diff', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  const custom = groups.find(item => item.name === 'custom');
  assert.equal(custom.readOnlyReason, null);
  const result = prepareConfigEdit({
    text: SAMPLE_CONFIG,
    groups,
    changes: [{ path: custom.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  assert.match(result.after, /"description": "Custom agent",/);
  assert.match(result.after, /"prompt": "synthetic-private-text",/);
  assert.match(result.after, /"skills": \["memory"\],/);
  assert.match(result.after, /"options": \{ "temperature": 0\.2 \}/);
  const diff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: result.changedValues });
  assert.match(diff, /openai\/gpt-6/);
  assert.doesNotMatch(diff, /Custom agent|synthetic-private-text|skills|temperature/);
  assert.equal(result.changedValues.length, 1);
  assert.equal(result.changedValues[0].path.join('.'), 'agents.custom.model');
});

test('distant and same-line neighboring secrets never reach the diff', () => {
  const filler = Array.from({ length: 650 }, (_, index) => `    // filler line ${index}`).join('\n');
  const spaced = `{
  "agents": {
    "a": { "model": "openai/gpt-5", "prompt": "SECRET-CANARY-A" },
${filler}
    "b": { "model": "openai/gpt-5", "prompt": "SECRET-CANARY-B" }
  }
}
`;
  const spacedGroups = enumerateGroups(parseConfigDocument(spaced));
  const b = spacedGroups.find(item => item.name === 'b');
  const spacedResult = prepareConfigEdit({
    text: spaced, groups: spacedGroups, changes: [{ path: b.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  const spacedDiff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: spacedResult.changedValues });
  assert.match(spacedDiff, /openai\/gpt-6/);
  assert.doesNotMatch(spacedDiff, /SECRET-CANARY-A|SECRET-CANARY-B|filler line/);

  const minified = '{"agents":{"a":{"model":"openai/gpt-5","prompt":"SECRET-SAME"},"b":{"model":"openai/gpt-5","prompt":"SECRET-OTHER"}}}';
  const minifiedGroups = enumerateGroups(parseConfigDocument(minified));
  const a = minifiedGroups.find(item => item.name === 'a');
  const minifiedResult = prepareConfigEdit({
    text: minified, groups: minifiedGroups, changes: [{ path: a.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  const minifiedDiff = renderModelValueDiffs({ fileName: 'config.jsonc', blocks: minifiedResult.changedValues });
  assert.match(minifiedDiff, /openai\/gpt-6/);
  assert.doesNotMatch(minifiedDiff, /SECRET-SAME|SECRET-OTHER|prompt/);
});

test('an oversized edited value refuses the preview instead of dumping neighbors', () => {
  const huge = `/*${'x'.repeat(70 * 1024)}*/`;
  const text = `{"agents":{"big":{"model":[${huge}"openai/gpt-5"],"prompt":"SECRET-NEIGHBOR"}}}`;
  const groups = enumerateGroups(parseConfigDocument(text));
  const big = groups.find(item => item.name === 'big');
  assert.equal(big.readOnlyReason, null);
  const result = prepareConfigEdit({
    text, groups, changes: [{ path: big.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  assert.throws(() => renderModelValueDiffs({ fileName: 'config.jsonc', blocks: result.changedValues }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'PREVIEW_TOO_LARGE');
    assert.doesNotMatch(error.message, /x{50}|SECRET-NEIGHBOR/);
    return true;
  });
});

test('comments inside the edited value stay reviewable as removals', () => {
  const text = '{"agents":{"c":{"model":[/* keep-me */"openai/gpt-5"],"prompt":"SECRET"}}}';
  const groups = enumerateGroups(parseConfigDocument(text));
  const c = groups.find(item => item.name === 'c');
  const result = prepareConfigEdit({
    text, groups, changes: [{ path: c.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  const diff = renderModelValueDiffs({ fileName: 'c.jsonc', blocks: result.changedValues });
  assert.match(diff, /^-.*keep-me/m);
  assert.match(diff, /\+.*openai\/gpt-6/m);
  assert.doesNotMatch(diff, /SECRET/);
});

test('unsupported existing variants are read-only and placeholders cannot be introduced', () => {
  const text = JSON.stringify({
    agents: {
      long: { model: [{ id: 'openai/gpt-5', variant: 'v'.repeat(501) }] },
      dollar: { model: [{ id: 'openai/gpt-5', variant: '${env:V}' }] },
      omos: { model: 'openai/{env:MODEL}' },
      doubled: { model: 'openai/gpt-5', variant: 'a\nb' },
    },
  });
  const groups = enumerateGroups(parseConfigDocument(text));
  const byName = name => groups.find(item => item.name === name);
  assert.match(byName('long').readOnlyReason, /variant/);
  assert.match(byName('dollar').readOnlyReason, /placeholders/);
  assert.match(byName('omos').readOnlyReason, /placeholders/);
  assert.match(byName('doubled').readOnlyReason, /default variant/);

  const plain = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG)).find(item => item.name === 'plain');
  const attempt = models => {
    try {
      prepareConfigEdit({ text: SAMPLE_CONFIG, groups: enumerateGroups(parseConfigDocument(SAMPLE_CONFIG)),
        changes: [{ path: plain.path, models }] });
      return null;
    } catch (error) {
      return error;
    }
  };
  assert.equal(attempt([{ id: 'openai/{env:MODEL}', variant: '' }]).code, 'INVALID_MODELS');
  assert.equal(attempt([{ id: 'openai/gpt-5', variant: '${env:V}' }]).code, 'INVALID_MODELS');
  assert.equal(attempt([{ id: 'bad model/x', variant: '' }]).code, 'INVALID_MODELS');
  assert.equal(attempt([{ id: 'openai/gpt 5', variant: '' }]).code, 'INVALID_MODELS');
  assert.equal(attempt([{ id: 'openai/gpt-5\u0000', variant: '' }]).code, 'INVALID_MODELS');
  assert.equal(attempt([{ id: 'openai/gpt-5', variant: 'x'.repeat(501) }]).code, 'INVALID_MODELS');
});

test('providers accept OMOS-compatible non-whitespace tokens', () => {
  const text = '{"agents":{"scoped":{"model":"@scope/model-name"},"plus":{"model":"provider+tag/model@v1"}}}';
  const groups = enumerateGroups(parseConfigDocument(text));
  assert.equal(groups.every(group => group.readOnlyReason === null), true);
  const scoped = groups.find(item => item.name === 'scoped');
  const result = prepareConfigEdit({
    text, groups, changes: [{ path: scoped.path, models: [{ id: '@scope/other-name', variant: '' }] }],
  });
  assert.match(renderModelValueDiffs({ fileName: 'c.jsonc', blocks: result.changedValues }), /@scope\/other-name/);
});

test('group ids are stable JSON paths and hashes are sha256 hex', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  const build = groups.find(item => item.name === 'build');
  assert.equal(build.id, '["presets","coding","build","model"]');
  assert.match(hashText(SAMPLE_CONFIG), /^[0-9a-f]{64}$/);
  assert.deepEqual(group(build.path, build.models).path, build.path);
});

test('a mixed structured/flat preset refuses marketplace staging but stays ordinarily editable', () => {
  const text = SAMPLE_CONFIG.replace(
    '{\n  "presets"',
    '{\n  "marketplace": { "enabled": true },\n  "presets"',
  );
  const groups = enumerateGroups(parseConfigDocument(text));
  const build = groups.find(item => item.name === 'review');
  const catalog = {
    state: 'ready',
    generation: 'gen-1',
    fingerprint: 'fp-1',
    packages: [{
      id: 'acme/janitor',
      version: '1.2.3',
      agentName: 'janitor',
      displayName: 'Janitor',
      modelSource: 'session',
      digest: 'a'.repeat(64),
      blockedReason: null,
    }],
  };
  assert.throws(() => prepareConfigEdit({
    text,
    groups,
    changes: [],
    marketplace: {
      sourceGeneration: 'gen-1',
      catalogFingerprint: 'fp-1',
      edits: [{ preset: 'coding', packageIds: ['acme/janitor'], creations: [] }],
    },
    marketplaceCatalog: catalog,
  }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'MARKETPLACE_UNSUPPORTED');
    assert.match(error.message, /mixes structured and flat/);
    return true;
  });

  const ordinary = prepareConfigEdit({
    text,
    groups,
    changes: [{ path: build.path, models: [{ id: 'openai/gpt-6', variant: '' }] }],
  });
  assert.match(ordinary.after, /openai\/gpt-6/);
  assert.equal(ordinary.marketplaceBinding, null);
});

test('an explicit null marketplace keeps legacy bytes and metadata identical to omission', () => {
  const groups = enumerateGroups(parseConfigDocument(SAMPLE_CONFIG));
  const custom = groups.find(item => item.name === 'custom');
  const change = { path: custom.path, models: [{ id: 'openai/gpt-6', variant: '' }] };
  const omitted = prepareConfigEdit({ text: SAMPLE_CONFIG, groups, changes: [change] });
  const explicit = prepareConfigEdit({
    text: SAMPLE_CONFIG,
    groups,
    changes: [change],
    marketplace: null,
  });
  assert.equal(explicit.after, omitted.after);
  assert.deepEqual(explicit.changedValues, omitted.changedValues);
  assert.equal(explicit.marketplaceBinding, null);
  assert.deepEqual(explicit.marketplaceCreations, []);
  assert.match(explicit.after, /"prompt": "synthetic-private-text"/);
});
