import { iconHtml, type IconName } from './icon';
import { mountRoutingForm } from './routing-form';
import { openShellOverlay, shellOverlayClosed } from './shell-overlay-state';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';
import type { ModelsSectionId } from './models-section-ids';
import { mountModelPoolOverview } from './model-pool-overview';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { formatModelLabel } from '../lib/format-model-label';

export function openModelsPopover(anchor: HTMLButtonElement): () => void {
  const panel = document.createElement('section');
  panel.className = 'mn-models-popover mn-models-popover--system';
  panel.id = 'modelsSystemPopover';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Models');
  panel.innerHTML = `
    <header class="models-system__header">
      <div class="models-system__identity">
        <span class="models-system__mark">${iconHtml('appModels', { size: 21 })}</span>
        <div><h2>Models</h2><p>Shared across projects</p></div>
      </div>
      <button type="button" class="mn-models-popover__close" aria-label="Close Models">${iconHtml('close', { size: 14 })}</button>
    </header>
    <div class="models-system__content">
      <section class="models-system__pools" aria-label="Pool task assignments">
        <div class="models-system__section-heading"><h3>Model pools</h3><button type="button" class="models-system__manage models-system__edit-pools">Manage pools ${iconHtml('chevronRight', { size: 12 })}</button></div>
        <div class="models-system__pool-list"></div>
      </section>
      <section class="models-system__routing" aria-label="Task routing">
        <div class="models-system__section-heading"><h3>Task routing</h3><span>Optional overrides</span></div>
        <div class="models-system__form"></div>
      </section>
      <nav class="models-system__nav" aria-label="Model settings"></nav>
    </div>
    <footer class="models-system__footer">
      <span class="models-system__hint">${iconHtml('modeGeneral', { size: 14 })}<span>Choose chat models in the composer</span></span>
      <button type="button" class="models-system__manage">Manage models ${iconHtml('chevronRight', { size: 12 })}</button>
    </footer>`;
  const body = panel.querySelector<HTMLElement>('.models-system__form')!;
  const dismiss = panel.querySelector<HTMLButtonElement>('.mn-models-popover__close')!;
  const overview = mountModelPoolOverview(panel.querySelector<HTMLElement>('.models-system__pool-list')!, entry => {
    const value = encodeModelSelectKey(entry.providerId, entry.modelId);
    return [...body.querySelectorAll('option')].find(option => option.value === value)?.textContent || formatModelLabel({ id: entry.modelId }).optionText;
  });
  const form = mountRoutingForm(body, { autosave: true, onReady: overview.refresh });
  const nav = panel.querySelector<HTMLElement>('nav')!;
  let alive = true;

  const close = (): void => {
    if (!alive) return;
    alive = false;
    form.dispose();
    overview.dispose();
    panel.remove();
    unregisterChromePopover();
    shellOverlayClosed('models');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key);
    window.removeEventListener('resize', position);
    anchor.focus();
  };

  const position = (): void => {
    const box = anchor.getBoundingClientRect();
    const top = Math.max(12, Math.min(box.bottom + 8, window.innerHeight - 80));
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `min(720px, ${window.innerHeight - top - 12}px)`;
    panel.style.left = `${Math.max(12, Math.min(box.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 12))}px`;
  };
  const outside = (event: PointerEvent): void => {
    const target = event.target as Element;
    if (panel.contains(target) || anchor.contains(target) || target.closest('.model-select-menu, .composer-model-panel')) return;
    close();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.key !== 'Escape' || panel.querySelector('.auxiliary-model-popover:not(.hidden)')) return;
    event.preventDefault();
    close();
  };
  const navigate = (section: ModelsSectionId): void => {
    close();
    void import('./models-page').then((module) => module.openModels(section));
  };
  const destinations: { label: string; hint: string; section: ModelsSectionId; icon: IconName }[] = [
    { label: 'Providers & connections', hint: 'Connect local servers and cloud APIs', section: 'providers', icon: 'globe' },
    { label: 'Local models', hint: 'Manage runtimes and loaded models', section: 'server', icon: 'appServers' },
  ];
  for (const { label, hint, section, icon } of destinations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'models-system__destination';
    button.innerHTML = `${iconHtml(icon, { size: 17, className: 'models-system__destination-icon' })}<span class="models-system__destination-copy"><span>${label}</span><small>${hint}</small></span>${iconHtml('chevronRight', { size: 12, className: 'models-system__destination-arrow' })}`;
    button.onclick = () => navigate(section);
    nav.append(button);
  }
  panel.querySelector<HTMLButtonElement>('.models-system__edit-pools')!.onclick = () => navigate('routers');
  panel.querySelector<HTMLButtonElement>('.models-system__footer .models-system__manage')!.onclick = () => navigate('installed');
  dismiss.onclick = close;
  openShellOverlay('models', close);
  document.body.append(panel);
  registerChromePopover();
  position();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key);
  window.addEventListener('resize', position);
  dismiss.focus();
  return close;
}
