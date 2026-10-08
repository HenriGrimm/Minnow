import '../styles/reef.css';
import { createIcon } from './icon';
import { appConfirm, appPrompt } from './app-dialog';
import { launchApp, getCurrentRoute } from '../os/router';
import { getForegroundAppId } from '../os/instances';
import { readDefaultModelBinding } from './default-model';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { isAgentCliProviderId } from '../models/runtime-ids.mjs';
import { closeModelSelectMenu, mountAuxiliaryModelSelectCombobox, syncAuxiliaryModelSelectCombobox } from './model-select-picker';
import { listReefApps, getReefApp, createReefApp, reefRequest, subscribeReef, exportReefApp } from '../reef/client';
import type { ReefApp, ReefRun } from '../reef/types';
import { mountReefChat } from './reef-chat';
import { mountReefAgentStream } from './reef-agent-stream';
import { mountReefOrb } from './reef-orb';
import { describeReefActivity } from '../reef/activity';
import { bindPreviewInstanceToElement, setPreviewInstanceVisible } from './preview-instance-host';

const terminal = new Set(['ready', 'failed', 'cancelled', 'interrupted']);
function recoveryLabel(app: ReefApp) {
  const state = app.runs.at(-1)?.state ?? app.status;
  return state === 'failed' ? 'Retry build' : state === 'cancelled' || state === 'interrupted' ? 'Resume build' : null;
}
let root: HTMLElement;
let createDraft = '';
let createPending = false;
let generation = 0;
let disposeEvents = () => {};
let disposePreview = () => {};
let disposeLiveStatus = () => {};
let disposeAgentStream = () => {};
let disposeModelPicker = () => {};
let disposeOrb = () => {};
/** Backstage panels stay as the viewer left them while they move around Reef. */
const backstageOpen = { agent: false, log: false };
const CHAT_OPEN_KEY = 'minnow.reef.chatOpen';
function readChatOpen() { try { return localStorage.getItem(CHAT_OPEN_KEY) === '1'; } catch { return false; } }
function writeChatOpen(open: boolean) { try { localStorage.setItem(CHAT_OPEN_KEY, open ? '1' : '0'); } catch { /* per-viewer convenience only */ } }
let chat: ReturnType<typeof mountReefChat> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let activePreview = '';
let previewImageUrl = '';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function button(label: string, action: () => void | Promise<void>, primary = false) {
  const node = element('button', label, primary ? 'reef-primary' : ''); node.type = 'button';
  node.addEventListener('click', () => {
    node.disabled = true;
    void Promise.resolve().then(action).catch(error => showError(errorText(error))).finally(() => { node.disabled = false; });
  });
  return node;
}
function showError(text: string) {
  const status = root.querySelector<HTMLElement>('.reef-error');
  if (status) { status.textContent = text; status.hidden = false; }
}
function navigate(id?: string) { launchApp('reef', id ? { reefAppId: id } : undefined); }
function reset() {
  disposeModelPicker(); disposeModelPicker = () => {};
  disposeAgentStream(); disposeAgentStream = () => {};
  disposeOrb(); disposeOrb = () => {};
  disposeLiveStatus(); disposeLiveStatus = () => {};
  disposeEvents(); disposeEvents = () => {};
  disposePreview(); disposePreview = () => {};
  if (activePreview) void window.minnow?.preview?.instances.destroy(activePreview);
  activePreview = '';
  if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
  previewImageUrl = '';
  chat?.dispose(); chat = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  root.replaceChildren();
  refreshTimer = undefined;
  const error = element('p', '', 'reef-error'); error.setAttribute('role', 'alert'); error.hidden = true; root.append(error);
}
export function initReefPage() {
  if (document.getElementById('reefView')) { root = document.getElementById('reefView')!; return; }
  root = element('section', '', 'mn-os-app-layer reef-page'); root.id = 'reefView'; root.dataset.osApp = 'reef';
  (document.getElementById('osAppsLayer') ?? document.body).append(root);
  window.addEventListener('hashchange', () => {
    if (getForegroundAppId() === 'reef') void openReef(getCurrentRoute().reefAppId);
  });
}
export function suspendReef() {
  disposeModelPicker(); disposeOrb(); disposeOrb = () => {};
  generation++; disposeEvents(); disposePreview(); disposeLiveStatus();
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  if (activePreview) setPreviewInstanceVisible(activePreview, false);
  root?.classList.remove('is-open');
}
export async function openReef(id?: string) {
  initReefPage(); const stamp = ++generation; reset(); root.classList.add('is-open');
  const creating = id === 'new';
  root.dataset.reefScreen = creating ? 'new' : id ? 'app' : 'store';
  const header = element('header', '', 'reef-header');
  const identity = element('div', '', 'reef-identity'); identity.append(createIcon('modeReef'), element('h1', 'Reef'));
  const navigation = element('nav', '', 'reef-navigation'); navigation.setAttribute('aria-label', 'Reef');
  const store = button('App store', () => navigate());
  const newApp = button('New app', () => navigate('new'), !creating);
  newApp.prepend(createIcon('plus'));
  if (!id) store.setAttribute('aria-current', 'page');
  if (creating) newApp.setAttribute('aria-current', 'page');
  navigation.append(store, newApp); header.append(identity, navigation); root.prepend(header);
  try { if (creating) showCreate(stamp); else if (id) await showDetail(id, stamp); else await showLibrary(stamp); }
  catch (error) { if (stamp === generation) showError(errorText(error)); }
}

function showCreate(stamp: number) {
  const body = element('main', '', 'reef-create-screen');
  const intro = element('div', '', 'reef-create-intro');
  intro.append(element('span', 'NEW APP', 'reef-eyebrow'), element('h2', 'A little app for your everyday.'), element('p', 'Describe what you need. Reef builds it, checks it, and saves it to your app store.'));
  const create = element('form', '', 'reef-create');
  const promptLabel = element('label', 'What should your app do?', 'reef-field-label'); promptLabel.htmlFor = 'reefPrompt';
  const prompt = element('textarea', '', 'reef-prompt'); prompt.id = 'reefPrompt'; prompt.rows = 6; prompt.maxLength = 16000; prompt.required = true; prompt.placeholder = 'For example, a dinner bill calculator that splits the total, adds a tip, and shows what each person owes.'; prompt.value = createDraft;
  prompt.addEventListener('input', () => { createDraft = prompt.value; });
  const controls = element('div', '', 'reef-create-controls');
  const submit = element('button', 'Build app', 'reef-primary'); submit.type = 'submit';
  controls.append(submit); create.append(promptLabel, prompt, controls);
  const hint = element('p', 'Start with one clear task. You can ask for changes after the first build.', 'reef-create-hint');
  const ideas = element('section', '', 'reef-ideas'); ideas.setAttribute('aria-label', 'App ideas');
  ideas.append(element('h3', 'Need a starting point?'));
  const examples = [
    ['Split a bill', 'Split a dinner bill between friends, with a tip percentage and a clear total for each person.'],
    ['Convert units', 'Convert between metric and imperial units for length, weight, and temperature.'],
    ['Focus timer', 'A focus timer with adjustable work and break sessions, and a sound when a session ends.'],
  ];
  for (const [label, description] of examples) {
    const idea = button(label, () => { prompt.value = description; createDraft = description; prompt.focus(); });
    idea.append(createIcon('chevronRight')); ideas.append(idea);
  }
  body.append(intro, create, hint, ideas); root.append(body);
  const updatePending = () => {
    for (const control of body.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea')) control.disabled = createPending;
    submit.textContent = createPending ? 'Checking prerequisites…' : 'Build app';
  };
  updatePending();
  create.addEventListener('submit', event => {
    event.preventDefault(); if (!prompt.value.trim() || createPending) return;
    const binding = readDefaultModelBinding();
    if (!binding.modelId) { showError('Choose a default model in the top bar before building your app.'); return; }
    createPending = true; updatePending();
    void createReefApp({ prompt: prompt.value.trim(), ...binding }).then(app => {
      createDraft = '';
      if (stamp === generation) navigate(app.id);
    }).catch(error => { if (stamp === generation) showError(errorText(error)); }).finally(() => {
      createPending = false;
      if (stamp === generation) updatePending();
      else if (root.dataset.reefScreen === 'new') void openReef('new');
    });
  });
}

async function showLibrary(stamp: number) {
  const body = element('main', '', 'reef-store-screen');
  const intro = element('div', '', 'reef-store-intro');
  intro.append(element('span', 'MADE FOR YOU', 'reef-eyebrow'), element('h2', 'Your app store'), element('p', 'The little tools you build, all in one place.'));
  const heading = element('div', '', 'reef-library-heading');
  const count = element('h3', 'Your apps'); heading.append(count);
  const tools = element('div', '', 'reef-library-tools');
  const searchField = element('div', '', 'reef-search'); searchField.append(createIcon('search'));
  const search = element('input'); search.type = 'search'; search.placeholder = 'Find an app'; search.setAttribute('aria-label', 'Search apps');
  searchField.append(search);
  const sort = element('select'); sort.setAttribute('aria-label', 'Sort apps');
  for (const [value, label] of [['recent', 'Recently updated'], ['name', 'Name: A to Z']]) { const option = element('option', label); option.value = value; sort.append(option); }
  tools.append(searchField, sort); heading.append(tools);
  const shelf = element('div', '', 'reef-library'); shelf.setAttribute('aria-label', 'Your apps');
  const results = element('p', '', 'reef-results'); results.setAttribute('role', 'status');
  body.append(intro, heading, results, shelf); root.append(body);
  shelf.append(element('p', 'Loading your apps…', 'reef-empty')); shelf.setAttribute('aria-busy', 'true');
  let apps: ReefApp[];
  try { apps = await listReefApps(); }
  catch (error) {
    if (stamp === generation) {
      shelf.removeAttribute('aria-busy');
      shelf.replaceChildren(button('Try again', () => openReef()));
    }
    throw error;
  }
  if (stamp !== generation) return;
  shelf.removeAttribute('aria-busy');
  const restarting = new Set<string>();
  const paint = () => {
    shelf.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const filtered = apps.filter(app => `${app.name} ${app.description}`.toLowerCase().includes(query)).sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt);
    count.textContent = `Your apps${apps.length ? ` · ${apps.length}` : ''}`;
    results.textContent = query ? `${filtered.length} ${filtered.length === 1 ? 'app' : 'apps'} found` : ''; results.hidden = !query;
    if (!filtered.length) {
      const empty = element('div', '', 'reef-empty');
      const mark = element('div', '', 'reef-empty-icon'); mark.append(createIcon(apps.length ? 'search' : 'grid')); mark.setAttribute('aria-hidden', 'true');
      empty.append(mark, element('h3', apps.length ? 'No apps found' : 'Make room for your first app'), element('p', apps.length ? 'Try a different name or description.' : 'A calculator, a converter, a timer. Make a tool that does just what you need.'));
      empty.append(apps.length ? button('Clear search', () => { search.value = ''; paint(); search.focus(); }) : button('Create an app', () => navigate('new'), true)); shelf.append(empty);
    }
    for (const app of filtered) {
      const row = element('article', '', 'reef-app');
      const icon = element('div', app.name.slice(0, 1).toUpperCase(), 'reef-app-icon'); icon.setAttribute('aria-hidden', 'true');
      const info = element('div', '', 'reef-app-info');
      const title = button(app.name, () => navigate(app.id)); title.classList.add('reef-app-name');
      info.append(title, element('p', app.description), element('span', app.status, 'reef-status'));
      const actions = element('div', '', 'reef-actions');
      const label = recoveryLabel(app);
      if (label) {
        const restart = button(label, async () => {
          if (restarting.has(app.id)) return;
          restarting.add(app.id); paint();
          try {
            const run = await reefRequest<ReefRun>(`apps/${app.id}/runs`, 'POST', { action: 'resume', runId: app.runs.at(-1)!.id });
            if (stamp !== generation) return;
            apps = apps.map(row => row.id === app.id ? { ...row, status: run.state, runs: row.runs.map(item => item.id === run.id ? run : item) } : row);
            navigate(app.id);
          } finally {
            restarting.delete(app.id);
            if (stamp === generation) paint();
          }
        }, true);
        restart.disabled = restarting.has(app.id);
        restart.setAttribute('aria-label', `${label} for ${app.name}`);
        actions.append(restart);
      }
      const open = button(app.release ? 'Open app' : 'View build', () => navigate(app.id)); open.setAttribute('aria-label', `${app.release ? 'Open' : 'View build for'} ${app.name}`); open.append(createIcon('chevronRight')); actions.append(open);
      row.append(icon, info, actions); shelf.append(row);
    }
  };
  search.addEventListener('input', paint); sort.addEventListener('change', paint); paint();
  let refreshing = false;
  const subscriptions = apps.filter(app => !terminal.has(app.status)).map(app => subscribeReef(app.id, () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (refreshing || stamp !== generation) return;
      refreshing = true;
      void listReefApps().then(latest => { if (stamp === generation) { apps = latest; paint(); } }).catch(() => {}).finally(() => { refreshing = false; });
    }, 250);
  }));
  disposeEvents = () => subscriptions.forEach(dispose => dispose());
}

async function showDetail(id: string, stamp: number) {
  let app = await getReefApp(id); if (stamp !== generation) return;
  const body = element('main', '', 'reef-detail-screen');
  const heading = element('div', '', 'reef-detail-heading');
  const identity = element('div', '', 'reef-detail-identity');
  const appIcon = element('div', app.name.slice(0, 1).toUpperCase(), 'reef-app-icon'); appIcon.setAttribute('aria-hidden', 'true');
  const info = element('div', '', 'reef-detail-info'); const title = element('h2', app.name); const description = element('p', app.description); info.append(title, description); identity.append(appIcon, info); heading.append(identity);
  const actions = element('div', '', 'reef-actions');
  const content = element('div', '', 'reef-workspace'); const main = element('div', '', 'reef-main'); const aside = element('aside');
  const toolbar = element('div', '', 'reef-workspace-toolbar');
  const views = element('div', '', 'reef-view-switch'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'App workspace view');
  const buildTab = button('Build', () => selectView('build')); buildTab.prepend(createIcon('tools'));
  const previewTab = button('Preview', () => selectView('preview')); previewTab.prepend(createIcon('browser'));
  views.append(buildTab, previewTab);
  const binding = element('div', '', 'reef-workspace-model');
  const modelSelect = element('select'); modelSelect.setAttribute('aria-label', 'Build model'); binding.append(modelSelect);
  const chatToggle = element('button', '', 'reef-chat-toggle'); chatToggle.type = 'button';
  chatToggle.append(createIcon('appChat'), element('span', 'Chat'));
  chatToggle.setAttribute('aria-controls', 'reefAppChat');
  const toolbarEnd = element('div', '', 'reef-toolbar-end'); toolbarEnd.append(binding, chatToggle);
  toolbar.append(views, toolbarEnd);
  let chatOpen = readChatOpen();
  function syncChat() {
    content.dataset.chat = chatOpen ? 'open' : 'closed'; aside.hidden = !chatOpen;
    chatToggle.setAttribute('aria-expanded', String(chatOpen));
    chatToggle.title = chatOpen ? 'Hide the app conversation' : 'Ask about this app or request a change';
  }
  chatToggle.addEventListener('click', () => {
    chatOpen = !chatOpen; writeChatOpen(chatOpen); syncChat();
    if (chatOpen) chat?.focus();
  });
  let savingModel = false;
  const modelValue = () => encodeModelSelectKey(app.providerId ?? '', app.modelId);
  function syncBuildModel() {
    const value = modelValue();
    if (![...modelSelect.options].some(option => option.value === value)) {
      const option = element('option', app.modelId); option.value = value; modelSelect.append(option);
    }
    modelSelect.value = value; modelSelect.disabled = savingModel;
    syncAuxiliaryModelSelectCombobox(modelSelect);
    const trigger = binding.querySelector<HTMLButtonElement>('.model-select-trigger');
    if (trigger) {
      trigger.setAttribute('aria-label', `Change build model, currently ${app.modelId}`);
      trigger.title = 'Change build model. Applies to the next agent stage or reply.';
    }
  }
  const catalog = document.getElementById('modelSelect') as HTMLSelectElement | null;
  function copyModelCatalog() {
    if (!catalog) return;
    modelSelect.replaceChildren(...[...catalog.children].map(option => option.cloneNode(true)));
    for (const option of [...modelSelect.options]) {
      if (isAgentCliProviderId(decodeModelSelectKey(option.value)?.providerId)) option.remove();
    }
  }
  copyModelCatalog();
  syncBuildModel(); mountAuxiliaryModelSelectCombobox(modelSelect); syncBuildModel();
  const modelPicker = binding.querySelector<HTMLElement>('.model-select-inner')!;
  const modelTrigger = binding.querySelector<HTMLButtonElement>('.model-select-trigger')!;
  const modelMenu = binding.querySelector<HTMLUListElement>('.model-select-menu')!;
  modelMenu.tabIndex = -1;
  let activeModelIndex = -1;
  modelPicker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modelPicker.classList.contains('is-open')) {
      event.preventDefault(); closeModelSelectMenu(); modelTrigger.focus(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) || savingModel) return;
    if (!modelPicker.classList.contains('is-open')) {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      modelTrigger.click(); activeModelIndex = -1;
    }
    const rows = [...modelMenu.querySelectorAll<HTMLLIElement>('[role="option"][data-value]')];
    if (!rows.length) return;
    event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') {
      rows[activeModelIndex]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); modelTrigger.focus(); return;
    }
    activeModelIndex = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? Math.min(activeModelIndex + 1, rows.length - 1)
        : activeModelIndex < 0 ? rows.length - 1 : Math.max(activeModelIndex - 1, 0);
    rows.forEach((row, index) => {
      row.id = `reef-model-option-${index}`;
      row.classList.toggle('model-select-option--active', index === activeModelIndex);
    });
    modelMenu.setAttribute('aria-activedescendant', rows[activeModelIndex].id);
    rows[activeModelIndex].scrollIntoView({ block: 'nearest' }); modelMenu.focus();
  });
  disposeModelPicker = () => { if (modelPicker.classList.contains('is-open')) closeModelSelectMenu(); };
  modelPicker.addEventListener('click', event => {
    if (!(event.target as Element).closest('.model-select-trigger') || savingModel) return;
    if (catalog) {
      copyModelCatalog();
      syncBuildModel();
    }
  }, { capture: true });
  modelTrigger.addEventListener('click', () => { activeModelIndex = -1; modelMenu.removeAttribute('aria-activedescendant'); });
  modelSelect.addEventListener('change', () => {
    if (savingModel) return;
    const selected = decodeModelSelectKey(modelSelect.value) ?? { modelId: modelSelect.value };
    if (!selected.modelId || modelSelect.value === modelValue()) return;
    savingModel = true; paint();
    void reefRequest<ReefApp>(`apps/${id}/model`, 'PUT', selected).then(async updated => {
      if (stamp !== generation) return;
      app = { ...app, ...updated }; paint(); await refresh();
    }).catch(error => { if (stamp === generation) showError(errorText(error)); }).finally(() => {
      savingModel = false; if (stamp === generation) paint();
    });
  });
  const build = element('section', '', 'reef-build'); build.setAttribute('aria-label', 'Build status');
  const stage = element('div', '', 'reef-stage');
  const orb = element('div', '', 'reef-orb');
  const orbCanvas = element('canvas'); orbCanvas.setAttribute('aria-hidden', 'true');
  const core = element('div', '', 'reef-orb-core');
  const status = element('p', '', 'reef-orb-stage'); status.setAttribute('role', 'status');
  const headline = element('h3', '', 'reef-orb-headline');
  const detail = element('p', '', 'reef-orb-detail');
  const live = element('p', '', 'reef-orb-meta');
  core.append(status, headline, detail, live); orb.append(orbCanvas, core);
  const ring = mountReefOrb(orbCanvas); disposeOrb = ring.dispose;
  const progress = element('progress', '', 'visually-hidden'); progress.max = 100; progress.setAttribute('aria-label', 'Build progress');
  const pipeline = element('ol', '', 'reef-pipeline'); pipeline.setAttribute('aria-label', 'Build steps');
  const stages = [
    ['scaffolding', 'Set up'], ['planning', 'Plan'], ['building', 'Build'],
    ['installing', 'Install'], ['checking', 'Check'], ['promoting', 'Save'],
  ];
  const steps = stages.map(([, label]) => {
    const step = element('li', '', 'reef-step'); const dot = element('span', '', 'reef-step-dot'); dot.setAttribute('aria-hidden', 'true');
    const state = element('span', 'Pending', 'reef-step-state visually-hidden');
    step.append(dot, element('span', label, 'reef-step-label'), state); pipeline.append(step); return { step, state };
  });
  const trail = element('ul', '', 'reef-trail'); trail.setAttribute('aria-label', 'Files the agent has touched');
  const recovery = element('div', '', 'reef-recovery');
  let restarting = false;
  async function recoverBuild(action: 'resume' | 'reset-phase' | 'reset-build') {
    if (restarting) return;
    restarting = true; paint();
    try {
      const run = await reefRequest<ReefRun>(`apps/${id}/runs`, 'POST', { action, runId: app.runs.at(-1)!.id });
      if (stamp !== generation) return;
      app = { ...app, status: run.state, runs: app.runs.some(item => item.id === run.id) ? app.runs.map(item => item.id === run.id ? run : item) : [...app.runs, run] }; paint();
      await refresh();
    }
    finally { restarting = false; if (stamp === generation) paint(); }
  }
  const repair = button('Retry build', () => recoverBuild('resume'), true);
  repair.title = 'Continue from the stopped phase using saved files.';
  const resetOptions = element('details', '', 'reef-reset'); resetOptions.append(element('summary', 'Start over'));
  const resetActions = element('div', '', 'reef-reset-actions');
  const resetPhase = button('Reset current phase', () => { resetOptions.open = false; return recoverBuild('reset-phase'); });
  resetPhase.title = 'Discard changes from the stopped phase and run that phase again.';
  const resetBuild = button('Reset whole build', () => { resetOptions.open = false; return recoverBuild('reset-build'); });
  resetBuild.title = 'Start the request again from the last verified version, keeping the previous build history.';
  resetActions.append(resetPhase, resetBuild); resetOptions.append(resetActions);
  const cancel = button('Cancel build', async () => { const run = app.runs.at(-1); if (run) await reefRequest(`apps/${id}/cancel`, 'POST', { runId: run.id }); await refresh(); });
  cancel.classList.add('reef-cancel');
  // Recovery sits in the ring's centre, where the eye already is when a build stops.
  recovery.append(repair); core.append(recovery);
  stage.append(orb, progress, pipeline, trail, resetOptions, cancel);
  // The working detail stays one click away for anyone who wants to watch closely.
  const backstage = element('div', '', 'reef-backstage');
  const peek = element('details', '', 'reef-peek');
  const peekSummary = element('summary'); peekSummary.append(createIcon('appChat'), element('span', 'Watch the agent'));
  const agentStream = element('div', '', 'reef-agent-stream'); agentStream.tabIndex = 0; agentStream.setAttribute('role', 'region'); agentStream.setAttribute('aria-label', 'Live agent response and tool activity');
  const agentView = mountReefAgentStream(agentStream); disposeAgentStream = agentView.dispose;
  peek.append(peekSummary, agentStream);
  const logs = element('details', '', 'reef-peek reef-host-logs');
  const logsSummary = element('summary'); logsSummary.append(createIcon('terminal'), element('span', 'Build log'));
  const error = element('pre', '', 'reef-build-error'); error.setAttribute('role', 'region'); error.setAttribute('aria-label', 'Build error');
  const log = element('pre', '', 'reef-build-log'); log.tabIndex = 0; log.setAttribute('role', 'region'); log.setAttribute('aria-label', 'Build activity log');
  logs.append(logsSummary, error, log);
  backstage.append(peek, logs);
  peek.open = backstageOpen.agent; logs.open = backstageOpen.log;
  logs.addEventListener('toggle', () => { backstageOpen.log = logs.open; });
  peek.addEventListener('toggle', () => { backstageOpen.agent = peek.open; if (peek.open) { const run = app.runs.at(-1); agentView.update(run, Boolean(run && !terminal.has(run.state))); } });
  build.append(stage, backstage);
  const preview = element('div', '', 'reef-preview');
  const previewEmpty = element('div', '', 'reef-preview-empty'); previewEmpty.append(createIcon('browser'), element('h3', 'Your app preview'), element('p', 'Run the verified build to use your app here.')); preview.append(previewEmpty);
  let displayedRelease = '', launched = false;
  let view: 'build' | 'preview' = app.release && app.status === 'ready' ? 'preview' : 'build';
  function selectView(next: typeof view) {
    if (next === 'preview' && !app.release) return;
    view = next; build.hidden = view !== 'build'; preview.hidden = view !== 'preview';
    buildTab.setAttribute('aria-pressed', String(view === 'build')); previewTab.setAttribute('aria-pressed', String(view === 'preview'));
    if (activePreview) setPreviewInstanceVisible(activePreview, view === 'preview' && exportPanel.hidden && !manage.open);
  }
  main.append(toolbar, build, preview); content.append(main, aside);
  const runButton = button('Run app', async () => {
    const launch = await reefRequest<{ url: string }>(`apps/${id}/launch`, 'POST');
    if (stamp !== generation) return;
    launched = true; selectView('preview');
    preview.replaceChildren();
    if (window.minnow?.preview) {
      const previewId = `reef-${id}`; activePreview = previewId;
      await window.minnow.preview.instances.create(previewId);
      if (stamp !== generation) { void window.minnow.preview.instances.destroy(previewId); return; }
      disposePreview(); disposePreview = bindPreviewInstanceToElement(activePreview, preview);
      await window.minnow.preview.loadURL(launch.url, undefined, activePreview);
    } else {
      const iframe = element('iframe'); iframe.title = app.name;
      iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-downloads', 'allow-forms'); iframe.src = launch.url; preview.append(iframe);
    }
  }, true);
  const exportPanel = element('section', '', 'reef-export'); exportPanel.hidden = true;
  const exportButton = button('Export', async () => {
    exportPanel.hidden = !exportPanel.hidden; exportButton.setAttribute('aria-expanded', String(!exportPanel.hidden));
    if (activePreview) setPreviewInstanceVisible(activePreview, view === 'preview' && exportPanel.hidden);
    if (!exportPanel.hidden) await showExport(exportPanel, app, refresh);
  }); exportButton.setAttribute('aria-expanded', 'false');
  const manage = element('details', '', 'reef-manage'); manage.append(element('summary', 'Manage app'));
  const manageActions = element('div', '', 'reef-manage-actions');
  manageActions.append(button('Rename', async () => { manage.open = false; const name = await appPrompt('App name', app.name); if (name?.trim()) { await reefRequest(`apps/${id}`, 'PATCH', { name }); await refresh(); } }),
    button('Delete app', async () => { manage.open = false; if (await appConfirm(`Delete ${app.name}, its local repository, and app data?`, { danger: true, confirmLabel: 'Delete app' })) { await reefRequest(`apps/${id}`, 'DELETE'); navigate(); } }));
  manage.append(manageActions);
  manage.addEventListener('toggle', () => { if (activePreview) setPreviewInstanceVisible(activePreview, view === 'preview' && !manage.open && exportPanel.hidden); });
  actions.append(runButton, exportButton, button('Open in Code', () => launchApp('code', { workspacePath: app.workspacePath })), manage);
  heading.append(actions); body.append(heading, exportPanel, content); root.append(body);
  chat = mountReefChat(aside, async text => { await reefRequest(`apps/${id}/chat`, 'POST', { prompt: text }); await refresh(); });
  aside.id = 'reefAppChat'; syncChat();
  let previousRunId = app.runs.at(-1)?.id, previousState = app.status;
  let connected: boolean | undefined;
  function duration(ms: number) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  let fileCount = 0;
  function paintLiveStatus() {
    const run = app.runs.at(-1), busy = Boolean(run && !terminal.has(run.state));
    live.hidden = !busy;
    if (!run || !busy) return;
    live.dataset.connected = String(connected === true);
    const files = fileCount ? ` · ${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : '';
    const text = connected === false ? 'Reconnecting…' : `${duration(Date.now() - (run.startedAt ?? run.createdAt))}${run.state === 'queued' ? ' in line' : files}`;
    if (live.textContent !== text) live.textContent = text;
  }
  function updateOutput(node: HTMLElement, text: string) {
    if (node.textContent === text) return;
    const following = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    node.textContent = text;
    if (following) node.scrollTop = node.scrollHeight;
  }
  // What the ring has already heard, so each snapshot feeds it only the new characters.
  let heardRun = '', heardLog = 0, heardState = '';
  const heard = new Map<string, { text: number; reasoning: number; tools: number }>();
  function listen(run: ReefRun | undefined) {
    const fresh = run?.id !== heardRun; heardRun = run?.id ?? '';
    if (fresh) { heard.clear(); heardLog = run?.log.length ?? 0; }
    for (const session of run?.agentSessions ?? []) for (const round of session.rounds) {
      const before = heard.get(round.id);
      heard.set(round.id, { text: round.text.length, reasoning: round.reasoning.length, tools: round.tools.length });
      if (fresh) continue;
      ring.feed(round.reasoning.slice(before && round.reasoning.length >= before.reasoning ? before.reasoning : 0), 0.7);
      ring.feed(round.text.slice(before && round.text.length >= before.text ? before.text : 0));
      for (let index = before?.tools ?? 0; index < round.tools.length; index++) ring.pulse(0.9);
    }
    const log = run?.log ?? '';
    if (!fresh && log.length > heardLog) ring.feed(log.slice(heardLog), 0.45);
    heardLog = log.length;
    if (!fresh && run && heardState && run.state !== heardState) ring.pulse(1.4);
    heardState = run?.state ?? '';
  }
  function paint() {
    syncBuildModel();
    const run = app.runs.at(-1); const busy = Boolean(run && !terminal.has(run.state));
    title.textContent = app.name; description.textContent = app.description; appIcon.textContent = app.name.slice(0, 1).toUpperCase(); runButton.disabled = !app.release; exportButton.disabled = !app.release; previewTab.disabled = !app.release;
    previewTab.title = app.release ? 'View the verified app' : 'Available after the first successful build';
    if (run?.id !== previousRunId) view = 'build';
    else if (run?.state === 'ready' && previousState !== 'ready') view = 'preview';
    previousRunId = run?.id; previousState = app.status;
    selectView(view);
    build.dataset.state = run?.state ?? 'queued';
    const activity = describeReefActivity(run);
    const stageText = `${activity.stage}${busy && run?.attempt ? ` · repair ${run.attempt} of 2` : ''}`;
    if (status.textContent !== stageText) status.textContent = stageText;
    if (headline.textContent !== activity.headline) headline.textContent = activity.headline;
    if (detail.textContent !== activity.detail) detail.textContent = activity.detail;
    detail.hidden = !activity.detail;
    fileCount = activity.files.length;
    paintLiveStatus();
    progress.value = run?.progress ?? 0;
    const tone = busy ? 'live' : run?.state === 'ready' ? 'ready' : run?.state === 'failed' ? 'failed' : 'idle';
    orb.dataset.tone = tone;
    ring.set(tone, busy ? run?.progress ?? 0 : run?.state === 'ready' ? 100 : 0);
    if (busy) listen(run); else heardRun = '';
    const shown = activity.files.slice(-5);
    if (trail.dataset.files !== shown.join('\n')) {
      trail.dataset.files = shown.join('\n');
      const existing = new Map([...trail.children].map(item => [(item as HTMLElement).dataset.file!, item as HTMLElement]));
      trail.replaceChildren(...shown.map(file => {
        const item = existing.get(file) ?? element('li', file); item.dataset.file = file; item.title = file; return item;
      }));
    }
    trail.hidden = !shown.length;
    const stoppedStage = run && terminal.has(run.state) && run.state !== 'ready' ? run.failedStage : run?.state;
    const stepStage = stoppedStage === 'repairing' ? 'building' : stoppedStage;
    const stageIndex = stages.findIndex(([value]) => value === stepStage);
    steps.forEach(({ step, state }, index) => {
      const done = run?.state === 'ready' || index < stageIndex;
      const current = index === stageIndex;
      step.dataset.state = done ? 'done' : current ? busy ? 'active' : 'stopped' : 'pending';
      state.textContent = done ? 'Done' : current ? busy ? 'Working' : run?.state === 'failed' ? 'Failed' : 'Stopped' : 'Pending';
      if (current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    });
    const label = recoveryLabel(app);
    error.textContent = run?.error ? `${run.failedStage ? `${run.failedStage}: ` : ''}${run.error}` : ''; error.hidden = !run?.error; cancel.hidden = !busy; repair.hidden = busy || !label;
    repair.textContent = restarting ? 'Starting build…' : label ?? 'Retry build'; repair.disabled = restarting || busy || savingModel;
    resetPhase.disabled = resetBuild.disabled = restarting || busy || savingModel;
    resetOptions.hidden = repair.hidden;
    recovery.hidden = repair.hidden;
    peek.hidden = !run?.agentLog && !run?.agentSessions?.length && !['planning', 'building', 'repairing'].includes(run?.state ?? '');
    // Rendering markdown per snapshot is wasted work while the panel is closed.
    if (peek.open) agentView.update(run, busy);
    updateOutput(log, run?.log || (busy ? 'Waiting for build activity…' : 'No build activity was recorded.'));
    chat?.update(app, busy || restarting || savingModel);
    if (app.release && !launched && displayedRelease !== app.release.id) {
      displayedRelease = app.release.id;
      void fetch(`/api/reef/apps/${id}/preview`).then(async response => {
        if (!response.ok) return;
        const blob = await response.blob();
        if (stamp !== generation || launched) return;
        if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
        previewImageUrl = URL.createObjectURL(blob);
        const image = element('img'); image.alt = `${app.name} verified build preview`; image.src = previewImageUrl;
        preview.replaceChildren(image);
      }).catch(() => {});
    }
  }
  let refreshing = false;
  async function refresh() {
    if (stamp !== generation) return;
    if (refreshing) { refreshQueued = true; return; }
    refreshing = true;
    try { const latest = await getReefApp(id); if (stamp !== generation) return; app = latest; paint(); }
    finally {
      refreshing = false;
      if (refreshQueued) { refreshQueued = false; void refresh().catch(error => showError(errorText(error))); }
    }
  }
  let refreshQueued = false;
  paint();
  const liveTimer = setInterval(() => { if (stamp === generation) paintLiveStatus(); }, 1000);
  // Keep snapshots advancing even when a connection dies silently or is reconnecting.
  const refreshFallback = setInterval(() => {
    if (stamp === generation && !terminal.has(app.runs.at(-1)?.state ?? 'ready')) void refresh().catch(() => {});
  }, 5000);
  disposeLiveStatus = () => { clearInterval(liveTimer); clearInterval(refreshFallback); };
  disposeEvents = subscribeReef(id, () => {
    if (stamp !== generation) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().catch(error => showError(errorText(error))); }, 200);
  }, value => { if (stamp === generation) { connected = value; paintLiveStatus(); } });
}

async function showExport(host: HTMLElement, app: ReefApp, refresh: () => Promise<void>) {
  host.replaceChildren(element('h3', 'Export app'), element('p', 'Standalone packages are unsigned and unnotarized. Source exports include build instructions.'));
  const capabilities = await reefRequest<{ platform: string; arch: string; docker: boolean; github: boolean }>('capabilities');
  const target = element('select'); target.setAttribute('aria-label', 'Export operating system');
  for (const [value, label] of [['win32', 'Windows'], ['darwin', 'macOS'], ['linux', 'Linux']]) { const option = element('option', label); option.value = value; target.append(option); }
  target.value = capabilities.platform;
  const arch = element('select'); arch.setAttribute('aria-label', 'Export architecture');
  for (const value of ['x64', 'arm64']) { const option = element('option', value); option.value = value; arch.append(option); } arch.value = capabilities.arch;
  const method = element('select'); method.setAttribute('aria-label', 'Export method');
  const updateMethods = () => {
    method.replaceChildren();
    const choices = [['source', 'Source + build kit']];
    if (target.value === capabilities.platform) choices.unshift(['local', 'Build on this machine']);
    if (capabilities.docker && target.value !== 'darwin') choices.push(['docker', 'Build with Docker']);
    choices.push(['github', 'GitHub Actions']);
    for (const [value, label] of choices) { const option = element('option', label); option.value = value; method.append(option); }
  };
  target.addEventListener('change', updateMethods); updateMethods();
  const controls = element('div', '', 'reef-actions');
  const performExport = async (exportMethod: string, exportTarget: string, exportArch = arch.value) => {
    let cloudConsent = false;
    if (exportMethod === 'github') {
      cloudConsent = await appConfirm('Upload this app’s source to a private GitHub repository and run a build on GitHub Actions? Your local app repository stays local.', { confirmLabel: 'Upload and build' });
      if (!cloudConsent) return;
    }
    await exportReefApp(app.id, { target: exportTarget, arch: exportArch, method: exportMethod, cloudConsent });
    await refresh(); await showExport(host, await getReefApp(app.id), refresh);
  };
  controls.append(target, arch, method, button('Create export', () => performExport(method.value, target.value), true));
  host.append(controls);
  for (const item of app.exports.slice().reverse()) {
    const row = element('div', '', 'reef-export-row'); row.append(element('span', `${item.target} · ${item.method} · ${item.status}`));
    if (item.filename && item.status === 'ready') {
      row.append(button('Download', async () => {
        const response = await fetch(`/api/reef/apps/${app.id}/exports/${item.id}`);
        if (!response.ok) throw new Error('Could not download export');
        const url = URL.createObjectURL(await response.blob());
        const link = element('a'); link.href = url; link.download = item.filename!; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }));
    }
    if (item.url) { const link = element('a', 'View build'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    if (item.error) row.append(element('p', item.error));
    if (item.status === 'failed' || item.status === 'interrupted') row.append(button('Retry', () => performExport(item.method, item.target, item.arch)));
    host.append(row);
  }
  host.append(button('Refresh exports', async () => showExport(host, await getReefApp(app.id), refresh)));
}
