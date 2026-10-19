/**
 * One-time "Add Minnow to your Home Screen" sheet after a phone connects. The
 * installed app signs itself in (the host puts a handoff ticket in its start
 * URL), so the copy promises no code — and that promise is what this sheet is for.
 */

import { isInstalledPwa } from '../api/pwa-context.ts';

const PHONE_MEDIA = '(max-width: 1024px)';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

/** Capture Chromium's install prompt early so the sheet can offer one tap. */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
  });
}

export function isAppleTouchDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function step(index: number, text: string): HTMLLIElement {
  const item = el('li', 'companion-install__step');
  item.append(el('span', 'companion-install__step-index', String(index)), el('span', '', text));
  return item;
}

/**
 * Show the sheet if this is a phone/tablet browser tab that can install Minnow.
 * @returns whether it was shown
 */
export function maybeShowInstallGuide(opts: { justConnected: boolean }): boolean {
  if (!opts.justConnected || isInstalledPwa() || !window.matchMedia(PHONE_MEDIA).matches) return false;
  const apple = isAppleTouchDevice();
  if (!apple && !deferredPrompt) return false;

  const sheet = el('section', 'companion-install');
  sheet.id = 'companionInstallGuide';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-labelledby', 'companionInstallTitle');
  const heading = el('h2', 'companion-install__title', 'Add Minnow to your Home Screen');
  heading.id = 'companionInstallTitle';
  const copy = el('p', 'companion-install__copy', 'It opens like an app and signs itself in. No code needed.');
  sheet.append(el('p', 'companion-install__eyebrow', 'Connected'), heading, copy);

  const actions = el('div', 'companion-install__actions');
  const dismiss = el('button', 'companion-access__btn companion-access__btn--secondary', apple ? 'Got it' : 'Not now');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => sheet.remove());

  if (apple) {
    const steps = el('ol', 'companion-install__steps');
    steps.append(step(1, 'Tap Share in the toolbar'), step(2, 'Choose Add to Home Screen'), step(3, 'Open Minnow from your Home Screen'));
    sheet.append(steps);
    actions.append(dismiss);
  } else {
    const install = el('button', 'companion-access__btn companion-access__btn--primary', 'Install app');
    install.type = 'button';
    install.addEventListener('click', () => {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      sheet.remove();
      void prompt?.prompt();
    });
    actions.append(install, dismiss);
  }
  sheet.append(actions);
  document.body.appendChild(sheet);
  return true;
}
