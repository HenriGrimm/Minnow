import { iconHtml, type IconName } from '../icon';

export type BrainEmptyIcon = 'inbox' | 'search' | 'graph' | 'file' | 'sparkle' | 'offline';

const ICON_NAMES: Record<BrainEmptyIcon, IconName> = {
  inbox: 'inbox',
  search: 'search',
  graph: 'brainGraph',
  file: 'fileText',
  sparkle: 'sparkles',
  offline: 'brainLint',
};

export interface BrainEmptyStateOptions {
  icon?: BrainEmptyIcon;
  title: string;
  message: string;
  ctaLabel?: string;
  onCta?: () => void;
}

/** Render a framed empty state into a mount element. */
export function renderBrainEmptyState(
  mount: HTMLElement,
  options: BrainEmptyStateOptions,
): void {
  mount.replaceChildren();
  const block = document.createElement('div');
  block.className = 'brain-empty-state';

  const icon = document.createElement('div');
  icon.className = 'brain-empty-state__icon';
  icon.setAttribute('aria-hidden', 'true');
  const iconKey = options.icon ?? 'inbox';
  icon.innerHTML = iconHtml(ICON_NAMES[iconKey]);
  block.append(icon);

  const title = document.createElement('h3');
  title.className = 'brain-empty-state__title';
  title.textContent = options.title;
  block.append(title);

  const message = document.createElement('p');
  message.className = 'brain-empty-state__message';
  message.textContent = options.message;
  block.append(message);

  if (options.ctaLabel && options.onCta) {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'brain-action-btn is-primary';
    cta.textContent = options.ctaLabel;
    cta.addEventListener('click', options.onCta);
    block.append(cta);
  }

  mount.append(block);
}

/** Show a compact loading row with spinner. */
export function renderBrainLoading(mount: HTMLElement, message: string): void {
  mount.replaceChildren();
  const row = document.createElement('div');
  row.className = 'brain-loading';
  row.setAttribute('role', 'status');
  const spinner = document.createElement('span');
  spinner.className = 'brain-loading__spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = message;
  row.append(spinner, text);
  mount.append(row);
}
