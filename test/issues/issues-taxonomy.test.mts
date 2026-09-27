import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countIssuesUsingTaxonomyId,
  createDefaultIssuesTaxonomy,
  defaultIssueStatusId,
  isClosedStatus,
  openIssueStatusIds,
  pickNextTaxonomyColor,
  requireStatusIdForRole,
  seedDefaultBoardVisibility,
  seedDefaultIssueTypes,
  slugifyTaxonomyLabel,
  statusIdForRole,
  validateIssuesTaxonomy,
} from '../../src/issues/taxonomy.ts';

describe('issues taxonomy', () => {
  it('seeds defaults with unique roles and board columns', () => {
    const taxonomy = createDefaultIssuesTaxonomy();
    assert.equal(taxonomy.version, 1);
    assert.ok(taxonomy.types.length >= 6);
    assert.ok(taxonomy.types.some((t) => t.id === 'feature'));
    assert.ok(taxonomy.types.some((t) => t.id === 'improvement'));
    assert.equal(taxonomy.typeSeedRevision, 2);
    assert.equal(taxonomy.boardSeedRevision, 1);
    assert.ok(taxonomy.statuses.length >= 8);
    assert.equal(statusIdForRole(taxonomy, 'triage'), 'triage');
    assert.equal(statusIdForRole(taxonomy, 'review'), 'review');
    assert.equal(taxonomy.statuses.find((status) => status.role === 'backlog')?.boardVisible, true);
    assert.ok(boardVisibleCount(taxonomy) >= 6);
  });

  it('rejects duplicate status roles', () => {
    const base = createDefaultIssuesTaxonomy();
    const dup = structuredClone(base);
    dup.statuses.push({
      id: 'extra_triage',
      label: 'Extra triage',
      order: 99,
      role: 'triage',
      boardVisible: false,
    });
    assert.throws(() => validateIssuesTaxonomy(dup), /already assigned/);
  });

  it('blocks deleting ids still used by issues', () => {
    const previous = createDefaultIssuesTaxonomy();
    const next = structuredClone(previous);
    next.types = next.types.filter((t) => t.id !== 'bug');
    assert.throws(
      () =>
        validateIssuesTaxonomy(next, {
          previous,
          issues: [{ type: 'bug', status: 'triage', priority: 'none' }],
        }),
      /Used by 1 issue/,
    );
  });

  it('derives open statuses from isClosed flags', () => {
    const taxonomy = createDefaultIssuesTaxonomy();
    const open = openIssueStatusIds(taxonomy);
    assert.ok(open.includes('triage'));
    assert.ok(!open.includes('done'));
    assert.equal(isClosedStatus(taxonomy, 'done'), true);
    assert.equal(isClosedStatus(taxonomy, 'triage'), false);
  });

  it('resolves workflow role ids and slugifies labels', () => {
    const taxonomy = createDefaultIssuesTaxonomy();
    assert.equal(requireStatusIdForRole(taxonomy, 'planned'), 'planned');
    assert.equal(slugifyTaxonomyLabel('My Custom Status'), 'my_custom_status');
    assert.equal(defaultIssueStatusId(taxonomy), 'triage');
  });

  it('rejects unsafe type colors', () => {
    const next = structuredClone(createDefaultIssuesTaxonomy());
    next.types[0].color = 'url(javascript:alert(1))';
    assert.throws(() => validateIssuesTaxonomy(next), /Unknown type color/);
  });

  it('seeds Feature and Improvement once on legacy catalogs', () => {
    const legacy = structuredClone(createDefaultIssuesTaxonomy());
    delete legacy.typeSeedRevision;
    legacy.types = legacy.types.filter((t) => t.id !== 'feature' && t.id !== 'improvement');
    const seeded = seedDefaultIssueTypes(legacy);
    assert.ok(seeded.types.some((t) => t.id === 'feature'));
    assert.ok(seeded.types.some((t) => t.id === 'improvement'));
    assert.equal(seeded.typeSeedRevision, 2);
    const withoutFeature = {
      ...seeded,
      types: seeded.types.filter((t) => t.id !== 'feature'),
    };
    const again = seedDefaultIssueTypes(withoutFeature);
    assert.equal(again.types.some((t) => t.id === 'feature'), false);
  });

  it('reveals Backlog once without overriding a later user choice', () => {
    const legacy = structuredClone(createDefaultIssuesTaxonomy());
    delete legacy.boardSeedRevision;
    const backlog = legacy.statuses.find((status) => status.role === 'backlog');
    assert.ok(backlog);
    backlog.boardVisible = false;

    const seeded = seedDefaultBoardVisibility(legacy);
    assert.equal(seeded.boardSeedRevision, 1);
    assert.equal(seeded.statuses.find((status) => status.role === 'backlog')?.boardVisible, true);

    const userHidden = structuredClone(seeded);
    const seededBacklog = userHidden.statuses.find((status) => status.role === 'backlog');
    assert.ok(seededBacklog);
    seededBacklog.boardVisible = false;
    assert.equal(
      seedDefaultBoardVisibility(userHidden).statuses.find((status) => status.role === 'backlog')
        ?.boardVisible,
      false,
    );
  });

  it('picks the next unused palette color', () => {
    assert.equal(pickNextTaxonomyColor(['var(--mn-danger)']), 'var(--mn-accent)');
  });

  it('counts issue usage per taxonomy kind', () => {
    const issues = [
      { type: 'bug', status: 'triage', priority: 'high' },
      { type: 'bug', status: 'done', priority: 'none' },
    ];
    assert.equal(countIssuesUsingTaxonomyId('type', 'bug', issues), 2);
    assert.equal(countIssuesUsingTaxonomyId('status', 'done', issues), 1);
    assert.equal(countIssuesUsingTaxonomyId('priority', 'high', issues), 1);
  });
});

function boardVisibleCount(taxonomy: ReturnType<typeof createDefaultIssuesTaxonomy>): number {
  return taxonomy.statuses.filter((s) => s.boardVisible !== false).length;
}
