import { captureChatToBrain, captureResearchToBrain } from '../brain/capture-client';
import { isChatStreaming } from '../chat/streaming-state';
import { pushNotification } from '../notifications/push';
import { detectLocalServer } from '../tools/client';
import type { Chat } from '../types';
import { setStatus } from './status';
import { showMemorySavedToast } from './memory-saved-toast';

type StatusFn = (state: string, msg: string) => void;

/** Guard + run chat capture with status toasts and optional Brain deep-link. */
export async function runChatBrainCapture(
  chat: Chat,
  setStatusFn: StatusFn = setStatus,
): Promise<BrainCaptureOutcome | null> {
  if (isChatStreaming(chat.id)) {
    setStatusFn('spin', 'Finish the current reply first');
    return null;
  }
  if (!chat.history.length) {
    setStatusFn('err', 'Chat has no messages to capture');
    return null;
  }

  const serverUp = await detectLocalServer();
  if (!serverUp) {
    setStatusFn('err', 'Minnow is not running locally — open or restart the app');
    return null;
  }

  setStatusFn('spin', 'Adding to Brain…');
  try {
    const result = await captureChatToBrain(chat);
    if (!result) {
      setStatusFn('err', 'Capture failed');
      return null;
    }

    pushNotification({
      kind: 'synthesis',
      title: 'Added to Brain',
      preview: result.title,
      appId: 'brain',
      dedupeKey: `brain-capture:chat:${chat.id}`,
    });

    setStatusFn('ok', 'Added to Brain');
    showMemorySavedToast({
      title: result.title,
      description: 'Captured from this chat and saved to Brain.',
      target: { kind: 'page', relPath: result.relPath },
    });
    return { relPath: result.relPath, title: result.title };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Capture failed';
    setStatusFn('err', msg);
    return null;
  }
}

export interface BrainCaptureOutcome {
  relPath: string;
  title: string;
}

/** Run research capture with the same success notification pattern. */
export async function runResearchBrainCapture(
  researchId: string,
  setStatusFn: StatusFn = setStatus,
): Promise<BrainCaptureOutcome | null> {
  const serverUp = await detectLocalServer();
  if (!serverUp) {
    setStatusFn('err', 'Minnow is not running locally — open or restart the app');
    return null;
  }

  setStatusFn('spin', 'Adding to Brain…');
  try {
    const result = await captureResearchToBrain(researchId);
    if (!result) {
      setStatusFn('err', 'Capture failed');
      return null;
    }

    pushNotification({
      kind: 'research',
      title: 'Research added to Brain',
      preview: result.title,
      appId: 'brain',
      dedupeKey: `brain-capture:research:${researchId}`,
    });

    setStatusFn('ok', 'Added to Brain');
    showMemorySavedToast({
      title: result.title,
      description: 'Captured from this research session and saved to Brain.',
      target: { kind: 'page', relPath: result.relPath },
    });
    return { relPath: result.relPath, title: result.title };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Capture failed';
    setStatusFn('err', msg);
    return null;
  }
}

/** Open captured page in Brain Edit after successful capture. */
export async function openCapturedBrainPage(relPath: string): Promise<void> {
  const { openBrainEditForPath } = await import('./brain-page');
  openBrainEditForPath(relPath);
}
