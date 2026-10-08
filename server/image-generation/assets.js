import fs from 'node:fs/promises';
import { linkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from './contracts.js';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function imageMetadata(bytes, claimedMime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image byte limit exceeded');
  const input = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
  const meta = await input.metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format) || !meta.width || !meta.height || (meta.pages ?? 1) !== 1) throw new Error('Expected a single PNG, JPEG or WebP image');
  const mime = `image/${meta.format}`;
  if (claimedMime && mime !== claimedMime) throw new Error('Image content does not match MIME type');
  await input.clone().stats();
  return { mime, width: meta.width, height: meta.height, bytes: bytes.length, sha256: sha256(bytes), extension: meta.format === 'jpeg' ? 'jpg' : meta.format };
}

export async function containedPath(workspace, relative, createParents = false) {
  if (typeof relative !== 'string' || !relative || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || /^[\\/]/.test(relative)) throw new Error('Image paths must be workspace-relative');
  const parts = relative.replace(/\\/g, '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('Invalid image path');
  const root = await fs.realpath(workspace);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (i < parts.length - 1 && createParents) { await fs.mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; }); stat = await fs.lstat(current); }
      else if (i < parts.length - 1) throw new Error('Image directory missing');
    }
    if (stat?.isSymbolicLink()) throw new Error('Image paths cannot contain symlinks');
    if (stat && i < parts.length - 1 && !stat.isDirectory()) throw new Error('Invalid image directory');
    if (stat) {
      const real = await fs.realpath(current);
      const rel = path.relative(root, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Image path escapes workspace');
    }
  }
  return current;
}

export async function readImageReference(workspace, relative, signal) {
  signal?.throwIfAborted();
  const file = await containedPath(workspace, relative);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid reference image size');
  const bytes = await fs.readFile(file, { signal });
  return { path: relative, ...await imageMetadata(bytes), bytes };
}

export async function writeImageAsset(workspace, relative, bytes, signal) {
  signal?.throwIfAborted();
  const meta = await imageMetadata(bytes);
  if (![`.${meta.extension}`, ...(meta.extension === 'jpg' ? ['.jpeg'] : [])].includes(path.extname(relative).toLowerCase())) throw new Error('Output extension must match image format');
  const destination = await containedPath(workspace, relative, true);
  const temporary = path.join(path.dirname(destination), `.minnow-image-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', signal });
    signal?.throwIfAborted();
    await containedPath(workspace, relative);
    signal?.throwIfAborted();
    linkSync(temporary, destination);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return { path: relative.replace(/\\/g, '/'), ...meta };
}

export async function imageThumbnail(bytes) {
  return sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}
