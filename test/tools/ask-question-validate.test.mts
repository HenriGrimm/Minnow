/**
 * Tests for ask_question argument validation.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ASK_QUESTION_OTHER_ID,
  diagnoseAskQuestionItem,
  normalizeAskQuestionItem,
  promptImpliesAllowMultiple,
  validateAskQuestionArgs,
} from '../../src/tools/ask-question-types.ts';

const validQ = (id: string) => ({
  id,
  prompt: 'Pick one',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
});

describe('validateAskQuestionArgs', () => {
  test('accepts minimal valid payload', () => {
    const r = validateAskQuestionArgs({ questions: [validQ('q1')] });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.questions.length, 1);
      assert.equal(r.args.questions[0].id, 'q1');
    }
  });

  test('accepts optional title', () => {
    const r = validateAskQuestionArgs({
      title: 'Theme',
      questions: [validQ('q1')],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.args.title, 'Theme');
  });

  test('rejects empty questions', () => {
    const r = validateAskQuestionArgs({ questions: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes('questions'));
  });

  test('rejects more than 10 questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => validQ(`q${i}`));
    const r = validateAskQuestionArgs({ questions });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes('10'));
  });

  test('rejects duplicate question ids', () => {
    const r = validateAskQuestionArgs({
      questions: [validQ('same'), validQ('same')],
    });
    assert.equal(r.ok, false);
  });

  test('rejects fewer than two options', () => {
    const r = validateAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'x', options: [{ id: 'a', label: 'Only' }] }],
    });
    assert.equal(r.ok, false);
  });

  test('rejects reserved __other__ option id', () => {
    const r = validateAskQuestionArgs({
      questions: [
        {
          id: 'q1',
          prompt: 'x',
          options: [
            { id: ASK_QUESTION_OTHER_ID, label: 'bad' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });
    assert.equal(r.ok, false);
  });

  test('rejects duplicate option ids within a question', () => {
    const r = validateAskQuestionArgs({
      questions: [
        {
          id: 'q1',
          prompt: 'x',
          options: [
            { id: 'dup', label: '1' },
            { id: 'dup', label: '2' },
          ],
        },
      ],
    });
    assert.equal(r.ok, false);
  });

  test('checks trimmed IDs before returning renderable options', () => {
    assert.equal(validateAskQuestionArgs({ questions: [validQ('same'), validQ(' same ')] }).ok, false);
    for (const id of [' a ', ` ${ASK_QUESTION_OTHER_ID} `]) {
      const question = { ...validQ('q1'), options: [{ id: 'a', label: 'A' }, { id, label: 'B' }] };
      assert.equal(validateAskQuestionArgs({ questions: [question] }).ok, false);
    }
  });

  test('omits unusable descriptions and optional titles from the durable payload', () => {
    const question = validQ('q1');
    const raw = { ...question, options: [{ ...question.options[0], description: true }, question.options[1]] };
    assert.deepEqual(validateAskQuestionArgs({ questions: [raw] }), { ok: true, args: { questions: [question] } });
  });

  test('diagnose hints when prompt is named question', () => {
    const hint = diagnoseAskQuestionItem({
      id: 'q1',
      question: 'Pick one',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    assert.ok(hint?.includes('prompt'));
  });

  test('diagnose hints when options are strings', () => {
    const hint = diagnoseAskQuestionItem({
      id: 'q1',
      prompt: 'Pick one',
      options: ['Yes', 'No'],
    });
    assert.ok(hint?.includes('objects'));
  });

  test('validation error mentions required shape', () => {
    const r = validateAskQuestionArgs({
      questions: [{ id: 'q1', question: 'x', choices: ['a', 'b'] }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('questions[0]'));
      assert.ok(r.error.includes('prompt'));
    }
  });

  test('normalizes allowMultiple alias', () => {
    const r = validateAskQuestionArgs({
      questions: [{ ...validQ('q1'), allowMultiple: true }],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.args.questions[0].allow_multiple, true);
  });

  test('infers allow_multiple from click-all-that-apply prompt', () => {
    const r = validateAskQuestionArgs({
      questions: [
        {
          id: 'q1',
          prompt: 'Which platforms matter? (Click all that apply)',
          options: [
            { id: 'web', label: 'Web' },
            { id: 'desktop', label: 'Desktop' },
          ],
        },
      ],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.args.questions[0].allow_multiple, true);
  });

  test('promptImpliesAllowMultiple matches common phrasing', () => {
    assert.equal(promptImpliesAllowMultiple('Select all that apply'), true);
    assert.equal(promptImpliesAllowMultiple('Pick one option'), false);
  });

  test('normalizeAskQuestionItem preserves explicit false', () => {
    const item = normalizeAskQuestionItem({
      ...validQ('q1'),
      prompt: 'Select all that apply',
      allow_multiple: false,
    });
    assert.equal(item.allow_multiple, false);
  });
});
