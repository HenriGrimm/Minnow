/** Keep the browser's last frame visible while a DOM menu covers its native guest. */
let snapshot: HTMLImageElement | null = null;

export function clearPreviewPopoverSnapshot(): void {
  snapshot?.remove();
  snapshot = null;
}

export async function preparePreviewPopoverSnapshot(): Promise<void> {
  if (snapshot?.isConnected) return;
  const api = window.minnow?.preview;
  const body = document.getElementById('previewBody');
  if (!api?.capturePage || !body) return;
  try {
    const base64 = await api.capturePage(undefined, undefined, true);
    if (!base64 || !body.isConnected) return;
    const image = document.createElement('img');
    image.className = 'preview-popover-snapshot';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    if (!body.isConnected) return;
    clearPreviewPopoverSnapshot();
    body.appendChild(image);
    snapshot = image;
  } catch {
    // Capture failure must not block menus or prevent the live guest returning.
  }
}
