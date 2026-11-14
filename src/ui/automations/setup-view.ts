/**
 * Setup screens: PR Reviewer, the other presets, and Custom. Also used to edit.
 */

import {
  createSchedulerJob,
  detectGithubRepository,
  previewAutomationSchedule,
  startAutomation,
  updateSchedulerJob,
  type AutomationJob,
  type ScheduledJob,
  type SchedulerSchedule,
} from '../../scheduler/client';
import {
  PR_INTERVALS,
  PR_PASS_ACTIONS,
  PR_REVIEWERS,
  buildPresetPrompt,
  defaultPresetConfig,
  describePrReviewSteps,
  getAutomationPreset,
  normalizePresetConfig,
  presetCapabilities,
  type AutomationPreset,
} from '../../lib/automation-presets.mjs';
import { describeAnySchedule, parseNaturalSchedule } from '../../lib/natural-schedule.mjs';
import { populateMultiProviderModelSelect } from '../../api/models';
import { decodeModelSelectKey } from '../../lib/model-select-key';
import { mountAuxiliaryModelSelectCombobox, syncAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox } from '../model-select-picker';
import { openWorkspaceFolderPicker } from '../workspace-folder-picker';
import { getWorkspacePath } from '../../state/workspace';
import { button, displayPath, el, enter, icon, toggleSwitch } from './dom';

export interface SetupDraft {
  label?: string;
  prompt?: string;
  scheduleText?: string;
  guidance?: string;
}

interface SetupOptions {
  presetId: string;
  jobId?: string;
  existingJob?: AutomationJob;
  draft?: SetupDraft;
  notify: (state: 'ok' | 'err', message: string) => void;
  onCancel: () => void;
  onBack: () => void;
  onSaved: (jobId: string, runId?: string | null) => void | Promise<void>;
}

let fieldSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++fieldSeq}`;

async function fetchFullJob(jobId: string): Promise<ScheduledJob | null> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return ((await res.json()) as { job?: ScheduledJob }).job ?? null;
}

export function renderSetupView(options: SetupOptions): { root: HTMLElement; dispose: () => void } {
  const preset = options.presetId === 'custom' ? null : getAutomationPreset(options.presetId);
  const editing = Boolean(options.jobId);
  const root = el('div', 'auto-setup');
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const crumbs = el('nav', 'auto-crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const home = el('button', 'auto-crumbs__link', 'Automations');
  home.type = 'button';
  home.addEventListener('click', options.onBack);
  const middle = el('button', 'auto-crumbs__link', editing ? (options.existingJob?.label ?? 'Automation') : 'New');
  middle.type = 'button';
  middle.addEventListener('click', options.onCancel);
  crumbs.append(home, el('span', 'auto-crumbs__sep', '/'), middle, el('span', 'auto-crumbs__sep', '/'), el('span', 'auto-crumbs__here', editing ? 'Edit' : preset?.name ?? 'Custom'));

  const layout = el('div', 'auto-setup__layout');
  const form = el('form', 'auto-setup__form');
  form.noValidate = true;
  const aside = el('aside', 'auto-setup__aside');
  layout.append(form, aside);

  const footer = el('footer', 'auto-setup__footer');
  const footerInner = el('div', 'auto-setup__footer-inner');
  footer.append(footerInner);
  root.append(crumbs, layout, footer);

  // ---------- shared state ----------
  const job = options.existingJob;
  const state = {
    label: job?.label ?? options.draft?.label ?? preset?.name ?? '',
    prompt: options.draft?.prompt ?? '',
    workspacePath: job?.workspacePath ?? (preset?.group === 'github' || preset?.engine === 'pr-review' ? '' : getWorkspacePath() || ''),
    providerId: job?.providerId as string | undefined,
    modelId: job?.modelId as string | undefined,
    modeId: job?.modeId ?? preset?.modeId ?? 'build',
    config: { ...defaultPresetConfig(preset?.id ?? ''), ...(job?.preset?.config ?? {}) } as Record<string, any>,
    customInstructions: Boolean(job?.preset?.customInstructions),
    scheduleText: options.draft?.scheduleText ?? (job ? scheduleToText(job.schedule) : preset ? scheduleToText(preset.schedule) : 'every weekday at 9am'),
    manual: job?.schedule.kind === 'manual',
  };
  if (options.draft?.guidance && preset?.id === 'pr-review') state.config.guidance = options.draft.guidance;
  if (job?.githubWatch && !state.config.repository) state.config.repository = job.githubWatch.repository;

  const refreshers: (() => void)[] = [];
  const refreshAll = () => { for (const fn of refreshers) fn(); };

  // ---------- form helpers ----------
  function section(label: string, help?: string): HTMLElement {
    const node = el('section', 'auto-field');
    const head = el('div', 'auto-field__label', label);
    node.append(head);
    if (help) node.append(el('p', 'auto-field__help', help));
    form.append(node);
    return node;
  }

  function nameField(placeholder: string): void {
    const wrap = el('div', 'auto-name');
    const label = el('label', 'auto-name__label', 'Name');
    const input = el('input', 'auto-name__input');
    input.id = nextId('automation-name');
    label.htmlFor = input.id;
    input.value = state.label;
    input.placeholder = placeholder;
    input.maxLength = 120;
    input.addEventListener('input', () => { state.label = input.value; });
    wrap.append(label, input);
    if (preset) wrap.append(el('p', 'auto-name__lede', preset.summary));
    form.append(wrap);
  }

  function checkoutField(opts: { required: boolean; detectRepo: boolean; locked?: boolean }): void {
    const node = section(opts.detectRepo ? 'Repository' : 'Workspace',
      opts.detectRepo ? 'The local checkout reviewers and agents work in. Its origin decides the GitHub repository; your gh login is used.'
        : 'The folder this automation works in.');
    const row = el('div', 'auto-pathrow');
    const path = el('div', 'auto-input auto-input--path');
    const browse = button('Browse…');
    const repo = el('div', 'auto-input auto-input--repo');
    const repoInput = el('input', 'auto-plain');
    repoInput.id = nextId('automation-repo');
    repoInput.placeholder = 'owner/repository';
    repoInput.setAttribute('aria-label', 'GitHub repository');
    repoInput.value = state.config.repository ?? '';
    const repoStatus = el('span', 'auto-input__status');
    repo.append(icon('gitPullRequest', 14), repoInput, repoStatus);
    row.append(path, browse);
    node.append(row);
    if (opts.detectRepo) node.append(repo);
    const useDefault = button('Use the Scheduler workspace', { variant: 'ghost', small: true });
    if (!opts.required) node.append(useDefault);

    const paint = () => {
      path.replaceChildren(icon('folder', 14), el('span', state.workspacePath ? 'auto-mono' : 'auto-muted', state.workspacePath ? displayPath(state.workspacePath) : opts.required ? 'Choose the local checkout' : 'Scheduler workspace (default)'));
      useDefault.hidden = !state.workspacePath;
    };
    const detect = async () => {
      if (!opts.detectRepo || !state.workspacePath) return;
      repoStatus.className = 'auto-input__status';
      repoStatus.replaceChildren(el('span', 'auto-spin'));
      try {
        const result = await detectGithubRepository(state.workspacePath);
        if (disposed) return;
        if (result.repository && !repoInput.value.trim()) {
          repoInput.value = result.repository;
          state.config.repository = result.repository;
          refreshAll();
        }
        const matches = result.repository && result.repository === repoInput.value.trim().toLowerCase() && result.pushMatches;
        repoStatus.replaceChildren(icon(matches && result.ghReady ? 'check' : 'warning', 13), el('span', undefined,
          matches && result.ghReady ? 'origin matches' : result.error ?? (result.repository ? `origin is ${result.repository}` : 'Not a GitHub checkout')));
        repoStatus.classList.add(matches && result.ghReady ? 'is-ok' : 'is-warn');
      } catch (error) {
        repoStatus.replaceChildren(el('span', undefined, error instanceof Error ? error.message : String(error)));
        repoStatus.classList.add('is-warn');
      }
    };
    repoInput.addEventListener('input', () => { state.config.repository = repoInput.value.trim(); refreshAll(); });
    repoInput.addEventListener('change', () => void detect());
    browse.addEventListener('click', () => {
      void (async () => {
        const result = await openWorkspaceFolderPicker({ initialPath: state.workspacePath || getWorkspacePath() || undefined, title: opts.detectRepo ? 'Choose the repository checkout' : 'Choose a workspace', confirmVerb: 'Choose', elevated: true });
        if (result.cancelled || !result.path || disposed) return;
        state.workspacePath = result.path;
        if (opts.detectRepo) { repoInput.value = ''; state.config.repository = ''; }
        paint();
        refreshAll();
        void detect();
      })();
    });
    useDefault.addEventListener('click', () => { state.workspacePath = ''; paint(); });
    if (opts.locked) {
      browse.disabled = true;
      repoInput.readOnly = true;
      node.append(el('p', 'auto-field__help', 'Repository and checkout are fixed after creating an Issue Watcher. Create a new one to change them.'));
    }
    paint();
    if (state.workspacePath) void detect();
  }

  function scheduleField(opts: { allowManual: boolean }): void {
    const node = section('When does it run?');
    if (opts.allowManual) {
      const tabs = el('div', 'auto-tabs');
      tabs.setAttribute('role', 'radiogroup');
      tabs.setAttribute('aria-label', 'Trigger');
      const make = (manual: boolean, title: string, sub: string) => {
        const tab = el('button', 'auto-tab');
        tab.type = 'button';
        tab.setAttribute('role', 'radio');
        tab.append(el('b', undefined, title), el('span', undefined, sub));
        tab.addEventListener('click', () => { state.manual = manual; paintTabs(); refreshAll(); });
        return tab;
      };
      const scheduled = make(false, 'On a schedule', 'A time or an interval');
      const manualTab = make(true, 'Only when I run it', 'From the hub, with Run now');
      const paintTabs = () => {
        scheduled.setAttribute('aria-checked', String(!state.manual));
        manualTab.setAttribute('aria-checked', String(state.manual));
        when.hidden = state.manual;
      };
      tabs.append(scheduled, manualTab);
      node.append(tabs);
      refreshers.push(paintTabs);
    }
    const when = el('div', 'auto-when');
    const label = el('label', 'auto-field__sublabel', 'In plain words or cron');
    const input = el('input', 'auto-plain');
    input.id = nextId('automation-when');
    label.htmlFor = input.id;
    input.value = state.scheduleText;
    input.placeholder = 'every weekday at 9am';
    const box = el('div', 'auto-input');
    box.append(icon('clock', 14), input);
    const parsed = el('div', 'auto-parsed');
    parsed.setAttribute('aria-live', 'polite');
    when.append(label, box, parsed, el('p', 'auto-field__help', 'Runs while Minnow is open, including from the tray. Missed runs are not replayed.'));
    node.append(when);
    let timer: number | undefined;
    let request = 0;
    const paint = () => {
      const result = parseNaturalSchedule(input.value);
      parsed.className = 'auto-parsed';
      parsed.replaceChildren();
      if (!result.ok) {
        parsed.classList.add('is-error');
        parsed.append(icon('warning', 13), el('span', undefined, result.error));
        return;
      }
      parsed.classList.add('is-ok');
      const next = el('span', 'auto-parsed__next');
      parsed.append(icon('check', 13), el('b', undefined, result.description), el('span', 'auto-mono auto-muted', result.schedule.kind === 'cron' ? result.schedule.value : ''), el('span', 'auto-spacer'), next);
      enter(parsed);
      const mine = ++request;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void previewAutomationSchedule(result.schedule).then((preview) => {
          if (mine !== request || disposed) return;
          next.textContent = preview.nextRunAt ? `Next: ${formatNext(preview.nextRunAt)}` : '';
        }).catch((error) => {
          if (mine !== request || disposed) return;
          parsed.className = 'auto-parsed is-error';
          parsed.replaceChildren(icon('warning', 13), el('span', undefined, error instanceof Error ? error.message : String(error)));
        });
      }, 250);
    };
    input.addEventListener('input', () => { state.scheduleText = input.value; paint(); refreshAll(); });
    paint();
  }

  function modelField(): void {
    const node = section('Model', 'Leave on the menubar default to use whichever model you last chose in a chat.');
    const select = el('select', 'settings-select auto-select');
    select.id = nextId('automation-model');
    select.setAttribute('aria-label', 'Model');
    select.innerHTML = '<option value="">Loading models…</option>';
    node.append(select);
    mountAuxiliaryModelSelectCombobox(select);
    cleanups.push(() => unmountAuxiliaryModelSelectCombobox(select));
    select.addEventListener('change', () => {
      const decoded = decodeModelSelectKey(select.value);
      state.providerId = decoded?.providerId || undefined;
      state.modelId = decoded?.modelId || undefined;
    });
    void (async () => {
      await populateMultiProviderModelSelect(select, {
        selectedProviderId: state.providerId, selectedModelId: state.modelId, includeEmptyOption: true, emptyLabel: 'Menubar default',
      });
      if (select.isConnected) syncAuxiliaryModelSelectCombobox(select);
    })();
  }

  function toggleRow(parent: HTMLElement, title: string, help: string, key: string): void {
    const row = el('div', 'auto-toggle');
    const text = el('div', 'auto-toggle__text');
    text.append(el('div', 'auto-toggle__title', title), el('p', 'auto-field__help', help));
    row.append(text, toggleSwitch(title, Boolean(state.config[key]), (on) => { state.config[key] = on; refreshAll(); }));
    parent.append(row);
  }

  function instructionsField(opts: { editable: boolean }): void {
    const node = section('Instructions');
    const head = node.querySelector('.auto-field__label')!;
    const note = el('span', 'auto-field__note', state.customInstructions ? 'Your own words' : 'Written from the options above');
    const edit = button(state.customInstructions ? 'Use written instructions' : 'Edit', { variant: 'ghost', small: true });
    head.append(note, el('span', 'auto-spacer'), edit);
    edit.hidden = !opts.editable;
    const pre = el('pre', 'auto-instructions');
    const area = el('textarea', 'auto-textarea');
    area.setAttribute('aria-label', 'Instructions');
    area.rows = 10;
    node.append(pre, area);
    const paint = () => {
      const written = preset ? buildPresetPrompt(preset.id, safeConfig()) : '';
      pre.textContent = written;
      pre.hidden = state.customInstructions;
      area.hidden = !state.customInstructions;
      if (state.customInstructions && !area.value) area.value = state.prompt || written;
      note.textContent = state.customInstructions ? 'Your own words — the options above no longer rewrite them' : 'Written from the options above';
      edit.replaceChildren(el('span', undefined, state.customInstructions ? 'Use written instructions' : 'Edit'));
    };
    area.addEventListener('input', () => { state.prompt = area.value; });
    edit.addEventListener('click', () => {
      state.customInstructions = !state.customInstructions;
      if (!state.customInstructions) area.value = '';
      paint();
      if (state.customInstructions) area.focus();
    });
    if (job?.preset?.customInstructions) {
      void fetchFullJob(job.id).then((full) => { if (full && !disposed) { state.prompt = full.prompt; area.value = full.prompt; } });
    }
    refreshers.push(paint);
    paint();
  }

  function safeConfig(): Record<string, any> {
    try { return normalizePresetConfig(preset!.id, { ...state.config, repository: state.config.repository || 'owner/repository' }); }
    catch { return { ...defaultPresetConfig(preset!.id), ...state.config }; }
  }

  // ---------- forms ----------
  if (preset?.id === 'pr-review') buildPrReview();
  else if (preset) buildPreset(preset);
  else buildCustom();

  function buildPrReview(): void {
    nameField('PR Reviewer');
    checkoutField({ required: true, detectRepo: true });

    const interval = section('Check for new PRs', 'Open PRs are picked oldest first, one per run.');
    const seg = el('div', 'auto-seg auto-seg--mono');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Check interval');
    for (const value of PR_INTERVALS) {
      const b = el('button', undefined, value);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => { state.config.interval = value; refreshAll(); });
      refreshers.push(() => b.setAttribute('aria-checked', String(state.config.interval === value)));
      seg.append(b);
    }
    interval.append(seg);

    const coord = section('Working alongside other agents');
    toggleRow(coord, 'Claim a PR before reviewing', 'Comments “Review in progress”, waits 5 s and re-reads the thread. If another agent claimed it first, this one deletes its comment and backs off.', 'claim');
    toggleRow(coord, 'Skip PRs that already have a comment', 'Leaves PRs alone once a person or another agent has started the conversation.', 'skipCommented');
    toggleRow(coord, 'Skip drafts', 'Drafts are reviewed once they are marked ready.', 'skipDrafts');

    const rev = section('Reviewers', 'Each runs in parallel on its own and reports pass or findings with file and line. Open any of them from the run.');
    const chips = el('div', 'auto-checks');
    for (const reviewer of PR_REVIEWERS) {
      const c = el('button', 'auto-check');
      c.type = 'button';
      c.title = reviewer.brief;
      const box = el('span', 'auto-check__box');
      box.append(icon('check', 10));
      c.append(box, el('span', undefined, reviewer.label));
      c.addEventListener('click', () => {
        const set = new Set<string>(state.config.reviewers ?? []);
        if (set.has(reviewer.id)) set.delete(reviewer.id); else set.add(reviewer.id);
        state.config.reviewers = PR_REVIEWERS.map((r) => r.id).filter((id) => set.has(id));
        refreshAll();
      });
      refreshers.push(() => {
        const on = (state.config.reviewers ?? []).includes(reviewer.id);
        c.setAttribute('aria-pressed', String(on));
        c.classList.toggle('is-on', on);
      });
      chips.append(c);
    }
    rev.append(chips);

    const pass = section('When a PR passes', 'Branch protection and required checks still apply.');
    const opts = el('div', 'auto-options');
    opts.setAttribute('role', 'radiogroup');
    opts.setAttribute('aria-label', 'When a PR passes');
    for (const action of PR_PASS_ACTIONS) {
      const o = el('button', 'auto-option');
      o.type = 'button';
      o.setAttribute('role', 'radio');
      const text = el('span');
      text.append(el('b', undefined, action.label), el('span', 'auto-option__detail', action.detail));
      o.append(el('span', 'auto-option__radio'), text);
      o.addEventListener('click', () => { state.config.onPass = action.id; refreshAll(); });
      refreshers.push(() => {
        const on = state.config.onPass === action.id;
        o.setAttribute('aria-checked', String(on));
        o.classList.toggle('is-on', on);
      });
      opts.append(o);
    }
    pass.append(opts);
    const failLabel = el('label', 'auto-field__sublabel', 'When it doesn’t');
    const fail = el('select', 'settings-select auto-select');
    fail.id = nextId('automation-fail');
    failLabel.htmlFor = fail.id;
    fail.innerHTML = '<option value="request_changes">Request changes, listing each blocking finding</option><option value="comment">Comment with the findings only</option>';
    fail.value = state.config.onFail ?? 'request_changes';
    fail.addEventListener('change', () => { state.config.onFail = fail.value; refreshAll(); });
    pass.append(failLabel, fail);

    instructionsField({ editable: false });
    const guide = section('Guidance for reviewers', 'Optional. Repository-specific rules every reviewer should know.');
    const area = el('textarea', 'auto-textarea');
    area.rows = 3;
    area.setAttribute('aria-label', 'Guidance for reviewers');
    area.placeholder = 'Public APIs need a changelog entry. Ignore generated files under dist/.';
    area.value = state.config.guidance ?? '';
    area.addEventListener('input', () => { state.config.guidance = area.value; refreshAll(); });
    guide.append(area);
    modelField();

    // Rail: the steps of one run, recomputed as options change.
    const card = el('div', 'auto-steps-card');
    const eyebrow = el('div', 'auto-rail__eyebrow');
    const steps = el('ol', 'auto-steps');
    const canHead = el('div', 'auto-rail__eyebrow');
    const cans = el('div', 'auto-cans');
    const warn = el('p', 'auto-warn');
    card.append(eyebrow, steps, canHead, cans, warn);
    aside.append(card, el('p', 'auto-field__help', 'Reviewers only read and run checks. Comments, reviews and merges come from the PR Reviewer itself, using your gh login.'));
    let lastStepsKey = '';
    refreshers.push(() => {
      const config = safeConfig();
      eyebrow.textContent = `Each run, every ${config.interval}`;
      const list = describePrReviewSteps(config);
      const key = list.map((s) => s.title + s.detail).join('|');
      if (key !== lastStepsKey) {
        const before = new Set([...steps.children].map((n) => (n as HTMLElement).dataset.key));
        steps.replaceChildren(...list.map((step, index) => {
          const li = el('li', 'auto-step');
          li.dataset.key = step.title;
          li.append(el('span', 'auto-step__n', String(index + 1)));
          const t = el('div');
          t.append(el('b', undefined, step.title), el('span', undefined, step.detail));
          li.append(t);
          if (lastStepsKey && !before.has(step.title)) enter(li);
          return li;
        }));
        lastStepsKey = key;
      }
      canHead.textContent = `On ${config.repository === 'owner/repository' ? 'the repository' : config.repository} it can`;
      cans.replaceChildren(...presetCapabilities('pr-review', config).map((c) => el('span', 'auto-can', c)));
      warn.hidden = config.onPass !== 'merge';
      warn.replaceChildren(icon('warning', 13), el('span', undefined, 'Merges without a person looking. The merge queue is the safer choice.'));
    });
  }

  function buildPreset(p: AutomationPreset): void {
    nameField(p.name);
    const github = p.group === 'github';
    checkoutField({ required: github, detectRepo: github, locked: editing && p.engine === 'github-watch' });
    const own = p.fields.filter((f) => f.key !== 'repository');
    if (own.length) {
      const opts = section('Options');
      for (const field of own) {
        if (field.type === 'toggle') {
          toggleRow(opts, field.label, field.help ?? '', field.key);
        } else {
          const label = el('label', 'auto-field__sublabel', field.label);
          const input = el('input', 'auto-input auto-input--text');
          input.id = nextId(`automation-${field.key}`);
          label.htmlFor = input.id;
          input.placeholder = field.placeholder ?? '';
          input.value = state.config[field.key] ?? '';
          input.addEventListener('input', () => { state.config[field.key] = input.value; refreshAll(); });
          opts.append(label, input);
          if (field.help) opts.append(el('p', 'auto-field__help', field.help));
        }
      }
    }
    scheduleField({ allowManual: false });
    if (p.engine === 'github-watch') {
      const guide = section('Additional guidance', 'Optional. Repository-specific constraints for the planning agent.');
      const area = el('textarea', 'auto-textarea');
      area.rows = 4;
      area.setAttribute('aria-label', 'Additional guidance');
      area.value = state.config.guidance ?? '';
      area.addEventListener('input', () => { state.config.guidance = area.value; });
      guide.append(area);
      aside.append(railList('Each run', [
        ['Pick the oldest open issue labeled minnow', 'One issue at a time per repository.'],
        ['Plan it in a separate worktree', 'A planning agent triages the issue and writes a board plan.'],
        ['Build and test on a board', 'Builder and Tester agents implement the plan.'],
        ['Open a PR', 'Only when every task merged and the final test passed. You review and merge it.'],
      ]));
    } else {
      instructionsField({ editable: true });
      aside.append(capabilitiesCard(p));
    }
    modelField();
  }

  function buildCustom(): void {
    nameField('Standup digest');
    const what = section('What should it do each run?', 'Nobody is there to answer questions, so say what to produce and where it goes.');
    const box = el('div', 'auto-composer');
    const area = el('textarea', 'auto-composer__input');
    area.rows = 6;
    area.setAttribute('aria-label', 'Instructions');
    area.placeholder = 'Summarize what changed in this repo since the last run: merged PRs, new issues, and CI failures. Append it to the Brain page “Standups” under today’s date.';
    area.value = state.prompt;
    const count = el('div', 'auto-composer__bar');
    const chars = el('span', 'auto-mono auto-muted');
    count.append(chars);
    box.append(area, count);
    what.append(box);
    const paintCount = () => { chars.textContent = `${area.value.length.toLocaleString()} / 32,000`; };
    area.addEventListener('input', () => { state.prompt = area.value; paintCount(); refreshAll(); });
    if (job) void fetchFullJob(job.id).then((full) => { if (full && !disposed) { state.prompt = full.prompt; area.value = full.prompt; paintCount(); refreshAll(); } });
    paintCount();
    scheduleField({ allowManual: true });
    checkoutField({ required: false, detectRepo: false });
    const mode = section('Mode');
    const select = el('select', 'settings-select auto-select');
    select.setAttribute('aria-label', 'Mode');
    select.innerHTML = '<option value="build">Build — can edit files and run commands</option><option value="general">General — read, search and write notes</option><option value="plan">Plan — writes plans only</option>';
    select.value = ['build', 'general', 'plan'].includes(state.modeId) ? state.modeId : 'build';
    select.addEventListener('change', () => { state.modeId = select.value; });
    mode.append(select);
    modelField();

    const card = el('div', 'auto-steps-card');
    card.append(el('div', 'auto-rail__eyebrow', 'Ready to run unattended?'));
    const checks = el('ul', 'auto-checklist');
    const summary = el('p', 'auto-field__help');
    card.append(checks, summary);
    aside.append(card);
    refreshers.push(() => {
      const text = state.prompt;
      const items: [boolean | null, string][] = [
        [text.trim().length > 20, 'Describes the job in a sentence or more'],
        [/\b(brain|file|write|append|save|issue|comment|report|summar|post|pull request|\bpr\b|log)/i.test(text), 'Says what to produce and where it goes'],
        [!/\b(ask me|confirm with me|check with me|wait for me|let me know before)\b/i.test(text), 'Doesn’t need answers from you mid-run'],
        [null, 'Uses your permission mode. Runs can’t stop to ask questions.'],
      ];
      checks.replaceChildren(...items.map(([ok, label]) => {
        const li = el('li', ok === null ? 'is-info' : ok ? 'is-ok' : 'is-warn');
        li.append(icon(ok === null ? 'info' : ok ? 'check' : 'warning', 13), el('span', undefined, label));
        return li;
      }));
      const parsed = parseNaturalSchedule(state.scheduleText);
      const when = state.manual ? 'When you run it' : parsed.ok ? parsed.description : 'On a schedule you still need to set';
      summary.textContent = `${when}, an agent in ${state.workspacePath ? displayPath(state.workspacePath) : 'the Scheduler workspace'} follows these instructions${state.prompt.trim() ? '' : ' (not written yet)'}.`;
    });
  }

  function railList(title: string, rows: [string, string][]): HTMLElement {
    const card = el('div', 'auto-steps-card');
    card.append(el('div', 'auto-rail__eyebrow', title));
    const list = el('ol', 'auto-steps');
    rows.forEach(([t, d], index) => {
      const li = el('li', 'auto-step');
      li.append(el('span', 'auto-step__n', String(index + 1)));
      const body = el('div');
      body.append(el('b', undefined, t), el('span', undefined, d));
      li.append(body);
      list.append(li);
    });
    card.append(list);
    return card;
  }

  function capabilitiesCard(p: AutomationPreset): HTMLElement {
    const card = el('div', 'auto-steps-card');
    card.append(el('div', 'auto-rail__eyebrow', 'Runs'));
    const when = el('p', 'auto-rail__strong');
    card.append(when, el('div', 'auto-rail__eyebrow', 'It can'));
    const cans = el('div', 'auto-cans');
    cans.append(...presetCapabilities(p.id).map((c) => el('span', 'auto-can', c)));
    card.append(cans, el('p', 'auto-field__help', 'Runs that find nothing to do stay quiet: no notification, a small grey tick in the hub.'));
    refreshers.push(() => {
      const parsed = parseNaturalSchedule(state.scheduleText);
      when.textContent = parsed.ok ? parsed.description : 'Set a schedule';
    });
    return card;
  }

  // ---------- footer ----------
  const primary = button(editing ? 'Save changes' : preset ? 'Start automation' : 'Create automation', { variant: 'primary' });
  primary.type = 'submit';
  const runOnce = button('Run once now', {});
  runOnce.hidden = editing || Boolean(preset);
  const cancel = button('Cancel', { variant: 'ghost' });
  const status = el('span', 'auto-setup__status');
  status.setAttribute('role', 'status');
  footerInner.append(primary, runOnce, cancel, el('span', 'auto-spacer'), status);
  if (!editing && preset) status.textContent = 'The first run starts right after you start it.';
  cancel.addEventListener('click', options.onCancel);
  form.addEventListener('submit', (event) => { event.preventDefault(); void save(Boolean(preset) && !editing); });
  primary.addEventListener('click', (event) => { event.preventDefault(); void save(Boolean(preset) && !editing); });
  runOnce.addEventListener('click', () => void save(true));

  function buildSchedule(): SchedulerSchedule {
    if (preset?.id === 'pr-review') return { kind: 'interval', value: state.config.interval ?? '2m' };
    if (!preset && state.manual) return { kind: 'manual', value: 'manual' };
    const parsed = parseNaturalSchedule(state.scheduleText);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.schedule as SchedulerSchedule;
  }

  async function save(startNow: boolean): Promise<void> {
    status.classList.remove('is-err');
    try {
      const label = state.label.trim() || preset?.name || '';
      if (!label) throw new Error('Give it a name.');
      const schedule = buildSchedule();
      const payload: Partial<ScheduledJob> & Record<string, unknown> = {
        label,
        schedule,
        modeId: state.modeId,
        providerId: state.modelId ? state.providerId ?? '' : '',
        modelId: state.modelId ?? '',
        workspacePath: state.workspacePath || undefined,
        channels: ['in_app'],
      };
      if (preset) {
        if (preset.group === 'github' && !state.workspacePath) throw new Error('Choose the local checkout of the repository.');
        const config = normalizePresetConfig(preset.id, state.config);
        payload.preset = { id: preset.id, config, customInstructions: state.customInstructions };
        payload.prompt = state.customInstructions ? state.prompt : '';
        if (preset.id === 'pr-review' && !config.reviewers.length && !confirmNoReviewers()) return;
      } else {
        if (!state.prompt.trim()) throw new Error('Write what it should do each run.');
        payload.prompt = state.prompt;
      }
      primary.disabled = true;
      status.textContent = editing ? 'Saving…' : 'Creating…';
      let jobId: string;
      if (editing) {
        if (job?.githubWatch) delete payload.workspacePath;
        jobId = (await updateSchedulerJob(options.jobId!, payload)).id;
      } else {
        jobId = (await createSchedulerJob({ enabled: true, prompt: '', modeId: state.modeId, ...payload } as Parameters<typeof createSchedulerJob>[0])).id;
      }
      let runId: string | null | undefined;
      if (startNow) runId = (await startAutomation(jobId)).runId;
      options.notify('ok', editing ? 'Saved' : startNow ? `${label} started` : `${label} created`);
      await options.onSaved(jobId, runId);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.classList.add('is-err');
    } finally {
      primary.disabled = false;
    }
  }

  function confirmNoReviewers(): boolean {
    status.textContent = 'Pick at least one reviewer.';
    status.classList.add('is-err');
    return false;
  }

  refreshAll();
  enter(layout);
  window.setTimeout(() => {
    const name = form.querySelector<HTMLInputElement>('.auto-name__input');
    name?.focus();
    name?.setSelectionRange(0, 0);
    if (name) name.scrollLeft = 0;
  }, 0);

  return {
    root,
    dispose() {
      disposed = true;
      for (const fn of cleanups) fn();
    },
  };
}

function scheduleToText(schedule: { kind: string; value: string }): string {
  if (schedule.kind === 'interval') return describeAnySchedule(schedule).replace(/^Every/, 'every');
  if (schedule.kind === 'manual') return 'every weekday at 9am';
  const described = describeAnySchedule(schedule);
  return described.startsWith('Cron ') ? schedule.value : described.toLowerCase().replace(/:00 (am|pm)/, '$1').replace(/ (am|pm)$/, '$1');
}

function formatNext(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
