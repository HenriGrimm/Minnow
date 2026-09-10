import type { Chat } from '../types';
import { answerSuperPlanGate } from '../chat/super-plan/client';

/** Keep the form stable during polling, including text and keyboard focus. */
export function renderSuperPlanGate(host: HTMLElement, chat: Chat): void {
  const gate = chat.superPlanView?.gate;
  const current = host.querySelector<HTMLElement>('[data-super-plan-gate]');
  if (!gate) { current?.remove(); return; }
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
  const label = document.createElement('label');
  label.textContent = gate.kind === 'question' ? 'Answer' : 'Changes requested (optional)';
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', label.textContent);
  label.append(input);
  const actions = document.createElement('div');
  actions.className = 'sp-gate__actions';
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  for (const answer of gate.choices?.length ? gate.choices : ['Send answer']) {
    const button = document.createElement('button');
    button.type = 'submit';
    button.value = answer;
    button.className = 'btn';
    button.textContent = ({ confirm: 'Confirm specification', revise: 'Revise specification', accept: 'Accept plan', reject: 'Request changes' } as Record<string, string>)[answer] ?? answer;
    actions.append(button);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answer = gate.kind === 'question' ? input.value.trim() : (event.submitter as HTMLButtonElement | null)?.value;
    if (!answer) return;
    const buttons = [...actions.querySelectorAll('button')];
    buttons.forEach((button) => { button.disabled = true; });
    error.textContent = '';
    try { await answerSuperPlanGate(chat, answer, input.value.trim() ? [input.value.trim()] : []); form.remove(); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); buttons.forEach((button) => { button.disabled = false; }); }
  });
  const review = document.createElement('p');
  review.textContent = chat.superPlanView?.reviewExitReason === 'no-progress' ? 'Review stopped because consecutive rounds found the same issues. Review remaining findings before accepting.' : '';
  if (chat.superPlanView?.disputedClaims?.length) review.textContent += ` ${chat.superPlanView.disputedClaims.length} claimed fixes are still reported by review.`;
  form.append(heading, question, review, label, actions, error);
  host.append(form);
}
