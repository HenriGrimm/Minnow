import { createHash } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { getProviderRuntime } from './store.js';
import { MINNOW_OPENCODE_USER_AGENT } from './opencode-identity.js';
import { OPENCODE_GO_USAGE_URL, normalizeOpenCodeAccountUsage } from './opencode-account-usage.js';

const MAX_BODY_BYTES = 64 * 1024;

// Deliberately reject coercions such as null, blank strings, hex and Infinity.
function balanceNumber(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid balance');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid balance');
  return number;
}

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error('Unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('Oversized balance');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const deepSeekUsageAdapter = {
  matches(profile) {
    try {
      const url = new URL(profile.baseUrl);
      return profile.apiKind !== 'agent-cli-v1' &&
        url.origin === 'https://api.deepseek.com' && !url.username && !url.password;
    } catch { return false; }
  },
  async read(runtime, { fetchImpl, signal }) {
    const headers = new Headers(runtime.headers);
    const authorization = headers.get('authorization');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) throw new Error('Missing credential');
    const response = await fetchImpl('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    const data = await boundedJson(response);
    if (!Array.isArray(data.balance_infos) || !data.balance_infos.length) throw new Error('Invalid balances');
    return data.balance_infos.flatMap((balance) => {
      if (!balance || !['CNY', 'USD'].includes(balance.currency)) throw new Error('Invalid currency');
      return [
        { label: 'Total balance', remaining: balanceNumber(balance.total_balance), unit: balance.currency },
        { label: 'Granted balance', remaining: balanceNumber(balance.granted_balance), unit: balance.currency },
        { label: 'Topped-up balance', remaining: balanceNumber(balance.topped_up_balance), unit: balance.currency },
      ];
    });
  },
};

export const openCodeGoUsageAdapter = {
  matches(profile) {
    try {
      const url = new URL(profile.baseUrl);
      return profile.apiKind !== 'agent-cli-v1' && url.origin === 'https://opencode.ai'
        && !url.username && !url.password
        && (/^\/zen\/go(?:\/|$)/.test(url.pathname)
          || /^\/inference\/go(?:\/|$)/.test(url.pathname)
          || (url.pathname === '/' && /^\/zen\/go\//.test(profile.chatCompletionsPath ?? '')));
    } catch { return false; }
  },
  async read(runtime, { fetchImpl, signal, checkedAt }) {
    const authorization = new Headers(runtime.headers).get('authorization');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) throw new Error('Missing credential');
    const response = await fetchImpl(OPENCODE_GO_USAGE_URL, {
      method: 'GET', redirect: 'error', signal,
      headers: { Authorization: authorization, Accept: 'application/json',
        'User-Agent': MINNOW_OPENCODE_USER_AGENT },
    });
    const metrics = normalizeOpenCodeAccountUsage(await boundedJson(response), checkedAt);
    if (!metrics.length) throw new Error('No reported quota');
    return metrics;
  },
};

// CLI account adapters retain their existing service in models/agent-cli-usage.js.
// New adapters must use read-only account APIs, never generation endpoints.
export function createAccountUsageService({
  getRuntime = getProviderRuntime,
  getHome = getMinnowHome,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = 60_000,
  timeoutMs = 8_000,
  adapters = [deepSeekUsageAdapter, openCodeGoUsageAdapter],
} = {}) {
  const cache = new Map();
  const identity = (id, runtime) => createHash('sha256').update(JSON.stringify([
    getHome(), id, runtime.profile, runtime.secrets, runtime.headers,
  ])).digest('hex');
  return async function getAccountUsage(id) {
    const empty = (status) => ({ status, checkedAt: new Date(now()).toISOString(), metrics: [] });
    let runtime;
    try { runtime = await getRuntime(id); } catch { return empty('unavailable'); }
    const key = identity(id, runtime);
    const existing = cache.get(key);
    if (existing && (existing.pending || existing.expiresAt > now())) return existing.promise;
    // Bound memory, including profiles and credentials which are no longer used.
    for (const [oldKey, entry] of cache) {
      if (!entry.pending && entry.expiresAt <= now()) cache.delete(oldKey);
    }
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    const entry = { pending: true, expiresAt: 0, promise: null };
    entry.promise = (async () => {
      const adapter = adapters.find((candidate) => candidate.matches(runtime.profile));
      if (!adapter) return empty('unsupported');
      const controller = new AbortController();
      let timer;
      try {
        // Race as well as abort: injected transports need not honor the signal.
        const metrics = await Promise.race([
          adapter.read(runtime, { fetchImpl, signal: controller.signal, checkedAt: new Date(now()).toISOString() }),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, timeoutMs);
          }),
        ]);
        // Do not paint a prior account if credentials/config changed in flight.
        if (identity(id, await getRuntime(id)) !== key) return empty('unavailable');
        return { status: 'available', checkedAt: new Date(now()).toISOString(), metrics };
      } catch { return empty('unavailable'); }
      finally { clearTimeout(timer); }
    })().catch(() => empty('unavailable')).finally(() => {
      entry.pending = false;
      entry.expiresAt = now() + ttlMs;
    });
    cache.set(key, entry);
    return entry.promise;
  };
}

export const getAccountUsage = createAccountUsageService();
