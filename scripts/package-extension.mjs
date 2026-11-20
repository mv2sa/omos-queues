#!/usr/bin/env node
// Build the deterministic install payload in dist/:
//   dist/install/**              the exact bytes an install would use
//   dist/omos-queues-<version>.zip   the same bytes, fixed metadata
//   dist/receipt.json            hashes, source provenance and check results
//
// This never touches a live OpenChamber install, never writes the OMOS config
// and never reads a real config file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkBundles, checkPageDocument, checkRuntimeImports } from './lib/bundles.mjs';
import { readManifest } from './lib/manifest.mjs';
import {
  buildArchive, createReceipt, installPathIn, stagePayload, verifyPackage, writeArtifacts,
} from './lib/package-artifact.mjs';
import { collectPayload } from './lib/payload.mjs';
import { readSourceState } from './lib/provenance.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.dirname(SCRIPT_DIR);

const option = (argv, name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

export function runSdkChecker({ checker, payloadRoot, cwd, timeoutMs = 120_000 }) {
  try {
    return execFileSync('bun', ['--no-install', checker, payloadRoot], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    }).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('bun is required to run the SDK guest checker.');
    if (error?.killed) throw new Error('The SDK guest checker timed out.');
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ');
    throw new Error(`The SDK guest checker rejected the payload${detail ? `: ${detail}` : '.'}`);
  }
}

/**
 * Package the repository (or a fixture root in tests). Development mode is
 * explicit: the receipt records the tree as uncommitted, and only the release
 * script accepts an approved source revision.
 */
export async function packageExtension({
  root = REPOSITORY_ROOT,
  out = path.join(root, 'dist'),
  checker = path.join(root, 'node_modules/@openchamber/sdk/scripts/check-guest.ts'),
} = {}) {
  const { manifest, version } = await readManifest(root);
  await checkBundles(root);
  await checkPageDocument(root);
  const files = await collectPayload(root);
  const archive = buildArchive(files);
  const install = await stagePayload(out, files);
  await checkRuntimeImports(install);
  await fs.access(checker).catch(() => {
    throw new Error('node_modules/@openchamber/sdk/scripts/check-guest.ts is missing; run bun install.');
  });
  runSdkChecker({ checker, payloadRoot: install, cwd: root });

  const source = readSourceState(root);
  const receipt = createReceipt({
    version,
    files,
    archive,
    source,
    checks: {
      manifest: 'passed',
      whitelist: 'passed',
      deterministic: 'passed',
      sdkChecker: 'passed',
      runtimeImports: 'passed',
    },
  });
  await writeArtifacts(out, { archive, receipt });
  await verifyPackage({ root, out });
  return { receipt, archive, manifest, install };
}

const main = async () => {
  const argv = process.argv.slice(2);
  const root = path.resolve(option(argv, 'root') ?? REPOSITORY_ROOT);
  const out = path.resolve(option(argv, 'out') ?? path.join(root, 'dist'));
  const checker = path.resolve(option(argv, 'sdk-checker')
    ?? path.join(root, 'node_modules/@openchamber/sdk/scripts/check-guest.ts'));
  const { receipt } = await packageExtension({ root, out, checker });
  const state = receipt.source.state === 'committed'
    ? `source ${receipt.source.commit.slice(0, 12)}`
    : 'source uncommitted (development package; not releaseable)';
  console.log(`Packaged ${receipt.archive.file}`);
  console.log(`  bytes   ${receipt.archive.bytes}`);
  console.log(`  sha256  ${receipt.archive.sha256}`);
  console.log(`  members ${receipt.members.length} (${receipt.members.map((member) => member.path).join(', ')})`);
  console.log(`  ${state}`);
  console.log(`  verified ${path.relative(root, path.join(out, 'install')) || '.'}`);
};

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`Package creation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
