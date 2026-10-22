import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { getProviderRuntime } from '../providers/store.js';
import { getAgentCliAllowanceIdentity } from '../models/agent-cli-usage.js';
import { allowanceFailure } from './quota-error.js';
export { allowanceFailure } from './quota-error.js';

const INITIAL_COOLDOWN = 15 * 60_000;
const MAX_COOLDOWN = 6 * 60 * 60_000;
const services = new Map();

/** Pure state machine: one real request probes an expired block, no background inference. */
export class AllowanceTracker {
  constructor({ rows = {}, now = Date.now, changed = () => {} } = {}) {
    this.rows = new Map(Object.entries(rows).filter(([, row]) =>
      row && ['quota', 'rate_limit', 'unavailable'].includes(row.kind) && Number.isFinite(row.retryAt) && Number.isFinite(row.failures)));
    this.now = now;
    this.changed = changed;
    this.probes = new Map();
    this.listeners = new Set();
  }
  key(context, scope = 'model') { return JSON.stringify([context.identity, scope === 'provider' ? '*' : scope === 'family' && context.family ? `family:${context.family}` : context.modelId]); }
  block(context) {
    for (const scope of ['provider', ...(context.family ? ['family'] : []), 'model']) {
      const key = this.key(context, scope);
      const row = this.rows.get(key);
      if (row) return { key, row };
    }
    return null;
  }
  availability(context) {
    const block = this.block(context);
    if (!block) return { available: true };
    const probing = this.probes.has(block.key);
    const available = !probing && this.now() >= block.row.retryAt;
    return { available, kind: block.row.kind, retryAt: block.row.retryAt, resetAt: block.row.resetAt,
      reason: probing ? 'Checking allowance recovery' : block.row.kind === 'quota' ? 'Out of usage' : block.row.kind === 'unavailable' ? 'Provider temporarily unavailable' : 'Rate limited' };
  }
  claim(context) {
    const block = this.block(context);
    if (!block) return { finish: (failure) => { if (failure) this.record(context, failure); } };
    const ownsBackoff = ['rate_limit', 'unavailable'].includes(block.row.kind) && context.requestId && block.row.owner === context.requestId && !this.probes.has(block.key);
    if (!ownsBackoff && !this.availability(context).available) return null;
    const token = Symbol('allowance probe');
    this.probes.set(block.key, token);
    return { finish: (failure, success = false) => {
      if (this.probes.get(block.key) !== token) return;
      this.probes.delete(block.key);
      // A concurrent refusal replaces the row; an older success must not clear it.
      if (this.rows.get(block.key) !== block.row) return;
      if (failure) this.record(context, failure);
      else if (success) { this.rows.delete(block.key); this.changed(); }
    } };
  }
  record(context, failure) {
    const key = this.key(context, failure.scope);
    const previous = this.rows.get(key);
    const failures = (previous?.failures || 0) + 1;
    const at = this.now();
    const delay = failure.kind === 'quota' ? Math.min(MAX_COOLDOWN, INITIAL_COOLDOWN * 2 ** Math.min(failures - 1, 5)) : 30_000;
    const resetAt = failure.resetAt > at ? failure.resetAt : previous?.resetAt > at ? previous.resetAt : undefined;
    const retryAt = resetAt ?? at + (failure.kind === 'rate_limit' ? failure.retryAfterMs ?? delay : Math.max(delay, failure.retryAfterMs || 0));
    this.rows.set(key, { kind: failure.kind, failures, observedAt: at, retryAt, ...(resetAt ? { resetAt } : {}),
      // The original request retains its bounded exponential retry when no
      // provider delay was supplied. Other requests observe the shared cooldown.
      ...(['rate_limit', 'unavailable'].includes(failure.kind) && failure.retryAfterMs == null && context.requestId ? { owner: context.requestId } : {}),
    });
    this.changed();
    for (const listener of this.listeners) listener();
  }
  retry(context) {
    const block = this.block(context);
    if (block && !this.probes.has(block.key)) { block.row.retryAt = this.now(); this.changed(); }
  }
  snapshot() { return Object.fromEntries(this.rows); }
}

async function openService(home) {
  const directory = path.join(home, 'model-routers');
  const file = path.join(directory, 'allowances.json');
  let rows = {};
  try { rows = JSON.parse(await fs.readFile(file, 'utf8')).rows || {}; }
  catch (error) { if (error.code !== 'ENOENT') console.warn('[allowances] Could not read saved cooldowns:', error.code || 'invalid data'); }
  let writes = Promise.resolve();
  const tracker = new AllowanceTracker({ rows, changed: () => {
    const content = JSON.stringify({ version: 1, rows: tracker.snapshot() });
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, content, { mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    });
    void writes.catch(error => console.error('[allowances] Could not save cooldowns:', error.code || 'write failed'));
  } });
  tracker.flush = () => writes;
  return tracker;
}

export function getAllowanceTracker() {
  const home = path.resolve(getMinnowHome());
  if (!services.has(home)) services.set(home, openService(home));
  return services.get(home);
}

/** Only opaque fingerprints are persisted; credentials and vendor diagnostics never are. */
export async function allowanceContext(providerId, modelId, runtime) {
  const { profile, secrets } = runtime || await getProviderRuntime(providerId);
  const login = profile.apiKind === 'agent-cli-v1'
    ? await getAgentCliAllowanceIdentity(profile.agentCli.kind, { binPath: profile.agentCli.binPath, cliToken: secrets.cliToken })
    : secrets;
  const identity = createHash('sha256').update(JSON.stringify([providerId, profile.baseUrl, login])).digest('hex');
  const cli = profile.apiKind === 'agent-cli-v1';
  const family = cli && /(?:^|[-/])(opus|sonnet)(?:[-/]|$)/i.exec(modelId)?.[1]?.toLowerCase();
  return { identity, providerId, modelId, cli, ...(family ? { family } : {}) };
}

/** Shared by all transports, including evaluators and CLI generations. */
export async function withAllowance(context, attempt, cancelled = () => false) {
  const tracker = await getAllowanceTracker();
  const claim = tracker.claim(context);
  if (!claim) {
    const status = tracker.availability(context);
    return { outcome: 'fatal', message: `${status.reason}. Retry after ${new Date(status.retryAt).toISOString()}.`,
      quotaExceeded: status.kind === 'quota', allowanceBlocked: true,
      failure: { kind: status.kind, scope: tracker.block(context)?.key === tracker.key(context, 'provider') ? 'provider' : 'model', retryAt: status.retryAt,
        identity: context.identity, providerId: context.providerId, modelId: context.modelId, ...(status.resetAt ? { resetAt: status.resetAt } : {}) } };
  }
  let result;
  try {
    result = await attempt();
    const failure = ['quota', 'rate_limit', 'unavailable'].includes(result.failure?.kind)
      ? result.failure : allowanceFailure(result.message, result);
    if (failure?.kind === 'quota' && context.cli && !result.failure) failure.scope = 'provider';
    claim.finish(failure, result.outcome === 'complete' && !cancelled());
    await tracker.flush().catch(() => {});
    if (failure) { result.failure = { ...failure, identity: context.identity, providerId: context.providerId, modelId: context.modelId }; result.quotaExceeded = failure.kind === 'quota'; }
    else if (result.outcome === 'fatal') result.failure = { identity: context.identity, providerId: context.providerId, modelId: context.modelId };
    return result;
  } finally { claim.finish(null); }
}
