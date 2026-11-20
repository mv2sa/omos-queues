// The install payload is an exact allowlist. Nothing else from the source tree
// is ever read into it, so generated bundles are the only JavaScript and no
// source fixture, type source or dependency tree can leak in.
import path from 'node:path';

import { readPayloadFile, sha256 } from './fs-util.mjs';

export const PAYLOAD_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'page/index.html',
  'page/main.js',
  'page/styles.css',
  'service/main.js',
]);

export const PAYLOAD_LIMITS = Object.freeze({
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
});

export async function collectPayload(root) {
  const files = new Map();
  let total = 0;
  for (const relative of PAYLOAD_FILES) {
    const { data } = await readPayloadFile(root, relative);
    if (data.length === 0) throw new Error(`${relative} is empty; build the extension first.`);
    if (data.length > PAYLOAD_LIMITS.fileBytes) throw new Error(`${relative} exceeds the payload file limit.`);
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`${relative} is not a safe payload path.`);
    }
    total += data.length;
    if (total > PAYLOAD_LIMITS.totalBytes) throw new Error('The payload exceeds the total size limit.');
    files.set(relative, data);
  }
  return files;
}

export const payloadEntries = (files) => [...files].map(([memberPath, data]) => ({ path: memberPath, data }));

export const payloadDigest = (files) => [...files].map(([memberPath, data]) => ({
  path: memberPath,
  bytes: data.length,
  sha256: sha256(data),
}));
