import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  PlanProgressPanel,
  REGULAR_PLAN_DISPLAY_STEPS,
  buildPlanPreviewPopoutDom,
  findPlanPreviewActionButton,
  regularPlanWorkingStepIndex,
} from '../../src/ui/plan-progress-screen.ts';

describe('plan progress screen', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window as never;
    globalThis.document = window.document as never;
    globalThis.performance = window.performance as never;
    document.body.innerHTML = '<div id="mount"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('regularPlanWorkingStepIndex advances with activity and save detection', () => {
    assert.equal(regularPlanWorkingStepIndex({ activityPhase: 'thinking' }), 0);
    assert.equal(regularPlanWorkingStepIndex({ activityPhase: 'generating' }), 1);
    assert.equal(regularPlanWorkingStepIndex({ activityPhase: 'tools', currentTool: 'list_dir' }), 1);
    assert.equal(regularPlanWorkingStepIndex({ hasPlanSave: true }), 2);
  });

  test('PlanProgressPanel renders the three Plan-mode steps and advances', () => {
    const mount = document.getElementById('mount') as HTMLElement;
    const panel = new PlanProgressPanel(mount, { reducedMotion: true });
    panel.reset();
    assert.equal(mount.querySelectorAll('.dr-node').length, REGULAR_PLAN_DISPLAY_STEPS.length);
    assert.ok(mount.querySelector('.dr-node.active'));

    panel.applyRegularPlanStep(1);
    assert.equal(mount.querySelectorAll('.dr-node.done').length, 1);
    assert.match(mount.querySelector('.dr-prog-title')?.textContent ?? '', /Drafting the plan/);

    panel.complete('error', 'Planning stopped');
    assert.match(mount.querySelector('.dr-prog-title')?.textContent ?? '', /Planning stopped/);
    panel.destroy();
    assert.equal(mount.childElementCount, 0);
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

  test('preview popout disables Start Orchestrator for a plan the board cannot run', () => {
    const popout = buildPlanPreviewPopoutDom(
      { onRevise: () => {}, onStartOrchestrator: () => {}, onBuild: () => {} },
      { orchestrateEnabled: false },
    );
    assert.equal(findPlanPreviewActionButton(popout, 'orchestrate')?.disabled, true);
  });

  test('plan progress CSS constrains embedded research source feed overflow', () => {
    const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/styles/plan-progress.css');
    const css = readFileSync(cssPath, 'utf8');
    assert.match(css, /\.orchestrate-plan-screen__progress-mount \.dr-feed[\s\S]*overflow-y:\s*auto/);
    assert.match(css, /\.orchestrate-plan-screen__progress-mount \.dr-feed-title[\s\S]*text-overflow:\s*ellipsis/);
    assert.match(css, /\.orchestrate-plan-screen__progress-mount \.dr-workspace-checklist[\s\S]*list-style:\s*none/);
    assert.match(css, /\.dr-prog--embedded/);
    assert.match(css, /\.dr-embedded-bar/);
  });
});
