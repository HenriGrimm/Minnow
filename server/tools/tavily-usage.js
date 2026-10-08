import { createHash } from 'node:crypto';
import { requestTavily } from './tavily-client.js';

let cached = null;
let inFlight = null;
const TTL_MS = 60_000;

function metrics(value, fields) {
  const result = {};
  for (const field of fields) {
    const number = value?.[field];
    result[field] = typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
  }
  return result;
}

/** A key-scoped transient cache, with no credentials in responses or on disk. */
export async function getTavilyUsage(apiKey, refresh = false) {
  if (!apiKey?.trim()) {
    cached = null;
    inFlight = null;
    throw new Error('Add a Tavily API key in Search Settings to see usage.');
  }
  const fingerprint = createHash('sha256').update(apiKey).digest('hex');
  if (cached?.fingerprint !== fingerprint) cached = null;
  if (!refresh && cached && Date.now() - cached.at < TTL_MS) return cached.data;
  if (inFlight?.fingerprint === fingerprint) return inFlight.promise;
  const promise = (async () => {
    const payload = await requestTavily('usage', apiKey);
    if (!payload.key || !payload.account) throw new Error('Tavily returned invalid usage data');
    const breakdown = ['search_usage', 'extract_usage', 'map_usage', 'crawl_usage', 'research_usage'];
    const data = {
      key: metrics(payload.key, ['usage', 'limit', ...breakdown]),
      account: { ...metrics(payload.account, ['plan_usage', 'plan_limit', 'paygo_usage', 'paygo_limit', ...breakdown]),
        current_plan: typeof payload.account.current_plan === 'string' ? payload.account.current_plan.slice(0, 100) : null },
      fetchedAt: new Date().toISOString(),
    };
    if (inFlight?.fingerprint === fingerprint) cached = { fingerprint, at: Date.now(), data };
    return data;
  })();
  inFlight = { fingerprint, promise };
  try { return await promise; }
  finally { if (inFlight?.promise === promise) inFlight = null; }
}
