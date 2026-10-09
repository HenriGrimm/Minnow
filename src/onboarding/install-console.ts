/**
 * Onboarding extras — scrollable install log (mono instrumentation panel).
 */

import { el } from './ui-helpers';

export type InstallLogLevel = 'info' | 'working' | 'ok' | 'err' | 'skip';

export interface InstallConsole {
  element: HTMLElement;
  log: (source: string, level: InstallLogLevel, text: string) => void;
  setHeadline: (text: string) => void;
  setProgress: (completed: number, total: number, failed: number) => void;
  show: () => void;
  hide: () => void;
  clear: () => void;
}

const MAX_LINES = 400;

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Build a live install log panel for the extras onboarding step. */
export function createInstallConsole(): InstallConsole {
  const root = el('section', 'mn-onboarding-install-console is-hidden');
  root.setAttribute('aria-label', 'Setup progress');

  const head = el('div', 'mn-onboarding-install-console__head');
  const title = el('span', 'mn-onboarding-install-console__title', 'Setting things up');
  const status = el('span', 'mn-onboarding-install-console__status', 'Waiting');
  status.setAttribute('role', 'status');
  head.append(title, status);

  const overview = el('div', 'mn-onboarding-install-console__overview');
  const progress = el('progress', 'mn-onboarding-install-progress');
  progress.setAttribute('aria-label', 'Extras completed');
  const count = el('p', 'mn-onboarding-muted');
  overview.append(progress, count);
  const details = el('details', 'mn-onboarding-install-console__details');
  details.appendChild(el('summary', undefined, 'Show technical details'));

  const body = el('div', 'mn-onboarding-install-console__body');
  body.setAttribute('role', 'log');
  details.appendChild(body);
  root.append(head, overview, details);

  const lastBySource = new Map<string, string>();
  const liveLines = new Map<string, HTMLElement>();
  let lineCount = 0;

  function scrollToEnd(): void {
    body.scrollTop = body.scrollHeight;
  }

  function trimOldLines(): void {
    while (lineCount > MAX_LINES) {
      const first = body.firstElementChild;
      if (!first) break;
      first.remove();
      lineCount -= 1;
    }
  }

  function clearLiveLine(source: string): void {
    const live = liveLines.get(source);
    if (!live) return;
    live.remove();
    liveLines.delete(source);
    lineCount = Math.max(0, lineCount - 1);
  }

  function upsertLiveLine(source: string, level: InstallLogLevel, text: string): void {
    let row = liveLines.get(source);
    if (!row) {
      row = el('div', `mn-onboarding-install-console__line is-${level} is-live`);
      row.appendChild(el('time', 'mn-onboarding-install-console__time', formatTime(new Date())));
      row.appendChild(el('span', 'mn-onboarding-install-console__source', source));
      row.appendChild(el('span', 'mn-onboarding-install-console__text', text));
      body.appendChild(row);
      liveLines.set(source, row);
      lineCount += 1;
      trimOldLines();
    } else {
      row.className = `mn-onboarding-install-console__line is-${level} is-live`;
      const textEl = row.querySelector('.mn-onboarding-install-console__text');
      if (textEl) textEl.textContent = text;
    }
    scrollToEnd();
  }

  function appendLine(source: string, level: InstallLogLevel, text: string): void {
    clearLiveLine(source);
    const row = el('div', `mn-onboarding-install-console__line is-${level}`);
    row.appendChild(el('time', 'mn-onboarding-install-console__time', formatTime(new Date())));
    row.appendChild(el('span', 'mn-onboarding-install-console__source', source));
    row.appendChild(el('span', 'mn-onboarding-install-console__text', text));
    body.appendChild(row);
    lineCount += 1;
    trimOldLines();
    scrollToEnd();
  }

  return {
    element: root,

    log(source, level, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (level === 'working') {
        if (lastBySource.get(source) === trimmed && liveLines.has(source)) return;
        lastBySource.set(source, trimmed);
        upsertLiveLine(source, level, trimmed);
        return;
      }
      lastBySource.set(source, trimmed);
      appendLine(source, level, trimmed);
    },

    setHeadline(text) {
      status.textContent = text;
      root.classList.toggle('is-busy', text === 'Installing…');
    },

    setProgress(completed, total, failed) {
      progress.max = Math.max(1, total);
      progress.value = completed + failed;
      count.textContent = `${completed} of ${total} ready${failed ? ` · ${failed} need attention` : ''}`;
    },

    show() {
      root.classList.remove('is-hidden');
    },

    hide() {
      root.classList.add('is-hidden');
    },

    clear() {
      body.textContent = '';
      lastBySource.clear();
      liveLines.clear();
      lineCount = 0;
      status.textContent = 'Waiting';
      progress.value = 0;
      count.textContent = '';
      root.classList.remove('is-busy');
    },
  };
}

/** Human label for each extras row id. */
export const EXTRA_LOG_SOURCE: Record<string, string> = {
  searxng: 'SearXNG',
  embeddings: 'Memory',
  voice: 'Voice',
  llama: 'llama.cpp',
};
