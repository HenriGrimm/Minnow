import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  resolveExpertChatSeed,
  resolveExpertToolNames,
} from '../../../src/chat/experts/runtime-profile.ts';
import {
  registerExpertFilesFromRaw,
  resetExpertRegistry,
} from '../../../src/chat/experts/registry.ts';

describe('resolveExpertChatSeed', () => {
  beforeEach(() => {
    resetExpertRegistry();
    registerExpertFilesFromRaw(
      {
        './experts/software-engineer/expert.full.md': `---
id: software-engineer
kind: expert
label: SE
greeting: Hello from SE.
---
Body`,
      },
      'builtin',
    );
  });

  test('inherits source chat binding when no profile override', () => {
    const result = resolveExpertChatSeed(
      'software-engineer',
      {
        providerId: 'lmstudio',
        modelId: 'qwen',
        modeId: 'build',
        workspacePath: '/tmp/ws',
      },
      { enabled: true, profiles: {} },
      {
        availableModeIds: new Set(['build', 'general']),
        availableModelKeys: new Set(['qwen', 'lmstudio:qwen']),
        resolveModeToolNames: () => ['read_file', 'write_file'],
      },
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.modelId, 'qwen');
    assert.equal(result.modeId, 'build');
    assert.equal(result.greeting, 'Hello from SE.');
    assert.deepEqual(result.runtimeSnapshot.enabledToolNames, [
      'read_file',
      'write_file',
    ]);
  });

  test('applies valid model overrides with the shared agent', () => {
    const result = resolveExpertChatSeed(
      'software-engineer',
      {
        modelId: 'qwen',
        modeId: 'build',
        workspacePath: '/tmp/ws',
      },
      {
        enabled: true,
        profiles: {
          'software-engineer': {
            providerId: 'lmstudio',
            modelId: 'mistral',
            modeId: 'general',
            toolAllowlist: ['read_file'],
          },
        },
      },
      {
        availableModeIds: new Set(['build', 'general']),
        availableModelKeys: new Set(['mistral', 'lmstudio:mistral', 'qwen']),
        resolveModeToolNames: (modeId) =>
          modeId === 'general'
            ? ['read_file', 'write_file', 'grep']
            : ['read_file', 'write_file'],
      },
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.modelId, 'mistral');
    assert.equal(result.modeId, 'build');
    assert.deepEqual(result.runtimeSnapshot.enabledToolNames, ['read_file']);
  });
});

describe('resolveExpertToolNames', () => {
  test('intersects allowlist and subtracts denylist', () => {
    const out = resolveExpertToolNames(['read_file', 'write_file', 'grep'], {
      toolAllowlist: ['read_file', 'write_file', 'grep'],
      toolDenylist: ['grep'],
    });
    assert.deepEqual(out.enabledToolNames, ['read_file', 'write_file']);
  });
});
