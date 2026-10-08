import { gzipSync } from 'node:zlib';

function header(name, size, type = '0') {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100, 'utf8');
  bytes.write('0000644\0', 100);
  bytes.write('0000000\0', 108);
  bytes.write('0000000\0', 116);
  bytes.write(size.toString(8).padStart(11, '0') + '\0', 124);
  bytes.write('00000000000\0', 136);
  bytes.fill(32, 148, 156);
  bytes.write(type, 156);
  bytes.write('ustar\0', 257);
  bytes.write('00', 263);
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
  bytes.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return bytes;
}

export function paxRecord(key, value) {
  const record = `${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 2;
  while (length !== Buffer.byteLength(record) + String(length).length + 1) length = Buffer.byteLength(record) + String(length).length + 1;
  return Buffer.from(`${length} ${record}`);
}

export function githubArchive(entries, { commit = 'a'.repeat(40), transform, omitMetadata = false } = {}) {
  const parts = [];
  const entry = (name, bytes, type) => {
    bytes = Buffer.from(bytes);
    parts.push(header(name, bytes.length, type), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  };
  if (!omitMetadata) entry('pax_global_header', paxRecord('comment', commit), 'g');
  entry('repository-HEAD/', '', '5');
  for (const file of entries) entry(`repository-HEAD/${file.name}`, file.bytes ?? '', file.type ?? '0');
  parts.push(Buffer.alloc(1024));
  const archive = Buffer.concat(parts);
  return gzipSync(transform ? transform(archive) : archive);
}
