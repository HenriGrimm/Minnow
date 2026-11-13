import { el } from './dom';

/** Add quick controls to the same numeric fields that persist the sampler defaults. */
export function mountGraphiteSamplerControls(host: HTMLElement): void {
  const grid = host.querySelector('#settingsSamplerBody .settings-sampler-grid');
  if (!grid || grid.querySelector('.models-sampler-advanced')) return;
  const advanced = el('details', 'models-sampler-advanced');
  advanced.append(el('summary', undefined, 'Advanced sampling'));
  const fields = el('div', 'models-sampler-advanced__fields');
  advanced.append(fields);
  for (const field of grid.querySelectorAll<HTMLElement>('.settings-sampler-field')) {
    const number = field.querySelector<HTMLInputElement>('input[type="number"]');
    const label = field.querySelector('label');
    if (!number || !label || !['sampler-temperature', 'sampler-topP', 'sampler-minP'].includes(number.id)) {
      fields.append(field);
      continue;
    }
    field.classList.add('models-sampler-quick');
    const slider = el('input', 'models-sampler-slider');
    slider.type = 'range';
    slider.min = number.min;
    slider.max = number.max;
    slider.step = number.step;
    slider.setAttribute('aria-label', `Adjust ${label.textContent}`);
    const sync = () => {
      slider.value = number.value || number.min;
      slider.setAttribute('aria-valuetext', number.value || 'Model default');
    };
    const apply = () => {
      number.value = slider.value;
      slider.setAttribute('aria-valuetext', slider.value);
    };
    sync();
    slider.addEventListener('input', apply);
    slider.addEventListener('change', apply);
    number.addEventListener('input', sync);
    field.append(slider);
  }
  grid.append(advanced);
}
