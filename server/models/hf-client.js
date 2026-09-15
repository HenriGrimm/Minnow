import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getModelsConfig } from './models-config.js';
import { expandSplitGgufFilenames } from './split-gguf.js';
import { validateGgufFilename, validateRepoId } from './validate.js';

let configTokenCache = { value: '', at: 0 };

const DOWNLOAD_STALL_MS = 120_000;

// ── Token ────────────────────────────────────────────────────────────────────

export function resolveHfToken() {
  const env = (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '').trim();
  if (env) return env;
  return configTokenCache.value;
}

export async function resolveHfTokenAsync() {
  const env = (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '').trim();
  if (env) return env;
  const now = Date.now();
  if (now - configTokenCache.at < 5_000 && configTokenCache.value) {
    return configTokenCache.value;
  }
  const models = await getModelsConfig();
  const token = typeof models.hfToken === 'string' ? models.hfToken.trim() : '';
  configTokenCache = { value: token, at: now };
  return token;
}

export function resetHfTokenCache() {
  configTokenCache = { value: '', at: 0 };
}

/**
 * @param {string} repoId
 * @param {string} [token]
 */
function hfHeaders(token) {
  const headers = { 'User-Agent': 'Minnow/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// ── Repo files ───────────────────────────────────────────────────────────────

/**
 * @param {string} repoId
 * @param {{ recursive?: boolean }} [options]
 * @returns {Promise<Array<{ path: string, size?: number }>>}
 */
export async function listRepoFiles(repoId, options = {}) {
  validateRepoId(repoId);
  const token = await resolveHfTokenAsync();
  const recursive = options.recursive === true ? '?recursive=true' : '';
  let url = `https://huggingface.co/api/models/${repoId}/tree/main${recursive}`;
  const data = [];
  const visited = new Set();
  while (url) {
    if (visited.has(url) || visited.size >= 100) throw new Error('Repository file listing is too large. Open a smaller repository.');
    visited.add(url);
    const res = await fetch(url, { headers: hfHeaders(token), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(hfErrorMessage(res.status));
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error('Hugging Face returned an invalid file listing. Try again.');
    data.push(...page);
    url = nextHfPage(res.headers.get('link'), `/api/models/${repoId}/tree/main`) ?? '';
  }
  return data
    .filter((row) => row && typeof row.path === 'string')
    .filter((row) => row.type === 'file' || row.type === undefined)
    .map((row) => ({ path: row.path, size: typeof row.size === 'number' ? row.size : undefined }));
}

export async function listRepoFilesRecursive(repoId) {
  return listRepoFiles(repoId, { recursive: true });
}

export function hfErrorMessage(status) {
  if (status === 401 || status === 403) return 'Hugging Face access denied. Add a token in Models settings and accept the model license on Hugging Face if required.';
  if (status === 404) return 'Repository or file not found on Hugging Face. Check the repository name and refresh its files.';
  if (status === 429) return 'Hugging Face is rate limiting requests. Wait a moment, then try again.';
  return `Hugging Face request failed (${status}). Check your connection and try again.`;
}

/** Never forward a token to a pagination URL outside the requested Hugging Face endpoint. */
export function nextHfPage(link, pathname) {
  const next = link?.split(',').find((part) => /rel="?next"?/.test(part))?.match(/<([^>]+)>/)?.[1];
  if (!next) return null;
  const url = new URL(next, 'https://huggingface.co');
  if (url.origin !== 'https://huggingface.co' || url.pathname !== pathname || url.username || url.password) {
    throw new Error('Invalid Hugging Face pagination URL');
  }
  return url.href;
}

/**
 * @param {string[]} ggufs
 * @param {string} [quant]
 * @returns {string[]}
 */
export function pickGgufFilenames(ggufs, quant = 'Q4_K_M') {
  if (!ggufs.length) {
    throw new Error('No GGUF files found');
  }
  const q = (quant || 'Q4_K_M').toUpperCase();
  const ranked = [
    ggufs.find((name) => name.toUpperCase().includes(q)),
    ggufs.find((name) => name.toUpperCase().includes('Q4_K_M')),
    ggufs.find((name) => name.toUpperCase().includes('Q4')),
    ggufs[0],
  ].filter(Boolean);
  return expandSplitGgufFilenames(ranked[0], ggufs);
}

/**
 * @param {string} repoId
 * @param {string} [quant]
 * @returns {Promise<string[]>}
 */
export async function resolveGgufFilename(repoId, quant = 'Q4_K_M') {
  const files = await listRepoFilesRecursive(repoId);
  const ggufs = files
    .map((f) => f.path)
    .filter((p) => p.toLowerCase().endsWith('.gguf'));
  if (!ggufs.length) {
    throw new Error(`No GGUF files found in ${repoId}`);
  }
  return pickGgufFilenames(ggufs, quant);
}

/**
 * @param {string} repoId
 * @param {string} filename
 */
export async function fetchRemoteSize(repoId, filename) {
  validateRepoId(repoId);
  const repoFilePath = filename.includes('/')
    ? validateRepoFilePath(filename)
    : validateGgufFilename(filename);
  const token = await resolveHfTokenAsync();
  const url = `https://huggingface.co/${repoId}/resolve/main/${encodeURI(repoFilePath)}`;
  const res = await fetch(url, { method: 'HEAD', headers: hfHeaders(token), redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`Hugging Face HEAD failed (${res.status})`);
  }
  const len = res.headers.get('content-length');
  return len ? Number(len) : null;
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal | undefined} signal
 */
async function readChunkWithStallTimeout(reader, signal) {
  let timer;
  let abort;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Download stalled (no data received)'));
        }, DOWNLOAD_STALL_MS);
      }),
      new Promise((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(new Error('Download cancelled'));
          return;
        }
        abort = () => reject(new Error('Download cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/**
 * @param {import('node:fs').WriteStream} file
 */
function finishWriteStream(file) {
  if (file.errored || file.destroyed) return Promise.reject(file.errored ?? new Error('Download file could not be written'));
  return new Promise((resolve, reject) => {
    file.on('finish', resolve);
    file.on('error', reject);
    file.end();
  });
}

/**
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function parseLinkedEtag(raw) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value) return null;
  if (value.startsWith('W/') || value.startsWith('w/')) value = value.slice(2).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (value.toLowerCase().startsWith('sha256:')) value = value.slice(7);
  value = value.trim();
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

/**
 * @param {string | null} header
 * @returns {{ start: number, end: number, total: number | null } | null}
 */
function parseContentRange(header) {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(header.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

async function hashFileInto(hasher, filePath) {
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * @param {string} url
 * @param {{ token?: string, rangeStart?: number, signal?: AbortSignal }} opts
 */
async function fetchHfPreservingRange(url, { token, rangeStart = 0, signal } = {}) {
  let current = url;
  let linkedEtag = null;
  for (let hop = 0; hop < 8; hop += 1) {
    /** @type {Record<string, string>} */
    const headers = { 'User-Agent': 'Minnow/1.0' };
    try {
      const host = new URL(current).hostname;
      if (token && (host === 'huggingface.co' || host.endsWith('.huggingface.co'))) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (rangeStart > 0) headers.Range = `bytes=${rangeStart}-`;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Download connection timed out. Retry to resume.')), DOWNLOAD_STALL_MS);
    let res;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
    } finally {
      clearTimeout(timer);
    }
    if (isRedirectStatus(res.status)) {
      linkedEtag = res.headers.get('x-linked-etag') ?? linkedEtag;
      const location = res.headers.get('location');
      if (res.body) await res.body.cancel().catch(() => {});
      if (!location) {
        throw new Error(`Hugging Face download failed (${res.status})`);
      }
      current = new URL(location, current).href;
      continue;
    }
    return { res, linkedEtag: res.headers.get('x-linked-etag') ?? linkedEtag };
  }
  throw new Error('Hugging Face download failed (too many redirects)');
}

/**
 * @param {{ url: string, destPath: string, token?: string, signal?: AbortSignal, onProgress?: (bytes: number, total: number | null) => void, errorLabel?: string }} opts
 */
async function streamHfUrlToFile({ url, destPath, token, signal, onProgress, errorLabel }) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.partial`;

  try {
    const destStat = await fsp.stat(destPath);
    if (destStat.isFile() && destStat.size > 0) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      onProgress?.(destStat.size, destStat.size);
      return { bytesReceived: destStat.size, totalBytes: destStat.size };
    }
  } catch {
  }

  let resumeFrom = 0;
  try {
    const partialStat = await fsp.stat(tmpPath);
    if (partialStat.isFile() && partialStat.size > 0) resumeFrom = partialStat.size;
  } catch {
    resumeFrom = 0;
  }

  let { res, linkedEtag } = await fetchHfPreservingRange(url, { token, rangeStart: resumeFrom, signal });
  if (res.status === 416 && resumeFrom > 0) {
    await res.body?.cancel().catch(() => {});
    ({ res, linkedEtag } = await fetchHfPreservingRange(url, { token, signal }));
    resumeFrom = 0;
  }
  if (!res.ok || !res.body) {
    const suffix = errorLabel ? ` for ${errorLabel}` : '';
    throw new Error(`${hfErrorMessage(res.status)}${suffix}`);
  }

  const append = res.status === 206;
  const writeFlags = append ? 'a' : 'w';
  const startOffset = append ? resumeFrom : 0;

  const contentRange = parseContentRange(res.headers.get('content-range'));
  if (append && (!contentRange || contentRange.start !== resumeFrom)) {
    await res.body.cancel().catch(() => {});
    throw new Error('Hugging Face returned an incorrect resume offset. Retry the download.');
  }
  const lengthHeader = res.headers.get('content-length');
  const length = lengthHeader ? Number(lengthHeader) : null;
  let totalBytes = null;
  if (append) {
    if (contentRange?.total != null) totalBytes = contentRange.total;
    else if (length != null) totalBytes = startOffset + length;
  } else if (length != null) {
    totalBytes = length;
  }

  const hasher = crypto.createHash('sha256');
  if (append && startOffset > 0) {
    await hashFileInto(hasher, tmpPath);
  }

  const file = fs.createWriteStream(tmpPath, { flags: writeFlags });
  let writeError = null;
  file.on('error', (err) => { writeError = err; });
  const reader = res.body.getReader();
  let bytesReceived = startOffset;

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Download cancelled');
      }
      const { done, value } = await readChunkWithStallTimeout(reader, signal);
      if (done) break;
      if (!value?.byteLength) continue;
      hasher.update(value);
      bytesReceived += value.byteLength;
      if (!file.write(value)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => { file.off('drain', drained); file.off('error', failed); };
          const drained = () => { cleanup(); resolve(); };
          const failed = (err) => { cleanup(); reject(err); };
          file.once('drain', drained);
          file.once('error', failed);
        });
      }
      if (writeError) throw writeError;
      onProgress?.(bytesReceived, totalBytes);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (!file.closed) await new Promise((resolve) => { file.once('close', resolve); file.destroy(); });
    throw err;
  }

  await finishWriteStream(file);

  if (totalBytes != null && bytesReceived !== totalBytes) {
    throw new Error(`Incomplete download (${bytesReceived} of ${totalBytes} bytes)`);
  }

  const written = await fsp.stat(tmpPath);
  if (written.size !== bytesReceived) {
    throw new Error(`Incomplete download (file size mismatch)`);
  }

  const expected = parseLinkedEtag(linkedEtag);
  if (expected) {
    const digest = hasher.digest('hex');
    if (digest !== expected) {
      await fsp.rm(tmpPath, { force: true });
      throw new Error(`Checksum mismatch (sha256 ${digest} != ${expected})`);
    }
  }

  await fsp.rename(tmpPath, destPath);
  return { bytesReceived, totalBytes: totalBytes ?? bytesReceived };
}

// ── Download HF ──────────────────────────────────────────────────────────────

/**
 * @param {{ repoId: string, filename: string, destPath: string, signal?: AbortSignal, onProgress?: (bytes: number, total: number | null) => void }} opts
 */
export async function downloadHfFile({ repoId, filename, destPath, signal, onProgress }) {
  validateRepoId(repoId);
  const repoFilePath = validateRepoFilePath(filename);
  const token = await resolveHfTokenAsync();
  const url = `https://huggingface.co/${repoId}/resolve/main/${encodeURI(repoFilePath)}`;
  return streamHfUrlToFile({ url, destPath, token, signal, onProgress });
}

/**
 * @param {string} filename
 */
export function validateRepoFilePath(filename) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid file path');
  }
  if (filename.includes('..') || filename.startsWith('/') || /[\\:#?\u0000-\u001f]/.test(filename)) {
    throw new Error('Invalid file path');
  }
  return filename;
}

/**
 * @param {{ repoId: string, filename: string, destPath: string, signal?: AbortSignal, onProgress?: (bytes: number, total: number | null) => void }} opts
 */
export async function downloadHfRepoFile({ repoId, filename, destPath, signal, onProgress }) {
  validateRepoId(repoId);
  validateRepoFilePath(filename);
  const token = await resolveHfTokenAsync();
  const url = `https://huggingface.co/${repoId}/resolve/main/${encodeURI(filename)}`;
  return streamHfUrlToFile({
    url,
    destPath,
    token,
    signal,
    onProgress,
    errorLabel: filename,
  });
}

/**
 * @param {string} pattern
 */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * @param {string} filePath
 * @param {string[]} patterns
 */
function matchesAnyGlob(filePath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export const MLX_SNAPSHOT_EXCLUDE = ['**/*.gguf', 'original/**', '**/*.pth', '**/*.bin'];

/**
 * @param {{ repoId: string, destDir: string, signal?: AbortSignal, include?: string[], exclude?: string[], onProgress?: (bytes: number, total: number | null) => void }} opts
 */
export async function downloadHfSnapshot({
  repoId,
  destDir,
  signal,
  include,
  exclude,
  onProgress,
}) {
  validateRepoId(repoId);
  const listed = await listRepoFilesRecursive(repoId);
  if (!listed.length) {
    throw new Error(`No files found in ${repoId}`);
  }

  const files = listed.filter((file) => {
    if (include?.length && !matchesAnyGlob(file.path, include)) return false;
    if (exclude?.length && matchesAnyGlob(file.path, exclude)) return false;
    return true;
  });
  if (!files.length) {
    throw new Error(`No files in ${repoId} matched the download filter`);
  }

  const totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0) || null;
  let completedBytes = 0;

  for (const file of files) {
    if (signal?.aborted) {
      throw new Error('Download cancelled');
    }
    const destPath = path.join(destDir, file.path);
    let fileBytes = 0;
    const result = await downloadHfRepoFile({
      repoId,
      filename: file.path,
      destPath,
      signal,
      onProgress: (received) => {
        fileBytes = received;
        onProgress?.(completedBytes + fileBytes, totalBytes);
      },
    });
    completedBytes += result.bytesReceived;
    onProgress?.(completedBytes, totalBytes);
  }

  return { bytesReceived: completedBytes, totalBytes };
}
