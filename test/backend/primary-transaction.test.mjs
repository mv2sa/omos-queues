import assert from 'node:assert/strict';
import test from 'node:test';
import { enumerateGroupsFromText, prepareConfigEdit } from '../../src/backend/config.js';
import { describePrimarySlots } from '../../src/backend/primary-slots.js';

const stage = (text, primaryCreations, changes = []) => prepareConfigEdit({
  text, groups: enumerateGroupsFromText(text), changes, primaryCreations,
});

test('stages safe flat and structured Orchestrator defaults while preserving metadata and neighbor bytes', () => {
  const flat = '{\n  "presets": {\n    "flat": { "orchestrator": { "prompt": "keep", "description": "private-neighbor" }, "other": { "model": "fixture/other" } }\n  }\n}\n';
  const result = stage(flat, [{ preset: 'flat', agent: 'orchestrator', models: [{ id: 'openai/gpt-5', variant: '' }] }]);
  assert.match(result.after, /"prompt": "keep"/);
  assert.match(result.after, /"description": "private-neighbor"/);
  assert.ok(result.after.includes('"other": { "model": "fixture/other" }'));
  assert.match(result.after, /"model": \[\s*\{\s*"id": "openai\/gpt-5"/);

  const structured = '{\n  "presets": {\n    "structured": { "agents": { "reviewer": { "model": "openai/gpt-4", "prompt": "neighbor" }, "orchestrator": { "description": "preserve" } } }\n  }, "extra": "stay"\n}\n';
  const next = stage(structured, [{ preset: 'structured', agent: 'orchestrator', models: [{ id: 'anthropic/claude-sonnet', variant: 'high' }] }]);
  assert.match(next.after, /"description": "preserve"/);
  assert.match(next.after, /"prompt": "neighbor"/);
  assert.match(next.after, /"extra": "stay"/);
  assert.match(next.after, /"model": \[\s*\{\s*"id": "anthropic\/claude-sonnet"/);
});

test('Build preset queues are read-only, while council Build seats remain ordinary queues', () => {
  const text = '{"presets":{"p":{"build":{"model":"openai/gpt-5"},"agents":{"orchestrator":{"model":"openai/gpt-4"}}}},"council":{"presets":{"p":{"build":{"model":"openai/gpt-4"}}}}}';
  const groups = enumerateGroupsFromText(text);
  const build = groups.find(group => group.path[0] === 'presets');
  assert.ok(build.readOnlyReason);
  assert.doesNotThrow(() => prepareConfigEdit({
    text, groups, changes: [{ path: ['council', 'presets', 'p', 'build', 'model'], models: [{ id: 'openai/gpt-5', variant: '' }] }],
  }));
  assert.throws(() => prepareConfigEdit({
    text, groups, changes: [{ path: build.path, models: [{ id: 'openai/gpt-4', variant: '' }] }],
  }), /OpenCode manages Build/);
  assert.throws(() => stage('{"presets":{"p":{}}}', [{ preset: 'p', agent: 'build', models: ['openai/gpt-5'] }]), /OpenCode manages Build/);
});

test('primary slots reject unsafe, inherited and shadowed identities', () => {
  const unsafe = '{"agents":{"orchestrator":{"model":"openai/gpt-4"}},"presets":{"p":{"agents":{"orchestrator":{"model":"openai/gpt-5","inheritModelFrom":"root"}}}}}';
  const slot = describePrimarySlots({ text: unsafe, groups: enumerateGroupsFromText(unsafe) })
    .find(item => item.preset === 'p' && item.agent === 'orchestrator');
  assert.ok(slot.blockedReason);
  assert.throws(() => stage(unsafe, [{ preset: 'p', agent: 'orchestrator', models: ['openai/gpt-5'] }]),
    { code: 'PRIMARY_SLOT_BLOCKED' });
});

test('ordinary edits cannot bypass primary policy or convert inheritance from scalar to array', () => {
  const changes = models => ({ models: [{ id: 'fixture/new', variant: '' }], path: models });
  for (const [text, path] of [
    ['{"agents":{"build":{"model":"fixture/native"}}}', ['agents','build','model']],
    ['{"agents":{"Build":{"model":"fixture/alias"}}}', ['agents','Build','model']],
    ['{"presets":{"p":{"worker":{"displayName":"Orchestrator","model":"fixture/alias"}}}}', ['presets','p','worker','model']],
    ['{"agents":{"orchestrator":{"model":"fixture/a","inheritModelFrom":"session"}}}', ['agents','orchestrator','model']],
    ['{"presets":{"p":{"orchestrator":{"model":"fixture/a","inheritModelFrom":"session"}}}}', ['presets','p','orchestrator','model']],
    ['{"agents":{"orchestrator":{"model":"root/wins"}},"presets":{"p":{"agents":{"orchestrator":{"model":"fixture/a"}}}}}', ['presets','p','agents','orchestrator','model']],
  ]) {
    const groups = enumerateGroupsFromText(text);
    assert.ok(groups.find(group => group.id === JSON.stringify(path)).readOnlyReason);
    assert.throws(() => prepareConfigEdit({text,groups,changes:[changes(path)]}), {code:'READ_ONLY_PATH'});
  }
});

test('reject mixed, non-agent, aliased and extended layouts before inserting a property', () => {
  for (const preset of [
    {agents:{}, other:{description:'ambiguous'}}, {agents:{prompt:'not a wrapper'}},
    {other:7}, {extends:'other', agents:{}}, {agents:{other:{displayName:'Orchestrator'}}},
  ]) {
    const text = JSON.stringify({presets:{p:preset}});
    assert.throws(() => stage(text,[{preset:'p',agent:'orchestrator',models:[{id:'fixture/new',variant:''}]}]), {code:'PRIMARY_SLOT_BLOCKED'});
  }
});

test('mixed ordinary and primary edits share one narrow result and preserve surrounding comment bytes', () => {
  const text = '{\r\n  "presets": { "p": { "agents": { "worker": { "model": "old/model",  /* keep */ "prompt": "private-canary" } } } }\r\n}\r\n';
  const result = stage(text,[{preset:'p',agent:'orchestrator',models:[{id:'new/primary',variant:''}]}],
    [{path:['presets','p','agents','worker','model'],models:[{id:'new/worker',variant:'low'}]}]);
  assert.deepEqual(result.changed, ['preset p · worker','preset p · orchestrator']);
  assert.ok(result.after.includes(',  /* keep */ "prompt": "private-canary"'));
  assert.ok(!result.changedValues.some(item => (item.before + item.after).includes('private-canary')));
  assert.equal(result.after.replaceAll('\r\n','').includes('\n'),false);
  assert.equal(enumerateGroupsFromText(result.after).length,2);
});
