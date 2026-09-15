/**
 * HTTP routes for voice runtime, model downloads, and installed manifests.
 */

import {
  cancelVoiceDownload,
  deleteVoiceModel,
  listInstalledVoiceModels,
  startVoiceDownload,
  subscribeVoiceDownload,
} from './download.js';
import {
  getRuntimeStatus,
  installRuntime,
  repairRuntime,
  startWorker,
  stopWorker,
  subscribeInstallProgress,
} from './runtime-manager.js';
import { validateJobId, validateRepoId } from '../models/validate.js';
import { parseMultipartFile } from '../stt/multipart.js';
import { loadVoiceConfig } from './config.js';
import { listClonePrompts, saveRefAudio } from './refs.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
export async function handleVoiceRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/voice')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (pathname === '/api/voice/config' && req.method === 'GET') {
    sendJson(res, 200, await loadVoiceConfig());
    return true;
  }

  if (pathname === '/api/voice/runtime/status' && req.method === 'GET') {
    const status = await getRuntimeStatus();
    sendJson(res, 200, status);
    return true;
  }

  if (pathname === '/api/voice/runtime/install' && req.method === 'POST') {
    try {
      const result = await installRuntime();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/runtime/repair' && req.method === 'POST') {
    try {
      const result = await repairRuntime();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/runtime/start' && req.method === 'POST') {
    try {
      const result = await startWorker();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/runtime/stop' && req.method === 'POST') {
    try {
      const result = await stopWorker();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/runtime/install/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.phase === 'completed' || event.phase === 'failed') {
        res.end();
      }
    };

    const unsubscribe = subscribeInstallProgress(send);
    req.on('close', () => unsubscribe());
    return true;
  }

  if (pathname === '/api/voice/download' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const job = await startVoiceDownload(body);
      sendJson(res, 200, { job });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const downloadStreamMatch = pathname.match(/^\/api\/voice\/download\/([^/]+)\/stream$/);
  if (downloadStreamMatch && req.method === 'GET') {
    const jobId = validateJobId(downloadStreamMatch[1]);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (
        event.status === 'completed' ||
        event.status === 'failed' ||
        event.status === 'cancelled'
      ) {
        res.end();
      }
    };
    const unsubscribe = subscribeVoiceDownload(jobId, send);
    req.on('close', () => unsubscribe());
    return true;
  }

  const downloadCancelMatch = pathname.match(/^\/api\/voice\/download\/([^/]+)\/cancel$/);
  if (downloadCancelMatch && req.method === 'POST') {
    try {
      const job = await cancelVoiceDownload(validateJobId(downloadCancelMatch[1]));
      sendJson(res, 200, { job });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/models/installed' && req.method === 'GET') {
    const manifest = await listInstalledVoiceModels();
    sendJson(res, 200, manifest);
    return true;
  }

  const deleteMatch = pathname.match(/^\/api\/voice\/models\/(stt|tts)\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    try {
      const kind = deleteMatch[1];
      const modelId = decodeURIComponent(deleteMatch[2]);
      validateRepoId(modelId);
      const result = await deleteVoiceModel(kind, modelId);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/refs/upload' && req.method === 'POST') {
    try {
      const voice = await loadVoiceConfig();
      const maxBytes = voice.limits?.maxAudioBytes ?? 25 * 1024 * 1024;
      const file = await parseMultipartFile(req, maxBytes);
      const saved = await saveRefAudio(file);
      sendJson(res, 200, { ok: true, ref: saved });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/voice/clone-prompts' && req.method === 'GET') {
    try {
      const prompts = await listClonePrompts();
      sendJson(res, 200, { prompts });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

/** @deprecated Use handleVoiceRequest */
export async function handleVoiceRuntimeRequest(req, res, pathname) {
  return handleVoiceRequest(req, res, pathname);
}

export function createVoiceRuntimeMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/voice')) {
      next();
      return;
    }

    await handleVoiceRequest(req, res, url);
  };
}
