import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { codeCommands, destinationCommands, initShellCommands, resetShellCommandsForTests } from '../../src/ui/shell-commands';
import { listCommands, resetCommandRegistryForTests } from '../../src/ui/command-registry';
import { SETTINGS_SECTIONS } from '../../src/ui/settings-page-types';
import { MODELS_SECTIONS } from '../../src/ui/models-section-ids';

afterEach(() => {
  resetShellCommandsForTests();
  resetCommandRegistryForTests();
});

test('destinations follow shipped catalogs and exclude retired settings', () => {
  const commands = destinationCommands();
  const ids = commands.map((command) => command.id);
  assert.deepEqual(ids.filter((id) => id.startsWith('settings.')), SETTINGS_SECTIONS.map((id) => `settings.${id}`));
  assert.deepEqual(ids.filter((id) => id.startsWith('models.')), MODELS_SECTIONS.map((id) => `models.${id}`));
  for (const stale of ['settings.deep-research', 'settings.providers', 'settings.voice', 'code.overview']) {
    assert.ok(!ids.includes(stale), stale);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('Code actions are scoped to Code and only create composer modes', () => {
  assert.deepEqual(codeCommands(false), []);
  assert.deepEqual(codeCommands(true).filter((command) => command.id.startsWith('chat.new.')).map((command) => command.id), [
    'chat.new.general', 'chat.new.build', 'chat.new.plan', 'chat.new.debug',
  ]);
});

test('shell registration is idempotent and excludes hidden apps', () => {
  initShellCommands();
  initShellCommands();
  const ids = listCommands().map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('app.home'));
  for (const hidden of ['research', 'experts', 'bench', 'compare']) assert.ok(!ids.includes(`app.${hidden}`));
});

test('Code commands hide controls without targets and reveal them when mounted', () => {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  try {
    const commands = codeCommands(true);
    const search = commands.find((command) => command.id === 'chat.search')!;
    const save = commands.find((command) => command.id === 'code.save')!;
    assert.equal(search.available?.(), false);
    assert.equal(save.available?.(), false);
    document.body.innerHTML = '<button id="btnChatSearch"></button><div class="cm-editor"></div>';
    assert.equal(search.available?.(), true);
    assert.equal(save.available?.(), true);
  } finally {
    win.close();
  }
});
