import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { registerExpertFilesFromRaw, resetExpertRegistry } from '../../src/chat/experts/registry.ts';

const baseMap = {
  './base/default.full.md': `---
id: default
kind: base
label: Base
version: 1
---
BASE`,
};

describe('expert composer integration', () => {
  beforeEach(() => {
    resetPromptRegistry();
    resetExpertRegistry();
    registerPromptFilesFromRaw({
      ...baseMap,
      './experts/software-engineer/expert.full.md': `---
id: software-engineer
kind: expert
label: SE
version: 1
---
[[EXPERT:software-engineer]]
Expert full body`,
      './experts/software-engineer/expert.lite.md': `---
id: software-engineer
kind: expert
label: SE
version: 1
---
[[EXPERT:software-engineer]]
Lite expert`,
    });
    registerExpertFilesFromRaw(
      {
        './experts/software-engineer/expert.full.md': `---
id: software-engineer
kind: expert
label: SE
version: 1
---
[[EXPERT:software-engineer]]
Expert full body`,
        './experts/software-engineer/expert.lite.md': `---
id: software-engineer
kind: expert
label: SE
version: 1
---
[[EXPERT:software-engineer]]
Lite expert`,
      },
      'builtin',
    );
  });

  test('expert part included when manual id set', () => {
    const out = composeSystemPrompt({
      cwd: '/t',
      modeId: null,
      expertId: 'software-engineer',
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.ok(out.includes('[[EXPERT:software-engineer]]'));
  });

  test('expert part omitted when expertId null', () => {
    const out = composeSystemPrompt({
      cwd: '/t',
      modeId: null,
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.ok(!out.includes('[[EXPERT:'));
  });

  test('a legacy Lite file cannot override the expert prompt', () => {
    const out = composeSystemPrompt({
      cwd: '/t',
      modeId: null,
      expertId: 'software-engineer',
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.ok(!out.includes('Lite expert'));
    assert.ok(out.includes('Expert full body'));
  });
});
