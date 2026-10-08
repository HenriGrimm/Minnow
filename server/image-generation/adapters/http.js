import { MAX_IMAGE_BYTES } from '../contracts.js';

export function imageEndpoint(runtime, suffix) {
  const base = runtime.profile.baseUrl.replace(/\/$/, '');
  const url = new URL(base + (base.endsWith('/v1') ? '' : '/v1') + suffix);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Image providers require an HTTPS API base URL');
  return url;
}

export async function boundedJson(response, maxBytes = MAX_IMAGE_BYTES * 1.4) {
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`Image provider returned HTTP ${response.status}`);
    error.safeMessage = error.message;
    error.definitive = response.status >= 400 && response.status < 500;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Image provider response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function normalizeImageResponse(body, response) {
  if (!Array.isArray(body.data) || body.data.length !== 1) throw new Error('Expected exactly one image');
  const image = body.data[0];
  if (typeof image.b64_json !== 'string' || image.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) throw new Error('Provider must return bounded base64 image bytes');
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']) {
    if (Number.isFinite(body.usage?.[key]) && body.usage[key] >= 0) usage[key] = body.usage[key];
  }
  return {
    bytes: Buffer.from(image.b64_json, 'base64'), mime: image.media_type,
    requestId: response.headers.get('x-request-id')?.slice(0, 200) ?? null,
    usage: Object.keys(usage).length ? usage : null,
    cost: Number.isFinite(body.usage?.cost) && body.usage.cost >= 0 ? { amount: body.usage.cost, currency: 'USD', source: 'provider' } : null,
  };
}
