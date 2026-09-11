/**
 * The card at the top of a run that asks the user for something: interview
 * questions, the spec and plan checkpoints, a halted stage. It is rebuilt only
 * when the ask changes, so typed answers and notes survive every view update.
 */

import type {
  SuperPlanAnswerEntry,
  SuperPlanQuestionItem,
  SuperPlanRunView,
  SuperPlanStageId,
} from '../../chat/super-plan/types';
import { baseName, button, el, ICON, reportActionError, svg } from './dom';

export const OTHER_OPTION_ID = '__other__';

export interface CheckpointHandlers {
  answerQuestions: (questionId: string, answers: SuperPlanAnswerEntry[]) => Promise<unknown>;
  stopQuestions: () => Promise<unknown>;
  confirmSpec: () => Promise<unknown>;
  reviseSpec: (notes: string) => Promise<unknown>;
  acceptPlan: () => Promise<unknown>;
  revisePlan: (notes: string) => Promise<unknown>;
  reviewAgain: () => Promise<unknown>;
  retry: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  cancel: () => Promise<unknown>;
  skip: (stage: SuperPlanStageId) => Promise<unknown>;
  showTab: (tab: 'activity' | 'spec' | 'research' | 'plan' | 'review') => void;
  openFile: (path: string) => void;
  orchestrate: (path: string) => void;
  build: (path: string) => void;
}

/** Which card a view calls for, and the identity that keeps it stable. */
export function checkpointKey(view: SuperPlanRunView): string {
  if (view.needsInput) return `ask:${view.attentionKey}`;
  if (view.status === 'done') return `done:${view.artifacts.plan?.sha256 ?? ''}`;
  if (view.status === 'cancelled' || view.status === 'failed' || view.status === 'legacy') return `end:${view.status}`;
  if (view.status === 'paused') return `paused:${view.current ?? ''}`;
  if (view.startFailure) return `start:${view.startFailure.message}`;
  return '';
}

export class CheckpointCard {
  private key = '';
  private card: HTMLElement | null = null;
  private pausedNote: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: CheckpointHandlers,
  ) {
    host.className = 'sp-checkhost';
  }

  update(view: SuperPlanRunView): void {
    const key = checkpointKey(view);
    if (key !== this.key) {
      this.key = key;
      this.card?.remove();
      this.card = key ? this.build(view) : null;
      if (this.card) this.host.replaceChildren(this.card);
      else this.host.replaceChildren();
    }
    this.host.hidden = !this.card;
    if (this.pausedNote) this.pausedNote.hidden = view.status !== 'paused';
  }

  private build(view: SuperPlanRunView): HTMLElement | null {
    this.pausedNote = null;
    if (view.needsInput === 'question' && view.question) return this.buildQuestions(view);
    if (view.needsInput === 'spec') return this.buildSpec();
    if (view.needsInput === 'accept') return this.buildAccept(view);
    if (view.needsInput === 'halted' && view.halted) return this.buildHalted(view);
    if (view.status === 'done') return this.buildDone(view);
    if (view.status === 'paused') return this.buildNotice('Paused', `Nothing runs until you resume. ${view.currentLabel ? `${view.currentLabel} picks up where it stopped.` : ''}`, [button('Resume', () => this.run(this.handlers.resume), { variant: 'primary', icon: ICON.play })]);
    if (view.status === 'cancelled') return this.buildNotice('Cancelled', 'Files the plan wrote are kept. Start a new plan to continue the work.');
    if (view.status === 'failed') return this.buildNotice('Stopped', 'This run ended before the plan was accepted. Files it wrote are kept.');
    if (view.status === 'legacy') return this.buildNotice('Older plan', 'This plan was made by an earlier version of Super Plan and cannot continue. Its files are kept.');
    if (view.startFailure) return this.buildNotice('Could not start', view.startFailure.message, [], 'danger');
    return null;
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      await reportActionError(err);
    }
  }

  private shell(kind: string, eyebrow: string, title: string, lede?: string): { card: HTMLElement; body: HTMLElement } {
    const card = el('section', `sp-check sp-check--${kind}`);
    const titleId = `sp-check-${kind}-title`;
    card.setAttribute('aria-labelledby', titleId);
    const head = el('header', 'sp-check__head');
    head.append(el('p', 'sp-check__eyebrow', eyebrow));
    const heading = el('h2', 'sp-check__title', title);
    heading.id = titleId;
    head.append(heading);
    if (lede) head.append(el('p', 'sp-check__lede', lede));
    const body = el('div', 'sp-check__body');
    card.append(head, body);
    return { card, body };
  }

  private buildNotice(label: string, text: string, actions: HTMLElement[] = [], tone?: 'danger'): HTMLElement {
    const card = el('section', `sp-check sp-check--notice${tone ? ` sp-check--${tone}` : ''}`);
    card.setAttribute('role', tone ? 'alert' : 'status');
    const row = el('div', 'sp-check__noticerow');
    const copy = el('p', 'sp-check__noticecopy');
    copy.append(el('strong', undefined, label), document.createTextNode(` ${text}`));
    row.append(copy);
    if (actions.length) {
      const wrap = el('div', 'sp-check__actions sp-check__actions--inline');
      wrap.append(...actions);
      row.append(wrap);
    }
    card.append(row);
    return card;
  }

  private pausedHint(): HTMLElement {
    const note = el('p', 'sp-check__paused', 'The run is paused. Answering resumes it.');
    note.hidden = true;
    this.pausedNote = note;
    return note;
  }

  // ── Questions ──────────────────────────────────────────────────────────────

  private buildQuestions(view: SuperPlanRunView): HTMLElement {
    const question = view.question!;
    const asked = view.questions.filter((q) => q.status !== 'cancelled').length;
    const { card, body } = this.shell(
      'question',
      `Interview · batch ${asked + 1}`,
      question.title?.trim() || (question.questions.length === 1 ? 'One question' : `${question.questions.length} questions`),
      'Only what the repository could not answer. Pick an option or write your own.',
    );
    body.append(this.pausedHint());
    const form = el('form', 'sp-qform');
    form.noValidate = true;
    const readers = question.questions.map((item, index) => appendQuestion(form, item, index, question.questionId));
    const error = el('p', 'sp-check__error');
    error.setAttribute('role', 'alert');
    const actions = el('div', 'sp-check__actions');
    const hasRecommended = question.questions.some((q) => q.options.some((o) => o.recommended));
    if (hasRecommended) {
      const fill = button('Use recommended', () => {
        for (const reader of readers) reader.applyRecommended();
        error.textContent = '';
      }, { variant: 'quiet', title: 'Select the option the planner recommends for every question' });
      actions.append(fill);
    }
    if (view.actions.stopQuestions) {
      actions.append(
        button('Stop asking', () => this.run(this.handlers.stopQuestions), {
          variant: 'quiet',
          title: 'Skip the remaining questions; the spec is written with what is known so far',
        }),
      );
    }
    const spacer = el('span', 'sp-check__spacer');
    const send = button('Send answers', () => undefined, { variant: 'primary' });
    send.type = 'submit';
    actions.append(spacer, send);
    form.append(error, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const answers: SuperPlanAnswerEntry[] = [];
      for (const reader of readers) {
        const answer = reader.read();
        if (!answer) {
          error.textContent = `Answer "${reader.prompt}" or write your own.`;
          reader.focus();
          return;
        }
        answers.push(answer);
      }
      error.textContent = '';
      send.disabled = true;
      void this.handlers
        .answerQuestions(question.questionId, answers)
        .catch((err) => {
          error.textContent = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          if (send.isConnected) send.disabled = false;
        });
    });
    body.append(form);
    return card;
  }

  // ── Spec ───────────────────────────────────────────────────────────────────

  /** The spec itself sits under the card, with its path and editor link. */
  private buildSpec(): HTMLElement {
    const { card, body } = this.shell(
      'spec',
      'Checkpoint 1 of 2',
      'Review the build spec',
      'Everything after this builds from it. Read it below, then confirm it or ask for changes.',
    );
    body.append(this.pausedHint());
    body.append(
      reviseArea({
        label: 'What should change in the spec?',
        placeholder: 'Scope, decisions, requirements, anything that reads wrong.',
        submitLabel: 'Revise spec',
        onSubmit: (notes) => this.handlers.reviseSpec(notes),
        primary: button('Confirm spec', () => this.run(this.handlers.confirmSpec), { variant: 'primary', icon: ICON.check }),
        extra: [button('Read spec', () => this.handlers.showTab('spec'), { variant: 'quiet' })],
      }),
    );
    return card;
  }

  // ── Accept ─────────────────────────────────────────────────────────────────

  private buildAccept(view: SuperPlanRunView): HTMLElement {
    const plan = view.artifacts.plan;
    const facts: string[] = [];
    if (plan?.tasks) facts.push(`${plan.tasks} task${plan.tasks === 1 ? '' : 's'}`);
    facts.push(reviewSummary(view));
    const { card, body } = this.shell('accept', 'Checkpoint 2 of 2', 'Review the plan', facts.filter(Boolean).join(' · '));
    body.append(this.pausedHint());
    const warnings = el('ul', 'sp-check__warnings');
    if (view.openFindings.length) {
      const item = el('li');
      const link = el('button', 'sp-link', `${view.openFindings.length} review finding${view.openFindings.length === 1 ? ' is' : 's are'} still open`);
      link.type = 'button';
      link.addEventListener('click', () => this.handlers.showTab('review'));
      item.append(link, document.createTextNode('. Check them before you accept.'));
      warnings.append(item);
    }
    if (view.disputedClaims.length) {
      warnings.append(el('li', undefined, `The last revision claims to fix ${view.disputedClaims.length} finding${view.disputedClaims.length === 1 ? '' : 's'} the reviewer still reports.`));
    }
    if (warnings.childElementCount) body.append(warnings);
    body.append(
      reviseArea({
        label: 'What should change in the plan?',
        placeholder: 'Tasks to split or merge, missing work, ordering, tests, anything that reads wrong.',
        submitLabel: 'Revise plan',
        onSubmit: (notes) => this.handlers.revisePlan(notes),
        primary: button('Accept plan', () => this.run(this.handlers.acceptPlan), { variant: 'primary', icon: ICON.check }),
        extra: [
          button('Review again', () => this.run(this.handlers.reviewAgain), {
            variant: 'quiet',
            title: 'Run one more review round, then come back here',
          }),
        ],
      }),
    );
    return card;
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  private buildDone(view: SuperPlanRunView): HTMLElement {
    const plan = view.artifacts.plan;
    const { card, body } = this.shell('done', 'Plan accepted', plan?.title ?? view.title, plan ? 'Hand it to a board, build it in a chat, or keep editing the file.' : undefined);
    if (!plan) return card;
    body.append(fileLine(plan.title ?? baseName(plan.path), plan.path, this.handlers));
    const actions = el('div', 'sp-check__actions');
    actions.append(
      button('Request changes', () => {
        actions.replaceWith(
          reviseArea({
            label: 'What should change in the plan?',
            placeholder: 'The plan reopens and is revised from your notes.',
            submitLabel: 'Revise plan',
            onSubmit: (notes) => this.handlers.revisePlan(notes),
            startOpen: true,
          }),
        );
      }, { variant: 'quiet' }),
      el('span', 'sp-check__spacer'),
      button('Build in a chat', () => this.handlers.build(plan.path)),
      button('Start Orchestrator', () => this.handlers.orchestrate(plan.path), {
        variant: 'primary',
        disabled: plan.executable === false,
        title: plan.executable === false ? 'The board cannot parse this plan' : 'Open a board that runs these tasks',
      }),
    );
    body.append(actions);
    return card;
  }

  // ── Halted ─────────────────────────────────────────────────────────────────

  private buildHalted(view: SuperPlanRunView): HTMLElement {
    const halted = view.halted!;
    const { card, body } = this.shell(
      'halted',
      'Needs attention',
      `${halted.label} stopped after repeated failures`,
      'Earlier stages and their files are kept. Retry starts the stage again from where it stopped, with a fresh set of attempts.',
    );
    card.setAttribute('role', 'alert');
    const detail = [halted.summary, ...halted.errors].filter((line): line is string => Boolean(line && line.trim()));
    if (detail.length) {
      const list = el('ul', 'sp-check__errors');
      for (const line of [...new Set(detail)].slice(0, 6)) list.append(el('li', undefined, line));
      body.append(list);
    }
    const actions = el('div', 'sp-check__actions');
    actions.append(
      button('Cancel plan', () => this.run(this.handlers.cancel), { variant: 'quiet' }),
      button('Show what happened', () => this.handlers.showTab('activity'), { variant: 'quiet' }),
      el('span', 'sp-check__spacer'),
    );
    if (view.actions.skip) {
      const stage = view.actions.skip;
      actions.append(button(`Skip ${halted.label.toLowerCase()}`, () => this.run(() => this.handlers.skip(stage))));
    }
    actions.append(button('Retry', () => this.run(this.handlers.retry), { variant: 'primary', icon: ICON.retry }));
    body.append(actions);
    return card;
  }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function reviewSummary(view: SuperPlanRunView): string {
  const rounds = view.reviews.filter((r) => r.cycle === view.reviewCycle).length;
  const exit = view.reviewExit;
  if (!rounds && (!exit || exit.reason === 'skipped')) return view.config.reviewRounds ? 'review skipped' : 'no review';
  const reason = exit
    ? { clean: 'clean', 'round-cap': 'round limit reached', 'no-progress': 'stopped, no progress', skipped: 'skipped', failed: 'review failed' }[exit.reason]
    : '';
  return `${rounds} review round${rounds === 1 ? '' : 's'}${reason ? `, ${reason}` : ''}`;
}

function fileLine(title: string, path: string, handlers: Pick<CheckpointHandlers, 'openFile'>): HTMLElement {
  const row = el('div', 'sp-check__file');
  row.append(svg(ICON.file));
  const name = el('span', 'sp-check__filename', title);
  const where = el('code', 'sp-check__filepath', path);
  const open = el('button', 'sp-link', 'Open in editor');
  open.type = 'button';
  open.addEventListener('click', () => handlers.openFile(path));
  row.append(name, where, open);
  return row;
}

interface ReviseAreaOptions {
  label: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (notes: string) => Promise<unknown>;
  primary?: HTMLButtonElement;
  extra?: HTMLElement[];
  startOpen?: boolean;
}

/**
 * The checkpoint's actions plus an inline notes area for "request changes".
 * Opening the notes swaps the row's intent: the primary action becomes
 * sending the notes, and cancelling puts the original actions back.
 */
function reviseArea(options: ReviseAreaOptions): HTMLElement {
  const wrap = el('div', 'sp-revise');
  const actions = el('div', 'sp-check__actions');
  const notes = el('div', 'sp-revise__notes');
  notes.hidden = true;
  const fieldId = `sp-revise-${Math.random().toString(36).slice(2, 8)}`;
  const label = el('label', 'sp-revise__label', options.label);
  label.htmlFor = fieldId;
  const field = el('textarea', 'sp-revise__field');
  field.id = fieldId;
  field.rows = 4;
  field.placeholder = options.placeholder;
  const error = el('p', 'sp-check__error');
  error.setAttribute('role', 'alert');
  const noteActions = el('div', 'sp-check__actions');
  const cancel = button('Cancel', () => setOpen(false), { variant: 'quiet' });
  const submit = button(options.submitLabel, async () => {
    const text = field.value.trim();
    if (!text) {
      error.textContent = 'Say what should change.';
      field.focus();
      return;
    }
    error.textContent = '';
    try {
      await options.onSubmit(text);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  }, { variant: 'primary' });
  noteActions.append(...(options.startOpen ? [] : [cancel]), el('span', 'sp-check__spacer'), submit);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit.click();
    }
  });
  notes.append(label, field, error, noteActions);

  const request = button('Request changes', () => setOpen(true), { variant: 'quiet' });
  actions.append(...(options.extra ?? []), request, el('span', 'sp-check__spacer'), ...(options.primary ? [options.primary] : []));

  function setOpen(open: boolean): void {
    notes.hidden = !open;
    actions.hidden = open;
    if (open) field.focus();
  }

  wrap.append(actions, notes);
  if (options.startOpen) setOpen(true);
  return wrap;
}

interface QuestionReader {
  prompt: string;
  read: () => SuperPlanAnswerEntry | null;
  applyRecommended: () => void;
  focus: () => void;
}

function appendQuestion(form: HTMLFormElement, item: SuperPlanQuestionItem, index: number, batchId: string): QuestionReader {
  const multiple = item.allow_multiple === true;
  const set = el('fieldset', 'sp-q');
  const legend = el('legend', 'sp-q__prompt');
  legend.append(el('span', 'sp-q__num', `${index + 1}`), document.createTextNode(item.prompt));
  set.append(legend);
  if (multiple) set.append(el('p', 'sp-q__hint', 'Pick all that apply'));
  const name = `sp-q-${batchId}-${index}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const inputs: HTMLInputElement[] = [];
  const list = el('div', 'sp-q__options');
  for (const option of item.options) {
    const row = el('label', 'sp-q__option');
    const input = el('input');
    input.type = multiple ? 'checkbox' : 'radio';
    input.name = name;
    input.value = option.id;
    inputs.push(input);
    const text = el('span', 'sp-q__text');
    const line = el('span', 'sp-q__label', option.label);
    if (option.recommended) line.append(el('span', 'sp-q__badge', 'Recommended'));
    text.append(line);
    if (option.description) text.append(el('span', 'sp-q__desc', option.description));
    row.append(input, text);
    list.append(row);
  }
  const otherRow = el('label', 'sp-q__option sp-q__option--other');
  const otherInput = el('input');
  otherInput.type = multiple ? 'checkbox' : 'radio';
  otherInput.name = name;
  otherInput.value = OTHER_OPTION_ID;
  const otherText = el('span', 'sp-q__text');
  otherText.append(el('span', 'sp-q__label', 'Other'));
  otherRow.append(otherInput, otherText);
  list.append(otherRow);
  const other = el('textarea', 'sp-q__other');
  other.rows = 2;
  other.placeholder = 'Your answer';
  other.setAttribute('aria-label', `Your own answer: ${item.prompt}`);
  other.addEventListener('input', () => {
    if (other.value.trim()) otherInput.checked = true;
  });
  otherInput.addEventListener('change', () => {
    if (otherInput.checked) other.focus();
  });
  set.append(list, other);
  form.append(set);
  return {
    prompt: item.prompt,
    read() {
      const selectedIds = [...inputs, otherInput].filter((input) => input.checked).map((input) => input.value);
      const text = other.value.trim();
      if (text && !selectedIds.includes(OTHER_OPTION_ID)) selectedIds.push(OTHER_OPTION_ID);
      if (!selectedIds.length) return null;
      if (selectedIds.includes(OTHER_OPTION_ID) && !text) return null;
      return { questionId: item.id, selectedIds, otherText: text || null };
    },
    applyRecommended() {
      const recommended = item.options.filter((o) => o.recommended).map((o) => o.id);
      if (!recommended.length) return;
      for (const input of inputs) input.checked = recommended.includes(input.value) ? true : multiple ? input.checked : false;
      if (!multiple) otherInput.checked = false;
    },
    focus() {
      (inputs[0] ?? other).focus();
    },
  };
}
