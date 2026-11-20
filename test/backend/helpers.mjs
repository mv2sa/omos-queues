// Shared fixtures for backend tests. Everything lives under /tmp/opencode with
// synthetic HOME/XDG/data directories; no real config or CLI is touched.
import fs from 'node:fs';
import path from 'node:path';
import { createServiceServer } from '../../src/backend/server.js';

export const ROOT = '/tmp/opencode';
export const TOKEN = 'test-token-0123456789';

export const SAMPLE_CONFIG = `// team settings
{
  "presets": {
    "coding": {
      "build": { "model": "openai/gpt-5", "variant": "high" },
      "review": {
        "model": [
          "anthropic/claude-sonnet-4",
          { "id": "google/gemini-2.5-pro", "variant": "low" }
        ]
      },
      // structured preset agents
      "agents": {
        "docs": { "model": "openai/gpt-5-mini" }
      }
    },
    "legacy": {
      "pair": { "model": "openai/gpt-5" },
      "broken": { "model": 42 }
    }
  },
  "agents": {
    "explore": { "model": "\${env:EXPLORE_MODEL}", "variant": "low" },
    "custom": {
      "model": "openai/gpt-5",
      "description": "Custom agent",
      "prompt": "synthetic-private-text",
      "skills": ["memory"],
      "options": { "temperature": 0.2 }
    },
    "helper": { "model": [{ "id": "openai/gpt-5", "weight": 2 }] },
    "plain": { "model": "openai/gpt-5" }
  },
  "council": {
    "presets": {
      "board": {
        "seat1": { "model": "openai/gpt-5" },
        "seat2": { "model": ["anthropic/claude-sonnet-4"] }
      }
    }
  }
}
`;

export function makeRoot(name = 'case') {
  fs.mkdirSync(ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(ROOT, `backend-${name}-`));
}

export function makeEnv(root, overrides = {}) {
  const home = path.join(root, 'home');
  const xdg = path.join(root, 'xdg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    OPENCHAMBER_SERVICE_DATA_DIR: path.join(root, 'data'),
    OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    OPENCHAMBER_SERVICE_PORT: '0',
    ...overrides,
  };
}

export function writeFile(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

export function standardConfig(root) {
  return writeFile(path.join(root, 'xdg', 'opencode', 'oh-my-opencode-slim.jsonc'), SAMPLE_CONFIG);
}

export function settingsFor(env, overrides = {}) {
  return {
    configFile: path.join(env.XDG_CONFIG_HOME, 'opencode', 'oh-my-opencode-slim.jsonc'),
    opencodeBin: 'opencode',
    modelCwd: env.HOME,
    opencodeConfigDir: '',
    ...overrides,
  };
}

export async function startService(env, options = {}) {
  const service = createServiceServer({ env, ...options });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = service.server.address();
  return {
    service,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await service.close();
    },
  };
}

export async function call(baseUrl, method, route, { body, headers = {}, token = TOKEN } = {}) {
  const requestHeaders = { authorization: `Bearer ${token}`, ...headers };
  let payload;
  if (body !== undefined) {
    requestHeaders['content-type'] ??= 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON route reply */ }
  return { status: response.status, body: json, text, headers: response.headers };
}

export async function waitFor(check, { timeout = 10_000, interval = 40, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => { setTimeout(resolve, interval); });
  }
}

export function readTarget(targetPath) {
  return fs.readFileSync(targetPath, 'utf8');
}

export async function configSnapshot(baseUrl) {
  const result = await call(baseUrl, 'GET', '/config');
  if (result.status !== 200) throw new Error(`GET /config failed: ${result.status} ${result.text}`);
  return result.body;
}

export async function previewChange(baseUrl, change, snapshot) {
  const current = snapshot ?? await configSnapshot(baseUrl);
  return call(baseUrl, 'POST', '/preview', {
    body: { baseHash: current.baseHash, generation: current.target.generation, changes: [change] },
  });
}
