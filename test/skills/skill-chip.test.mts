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
    assert.match(html, /<span class="skill-chip" data-label="Impeccable">\/impeccable<\/span>/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(html.includes('<script>'), false);
  });

  test('composer labels are capitalized while slash tokens remain intact', () => {
    const html = highlightedSkillTextHtml('/plan /ask /debug');
    for (const [token, label] of [['plan', 'Plan'], ['ask', 'Ask'], ['debug', 'Debug']]) {
      assert.ok(html.includes(`data-label="${label}">/${token}</span>`));
    }
    assert.match(highlightedSkillTextHtml('/git-commit'), /data-label="Git Commit"/);
  });

  test('reveals only the source token being edited', () => {
    assert.match(highlightedSkillTextHtml('/plan /ask', undefined, 8), /data-label="Ask" data-editing="true">\/ask/);
    assert.doesNotMatch(highlightedSkillTextHtml('/plan /ask', undefined, 10), /data-editing/);
    assert.doesNotMatch(highlightedSkillTextHtml('/plan /ask', undefined, 5), /data-editing/);
  });
});
