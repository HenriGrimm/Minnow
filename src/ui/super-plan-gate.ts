import type { Chat } from '../types';
import { answerSuperPlanGate } from '../chat/super-plan/client';
import { ASK_QUESTION_OTHER_ID, stringifyAskQuestionResult, validateAskQuestionArgs, type AskQuestionItem } from '../tools/ask-question-types';

function appendQuestionChoices(form: HTMLFormElement, questions: AskQuestionItem[]): () => string | null {
  const fields = questions.map((question, index) => {
    const field = document.createElement('fieldset');
    field.className = 'sp-gate__question';
    const legend = document.createElement('legend');
    legend.textContent = question.prompt;
    field.append(legend);
    const choices = [...question.options, { id: ASK_QUESTION_OTHER_ID, label: 'Other' }].map((option) => {
      const label = document.createElement('label');
      label.className = 'sp-gate__choice';
      const input = document.createElement('input');
      input.type = question.allow_multiple ? 'checkbox' : 'radio';
      input.name = `question-${index}`;
      input.value = option.id;
      const text = document.createElement('span');
      text.textContent = option.label;
      if (option.description) {
        const detail = document.createElement('small');
        detail.textContent = option.description;
        text.append(detail);
      }
      label.append(input, text);
      field.append(label);
      return input;
    });
    const other = document.createElement('textarea');
    other.setAttribute('aria-label', `Other answer: ${question.prompt}`);
    other.placeholder = 'Your answer';
    other.addEventListener('input', () => {
      if (other.value.trim()) choices.at(-1)!.checked = true;
    });
    field.append(other);
    form.append(field);
    return { question, choices, other };
  });
  return () => {
    const answers = fields.map(({ question, choices, other }) => ({
      questionId: question.id,
      selectedIds: choices.filter((choice) => choice.checked).map((choice) => choice.value),
      otherText: other.value.trim() || null,
    }));
    if (answers.some((answer) => !answer.selectedIds.length || (answer.selectedIds.includes(ASK_QUESTION_OTHER_ID) && !answer.otherText))) return null;
    return stringifyAskQuestionResult({ status: 'answered', answers });
  };
}

/** Keep the form stable during polling, including text and keyboard focus. */
export function renderSuperPlanGate(host: HTMLElement, chat: Chat): void {
  const gate = chat.superPlanView?.gate;
  const current = host.querySelector<HTMLElement>('[data-super-plan-gate]');
  if (!gate || chat.superPlanView?.finished || chat.superPlanView?.paused) { current?.remove(); host.hidden = !host.childElementCount; return; }
  host.hidden = false;
  if (current?.dataset.superPlanGate === gate.gateId) return;
  current?.remove();
  host.hidden = false;
  const form = document.createElement('form');
  form.dataset.superPlanGate = gate.gateId;
  form.className = 'sp-gate';
  const heading = document.createElement('h3');
  heading.textContent = gate.kind === 'spec' ? 'Confirm the specification' : gate.kind === 'accept' ? 'Review the final plan' : 'Your input';
  const question = document.createElement('p');
  question.textContent = gate.question;
  const parsed = gate.kind === 'question' ? validateAskQuestionArgs({ questions: gate.questions }) : null;
  const structured = parsed?.ok === true ? parsed.args : null;
  if (structured) question.textContent = gate.title ?? '';
  const label = document.createElement('label');
  label.textContent = gate.kind === 'question' ? 'Answer' : 'Changes requested (optional)';
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', label.textContent);
  label.append(input);
  const actions = document.createElement('div');
  actions.className = 'sp-gate__actions';
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  for (const answer of gate.kind !== 'question' && gate.choices?.length ? gate.choices : ['Send answer']) {
    const button = document.createElement('button');
    button.type = 'submit';
    button.value = answer;
    button.className = 'btn';
    button.textContent = ({ confirm: 'Confirm specification', revise: 'Revise specification', accept: 'Accept plan', reject: 'Request changes' } as Record<string, string>)[answer] ?? answer;
    actions.append(button);
  }
  let readAnswers: (() => string | null) | null = null;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answer = gate.kind === 'question' ? (readAnswers ? readAnswers() : input.value.trim()) : (event.submitter as HTMLButtonElement | null)?.value;
    if (!answer) { error.textContent = 'Answer each question before continuing.'; return; }
    if (chat.superPlanView?.gate?.gateId !== gate.gateId) return;
    const buttons = [...actions.querySelectorAll('button')];
    buttons.forEach((button) => { button.disabled = true; });
    error.textContent = '';
    try { await answerSuperPlanGate(chat, answer, input.value.trim() ? [input.value.trim()] : []); form.remove(); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); buttons.forEach((button) => { button.disabled = false; }); }
  });
  const review = document.createElement('p');
  review.textContent = chat.superPlanView?.reviewExitReason === 'no-progress' ? 'Review stopped because consecutive rounds found the same issues. Review remaining findings before accepting.' : '';
  if (chat.superPlanView?.disputedClaims?.length) review.textContent += ` ${chat.superPlanView.disputedClaims.length} claimed fixes are still reported by review.`;
  form.append(heading, question, review);
  if (structured) readAnswers = appendQuestionChoices(form, structured.questions);
  else form.append(label);
  form.append(actions, error);
  host.append(form);
}
