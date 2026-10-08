import { validateImageCapabilities } from '../contracts.js';
import { boundedJson, imageEndpoint, normalizeImageResponse } from './http.js';

const MODELS = ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'];

export function createOpenAIImageAdapter(fetchImpl = fetch) {
  function capabilities(model) {
    if (!MODELS.includes(model)) throw new Error('Image model not in the verified OpenAI catalog');
    return { operations: ['generate', 'edit'], options: {
      size: ['auto', '1024x1024', '1536x1024', '1024x1536'],
      quality: ['auto', 'low', 'medium', 'high', ...(model.startsWith('gpt-image-2.5') ? ['xhigh', 'max'] : [])],
      format: ['png', 'jpeg', 'webp'], background: ['auto', 'opaque', 'transparent'],
    }, evidence: 'OpenAI Images reference, 2026-10-07' };
  }
  return {
    id: 'openai', capabilities,
    async catalog(runtime, signal) {
      const body = await boundedJson(await fetchImpl(imageEndpoint(runtime, '/models'), { headers: runtime.headers, signal, redirect: 'error' }), 2 * 1024 * 1024);
      return MODELS.filter(id => body.data?.some(row => row.id === id)).map(id => ({ id, capabilities: capabilities(id) }));
    },
    async generate({ runtime, modelId, request, references, signal }) {
      validateImageCapabilities(request, capabilities(modelId));
      const data = { model: modelId, prompt: request.prompt, n: 1 };
      for (const key of ['size', 'quality', 'background']) if (request[key]) data[key] = request[key];
      data.output_format = request.format ?? 'png';
      let body, headers = { ...runtime.headers };
      if (request.operation === 'edit') {
        body = new FormData();
        for (const [key, value] of Object.entries(data)) body.append(key, String(value));
        for (const reference of references) body.append('image[]', new Blob([reference.bytes], { type: reference.mime }), `reference.${reference.extension}`);
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
      } else { body = JSON.stringify(data); headers['Content-Type'] = 'application/json'; }
      const response = await fetchImpl(imageEndpoint(runtime, request.operation === 'edit' ? '/images/edits' : '/images/generations'), { method: 'POST', headers, body, signal, redirect: 'error' });
      return normalizeImageResponse(await boundedJson(response), response);
    },
  };
}
