import { buildLineDiff, promptsMatchForDiff } from '../chat/prompts/text-diff';
import { isLocalServerAvailable } from '../tools/config';
import { appConfirm } from './app-dialog';
import {
  renderSideBySidePromptDiff,
  renderUnifiedPromptDiff,
} from './prompt-diff-unified';
import { createSettingsSwitch } from './settings-switch';

export type PromptDiffLayout = 'unified' | 'side-by-side';

const LAYOUT_STORAGE_KEY = 'minnow.promptDiffLayout';

export function getPromptDiffLayout(): PromptDiffLayout {
  try {
    const v = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (v === 'side-by-side') return 'side-by-side';
  } catch {
  }
  return 'unified';
}

export function setPromptDiffLayout(layout: PromptDiffLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  } catch {
  }
}

export interface PromptDiffPanelOptions {
  getBaseline: () => string;
  getCurrent: () => string;
  /** When true, show offline baseline hint (bundled builtin may differ from disk). */
  showOfflineHint?: boolean;
  onResetPart?: () => void | Promise<void>;
  resetPartLabel?: string;
}

export interface PromptDiffControls {
  refresh: () => void;
  setBaseline: (text: string) => void;
  toolbar: HTMLElement;
  panelHost: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount compare toggle, layout switch, optional per-part reset, and diff panel.
 */
export function mountPromptDiffControls(
  container: HTMLElement,
  options: PromptDiffPanelOptions,
): PromptDiffControls {
  let baselineText = options.getBaseline();
  let compareOpen = false;
  let layout: PromptDiffLayout = getPromptDiffLayout();

  const toolbar = el('div', 'prompt-diff-toolbar');
  const compareId = `prompt-diff-compare-${Math.random().toString(36).slice(2, 9)}`;
  const compareWrap = el('div', 'prompt-diff-toolbar__compare');
  const compareText = el('span', 'prompt-diff-toolbar__compare-label', 'Compare to shipped default');
  const { root: compareSwitch, input: compareCb } = createSettingsSwitch({
    id: compareId,
    ariaLabel: 'Compare to shipped default',
  });
  compareWrap.append(compareText, compareSwitch);

  const matchNote = el('span', 'prompt-diff-toolbar__match hidden', 'Matches shipped default');

  const layoutSel = document.createElement('select');
  layoutSel.className = 'settings-select prompt-diff-toolbar__layout';
  layoutSel.title = 'Diff layout';
  for (const [value, label] of [
    ['unified', 'Unified'],
    ['side-by-side', 'Side by side'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    layoutSel.appendChild(opt);
  }
  layoutSel.value = layout;
  layoutSel.classList.add('hidden');

  const offlineBanner = el(
    'p',
    'settings-field-hint prompt-diff__offline hidden',
    'Server offline — baseline from bundled shipped prompts; may differ from ~/.minnow on disk.',
  );


  const panelHost = el('div', 'prompt-diff-host hidden');
  panelHost.setAttribute('role', 'region');
  panelHost.setAttribute('aria-label', 'Prompt diff');

  let resetBtn: HTMLButtonElement | null = null;
  if (options.onResetPart) {
    resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'settings-action-btn';
    resetBtn.textContent = options.resetPartLabel ?? 'Reset part to default';
  }

  toolbar.appendChild(compareWrap);
  toolbar.appendChild(matchNote);
  toolbar.appendChild(layoutSel);
  if (resetBtn) toolbar.appendChild(resetBtn);

  container.appendChild(toolbar);
  if (options.showOfflineHint) container.appendChild(offlineBanner);
  container.appendChild(panelHost);

  const renderPanel = () => {
    panelHost.replaceChildren();
    const current = options.getCurrent();
    const baseline = baselineText;
    if (layout === 'side-by-side') {
      renderSideBySidePromptDiff(panelHost, baseline, current);
    } else {
      renderUnifiedPromptDiff(panelHost, buildLineDiff(baseline, current));
    }
  };

  const syncToolbarState = () => {
    const matches = promptsMatchForDiff(baselineText, options.getCurrent());
    matchNote.classList.toggle('hidden', !matches || compareOpen);
    compareCb.disabled = matches && !compareOpen;
    if (matches && compareOpen) {
      compareCb.checked = false;
      compareOpen = false;
      panelHost.classList.add('hidden');
      panelHost.setAttribute('aria-expanded', 'false');
      layoutSel.classList.add('hidden');
    }
    if (resetBtn) {
      resetBtn.disabled = matches;
    }
  };

  const refresh = () => {
    syncToolbarState();
    if (!compareOpen) return;
    renderPanel();
  };

  compareCb.addEventListener('change', () => {
    compareOpen = compareCb.checked;
    panelHost.classList.toggle('hidden', !compareOpen);
    panelHost.setAttribute('aria-expanded', compareOpen ? 'true' : 'false');
    layoutSel.classList.toggle('hidden', !compareOpen);
    matchNote.classList.toggle('hidden', compareOpen || promptsMatchForDiff(baselineText, options.getCurrent()));
    if (compareOpen) renderPanel();
  });

  layoutSel.addEventListener('change', () => {
    layout = layoutSel.value === 'side-by-side' ? 'side-by-side' : 'unified';
    setPromptDiffLayout(layout);
    if (compareOpen) renderPanel();
  });

  if (resetBtn && options.onResetPart) {
    resetBtn.addEventListener('click', () => {
      void (async () => {
        const dirty =
          options.getCurrent().trim() !== baselineText.trim() &&
          options.getCurrent().trim() !== '';
        if (
          dirty &&
          !(await appConfirm('Discard unsaved edits for this part and reset to shipped default?'))
        ) {
          return;
        }
        await options.onResetPart!();
        baselineText = options.getBaseline();
        refresh();
      })();
    });
  }

  void (async () => {
    const serverUp = await isLocalServerAvailable();
    if (options.showOfflineHint && !serverUp) {
      offlineBanner.classList.remove('hidden');
    }
  })();

  syncToolbarState();

  return {
    refresh,
    setBaseline: (text: string) => {
      baselineText = text;
      refresh();
    },
    toolbar,
    panelHost,
  };
}
