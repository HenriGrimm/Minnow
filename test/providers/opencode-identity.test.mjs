/**
 * OpenCode Go routing identity headers (User-Agent + x-opencode-session).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
const { version } = createRequire(import.meta.url)('../../package.json');
import {
  mergeOpenCodeIdentityHeaders,
  MINNOW_OPENCODE_USER_AGENT,
  OPENCODE_SESSION_CATALOG,
  OPENCODE_SESSION_HEADER,
  openCodeSessionIdForGeneration,
} from '../../server/providers/opencode-identity.js';

describe('openCodeSessionIdForGeneration', () => {
  it('prefers the chat id so follow-up turns share a cache key', () => {
    assert.equal(
      openCodeSessionIdForGeneration({
        chatId: '11111111-1111-1111-1111-111111111111',
        id: '22222222-2222-2222-2222-222222222222',
      }),
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('falls back to the generation id when chatId is missing', () => {
    assert.equal(
      openCodeSessionIdForGeneration({
        chatId: null,
        id: '22222222-2222-2222-2222-222222222222',
      }),
      '22222222-2222-2222-2222-222222222222',
    );
  });
});

describe('mergeOpenCodeIdentityHeaders', () => {
  it('leaves non-OpenCode hosts unchanged', () => {
    const headers = { Authorization: 'Bearer sk-fixed' };
    assert.deepEqual(
      mergeOpenCodeIdentityHeaders(headers, { baseUrl: 'https://api.openai.com', sessionId: 'chat-1' }),
      { Authorization: 'Bearer sk-fixed' },
    );
  });

  it('stamps Minnow User-Agent and session on OpenCode Go', () => {
    const expected = {
      Authorization: 'Bearer sk-go-fixed',
      'User-Agent': `Minnow/${version}`,
      'x-opencode-session': '11111111-1111-1111-1111-111111111111',
    };
    const actual = mergeOpenCodeIdentityHeaders(
      { Authorization: 'Bearer sk-go-fixed', 'User-Agent': 'undici' },
      {
        baseUrl: 'https://opencode.ai/zen/go',
        sessionId: '11111111-1111-1111-1111-111111111111',
      },
    );
    assert.deepEqual(actual, expected);
    assert.equal(MINNOW_OPENCODE_USER_AGENT, `Minnow/${version}`);
    assert.equal(OPENCODE_SESSION_HEADER, 'x-opencode-session');
    assert.equal(OPENCODE_SESSION_CATALOG, 'minnow-catalog');
  });
});
