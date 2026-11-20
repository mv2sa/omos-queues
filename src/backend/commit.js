// The synchronous commit boundary: exclusive backup, exclusive same-directory
// temporary file, flush, last-moment byte check, atomic rename. Not a claim of
// perfect CAS against an uncooperative writer or power-loss durability.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceError, conflict } from './errors.js';

const failure = (message) => new ServiceError(500, 'COMMIT_FAILED', message);

function backupStamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support directory fsync; the rename itself is atomic.
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

function createBackup({ targetPath, before, mode, stamp, flush }) {
  const prefix = `${targetPath}.bak.pre-ui-${stamp}`;
  for (let suffix = 1; ; suffix += 1) {
    const backup = suffix === 1 ? prefix : `${prefix}.${suffix}`;
    let descriptor;
    try {
      descriptor = fs.openSync(backup, 'wx', mode);
      fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, before, 'utf8');
      flush(descriptor, 'backup');
      fs.closeSync(descriptor);
      descriptor = undefined;
      return backup;
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
        try { fs.unlinkSync(backup); } catch { /* never created or already gone */ }
      }
      if (error?.code === 'EEXIST') continue;
      throw failure('Could not create the backup file. Nothing was replaced.');
    }
  }
}

export function commitConfig({
  targetPath, before, after, hooks = {}, preview = null, validatePreview,
}) {
  const flush = hooks.flush ?? ((descriptor) => fs.fsyncSync(descriptor));
  const rename = hooks.rename ?? ((from, to) => fs.renameSync(from, to));
  // Server-composed source guard. Ordinary unbound previews keep the default
  // no-op and perform no source I/O. A throw (for example ServiceError 409)
  // stops the save before the backup and again before the replacement.
  const guard = validatePreview ?? hooks.validatePreview ?? (() => {});

  let mode;
  try {
    mode = fs.statSync(targetPath).mode & 0o777;
  } catch {
    throw new ServiceError(404, 'CONFIG_MISSING',
      'The selected config file is missing. Nothing was replaced.');
  }

  guard(preview);
  const backup = createBackup({ targetPath, before, mode, stamp: backupStamp(new Date()), flush });
  const temporary = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.ui-${randomUUID()}.tmp`);
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(temporary, 'wx', mode);
      fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, after, 'utf8');
      flush(descriptor, 'temporary');
      fs.closeSync(descriptor);
      descriptor = undefined;
    } catch {
      throw failure('Could not write the temporary config file. The config was not replaced.');
    }
    // Re-check the source binding inside the same synchronous boundary, after
    // the backup exists and before the last target-byte check. The guard may do
    // slow source I/O, so it must run before that check or an external write
    // during the guard would be overwritten.
    guard(preview);
    // Detect an external edit before replacing the file. Saves in this process
    // are synchronous, so no other accepted commit interleaves here.
    let current;
    try {
      current = fs.readFileSync(targetPath, 'utf8');
    } catch {
      throw conflict('The config is no longer readable. The reviewed edit was not written.',
        'BASE_HASH_MISMATCH');
    }
    if (current !== before) {
      throw conflict('The config changed during save. The reviewed edit was not written; reload and preview again.',
        'BASE_HASH_MISMATCH');
    }
    try {
      rename(temporary, targetPath);
    } catch {
      throw failure('Could not replace the config file. The config was not replaced.');
    }
    fsyncDirectory(path.dirname(targetPath));
    return { backup };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}
