import {
  addCustomLlamaFork,
  buildLlamaEngine,
  cancelLlamaEngineBuild,
  fetchLlamaEngines,
  fetchLlamaRuntime,
  installLlamaRuntime,
  listModelServes,
  notifyLlamaEngineChanged,
  removeLlamaEngine,
  setActiveLlamaEngine,
  stopModelServe,
  subscribeLlamaEngineBuild,
  subscribeLlamaInstallProgress,
  type CustomLlamaForkInput,
  type LlamaEngineBuildJob,
  type LlamaEngineStatus,
  type LlamaEnginesView,
  type LlamaRuntimeStatus,
  type ServeRecord,
} from '../../models/api-client';
import {
  fetchManagedServerLogs,
  fetchManagedServers,
  fetchServerInstallStatus,
  installManagedServer,
  setManagedServerAutoStart,
  setManagedServerPort,
  startManagedServer,
  stopManagedServer,
  uninstallManagedServer,
  type ManagedServerSummary,
} from '../../servers/client';
import { appConfirm } from '../app-dialog';
import { setStatus } from '../status';
import { chip, el, emptyState, formatElapsed, textButton } from './dom';

type Backend = CustomLlamaForkInput['backend'];

const BACKEND_LABELS: Record<Backend, string> = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  metal: 'Metal',
  rocm: 'ROCm',
  cpu: 'CPU',
};

const TERMINAL_BUILD = new Set<LlamaEngineBuildJob['phase']>(['completed', 'failed', 'cancelled']);

let view: LlamaEnginesView | null = null;
let runtime: LlamaRuntimeStatus | null = null;
let runtimeError: string | null = null;
let mlx: ManagedServerSummary | null = null;
let llamaServes: ServeRecord[] = [];
let buildUnsub: (() => void) | null = null;
/** Upstream install in flight: its progress line replaces the runtime facts. */
let upstreamInstallMessage: string | null = null;
let mountGeneration = 0;

function body(): HTMLElement | null {
  return document.getElementById('modelsEngineBody');
}

function isBuildRunning(job: LlamaEngineBuildJob | null | undefined): boolean {
  return Boolean(job && !TERMINAL_BUILD.has(job.phase));
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadRuntime(): Promise<void> {
  try {
    runtime = await fetchLlamaRuntime();
    runtimeError = null;
  } catch (err) {
    runtime = null;
    runtimeError = errMessage(err, 'Could not read the llama.cpp runtime');
  }
}

async function loadServes(): Promise<void> {
  try {
    llamaServes = (await listModelServes()).filter(
      (s) => s.runtime === 'llama-cpp' && (s.status === 'running' || s.status === 'starting'),
    );
  } catch {
    llamaServes = [];
  }
}

async function loadMlx(): Promise<void> {
  const servers = await fetchManagedServers();
  mlx = servers?.find((s) => s.id === 'mlx-lm') ?? null;
}

async function refreshEngines(): Promise<void> {
  view = await fetchLlamaEngines();
  renderEngineList();
}

// ── Mount ────────────────────────────────────────────────────────────────────

/** Render Models → Engine. */
export async function mountEngineSection(): Promise<void> {
  const mount = body();
  if (!mount) return;
  const generation = ++mountGeneration;
  if (!view) mount.replaceChildren(el('p', 'models-muted', 'Loading…'));

  try {
    const [engines] = await Promise.all([fetchLlamaEngines(), loadRuntime(), loadServes(), loadMlx()]);
    view = engines;
  } catch (err) {
    if (generation !== mountGeneration) return;
    mount.replaceChildren(
      emptyState({
        glyph: 'triangle-warning',
        title: 'Could not read engine settings',
        body: errMessage(err, 'Unknown error.'),
        action: { label: 'Try again', onClick: () => void mountEngineSection() },
      }),
    );
    return;
  }
  if (generation !== mountGeneration) return;

  const llamaBlock = el('section', 'models-block');
  llamaBlock.append(
    el('h3', 'models-block__label', 'llama.cpp engine'),
    el(
      'p',
      'models-hint',
      'Runs GGUF models. The choice applies to the next load; models already loaded keep the engine they started on.',
    ),
  );
  const list = el('div', 'models-engine-list');
  list.id = 'modelsEngineList';
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'llama.cpp engine');
  llamaBlock.appendChild(list);

  const servesBlock = el('section', 'models-block');
  servesBlock.id = 'modelsEngineServes';

  mount.replaceChildren(llamaBlock, customForkBlock(), servesBlock, mlxBlock());
  renderEngineList();
  renderServes();

  if (!buildUnsub) {
    buildUnsub = subscribeLlamaEngineBuild(onBuildEvent);
  }
}

export function teardownEngineSection(): void {
  buildUnsub?.();
  buildUnsub = null;
  mountGeneration += 1;
}

// ── Engine list ──────────────────────────────────────────────────────────────

function renderEngineList(): void {
  const list = document.getElementById('modelsEngineList');
  if (!list || !view) return;
  list.replaceChildren(...view.engines.map((engine) => engineCard(engine)));
}

function engineCard(engine: LlamaEngineStatus): HTMLElement {
  const current = view!;
  const isActive = current.active === engine.id;
  const card = el('article', `models-engine${isActive ? ' is-active' : ''}`);
  card.dataset.engineId = engine.id;

  const pick = el('input', 'models-engine__radio') as HTMLInputElement;
  pick.type = 'radio';
  pick.name = 'modelsLlamaEngine';
  pick.value = engine.id;
  pick.checked = isActive;
  pick.disabled = !engine.supported || !engine.installed;
  pick.id = `modelsEngine-${engine.id}`;
  pick.setAttribute('aria-describedby', `modelsEngineDesc-${engine.id}`);
  pick.addEventListener('change', () => {
    if (pick.checked) void selectEngine(engine);
  });

  const main = el('div', 'models-engine__main');
  const head = el('div', 'models-engine__head');
  const name = el('label', 'models-engine__name', engine.label);
  name.htmlFor = pick.id;
  head.appendChild(name);
  if (isActive) head.appendChild(chip('In use', 'fit-perfect'));
  head.appendChild(
    chip(engine.kind === 'upstream' ? 'Official' : engine.origin === 'custom' ? 'Custom' : 'Fork', 'muted'),
  );
  if (engine.backend) {
    const sm = engine.minCudaSm ? ` · SM ${Math.floor(engine.minCudaSm / 10)}.${engine.minCudaSm % 10}+` : '';
    head.appendChild(chip(`${BACKEND_LABELS[engine.backend]}${sm}`, 'muted'));
  }
  if (!engine.installed && engine.supported) {
    head.appendChild(chip(engine.kind === 'upstream' ? 'Not installed' : 'Not built', 'fit-tight'));
  }
  main.appendChild(head);

  const desc = el('p', 'models-engine__desc');
  desc.id = `modelsEngineDesc-${engine.id}`;
  desc.textContent = engine.description ?? '';
  if (engine.homepage) {
    const link = el('a', 'models-engine__link', engine.repo ?? 'Source');
    link.href = engine.homepage;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    desc.append(engine.description ? ' ' : '', link);
  }
  if (desc.textContent) main.appendChild(desc);

  const facts = engineFacts(engine);
  if (facts) main.appendChild(facts);

  if (!engine.supported && engine.unsupportedReason) {
    main.appendChild(el('p', 'models-hint', engine.unsupportedReason));
  } else if (engine.prereqs && !engine.prereqs.ok && !engine.installed) {
    main.appendChild(prereqList(engine));
  }

  const job = current.build;
  if (job && job.engineId === engine.id && (isBuildRunning(job) || job.phase !== 'completed')) {
    main.appendChild(buildPanel(job));
  }

  const actions = el('div', 'models-engine__actions');
  for (const node of engineActions(engine)) actions.appendChild(node);

  card.append(pick, main, actions);
  return card;
}

function engineFacts(engine: LlamaEngineStatus): HTMLElement | null {
  const facts = el('p', 'models-engine__facts');
  if (engine.kind === 'upstream') {
    if (upstreamInstallMessage) {
      facts.textContent = upstreamInstallMessage;
      return facts;
    }
    if (!runtime) {
      facts.textContent = runtimeError ?? '';
      return runtimeError ? facts : null;
    }
    if (engine.installed) {
      const upstreamVariant = runtime.engineId === 'upstream' ? runtime.variant : null;
      const version = runtime.installedVersion ?? runtime.pinnedVersion;
      facts.textContent = [upstreamVariant, version, engine.binaryPath].filter(Boolean).join(' · ');
      if (runtime.upgradeAvailable) {
        facts.appendChild(
          el(
            'span',
            'models-engine__note',
            ` Installed ${runtime.installedVersion ?? '?'}; Minnow now pins ${runtime.pinnedVersion}.`,
          ),
        );
      }
    } else {
      facts.textContent = `Pinned ${runtime.pinnedVersion} · recommended build: ${runtime.preferredVariant}`;
    }
    return facts;
  }

  if (engine.source === 'local') {
    facts.textContent = engine.installed
      ? (engine.binaryPath ?? '')
      : `Missing: ${engine.binaryPath ?? 'no path set'}`;
    return facts;
  }

  const parts: string[] = [];
  if (engine.installed) {
    if (engine.installKind === 'release' && engine.version) parts.push(`Release ${engine.version}`);
    else if (engine.installedSha) parts.push(`Built at ${shortSha(engine.installedSha)}`);
    if (engine.builtAt) parts.push(new Date(engine.builtAt).toLocaleDateString());
  } else if (engine.pinnedSha) {
    parts.push(`Pinned at ${shortSha(engine.pinnedSha)}`);
  } else if (engine.ref) {
    parts.push(`Ref ${engine.ref}`);
  }
  if (engine.commitsBehind && engine.branch) {
    parts.push(
      `${engine.commitsBehind} newer commit${engine.commitsBehind === 1 ? '' : 's'} on ${engine.branch}`,
    );
  }
  if (engine.cmakeFlags?.length) parts.push(engine.cmakeFlags.join(' '));
  if (!parts.length) return null;
  facts.textContent = parts.join(' · ');
  if (engine.pinUpdateAvailable) {
    facts.appendChild(
      el('span', 'models-engine__note', ` Minnow now pins ${shortSha(engine.pinnedSha)}; rebuild to update.`),
    );
  }
  return facts;
}

function prereqList(engine: LlamaEngineStatus): HTMLElement {
  const wrap = el('div', 'models-engine__prereqs');
  wrap.appendChild(
    el(
      'p',
      'models-hint models-hint--warning',
      engine.origin === 'approved'
        ? 'Building this fork needs these tools installed first:'
        : 'If this fork publishes no release binaries, building it needs:',
    ),
  );
  const list = el('ul', 'models-engine__prereq-list');
  for (const tool of engine.prereqs?.missing ?? []) {
    const item = el('li');
    const link = el('a', 'models-engine__link', tool.tool);
    link.href = tool.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    // target=_blank opens an Electron child window; install docs belong in the user's default browser.
    link.addEventListener('click', (event) => {
      if (!window.minnow?.app?.openExternal) return;
      event.preventDefault();
      void window.minnow.app.openExternal(link.href);
    });
    item.append(link, ` — ${tool.hint}`);
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

function engineActions(engine: LlamaEngineStatus): HTMLElement[] {
  if (engine.kind === 'upstream') return upstreamActions(engine);

  const job = view?.build ?? null;
  const running = isBuildRunning(job);
  const out: HTMLElement[] = [];

  if (engine.source === 'github' && engine.supported) {
    if (running && job?.engineId === engine.id) {
      out.push(
        textButton('Cancel build', () => {
          void cancelLlamaEngineBuild().catch((err: unknown) => {
            setStatus('err', errMessage(err, 'Cancel failed'));
          });
        }),
      );
    } else {
      const toolsMissing = engine.origin === 'approved' && engine.prereqs?.ok === false;
      const label = !engine.installed ? 'Build' : engine.pinUpdateAvailable ? 'Update' : 'Rebuild';
      const primary = textButton(label, () => void startBuild(engine, 'pinned'), engine.installed ? undefined : 'primary');
      primary.disabled = running || toolsMissing;
      if (running) primary.title = 'Another build is running';
      out.push(primary);
      if (engine.origin === 'approved' && engine.commitsBehind) {
        const head = textButton('Build latest', () => void startBuild(engine, 'head'));
        head.title = `Build the tip of ${engine.branch ?? 'the branch'} instead of the commit Minnow tested`;
        head.disabled = running || toolsMissing;
        out.push(head);
      }
    }
  }

  if (engine.origin === 'custom') {
    out.push(textButton('Remove', () => void removeEngine(engine), 'danger'));
  } else if (engine.installed) {
    out.push(textButton('Uninstall', () => void removeEngine(engine), 'danger'));
  }
  return out;
}

function upstreamActions(engine: LlamaEngineStatus): HTMLElement[] {
  if (!runtime) return [];
  const rt = runtime;
  const out: HTMLElement[] = [];
  if (rt.installableVariants.length) {
    const select = el('select', 'models-select models-engine__variant') as HTMLSelectElement;
    select.setAttribute('aria-label', 'llama.cpp build variant');
    const current = rt.engineId === 'upstream' ? (rt.variant ?? rt.preferredVariant) : rt.preferredVariant;
    for (const variant of rt.installableVariants) {
      const option = el('option', undefined, variant) as HTMLOptionElement;
      option.value = variant;
      option.selected = variant === current;
      select.appendChild(option);
    }
    out.push(select);
    const label = rt.upgradeAvailable ? 'Upgrade' : engine.installed ? 'Reinstall' : 'Install';
    const btn = textButton(
      label,
      () => void installUpstream(select.value, label, btn),
      engine.installed && !rt.upgradeAvailable ? undefined : 'primary',
    );
    btn.dataset.llamaInstall = 'upstream';
    btn.disabled = Boolean(upstreamInstallMessage) || !rt.installable;
    out.push(btn);
  }
  return out;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function selectEngine(engine: LlamaEngineStatus): Promise<void> {
  try {
    view = await setActiveLlamaEngine(engine.id);
    notifyLlamaEngineChanged();
    await loadRuntime();
    renderEngineList();
    setStatus(
      'ok',
      llamaServes.length
        ? `Using ${engine.label} for the next load. Loaded models keep running on their current engine.`
        : `Using ${engine.label} for llama.cpp models.`,
    );
  } catch (err) {
    setStatus('err', errMessage(err, 'Could not switch engine'));
    renderEngineList();
  }
}

async function startBuild(engine: LlamaEngineStatus, target: 'pinned' | 'head'): Promise<void> {
  try {
    const { build } = await buildLlamaEngine(engine.id, target);
    if (view) view = { ...view, build };
    renderEngineList();
  } catch (err) {
    setStatus('err', errMessage(err, 'Could not start the build'));
  }
}

async function removeEngine(engine: LlamaEngineStatus): Promise<void> {
  const custom = engine.origin === 'custom';
  const message = custom
    ? `Remove ${engine.label}? ${engine.source === 'github' ? 'Its build is deleted too.' : 'The binary on disk is left alone.'}`
    : `Uninstall ${engine.label}? You can build it again later.`;
  if (!(await appConfirm(message, { confirmLabel: custom ? 'Remove' : 'Uninstall', danger: true }))) return;
  try {
    view = await removeLlamaEngine(engine.id);
    notifyLlamaEngineChanged();
    await loadRuntime();
    renderEngineList();
    setStatus('ok', custom ? `${engine.label} removed` : `${engine.label} uninstalled`);
  } catch (err) {
    setStatus('err', errMessage(err, 'Could not remove engine'));
  }
}

async function installUpstream(variant: string, label: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  upstreamInstallMessage = `${label === 'Upgrade' ? 'Upgrading' : 'Installing'}…`;
  renderEngineList();
  const unsub = subscribeLlamaInstallProgress((job) => {
    if (job.phase !== 'installing') return;
    upstreamInstallMessage = `${job.message || 'Installing'} · ${job.percent}%`;
    const facts = document.querySelector('[data-engine-id="upstream"] .models-engine__facts');
    if (facts) facts.textContent = upstreamInstallMessage;
  });
  try {
    await installLlamaRuntime({ variant, reinstall: label !== 'Install' });
    setStatus('ok', label === 'Upgrade' ? 'llama.cpp upgraded' : 'llama.cpp installed');
  } catch (err) {
    setStatus('err', errMessage(err, 'Install failed'));
  } finally {
    unsub();
    upstreamInstallMessage = null;
    notifyLlamaEngineChanged();
    await loadRuntime();
    await refreshEngines().catch(() => renderEngineList());
  }
}

// ── Build progress ───────────────────────────────────────────────────────────

function buildPanel(job: LlamaEngineBuildJob): HTMLElement {
  const panel = el('div', 'models-engine__build');
  panel.dataset.buildPanel = job.engineId;
  const head = el('div', 'models-engine__build-head');
  const message = el('span', 'models-engine__build-message');
  const meta = el('span', 'models-engine__build-meta');
  head.append(message, meta);
  const progress = el('div', 'models-progress');
  const fill = el('div', 'models-progress__fill');
  progress.appendChild(fill);
  const logWrap = el('details', 'models-engine__log');
  logWrap.open = isBuildRunning(job) || job.phase === 'failed';
  logWrap.appendChild(el('summary', undefined, 'Build log'));
  const log = el('pre', 'models-engine__log-body');
  logWrap.appendChild(log);
  panel.append(head, progress, logWrap);
  patchBuildPanel(panel, job);
  return panel;
}

function patchBuildPanel(panel: HTMLElement, job: LlamaEngineBuildJob): void {
  const running = isBuildRunning(job);
  panel.classList.toggle('is-failed', job.phase === 'failed');
  const message = panel.querySelector<HTMLElement>('.models-engine__build-message');
  const meta = panel.querySelector<HTMLElement>('.models-engine__build-meta');
  const fill = panel.querySelector<HTMLElement>('.models-progress__fill');
  const progress = panel.querySelector<HTMLElement>('.models-progress');
  const log = panel.querySelector<HTMLElement>('.models-engine__log-body');
  if (message) message.textContent = job.error ?? job.message;
  if (meta) {
    meta.textContent = running
      ? `${job.percent}% · ${formatElapsed(job.startedAt)}${job.sha ? ` · ${shortSha(job.sha)}` : ''}`
      : '';
  }
  if (progress) progress.hidden = !running;
  if (fill) fill.style.setProperty('--progress', String(Math.max(0, Math.min(100, job.percent)) / 100));
  if (log) {
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.textContent = job.logTail.join('\n');
    if (stick) log.scrollTop = log.scrollHeight;
  }
}

function onBuildEvent(job: LlamaEngineBuildJob): void {
  if (!view) return;
  const previous = view.build;
  view = { ...view, build: job };
  const panel = document.querySelector<HTMLElement>(`[data-build-panel="${CSS.escape(job.engineId)}"]`);
  const phaseChanged = previous?.phase !== job.phase || previous?.engineId !== job.engineId;

  if (TERMINAL_BUILD.has(job.phase) && phaseChanged) {
    if (job.phase === 'completed') {
      setStatus('ok', job.message);
      notifyLlamaEngineChanged();
    }
    else if (job.phase === 'failed') setStatus('err', `Build failed: ${job.error ?? job.message}`);
    void refreshEngines().catch(() => renderEngineList());
    return;
  }
  if (panel && !phaseChanged) {
    patchBuildPanel(panel, job);
    return;
  }
  renderEngineList();
}

// ── Custom forks ─────────────────────────────────────────────────────────────

function defaultBackend(): Backend {
  const variant = String(runtime?.preferredVariant ?? '').toLowerCase();
  if (variant.includes('cuda')) return 'cuda';
  if (variant.includes('vulkan')) return 'vulkan';
  if (variant.includes('metal')) return 'metal';
  if (variant.includes('rocm')) return 'rocm';
  return 'cpu';
}

function labeled(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('label', 'models-field');
  wrap.append(el('span', 'models-field__label', label), control);
  if (hint) wrap.appendChild(el('span', 'models-hint', hint));
  return wrap;
}

function textInput(placeholder: string): HTMLInputElement {
  const input = el('input', 'models-field__input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function customForkBlock(): HTMLElement {
  const block = el('section', 'models-block');
  const details = el('details', 'models-engine__add');
  details.appendChild(el('summary', 'models-block__label', 'Add a custom fork'));

  const form = el('form', 'models-engine__form');
  form.noValidate = true;

  const nameInput = textInput('My fork');
  const sourceSelect = el('select', 'models-field__input') as HTMLSelectElement;
  for (const [value, label] of [
    ['github', 'GitHub repository'],
    ['local', 'llama-server already on disk'],
  ]) {
    const option = el('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    sourceSelect.appendChild(option);
  }
  const repoInput = textInput('owner/repo or https://github.com/owner/repo');
  const refInput = textInput('Default branch');
  const pathInput = textInput(
    navigator.userAgent.includes('Windows') ? 'C:\\llama.cpp\\build\\bin\\Release\\llama-server.exe' : '/path/to/llama-server',
  );
  const backendSelect = el('select', 'models-field__input') as HTMLSelectElement;
  const initialBackend = defaultBackend();
  for (const [value, label] of Object.entries(BACKEND_LABELS)) {
    const option = el('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    option.selected = value === initialBackend;
    backendSelect.appendChild(option);
  }
  const flagsInput = textInput('-DGGML_CUDA_FA_ALL_QUANTS=ON');

  const repoField = labeled('Repository', repoInput);
  const refField = labeled('Branch, tag or commit', refInput, 'Optional.');
  const pathField = labeled('Path to llama-server', pathInput);
  const flagsField = labeled(
    'Extra CMake flags',
    flagsInput,
    'Optional, for source builds. -DNAME=VALUE pairs separated by spaces. The backend flag is added for you.',
  );

  const syncSource = (): void => {
    const local = sourceSelect.value === 'local';
    repoField.hidden = local;
    refField.hidden = local;
    flagsField.hidden = local;
    pathField.hidden = !local;
  };
  sourceSelect.addEventListener('change', syncSource);
  syncSource();

  const submit = textButton('Add fork', () => {}, 'primary');
  submit.type = 'submit';

  form.append(
    labeled('Name', nameInput),
    labeled('Source', sourceSelect),
    repoField,
    refField,
    pathField,
    labeled('Backend', backendSelect, 'The GPU API this build targets.'),
    flagsField,
    el(
      'p',
      'models-hint',
      'Minnow downloads a fork’s release binaries when it publishes llama.cpp-style ones, and otherwise compiles it on this machine. Only add forks you trust: their code runs with your permissions.',
    ),
    submit,
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const input: CustomLlamaForkInput = {
        label: nameInput.value.trim(),
        source: sourceSelect.value === 'local' ? 'local' : 'github',
        backend: backendSelect.value as Backend,
      };
      if (!input.label) {
        setStatus('err', 'Give the fork a name.');
        nameInput.focus();
        return;
      }
      if (input.source === 'local') {
        input.binaryPath = pathInput.value.trim();
      } else {
        input.repo = repoInput.value.trim();
        input.ref = refInput.value.trim() || undefined;
        input.cmakeFlags = flagsInput.value.trim() || undefined;
        if (!input.repo) {
          setStatus('err', 'Enter the GitHub repository.');
          repoInput.focus();
          return;
        }
        const ok = await appConfirm(
          `Add ${input.repo}? Building it downloads that repository and compiles its code on this machine.`,
          { confirmLabel: 'Add fork' },
        );
        if (!ok) return;
      }
      submit.disabled = true;
      try {
        const result = await addCustomLlamaFork(input);
        view = result;
        renderEngineList();
        form.reset();
        backendSelect.value = initialBackend;
        syncSource();
        setStatus(
          'ok',
          input.source === 'local'
            ? `${input.label} added. Select it to use it.`
            : `${input.label} added. Build it, then select it.`,
        );
      } catch (err) {
        setStatus('err', errMessage(err, 'Could not add the fork'));
      } finally {
        submit.disabled = false;
      }
    })();
  });

  details.appendChild(form);
  block.appendChild(details);
  return block;
}

// ── Loaded serves ────────────────────────────────────────────────────────────

function renderServes(): void {
  const block = document.getElementById('modelsEngineServes');
  if (!block) return;
  block.replaceChildren(el('h3', 'models-block__label', 'Loaded on llama.cpp'));
  if (!llamaServes.length) {
    block.appendChild(el('p', 'models-muted', 'Nothing loaded. Load a model from My models.'));
    return;
  }
  const list = el('div', 'models-path-list');
  for (const serve of llamaServes) {
    const row = el('div', 'models-path-row');
    const engineLabel =
      view?.engines.find((e) => e.id === (serve.engineId ?? 'upstream'))?.label ?? serve.engineId ?? 'llama.cpp';
    row.append(
      el('span', 'models-path-row__path', `${serve.modelLabel} · :${serve.port}`),
      el('span', 'models-path-row__note', engineLabel),
    );
    const stop = textButton('Unload', () => {
      stop.disabled = true;
      void stopModelServe(serve.id)
        .then(async () => {
          setStatus('ok', `${serve.modelLabel} unloaded`);
          await loadServes();
          renderServes();
        })
        .catch((err: unknown) => {
          stop.disabled = false;
          setStatus('err', errMessage(err, 'Could not unload'));
        });
    });
    row.appendChild(stop);
    list.appendChild(row);
  }
  block.appendChild(list);
}

// ── MLX ──────────────────────────────────────────────────────────────────────

function mlxBlock(): HTMLElement {
  const block = el('section', 'models-block');
  block.id = 'modelsEngineMlx';
  renderMlxInto(block);
  return block;
}

async function refreshMlx(): Promise<void> {
  await loadMlx();
  const block = document.getElementById('modelsEngineMlx');
  if (block) renderMlxInto(block);
}

function renderMlxInto(block: HTMLElement): void {
  block.replaceChildren(el('h3', 'models-block__label', 'MLX'));
  const server = mlx;
  if (!server) {
    block.appendChild(el('p', 'models-muted', 'Could not load the MLX runtime status.'));
    return;
  }
  block.dataset.serverId = server.id;

  const head = el('div', 'models-engine__head');
  head.appendChild(el('span', 'models-engine__name', 'mlx-lm'));
  if (server.job?.phase === 'installing') head.appendChild(chip('Installing', 'fit-marginal'));
  else if (server.running) head.appendChild(chip('Running', 'fit-perfect'));
  else if (server.installed) head.appendChild(chip('Stopped', 'muted'));
  else head.appendChild(chip('Not installed', 'muted'));
  if (server.version) head.appendChild(chip(server.version, 'muted'));
  block.append(head, el('p', 'models-engine__desc', server.description));

  if (!server.installed && server.installable === false) {
    const reason = el('p', 'models-hint', server.reason ?? 'MLX is not available on this machine.');
    reason.dataset.serverInstallReason = server.id;
    block.appendChild(reason);
    return;
  }

  const progress = el('p', 'models-hint');
  progress.hidden = true;

  const actions = el('div', 'models-inline-form models-engine__mlx-actions');
  if (!server.installed) {
    const install = textButton('Install', () => void installMlx(install, progress), 'primary');
    install.dataset.serverInstall = server.id;
    actions.appendChild(install);
  } else {
    if (server.running) {
      actions.appendChild(
        textButton('Stop', () => void runMlxAction(() => stopManagedServer(server.id), 'MLX stopped')),
      );
    } else {
      actions.appendChild(
        textButton('Start', () => void runMlxAction(() => startManagedServer(server.id), 'MLX started')),
      );
    }

    const port = el('input', 'models-field__input models-engine__port') as HTMLInputElement;
    port.type = 'number';
    port.min = '1024';
    port.max = '65535';
    port.value = String(server.port);
    port.setAttribute('aria-label', 'MLX port');
    actions.append(
      port,
      textButton('Set port', () => {
        void setManagedServerPort(server.id, Number(port.value)).then((result) => {
          if (result.ok) {
            setStatus('ok', `MLX port set to ${result.port}`);
            void refreshMlx();
          } else {
            setStatus('err', result.error);
          }
        });
      }),
    );

    const auto = el('label', 'models-check');
    const autoInput = el('input') as HTMLInputElement;
    autoInput.type = 'checkbox';
    autoInput.checked = server.autoStart;
    autoInput.addEventListener('change', () => {
      void setManagedServerAutoStart(server.id, autoInput.checked).then((ok) => {
        if (ok) setStatus('ok', autoInput.checked ? 'MLX starts with Minnow' : 'MLX no longer starts with Minnow');
        else {
          autoInput.checked = !autoInput.checked;
          setStatus('err', 'Could not save auto-start');
        }
      });
    });
    auto.append(autoInput, el('span', undefined, 'Start with Minnow'));
    actions.appendChild(auto);

    actions.appendChild(
      textButton(
        'Uninstall',
        () => {
          void (async () => {
            const ok = await appConfirm('Uninstall MLX? This removes its files under ~/.minnow/servers/.', {
              confirmLabel: 'Uninstall',
              danger: true,
            });
            if (!ok) return;
            if (await uninstallManagedServer(server.id)) setStatus('ok', 'MLX uninstalled');
            else setStatus('err', 'Uninstall failed');
            void refreshMlx();
          })();
        },
        'danger',
      ),
    );
  }
  block.append(actions, progress);

  if (server.installed) {
    const logs = el('details', 'models-engine__log');
    logs.appendChild(el('summary', undefined, 'Logs'));
    const pre = el('pre', 'models-engine__log-body', 'Loading…');
    logs.appendChild(pre);
    logs.addEventListener('toggle', () => {
      if (!logs.open) return;
      void fetchManagedServerLogs(server.id).then((lines) => {
        pre.textContent = lines?.length ? lines.join('\n') : 'No log lines yet.';
      });
    });
    block.appendChild(logs);
  }
}

async function runMlxAction(
  action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  okMessage: string,
): Promise<void> {
  const result = await action();
  if (result.ok) setStatus('ok', okMessage);
  else setStatus('err', result.error);
  await refreshMlx();
}

async function installMlx(btn: HTMLButtonElement, progress: HTMLElement): Promise<void> {
  btn.disabled = true;
  progress.hidden = false;
  progress.textContent = 'Starting install…';
  const kick = await installManagedServer('mlx-lm');
  if (!kick.ok) {
    btn.disabled = false;
    progress.hidden = true;
    setStatus('err', kick.error);
    return;
  }
  if (!kick.alreadyInstalled) {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750));
      const job = await fetchServerInstallStatus('mlx-lm');
      if (job?.phase === 'done') break;
      if (job?.phase === 'error') {
        setStatus('err', `Install failed: ${job.error ?? job.message}`);
        break;
      }
      if (job) progress.textContent = job.message || `Installing… ${job.percent}%`;
    }
  }
  await refreshMlx();
}
