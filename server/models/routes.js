import { cancelDownload, pauseDownload, resumeDownload, listDownloads, startDownload, subscribeDownload } from './download.js';
import { getHubFiles } from './hf-files.js';
import { searchHubModels } from './hf-search.js';
import { getHfCreatorAvatarImage } from './hf-avatar.js';
import { listCachedModels } from './cached.js';
import { listInstalled } from './installed.js';
import { getModelsConfig, patchModelsConfig } from './models-config.js';
import { getInferencePrefs, setLibraryInferenceSampler } from './inference-prefs.js';
import { getLaunchPrefs, setLibraryLaunchSettings } from './launch-prefs.js';
import { readGgufMetadata } from './gguf-metadata.js';
import { listServeActivity, subscribeServeActivity } from './serve-activity.js';
import { computeServeProfiles } from './profiles.js';
import { detectRuntimes } from './runtime-detect.js';
import { getServe, listServes, startServe, stopServe, subscribeServeEvents } from './serve.js';
import {
  readServeLogTailForServe,
  subscribeServeLogForServe,
} from './serve-logs.js';
import { validateJobId, validateServeId } from './validate.js';
import { detectHardware } from '../system/hardware.js';
import {
  getLlamaRuntimeStatus,
  ensureLlamaServer,
  getInstalledLlamaVariant,
  subscribeLlamaInstallProgress,
} from './llama-runtime.js';
import { writeLlamaCppConfig, readLlamaCppConfig, buildLlamaServerArgs } from './llama-args.js';

// ── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 */
export async function handleModelsRequest(req, res, pathname) {

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (pathname === '/api/models/ping' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/models/downloads' && req.method === 'GET') {
    const jobs = await listDownloads();
    sendJson(res, 200, { jobs });
    return true;
  }

  if (pathname === '/api/models/hf/search' && req.method === 'GET') {
    try {
      const params = new URL(req.url ?? '', 'http://localhost').searchParams;
      const payload = await searchHubModels({
        query: params.get('q') ?? '',
        format: params.get('format') ?? 'gguf',
        limit: Number(params.get('limit')) || undefined,
        sort: params.get('sort') ?? undefined,
        cursor: params.get('cursor') ?? undefined,
      });
      sendJson(res, 200, payload);
    } catch (err) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/hf/avatar' && req.method === 'GET') {
    const params = new URL(req.url ?? '', 'http://localhost').searchParams;
    const avatar = await getHfCreatorAvatarImage(params.get('owner') ?? '').catch(() => null);
    if (!avatar) {
      res.statusCode = 404;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', avatar.contentType);
    res.setHeader('Content-Length', String(avatar.body.byteLength));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(avatar.body);
    return true;
  }

  if (pathname === '/api/models/hf/files' && req.method === 'GET') {
    try {
      const params = new URL(req.url ?? '', 'http://localhost').searchParams;
      sendJson(res, 200, await getHubFiles(params.get('repo') ?? ''));
    } catch (err) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const downloadAction = pathname.match(/^\/api\/models\/download\/([^/]+)\/(pause|resume)$/);
  if (downloadAction && req.method === 'POST') {
    try {
      const action = downloadAction[2] === 'pause' ? pauseDownload : resumeDownload;
      sendJson(res, 200, { job: await action(validateJobId(downloadAction[1])) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/download' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const job = await startDownload(body);
      sendJson(res, 200, { job });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const downloadStreamMatch = pathname.match(/^\/api\/models\/download\/([^/]+)\/stream$/);
  if (downloadStreamMatch && req.method === 'GET') {
    const jobId = validateJobId(downloadStreamMatch[1]);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        return;
      }
      if (['completed', 'failed', 'cancelled', 'paused'].includes(event.status)) {
        res.end();
      }
    };
    const unsubscribe = subscribeDownload(jobId, send);
    req.on('close', () => unsubscribe());
    return true;
  }

  const downloadCancelMatch = pathname.match(/^\/api\/models\/download\/([^/]+)\/cancel$/);
  if (downloadCancelMatch && req.method === 'POST') {
    try {
      const job = await cancelDownload(validateJobId(downloadCancelMatch[1]));
      sendJson(res, 200, { job });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/installed' && req.method === 'GET') {
    const payload = await listInstalled();
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname === '/api/models/cached' && req.method === 'GET') {
    const payload = await listCachedModels();
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname === '/api/models/gguf-meta' && req.method === 'GET') {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const filePath = parsed.searchParams.get('path') || '';
    const meta = await readGgufMetadata(filePath);
    if (!meta) {
      sendJson(res, 404, { error: 'No readable GGUF header at that path' });
      return true;
    }
    sendJson(res, 200, meta);
    return true;
  }

  if (pathname === '/api/models/config' && req.method === 'GET') {
    const models = await getModelsConfig();
    const hfToken = typeof models.hfToken === 'string' ? models.hfToken : '';
    sendJson(res, 200, {
      hfTokenConfigured: Boolean(hfToken),
      hfTokenMasked: hfToken ? `${hfToken.slice(0, 4)}…${hfToken.slice(-4)}` : '',
      modelDirs: Array.isArray(models.modelDirs) ? models.modelDirs : [],
    });
    return true;
  }

  if (pathname === '/api/models/config' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.hfToken === 'string' && body.hfToken.trim()) {
        patch.hfToken = body.hfToken.trim();
      } else if (body.clearHfToken === true) {
        patch.hfToken = '';
      }
      if (Array.isArray(body.modelDirs)) {
        patch.modelDirs = body.modelDirs
          .filter((d) => typeof d === 'string' && d.trim())
          .map((d) => d.trim());
      }
      const models = await patchModelsConfig(patch);
      const { resetHfTokenCache } = await import('./hf-client.js');
      resetHfTokenCache();
      const hfToken = typeof models.hfToken === 'string' ? models.hfToken : '';
      sendJson(res, 200, {
        ok: true,
        hfTokenConfigured: Boolean(hfToken),
        hfTokenMasked: hfToken ? `${hfToken.slice(0, 4)}…${hfToken.slice(-4)}` : '',
        modelDirs: Array.isArray(models.modelDirs) ? models.modelDirs : [],
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/inference' && req.method === 'GET') {
    const inference = await getInferencePrefs();
    sendJson(res, 200, inference);
    return true;
  }

  if (pathname === '/api/models/inference' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const libraryId = typeof body.libraryId === 'string' ? body.libraryId : '';
      const sampler =
        body.sampler === null
          ? null
          : body.sampler && typeof body.sampler === 'object'
            ? body.sampler
            : null;
      const aliases = Array.isArray(body.aliases)
        ? body.aliases.filter((a) => typeof a === 'string')
        : [];
      const inference = await setLibraryInferenceSampler(libraryId, sampler, aliases);
      sendJson(res, 200, { ok: true, ...inference });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/launch' && req.method === 'GET') {
    const launch = await getLaunchPrefs();
    sendJson(res, 200, launch);
    return true;
  }

  if (pathname === '/api/models/launch' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const libraryId = typeof body.libraryId === 'string' ? body.libraryId : '';
      const settings =
        body.settings === null
          ? null
          : body.settings && typeof body.settings === 'object'
            ? body.settings
            : null;
      const launch = await setLibraryLaunchSettings(libraryId, settings);
      sendJson(res, 200, { ok: true, ...launch });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/profiles' && req.method === 'GET') {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const modelName = parsed.searchParams.get('model') || '';
      const quant = parsed.searchParams.get('quant') || undefined;
      const weightsGb = parsed.searchParams.get('weights_gb');
      const fresh = parsed.searchParams.get('fresh') === '1';
      const hardware = await detectHardware({ fresh });
      const model = {
        name: modelName,
        architecture: parsed.searchParams.get('arch') || undefined,
        parameter_count: parsed.searchParams.get('params') || undefined,
        parameters_raw: parsed.searchParams.get('params_b')
          ? Number(parsed.searchParams.get('params_b'))
          : undefined,
        quantization: quant,
        active_parameters: parsed.searchParams.get('active_params_b')
          ? Number(parsed.searchParams.get('active_params_b'))
          : undefined,
        is_moe: parsed.searchParams.get('is_moe') === '1',
      };
      const modelPath = parsed.searchParams.get('model_path') || '';
      const ggufMeta = modelPath ? await readGgufMetadata(modelPath) : null;
      const profiles = computeServeProfiles(hardware, model, {
        serveWeightsGb: weightsGb ? Number(weightsGb) : undefined,
        serveQuant: quant,
        ggufMeta,
      });
      const variant = (await getInstalledLlamaVariant()) ?? 'cpu';
      const profilesWithArgs = profiles.map((p) => ({
        ...p,
        llama_args: buildLlamaServerArgs({
          modelPath: '/model.gguf',
          port: 8085,
          profileKey: p.key,
          hardware,
          modelMeta: model,
          variant,
          ggufMeta,
        }),
      }));
      sendJson(res, 200, { profiles: profilesWithArgs, hardware });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/runtimes' && req.method === 'GET') {
    const runtimes = await detectRuntimes();
    sendJson(res, 200, runtimes);
    return true;
  }

  if (pathname === '/api/models/llama-runtime' && req.method === 'GET') {
    try {
      const status = await getLlamaRuntimeStatus();
      sendJson(res, 200, status);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/llama-runtime/install/stream' && req.method === 'GET') {
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

    const unsubscribe = subscribeLlamaInstallProgress(send);
    req.on('close', () => unsubscribe());
    return true;
  }

  if (pathname === '/api/models/llama-runtime/install' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const variant = typeof body.variant === 'string' ? body.variant : undefined;
      const tag = typeof body.tag === 'string' ? body.tag : undefined;
      const reinstall = body.reinstall === true;
      if (variant) {
        await writeLlamaCppConfig({ variant });
      }
      const path = await ensureLlamaServer({ variant, tag, reinstall });
      const status = await getLlamaRuntimeStatus();
      sendJson(res, 200, { ok: true, path, ...status });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/llama-cpp-config' && req.method === 'GET') {
    const config = await readLlamaCppConfig();
    sendJson(res, 200, config);
    return true;
  }

  if (pathname === '/api/models/llama-cpp-config' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const config = await writeLlamaCppConfig(body);
      sendJson(res, 200, { ok: true, ...config });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/models/serve' && req.method === 'GET') {
    const serves = await listServes();
    sendJson(res, 200, { serves });
    return true;
  }

  if (pathname === '/api/models/serve/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const unsubscribe = subscribeServeEvents((payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        unsubscribe();
      }
    });
    req.on('close', () => unsubscribe());
    return true;
  }

  if (pathname === '/api/models/serve/activity/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const unsubscribe = subscribeServeActivity((activity) => {
      try {
        res.write(`data: ${JSON.stringify(activity)}\n\n`);
      } catch {
        unsubscribe();
      }
    });
    req.on('close', () => unsubscribe());
    return true;
  }

  if (pathname === '/api/models/serve/activity' && req.method === 'GET') {
    sendJson(res, 200, { activity: listServeActivity() });
    return true;
  }

  if (pathname === '/api/models/serve' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const serve = await startServe(body);
      sendJson(res, 200, { serve });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const serveLogStreamMatch = pathname.match(/^\/api\/models\/serve\/([^/]+)\/logs\/stream$/);
  if (serveLogStreamMatch && req.method === 'GET') {
    let serve;
    try {
      serve = await getServe(validateServeId(serveLogStreamMatch[1]));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    if (!serve) {
      sendJson(res, 404, { error: 'Serve session not found' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const serveId = serve.id;
    const unsubscribe = subscribeServeLogForServe(() => getServe(serveId), (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        unsubscribe();
      }
    });
    req.on('close', () => unsubscribe());
    return true;
  }

  const serveLogMatch = pathname.match(/^\/api\/models\/serve\/([^/]+)\/logs$/);
  if (serveLogMatch && req.method === 'GET') {
    try {
      const serve = await getServe(validateServeId(serveLogMatch[1]));
      if (!serve) {
        sendJson(res, 404, { error: 'Serve session not found' });
        return true;
      }
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const bytes = Number(parsed.searchParams.get('bytes'));
      const tail = await readServeLogTailForServe(
        serve,
        Number.isFinite(bytes) ? bytes : undefined,
      );
      sendJson(res, 200, { text: tail?.text ?? '', offset: tail?.size ?? 0 });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const serveStopMatch = pathname.match(/^\/api\/models\/serve\/([^/]+)\/stop$/);
  if (serveStopMatch && req.method === 'POST') {
    try {
      const serve = await stopServe(validateServeId(serveStopMatch[1]));
      sendJson(res, 200, { serve });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const serveGetMatch = pathname.match(/^\/api\/models\/serve\/([^/]+)$/);
  if (serveGetMatch && req.method === 'GET') {
    try {
      const serve = await getServe(validateServeId(serveGetMatch[1]));
      if (!serve) {
        sendJson(res, 404, { error: 'Serve session not found' });
        return true;
      }
      sendJson(res, 200, { serve });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname.startsWith('/api/models')) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  return false;
}

// ── Middleware ───────────────────────────────────────────────────────────────

export function createModelsMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith('/api/models')) {
      next();
      return;
    }
    const handled = await handleModelsRequest(req, res, parsed.pathname);
    if (!handled) next();
  };
}
