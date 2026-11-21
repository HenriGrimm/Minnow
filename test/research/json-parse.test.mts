/**
 * Deep Research JSON repair helpers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseJsonArray, parseJsonObject, stripCodeBlock } from '../../server/lib/json-parse.js';

describe('stripCodeBlock', () => {
  test('removes ```json fences', () => {
    const input = '```json\n["a"]\n```';
    assert.equal(stripCodeBlock(input), '["a"]');
  });
});

describe('parseJsonArray', () => {
  test('parses a plain JSON array', () => {
    assert.deepEqual(parseJsonArray('["one", "two"]'), ['one', 'two']);
  });

  test('repairs truncated arrays from the last bracket', () => {
    const truncated = '["query one", "query two", "query thr';
    assert.deepEqual(parseJsonArray(truncated), ['query one', 'query two']);
  });

  test('keeps the last parseable array when the model echoes an example', () => {
    const echoed =
      'Example: ["query one", "query two", "query three"]\n\n' +
      'Here are queries:\n["real alpha", "real beta"]';
    assert.deepEqual(parseJsonArray(echoed), ['real alpha', 'real beta']);
  });

  test('parses arrays inside code fences', () => {
    assert.deepEqual(parseJsonArray('```\n["a", "b"]\n```'), ['a', 'b']);
  });
});

describe('parseJsonObject', () => {
  test('parses a plain object', () => {
    const obj = parseJsonObject('{"rational":"x","summary":"y"}');
    assert.equal(obj?.rational, 'x');
    assert.equal(obj?.summary, 'y');
  });

  test('extracts the outermost object from prose', () => {
    const obj = parseJsonObject('Sure! {"rational":"a","evidence":"b","summary":"c"} done.');
    assert.equal(obj?.summary, 'c');
  });
});
