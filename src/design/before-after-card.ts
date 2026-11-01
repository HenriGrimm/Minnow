import { createButton, setButtonClassName } from '../ui/components';
/**
 * Before/after diff card (MIN-370 P1): a functional toggle between the pre-reload and
 * post-reload viewport crops for a design-linked chat turn. DOM-only — no store/network
 * coupling, mirrors overlay.ts/annotations-panel.ts's "host owns lifecycle, this owns its
 * subtree" pattern. Visual polish (swipe slider, etc.) is a later pass; a toggle button that
 * flips between the two images is the functional baseline.
 */
import type { BeforeAfterPair } from './before-after';

const ROOT_CLASS = 'mn-before-after-card';

function fileLabel(pair: BeforeAfterPair): string {
  if (pair.paths.length === 0) return 'preview diff';
  if (pair.paths.length === 1) return pair.paths[0]!;
  return `${pair.paths.length} files changed`;
}

/** Build a before/after diff card for one finalized pair. Caller mounts it into the transcript. */
export function renderBeforeAfterCard(pair: BeforeAfterPair): HTMLElement {
  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  root.dataset.pairId = pair.id;

  const header = document.createElement('div');
  header.className = `${ROOT_CLASS}__header`;
  header.textContent = fileLabel(pair);
  root.appendChild(header);

  const hasBefore = Boolean(pair.before?.dataUrl);
  const hasAfter = Boolean(pair.after?.dataUrl);
  let showingAfter = hasAfter;

  const img = document.createElement('img');
  img.className = `${ROOT_CLASS}__image`;
  img.alt = showingAfter ? 'After the change' : 'Before the change';
  img.src = (showingAfter ? pair.after?.dataUrl : pair.before?.dataUrl) ?? '';
  root.appendChild(img);

  const toggle = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  toggle.type = 'button';
  setButtonClassName(toggle, `${ROOT_CLASS}__toggle`);
  toggle.setAttribute('aria-pressed', String(showingAfter));

  function syncToggleLabel(): void {
    toggle.textContent = showingAfter ? 'After — click for before' : 'Before — click for after';
    toggle.setAttribute('aria-pressed', String(showingAfter));
    img.alt = showingAfter ? 'After the change' : 'Before the change';
  }
  syncToggleLabel();

  if (!hasBefore || !hasAfter) {
    toggle.disabled = true;
    toggle.title = !hasBefore && !hasAfter ? 'No captures available' : !hasBefore ? 'Before capture unavailable' : 'After capture unavailable';
  } else {
    toggle.addEventListener('click', () => {
      showingAfter = !showingAfter;
      img.src = (showingAfter ? pair.after?.dataUrl : pair.before?.dataUrl) ?? '';
      syncToggleLabel();
    });
  }
  root.appendChild(toggle);

  return root;
}
