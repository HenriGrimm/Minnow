/**
 * The `.mnbak` container: one file, streamed in both directions.
 *
 *   MAGIC (8) | u32 headerLen | header JSON | payload
 *
 * The header is always readable — it is what a restore previews before asking
 * for a passphrase. The payload is a gzip stream of entries:
 *
 *   u32 metaLen | meta JSON | data (meta.s bytes) | sha256(data)
 *
 * Entry meta is `{ p: path, s: size, m: mtime, c: category }`, plus `k: 1` for a
 * credential file and `q: 1` for a SQLite store copied through the backup API.
 *   …
 *   u32 metaLen | { end: true, files, bytes }
 *
 * With a passphrase the gzip stream is cut into frames, each sealed with
 * AES-256-GCM under an scrypt-derived key:
 *
 *   u32 cipherLen | u8 final | ciphertext | tag (16)
 *
 * The nonce is a per-archive random prefix plus the frame counter; the header
 * digest and the final flag are bound in as AAD, so an edited header, a
 * reordered frame and a truncated archive all fail authentication.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BACKUP_MAGIC = Buffer.from('MNWBAK1\n', 'latin1');
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_FILE_EXTENSION = '.mnbak';

/** Shortest passphrase the app accepts for an encrypted backup. */
export const MIN_PASSPHRASE_LENGTH = 8;

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const NONCE_PREFIX_BYTES = 4;
const FRAME_PLAINTEXT_BYTES = 64 * 1024;
const HASH_BYTES = 32;

/** scrypt cost. N=2^17 needs ~128 MiB, hence the explicit maxmem. */
const KDF_DEFAULTS = { N: 1 << 17, r: 8, p: 1 };
const KDF_MAXMEM = 512 * 1024 * 1024;

/** Bounds on what a header may ask this process to allocate. */
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_META_BYTES = 64 * 1024;
const MAX_FRAME_CIPHER_BYTES = 1024 * 1024;
const MAX_KDF_N = 1 << 20;

export class BackupFormatError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'bad_archive') {
    super(message);
    this.name = 'BackupFormatError';
    this.code = code;
  }
}

/** @param {string} passphrase */
export function normalizePassphrase(passphrase) {
  return String(passphrase ?? '').normalize('NFKC');
}

/**
 * @param {string} passphrase
 * @param {{ N: number, r: number, p: number, salt: string }} kdf
 * @returns {Promise<Buffer>}
 */
function deriveKey(passphrase, kdf) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(normalizePassphrase(passphrase), 'utf8'),
      Buffer.from(kdf.salt, 'base64'),
      KEY_BYTES,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: KDF_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** @param {Buffer} headerBytes */
function headerDigest(headerBytes) {
  return crypto.createHash('sha256').update(BACKUP_MAGIC).update(headerBytes).digest();
}

/**
 * @param {Buffer} prefix
 * @param {number} counter
 */
function frameNonce(prefix, counter) {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(counter), NONCE_PREFIX_BYTES);
  return nonce;
}

/**
 * @param {Buffer} digest
 * @param {boolean} final
 */
function frameAad(digest, final) {
  return Buffer.concat([digest, Buffer.from([final ? 1 : 0])]);
}

/** Seal a byte stream into authenticated frames. */
class FrameEncryptor extends Transform {
  /**
   * @param {Buffer} key
   * @param {Buffer} noncePrefix
   * @param {Buffer} digest
   */
  constructor(key, noncePrefix, digest) {
    super();
    this.key = key;
    this.noncePrefix = noncePrefix;
    this.digest = digest;
    this.counter = 0;
    /** @type {Buffer[]} */
    this.pending = [];
    this.pendingBytes = 0;
  }

  /**
   * @param {Buffer} plaintext
   * @param {boolean} final
   */
  seal(plaintext, final) {
    const cipher = crypto.createCipheriv(CIPHER, this.key, frameNonce(this.noncePrefix, this.counter));
    cipher.setAAD(frameAad(this.digest, final));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.counter += 1;
    const head = Buffer.alloc(5);
    head.writeUInt32BE(ciphertext.length, 0);
    head[4] = final ? 1 : 0;
    this.push(Buffer.concat([head, ciphertext, cipher.getAuthTag()]));
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      // Hold one full frame back so the last frame can always be flagged final.
      while (this.pendingBytes > FRAME_PLAINTEXT_BYTES) {
        const all = Buffer.concat(this.pending);
        this.seal(all.subarray(0, FRAME_PLAINTEXT_BYTES), false);
        const rest = all.subarray(FRAME_PLAINTEXT_BYTES);
        this.pending = rest.length ? [rest] : [];
        this.pendingBytes = rest.length;
      }
      callback();
    } catch (err) {
      callback(/** @type {Error} */ (err));
    }
  }

  _flush(callback) {
    try {
      this.seal(Buffer.concat(this.pending), true);
      this.pending = [];
      this.pendingBytes = 0;
      callback();
    } catch (err) {
      callback(/** @type {Error} */ (err));
    }
  }
}

/** Open authenticated frames back into the byte stream they sealed. */
class FrameDecryptor extends Transform {
  /**
   * @param {Buffer} key
   * @param {Buffer} noncePrefix
   * @param {Buffer} digest
   */
  constructor(key, noncePrefix, digest) {
    super();
    this.key = key;
    this.noncePrefix = noncePrefix;
    this.digest = digest;
    this.counter = 0;
    this.buffer = Buffer.alloc(0);
    this.sawFinal = false;
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      for (;;) {
        if (this.buffer.length < 5) break;
        const cipherLen = this.buffer.readUInt32BE(0);
        if (cipherLen > MAX_FRAME_CIPHER_BYTES) {
          throw new BackupFormatError('Backup is damaged: oversized frame.');
        }
        const total = 5 + cipherLen + TAG_BYTES;
        if (this.buffer.length < total) break;
        if (this.sawFinal) {
          throw new BackupFormatError('Backup is damaged: data after the final frame.');
        }
        const final = this.buffer[4] === 1;
        const ciphertext = this.buffer.subarray(5, 5 + cipherLen);
        const tag = this.buffer.subarray(5 + cipherLen, total);
        const decipher = crypto.createDecipheriv(
          CIPHER,
          this.key,
          frameNonce(this.noncePrefix, this.counter),
        );
        decipher.setAAD(frameAad(this.digest, final));
        decipher.setAuthTag(tag);
        let plaintext;
        try {
          plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        } catch {
          throw new BackupFormatError(
            this.counter === 0
              ? 'Wrong passphrase, or this backup is damaged.'
              : 'Backup is damaged: a block failed authentication.',
            this.counter === 0 ? 'bad_passphrase' : 'bad_archive',
          );
        }
        this.counter += 1;
        this.sawFinal = final;
        this.buffer = this.buffer.subarray(total);
        if (plaintext.length) this.push(plaintext);
      }
      callback();
    } catch (err) {
      callback(/** @type {Error} */ (err));
    }
  }

  _flush(callback) {
    if (this.buffer.length > 0 || !this.sawFinal) {
      callback(new BackupFormatError('Backup is incomplete: it ends before its final block.'));
      return;
    }
    callback();
  }
}

/**
 * Write an archive. `entries` yields `{ meta, chunks }` in order; `chunks` is an
 * async iterable of Buffers totalling `meta.s` bytes.
 *
 * @param {{
 *   outPath: string,
 *   header: Record<string, unknown>,
 *   passphrase?: string,
 *   entries: AsyncIterable<{ meta: { p: string, s: number, [k: string]: unknown }, chunks: AsyncIterable<Buffer> }>,
 *   kdf?: { N: number, r: number, p: number },
 * }} options
 * @returns {Promise<{ files: number, bytes: number, archiveBytes: number }>}
 */
export async function writeArchive({ outPath, header, passphrase, entries, kdf }) {
  const encrypted = typeof passphrase === 'string' && passphrase.length > 0;
  const fullHeader = { ...header, format: BACKUP_FORMAT_VERSION, encrypted };
  /** @type {Buffer | null} */
  let key = null;
  /** @type {Buffer | null} */
  let noncePrefix = null;
  if (encrypted) {
    const params = { ...(kdf ?? KDF_DEFAULTS), salt: crypto.randomBytes(SALT_BYTES).toString('base64') };
    noncePrefix = crypto.randomBytes(NONCE_PREFIX_BYTES);
    fullHeader.cipher = CIPHER;
    fullHeader.kdf = { name: 'scrypt', ...params };
    fullHeader.noncePrefix = noncePrefix.toString('base64');
    key = await deriveKey(/** @type {string} */ (passphrase), params);
  }

  const headerBytes = Buffer.from(JSON.stringify(fullHeader), 'utf8');
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new BackupFormatError('Backup header is too large.');
  }

  let files = 0;
  let bytes = 0;

  async function* entryStream() {
    for await (const { meta, chunks } of entries) {
      const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
      if (metaBytes.length > MAX_ENTRY_META_BYTES) {
        throw new BackupFormatError(`Path is too long to archive: ${meta.p}`);
      }
      const len = Buffer.alloc(4);
      len.writeUInt32BE(metaBytes.length, 0);
      yield len;
      yield metaBytes;
      const hash = crypto.createHash('sha256');
      let seen = 0;
      for await (const chunk of chunks) {
        seen += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (seen !== meta.s) {
        throw new BackupFormatError(`${meta.p} changed while it was being backed up.`, 'source_changed');
      }
      yield hash.digest();
      files += 1;
      bytes += seen;
    }
    const end = Buffer.from(JSON.stringify({ end: true, files, bytes }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(end.length, 0);
    yield len;
    yield end;
  }

  // Opened by hand so an existing file rejects here instead of as a stream event.
  const handle = await fs.promises.open(outPath, 'wx', 0o600);
  const out = handle.createWriteStream();
  const prefix = Buffer.alloc(BACKUP_MAGIC.length + 4);
  BACKUP_MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.length, BACKUP_MAGIC.length);
  await new Promise((resolve, reject) => {
    out.write(Buffer.concat([prefix, headerBytes]), (err) => (err ? reject(err) : resolve(undefined)));
  });

  const stages = [Readable.from(entryStream(), { objectMode: false }), zlib.createGzip({ level: 4 })];
  if (key && noncePrefix) {
    stages.push(new FrameEncryptor(key, noncePrefix, headerDigest(headerBytes)));
  }
  await pipeline([...stages, out]);

  const { size: archiveBytes } = await fs.promises.stat(outPath);
  return { files, bytes, archiveBytes };
}

/**
 * Read and validate an archive's header without touching the payload.
 * @param {string} archivePath
 * @returns {Promise<{ header: Record<string, any>, headerBytes: Buffer, payloadOffset: number, archiveBytes: number }>}
 */
export async function readArchiveHeader(archivePath) {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const { size: archiveBytes } = await handle.stat();
    const prefix = Buffer.alloc(BACKUP_MAGIC.length + 4);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead < prefix.length || !prefix.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
      throw new BackupFormatError('This file is not a Minnow backup.', 'not_a_backup');
    }
    const headerLen = prefix.readUInt32BE(BACKUP_MAGIC.length);
    if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) {
      throw new BackupFormatError('Backup header is damaged.');
    }
    const headerBytes = Buffer.alloc(headerLen);
    const read = await handle.read(headerBytes, 0, headerLen, prefix.length);
    if (read.bytesRead < headerLen) {
      throw new BackupFormatError('Backup is incomplete: the header is cut short.');
    }
    let header;
    try {
      header = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      throw new BackupFormatError('Backup header is damaged.');
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      throw new BackupFormatError('Backup header is damaged.');
    }
    if (header.format !== BACKUP_FORMAT_VERSION) {
      throw new BackupFormatError(
        `This backup uses format ${header.format}, which this version of Minnow cannot read. Update Minnow and try again.`,
        'unsupported_format',
      );
    }
    if (header.encrypted) validateEncryptionHeader(header);
    return { header, headerBytes, payloadOffset: prefix.length + headerLen, archiveBytes };
  } finally {
    await handle.close();
  }
}

/** @param {Record<string, any>} header */
function validateEncryptionHeader(header) {
  const kdf = header.kdf;
  const okKdf =
    kdf &&
    kdf.name === 'scrypt' &&
    Number.isInteger(kdf.N) &&
    kdf.N >= 1 << 14 &&
    kdf.N <= MAX_KDF_N &&
    (kdf.N & (kdf.N - 1)) === 0 &&
    Number.isInteger(kdf.r) &&
    kdf.r >= 1 &&
    kdf.r <= 16 &&
    Number.isInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= 4 &&
    typeof kdf.salt === 'string' &&
    Buffer.from(kdf.salt, 'base64').length === SALT_BYTES;
  const okNonce =
    typeof header.noncePrefix === 'string' &&
    Buffer.from(header.noncePrefix, 'base64').length === NONCE_PREFIX_BYTES;
  if (header.cipher !== CIPHER || !okKdf || !okNonce) {
    throw new BackupFormatError('Backup encryption settings are damaged or unsupported.');
  }
}

/** Pull exact byte counts off an async iterable of Buffers. */
class ByteReader {
  /** @param {AsyncIterable<Buffer>} source */
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async pull() {
    if (this.ended) return false;
    const { value, done } = await this.iterator.next();
    if (done) {
      this.ended = true;
      return false;
    }
    if (value?.length) {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    }
    return true;
  }

  /** @param {number} n */
  async read(n) {
    while (this.buffer.length < n) {
      if (!(await this.pull())) {
        throw new BackupFormatError('Backup is incomplete: it ends in the middle of an entry.');
      }
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /**
   * Yield exactly `n` bytes in whatever chunks arrive.
   * @param {number} n
   */
  async *stream(n) {
    let left = n;
    while (left > 0) {
      if (this.buffer.length === 0 && !(await this.pull())) {
        throw new BackupFormatError('Backup is incomplete: it ends in the middle of a file.');
      }
      if (this.buffer.length === 0) continue;
      const take = Math.min(left, this.buffer.length);
      const chunk = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      left -= take;
      yield chunk;
    }
  }

  async drainToEnd() {
    while (await this.pull()) {
      /* keep pulling so stream errors (bad tag, truncated gzip) surface */
    }
    return this.buffer.length;
  }
}

/**
 * Walk an archive's entries. `onEntry` gets each entry's meta and a `chunks`
 * iterable it must fully consume (or call `skip()`); the content hash is checked
 * after it returns.
 *
 * @param {{
 *   archivePath: string,
 *   passphrase?: string,
 *   onEntry: (entry: {
 *     meta: { p: string, s: number, [k: string]: unknown },
 *     chunks: AsyncIterable<Buffer>,
 *     skip: () => Promise<void>,
 *   }) => Promise<void>,
 *   maxEntries?: number,
 * }} options
 * @returns {Promise<{ header: Record<string, any>, files: number, bytes: number }>}
 */
export async function readArchive({ archivePath, passphrase, onEntry, maxEntries = Infinity }) {
  const { header, headerBytes, payloadOffset } = await readArchiveHeader(archivePath);
  /** @type {import('node:stream').Readable} */
  let source = fs.createReadStream(archivePath, { start: payloadOffset });
  const stages = [source];

  if (header.encrypted) {
    if (!passphrase) {
      source.destroy();
      throw new BackupFormatError('This backup is encrypted. Enter its passphrase.', 'passphrase_required');
    }
    const key = await deriveKey(passphrase, header.kdf);
    stages.push(
      new FrameDecryptor(key, Buffer.from(header.noncePrefix, 'base64'), headerDigest(headerBytes)),
    );
  }
  const gunzip = zlib.createGunzip();
  stages.push(gunzip);

  // Errors anywhere in the chain must reach the reader, not an unhandled event.
  for (let i = 0; i < stages.length - 1; i += 1) {
    stages[i].on('error', (err) => gunzip.destroy(err));
    stages[i].pipe(stages[i + 1]);
  }

  const reader = new ByteReader(gunzip);
  let files = 0;
  let bytes = 0;
  let stopped = false;

  try {
    for (;;) {
      const metaLen = (await reader.read(4)).readUInt32BE(0);
      if (metaLen === 0 || metaLen > MAX_ENTRY_META_BYTES) {
        throw new BackupFormatError('Backup is damaged: unreadable entry.');
      }
      let meta;
      try {
        meta = JSON.parse((await reader.read(metaLen)).toString('utf8'));
      } catch (err) {
        if (err instanceof BackupFormatError) throw err;
        throw new BackupFormatError('Backup is damaged: unreadable entry.');
      }
      if (meta?.end === true) {
        if (meta.files !== files || meta.bytes !== bytes) {
          throw new BackupFormatError('Backup is damaged: its contents do not match its own totals.');
        }
        if ((await reader.drainToEnd()) > 0) {
          throw new BackupFormatError('Backup is damaged: data after the last entry.');
        }
        return { header, files, bytes };
      }
      if (typeof meta?.p !== 'string' || !Number.isSafeInteger(meta.s) || meta.s < 0) {
        throw new BackupFormatError('Backup is damaged: unreadable entry.');
      }

      const hash = crypto.createHash('sha256');
      let consumed = 0;
      const body = reader.stream(meta.s);
      async function* chunks() {
        for await (const chunk of body) {
          consumed += chunk.length;
          hash.update(chunk);
          yield chunk;
        }
      }
      const iterable = chunks();
      const skip = async () => {
        for await (const _chunk of iterable) {
          /* discard */
        }
      };
      await onEntry({ meta, chunks: iterable, skip });
      if (consumed !== meta.s) await skip();

      const expected = await reader.read(HASH_BYTES);
      if (!hash.digest().equals(expected)) {
        throw new BackupFormatError(`Backup is damaged: ${meta.p} does not match its checksum.`);
      }
      files += 1;
      bytes += meta.s;
      if (files >= maxEntries) {
        stopped = true;
        return { header, files, bytes };
      }
    }
  } catch (err) {
    // zlib reports a cut-off or corrupted stream with its own error codes.
    const code = /** @type {{ code?: unknown }} */ (err)?.code;
    if (!(err instanceof BackupFormatError) && typeof code === 'string' && code.startsWith('Z_')) {
      throw new BackupFormatError('Backup is damaged or incomplete: it could not be decompressed.');
    }
    throw err;
  } finally {
    if (stopped || !gunzip.readableEnded) {
      for (const stage of stages) stage.destroy();
    }
  }
}

/**
 * Check a passphrase against an encrypted archive by opening its first frame.
 * @param {string} archivePath
 * @param {string} passphrase
 * @returns {Promise<boolean>}
 */
export async function verifyArchivePassphrase(archivePath, passphrase) {
  const { header, headerBytes, payloadOffset } = await readArchiveHeader(archivePath);
  if (!header.encrypted) return true;
  if (!passphrase) return false;
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const head = Buffer.alloc(5);
    const first = await handle.read(head, 0, 5, payloadOffset);
    if (first.bytesRead < 5) return false;
    const cipherLen = head.readUInt32BE(0);
    if (cipherLen > MAX_FRAME_CIPHER_BYTES) return false;
    const body = Buffer.alloc(cipherLen + TAG_BYTES);
    const rest = await handle.read(body, 0, body.length, payloadOffset + 5);
    if (rest.bytesRead < body.length) return false;
    const key = await deriveKey(passphrase, header.kdf);
    const decipher = crypto.createDecipheriv(
      CIPHER,
      key,
      frameNonce(Buffer.from(header.noncePrefix, 'base64'), 0),
    );
    decipher.setAAD(frameAad(headerDigest(headerBytes), head[4] === 1));
    decipher.setAuthTag(body.subarray(cipherLen));
    try {
      decipher.update(body.subarray(0, cipherLen));
      decipher.final();
      return true;
    } catch {
      return false;
    }
  } finally {
    await handle.close();
  }
}

/**
 * True when the file starts with the backup magic. Never throws.
 * @param {string} filePath
 */
export async function looksLikeBackup(filePath) {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const magic = Buffer.alloc(BACKUP_MAGIC.length);
      const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
      return bytesRead === magic.length && magic.equals(BACKUP_MAGIC);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
