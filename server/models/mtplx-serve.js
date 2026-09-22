import os from 'node:os';
import { estimateMtplxMemory, diagnoseMtplxFailure } from './mtplx-memory.js';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getMtplxStatus } from './mtplx-runtime.js';
import { getMtplxDescriptor, descriptorFromHealth, recordMtplxHealthDescriptor } from './mtplx-descriptor.js';
import { buildMtplxServeLaunch, readMtplxConfig } from './mtplx-args.js';
import { getLaunchPrefs, recordLaunchLoadPrior } from './launch-prefs.js';
import { MTPLX_LOCAL_ID } from '../../src/models/engine-ids.mjs';
import { MINNOW_LIBRARY_PROVIDER_ID, updateProviderSecrets } from '../providers/store.js';
import { getManagedServerPort } from '../servers/manager.js';
import { waitForHealth } from './wait-for-health.js';
import { appendServeLog } from './serve-logs.js';

export async function mtplxAuthHeaders(row) {
  if (!row.apiKeyFile) return {};
  const key = (await fsp.readFile(row.apiKeyFile, 'utf8')).trim();
  if (!key) throw new Error('MTPLX API key file is empty');
  return { Authorization: `Bearer ${key}` };
}

export async function probeMtplxHealth(baseUrl, headers = {}, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { headers, signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const json = await response.json();
    return (json.ok === true || json.status === 'ok') && typeof json.model_path === 'string' ? json : null;
  } catch { return null; }
}

export async function mtplxHealthMatchesModel(health, modelPath) {
  if (!health?.model_path) return false;
  try { return await fsp.realpath(health.model_path) === await fsp.realpath(modelPath); }
  catch { return false; }
}

/** Shared serve store owns rows, events, stop and restart; MTPLX owns launch semantics. */
export async function startMtplxServe(body, deps) {
  const status = await (deps.status ?? getMtplxStatus)();
  if (!status.supported || !status.installed) throw new Error(status.reason || 'MTPLX is not installed');
  const modelPath = await fsp.realpath(body.modelPath);
  const previous = deps.rows.find((r) => r.runtime === 'mtplx' && r.modelPath === modelPath && ['starting', 'running', 'unhealthy'].includes(r.status));
  if (previous) return previous;
  let descriptor = await (deps.descriptor ?? getMtplxDescriptor)(modelPath);
  const saved = body.libraryId ? (await getLaunchPrefs()).byLibraryId[body.libraryId]?.mtplx : undefined;
  const desiredPort = body.port ?? await getManagedServerPort('mtplx') ?? 8088;
  const requested = buildMtplxServeLaunch({ modelPath, port: desiredPort, descriptor, defaults: await readMtplxConfig(), saved, settings: body.mtplx });
  let authFile = requested.apiKeyFile;
  let headers = await mtplxAuthHeaders(requested).catch(() => ({}));
  const probe = deps.probe ?? probeMtplxHealth;
  // Also discover MTPLX's standard daemon port when no explicit port was requested.
  let health = null, port = desiredPort;
  for (const candidate of body.port ? [desiredPort] : [...new Set([desiredPort, 8000])]) {
    let found = await probe(`http://127.0.0.1:${candidate}`, headers);
    if (!found) {
      const fallbackFile = path.join(os.homedir(), '.mtplx', 'api-key');
      const fallbackHeaders = await mtplxAuthHeaders({ apiKeyFile: fallbackFile }).catch(() => null);
      if (fallbackHeaders) {
        found = await probe('http://127.0.0.1:' + candidate, fallbackHeaders);
        if (await mtplxHealthMatchesModel(found, modelPath)) { headers = fallbackHeaders; authFile = fallbackFile; }
      }
    }
    if (await mtplxHealthMatchesModel(found, modelPath)) { health = found; port = candidate; break; }
  }
  const adopted = Boolean(health);
  if (adopted) descriptor = descriptorFromHealth(health, modelPath);
  else if (!descriptor.canRun) throw new Error('MTPLX has not validated this model runtime contract. Run mtplx inspect for details.');
  if (!adopted) port = await deps.findPort(desiredPort);
  const launch = buildMtplxServeLaunch({ modelPath, port, descriptor, defaults: await readMtplxConfig(), saved, settings: body.mtplx });
  const memory = await estimateMtplxMemory(modelPath, launch.settings, Number(body.weightsGb) * 1024 ** 3 || 0);
  const connectHost = ['0.0.0.0', '::'].includes(launch.host) ? '127.0.0.1' : launch.host.includes(':') ? '[' + launch.host + ']' : launch.host;
  const row = { id: crypto.randomUUID(), runtime: 'mtplx', modelPath,
    modelLabel: launch.settings.model_id || body.modelLabel || path.basename(modelPath),
    port, baseUrl: `http://${adopted ? '127.0.0.1' : connectHost}:${port}`, providerId: MINNOW_LIBRARY_PROVIDER_ID,
    ownership: adopted ? 'external' : 'minnow', status: 'starting', startedAt: Date.now(),
    lastUsedAt: Date.now(), libraryId: body.libraryId, mtplxSettings: launch.settings,
    mtplxDescriptor: descriptor, apiKeyFile: adopted ? authFile : launch.apiKeyFile,
    restartCount: body.restartCount ?? 0,
    launchPlan: { variant: 'metal', hardware: body.hardware ?? {}, ...memory },
  };
  if (!adopted) await deps.admit(row.launchPlan);
  deps.rows.push(row);
  await deps.commit('mtplx-starting');
  const fail = async (err) => {
    if (['stopped', 'crashed'].includes(row.status)) return row;
    row.status = 'error'; row.error = err instanceof Error ? err.message : String(err);
    row.failure = diagnoseMtplxFailure(row.error, null);
    if (row.runId && row.ownership === 'minnow') await deps.stopRun(row.runId).catch(() => {});
    if (!deps.rows.some((other) => other.id !== row.id && other.runtime === 'mtplx' && ['running', 'starting'].includes(other.status))) {
      await deps.upsert({ id: MTPLX_LOCAL_ID, label: 'Powered by MTPLX', baseUrl: row.baseUrl, enabled: false }).catch(() => {});
    }
    await deps.commit('mtplx-error');
    return row;
  };
  try {
    if (!adopted) {
      const run = await deps.createRun({ command: status.path, args: launch.args, cwd: path.dirname(status.path),
        env: launch.settings.env, source: 'agent', sandbox: false, logSubdir: 'models' });
      row.runId = run.runId; row.pid = run.pid;
      if (row.status === 'stopped') { await deps.stopRun(run.runId); return row; }
      if (launch.warning) await appendServeLog(row.runId, launch.warning);
      deps.watch?.(row);
      await deps.commit('mtplx-spawned');
    }
  } catch (err) { await fail(err); throw err; }
  const finish = async () => {
    try {
      if (!health) {
        const result = await (deps.wait ?? waitForHealth)({ baseUrl: row.baseUrl, healthPath: '/health', runId: row.runId,
          getRun: (id) => row.status === 'stopped' ? { finished: true } : deps.getRun(id),
          readLogTail: deps.readLogTail, label: 'MTPLX',
          fetchImpl: async (url, init) => fetch(url, { ...init, headers: await mtplxAuthHeaders(row) }),
        });
        if (!result.ok) throw new Error([result.error, result.logTail].filter(Boolean).join('\n'));
        health = await probe(row.baseUrl, await mtplxAuthHeaders(row));
        if (!await mtplxHealthMatchesModel(health, modelPath)) throw new Error('MTPLX health returned a different model');
      }
      if (['stopped', 'crashed', 'error'].includes(row.status)) return row;
      row.mtplxDescriptor = await recordMtplxHealthDescriptor(modelPath, health);
      row.pid = row.pid ?? health.startup?.pid;
      row.mtplxSettings = { ...row.mtplxSettings,
        ...(Number.isFinite(health.context_window) ? { context_window: health.context_window } : {}),
        ...(Number.isFinite(health.depth) ? { depth: health.depth } : {}),
      };
      const catalog = deps.models ? await deps.models(row) : await fetch(row.baseUrl + '/v1/models', { headers: await mtplxAuthHeaders(row), signal: AbortSignal.timeout(5000) }).then((res) => res.ok ? res.json() : null).catch(() => null);
      const modelId = catalog?.data?.find((model) => typeof model.id === 'string')?.id;
      if (modelId) row.modelLabel = modelId;
      if (adopted) {
        // These are observed values, not a claim that saved launch preferences were applied.
        row.mtplxSettings = { depth: health.depth, profile: health.profile, context_window: health.context_window };
      }
      await deps.upsert({ id: MTPLX_LOCAL_ID, label: 'Powered by MTPLX', baseUrl: row.baseUrl, enabled: true });
      if (row.apiKeyFile) await updateProviderSecrets(MTPLX_LOCAL_ID, { apiKey: (await fsp.readFile(row.apiKeyFile, 'utf8')).trim() });
      if (['stopped', 'crashed', 'error'].includes(row.status)) {
        if (!deps.rows.some((other) => other.id !== row.id && other.runtime === 'mtplx' && ['running', 'starting'].includes(other.status))) await deps.upsert({ id: MTPLX_LOCAL_ID, label: 'Powered by MTPLX', baseUrl: row.baseUrl, enabled: false });
        return row;
      }
      row.status = 'running'; row.lastHealthyAt = Date.now();
      if (body.libraryId && !adopted) {
        await recordLaunchLoadPrior(body.libraryId, { lastLoadMs: Date.now() - row.startedAt, lastWeightsBytes: Number(body.weightsGb) * 1024 ** 3 || 0 })
          .catch((err) => console.warn('[mtplx] load prior could not be saved:', err));
      }
      await deps.commit('mtplx-running');
      return row;
    } catch (err) { return fail(err); }
  };
  if (body.async === true) { void finish().catch((err) => console.warn('[mtplx] load failed:', err)); return row; }
  return finish();
}
