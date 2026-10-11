import { githubAuthRequest, type GitHubAccount } from '../state/github-auth';
import '../styles/github-account.css';

/** Shared account UI; credentials remain owned by GitHub CLI. */
export function mountGitHubAccount(mount: HTMLElement, onAccount?: (connected: boolean) => void, headingTag: 'h2' | 'h3' = 'h2'): () => void {
  const root = document.createElement('section');
  root.className = 'github-account';
  root.dataset.settingsSearchKey = 'github.account';
  root.setAttribute('aria-label', 'GitHub account');
  const heading = document.createElement(headingTag);
  heading.className = 'github-account__heading';
  heading.textContent = 'Your GitHub account';
  const intro = document.createElement('header');
  intro.className = 'github-account__intro';
  const mark = document.createElement('span');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .75C5.79.75.75 5.79.75 12c0 4.97 3.22 9.18 7.69 10.67.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 .1 1.55 2.19 3.28 1.59.1-.72.39-1.2.71-1.48-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.42.11-2.96 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.63 0c2.15-1.46 3.1-1.15 3.1-1.15.61 1.54.23 2.68.11 2.96.72.79 1.16 1.79 1.16 3.02 0 4.33-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.25 11.25 0 0 0 23.25 12C23.25 5.79 18.21.75 12 .75Z"/></svg>';
  mark.className = 'github-account__mark';
  const description = document.createElement('p');
  description.textContent = 'Connect once for pull requests, CI checks, and GitHub issue sync across Minnow.';
  const copy = document.createElement('div');
  copy.append(heading, description);
  intro.append(mark, copy);
  const features = document.createElement('ul');
  features.className = 'github-account__features';
  for (const [title, detail] of [
    ['Pull requests', 'Create and review changes in your workspace.'],
    ['Actions', 'Follow workflows and CI checks alongside your code.'],
    ['Issues', 'Connect GitHub issues to your project.'],
  ]) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = title;
    const text = document.createElement('span');
    text.textContent = detail;
    item.append(label, text);
    features.append(item);
  }
  const status = document.createElement('p');
  status.className = 'github-account__status';
  status.setAttribute('role', 'status');
  const detail = document.createElement('div');
  detail.className = 'github-account__detail';
  const actions = document.createElement('div');
  actions.className = 'github-account__actions';
  const signIn = document.createElement('button');
  signIn.type = 'button';
  signIn.className = 'github-account__primary';
  signIn.textContent = 'Sign in with GitHub';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Check again';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel sign-in';
  const note = document.createElement('p');
  note.className = 'github-account__note';
  note.textContent = 'Uses GitHub CLI on this machine, including any account already signed in. Credentials are managed by the CLI; Minnow does not store a separate GitHub token.';
  actions.append(signIn, refresh, cancel);
  const connection = document.createElement('div');
  connection.className = 'github-account__connection';
  connection.append(status, detail, actions);
  root.append(intro, features, connection, note);
  mount.append(root);
  let active = true;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let account: GitHubAccount = { ok: true, flow: null };
  let detailKey = '';

  function link(label: string, url: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.textContent = label;
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function paint(): void {
    const pending = account.flow?.state === 'pending';
    root.dataset.state = pending ? 'pending' : account.authenticated ? 'connected' : 'disconnected';
    root.setAttribute('aria-busy', String(busy));
    signIn.hidden = !account.installed || Boolean(account.managed) || pending;
    signIn.textContent = account.authenticated ? 'Switch account' : 'Sign in with GitHub';
    signIn.disabled = refresh.disabled = busy;
    refresh.hidden = pending;
    cancel.hidden = !pending;
    cancel.disabled = busy;
    status.textContent = pending ? (account.flow?.code ? 'Enter this code on GitHub to finish signing in.' : 'Starting secure sign-in…')
      : account.flow?.state === 'failed' ? `${account.flow.error}${account.authenticated ? ` Still connected as @${account.login}.` : ''}`
      : account.authenticated ? `Connected as @${account.login}`
      : account.installed === false ? 'GitHub CLI is needed to connect your account.'
      : account.installed ? account.error || 'Not connected'
      : 'Checking GitHub…';
    const nextKey = `${pending}:${account.flow?.code}:${account.installed}:${account.managed}`;
    if (detailKey !== nextKey) {
      detailKey = nextKey;
      detail.replaceChildren();
      if (pending && account.flow?.code) {
        const code = document.createElement('code');
        code.className = 'github-account__code';
        code.textContent = account.flow.code;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy code';
        copy.onclick = () => {
          void navigator.clipboard.writeText(code.textContent || '').then(() => {
            copy.textContent = 'Copied';
          }).catch(() => { copy.textContent = 'Select and copy the code above'; });
        };
        detail.append(code, copy, link('Continue on GitHub', 'https://github.com/login/device'));
      } else if (account.installed === false) {
        const instructions = document.createElement('p');
        instructions.textContent = 'Install GitHub CLI from its website, restart Minnow, then return here and choose Check again. You can also skip this step.';
        detail.append(instructions, link('Install GitHub CLI', 'https://cli.github.com/'));
      } else if (account.managed) {
        detail.textContent = 'An environment token supplies this account. Manage GH_TOKEN or GITHUB_TOKEN outside Minnow.';
      }
    }
    onAccount?.(Boolean(account.authenticated));
  }

  async function request(action: 'Status' | 'Start' | 'Poll' | 'Cancel'): Promise<void> {
    if (!active || busy) return;
    clearTimeout(timer);
    busy = true;
    paint();
    try {
      const result = await githubAuthRequest(action);
      if (!active) return;
      account = action === 'Status' ? result : { ...account, ...result };
      if (action === 'Poll' && account.flow?.state === 'complete') {
        account = await githubAuthRequest('Status');
      }
      if (!active) return;
      busy = false;
      paint();
      if (account.flow?.state === 'pending') timer = setTimeout(() => {
        if (!root.isConnected) { cleanup(); return; }
        void request('Poll');
      }, 1500);
    } catch (error) {
      if (!active) return;
      busy = false;
      paint();
      status.textContent = error instanceof Error ? error.message : 'Could not check GitHub. Try again.';
      refresh.hidden = false;
    }
  }

  function cleanup(): void {
    active = false;
    clearTimeout(timer);
  }
  signIn.onclick = () => void request('Start');
  refresh.onclick = () => void request('Status');
  cancel.onclick = () => void request('Cancel');
  void request('Status');
  return cleanup;
}
