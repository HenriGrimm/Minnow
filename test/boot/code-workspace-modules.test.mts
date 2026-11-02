/**
 * Code workspace boot must survive one bad module.
 *
 * The steps are independent surfaces (file tree, terminal, orchestrate hub, …).
 * A single `await` chain meant one throw stranded every step after it, and the
 * rejected promise stayed memoized so that window never retried — which is how
 * one window ended up with no file tree and no terminal for a whole session
 * while its sibling worked fine.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

const calls: string[] = [];
let filePanelThrows = false;

function stub(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [name]: () => {
      calls.push(name);
    },
    ...extra,
  };
}

mock.module('../../src/tools/client.ts', {
  namedExports: {
    detectLocalServer: async (options?: { refreshTools?: boolean }) => {
      assert.equal(options?.refreshTools, false, 'Code boot must not wait on external tool discovery');
      calls.push('detectLocalServer');
      return true;
    },
  },
});
mock.module('../../src/ui/init-file-panel.ts', {
  namedExports: {
    initFilePanel: async () => {
      calls.push('initFilePanel');
      if (filePanelThrows) throw new Error('preview panel exploded');
    },
    onFilePanelServerAvailabilityChanged: () => {
      calls.push('onFilePanelServerAvailabilityChanged');
    },
  },
});
mock.module('../../src/ui/terminal-panel.ts', {
  namedExports: {
    initTerminalPanel: async () => {
      calls.push('initTerminalPanel');
    },
    onTerminalServerAvailabilityChanged: () => {
      calls.push('onTerminalServerAvailabilityChanged');
    },
    registerTerminalKeyboardShortcut: () => {
      calls.push('registerTerminalKeyboardShortcut');
    },
  },
});
mock.module('../../src/ui/shell-run-ui.ts', { namedExports: stub('initShellRunUi') });
mock.module('../../src/ui/code-brain-map.ts', { namedExports: stub('initCodeBrainMap') });
mock.module('../../src/ui/code-overview.ts', { namedExports: stub('initCodeOverview') });
mock.module('../../src/ui/dev-server-screen.ts', { namedExports: stub('initDevServerScreen') });
mock.module('../../src/ui/code-views-chats-toggle.ts', {
  namedExports: stub('initCodeViewsChatsToggle'),
});
mock.module('../../src/ui/orchestrate-hub.ts', { namedExports: stub('initOrchestrateHub') });
mock.module('../../src/ui/super-plan-entry.ts', { namedExports: stub('initSuperPlanEntry') });
mock.module('../../src/ui/code-change-strip.ts', { namedExports: stub('initCodeChangeStrip') });

const { ensureCodeWorkspaceModules, resetCodeWorkspaceModulesForTests } = await import(
  '../../src/boot/code-workspace-modules.ts'
);

describe('code workspace module boot', { concurrency: false }, () => {
  afterEach(() => {
    resetCodeWorkspaceModulesForTests();
    calls.length = 0;
    filePanelThrows = false;
  });

  test('a throwing step does not strand the surfaces after it', async () => {
    filePanelThrows = true;

    await ensureCodeWorkspaceModules();

    assert.ok(calls.includes('initFilePanel'), 'the failing step still ran');
    // Everything downstream of the failure must still be wired.
    for (const later of [
      'initTerminalPanel',
      'initOrchestrateHub',
      'initCodeChangeStrip',
      'registerTerminalKeyboardShortcut',
    ]) {
      assert.ok(calls.includes(later), `${later} was stranded by the failing step`);
    }
  });

  test('a failed boot is not memoized as a permanent rejection', async () => {
    filePanelThrows = true;
    await ensureCodeWorkspaceModules();
    calls.length = 0;

    // Second foreground: the module is already initialized, so nothing re-runs
    // and — crucially — awaiting it does not reject.
    await ensureCodeWorkspaceModules();
    assert.deepEqual(calls, []);
  });

  test('a clean boot wires every surface once', async () => {
    await ensureCodeWorkspaceModules();
    await ensureCodeWorkspaceModules();

    assert.deepEqual(
      calls.filter((c) => c === 'initOrchestrateHub'),
      ['initOrchestrateHub'],
    );
    assert.equal(calls[0], 'detectLocalServer');
    assert.equal(calls.at(-1), 'registerTerminalKeyboardShortcut');
  });
});
