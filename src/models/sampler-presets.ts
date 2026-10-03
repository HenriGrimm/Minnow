import type { SamplerPreset } from '../agents/sampler-types';

export interface ModelSamplerPreset {
  id: string;
  label: string;
  values: Readonly<SamplerPreset>;
}

interface ModelSamplerPresetFamily {
  id: string;
  label: string;
  matches: RegExp;
  source: string;
  reviewedAt: string;
  presets: readonly ModelSamplerPreset[];
}

const neutral = { minP: 0, presencePenalty: 0, repetitionPenalty: 1 };
const qwenThinking = { ...neutral, temperature: 1, topP: 0.95, topK: 20 };
const qwenCoding = { ...qwenThinking, temperature: 0.6 };
const qwenInstruct = {
  ...neutral, temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5,
};

/** Specific families precede base models so distills and coding variants stay distinct. */
export const MODEL_SAMPLER_PRESET_FAMILIES: readonly ModelSamplerPresetFamily[] = [
  {
    id: 'deepseek-r1', label: 'DeepSeek R1', matches: /\bdeepseek-r1(?:\b|_)/i,
    source: 'https://huggingface.co/deepseek-ai/DeepSeek-R1#usage-recommendations',
    reviewedAt: '2026-10-02',
    presets: [{ id: 'reasoning', label: 'Reasoning', values: { temperature: 0.6, topP: 0.95 } }],
  },
  {
    id: 'qwen3-coder-next', label: 'Qwen3 Coder Next', matches: /\bqwen3-coder-next\b/i,
    source: 'https://huggingface.co/Qwen/Qwen3-Coder-Next#best-practices',
    reviewedAt: '2026-10-02',
    presets: [{ id: 'coding', label: 'Coding', values: { temperature: 1, topP: 0.95, topK: 40 } }],
  },
  {
    id: 'qwen3.8', label: 'Qwen3.8', matches: /\bqwen3[.-]8\b/i,
    source: 'https://huggingface.co/Qwen/Qwen3.8-27B#best-practices',
    reviewedAt: '2026-10-02',
    presets: [
      { id: 'thinking', label: 'Thinking', values: qwenThinking },
      { id: 'instruct', label: 'Non-thinking', values: qwenInstruct },
    ],
  },
  {
    id: 'qwen3.6', label: 'Qwen3.6', matches: /\bqwen3[.-]6\b/i,
    source: 'https://huggingface.co/Qwen/Qwen3.6-27B#best-practices',
    reviewedAt: '2026-10-02',
    presets: [
      { id: 'thinking-code', label: 'Thinking / precise coding', values: qwenCoding },
      { id: 'thinking', label: 'Thinking / general', values: qwenThinking },
      { id: 'instruct', label: 'Non-thinking', values: qwenInstruct },
    ],
  },
  {
    id: 'qwen3.5', label: 'Qwen3.5', matches: /\bqwen3[.-]5\b/i,
    source: 'https://huggingface.co/Qwen/Qwen3.5-9B#best-practices',
    reviewedAt: '2026-10-02',
    presets: [
      { id: 'thinking-code', label: 'Thinking / precise coding', values: qwenCoding },
      { id: 'thinking', label: 'Thinking / general', values: { ...qwenThinking, presencePenalty: 1.5 } },
      { id: 'instruct', label: 'Non-thinking / general', values: qwenInstruct },
    ],
  },
  {
    id: 'qwen3', label: 'Qwen3', matches: /\bqwen3-\d+(?:\.\d+)?b(?:-a\d+b)?(?:$|[-.:])/i,
    source: 'https://huggingface.co/Qwen/Qwen3-8B#best-practices',
    reviewedAt: '2026-10-02',
    presets: [
      { id: 'thinking', label: 'Thinking', values: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 } },
      { id: 'instruct', label: 'Non-thinking', values: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 } },
    ],
  },
  {
    id: 'gemma4', label: 'Gemma 4', matches: /\bgemma-?4-.*\bit\b/i,
    source: 'https://huggingface.co/google/gemma-4-12B-it#best-practices',
    reviewedAt: '2026-10-02',
    presets: [{ id: 'standard', label: 'Standard', values: { temperature: 1, topP: 0.95, topK: 64 } }],
  },
];

/** Match repo, file, or served names; architecture alone cannot identify a tuning. */
export function recommendedSamplerFamily(...modelNames: (string | null | undefined)[]): ModelSamplerPresetFamily | null {
  const names = modelNames.filter((name): name is string => Boolean(name?.trim()))
    .map((name) => name.toLowerCase().replace(/[_\s]+/g, '-'));
  // July 2025 Qwen3 updates have their own tuning; do not use the original hybrid presets.
  return MODEL_SAMPLER_PRESET_FAMILIES.find((family) =>
    !(family.id === 'qwen3' && names.some((name) => /2507|thinking|instruct|\bbase\b/i.test(name))) &&
    names.some((name) => family.matches.test(name)),
  ) ?? null;
}

/** Only the documented sampler values change; output limits and other overrides survive. */
export function applyModelSamplerPreset(current: SamplerPreset | null, preset: ModelSamplerPreset): SamplerPreset {
  return { ...current, ...preset.values };
}
