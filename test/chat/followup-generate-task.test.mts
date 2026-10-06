/**
 * MIN-206 — agent-chosen follow-up task generation.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  MAX_FOLLOWUP_TASK_CHARS,
  generateFollowupTask,
  sanitizeFollowupTask,
  type FollowupTaskProviderPort,
} from '../../src/chat/followup/generate-task.ts';
import { buildFollowupTaskMessages } from '../../src/chat/followup/prompt.ts';
import { setUtilityModelConfigForTests } from '../../src/config/utility-model-meta.ts';
import { formatSourceLabel, sourceKey } from '../../src/usage/token-ledger.ts';
import type { ChatCompletionBody } from '../../src/api/chat.ts';
import type { ChatCompletionChunk } from '../../src/types.ts';

let activeWindow: Window | undefined;
const originalFetch = globalThis.fetch;

function portFor(chunk: ChatCompletionChunk | Error): FollowupTaskProviderPort {
  return {
    async complete() {
      if (chunk instanceof Error) throw chunk;
      return chunk;
    },
  };
}

/** Fast, offline provider registry so `getActiveProvider` never waits on a socket. */
function stubFetch(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ providers: [], activeProviderId: '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

function seededChat() {
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
  const chat = createEmptyChatObject('small-model');
  chat.modelId = 'small-model';
  chat.providerId = 'local';
  return chat;
}

async function waitForLedger(chat: ReturnType<typeof seededChat>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if ((chat.tokenLedger?.totals.completionCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  activeWindow?.close();
  activeWindow = undefined;
  globalThis.fetch = originalFetch;
});

/** Message content as text, whatever the union member carries. */
function messageText(message: { content?: unknown } | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

describe('buildFollowupTaskMessages', () => {
  test('asks for one imperative next step', () => {
    const messages = buildFollowupTaskMessages('SUMMARY');
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, 'system');
    assert.match(messageText(messages[0]), /single next task/);
    assert.match(messageText(messages[1]), /SUMMARY/);
  });
});

describe('sanitizeFollowupTask', () => {
  test('keeps one clean line', () => {
    assert.equal(sanitizeFollowupTask('1. Review the build for bugs.\n'), 'Review the build for bugs.');
    assert.equal(sanitizeFollowupTask('\n\n-  "ship it"  \nmore'), 'ship it');
    assert.equal(sanitizeFollowupTask('   '), '');
    assert.equal(sanitizeFollowupTask('x'.repeat(1000)).length, MAX_FOLLOWUP_TASK_CHARS);
  });
});

describe('generateFollowupTask', () => {
  test('returns the first line of the completion', async () => {
    const chat = seededChat();
    setUtilityModelConfigForTests({ providerId: 'local', modelId: 'small-model' });
    stubFetch();

    const result = await generateFollowupTask(
      'summary',
      { chat },
      portFor({
        choices: [{ message: { content: '1. Review the build for bugs.\n2. ignore me' } }],
      }),
    );

    assert.equal(result.task, 'Review the build for bugs.');
  });

  test('sends the utility binding and the summary', async () => {
    const chat = seededChat();
    setUtilityModelConfigForTests({ providerId: 'local', modelId: 'small-model' });
    stubFetch();

    let seen: ChatCompletionBody | undefined;
    const port: FollowupTaskProviderPort = {
      async complete(body) {
        seen = body;
        return { choices: [{ message: { content: 'Do the next thing' } }] };
      },
    };

    await generateFollowupTask('THE SUMMARY', { chat }, port);
    assert.equal(seen?.model, 'small-model');
    assert.equal(seen?.max_tokens, 200);
    assert.match(messageText(seen?.messages?.[1]), /THE SUMMARY/);
  });

  test('a failing port yields no task instead of throwing', async () => {
    const chat = seededChat();
    setUtilityModelConfigForTests({ providerId: 'local', modelId: 'small-model' });
    stubFetch();

    const result = await generateFollowupTask('summary', { chat }, portFor(new Error('boom')));
    assert.deepEqual(result, { task: null });
  });

  test('empty output yields no task', async () => {
    const chat = seededChat();
    setUtilityModelConfigForTests({ providerId: 'local', modelId: 'small-model' });
    stubFetch();

    const result = await generateFollowupTask(
      'summary',
      { chat },
      portFor({ choices: [{ message: { content: '   \n  ' } }] }),
    );
    assert.equal(result.task, null);
  });

  test('records usage on the chat ledger under the utility source', async () => {
    const chat = seededChat();
    setUtilityModelConfigForTests({ providerId: 'local', modelId: 'small-model' });
    stubFetch();

    const result = await generateFollowupTask(
      'summary',
      { chat },
      portFor({
        choices: [{ message: { content: 'Next step' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    );

    assert.equal(result.task, 'Next step');
    await waitForLedger(chat);
    assert.equal(chat.tokenLedger?.bySource['utility:followup-task']?.totalTokens, 14);
  });

  test('no bound model yields no task', async () => {
    const chat = seededChat();
    chat.modelId = '';
    chat.providerId = '';
    setUtilityModelConfigForTests({ providerId: '', modelId: '' });

    const result = await generateFollowupTask('summary', { chat }, portFor({}));
    assert.deepEqual(result, { task: null });
  });
});

describe('utility token-ledger source', () => {
  test('has a stable key and label', () => {
    assert.equal(sourceKey({ kind: 'utility', task: 'followup-task' }), 'utility:followup-task');
    assert.equal(formatSourceLabel({ kind: 'utility', task: 'followup-task' }), 'Follow-up task');
  });
});
