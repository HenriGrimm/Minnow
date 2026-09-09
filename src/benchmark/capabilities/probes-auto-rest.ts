/**
 * Auto probe specs — code, web, agents, knowledge, apps, features.
 */

import {
  argsTextFor,
  fail,
  firstRoundWithTool,
  hasAnyTool,
  hasTool,
  partial,
  pass,
} from './probe-helpers.ts';
import { CAP_MATRIX_MEAN_EXPECTED } from './probe-prompts.ts';
import type { CapabilityProbeSpec } from './types.ts';

export const REMAINING_AUTO_PROBES: Record<string, CapabilityProbeSpec> = {
  'code-execute-command': {
    kind: 'tool-call',
    toolIds: ['execute_command'],
    requires: ['workspace', 'tool-server'],
    verdict: (out) => {
      if (!hasTool(out.toolCalls, 'execute_command')) return fail('No execute_command');
      if (out.executedResults.some((r) => r.includes('63'))) {
        return pass('execute_command ran and returned the expected output');
      }
      return partial('execute_command called but 63 never came back');
    },
  },
  'code-background-cmds': {
    kind: 'tool-chain',
    maxToolRounds: 10,
    toolIds: [
      'start_background_command',
      'stop_background_command',
      'list_running_commands',
      'read_command_log',
      'execute_command',
    ],
    requires: ['workspace', 'tool-server'],
    verdict: (out) => {
      const started =
        hasTool(out.toolCalls, 'start_background_command') ||
        /"background"\s*:\s*true/.test(argsTextFor(out, 'execute_command'));
      const stopped =
        hasTool(out.toolCalls, 'stop_background_command') ||
        /"stop"\s*:\s*true/.test(argsTextFor(out, 'execute_command'));
      if (started && stopped) return pass('Background run started and stopped');
      if (started) return partial('Started a background run but never stopped it');
      if (hasTool(out.toolCalls, 'execute_command')) {
        return partial('Ran in the foreground instead of detaching');
      }
      return fail('No background command tools called');
    },
  },
  'code-run-js-py': {
    kind: 'tool-call',
    toolIds: ['run_python', 'run_javascript'],
    requires: ['workspace', 'tool-server'],
    verdict: (out) => {
      if (!hasAnyTool(out.toolCalls, ['run_python', 'run_javascript'])) {
        return fail('Expected run_python/javascript');
      }
      if (out.executedResults.some((r) => r.includes(CAP_MATRIX_MEAN_EXPECTED))) {
        return pass('Interpreter ran and returned the expected mean');
      }
      return partial(`Interpreter called but ${CAP_MATRIX_MEAN_EXPECTED} never came back`);
    },
  },
  'code-command-log': {
    kind: 'tool-chain',
    maxToolRounds: 10,
    toolIds: [
      'start_background_command',
      'read_command_log',
      'list_running_commands',
      'stop_background_command',
      'stop_command',
    ],
    requires: ['workspace', 'tool-server'],
    verdict: (out) => {
      const log = hasTool(out.toolCalls, 'read_command_log');
      const stop = hasAnyTool(out.toolCalls, ['stop_command', 'stop_background_command']);
      if (log && stop) return pass('Read the command log, then stopped the run');
      if (log) return partial('Read the command log but never stopped the run');
      if (hasTool(out.toolCalls, 'list_running_commands')) {
        return partial('Listed running commands without reading the log');
      }
      return fail('Expected command log tools');
    },
  },
  'code-repo-intel': {
    kind: 'tool-call',
    toolIds: ['repo_map', 'find_symbol'],
    requires: ['workspace'],
    verdict: (out) =>
      hasTool(out.toolCalls, 'repo_map') || hasTool(out.toolCalls, 'find_symbol')
        ? pass('Code intel tool called')
        : fail('Expected repo_map or find_symbol'),
  },
  'lsp-diagnostics': {
    kind: 'tool-call',
    toolIds: ['get_lsp_diagnostics'],
    requires: ['lsp'],
    verdict: (out) =>
      hasTool(out.toolCalls, 'get_lsp_diagnostics')
        ? pass('LSP tool called')
        : fail('Expected LSP diagnostics tool'),
  },
  'web-search': {
    kind: 'tool-call',
    toolIds: ['web_search'],
    emitOnly: true,
    verdict: (out) =>
      hasTool(out.toolCalls, 'web_search') ? pass('web_search emitted') : fail('No web_search emit'),
  },
  'web-fetch': {
    kind: 'tool-call',
    toolIds: ['fetch_web_content', 'rag_web_content'],
    emitOnly: true,
    verdict: (out) =>
      hasTool(out.toolCalls, 'fetch_web_content') || hasTool(out.toolCalls, 'rag_web_content')
        ? pass('Fetch tool emitted')
        : fail('No fetch_web_content emit'),
  },
  'web-wikipedia': {
    kind: 'tool-call',
    toolIds: ['wikipedia_search'],
    emitOnly: true,
    verdict: (out) =>
      hasTool(out.toolCalls, 'wikipedia_search') ? pass('wikipedia_search emitted') : fail('No wikipedia_search'),
  },
  'agents-todo-write': {
    kind: 'derived',
    maxToolRounds: 12,
    toolIds: ['todo_write', 'list_directory', 'read_file', 'get_datetime'],
    verdict: (out) => {
      const rounds = out.rounds.filter((r) =>
        r.toolCalls.some((c) => c.function.name === 'todo_write'),
      ).length;
      if (rounds >= 2) return pass('todo_write updated across rounds');
      if (rounds === 1) return partial('Wrote the list once and never updated it');
      return fail('No todo_write calls');
    },
  },
  'agents-spawn-sub-agent': {
    kind: 'tool-call',
    toolIds: ['spawn_sub_agent'],
    emitOnly: true,
    verdict: (out) =>
      hasTool(out.toolCalls, 'spawn_sub_agent') ? pass('spawn_sub_agent emitted') : fail('No spawn_sub_agent'),
  },
  'agents-issue-tools': {
    kind: 'tool-chain',
    maxToolRounds: 6,
    toolIds: ['issue_add', 'issue_update', 'issue_link', 'issue_get_state'],
    emitOnly: true,
    verdict: (out) => {
      const added = hasTool(out.toolCalls, 'issue_add');
      const linked = hasTool(out.toolCalls, 'issue_link');
      if (added && linked) return pass('Filed an issue and linked it');
      if (added) return partial('Filed an issue but never linked it');
      if (hasAnyTool(out.toolCalls, ['issue_update', 'issue_get_state'])) {
        return partial('Touched issue tools without filing one');
      }
      return fail('No issue_* emit');
    },
  },
  'agents-issue-tools-v2': {
    kind: 'tool-chain',
    maxToolRounds: 6,
    toolIds: ['issue_search', 'issue_comment', 'issue_assign', 'issue_unlink', 'issue_move'],
    emitOnly: true,
    verdict: (out) => {
      const searched = hasTool(out.toolCalls, 'issue_search');
      const commented = hasTool(out.toolCalls, 'issue_comment');
      if (searched && commented) return pass('Searched issues and commented');
      if (searched) return partial('Searched issues but never commented');
      if (hasAnyTool(out.toolCalls, ['issue_assign', 'issue_unlink', 'issue_move'])) {
        return partial('Used v2 issue tools without search');
      }
      return fail('No issue v2 emit');
    },
  },
  'knowledge-brain-read': {
    kind: 'tool-call',
    toolIds: ['brain_search', 'brain_read_page', 'brain_list'],
    emitOnly: true,
    verdict: (out) =>
      hasAnyTool(out.toolCalls, ['brain_search', 'brain_read_page', 'brain_list'])
        ? pass('Brain read tool emitted')
        : fail('No brain read tool'),
  },
  'knowledge-brain-write': {
    kind: 'tool-call',
    toolIds: ['brain_write_page', 'brain_append_log', 'brain_ingest_source'],
    emitOnly: true,
    verdict: (out) =>
      hasAnyTool(out.toolCalls, ['brain_write_page', 'brain_append_log', 'brain_ingest_source'])
        ? pass('Brain write tool emitted')
        : fail('No brain write tool'),
  },
  'knowledge-minnow-docs': {
    kind: 'tool-call',
    toolIds: ['minnow_docs_search', 'minnow_docs_read'],
    emitOnly: true,
    verdict: (out) => {
      const docs = out.toolCalls.some((c) => c.function.name.startsWith('minnow_docs_'));
      return docs ? pass('minnow_docs_* emitted') : fail('No minnow_docs tool');
    },
  },
  'knowledge-save-memory': {
    kind: 'tool-call',
    toolIds: ['save_memory'],
    emitOnly: true,
    verdict: (out) =>
      hasTool(out.toolCalls, 'save_memory') ? pass('save_memory emitted') : fail('No save_memory'),
  },
  'apps-settings-appearance': {
    kind: 'tool-call',
    toolIds: ['update_settings', 'update_appearance'],
    emitOnly: true,
    verdict: (out) => {
      const settings = hasTool(out.toolCalls, 'update_settings') || hasTool(out.toolCalls, 'update_appearance');
      return settings ? pass('Settings/appearance tool emitted') : fail('No settings tool emit');
    },
  },
  'mode-set-chat-mode': {
    kind: 'tool-call',
    toolIds: ['set_chat_mode', 'propose_mode_switch'],
    emitOnly: true,
    verdict: (out) =>
      hasTool(out.toolCalls, 'set_chat_mode') || hasTool(out.toolCalls, 'propose_mode_switch')
        ? pass('Mode switch tool emitted')
        : fail('No mode switch emit'),
  },
  'mode-create-chat': {
    kind: 'tool-call',
    toolIds: ['create_chat_with_mode', 'launch_minnow_app'],
    emitOnly: true,
    verdict: (out) => {
      const launch =
        hasTool(out.toolCalls, 'create_chat_with_mode') || hasTool(out.toolCalls, 'launch_minnow_app');
      return launch ? pass('Chat/app launch tool emitted') : fail('No create_chat/launch emit');
    },
  },
  'mode-impeccable': {
    kind: 'derived',
    maxToolRounds: 8,
    toolIds: ['load_impeccable_context', 'load_aesthetics_reference', 'run_impeccable'],
    trapToolIds: ['save_file', 'replace_text_in_file'],
    verdict: (out) => {
      const loadRound = firstRoundWithTool(out, 'load_impeccable_context');
      const editRound = out.rounds.findIndex((r) =>
        r.toolCalls.some((c) => ['save_file', 'replace_text_in_file'].includes(c.function.name)),
      );
      if (loadRound >= 0 && (editRound < 0 || loadRound <= editRound)) {
        return pass('Loaded Impeccable context before editing');
      }
      if (loadRound >= 0) return partial('Loaded Impeccable context after starting edits');
      if (hasAnyTool(out.toolCalls, ['load_aesthetics_reference', 'run_impeccable'])) {
        return partial('Used an Impeccable tool but never loaded the context');
      }
      if (out.text.toLowerCase().includes('impeccable')) {
        return partial('Mentioned Impeccable without loading it');
      }
      return fail('No Impeccable context signal');
    },
  },
  'features-chat-title': {
    kind: 'text',
    verdict: (out) => {
      const t = (out.contentText || out.text).trim();
      if (!t) return fail('Empty title');
      if (t.startsWith('{') || t.includes('```')) return fail('Title looks like JSON or fence');
      if (/^(sure|here|certainly|title:)/i.test(t)) return partial('Title carries a preamble');
      if (t.length > 120 || t.includes('\n')) return partial('Long or multi-line chat title');
      return pass('Sensible title shape');
    },
  },
  'features-skills': {
    kind: 'delegated',
    suiteId: 'skills',
    testId: 'skill-impeccable',
  },
  'features-markdown': {
    kind: 'text',
    verdict: (out) => {
      const t = out.contentText || out.text;
      const fences = (t.match(/```/g) ?? []).length;
      if (fences === 0) return fail('No code fence in a snippet answer');
      if (fences % 2 !== 0) return fail('Unclosed code fence');
      const tagged = /```(ts|typescript|js|javascript)/i.test(t);
      const table = /\|[^\n]*\|/.test(t) && /\|\s*-{3,}/.test(t);
      if (tagged && table) return pass('Tagged fences and a well-formed table');
      if (tagged) return partial('Tagged fences but no well-formed table');
      return partial('Fences without language tags');
    },
  },
};
