/**
 * Binary sniff for read_file — refuse to dump ZIP/OLE/image bytes as UTF-8,
 * but decode UTF-16 and mixed-encoding logs instead of calling them binary.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeTextBuffer, looksLikeBinaryBuffer } from '../../server/tools/binary-sniff.js';

describe('looksLikeBinaryBuffer', () => {
  it('treats empty and UTF-8 text as not binary', () => {
    assert.equal(looksLikeBinaryBuffer(Buffer.alloc(0)), false);
    assert.equal(looksLikeBinaryBuffer(Buffer.from('hello\nworld', 'utf8')), false);
  });

  it('detects ZIP local-file header used by xlsx (NUL after PK)', () => {
    // Minimal ZIP local header: PK\x03\x04 then zeros in the rest of the header.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(looksLikeBinaryBuffer(zip), true);
  });

  it('detects a NUL in the leading sample', () => {
    assert.equal(looksLikeBinaryBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])), true);
  });
});

describe('decodeTextBuffer', () => {
  it('reads plain UTF-8 without a note', () => {
    const decoded = decodeTextBuffer(Buffer.from('hello\nworld', 'utf8'));
    assert.equal(decoded.text, 'hello\nworld');
    assert.equal(decoded.encoding, 'utf8');
    assert.equal(decoded.note, undefined);
  });

  it('decodes a UTF-16LE log with a byte-order mark', () => {
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('npm test failed\r\n', 'utf16le'),
    ]);
    const decoded = decodeTextBuffer(buffer);
    assert.match(decoded.text, /npm test failed/);
    assert.equal(decoded.encoding, 'utf16le');
  });

  it('decodes a log that mixes UTF-8 and UTF-16LE sections', () => {
    // PowerShell redirects append UTF-16 after an ASCII header. The prefix length
    // is arbitrary, so the UTF-16 region can start at an odd byte offset — byte
    // parity alone cannot tell the decoder where a code unit begins.
    for (const header of ['=== ci gate ===\r\n', '== ci gate ==\r\n']) {
      const buffer = Buffer.concat([
        Buffer.from(header, 'utf8'),
        Buffer.from('tsc emitted no errors at all\r\n', 'utf16le'),
      ]);
      const decoded = decodeTextBuffer(buffer);
      assert.match(decoded.text, /ci gate/);
      assert.match(decoded.text, /tsc emitted no errors at all/);
      assert.equal(decoded.text.includes('\u0000'), false);
    }
  });

  it('decodes UTF-16BE without a mark', () => {
    const be = Buffer.from('big endian output line here\r\n', 'utf16le').swap16();
    assert.match(decodeTextBuffer(Buffer.from(be)).text, /big endian output line here/);
  });

  it('still refuses real binaries', () => {
    assert.equal(decodeTextBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), null);
    assert.equal(decodeTextBuffer(Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10])), null);
  });
});
