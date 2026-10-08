import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './assets.js';

const active = new Map();
const terminal = new Set(['succeeded', 'failed', 'canceled', 'outcome_unknown']);

export async function workspaceJournal(home, workspace) {
  const canonical = await fs.realpath(workspace);
  return path.join(home, 'image-generation', sha256(process.platform === 'win32' ? canonical.toLowerCase() : canonical));
}

export async function readImageJob(home, workspace, jobId) {
  if (!/^[a-f0-9]{64}$/.test(jobId)) throw new Error('Invalid image job ID');
  const directory = await workspaceJournal(home, workspace);
  const file = path.join(directory, `${jobId}.json`);
  const job = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!terminal.has(job.status) && !active.has(file)) {
    job.status = 'outcome_unknown';
    job.completedAt = new Date().toISOString();
    job.error = 'Execution interrupted. Provider charges may apply. This job will not be resubmitted.';
    await persist(file, job);
  }
  return job;
}

async function persist(file, job) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}

async function abortable(work, signal) {
  if (!signal) return work;
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, canceled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export async function runImageJob({ home, workspace, identity, metadata, signal, execute }) {
  if (typeof identity !== 'string' || !identity || identity.length > 2048) throw new Error('Image generation requires a runner execution identity');
  const directory = await workspaceJournal(home, workspace);
  await fs.mkdir(directory, { recursive: true });
  const jobId = sha256(identity);
  const file = path.join(directory, `${jobId}.json`);
  if (active.has(file)) return active.get(file);
  const run = (async () => {
    const job = { ...metadata, jobId, status: 'queued', createdAt: new Date().toISOString(), artifacts: [], usage: null, cost: null };
    try { await fs.writeFile(file, JSON.stringify(job), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return readImageJob(home, workspace, jobId); throw error; }
    try {
      signal?.throwIfAborted();
      job.status = 'submitting';
      await persist(file, job);
      Object.assign(job, await abortable(execute(jobId, async update => { signal?.throwIfAborted(); Object.assign(job, update); await persist(file, job); }), signal));
      job.status = 'succeeded';
    } catch (error) {
      job.status = signal?.aborted ? 'canceled' : error.definitive ? 'failed' : 'outcome_unknown';
      job.error = error.safeMessage ?? 'Image generation did not complete. Provider charges may apply; do not resubmit this execution.';
    }
    job.completedAt = new Date().toISOString();
    await persist(file, job);
    return job;
  })();
  active.set(file, run);
  try { return await run; } finally { active.delete(file); }
}

export async function cleanupImageJobs(home, workspace, now = Date.now()) {
  const directory = await workspaceJournal(home, workspace);
  for (const entry of await fs.readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const file = path.join(directory, entry);
    if (active.has(file)) continue;
    const job = JSON.parse(await fs.readFile(file, 'utf8'));
    if (terminal.has(job.status) && Date.parse(job.completedAt) < now - 30 * 86400000) await fs.unlink(file);
  }
}
