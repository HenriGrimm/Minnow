/**
 * A phone paired on the home-network address can move to the Anywhere address
 * in one tap once the host turns it on. Its sign-in travels with a handoff
 * ticket; nothing has to be approved again.
 */

import { createHandoffTicket } from '../api/device-auth.ts';
import { isInstalledPwa } from '../api/pwa-context.ts';

const DISMISSED_KEY = 'minnow.companion.moveDismissed';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function isDismissed(): boolean {
  try { return window.localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
}

/** Offer the move when this page is on the home-network address and Anywhere is ready. */
export async function maybeOfferMove(): Promise<boolean> {
  if (window.location.protocol !== 'http:' || isDismissed()) return false;
  let anywhereUrl: string | null = null;
  try {
    const response = await fetch('/api/remote/status', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return false;
    anywhereUrl = ((await response.json()) as { anywhereUrl?: string | null }).anywhereUrl ?? null;
  } catch {
    return false;
  }
  if (!anywhereUrl || document.getElementById('companionMovePrompt')) return false;

  const banner = el('section', 'companion-move');
  banner.id = 'companionMovePrompt';
  banner.setAttribute('aria-labelledby', 'companionMoveTitle');
  const heading = el('strong', 'companion-move__title', 'Use Minnow away from home');
  heading.id = 'companionMoveTitle';
  const copy = el(
    'p',
    'companion-move__copy',
    isInstalledPwa()
      ? 'Switch this device to your Anywhere address. Then add Minnow to your Home Screen again from there.'
      : 'Switch this device to your Anywhere address. It works on Wi-Fi and mobile data.',
  );
  const actions = el('div', 'companion-move__actions');
  const later = el('button', 'companion-access__btn companion-access__btn--secondary', 'Not now');
  later.type = 'button';
  const go = el('button', 'companion-access__btn companion-access__btn--primary', 'Switch');
  go.type = 'button';
  later.addEventListener('click', () => {
    try { window.localStorage.setItem(DISMISSED_KEY, '1'); } catch {}
    banner.remove();
  });
  go.addEventListener('click', () => {
    go.disabled = true;
    void createHandoffTicket('move')
      .then((ticket) => {
        const target = new URL(anywhereUrl as string);
        target.pathname = '/';
        target.search = `?handoff=${encodeURIComponent(ticket)}`;
        window.location.href = target.toString();
      })
      .catch(() => {
        go.disabled = false;
        copy.textContent = "Couldn't prepare the switch. Try again in a moment.";
      });
  });
  actions.append(later, go);
  banner.append(heading, copy, actions);
  document.body.appendChild(banner);
  return true;
}
