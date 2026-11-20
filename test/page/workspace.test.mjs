import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSelect } from '@openchamber/sdk/ui';
import { createEditor, clone, setFilter, visibleGroups, replaceModels, snapshot, movePosition, mergeSavedConfig,
  beginPrimaryPick, applyPrimaryPick, discardPrimaryCreation } from '../../src/page/editor-state.js';
import { jumpToQueue, actionPresentation, pickerViewport, pickerTabWrap, beginModelPick, applyModelPick } from '../../src/page/controller.js';
import { queueWorkspacePlan, queueReadOnlyReason, emptyWorkspaceNote, phoneJumpProps, visibleWorkspaceSelection, primarySlotAtLimit,
  INSTALLED_AGENTS_ID } from '../../src/page/workspace-metadata.js';

function fixture() {
  return createEditor({ target: { path: '/isolated/omos.jsonc', generation: 'generation-a' }, baseHash: 'before',
    groups: ['first', 'custom name', 'seat'].map((name, index) => {
      const path = index === 2 ? ['council', 'presets', 'panel', name, 'model'] : ['agents', name, 'model'];
      return { id: JSON.stringify(path), path, name, label: name, section: index === 2 ? 'Council' : 'Agents',
        defaultVariant: index === 1 ? 'high' : '', readOnlyReason: null, models: [{ id: `fixture/${index}`, variant: '' }] };
    }) });
}

test('continuous workspace keeps every queue in stable file order regardless of outline filter or selected queue', () => {
  const editor = fixture(); const original = queueWorkspacePlan(editor);
  replaceModels(editor, editor.groups[1].id, [{ id: 'fixture/changed', variant: 'low' }]);
  editor.selectedId = editor.groups[2].id; setFilter(editor, 'first');
  assert.equal(visibleGroups(editor).length, 1);
  const plan = queueWorkspacePlan(editor);
  assert.deepEqual(plan.filter(item => item.type === 'queue').map(item => item.id), editor.groups.map(group => group.id));
  assert.deepEqual(plan.map(item => item.anchorId), original.map(item => item.anchorId));
  assert.equal(plan.length, 5); assert.equal(plan[1].group.models[0].id, 'fixture/changed');
  assert.equal(snapshot(editor).changes.length, 1);
});

test('jump selects and scrolls the existing section, focuses its heading and never replaces or discards other queues', () => {
  const editor = fixture(); replaceModels(editor, editor.groups[0].id, [{ id: 'fixture/dirty', variant: '' }]);
  const before = snapshot(editor); const groups = editor.groups; const calls = [];
  const view = { section: { scrollIntoView: value => calls.push(['scroll', value]) }, name: { focus: value => calls.push(['focus', value]) } };
  assert.equal(jumpToQueue(editor, editor.groups[1].id, view), true);
  assert.equal(editor.groups, groups); assert.deepEqual(snapshot(editor), before);
  assert.equal(editor.selectedId, editor.groups[1].id);
  assert.deepEqual(calls, [['scroll', { block: 'start', inline: 'nearest' }], ['focus', { preventScroll: true }]]);
  assert.equal(jumpToQueue(editor, editor.groups[1].id, view), true); // Jump still works after scrolling away.
  assert.equal(jumpToQueue(editor, 'unknown', view), false);
});

test('phone action select jumps again when clicked on the destination already shown in its trigger', t => {
  // This small DOM harness exercises the real SDK's pointer and value handling.
  class Element extends EventTarget {
    children = []; dataset = {}; style = {}; className = ''; attributes = new Map();
    classList = { contains: name => this.className.split(' ').includes(name) };
    get firstChild() { return this.children[0]; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    removeChild(node) { this.children = this.children.filter(child => child !== node); node.parent = null; }
    remove() { this.parent?.removeChild(this); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelector(selector) {
      const match = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1))
        : selector === '[data-active="true"]' && node.dataset.active === 'true';
      return this.children.find(match) ?? this.children.map(node => node.querySelector(selector)).find(Boolean);
    }
    getBoundingClientRect() { return { left: 8, top: 50, bottom: 94, width: 150 }; }
    focus() {}
    scrollIntoView() {}
    click() { this.dispatchEvent(new Event('click')); }
  }
  const document = Object.assign(new EventTarget(), { getElementById: () => new Element(),
    createElement: () => new Element(), createElementNS: () => new Element() });
  const window = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 760 });
  const prior = Object.fromEntries(['document', 'window', 'HTMLElement', 'HTMLStyleElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(prior)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  Object.assign(globalThis, { document, window, HTMLElement: Element, HTMLStyleElement: Element });
  const editor = fixture(); const plan = queueWorkspacePlan(editor); const target = editor.groups[1].id;
  const root = new Element(); const jumps = [];
  const select = mountSelect(root, { label: 'Jump to queue', ...phoneJumpProps(plan, editor.selectedId), onChange(id) {
    jumpToQueue(editor, id, { section: { scrollIntoView() { jumps.push(id); } }, name: { focus() {} } });
    select.update(phoneJumpProps(plan, editor.selectedId));
  } });
  const trigger = root.querySelector('.oc-sdk-trigger');
  for (let count = 0; count < 2; count += 1) {
    trigger.click();
    const listbox = root.querySelector('.oc-sdk-popup').firstChild;
    listbox.children.find(option => option.id.endsWith(target)).click();
    assert.equal(root.querySelector('.oc-sdk-trigger-value').textContent, plan.find(item => item.id === target).label);
  }
  assert.deepEqual(jumps, [target, target]);
  select.dispose();
});

test('model edits and staged Add target the originating queue, retaining every other queue and default', () => {
  const editor = fixture(); const first = clone(editor.groups[0]); const target = editor.groups[1];
  const pending = beginModelPick(editor, target.id, 1, true);
  assert.equal(target.models.length, 1);
  assert.equal(applyModelPick(editor, pending, 'fixture/new'), true);
  assert.deepEqual(editor.groups[0], first); assert.equal(target.defaultVariant, 'high'); assert.equal(target.models.length, 2);
  const focused = movePosition(editor, target.id, 1, -1);
  assert.equal(focused, 0); assert.equal(target.models[focused].id, 'fixture/new');
  assert.equal(editor.groups.length, 3); assert.equal(snapshot(editor).changes.length, 1);
});

test('an edit in another visible queue invalidates a stale model popup choice without losing either edit', () => {
  const editor = fixture(); const pending = beginModelPick(editor, editor.groups[1].id, 0);
  replaceModels(editor, editor.groups[0].id, [{ id: 'fixture/later', variant: '' }]);
  assert.equal(applyModelPick(editor, pending, 'fixture/stale-choice'), false);
  assert.equal(editor.groups[0].models[0].id, 'fixture/later'); assert.equal(editor.groups[1].models[0].id, 'fixture/1');
});

test('the picker covers the extension viewport including visual viewport offsets', () => {
  assert.deepEqual(pickerViewport(null, 1000, 800), { left: 0, top: 0, width: 1000, height: 800 });
  const keyboard = { width: 360, height: 300, offsetLeft: 6, offsetTop: 40 };
  assert.deepEqual(pickerViewport(keyboard, 390, 750), { left: 6, top: 40, width: 360, height: 300 });
  assert.deepEqual(pickerViewport({ width: 0, height: NaN }, 390, 750), { left: 0, top: 0, width: 390, height: 750 });
});

test('phone keyboard covers unresized frames but is not double-subtracted from already resized frames', () => {
  const editor = fixture(); const pending = { ...beginModelPick(editor, editor.selectedId, 0), query: 'fixture' };
  const before = clone(pending); const options = { keyboard: 300, unobscuredHeight: 750 };
  assert.equal(pickerViewport(null, 390, 750, options).height, 450);
  assert.equal(pickerViewport(null, 390, 450, options).height, 450);
  assert.equal(pickerViewport({ width: 390, height: 420, offsetTop: 26 }, 390, 750, options).height, 420);
  assert.deepEqual(pending, before);
});

test('picker focus wraps in either direction without intercepting normal Tab or text entry', () => {
  const calls = [];
  const stops = ['cancel', 'search', 'star'].map(name => ({ focus() { calls.push(name); } }));
  const key = (key = 'Tab', shiftKey = false) => ({ key, shiftKey, preventDefault() { this.defaultPrevented = true; } });
  assert.equal(pickerTabWrap(key(), stops[1], stops), false);
  assert.equal(pickerTabWrap(key('g'), stops[1], stops), false);
  assert.equal(pickerTabWrap(key(), stops[2], stops), true);
  assert.equal(pickerTabWrap(key('Tab', true), stops[0], stops), true);
  assert.equal(pickerTabWrap(key(), null, stops), true);
  assert.deepEqual(calls, ['cancel', 'star', 'cancel']);
});

test('positive actions get explicit semantic intent while Remove stays destructive and Cancel stays neutral', () => {
  assert.deepEqual(actionPresentation({ variant: 'default' }), { variant: 'default', intent: 'positive' });
  assert.deepEqual(actionPresentation({ intent: 'positive' }), { variant: 'default', intent: 'positive' });
  assert.deepEqual(actionPresentation({ variant: 'destructive' }), { variant: 'destructive', intent: 'destructive' });
  assert.deepEqual(actionPresentation({ variant: 'outline' }), { variant: 'outline', intent: 'neutral' });
  assert.deepEqual(actionPresentation({ variant: 'default', intent: 'neutral' }), { variant: 'outline', intent: 'neutral' });
});

test('saved metadata hydration updates the plan labels without changing anchors or newer draft values', () => {
  const editor = fixture(); const group = editor.groups[0]; const originalGroup = group;
  replaceModels(editor, group.id, [{ id: 'fixture/later', variant: 'low' }]);
  const pending = beginModelPick(editor, group.id, 0); const revision = editor.revision;
  const anchor = queueWorkspacePlan(editor)[0].anchorId;
  const config = { target: clone(editor.target), baseHash: editor.baseHash, groups: editor.groups.map(item => ({ ...clone(item), models: clone(item.original) })) };
  Object.assign(config.groups[0], { name: 'Canonical agent', label: 'Preset production · canonical agent', section: 'Presets · production' });
  assert.equal(mergeSavedConfig(editor, config), true); assert.equal(editor.groups[0], originalGroup);
  const entry = queueWorkspacePlan(editor)[0];
  assert.equal(entry.label, 'Canonical agent'); assert.equal(entry.anchorId, anchor);
  assert.equal(editor.revision, revision); assert.equal(group.models[0].id, 'fixture/later');
  assert.equal(applyModelPick(editor, pending, 'fixture/next-choice'), true);
});

const queue = (path, name, section = 'Agents', kind = 'agent') => ({ id: JSON.stringify(path), path, name,
  label: `preset quality · ${name}`, section, kind, defaultVariant: '', models: [{ id: 'fixture/model', variant: '' }], readOnlyReason: null });
const primary = (preset, agent = 'orchestrator') => ({ preset, agent, modelPath: ['presets', preset, 'agents', agent, 'model'],
  existingGroupId: null, defaultVariant: '', canCreate: agent === 'orchestrator', blockedReason: null });
const withGroups = (groups, primarySlots = []) => createEditor({ target: { path: '/isolated/omos.jsonc', generation: 'gen' }, baseHash: 'before', groups, primarySlots });

test('shared workspace order is stable, and verified package ownership never follows name-only matches', () => {
  const packageQueue = queue(['presets', 'quality', 'agents', 'janitor', 'model'], 'janitor', 'Preset · quality', 'preset');
  const sameNamedRoot = queue(['agents', 'janitor', 'model'], 'janitor');
  const buildSeat = queue(['council', 'presets', 'board', 'build', 'model'], 'build', 'Council seats · board', 'council');
  const customBuild = queue(['agents', 'build', 'model'], 'build');
  const otherQueue = queue(['presets', 'quality', 'agents', 'scanner', 'model'], 'scanner', 'Preset · quality', 'preset');
  const editor = withGroups([packageQueue, sameNamedRoot, buildSeat, customBuild, otherQueue], [primary('quality'), primary('quality', 'build')]);
  const initial = queueWorkspacePlan(editor);
  assert.equal(initial[0].category, 'regular');
  editor.marketplaceView = { catalog: { state: 'ready', packages: [{ id: 'fixture/janitor', agentName: 'janitor' }] },
    presets: [{ name: 'quality', agents: [{ packageId: 'fixture/janitor', agentName: 'janitor', selected: true, existingGroupId: packageQueue.id, modelPath: packageQueue.path },
      { packageId: 'unknown/scanner', agentName: 'scanner', selected: true, existingGroupId: otherQueue.id, modelPath: otherQueue.path }] }] };
  const plan = queueWorkspacePlan(editor);
  assert.deepEqual(plan.map(entry => entry.category), ['regular', 'regular', 'regular', 'orchestrator', 'marketplace', 'marketplace']);
  assert.deepEqual(plan.map(entry => entry.label), ['janitor · Agents', 'build', 'scanner', 'Orchestrator', 'janitor · quality', 'Installed agents']);
  assert.equal(plan[4].anchorId, initial[0].anchorId);
  assert.equal(plan.at(-1).id, INSTALLED_AGENTS_ID);
  assert.deepEqual(plan.slice(0, 3).map(entry => entry.id), [sameNamedRoot.id, buildSeat.id, otherQueue.id]);
  assert.ok(!plan.some(entry => entry.id === customBuild.id));
});

test('an installed but unselected package does not claim a same-preset custom queue at its exact path', () => {
  const custom = queue(['presets', 'quality', 'agents', 'janitor', 'model'], 'janitor', 'Preset · quality', 'preset');
  const other = queue(['agents', 'worker', 'model'], 'worker');
  const editor = withGroups([custom, other]);
  const agent = { packageId: 'fixture/janitor', agentName: 'janitor', selected: false, existingGroupId: custom.id, modelPath: custom.path };
  editor.marketplaceView = { catalog: { state: 'ready', packages: [{ id: agent.packageId, agentName: agent.agentName }] },
    presets: [{ name: 'quality', agents: [agent] }] };
  const plan = queueWorkspacePlan(editor);
  assert.deepEqual(plan.slice(0, 2).map(entry => [entry.id, entry.category]), [[custom.id, 'regular'], [other.id, 'regular']]);
  assert.equal(plan.filter(entry => entry.id === custom.id).length, 1);
});

test('shared workspace, outline and phone plan omits native and exact-path OMOS Build without hiding an editable council seat or custom agent', () => {
  const paths = [
    ['agents', 'build', 'model'],
    ['presets', 'quality', 'build', 'model'],
    ['presets', 'quality', 'agents', 'build', 'model'],
    ['presets', 'speed', 'agents', 'build', 'model'],
  ];
  const configs = paths.map(path => queue(path, 'build', 'Agents', path[0] === 'agents' ? 'agent' : 'preset'));
  configs.forEach(group => { group.readOnlyReason = 'Read-only Build configuration.'; });
  const seat = queue(['council', 'presets', 'board', 'build', 'model'], 'build', 'Council seats · board', 'council');
  const custom = queue(['agents', 'build-worker', 'model'], 'build-worker');
  const editor = withGroups([configs[0], seat, ...configs.slice(1), custom], [primary('quality', 'build'), primary('speed', 'build'), primary('quality')]);
  const plan = queueWorkspacePlan(editor);
  const visibleLabels = ['build', 'build-worker', 'Orchestrator', 'Installed agents'];
  assert.deepEqual(plan.map(entry => entry.label), visibleLabels);
  assert.equal(plan[0].category, 'regular');
  assert.equal(queueReadOnlyReason(plan[0]), null);
  assert.equal(queueReadOnlyReason(plan[1]), null);
  assert.equal(editor.selectedId, configs[0].id);
  const selected = visibleWorkspaceSelection(plan, null, editor.selectedId);
  assert.equal(selected, seat.id);
  assert.equal(visibleWorkspaceSelection(plan, custom.id, editor.selectedId), custom.id);
  const phone = phoneJumpProps(plan, selected);
  assert.equal(phone.placeholder, 'build');
  assert.deepEqual(phone.options.map(option => option.label), visibleLabels);
  for (const hidden of configs) {
    assert.ok(!phone.options.some(option => option.id === hidden.id));
    assert.deepEqual(editor.groups.find(group => group.id === hidden.id)?.models, hidden.models);
    assert.equal(beginModelPick(editor, hidden.id, 0), null);
  }
  assert.ok(applyModelPick(editor, beginModelPick(editor, seat.id, 0), 'fixture/seat'));
  assert.deepEqual(snapshot(editor).changes.map(edit => edit.path), [seat.path]);
});

test('Orchestrator and marketplace are shown even without queues, presets or source', () => {
  const plan = queueWorkspacePlan(withGroups([]));
  assert.deepEqual(plan.map(entry => entry.label), ['Orchestrator', 'Installed agents']);
  assert.equal(plan[0].slot, null);
});

test('the empty note requires a readable snapshot with no explicit queues, without removing primary actions', () => {
  assert.equal(emptyWorkspaceNote(null), '');
  const editor = withGroups([], [primary('quality')]);
  assert.equal(emptyWorkspaceNote(editor), 'No explicit queues in this file.');
  const eligible = queueWorkspacePlan(editor).find(entry => entry.category === 'orchestrator');
  assert.ok(eligible.slot.canCreate);
  assert.ok(applyPrimaryPick(editor, beginPrimaryPick(editor, 'quality', 'orchestrator'), 'fixture/staged'));
  assert.equal(emptyWorkspaceNote(editor), 'No explicit queues in this file.'); // A local draft is not an explicit queue in the file.
  editor.unknown = {};
  assert.equal(emptyWorkspaceNote(editor), '');
  editor.unknown = null;
  editor.conflict = { unreadable: true };
  assert.equal(emptyWorkspaceNote(editor), '');
  assert.equal(emptyWorkspaceNote(fixture()), '');
});

test('a Build-only file has an explanatory empty state and still offers a valid Orchestrator override', () => {
  const build = { ...queue(['agents', 'build', 'model'], 'build'), readOnlyReason: 'Read-only Build configuration.' };
  const editor = withGroups([build], [primary('quality', 'build'), primary('quality')]);
  const plan = queueWorkspacePlan(editor);
  assert.deepEqual(plan.map(entry => entry.label), ['Orchestrator', 'Installed agents']);
  assert.equal(visibleWorkspaceSelection(plan, null, editor.selectedId), plan[0].id);
  assert.equal(emptyWorkspaceNote(editor), 'No editable model queues in this file.');
  assert.ok(beginPrimaryPick(editor, plan[0].preset, 'orchestrator'));
});

test('existing and staged primary queues replace only their corresponding preset slot', () => {
  const quality = primary('quality'); const fast = primary('fast');
  const existing = queue(fast.modelPath, 'orchestrator', 'Preset · fast', 'preset');
  Object.assign(fast, { existingGroupId: existing.id, canCreate: false });
  const editor = withGroups([existing], [quality, fast]);
  const original = queueWorkspacePlan(editor);
  assert.deepEqual(original.slice(0, 2).map(entry => entry.label), ['Orchestrator · quality', 'Orchestrator · fast']);
  const pending = applyPrimaryPick(editor, beginPrimaryPick(editor, 'quality', 'orchestrator'), 'fixture/chosen');
  const staged = queueWorkspacePlan(editor);
  assert.equal(staged.length, original.length);
  assert.equal(staged[0].id, pending.id);
  assert.equal(staged[0].label, original[0].label);
  assert.equal(staged[1].anchorId, original[1].anchorId);
  discardPrimaryCreation(editor, pending.id);
  assert.deepEqual(queueWorkspacePlan(editor).map(entry => entry.id), original.map(entry => entry.id));
});

test('the 64-stage limit matches state eligibility and resetting one override re-enables another preset', () => {
  const slots = Array.from({ length: 65 }, (_, index) => primary(`preset-${index}`));
  const editor = withGroups([], slots);
  for (const slot of slots.slice(0, 64)) {
    assert.ok(applyPrimaryPick(editor, beginPrimaryPick(editor, slot.preset, slot.agent), 'fixture/model'));
  }
  const last = slots.at(-1);
  const entry = queueWorkspacePlan(editor).find(item => item.preset === last.preset);
  assert.equal(primarySlotAtLimit(entry, editor), true);
  assert.equal(beginPrimaryPick(editor, last.preset, last.agent), null);
  discardPrimaryCreation(editor, editor.groups[0].id);
  assert.equal(primarySlotAtLimit(entry, editor), false);
  assert.ok(beginPrimaryPick(editor, last.preset, last.agent));
});
