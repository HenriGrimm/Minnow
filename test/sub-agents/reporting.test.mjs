import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSubAgentSystemPrompt } from '../../server/sub-agents/prompts.js';
import { SUB_AGENT_COMPLETION_GUIDANCE, subAgentCompletionResult, withSubAgentReportTool } from '../../server/sub-agents/reporting.js';
import { resolveTurnTools } from '../../server/runner/run-turn.js';

test('legacy sub-agent prompts and refreshed catalogs retain assignment completion semantics', async () => {
  for (const profile of ['full', 'lite']) {
    const prompt = await loadSubAgentSystemPrompt('explore', {}, 'Review source and report findings.', profile);
    assert.ok(prompt.includes(SUB_AGENT_COMPLETION_GUIDANCE));
  }
  const catalog = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const original = structuredClone(catalog);
  for (const tools of [withSubAgentReportTool(catalog), withSubAgentReportTool(withSubAgentReportTool(catalog))]) {
    assert.equal(tools.filter(tool => tool.function.name === 'report_outcome').length, 1);
    const report = tools.find(tool => tool.function.name === 'report_outcome').function;
    assert.ok(report.description.includes(SUB_AGENT_COMPLETION_GUIDANCE));
    assert.equal(report.parameters.properties.outcome.description, SUB_AGENT_COMPLETION_GUIDANCE);
    assert.deepEqual(report.parameters.properties.outcome.enum, ['pass', 'fail', 'blocked']);
  }
  assert.deepEqual(catalog, original);
  assert.ok(!resolveTurnTools([])[0].function.description.includes(SUB_AGENT_COMPLETION_GUIDANCE), 'board verdicts retain their original contract');
});

test('negative final assessments complete the run and preserve the original verdict and limitations', () => {
  for (const outcome of ['fail', 'blocked']) {
    const raw = { outcome, summary: 'Review finished; found authorization bugs.', blockers: ['Static review only.'],
      needs: ['Runtime validation unavailable.'], usage: { total_tokens: 321 } };
    const before = structuredClone(raw);
    const result = subAgentCompletionResult(raw);
    assert.equal(result.outcome, 'pass');
    assert.equal(result.reportedOutcome, outcome);
    assert.equal(result.summary, raw.summary);
    assert.deepEqual(result.evidence, [`Reported assessment: ${outcome}.`, ...raw.blockers, ...raw.needs]);
    assert.deepEqual(result.usage, raw.usage);
    assert.deepEqual(raw, before);
    assert.deepEqual(subAgentCompletionResult(result), result);
  }
});

test('execution failures, stopped runs, recovery barriers, and missing reports retain their outcome', () => {
  for (const raw of [{ outcome: 'crashed', error: 'Provider failed' }, { outcome: 'timeout' }, { outcome: 'no_report' },
    { outcome: 'crashed', error: 'Stopped', failure: { stopped: true } },
    { outcome: 'fail', summary: 'Effect needs recovery', failure: { recoveryRequired: true } },
    { outcome: 'pass', summary: 'Done.', evidence: [] }]) {
    assert.equal(subAgentCompletionResult(raw), raw);
  }
});
