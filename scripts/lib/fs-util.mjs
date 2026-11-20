// Small filesystem helpers shared by the packaging scripts. Everything here is
// dependency-free and refuses symlinks for anything that becomes a payload byte.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const FILE_MODE = 0o644;
export const DIR_MODE = 0o755;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** Absolute, non-symlinked regular file inside `parent`. */
export async function readPayloadFile(parent, relative) {
  const absolute = path.resolve(parent, relative);
  if (!isInside(parent, absolute)) throw new Error(`Payload path escapes its root: ${relative}`);
  let info;
  try {
    info = await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${relative} is missing.`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${relative} must not be a symlink.`);
  if (!info.isFile()) throw new Error(`${relative} must be a regular file.`);
  return { absolute, data: await fs.readFile(absolute), info };
}

export async function listTree(root) {
  const found = [];
  const walk = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) found.push(absolute);
      else if (entry.isSymbolicLink()) found.push(absolute);
    }
  };
  await walk(root);
  return found;
}

/** Newest modification time of a tree, 0 when the tree is absent. */
export async function newestMtime(root) {
  const files = await listTree(root);
  let newest = 0;
  for (const file of files) {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) continue;
    newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

/** Recreate a directory as an empty, non-symlinked directory. */
export async function resetDirectory(directory) {
  let existing;
  try {
    existing = await fs.lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink()) await fs.unlink(directory);
  else if (existing) await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true, mode: DIR_MODE });
  await fs.chmod(directory, DIR_MODE);
}

/** Write bytes to an exact path, refusing to follow an existing symlink. */
export async function writeFileExact(absolute, data, mode = FILE_MODE) {
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: DIR_MODE });
  const handle = await fs.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(absolute, mode);
  const info = await fs.lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== mode) {
    throw new Error(`Could not write ${path.basename(absolute)} with mode ${mode.toString(8)}.`);
  }
}

export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Paths that must never appear in a shipped artifact or receipt. */
const PERSONAL_PATH = /(?:\/home\/|\/Users\/|\/root\/|\/tmp\/|[A-Za-z]:\\\\?Users\\\\)/;

export function personalPathHits(text) {
  return PERSONAL_PATH.test(text);
}
