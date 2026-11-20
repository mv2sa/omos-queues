import test from 'node:test';
import assert from 'node:assert/strict';
import { validModelId, validModels } from '../../src/page/editor-state.js';

test('editor and service accept the same OMOS provider tokens', () => {
  for (const id of ['@scope/model', 'provider+tag/model@v1', 'provider/name/child']) {
    assert.equal(validModelId(id), true, id);
    assert.equal(validModels([{ id, variant: 'adaptive=budget' }]), true, id);
  }
  for (const id of ['', '/model', 'provider/', 'provider/model with space',
    'provider/${env:MODEL}', '{env:PROVIDER}/model', 'provider/model\n']) {
    assert.equal(validModelId(id), false, JSON.stringify(id));
  }
});

test('invalid or interpolated variants cannot replace an earlier recoverable draft', () => {
  assert.equal(validModels([{ id: 'synthetic/model', variant: 'x'.repeat(500) }]), true);
  for (const variant of ['x'.repeat(501), 'line\nbreak', '\u0001', '${env:EFFORT}', '{env:EFFORT}']) {
    assert.equal(validModels([{ id: 'synthetic/model', variant }]), false, JSON.stringify(variant));
  }
});
