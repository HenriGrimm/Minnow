import { getActiveGoal, isGoalLoopActive } from '../state/sessions';
import { isGoalEvaluating } from '../chat/goal/evaluating-state';
import { getActiveChat } from '../state/sessions';

/** Show or hide the active-goal strip above the composer. */
export function syncGoalActiveHint(): void {
  if (typeof document === 'undefined') return;

  let el = document.getElementById('composerGoalActiveHint');
  if (!el) {
    el = document.createElement('p');
    el.id = 'composerGoalActiveHint';
    el.className = 'composer-goal-active-hint hidden';
    el.setAttribute('role', 'status');
    const host = document.querySelector('.input-bar-composer');
    if (host) {
      host.insertBefore(el, host.firstChild);
    } else {
      document.body.appendChild(el);
    }
  }

  const chat = getActiveChat();
  const goal = getActiveGoal(chat);
  const show = Boolean(goal && (isGoalLoopActive(chat) || goal.achieved));
  el.classList.toggle('hidden', !show);

  if (!show || !goal) {
    el.textContent = '';
    el.removeAttribute('title');
    return;
  }

  const suffix = goal.achieved ? ' · achieved' : goal.paused ? ' · paused' : '';
  const evaluating = isGoalEvaluating(chat.id);
  const phase = evaluating ? ' · evaluating…' : '';
  el.textContent = `◎ goal active${suffix}${phase} · ${goal.turnCount} turn(s)`;
  el.classList.toggle('composer-goal-active-hint--evaluating', evaluating);
  if (goal.lastReason) {
    el.title = goal.lastReason;
  } else {
    el.removeAttribute('title');
  }
}
