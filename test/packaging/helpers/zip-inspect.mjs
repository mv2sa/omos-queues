// An independent ZIP inspector for the packaging tests. It shares no code with
// scripts/lib/zip.mjs: it computes CRC-32 from its own table and walks the
// headers itself, so a bug in the writer cannot hide behind the same bug in the
// reader.
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const fail = (message) => {
  throw new Error(`Independent ZIP inspector: ${message}`);
};

export function findEnd(buffer) {
  for (let at = buffer.length - 22; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(at + 20);
      if (at + 22 + commentLength === buffer.length) return at;
    }
  }
  return fail('no end-of-central-directory record');
}

/** Extract every member and assert the archive is a well formed stored ZIP. */
export function inspectZip(buffer) {
  const end = findEnd(buffer);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) fail('multi-disk archive');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (directoryOffset + directorySize !== end) fail('central directory is not adjacent to the end record');
  const comment = buffer.toString('utf8', end + 22, end + 22 + buffer.readUInt16LE(end + 20));

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) fail(`central header ${index} signature`);
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const dosTime = buffer.readUInt16LE(cursor + 12);
    const dosDate = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const centralCommentLength = buffer.readUInt16LE(cursor + 32);
    const attributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + centralCommentLength;

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) fail(`local header ${name}`);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localTime = buffer.readUInt16LE(localOffset + 10);
    const localDate = buffer.readUInt16LE(localOffset + 12);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressed = buffer.readUInt32LE(localOffset + 18);
    const localUncompressed = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== name) fail(`local name for ${name}`);
    if (localFlags !== flags || localMethod !== method) fail(`header agreement for ${name}`);
    if (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed) {
      fail(`size and CRC agreement for ${name}`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressed);
    if (crc32(data) !== crc) fail(`CRC-32 for ${name}`);
    if (data.length !== uncompressed) fail(`stored size for ${name}`);

    entries.push({
      path: name,
      mode: (attributes >>> 16) & 0o177777,
      madeBy,
      flags,
      method,
      dosTime,
      dosDate,
      crc,
      compressed,
      uncompressed,
      extraLength,
      centralCommentLength,
      data: Buffer.from(data),
    });
  }
  if (cursor !== end) fail('central directory trailing bytes');
  return { entries, comment, count };
}

export const entryPaths = (archive) => inspectZip(archive).entries.map((entry) => entry.path);
export const entryMap = (archive) => new Map(inspectZip(archive).entries.map((entry) => [entry.path, entry.data]));
