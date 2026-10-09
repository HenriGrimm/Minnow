import { decodeModelSelectKey } from '../lib/model-select-key';
import { modelProducerLogoSvg } from '../providers/model-producer';
import { iconHtml } from './icon';

/** Shared model button for composer controls and app-scoped model pickers. */
export function createComposerModelButton(ariaLabel: string) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'composer-model-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', ariaLabel);

  const dotEl = document.createElement('span');
  dotEl.className = 'model-load-dot composer-model-trigger__spinner';
  dotEl.setAttribute('aria-hidden', 'true');

  const logoEl = document.createElement('span');
  logoEl.className = 'composer-model-trigger__logo hidden';
  logoEl.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = 'composer-model-trigger__label';
  labelEl.textContent = 'Select model';

  const chevronEl = document.createElement('span');
  chevronEl.className = 'composer-model-trigger__chevron';
  chevronEl.setAttribute('aria-hidden', 'true');
  chevronEl.innerHTML = iconHtml('chevronDown', { size: 10 });

  trigger.append(dotEl, logoEl, labelEl, chevronEl);
  return { trigger, dotEl, logoEl, labelEl };
}

/** Split composite option text into model name and provider label. */
export function parseModelOptionLabels(opt?: HTMLOptionElement): {
  model: string;
  provider: string;
} {
  const text = opt?.text?.trim() || opt?.label?.trim() || '';
  const sep = ' — ';
  const idx = text.lastIndexOf(sep);
  if (idx > 0) {
    return {
      model: text.slice(0, idx).trim(),
      provider: text.slice(idx + sep.length).trim(),
    };
  }
  return { model: text || 'Select model', provider: '' };
}

export function applyModelProducerLogo(target: HTMLElement, modelId: string): void {
  const svg = (modelId ? modelProducerLogoSvg(modelId) : '') ?? '';
  target.innerHTML = svg;
  target.classList.toggle('hidden', !svg);
}

export function syncComposerModelButtonLabel(
  button: ReturnType<typeof createComposerModelButton>,
  value: string,
  option?: HTMLOptionElement,
): void {
  button.labelEl.textContent = parseModelOptionLabels(option).model;
  const title = option?.title?.trim() || option?.text?.trim() || value;
  if (title) button.labelEl.title = title;
  else button.labelEl.removeAttribute('title');
  applyModelProducerLogo(button.logoEl, decodeModelSelectKey(value)?.modelId ?? value.trim());
}
