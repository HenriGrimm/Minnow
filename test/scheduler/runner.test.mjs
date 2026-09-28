/**
 * Scheduler runner subprocess tests with a fake minnow CLI.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { writeResource } from '../../server/config/store.js';
import { createJob, getStoredJobById } from '../../server/scheduler/store.js';
import { listRunsForJob, runStoredJob } from '../../server/scheduler/runner.js';
import { getSchedulerWorkspacePath } from '../../server/scheduler-workspace/paths.js';

describe('scheduler runner', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-runner-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
  });

  after(async () => {
    // runStoredJob → resolveJobRunModel may open sessions.db — close before rm (Windows EBUSY).
    closeSessionsDb();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test('captures fake subprocess JSON and records completed run', async () => {
    const payload = {
      version: 1,
      ok: true,
      exitCode: 0,
      assistantFinal: 'All good',
      error: null,
      chatId: '11111111-1111-1111-1111-111111111111',
    };

    /** @type {string[] | undefined} */
    let capturedArgs;

    const fakeSpawn = (_execPath, args) => {
      capturedArgs = args;
      const handlers = {};
      return {
        stdout: {
          on: (event, fn) => {
            if (event === 'data') handlers.stdout = fn;
          },
        },
        stderr: { on: () => undefined },
        on: (event, fn) => {
          if (event === 'close') {
            queueMicrotask(() => {
              handlers.stdout?.(Buffer.from(`${JSON.stringify(payload)}\n`));
              fn(0);
            });
          }
        },
        kill: () => undefined,
      };
    };

    const created = await createJob({
      label: 'Runner test',
      schedule: { kind: 'interval', value: '60s' },
      prompt: 'Say OK',
      modeId: 'build',
      channels: ['in_app'],
    });

    const stored = await getStoredJobById(created.id);
    assert.ok(stored);

    const result = await runStoredJob(stored, {
      baseUrl: 'http://127.0.0.1:5173',
      spawn: fakeSpawn,
    });
    assert.equal(result.started, true);
    assert.equal(result.status, 'completed');

    const workspaceIndex = capturedArgs?.indexOf('--workspace') ?? -1;
    assert.ok(workspaceIndex >= 0);
    assert.equal(capturedArgs?.[workspaceIndex + 1], getSchedulerWorkspacePath());

    const runs = await listRunsForJob(created.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.match(runs[0].output ?? '', /All good/);
    assert.equal(runs[0].chatId, payload.chatId);

    const persistIndex = capturedArgs?.indexOf('--persist-chat') ?? -1;
    const chatIdIndex = capturedArgs?.indexOf('--chat-id') ?? -1;
    const schedulerRunIndex = capturedArgs?.indexOf('--scheduler-run') ?? -1;
    assert.ok(persistIndex >= 0);
    assert.ok(chatIdIndex >= 0);
    assert.ok(schedulerRunIndex >= 0);
    assert.equal(capturedArgs?.[chatIdIndex + 1], runs[0].id);

    const after = await getStoredJobById(created.id);
    assert.equal(after?.running, false);
    assert.ok(after?.lastRunAt);
    assert.ok(after?.nextRunAt);
  });

  test('sets ELECTRON_RUN_AS_NODE when the server is Electron', async () => {
    const payload = {
      version: 1,
      ok: true,
      exitCode: 0,
      assistantFinal: 'Electron spawn',
      error: null,
    };

    /** @type {NodeJS.ProcessEnv | undefined} */
    let capturedEnv;

    const fakeSpawn = (_execPath, _args, options) => {
      capturedEnv = options?.env;
      const handlers = {};
      return {
        stdout: {
          on: (event, fn) => {
            if (event === 'data') handlers.stdout = fn;
          },
        },
        stderr: { on: () => undefined },
        on: (event, fn) => {
          if (event === 'close') {
            queueMicrotask(() => {
              handlers.stdout?.(Buffer.from(`${JSON.stringify(payload)}\n`));
              fn(0);
            });
          }
        },
        kill: () => undefined,
      };
    };

    const created = await createJob({
      label: 'Electron spawn env',
      schedule: { kind: 'interval', value: '60s' },
      prompt: 'Say OK',
      modeId: 'build',
      channels: ['in_app'],
    });

    const stored = await getStoredJobById(created.id);
    assert.ok(stored);

    const hadElectron = 'electron' in process.versions;
    process.versions.electron = '43.0.0-test';
    try {
      await runStoredJob(stored, {
        baseUrl: 'http://127.0.0.1:5173',
        spawn: fakeSpawn,
      });
    } finally {
      if (!hadElectron) delete process.versions.electron;
    }

    assert.equal(capturedEnv?.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(capturedEnv?.BROWSER, 'none');
  });

  test('passes explicit --provider and --model when job pins a model', async () => {
    const payload = {
      version: 1,
      ok: true,
      exitCode: 0,
      assistantFinal: 'Pinned model run',
      error: null,
    };

    /** @type {string[] | undefined} */
    let capturedArgs;

    const fakeSpawn = (_execPath, args) => {
      capturedArgs = args;
      const handlers = {};
      return {
        stdout: {
          on: (event, fn) => {
            if (event === 'data') handlers.stdout = fn;
          },
        },
        stderr: { on: () => undefined },
        on: (event, fn) => {
          if (event === 'close') {
            queueMicrotask(() => {
              handlers.stdout?.(Buffer.from(`${JSON.stringify(payload)}\n`));
              fn(0);
            });
          }
        },
        kill: () => undefined,
      };
    };

    const created = await createJob({
      label: 'Pinned model',
      schedule: { kind: 'interval', value: '60s' },
      prompt: 'Use pinned model',
      modeId: 'build',
      providerId: 'lmstudio',
      modelId: 'qwen/qwen3-8b',
      channels: ['in_app'],
    });

    const stored = await getStoredJobById(created.id);
    assert.ok(stored);

    await runStoredJob(stored, {
      baseUrl: 'http://127.0.0.1:5173',
      spawn: fakeSpawn,
    });

    const providerIndex = capturedArgs?.indexOf('--provider') ?? -1;
    const modelIndex = capturedArgs?.indexOf('--model') ?? -1;
    assert.ok(providerIndex >= 0);
    assert.ok(modelIndex >= 0);
    assert.equal(capturedArgs?.[providerIndex + 1], 'lmstudio');
    assert.equal(capturedArgs?.[modelIndex + 1], 'qwen/qwen3-8b');
  });

  test('falls back to active chat model when job has no pinned model', async () => {
    await writeResource('sessions', {
      version: 5,
      activeId: 'chat-fallback',
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: {},
      groups: [],
      chats: [
        {
          id: 'chat-fallback',
          name: 'Fallback',
          workspacePath: '',
          providerId: 'ollama',
          modelId: 'llama3.2:latest',
          history: [],
          lastStats: null,
          modelInfo: {},
          updatedAt: 0,
          lastMessageAt: 0,
        },
      ],
    });

    const payload = {
      version: 1,
      ok: true,
      exitCode: 0,
      assistantFinal: 'Fallback model run',
      error: null,
    };

    /** @type {string[] | undefined} */
    let capturedArgs;

    const fakeSpawn = (_execPath, args) => {
      capturedArgs = args;
      const handlers = {};
      return {
        stdout: {
          on: (event, fn) => {
            if (event === 'data') handlers.stdout = fn;
          },
        },
        stderr: { on: () => undefined },
        on: (event, fn) => {
          if (event === 'close') {
            queueMicrotask(() => {
              handlers.stdout?.(Buffer.from(`${JSON.stringify(payload)}\n`));
              fn(0);
            });
          }
        },
        kill: () => undefined,
      };
    };

    const created = await createJob({
      label: 'Menubar default',
      schedule: { kind: 'interval', value: '60s' },
      prompt: 'Use menubar model',
      modeId: 'build',
      channels: ['in_app'],
    });

    const stored = await getStoredJobById(created.id);
    assert.ok(stored);

    await runStoredJob(stored, {
      baseUrl: 'http://127.0.0.1:5173',
      spawn: fakeSpawn,
    });

    const providerIndex = capturedArgs?.indexOf('--provider') ?? -1;
    const modelIndex = capturedArgs?.indexOf('--model') ?? -1;
    assert.ok(providerIndex >= 0);
    assert.ok(modelIndex >= 0);
    assert.equal(capturedArgs?.[providerIndex + 1], 'ollama');
    assert.equal(capturedArgs?.[modelIndex + 1], 'llama3.2:latest');
  });

  test('skips overlapping runs for the same job', async () => {
    const created = await createJob({
      label: 'Overlap',
      schedule: { kind: 'interval', value: '60s' },
      prompt: 'busy',
      modeId: 'build',
      channels: ['in_app'],
    });

    const stored = await getStoredJobById(created.id);
    assert.ok(stored);
    stored.running = true;

    const result = await runStoredJob(stored);
    assert.equal(result.started, false);
    assert.equal(result.reason, 'already_running');
  });
});
