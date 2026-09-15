import { el } from './dom';
import { withSessionToken } from '../../api/session-token';

const MODEL_CREATORS: Array<[RegExp, string]> = [
  [/\bqwen(?:\d|\b)/i, 'Qwen'],
  [/\b(?:deepseek|janus)\b/i, 'deepseek-ai'],
  [/\b(?:llama|code-llama)\b/i, 'meta-llama'],
  [/\b(?:gemma|gemini)\b/i, 'google'],
  [/\b(?:mistral|mixtral|codestral)\b/i, 'mistralai'],
  [/\bphi[-_.\d]/i, 'microsoft'],
  [/\bcommand[-_.]?r\b/i, 'CohereForAI'],
  [/\bgranite\b/i, 'ibm-granite'],
  [/\b(?:stablelm|stable-code)\b/i, 'stabilityai'],
  [/\bfalcon\b/i, 'tiiuae'],
  [/\byi[-_.\d]/i, '01-ai'],
];

const CREATOR_LABELS: Record<string, string> = {
  '01-ai': '01.AI',
  CohereForAI: 'Cohere',
  'deepseek-ai': 'DeepSeek',
  google: 'Google',
  'ibm-granite': 'IBM',
  'meta-llama': 'Meta',
  microsoft: 'Microsoft',
  mistralai: 'Mistral AI',
  stabilityai: 'Stability AI',
  tiiuae: 'TII',
};

export function formatCreatorLabel(creator: string): string {
  return CREATOR_LABELS[creator] ?? creator;
}

/** Prefer the original model maker over the account that repackaged its weights. */
export function resolveModelCreator(repoId: string, sourceModelId = ''): string {
  const sourceOwner = sourceModelId.split('/')[0]?.trim();
  if (sourceOwner) return sourceOwner;
  const modelName = repoId.split('/').pop() ?? repoId;
  const matched = MODEL_CREATORS.find(([pattern]) => pattern.test(modelName));
  return matched?.[1] ?? repoId.split('/')[0]?.trim() ?? '';
}

function initialsFor(creator: string): string {
  const words = creator.split(/[^a-z0-9]+/i).filter(Boolean);
  if (!words.length) return '?';
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

export function createCreatorLogo(creator: string): HTMLElement {
  const label = formatCreatorLabel(creator);
  const mark = el('span', 'discover-creator-logo');
  mark.title = label;
  mark.setAttribute('aria-hidden', 'true');
  const fallback = el('span', 'discover-creator-logo__fallback', initialsFor(label));
  const image = new Image();
  image.className = 'discover-creator-logo__image';
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => mark.classList.add('has-image'));
  image.addEventListener('error', () => image.remove());
  image.src = withSessionToken(`/api/models/hf/avatar?${new URLSearchParams({ owner: creator })}`);
  mark.append(fallback, image);
  return mark;
}

export function createModelIdentity(name: string, creator: string): HTMLElement {
  const identity = el('div', 'discover-model-identity');
  const text = el('div', 'discover-model-identity__text');
  text.append(el('h4', undefined, name), el('p', 'models-muted', formatCreatorLabel(creator)));
  identity.append(createCreatorLogo(creator), text);
  return identity;
}
