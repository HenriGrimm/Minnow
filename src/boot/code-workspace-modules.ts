/**
 * Lazy initialization for Code workspace modules (editor, terminal, orchestrate hub).
 * Deferred on Minnow desktop cold start so the entry chunk stays smaller.
 */

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Run one init step without letting it take the rest of Code down with it.
 *
 * These steps are independent surfaces (file tree, terminal, hub, …). A single
 * `await` chain meant one throw stranded every step after it — and, because the
 * rejected promise stayed memoized, that window never retried. Two windows boot
 * concurrently now, so a transient failure in one of them used to leave that
 * window with no file tree and no terminal for the rest of the session.
 */
async function step(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`[code-workspace] ${name} failed to initialize`, err);
  }
}

/** Wire file panel, terminal, and code overview once Code workspace is needed. */
export function ensureCodeWorkspaceModules(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      await step('server detection', async () => {
        const { detectLocalServer } = await import('../tools/client');
        await detectLocalServer();
      });

      const filePanel = await import('../ui/init-file-panel');
      await step('file panel', () => filePanel.initFilePanel());
      await step('file panel availability', () =>
        filePanel.onFilePanelServerAvailabilityChanged(),
      );

      const terminal = await import('../ui/terminal-panel');
      await step('terminal panel', () => terminal.initTerminalPanel());
      await step('terminal availability', () => terminal.onTerminalServerAvailabilityChanged());

      await step('shell run UI', async () => {
        const { initShellRunUi } = await import('../ui/shell-run-ui');
        initShellRunUi();
      });

      await step('brain map', async () => {
        const { initCodeBrainMap } = await import('../ui/code-brain-map');
        initCodeBrainMap();
      });

      await step('code overview', async () => {
        const { initCodeOverview } = await import('../ui/code-overview');
        initCodeOverview();
      });

      await step('dev server screen', async () => {
        const { initDevServerScreen } = await import('../ui/dev-server-screen');
        initDevServerScreen();
      });

      await step('views/chats toggle', async () => {
        const { initCodeViewsChatsToggle } = await import('../ui/code-views-chats-toggle');
        initCodeViewsChatsToggle();
      });

      await step('orchestrate hub', async () => {
        const { initOrchestrateHub } = await import('../ui/orchestrate-hub');
        initOrchestrateHub();
      });


      await step('code change strip', async () => {
        const { initCodeChangeStrip } = await import('../ui/code-change-strip');
        initCodeChangeStrip();
      });

      await step('terminal shortcut', () => terminal.registerTerminalKeyboardShortcut());
      initialized = true;
    })().catch((err: unknown) => {
      // Nothing above should reject any more, but a memoized rejection is the
      // one failure mode this module must never re-introduce: clear the memo so
      // the next foreground retries instead of leaving Code half-wired forever.
      console.error('[code-workspace] initialization aborted', err);
      initPromise = null;
    });
  }
  return initPromise ?? Promise.resolve();
}

/** Reset lazy-init state (tests). */
export function resetCodeWorkspaceModulesForTests(): void {
  initialized = false;
  initPromise = null;
}

function isCodeBootRoute(): boolean {
  const hash = window.location.hash;
  return hash.startsWith('#/app/code') || hash === '#/code' || hash.startsWith('#/code/');
}

/** Initialize code workspace modules immediately when the boot hash targets Code. */
export async function ensureCodeWorkspaceModulesForBoot(): Promise<void> {
  if (isCodeBootRoute()) {
    await ensureCodeWorkspaceModules();
  }
}

/** Re-sync file tree / terminal offline state after a later detectLocalServer() probe. */
export async function notifyCodeWorkspaceServerAvailability(): Promise<void> {
  if (!initialized) return;
  const filePanel = await import('../ui/init-file-panel');
  filePanel.onFilePanelServerAvailabilityChanged();
  const terminal = await import('../ui/terminal-panel');
  terminal.onTerminalServerAvailabilityChanged();
}
