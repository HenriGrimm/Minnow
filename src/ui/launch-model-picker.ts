import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';
import { launchModelLabel } from '../models/launch-selection';
import { loadModelChoices } from '../models/model-choices';
import { fillModelChoices } from './routing-form';
import { mountAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox } from './model-select-picker';
import '../styles/model-routing-form.css';

let closePicker: (() => void) | undefined;
/** A dispatch override is local; changing it never remembers a chat preference. */
export function openLaunchModelPicker(anchor: HTMLElement, value: string, onPick: (value: string) => void): void {
  closePicker?.();
  const abort = new AbortController();
  const panel = document.createElement('section'); panel.className = 'mn-models-popover';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Model for new chats');
  const title = document.createElement('h2'); title.textContent = 'Model for new chats';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Launch model'); select.disabled = true;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Loading models…';
  panel.append(title, select, status); document.body.append(panel); registerChromePopover();
  let closed = false;
  const rect = anchor.getBoundingClientRect(); panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - panel.offsetWidth - 12))}px`; panel.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - 230))}px`;
  const close = () => { if (closed) return; closed = true; unregisterChromePopover(); abort.abort(); unmountAuxiliaryModelSelectCombobox(select); panel.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key); closePicker = undefined; anchor.focus(); };
  const outside = (event: PointerEvent) => { if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !panel.querySelector('.auxiliary-model-popover:not(.hidden)')) { event.preventDefault(); close(); } };
  closePicker = close; document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key);
  void loadModelChoices(abort.signal).then((choices) => {
    if (abort.signal.aborted) return;
    fillModelChoices(select, choices, value, `Use last selected chat model · ${launchModelLabel('')}`);
    select.disabled = false; status.textContent = 'Applies to this launch. Existing chats keep their model.';
    mountAuxiliaryModelSelectCombobox(select, { searchable: true });
    select.onchange = () => { onPick(select.value); close(); };
    panel.querySelector<HTMLButtonElement>('.model-select-trigger')?.focus();
  }).catch((error) => { if (!abort.signal.aborted) status.textContent = error.message; });
}
