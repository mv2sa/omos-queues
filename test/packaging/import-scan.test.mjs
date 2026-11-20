import test from 'node:test';
import assert from 'node:assert/strict';
import { importSpecifiers } from '../../scripts/lib/bundles.mjs';

test('import scanning ignores ordinary copy, comments, regexes and template text', () => {
  const code = [
    'const label = "Review import "; const data = { import: ":" };',
    '// import "comment-only";',
    '/* require("comment-only"); export { x } from "comment-only"; */',
    'const pattern = /import "regex-only"/;',
    'const help = `import "template-text-only"`;',
    'throw new Error("a scan must not execute this code");',
  ].join('\n');
  assert.deepEqual(importSpecifiers(code), []);
});

test('import scanning retains static imports, re-exports, dynamic imports and require calls', () => {
  const code = [
    'import fs from "node:fs";',
    'export { value } from "./value.js";',
    'const lazy = import("./lazy.js");',
    'const legacy = require("external-package");',
    'const template = `${import("./inside-template.js")}`;',
  ].join('\n');
  assert.deepEqual(importSpecifiers(code).sort(), [
    './inside-template.js', './lazy.js', './value.js', 'external-package', 'node:fs',
  ].sort());
});
