/**
 * P2-E — V2 Builder and Tester prompts (MIN-702).
 *
 * V1's work-agent prompts no longer name deleted board tools (MIN-715). These
 * files are the V2 lineage: `blocked` is defined, and boards / waves /
 * delegation / lifecycle reporting are gone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'prompts');
const V1_BUILDER = path.join(PROJECT_ROOT, 'src', 'chat', 'prompts', 'work-agents', 'builder', 'agent.full.md');
const V1_TESTER = path.join(PROJECT_ROOT, 'src', 'chat', 'prompts', 'work-agents', 'tester', 'agent.full.md');

const FILES = [
  ['builder', path.join(PROMPTS_DIR, 'builder', 'agent.full.md')],
  ['tester', path.join(PROMPTS_DIR, 'tester', 'agent.full.md')],
  ['final', path.join(PROMPTS_DIR, 'final', 'agent.full.md')],
];

function read(abs) {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
}

describe('efficient build and verification guidance', () => {
  it(`builders batch edits and per-task testers leave the full ladder to integration`, () => {
    const builder = read(path.join(PROMPTS_DIR, 'builder', `agent.full.md`));
    const tester = read(path.join(PROMPTS_DIR, 'tester', `agent.full.md`));
    const chat = read(path.join(PROJECT_ROOT, 'src/chat/prompts/tool-usage', 'default.full.md'));
    for (const body of [builder, chat]) {
      assert.match(body, /apply_patch/);
      assert.match(body, /[Bb]atch independent|Independent calls go in one message/);
    }
    assert.match(tester, /final integration/i);
    assert.doesNotMatch(builder, /After editing each file/);
  });
});

describe('acceptance verification remains actionable after failed checks', () => {
  it(`builders keep repairing without a browser budget or fixed retry cutoff`, () => {
    const builder = read(path.join(PROMPTS_DIR, 'builder', `agent.full.md`));
    assert.doesNotMatch(builder, /two-minute total budget|three unsuccessful repair cycles|#3 attempts|within the remaining budget/i);
    assert.match(builder, /Keep fixing failing acceptance tests until all required criteria pass or a concrete blocker/i);
    assert.match(builder, /change the hypothesis or approach/i);
    assert.match(builder, /Do not skip required checks, weaken assertions/i);
    assert.match(builder, /command and test timeouts appropriate/i);
    for (const role of ['builder', 'tester']) {
      const body = read(path.join(PROMPTS_DIR, role, `agent.full.md`));
      assert.match(body, /checks required by the assigned task's Test and Accept criteria/);
      assert.doesNotMatch(body, /two-minute total budget|report the conflict so acceptance can be narrowed/);
    }
  });
});

describe('V1 work-agent prompts no longer name deleted board tools', () => {
  it('builder and tester do not mention board_report', () => {
    const builder = read(V1_BUILDER);
    const tester = read(V1_TESTER);
    assert.equal(builder.includes('board_report'), false);
    assert.equal(tester.includes('board_report'), false);
  });
});

describe('V2 prompts exist with front-matter', () => {
  for (const [role, abs] of FILES) {
    it(`${role} has front-matter and report_outcome`, () => {
      const body = read(abs);
      assert.match(body, /^---\n/);
      assert.match(body, /\nid: /);
      assert.match(body, /report_outcome/);
    });
  }
});

describe('V2 prompts use only orchestrator interpolation variables', () => {
  for (const [role, abs] of FILES) {
    it(`${role} has no chat-only work-agent or mode placeholders`, () => {
      const body = read(abs);
      assert.doesNotMatch(body, /\{\{(?:work_agent_label|mode_label)\}\}/);
    });
  }
});

describe('V2 prompts do not instruct board roles to call browser tools', () => {
  for (const [role, abs] of FILES) {
    it(`${role} has no browser tool calls`, () => {
      assert.doesNotMatch(read(abs), /\b(?:browser_(?:snapshot|click|eval|navigate|screenshot)|browser_drive_[a-z_]+)\b/);
    });
  }
});

describe('Builder prompt states the blocked criterion', () => {
  it(`defines blocked as an environment problem, not a hard build`, () => {
    const body = read(path.join(PROMPTS_DIR, 'builder', `agent.full.md`));
    assert.match(body, /`blocked` means the environment cannot support the work/i);
    assert.match(body, /missing dependency/i);
    assert.match(body, /unstartable service/i);
    assert.match(body, /absent credential/i);
    assert.match(body, /does \*\*not\*\* mean the code is hard/i);
    assert.match(body, /not an escape hatch from a failing build/i);
  });
});

describe('Tester distinguishes defects from unavailable verification', () => {
  it(`allows an explicit prerequisite hold`, () => {
    const body = read(path.join(PROMPTS_DIR, 'tester', `agent.full.md`));
    assert.match(body, /pass.*fail/);
    assert.match(body, /prerequisite/i);
    assert.equal(body.includes("outcome: \"pass\" | \"fail\" | \"blocked\""), true);
  });
});

describe('neither V2 prompt mentions boards, waves, delegation, or lifecycle reporting', () => {
  const banned = [
    [/\bboards?\b/i, 'board'],
    [/\bwaves?\b/i, 'wave'],
    [/\bdelegat/i, 'delegat'],
    [/lifecycle/i, 'lifecycle'],
    [/board_report/, 'board_report'],
    [/board_init/, 'board_init'],
    [/delegate_tasks/, 'delegate_tasks'],
    [/env_blocked/, 'env_blocked'],
    [/env-fixer/, 'env-fixer'],
    [/merge-fixer/, 'merge-fixer'],
    [/VERDICT:/, 'VERDICT recovery marker'],
  ];

  for (const [role, abs] of FILES) {
    it(`${role} is clean`, () => {
      const body = read(abs);
      const start = body.indexOf('\n---\n');
      const content = start >= 0 ? body.slice(start + 5) : body;
      for (const [re, label] of banned) {
        assert.equal(re.test(content), false, `${role} mentions ${label}`);
      }
    });
  }
});

describe('V2 builder has no "do not call delegate_tasks" leftover', () => {
  it('does not mention the deleted tool even as a prohibition', () => {
    const full = read(path.join(PROMPTS_DIR, 'builder', 'agent.full.md'));
    assert.equal(full.includes('delegate_tasks'), false);
  });
});

describe('Final Tester prompt is a fixed ladder, not a chooser', () => {
  it(`runs execute_command, reports runInstructions, does not reopen work`, () => {
    const body = read(path.join(PROMPTS_DIR, 'final', `agent.full.md`));
    assert.match(body, /execute_command/);
    assert.match(body, /runInstructions/);
    assert.match(body, /command:/);
    assert.match(body, /cwd:/);
    assert.match(body, /reopen/i);
    assert.equal(body.includes("outcome: \"pass\" | \"fail\" | \"blocked\""), false);
  });
});
