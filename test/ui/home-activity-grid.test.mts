import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { activityCalendar, createHomeActivityGrid } from '../../src/ui/home-activity.ts';

test('Home activity uses one active-descendant grid stop for the full calendar', () => {
  const window = new Window();
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;

  const cells = activityCalendar({
    trackingSince: '2024-01-01T00:00:00Z',
    events: [],
    days: [{ day: '2024-01-14', source: 'agent', additions: 3, deletions: 1 }],
  }, 14, Date.parse('2024-01-14T12:00:00Z'));
  const activated: string[] = [];
  const { grid } = createHomeActivityGrid(cells, cell => activated.push(cell.day));
  document.body.append(grid);

  assert.equal(grid.getAttribute('role'), 'grid');
  assert.equal(grid.tabIndex, 0);
  assert.equal(grid.querySelectorAll('button').length, 0);
  assert.equal(grid.querySelectorAll('[role="row"]').length, 7);
  assert.equal(grid.querySelectorAll('[role="gridcell"]').length, 14);
  assert.equal(grid.querySelectorAll('[aria-selected="true"]').length, 1);
  assert.equal(grid.getAttribute('aria-activedescendant'), `${grid.id}-day-13`);

  grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(grid.getAttribute('aria-activedescendant'), `${grid.id}-day-6`);
  grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(activated, [cells[6].day]);

  (grid.querySelector('[data-index="0"]') as HTMLElement).click();
  assert.equal(grid.getAttribute('aria-activedescendant'), `${grid.id}-day-0`);
  assert.deepEqual(activated, [cells[6].day, cells[0].day]);
});
