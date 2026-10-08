import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let permission = 'ask';
let decision = 'cancel';
let prompts: any[] = [];
mock.module('../../src/tools/config.ts', { namedExports: { loadToolConfig: () => ({}) } });
mock.module('../../src/tools/permission-resolve.ts', { namedExports: { resolveEffectivePermission: () => ({ mode: permission }) } });
mock.module('../../src/tools/approval-queue.ts', { namedExports: { enqueueToolApproval: async (request: unknown) => { prompts.push(request); return decision; } } });
mock.module('../../src/agents/work-agent-registry.ts', { namedExports: { getWorkAgent: () => ({ allowedTools: ['read_file'] }) } });
const { executeApprovedImage } = await import('../../src/tools/image-generation-approval.ts');

test('denied Ask, Off, read-only roles and no-DOM callers never generate; Full is explicit', async () => {
  Object.assign(globalThis, { document: { documentElement: { classList: { contains: () => false } } } });
  const calls: string[] = [];
  const execute = async (name: string, _args: unknown, approval?: unknown) => {
    calls.push(name);
    if (name === 'generate_image') assert.deepEqual(approval, { approved: true, fingerprint: 'binding' });
    return { content: JSON.stringify({ status: 'Ready', fingerprint: 'binding', binding: { providerId: 'provider', modelId: 'model' }, notice: 'Cost unavailable; provider charges may apply.' }) };
  };
  const args = { prompt: 'fish', reference_paths: ['reference.png'], output_path: 'fish.png' };
  const context = { toolCallId: 'call', benchmarkAutonomous: true };
  assert.match((await executeApprovedImage(args, context, execute)).content, /denied/);
  assert.deepEqual(calls, ['image_generation_info']);
  assert.match(prompts[0].title, /provider \/ model/); assert.match(prompts[0].description, /reference.png/); assert.match(prompts[0].description, /Cost unavailable/);
  permission = 'off'; await executeApprovedImage(args, context, execute); assert.equal(calls.length, 1);
  permission = 'full'; await executeApprovedImage(args, { ...context, workAgentId: 'reviewer' }, execute); assert.equal(calls.length, 1);
  await executeApprovedImage(args, context, execute); assert.equal(calls.at(-1), 'generate_image'); assert.equal(prompts.length, 1);
  permission = 'ask'; delete (globalThis as any).document;
  assert.match((await executeApprovedImage(args, context, execute)).content, /Unattended/);
  assert.equal(calls.filter(name => name === 'generate_image').length, 1);
});
