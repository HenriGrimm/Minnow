import { gunzipSync } from 'node:zlib';
import { relativeFile, MAX_PACKAGE_BYTES } from './manifest.js';

export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_REPOSITORY_BYTES = 64 * 1024 * 1024;

function field(header, start, end) {
  return header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
}

function octal(value) {
  if (!/^[0-7]+$/.test(value.trim())) throw new Error('Invalid GitHub archive header.');
  return parseInt(value.trim(), 8);
}

function paxFields(bytes) {
  const fields = Object.create(null);
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (space < offset || !/^\d+$/.test(lengthText)) throw new Error('Invalid GitHub archive metadata.');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error('Invalid GitHub archive metadata.');
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error('Invalid GitHub archive metadata.');
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

export function readGitHubArchive(compressed) {
  let archive;
  try { archive = gunzipSync(compressed, { maxOutputLength: MAX_REPOSITORY_BYTES }); }
  catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Repository archive exceeds 64 MiB. Use a local plugin folder instead.');
    throw new Error('Invalid GitHub source archive.');
  }
  const entries = [];
  const names = new Set();
  let commit;
  let extended = {};
  let root;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (archive.subarray(offset).some(byte => byte !== 0)) throw new Error('Invalid GitHub archive trailer.');
      if (!commit || Object.keys(extended).length) throw new Error('GitHub archive is missing commit metadata.');
      return { entries, commit };
    }
    const checksum = octal(field(header, 148, 156));
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    if (actual !== checksum) throw new Error('Invalid GitHub archive checksum.');
    const size = octal(field(header, 124, 136));
    const end = offset + 512 + size;
    if (end > archive.length) throw new Error('Truncated GitHub source archive.');
    const data = archive.subarray(offset + 512, end);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = field(header, 156, 157);
    if (type === 'g' || type === 'x') {
      if (size > 65536) throw new Error('GitHub archive metadata is too large.');
      const metadata = paxFields(data);
      if (type === 'g') {
        if (!/^[0-9a-f]{40}$/.test(metadata.comment ?? '') || (commit && commit !== metadata.comment)) throw new Error('GitHub archive has invalid commit metadata.');
        commit = metadata.comment;
      } else {
        if (Object.keys(metadata).some(key => key !== 'path' && key !== 'mtime' && key !== 'atime' && key !== 'ctime')) throw new Error('Unsupported GitHub archive metadata.');
        extended = metadata;
      }
      continue;
    }
    const prefix = field(header, 345, 500);
    const name = relativeFile((extended.path ?? `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`).replace(/\/$/, ''));
    extended = {};
    const slash = name.indexOf('/');
    const entryRoot = slash < 0 ? name : name.slice(0, slash);
    if (root && root !== entryRoot) throw new Error('GitHub archive has multiple repository roots.');
    root = entryRoot;
    if (slash < 0) {
      if (type !== '5') throw new Error('Invalid GitHub archive root.');
      continue;
    }
    const relative = name.slice(slash + 1);
    if (names.has(relative)) throw new Error('Duplicate GitHub archive entry.');
    names.add(relative);
    if (entries.length >= 16384) throw new Error('Repository archive has too many entries. Use a local plugin folder instead.');
    entries.push({ name: relative, bytes: data, type });
  }
  throw new Error('Truncated GitHub source archive.');
}

export function selectArchivePlugin(entries, subpath) {
  const isFile = entry => entry.type === '0' || entry.type === '';
  let folder = subpath;
  if (!folder && !entries.some(entry => entry.name === 'plugin.json' && isFile(entry))) {
    const manifests = entries.filter(entry => entry.name.endsWith('/plugin.json') && isFile(entry));
    if (manifests.length > 1) throw new Error('This repository contains multiple plugins. Paste the GitHub folder URL for the plugin you want.');
    if (manifests.length === 1) folder = manifests[0].name.slice(0, -'/plugin.json'.length);
  }
  const prefix = folder ? `${folder}/` : '';
  const selected = entries.filter(entry => entry.name.startsWith(prefix));
  if (!selected.some(entry => entry.name === `${prefix}plugin.json` && isFile(entry))) throw new Error('No plugin.json found. Paste the GitHub URL of the folder containing plugin.json.');
  if (selected.length > 512) throw new Error('Plugin directory tree is too large.');
  const files = [];
  let total = 0;
  for (const entry of selected) {
    const name = relativeFile(entry.name.slice(prefix.length));
    if (entry.type === '5') continue;
    if (!isFile(entry)) throw new Error(`Links and special files are not allowed: ${name}`);
    total += entry.bytes.length;
    if (files.length >= 256 || total > MAX_PACKAGE_BYTES) throw new Error('Plugin exceeds 8 MiB or 256 files.');
    files.push({ name, bytes: entry.bytes });
  }
  return { files, folder };
}
