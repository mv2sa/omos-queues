// Focused preview diff. Each block is the exact AST slice of one edited model
// value, so no unrelated config bytes (neighboring settings, prompts, secrets)
// can appear regardless of line layout. Oversized values refuse the preview
// instead of dumping or truncating the document.
import { ServiceError } from './errors.js';

export const MAX_DIFF_BLOCK_BYTES = 64 * 1024;
export const MAX_DIFF_BLOCK_LINES = 2000;
export const MAX_DIFF_TOTAL_BYTES = 1024 * 1024;

function refuse() {
  return new ServiceError(
    422,
    'PREVIEW_TOO_LARGE',
    'The edited queue value is too large to display as a focused diff. Nothing was written.',
  );
}

function splitLines(text) {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function renderBlock({ path, before, after }, fileName) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) {
    suffix += 1;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const label = Array.isArray(path) ? path.join('.') : String(path);
  const lines = [
    `--- ${fileName} ${label} (current)`,
    `+++ ${fileName} ${label} (edited)`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  ];
  for (const line of removed) lines.push(`-${line.replace(/\r?\n$/, '')}`);
  for (const line of added) lines.push(`+${line.replace(/\r?\n$/, '')}`);
  return { text: `${lines.join('\n')}\n`, bytes: Buffer.byteLength(before) + Buffer.byteLength(after) };
}

export function renderModelValueDiffs({ fileName, blocks }) {
  if (!Array.isArray(blocks) || !blocks.length) return '';
  const rendered = [];
  let total = 0;
  for (const block of blocks) {
    const before = typeof block.before === 'string' ? block.before : '';
    const after = typeof block.after === 'string' ? block.after : '';
    if (splitLines(before).length > MAX_DIFF_BLOCK_LINES
      || splitLines(after).length > MAX_DIFF_BLOCK_LINES
      || Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_DIFF_BLOCK_BYTES) {
      throw refuse();
    }
    const next = renderBlock({ path: block.path, before, after }, fileName);
    total += next.bytes;
    if (total > MAX_DIFF_TOTAL_BYTES) throw refuse();
    rendered.push(next.text);
  }
  return rendered.join('');
}
