import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { REPO_ROOT } from './helpers/fixture.mjs';

test('public CI is read-only safe and does not publish artifacts', async () => {
  const workflow = await fs.readFile(path.join(REPO_ROOT, '.github/workflows/check.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request_target|upload-artifact|release|secrets\.|workflow_dispatch/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /bun install --frozen-lockfile/);
  assert.match(workflow, /bun run check/);
  for (const sha of [
    '11d5960a326750d5838078e36cf38b85af677262',
    '49933ea5288caeca8642d1e84afbd3f7d6820020',
    '0c5077e51419868618aeaa5fe8019c62421857d6',
  ]) assert.ok(workflow.includes(sha));
});
