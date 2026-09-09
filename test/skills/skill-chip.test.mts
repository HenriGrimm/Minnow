import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatComposerTextFromHistory,
  parseSkillTagFromHistory,
} from '../../src/skills/history-content.ts';
import {
  highlightedSkillTextHtml,
  restoreLeadingSkillToken,
  splitSlashSkillTokens,
} from '../../src/skills/skill-chip.ts';

describe('skill chips', () => {
  test('restoreLeadingSkillToken prepends the consumed slash', () => {
    assert.equal(restoreLeadingSkillToken('lets improve the skill display', 'impeccable'), '/impeccable lets improve the skill display');
    assert.equal(restoreLeadingSkillToken('', 'fix-ci'), '/fix-ci');
    assert.equal(restoreLeadingSkillToken('/impeccable already there', 'impeccable'), '/impeccable already there');
  });

  test('formatComposerTextFromHistory restores slash from audit footer', () => {
    const text = formatComposerTextFromHistory('lets improve the skill display\n\n[skill: impeccable]');
    assert.equal(text, '/impeccable lets improve the skill display');
    const tagged = parseSkillTagFromHistory('lets improve the skill display\n\n[skill: impeccable]');
    assert.equal(tagged.skillId, 'impeccable');
    assert.equal(tagged.displayText, 'lets improve the skill display');
  });

  test('splitSlashSkillTokens chips known builtin skills', () => {
    const parts = splitSlashSkillTokens('/impeccable lets improve\n/fix-ci');
    const chips = parts.filter((part) => part.kind === 'chip').map((part) => part.value);
    assert.deepEqual(chips, ['/impeccable', '/fix-ci']);
  });

  test('unknown slash tokens stay plain text', () => {
    const parts = splitSlashSkillTokens('see /not-a-real-skill please');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].kind, 'text');
  });

  test('highlightedSkillTextHtml escapes user text', () => {
    const html = highlightedSkillTextHtml('/impeccable <script>');
    assert.match(html, /<span class="skill-chip">\/impeccable<\/span>/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(html.includes('<script>'), false);
  });
});
