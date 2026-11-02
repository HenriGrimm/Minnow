import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  getInstanceSnapshot,
  launchInstance,
  resetInstancesForTests,
  consumeCodeChatLaunch,
  ensureBackgroundInstance,
} from '../../src/os/instances.ts';

function codeLaunchOptions() {
  return getInstanceSnapshot().instances.find((i) => i.appId === 'code')?.launchOptions;
}

describe('instance launch options', () => {
  beforeEach(() => {
    resetInstancesForTests();
  });

  test('a Code section launch drops the previous chat intent', () => {
    launchInstance('code', { chatId: 'chat-1', codeSection: 'chat', seed: 'hi', modeId: 'build' });
    launchInstance('code', { codeSection: 'boards' });
    const options = codeLaunchOptions();
    assert.equal(options?.codeSection, 'boards');
    assert.equal(options?.chatId, undefined);
    assert.equal(options?.seed, undefined);
    assert.equal(options?.modeId, undefined);
  });

  test('other apps still merge launch options', () => {
    launchInstance('brain', { brainSection: 'edit', brainEditPath: 'a.md' });
    launchInstance('brain', { brainSection: 'graph' });
    const brain = getInstanceSnapshot().instances.find((i) => i.appId === 'brain');
    assert.equal(brain?.launchOptions?.brainEditPath, 'a.md');
  });

  test('a consumed child link cannot replay on a background update or return to Code', () => {
    launchInstance('code', { chatId: 'restored-child', codeSection: 'chat' });
    consumeCodeChatLaunch(codeLaunchOptions()!);
    launchInstance('models');
    ensureBackgroundInstance('scheduler');
    launchInstance('code');
    assert.equal(codeLaunchOptions()?.chatId, undefined);
    assert.equal(codeLaunchOptions()?.codeSection, 'chat');
  });

  test('a late chat activation cannot consume a newer launch', () => {
    launchInstance('code', { chatId: 'old-child' });
    const previous = codeLaunchOptions()!;
    launchInstance('code', { chatId: 'new-child' });
    consumeCodeChatLaunch(previous);
    assert.equal(codeLaunchOptions()?.chatId, 'new-child');
  });
});
