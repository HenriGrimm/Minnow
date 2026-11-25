import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { await environment?.dispose(); });

for (const populated of [false, true]) {
  test('Factory initializes ' + (populated ? 'an existing project folder' : 'an empty folder') + ' before the first model turn', async t => {
    const id = 'new-project';
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    let interruptOnce = populated;
    const f = await environment.fixture(t, {
      chats: { [id]: {}, sibling: {} },
      runtimeOptions: { async enableChatWorktree(input) {
        if (interruptOnce) {
          interruptOnce = false;
          throw new Error('Interrupted after the first commit');
        }
        return (await import('../../server/worktree/worktree-ops.js')).enableChatWorktree(input);
      } },
      async loadSkill(name) { return (await import('../../server/skills/scan.js')).getSkillById(process.cwd(), name); },
      async install(_, { workspace }) {
        if (populated) {
          await writeFile(path.join(workspace, 'index.js'), 'original project');
          await writeFile(path.join(workspace, '.env'), 'ignored fixture');
        }
      },
      respond() {
        // Finish this setup-only fixture after its first real turn.
        if (f.calls.length === 1) f.runtime.factory.control(id, f.repository.getChat(id).factoryRun.id, 'clear');
        return 'Ready in the thread worktree.';
      },
    });
    const accepted = await f.request('/api/chats/' + id + '/commands', {
      action: 'send', text: 'Build an app', clientRequestId: 'factory-init',
      intent: { version: 1, goalDriven: true, skill: { id: 'factory', source: 'slash', input: 'Build an app' } },
    });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await f.runtime.service.idle();
    if (populated) {
      assert.equal(f.repository.getCommand(accepted.body.receipt.commandId).state, 'failed');
      assert.equal(f.calls.length, 0);
      await f.runtime.factory.notify(id);
      // Expire the retry deadline instead of sleeping through the backoff.
      f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.factoryRun.retryAt',0) WHERE chat_id=?").run(id);
      await f.runtime.factory.notify(id);
      await f.runtime.service.idle();
    }
    const chat = f.repository.getChat(id);
    const record = f.repository.getCommand(chat.factoryRun.cursor);
    assert.equal(record.state, 'settled', JSON.stringify(record.error || record.result));
    assert.equal(chat.workspacePreparation.status, 'ready');
    assert.ok(chat.worktreeRoot && path.resolve(chat.worktreeRoot) !== path.resolve(chat.workspacePath));
    assert.equal(git(chat.workspacePath, 'branch', '--show-current'), 'main');
    assert.notEqual(git(chat.worktreeRoot, 'branch', '--show-current'), 'main');
    assert.equal(git(chat.workspacePath, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(chat.worktreeRoot, 'rev-parse', 'HEAD'), git(chat.workspacePath, 'rev-parse', 'HEAD'));
    assert.equal(f.repository.getCommand(accepted.body.receipt.commandId).captured.scope.workspaceId, record.captured.scope.workspaceId);
    const peer = await f.request('/api/chats/sibling/commands', { action: 'send', text: 'Check the local project', clientRequestId: 'local-sibling' });
    assert.equal(peer.status, 202);
    await f.runtime.service.idle();
    const sibling = f.repository.getCommand(peer.body.receipt.commandId);
    assert.equal(sibling.state, 'settled');
    assert.equal(sibling.captured.scope.projectId, record.captured.scope.projectId);
    assert.notEqual(sibling.captured.scope.workspaceId, record.captured.scope.workspaceId);
    assert.equal(git(sibling.captured.scope.canonicalKey, 'branch', '--show-current'), 'main');
    await writeFile(path.join(record.captured.scope.canonicalKey, 'factory-only.txt'), 'thread output');
    await assert.rejects(readFile(path.join(sibling.captured.scope.canonicalKey, 'factory-only.txt')), { code: 'ENOENT' });
    if (populated) {
      assert.equal(await readFile(path.join(chat.worktreeRoot, 'index.js'), 'utf8'), 'original project');
      assert.equal(await readFile(path.join(chat.workspacePath, '.env'), 'utf8'), 'ignored fixture');
      assert.equal(git(chat.workspacePath, 'ls-tree', '--name-only', 'HEAD', '--', '.env'), '');
    }
  });
}

test('an HTTP factory admission runs the shipped skill and independently verifies actual terminal receipts without a renderer', { timeout: 65000 }, async t => {
  let verifierCalls = 0;
  const f = await environment.fixture(t, {
    chats: { factory: {} }, toolNames: ['execute_command', 'read_file', 'save_file'],
    async loadSkill(id) {
      const { getSkillById } = await import('../../server/skills/scan.js');
      return getSkillById(process.cwd(), id);
    },
    async install(_, { workspace }) {
      const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, windowsHide: true });
      git('init', '-b', 'main');
      await mkdir(path.join(workspace, 'factory'));
      await writeFile(path.join(workspace, 'factory/progress.json'), JSON.stringify({ reviews: [{ afterFeature: 'F1' }], features: [{ id: 'F1', passes: true, checks: ['git --version'] }] }));
      await writeFile(path.join(workspace, 'factory/factory.json'), JSON.stringify({ gates: [{ command: 'git --version' }], full: [{ command: 'git --version' }] }));
      await writeFile(path.join(workspace, 'factory/spec.md'), 'Build F1.');
      await writeFile(path.join(workspace, 'factory/REPORT.md'), 'Verified F1.\n\n## How to run\nRun git --version.\n\n## Next steps\nNo manual steps.');
      git('add', 'factory'); git('commit', '-m', 'factory: contract');
    },
    respond(body) {
      const user = body.messages.filter(m => m.role === 'user').at(-1);
      if (!String(user?.content).includes('Verify the completed factory contract')) return 'The feature and report are committed.';
      verifierCalls++;
      assert.ok(!body.tools?.some(t => t.function.name === 'save_file'));
      assert.ok(!body.tools?.some(t => t.function.name === 'execute_command'));
      return 'I inspected the results.\nYES';
    },
  });
  f.settings.meta.toolSecurity.permissionLevel = 'full';
  const accepted = await f.request('/api/chats/factory/commands', { action: 'send', text: 'Build F1', clientRequestId: 'start-factory',
    intent: { version: 1, goalDriven: true, skill: { id: 'factory', source: 'slash', input: 'Build F1' } } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const runId = accepted.body.receipt.commandId;
  const origin = f.repository.getCommand(runId);
  assert.equal(accepted.body.frame.fields.factoryGoal?.factoryRunId, runId, JSON.stringify({ intent: origin.command.intent, skillGoal: origin.captured.turnIntent?.skillGoal, body: origin.captured.turnIntent?.skillBody?.slice(0, 60), meta: f.repository.getChat('factory').factoryRun, fields: Object.keys(accepted.body.frame.fields) }));
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline && !f.repository.getChat('factory').activeGoal?.achieved) {
    if (f.repository.getChat('factory').factoryRun.status === 'paused') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const chat = f.repository.getChat('factory');
  assert.equal(chat.activeGoal.achieved, true, JSON.stringify({ run: chat.factoryRun, commands: f.repository.listCommands({ chatId: 'factory' }).map(c => [c.commandId, c.error, c.result]), results: f.db.prepare('SELECT tool_name,result_json FROM chat_tool_invocations').all() }));
  assert.equal(verifierCalls, 1);
  assert.ok(chat.worktreeRoot);
  assert.notEqual(path.resolve(chat.worktreeRoot), path.resolve(chat.workspacePath));
  assert.equal(execFileSync('git', ['branch','--show-current'], { cwd: chat.workspacePath, encoding: 'utf8' }).trim(), 'main');
  assert.match(f.repository.readTranscript('factory').messages.at(-1).content, /Factory complete[\s\S]*How to run[\s\S]*Next steps/);
  const stale = await f.request('/api/chats/factory/factory', { runId: 'other', action: 'clear' });
  assert.equal(stale.status, 409);
  const clear = await f.request('/api/chats/factory/factory', { runId, action: 'clear' });
  assert.equal(clear.status, 200); assert.equal(clear.body.goal, null);
});
