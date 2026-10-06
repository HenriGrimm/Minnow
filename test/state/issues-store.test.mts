/**
 * Issues store: add/update, migration mapping, id sequencing.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  addIssue,
  bugColumnToIssueStatus,
  bugSeverityToIssuePriority,
  collectIssueLabelSuggestions,
  deleteIssue,
  deleteIssues,
  findIssueById,
  getIssueLabelSwatch,
  isBugColumn,
  isBugSeverity,
  migrateBugCardToIssue,
  migrateBugsToIssuesState,
  migrateLegacyBugBoardsFromChats,
  normalizeIssueLabel,
  getNextIssueIdPreview,
  setWorkspaceProjectKey,
  setIssuesNowForTests,
  setIssuesStateForTests,
  setIssueLabelColor,
  updateIssue,
} from '../../src/state/issues-store.ts';
import type { BugCard, Chat } from '../../src/types.ts';

const FIXED_NOW = 1710000002000;

describe('issues-store', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  beforeEach(() => {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, String(value)),
    } });
    setIssuesNowForTests(() => FIXED_NOW);
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  });

  afterEach(() => {
    setIssuesStateForTests(null);
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  test('addIssue allocates workspace project key ids', () => {
    const a = addIssue({ title: 'First', workspacePath: '/proj/Minnow' });
    const b = addIssue({ title: 'Second', workspacePath: '/proj/Minnow' });
    assert.equal(a.id, 'MIN-1');
    assert.equal(b.id, 'MIN-2');
    assert.equal(a.status, 'backlog');
    assert.equal(a.type, 'task');
    assert.equal(a.source, 'user');
  });

  test('legacy ISS cards coexist with new MIN ids in same workspace', () => {
    setIssuesStateForTests({
      version: 2,
      nextId: 3,
      workspaces: {},
      issues: [
        {
          id: 'ISS-1',
          type: 'bug',
          title: 'Old',
          description: '',
          status: 'triage',
          priority: 'none',
          labels: [],
          workspacePath: '/proj/Minnow',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const next = addIssue({ title: 'New', workspacePath: '/proj/Minnow' });
    assert.equal(next.id, 'MIN-1');
    assert.equal(findIssueById('ISS-1')?.title, 'Old');
  });

  test('setWorkspaceProjectKey reconciles next id from existing cards', () => {
    setWorkspaceProjectKey('/proj/Minnow', 'ABC');
    addIssue({ title: 'One', workspacePath: '/proj/Minnow' }, 'ABC-5');
    assert.equal(getNextIssueIdPreview('/proj/Minnow'), 'ABC-6');
  });

  test('addIssue allocates sequential ISS-n ids when key falls back to ISS', () => {
    const a = addIssue({ title: 'First', workspacePath: '/w' });
    const b = addIssue({ title: 'Second', workspacePath: '/w' });
    assert.equal(a.id, 'ISS-1');
    assert.equal(b.id, 'ISS-2');
    assert.equal(a.status, 'backlog');
    assert.equal(a.type, 'task');
    assert.equal(a.source, 'user');
  });

  test('updateIssue patches status and notes', () => {
    addIssue({ title: 'x', workspacePath: '/w' }, 'ISS-9');
    const updated = updateIssue('ISS-9', {
      status: 'in_progress',
      notes: 'Looking into it',
    });
    assert.ok(updated);
    assert.equal(updated?.status, 'in_progress');
    assert.equal(updated?.notes, 'Looking into it');
    assert.equal(findIssueById('ISS-9')?.status, 'in_progress');
  });

  test('deleteIssue and deleteIssues remove cards by id', () => {
    addIssue({ title: 'Keep', workspacePath: '/w' }, 'ISS-1');
    addIssue({ title: 'Drop one', workspacePath: '/w' }, 'ISS-2');
    addIssue({ title: 'Drop two', workspacePath: '/w' }, 'ISS-3');
    assert.equal(deleteIssue('ISS-2'), true);
    assert.equal(findIssueById('ISS-2'), undefined);
    assert.equal(deleteIssues(['ISS-3', 'missing']), 1);
    assert.equal(findIssueById('ISS-1')?.title, 'Keep');
    assert.equal(deleteIssue('ISS-1'), true);
    assert.equal(deleteIssue('ISS-1'), false);
  });

  test('bug column and severity maps cover all legacy values', () => {
    assert.equal(bugColumnToIssueStatus('reported'), 'triage');
    assert.equal(bugColumnToIssueStatus('investigating'), 'in_progress');
    assert.equal(bugColumnToIssueStatus('planned'), 'planned');
    assert.equal(bugColumnToIssueStatus('fixing'), 'in_progress');
    assert.equal(bugColumnToIssueStatus('complete'), 'done');
    assert.equal(bugSeverityToIssuePriority('critical'), 'urgent');
    assert.equal(bugSeverityToIssuePriority('high'), 'high');
    assert.equal(bugSeverityToIssuePriority('medium'), 'medium');
    assert.equal(bugSeverityToIssuePriority('low'), 'low');
  });

  test('migrateBugsToIssuesState preserves legacyBugId and severity', () => {
    const bugs: BugCard[] = [
      {
        id: 'bug-a',
        title: 'Crash',
        description: 'null ref',
        severity: 'critical',
        column: 'investigating',
        workspacePath: '/proj',
        createdAt: 1,
        updatedAt: 2,
        notes: 'auth.ts',
        chatId: 'chat-1',
      },
      {
        id: 'bug-b',
        title: 'Typo',
        description: '',
        severity: 'low',
        column: 'complete',
        workspacePath: '/proj',
        createdAt: 3,
        updatedAt: 4,
      },
    ];
    const state = migrateBugsToIssuesState(bugs);
    assert.equal(state.nextId, 3);
    assert.equal(state.issues.length, 2);
    assert.equal(state.issues[0]?.id, 'ISS-1');
    assert.equal(state.issues[0]?.legacyBugId, 'bug-a');
    assert.equal(state.issues[0]?.severity, 'critical');
    assert.equal(state.issues[0]?.priority, 'urgent');
    assert.equal(state.issues[0]?.status, 'in_progress');
    assert.equal(state.issues[0]?.chatIds?.[0], 'chat-1');
    assert.equal(state.issues[1]?.status, 'done');
    assert.equal(state.issues[1]?.priority, 'low');

    const single = migrateBugCardToIssue(bugs[0]!, 'ISS-99');
    assert.equal(single.id, 'ISS-99');
    assert.equal(single.type, 'bug');
  });

  test('isBugColumn and isBugSeverity guard legacy alias args', () => {
    assert.equal(isBugColumn('reported'), true);
    assert.equal(isBugColumn('triage'), false);
    assert.equal(isBugSeverity('critical'), true);
    assert.equal(isBugSeverity('urgent'), false);
  });

  test('migrateLegacyBugBoardsFromChats imports chat.bugBoard then strips it', async () => {
    const chat = {
      id: 'chat-legacy',
      workspacePath: '/proj',
      bugBoard: {
        bugs: [
          {
            id: 'bug-from-chat',
            title: 'From chat board',
            description: 'legacy',
            severity: 'high',
            column: 'reported',
            workspacePath: '',
            createdAt: 10,
            updatedAt: 11,
          },
        ],
        startedAt: 10,
        lastUpdatedAt: 11,
      },
    } as Chat;

    const changed = await migrateLegacyBugBoardsFromChats([chat]);
    assert.equal(changed, true);
    const imported = findIssueById('bug-from-chat');
    assert.ok(imported);
    assert.equal(imported?.title, 'From chat board');
    assert.equal(imported?.legacyBugId, 'bug-from-chat');
    assert.equal(imported?.priority, 'high');
    assert.equal(chat.bugBoard, undefined);
    const saved = JSON.parse(localStorage.getItem('minnow-issues-v1')!);
    assert.equal(saved.issues[0].legacyBugId, 'bug-from-chat');
  });

  test('normalizeIssueLabel trims and collapses whitespace', () => {
    assert.equal(normalizeIssueLabel('  foo   bar  '), 'foo bar');
    assert.equal(normalizeIssueLabel('   '), null);
  });

  test('updateIssue deduplicates labels case-insensitively', () => {
    addIssue({ title: 'x', workspacePath: '/w' }, 'ISS-1');
    const updated = updateIssue('ISS-1', { labels: ['Bug', 'bug', '  Feature '] });
    assert.deepEqual(updated?.labels, ['Bug', 'Feature']);
  });

  test('updateIssue with an empty labels array clears every chip', () => {
    addIssue({ title: 'x', workspacePath: '/w', labels: ['bug'] }, 'ISS-1');
    const updated = updateIssue('ISS-1', { labels: [] });
    assert.deepEqual(updated?.labels, []);
  });

  test('collectIssueLabelSuggestions returns unique sorted labels', () => {
    addIssue({ title: 'a', workspacePath: '/w', labels: ['Beta', 'alpha'] }, 'ISS-1');
    addIssue({ title: 'b', workspacePath: '/w', labels: ['ALPHA', 'gamma'] }, 'ISS-2');
    assert.deepEqual(collectIssueLabelSuggestions(undefined, '/w'), ['alpha', 'Beta', 'gamma']);
    assert.deepEqual(collectIssueLabelSuggestions('ISS-1'), ['alpha', 'Beta', 'gamma']);
  });

  test('collectIssueLabelSuggestions leaves catalog-only names out (the catalog supplies colors, not membership)', () => {
    addIssue({ title: 'a', workspacePath: '/w', labels: ['bug'] }, 'ISS-1');
    setIssueLabelColor('legacy', 'clay');
    assert.deepEqual(collectIssueLabelSuggestions(undefined, '/w'), ['bug']);
  });

  test('new labels get the next unused catalog swatch', () => {
    addIssue({ title: 'a', workspacePath: '/w', labels: ['UX'] }, 'ISS-1');
    addIssue({ title: 'b', workspacePath: '/w', labels: ['API'] }, 'ISS-2');
    assert.equal(getIssueLabelSwatch('UX'), 'clay');
    assert.equal(getIssueLabelSwatch('API'), 'apricot');
  });

  test('setIssueLabelColor does not bump issue.updatedAt', () => {
    const issue = addIssue({ title: 'a', workspacePath: '/w', labels: ['UX'] }, 'ISS-1');
    const before = issue.updatedAt;
    setIssuesNowForTests(() => FIXED_NOW + 50_000);
    setIssueLabelColor('UX', 'dusk');
    assert.equal(findIssueById('ISS-1')?.updatedAt, before);
    assert.equal(getIssueLabelSwatch('UX'), 'dusk');
  });
});
