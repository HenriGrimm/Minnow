import { createButton, type ButtonSize, type ButtonVariant } from './button';
import { createCheckbox, createSelect, createTextarea, createTextInput } from './field';
import { attachTooltip } from './tooltip';
import { createTabs } from './tabs';
import { nextComponentId, type ComponentAppearance } from './internal';

export interface AdoptControlsOptions {
  appearance?: ComponentAppearance;
  size?: ButtonSize;
  variant?: ButtonVariant;
  variants?: Partial<Record<ButtonVariant, string>>;
}

/** A surface DOM builder can delegate control creation after assigning attributes. */
export function adoptControl<T extends HTMLElement>(element: T, options: AdoptControlsOptions = {}): T {
  if (!['BUTTON', 'SELECT', 'TEXTAREA'].includes(element.tagName)) return element;
  const classes = element.className;
  adoptControls(element, { size: 'sm', variant: /--(?:mn-)?danger/.test(classes) ? 'danger' : /--primary/.test(classes) ? 'primary' : /icon-(?:btn|button)|--ghost/.test(classes) ? 'ghost' : 'secondary', ...options });
  return element;
}

/** Build shared controls in a surface's static template, preserving nodes and bindings. */
export function adoptControls(root: ParentNode, options: AdoptControlsOptions = {}): void {
  const elements = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea')];
  if ('matches' in root && typeof root.matches === 'function' && root.matches('button, input, select, textarea')) elements.unshift(root as HTMLElement);
  for (const element of elements) {
    if (element.matches('.mn-btn, .mn-input, .mn-select, .mn-checkbox__input, .mn-switch__input, [role="tab"], [role="radio"]')) continue;
    if (element.tagName === 'BUTTON') {
      const button = element as HTMLButtonElement;
      const size = button.dataset.mnSize;
      const variant = button.dataset.mnVariant;
      const title = button.getAttribute('title');
      const mappedVariant = (['danger', 'primary', 'ghost', 'secondary'] as const).find((name) => {
        const selector = options.variants?.[name];
        return selector && button.matches(selector);
      });
      createButton({
        appearance: options.appearance,
        element: button,
        size: size === 'sm' || size === 'md' || size === 'lg' ? size : options.size,
        variant: variant === 'primary' || variant === 'secondary' || variant === 'ghost' || variant === 'danger' ? variant : mappedVariant ?? options.variant,
      });
      if (!button.textContent?.trim() && (button.getAttribute('aria-label') || title)) {
        button.classList.add('mn-btn--icon');
        if (!button.hasAttribute('aria-label') && title) button.setAttribute('aria-label', title);
        attachTooltip(button, title || button.getAttribute('aria-label')!);
      } else if (title) attachTooltip(button, title);
    } else if (element.tagName === 'SELECT') {
      createSelect({ element: element as HTMLSelectElement, appearance: options.appearance });
    } else if (element.tagName === 'TEXTAREA') {
      createTextarea({ element: element as HTMLTextAreaElement, appearance: options.appearance });
    } else {
      const input = element as HTMLInputElement;
      if (input.type === 'checkbox') {
        const hasLabel = Boolean(input.closest('label'));
        const home = document.createComment('checkbox');
        input.before(home);
        const checkbox = createCheckbox({ element: input, label: input.getAttribute('aria-label') ?? '', appearance: options.appearance });
        if (!hasLabel && home.parentNode) home.replaceWith(checkbox.root);
        else home.remove();
      } else if (['text', 'search', 'email', 'url', 'password', 'number', 'tel'].includes(input.type)) {
        createTextInput({ element: input, appearance: options.appearance });
      }
    }
  }
  adoptTabs(root, options);
}

/** Attach the shared tab keyboard model to a surface's existing tab chrome. */
export function adoptTabs(root: ParentNode, options: Pick<AdoptControlsOptions, 'appearance'> = {}): void {
  const lists = [...root.querySelectorAll<HTMLElement>('[role="tablist"]')];
  if ('matches' in root && typeof root.matches === 'function' && root.matches('[role="tablist"]')) lists.unshift(root as HTMLElement);
  for (const list of lists) {
    if (list.closest('.mn-tabs') && !list.classList.contains('mn-tabs--flat')) continue;
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((tab) => tab.closest('[role="tablist"]') === list);
    if (!tabs.length) continue;
    const specs = tabs.map((element) => ({ element, id: element.dataset.tabId || element.id || nextComponentId('tab'), label: element.textContent?.trim() ?? '', disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' }));
    const selected = specs.find(({ element }) => element.getAttribute('aria-selected') === 'true');
    createTabs({
      appearance: options.appearance,
      element: list as HTMLDivElement, list: list as HTMLDivElement,
      tabs: specs, selected: selected?.id,
      ariaLabel: list.getAttribute('aria-label') || 'Views', variant: 'underline',
      onChange: (id, source) => { if (source !== 'click') specs.find((tab) => tab.id === id)?.element.click(); },
    });
  }
}
