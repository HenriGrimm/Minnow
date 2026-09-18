import { app, nativeImage, type NativeImage, type WebContents } from 'electron';
import * as channels from './ipc-channels.js';

/** getFileIcon is usually a few ms; never hold the pressed mouse longer than this. */
const FILE_ICON_TIMEOUT_MS = 120;

let fallbackIcon: NativeImage | null = null;

function loadFallbackIcon(fallbackIconPath: string): NativeImage {
  if (!fallbackIcon || fallbackIcon.isEmpty()) {
    const image = nativeImage.createFromPath(fallbackIconPath);
    fallbackIcon = image.isEmpty() ? image : image.resize({ width: 32, height: 32 });
  }
  return fallbackIcon;
}

/** The OS icon for the first dragged item, or the Minnow logo. macOS rejects an empty icon. */
async function resolveDragIcon(firstPath: string, fallbackIconPath: string): Promise<NativeImage> {
  try {
    const icon = await Promise.race([
      app.getFileIcon(firstPath, { size: 'normal' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FILE_ICON_TIMEOUT_MS)),
    ]);
    if (icon && !icon.isEmpty()) return icon;
  } catch {
    // Fall through to the bundled logo.
  }
  return loadFallbackIcon(fallbackIconPath);
}

/**
 * Hand `files` to the OS as a native drag so Explorer, Finder, the desktop and
 * other apps receive real files. Electron offers copy | link only, so a drop on
 * a file manager copies — the workspace originals are never moved.
 *
 * Windows and Linux run the drag in a nested loop, so `startDrag` returns once
 * the drop lands and the renderer is told the session ended. macOS returns
 * immediately; the renderer ends that session from its own pointer events.
 */
export async function startShellFileDrag(
  sender: WebContents,
  files: string[],
  fallbackIconPath: string,
): Promise<void> {
  const notifyEnded = (): void => {
    if (!sender.isDestroyed()) sender.send(channels.SHELL_FILE_DRAG_ENDED);
  };

  try {
    const icon = await resolveDragIcon(files[0]!, fallbackIconPath);
    if (sender.isDestroyed()) return;
    sender.startDrag({ file: files[0]!, files, icon });
  } catch (err) {
    console.warn('[electron/file-drag] startDrag failed:', err);
    notifyEnded();
    return;
  }

  if (process.platform !== 'darwin') notifyEnded();
}
