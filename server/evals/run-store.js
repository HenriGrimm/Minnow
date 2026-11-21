/**
 * Persist eval suite manifests, leaderboards, and cells under ~/.minnow/evals/runs/
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LIST_CAP = 50;

function runsRoot() {
  return path.join(getMinnowHome(), 'evals', 'runs');
}

/** @param {string} id */
function safeSuiteRunId(id) {
  if (typeof id !== 'string' || !/^suite-[a-zA-Z0-9._-]+$/.test(id)) {
    return null;
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return null;
  }
  return id;
}

/** @param {string} cellId */
function safeCellId(cellId) {
  if (typeof cellId !== 'string' || !/^[a-z0-9_-]+__[a-zA-Z0-9._-]+$/.test(cellId)) {
    return null;
  }
  if (cellId.includes('..') || cellId.includes('/') || cellId.includes('\\')) {
    return null;
  }
  return cellId;
}

function runDir(suiteRunId) {
  return path.join(runsRoot(), suiteRunId);
}

export async function listRunSummaries() {
  const root = runsRoot();
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, 'manifest.json');
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const m = JSON.parse(raw);
      runs.push({
        suiteRunId: m.suiteRunId ?? entry.name,
        packId: m.packId ?? '',
        packLabel: m.packLabel ?? '',
        status: m.status ?? 'unknown',
        startedAt: m.startedAt ?? '',
        endedAt: m.endedAt ?? null,
        totalCells: m.totalCells ?? 0,
        completedCells: m.completedCells ?? 0,
      });
    } catch {
      /* skip */
    }
  }

  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return runs.slice(0, LIST_CAP);
}

/** @param {string} suiteRunId */
export async function getRunDetail(suiteRunId) {
  const id = safeSuiteRunId(suiteRunId);
  if (!id) return null;
  const dir = runDir(id);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }

  let leaderboard = [];
  try {
    leaderboard = JSON.parse(
      await fs.readFile(path.join(dir, 'leaderboard.json'), 'utf8'),
    );
  } catch {
    leaderboard = [];
  }

  let cellIds = [];
  try {
    const cells = await fs.readdir(path.join(dir, 'cells'));
    cellIds = cells.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    cellIds = [];
  }

  return { manifest, leaderboard, cellIds };
}

/** @param {string} suiteRunId @param {string} cellId */
export async function getCell(suiteRunId, cellId) {
  const id = safeSuiteRunId(suiteRunId);
  const safeCell = safeCellId(cellId);
  if (!id || !safeCell) return null;
  try {
    const raw = await fs.readFile(
      path.join(runDir(id), 'cells', `${safeCell}.json`),
      'utf8',
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function assertBodySize(size) {
  if (size > MAX_BODY_BYTES) {
    throw new Error('Body too large');
  }
}
