// Deterministic, dependency-free ZIP writer and strict reader for the install
// payload. Entries are stored (no compression) so the archive bytes depend only
// on the member paths and their bytes: same input, same archive, on any host.
//
// Fixed metadata: 1980-01-01 00:00, UTF-8 names, mode 0644, no extra fields,
// no comments, central directory sorted by path. That makes a rebuild from the
// same staged bytes byte-identical, which is what the release freshness proof
// relies on.
import { crc32 as zlibCrc32 } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix, spec 2.0
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const FILE_MODE = 0o100644;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

export class ZipError extends Error {}

const fail = (message) => {
  throw new ZipError(message);
};

const crcOf = (data) => zlibCrc32(data) >>> 0;

export function validateMemberPath(path) {
  if (typeof path !== 'string' || path.length === 0) fail('A ZIP member path must be a non-empty string.');
  if (path.length > 512) fail(`ZIP member path is too long: ${path.slice(0, 40)}…`);
  if (path.startsWith('/') || path.startsWith('\\')) fail(`ZIP member path must be relative: ${path}`);
  if (path.includes('\\')) fail(`ZIP member path must use "/": ${path}`);
  if (path.includes('\0')) fail('ZIP member path must not contain NUL.');
  if (path.endsWith('/')) fail(`ZIP member path must name a file: ${path}`);
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`ZIP member path must be normalized: ${path}`);
  }
  if (segments.includes('node_modules')) fail(`ZIP payload must not contain node_modules: ${path}`);
  if (path.toLowerCase().endsWith('.ts')) fail(`ZIP payload must not contain TypeScript sources: ${path}`);
  return path;
}

/**
 * Build a deterministic ZIP. `files` is an array of { path, data } where data is
 * a Buffer/Uint8Array. Input order is irrelevant: members are sorted by path.
 */
export function buildZip(files) {
  if (!Array.isArray(files) || files.length === 0) fail('A ZIP needs at least one member.');
  if (files.length > MAX_ENTRIES) fail('Too many ZIP members.');
  const members = files.map(({ path, data }) => {
    validateMemberPath(path);
    if (!(data instanceof Uint8Array)) fail(`ZIP member ${path} needs bytes.`);
    if (data.length > MAX_BYTES) fail(`ZIP member ${path} is too large.`);
    return { path, data: Buffer.from(data) };
  });
  const sorted = [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].path === sorted[index].path) fail(`Duplicate ZIP member: ${sorted[index].path}`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const member of sorted) {
    const name = Buffer.from(member.path, 'utf8');
    if (name.length > 0xffff) fail(`ZIP member path is too long: ${member.path}`);
    const crc = crcOf(member.data);
    const size = member.data.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(METHOD_STORE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, member.data);
    centrals.push(central);
    offset += local.length + size;
    if (offset > MAX_BYTES) fail('ZIP is larger than the classic ZIP limit.');
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

const readName = (name, where) => {
  if (Buffer.from(name, 'utf8').length > 0xffff) fail(`ZIP name is too long in ${where}.`);
  return name;
};

/** Strict reader: every header, CRC, size and mode is checked before returning. */
export function parseZip(archive) {
  if (!(archive instanceof Uint8Array)) fail('ZIP archive must be bytes.');
  const buffer = Buffer.from(archive);
  if (buffer.length < 22) fail('ZIP archive is too short.');
  let end = -1;
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= searchFrom; at -= 1) {
    if (buffer.readUInt32LE(at) === END_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) fail('ZIP end-of-central-directory record is missing.');
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) fail('Multi-disk ZIP is not supported.');
  const count = buffer.readUInt16LE(end + 10);
  if (buffer.readUInt16LE(end + 8) !== count) fail('ZIP member counts disagree.');
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  const commentLength = buffer.readUInt16LE(end + 20);
  if (commentLength !== 0) fail('ZIP comments are not supported in the payload.');
  if (end + 22 !== buffer.length) fail('ZIP archive has trailing bytes after its end record.');
  if (directoryOffset + directorySize !== end) fail('ZIP central directory is not adjacent to its end record.');

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end) fail('ZIP central directory is truncated.');
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) fail(`ZIP central header ${index} has a bad signature.`);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (flags !== UTF8_FLAG) fail(`ZIP member ${index} does not carry the UTF-8 flag.`);
    if (method !== METHOD_STORE) fail(`ZIP member ${index} is not stored.`);
    if (compressed !== uncompressed) fail(`ZIP member ${index} has inconsistent sizes.`);
    if (extraLength !== 0 || commentLength !== 0) fail(`ZIP member ${index} carries extra fields or a comment.`);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > end) fail('ZIP member name is truncated.');
    const path = readName(buffer.toString('utf8', nameStart, nameStart + nameLength), `member ${index}`);
    validateMemberPath(path);
    cursor = nameStart + nameLength;

    if (localOffset + 30 > directoryOffset) fail(`ZIP member ${path} points outside the file data.`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) fail(`ZIP member ${path} has a bad local signature.`);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (localFlags !== flags || localMethod !== method) fail(`ZIP member ${path} local and central headers disagree.`);
    const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== path) fail(`ZIP member ${path} local name disagrees with the central directory.`);
    if (localExtraLength !== 0) fail(`ZIP member ${path} carries a local extra field.`);
    const dataStart = localOffset + 30 + localNameLength;
    if (dataStart + uncompressed > directoryOffset) fail(`ZIP member ${path} data is truncated.`);
    const data = buffer.subarray(dataStart, dataStart + uncompressed);
    if (crcOf(data) !== crc) fail(`ZIP member ${path} fails its CRC.`);
    entries.push({ path, mode, crc, data: Buffer.from(data) });
  }
  if (cursor !== end) fail('ZIP central directory has trailing bytes.');
  return { entries, size: buffer.length };
}
