#!/usr/bin/env node
// Build the host service as one self-contained Node ESM file.
//
// The browser page uses the SDK's bundle command unchanged. The service needs a
// project-owned step because Bun resolves the bare `jsonc-parser` import to the
// package's `main` (a UMD bundle that calls require('./impl/format')). The
// payload ships no node_modules, so those inner requires can never resolve, and
// the host fails at runtime with "Cannot find module './impl/format'".
//
// A build plugin resolves only the bare `jsonc-parser` specifier to the
// package's official ESM entry (`module` in its package.json). Bun then bundles
// that entry's extensionless relative imports itself, the same way it bundles
// every other dependency. No installed package file is edited, and the output is
// plain Node ESM that is imported from a directory with no node_modules.
//
// Run with Bun: `bun scripts/build-service.mjs [--root <dir>] [--out <file>]`
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPassiveServiceImport } from './lib/bundles.mjs';

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = 'src/backend/main.js';
const OUTPUT = 'service/main.js';

const option = (argv, name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** The package's declared ESM entry, read from its own package.json. */
async function resolveJsoncEsmEntry(root) {
  const require = createRequire(path.join(root, 'package.json'));
  const packageJson = require.resolve('jsonc-parser/package.json');
  const meta = JSON.parse(await fs.readFile(packageJson, 'utf8'));
  if (meta.name !== 'jsonc-parser' || typeof meta.version !== 'string') {
    throw new Error('Resolved package.json is not jsonc-parser.');
  }
  const esmRelative = meta.module;
  if (typeof esmRelative !== 'string' || esmRelative.length === 0) {
    throw new Error(`jsonc-parser ${meta.version} declares no ESM "module" entry.`);
  }
  const esmEntry = path.resolve(path.dirname(packageJson), esmRelative);
  const info = await fs.lstat(esmEntry);
  if (!info.isFile()) throw new Error(`jsonc-parser ESM entry is not a file: ${esmRelative}`);
  return { esmEntry, version: meta.version, esmRelative };
}

/** Resolve exactly one bare specifier; every other import keeps Bun's rules. */
const jsoncEsmPlugin = (esmEntry) => ({
  name: 'jsonc-parser-esm',
  setup(build) {
    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: esmEntry }));
  },
});

/** Guard rails that name the known UMD failure instead of shipping it again. */
function checkSelfContained(code) {
  const problems = [];
  if (code.includes('jsonc-parser/lib/umd/')) problems.push('the UMD build of jsonc-parser was bundled');
  if (/require2?\(\s*["']\.\/impl\//.test(code)) problems.push('an unresolved require("./impl/…") survived bundling');
  if (/\b__require\b/.test(code)) problems.push('a CommonJS require shim survived bundling');
  if (problems.length > 0) {
    throw new Error(`The service bundle is not self-contained: ${problems.join('; ')}.`);
  }
}

async function buildService({ root, out }) {
  const bun = globalThis.Bun;
  if (!bun?.build) throw new Error('This build script needs Bun: run `bun scripts/build-service.mjs`.');
  const { esmEntry, version, esmRelative } = await resolveJsoncEsmEntry(root);
  const entry = path.resolve(root, ENTRY);
  const entryInfo = await fs.lstat(entry).catch(() => null);
  if (!entryInfo?.isFile()) throw new Error(`${ENTRY} is missing.`);

  // Bun 1.3.14 accepts `root` but formats module header comments relative to
  // the process working directory, so building a package that lives outside the
  // cwd would otherwise embed "../../../home/..." paths. Build from the package
  // root and restore the caller's cwd afterwards.
  const previousCwd = process.cwd();
  let code;
  try {
    process.chdir(root);
    const result = await bun.build({
      root,
      entrypoints: [entry],
      format: 'esm',
      target: 'node',
      minify: false,
      write: false,
      plugins: [jsoncEsmPlugin(esmEntry)],
    });
    if (!result.success) {
      const message = result.logs.map((log) => log.message).join('\n');
      throw new Error(message || 'Service build failed.');
    }
    const artifact = result.outputs.find((output) => output.path?.endsWith('.js')) ?? result.outputs[0];
    if (!artifact) throw new Error('Service build produced no output.');
    code = await artifact.text();
  } finally {
    process.chdir(previousCwd);
  }
  checkSelfContained(code);

  await fs.mkdir(path.dirname(out), { recursive: true });
  const temporary = `${out}.tmp`;
  await fs.writeFile(temporary, code, { mode: 0o644 });
  await fs.chmod(temporary, 0o644);
  await fs.rename(temporary, out);
  return { bytes: Buffer.byteLength(code), esmEntry, jsoncVersion: version, esmRelative };
}

const main = async () => {
  const argv = process.argv.slice(2);
  const root = path.resolve(option(argv, 'root') ?? REPOSITORY_ROOT);
  const out = path.resolve(option(argv, 'out') ?? path.join(root, OUTPUT));
  const { bytes, jsoncVersion, esmRelative } = await buildService({ root, out });

  // Prove the artifact the way the host will use it: plain Node, a directory
  // with no node_modules, and a passive import that must not listen, write app
  // state or launch children.
  await assertPassiveServiceImport(out);
  console.log(`Built ${path.relative(root, out)} (${bytes} bytes, ESM, jsonc-parser ${jsoncVersion} via ${esmRelative})`);
  console.log('Verified by importing it from a relocated directory without node_modules.');
};

main().catch((error) => {
  console.error(`Service build failed: ${error.message}`);
  process.exitCode = 1;
});
