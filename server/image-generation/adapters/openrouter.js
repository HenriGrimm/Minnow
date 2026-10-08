import { IMAGE_OPTION_KEYS, validateImageCapabilities } from '../contracts.js';
import { boundedJson, imageEndpoint, normalizeImageResponse } from './http.js';

export function createOpenRouterImageAdapter(fetchImpl = fetch) {
  async function metadata(runtime, suffix, signal) {
    return boundedJson(await fetchImpl(imageEndpoint(runtime, suffix), { headers: runtime.headers, signal, redirect: 'error' }), 2 * 1024 * 1024);
  }
  async function capabilities(modelId, runtime, signal) {
    const models = await metadata(runtime, '/images/models', signal);
    const model = models.data?.find(row => row.id === modelId && row.architecture?.output_modalities?.includes('image'));
    if (!model) throw new Error('Image model unavailable in OpenRouter catalog');
    const details = await metadata(runtime, `/images/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`, signal);
    const endpoint = details.endpoints?.find(row => typeof row.provider_tag === 'string' && row.provider_tag);
    if (!endpoint) throw new Error('No verifiable OpenRouter image endpoint');
    const options = {};
    for (const key of IMAGE_OPTION_KEYS) {
      const descriptor = endpoint.supported_parameters?.[key === 'format' ? 'output_format' : key];
      if (descriptor?.type === 'enum' && Array.isArray(descriptor.values)) options[key] = descriptor.values.filter(v => typeof v === 'string' && (key !== 'format' || ['png', 'jpeg', 'webp'].includes(v)));
    }
    return { operations: ['generate', ...(model.architecture?.input_modalities?.includes('image') && endpoint.supported_parameters?.input_references ? ['edit'] : [])], options, endpoint: endpoint.provider_tag, evidence: 'Live OpenRouter endpoint metadata' };
  }
  return {
    id: 'openrouter', capabilities,
    async catalog(runtime, signal) {
      const body = await metadata(runtime, '/images/models', signal);
      return (body.data ?? []).filter(row => row.architecture?.output_modalities?.includes('image')).map(row => ({ id: row.id }));
    },
    async generate({ runtime, modelId, request, references, signal, capabilities: caps }) {
      validateImageCapabilities(request, caps);
      const body = { model: modelId, prompt: request.prompt, n: 1, provider: { only: [caps.endpoint], allow_fallbacks: false } };
      for (const key of IMAGE_OPTION_KEYS) if (request[key]) body[key === 'format' ? 'output_format' : key] = request[key];
      if (references.length) body.input_references = references.map(ref => ({ type: 'image_url', image_url: { url: `data:${ref.mime};base64,${ref.bytes.toString('base64')}` } }));
      const response = await fetchImpl(imageEndpoint(runtime, '/images'), { method: 'POST', headers: { ...runtime.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
      return { ...normalizeImageResponse(await boundedJson(response), response), routedProvider: caps.endpoint };
    },
  };
}
