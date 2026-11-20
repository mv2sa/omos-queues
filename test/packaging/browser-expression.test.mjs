import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readUiState, waitForSettingsForm } from '../integration/ui-flow.mjs';
import { readFavoritesState, readPickerFavoritesState } from '../integration/favorites-flow.mjs';
import { FirefoxBrowser, remainingBudget } from '../integration/browser.mjs';
import { marketplaceBundleDigest, readMarketplaceState } from '../integration/marketplace-flow.mjs';

test('Settings readiness ignores preference fields and waits for four enabled core inputs in an open dialog', async () => {
  for (const [open, fields, expected] of [[false, 4, false], [true, 0, false], [true, 2, false], [true, 4, true], [true, 5, false]]) {
    for (const disabled of [false, true]) {
      const actual = await waitForSettingsForm({ waitForExpression(expression, options) {
        assert.deepEqual(options, { context: 'frame', timeoutMs: 8_000 });
        return vm.runInNewContext(expression, { document: { querySelector(selector) {
          assert.equal(selector, 'dialog.editor-dialog[open]');
          return open ? { querySelectorAll(scope) {
            assert.equal(scope, '.settings-fields input');
            return Array.from({ length: fields }, () => ({ disabled }));
          } } : null;
        } } });
      } }, 'frame');
      assert.equal(actual, expected && !disabled);
    }
  }
});

test('the generated queue-state browser expression is valid JavaScript without executing page code', async () => {
  let scanned = 0;
  const browser = { async evaluate(source) { new vm.Script(source); scanned += 1; return '{}'; } };
  assert.deepEqual(await readUiState(browser, 'synthetic-frame'), {});
  assert.equal(scanned, 1);
});

for (const readState of [readFavoritesState, readPickerFavoritesState]) {
  test(`${readState.name} generates valid browser JavaScript`, async () => {
    let scanned = 0;
    await readState({ async evaluate(source) { new vm.Script(source); scanned += 1; return '{}'; } }, 'synthetic-frame');
    assert.ok(scanned > 0);
  });
}

const compileOnlyBrowser = () => {
  const expressions = [];
  return {
    context: 'synthetic-frame',
    expressions,
    prepareSdkPopupTrigger: FirefoxBrowser.prototype.prepareSdkPopupTrigger,
    readSdkMenuItems: FirefoxBrowser.prototype.readSdkMenuItems,
    openSdkMenu: FirefoxBrowser.prototype.openSdkMenu,
    clickSdkMenuItem: FirefoxBrowser.prototype.clickSdkMenuItem,
    async evaluate(source) {
      new vm.Script(source);
      expressions.push(source);
      if (source.includes('scope-not-found')) return JSON.stringify({ ok: true, stable: 3 });
      if (source.includes('menuitem') && source.includes('items')) {
        return JSON.stringify({
          expanded: 'true',
          items: [{ label: 'Copy queue', disabled: false, visible: true }],
          popupRect: null,
          scrollY: 0,
          active: { tag: 'DIV', role: 'menu' },
        });
      }
      if (source.includes('oc-sdk-option-label')) return JSON.stringify(['low', 'medium', 'high']);
      return true;
    },
    async waitForExpression(source) {
      new vm.Script(source);
      expressions.push(source);
      return true;
    },
    async pointerClick() {},
    async pressKey() {},
    async command() {},
  };
};

for (const pointer of [true, false]) {
  test(`the shared SDK-select helper generates valid browser JavaScript (${pointer ? 'pointer' : 'keyboard'})`, async () => {
    const browser = compileOnlyBrowser();
    const result = await FirefoxBrowser.prototype.selectSdkOption.call(
      browser, '.synthetic .variant-cell', 'high', { context: 'synthetic-frame', pointer },
    );
    assert.equal(result.value, 'high');
    assert.equal(result.mode, pointer ? 'pointer' : 'keyboard');
    assert.ok(browser.expressions.length >= 4, `expected several browser expressions, got ${browser.expressions.length}`);
    for (const source of browser.expressions) new vm.Script(source);
  });
}

test('the absolute budget never resets after expiry', () => {
  assert.deepEqual(remainingBudget(1_000, 900), { expired: false, left: 100 });
  assert.deepEqual(remainingBudget(1_000, 1_000), { expired: true, left: 0 });
  assert.deepEqual(remainingBudget(1_000, 5_000), { expired: true, left: 0 });
});

for (const [name, invoke] of [
  ['select', (browser) => FirefoxBrowser.prototype.selectSdkOption.call(
    browser, '.synthetic .variant-cell', 'high', { context: 'synthetic-frame', timeoutMs: 0 },
  )],
  ['menu', (browser) => FirefoxBrowser.prototype.openSdkMenu.call(
    browser, '#synthetic-menu', { context: 'synthetic-frame', timeoutMs: 0 },
  )],
]) {
  test(`the ${name} helper fails fast on an expired deadline without page work`, async () => {
    let evaluations = 0;
    const browser = {
      context: 'synthetic-frame',
      prepareSdkPopupTrigger: FirefoxBrowser.prototype.prepareSdkPopupTrigger,
      readSdkMenuItems: FirefoxBrowser.prototype.readSdkMenuItems,
      openSdkMenu: FirefoxBrowser.prototype.openSdkMenu,
      clickSdkMenuItem: FirefoxBrowser.prototype.clickSdkMenuItem,
      async evaluate() { evaluations += 1; return '{}'; },
      async waitForExpression() { evaluations += 1; return true; },
      async pointerClick() { evaluations += 1; },
      async pressKey() { evaluations += 1; },
      async command() { evaluations += 1; },
    };
    await assert.rejects(invoke(browser), (error) => (
      error.code === 'SDK_SELECT_TIMEOUT' || error.code === 'SDK_MENU_TIMEOUT'
    ));
    assert.ok(evaluations <= 1, `only failure diagnostics may read the page (got ${evaluations} calls)`);
  });
}

test('the shared SDK-menu helper generates valid browser JavaScript', async () => {
  const browser = compileOnlyBrowser();
  const result = await FirefoxBrowser.prototype.selectSdkMenuItem.call(
    browser, '#synthetic-menu', 'Copy queue', { context: 'synthetic-frame' },
  );
  assert.equal(result.label, 'Copy queue');
  assert.ok(browser.expressions.length >= 4);
  for (const source of browser.expressions) new vm.Script(source);
});

test('the marketplace page-state expression is valid JavaScript without executing page code', async () => {
  let scanned = 0;
  const browser = { async evaluate(source) { new vm.Script(source); scanned += 1; return '{}'; } };
  assert.deepEqual(await readMarketplaceState(browser, 'synthetic-frame'), {});
  assert.equal(scanned, 1);
});

test('the synthetic marketplace bundle digest is canonical and order-independent', () => {
  const left = { manifest: { schemaVersion: 3, id: 'fixture/janitor', version: '1.0.0', nested: { b: 2, a: 1 } } };
  const right = { manifest: { nested: { a: 1, b: 2 }, version: '1.0.0', id: 'fixture/janitor', schemaVersion: 3 } };
  assert.match(marketplaceBundleDigest(left), /^[0-9a-f]{64}$/);
  assert.equal(marketplaceBundleDigest(left), marketplaceBundleDigest(right));
  assert.notEqual(marketplaceBundleDigest(left), marketplaceBundleDigest({ ...left, manifest: { ...left.manifest, version: '1.0.1' } }));
});
