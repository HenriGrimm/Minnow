import { requestRouterReevaluation, type RouterRouteState } from '../models/routers';

interface ActionInput {
  chatId: string;
  routerId: string;
  route?: RouterRouteState;
  busy: boolean;
}

export function syncRouterReevaluateAction(panel: HTMLElement, input?: ActionInput): void {
  let row = panel.querySelector<HTMLElement>('.router-reevaluate-action');
  if (!row && !input) return;
  if (!row) {
    row = document.createElement('div');
    row.className = 'model-menu-actions router-reevaluate-action';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-menu-action';
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    row.append(button, status);
    panel.append(row);
  }
  row.hidden = !input;
  if (!input) return;
  const button = row.querySelector('button')!;
  const status = row.querySelector('span')!;
  button.textContent = input.route?.reevaluate ? 'Re-evaluation queued' : 'Re-evaluate';
  button.title = 'Choose a fresh model and reasoning level for your next message';
  button.disabled = input.busy || !input.route?.decision || input.route.phase === 'deciding' || input.route.reevaluate === true || input.route.decision.source === 'override';
  status.textContent = input.route?.reevaluate ? 'On your next message' : '';
  const onClick = async () => {
    button.disabled = true;
    try {
      await requestRouterReevaluation(input.chatId, input.routerId);
      if (button.onclick !== onClick) return;
      button.textContent = 'Re-evaluation queued';
      status.textContent = 'On your next message';
    } catch (error) {
      if (button.onclick !== onClick) return;
      button.disabled = false;
      status.textContent = error instanceof Error ? error.message : 'Could not queue re-evaluation';
    }
  };
  button.onclick = onClick;
}
