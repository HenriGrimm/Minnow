import '../styles/reef.css';
import { createIcon } from './icon';
import { appConfirm, appPrompt } from './app-dialog';
import { launchApp, getCurrentRoute } from '../os/router';
import { getForegroundAppId } from '../os/instances';
import { readDefaultModelBinding } from './default-model';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { closeComposerModelMenu, mountAppModelTrigger } from './composer-model-trigger';
import { listReefApps, getReefApp, createReefApp, reefRequest, subscribeReef } from '../reef/client';
import type { ReefApp, ReefRun } from '../reef/types';
import { mountReefChat } from './reef-chat';
import { mountReefExport } from './reef-export';
import { mountReefAgentStream } from './reef-agent-stream';
import { mountReefOrb } from './reef-orb';
import { describeReefActivity } from '../reef/activity';
import { DEFAULT_REEF_PALETTE, REEF_CUSTOM_VIBE, REEF_PALETTE_ROLES, REEF_THEME_VIBE, type ReefThemeColors, REEF_SETUP_STEPS, REEF_VIBES, composeReefLook, suggestReefNames, type ReefPalette, type ReefSetupStep } from '../reef/setup';
import { mountReefPreview } from './reef-preview';

const terminal = new Set(['ready', 'failed', 'cancelled', 'interrupted']);
function recoveryLabel(app: ReefApp) {
  const state = app.runs.at(-1)?.state ?? app.status;
  return state === 'failed' ? 'Retry build' : state === 'cancelled' || state === 'interrupted' ? 'Resume build' : null;
}
let root: HTMLElement;
/** Setup answers survive moving around Reef until a build starts. */
const emptyCreateDraft = () => ({ step: 'idea' as ReefSetupStep, what: '', name: '', suggestedName: '', vibe: null as string | null, palette: [...DEFAULT_REEF_PALETTE] as ReefPalette, look: '' });
let createDraft = emptyCreateDraft();
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
let setPreviewVisible = (_visible: boolean) => {};

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
/** The live Minnow theme as hex, since themes may define tokens as oklch or color-mix. */
function readMinnowTheme(): ReefThemeColors | undefined {
  let context: CanvasRenderingContext2D | null = null;
  try { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; context = canvas.getContext('2d', { willReadFrequently: true }); }
  catch { return undefined; }
  if (!context) return undefined;
  const styles = getComputedStyle(root ?? document.documentElement);
  const hex = (token: string) => {
    context!.clearRect(0, 0, 1, 1); context!.fillStyle = '#000'; context!.fillStyle = styles.getPropertyValue(token).trim() || '#000'; context!.fillRect(0, 0, 1, 1);
    const [r, g, b] = context!.getImageData(0, 0, 1, 1).data;
    return { hex: `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`, light: 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 };
  };
  const background = hex('--mn-bg');
  return {
    scheme: background.light ? 'light' : 'dark',
    colors: { background: background.hex, surface: hex('--mn-surface-1').hex, text: hex('--mn-fg').hex, 'muted text': hex('--mn-fg-muted').hex, accent: hex('--mn-accent').hex },
  };
}
function navigate(id?: string) { launchApp('reef', id ? { reefAppId: id } : undefined); }
function reset() {
  disposeModelPicker(); disposeModelPicker = () => {};
  disposeAgentStream(); disposeAgentStream = () => {};
  disposeOrb(); disposeOrb = () => {};
  disposeLiveStatus(); disposeLiveStatus = () => {};
  disposeEvents(); disposeEvents = () => {};
  disposePreview(); disposePreview = () => {};
  setPreviewVisible = () => {};
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
  closeComposerModelMenu(); disposeOrb(); disposeOrb = () => {};
  generation++; disposeEvents(); disposePreview(); disposeLiveStatus();
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  setPreviewVisible(false);
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
  body.dataset.step = createDraft.step;
  const stepIndex = REEF_SETUP_STEPS.findIndex(step => step.id === createDraft.step);
  const track = element('ol', '', 'reef-setup-track'); track.setAttribute('aria-label', 'New app steps');
  REEF_SETUP_STEPS.forEach((step, index) => {
    const item = element('li', '', 'reef-setup-step');
    item.dataset.state = index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'next';
    const bubble = element('span', String(index + 1), 'reef-setup-bubble'); bubble.setAttribute('aria-hidden', 'true');
    const label = element('span', step.label, 'reef-setup-label');
    // Finished steps stay one tap away, so a change of heart never means starting over.
    if (index < stepIndex && !createPending) {
      const jump = button('', () => goTo(step.id)); jump.classList.add('reef-setup-jump');
      jump.setAttribute('aria-label', `Back to step ${index + 1}: ${step.label}`); jump.append(bubble, label); item.append(jump);
    } else item.append(bubble, label);
    if (index === stepIndex) item.setAttribute('aria-current', 'step');
    track.append(item);
  });
  const panel = element('form', '', 'reef-create'); panel.noValidate = true;
  const intro = element('div', '', 'reef-create-intro');
  const cheer = ['NEW APP', 'OOH, NICE IDEA', 'GREAT NAME'][stepIndex];
  const controls = element('div', '', 'reef-create-controls');
  const back = element('button', 'Back', 'reef-create-back'); back.type = 'button'; back.prepend(createIcon('chevronLeft'));
  back.addEventListener('click', () => goTo(REEF_SETUP_STEPS[stepIndex - 1].id));
  const next = element('button', '', 'reef-primary'); next.type = 'submit';
  const appName = () => createDraft.name.trim() || 'your app';
  let field: HTMLInputElement | HTMLTextAreaElement;
  let advance: () => void;
  if (createDraft.step === 'idea') {
    intro.append(element('span', cheer, 'reef-eyebrow'), element('h2', 'What shall we dream up?'), element('p', 'Tell Reef what your little app should do. One clear job works best, and you can ask for changes later.'));
    const label = element('label', 'Your idea', 'reef-field-label'); label.htmlFor = 'reefPrompt';
    const prompt = element('textarea', '', 'reef-prompt'); prompt.id = 'reefPrompt'; prompt.rows = 5; prompt.maxLength = 16000; prompt.required = true;
    prompt.placeholder = 'For example, a dinner bill calculator that splits the total, adds a tip, and shows what each person owes.'; prompt.value = createDraft.what;
    prompt.addEventListener('input', () => { createDraft.what = prompt.value; });
    const ideas = element('div', '', 'reef-ideas'); ideas.setAttribute('role', 'group'); ideas.setAttribute('aria-labelledby', 'reefIdeasTitle');
    const ideasTitle = element('span', 'Need a nudge?', 'reef-ideas-title'); ideasTitle.id = 'reefIdeasTitle'; ideas.append(ideasTitle);
    const examples = [
      ['Split a bill', 'Split a dinner bill between friends, with a tip percentage and a clear total for each person.'],
      ['Convert units', 'Convert between metric and imperial units for length, weight, and temperature.'],
      ['Focus timer', 'A focus timer with adjustable work and break sessions, and a sound when a session ends.'],
    ];
    for (const [title, description] of examples) {
      const idea = button(title, () => { prompt.value = description; createDraft.what = description; prompt.focus(); });
      idea.append(createIcon('chevronRight')); ideas.append(idea);
    }
    panel.append(intro, label, prompt, ideas);
    next.textContent = 'Next: name it'; field = prompt;
    advance = () => {
      if (!createDraft.what.trim()) { showError('Tell Reef a little about your app first.'); prompt.focus(); return; }
      // A fresh idea gets a fresh name idea; a name the person typed themselves is kept.
      if (!createDraft.name.trim() || createDraft.name === createDraft.suggestedName) createDraft.name = createDraft.suggestedName = suggestReefNames(createDraft.what)[0];
      goTo('name');
    };
  } else if (createDraft.step === 'name') {
    intro.append(element('span', cheer, 'reef-eyebrow'), element('h2', 'Every little app deserves a name.'), element('p', 'Something short you will spot on your shelf. You can rename it any time.'));
    const label = element('label', 'App name', 'reef-field-label'); label.htmlFor = 'reefName';
    const row = element('div', '', 'reef-name-row');
    const tile = element('div', '', 'reef-app-icon reef-name-tile'); tile.setAttribute('aria-hidden', 'true');
    const input = element('input', '', 'reef-name'); input.id = 'reefName'; input.maxLength = 100; input.required = true; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = createDraft.name;
    const paintTile = () => { tile.textContent = (createDraft.name.trim() || '?').slice(0, 1).toUpperCase(); };
    input.addEventListener('input', () => { createDraft.name = input.value; paintTile(); });
    const suggestions = suggestReefNames(createDraft.what);
    const shuffle = button('Shuffle', () => {
      createDraft.name = createDraft.suggestedName = suggestions[(suggestions.indexOf(createDraft.name) + 1) % suggestions.length];
      input.value = createDraft.name; paintTile();
      // Restart the tile's little hop on every shuffle.
      tile.classList.remove('is-hopping'); void tile.offsetWidth; tile.classList.add('is-hopping');
    });
    shuffle.classList.add('reef-shuffle'); shuffle.prepend(createIcon('dice')); shuffle.title = 'Try another name idea';
    paintTile(); row.append(tile, input, shuffle);
    panel.append(intro, label, row);
    next.textContent = 'Next: pick a look'; field = input;
    advance = () => {
      if (!createDraft.name.trim()) { showError('Give your app a name, or shuffle for an idea.'); input.focus(); return; }
      goTo('look');
    };
  } else {
    intro.append(element('span', cheer, 'reef-eyebrow'), element('h2', `How should ${appName()} look?`), element('p', 'Pick a vibe, describe your own, or both. Skip it and Reef will choose something fitting.'));
    const vibes = element('div', '', 'reef-vibes'); vibes.setAttribute('role', 'group'); vibes.setAttribute('aria-label', 'Vibes');
    const vibeCard = (id: string, label: string, title: string, dots: string[]) => {
      const choice = element('button', '', 'reef-vibe'); choice.type = 'button'; choice.dataset.vibe = id; choice.title = title;
      const swatch = element('span', '', 'reef-vibe-swatch'); swatch.setAttribute('aria-hidden', 'true');
      for (const color of dots) { const dot = element('span'); dot.style.setProperty('--reef-swatch', color); swatch.append(dot); }
      choice.append(swatch, element('span', label, 'reef-vibe-label'));
      choice.addEventListener('click', () => {
        createDraft.vibe = createDraft.vibe === id ? null : id; paintVibes();
        if (createDraft.vibe === REEF_CUSTOM_VIBE) editor.querySelector('input')?.focus();
      });
      return choice;
    };
    const choices = REEF_VIBES.map(vibe => vibeCard(vibe.id, vibe.label, vibe.look, vibe.swatch.map(tone => `var(--mn-label-${tone})`)));
    // Its swatch reads the live theme tokens, so it always shows the theme in use.
    choices.push(vibeCard(REEF_THEME_VIBE, 'Match Minnow', 'Use the colors of your current Minnow theme.', ['var(--mn-bg)', 'var(--mn-surface-2)', 'var(--mn-accent)']));
    // Make your own opens one color picker per palette role, below the cards.
    const custom = vibeCard(REEF_CUSTOM_VIBE, 'Make your own', 'Pick each color yourself.', createDraft.palette);
    custom.classList.add('reef-vibe-custom'); custom.setAttribute('aria-controls', 'reefPaletteEditor');
    const customDots = [...custom.querySelectorAll<HTMLElement>('.reef-vibe-swatch > span')];
    choices.push(custom);
    const editor = element('div', '', 'reef-palette-editor'); editor.id = 'reefPaletteEditor';
    editor.setAttribute('role', 'group'); editor.setAttribute('aria-label', 'Your color palette');
    const codes = REEF_PALETTE_ROLES.map((role, index) => {
      const slot = element('label', '', 'reef-palette-slot');
      const picker = element('input', '', 'reef-palette-picker'); picker.type = 'color'; picker.value = createDraft.palette[index];
      picker.setAttribute('aria-label', `${role.label} color`);
      const code = element('span', '', 'reef-palette-code');
      picker.addEventListener('input', () => { createDraft.palette[index] = picker.value; paintPalette(); });
      const copy = element('span', '', 'reef-palette-copy'); copy.append(element('span', role.label, 'reef-palette-role'), code);
      slot.append(picker, copy); editor.append(slot);
      return code;
    });
    const paintPalette = () => createDraft.palette.forEach((color, index) => {
      customDots[index].style.setProperty('--reef-swatch', color); codes[index].textContent = color.toUpperCase();
    });
    paintPalette();
    const paintVibes = () => {
      for (const choice of choices) choice.setAttribute('aria-pressed', String(choice.dataset.vibe === createDraft.vibe));
      const open = createDraft.vibe === REEF_CUSTOM_VIBE;
      custom.setAttribute('aria-expanded', String(open)); editor.hidden = !open;
    };
    vibes.append(...choices, editor); paintVibes();
    const label = element('label', 'Anything else about the look? (optional)', 'reef-field-label'); label.htmlFor = 'reefLook';
    const notes = element('textarea', '', 'reef-prompt reef-look'); notes.id = 'reefLook'; notes.rows = 3; notes.maxLength = 3000;
    notes.placeholder = 'For example, big friendly numbers, a sunset gradient, and a tiny fish that swims by when you finish.'; notes.value = createDraft.look;
    notes.addEventListener('input', () => { createDraft.look = notes.value; });
    panel.append(intro, vibes, label, notes);
    next.textContent = `Build ${appName()}`; next.prepend(createIcon('sparkles')); field = notes;
    advance = submitBuild;
  }
  if (stepIndex > 0) controls.append(back);
  controls.append(next); panel.append(controls);
  body.append(track, panel); root.append(body);
  // Ctrl/Cmd+Enter moves on from a multi-line answer, as Enter does from the name.
  field.addEventListener('keydown', event => {
    const key = event as KeyboardEvent;
    if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) { key.preventDefault(); panel.requestSubmit(); }
  });
  panel.addEventListener('submit', event => { event.preventDefault(); if (!createPending) advance(); });
  if (createPending) { showLaunch(); return; }
  queueMicrotask(() => { if (stamp === generation && field.isConnected && document.activeElement !== field) field.focus({ preventScroll: true }); });

  function goTo(step: ReefSetupStep) {
    createDraft.step = step;
    root.querySelector<HTMLElement>('.reef-error')!.hidden = true;
    body.remove(); showCreate(stamp);
  }
  /** The orb appears the moment the person commits, with their own words rippling its rim. */
  function showLaunch() {
    const launch = element('section', '', 'reef-launch'); launch.setAttribute('aria-label', 'Starting your build');
    const orb = element('div', '', 'reef-orb reef-launch-orb'); orb.dataset.tone = 'live';
    const canvas = element('canvas'); canvas.setAttribute('aria-hidden', 'true');
    const core = element('div', '', 'reef-orb-core');
    const stage = element('p', 'Waking the reef', 'reef-orb-stage'); stage.setAttribute('role', 'status');
    core.append(stage, element('h3', `${appName()} is on its way`, 'reef-orb-headline'), element('p', 'Checking your model and tools before the build begins.', 'reef-orb-detail'));
    orb.append(canvas, core); launch.append(orb); panel.replaceWith(launch);
    disposeOrb(); const ring = mountReefOrb(canvas); disposeOrb = ring.dispose;
    ring.set('live', 4);
    ring.feed(`${createDraft.what} ${createDraft.name} ${composeReefLook(createDraft.vibe, createDraft.look, { palette: createDraft.palette, theme: readMinnowTheme() })}`);
    ring.pulse(1.2);
  }
  function submitBuild() {
    const binding = readDefaultModelBinding();
    if (!binding.modelId) { showError('Choose a default model in the top bar before building your app.'); return; }
    const look = composeReefLook(createDraft.vibe, createDraft.look, { palette: createDraft.palette, theme: readMinnowTheme() });
    createPending = true; body.remove(); showCreate(stamp);
    let created = false;
    void createReefApp({ prompt: createDraft.what.trim(), name: createDraft.name.trim(), ...(look ? { look } : {}), ...binding }).then(app => {
      created = true; createDraft = emptyCreateDraft();
      // The build page carries the same orb on, unless the person has wandered elsewhere.
      if (stamp === generation || root.dataset.reefScreen === 'new') navigate(app.id);
    }).catch(error => {
      if (stamp === generation) showError(errorText(error));
    }).finally(() => {
      createPending = false;
      // On failure the answers are still there to adjust and try again.
      if (created || root.dataset.reefScreen !== 'new' || !root.querySelector('.reef-launch')) return;
      if (stamp === generation) { disposeOrb(); disposeOrb = () => {}; root.querySelector('.reef-create-screen')?.remove(); showCreate(stamp); }
      else void openReef('new');
    });
  }
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
  // The composer's own chip and menu over the full shared catalog; the pick saves to this app only.
  const modelPicker = mountAppModelTrigger(binding, {
    ariaLabel: 'Build model',
    resolveBinding: () => ({ providerId: app.providerId, modelId: app.modelId }),
    pick: value => {
      if (savingModel) return;
      const selected = decodeModelSelectKey(value) ?? { modelId: value };
      if (!selected.modelId) return;
      savingModel = true; paint();
      void reefRequest<ReefApp>(`apps/${id}/model`, 'PUT', selected).then(async updated => {
        if (stamp !== generation) return;
        app = { ...app, ...updated }; paint(); await refresh();
      }).catch(error => { if (stamp === generation) showError(errorText(error)); }).finally(() => {
        savingModel = false; if (stamp === generation) paint();
      });
    },
  });
  disposeModelPicker = modelPicker.dispose;
  function syncBuildModel() {
    modelPicker.setBusy(savingModel);
    modelPicker.trigger.setAttribute('aria-label', `Change build model, currently ${app.modelId}`);
    modelPicker.trigger.title = 'Change build model. Applies to the next agent stage or reply.';
  }
  syncBuildModel();
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
  const previewView = mountReefPreview(preview, {
    instanceId: `reef-${id}-${stamp}`, name: () => app.name,
    launch: () => reefRequest<{ url: string }>(`apps/${id}/launch`, 'POST'),
  });
  disposePreview = previewView.dispose; setPreviewVisible = previewView.setVisible;
  let view: 'build' | 'preview' = app.release && app.status === 'ready' ? 'preview' : 'build';
  function selectView(next: typeof view) {
    if (next === 'preview' && !app.release) return;
    view = next; build.hidden = view !== 'build'; preview.hidden = view !== 'preview';
    buildTab.setAttribute('aria-pressed', String(view === 'build')); previewTab.setAttribute('aria-pressed', String(view === 'preview'));
    previewView.setVisible(view === 'preview' && exportPanel.hidden && !manage.open);
    if (view === 'preview' && app.release) previewView.open(app.release.id);
  }
  main.append(toolbar, build, preview); content.append(main, aside);
  const runButton = button('Run app', async () => {
    if (!app.release) return;
    selectView('preview');
    await previewView.start(app.release.id);
  }, true);
  const exportPanel = element('section', '', 'reef-export'); exportPanel.hidden = true;
  exportPanel.id = 'reefAppExport'; exportPanel.setAttribute('aria-label', 'Build and export app');
  const exportView = mountReefExport(exportPanel, app, refresh);
  const exportButton = button('Export', async () => {
    exportPanel.hidden = !exportPanel.hidden; exportButton.setAttribute('aria-expanded', String(!exportPanel.hidden));
    previewView.setVisible(view === 'preview' && exportPanel.hidden && !manage.open);
    if (!exportPanel.hidden) await exportView.open();
  }); exportButton.setAttribute('aria-expanded', 'false'); exportButton.setAttribute('aria-controls', exportPanel.id);
  const manage = element('details', '', 'reef-manage'); manage.append(element('summary', 'Manage app'));
  const manageActions = element('div', '', 'reef-manage-actions');
  manageActions.append(button('Rename', async () => { manage.open = false; const name = await appPrompt('App name', app.name); if (name?.trim()) { await reefRequest(`apps/${id}`, 'PATCH', { name }); await refresh(); } }),
    button('Delete app', async () => { manage.open = false; if (await appConfirm(`Delete ${app.name}, its local repository, and app data?`, { danger: true, confirmLabel: 'Delete app' })) { await reefRequest(`apps/${id}`, 'DELETE'); navigate(); } }));
  manage.append(manageActions);
  manage.addEventListener('toggle', () => { previewView.setVisible(view === 'preview' && !manage.open && Boolean(exportPanel.hidden)); });
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
    const now = Date.now(), waiting = run.retry && run.retry.at > now ? ` · retrying in ${duration(run.retry.at - now + 999)}` : '';
    const text = connected === false ? 'Reconnecting…' : `${duration(now - (run.startedAt ?? run.createdAt))}${run.state === 'queued' ? ' in line' : files}${waiting}`;
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
    exportView.update(app);
    const run = app.runs.at(-1); const busy = Boolean(run && !terminal.has(run.state));
    title.textContent = app.name; description.textContent = app.description; appIcon.textContent = app.name.slice(0, 1).toUpperCase(); runButton.disabled = !app.release; exportButton.disabled = !app.release; previewTab.disabled = !app.release;
    previewTab.title = app.release ? 'View the verified app' : 'Available after the first successful build';
    if (run?.id !== previousRunId) view = 'build';
    else if (run?.state === 'ready' && previousState !== 'ready') view = 'preview';
    previousRunId = run?.id; previousState = app.status;
    selectView(view);
    build.dataset.state = run?.state ?? 'queued';
    const activity = describeReefActivity(run);
    const stageText = `${activity.stage}${busy && run?.attempt ? ` · repair ${run.attempt}` : ''}`;
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
    if (stamp === generation && (!terminal.has(app.runs.at(-1)?.state ?? 'ready') || app.exports.some(item => item.status === 'queued' || item.status === 'building'))) void refresh().catch(() => {});
  }, 5000);
  disposeLiveStatus = () => { clearInterval(liveTimer); clearInterval(refreshFallback); };
  disposeEvents = subscribeReef(id, () => {
    if (stamp !== generation) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().catch(error => showError(errorText(error))); }, 200);
  }, value => { if (stamp === generation) { connected = value; paintLiveStatus(); } });
}
