/**
 * List labels field: one row, max three chips, caret overflow, + add (no dashed placeholder).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { ISSUES_COMPAT_VERSION, ISSUES_SCHEMA_VERSION } from '../../src/types.ts';
import type { IssueCard } from '../../src/types.ts';

const { setIssuesStateForTests } = await import('../../src/state/issues-store.ts');
const { createIssuesLabelsField, closeIssuesLabelsSuggestionsMenu, filterIssueLabelSuggestions } = await import(
  '../../src/ui/issues-labels-field.ts'
);
const { deferUntilIssueLabelPopoverClosed } = await import('../../src/ui/issues-label-chip.ts');

const FIXED_NOW = 1_710_000_000_000;

let domWindow: Window | null = null;

function setupDom(): void {
  const window = new Window({ url: 'http://localhost/' });
  domWindow = window;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLUListElement = window.HTMLUListElement;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
}

function seedIssue(labels: string[]): IssueCard {
  const issue: IssueCard = {
    id: 'MIN-9',
    type: 'task',
    title: 'Keyboard shortcuts',
    description: '',
    status: 'todo',
    priority: 'none',
    labels,
    workspacePath: '/workspace',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    source: 'user',
  };
  setIssuesStateForTests({
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 10,
    issues: [issue],
    workspaces: {},
  });
  return issue;
}

describe('issues labels field', () => {
  beforeEach(() => {
    setupDom();
  });

  afterEach(() => {
    closeIssuesLabelsSuggestionsMenu();
    setIssuesStateForTests(null);
    domWindow?.happyDOM.close();
    domWindow = null;
  });

  test('row variant shows three chips, a caret for overflow, and + with no inline input', () => {
    const issue = seedIssue(['AUTH', 'CLERK', 'ONBOARDING', 'SETUP', 'API']);
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'row',
      onChange: () => {},
    });
    document.body.appendChild(field);

    const chips = [...field.querySelectorAll('.issues-label-chip')];
    assert.equal(chips.length, 3);
    assert.deepEqual(
      chips.map((chip) => chip.querySelector('.issues-label-chip__text')?.textContent),
      ['AUTH', 'CLERK', 'ONBOARDING'],
    );
    assert.equal(field.querySelector('.issues-labels-field__more')?.getAttribute('aria-label'), '2 more labels');
    assert.ok(field.querySelector('.issues-labels-field__more .issues-labels-field__more-icon'));
    assert.ok(field.querySelector('.issues-labels-field__add'));
    assert.equal(field.querySelector(':scope > .issues-labels-field__input'), null);
    assert.ok(chips[0]?.getAttribute('data-swatch'));
  });

  test('form mounts before the store loads and reads fresh suggestions when opened', () => {
    setIssuesStateForTests(null);
    const field = createIssuesLabelsField({
      issueId: 'new-issue', workspacePath: '/workspace', labels: [], variant: 'form', onChange: () => {},
    });
    document.body.appendChild(field);
    seedIssue(['FRESH']);
    field.querySelector<HTMLButtonElement>('.issues-labels-field__add')!.click();
    assert.match(document.querySelector('.issues-labels-suggestions')?.textContent ?? '', /FRESH/);
    closeIssuesLabelsSuggestionsMenu();
    seedIssue(['UPDATED']);
    field.querySelector<HTMLButtonElement>('.issues-labels-field__add')!.click();
    const suggestions = document.querySelector('.issues-labels-suggestions')?.textContent ?? '';
    assert.match(suggestions, /UPDATED/);
    assert.doesNotMatch(suggestions, /FRESH/);
  });

  test('new issue suggestions follow the destination when it changes', () => {
    const first = seedIssue(['FIRST']);
    setIssuesStateForTests({
      version: ISSUES_COMPAT_VERSION, schemaRevision: ISSUES_SCHEMA_VERSION,
      nextId: 11, workspaces: {}, issues: [first,
        { ...first, id: 'MIN-10', workspacePath: '/other', labels: ['SECOND'] }],
    });
    let destination = '/workspace';
    const field = createIssuesLabelsField({
      issueId: '__new__', labels: [], variant: 'form',
      workspacePath: () => destination, onChange: () => {},
    });
    document.body.appendChild(field);
    const open = (): string => {
      field.querySelector<HTMLButtonElement>('.issues-labels-field__add')!.click();
      return document.querySelector('.issues-labels-suggestions')?.textContent ?? '';
    };
    assert.match(open(), /FIRST/);
    closeIssuesLabelsSuggestionsMenu();
    destination = '/other';
    const suggestions = open();
    assert.match(suggestions, /SECOND/);
    assert.doesNotMatch(suggestions, /FIRST/);
  });

  test('coalesces refresh callbacks until a body-mounted popover closes', async () => {
    const field = createIssuesLabelsField({
      issueId: 'popover-refresh',
      labels: [],
      variant: 'form',
      onChange: () => {},
    });
    document.body.appendChild(field);
    field.querySelector<HTMLButtonElement>('.issues-labels-field__add')!.click();

    let refreshes = 0;
    const refresh = () => { refreshes += 1; };
    assert.equal(deferUntilIssueLabelPopoverClosed(refresh), true);
    assert.equal(deferUntilIssueLabelPopoverClosed(refresh), true);
    assert.equal(refreshes, 0);

    closeIssuesLabelsSuggestionsMenu();
    await Promise.resolve();
    assert.equal(refreshes, 1);
  });

  test('caret opens a popover with the remaining labels', () => {
    const issue = seedIssue(['AUTH', 'CLERK', 'ONBOARDING', 'SETUP', 'API']);
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'row',
      onChange: () => {},
    });
    document.body.appendChild(field);
    const more = field.querySelector('.issues-labels-field__more');
    assert.ok(more instanceof globalThis.HTMLButtonElement);
    more.click();
    const overflow = document.querySelector('.issues-labels-overflow');
    assert.ok(overflow);
    assert.deepEqual(
      [...overflow.querySelectorAll('.issues-label-chip__text')].map((node) => node.textContent),
      ['SETUP', 'API'],
    );
  });

  test('detail variant shows every label', () => {
    const issue = seedIssue(['AUTH', 'CLERK', 'ONBOARDING', 'SETUP']);
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'detail',
      onChange: () => {},
    });
    assert.equal(field.querySelectorAll('.issues-label-chip').length, 4);
    assert.equal(field.querySelector('.issues-labels-field__more'), null);
  });

  test('add popover lists every workspace suggestion, not a capped subset', () => {
    const labels = Array.from({ length: 15 }, (_, index) => `LABEL-${index + 1}`);
    const issue = seedIssue(['FEATURE']);
    setIssuesStateForTests({
      version: ISSUES_COMPAT_VERSION,
      schemaRevision: ISSUES_SCHEMA_VERSION,
      nextId: 10,
      issues: [
        {
          ...issue,
          labels: ['FEATURE'],
        },
        {
          id: 'MIN-10',
          type: 'task',
          title: 'Other',
          description: '',
          status: 'todo',
          priority: 'none',
          labels,
          workspacePath: '/workspace',
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
          source: 'user',
        },
      ],
    });

    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: ['FEATURE'],
      variant: 'row',
      onChange: () => {},
    });
    document.body.appendChild(field);
    field.querySelector('.issues-labels-field__add')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const options = document.querySelectorAll('.issues-labels-suggestions__item');
    assert.equal(options.length, 15);
  });

  test('filterIssueLabelSuggestions returns every match', () => {
    const suggestions = Array.from({ length: 25 }, (_, index) => `TAG-${index + 1}`);
    const filtered = filterIssueLabelSuggestions(suggestions, ['TAG-1'], '');
    assert.equal(filtered.length, 24);
  });

  test('onBlur fires once when focus leaves the field for an outside element', () => {
    const issue = seedIssue(['AUTH']);
    let blurCount = 0;
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'detail',
      onChange: () => {},
      onBlur: () => {
        blurCount += 1;
      },
    });
    document.body.append(field);

    const add = field.querySelector('.issues-labels-field__add');
    assert.ok(add instanceof globalThis.HTMLButtonElement);
    add.focus();
    assert.equal(blurCount, 0, 'focus inside the field must not fire onBlur');

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    assert.equal(blurCount, 1);
  });

  test('onBlur does not fire when focus stays inside the field', () => {
    const issue = seedIssue(['AUTH']);
    let blurCount = 0;
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'detail',
      onChange: () => {},
      onBlur: () => {
        blurCount += 1;
      },
    });
    document.body.append(field);

    const add = field.querySelector('.issues-labels-field__add');
    assert.ok(add instanceof globalThis.HTMLButtonElement);
    const remove = field.querySelector('.issues-label-chip__remove');
    assert.ok(remove instanceof globalThis.HTMLButtonElement);
    add.focus();
    remove.focus();

    assert.equal(blurCount, 0);
  });

  test('add popover stays open and focused after Enter so another label can be typed', () => {
    const issue = seedIssue(['AUTH']);
    const changes: string[][] = [];
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'detail',
      onChange: (labels) => {
        changes.push(labels);
      },
    });
    document.body.appendChild(field);
    field.querySelector<HTMLButtonElement>('.issues-labels-field__add')!.click();

    const input = document.querySelector('.issues-labels-add-popover input');
    assert.ok(input instanceof globalThis.HTMLInputElement);
    input.value = 'API';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const popover = document.querySelector('.issues-labels-add-popover');
    assert.ok(popover instanceof globalThis.HTMLElement);
    assert.equal(popover.isConnected, true);
    assert.equal(input.value, '');
    assert.equal(document.activeElement, input);
    assert.deepEqual(changes.at(-1), ['AUTH', 'API']);

    input.value = 'UX';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(changes.at(-1), ['AUTH', 'API', 'UX']);
    assert.equal(document.activeElement, input);
    assert.equal(document.querySelector('.issues-labels-add-popover'), popover);

    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('.issues-labels-add-popover')?.isConnected ?? false, false);
  });

  test('onBlur does not fire when focus moves into the body-mounted add flyout', () => {
    const issue = seedIssue(['AUTH']);
    let blurCount = 0;
    const field = createIssuesLabelsField({
      issueId: issue.id,
      labels: issue.labels,
      variant: 'detail',
      onChange: () => {},
      onBlur: () => {
        blurCount += 1;
      },
    });
    document.body.append(field);

    const add = field.querySelector('.issues-labels-field__add');
    assert.ok(add instanceof globalThis.HTMLButtonElement);
    add.click(); // opens the flyout and focuses its input
    const flyoutInput = document.querySelector('.issues-labels-add-popover input');
    assert.ok(flyoutInput instanceof globalThis.HTMLInputElement, 'flyout input should be focused');
    assert.equal(document.activeElement, flyoutInput);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus(); // focusout: field add button -> flyout input
    assert.equal(blurCount, 0);
  });
});
