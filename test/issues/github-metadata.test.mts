import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { decodeGithubIssueBody, encodeGithubIssueBody, type GithubIssueMetadata } from '../../src/issues/github-metadata.ts';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';
import { importGithubIssues, syncAllIssuesWithGithub, syncIssueWithGithub, resetIssuesGithubForTests, setIssuesGithubMode } from '../../src/state/issues-github.ts';
import { addIssueComment, deleteIssueComment, findIssueById, findIssueProject, listIssues, parseIssuesState, setIssuesStateForTests, updateIssue } from '../../src/state/issues-store.ts';
import { getIssuesTaxonomySync, setIssuesTaxonomyForTests } from '../../src/state/issues-taxonomy-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import type { IssueCard } from '../../src/types.ts';

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const metadata = (): GithubIssueMetadata => ({
  version: 1, type: { id: 'spike', label: 'Research spike', order: 0 },
  priority: { id: 'urgent', label: 'Urgent', order: 0 },
  status: { id: 'investigating', label: 'Investigating', order: 0, isClosed: false },
  project: { id: 'shared-project', name: 'Release' }, parent: null,
  comments: [{ id: 'comment-1', authorKind: 'agent', author: 'Planner', body: 'Keep --> <details>\nUnicode: 🐟', createdAt: 100 }],
});
const card = (): IssueCard => ({
  id: 'MIN-1', title: 'An issue', description: 'Description', labels: [],
  type: 'task', status: 'todo', priority: 'none', workspacePath: '/w',
  createdAt: 1, updatedAt: 1000,
  github: { number: 1, url: 'https://github.com/o/r/issues/1', syncedAt: 1000, localUpdatedAt: 1000, remoteUpdatedAt: 1000 },
});

beforeEach(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  }, configurable: true });
  resetIssuesGithubForTests();
  setIssuesGithubMode('mirror');
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: '/w', label: 'w', isDefault: false });
  setIssuesTaxonomyForTests(createDefaultIssuesTaxonomy());
  setIssuesStateForTests({ version: 2, nextId: 2, issues: [card()], workspaces: {} });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as any).localStorage;
  resetIssuesGithubForTests();
  resetWorkspaceStateForTests();
  setLocalServerAvailableForTests(false);
  setIssuesStateForTests(null);
  setIssuesTaxonomyForTests(null);
});

test('portable body round trips comments and preserves malformed/future blocks as description', () => {
  const data = metadata();
  const wire = encodeGithubIssueBody('Original\n\n', data);
  assert.deepEqual(decodeGithubIssueBody(wire), { body: 'Original\n\n', metadata: data });
  assert.equal(wire.includes('--> <details>'), false);
  for (const body of ['Plain text', 'Text\n\n<!-- minnow-issue:v1\ninvalid\n-->', wire.replace('"version":1', '"version":2')]) {
    assert.deepEqual(decodeGithubIssueBody(body), { body });
  }
});

test('duplicate transport blocks decode to the description with the newest metadata', () => {
  const older = metadata();
  const newest = { ...metadata(), comments: [] };
  const prefix = 'User text\n\n';
  const first = encodeGithubIssueBody(prefix, older);
  const wire = first + encodeGithubIssueBody('', newest);
  for (const body of [wire, `${wire}\n\n`, `${wire.replace(/\n/g, '\r\n')}\r\n`]) {
    assert.deepEqual(decodeGithubIssueBody(body), {
      body: body.includes('\r\n') ? prefix.replace(/\n/g, '\r\n') : prefix,
      metadata: newest,
    });
  }
  assert.equal(encodeGithubIssueBody(wire, newest), encodeGithubIssueBody(prefix, newest));
  assert.equal(encodeGithubIssueBody(encodeGithubIssueBody(prefix, newest), newest), encodeGithubIssueBody(prefix, newest));
});

test('cleanup preserves malformed, future and nontrailing blocks', () => {
  for (const preserved of [
    'Text\n\n<!-- minnow-issue:v1\ninvalid\n-->',
    encodeGithubIssueBody('Text', metadata()).replace('"version":1', '"version":2'),
    `${encodeGithubIssueBody('Text', metadata())}\nUser text after the block`,
  ]) {
    assert.deepEqual(decodeGithubIssueBody(preserved), { body: preserved });
    assert.equal(decodeGithubIssueBody(preserved + encodeGithubIssueBody('', metadata())).body, preserved);
  }
});

test('loading linked issues repairs descriptions without changing local fields or watermarks', () => {
  const issue = card();
  issue.type = 'bug';
  issue.comments = [{ id: 'local', body: 'New local comment', authorKind: 'user', createdAt: 200 }];
  const wire = encodeGithubIssueBody(issue.description, metadata()) + encodeGithubIssueBody('', metadata());
  const linked = { ...issue, description: wire };
  const unlinked = { ...linked, id: 'MIN-2', github: undefined };
  const parsed = parseIssuesState({ version: 2, nextId: 3, issues: [linked, unlinked], workspaces: {} });
  assert.equal(parsed.issues[0].description, 'Description');
  assert.equal(parsed.issues[0].type, 'bug');
  assert.deepEqual(parsed.issues[0].comments, issue.comments);
  assert.deepEqual(parsed.issues[0].github, issue.github);
  assert.equal(parsed.issues[0].updatedAt, issue.updatedAt);
  assert.equal(parsed.issues[1].description, wire);
});

test('sync pulls duplicate remote blocks without leaking transport into descriptions', async () => {
  const data = metadata();
  const wire = encodeGithubIssueBody('Remote description', data) + encodeGithubIssueBody('', data);
  globalThis.fetch = async () => Response.json({ ok: true, issue: {
    number: 1, title: 'An issue', body: `${wire}\n`, state: 'open', labels: [],
    url: 'https://github.com/o/r/issues/1', updatedAt: 2000,
  } });
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'pull');
  assert.equal(findIssueById('MIN-1')?.description, 'Remote description');
  assert.deepEqual(findIssueById('MIN-1')?.comments, data.comments);
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'noop');
});

test('fresh-machine Sync all restores custom types, projects, comments and child-first hierarchy', async () => {
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  const parent = { number: 10, title: 'Parent', body: encodeGithubIssueBody('Parent description', metadata()), labels: [], state: 'open', url: 'https://github.com/o/r/issues/10', updatedAt: 2000 };
  const childData = { ...metadata(), parent: 10 };
  const child = { ...parent, number: 11, title: 'Child', body: encodeGithubIssueBody('Child description', childData) + encodeGithubIssueBody('', childData), url: 'https://github.com/o/r/issues/11' };
  globalThis.fetch = async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).op, 'issueList');
    return Response.json({ ok: true, issues: [child, parent] });
  };
  const result = await syncAllIssuesWithGithub();
  assert.deepEqual(result.errors, []);
  assert.equal(result.imported, 2);
  const rows = listIssues();
  const importedChild = rows.find((row) => row.github?.number === 11)!;
  const importedParent = rows.find((row) => row.github?.number === 10)!;
  assert.equal(importedChild.parentId, importedParent.id);
  assert.equal(importedChild.type, 'spike');
  assert.equal(importedChild.status, 'investigating');
  assert.equal(importedChild.priority, 'urgent');
  assert.equal(importedChild.description, 'Child description');
  assert.deepEqual(importedChild.comments, metadata().comments);
  assert.equal(findIssueProject(importedChild.projectId!)?.name, 'Release');
  assert.equal(getIssuesTaxonomySync().types.find((row) => row.id === 'spike')?.label, 'Research spike');
  assert.equal((await importGithubIssues()).imported, 0);
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.op, 'issueView');
    return Response.json({ ok: true, issue: request.number === 11 ? child : parent });
  };
  assert.equal((await syncIssueWithGithub(importedChild.id)).action, 'noop');
});

test('a missing remote parent reports an error without overwriting its relationship', async () => {
  globalThis.fetch = async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).op, 'issueView');
    return Response.json({ ok: true, issue: {
      number: 1, title: 'An issue', body: encodeGithubIssueBody('Description', { ...metadata(), parent: 999 }),
      state: 'open', labels: [], url: 'https://github.com/o/r/issues/1', updatedAt: 2000,
    } });
  };
  const result = await syncIssueWithGithub('MIN-1');
  assert.equal(result.ok, false);
  assert.match(result.error!, /Could not import parent GitHub issue #999/);
  assert.equal(findIssueById('MIN-1')?.description, 'Description');
  assert.equal(findIssueById('MIN-1')?.github?.remoteUpdatedAt, 1000);
});

test('type-only edits and comment changes publish; parsed bodies subsequently stay in sync', async () => {
  let remote = { number: 1, title: 'An issue', body: 'Description', state: 'open', labels: [], url: 'https://github.com/o/r/issues/1', updatedAt: 1000 };
  let edits = 0;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.op === 'issueView') return Response.json({ ok: true, issue: remote });
    if (request.op === 'issueEdit') {
      edits++;
      remote = { ...remote, title: request.title, body: request.body, updatedAt: Date.now() };
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: 'Unexpected operation' });
  };
  updateIssue('MIN-1', { type: 'bug', priority: 'high' });
  const comment = addIssueComment('MIN-1', { body: 'Preserve this on another machine', author: 'Ada' })!;
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'push');
  const data = decodeGithubIssueBody(remote.body).metadata!;
  assert.equal(data.type.id, 'bug');
  assert.equal(data.priority.id, 'high');
  assert.equal(data.comments[0].body, comment.body);
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'noop');
  assert.equal(edits, 1);
  deleteIssueComment('MIN-1', comment.id);
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'push');
  assert.deepEqual(decodeGithubIssueBody(remote.body).metadata?.comments, []);
  remote = { ...remote, updatedAt: Date.now() + 10_000, body: encodeGithubIssueBody('Remote description', { ...decodeGithubIssueBody(remote.body).metadata!, type: { id: 'feature', label: 'Feature', order: 0 } }) };
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'pull');
  assert.equal(findIssueById('MIN-1')?.type, 'feature');
  assert.equal(findIssueById('MIN-1')?.description, 'Remote description');
});


test('single-issue sync restores a missing closed parent in the child workspace', async () => {
  setWorkspaceFromServer({ path: '/other', label: 'other', isDefault: false });
  const child = { number: 1, title: 'Child', body: encodeGithubIssueBody('Child body', { ...metadata(), parent: 197 }),
    state: 'open', labels: [], url: 'https://github.com/o/r/issues/1', updatedAt: 2000 };
  const parent = { ...child, number: 197, title: 'Closed parent', state: 'closed',
    body: encodeGithubIssueBody('Parent body', metadata()), url: 'https://github.com/o/r/issues/197' };
  const requests: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.op, 'issueView');
    assert.equal(request.cwd, '/w');
    requests.push(request.number);
    return Response.json({ ok: true, issue: request.number === 197 ? parent : child });
  };
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'pull');
  const restored = listIssues().find((issue) => issue.github?.number === 197)!;
  assert.equal(restored.workspacePath, '/w');
  assert.equal(restored.status, 'done');
  assert.deepEqual(restored.comments, metadata().comments);
  assert.equal(findIssueById('MIN-1')?.parentId, restored.id);
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'noop');
  assert.deepEqual(requests, [1, 197, 1]);
});

test('import fetches parents outside discovery and retries without partial child watermarks', async () => {
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  const child = { number: 11, title: 'Child', body: encodeGithubIssueBody('Child body', { ...metadata(), parent: 197 }),
    state: 'open', labels: [], url: 'https://github.com/o/r/issues/11', updatedAt: 2000 };
  const parent = { ...child, number: 197, title: 'Parent', state: 'closed',
    body: encodeGithubIssueBody('Parent body', metadata()), url: 'https://github.com/o/r/issues/197' };
  let fail = true;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.op === 'issueList') return Response.json({ ok: true, issues: [child] });
    assert.equal(request.op, 'issueView');
    assert.equal(request.number, 197);
    return Response.json(fail ? { ok: false, error: 'Network unavailable' } : { ok: true, issue: parent });
  };
  const failed = await importGithubIssues({ limit: 1 });
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /#197.*Network unavailable/);
  assert.equal(listIssues().length, 0);
  fail = false;
  assert.deepEqual(await importGithubIssues({ limit: 1 }), { ok: true, imported: 2, skipped: 0 });
  const rows = listIssues();
  assert.equal(rows.find((row) => row.github?.number === 11)?.parentId,
    rows.find((row) => row.github?.number === 197)?.id);
  assert.equal((await importGithubIssues()).skipped, 1);
});

test('batch sync restores a shared missing parent without duplicate local cards', async () => {
  const first = card();
  const second = { ...card(), id: 'MIN-2', github: { ...card().github!, number: 2 } };
  setIssuesStateForTests({ version: 2, nextId: 3, issues: [first, second], workspaces: {} });
  const remote = (number: number) => ({ number, title: 'Child',
    body: encodeGithubIssueBody('Child body', { ...metadata(), parent: 197 }),
    state: 'open', labels: [], url: `https://github.com/o/r/issues/${number}`, updatedAt: 2000 });
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.op, 'issueView');
    assert.equal(request.number, 197);
    return Response.json({ ok: true, issue: { ...remote(197), title: 'Parent', body: encodeGithubIssueBody('Parent', metadata()) } });
  };
  const results = await Promise.all([first, second].map((issue) => syncIssueWithGithub(issue.id, {
    remote: remote(issue.github!.number), workspacePath: '/w', syncedAt: 1000,
  })));
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const parents = listIssues().filter((issue) => issue.github?.number === 197);
  assert.equal(parents.length, 1);
  assert.equal(findIssueById(first.id)?.parentId, parents[0].id);
  assert.equal(findIssueById(second.id)?.parentId, parents[0].id);
});

test('invalid remote parent hierarchies fail without changing the child', async () => {
  for (const parentNumber of [1, 197]) {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ ok: true, issue: { number: request.number, title: 'Invalid',
        body: encodeGithubIssueBody('Invalid', { ...metadata(), parent: parentNumber }),
        state: 'open', labels: [], url: `https://github.com/o/r/issues/${request.number}`, updatedAt: 2000 } });
    };
    assert.equal((await syncIssueWithGithub('MIN-1')).ok, false);
    assert.equal(listIssues().length, 1);
    assert.equal(findIssueById('MIN-1')?.description, 'Description');
  }
});


test('parent discovery respects workspace identity and keeps an already imported parent’s local edits', async () => {
  const otherParent = { ...card(), id: 'OTHER-1', workspacePath: '/other', github: { ...card().github!, number: 197 } };
  const localParent = { ...card(), id: 'MIN-2', title: 'Unsynced parent edit', updatedAt: 3000,
    github: { ...card().github!, number: 198 } };
  setIssuesStateForTests({ version: 2, nextId: 3, issues: [card(), otherParent, localParent], workspaces: {} });
  let parentNumber = 197;
  const parentReads: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.cwd, '/w');
    if (request.number !== 1) parentReads.push(request.number);
    return Response.json({ ok: true, issue: { number: request.number, title: 'Remote title',
      body: encodeGithubIssueBody('Remote body', { ...metadata(), parent: request.number === 1 ? parentNumber : null }),
      state: 'open', labels: [], url: `https://github.com/o/r/issues/${request.number}`, updatedAt: parentNumber * 1000 } });
  };
  assert.equal((await syncIssueWithGithub('MIN-1')).ok, true);
  const restored = listIssues().find((row) => row.workspacePath === '/w' && row.github?.number === 197)!;
  assert.equal(findIssueById('MIN-1')?.parentId, restored.id);
  assert.notEqual(restored.id, otherParent.id);
  parentNumber = 198;
  assert.equal((await syncIssueWithGithub('MIN-1')).action, 'pull');
  assert.equal(findIssueById('MIN-1')?.parentId, localParent.id);
  assert.equal(findIssueById(localParent.id)?.title, 'Unsynced parent edit');
  assert.deepEqual(parentReads, [197]);
});
