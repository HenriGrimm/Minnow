import '../styles/commit-generation-status.css';

/** Dedicated to the request lifetime, so git polling cannot clear it. */
export function createCommitGenerationStatus(): HTMLDivElement {
  const status = document.createElement('div');
  status.className = 'commit-generation-status';
  status.hidden = true;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const dots = document.createElement('span');
  dots.className = 'commit-generation-status__dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.append(document.createElement('span'));
  status.append(dots, 'Generating commit message…');
  return status;
}
