import { validModelId } from './editor-state.js';

export const FAVORITES_KEY = 'omos-queues.favorites.v1';
export const FAVORITES_SCOPE = Object.freeze({ scope: 'instance' });
export const MAX_FAVORITES = 64;
const MAX_BYTES = 64 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const modelRefId = ref => `${ref.providerID}/${ref.modelID}`;
export function modelIdRef(id) {
  if (!validModelId(id)) throw new Error('Use a valid provider/model ID.');
  const slash = id.indexOf('/');
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}
export function normalizeFavoriteRefs(refs) {
  if (!Array.isArray(refs) || bytes(refs) > MAX_BYTES) throw new Error('Favorites must fit within 64 KiB.');
  const seen = new Set(); const result = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || Object.keys(ref).some(key => !['providerID', 'modelID'].includes(key))
      || typeof ref.providerID !== 'string' || typeof ref.modelID !== 'string'
      || ref.providerID.includes('/') || !validModelId(modelRefId(ref))) throw new Error('Favorites contain an invalid model reference.');
    const id = modelRefId(ref);
    if (!seen.has(id)) { seen.add(id); result.push({ providerID: ref.providerID, modelID: ref.modelID }); }
  }
  if (result.length > MAX_FAVORITES) throw new Error('Keep at most 64 extension favorites.');
  return result;
}
export const emptyFavorites = () => ({ version: 1, models: [], source: { kind: 'manual', importedAt: null } });
export function normalizeFavorites(value) {
  if (value === undefined) return emptyFavorites();
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || Object.keys(value).some(key => !['version', 'models', 'source'].includes(key))
    || !value.source || Object.keys(value.source).some(key => !['kind', 'importedAt'].includes(key))
    || !['manual', 'openchamber-import'].includes(value.source.kind)
    || !(value.source.importedAt === null || (Number.isFinite(value.source.importedAt) && value.source.importedAt >= 0))
    || bytes(value) > MAX_BYTES) throw new Error('Stored extension favorites are invalid or exceed 64 KiB.');
  const result = { version: 1, models: normalizeFavoriteRefs(value.models), source: copy(value.source) };
  if (bytes(result) > MAX_BYTES) throw new Error('Favorites must fit within 64 KiB.');
  return result;
}
export function favoriteFirst(ids, refs) {
  const ordered = [...new Set(ids)]; const available = new Set(ordered);
  const favorites = normalizeFavoriteRefs(refs).map(modelRefId).filter(id => available.has(id));
  const selected = new Set(favorites);
  return [...favorites, ...ordered.filter(id => !selected.has(id))];
}
export function favoriteButtonProps(id, selected, disabled = false) {
  return { label: selected ? '★' : '☆', ariaLabel: `${selected ? 'Remove' : 'Add'} ${id} ${selected ? 'from' : 'to'} extension favorites`,
    pressed: String(selected), disabled };
}

// Storage is the extension's connected-instance namespace, never host profile
// preferences. Reads happen once unless the user explicitly retries a failure.
export function createFavoritesController({ storage, onChange = () => {}, now = Date.now }) {
  const state = { record: emptyFavorites(), revision: 0, loaded: false, reading: false, saving: false,
    readError: null, writeError: null, savedRevision: 0 };
  let reading = null; let readVersion = 0; let writes = Promise.resolve(true); let pending = 0;
  const emit = () => onChange(copy(state));
  function write() {
    if (!state.loaded || state.readError) throw new Error('Read extension favorites successfully before saving them.');
    const revision = state.revision; const record = normalizeFavorites(state.record);
    pending += 1; state.saving = true; emit();
    writes = writes.catch(() => false).then(async () => {
      try {
        await storage.set(FAVORITES_KEY, record, FAVORITES_SCOPE);
        state.savedRevision = Math.max(state.savedRevision, revision);
        if (state.revision === revision) state.writeError = null;
        return true;
      } catch (error) {
        state.writeError = `Extension favorites could not be saved. ${error.message}`;
        return false;
      } finally { pending -= 1; state.saving = pending > 0; emit(); }
    });
    return writes;
  }
  function replace(record) {
    if (!state.loaded || state.readError) throw new Error('Read extension favorites successfully before replacing them.');
    state.record = normalizeFavorites(record); state.revision += 1;
    state.writeError = null;
    void write();
  }
  async function refreshForUse() {
    if (reading) await reading;
    const revision = state.revision;
    // Drain every owned write already queued. A failed write must not be hidden
    // by reading the older server record over newer unsaved stars.
    do { await writes; } while (pending > 0);
    if (state.writeError) throw new Error(state.writeError);
    if (state.revision !== revision) throw new Error('Extension favorites changed while checking them. Try again after saving finishes.');
    const token = ++readVersion;
    state.reading = true; emit();
    try {
      const record = normalizeFavorites(await storage.get(FAVORITES_KEY, FAVORITES_SCOPE));
      if (token !== readVersion || state.revision !== revision || pending > 0) throw new Error('Extension favorites changed during the fresh read. Newer stars were kept.');
      if (JSON.stringify(record) !== JSON.stringify(state.record)) { state.record = record; state.revision += 1; }
      state.loaded = true; state.readError = null; state.savedRevision = state.revision;
      return { ...copy(state), reading: false };
    } catch (error) {
      if (token === readVersion && state.revision === revision) state.readError = `Extension favorites could not be refreshed. ${error.message}`;
      throw error;
    } finally { if (token === readVersion) { state.reading = false; emit(); } }
  }
  return {
    getState: () => copy(state),
    async load({ retry = false } = {}) {
      if (reading) return reading;
      if (retry && state.loaded && state.readError) { try { await refreshForUse(); } catch { /* exposed in state */ } return; }
      if (state.loaded || (!retry && state.readError)) return;
      const token = ++readVersion; const revision = state.revision;
      state.reading = true; state.readError = null; emit();
      reading = (async () => {
        try {
          const value = await Promise.resolve().then(() => storage.get(FAVORITES_KEY, FAVORITES_SCOPE));
          const record = normalizeFavorites(value);
          if (token !== readVersion || revision !== state.revision) return;
          state.record = record; state.loaded = true;
        } catch (error) {
          if (token === readVersion) state.readError = `Extension favorites could not be read. ${error.message}`;
        } finally {
          if (token === readVersion) { state.reading = false; reading = null; emit(); }
        }
      })();
      return reading;
    },
    toggle(id) {
      const ref = modelIdRef(id); const models = state.record.models;
      const exists = models.some(item => modelRefId(item) === id);
      replace({ version: 1, models: exists ? models.filter(item => modelRefId(item) !== id) : [...models, ref],
        source: { kind: 'manual', importedAt: null } });
    },
    prepareImport(snapshot) {
      if (!state.loaded || state.readError || snapshot?.state !== 'ready') throw new Error('A successful local read and a fresh source snapshot are required.');
      return Object.freeze({ revision: state.revision, source: sourceIdentity(snapshot),
        models: Object.freeze(normalizeFavoriteRefs(snapshot.favoriteModels).map(ref => Object.freeze(ref))) });
    },
    applyImport(preview, snapshot) {
      if (!preview || state.revision !== preview.revision || snapshot?.state !== 'ready'
        || preview.source !== sourceIdentity(snapshot)
        || JSON.stringify(preview.models) !== JSON.stringify(normalizeFavoriteRefs(snapshot.favoriteModels))) throw new Error('Favorites or the source changed. Review a fresh import before replacing extension favorites.');
      replace({ version: 1, models: preview.models, source: { kind: 'openchamber-import', importedAt: now() } });
    },
    retryWrite: write,
    drain: () => writes,
    refreshForUse,
  };
}

function sourceIdentity(snapshot) {
  return JSON.stringify([snapshot.generation, snapshot.fingerprint, snapshot.readAt, normalizeFavoriteRefs(snapshot.favoriteModels)]);
}
function sourceSettings(value) {
  if (!value || typeof value.filePath !== 'string' || typeof value.generation !== 'string' || !value.generation) throw new Error('The favorite source settings response is invalid.');
  return { filePath: value.filePath, generation: value.generation };
}
function sourceSnapshot(value, generation) {
  if (!value || value.generation !== generation) throw new Error('The favorite source changed while it was being read. Refresh the source again.');
  if (value.state === 'ready') {
    if (value.sourceKind !== 'openchamber-preferences-v1' || typeof value.fingerprint !== 'string'
      || !value.fingerprint || !Number.isFinite(value.readAt)
      || !(value.updatedAt === null || (Number.isFinite(value.updatedAt) && value.updatedAt >= 0))) throw new Error('The favorite source snapshot response is invalid.');
    return { state: 'ready', generation, favoriteModels: normalizeFavoriteRefs(value.favoriteModels),
      fingerprint: value.fingerprint, readAt: value.readAt, updatedAt: value.updatedAt ?? null, sourceKind: value.sourceKind };
  }
  if (!['not-configured', 'unavailable', 'unsupported'].includes(value.state)
    || typeof value.error?.message !== 'string' || Object.hasOwn(value, 'favoriteModels')) throw new Error('The favorite source status response is invalid.');
  return { state: value.state, generation, error: { code: value.error.code, message: value.error.message } };
}

// Refreshes update only this source snapshot. Importing it is a separate,
// revision-bound action on the local favorites controller.
export function createFavoriteSourceController({ request, onChange = () => {} }) {
  const state = { settings: null, snapshot: null, lastGood: null, busy: '', error: null };
  let version = 0; let settingsWrites = Promise.resolve();
  const emit = () => onChange(copy(state));
  const fail = (token, error) => {
    if (token !== version) return;
    state.snapshot = { state: 'unavailable', generation: state.settings?.generation ?? null, error: { message: error.message } };
    state.error = error.message;
  };
  async function read(token) {
    const metadata = sourceSettings(await request('/favorites/source'));
    if (token !== version) return;
    state.settings = metadata;
    const snapshot = sourceSnapshot(await request('/favorites/snapshot'), metadata.generation);
    if (token !== version) return;
    state.snapshot = snapshot;
    state.error = snapshot.state === 'ready' ? null : snapshot.error.message;
    if (snapshot.state === 'ready') state.lastGood = copy(snapshot);
  }
  return {
    getState: () => copy(state),
    async refresh() {
      const token = ++version; state.busy = 'refresh'; state.error = null; state.snapshot = null; emit();
      try { await settingsWrites.catch(() => {}); if (token === version) await read(token); }
      catch (error) { fail(token, error); }
      finally { if (token === version) { state.busy = ''; emit(); } }
    },
    async configure(filePath) {
      if (typeof filePath !== 'string') throw new Error('Enter an absolute source file path or leave it empty.');
      const token = ++version; state.busy = 'configure'; state.error = null; state.snapshot = null; emit();
      const write = settingsWrites.catch(() => {}).then(() => request('/favorites/source', { filePath }));
      settingsWrites = write;
      try {
        const metadata = sourceSettings(await write);
        if (token !== version) return;
        state.settings = metadata;
        await read(token);
      } catch (error) { fail(token, error); }
      finally { if (token === version) { state.busy = ''; emit(); } }
    },
  };
}
