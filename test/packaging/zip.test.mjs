import assert from 'node:assert/strict';
import test from 'node:test';

import { buildZip, parseZip, validateMemberPath, ZipError } from '../../scripts/lib/zip.mjs';
import { crc32, inspectZip } from './helpers/zip-inspect.mjs';

const files = [
  { path: 'service/main.js', data: Buffer.from('export const port = process.env.OPENCHAMBER_SERVICE_PORT;\n') },
  { path: 'package.json', data: Buffer.from('{"name":"fixture","private":true}\n') },
  { path: 'page/main.js', data: Buffer.from('(function(){})();\n') },
  { path: 'page/ünïcode.css', data: Buffer.from('body { color: black; }\n') },
];

test('the archive is byte-identical for identical input, in any order', () => {
  const first = buildZip(files);
  const repeated = buildZip([...files].reverse());
  const copied = files.map((file) => ({ path: file.path, data: Buffer.from(file.data) }));
  const again = buildZip(copied);
  assert.deepEqual(first, repeated);
  assert.deepEqual(first, again);
  assert.equal(first.length, again.length);
});

test('metadata is fixed: stored, UTF-8, 1980-01-01, mode 0644, no extra fields', () => {
  const archive = inspectZip(buildZip(files));
  assert.equal(archive.comment, '');
  assert.equal(archive.count, files.length);
  for (const entry of archive.entries) {
    assert.equal(entry.method, 0, `${entry.path} must be stored`);
    assert.equal(entry.flags, 0x0800, `${entry.path} must carry the UTF-8 flag`);
    assert.equal(entry.dosTime, 0);
    assert.equal(entry.dosDate, 0x0021);
    assert.equal(entry.mode, 0o100644);
    assert.equal(entry.extraLength, 0);
    assert.equal(entry.centralCommentLength, 0);
    assert.equal(entry.madeBy, (3 << 8) | 20);
  }
});

test('members are sorted by path and every CRC and size is independent-verifiable', () => {
  const archive = buildZip(files);
  const inspected = inspectZip(archive);
  const expectedOrder = [...files].map((file) => file.path)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.deepEqual(inspected.entries.map((entry) => entry.path), expectedOrder);
  const byPath = new Map(files.map((file) => [file.path, file.data]));
  for (const entry of inspected.entries) {
    assert.equal(entry.crc, crc32(byPath.get(entry.path)));
    assert.deepEqual(entry.data, byPath.get(entry.path));
    assert.equal(entry.uncompressed, byPath.get(entry.path).length);
  }
});

test('the strict reader extracts every byte and agrees with the independent inspector', () => {
  const archive = buildZip(files);
  const parsed = parseZip(archive);
  const inspected = inspectZip(archive);
  assert.deepEqual(parsed.entries.map((entry) => entry.path), inspected.entries.map((entry) => entry.path));
  for (const [index, entry] of parsed.entries.entries()) {
    assert.deepEqual(entry.data, inspected.entries[index].data);
    assert.equal(entry.crc, crc32(entry.data));
  }
});

test('a corrupted or truncated archive is rejected', () => {
  const archive = buildZip(files);
  const corrupted = Buffer.from(archive);
  const dataStart = 30 + Buffer.byteLength('package.json');
  corrupted[dataStart] ^= 0xff;
  assert.throws(() => parseZip(corrupted), ZipError);

  assert.throws(() => parseZip(archive.subarray(0, archive.length - 5)), ZipError);
  assert.throws(() => parseZip(Buffer.concat([archive, Buffer.from('comment')])), ZipError);
  assert.throws(() => parseZip(Buffer.from('not a zip')), ZipError);
});

test('unsafe payload paths are refused before an archive exists', () => {
  const bad = [
    '/etc/passwd', '../escape.js', 'page/../main.js', 'page\\main.js', 'node_modules/x/index.js',
    'page/main.ts', 'page//main.js', 'page/', '', 'a\0b.js',
  ];
  for (const path of bad) {
    assert.throws(() => validateMemberPath(path), ZipError, `expected ${JSON.stringify(path)} to be refused`);
  }
  assert.throws(() => buildZip([{ path: 'a.js', data: Buffer.from('x') }, { path: 'a.js', data: Buffer.from('y') }]), ZipError);
  assert.throws(() => buildZip([]), ZipError);
  assert.throws(() => buildZip([{ path: 'a.js', data: 'text' }]), ZipError);
});

test('a payload member carrying a local absolute path is detectable text', () => {
  const archive = buildZip([{ path: 'a.js', data: Buffer.from('const home = "/home/someone/file";') }]);
  const inspected = inspectZip(archive);
  assert.match(inspected.entries[0].data.toString('utf8'), /\/home\/someone\/file/);
});
