/**
 * Issue attachments: images and files stored beside the issues state file.
 *
 * `POST   /api/issues/attachments`        body { issueId, name, mime, data }  (base64)
 * `GET    /api/issues/attachments?key=…`  raw bytes for preview
 * `DELETE /api/issues/attachments?key=…`
 *
 * Files live under `~/.minnow/issues/attachments/<issueId>/<name>` so an agent
 * can be handed a real path and read the screenshot the user pasted — the point
 * of §10's "attachment read access". Every path is rebuilt server-side from
 * sanitized segments in `config/paths.js`; the client never addresses a file by
 * anything the server has not re-derived.
 *
 * Phase 2 of `documentation/plans/issues-app-v2.md`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  issuesAttachmentPath,
  resolveIssueAttachmentPath,
  sanitizeAttachmentSegment,
} from '../config/paths.js';

const ROUTE = '/api/issues/attachments';
/** Refuse anything that would bloat the debounced state file's neighbourhood. */
const MAX_BYTES = 12 * 1024 * 1024;
/** Cap on the JSON envelope, which is base64 and so ~4/3 of the payload. */
const MAX_BODY_BYTES = Math.ceil(MAX_BYTES * 1.4) + 4096;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Attachment too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Never overwrite: a second `screenshot.png` becomes `screenshot-2.png`.
 *
 * Silently replacing a file the user already attached would lose data with no
 * signal, and attachments have no undo.
 *
 * @param {string} issueId
 * @param {string} name
 * @param {Buffer} bytes
 * @returns {Promise<{ absolute: string, fileName: string }>}
 */
async function saveAttachment(issueId, name, bytes) {
  const safe = sanitizeAttachmentSegment(name, 'file');
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;

  await fs.mkdir(path.dirname(issuesAttachmentPath(issueId, safe)), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const suffix = attempt === 0 ? '' : '-' + (attempt + 1);
    const extension = ext.slice(0, 96 - suffix.length - 1);
    const candidate = stem.slice(0, 96 - extension.length - suffix.length) + suffix + extension;
    const absolute = issuesAttachmentPath(issueId, candidate);
    let file;
    try {
      file = await fs.open(absolute, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      try { await file.writeFile(bytes); } finally { await file.close(); }
    } catch (error) {
      await fs.unlink(absolute);
      throw error;
    }
    return { absolute, fileName: path.basename(absolute) };
  }
  throw new Error('Too many attachments with that name');
}

// Accepts a data: URL or bare base64 (paste vs file input).
function decodeBase64(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('data is required');
  const comma = raw.startsWith('data:') ? raw.indexOf(',') : -1;
  const payload = comma >= 0 ? raw.slice(comma + 1) : raw;
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) throw new Error('data is empty');
  if (buffer.length > MAX_BYTES) throw new Error('Attachment exceeds 12 MB');
  return buffer;
}

async function handlePost(req, res) {
  const body = await readJsonBody(req);
  const issueId = typeof body?.issueId === 'string' ? body.issueId.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!issueId) {
    sendJson(res, 400, { error: 'issueId is required' });
    return;
  }
  if (!name) {
    sendJson(res, 400, { error: 'name is required' });
    return;
  }

  let buffer;
  try {
    buffer = decodeBase64(body?.data);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid data' });
    return;
  }

  const { absolute, fileName } = await saveAttachment(issueId, name, buffer);

  const issueSegment = sanitizeAttachmentSegment(issueId, 'issue');
  sendJson(res, 200, {
    ok: true,
    attachment: {
      key: `${issueSegment}/${fileName}`,
      name: fileName,
      path: absolute,
      bytes: buffer.length,
      mime:
        (typeof body?.mime === 'string' && body.mime.trim()) ||
        MIME_BY_EXT[path.extname(fileName).toLowerCase()] ||
        'application/octet-stream',
    },
  });
}

async function handleGet(req, res, key) {
  const absolute = resolveIssueAttachmentPath(key);
  let bytes;
  try {
    bytes = await fs.readFile(absolute);
  } catch {
    sendJson(res, 404, { error: 'Attachment not found' });
    return;
  }
  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    MIME_BY_EXT[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
  );
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(bytes);
}

async function handleDelete(res, key) {
  const absolute = resolveIssueAttachmentPath(key);
  try {
    await fs.unlink(absolute);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  sendJson(res, 200, { ok: true });
}

/** Connect middleware for the attachments route. */
export function createIssueAttachmentsMiddleware() {
  return async (req, res, next) => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];
    if (pathname !== ROUTE) {
      next();
      return;
    }

    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'POST') {
        await handlePost(req, res);
        return;
      }

      const key = new URL(url, 'http://127.0.0.1').searchParams.get('key') ?? '';
      if (req.method === 'GET') {
        await handleGet(req, res, key);
        return;
      }
      if (req.method === 'DELETE') {
        await handleDelete(res, key);
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
