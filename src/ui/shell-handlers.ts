import { fetchModels } from '../api/models';
import {
  closeDrawer,
  onDrawerKeydown,
  onSystemPromptInput,
  onSystemPromptPresetChange,
} from './settings';
import { clearChat } from './messages';
import { isAppAvailable } from '../os/app-preferences';
import { closeMobileSidebar, toggleSidebarLayout } from './layout';
import { closeFileSidebar, closeMobileFileSidebar, toggleFileSidebarLayout } from './file-layout';
import { createChat, onModelSelectChange } from './sidebar';
import { handleComposerPrimaryAction } from './input';
import { toggleStatsPanel } from './stats';

let shellHandlersBound = false;

/** Bind a click handler once per element (guards duplicate init). */
function wireClick(id: string, handler: () => void | Promise<void>): void {
  const el = document.getElementById(id);
  if (!el || el.dataset.shellWired === '1') return;
  el.dataset.shellWired = '1';
  el.addEventListener('click', () => {
    void handler();
  });
}

/** Bind the first matching selector (for duplicate new-chat buttons). */
function wireClickAll(selector: string, handler: () => void): void {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el.dataset.shellWired === '1') continue;
    el.dataset.shellWired = '1';
    el.addEventListener('click', handler);
  }
}

/** Replace legacy inline onclick/onchange/on* handlers on the static HTML shell. */
export function initShellHandlers(): void {
  if (shellHandlersBound) return;
  shellHandlersBound = true;

  wireClick('btnRefreshModels', () => fetchModels());

  const modelSelect = document.getElementById('modelSelect');
  if (modelSelect && modelSelect.dataset.shellWired !== '1') {
    modelSelect.dataset.shellWired = '1';
    modelSelect.addEventListener('change', onModelSelectChange);
  }

  wireClick('btnSidebarToggle', toggleSidebarLayout);
  wireClick('btnResearch', () => {
    void import('../research/panel').then((m) => m.openResearchFromTopbar());
  });
  wireClick('btnBenchmark', () => {
    if (!isAppAvailable('bench')) return;
    void import('../ui/benchmark-page').then((m) => m.openBenchmarkFromTopbar());
  });
  wireClick('btnExpertLab', () => {
    if (!isAppAvailable('experts')) return;
    void import('../ui/experts/experts-hub').then((m) => m.openExpertLabFromTopbar());
  });
  wireClick('btnSettings', () => {
    void import('./settings-page').then((m) => m.openSettingsFromTopbar());
  });

  wireClick('drawerExpertsLink', () => {
    void import('../ui/experts/experts-hub').then((m) => m.openExpertLabFromTopbar());
  });

  wireClick('drawerOverlay', closeDrawer);
  const drawer = document.getElementById('drawer');
  if (drawer && drawer.dataset.shellWired !== '1') {
    drawer.dataset.shellWired = '1';
    drawer.addEventListener('keydown', onDrawerKeydown);
  }

  const systemPromptPreset = document.getElementById('systemPromptPreset');
  if (systemPromptPreset && systemPromptPreset.dataset.shellWired !== '1') {
    systemPromptPreset.dataset.shellWired = '1';
    systemPromptPreset.addEventListener('change', onSystemPromptPresetChange);
  }

  const systemPrompt = document.getElementById('systemPrompt');
  if (systemPrompt && systemPrompt.dataset.shellWired !== '1') {
    systemPrompt.dataset.shellWired = '1';
    systemPrompt.addEventListener('input', onSystemPromptInput);
  }

  const drawerClearBtn = document.querySelector<HTMLButtonElement>('.drawer-clear-btn');
  if (drawerClearBtn && drawerClearBtn.dataset.shellWired !== '1') {
    drawerClearBtn.dataset.shellWired = '1';
    drawerClearBtn.addEventListener('click', clearChat);
  }

  wireClick('sidebarBackdrop', closeMobileSidebar);
  wireClick('fileSidebarBackdrop', closeMobileFileSidebar);

  wireClick('btnChatSearch', () => {
    const btn = document.getElementById('btnChatSearch');
    if (!btn) return;
    void import('./chat-search-popover').then((m) => m.toggleChatSearchPopover(btn));
  });
  wireClickAll('.chat-new-wide', createChat);
  wireClick('btnOrchestrate', () => {
    void import('./orchestrate-hub').then((m) => m.toggleOrchestrateHubFromTopbar());
  });

  wireClick('sendBtn', handleComposerPrimaryAction);

  wireClick('statsExpandBtn', toggleStatsPanel);

  wireClick('btnFileSidebarCollapse', toggleFileSidebarLayout);
  wireClick('btnFileSidebarClose', closeFileSidebar);
  wireClick('btnPreviewToggle', () => {
    void import('./preview-panel').then((m) => m.togglePreviewPanel());
  });
}
