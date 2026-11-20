import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTarget } from '../../src/page/target-context.js';

test('header shows the basename instead of a long directory prefix and retains the complete disclosure path', () => {
  const path = `/isolated/${'long-directory/'.repeat(20)}oh-my-opencode-slim.jsonc`;
  const context = describeTarget({ target: { path, logicalPath: path } });
  assert.equal(context.name, 'oh-my-opencode-slim.jsonc');
  assert.deepEqual(context.paths, [{ label: 'Configuration file', value: path }]);
  assert.equal(context.accessibleLabel, 'Show global OMOS file details for oh-my-opencode-slim.jsonc');
});

test('file details expose both the selected logical path and resolved target when different', () => {
  const context = describeTarget({ target: { logicalPath: '/isolated/selected.jsonc', path: '/isolated/resolved/actual.jsonc' } });
  assert.equal(context.name, 'actual.jsonc');
  assert.deepEqual(context.paths, [
    { label: 'Selected path', value: '/isolated/selected.jsonc' },
    { label: 'Resolved target', value: '/isolated/resolved/actual.jsonc' },
  ]);
});

test('missing or unreadable configuration keeps the explicit selected path available without inventing a resolved target', () => {
  const context = describeTarget({ selectedPath: '/isolated/missing.jsonc' });
  assert.equal(context.name, 'missing.jsonc');
  assert.deepEqual(context.paths, [{ label: 'Selected path', value: '/isolated/missing.jsonc' }]);
  assert.match(context.description, /has not loaded/);
  const retained = describeTarget({ target: { path: '/isolated/last.jsonc' }, unreadable: true });
  assert.match(retained.description, /last successful load/);
});

test('loading and unavailable context are explicit and a basename remains intact as text data', () => {
  assert.equal(describeTarget({ loading: true }).name, 'Loading file');
  assert.equal(describeTarget().name, 'File unavailable');
  assert.deepEqual(describeTarget().paths, []);
  const name = '<synthetic & unicode-配置>.jsonc';
  const context = describeTarget({ selectedPath: `/isolated/${name}`, loading: true });
  assert.equal(context.name, name);
  assert.equal(context.paths[0].value, `/isolated/${name}`);
  assert.match(context.description, /Loading the selected/);
});
