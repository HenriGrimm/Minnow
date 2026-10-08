import { renderUserMessageBubble } from './user-message-bubble';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { registerComposerSurface } from './composer-surface';
import { bindComposerAutoResize } from './composer-auto-resize';
import type { ReefApp } from '../reef/types';

/** Shared message rendering and composer registration, with no global chat selection. */
export function mountReefChat(host: HTMLElement, send: (text: string) => Promise<void>) {
  host.className = 'reef-chat';
  const title = document.createElement('h2'); title.textContent = 'Chat about this app';
  const history = document.createElement('div'); history.className = 'reef-chat-history'; history.setAttribute('role', 'log');
  const form = document.createElement('form'); form.className = 'reef-chat-composer';
  const input = document.createElement('textarea'); input.rows = 3; input.placeholder = 'Ask a question or describe a change…'; input.setAttribute('aria-label', 'Message about this app');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Send';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  form.append(input, submit); host.append(title, history, status, form);
  let busy = false, building = false, signature = '';
  const dispatch = async () => {
    if (busy || building || !input.value.trim()) return;
    const text = input.value.trim(); busy = true; submit.disabled = true; status.textContent = 'Thinking…';
    try { await send(text); input.value = ''; status.textContent = ''; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; submit.disabled = building; }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void dispatch(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void dispatch(); } });
  const unregister = registerComposerSurface('reef', { inputEl: input, sendBtnEl: submit, onPrimaryAction: () => { void dispatch(); } });
  const unresize = bindComposerAutoResize(input);
  return {
    focus: () => input.focus(),
    update(app: ReefApp, isBuilding: boolean) {
      building = isBuilding; submit.disabled = busy || building; input.disabled = building;
      if (!busy) status.textContent = building ? 'Chat is available when the build finishes.' : '';
      const next = JSON.stringify(app.messages);
      if (next === signature) return; signature = next;
      history.replaceChildren();
      for (const message of app.messages) {
        const row = document.createElement('div'); row.className = `msg-row ${message.role}`;
        const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
        if (message.role === 'user') renderUserMessageBubble(bubble, message.content);
        else setAssistantBubbleContent(bubble, message.content);
        row.append(bubble); history.append(row);
      }
      history.scrollTop = history.scrollHeight;
    },
    dispose() { unregister(); unresize(); },
  };
}
