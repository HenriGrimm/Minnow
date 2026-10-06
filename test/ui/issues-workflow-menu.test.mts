import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import {
  closeIssuesWorkflowMenu,
  createIssuesWorkflowDropdown,
  type IssuesWorkflowMenuItem,
} from '../../src/ui/issues-workflow-menu.ts';

test('mode selection preserves the send button origin after the sidebar rerenders', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  try {
    const selections: Parameters<IssuesWorkflowMenuItem['onSelect']>[0][] = [];
    const dropdown = createIssuesWorkflowDropdown({
      label: 'Send to chat',
      ariaLabel: 'Send issue to chat',
      items: [{ id: 'build', label: 'Build', onSelect: (context) => selections.push(context) }],
    });
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector('button')!;
    trigger.getBoundingClientRect = () => trigger.isConnected
      ? new win.DOMRect(850, 220, 100, 32)
      : new win.DOMRect();
    trigger.click();

    dropdown.remove();
    document.querySelector<HTMLButtonElement>('.issues-workflow-menu__item')!.click();

    assert.equal(selections.length, 1);
    assert.equal(selections[0]?.clientX, 850);
    assert.equal(selections[0]?.clientY, 252);
    assert.equal(document.querySelector('.issues-workflow-menu'), null);
  } finally {
    closeIssuesWorkflowMenu();
    await teardownHappyDomAsync(win);
  }
});
