import type { SamplerPreset } from '../agents/sampler-types';

export interface SamplerFieldInputs {
  root: HTMLElement;
  readPatch: () => SamplerPreset | null;
  /** Set all inputs from a preset (empty fields when null). */
  setValues: (preset: SamplerPreset | null | undefined) => void;
}

export interface BuildSamplerFieldInputsOptions {
  /** Show max output tokens (global defaults and sub-agent types). */
  includeMaxTokens?: boolean;
  /** Placeholder when empty (e.g. "Inherit" for per-agent overrides). */
  emptyPlaceholder?: string;
  /** Prefix for data-settings-search-key on each field (e.g. models.sampler). */
  searchKeyPrefix?: string;
}

const SEARCH_KEY_BY_FIELD: Record<keyof SamplerPreset, string> = {
  temperature: 'temperature',
  topP: 'topP',
  topK: 'topK',
  minP: 'minP',
  repetitionPenalty: 'repetitionPenalty',
  presencePenalty: 'presencePenalty',
  maxTokens: 'maxTokens',
  stop: 'stop',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Numeric inputs for sampler fields; empty inputs mean inherit (when placeholder set). */
export function buildSamplerFieldInputs(
  initial: SamplerPreset | null | undefined,
  options: BuildSamplerFieldInputsOptions = {},
): SamplerFieldInputs {
  const useGrid = Boolean(options.searchKeyPrefix);
  const root = el(
    'div',
    useGrid ? 'settings-sampler-grid' : 'settings-model-row settings-sampler-row',
  );
  const placeholder = options.emptyPlaceholder ?? 'Inherit';

  const fields: Array<{
    key: keyof SamplerPreset;
    label: string;
    description: string;
    step: string;
    min: string;
    max: string;
  }> = [
    {
      key: 'temperature',
      label: 'Temperature',
      description:
        'How much each token choice varies. Lower stays focused; higher explores more wording.',
      step: '0.05',
      min: '0',
      max: '2',
    },
    {
      key: 'topP',
      label: 'Top P',
      description:
        'Nucleus sampling: keeps likely tokens until their combined probability reaches this value. 1.0 disables the cutoff.',
      step: '0.05',
      min: '0',
      max: '1',
    },
    {
      key: 'topK',
      label: 'Top K',
      description:
        'Only the top K candidates are considered each step. Smaller K tightens output; larger K allows more variety.',
      step: '1',
      min: '1',
      max: '200',
    },
    {
      key: 'minP',
      label: 'Min P',
      description:
        'Drops tokens much less likely than the best pick. Trims noise without a fixed K limit.',
      step: '0.01',
      min: '0',
      max: '1',
    },
    {
      key: 'repetitionPenalty',
      label: 'Repeat penalty',
      description:
        'Penalizes tokens already in the reply. Above 1.0 reduces repeated phrases; 1.0 is neutral.',
      step: '0.01',
      min: '1',
      max: '2',
    },
    {
      key: 'presencePenalty',
      label: 'Presence penalty',
      description:
        'Favors tokens not used yet in the reply. Helps when the model circles the same idea.',
      step: '0.1',
      min: '0',
      max: '2',
    },
  ];

  if (options.includeMaxTokens) {
    fields.push({
      key: 'maxTokens',
      label: 'Max tokens',
      description:
        'Upper bound on completion length for one response. The model may stop sooner on its own.',
      step: '1',
      min: '1',
      max: '131072',
    });
  }

  const inputs = new Map<keyof SamplerPreset, HTMLInputElement>();

  const applyInitial = (preset: SamplerPreset | null | undefined): void => {
    for (const [key, input] of inputs) {
      const value = preset?.[key];
      input.value =
        value !== undefined && Number.isFinite(value) ? String(value) : '';
    }
  };

  for (const field of fields) {
    const inputId = options.searchKeyPrefix ? `sampler-${field.key}` : undefined;

    let mount: HTMLElement = root;

    if (useGrid) {
      const wrap = el('div', 'settings-sampler-field');
      if (options.searchKeyPrefix) {
        wrap.dataset.settingsSearchKey = `${options.searchKeyPrefix}.${SEARCH_KEY_BY_FIELD[field.key]}`;
      }
      const labelEl = el('label', 'settings-sampler-field__label', field.label);
      if (inputId) labelEl.htmlFor = inputId;
      mount = wrap;
      root.appendChild(wrap);
      mount.appendChild(labelEl);

      const hintId = inputId ? `${inputId}-hint` : undefined;
      const hintEl = el('p', 'settings-sampler-field__hint', field.description);
      if (hintId) hintEl.id = hintId;
      mount.appendChild(hintEl);
    } else {
      root.appendChild(el('label', 'settings-field-label', field.label));
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.className = useGrid
      ? 'settings-sampler-field__input'
      : 'settings-sampler-field__input settings-kv-input';
    if (inputId) input.id = inputId;
    if (!useGrid) input.setAttribute('aria-label', field.label);
    if (useGrid && inputId) {
      input.setAttribute('aria-describedby', `${inputId}-hint`);
    }
    input.step = field.step;
    input.min = field.min;
    input.max = field.max;
    input.placeholder = placeholder;
    inputs.set(field.key, input);
    mount.appendChild(input);
  }

  applyInitial(initial);

  const readPatch = (): SamplerPreset | null => {
    const patch: SamplerPreset = {};
    for (const [key, input] of inputs) {
      const raw = input.value.trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (key === 'temperature') patch.temperature = n;
      else if (key === 'topP') patch.topP = n;
      else if (key === 'topK') patch.topK = n;
      else if (key === 'minP') patch.minP = n;
      else if (key === 'repetitionPenalty') patch.repetitionPenalty = n;
      else if (key === 'presencePenalty') patch.presencePenalty = n;
      else if (key === 'maxTokens') patch.maxTokens = n;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  };

  return { root, readPatch, setValues: applyInitial };
}
