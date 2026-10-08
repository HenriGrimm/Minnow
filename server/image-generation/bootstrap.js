import { registerImageAdapter } from './adapter-registry.js';
import { createOpenAIImageAdapter } from './adapters/openai.js';
import { createOpenRouterImageAdapter } from './adapters/openrouter.js';

registerImageAdapter(createOpenAIImageAdapter());
registerImageAdapter(createOpenRouterImageAdapter());
