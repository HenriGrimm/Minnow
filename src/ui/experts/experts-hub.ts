import '../../styles/experts-hub.css';
import '../../styles/experts-summon.css';

import { createExpertFromDescription } from '../../chat/experts/create-expert';
import { buildExpertSeedValidationContext } from '../../chat/experts/seed-context';
import { resolveExpertChatSeed } from '../../chat/experts/runtime-profile';
import {
  deleteUserExpert,
  loadUserExpertForEdit,
  saveUserExpert,
} from '../../chat/experts/expert-user-ops';
import {
  getExpert,
  listExperts,
  syncExpertRegistryFromServer,
} from '../../chat/experts/registry';
import type { ExpertAccent, ExpertMeta } from '../../chat/experts/types';
import { EXPERT_ACCENT_VALUES } from '../../chat/experts/types';
import { isExpertsPageOpen, setExpertsPageOpen } from '../../app-state';
import { loadExpertsConfig, getExpertsConfigSync } from '../../config/experts-config';
import { normalizeModeId } from '../../chat/modes/types';
import { resolveEffectiveChatModelBinding } from '../default-model';
import {
  activateChatById,
  createExpertChatFromSeed,
  getActiveChat,
  getExpertChats,
  recordChatMessage,
  scheduleSaveSessions,
  sessionState,
} from '../../state/sessions';
import { getWorkspacePath } from '../../state/workspace';
import { closeBenchmark } from '../benchmark-page';
import { appConfirm } from '../app-dialog';
import { closeSettings } from '../settings-page';
import {
  isExpertScopeActive,
  openExpertChatInShell,
  teardownExpertScopeShell,
} from './experts-scope';
import { renderExpertDetailTabbed } from './experts-lab-detail';
import { isOsAppHash, isOsEmbedded } from '../../os/page-bridge';
import { launchApp, navigateToWorkspaces } from '../../os/router';
import { isAppAvailable } from '../../os/app-preferences';

export { openExpertChatInShell } from './experts-scope';

export type ExpertsHubStep = 'browse' | 'create' | 'edit';

/** @deprecated Use browse */
export type LegacyExpertsHubStep = 'gallery' | 'chats';

let currentStep: ExpertsHubStep = 'browse';
let selectedExpertId: string | null = null;
let savedActiveChatId: string | null = null;
let createInFlight = false;
let editExpertId: string | null = null;
let editFullBody = '';
let editDirty = false;
let summonAbort: AbortController | null = null;
let detailTab: 'overview' | 'runtime' | 'memory' | 'chats' = 'overview';

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getRoot(): HTMLElement | null {
  return document.getElementById('expertsView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function expertIcon(meta: ExpertMeta): string {
  const icon = meta.icon?.trim();
  return icon || meta.label.charAt(0).toUpperCase();
}

function expertAccent(meta: ExpertMeta): ExpertAccent {
  return meta.accent ?? 'sage';
}

function accentClassName(accent: ExpertAccent): string {
  return `expert-accent-${accent}`;
}

function hueClassForIndex(index: number): string {
  return `hue-${(index % 4) + 1}`;
}

function applyAccentToElement(el: HTMLElement, accent: ExpertAccent): void {
  el.classList.remove(
    'expert-accent-sage',
    'expert-accent-amber',
    'expert-accent-cyan',
    'expert-accent-coral',
    'expert-accent-violet',
    'expert-accent-rose',
  );
  el.classList.add(accentClassName(accent));
}

function setStep(step: ExpertsHubStep): void {
  currentStep = step;
  const root = getRoot();
  if (root) root.dataset.step = step;
}

function normalizeOpenStep(
  step?: ExpertsHubStep | LegacyExpertsHubStep | 'gallery' | 'chats',
): ExpertsHubStep {
  if (step === 'gallery' || step === 'chats') return 'browse';
  return step ?? 'browse';
}

function setFormError(elementId: string, message: string | null): void {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function promptPreviewForExpert(expertId: string): string {
  const expert = getExpert(expertId);
  if (!expert) return '';
  const body = expert.fullBody.trim();
  if (body.length <= 1200) return body;
  return `${body.slice(0, 1200).trimEnd()}…`;
}

function runtimeModelLabel(expertId: string): string {
  const config = getExpertsConfigSync();
  const profile = config.profiles[expertId];
  if (profile?.modelId?.trim()) {
    const provider = profile.providerId?.trim();
    return provider
      ? `${provider} / ${profile.modelId.trim()}`
      : profile.modelId.trim();
  }
  const binding = resolveEffectiveChatModelBinding(getActiveChat());
  if (binding.modelId) {
    return binding.providerId
      ? `${binding.providerId} / ${binding.modelId}`
      : binding.modelId;
  }
  return 'Inherits active chat model';
}

/** Left roster column — selectable expert cards. */
function renderExpertList(): void {
  const list = document.getElementById('expertsList');
  if (!list) return;
  list.replaceChildren();

  const experts = listExperts();
  if (experts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'experts-chat-empty';
    empty.textContent = 'No experts yet. Use New expert to create one.';
    list.appendChild(empty);
    return;
  }

  experts.forEach((expert, index) => {
    const accent = expertAccent(expert.meta);
    const chatCount = getExpertChats(expert.meta.id).length;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `experts-card ${accentClassName(accent)}`;
    card.classList.toggle('on', expert.meta.id === selectedExpertId);
    card.dataset.expertId = expert.meta.id;
    card.setAttribute('role', 'listitem');

    const ava = document.createElement('span');
    ava.className = `experts-card-ava ${hueClassForIndex(index)}`;
    ava.textContent = expertIcon(expert.meta);
    ava.setAttribute('aria-hidden', 'true');
    applyAccentToElement(ava, accent);

    const meta = document.createElement('div');
    meta.className = 'experts-card-meta';

    const label = document.createElement('b');
    label.textContent = expert.meta.label;

    const role = document.createElement('i');
    role.textContent = expert.meta.description ?? expert.meta.tagline ?? 'Expert persona';

    meta.appendChild(label);
    meta.appendChild(role);
    card.appendChild(ava);
    card.appendChild(meta);

    if (chatCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'experts-card-badge';
      badge.textContent = String(chatCount);
      badge.setAttribute('aria-label', `${chatCount} chat${chatCount === 1 ? '' : 's'}`);
      card.appendChild(badge);
    }

    card.addEventListener('click', () => selectExpert(expert.meta.id));
    list.appendChild(card);
  });

  if (!selectedExpertId && experts[0]) {
    selectExpert(experts[0].meta.id, { skipListRender: true });
    renderExpertList();
  }
}

/** Right detail column for the selected expert. */
function renderExpertDetail(): void {
  showExpertsActionError(null);
  if (!selectedExpertId) {
    const mount = document.getElementById('expertsDetailMount');
    mount?.replaceChildren();
    return;
  }

  renderExpertDetailTabbed({
    selectedExpertId,
    detailTab,
    setDetailTab: (tab) => {
      detailTab = tab;
    },
    expertIcon,
    expertAccent,
    accentClassName,
    hueClassForIndex,
    applyAccentToElement,
    promptPreviewForExpert,
    runtimeModelLabel,
    onStartChat: () => {
      void startExpertChat(selectedExpertId!);
    },
    onEdit: () => {
      void openEditExpertStep(selectedExpertId!);
    },
    onDelete: () => {
      void (async () => {
        const expert = getExpert(selectedExpertId!);
        const label = expert?.meta.label ?? selectedExpertId;
        if (
          !(await appConfirm(`Delete "${label}"? This cannot be undone.`, {
            confirmLabel: 'Delete',
            danger: true,
          }))
        ) {
          return;
        }
        await deleteExpertConfirmed(selectedExpertId!);
      })();
    },
    onOpenChat: (chat) => {
      void openExpertChatInShell(chat);
    },
    onRefresh: () => renderExpertDetail(),
  });
}

function selectExpert(expertId: string, options?: { skipListRender?: boolean }): void {
  selectedExpertId = expertId;
  if (!options?.skipListRender) {
    document.querySelectorAll('.experts-card').forEach((card) => {
      const el = card as HTMLElement;
      el.classList.toggle('on', el.dataset.expertId === expertId);
    });
  }
  if (currentStep === 'browse') {
    renderExpertDetail();
  }
}

/** Refresh roster + detail (exported for settings toggle). */
export function renderGallery(): void {
  renderExpertList();
  renderExpertDetail();
}

export function openExpertDetail(expertId: string): void {
  selectedExpertId = expertId;
  setStep('browse');
  renderGallery();
}

export function renderExpertChatList(expertId: string): void {
  selectedExpertId = expertId;
  renderExpertDetail();
}

function showExpertsSummon(expertId: string): void {
  const overlay = document.getElementById('expertsSummon');
  const expert = getExpert(expertId);
  if (!overlay || !expert) return;

  const iconEl = document.getElementById('expertsSummonIcon');
  const labelEl = document.getElementById('expertsSummonLabel');
  if (iconEl) {
    iconEl.textContent = expertIcon(expert.meta);
    applyAccentToElement(iconEl, expertAccent(expert.meta));
  }
  if (labelEl) labelEl.textContent = expert.meta.label;

  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => overlay.classList.add('is-visible'));
}

function hideExpertsSummon(): void {
  const overlay = document.getElementById('expertsSummon');
  if (!overlay) return;
  overlay.classList.remove('is-visible');
  overlay.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => {
    overlay.classList.add('hidden');
  }, 280);
}

/** Create expert chat with authored greeting and open scoped chat shell. */
export async function startExpertChat(expertId: string): Promise<void> {
  showExpertsActionError(null);
  const sourceChat = getActiveChat();
  const binding = resolveEffectiveChatModelBinding(sourceChat);
  let chatsWorkspace = getWorkspacePath();

  const source = {
    providerId: sourceChat.providerId?.trim() || binding.providerId,
    modelId: sourceChat.modelId?.trim() || binding.modelId,
    modeId: normalizeModeId(sourceChat.modeId),
    workspacePath: chatsWorkspace,
  };

  const expertsConfig = await loadExpertsConfig();
  const validation = buildExpertSeedValidationContext();
  const seedResult = resolveExpertChatSeed(
    expertId,
    source,
    expertsConfig,
    validation,
  );
  if ('error' in seedResult) {
    showExpertsActionError(seedResult.error);
    return;
  }

  const transitionMs = prefersReducedMotion() ? 0 : 200;
  showExpertsSummon(expertId);

  if (transitionMs > 0) {
    await new Promise<void>((resolve) => {
      summonAbort?.abort();
      summonAbort = new AbortController();
      const signal = summonAbort.signal;
      const timer = window.setTimeout(resolve, transitionMs);
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      });
    });
    if (summonAbort?.signal.aborted) return;
  }

  try {
    const chat = createExpertChatFromSeed(seedResult);
    await activateChatById(chat.id);
    recordChatMessage(chat);
    scheduleSaveSessions();
    hideExpertsSummon();
    await openExpertChatInShell(chat);
  } catch (err) {
    hideExpertsSummon();
    const message = err instanceof Error ? err.message : String(err);
    showExpertsActionError(message || 'Could not start expert chat.');
  }
}

/** Leave expert-scoped shell and return to the hub detail pane. */
export function returnToExpertsHub(): void {
  const expertId = selectedExpertId;
  teardownExpertScopeShell();
  if (isOsEmbedded()) {
    launchApp('experts', expertId ? { expertId } : undefined);
    return;
  }
  if (expertId) {
    openExperts({ step: 'browse', expertId });
  } else {
    openExperts();
  }
}

function openCreateExpertStep(): void {
  setFormError('expertsCreateError', null);
  const input = document.getElementById('expertsCreateInput') as HTMLTextAreaElement | null;
  if (input) {
    input.value = '';
    input.disabled = false;
  }
  setStep('create');
  input?.focus();
}

async function submitCreateExpert(): Promise<void> {
  if (createInFlight) return;
  const input = document.getElementById('expertsCreateInput') as HTMLTextAreaElement | null;
  const description = input?.value.trim() ?? '';
  if (!description) {
    setFormError('expertsCreateError', 'Describe the expert you want to create.');
    return;
  }

  createInFlight = true;
  setFormError('expertsCreateError', null);
  const createBtn = document.getElementById('btnExpertsCreate');
  if (createBtn instanceof HTMLButtonElement) createBtn.disabled = true;
  if (input) input.disabled = true;

  try {
    const result = await createExpertFromDescription({ description });
    selectedExpertId = result.expertId;
    setStep('browse');
    renderGallery();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setFormError('expertsCreateError', message);
  } finally {
    createInFlight = false;
    if (createBtn instanceof HTMLButtonElement) createBtn.disabled = false;
    if (input) input.disabled = false;
  }
}

function syncEditBodyField(): void {
  const bodyInput = document.getElementById('expertsEditBody') as HTMLTextAreaElement | null;
  if (!bodyInput) return;
  bodyInput.value = editFullBody;
}

function markEditDirty(): void {
  editDirty = true;
}

async function openEditExpertStep(expertId: string): Promise<void> {
  const loaded = await loadUserExpertForEdit(expertId);
  if (!loaded) {
    setStep('edit');
    setFormError(
      'expertsEditError',
      'Could not load this expert. Open Minnow if the app is not running locally.',
    );
    return;
  }

  editExpertId = expertId;
  editFullBody = loaded.fullBody;
  editDirty = false;

  const labelInput = document.getElementById('expertsEditLabel') as HTMLInputElement | null;
  const descInput = document.getElementById('expertsEditDescription') as HTMLInputElement | null;
  const iconInput = document.getElementById('expertsEditIcon') as HTMLInputElement | null;
  const accentSelect = document.getElementById('expertsEditAccent') as HTMLSelectElement | null;

  const taglineInput = document.getElementById('expertsEditTagline') as HTMLInputElement | null;
  const greetingInput = document.getElementById('expertsEditGreeting') as HTMLInputElement | null;

  if (labelInput) labelInput.value = loaded.meta.label;
  if (descInput) descInput.value = loaded.meta.description ?? '';
  if (iconInput) iconInput.value = loaded.meta.icon ?? '';
  if (taglineInput) taglineInput.value = loaded.meta.tagline ?? '';
  if (greetingInput) greetingInput.value = loaded.meta.greeting ?? '';
  if (accentSelect) {
    accentSelect.replaceChildren();
    for (const accent of EXPERT_ACCENT_VALUES) {
      const opt = document.createElement('option');
      opt.value = accent;
      opt.textContent = accent.charAt(0).toUpperCase() + accent.slice(1);
      if (accent === (loaded.meta.accent ?? 'sage')) opt.selected = true;
      accentSelect.appendChild(opt);
    }
  }


  setFormError('expertsEditError', null);
  syncEditBodyField();
  setStep('edit');
  labelInput?.focus();
}

async function submitEditExpert(event?: Event): Promise<void> {
  event?.preventDefault();
  if (!editExpertId) return;

  const labelInput = document.getElementById('expertsEditLabel') as HTMLInputElement | null;
  const descInput = document.getElementById('expertsEditDescription') as HTMLInputElement | null;
  const iconInput = document.getElementById('expertsEditIcon') as HTMLInputElement | null;
  const accentSelect = document.getElementById('expertsEditAccent') as HTMLSelectElement | null;
  const taglineInput = document.getElementById('expertsEditTagline') as HTMLInputElement | null;
  const greetingInput = document.getElementById('expertsEditGreeting') as HTMLInputElement | null;
  const bodyInput = document.getElementById('expertsEditBody') as HTMLTextAreaElement | null;

  editFullBody = bodyInput?.value ?? editFullBody;

  const saveBtn = document.getElementById('btnExpertsEditSave');
  if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
  setFormError('expertsEditError', null);

  try {
    await saveUserExpert({
      id: editExpertId,
      label: labelInput?.value.trim() || editExpertId,
      description: descInput?.value.trim(),
      icon: iconInput?.value.trim(),
      accent: (accentSelect?.value as ExpertAccent) || 'sage',
      tagline: taglineInput?.value.trim(),
      greeting: greetingInput?.value.trim(),
      fullBody: editFullBody,
    });
    const savedId = editExpertId;
    editExpertId = null;
    editDirty = false;
    selectedExpertId = savedId;
    setStep('browse');
    renderGallery();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setFormError('expertsEditError', message);
  } finally {
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
  }
}

function cancelEditExpert(): void {
  void (async () => {
    if (editDirty && !(await appConfirm('Discard unsaved changes?'))) return;
    editExpertId = null;
    editDirty = false;
    setFormError('expertsEditError', null);
    setStep('browse');
  })();
}

function showExpertsActionError(message: string | null): void {
  setFormError('expertsActionError', message);
}

async function deleteExpertConfirmed(expertId: string): Promise<void> {
  showExpertsActionError(null);
  try {
    await deleteUserExpert(expertId);
    if (selectedExpertId === expertId) selectedExpertId = null;
    renderGallery();
    setStep('browse');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showExpertsActionError(message);
  }
}

export async function refreshExpertsEnabledState(): Promise<void> {
  const { refreshExpertsEnabledState: refresh } = await import('../experts-settings');
  await refresh();
}

export { isExpertsPageOpen };

/** Drop the pre-hub chat id so deferred hub teardown cannot restore it over an expert thread. */
export function abandonExpertsHubSavedChat(): void {
  savedActiveChatId = null;
}

/** Hide Experts' Lab UI only — no session restore or expert-scope teardown (desktop chat handoff). */
export function dismissExpertsHubUi(): void {
  const root = getRoot();
  if (!root) return;

  summonAbort?.abort();
  summonAbort = null;
  hideExpertsSummon();
  setExpertsPageOpen(false);
  root.classList.remove('is-open');
}

export function closeExpertsHub(options?: { skipNavigate?: boolean }): void {
  const root = getRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  summonAbort?.abort();
  summonAbort = null;
  hideExpertsSummon();

  setExpertsPageOpen(false);
  root.classList.remove('is-open');
  if (!isOsEmbedded()) {
    shell.classList.remove('hidden');
    document.querySelector('header.topbar')?.classList.remove('hidden');
    if (!options?.skipNavigate && window.location.hash.startsWith('#/experts')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    navigateToWorkspaces();
  }
  void import('../preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  const activeChat = sessionState ? getActiveChat() : null;
  const preserveActiveExpertChat = activeChat?.kind === 'expert';

  if (isExpertScopeActive() && !preserveActiveExpertChat) {
    teardownExpertScopeShell();
  }

  if (savedActiveChatId && sessionState && !preserveActiveExpertChat) {
    const prev = savedActiveChatId;
    savedActiveChatId = null;
    if (sessionState.chats.some((c) => c.id === prev)) {
      void activateChatById(prev).then(() => {
        void import('../sidebar').then((m) => m.renderSidebar());
        const chat = sessionState?.chats.find((c) => c.id === prev);
        if (chat) {
          void import('../messages').then((mod) => {
            mod.renderChatFromHistory(chat);
            mod.renderStatsForChat(chat);
          });
        }
      });
    }
  } else if (preserveActiveExpertChat) {
    savedActiveChatId = null;
  }

  setStep('browse');
  if (!preserveActiveExpertChat) {
    selectedExpertId = null;
  }
  editExpertId = null;
  editDirty = false;
}

export interface OpenExpertsOptions {
  step?: ExpertsHubStep | LegacyExpertsHubStep;
  expertId?: string;
}

/** Open Experts' Lab (`#/experts` / `#/app/experts`). */
export function openExperts(options?: OpenExpertsOptions): void {
  if (!isAppAvailable('experts')) {
    return;
  }
  const root = getRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  closeSettings({ skipNavigate: true });
  closeBenchmark({ skipNavigate: true });
  void import('../welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) m.closeWelcome({ skipHash: true });
  });

  if (isExpertScopeActive()) {
    teardownExpertScopeShell();
  }

  if (!savedActiveChatId && sessionState?.activeId) {
    savedActiveChatId = sessionState.activeId;
  }

  setExpertsPageOpen(true);
  root.classList.add('is-open');
  if (!isOsEmbedded()) {
    shell.classList.add('hidden');
    document.querySelector('header.topbar')?.classList.add('hidden');
    document.getElementById('drawer')?.setAttribute('aria-hidden', 'true');
    const nextHash = '#/experts';
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }
  void import('../preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  void refreshExpertsEnabledState();

  const step = normalizeOpenStep(options?.step);
  if (options?.expertId) {
    selectedExpertId = options.expertId;
  }
  setStep(step);
  if (step === 'browse') {
    renderGallery();
  }
}

export function openExpertLabFromTopbar(): void {
  if (isOsEmbedded()) {
    launchApp('experts', { openLab: true });
    return;
  }
  openExperts();
}

/** @deprecated Use openExperts */
export function openExpertLab(): void {
  openExperts();
}

/** @deprecated Use closeExpertsHub */
export function closeExpertLab(): void {
  closeExpertsHub();
}

/** @deprecated Use refreshExpertsEnabledState */
export async function refreshExpertLabEnabledState(): Promise<void> {
  return refreshExpertsEnabledState();
}

let staticBindingsDone = false;

function bindStaticControls(): void {
  if (staticBindingsDone) return;
  staticBindingsDone = true;

  document.getElementById('btnExpertsNew')?.addEventListener('click', () => {
    openCreateExpertStep();
  });

  document.getElementById('btnExpertsCreateCancel')?.addEventListener('click', () => {
    setStep('browse');
  });

  document.getElementById('btnExpertsCreate')?.addEventListener('click', () => {
    void submitCreateExpert();
  });

  document.getElementById('btnExpertsEditCancel')?.addEventListener('click', () => {
    cancelEditExpert();
  });

  document.getElementById('expertsEditForm')?.addEventListener('submit', (e) => {
    void submitEditExpert(e);
  });

  document.getElementById('expertsEditLabel')?.addEventListener('input', markEditDirty);
  document.getElementById('expertsEditDescription')?.addEventListener('input', markEditDirty);
  document.getElementById('expertsEditIcon')?.addEventListener('input', markEditDirty);
  document.getElementById('expertsEditAccent')?.addEventListener('change', markEditDirty);

  document.getElementById('expertsEditBody')?.addEventListener('input', markEditDirty);

  document.getElementById('btnExpertScopeBack')?.addEventListener('click', () => {
    returnToExpertsHub();
  });

  document.getElementById('btnExpertScopeNewChat')?.addEventListener('click', () => {
    const scopeId = selectedExpertId;
    if (scopeId) void startExpertChat(scopeId);
  });
}

function isEmbeddedDesktopHash(hash: string): boolean {
  return hash === '#/' || hash === '#' || hash === '#/desktop' || isOsAppHash(hash);
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/experts') || hash.startsWith('#/app/experts')) {
    launchApp('experts');
    return;
  }
  if (isOsEmbedded() && isEmbeddedDesktopHash(hash)) return;
  if (isExpertsPageOpen()) {
    closeExpertsHub();
  }
}

export function initExpertsHub(): void {
  bindStaticControls();
  window.addEventListener('hashchange', onHashChange);
  if (
    window.location.hash.startsWith('#/experts') ||
    window.location.hash.startsWith('#/app/experts')
  ) {
    launchApp('experts');
  }
}
