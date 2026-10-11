import { el } from './dom';

const selectedLevels = new Map<string, 'basic' | 'advanced'>();

/** Switch views without replacing controls or losing pending edits. */
export function createLoadSettingsLayout(body: HTMLElement, modelId: string): {
  basic: HTMLElement;
  advanced: HTMLElement;
} {
  const tabs = el('div', 'models-load-levels');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Load settings detail');
  const basic = el('div', 'models-load-basic');
  const advanced = el('div', 'models-load-advanced');
  const panels = { basic, advanced };
  const buttons = new Map<string, HTMLButtonElement>();
  const activate = (level: 'basic' | 'advanced'): void => {
    selectedLevels.set(modelId, level);
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== level;
      const button = buttons.get(key)!;
      button.setAttribute('aria-selected', String(key === level));
      button.tabIndex = key === level ? 0 : -1;
    }
  };
  for (const [level, label] of [['basic', 'Basic settings'], ['advanced', 'Advanced settings']] as const) {
    const button = el('button', 'models-load-levels__tab', label);
    button.type = 'button';
    button.id = `modelsLoadTab-${level}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `modelsLoadPanel-${level}`);
    const panel = panels[level];
    panel.id = `modelsLoadPanel-${level}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    button.addEventListener('click', () => activate(level));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'basic' : event.key === 'End' ? 'advanced' : level === 'basic' ? 'advanced' : 'basic';
      activate(next);
      buttons.get(next)?.focus();
    });
    buttons.set(level, button);
    tabs.appendChild(button);
  }
  basic.appendChild(el('p', 'models-load-intro', 'Start with the defaults. Increase context only when you need more room for your conversation.'));
  advanced.appendChild(el('p', 'models-load-intro', 'Fine-tune the runtime. Leave a field at its default to let the engine choose.'));
  body.append(tabs, basic, advanced);
  activate(selectedLevels.get(modelId) ?? 'basic');
  return panels;
}
