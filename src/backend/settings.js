// Settings are the explicit seam between the page and one OMOS JSONC file. They
// are validated as shapes only: an explicit path that does not exist is still a
// valid setting, never a reason to fall back to another file or executable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceError, badRequest } from './errors.js';
import { readJsonStore, writeJsonStore } from './store.js';

export const DEFAULT_CONFIG_NAME = 'oh-my-opencode-slim';

const SETTINGS_KEYS = ['configFile', 'opencodeBin', 'modelCwd', 'opencodeConfigDir'];
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_PATH = 4096;

export function defaultSettings(env = process.env) {
  const home = env.HOME || os.homedir();
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : '';
  const base = path.join(xdg || path.join(home, '.config'), 'opencode');
  const jsonc = path.join(base, `${DEFAULT_CONFIG_NAME}.jsonc`);
  const json = path.join(base, `${DEFAULT_CONFIG_NAME}.json`);
  // JSONC wins when both exist; the standard JSONC path is displayed if neither does.
  const configFile = fs.existsSync(jsonc) ? jsonc : (fs.existsSync(json) ? json : jsonc);
  return { configFile, opencodeBin: 'opencode', modelCwd: home, opencodeConfigDir: '' };
}

function requireString(value, field) {
  if (typeof value !== 'string') throw badRequest(`settings.${field} must be a string.`, 'INVALID_SETTINGS');
  if (value.length > MAX_PATH || /[\r\n\0]/.test(value)) {
    throw badRequest(`settings.${field} contains unsupported characters.`, 'INVALID_SETTINGS');
  }
  return value;
}

export function validateSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('Settings must be an object with configFile, opencodeBin, modelCwd and opencodeConfigDir.', 'INVALID_SETTINGS');
  }
  const keys = Object.keys(input);
  const unknown = keys.filter(key => !SETTINGS_KEYS.includes(key));
  if (unknown.length) {
    throw badRequest(`Unknown settings fields: ${unknown.slice(0, 5).join(', ')}.`, 'INVALID_SETTINGS');
  }
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(input, key)) {
      throw badRequest(`settings.${key} is required.`, 'INVALID_SETTINGS');
    }
  }
  const configFile = requireString(input.configFile, 'configFile');
  if (!path.isAbsolute(configFile)) {
    throw badRequest('settings.configFile must be an absolute path.', 'INVALID_SETTINGS');
  }
  const opencodeBin = requireString(input.opencodeBin, 'opencodeBin');
  if (!opencodeBin) throw badRequest('settings.opencodeBin is required.', 'INVALID_SETTINGS');
  if (!path.isAbsolute(opencodeBin) && !EXECUTABLE_NAME.test(opencodeBin)) {
    throw badRequest('settings.opencodeBin must be an executable name or an absolute path.', 'INVALID_SETTINGS');
  }
  const modelCwd = requireString(input.modelCwd, 'modelCwd');
  if (!path.isAbsolute(modelCwd)) {
    throw badRequest('settings.modelCwd must be an absolute path.', 'INVALID_SETTINGS');
  }
  const opencodeConfigDir = requireString(input.opencodeConfigDir, 'opencodeConfigDir');
  if (opencodeConfigDir && !path.isAbsolute(opencodeConfigDir)) {
    throw badRequest('settings.opencodeConfigDir must be an absolute path or empty.', 'INVALID_SETTINGS');
  }
  return { configFile, opencodeBin, modelCwd, opencodeConfigDir };
}

function corruptSettings() {
  return new ServiceError(
    500,
    'SETTINGS_CORRUPT',
    'Saved service settings could not be read. Fix or remove settings.json in the extension data folder.',
  );
}

// Loads lazily so /health never touches settings, the target file or the CLI.
export function createSettingsStore({ dataDir, env = process.env } = {}) {
  const file = path.join(dataDir, 'settings.json');
  let cached = null;

  function persist(state) {
    const record = {
      version: 1,
      generation: state.generation,
      settings: state.explicit ? state.settings : null,
    };
    writeJsonStore(file, record);
  }

  function load() {
    if (cached) return cached;
    let record;
    try {
      record = readJsonStore(file, null);
    } catch {
      throw corruptSettings();
    }
    let settings;
    let explicit = false;
    let generation;
    if (record === null) {
      // A genuinely missing record starts from discovery.
      settings = defaultSettings(env);
      generation = randomUUID();
    } else {
      // An existing record must have the exact persisted shape. A partial record
      // ({}, {version:1}) is corrupt, never a silent fallback to defaults.
      if (typeof record !== 'object' || Array.isArray(record)) throw corruptSettings();
      const keys = Object.keys(record);
      if (keys.some(key => !['version', 'generation', 'settings'].includes(key))) throw corruptSettings();
      if (record.version !== 1) throw corruptSettings();
      if (typeof record.generation !== 'string' || !record.generation.length || record.generation.length > 200) {
        throw corruptSettings();
      }
      if (!Object.hasOwn(record, 'settings')) throw corruptSettings();
      generation = record.generation;
      if (record.settings !== null) {
        try {
          settings = validateSettings(record.settings);
        } catch {
          throw corruptSettings();
        }
        explicit = true;
      } else {
        settings = defaultSettings(env);
      }
    }
    cached = { settings, explicit, generation };
    if (record === null) {
      // Persist only the opaque generation, so discovery stays fresh on the next
      // start while the model cache keeps a stable scope. Failure is not fatal.
      try { persist(cached); } catch { /* settings stay usable in memory */ }
    }
    return cached;
  }

  return {
    get() {
      const state = load();
      return { settings: { ...state.settings }, generation: state.generation, explicit: state.explicit };
    },
    update(input) {
      const next = validateSettings(input);
      const generation = randomUUID();
      const state = { settings: next, explicit: true, generation };
      try {
        persist(state);
      } catch {
        throw new ServiceError(
          500,
          'SETTINGS_NOT_SAVED',
          'The new settings could not be saved in the extension data folder. Nothing changed.',
        );
      }
      cached = state;
      return { settings: { ...next }, generation, explicit: true };
    },
  };
}
