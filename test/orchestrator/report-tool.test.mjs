/**
 * P2-E — Builder and Tester report schemas (MIN-702).
 *
 * Each malformed variant is rejected with a message the agent can act on.
 * A rejected report is not `no_report`; that is asserted in the wiring suite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_REPORT_TOOL_NAME } from '../../server/runner/run-turn.js';
import {
  builderReportTool,
  parseBuilderReport,
  parseReportFor,
  parseTesterReport,
  REPORT_TOOL_NAME,
  reportToolFor,
  testerReportTool,
} from '../../server/orchestrator/report-tool.js';

const BUILDER_PASS = {
  outcome: 'pass',
  summary: 'Added GET /health.',
  evidence: ['src/api/health.ts'],
  blockers: [],
  needs: [],
};

const BUILDER_FAIL = {
  outcome: 'fail',
  summary: 'Typecheck failed.',
  evidence: ['src/api/health.ts'],
  blockers: ['src/api/health.ts: missing return type'],
  needs: [],
};

const BUILDER_BLOCKED = {
  outcome: 'blocked',
  summary: 'Cannot reach postgres.',
  evidence: ['psql: connection refused'],
  blockers: [],
  needs: ['DATABASE_URL must be set'],
};

const TESTER_PASS = {
  outcome: 'pass',
  summary: 'All scripts green.',
  evidence: ['npm test'],
  testOutput: '12 passing',
};

const TESTER_FAIL = {
  outcome: 'fail',
  summary: 'Health test failed.',
  evidence: ['test/api/health.test.ts'],
  testOutput: 'FAIL test/api/health.test.ts\n  expected 200, got 500',
};

// ── report tool identity ─────────────────────────────────────────────────────

describe('report tool identity', () => {
  it('uses the same name runTurn injects by default', () => {
    assert.equal(REPORT_TOOL_NAME, DEFAULT_REPORT_TOOL_NAME);
    assert.equal(builderReportTool().function.name, REPORT_TOOL_NAME);
    assert.equal(testerReportTool().function.name, REPORT_TOOL_NAME);
    assert.equal(reportToolFor('builder').function.name, REPORT_TOOL_NAME);
    assert.equal(reportToolFor('tester').function.name, REPORT_TOOL_NAME);
  });

  it('advertises blocked only on the builder schema', () => {
    assert.deepEqual(builderReportTool().function.parameters.properties.outcome.enum, [
      'pass',
      'fail',
      'blocked',
    ]);
    assert.deepEqual(testerReportTool().function.parameters.properties.outcome.enum, [
      'pass',
      'fail',
    ]);
  });
});

// ── valid ────────────────────────────────────────────────────────────────────

describe('parseBuilderReport — valid', () => {
  it('accepts pass, fail, and blocked', () => {
    const pass = parseBuilderReport(BUILDER_PASS);
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.result, {
      outcome: 'pass',
      summary: BUILDER_PASS.summary,
      evidence: BUILDER_PASS.evidence,
    });

    const fail = parseBuilderReport(BUILDER_FAIL);
    assert.equal(fail.ok, true);
    assert.deepEqual(fail.result, {
      outcome: 'fail',
      summary: BUILDER_FAIL.summary,
      blockers: BUILDER_FAIL.blockers,
    });

    const blocked = parseBuilderReport(BUILDER_BLOCKED);
    assert.equal(blocked.ok, true);
    assert.deepEqual(blocked.result, {
      outcome: 'blocked',
      summary: BUILDER_BLOCKED.summary,
      needs: BUILDER_BLOCKED.needs,
    });
  });

  it('accepts a JSON string of the same object', () => {
    const parsed = parseBuilderReport(JSON.stringify(BUILDER_PASS));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.outcome, 'pass');
  });
});

// ── malformed ────────────────────────────────────────────────────────────────

describe('parseBuilderReport — malformed', () => {
  const cases = [
    ['not-json', 'not json {', 'JSON'],
    ['array', [], 'object'],
    ['null', null, 'object'],
    ['missing outcome', { summary: 'x', evidence: [], blockers: [], needs: [] }, 'outcome'],
    ['env_blocked leftover', { ...BUILDER_PASS, outcome: 'env_blocked' }, 'blocked'],
    ['unknown outcome', { ...BUILDER_PASS, outcome: 'ok' }, 'outcome'],
    ['missing summary', { outcome: 'pass', evidence: [], blockers: [], needs: [] }, 'summary'],
    ['empty summary', { ...BUILDER_PASS, summary: '   ' }, 'summary'],
    ['summary not a string', { ...BUILDER_PASS, summary: 12 }, 'summary'],
    ['missing evidence', { outcome: 'pass', summary: 'x', blockers: [], needs: [] }, 'evidence'],
    ['evidence not array', { ...BUILDER_PASS, evidence: 'src/a.ts' }, 'evidence'],
    ['evidence item not string', { ...BUILDER_PASS, evidence: [1] }, 'evidence'],
    ['missing blockers', { outcome: 'fail', summary: 'x', evidence: [], needs: [] }, 'blockers'],
    ['blockers not array', { ...BUILDER_FAIL, blockers: 'typecheck' }, 'blockers'],
    ['missing needs', { outcome: 'blocked', summary: 'x', evidence: [], blockers: [] }, 'needs'],
    ['needs not array', { ...BUILDER_BLOCKED, needs: 'postgres' }, 'needs'],
  ];

  for (const [name, raw, hint] of cases) {
    it(`rejects ${name} with an actionable message`, () => {
      const parsed = parseBuilderReport(raw);
      assert.equal(parsed.ok, false, name);
      assert.match(parsed.error, /^Error: /);
      assert.match(parsed.error, /Retry/i);
      assert.match(parsed.error.toLowerCase(), new RegExp(hint, 'i'));
    });
  }
});

describe('parseTesterReport — valid', () => {
  it('accepts pass and fail', () => {
    const pass = parseTesterReport(TESTER_PASS);
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.result, {
      outcome: 'pass',
      summary: TESTER_PASS.summary,
      evidence: TESTER_PASS.evidence,
    });

    const fail = parseTesterReport(TESTER_FAIL);
    assert.equal(fail.ok, true);
    assert.equal(fail.result.outcome, 'fail');
    assert.equal(fail.result.summary, TESTER_FAIL.summary);
    assert.ok(fail.result.blockers[0].includes('expected 200, got 500'));
  });
});

describe('parseTesterReport — malformed', () => {
  const cases = [
    ['not-json', 'not json {', 'JSON'],
    ['array', [], 'object'],
    ['blocked outcome', { ...TESTER_PASS, outcome: 'blocked' }, 'blocked'],
    ['missing outcome', { summary: 'x', evidence: [], testOutput: '' }, 'outcome'],
    ['unknown outcome', { ...TESTER_PASS, outcome: 'ok' }, 'outcome'],
    ['missing summary', { outcome: 'pass', evidence: [], testOutput: '' }, 'summary'],
    ['empty summary', { ...TESTER_PASS, summary: '' }, 'summary'],
    ['missing evidence', { outcome: 'pass', summary: 'x', testOutput: '' }, 'evidence'],
    ['evidence not array', { ...TESTER_PASS, evidence: 'npm test' }, 'evidence'],
    ['missing testOutput', { outcome: 'fail', summary: 'x', evidence: [] }, 'testOutput'],
    ['testOutput not a string', { ...TESTER_FAIL, testOutput: ['fail'] }, 'testOutput'],
  ];

  for (const [name, raw, hint] of cases) {
    it(`rejects ${name} with an actionable message`, () => {
      const parsed = parseTesterReport(raw);
      assert.equal(parsed.ok, false, name);
      assert.match(parsed.error, /^Error: /);
      assert.match(parsed.error, /Retry/i);
      assert.match(parsed.error.toLowerCase(), new RegExp(hint, 'i'));
    });
  }
});

describe('leaked tool-call markup', () => {
  // A model that writes `<parameter=name>` tags whose envelope is recovered
  // imperfectly ends up with the markup inside an argument. Echoing the value
  // alone leaves it nothing to act on, and it retries the same shape until the
  // attempt budget is gone.
  const HINT = /not parsed into separate arguments/i;

  it('names the markup when it lands in the outcome itself', () => {
    const parsed = parseBuilderReport({
      outcome: 'pass\n<parameter=summary>\nW1-A verified.',
    });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, HINT);
  });

  it('names the markup when outcome is missing and the markup sits in another field', () => {
    const parsed = parseBuilderReport({
      blockers: '[]\n<parameter>\nevidence>\n["x"]',
    });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, HINT);
  });

  it('names the markup for the tester too', () => {
    const parsed = parseTesterReport({ outcome: 'pass\n<parameter=summary>\nran' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, HINT);
  });

  it('stays quiet for an ordinary bad outcome', () => {
    const parsed = parseBuilderReport({
      outcome: 'succeeded',
      summary: 's',
      evidence: [],
      blockers: [],
      needs: [],
    });
    assert.equal(parsed.ok, false);
    assert.doesNotMatch(parsed.error, HINT);
  });

  it('stays quiet when the outcome is simply absent', () => {
    const parsed = parseBuilderReport({ summary: 's' });
    assert.equal(parsed.ok, false);
    assert.doesNotMatch(parsed.error, HINT);
  });
});

describe('parseReportFor', () => {
  it('routes by role', () => {
    assert.equal(parseReportFor('builder')(BUILDER_BLOCKED).result.outcome, 'blocked');
    assert.equal(parseReportFor('tester')(TESTER_PASS).result.outcome, 'pass');
    assert.equal(parseReportFor('tester')(BUILDER_BLOCKED).ok, false);
  });
});
