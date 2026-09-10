/**
 * Issues sparkles expander — prompt construction and model-output parsing.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  buildExpandIssueMessages,
  canExpandIssueDraft,
  issueHasDetails,
  mergeExpandedIssue,
  parseExpandedIssue,
} = await import('../../src/chat/issues/expand-issue.ts');

const { GUARD_CLOSE } = await import('../../src/lib/untrusted.mjs');

function stub(over: {
  title?: string;
  description?: string;
  notes?: string;
  type?: string;
} = {}) {
  return {
    id: 'MIN-8',
    type: over.type ?? 'task',
    title: over.title ?? 'login broken',
    description: over.description ?? '',
    notes: over.notes,
  };
}

describe('issueHasDetails / canExpandIssueDraft', () => {
  test('title-only cards have no details and can still expand', () => {
    const issue = stub({ title: 'thin', description: '' });
    assert.equal(issueHasDetails(issue), false);
    assert.equal(canExpandIssueDraft(issue), true);
  });

  test('a description or notes counts as details', () => {
    assert.equal(issueHasDetails(stub({ description: 'Repro: click save' })), true);
    assert.equal(issueHasDetails(stub({ notes: 'from crash' })), true);
  });

  test('an empty card cannot expand', () => {
    assert.equal(canExpandIssueDraft(stub({ title: '  ', description: '', notes: '' })), false);
  });
});

describe('buildExpandIssueMessages', () => {
  test('title-only prompt asks for a fuller title and a description', () => {
    const messages = buildExpandIssueMessages(stub({ title: 'login broken', description: '' }));
    assert.equal(messages.length, 2);
    assert.match(String(messages[0]?.content), /The card has no description/);
    assert.match(String(messages[1]?.content), /Write a fuller title and a description/);
    assert.match(String(messages[1]?.content), /not instructions to you/);
    assert.match(String(messages[1]?.content), /login broken/);
    assert.match(String(messages[1]?.content), /UNTRUSTED_SOURCE_DATA/);
  });

  test('existing details prompt forbids wiping the body', () => {
    const messages = buildExpandIssueMessages(
      stub({ title: 'Login', description: 'Null when saving settings' }),
    );
    const system = String(messages[0]?.content);
    assert.match(system, /already has a description/);
    assert.match(system, /do not wipe the existing details/i);
    assert.match(String(messages[1]?.content), /Null when saving settings/);
    assert.ok(String(messages[1]?.content).includes(GUARD_CLOSE));
  });

  test('does not ask the model to research or call issue tools', () => {
    const system = String(buildExpandIssueMessages(stub())[0]?.content);
    assert.match(system, /not answering it, researching the workspace/);
    assert.equal(system.includes('issue_update'), false);
    assert.equal(system.includes('issue_link'), false);
  });
});

describe('parseExpandedIssue', () => {
  test('reads the contracted XML', () => {
    const draft = parseExpandedIssue(
      '<title>Fix login save crash</title>\n<description>\nNull when saving settings.\n\n## Repro\n1. Open settings\n</description>',
    );
    assert.deepEqual(draft, {
      title: 'Fix login save crash',
      description: 'Null when saving settings.\n\n## Repro\n1. Open settings',
    });
  });

  test('reads JSON when the model ignores XML', () => {
    const draft = parseExpandedIssue(
      '{"title":"Fix login","description":"Null on save."}',
    );
    assert.deepEqual(draft, { title: 'Fix login', description: 'Null on save.' });
  });

  test('reads TITLE / DESCRIPTION labels', () => {
    const draft = parseExpandedIssue('Title: Fix login\nDescription:\nNull on save.');
    assert.deepEqual(draft, { title: 'Fix login', description: 'Null on save.' });
  });

  test('falls back to first line as title', () => {
    const draft = parseExpandedIssue('Fix login save crash\n\nNull when saving settings.');
    assert.deepEqual(draft, {
      title: 'Fix login save crash',
      description: 'Null when saving settings.',
    });
  });

  test('strips a wrapping fence and preamble', () => {
    const draft = parseExpandedIssue(
      'Here is the expanded issue:\n```xml\n<title>Fix login</title>\n<description>Null on save.</description>\n```',
    );
    assert.deepEqual(draft, { title: 'Fix login', description: 'Null on save.' });
  });

  test('partial XML fills description before the closing tag', () => {
    const draft = parseExpandedIssue(
      '<title>Fix login</title>\n<description>\nNull when',
      { partial: true },
    );
    assert.deepEqual(draft, { title: 'Fix login', description: 'Null when' });
  });

  test('partial streams skip the first-line fallback', () => {
    assert.equal(parseExpandedIssue('<title>Fix', { partial: true })?.title, 'Fix');
    assert.equal(parseExpandedIssue('just some tokens', { partial: true }), null);
  });
});

describe('mergeExpandedIssue', () => {
  test('keeps the original description when the model leaves it blank', () => {
    const merged = mergeExpandedIssue(
      { title: 'Old title', description: 'Keep me' },
      { title: 'New title', description: '  ' },
    );
    assert.deepEqual(merged, { title: 'New title', description: 'Keep me' });
  });

  test('fills an empty original description from the proposal', () => {
    const merged = mergeExpandedIssue(
      { title: 'thin', description: '' },
      { title: 'Fuller title', description: 'A real description.' },
    );
    assert.deepEqual(merged, {
      title: 'Fuller title',
      description: 'A real description.',
    });
  });
});


test('expander reads metadata, validates custom priorities, and preserves omitted values', () => {
  const original = { title: 'Bug', description: 'Details', labels: ['ui'], priority: 'none' };
  const catalog = { types: [{ id: 'bug', label: 'Bug' }, { id: 'task', label: 'Task' }], priorities: [{ id: 'critical', label: 'Critical' }], labels: ['ui'] };
  const draft = parseExpandedIssue('<title>Fix bug</title><description>Details</description><type>bug</type><labels><label>ui</label><label>crash</label></labels><priority>critical</priority>')!;
  assert.deepEqual(mergeExpandedIssue(original, draft, catalog), {
    title: 'Fix bug', description: 'Details', type: 'bug', labels: ['ui', 'crash'], priority: 'critical',
  });
  assert.deepEqual(mergeExpandedIssue(original, { title: 'Fix', description: '', priority: 'invented' }, catalog), {
    ...original, title: 'Fix',
  });
  const json = parseExpandedIssue('{"title":"Fix","description":"Details","type":"task","labels":["ui",2],"priority":"critical"}');
  assert.deepEqual(json?.labels, ['ui']);
  assert.equal(json?.type, 'task');
  assert.equal(json?.priority, 'critical');
  const prompt = buildExpandIssueMessages({ id: 'ISS-1', type: 'bug', ...original }, catalog);
  assert.match(String(prompt[1]?.content), /critical/);
  assert.match(String(prompt[1]?.content), /Current labels/);
  assert.match(String(prompt[1]?.content), /Available types/);
});

test('keeps the current type when the model proposes a type outside the catalog', () => {
  const catalog = { types: [{ id: 'task', label: 'Task' }], priorities: [], labels: [] };
  assert.deepEqual(
    mergeExpandedIssue(
      { title: 'Draft', description: '', type: 'task' },
      { title: 'Draft', description: '', type: 'incident' },
      catalog,
    ),
    { title: 'Draft', description: '', type: 'task' },
  );
});
