/**
 * Unit tests for friendly model display labels (feature 10 / Epic A2).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  buildModelOptionHtml,
  formatModelLabel,
  humanizeModelSlug,
  slugFromModelId,
} from '../../src/lib/format-model-label.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '../fixtures/format-model-label.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  cases: Array<{
    id: string;
    quantization?: string;
    state?: string;
    primary: string;
    optionText: string;
    title: string;
    loadState: string;
  }>;
};

describe('slugFromModelId', () => {
  test('uses last path segment when id contains slashes', () => {
    assert.equal(slugFromModelId('vendor/deep/path/model-8b'), 'model-8b');
    assert.equal(slugFromModelId('qwen/qwen3.6-27b'), 'qwen3.6-27b');
  });

  test('returns trimmed id when no slash', () => {
    assert.equal(slugFromModelId('mock-model-fixed'), 'mock-model-fixed');
  });

  test('empty and whitespace ids yield empty slug', () => {
    assert.equal(slugFromModelId(''), '');
    assert.equal(slugFromModelId('   '), '');
  });
});

describe('humanizeModelSlug', () => {
  test('formats size tokens with uppercase B', () => {
    assert.equal(humanizeModelSlug('foo-27b'), 'Foo 27B');
    assert.equal(humanizeModelSlug('x-8b'), 'X 8B');
  });

  test('shows Claude model versions with a decimal', () => {
    assert.equal(humanizeModelSlug('claude-opus-5-5'), 'Claude Opus 5.5');
    assert.equal(humanizeModelSlug('claude-sonnet-5'), 'Claude Sonnet 5');
    assert.equal(humanizeModelSlug('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  });
});

describe('formatModelLabel fixture cases', () => {
  for (const row of fixture.cases) {
    test(`formats ${row.id.trim() || '(whitespace id)'}`, () => {
      const parts = formatModelLabel({
        id: row.id,
        quantization: row.quantization,
        state: row.state,
      });
      assert.equal(parts.primary, row.primary);
      assert.equal(parts.optionText, row.optionText);
      assert.equal(parts.title, row.title);
      assert.equal(parts.loadState, row.loadState);
    });
  }
});

describe('buildModelOptionHtml', () => {
  test('escapes HTML in id, title, and option text', () => {
    const html = buildModelOptionHtml({ id: 'weird<tag>&"model\'' });
    assert.ok(!html.includes('<tag>'));
    assert.ok(html.includes('&lt;tag&gt;'));
    assert.ok(html.includes('&quot;'));
    assert.ok(html.includes('&#39;'));
    assert.match(html, /^<option value="[^"]+" title="[^"]+">[^<]+<\/option>$/);
  });

  test('preserves canonical id in value attribute', () => {
    const html = buildModelOptionHtml({
      id: 'qwen/qwen3.6-27b',
      quantization: 'Q4_K_M',
      state: 'loaded',
    });
    assert.ok(html.includes('value="qwen/qwen3.6-27b"'));
    assert.ok(html.includes('Qwen3.6 27B'));
  });
});
