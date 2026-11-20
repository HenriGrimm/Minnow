/**
 * Project memory guidance: one static block gated on memory tool availability,
 * a read-only variant for agents that cannot save, and no memory text injected
 * into any composed prompt.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PROMPTS_ROOT = path.join(REPO_ROOT, 'src/chat/prompts');
const MEMORY_TOOLS = ['memory_search', 'memory_read', 'memory_save', 'memory_forget'];
const SEEDED = 'SEEDED_MEMORY_MARKER: deploys go through the blue cluster';

async function loadShippedPromptMap() {
  const out = {};
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '_example') await walk(full, rel);
      } else if (entry.name.endsWith('.md')) {
        out[`./${rel.replace(/\\/g, '/')}`] = await fs.readFile(full, 'utf8');
      }
    }
  }
  await walk(PROMPTS_ROOT);
  return out;
}

function compose(overrides, options) {
  return composeSystemPrompt({
    cwd: '/proj',
    modeId: 'build',
    expertId: null,
    workAgentId: null,
    skillBody: null,
    // A stale caller that still passes a retrieved block must not inject it.
    memoryBlock: SEEDED,
    memoryEnabled: true,
    enabledToolIds: ['read_file', ...MEMORY_TOOLS],
    ...overrides,
  }, options);
}

const count = (text, needle) => text.split(needle).length - 1;

describe('project memory guidance', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    registerPromptFilesFromRaw(await loadShippedPromptMap());
  });

  test('appears exactly once when memory tools are enabled', () => {
    for (const modeId of ['build', 'debug', 'plan', 'general', 'orchestrate']) {
      const out = compose({ modeId });
      assert.equal(count(out, '**Project memory.**'), 1, modeId);
      assert.match(out, /Check memory/);
      assert.match(out, /Saving nothing is the normal outcome/);
    }
  });

  test('work agents get the same single block and no capture mandate', () => {
    for (const workAgentId of ['builder', 'reviewer', 'tester']) {
      const out = compose({ workAgentId, workAgentLabel: workAgentId });
      assert.equal(count(out, '**Project memory.**'), 1, workAgentId);
      assert.doesNotMatch(out, /Knowledge capture|make \*\*one\*\*|save_memory|brain_search|brain_write_page/);
    }
  });

  test('read-only agents (board attempts, sub-agents) get the read-only variant', () => {
    const out = compose({ enabledToolIds: ['read_file', 'memory_search', 'memory_read'] });
    assert.equal(count(out, '**Project memory.**'), 1);
    assert.match(out, /You can't save or forget memories/);
    assert.doesNotMatch(out, /Search before saving/);
  });

  test('is absent when memory tools are not enabled', () => {
    const out = compose({ enabledToolIds: ['read_file'] });
    assert.doesNotMatch(out, /Project memory/);
  });

  test('never injects memory text, including the CLI turn-context split', () => {
    const out = compose({});
    assert.doesNotMatch(out, /SEEDED_MEMORY_MARKER/);
    const turnContext = [];
    const stable = compose({}, { turnContext });
    assert.doesNotMatch(stable + turnContext.join('\n'), /SEEDED_MEMORY_MARKER/);
    assert.doesNotMatch(out, /Retrieved memory|wiki notes matched/);
  });

  test('the block is static: no counts or titles vary between projects', () => {
    const a = compose({ cwd: '/a' });
    const b = compose({ cwd: '/b' });
    const block = text => text.slice(text.indexOf('## Project memory'), text.indexOf('Never claim a save'));
    assert.equal(block(a), block(b));
  });
});
