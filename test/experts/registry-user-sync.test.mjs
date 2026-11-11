import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import {
  initBuiltinExpertRegistry,
  listExperts,
  resetExpertRegistry,
  syncExpertRegistryFromServer,
} from '../../src/chat/experts/registry.ts';

describe('syncExpertRegistryFromServer', () => {
  beforeEach(() => {
    resetExpertRegistry();
    initBuiltinExpertRegistry({
      './experts/general/expert.full.md': `---
id: general
kind: expert
label: General
version: 1
---
[[EXPERT:general]]
General body`,
      './experts/general/expert.lite.md': `---
id: general
kind: expert
label: General
version: 1
---
Lite`,
    });
  });

  afterEach(() => {
    mock.restoreAll();
    resetExpertRegistry();
  });

  test('loads user-only expert from prompt API', async () => {
    const fullMarkdown = `---
id: my-coach
kind: expert
label: My Coach
version: 1
description: Coaching
icon: "🎯"
accent: violet
---
[[EXPERT:my-coach]]
Coach instructions`;

    mock.method(globalThis, 'fetch', async (url) => {
      const href = String(url);
      if (href.includes('/api/prompts/registry')) {
        return {
          ok: true,
          async json() {
            return {
              prompts: [{ kind: 'expert', id: 'my-coach', source: 'user' }],
            };
          },
        };
      }
      if (href.includes('my-coach')) {
        return {
          ok: true,
          async json() {
            return { content: fullMarkdown, source: 'override' };
          },
        };
      }
      return { ok: false };
    });

    await syncExpertRegistryFromServer();
    const coach = listExperts().find((e) => e.meta.id === 'my-coach');
    assert.ok(coach);
    assert.equal(coach.source, 'user');
    assert.equal(coach.meta.label, 'My Coach');
    assert.match(coach.fullBody, /Coach instructions/);
  });
});
