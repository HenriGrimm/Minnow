import { agentCliLoginRequest, type AgentCliKind, type AgentCliLogin } from '../models/agent-clis';
import '../styles/agent-cli-sign-in.css';

/** Inline browser authorization shared by Models and first-run setup. */
export function createAgentCliSignIn(kind: AgentCliKind, label: string, options: {
  request?: typeof agentCliLoginRequest;
  retry: () => void;
}) {
  const request = options.request ?? agentCliLoginRequest;
  const root = document.createElement('section');
  root.className = 'cli-sign-in';
  root.hidden = true;
  root.setAttribute('aria-label', `${label} sign-in`);
  const heading = document.createElement('h3');
  heading.tabIndex = -1;
  const message = document.createElement('p');
  message.className = 'cli-sign-in__message';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const steps = document.createElement('ol');
  steps.className = 'cli-sign-in__steps';
  for (const text of ['Open sign-in', 'Approve in browser', 'Connected']) {
    const step = document.createElement('li');
    step.textContent = text;
    steps.append(step);
  }
  const actions = document.createElement('div');
  actions.className = 'cli-sign-in__actions';
  const link = document.createElement('a');
  link.className = 'models-inline-btn is-primary';
  link.textContent = 'Open sign-in page';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.hidden = true;
  const deviceCode = document.createElement('p');
  deviceCode.className = 'cli-sign-in__device-code';
  deviceCode.hidden = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'models-inline-btn';
  cancel.textContent = 'Cancel';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'models-inline-btn is-primary';
  retry.textContent = 'Try again';
  retry.hidden = true;
  actions.append(link, retry, cancel);
  const fallback = document.createElement('details');
  fallback.className = 'cli-sign-in__fallback';
  const summary = document.createElement('summary');
  summary.textContent = 'Browser gave you a sign-in code?';
  const form = document.createElement('form');
  const codeLabel = document.createElement('label');
  codeLabel.textContent = 'Paste the code shown after browser approval';
  const code = document.createElement('input');
  code.className = 'models-cli-input';
  code.autocomplete = 'off';
  code.spellcheck = false;
  code.maxLength = 2048;
  code.required = true;
  codeLabel.append(code);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'models-inline-btn';
  submit.textContent = 'Complete sign-in';
  const codeError = document.createElement('p');
  codeError.setAttribute('role', 'alert');
  form.append(codeLabel, submit, codeError);
  fallback.append(summary, form);
  const note = document.createElement('p');
  note.className = 'cli-sign-in__note';
  note.textContent = `Sign in directly with ${label}. Your login stays in the CLI’s credential store on this computer.`;
  root.append(heading, steps, message, deviceCode, actions, fallback, note);
  let disposed = false;
  let flow: AgentCliLogin | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: ((success: boolean) => void) | undefined;
  let controller: AbortController | undefined;
  let revision = 0;
  let startWork: Promise<void> | undefined;

  function render(): void {
    const state = flow?.state ?? 'starting';
    const terminal = ['signed-in', 'failed', 'cancelled'].includes(state);
    root.dataset.state = state;
    heading.textContent = state === 'signed-in' ? `${label} is connected`
      : state === 'failed' ? 'Sign-in needs another try'
        : state === 'cancelled' ? 'Sign-in cancelled' : `Connect ${label}`;
    message.textContent = flow?.error ?? (state === 'starting' ? 'Preparing your secure sign-in page…'
      : state === 'waiting' ? 'Continue in your browser. This page updates when you finish.'
        : state === 'verifying' ? 'Checking your login…'
          : state === 'signed-in' ? 'Your account is ready to use in Minnow.' : 'You can start again whenever you are ready.');
    link.hidden = !flow?.verificationUrl || terminal;
    if (flow?.verificationUrl && !terminal) link.href = flow.verificationUrl;
    else link.removeAttribute('href');
    deviceCode.textContent = flow?.code ? `Enter this code in your browser: ${flow.code}` : '';
    deviceCode.hidden = !flow?.code || terminal;
    cancel.hidden = terminal;
    cancel.disabled = false;
    retry.hidden = !['failed', 'cancelled'].includes(state);
    fallback.hidden = !flow?.acceptsCode;
    const index = state === 'signed-in' ? 2 : state === 'verifying' ? 2 : state === 'waiting' ? 1 : 0;
    [...steps.children].forEach((step, i) => {
      if (!terminal && i === index) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      (step as HTMLElement).dataset.complete = String(i < index || state === 'signed-in');
    });
  }

  function settle(success: boolean): void {
    clearTimeout(timer);
    code.value = '';
    finish?.(success);
    finish = undefined;
  }

  function fail(): void {
    flow = { id: flow?.id ?? '', state: 'failed', verificationUrl: null, code: null,
      acceptsCode: false, error: 'Could not complete sign-in. Check your connection and try again.' };
    render();
    settle(false);
  }

  async function poll(attempt: number): Promise<void> {
    if (disposed || attempt !== revision || !flow) return;
    try {
      const next = await request(kind, 'poll', { id: flow.id, signal: controller?.signal });
      if (disposed || attempt !== revision) return;
      flow = next;
      render();
      if (['signed-in', 'failed', 'cancelled'].includes(next.state)) { settle(next.state === 'signed-in'); return; }
      timer = setTimeout(() => void poll(attempt), 1000);
    } catch {
      if (disposed || attempt !== revision) return;
      const id = flow.id;
      void request(kind, 'cancel', { id }).catch(() => {});
      fail();
    }
  }

  link.addEventListener('click', event => {
    if (!window.minnow?.app?.openExternal) return;
    event.preventDefault();
    void window.minnow.app.openExternal(link.href);
  });
  retry.addEventListener('click', options.retry);
  cancel.addEventListener('click', async () => {
    const id = flow?.id;
    const attempt = ++revision;
    clearTimeout(timer);
    controller?.abort();
    if (!id) {
      flow = { id: '', state: 'cancelled', verificationUrl: null, code: null, acceptsCode: false, error: null };
      render();
      settle(false);
      return;
    }
    cancel.disabled = true;
    try {
      const next = await request(kind, 'cancel', { id });
      if (disposed || attempt !== revision) return;
      flow = next;
      render();
      settle(false);
    } catch { if (!disposed && attempt === revision) fail(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!flow || !code.value.trim() || submit.disabled) return;
    submit.disabled = true;
    codeError.textContent = '';
    const attempt = revision;
    try {
      await request(kind, 'code', { id: flow.id, code: code.value.trim(), signal: controller?.signal });
      if (!disposed && attempt === revision) { code.value = ''; codeError.textContent = 'Code sent. Waiting for confirmation…'; }
    } catch { if (!disposed && attempt === revision) codeError.textContent = 'Could not send that code. Try again.'; }
    finally { submit.disabled = false; }
  });
  return {
    root,
    start(): Promise<boolean> {
      const attempt = ++revision;
      root.hidden = false;
      flow = null;
      fallback.open = false;
      codeError.textContent = '';
      controller = new AbortController();
      render();
      heading.focus();
      let resolveAttempt!: (success: boolean) => void;
      const completed = new Promise<boolean>(resolve => { resolveAttempt = resolve; finish = resolve; });
      const previousStart = startWork;
      startWork = (async () => {
        await previousStart;
        if (disposed || attempt !== revision) { resolveAttempt(false); return; }
        try {
          const next = await request(kind, 'start');
          if (disposed || attempt !== revision) {
            await request(kind, 'cancel', { id: next.id }).catch(() => {});
            resolveAttempt(false);
            return;
          }
          flow = next;
          render();
          if (['signed-in', 'failed', 'cancelled'].includes(next.state)) settle(next.state === 'signed-in');
          else void poll(attempt);
        } catch { if (!disposed && attempt === revision) fail(); else resolveAttempt(false); }
      })();
      return completed;
    },
    dispose(): void {
      disposed = true;
      revision += 1;
      controller?.abort();
      if (flow && !['signed-in', 'failed', 'cancelled'].includes(flow.state)) {
        void request(kind, 'cancel', { id: flow.id }).catch(() => {});
      }
      link.removeAttribute('href');
      settle(false);
    },
  };
}
