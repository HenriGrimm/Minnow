export type PreviewGuestAttachMode = 'paint' | 'navigate-hidden';

export function resolvePreviewGuestAttachMode(options: {
  explicitBoundsValid: boolean;
  instanceAlreadyVisible: boolean;
}): PreviewGuestAttachMode {
  if (options.explicitBoundsValid || options.instanceAlreadyVisible) return 'paint';
  return 'navigate-hidden';
}

export function shouldKeepPreviewGuestVisibleAfterCapture(wasVisibleBeforeCapture: boolean): boolean {
  return wasVisibleBeforeCapture;
}

/** Repeated layout/show IPC must not reactivate an already painted native guest. */
export function showPreviewGuestIfHidden(entry: {
  visible: boolean;
  view: { setVisible: (visible: boolean) => void };
}): void {
  if (!entry.visible) entry.view.setVisible(true);
  entry.visible = true;
}
