import { actionApi } from '../state/actions-api';
import { getReleaseWorkflow } from '../state/release-workflow';
import { requestActionRuns, requestActionWorkflow } from './scc-actions';
import { button, el, type SccContext } from './scc-shared';
import { statusLine } from './scc-action-form';
import { renderRemoteWorkflowForm } from './scc-workflow-form';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

export function createReleaseWorkflowTrigger(ctx: SccContext) {
  let popover: HTMLElement | null = null;
  let request = 0;
  const trigger = button({ label: 'Run release workflow', onClick: () => {
    if (popover) close(true);
    else void open();
  } });
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');

  function position() {
    if (!popover) return;
    const rect = trigger.getBoundingClientRect();
    const width = popover.offsetWidth || Math.min(380, window.innerWidth - 16);
    const height = popover.offsetHeight || 120;
    popover.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    popover.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8))}px`;
  }
  function outside(event: PointerEvent) {
    if (!popover?.contains(event.target as Node) && !trigger.contains(event.target as Node)) close(false);
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }
  function close(restoreFocus = false) {
    request++;
    if (!popover) return;
    popover.remove();
    popover = null;
    unregisterChromePopover();
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('scroll', position, true);
    if (restoreFocus && trigger.isConnected) trigger.focus();
  }
  async function open() {
    const current = ++request;
    const cwd = ctx.getCwd();
    const panel = el('div', 'scc-root scc-actions scc-release-workflow-popover');
    popover = panel;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Run release workflow');
    panel.setAttribute('aria-modal', 'false');
    const header = el('div', 'scc-release-workflow-popover__header');
    const title = el('h2', undefined, 'Release workflow');
    header.append(title, button({ label: 'Close', onClick: () => close(true) }));
    const host = el('div');
    const status = statusLine();
    status.textContent = 'Loading release workflow…';
    host.append(status);
    panel.append(header, host);
    document.body.append(panel);
    registerChromePopover();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    position();
    header.querySelector<HTMLButtonElement>('button')?.focus();
    const valid = () => current === request && popover === panel && cwd === ctx.getCwd();
    const choose = button({ label: 'Choose workflow', onClick: () => {
      close(); requestActionWorkflow(); ctx.goTo('checks');
    } });
    panel.append(choose);
    const result = await actionApi('workflowList', { cwd, location: 'remote', page: 1 });
    if (!valid()) return;
    if (!result.ok || !result.repo) {
      status.textContent = result.error || 'Could not identify the GitHub repository.';
      position();
      return;
    }
    const workflow = getReleaseWorkflow(result.repo);
    if (!workflow) {
      status.textContent = 'Choose a workflow in Actions, then select “Use for releases” to connect it to this button.';
      position();
      return;
    }
    title.textContent = workflow.name;
    choose.textContent = 'Change workflow';
    host.replaceChildren(el('p', 'scc-action-context', result.repo));
    const runs = button({ label: 'View runs', onClick: () => {
      close();
      requestActionRuns();
      ctx.goTo('checks');
    } });
    runs.hidden = true;
    panel.append(runs);
    await renderRemoteWorkflowForm(workflow, host, {
      cwd, branch: ctx.getBranch(), isCurrent: valid,
      onAccepted: () => {
        runs.hidden = false;
        position();
      },
      onWorkflowLoaded: () => position(),
    });
    if (valid()) {
      position();
      // Avoid moving focus when the user has already chosen another control.
      if (document.activeElement === header.querySelector('button'))
        host.querySelector<HTMLElement>('input, select, button')?.focus();
    }
  }
  return { button: trigger, close: () => close(), destroy: () => close() };
}
