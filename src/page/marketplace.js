import { clone, pathKey, validModels, bindMarketplaceView, markMarketplaceUnavailable } from './editor-state.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = value => typeof value === 'string' && value.length <= 500;
const nullable = value => value === null || text(value);
const packageId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
  && !value.split('/').some(part => ['__proto__', 'prototype', 'constructor', '.', '..'].includes(part));
const agentName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const unique = (items, key) => new Set(items.map(key)).size === items.length;
export function normalizeMarketplaceCatalog(value) {
  if (!object(value) || !text(value.generation) || !value.generation) throw new Error('Marketplace source identity is invalid.');
  if (value.state !== 'ready') {
    if (!['not-configured', 'unavailable', 'unsupported'].includes(value.state) || typeof value.error?.message !== 'string' || Object.hasOwn(value, 'packages')) throw new Error('Marketplace source status is invalid.');
    return { state: value.state, generation: value.generation, error: { code: value.error.code, message: value.error.message } };
  }
  if (value.adapterVersion !== 'omos-marketplace-lock-v2' || !text(value.fingerprint) || !value.fingerprint || !Number.isFinite(value.readAt)
    || !Array.isArray(value.packages) || value.packages.length > 64 || !unique(value.packages, item => item?.id) || !unique(value.packages, item => item?.agentName)) throw new Error('Installed marketplace catalog is invalid or too large.');
  const packages = value.packages.map(item => {
    if (!only(item, ['id', 'version', 'agentName', 'displayName', 'modelSource', 'digest', 'blockedReason']) || !packageId(item.id)
      || typeof item.version !== 'string' || !item.version || item.version.length > 128 || !agentName(item.agentName) || !text(item.displayName)
      || !['session', 'orchestrator', 'explicit', 'builtin'].includes(item.modelSource) || typeof item.digest !== 'string'
      || !/^[0-9a-f]{64}$/i.test(item.digest) || !nullable(item.blockedReason)) throw new Error('An installed marketplace package has invalid safe metadata.');
    return clone(item);
  });
  return { state: 'ready', adapterVersion: value.adapterVersion, generation: value.generation, fingerprint: value.fingerprint, readAt: value.readAt, packages };
}
export function normalizeMarketplaceConfig(value) {
  if (!only(value, ['target', 'baseHash', 'catalog', 'masterEnabled', 'activePreset', 'presets']) || !object(value.target)
    || !text(value.target.generation) || typeof value.target.path !== 'string' || typeof value.baseHash !== 'string'
    || ![true, false, null].includes(value.masterEnabled) || !nullable(value.activePreset)
    || !Array.isArray(value.presets) || value.presets.length > 256 || !unique(value.presets, item => item?.name)
    || new TextEncoder().encode(JSON.stringify(value)).length > 8 * 1024 * 1024) throw new Error('Marketplace configuration view is invalid or too large.');
  const catalog = normalizeMarketplaceCatalog(value.catalog);
  const presets = value.presets.map(preset => {
    if (!only(preset, ['name', 'layout', 'editable', 'reason', 'selectionPresent', 'packageIds', 'agents']) || !text(preset.name)
      || !['structured', 'flat', 'unsupported'].includes(preset.layout) || typeof preset.editable !== 'boolean' || !nullable(preset.reason)
      || typeof preset.selectionPresent !== 'boolean' || !Array.isArray(preset.packageIds) || preset.packageIds.length > 64
      || !preset.packageIds.every(text) || !unique(preset.packageIds, item => item) || !Array.isArray(preset.agents)
      || preset.agents.length > 128 || !unique(preset.agents, item => item?.packageId)) throw new Error('A marketplace preset view is invalid.');
    const agents = preset.agents.map(agent => {
      const retainedUnknown = agent && text(agent.packageId) && preset.packageIds.includes(agent.packageId)
        && !catalog.packages?.some(pkg => pkg.id === agent.packageId) && agent.agentName === null && agent.selected === true
        && agent.existingGroupId === null && agent.modelPath === null && agent.canCreate === false && typeof agent.blockedReason === 'string';
      if (!only(agent, ['packageId', 'agentName', 'selected', 'existingGroupId', 'modelPath', 'defaultVariant', 'canCreate', 'blockedReason']) || (!packageId(agent.packageId) && !retainedUnknown)
        || !(agent.agentName === null || agentName(agent.agentName)) || typeof agent.selected !== 'boolean' || !(agent.existingGroupId === null || (typeof agent.existingGroupId === 'string' && agent.existingGroupId.length <= 8192))
        || typeof agent.defaultVariant !== 'string' || typeof agent.canCreate !== 'boolean' || !nullable(agent.blockedReason)) throw new Error('A marketplace agent view is invalid.');
      if (agent.modelPath !== null && (!Array.isArray(agent.modelPath) || !agent.modelPath.every(text) || agent.modelPath.at(-1) !== 'model')) throw new Error('A marketplace model path is invalid.');
      if (agent.canCreate) {
        const expected = preset.layout === 'structured' ? ['presets', preset.name, 'agents', agent.agentName, 'model'] : ['presets', preset.name, agent.agentName, 'model'];
        const pkg = catalog.packages?.find(item => item.id === agent.packageId);
        if (!preset.editable || preset.layout === 'unsupported' || !pkg || pkg.agentName !== agent.agentName || agent.existingGroupId || agent.blockedReason
          || pathKey(agent.modelPath) !== pathKey(expected) || !validModels([{ id: 'check/default', variant: agent.defaultVariant }])) throw new Error('A marketplace creation path or default variant is not qualified.');
      }
      return clone(agent);
    });
    return { ...clone(preset), agents };
  });
  return { target: clone(value.target), baseHash: value.baseHash, catalog, masterEnabled: value.masterEnabled, activePreset: value.activePreset, presets };
}
function normalizeSource(value) {
  if (!only(value, ['rootPath', 'generation']) || typeof value.rootPath !== 'string' || !text(value.generation) || !value.generation) throw new Error('Marketplace source settings are invalid.');
  return { rootPath: value.rootPath, generation: value.generation };
}
export function createMarketplaceController({ request, getEditor, onChange = () => {} }) {
  const state = { source: null, data: null, catalog: null, busy: '', error: null }; let version = 0; let writes = Promise.resolve();
  const emit = changed => onChange({ changed: Boolean(changed) });
  async function read(token, recheck) {
    const source = normalizeSource(await request('/marketplace/source'));
    if (token !== version) return;
    state.source = source;
    const editor = getEditor(); const hash = editor?.baseHash; const generation = editor?.target.generation;
    if (!editor) {
      const catalog = normalizeMarketplaceCatalog(await request('/marketplace/snapshot'));
      if (token === version) { state.catalog = catalog; state.error = catalog.error?.message || null; }
      return;
    }
    const data = normalizeMarketplaceConfig(await request('/marketplace/config'));
    if (token !== version || getEditor() !== editor || editor.baseHash !== hash || editor.target.generation !== generation) return;
    const revision = editor.revision;
    if (!bindMarketplaceView(editor, data, { recheck })) throw new Error('Marketplace view belongs to a different file revision. Refresh it.');
    state.data = data; state.catalog = data.catalog; state.error = data.catalog.error?.message || null;
    emit(editor.revision !== revision);
  }
  const fail = (token, error, binding) => {
    if (token !== version) return;
    if (binding && (getEditor() !== binding.editor || (binding.editor && (binding.editor.baseHash !== binding.hash || binding.editor.target.generation !== binding.generation)))) return;
    state.error = error.message || 'Marketplace metadata could not be read.';
    const editor = getEditor(); if (editor) markMarketplaceUnavailable(editor);
  };
  return {
    getState: () => clone(state),
    async refresh({ recheck = false } = {}) {
      const token = ++version; state.busy = 'read'; state.error = null; emit();
      const editor = getEditor(); const binding = { editor, hash: editor?.baseHash, generation: editor?.target.generation };
      try { await writes.catch(() => {}); if (token === version) await read(token, recheck); }
      catch (error) { fail(token, error, binding); }
      finally { if (token === version) { state.busy = ''; emit(); } }
    },
    async configure(rootPath) {
      const token = ++version; state.busy = 'save'; state.error = null;
      const editor = getEditor(); if (editor) markMarketplaceUnavailable(editor); emit();
      const write = writes.catch(() => {}).then(() => request('/marketplace/source', { rootPath })); writes = write;
      try { const source = normalizeSource(await write); if (token === version) { state.source = source; await read(token, false); } }
      catch (error) { fail(token, error); }
      finally { if (token === version) { state.busy = ''; emit(); } }
    },
  };
}
