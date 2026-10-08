const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Bounded, single-attempt requests. Never retry an ambiguously charged request. */
export async function requestTavily(endpoint, apiKey, body, signal) {
  if (!apiKey?.trim()) throw new Error('Tavily API key not configured. Add one in Settings → Integrations → Search.');
  const deadline = AbortSignal.timeout(((body?.timeout ?? 30) + 5) * 1000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(`https://api.tavily.com/${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: requestSignal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Tavily returned an empty response');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('Tavily response exceeds the 2 MB safety limit. Request fewer pages.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error(`Tavily returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok) {
      const messages = { 401: 'Invalid Tavily API key', 403: 'Tavily denied this request', 429: 'Tavily rate limit reached', 432: 'Tavily plan credit limit reached', 433: 'Tavily pay-as-you-go limit reached' };
      // Do not echo arbitrary upstream errors: they can contain request secrets.
      throw new Error(`${messages[response.status] ?? 'Tavily request failed'} (HTTP ${response.status})`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Tavily returned an invalid response');
    return payload;
  } catch (error) {
    if (requestSignal.aborted) throw new Error(signal?.aborted ? 'Tavily request cancelled' : 'Tavily request timed out. It may have consumed credits.');
    throw error;
  }
}
