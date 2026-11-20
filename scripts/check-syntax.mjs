#!/usr/bin/env node
// Parse every JavaScript source, test and build script with Node's checker. This
// is a syntax gate only; it does not run anything.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TREES = ['src', 'page', 'service', 'scripts', 'test'];
const SKIP = new Set(['node_modules', '.git', 'dist', '.slim', 'coverage']);

async function walk(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const main = async () => {
  const root = REPOSITORY_ROOT;
  const files = [];
  for (const tree of TREES) files.push(...await walk(path.join(root, tree)));
  const failures = [];
  for (const file of files.sort()) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const detail = `${error?.stderr ?? ''}`.trim().split('\n')[0] ?? 'parse error';
      failures.push(`${path.relative(root, file).split(path.sep).join('/')}: ${detail}`);
    }
  }
  if (failures.length > 0) {
    console.error(`Syntax check failed for ${failures.length} file(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Syntax check passed for ${files.length} file(s).`);
};

main().catch((error) => {
  console.error(`Syntax check could not run: ${error.message}`);
  process.exitCode = 1;
});
