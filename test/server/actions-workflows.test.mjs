import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
const calls = [];
let reply = () => ({});
mock.module('../../server/git/action-common.js', {
  namedExports: {
    actionRoot: async () => '/repo',
    inside: async (_, p) => p,
    remoteContext: async () => ({
      cwd: '/repo',
      repo: 'owner/repo',
      hostname: 'github.example.com',
    }),
    github: async (context, endpoint, method, body) => {
      calls.push({ context, endpoint, method, body });
      return reply(endpoint, method, body);
    },
    segment: encodeURIComponent,
    pageNumber: (n) => Number(n) || 1,
    positiveId: (n) => Number(n),
  },
});
const { parseWorkflow, validateInputs, workflowList, workflowView, workflowDispatch } = await import(
  '../../server/git/workflow-ops.js'
);
const releases = await import('../../server/git/release-ops.js');
const yaml = `name: Build\non:\n  workflow_dispatch:\n    inputs:\n      version: {type: string, required: true}\n      publish: {type: boolean, default: false}\n      count: {type: number, default: 2}\n      target: {type: choice, options: [a, b], default: a}\njobs:\n  linux: {runs-on: ubuntu-latest, steps: []}\n  mac: {runs-on: macos-latest, steps: []}\n`;

test('remote workflow list exposes the host-qualified repository for release mappings', async () => {
  reply = () => ({ workflows: [{ id: 7 }], total_count: 1 });
  const result = await workflowList({ cwd: '/repo' });
  assert.equal(result.repo, 'github.example.com/owner/repo');
  assert.equal(result.hasMore, false);
});

test('workflow YAML preserves on, input types and unsupported runners', () => {
  const workflow = parseWorkflow(yaml, '.github/workflows/build.yml');
  assert.equal(workflow.dispatchable, true);
  assert.deepEqual(
    workflow.jobs.map((j) => j.supported),
    [true, false],
  );
  assert.deepEqual(validateInputs(workflow.inputs, { version: '1.2', publish: 'false' }), {
    version: '1.2',
    publish: false,
    count: 2,
    target: 'a',
  });
  assert.throws(() => validateInputs(workflow.inputs, {}), /version is required/);
  assert.throws(() => validateInputs(workflow.inputs, { version: 'x', publish: 'yes' }), /boolean/);
  assert.throws(() => validateInputs(workflow.inputs, { version: 'x', count: 'no' }), /number/);
  assert.throws(() => validateInputs(workflow.inputs, { version: 'x', target: 'c' }), /choice/);
  assert.throws(
    () => validateInputs(workflow.inputs, { version: 'x', extra: 'x' }),
    /Unknown input/,
  );
  assert.throws(() => parseWorkflow('on: push\non: pull_request', 'bad'), /Map keys/);
});
test('remote input definitions use the selected ref and dispatch returns acceptance, not a guessed run', async () => {
  calls.length = 0;
  reply = (endpoint) =>
    endpoint.startsWith('actions/workflows/') && !endpoint.endsWith('dispatches')
      ? { id: 7, path: '.github/workflows/build.yml', state: 'active' }
      : endpoint.startsWith('contents/')
        ? { content: Buffer.from(yaml).toString('base64') }
        : null;
  await workflowView({ id: 7, ref: 'feature/a' });
  assert(calls.some((c) => c.endpoint.endsWith('ref=feature%2Fa')));
  const result = await workflowDispatch({ id: 7, ref: 'feature/a', inputs: { version: '1.2' } });
  assert.equal(result.accepted, true);
  assert.equal(result.run, undefined);
  assert.equal(calls.at(-1).context.hostname, 'github.example.com');
  assert.deepEqual(calls.at(-1).body, {
    ref: 'feature/a',
    inputs: { version: '1.2', publish: false, count: 2, target: 'a' },
  });
});
test('unsupported manual dispatch does not write to GitHub', async () => {
  calls.length = 0;
  reply = (endpoint) =>
    endpoint.startsWith('contents/')
      ? { content: Buffer.from('on: push\njobs: {}').toString('base64') }
      : { id: 7, path: '.github/workflows/build.yml' };
  await assert.rejects(workflowDispatch({ id: 7, ref: 'main' }), /manual dispatch/);
  assert(!calls.some((c) => c.method === 'POST'));
});
test('release drafts verify existing tags and explicit new-tag targets', async () => {
  calls.length = 0;
  reply = (endpoint, method, body) =>
    method === 'POST' ? { id: 2, ...body } : { sha: 'a'.repeat(40) };
  const result = await releases.releaseCreate({ tag: 'v1' });
  assert.equal(result.release.draft, true);
  assert.equal(calls[0].endpoint, 'git/ref/tags/v1');
  await assert.rejects(releases.releaseCreate({ tag: 'v2', createTag: true }), /commit SHA/);
  await releases.releaseCreate({ tag: 'v2', createTag: true, target: 'a'.repeat(40) });
  assert.equal(calls.at(-1).body.target_commitish, 'a'.repeat(40));
});
test('immutable releases cannot be mutated and deletion never removes tags', async () => {
  reply = () => ({ id: 2, immutable: true });
  await assert.rejects(releases.releaseEdit({ id: 2, title: 'No' }), /immutable/);
  await assert.rejects(releases.releaseDelete({ id: 2 }), /immutable/);
  calls.length = 0;
  reply = () => ({ id: 2, assets: [] });
  await releases.releaseDelete({ id: 2 });
  assert.deepEqual(
    calls.filter((c) => c.method === 'DELETE').map((c) => c.endpoint),
    ['releases/2'],
  );
  await assert.rejects(releases.releaseAssetDelete({ id: 2, assetId: 99 }), /does not belong/);
});
