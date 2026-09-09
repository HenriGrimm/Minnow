/**
 * Detect buffers that are not UTF-8 text so read_file does not dump ZIP/OLE/image bytes.
 *
 * Windows tooling writes logs that mix UTF-8 and UTF-16 in one file (a PowerShell
 * redirect appended after an ASCII header, say). Those are text, not binaries, so
 * `decodeTextBuffer` segments the buffer by encoding instead of refusing on the
 * first NUL byte.
 */

/** Sample window — enough to catch ZIP/OLE/PNG headers and embedded NULs. */
const BINARY_SAMPLE_BYTES = 8192;

/** Classification window. Small enough that a short ASCII header gets its own run. */
const SEGMENT_WINDOW_BYTES = 64;

/** Code units that must match before a UTF-16 run boundary is accepted. */
const UTF16_CONFIRM_UNITS = 8;

/** Above this share of undecodable bytes the whole buffer is treated as binary. */
const BINARY_BYTE_RATIO = 0.02;

/**
 * True when the buffer is unlikely to be UTF-8 text (NUL in the leading sample).
 * Office/PDF paths should be routed to read_document before this check.
 *
 * Prefer `decodeTextBuffer` for read paths: this returns true for UTF-16 logs,
 * which are text.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function looksLikeBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }
  const sampleLen = Math.min(buffer.length, BINARY_SAMPLE_BYTES);
  for (let i = 0; i < sampleLen; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {'utf16' | 'text' | 'binary'}
 */
function classifyWindow(buffer, start, end) {
  let nulEven = 0;
  let nulOdd = 0;
  let ctrl = 0;
  const len = end - start;
  for (let i = start; i < end; i += 1) {
    const byte = buffer[i];
    if (byte === 0) {
      if (i % 2 === 0) nulEven += 1;
      else nulOdd += 1;
    } else if (byte < 9 || (byte > 13 && byte < 32)) {
      ctrl += 1;
    }
  }

  // UTF-16 text puts a NUL in every other byte. Which parity depends on where the
  // region starts, so only consistency matters here; the boundary scan below
  // resolves alignment and endianness.
  const dominant = Math.max(nulEven, nulOdd);
  const minor = Math.min(nulEven, nulOdd);
  const half = Math.max(1, Math.floor(len / 2));
  if (dominant / half >= 0.5 && minor <= dominant * 0.2) return 'utf16';
  if (dominant + minor > 0) return 'binary';
  return ctrl / len > 0.1 ? 'binary' : 'text';
}

/**
 * True when `index` starts a run of UTF-16 code units in the given endianness.
 *
 * @param {Buffer} buffer
 * @param {number} index
 * @param {number} nulOffset 1 for little-endian, 0 for big-endian
 * @returns {boolean}
 */
function startsUtf16Run(buffer, index, nulOffset) {
  for (let k = 0; k < UTF16_CONFIRM_UNITS * 2; k += 2) {
    const charByte = buffer[index + k + (1 - nulOffset)];
    if (buffer[index + k + nulOffset] !== 0 || charByte === undefined || charByte === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Find where a UTF-16 region really begins, and in which endianness.
 *
 * A window straddling the change from UTF-8 to UTF-16 is classified as one kind,
 * and the UTF-16 region can start at an odd offset, so neither the window
 * boundary nor byte parity can be trusted for the decoder's alignment.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {{ index: number, nulOffset: number, encoding: 'utf16le' | 'utf16be' } | null}
 */
function findUtf16Start(buffer, start, end) {
  for (let i = start; i + UTF16_CONFIRM_UNITS * 2 <= end; i += 1) {
    if (startsUtf16Run(buffer, i, 1)) return { index: i, nulOffset: 1, encoding: 'utf16le' };
    if (startsUtf16Run(buffer, i, 0)) return { index: i, nulOffset: 0, encoding: 'utf16be' };
  }
  return null;
}

/**
 * Split a buffer into runs of one encoding each.
 *
 * @param {Buffer} buffer
 * @returns {{ kind: string, start: number, end: number }[]}
 */
function segmentByEncoding(buffer) {
  /** @type {{ kind: string, start: number, end: number }[]} */
  const runs = [];
  for (let start = 0; start < buffer.length; start += SEGMENT_WINDOW_BYTES) {
    const end = Math.min(buffer.length, start + SEGMENT_WINDOW_BYTES);
    const kind = classifyWindow(buffer, start, end);
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.end = end;
    else runs.push({ kind, start, end });
  }

  for (let r = 0; r < runs.length; r += 1) {
    const run = runs[r];
    if (run.kind !== 'utf16') continue;

    const found = findUtf16Start(buffer, run.start, run.end);
    if (!found) {
      run.kind = 'binary';
      continue;
    }
    run.kind = found.encoding;

    if (found.index > run.start) {
      const prev = runs[r - 1];
      if (prev && prev.kind === 'text') {
        prev.end = found.index;
      } else {
        runs.splice(r, 0, { kind: 'text', start: run.start, end: found.index });
        r += 1;
      }
      run.start = found.index;
    }

    const next = runs[r + 1];
    if (next && next.kind === 'text') {
      // Back off to the last complete code unit so trailing UTF-8 bytes caught by
      // the final window go back to the text run.
      while (
        run.end - 2 >= run.start &&
        buffer[run.end - 1 - (1 - found.nulOffset)] !== 0
      ) {
        run.end -= 1;
      }
      next.start = run.end;
    }
    if ((run.end - run.start) % 2 !== 0) run.end -= 1;
  }

  return runs.filter((run) => run.end > run.start);
}

/**
 * @param {Buffer} buffer
 * @param {{ kind: string, start: number, end: number }} run
 * @returns {string}
 */
function decodeRun(buffer, run) {
  const slice = buffer.subarray(run.start, run.end);
  if (run.kind === 'utf16le') return new TextDecoder('utf-16le').decode(slice);
  if (run.kind === 'utf16be') return new TextDecoder('utf-16be').decode(slice);
  return slice.toString('utf8');
}

/** Share of control/replacement characters above which a decode is not text. */
const MAX_CONTROL_CHAR_RATIO = 0.02;

/**
 * Guard against a short binary blob whose byte parity happens to look like UTF-16.
 * The encoding heuristics only look at byte layout; this checks the result reads
 * as text.
 *
 * @param {string} text
 * @returns {boolean}
 */
function decodedTextIsPlausible(text) {
  const sample = text.slice(0, 4096);
  if (sample.length === 0) return true;
  let bad = 0;
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0xfffd || (code >= 0x7f && code <= 0x9f)) bad += 1;
  }
  return bad / sample.length <= MAX_CONTROL_CHAR_RATIO;
}

/**
 * @param {Buffer} buffer
 * @returns {{ encoding: 'utf16le' | 'utf16be' | 'utf8', skip: number } | null}
 */
function readBom(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0 && buffer[3] === 0) {
    return null; // UTF-32LE — not supported as text
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf16le', skip: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'utf16be', skip: 2 };
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf8', skip: 3 };
  }
  return null;
}

/**
 * Decode a file buffer as text, handling UTF-8, UTF-16, and files that mix them.
 *
 * Returns null when the buffer is genuinely binary (image, ZIP, OLE) and should
 * be routed to read_document or refused.
 *
 * @param {Buffer} buffer
 * @returns {{ text: string, encoding: string, note?: string } | null}
 */
export function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length === 0) return { text: '', encoding: 'utf8' };

  const bom = readBom(buffer);
  if (bom) {
    const body = buffer.subarray(bom.skip);
    if (bom.encoding === 'utf8') return { text: body.toString('utf8'), encoding: 'utf8' };
    return {
      text: decodeRun(body, { kind: bom.encoding, start: 0, end: body.length }),
      encoding: bom.encoding,
      note: `decoded as ${bom.encoding.toUpperCase()} (byte-order mark)`,
    };
  }

  // Fast path: no NUL anywhere means plain UTF-8 (or a single-byte legacy encoding).
  if (buffer.indexOf(0) === -1) {
    return { text: buffer.toString('utf8'), encoding: 'utf8' };
  }

  const runs = segmentByEncoding(buffer);
  let binaryBytes = 0;
  const kinds = new Set();
  for (const run of runs) {
    kinds.add(run.kind);
    if (run.kind === 'binary') binaryBytes += run.end - run.start;
  }
  if (binaryBytes / buffer.length > BINARY_BYTE_RATIO) {
    return null;
  }

  const text = runs.map((run) => decodeRun(buffer, run)).join('');
  if (!decodedTextIsPlausible(text)) {
    return null;
  }
  const encodings = [...kinds]
    .filter((kind) => kind !== 'binary')
    .map((kind) => (kind === 'text' ? 'utf8' : kind));
  const encoding = encodings.length === 1 ? encodings[0] : 'mixed';
  const note =
    encoding === 'mixed'
      ? `mixed encodings decoded per section (${encodings.join(' + ')})`
      : `decoded as ${String(encoding).toUpperCase()}`;
  return { text, encoding, note };
}
