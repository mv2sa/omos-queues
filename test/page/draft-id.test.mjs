import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createDraftId } from '../../src/page/draft-id.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('secure contexts use their native random UUID', () => {
  const expected = '00010203-0405-4607-8809-0a0b0c0d0e0f';
  assert.equal(createDraftId({ randomUUID: () => expected }), expected);
});

test('private HTTP contexts use cryptographic bytes with RFC4122 version and variant bits', () => {
  const id = createDraftId({ getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    return bytes;
  } });
  assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('fallback IDs use fresh cryptographic values for each frame or revision', () => {
  const random = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  const first = createDraftId(random);
  const second = createDraftId(random);
  assert.match(first, UUID_V4);
  assert.match(second, UUID_V4);
  assert.notEqual(first, second);
});

test('missing cryptographic randomness fails instead of using Math.random', () => {
  assert.throws(() => createDraftId({}), /cryptographic random values/);
});
