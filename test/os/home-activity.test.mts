import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityCalendar, activitySummary } from '../../src/ui/home-activity.ts';
import { getAppById } from '../../src/os/app-registry.ts';
import { listRailApps } from '../../src/os/app-preferences.ts';
import { resolveLegacyHash, hashForCodeSection } from '../../src/os/router.ts';

test('Home is released, first on the rail, and receives old overview links', () => {
  assert.equal(getAppById('home')?.releaseState, 'released');
  assert.equal(getAppById('home')?.availability, 'core');
  assert.equal(listRailApps()[0].id, 'home');
  assert.deepEqual(resolveLegacyHash('#/app/code/overview'), { hash: '#/app/home' });
  assert.equal(hashForCodeSection('overview'), '#/app/home');
});

test('calendar distinguishes unknown history from zero and combines edit sources', () => {
  const cells = activityCalendar({ trackingSince: '2024-02-28T12:00:00Z', events: [], days: [
    { day: '2024-02-28', source: 'agent', additions: 5, deletions: 2 },
    { day: '2024-02-29', source: 'agent', additions: 3, deletions: 1 },
    { day: '2024-02-29', source: 'completions', additions: 2, deletions: 0 },
  ] }, 4, Date.parse('2024-03-01T12:00:00Z'));
  assert.deepEqual(cells.map(c => c.day), ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']);
  assert.equal(cells[0].tracked, false);
  assert.equal(cells[3].tracked, true);
  assert.deepEqual(activitySummary(cells), { total: 13, active: 2, longest: 2, current: 2, bestDay: '2024-02-28', bestMonth: '2024-02' });
});
