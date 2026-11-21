/**
 * Benchmark run persistence under ~/.minnow/benchmarks/*.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureMinnowLayout, getMinnowHome } from '../config/home.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DATASET_BYTES = 64 * 1024 * 1024;
const LIST_CAP = 20;
const CAMPAIGN_LIST_CAP = 50;

function benchmarksDir() {
  return path.join(getMinnowHome(), 'benchmarks');
}

function campaignsDir() {
  return path.join(benchmarksDir(), 'campaigns');
}

function capabilityMatrixDir() {
  return path.join(benchmarksDir(), 'capability-matrix');
}

const CAP_MATRIX_ROSTER_FILE = 'roster.json';
const CAP_MATRIX_VERDICTS_FILE = 'verdicts.json';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
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

/** Safe filename: ISO timestamp id only. */
function safeRunId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    return null;
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return null;
  }
  return id;
}

async function listRunSummaries() {
  const dir = benchmarksDir();
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('index'))
    .map((e) => e.name);

  const runs = [];
  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const run = JSON.parse(raw);
      runs.push({
        id: run.id ?? file.replace(/\.json$/, ''),
        startedAt: run.startedAt ?? '',
        modelId: run.model?.id ?? '',
        providerId: run.provider?.id ?? '',
        totalScore: run.totalScore ?? 0,
        headlineTtftMs: run.headlineTtftMs ?? 0,
        headlineTokPerSec: run.headlineTokPerSec ?? 0,
      });
    } catch {
      /* skip corrupt */
    }
  }

  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return runs.slice(0, LIST_CAP);
}

async function handleGetList(_req, res) {
  await ensureMinnowLayout();
  const runs = await listRunSummaries();
  sendJson(res, 200, { runs });
}

async function handleGetOne(id, res) {
  await ensureMinnowLayout();
  const safe = safeRunId(id);
  if (!safe) {
    sendJson(res, 400, { error: 'Invalid run id' });
    return;
  }
  const filePath = path.join(benchmarksDir(), `${safe}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const run = JSON.parse(raw);
    sendJson(res, 200, run);
  } catch {
    sendJson(res, 404, { error: 'Run not found' });
  }
}

/** Remove every persisted run file under ~/.minnow/benchmarks. */
async function handleDeleteAll(res) {
  await ensureMinnowLayout();
  const dir = benchmarksDir();
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    sendJson(res, 200, { ok: true, deleted: 0 });
    return;
  }

  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    await fs.unlink(path.join(dir, entry.name));
    deleted += 1;
  }
  sendJson(res, 200, { ok: true, deleted });
}

async function handlePost(body, res) {
  await ensureMinnowLayout();
  const id =
    typeof body?.id === 'string' && body.id.trim()
      ? body.id.trim()
      : new Date().toISOString().replace(/[:.]/g, '-');
  const safe = safeRunId(id);
  if (!safe) {
    sendJson(res, 400, { error: 'Invalid run id' });
    return;
  }
  const filePath = path.join(benchmarksDir(), `${safe}.json`);
  const payload = { ...body, id: safe };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  sendJson(res, 201, { ok: true, id: safe });
}

function campaignSummary(campaign) {
  const aggregates = Array.isArray(campaign.aggregates) ? campaign.aggregates : [];
  const topScore = aggregates.length
    ? Math.max(...aggregates.map((a) => a.totalScore ?? 0))
    : 0;
  return {
    id: campaign.id,
    startedAt: campaign.startedAt ?? '',
    endedAt: campaign.endedAt ?? null,
    status: campaign.status ?? 'completed',
    targetCount: Array.isArray(campaign.targets) ? campaign.targets.length : 0,
    preset: campaign.preset ?? 'custom',
    topScore,
    kind: campaign.kind,
  };
}

async function listCampaignSummaries() {
  const dir = campaignsDir();
  await fs.mkdir(dir, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const campaigns = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
      const campaign = JSON.parse(raw);
      campaigns.push(campaignSummary(campaign));
    } catch {
      /* skip */
    }
  }
  campaigns.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return campaigns.slice(0, CAMPAIGN_LIST_CAP);
}

async function handleGetCampaigns(_req, res) {
  await ensureMinnowLayout();
  const campaigns = await listCampaignSummaries();
  sendJson(res, 200, { campaigns });
}

async function handleGetCampaign(id, res) {
  await ensureMinnowLayout();
  const safe = safeRunId(id);
  if (!safe) {
    sendJson(res, 400, { error: 'Invalid campaign id' });
    return;
  }
  const filePath = path.join(campaignsDir(), `${safe}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    sendJson(res, 200, JSON.parse(raw));
  } catch {
    sendJson(res, 404, { error: 'Campaign not found' });
  }
}

async function handlePostCampaign(body, res) {
  await ensureMinnowLayout();
  const id =
    typeof body?.id === 'string' && body.id.trim()
      ? body.id.trim()
      : `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const safe = safeRunId(id);
  if (!safe) {
    sendJson(res, 400, { error: 'Invalid campaign id' });
    return;
  }
  await fs.mkdir(campaignsDir(), { recursive: true });
  const payload = { ...body, id: safe };
  await fs.writeFile(
    path.join(campaignsDir(), `${safe}.json`),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
  sendJson(res, 201, { ok: true, id: safe });
}

async function buildModelScoreIndex() {
  const dir = campaignsDir();
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const campaigns = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
      campaigns.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  campaigns.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const byKey = new Map();
  for (const campaign of campaigns) {
    const aggregates = Array.isArray(campaign.aggregates) ? campaign.aggregates : [];
    for (const agg of aggregates) {
      const key = agg.targetKey ?? `${agg.providerId}::${agg.modelId}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        targetKey: key,
        providerId: agg.providerId ?? '',
        modelId: agg.modelId ?? '',
        label: agg.label ?? key,
        campaignId: campaign.id,
        startedAt: campaign.startedAt ?? '',
        totalScore: agg.totalScore ?? 0,
        headlineTokPerSec: agg.headlineTokPerSec ?? 0,
        headlineTtftMs: agg.headlineTtftMs ?? 0,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.totalScore - a.totalScore);
}

async function handleGetModels(_req, res) {
  await ensureMinnowLayout();
  const models = await buildModelScoreIndex();
  sendJson(res, 200, { models });
}

async function readCapabilityMatrixJson(fileName, fallback) {
  const filePath = path.join(capabilityMatrixDir(), fileName);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeCapabilityMatrixJson(fileName, payload) {
  await fs.mkdir(capabilityMatrixDir(), { recursive: true });
  await fs.writeFile(
    path.join(capabilityMatrixDir(), fileName),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

async function handleGetCapabilityMatrixRoster(_req, res) {
  await ensureMinnowLayout();
  const roster = await readCapabilityMatrixJson(CAP_MATRIX_ROSTER_FILE, { targets: [] });
  sendJson(res, 200, roster);
}

async function handlePutCapabilityMatrixRoster(body, res) {
  await ensureMinnowLayout();
  const targets = Array.isArray(body?.targets) ? body.targets : [];
  const roster = {
    targets,
    updatedAt: new Date().toISOString(),
  };
  await writeCapabilityMatrixJson(CAP_MATRIX_ROSTER_FILE, roster);
  sendJson(res, 200, { ok: true });
}

async function handleGetCapabilityMatrixVerdicts(_req, res) {
  await ensureMinnowLayout();
  const verdicts = await readCapabilityMatrixJson(CAP_MATRIX_VERDICTS_FILE, {});
  sendJson(res, 200, { verdicts });
}

async function handlePostCapabilityMatrixVerdict(body, res) {
  await ensureMinnowLayout();
  const targetKey = typeof body?.targetKey === 'string' ? body.targetKey.trim() : '';
  const capabilityId =
    typeof body?.capabilityId === 'string' ? body.capabilityId.trim() : '';
  const verdict = typeof body?.verdict === 'string' ? body.verdict.trim() : '';
  if (!targetKey || !capabilityId || !verdict) {
    sendJson(res, 400, { error: 'targetKey, capabilityId, and verdict are required' });
    return;
  }
  const store = await readCapabilityMatrixJson(CAP_MATRIX_VERDICTS_FILE, {});
  const key = `${targetKey}::${capabilityId}`;
  store[key] = {
    targetKey,
    capabilityId,
    verdict,
    note: typeof body?.note === 'string' ? body.note : undefined,
    updatedAt:
      typeof body?.updatedAt === 'string' && body.updatedAt.trim()
        ? body.updatedAt.trim()
        : new Date().toISOString(),
  };
  await writeCapabilityMatrixJson(CAP_MATRIX_VERDICTS_FILE, store);
  sendJson(res, 200, { ok: true, key });
}

async function handlePutCapabilityMatrixImport(body, res) {
  await ensureMinnowLayout();
  if (Array.isArray(body?.verdicts)) {
    const store = {};
    for (const row of body.verdicts) {
      if (!row || typeof row !== 'object') continue;
      const targetKey =
        typeof row.targetKey === 'string' ? row.targetKey.trim() : '';
      const capabilityId =
        typeof row.capabilityId === 'string' ? row.capabilityId.trim() : '';
      if (!targetKey || !capabilityId) continue;
      const key = `${targetKey}::${capabilityId}`;
      store[key] = row;
    }
    await writeCapabilityMatrixJson(CAP_MATRIX_VERDICTS_FILE, store);
  }
  if (Array.isArray(body?.targets)) {
    await writeCapabilityMatrixJson(CAP_MATRIX_ROSTER_FILE, {
      targets: body.targets,
      updatedAt: new Date().toISOString(),
    });
  }
  sendJson(res, 200, { ok: true });
}

export function createBenchmarksMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/benchmarks')) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (url === '/api/benchmarks/models' && req.method === 'GET') {
        await handleGetModels(req, res);
        return;
      }

      if (url === '/api/benchmarks/campaigns' && req.method === 'GET') {
        await handleGetCampaigns(req, res);
        return;
      }

      if (url === '/api/benchmarks/campaigns' && req.method === 'POST') {
        const body = await readJsonBody(req, MAX_DATASET_BYTES);
        await handlePostCampaign(body, res);
        return;
      }

      if (url === '/api/benchmarks/capability-matrix/roster' && req.method === 'GET') {
        await handleGetCapabilityMatrixRoster(req, res);
        return;
      }

      if (url === '/api/benchmarks/capability-matrix/roster' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        await handlePutCapabilityMatrixRoster(body, res);
        return;
      }

      if (url === '/api/benchmarks/capability-matrix/verdicts' && req.method === 'GET') {
        await handleGetCapabilityMatrixVerdicts(req, res);
        return;
      }

      if (url === '/api/benchmarks/capability-matrix/verdicts' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await handlePostCapabilityMatrixVerdict(body, res);
        return;
      }

      if (url === '/api/benchmarks/capability-matrix/import' && req.method === 'PUT') {
        const body = await readJsonBody(req, MAX_DATASET_BYTES);
        await handlePutCapabilityMatrixImport(body, res);
        return;
      }

      const campaignMatch = url.match(/^\/api\/benchmarks\/campaigns\/([^/]+)$/);
      if (campaignMatch && req.method === 'GET') {
        await handleGetCampaign(decodeURIComponent(campaignMatch[1]), res);
        return;
      }

      if (url === '/api/benchmarks' && req.method === 'GET') {
        await handleGetList(req, res);
        return;
      }

      const match = url.match(/^\/api\/benchmarks\/([^/]+)$/);
      if (match && req.method === 'GET') {
        await handleGetOne(decodeURIComponent(match[1]), res);
        return;
      }

      if (url === '/api/benchmarks' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await handlePost(body, res);
        return;
      }

      if (url === '/api/benchmarks' && req.method === 'DELETE') {
        await handleDeleteAll(res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Body too large') {
        sendJson(res, 413, { error: message });
        return;
      }
      sendJson(res, 500, { error: message });
    }
  };
}
