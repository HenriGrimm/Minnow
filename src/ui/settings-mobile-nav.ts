import { isPhoneLayout, onPhoneLayoutChange } from './mobile-layout';

const SECTION_OPEN_CLASS = 'settings-page--phone-section';
const BAR_ID = 'settingsPhoneBar';

let installed = false;

function getRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.settings-page');
}

/** Label of the section the sidebar currently marks as active. */
function activeSectionLabel(): string {
  const active = document.querySelector<HTMLElement>(
    '.settings-nav__item.is-active, .settings-nav__item[aria-current="page"]',
  );
  return active?.querySelector('.settings-nav__item-label')?.textContent?.trim() || 'Settings';
}

function closeSection(): void {
  getRoot()?.classList.remove(SECTION_OPEN_CLASS);
}

function openSection(): void {
  const root = getRoot();
  if (!root) return;
  root.classList.add(SECTION_OPEN_CLASS);
  const title = document.getElementById(`${BAR_ID}Title`);
  if (title) title.textContent = activeSectionLabel();
  root.querySelector('.settings-content')?.scrollTo({ top: 0 });
}

/**
 * Deep links (`#/settings/watchdog`, "Settings → Agents" links) name a section, so
 * on a phone they should land on it rather than on the section list.
 */
export function openSettingsPhoneSection(): void {
  if (!isPhoneLayout()) return;
  openSection();
}

/** Build the back bar once; it stays hidden until a section is open. */
function ensureBar(root: HTMLElement): void {
  if (document.getElementById(BAR_ID)) return;
  const body = root.querySelector('.settings-page-body');
  if (!body) return;

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.className = 'settings-phone-bar';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'settings-phone-bar__back';
  back.setAttribute('aria-label', 'All settings');
  back.innerHTML = '<i class="fi fi-rr-arrow-left icon-svg" aria-hidden="true"></i>';
  back.addEventListener('click', closeSection);

  const title = document.createElement('span');
  title.id = `${BAR_ID}Title`;
  title.className = 'settings-phone-bar__title';

  bar.append(back, title);
  body.prepend(bar);
}

/** Wire the phone drill-down. */
export function initSettingsMobileNav(): void {
  const root = getRoot();
  if (!root) return;
  ensureBar(root);

  if (installed) {
    if (!isPhoneLayout()) closeSection();
    return;
  }
  installed = true;

  root.addEventListener('click', (event) => {
    if (!isPhoneLayout()) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('[data-area-jump], [data-hub-jump]')) return;
    openSection();
  });

  onPhoneLayoutChange((phone) => {
    if (!phone) closeSection();
  });
}
