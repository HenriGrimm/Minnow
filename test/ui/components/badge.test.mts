/**
 * Shared badges and chips.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { createBadge, createChip, setChipSelected } from '../../../src/ui/components/badge';
import { resetTooltipForTests } from '../../../src/ui/components/tooltip';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('badge and chip', () => {
  let dom: ComponentDom;

  afterEach(() => {
    resetTooltipForTests();
    dom?.cleanup();
  });

  test('badge tone, size, mono and dot', () => {
    dom = installComponentDom();
    const plain = createBadge({ label: 'Draft' });
    assert.equal(plain.className, 'mn-badge mn-badge--neutral mn-badge--md');
    assert.equal(plain.querySelector('.mn-badge__dot'), null);

    const metric = createBadge({ label: '42 tok/s', tone: 'success', size: 'sm', mono: true, dot: true });
    assert.equal(metric.classList.contains('mn-badge--success'), true);
    assert.equal(metric.classList.contains('mn-badge--sm'), true);
    assert.equal(metric.classList.contains('mn-badge--mono'), true);
    assert.equal(metric.querySelector('.mn-badge__dot')?.getAttribute('aria-hidden'), 'true');
    assert.equal(metric.querySelector('.mn-badge__label')?.textContent, '42 tok/s');
  });

  test('a passive chip is a span; a clickable chip is a toggle button', () => {
    dom = installComponentDom();
    const passive = createChip({ label: 'bug' });
    assert.equal(passive.querySelector('button'), null);

    let clicks = 0;
    const chip = createChip({ label: 'Open', selected: true, onClick: () => clicks++ });
    dom.doc.body.appendChild(chip);
    const main = chip.querySelector<HTMLButtonElement>('button.mn-chip__main')!;
    assert.equal(main.getAttribute('aria-pressed'), 'true');
    assert.equal(chip.classList.contains('is-selected'), true);
    main.click();
    assert.equal(clicks, 1);
    setChipSelected(chip, false);
    assert.equal(main.getAttribute('aria-pressed'), 'false');
    assert.equal(chip.classList.contains('is-selected'), false);
  });

  test('remove is a sibling button with a name and does not trigger the main action', () => {
    dom = installComponentDom();
    let clicks = 0;
    let removed = 0;
    const chip = createChip({ label: 'frontend', onClick: () => clicks++, onRemove: () => removed++ });
    dom.doc.body.appendChild(chip);
    const remove = chip.querySelector<HTMLButtonElement>('.mn-chip__remove')!;
    assert.equal(remove.getAttribute('aria-label'), 'Remove frontend');
    assert.equal(remove.closest('.mn-chip__main'), null, 'not nested in the main button');
    remove.click();
    assert.equal(removed, 1);
    assert.equal(clicks, 0);
  });
});
