import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { routeCodeWindowCommand } from '../../src/os/code-window-command.ts';

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

test('an app-only window forwards a seeded chat even on the same workspace', async () => {
  const sent: unknown[] = [];
  globalThis.window = { addEventListener() {}, minnow: {
    viewContext: { appId: 'issues', workspacePath: '/project' },
    window: { sendCodeCommand: async (command: unknown) => { sent.push(command); return { ok: true }; } },
  } } as unknown as Window & typeof globalThis;
  const command = { kind: 'seed' as const, workspacePath: '/project', issueId: 'ISS-3', seed: 'Fix it', modeId: 'build' };
  assert.equal(await routeCodeWindowCommand(command), true);
  assert.deepEqual(sent, [command]);
});

test('an older preload reports a restart instead of silently discarding the action', async () => {
  globalThis.window = { minnow: { viewContext: { appId: 'issues' } } } as unknown as Window & typeof globalThis;
  await assert.rejects(routeCodeWindowCommand({ kind: 'file', workspacePath: '/project', path: 'README.md' }), /Restart Minnow/);
});

test('Code window errors propagate to the workflow caller', async () => {
  globalThis.window = { minnow: {
    viewContext: { appId: 'issues' },
    window: { sendCodeCommand: async () => ({ ok: false, error: 'Folder unavailable' }) },
  } } as unknown as Window & typeof globalThis;
  await assert.rejects(routeCodeWindowCommand({ kind: 'chat', workspacePath: '/project', chatId: 'c1' }), /Folder unavailable/);
});
