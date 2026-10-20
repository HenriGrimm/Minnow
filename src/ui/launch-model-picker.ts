import { launchModelLabel } from '../models/launch-selection';
import { readDefaultModelBinding } from '../models/selection';
import { loadModelChoices } from '../models/model-choices';
import { fillModelChoices } from './routing-form';
import { mountAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox } from './model-select-picker';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { formatReasoningEffortLabel, getComposerReasoningLevelOptions, modelShowsComposerBrainToggle } from '../lib/reasoning-effort';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import type { ReasoningEffortOption } from '../types';
import '../styles/model-routing-form.css';

interface LaunchPickerOptions {
  reasoning: () => ReasoningEffortOption | undefined;
  onReasoning: (value?: ReasoningEffortOption) => void;
  onClose: () => void;
}

let closePicker: (() => void) | undefined;
/** A dispatch override is local; changing it never remembers a chat preference. */
export function openLaunchModelPicker(anchor: HTMLElement, value: string, onPick: (value: string) => void, options?: LaunchPickerOptions): void {
  closePicker?.();
  const abort = new AbortController();
  const host = document.createElement('div');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Model for new chats');
  select.hidden = true;
  select.disabled = true;
  host.append(select);
  document.body.append(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    unmountAuxiliaryModelSelectCombobox(select);
    host.remove();
    closePicker = undefined;
    options?.onClose();
    if (anchor.isConnected) anchor.focus();
  };
  closePicker = close;
  void loadModelChoices(abort.signal).then((choices) => {
    if (abort.signal.aborted || !anchor.isConnected) { close(); return; }
    fillModelChoices(select, choices, value, `Use last selected chat model · ${launchModelLabel('')}`);
    select.disabled = false;
    mountAuxiliaryModelSelectCombobox(select, {
      searchable: true, anchor, onClose: close, keepOpenOnPick: !!options,
      showReasoningDefault: !options,
    });
    const trigger = host.querySelector<HTMLButtonElement>('.model-select-trigger')!;
    // Only the shared menu is visible; the original issue control remains its anchor.
    trigger.hidden = true;
    trigger.style.display = 'none';
    const panel = host.querySelector<HTMLElement>('.auxiliary-model-popover')!;
    const reasoning = document.createElement('div');
    reasoning.className = 'composer-model-reasoning';
    const renderReasoning = () => {
      if (!options) return;
      const binding = decodeModelSelectKey(select.value) ?? readDefaultModelBinding();
      const caps = binding.providerId ? resolveSendCapabilities(binding.providerId, binding.modelId) : undefined;
      const levels = getComposerReasoningLevelOptions(caps?.reasoningAllowedOptions ?? []);
      const toggle = modelShowsComposerBrainToggle(caps);
      reasoning.replaceChildren();
      reasoning.hidden = binding.providerId === 'minnow-router' || (!levels.length && !toggle);
      if (reasoning.hidden) return;
      const heading = document.createElement('div');
      heading.className = 'composer-model-reasoning__heading';
      heading.textContent = 'Reasoning for new chat';
      const buttons = document.createElement('div');
      buttons.className = 'composer-model-reasoning__choices';
      buttons.setAttribute('role', 'group');
      buttons.setAttribute('aria-label', 'Reasoning for new chat');
      const values: Array<ReasoningEffortOption | undefined> = [undefined, ...(toggle ? ['off' as const] : []), ...(levels.length ? levels : ['on' as const])];
      for (const effort of values) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'composer-model-reasoning__choice';
        button.textContent = effort ? formatReasoningEffortLabel(effort) : 'Default';
        button.setAttribute('aria-pressed', String(options.reasoning() === effort));
        button.addEventListener('click', () => {
          options.onReasoning(effort);
          buttons.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        });
        buttons.append(button);
      }
      reasoning.append(heading, buttons);
    };
    if (options) panel.querySelector('.model-select-menu')!.after(reasoning);
    select.onchange = () => {
      onPick(select.value);
      if (options) renderReasoning();
      else close();
    };
    renderReasoning();
    trigger.click();
  }).catch(async (error) => {
    if (abort.signal.aborted) return;
    close();
    const { showToast } = await import('./toast');
    showToast(error instanceof Error ? error.message : String(error), 'error');
  });
}
