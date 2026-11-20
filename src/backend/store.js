// Bounded, atomic JSON persistence for service-owned data (settings, draft
// records, catalog cache). Nothing here touches the selected OMOS config.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_STORE_BYTES = 2 * 1024 * 1024;

// Creates or tightens only the exact service-owned directory. Never chmods a
// parent, never follows a symlink and never accepts another user's directory.
export function ensurePrivateDir(directory) {
  let stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
    stats = fs.lstatSync(directory);
  }
  if (stats.isSymbolicLink()) throw new Error('The service data directory must not be a symlink.');
  if (!stats.isDirectory()) throw new Error('The service data directory is not a directory.');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('The service data directory is not owned by this user.');
  }
  if ((stats.mode & 0o777) !== 0o700) {
    fs.chmodSync(directory, 0o700);
    stats = fs.lstatSync(directory);
    if ((stats.mode & 0o777) !== 0o700) throw new Error('The service data directory could not be made private.');
  }
  return directory;
}

// Reads a JSON store without following symlinks. A missing file returns the
// fallback; any other problem is thrown so a corrupt or substituted store is
// never silently replaced.
export function readJsonStore(file, fallback) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`Store ${path.basename(file)} could not be opened safely.`);
  }
  let text;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`Store ${path.basename(file)} is not a regular file.`);
    if (stats.size > MAX_STORE_BYTES) throw new Error(`Store ${path.basename(file)} is too large.`);
    text = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_STORE_BYTES) {
    throw new Error(`Store ${path.basename(file)} is too large.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Store ${path.basename(file)} is not valid JSON.`);
  }
}

// Writes mode 0600 in the same directory, flushes, then renames. On failure the
// previous file is untouched and the temporary file is removed.
export function writeJsonStore(file, value, { mode = 0o600 } = {}) {
  const directory = path.dirname(file);
  ensurePrivateDir(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}
