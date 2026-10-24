import type { PowerSaveBlocker, WebContents } from 'electron';

/** Share one system sleep blocker across all renderers with active chats. */
export function createChatPowerGuard(powerSaveBlocker: Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>) {
  const activeRenderers = new Set<number>();
  let blockerId: number | null = null;

  function sync(): void {
    if (activeRenderers.size > 0) {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
      return;
    }
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
    blockerId = null;
  }

  return {
    setActive(rendererId: number, active: boolean): void {
      if (active) activeRenderers.add(rendererId);
      else activeRenderers.delete(rendererId);
      sync();
    },
    dispose(): void {
      activeRenderers.clear();
      sync();
    },
  };
}

/** Release only the departing document's claim; hidden windows keep theirs. */
export function wireChatPowerGuard(contents: WebContents, guard: ReturnType<typeof createChatPowerGuard>): void {
  const release = () => guard.setActive(contents.id, false);
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) release();
  });
  contents.on('render-process-gone', release);
  contents.on('destroyed', release);
}
