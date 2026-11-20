/**
 * Auto probe specs — core protocol and files/git/docs bands.
 */

import { CAP_MATRIX_HAYSTACK_NEEDLE } from './fixture-paths.ts';
import {
  fail,
  firstRoundWithTool,
  hallucinatedToolNames,
  hasTool,
  maxRoundBatchSize,
  parseToolArgs,
  pass,
  partial,
  streamVerdict,
  totalToolRounds,
} from './probe-helpers.ts';
import type { CapabilityProbeSpec } from './types.ts';

export const CORE_AND_FILES_PROBES: Record<string, CapabilityProbeSpec> = {
  'core-streaming': {
    kind: 'stream',
    verdict: streamVerdict,
  },
  'core-tool-calling': {
    kind: 'tool-call',
    toolIds: ['get_datetime'],
    verdict: (out) =>
      hasTool(out.toolCalls, 'get_datetime')
        ? pass('Emitted get_datetime')
        : fail('Answered in prose instead of calling get_datetime'),
  },
  'core-parallel-tools': {
    kind: 'derived',
    maxToolRounds: 4,
    toolIds: ['read_file'],
    requires: ['workspace'],
    verdict: (out) => {
      const batch = maxRoundBatchSize(out);
      if (batch >= 3) return pass('Three or more parallel read_file calls');
      if (batch === 2) return partial('Two read_file calls in one batch');
      if (batch === 1 && out.rounds.some((r) => r.toolCalls.length > 0)) {
        return partial('Serial read_file calls only');
      }
      return fail('No read_file batch observed');
    },
  },
  'core-tool-loop': {
    kind: 'tool-chain',
    maxToolRounds: 16,
    toolIds: ['list_directory', 'read_file', 'grep', 'find_files'],
    requires: ['workspace'],
    verdict: (out) => {
      const rounds = totalToolRounds(out);
      const callCount = out.rounds.reduce((n, r) => n + r.toolCalls.length, 0);
      const listRound = firstRoundWithTool(out, 'list_directory');
      const readRound = firstRoundWithTool(out, 'read_file');
      const grepRound = firstRoundWithTool(out, 'grep');
      const sequentialChain =
        listRound >= 0 &&
        readRound > listRound &&
        grepRound > readRound &&
        rounds >= 3;

      if (sequentialChain && rounds >= 4) {
        return pass('Sequential discovery chain across four or more rounds');
      }
      if (sequentialChain) return pass('Sequential list → read → grep chain');
      if (rounds >= 4) return pass('Four or more tool rounds');
      if (rounds >= 2) return partial('Short tool chain');
      if (rounds === 1 && callCount >= 4) {
        return partial('One batched round (parallel, not a sequential loop)');
      }
      if (callCount >= 2) return partial('Multiple tools but loop stopped early');
      return fail('Tool loop did not continue');
    },
  },
  'core-json-args': {
    kind: 'derived',
    maxToolRounds: 6,
    toolIds: ['grep', 'get_datetime'],
    verdict: (out) => {
      const calls = out.rounds.flatMap((r) => r.toolCalls);
      for (const call of calls) {
        const args = parseToolArgs(call);
        if (args === null) return fail(`Invalid JSON args for ${call.function.name}`);
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
            return partial(`Stringified object in ${call.function.name}.${key}`);
          }
        }
      }
      if (calls.length === 0) return fail('No tool calls to validate');
      return pass(`${calls.length} tool call(s) with well-formed JSON args`);
    },
  },
  'core-no-hallucinated-tools': {
    kind: 'derived',
    maxToolRounds: 4,
    toolIds: ['get_datetime', 'memory_save'],
    verdict: (out) => {
      const invented = hallucinatedToolNames(out);
      if (invented.length > 0) {
        return fail(`Invented tool name(s): ${invented.join(', ')}`);
      }
      if (out.toolCalls.length === 0) {
        return partial('Declined without calling any offered tool');
      }
      return pass('Stayed inside the offered tool catalog');
    },
  },
  'core-system-prompt': {
    kind: 'text',
    verdict: (out) => {
      const t = (out.contentText || out.text).trim();
      if (!t) return fail('Empty response');
      const words = t.replace(/[.]$/, '').split(/\s*,\s*/);
      const shapeOk = words.length === 3 && words.every((w) => /^[a-z]+$/.test(w));
      if (shapeOk) return pass('Followed the exact output shape');
      if (words.some((w) => /red|green|blue/i.test(w))) {
        return partial('Right answer, wrong output shape (preamble or formatting)');
      }
      return fail('Ignored the requested output shape');
    },
  },
  'core-long-context': {
    kind: 'text',
    verdict: (out) => {
      const t = (out.contentText || out.text).toLowerCase();
      if (t.includes(CAP_MATRIX_HAYSTACK_NEEDLE)) return pass('Recalled the buried needle');
      if (/truncat|too long|context (window|length|limit)|exceed/i.test(t)) {
        return partial('Model reported a context limit');
      }
      return fail('Did not recall the needle from a >32k-token prompt');
    },
  },
  'core-vision': {
    kind: 'delegated',
    suiteId: 'capability',
    testId: 'cap-multimodal',
    requires: ['vision'],
  },
  'core-reasoning': {
    kind: 'text',
    verdict: (out) => {
      const leaked = /<think>|<\/think>|\[thinking\]|◁think▷/i.test(out.contentText);
      const answered = /(^|\D)0?\.0?5\b|5 cents|five cents/i.test(out.contentText || out.text);
      if (leaked) return partial('Thinking markup leaked into the visible answer');
      if (!answered) return fail('Wrong answer on the reasoning trap question');
      if (out.reasoningText.trim()) return pass('Reasoning channel parsed and answer correct');
      return pass('Correct answer with no leaked thinking markup');
    },
  },
  'files-list-read': {
    kind: 'tool-chain',
    maxToolRounds: 8,
    toolIds: ['list_directory', 'read_file'],
    requires: ['workspace'],
    verdict: (out) => {
      const listed = hasTool(out.toolCalls, 'list_directory');
      const read = hasTool(out.toolCalls, 'read_file');
      if (listed && read) return pass('list_directory and read_file called');
      if (read) return partial('read_file without list_directory');
      return fail('Expected directory listing and read');
    },
  },
  'files-read-document': {
    kind: 'tool-call',
    toolIds: ['read_document'],
    requires: ['workspace'],
    verdict: (out) =>
      hasTool(out.toolCalls, 'read_document') ? pass('read_document called') : fail('No read_document call'),
  },
  'files-save-append': {
    kind: 'tool-chain',
    maxToolRounds: 8,
    toolIds: ['save_file', 'append_file'],
    requires: ['workspace'],
    verdict: (out) => {
      const saved = hasTool(out.toolCalls, 'save_file');
      const appended = hasTool(out.toolCalls, 'append_file');
      if (saved && appended) return pass('save_file and append_file called');
      if (saved) return partial('save_file without append');
      return fail('Expected save and append sequence');
    },
  },
  'files-replace-text': {
    kind: 'tool-chain',
    maxToolRounds: 10,
    toolIds: ['replace_text_in_file', 'save_file'],
    requires: ['workspace'],
    verdict: (out) => {
      const replaceRounds = out.rounds.filter((r) =>
        r.toolCalls.some((c) => c.function.name === 'replace_text_in_file'),
      ).length;
      const saveOnly = hasTool(out.toolCalls, 'save_file') && !hasTool(out.toolCalls, 'replace_text_in_file');
      if (replaceRounds === 1 && hasTool(out.toolCalls, 'replace_text_in_file')) {
        return pass('replace_text_in_file succeeded on first round');
      }
      if (replaceRounds >= 2 && replaceRounds <= 3) {
        return partial('replace_text_in_file needed multiple rounds');
      }
      if (saveOnly) return fail('Rewrote file with save_file instead of replace');
      return fail('No successful replace_text_in_file');
    },
  },
  'files-insert-range': {
    kind: 'tool-chain',
    maxToolRounds: 8,
    toolIds: ['read_file_range', 'insert_at_line'],
    requires: ['workspace'],
    verdict: (out) => {
      const range = hasTool(out.toolCalls, 'read_file_range');
      const insert = hasTool(out.toolCalls, 'insert_at_line');
      if (range && insert) return pass('read_file_range and insert_at_line called');
      return fail('Expected range read then insert');
    },
  },
  'files-grep': {
    kind: 'tool-call',
    toolIds: ['grep', 'find_files'],
    requires: ['workspace'],
    verdict: (out) =>
      hasTool(out.toolCalls, 'grep') || hasTool(out.toolCalls, 'find_files')
        ? pass('Search tool called')
        : fail('Expected grep or find_files'),
  },
  'docs-create-office': {
    kind: 'tool-call',
    toolIds: ['create_spreadsheet', 'create_pdf', 'create_word_document'],
    requires: ['workspace'],
    verdict: (out) => {
      const office = out.toolCalls.some((c) =>
        ['create_spreadsheet', 'create_pdf', 'create_word_document'].includes(c.function.name),
      );
      return office ? pass('Office document tool called') : fail('No document creation tool');
    },
  },
  'git-read': {
    kind: 'tool-call',
    toolIds: ['git_status', 'git_diff', 'git_log'],
    requires: ['workspace', 'git-fixture'],
    verdict: (out) => {
      const read = out.toolCalls.some((c) =>
        ['git_status', 'git_diff', 'git_log'].includes(c.function.name),
      );
      return read ? pass('Git read tool called') : fail('Expected git_status/diff/log');
    },
  },
  'git-write': {
    kind: 'tool-chain',
    maxToolRounds: 12,
    toolIds: ['git_add', 'git_commit', 'git_branch'],
    requires: ['workspace', 'git-fixture'],
    emitOnly: true,
    verdict: (out) => {
      const write = out.toolCalls.some((c) =>
        ['git_add', 'git_commit', 'git_branch'].includes(c.function.name),
      );
      return write ? pass('Git write tool emitted') : fail('Expected git add/commit/branch emit');
    },
  },
};
