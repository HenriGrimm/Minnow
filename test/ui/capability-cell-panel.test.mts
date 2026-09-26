/**
 * Capability-matrix cell click opens the transcript drawer with the editor folded in.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import type { BenchmarkCampaign } from '../../src/benchmark/campaign-types.ts';
import type { BenchmarkRun } from '../../src/benchmark/types.ts';
import type { MergedCapabilityCell } from '../../src/benchmark/capabilities/merge.ts';
import { closeBenchmarkTranscriptDrawer } from '../../src/ui/benchmark-transcript-drawer.ts';
import { openCapabilityCellTranscript } from '../../src/ui/capability-matrix/cell-transcript.ts';

const TARGET_KEY = 'openai::gpt-test';
const CAP_ID = 'core-streaming';

const CELL: MergedCapabilityCell = {
  targetKey: TARGET_KEY,
  capabilityId: CAP_ID,
  verdict: 'untested',
  source: 'none',
};

function setupDom(): Window {
  const window = new Window();
  globalThis.window = window as unknown as typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.Node = window.Node;
  document.body.replaceChildren();
  return window;
}

function matrixRun(): BenchmarkRun {
  return {
    id: 'run-1',
    startedAt: '2026-06-01T00:00:00.000Z',
    durationMs: 12,
    preset: 'custom',
    provider: { id: 'openai', baseUrl: 'http://127.0.0.1' },
    model: { id: 'gpt-test' },
    totalScore: 0,
    headlineTokPerSec: 0,
    headlineTtftMs: 0,
    modeMatrixPassed: 0,
    toolsPassed: 0,
    skillsPassed: 0,
    suites: [
      {
        id: 'capability-matrix',
        label: 'Capability matrix',
        passed: 0,
        failed: 1,
        skipped: 0,
        score: 0,
        tests: [
          {
            testId: `cap-matrix/${CAP_ID}`,
            suite: 'capability-matrix',
            label: CAP_ID,
            passed: false,
            skipped: false,
            durationMs: 12,
            score: 0,
            verdict: 'fail',
            transcript: [
              { role: 'user', content: 'Stream three tokens.' },
              { role: 'assistant', content: 'one two three' },
            ],
          },
        ],
      },
    ],
  };
}

function campaignWithRun(): BenchmarkCampaign {
  return {
    id: 'c1',
    startedAt: '2026-06-01T00:00:00.000Z',
    endedAt: '2026-06-02T00:00:00.000Z',
    durationMs: 1,
    preset: 'custom',
    targets: [{ providerId: 'openai', modelId: 'gpt-test' }],
    suites: [{ family: 'integration', id: 'capability-matrix' }],
    status: 'completed',
    cells: [],
    aggregates: [],
    runs: [matrixRun()],
    kind: 'capability-matrix',
  };
}

describe('capability cell transcript panel', () => {
  afterEach(() => {
    closeBenchmarkTranscriptDrawer();
    document.body.replaceChildren();
  });

  test('opens the drawer with an embedded editor when no probe has run', () => {
    setupDom();
    openCapabilityCellTranscript(CELL, {
      campaigns: [],
      targetLabel: 'gpt-test',
      onSaved: () => {},
    });

    const panel = document.querySelector('.benchmark-transcript-drawer-panel');
    assert.ok(panel);
    const editor = document.querySelector('.cap-matrix-cell-editor--embedded');
    assert.ok(editor);
    assert.equal(editor?.textContent?.includes('View probe transcript'), false);
    assert.ok(document.querySelector('.cap-matrix-cell-editor__heading'));
    assert.match(
      document.querySelector('.benchmark-transcript-drawer__empty')?.textContent ?? '',
      /No probe has run/,
    );
    assert.ok(document.querySelector('.benchmark-transcript-drawer__extra'));
    assert.ok(document.querySelector('.benchmark-transcript-drawer__copy'));
  });

  test('shows probe messages and keeps the editor in the extra slot', () => {
    setupDom();
    openCapabilityCellTranscript(
      { ...CELL, verdict: 'fail', source: 'auto', autoVerdict: 'fail' },
      {
        campaigns: [campaignWithRun()],
        targetLabel: 'gpt-test',
        onSaved: () => {},
      },
    );

    const user = document.querySelector('.transcript-view__user');
    assert.match(user?.textContent ?? '', /Stream three tokens/);
    assert.ok(document.querySelector('.cap-matrix-cell-editor--embedded'));
    assert.ok(document.querySelector('button.settings-action-btn--primary'));
  });

  test('shows reasoning in the transcript when stored on assistant messages', () => {
    setupDom();
    const campaign = campaignWithRun();
    const test = campaign.runs![0]!.suites[0]!.tests[0]!;
    test.transcript = [
      { role: 'user', content: 'Solve the bat-and-ball puzzle.' },
      {
        role: 'assistant',
        content: 'The ball costs $0.05.',
        reasoning_content: '1.10 - 1.00 = 0.10',
      },
    ];

    openCapabilityCellTranscript(
      { ...CELL, verdict: 'pass', source: 'auto', autoVerdict: 'pass' },
      {
        campaigns: [campaign],
        targetLabel: 'gpt-test',
        onSaved: () => {},
      },
    );

    assert.equal(
      document.querySelector('.transcript-view__assistant')?.textContent,
      'The ball costs $0.05.',
    );
    document.querySelector<HTMLButtonElement>('.thoughts-toggle')?.click();
    assert.equal(
      document.querySelector('.thoughts-content')?.textContent?.trim(),
      '1.10 - 1.00 = 0.10',
    );
    assert.equal(
      document.querySelector('.thoughts-toggle__label')?.textContent,
      'Thoughts',
    );
  });
});
