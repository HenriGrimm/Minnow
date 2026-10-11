import { renderUserMessageBubble } from './user-message-bubble';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { registerComposerSurface } from './composer-surface';
import { autoResize, bindComposerAutoResize } from './composer-auto-resize';
import { createIcon } from './icon';
import type { ReefApp } from '../reef/types';

/** Shared message rendering and composer registration, with no global chat selection. */
export function mountReefChat(host: HTMLElement, send: (text: string) => Promise<void>) {
  host.className = 'reef-chat';
  host.setAttribute('aria-label', 'App conversation');
  const header = document.createElement('div'); header.className = 'reef-chat-heading';
  const identity = document.createElement('div'); identity.className = 'reef-chat-identity';
  const headingCopy = document.createElement('div'); headingCopy.className = 'reef-chat-heading-copy';
  const title = document.createElement('h2'); title.textContent = 'App conversation';
  const context = document.createElement('p'); context.className = 'reef-chat-context';
  headingCopy.append(title, context); identity.append(createIcon('appChat'), headingCopy);
  const availability = document.createElement('span'); availability.className = 'reef-chat-availability'; availability.setAttribute('role', 'status'); header.append(identity, availability);
  const history = document.createElement('div'); history.className = 'reef-chat-history'; history.setAttribute('role', 'log'); history.setAttribute('aria-label', 'Conversation messages'); history.tabIndex = 0;
  const form = document.createElement('form'); form.className = 'reef-chat-composer';
  const field = document.createElement('div'); field.className = 'reef-chat-field';
  const input = document.createElement('textarea'); input.rows = 2; input.placeholder = 'Ask a question or describe a change…'; input.setAttribute('aria-label', 'Message about this app');
  const toolbar = document.createElement('div'); toolbar.className = 'reef-chat-composer-toolbar';
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'reef-primary reef-chat-send'; submit.setAttribute('aria-label', 'Send message'); submit.title = 'Send message (Enter)'; submit.append(createIcon('arrowUp'));
  const status = document.createElement('p'); status.className = 'reef-chat-status'; status.setAttribute('role', 'status');
  const paused = document.createElement('div'); paused.className = 'reef-chat-paused'; paused.hidden = true; paused.setAttribute('role', 'status');
  const pausedCopy = document.createElement('div'); pausedCopy.className = 'reef-chat-paused-copy';
  const pausedTitle = document.createElement('strong'); pausedTitle.textContent = 'Chat paused during the build';
  const pausedHint = document.createElement('p'); pausedHint.textContent = 'Ask questions or request changes once it finishes.';
  pausedCopy.append(pausedTitle, pausedHint); paused.append(createIcon('clock'), pausedCopy);
  const hint = document.createElement('p'); hint.className = 'reef-chat-hint'; hint.id = 'reef-chat-input-hint'; hint.textContent = 'Enter to send · Shift + Enter for a new line'; input.setAttribute('aria-describedby', hint.id);
  toolbar.append(hint, submit); field.append(input, toolbar); form.append(field, status); host.append(header, history, paused, form);
  let busy = false, building = false, signature = '';
  const syncControls = () => {
    submit.disabled = busy || building || !input.value.trim();
    availability.textContent = building ? 'Paused' : busy ? 'Thinking' : 'Ready';
    host.dataset.state = building ? 'paused' : busy ? 'busy' : 'ready';
  };
  input.addEventListener('input', syncControls);
  const dispatch = async () => {
    if (busy || building || !input.value.trim()) return;
    const text = input.value.trim(); busy = true; syncControls(); status.textContent = 'Thinking…';
    try { await send(text); if (input.value.trim() === text) { input.value = ''; autoResize(input); } status.textContent = ''; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; syncControls(); }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void dispatch(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void dispatch(); } });
  const unregister = registerComposerSurface('reef', { inputEl: input, sendBtnEl: submit, onPrimaryAction: () => { void dispatch(); } });
  const unresize = bindComposerAutoResize(input);
  syncControls();
  return {
    focus: () => input.focus(),
    update(app: ReefApp, isBuilding: boolean) {
      building = isBuilding; input.disabled = building; syncControls();
      form.hidden = building; paused.hidden = !building;
      context.textContent = app.name; context.title = app.name;
      for (const suggestion of history.querySelectorAll<HTMLButtonElement>('.reef-chat-empty button')) suggestion.disabled = building;
      if (!busy) status.textContent = '';
      const next = JSON.stringify(app.messages);
      if (next === signature) return;
      const followLatest = !signature || history.scrollHeight - history.scrollTop - history.clientHeight < 64;
      const scrollTop = history.scrollTop;
      signature = next;
      history.replaceChildren();
      if (!app.messages.length) {
        const empty = document.createElement('div'); empty.className = 'reef-chat-empty';
        const heading = document.createElement('h3'); heading.textContent = 'Make it yours';
        const description = document.createElement('p'); description.textContent = 'Ask how your app works, discuss a problem, or describe what to change next.';
        empty.append(createIcon('appChat'), heading, description);
        for (const text of ['How does this app work?', 'What could we improve?']) {
          const suggestion = document.createElement('button'); suggestion.type = 'button'; suggestion.textContent = text; suggestion.disabled = building;
          suggestion.addEventListener('click', () => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }); empty.append(suggestion);
        }
        history.append(empty);
      }
      for (const message of app.messages) {
        const row = document.createElement('div'); row.className = `msg-row ${message.role}`;
        const author = document.createElement('span'); author.className = 'reef-chat-author'; author.textContent = message.role === 'user' ? 'You' : 'Assistant';
        const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
        if (message.role === 'user') renderUserMessageBubble(bubble, message.content);
        else setAssistantBubbleContent(bubble, message.content);
        row.append(author, bubble); history.append(row);
      }
      history.scrollTop = followLatest ? history.scrollHeight : scrollTop;
    },
    dispose() { unregister(); unresize(); },
  };
}
