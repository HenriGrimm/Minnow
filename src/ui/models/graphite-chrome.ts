import { createIcon } from '../icon';
import { groupLibraryVariants } from '../../models/library-group';
import { loadableLibrary } from '../../models/library';
import type { ModelsSectionId } from '../models-section-ids';
import { el, formatBytes } from './dom';
import { getModelsState } from './store';

export function usesGraphiteModels(): boolean {
  return document.documentElement.classList.contains('mn-graphite-apps');
}

export function setModelsRailCount(id: ModelsSectionId, count: number): void {
  const target = document.querySelector(`#modelsView .models-nav [data-models-nav="${id}"] .models-nav__metadata`);
  if (target) target.textContent = count ? String(count) : '';
}

function hardwareRow(label: string, value: string, used?: number, total?: number): HTMLElement {
  const row = el('div', 'models-rail-meter');
  const line = el('div', 'models-rail-meter__line');
  line.append(el('span', undefined, label), el('span', 'models-rail-meter__value', value));
  row.append(line);
  if (used !== undefined && total !== undefined && total > 0) {
    const meter = el('meter', 'models-rail-meter__bar');
    meter.max = total;
    meter.value = Math.max(0, Math.min(total, used));
    meter.setAttribute('aria-label', `${label} in use`);
    row.append(meter);
  }
  return row;
}

export function updateGraphiteModelsChrome(root: HTMLElement): void {
  const nav = root.querySelector<HTMLElement>('.models-nav');
  if (!nav) return;
  const { hardware, library, serves } = getModelsState();
  const setCount = (id: ModelsSectionId, value: string) => {
    const slot = nav.querySelector<HTMLElement>(`[data-models-nav="${id}"] .models-nav__metadata`);
    if (slot && slot.textContent !== value) slot.textContent = value;
  };
  const distinct = new Map(library.map((item) => [item.path ?? item.id, item]));
  const groups = groupLibraryVariants(loadableLibrary(library, { backend: hardware?.backend })).length;
  setCount('installed', groups ? String(groups) : '');
  const bytes = [...distinct.values()].reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  setCount('settings', bytes > 0 ? formatBytes(bytes) : '');
  nav.querySelector('[data-models-nav="server"]')?.classList.toggle('is-serving', serves.some((serve) => serve.status === 'running'));
  const meters = nav.querySelector<HTMLElement>('.models-rail-hardware');
  if (!meters) return;
  const key = JSON.stringify(hardware && [hardware.gpuVramGb, hardware.totalRamGb, hardware.availableRamGb, hardware.unifiedMemory]);
  if (meters.dataset.hardware === key) return;
  meters.dataset.hardware = key;
  if (!hardware) { meters.replaceChildren(); return; }
  const usedRam = Math.max(0, hardware.totalRamGb - hardware.availableRamGb);
  const gb = (value: number) => `${value.toFixed(1)} GiB`;
  const gpu = hardware.gpuVramGb;
  const gpuRow = gpu != null
    ? hardwareRow(hardware.unifiedMemory ? 'Unified memory' : 'GPU memory', gb(gpu))
    : null;
  meters.replaceChildren(...(gpuRow ? [gpuRow] : []), hardwareRow('RAM', `${usedRam.toFixed(1)} / ${gb(hardware.totalRamGb)}`, usedRam, hardware.totalRamGb));
}

export function mountGraphiteModelsChrome(root: HTMLElement, navigate: (id: ModelsSectionId) => void): void {
  const nav = root.querySelector<HTMLElement>('.models-nav');
  const body = root.querySelector<HTMLElement>('.models-page-body');
  if (!nav || !body || nav.querySelector('.models-rail-hardware')) return;
  for (const button of nav.querySelectorAll<HTMLButtonElement>('[data-models-nav]')) {
    const text = [...button.childNodes].filter((node) => node.nodeType === document.TEXT_NODE);
    const label = el('span', 'models-nav__label');
    const original = el('span', 'models-nav__original-label', text.map((node) => node.textContent).join('').trim());
    label.append(original);
    for (const node of text) node.remove();
    const key = button.dataset.modelsNav;
    const graphiteLabel = key === 'sampler' ? 'Sampling and thinking' : key === 'usage' ? 'Usage and cost' : '';
    if (graphiteLabel) {
      label.classList.add('has-graphite-label');
      label.append(el('span', 'models-nav__graphite-label', graphiteLabel));
    }
    button.append(label, el('span', 'models-nav__metadata'));
  }
  nav.append(el('div', 'models-rail-hardware'));
  const railWidth = Number.parseFloat(getComputedStyle(root).getPropertyValue('--mn-workbench-rail-w')) || 232;
  nav.after(createModelsResizeHandle(body, {
    label: 'Resize Models sidebar', property: '--models-graphite-rail-width', initial: railWidth, min: 176, max: 290,
  }));

  for (const [section, target, label] of [['settings', 'engine', 'Manage engines'], ['engine', 'settings', 'Storage settings']] as const) {
    const heading = root.querySelector(`#modelsSection-${section} > h2`);
    if (!heading) continue;
    const jump = el('button', 'models-btn models-graphite-section-link');
    jump.type = 'button';
    jump.append(createIcon(section === 'settings' ? 'tools' : 'chevronLeft', { size: 14 }), label);
    jump.addEventListener('click', () => navigate(target));
    heading.after(jump);
  }
  updateGraphiteModelsChrome(root);
}

interface ModelsResizeOptions {
  label: string;
  property: string;
  initial: number;
  min: number;
  max: number;
  reverse?: boolean;
}

/** Shared pointer and keyboard handle for the Models workbench dividers. */
export function createModelsResizeHandle(host: HTMLElement, options: ModelsResizeOptions): HTMLElement {
  const handle = el('div', 'models-graphite-resize');
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', options.label);
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(options.min));
  handle.setAttribute('aria-valuemax', String(options.max));
  const key = `minnow.models.${options.property}`;
  const direction = options.reverse ? -1 : 1;
  let width = options.initial;
  let pointer: { id: number; x: number; width: number } | undefined;
  const paint = (next: number) => {
    width = Math.min(options.max, Math.max(options.min, Math.round(next)));
    host.style.setProperty(options.property, `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
  };
  const save = () => { try { localStorage.setItem(key, String(width)); } catch {} };
  try {
    const stored = Number(localStorage.getItem(key));
    if (stored > 0) width = stored;
  } catch {}
  paint(width);
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer) return;
    pointer = { id: event.pointerId, x: event.clientX, width };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (pointer?.id === event.pointerId) paint(pointer.width + (event.clientX - pointer.x) * direction);
  });
  handle.addEventListener('lostpointercapture', () => {
    if (!pointer) return;
    pointer = undefined;
    handle.classList.remove('is-dragging');
    save();
  });
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    const widths: Record<string, number> = {
      ArrowLeft: width - step * direction, ArrowRight: width + step * direction,
      Home: options.min, End: options.max, Enter: options.initial,
    };
    if (!Object.hasOwn(widths, event.key)) return;
    event.preventDefault();
    paint(widths[event.key]);
    save();
  });
  handle.addEventListener('dblclick', () => { paint(options.initial); save(); });
  return handle;
}
