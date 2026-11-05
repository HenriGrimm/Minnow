/**
 * Minimal zip reader for agent pack uploads (STORE + DEFLATE, no external deps).
 */

import { inflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * @typedef {{ path: string, data: Buffer, isDirectory: boolean }} ZipEntry
 */

/**
 * Read all file entries from a zip buffer.
 * @param {Buffer} buffer
 * @returns {ZipEntry[]}
 */
export function readZipEntries(buffer, { maxEntries, maxFileBytes, maxTotalBytes }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Invalid zip archive');
  }

  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  if (totalEntries > maxEntries) throw new Error(`Zip exceeds ${maxEntries} entry limit`);
  let totalBytes = 0;
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('Corrupt zip central directory');
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > buffer.length) {
      throw new Error('Corrupt zip central directory entry');
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error('Corrupt zip central directory entry');
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    if (uncompressedSize > maxFileBytes) throw new Error('Zip file exceeds per-file byte limit');
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) throw new Error('Zip exceeds total expanded byte limit');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const entryName = buffer.slice(nameStart, nameEnd).toString('utf8');
    offset = nameEnd + extraLength + commentLength;

    const localOffset = localHeaderOffset;
    if (localOffset + 30 > buffer.length) {
      throw new Error(`Corrupt zip entry: ${entryName}`);
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`Corrupt zip entry: ${entryName}`);
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.length) {
      throw new Error(`Corrupt zip entry data: ${entryName}`);
    }

    const compressed = buffer.slice(dataStart, dataEnd);
    const normalizedPath = normalizeZipEntryPath(entryName);
    const isDirectory = /[/\\\\]$/.test(entryName);

    if (isDirectory) {
      entries.push({ path: normalizedPath, data: Buffer.alloc(0), isDirectory: true });
      continue;
    }

    const data = decompressEntry(compressionMethod, compressed, uncompressedSize, entryName);
    entries.push({ path: normalizedPath, data, isDirectory: false });
  }

  return entries;
}

/**
 * @param {Buffer} buffer
 */
function findEndOfCentralDirectory(buffer) {
  const maxComment = 0xffff;
  const searchStart = Math.max(0, buffer.length - (22 + maxComment));
  for (let i = buffer.length - 22; i >= searchStart; i -= 1) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIR_SIG) {
      return i;
    }
  }
  throw new Error('Zip end-of-central-directory record not found');
}

/**
 * @param {number} method
 * @param {Buffer} compressed
 * @param {number} uncompressedSize
 * @param {string} entryName
 */
function decompressEntry(method, compressed, uncompressedSize, entryName) {
  if (method === METHOD_STORE) {
    if (compressed.length !== uncompressedSize) {
      throw new Error(`Corrupt stored entry: ${entryName}`);
    }
    return compressed;
  }
  if (method === METHOD_DEFLATE) {
    const data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
    if (data.length !== uncompressedSize) {
      throw new Error(`Corrupt deflated entry: ${entryName}`);
    }
    return data;
  }
  throw new Error(`Unsupported zip compression method ${method} on ${entryName}`);
}

/**
 * Normalize zip entry paths and reject traversal attempts.
 * @param {string} rawPath
 */
export function normalizeZipEntryPath(rawPath) {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || /[\x00-\x1f:]/.test(segment) ||
        /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new Error('Zip entry path traversal is not allowed');
    }
  }
  return segments.join('/');
}
