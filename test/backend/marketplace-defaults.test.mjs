import assert from 'node:assert/strict';
import test from 'node:test';
import { describeMarketplaceConfig } from '../../src/backend/marketplace-config.js';
import { enumerateGroupsFromText, parseConfigDocument, prepareConfigEdit } from '../../src/backend/config.js';

const catalog = { state: 'ready', generation: 'source', fingerprint: 'a'.repeat(64), packages: [
  { id: 'acme/cleaner', version: '1.0.0', agentName: 'cleaner', displayName: 'Cleaner', modelSource: 'session', digest: 'b'.repeat(64), blockedReason: null },
] };
const config = () => ({ preset: 'coding', presets: { coding: { agents: { worker: { model: 'fixture/old' } } } } });

test('omitted and empty marketplace master settings use the native enabled default without materializing it', () => {
  for (const root of [undefined, {}, { enabled: true }, { enabled: false }, null, { enabled: 'true' }]) {
    const document = config(); if (root !== undefined) document.marketplace = root;
    const text = JSON.stringify(document); const groups = enumerateGroupsFromText(text);
    const expected = root === undefined || (root !== null && (root.enabled === undefined || root.enabled === true));
    const view = describeMarketplaceConfig({ text, groups, catalog });
    assert.equal(view.masterEnabled, expected);
    assert.equal(view.presets[0].editable, expected);
    if (root !== undefined) continue;
    const prepared = prepareConfigEdit({ text, groups, changes: [], marketplaceCatalog: catalog,
      marketplace: { sourceGeneration: catalog.generation, catalogFingerprint: catalog.fingerprint,
        edits: [{ preset: 'coding', packageIds: ['acme/cleaner'], creations: [] }] } });
    const after = parseConfigDocument(prepared.after);
    assert.equal(Object.hasOwn(after, 'marketplace'), false, 'never write a master-enable setting');
    assert.deepEqual(after.presets.coding.marketplace.agents, ['acme/cleaner']);
    assert.deepEqual(after.presets.coding.agents, document.presets.coding.agents);
  }
});
