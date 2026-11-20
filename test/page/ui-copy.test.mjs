import test from 'node:test';
import assert from 'node:assert/strict';
import { favoritesStatus, mountFavoritesPanel } from '../../src/page/favorites-panel.js';
import { createFavoriteSourceController } from '../../src/page/favorites.js';
import { marketplaceSourceStatus } from '../../src/page/marketplace-panel.js';
import { variantOptions } from '../../src/page/editor-state.js';
import { primarySlotExplanation, primaryReviewNotice, queueContext, pickerSearchPresentation } from '../../src/page/workspace-metadata.js';

test('the first Orchestrator model is only staged and blocked reasons are preserved', () => {
  assert.match(primarySlotExplanation({ category: 'orchestrator', slot: { canCreate: true } }), /stage an override/);
  const blockedReason = 'The preset inherits its model and cannot be staged.';
  assert.equal(primarySlotExplanation({ category: 'orchestrator', slot: { canCreate: false, blockedReason } }), blockedReason);
  assert.match(primarySlotExplanation({ category: 'orchestrator', preset: null }), /No explicit queue or supported preset/);
});

test('the staging limit copy explains how to continue, and new defaults alone show the inheritance warning', () => {
  const entry = { category: 'orchestrator', slot: { canCreate: true } };
  assert.match(primarySlotExplanation(entry, { primaryCreations: Array(64) }), /64 Orchestrator overrides.*Review and save, or reset one/);
  assert.doesNotMatch(primarySlotExplanation(entry, { primaryCreations: Array(63) }), /64/);
  assert.equal(primaryReviewNotice({ changes: [{ path: ['agents', 'worker', 'model'] }] }), '');
  assert.equal(primaryReviewNotice({ primaryCreations: [] }), '');
  assert.match(primaryReviewNotice({ primaryCreations: [{ preset: 'quality' }] }), /default in the global file.*agents in that preset that inherit it/);
});

test('compact model metadata shows only configured defaults; the selector still explains inheritance', () => {
  const group = { models: [{}], defaultVariant: 'high', section: 'Agents' };
  assert.equal(queueContext({ category: 'regular', group }), 'Agents · 1 position · Default variant: high');
  assert.equal(queueContext({ category: 'orchestrator', preset: 'quality', group: { ...group, models: [{}, {}, {}], defaultVariant: '' } }),
    'Preset quality · 3 positions');
  assert.equal(variantOptions('', '')[0].label, 'Inherit (no explicit variant)');
});

test('favorites counts are concise while read/write failure guidance is preserved', () => {
  assert.equal(favoritesStatus({ loaded: true, record: { models: [{}] } }), '1 extension favorite');
  assert.equal(favoritesStatus({ loaded: true, record: { models: [] } }), '0 extension favorites');
  assert.equal(favoritesStatus({ readError: 'Read failed. Retry favorites read.' }), 'Read failed. Retry favorites read.');
  assert.equal(favoritesStatus({ writeError: 'Write failed. Retry favorites save.' }), 'Write failed. Retry favorites save.');
});

test('the SDK favorites source field retains typing across updates and adopts a normalized path only after saving', async t => {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; }
    children = []; dataset = {}; attributes = new Map(); className = '';
    get parentNode() { return this.parent; }
    append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
    prepend(child) { this.children.unshift(child); child.parent = this; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    find(match) { return match(this) ? this : this.children.map(child => child.find(match)).find(Boolean); }
    contains(node) { return Boolean(this.find(child => child === node)); }
    querySelector(selector) { return this.children.map(child => child.find(node => selector.startsWith('.')
      ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector)).find(Boolean); }
  }
  class Input extends Element {
    writes = 0; currentValue = '';
    get value() { return this.currentValue; }
    set value(value) { this.currentValue = value; this.writes += 1; }
  }
  const globals = { document: { activeElement: null, createElement: tag => tag === 'input' ? new Input(tag) : new Element(tag),
    getElementById: () => new Element('style') }, HTMLStyleElement: Element, HTMLInputElement: Input };
  const prior = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(prior)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  Object.assign(globalThis, globals);
  let settings = { filePath: '', generation: '0' };
  let panel;
  const source = createFavoriteSourceController({ onChange: () => panel?.update(), async request(route, body) {
    if (route === '/favorites/source') {
      if (body?.filePath === 'relative.json') throw new Error('Use an absolute path.');
      if (body) settings = { filePath: body.filePath.replace('/./', '/'), generation: settings.generation + '1' };
      return settings;
    }
    if (!settings.filePath) return { generation: settings.generation, state: 'not-configured', error: { message: 'No source path.' } };
    return { generation: settings.generation, state: 'ready', sourceKind: 'openchamber-preferences-v1',
      favoriteModels: [], fingerprint: 'synthetic', readAt: 123, updatedAt: null };
  } });
  const root = new Element('div');
  await source.refresh();
  panel = mountFavoritesPanel(root, { source, favorites: { getState: () => ({ loaded: true, record: { models: [] } }) },
    getCatalog: () => ({ state: 'ready', flat: [] }), onImport() {} });
  t.after(() => panel.dispose());
  const input = root.querySelector('input');
  const current = root.querySelector('.favorite-current-source');
  function type(value) {
    input.value = value;
    const writes = input.writes;
    input.dispatchEvent(new Event('input'));
    assert.equal(input.writes, writes, 'the input event does not repaint its field');
  }
  async function press(label) {
    root.find(node => node.tag === 'button' && node.children.some(child => child.textContent === label)).dispatchEvent(new Event('click'));
    await new Promise(resolve => setImmediate(resolve));
  }
  type('/profile/preferences.json');
  await press('Save source');
  assert.equal(input.value, '/profile/preferences.json');
  assert.equal(current.hidden, true);

  type('/profile/./new.json');
  await press('Refresh source');
  assert.equal(input.value, '/profile/./new.json');
  assert.equal(current.querySelector('code').textContent, '/profile/preferences.json');
  await press('Save source');
  assert.equal(input.value, '/profile/new.json');
  assert.equal(current.hidden, true);

  type('relative.json');
  await press('Save source');
  assert.equal(input.value, 'relative.json');
  assert.equal(current.hidden, false);
  assert.equal(current.querySelector('code').textContent, '/profile/new.json');
  assert.equal(root.find(node => node.getAttribute('role') === 'alert').textContent, 'Use an absolute path.');
});

test('picker partial matches show counts without an irrelevant format or catalog warning', () => {
  const ids = ['fixture/alpha', 'fixture/beta'];
  assert.deepEqual(pickerSearchPresentation('fixt', ids, 2), { status: '2 models', useEnteredId: false });
  assert.deepEqual(pickerSearchPresentation(' fixture/alpha ', ids.slice(0, 1), 1), { status: '1 model', useEnteredId: false });
  assert.deepEqual(pickerSearchPresentation('fixture/b', ids.slice(1), 1), { status: '1 model', useEnteredId: true });
});

test('picker unmatched input makes one distinction between format help and a valid manual ID', () => {
  assert.deepEqual(pickerSearchPresentation('missing/', [], 0), { status: 'Enter a complete provider/model ID.', useEnteredId: false });
  assert.deepEqual(pickerSearchPresentation('missing/id', [], 0), { status: 'No matching models.', useEnteredId: true });
  assert.deepEqual(pickerSearchPresentation(' ', [], 0), { status: 'No models to show.', useEnteredId: false });
  const ids = Array.from({ length: 301 }, (_, index) => `fixture/model-${index}`);
  assert.deepEqual(pickerSearchPresentation('fixture/model', ids, 300), { status: '301 matches. Showing 300. Refine the search.', useEnteredId: true });
});

test('marketplace suppresses only the expected disconnect reason, not a later genuine source failure', () => {
  const disconnected = { source: { rootPath: '' }, catalog: { state: 'not-configured', error: { message: 'Not configured.' } }, error: 'Not configured.' };
  assert.deepEqual(marketplaceSourceStatus(disconnected), { disconnected: true, error: '' });
  assert.deepEqual(marketplaceSourceStatus({ ...disconnected, error: 'Source request failed.' }), { disconnected: false, error: 'Source request failed.' });
  assert.deepEqual(marketplaceSourceStatus({ ...disconnected, source: { rootPath: '/synthetic/store' } }), { disconnected: false, error: 'Not configured.' });
});
