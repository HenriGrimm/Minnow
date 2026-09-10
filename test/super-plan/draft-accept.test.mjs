/**
 * W6-B — per-stage `report_outcome` + two-tier draft accept gate.
 *
 * Covers the review preset (`minnow.super-plan.review.v1`, findings required),
 * the per-stage schema mapping, and the two-tier draft accept gate: prose
 * plans pass Tier 1 with Tier 2 skipped, a broken executable plan is rejected
 * with `formatParseErrors` output in its retry seed, and an identical-sha draft
 * is rejected. Runs on bare node — the Super Plan core is plain .js + .d.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { derive } from '../../server/super-plan/derive.js';
import { makeEvent } from '../../server/super-plan/events.js';
import {
  buildStageSeed,
  parseReportForStage,
  schemaIdForStage,
  STAGE_SUMMARY_SCHEMAS,
} from '../../server/super-plan/effector-headless.js';
import {
  draftContentSha256,
  evaluateDraftAccept,
  isExecutableDraftPlan,
  REQUIRED_DRAFT_HEADINGS,
} from '../../server/super-plan/draft-accept.js';
import {
  SUB_AGENT_SUMMARY_SCHEMA_PRESETS,
  validateStructuredOutcomeForPreset,
} from '../../server/runner/sub-agent-summary-schemas.js';
import { formatParseErrors, isParseErrors, parsePlan } from '../../server/orchestrator/core/parse-plan.js';

const REVIEW_SCHEMA = 'minnow.super-plan.review.v1';

const PROSE_PLAN = [
  '# Prose plan',
  '',
  '## Overview',
  '',
  'A design note, not a board plan. No waves, no tasks.',
  '',
].join('\n');

const BROKEN_BOARD_PLAN = [
  '# Broken board plan',
  '',
  '## Wave Breakdown',
  '',
  '### Wave 1 — Schema',
  '',
  '#### Task W1-A: Incomplete',
  '',
  '- **Build:** write the thing',
  '',
].join('\n');

describe('minnow.super-plan.review.v1 preset', () => {
  const preset = SUB_AGENT_SUMMARY_SCHEMA_PRESETS[REVIEW_SCHEMA];

  it('is registered with requireFindings', () => {
    assert.ok(preset);
    assert.equal(preset.requireFindings, true);
    assert.equal(preset.maxFindings, 40);
  });

  it('validates a review fixture with findings present', () => {
    const outcome = validateStructuredOutcomeForPreset(
      {
        summary: 'REQUEST_CHANGES — 1 blocker. The wave order is wrong.',
        findings: [
          {
            id: 'F1',
            title: 'Wave order',
            detail: 'W2 depends on W1 but is listed first. Suggested fix: swap the waves.',
            severity: 'blocker',
            paths: ['documentation/plans/kanban.md'],
          },
        ],
        artifacts: [{ kind: 'path', label: 'plan', ref: 'documentation/plans/kanban.md' }],
      },
      preset,
    );
    assert.ok(outcome);
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.findings[0]?.severity, 'blocker');
  });
});

describe('per-stage report_outcome schema', () => {
  it('routes review to the findings-required preset and the rest to the standard one', () => {
    assert.equal(schemaIdForStage('review'), REVIEW_SCHEMA);
    assert.equal(schemaIdForStage('draft'), 'minnow.sub-agent.v1');
    assert.equal(schemaIdForStage('polish'), 'minnow.sub-agent.v1');
    assert.equal(schemaIdForStage('research'), 'minnow.sub-agent.v1');
    assert.equal(STAGE_SUMMARY_SCHEMAS.review, REVIEW_SCHEMA);
  });

  it('accepts a review report that carries findings', () => {
    const report = parseReportForStage(schemaIdForStage('review'))({
      summary: 'APPROVE — 0 blockers, 1 warn.',
      findings: [{ title: 'Naming', detail: 'Rename foo to loadConfig.', severity: 'warn' }],
      artifacts: [],
    });
    assert.equal(report.ok, true);
    assert.equal(report.result.outcome, 'pass');
  });

  it('accepts an empty findings array but rejects a report without structured findings', () => {
    const empty = parseReportForStage(schemaIdForStage('review'))({
      summary: 'looks fine',
      findings: [],
      artifacts: [],
    });
    assert.equal(empty.ok, true);

    const union = parseReportForStage(schemaIdForStage('review'))({
      outcome: 'pass',
      summary: 'looks fine',
    });
    assert.equal(union.ok, false);
    assert.match(union.error, /requires structured findings/);
  });
});

describe('two-tier draft accept gate', () => {
  it('passes a prose plan through Tier 1 with Tier 2 skipped', () => {
    const result = evaluateDraftAccept({
      markdown: PROSE_PLAN,
      planPath: 'documentation/plans/kanban.md',
      priorAcceptedSha256: null,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.tier, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.retrySeed, null);
    assert.equal(isExecutableDraftPlan('documentation/plans/references/kanban-spec.md'), false);
  });

  it('rejects a broken executable board plan with parse errors in the retry seed', () => {
    const parsed = parsePlan(BROKEN_BOARD_PLAN);
    assert.equal(isParseErrors(parsed), true);
    const formatted = formatParseErrors(parsed);

    const result = evaluateDraftAccept({
      markdown: BROKEN_BOARD_PLAN,
      planPath: 'documentation/plans/kanban.md',
      priorAcceptedSha256: null,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.tier, 2);
    assert.ok(result.retrySeed.includes(formatted), result.retrySeed ?? '');
    assert.ok(result.retrySeed.includes('line 1:1'));
  });

  it('accepts a valid executable board plan through Tier 2', () => {
    const valid = [
      '---',
      'name: kanban',
      'overview: a board',
      'isProject: true',
      'todos:',
      '  - id: W1-A',
      '    content: first',
      '    status: todo',
      '---',
      '# Kanban',
      '',
      '## Wave Breakdown',
      '',
      '### Wave 1 — Build',
      '',
      '#### Task W1-A: First',
      '',
      '- **Build:** do the thing',
      '- **Test:** assert the thing',
      '- **Accept:** the thing works',
      '- **Touches:** src/thing.ts',
      '',
    ].join('\n');
    const result = evaluateDraftAccept({
      markdown: valid,
      planPath: 'documentation/plans/kanban.md',
      priorAcceptedSha256: null,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.tier, 2);
  });

  it('rejects an identical-sha draft', () => {
    const result = evaluateDraftAccept({
      markdown: PROSE_PLAN,
      planPath: 'documentation/plans/references/kanban-spec.md',
      priorAcceptedSha256: draftContentSha256(PROSE_PLAN),
    });
    assert.equal(result.accepted, false);
    assert.equal(result.tier, 1);
    assert.match(result.errors[0], /identical/);
  });

  it('rejects a draft that was never written or is empty', () => {
    assert.equal(evaluateDraftAccept({ markdown: null }).accepted, false);
    assert.equal(evaluateDraftAccept({ markdown: '   \n' }).accepted, false);
  });

  it('rejects a draft missing the required headings', () => {
    const result = evaluateDraftAccept({ markdown: '# Title only\n', planPath: null });
    assert.equal(result.accepted, false);
    assert.match(result.errors[0], /required heading/);
    assert.deepEqual([...REQUIRED_DRAFT_HEADINGS], ['# ', '## ']);
  });

  it('classifies executable paths like isExecutableOrchestratePlan', () => {
    assert.equal(isExecutableDraftPlan('documentation/plans/kanban.md'), true);
    assert.equal(isExecutableDraftPlan('documentation/plans/references/x.md'), false);
    assert.equal(isExecutableDraftPlan('documentation/plans/verification/step-01.md'), false);
    assert.equal(isExecutableDraftPlan('src/main.ts'), false);
  });
});

describe('rejected draft retry seed', () => {
  it('carries the accept-gate errors into the next draft seed', () => {
    const errors = ['line 1:1 — plan is missing YAML front matter'];
    const state = derive([
      makeEvent('run.created', {
        runId: 'run-1',
        prompt: 'Build a Kanban UI',
        config: { research: false, reviewRounds: 0, polish: 'never' },
      }),
      makeEvent('run.started', {}),
      makeEvent('stage.ended', { stage: 'interview', attemptId: 'i1', outcome: 'ok' }),
      makeEvent('stage.ended', { stage: 'spec', attemptId: 's1', outcome: 'ok' }),
      makeEvent('spec.written', { path: 'documentation/plans/references/kanban-spec.md' }),
      makeEvent('gate.opened', { kind: 'spec' }),
      makeEvent('gate.answered', { kind: 'spec', verdict: 'confirm' }),
      makeEvent('stage.started', { stage: 'draft', attemptId: 'd1' }),
      makeEvent('stage.ended', { stage: 'draft', attemptId: 'd1', outcome: 'rejected', errors }),
    ]);
    assert.equal(state.stage, 'draft');
    assert.equal(state.draftSeed, 'errors');
    const seed = buildStageSeed('draft', state, 'errors');
    assert.ok(seed.includes(errors[0]), seed);
  });
});
