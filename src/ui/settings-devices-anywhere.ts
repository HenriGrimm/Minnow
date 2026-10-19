/**
 * The Anywhere (built-in Tailscale) setup states, shared by the Devices page and
 * the Connect sheet. Each state has exactly one primary action.
 */

import {
  logoutAnywhere,
  openExternalUrl,
  setAnywhere,
  type AnywhereStatus,
  type RemoteStatus,
} from '../api/remote-admin.ts';
import { appConfirm } from './app-dialog.ts';
import { showToast } from './toast.ts';

/** Anywhere states that change on their own and need polling. */
export function isAnywhereSettling(status: AnywhereStatus): boolean {
  return (
    status.state === 'starting' ||
    status.state === 'needs-login' ||
    status.state === 'needs-approval' ||
    (status.state === 'error' && status.code === 'helper-exited')
  );
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(label: string, primary = false): HTMLButtonElement {
  const node = el('button', primary ? 'settings-action-btn settings-action-btn--primary' : 'settings-action-btn', label);
  node.type = 'button';
  return node;
}

/**
 * Render the current Anywhere state into `mount`. `onChange` receives the new
 * status after any action so the caller can re-render.
 */
export function renderAnywhereState(
  mount: HTMLElement,
  status: AnywhereStatus,
  onChange: (next: RemoteStatus) => void,
): void {
  mount.replaceChildren();
  const copy = (text: string) => mount.appendChild(el('p', 'devices-card__copy', text));
  const actions = el('div', 'devices-card__actions');
  const run = (button: HTMLButtonElement, action: () => Promise<RemoteStatus>) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      void action()
        .then(onChange)
        .catch((err: Error) => {
          button.disabled = false;
          showToast(err.message || 'Something went wrong', 'error');
        });
    });
  };
  /** Forget the node's account and start over, so a different one can sign in. */
  const switchAccount = () => {
    const button = actionButton('Use a different account');
    run(button, () => logoutAnywhere().then(() => setAnywhere(true)));
    return button;
  };
  const accountHint = () => {
    if (status.loginName) mount.appendChild(el('p', 'settings-field-hint', `Tailscale account: ${status.loginName}`));
  };

  switch (status.state) {
    case 'unavailable':
      copy("Anywhere access isn't included in this build of Minnow.");
      if (import.meta.env?.DEV) copy('Developers: run npm run tailnet:build, then reopen this page.');
      break;
    case 'off': {
      copy('Reach Minnow from your phone at home, at work, or on mobile data. Uses a free Tailscale account; your phone needs nothing installed.');
      const start = actionButton('Make it work anywhere', true);
      run(start, () => setAnywhere(true));
      actions.append(start);
      break;
    }
    case 'starting': {
      copy('Starting the secure connection…');
      const cancel = actionButton('Cancel');
      run(cancel, () => setAnywhere(false));
      actions.append(cancel);
      break;
    }
    case 'needs-login': {
      copy('Sign in to Tailscale to get your private address. It is free — use Google, Apple, Microsoft, or GitHub.');
      const signIn = actionButton('Sign in with Tailscale', true);
      signIn.addEventListener('click', () => {
        if (status.authUrl) openExternalUrl(status.authUrl);
      });
      const cancel = actionButton('Cancel');
      run(cancel, () => setAnywhere(false));
      actions.append(signIn, cancel);
      break;
    }
    case 'needs-approval': {
      const step = {
        device: {
          text: 'Your Tailscale account requires new devices to be approved. Approve this computer on the Machines page that opens, then come back.',
          label: 'Approve this computer',
        },
        funnel: {
          text: 'One more step: allow phones without the Tailscale app to reach Minnow. Approve it on the page that opens, then come back.',
          label: 'Allow access',
        },
        https: {
          text: 'One more step: turn on HTTPS for your Tailscale account. Approve it on the page that opens, then come back.',
          label: 'Turn on HTTPS',
        },
      }[status.feature ?? 'https'];
      copy(step.text);
      accountHint();
      const approve = actionButton(step.label, true);
      approve.addEventListener('click', () => {
        if (status.url) openExternalUrl(status.url);
      });
      const cancel = actionButton('Cancel');
      run(cancel, () => setAnywhere(false));
      actions.append(approve, switchAccount(), cancel);
      break;
    }
    case 'ready': {
      const address = el('div', 'devices-address');
      address.append(el('code', 'devices-address__url', status.url ?? ''));
      const copyBtn = el('button', 'settings-inline-btn', 'Copy');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', () => {
        void navigator.clipboard.writeText(status.url ?? '').then(
          () => showToast('Address copied'),
          () => showToast('Could not copy the address', 'error'),
        );
      });
      address.append(copyBtn);
      mount.append(address);
      copy(
        status.funnel === false
          ? 'Works anywhere for devices signed in to the Tailscale app.'
          : 'Works anywhere. Your phone needs nothing installed — only devices you connect can use Minnow.',
      );
      accountHint();

      const privateRow = el('label', 'devices-checkbox');
      const privateInput = el('input');
      privateInput.type = 'checkbox';
      privateInput.checked = status.funnel === false;
      privateRow.append(privateInput, el('span', '', 'Only devices with the Tailscale app'));
      privateInput.addEventListener('change', () => {
        privateInput.disabled = true;
        void setAnywhere(true, { funnel: !privateInput.checked })
          .then(onChange)
          .catch(() => {
            privateInput.disabled = false;
            privateInput.checked = !privateInput.checked;
          });
      });
      mount.append(privateRow);

      const off = actionButton('Turn off');
      run(off, () => setAnywhere(false));
      const signOut = actionButton('Sign out of Tailscale');
      signOut.addEventListener('click', () => {
        void appConfirm('Phones using the Anywhere address will stop working until you sign in again.', {
          title: 'Sign out of Tailscale?',
          confirmLabel: 'Sign out',
          danger: true,
        }).then((confirmed) => {
          if (!confirmed) return;
          signOut.disabled = true;
          void logoutAnywhere().then(onChange, () => { signOut.disabled = false; });
        });
      });
      actions.append(off, signOut);
      break;
    }
    case 'error': {
      copy(status.message || 'Tailscale reported a problem.');
      const retry = actionButton('Try again', true);
      run(retry, async () => {
        await setAnywhere(false);
        return setAnywhere(true);
      });
      const off = actionButton('Turn off');
      run(off, () => setAnywhere(false));
      actions.append(retry, switchAccount(), off);
      break;
    }
  }
  if (actions.childElementCount) mount.append(actions);
}
