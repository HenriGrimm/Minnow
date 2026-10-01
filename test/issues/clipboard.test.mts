import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatIssueForClipboard } from '../../src/issues/clipboard.ts';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';
import type { IssueCard } from '../../src/types.ts';

const BASE: IssueCard = {
  id: 'MIN-95',
  type: 'improvement',
  title: 'Add Copy Issue option to the issue details dropdown',
  description: '## Motivation\nMake it easy to copy an issue.',
  status: 'backlog',
  priority: 'low',
  labels: ['issues', 'ui'],
  workspacePath: 'C:/dev/Minnow',
  createdAt: Date.UTC(2026, 8, 30, 10, 0, 0),
  updatedAt: Date.UTC(2026, 9, 1, 8, 30, 0),
};

test('copy issue emits every stored field, link, and comment', () => {
  const issue: IssueCard = {
    ...BASE,
    notes: 'Scoped to the peek dropdown.',
    planPath: 'documentation/plans/issues/MIN-95.md',
    projectId: 'proj-1',
    parentId: 'MIN-90',
    source: 'user',
    chatIds: ['chat-1'],
    assignee: { id: 'me', label: 'Henri', assignedAt: BASE.createdAt },
    agent: {
      agentId: 'builder',
      phase: 'running',
      step: 'Writing the formatter',
      startedAt: BASE.createdAt,
      updatedAt: BASE.updatedAt,
      branch: 'min-95',
      prNumber: 12,
    },
    codeRefs: [{ path: 'src\\issues\\clipboard.ts', startLine: 1, endLine: 20, note: 'formatter' }],
    gitLinks: [
      { kind: 'pr', ref: '12', title: 'Copy issue', url: 'https://x/pr/12', addedAt: BASE.updatedAt },
    ],
    issueRefs: [{ issueId: 'MIN-3', kind: 'related', addedAt: BASE.updatedAt }],
    attachments: [
      { id: 'a1', name: 'shot.png', path: 'issues/attachments/a1.png', mime: 'image/png', bytes: 1234, addedAt: BASE.updatedAt },
    ],
    activity: [{ id: 'e1', kind: 'status_changed', at: BASE.updatedAt, actorKind: 'user', data: { to: 'backlog' } }],
    comments: [
      { id: 'c1', authorKind: 'user', author: 'Henri', body: 'Paste target is chat.', createdAt: BASE.updatedAt },
    ],
    github: { number: 7, url: 'https://x/issues/7', repo: 'a/b', syncedAt: BASE.updatedAt },
  };

  const text = formatIssueForClipboard(issue, {
    taxonomy: createDefaultIssuesTaxonomy(),
    projectName: 'Issues polish',
    children: [{ ...BASE, id: 'MIN-96', title: 'Child card', parentId: 'MIN-95' }],
  });

  assert.match(text, /^# MIN-95 — Add Copy Issue option to the issue details dropdown\n/);
  // Taxonomy ids render as their human labels.
  assert.match(text, /- Type: Improvement/);
  assert.match(text, /- Status: Backlog/);
  assert.match(text, /- Priority: Low/);
  assert.match(text, /- Labels: issues, ui/);
  assert.match(text, /- Project: Issues polish/);
  assert.match(text, /- Assignee: Henri/);
  assert.match(text, /- Agent: builder · running — Writing the formatter — branch min-95 — PR #12/);
  assert.match(text, /- Parent: MIN-90/);
  assert.match(text, /- Source: user/);
  assert.match(text, /- Plan: documentation\/plans\/issues\/MIN-95\.md/);
  assert.match(text, /- Linked chats: chat-1/);
  assert.match(text, /- GitHub: #7 — a\/b — https:\/\/x\/issues\/7/);
  assert.match(text, /- Workspace: C:\/dev\/Minnow/);
  assert.match(text, /- Created: 2026-09-30T10:00:00\.000Z/);
  assert.match(text, /- Updated: 2026-10-01T08:30:00\.000Z/);
  assert.match(text, /## Description\n\n## Motivation\nMake it easy to copy an issue\./);
  assert.match(text, /## Notes\n\nScoped to the peek dropdown\./);
  // Windows separators are normalized; a range keeps both ends.
  assert.match(text, /## Code references\n\n- src\/issues\/clipboard\.ts:1-20 — formatter/);
  assert.match(text, /## Git links\n\n- pr 12 — Copy issue — https:\/\/x\/pr\/12/);
  assert.match(text, /## Related issues\n\n- related MIN-3/);
  assert.match(text, /## Sub-issues\n\n- MIN-96: Child card \(backlog\)/);
  assert.match(text, /## Attachments\n\n- shot\.png \(image\/png, 1234 bytes\)/);
  assert.match(text, /## Activity\n\n- 2026-10-01T08:30:00\.000Z · status_changed · user \(to=backlog\)/);
  assert.match(text, /## Comments \(1\)\n\n### Henri · 2026-10-01T08:30:00\.000Z\n\nPaste target is chat\./);
  assert.ok(text.endsWith('\n'));
});

test('copy issue omits empty sections and keeps unknown taxonomy ids', () => {
  const text = formatIssueForClipboard({
    ...BASE,
    type: 'weird-type',
    labels: [],
    description: '',
    title: '   ',
  });

  assert.match(text, /^# MIN-95 — \(untitled\)\n/);
  assert.match(text, /- Type: weird-type/);
  assert.ok(!text.includes('- Labels:'), 'no empty labels line');
  assert.ok(!text.includes('## Comments'), 'no comments section');
  assert.ok(!text.includes('## Code references'), 'no code refs section');
  assert.ok(!text.includes('## Sub-issues'), 'no sub-issues section');
  assert.match(text, /## Description\n\n\(none\)/);
});
