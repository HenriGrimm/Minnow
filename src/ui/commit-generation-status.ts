import '../styles/commit-generation-status.css';

export interface CommitGenerationOverlay {
  /** Wraps the message input; mount this where the input used to go. */
  host: HTMLDivElement;
  /** Request started: cover the field with the pending indicator. */
  start(): void;
  /** First streamed text arrived: fade the indicator out so the text shows. */
  streaming(): void;
  /** Request finished (success, error or abort). */
  stop(): void;
}

/**
 * Overlays the "Generating commit message…" indicator on the message input
 * itself, so the commit box keeps its height while the request is pending.
 * State lives on the host for the request lifetime, so git polling cannot clear it.
 */
export function wrapWithCommitGenerationOverlay(input: HTMLTextAreaElement): CommitGenerationOverlay {
  const host = document.createElement('div');
  host.className = 'commit-generation-host';
  host.append(input);

  const status = document.createElement('div');
  status.className = 'commit-generation-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const dots = document.createElement('span');
  dots.className = 'commit-generation-status__dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.append(document.createElement('span'));
  const label = document.createElement('span');
  label.className = 'commit-generation-status__label';
  status.append(dots, label);
  host.append(status);

  const setState = (state: 'pending' | 'streaming' | null): void => {
    if (state) host.dataset.state = state;
    else delete host.dataset.state;
    // Only announce while pending; the streamed text speaks for itself.
    label.textContent = state === 'pending' ? 'Generating commit message…' : '';
  };

  return {
    host,
    start: () => setState('pending'),
    streaming: () => {
      if (host.dataset.state === 'pending') setState('streaming');
    },
    stop: () => setState(null),
  };
}
