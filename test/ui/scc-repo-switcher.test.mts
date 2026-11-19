/**
 * Source Control repo switcher logic for multi-repo workspace folders.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildRepoMenuItems,
  pickDefaultRepo,
  repoForPanelCwd,
  repoLabel,
  repoPanelCwd,
} from '../../src/ui/scc-repo-switcher.ts';
import type { WorkspaceRepo } from '../../src/state/workspace-repos.ts';

const WS = 'C:/work/app';
const repo = (id: string, slug?: string): WorkspaceRepo => ({
  id, relPath: id, absPath: id === '.' ? WS : `${WS}/${id}`, isRoot: id === '.',
  remote: slug ? { url: '', host: 'github', hostname: 'github.com', slug, owner: slug.split('/')[0], name: slug.split('/')[1] } : null,
});

const siblings = [repo('backend', 'acme/api'), repo('frontend', 'acme/web')];

describe('scc repo switcher', () => {
  test('default pick: remembered, then active file, then root, then first', () => {
    assert.equal(pickDefaultRepo(siblings, { workspacePath: WS, remembered: 'frontend' })?.id, 'frontend');
    assert.equal(pickDefaultRepo(siblings, { workspacePath: WS, remembered: 'gone', activeFilePath: 'frontend/src/App.tsx' })?.id, 'frontend');
    assert.equal(pickDefaultRepo(siblings, { workspacePath: WS, activeFilePath: `${WS}/backend/main.go` })?.id, 'backend');
    assert.equal(pickDefaultRepo(siblings, { workspacePath: WS, activeFilePath: 'README.md' })?.id, 'backend');
    assert.equal(pickDefaultRepo([repo('.'), repo('apps/web')], { workspacePath: WS })?.id, '.');
    assert.equal(pickDefaultRepo([], { workspacePath: WS }), null);
  });

  test('panel cwd maps to and from repos', () => {
    assert.equal(repoPanelCwd(repo('.')), undefined);
    assert.equal(repoPanelCwd(siblings[0]), `${WS}/backend`);
    assert.equal(repoForPanelCwd(`${WS}\\frontend`, siblings, WS)?.id, 'frontend');
    assert.equal(repoForPanelCwd(undefined, siblings, WS), null);
    assert.equal(repoForPanelCwd(undefined, [repo('.'), ...siblings], WS)?.id, '.');
    assert.equal(repoForPanelCwd('C:/elsewhere/wt', siblings, WS), null);
  });

  test('menu rows check the current repo and show the remote', () => {
    const picked: string[] = [];
    const items = buildRepoMenuItems(siblings, 'frontend', (r) => picked.push(r.id));
    const rows = items.filter((item) => item.kind !== 'heading') as Array<{ id: string; label: string; hint?: string; checked?: boolean; onSelect: () => void }>;
    assert.deepEqual(rows.map((r) => [r.label, r.hint, r.checked]), [['backend', 'acme/api', false], ['frontend', 'acme/web', true]]);
    rows[0].onSelect();
    assert.deepEqual(picked, ['backend']);
    assert.equal(repoLabel(repo('.')).label, 'Workspace root');
  });
});
