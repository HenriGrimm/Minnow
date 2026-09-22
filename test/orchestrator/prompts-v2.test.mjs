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
  ['builder', 'full', path.join(PROMPTS_DIR, 'builder', 'agent.full.md')],
  ['builder', 'lite', path.join(PROMPTS_DIR, 'builder', 'agent.lite.md')],
  ['tester', 'full', path.join(PROMPTS_DIR, 'tester', 'agent.full.md')],
  ['tester', 'lite', path.join(PROMPTS_DIR, 'tester', 'agent.lite.md')],
  ['final', 'full', path.join(PROMPTS_DIR, 'final', 'agent.full.md')],
  ['final', 'lite', path.join(PROMPTS_DIR, 'final', 'agent.lite.md')],
];

function read(abs) {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
}

describe('efficient build and verification guidance', () => {
  for (const profile of ['full', 'lite']) {
    it(`${profile} builders batch edits and per-task testers leave the full ladder to integration`, () => {
      const builder = read(path.join(PROMPTS_DIR, 'builder', `agent.${profile}.md`));
      const tester = read(path.join(PROMPTS_DIR, 'tester', `agent.${profile}.md`));
      const chat = read(path.join(PROJECT_ROOT, 'src/chat/prompts/tool-usage', `default.${profile}.md`));
      for (const body of [builder, chat]) {
        assert.match(body, /apply_patch/);
        assert.match(body, /[Bb]atch independent/);
      }
      assert.match(tester, /final integration/i);
      assert.doesNotMatch(builder, /After editing each file/);
    });
  }
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
  for (const [role, profile, abs] of FILES) {
    it(`${role} ${profile} has front-matter and report_outcome`, () => {
      const body = read(abs);
      assert.match(body, /^---\n/);
      assert.match(body, /\nid: /);
      assert.match(body, /report_outcome/);
    });
  }
});

describe('V2 prompts use only orchestrator interpolation variables', () => {
  for (const [role, profile, abs] of FILES) {
    it(`${role} ${profile} has no chat-only work-agent or mode placeholders`, () => {
      const body = read(abs);
      assert.doesNotMatch(body, /\{\{(?:work_agent_label|mode_label)\}\}/);
    });
  }
});

describe('Builder prompt states the blocked criterion', () => {
  for (const profile of ['full', 'lite']) {
    it(`${profile} defines blocked as an environment problem, not a hard build`, () => {
      const body = read(path.join(PROMPTS_DIR, 'builder', `agent.${profile}.md`));
      assert.match(body, /`blocked` means the environment cannot support the work/i);
      assert.match(body, /missing dependency/i);
      assert.match(body, /unstartable service/i);
      assert.match(body, /absent credential/i);
      assert.match(body, /does \*\*not\*\* mean the code is hard/i);
      assert.match(body, /not an escape hatch from a failing build/i);
    });
  }
});

describe('Tester prompt has no blocked outcome', () => {
  for (const profile of ['full', 'lite']) {
    it(`${profile} allows pass or fail only`, () => {
      const body = read(path.join(PROMPTS_DIR, 'tester', `agent.${profile}.md`));
      assert.match(body, /pass.*fail/);
      assert.match(body, /do \*\*not\*\* report `blocked`|You do not report `blocked`/i);
      assert.equal(body.includes("outcome: \"pass\" | \"fail\" | \"blocked\""), false);
    });
  }
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

  for (const [role, profile, abs] of FILES) {
    it(`${role} ${profile} is clean`, () => {
      const body = read(abs);
      const start = body.indexOf('\n---\n');
      const content = start >= 0 ? body.slice(start + 5) : body;
      for (const [re, label] of banned) {
        assert.equal(re.test(content), false, `${role}/${profile} mentions ${label}`);
      }
    });
  }
});

describe('V2 builder has no "do not call delegate_tasks" leftover', () => {
  it('does not mention the deleted tool even as a prohibition', () => {
    const full = read(path.join(PROMPTS_DIR, 'builder', 'agent.full.md'));
    const lite = read(path.join(PROMPTS_DIR, 'builder', 'agent.lite.md'));
    assert.equal(full.includes('delegate_tasks'), false);
    assert.equal(lite.includes('delegate_tasks'), false);
  });
});

describe('Final Tester prompt is a fixed ladder, not a chooser', () => {
  for (const profile of ['full', 'lite']) {
    it(`${profile} runs execute_command, reports runInstructions, does not reopen work`, () => {
      const body = read(path.join(PROMPTS_DIR, 'final', `agent.${profile}.md`));
      assert.match(body, /execute_command/);
      assert.match(body, /runInstructions/);
      assert.match(body, /command:/);
      assert.match(body, /cwd:/);
      assert.match(body, /reopen/i);
      assert.equal(body.includes("outcome: \"pass\" | \"fail\" | \"blocked\""), false);
    });
  }
});
