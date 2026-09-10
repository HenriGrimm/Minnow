import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createInitialSuperPlanStages } from '../helpers/super-plan-fixture.ts';
import type { SuperPlanState } from '../../src/chat/super-plan/types.ts';
import {
  PlanProgressPanel,
  buildPlanPreviewPopoutDom,
  findPlanPreviewActionButton,
  regularPlanWorkingStepIndex,
  superPlanStageToDisplayStep,
  superPlanStateToDisplayStep,
  superPlanStepNodeState,
} from '../../src/ui/plan-progress-screen.ts';

function makeSuperPlanState(activeStage: SuperPlanState['activeStage']): SuperPlanState {
  return {
    slug: 'demo-plan',
    prompt: 'Build a feature',
    activeStage,
    stages: createInitialSuperPlanStages(),
    specPath: 'documentation/plans/references/demo-plan-spec.md',
    researchPath: 'documentation/plans/references/demo-plan-research.md',
    planPath: 'documentation/plans/demo-plan.md',
  };
}

describe('plan progress screen', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.performance = window.performance;
    document.body.innerHTML = '<div id="mount"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('superPlanStageToDisplayStep maps pipeline stages to seven display nodes', () => {
    assert.equal(superPlanStageToDisplayStep('grill'), 0);
    assert.equal(superPlanStageToDisplayStep('spec_confirm'), 1);
    assert.equal(superPlanStageToDisplayStep('research'), 2);
    assert.equal(superPlanStageToDisplayStep('draft1'), 3);
    assert.equal(superPlanStageToDisplayStep('review2'), 4);
    assert.equal(superPlanStageToDisplayStep('impeccable'), 5);
    assert.equal(superPlanStageToDisplayStep('finalize'), 6);
    assert.equal(superPlanStageToDisplayStep('present'), 6);
  });

  test('superPlanStepNodeState marks prior nodes done', () => {
    const state = makeSuperPlanState('research');
    state.stages.grill.status = 'done';
    state.stages.spec_confirm.status = 'done';
    state.stages.research.status = 'running';

    assert.equal(superPlanStepNodeState(state, 0), 'done');
    assert.equal(superPlanStepNodeState(state, 1), 'done');
    assert.equal(superPlanStepNodeState(state, 2), 'active');
    assert.equal(superPlanStepNodeState(state, 3), 'todo');
    assert.equal(superPlanStateToDisplayStep(state), 2);
  });

  test('regularPlanWorkingStepIndex advances with activity and save detection', () => {
    assert.equal(regularPlanWorkingStepIndex({ activityPhase: 'thinking' }), 0);
    assert.equal(regularPlanWorkingStepIndex({ activityPhase: 'generating' }), 1);
    assert.equal(
      regularPlanWorkingStepIndex({ activityPhase: 'tools', currentTool: 'list_dir' }),
      1,
    );
    assert.equal(regularPlanWorkingStepIndex({ hasPlanSave: true }), 2);
  });

  test('PlanProgressPanel renders super-plan stepper nodes', () => {
    const mount = document.getElementById('mount') as HTMLElement;
    const panel = new PlanProgressPanel(mount, { variant: 'super-plan', reducedMotion: true });
    panel.reset();
    const state = makeSuperPlanState('draft1');
    state.stages.grill.status = 'done';
    state.stages.spec_confirm.status = 'done';
    state.stages.research.status = 'done';
    state.stages.draft1.status = 'running';
    panel.applySuperPlanState(state);

    assert.ok(mount.querySelector('.dr-stepper'));
    assert.ok(mount.querySelector('.dr-node.active'));
    assert.ok(mount.querySelector('.dr-node.done'));
    panel.destroy();
  });

  test('PlanProgressPanel advances headline when active stage leaves interview', () => {
    const mount = document.getElementById('mount') as HTMLElement;
    const panel = new PlanProgressPanel(mount, { variant: 'super-plan', reducedMotion: true });
    panel.reset();

    const grillState = makeSuperPlanState('grill');
    grillState.stages.grill.status = 'running';
    panel.applySuperPlanState(grillState);
    assert.match(
      mount.querySelector('[data-plan-label]')?.textContent ?? '',
      /Interviewing/i,
    );

    const specState = makeSuperPlanState('spec_confirm');
    specState.stages.grill.status = 'done';
    specState.stages.spec_confirm.status = 'running';
    panel.applySuperPlanState(specState);
    assert.match(
      mount.querySelector('[data-plan-label]')?.textContent ?? '',
      /build spec/i,
    );

    panel.destroy();
  });

  test('preview popout wires three action buttons', () => {
    const calls: string[] = [];
    const popout = buildPlanPreviewPopoutDom({
      onRevise: () => calls.push('revise'),
      onStartOrchestrator: () => calls.push('orchestrate'),
      onBuild: () => calls.push('build'),
    });

    document.body.appendChild(popout);

    findPlanPreviewActionButton(popout, 'revise')?.click();
    findPlanPreviewActionButton(popout, 'orchestrate')?.click();
    findPlanPreviewActionButton(popout, 'build')?.click();

    assert.deepEqual(calls, ['revise', 'orchestrate', 'build']);
  });

  test('plan progress CSS constrains embedded research source feed overflow', () => {
    const cssPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/styles/plan-progress.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    assert.match(css, /\.orchestrate-plan-screen__progress-mount \.dr-feed[\s\S]*overflow-y:\s*auto/);
    assert.match(
      css,
      /\.orchestrate-plan-screen__progress-mount \.dr-feed-title[\s\S]*text-overflow:\s*ellipsis/,
    );
    assert.match(
      css,
      /\.orchestrate-plan-screen__progress-mount \.dr-workspace-checklist[\s\S]*list-style:\s*none/,
    );
    assert.match(css, /\.dr-prog--embedded/);
    assert.match(css, /\.dr-embedded-bar/);
  });
});
