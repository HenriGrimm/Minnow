import type { ToolImageAttachment } from '../types';
import { withSessionToken } from '../api/session-token';

export function renderGeneratedImageResult(attachment: ToolImageAttachment): HTMLElement {
  const result = document.createElement('div');
  const artifact = attachment.generated!;
  const image = document.createElement('img');
  image.className = 'tool-call-screenshot'; image.loading = 'lazy';
  image.alt = 'Generated workspace image'; image.src = withSessionToken(attachment.url);
  const label = document.createElement('p');
  label.textContent = `${artifact.path} · ${artifact.width} × ${artifact.height} · ${artifact.providerId} / ${artifact.modelId}`;
  const open = document.createElement('a');
  open.href = withSessionToken(attachment.url); open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Open asset';
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'settings-btn'; copy.textContent = 'Copy path';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(artifact.path); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Copy failed'; }
  });
  image.addEventListener('error', () => { image.hidden = true; label.textContent = `Image unavailable: ${artifact.path}`; });
  result.append(image, label, open, copy);
  return result;
}
