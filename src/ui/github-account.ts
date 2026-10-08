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
  const description = document.createElement('p');
  description.textContent = 'Connect once for pull requests, CI checks, and GitHub issue sync across Minnow.';
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
  root.append(heading, description, status, detail, actions, note);
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
    root.setAttribute('aria-busy', String(busy));
    signIn.hidden = !account.installed || Boolean(account.managed) || pending;
    signIn.textContent = account.authenticated ? 'Sign in again' : 'Sign in with GitHub';
    signIn.disabled = refresh.disabled = busy;
    refresh.hidden = pending;
    cancel.hidden = !pending;
    cancel.disabled = busy;
    status.textContent = pending ? (account.flow?.code ? 'Enter this code on GitHub to finish signing in.' : 'Starting secure sign-in…')
      : account.flow?.state === 'failed' ? `${account.flow.error}${account.authenticated ? ` Still connected as @${account.login}.` : ''}`
      : account.authenticated ? `Connected as @${account.login}`
      : account.installed === false ? 'Install GitHub CLI, restart Minnow, then check again.'
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
        detail.append(link('Install GitHub CLI', 'https://cli.github.com/'));
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
