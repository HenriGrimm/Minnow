import { githubAuthRequest, type GitHubAccount } from '../state/github-auth';
import { createGitHubMark } from './icon';
import { installDevTool } from '../api/dev-tools';
import '../styles/github-account.css';

/** Shared account UI; credentials remain owned by GitHub CLI. */
export function mountGitHubAccount(
  mount: HTMLElement,
  onAccount?: (connected: boolean) => void,
  headingTag: 'h2' | 'h3' = 'h2',
  compact = false,
): () => void {
  const root = document.createElement('section');
  root.className = 'github-account';
  root.dataset.settingsSearchKey = 'github.account';
  root.setAttribute('aria-label', 'GitHub account');
  const heading = document.createElement(headingTag);
  heading.className = 'github-account__heading';
  heading.textContent = compact ? 'GitHub' : 'Your GitHub account';
  const intro = document.createElement('header');
  intro.className = 'github-account__intro';
  const mark = createGitHubMark({ size: 40 });
  const description = document.createElement('p');
  description.textContent = compact ? 'Pull requests, CI checks, and issue sync.' : 'Connect once for pull requests, CI checks, and GitHub issue sync across Minnow.';
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
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'github-account__primary';
  install.textContent = 'Set up GitHub';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Check again';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel sign-in';
  const note = document.createElement('p');
  note.className = 'github-account__note';
  note.textContent = 'Uses GitHub CLI on this machine, including any account already signed in. Credentials are managed by the CLI; Minnow does not store a separate GitHub token.';
  actions.append(signIn, install, refresh, cancel);
  const connection = document.createElement('div');
  connection.className = 'github-account__connection';
  connection.append(status, detail, actions);
  if (compact) {
    root.classList.add('settings-row', 'settings-row--actions', 'external-connections__github');
    const label = document.createElement('div');
    label.className = 'settings-row__label';
    heading.className = 'settings-row__title';
    description.className = 'settings-field-hint';
    status.classList.add('external-connections__status');
    actions.className = 'settings-actions';
    for (const button of [signIn, install, refresh, cancel]) button.className = 'settings-action-btn';
    label.append(heading, description, status, detail);
    root.append(label, actions);
  } else {
    root.append(intro, features, connection, note);
  }
  mount.append(root);
  let active = true;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let account: GitHubAccount = { ok: true, flow: null };
  let detailKey = '';
  let installController: AbortController | undefined;
  let installMessage = '';

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
    install.hidden = account.installed !== false || !account.installable;
    install.disabled = busy;
    install.textContent = installController ? 'Setting up…' : 'Set up GitHub';
    signIn.textContent = account.authenticated ? 'Switch account' : 'Sign in with GitHub';
    signIn.disabled = refresh.disabled = busy;
    refresh.hidden = pending;
    cancel.hidden = !pending;
    cancel.disabled = busy;
    status.textContent = installMessage || (pending ? (account.flow?.code ? 'Enter this code on GitHub to finish signing in.' : 'Starting secure sign-in…')
      : account.flow?.state === 'failed' ? `${account.flow.error}${account.authenticated ? ` Still connected as @${account.login}.` : ''}`
      : account.authenticated ? `Connected as @${account.login}`
      : account.installed === false ? 'GitHub CLI is needed to connect your account.'
      : account.installed ? account.error || 'Not connected'
      : 'Checking GitHub…');
    const nextKey = `${pending}:${account.flow?.code}:${account.installed}:${account.installable}:${account.managed}`;
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
        instructions.textContent = account.installable
          ? 'Minnow installs GitHub CLI for you. If Git is missing, approve Apple’s installer when it opens. No Homebrew or terminal commands needed.'
          : compact ? 'Install GitHub CLI, then check again.' : 'Install GitHub CLI from its website, then choose Check again. You can also skip this step.';
        detail.append(instructions);
        if (!account.installable) detail.append(link('Install GitHub CLI', 'https://cli.github.com/'));
      } else if (account.managed) {
        detail.textContent = 'An environment token supplies this account. Manage GH_TOKEN or GITHUB_TOKEN outside Minnow.';
      }
    }
    onAccount?.(Boolean(account.authenticated));
  }

  async function request(action: 'Status' | 'Start' | 'Poll' | 'Cancel'): Promise<void> {
    if (!active || busy) return;
    clearTimeout(timer);
    installMessage = '';
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
    installController?.abort();
    clearTimeout(timer);
  }
  signIn.onclick = () => void request('Start');
  install.onclick = async () => {
    if (busy || !active) return;
    busy = true;
    installMessage = 'Preparing GitHub tools…';
    installController = new AbortController();
    paint();
    try {
      await installDevTool('github', installController.signal, message => {
        if (active) { installMessage = message; paint(); }
      });
      if (!active) return;
      installMessage = '';
      installController = undefined;
      busy = false;
      await request('Status');
      if (account.installed && !account.authenticated) await request('Start');
    } catch (error) {
      if (!active) return;
      installMessage = error instanceof Error ? error.message : 'Setup failed. Retry here.';
      installController = undefined;
      busy = false;
      paint();
    }
  };
  refresh.onclick = () => void request('Status');
  cancel.onclick = () => void request('Cancel');
  void request('Status');
  return cleanup;
}
