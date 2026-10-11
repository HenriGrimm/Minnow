import { el, button } from './scc-shared';
import { actionApi, type ActionResult } from '../state/actions-api';
import { appConfirm, type AppConfirmOptions } from './app-dialog';
export const confirmAction = ({ message, ...options }: AppConfirmOptions) =>
  appConfirm(message, options);

export function field(label: string, value = '', type = 'text'): HTMLInputElement {
  const input = el('input', 'scc-action-input');
  input.type = type;
  input.value = value;
  input.setAttribute('aria-label', label);
  return input;
}
export function labeled(label: string, input: HTMLElement): HTMLLabelElement {
  const wrap = el('label', 'scc-action-field');
  wrap.append(el('span', undefined, label), input);
  return wrap;
}
export function select(
  label: string,
  choices: { value: string; label: string }[],
  value?: string,
): HTMLSelectElement {
  const input = el('select', 'scc-action-input');
  input.setAttribute('aria-label', label);
  for (const choice of choices) {
    const option = el('option', undefined, choice.label);
    option.value = choice.value;
    input.append(option);
  }
  if (value !== undefined) input.value = value;
  return input;
}
export function textArea(label: string, value = ''): HTMLTextAreaElement {
  const input = el('textarea', 'scc-action-input');
  input.value = value;
  input.rows = 6;
  input.setAttribute('aria-label', label);
  return input;
}
export function statusLine(): HTMLElement {
  const node = el('p', 'scc-action-status');
  node.setAttribute('role', 'status');
  return node;
}
export function operationButton(
  label: string,
  status: HTMLElement,
  operation: () => Promise<ActionResult>,
  onSuccess?: (result: ActionResult) => void,
): HTMLButtonElement {
  const control = button({
    label,
    onClick: async () => {
      if (control.disabled) return;
      control.disabled = true;
      status.textContent = `${label}…`;
      const progress = el('progress');
      progress.setAttribute('aria-label', label);
      status.append(progress);
      try {
        const result = await operation();
        status.textContent = result.ok
          ? result.note || 'Done.'
          : result.error || 'Operation failed';
        if (result.ok) onSuccess?.(result);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        control.disabled = false;
      }
    },
  });
  return control;
}
export async function remoteOptions(
  cwd: string | undefined,
  kind: string,
): Promise<{ name: string; sha?: string }[]> {
  const options: { name: string; sha?: string }[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await actionApi('actionRemoteOptions', { cwd, kind, page });
    if (!result.ok) throw new Error(result.error);
    options.push(...(result.options || []));
    if (!result.hasMore) break;
  }
  return options;
}
