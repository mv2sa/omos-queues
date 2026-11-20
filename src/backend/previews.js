// Immutable reviewed previews. A record is the exact output that was diffed;
// commit never accepts revised edits, only its opaque token.
import { randomUUID } from 'node:crypto';

export const PREVIEW_TTL_MS = 15 * 60 * 1000;
export const MAX_PREVIEWS = 100;
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

export function createPreviewCache({
  now = Date.now,
  ttlMs = PREVIEW_TTL_MS,
  maxEntries = MAX_PREVIEWS,
  maxBytes = MAX_PREVIEW_BYTES,
} = {}) {
  const entries = new Map();
  let totalBytes = 0;

  const remove = token => {
    const entry = entries.get(token);
    if (!entry) return;
    totalBytes -= entry.bytes;
    entries.delete(token);
  };

  const purge = () => {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= now()) remove(token);
    }
  };

  return {
    add(record) {
      purge();
      const token = randomUUID();
      const bytes = Buffer.byteLength(record.after, 'utf8');
      const entry = Object.freeze({
        ...record,
        token,
        bytes,
        createdAt: now(),
        expiresAt: now() + ttlMs,
      });
      entries.set(token, entry);
      totalBytes += bytes;
      while (entries.size > maxEntries || totalBytes > maxBytes) {
        const oldest = entries.keys().next().value;
        remove(oldest);
      }
      return entry;
    },
    get(token) {
      purge();
      return entries.get(token) ?? null;
    },
    take(token) {
      const entry = this.get(token);
      if (entry) remove(token);
      return entry;
    },
    delete(token) {
      purge();
      remove(token);
    },
    clear() {
      entries.clear();
      totalBytes = 0;
    },
    size() {
      purge();
      return entries.size;
    },
  };
}
