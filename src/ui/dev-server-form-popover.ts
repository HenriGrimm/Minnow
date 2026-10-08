import type { DevServerDefinition, DevServerListItem, ListeningPortRow } from '../config/dev-servers-api';
import { DEFAULT_DEV_SERVER_PORT } from '../config/startup-api';
import { iconHtml } from './icon';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

type ServerInput = Partial<DevServerDefinition> & { name: string; command: string };

interface DevServerFormOptions {
  anchor: HTMLElement;
  existing?: DevServerListItem;
  workspacePath: string;
  worktrees: { value: string; label: string }[];
  getPorts: () => ListeningPortRow[];
  nextFreePort: (base: number) => Promise<number>;
  onSave: (input: ServerInput) => Promise<unknown>;
  onSaved: () => void;
  onClose: () => void;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Anchored add/edit form. Advanced values stay mounted when their disclosure closes. */
export function openDevServerFormPopover(options: DevServerFormOptions): () => void {
  const { anchor, existing, workspacePath } = options;
  const def = existing?.def;
  const lockedCmd = def?.source === 'startup.md';
  const selectedWorktree = def?.worktreeRoot || existing?.worktreeRoot || workspacePath;
  const worktrees = [...options.worktrees];
  if (selectedWorktree && !worktrees.some((wt) => pathKey(wt.value) === pathKey(selectedWorktree))) {
    worktrees.push({ value: selectedWorktree, label: selectedWorktree });
  }
  const panel = document.createElement('div');
  panel.id = 'devServerFormPopover';
  panel.className = 'dev-server-screen__popover';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'devServerFormTitle');
  panel.innerHTML = `
    <form class="dev-server-screen__form" novalidate>
      <header class="dev-server-screen__form-heading">
        <div>
          <h2 id="devServerFormTitle">${existing ? 'Edit server' : 'Add dev server'}</h2>
          <p>${lockedCmd ? 'Command details are managed in startup.md.' : 'Save the command you use to run your project.'}</p>
        </div>
        <button type="button" class="dev-server-screen__icon-btn" data-form-action="close" aria-label="Close server form">${iconHtml('close', { size: 16 })}</button>
      </header>
      <div class="dev-server-screen__form-body">
        <label>Start command
          <input name="command" class="mono" placeholder="npm run dev" value="${escapeAttr(def?.command ?? existing?.command ?? '')}" required ${lockedCmd ? 'disabled' : ''} aria-describedby="devServerCommandHint" />
          <span id="devServerCommandHint" class="dev-server-screen__field-hint">${lockedCmd ? 'Edit startup.md to change this command.' : 'The same command you would enter in a terminal.'}</span>
        </label>
        <div class="dev-server-screen__form-row">
          <label>Server name
            <input name="name" placeholder="Web app" value="${escapeAttr(def?.name ?? existing?.name ?? 'Web app')}" required />
          </label>
          <label>Port
            <input name="port" type="number" min="1" max="65535" step="1" value="${def?.port ?? existing?.port ?? DEFAULT_DEV_SERVER_PORT}" required aria-describedby="devServerPortHint" />
          </label>
        </div>
        <p id="devServerPortHint" class="dev-server-screen__field-hint">Use the port your project runs on, such as 3000 or 5173.</p>
        <div class="dev-server-screen__port-warning" hidden>
          <p class="dev-server-screen__warn" data-role="port-warn" role="status"></p>
          <button type="button" class="dev-server-screen__btn dev-server-screen__btn--compact" data-form-action="free-port">Use a free port</button>
        </div>
        <details class="dev-server-screen__advanced">
          <summary>Advanced <span>Folder, network &amp; startup</span></summary>
          <div class="dev-server-screen__advanced-fields">
            <label>Working folder
              <input name="cwd" value="${escapeAttr(def?.cwd ?? '.')}" placeholder="." ${lockedCmd ? 'disabled' : ''} />
              <span class="dev-server-screen__field-hint">Relative to the selected worktree. Use . for its root.</span>
            </label>
            <label>Worktree
              <select name="worktreeRoot">${worktrees.map((wt) => `<option value="${escapeAttr(wt.value)}" ${pathKey(wt.value) === pathKey(selectedWorktree) ? 'selected' : ''}>${escapeAttr(wt.label)}</option>`).join('')}</select>
            </label>
            <label>Available to
              <select name="network">
                <option value="local" ${(def?.network ?? 'local') === 'local' ? 'selected' : ''}>This computer only</option>
                <option value="lan" ${def?.network === 'lan' ? 'selected' : ''}>Devices on your local network</option>
              </select>
            </label>
            <label>Health check URL <span class="dev-server-screen__optional">(optional)</span>
              <input name="healthUrl" type="url" placeholder="http://localhost:3000/" value="${escapeAttr(def?.healthUrl ?? '')}" ${lockedCmd ? 'disabled' : ''} />
              <span class="dev-server-screen__field-hint">Minnow checks this address to confirm the server is ready.</span>
            </label>
            <label class="dev-server-screen__inline-check">
              <input type="checkbox" name="autoStart" ${def?.autoStart ? 'checked' : ''} />
              <span>Start automatically when this workspace opens</span>
            </label>
          </div>
        </details>
        <p class="dev-server-screen__form-error" role="alert" hidden></p>
      </div>
      <footer class="dev-server-screen__form-actions">
        <span>${existing ? 'Changes apply on the next start.' : 'You can start it after adding.'}</span>
        <button type="button" class="dev-server-screen__btn" data-form-action="close">Cancel</button>
        <button type="submit" class="dev-server-screen__btn dev-server-screen__btn--primary">${existing ? 'Save changes' : 'Add server'}</button>
      </footer>
    </form>
  `;
  const form = panel.querySelector<HTMLFormElement>('form')!;
  const input = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const select = (name: string) => form.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  const error = panel.querySelector<HTMLElement>('[role="alert"]')!;
  const advanced = panel.querySelector<HTMLDetailsElement>('details')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  let closed = false;
  let saving = false;
  let findingPort = false;

  function position(): void {
    const margin = 12;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    panel.style.left = `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`;
    const top = rect.bottom + 8;
    panel.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
  }

  function close(restoreFocus = true): void {
    if (closed) return;
    closed = true;
    panel.remove();
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onEscape, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', onScroll, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    unregisterChromePopover();
    options.onClose();
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }

  function onOutsidePointer(event: PointerEvent): void {
    if (panel.contains(event.target as Node) || anchor.contains(event.target as Node)) return;
    close(false);
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  function onScroll(event: Event): void {
    if (!panel.contains(event.target as Node)) position();
  }

  function syncPortWarning(): void {
    const port = Number(input('port').value);
    const hit = options.getPorts().find((row) => row.port === port);
    const warning = panel.querySelector<HTMLElement>('.dev-server-screen__port-warning')!;
    warning.hidden = !hit;
    panel.querySelector<HTMLElement>('[data-role="port-warn"]')!.textContent = hit
      ? `Port ${port} is in use by ${hit.process} (PID ${hit.pid}).`
      : '';
    position();
  }

  panel.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-form-action]');
    if (action?.dataset.formAction === 'close') close();
    if (action?.dataset.formAction === 'free-port' && !findingPort && !saving) {
      findingPort = true;
      const requestedPort = input('port').value;
      (action as HTMLButtonElement).disabled = true;
      void options.nextFreePort(Number(requestedPort) || DEFAULT_DEV_SERVER_PORT).then((port) => {
        if (!closed && input('port').value === requestedPort) {
          input('port').value = String(port);
          syncPortWarning();
        }
      }).catch((err: unknown) => {
        if (closed) return;
        error.hidden = false;
        error.textContent = err instanceof Error ? err.message : String(err);
        position();
      }).finally(() => {
        findingPort = false;
        (action as HTMLButtonElement).disabled = false;
      });
    }
  });
  input('port').addEventListener('input', syncPortWarning);
  advanced.addEventListener('toggle', position);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (saving || findingPort || closed) return;
    input('name').value = input('name').value.trim();
    input('command').value = input('command').value.trim();
    if (!form.checkValidity()) {
      if ([...advanced.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')]
        .some((field) => !field.validity.valid)) advanced.open = true;
      position();
      form.reportValidity();
      return;
    }
    const worktreeRoot = select('worktreeRoot').value.trim();
    const values: ServerInput = {
      name: input('name').value,
      command: input('command').value,
      cwd: input('cwd').value.trim() || '.',
      port: Number(input('port').value),
      network: select('network').value === 'lan' ? 'lan' : 'local',
      healthUrl: input('healthUrl').value.trim(),
      autoStart: input('autoStart').checked,
      worktreeRoot: pathKey(worktreeRoot) === pathKey(workspacePath) ? '' : worktreeRoot,
    };
    if (lockedCmd) {
      delete values.cwd;
      delete values.healthUrl;
    }
    saving = true;
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Saving…';
    form.setAttribute('aria-busy', 'true');
    void options.onSave(values).then(() => {
      close();
      options.onSaved();
    }).catch((err: unknown) => {
      if (closed) return;
      error.hidden = false;
      error.textContent = err instanceof Error ? err.message : String(err);
      position();
    }).finally(() => {
      saving = false;
      submit.disabled = false;
      submit.textContent = existing ? 'Save changes' : 'Add server';
      form.removeAttribute('aria-busy');
    });
  });
  document.body.appendChild(panel);
  registerChromePopover();
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', panel.id);
  anchor.setAttribute('aria-haspopup', 'dialog');
  syncPortWarning();
  (lockedCmd ? input('name') : input('command')).focus();
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('keydown', onEscape, true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', onScroll, true);
  return close;
}
