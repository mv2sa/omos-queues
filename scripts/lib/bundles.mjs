// Build-output checks: the payload ships generated bundles, so the packager must
// prove the bundles exist, come from the current sources, and actually run with
// no node_modules beside them. A gitignored bundle or a matching regex is not
// evidence; importing the file is.
import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listTree, newestMtime } from './fs-util.mjs';

export const PAGE_BUNDLE = 'page/main.js';
export const SERVICE_BUNDLE = 'service/main.js';

/** Bundle paths must exist, be regular files, and be newer than their sources. */
export async function checkBundles(root) {
  const bundles = [
    { bundle: PAGE_BUNDLE, source: 'src/page' },
    { bundle: SERVICE_BUNDLE, source: 'src/backend' },
  ];
  const summary = [];
  for (const { bundle, source } of bundles) {
    let info;
    try {
      info = await fs.lstat(path.join(root, bundle));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${bundle} is missing; run \`bun run build\` first.`);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${bundle} must be a regular generated file.`);
    if (info.size === 0) throw new Error(`${bundle} is empty; run \`bun run build\`.`);
    const newest = await newestMtime(path.join(root, source));
    if (newest === 0) throw new Error(`${source} is missing; there is no source for ${bundle}.`);
    if (info.mtimeMs < newest) {
      throw new Error(`${bundle} is stale: ${source} changed after the last build. Run \`bun run build\`.`);
    }
    summary.push({ bundle, source, bytes: info.size });
  }
  return summary;
}

const RESOURCE = /<(?:script|link|img|source|iframe)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/** The page document may only load payload-local assets, never a network URL. */
export async function checkPageDocument(root) {
  const document = await fs.readFile(path.join(root, 'page/index.html'), 'utf8').then(
    (text) => text,
    (error) => {
      if (error?.code === 'ENOENT') throw new Error('page/index.html is missing.');
      throw error;
    },
  );
  const problems = [];
  for (const match of document.matchAll(RESOURCE)) {
    const resource = match[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(resource) || resource.startsWith('//')) {
      problems.push(`page/index.html loads the external resource ${resource}.`);
      continue;
    }
    if (resource.includes('..') || resource.startsWith('/')) {
      problems.push(`page/index.html resource ${resource} must stay inside the payload.`);
      continue;
    }
    if (resource.toLowerCase().endsWith('.ts')) problems.push(`page/index.html loads ${resource}; load the built .js bundle.`);
  }
  if (problems.length > 0) throw new Error(`Page document:\n- ${problems.join('\n- ')}`);
  return document;
}

export function importSpecifiers(code) {
  // Use the already-required build tool's JavaScript parser, not a regex that
  // treats UI text or comments as executable imports. Scanning never runs code.
  const scanner = 'const code = await Bun.stdin.text(); '
    + 'console.log(JSON.stringify(new Bun.Transpiler({loader:"js"}).scanImports(code).map(item => item.path)));';
  try {
    return JSON.parse(execFileSync('bun', ['--eval', scanner], {
      input: code, encoding: 'utf8', timeout: 10_000, maxBuffer: 8_000_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch {
    throw new Error('JavaScript import scanning failed; a working Bun parser is required.');
  }
}

// The probe refuses the operations a passive module must not perform, and
// records any read outside the relocated app directory. Builtin exports are
// patched and re-exported to ESM before the guest is imported.
const PROBE_SCRIPT = (entryUrl) => `
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import cp from 'node:child_process';
import path from 'node:path';

const violations = [];
const record = (kind) => {
  violations.push(kind);
  throw new Error('observed ' + kind);
};
const root = process.cwd();
const entryFile = path.resolve(new URL(${JSON.stringify(entryUrl)}).pathname);
const fileOf = (value) => {
  try {
    if (value instanceof URL) return path.resolve(value.pathname);
    if (Buffer.isBuffer(value)) return path.resolve(value.toString());
    if (typeof value === 'string') return path.resolve(value);
  } catch {}
  return null;
};
const allowedRead = (args) => {
  const file = fileOf(args[0]);
  return file === null || file === entryFile || file.startsWith(root + path.sep);
};
const readFlags = (flags) => flags === undefined || flags === null
  || (typeof flags === 'string' ? !/[wa]/.test(flags)
    : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
      | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0);
const wrap = (target, name, handler) => {
  const original = target?.[name];
  if (typeof original !== 'function') return;
  target[name] = function patched(...args) { handler(args); return original.apply(this, args); };
};

for (const [target, name, kind] of [
  [http, 'createServer', 'http-server'],
  [https, 'createServer', 'https-server'],
  [net, 'createServer', 'net-server'],
  [net, 'connect', 'net-connect'],
  [net, 'createConnection', 'net-connect'],
  [http, 'request', 'http-client'],
  [http, 'get', 'http-client'],
  [https, 'request', 'http-client'],
  [https, 'get', 'http-client'],
]) {
  wrap(target, name, () => record(kind));
}
if (typeof http.Server?.prototype?.listen === 'function') {
  http.Server.prototype.listen = function patchedListen() { return record('listen'); };
}
if (typeof net.Server?.prototype?.listen === 'function') {
  net.Server.prototype.listen = function patchedListen() { return record('listen'); };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  wrap(cp, name, () => record('child-process'));
}
for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'mkdtemp', 'mkdtempSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
  'copyFile', 'copyFileSync', 'chmod', 'chmodSync', 'createWriteStream', 'symlink', 'symlinkSync']) {
  wrap(fs, name, () => record('fs-write:' + name));
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'copyFile', 'chmod', 'symlink']) {
  wrap(fsp, name, () => record('fs-write:' + name));
}
for (const name of ['readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'access', 'accessSync', 'realpath', 'realpathSync', 'existsSync', 'createReadStream', 'watch', 'watchFile']) {
  wrap(fs, name, (args) => { if (!allowedRead(args)) record('fs-read:' + name); });
}
for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath']) {
  wrap(fsp, name, (args) => { if (!allowedRead(args)) record('fs-read:' + name); });
}
const openSyncOriginal = fs.openSync;
fs.openSync = function patchedOpenSync(file, flags, ...rest) {
  if (!readFlags(flags) || !allowedRead([file])) return record('fs-open');
  return openSyncOriginal.call(this, file, flags, ...rest);
};
const openOriginal = fs.open;
fs.open = function patchedOpen(file, flags, ...rest) {
  if (!readFlags(flags) || !allowedRead([file])) return record('fs-open');
  return openOriginal.call(this, file, flags, ...rest);
};
process.exit = function patchedExit() { return record('process-exit'); };

syncBuiltinESMExports();

let guest = null;
try {
  guest = await import(${JSON.stringify(entryUrl)});
} catch (error) {
  if (violations.length === 0) {
    console.error('PROBE-IMPORT-ERROR:' + (error?.code ?? '') + ':' + (error?.message ?? String(error)));
    process.exitCode = 8;
  }
}

if (violations.length > 0) {
  console.error('PROBE-VIOLATION:' + violations.join(','));
  process.exitCode = 9;
} else if (guest) {
  const api = typeof guest.createServiceServer === 'function' || typeof guest.startService === 'function';
  if (!api) {
    console.error('PROBE-MISSING-EXPORTS');
    process.exitCode = 7;
  } else if ((process._getActiveHandles?.() ?? []).some((handle) => handle?.listening)) {
    console.error('PROBE-VIOLATION:listener-handle');
    process.exitCode = 9;
  } else {
    console.log('PROBE-PASSIVE-OK');
  }
}
`;

/**
 * The gate must run the guest under Node even when the build wrapper runs under
 * Bun, otherwise the result says nothing about the host. Bun's process.execPath
 * is Bun itself, so fall back to a real `node` on PATH.
 */
function resolveNodeExecutable() {
  // Bun reports process.release.name === 'node' for compatibility, so detect it
  // explicitly instead of trusting that field.
  if (typeof globalThis.Bun === 'undefined' && !process.versions?.bun) return process.execPath;
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      const identity = execFileSync(candidate, ['-p', 'process.versions.bun ? "bun" : process.version'], {
        encoding: 'utf8',
      }).trim();
      if (/^v\d+\./.test(identity)) return candidate;
    } catch {
      // Not an executable Node; keep looking.
    }
  }
  throw new Error('The passive import gate needs a Node executable on PATH when the build runs under Bun.');
}

/**
 * Import a built service the way the host will: plain Node, ESM, from a
 * directory with no node_modules on any ancestor path. The import must exit
 * cleanly without listening, without reading or writing app state outside the
 * relocated directory, and without launching a child process.
 */
export async function assertPassiveServiceImport(serviceFile, { timeoutMs = 30_000 } = {}) {
  const absolute = path.resolve(serviceFile);
  const info = await fs.lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw new Error(`${SERVICE_BUNDLE} is not a regular built file.`);

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omos-service-probe-'));
  try {
    const app = path.join(base, 'app');
    const entry = path.join(app, 'service', 'main.js');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.copyFile(absolute, entry);
    await fs.chmod(entry, 0o644);
    await fs.writeFile(path.join(app, 'package.json'), '{"type":"module"}\n');
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    await fs.mkdir(path.join(home, '.config'), { recursive: true, mode: 0o700 });
    await fs.mkdir(tmp, { mode: 0o700 });

    const node = resolveNodeExecutable();
    const result = spawnSync(node, ['--input-type=module', '-e', PROBE_SCRIPT(pathToFileURL(entry).href)], {
      cwd: app,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: tmp,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_STATE_HOME: path.join(home, '.state'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        NO_COLOR: '1',
      },
    });
    if (result.error?.code === 'ETIMEDOUT' || result.signal) {
      throw new Error(`${SERVICE_BUNDLE} did not exit after a passive import (a listener, timer or child is still running).`);
    }
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(0, 3).join(' | ');
      throw new Error(`${SERVICE_BUNDLE} failed a passive import from a directory without node_modules${detail ? `: ${detail}` : '.'}`);
    }
    if (!String(result.stdout).includes('PROBE-PASSIVE-OK')) {
      throw new Error(`${SERVICE_BUNDLE} did not report a passive import.`);
    }
    if ((await listTree(home)).length > 0) throw new Error(`${SERVICE_BUNDLE} wrote app state during a passive import.`);
    if ((await listTree(tmp)).length > 0) throw new Error(`${SERVICE_BUNDLE} wrote temporary state during a passive import.`);
    return { status: result.status };
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

/**
 * With no node_modules in the payload, every runtime import must be a Node
 * builtin or a payload-relative file. The page bundle is an IIFE, so it must not
 * have module syntax at all. The service is then imported for real: the known
 * failure mode was a UMD package whose inner require('./impl/format') only fails
 * when the file is actually run without node_modules.
 */
export async function checkRuntimeImports(root) {
  const problems = [];
  const page = await fs.readFile(path.join(root, PAGE_BUNDLE), 'utf8');
  const service = await fs.readFile(path.join(root, SERVICE_BUNDLE), 'utf8');

  for (const specifier of importSpecifiers(service)) {
    if (specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')) continue;
    problems.push(`${SERVICE_BUNDLE} imports ${specifier}, which needs node_modules.`);
  }
  for (const specifier of importSpecifiers(page)) {
    problems.push(`${PAGE_BUNDLE} is an IIFE but still has the module import ${specifier}.`);
  }
  for (const [file, code] of [[PAGE_BUNDLE, page], [SERVICE_BUNDLE, service]]) {
    // Module comments may name the files Bun bundled; only an actual specifier
    // would make the payload depend on node_modules, and the import below is the
    // final word.
    if (/@openchamber\/sdk/.test(code)) problems.push(`${file} was not bundled: it still references @openchamber/sdk.`);
  }
  if (problems.length > 0) throw new Error(`Runtime imports:\n- ${problems.join('\n- ')}`);

  const probe = await assertPassiveServiceImport(path.join(root, SERVICE_BUNDLE))
    .then(() => null, (error) => error.message);
  if (probe !== null) throw new Error(probe);
  return { page: page.length, service: service.length };
}
