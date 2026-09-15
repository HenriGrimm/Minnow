/**
 * STT API — local Whisper worker or provider-backed speech-to-text proxy.
 */

import { getProviderRuntime } from '../providers/store.js';
import { loadVoiceConfig, resolveVoicePaths } from '../voice/config.js';
import { buildLocalSttStatus, transcribeLocal } from '../voice/local-stt.js';
import { formatByteLimit, isAllowedAudioMime, resolveSttLimits } from './limits.js';
import { parseMultipartFile } from './multipart.js';
import { getBuiltinSttStatus, prepareBuiltinStt, transcribeBuiltin } from '../voice/builtin-stt.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * Build STT status payload for the client.
 * @param {Awaited<ReturnType<typeof loadVoiceConfig>>} voice
 */
async function buildSttStatus(voice) {
  const stt = voice.stt;
  const enabled = stt.enabled === true;
  const backend = stt.backend;
  const providerId = String(stt.providerId || '').trim();
  let healthy = false;

  if (!enabled) {
    return {
      enabled,
      backend,
      providerId,
      model: stt.model,
      language: stt.language,
      healthy: false,
      modelId: stt.local?.modelId ?? stt.model,
      runtimeReady: false,
      modelLoaded: false,
      cudaAvailable: false,
      streaming: false,
      streamingSupported: false,
      warning: null,
    };
  }

  if (backend === 'builtin') {
    const builtin = getBuiltinSttStatus();
    return {
      enabled, backend, providerId: '', model: 'Xenova/whisper-tiny',
      language: stt.language, healthy: true, streamingSupported: false,
      modelLoaded: builtin.phase === 'ready', builtin,
    };
  }

  if (backend === 'local') {
    const local = await buildLocalSttStatus(voice);
    healthy = local.runtimeReady;
    const streamingEnabled = stt.local?.streamingEnabled !== false;
    const streamingSupported = healthy && streamingEnabled;
    return {
      enabled,
      backend,
      providerId: '',
      model: stt.local.modelId,
      language: stt.local.language,
      healthy,
      streaming: streamingSupported,
      streamingSupported,
      ...local,
    };
  }

  if (providerId) {
    try {
      await getProviderRuntime(providerId);
      healthy = true;
    } catch {
      healthy = false;
    }
  }

  return {
    enabled,
    backend,
    providerId,
    model: stt.model,
    language: stt.language,
    healthy,
    modelId: stt.provider.model,
    runtimeReady: healthy,
    modelLoaded: healthy,
    cudaAvailable: false,
    streaming: false,
    streamingSupported: false,
    warning: providerId ? null : 'No STT provider configured',
  };
}

/**
 * Forward audio bytes to the provider transcription endpoint.
 * @param {object} params
 */
async function transcribeWithProvider(params) {
  const { providerId, model, language, audioBuffer, mime, filename } = params;
  const runtime = await getProviderRuntime(providerId);
  const paths = resolveVoicePaths(runtime.paths);
  const url = `${runtime.profile.baseUrl}${paths.transcriptionsPath}`;

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mime });
  form.append('file', blob, filename || 'audio.webm');
  form.append('model', model);
  if (language) {
    form.append('language', language);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...runtime.headers,
      },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail || `Provider returned ${res.status}`);
    }
    const json = await res.json();
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Handle /api/stt/* routes.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
export async function handleSttRequest(req, res, pathname) {
  if (pathname === '/api/stt/prepare' && req.method === 'POST') {
    const voice = await loadVoiceConfig();
    if (!voice.stt.enabled || voice.stt.backend !== 'builtin') {
      sendJson(res, 409, { error: 'Built-in dictation is not enabled' });
      return true;
    }
    void prepareBuiltinStt().catch(() => {});
    sendJson(res, 202, getBuiltinSttStatus());
    return true;
  }
  if (pathname === '/api/stt/status' && req.method === 'GET') {
    const voice = await loadVoiceConfig();
    const status = await buildSttStatus(voice);
    sendJson(res, 200, status);
    return true;
  }

  if (pathname === '/api/stt/transcribe' && req.method === 'POST') {
    const voice = await loadVoiceConfig();
    const stt = voice.stt;
    if (!stt.enabled) {
      sendJson(res, 503, { error: 'Speech-to-text is disabled in settings' });
      return true;
    }

    const { maxAudioBytes } = resolveSttLimits(voice);
    try {
      const upload = await parseMultipartFile(req, maxAudioBytes);
      if (!upload.buffer.length) {
        sendJson(res, 400, { error: 'Empty audio file' });
        return true;
      }
      if (!isAllowedAudioMime(upload.mime)) {
        sendJson(res, 415, {
          error: `Unsupported audio type: ${upload.mime || 'unknown'}`,
        });
        return true;
      }

      let text = '';
      if (stt.backend === 'builtin') {
        text = await transcribeBuiltin({
          audioBuffer: upload.buffer, language: stt.language,
          maxDurationSeconds: voice.limits.maxDurationSeconds,
        });
      } else if (stt.backend === 'local') {
        text = await transcribeLocal({
          localConfig: stt.local,
          audioBuffer: upload.buffer,
          mime: upload.mime,
          filename: upload.filename,
        });
      } else {
        const providerId = String(stt.providerId || '').trim();
        if (!providerId) {
          sendJson(res, 503, {
            error: 'No STT provider configured. Open Models → Voice.',
          });
          return true;
        }
        text = await transcribeWithProvider({
          providerId,
          model: stt.model,
          language: stt.language,
          audioBuffer: upload.buffer,
          mime: upload.mime,
          filename: upload.filename,
        });
      }

      sendJson(res, 200, { text });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('exceeds')) {
        sendJson(res, 413, { error: message });
        return true;
      }
      if (message.includes('Unsupported') || message.includes('multipart')) {
        sendJson(res, 400, { error: message });
        return true;
      }
      sendJson(res, 500, { error: `Transcription failed: ${message}` });
      return true;
    }
  }

  return false;
}

export function createSttMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/stt')) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const handled = await handleSttRequest(req, res, url);
    if (!handled) {
      sendJson(res, 404, { error: 'Not found' });
    }
  };
}

/** @internal Test helper */
export { buildSttStatus, transcribeWithProvider, formatByteLimit };
