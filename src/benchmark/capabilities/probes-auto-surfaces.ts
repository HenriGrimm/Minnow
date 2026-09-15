/**
 * Auto probe specs for rows that used to be manual — browser, sub-agents,
 * recall, and other app surfaces.
 *
 * These rows were marked manual because *executing* them needs the Electron browser
 * pane, a live orchestration session, or a connected mailbox. The matrix scores the
 * **model**, though, so each row runs as an emit-only probe: the tools are offered for
 * real and stubbed on execution (see `execute-tool.ts`), and the verdict reads which
 * tools the model reached for and whether it used the ids the stub handed back.
 */

import {
  argsTextFor,
  fail,
  hasAnyTool,
  hasTool,
  partial,
  pass,
  usedStubUid,
} from './probe-helpers.ts';
import {
  CAP_STUB_SNAPSHOT_UIDS,
  CAP_STUB_SUB_AGENT_ID,
} from './stub-fixtures.ts';
import type { CapabilityProbeRunOutput, CapabilityProbeSpec } from './types.ts';

/** True when any call to `name` quoted one of the ids the stub handed back. */
function usedStubId(
  out: CapabilityProbeRunOutput,
  name: string,
  ids: readonly string[],
): boolean {
  const args = argsTextFor(out, name);
  return ids.some((id) => args.includes(id));
}

export const SURFACE_PROBES: Record<string, CapabilityProbeSpec> = {
  'browser-navigate': {
    kind: 'tool-chain',
    maxToolRounds: 8,
    toolIds: [
      'browser_new_tab',
      'browser_navigate',
      'browser_list',
      'browser_switch_tab',
      'browser_close_tab',
    ],
    emitOnly: true,
    verdict: (out) => {
      const opened = hasAnyTool(out.toolCalls, ['browser_new_tab', 'browser_navigate']);
      const listed = hasTool(out.toolCalls, 'browser_list');
      const addressed = /example\.com/i.test(
        `${argsTextFor(out, 'browser_navigate')} ${argsTextFor(out, 'browser_new_tab')}`,
      );
      if (opened && listed && addressed) return pass('Opened the requested URL, then listed tabs');
      if (opened && listed) return partial('Opened a tab and listed, but not the requested URL');
      if (opened) return partial('Opened a tab without listing them');
      return fail('No browser navigation tools called');
    },
  },
  'browser-snapshot': {
    kind: 'tool-chain',
    maxToolRounds: 10,
    toolIds: ['browser_snapshot', 'browser_fill', 'browser_click'],
    emitOnly: true,
    verdict: (out) => {
      if (!hasTool(out.toolCalls, 'browser_snapshot')) {
        return hasAnyTool(out.toolCalls, ['browser_fill', 'browser_click'])
          ? fail('Clicked or filled without snapshotting for refs first')
          : fail('No browser snapshot tools called');
      }
      const acted = hasAnyTool(out.toolCalls, ['browser_fill', 'browser_click']);
      if (!acted) return partial('Snapshotted but never acted on the page');
      const uidOk =
        usedStubUid(out, 'browser_fill', CAP_STUB_SNAPSHOT_UIDS) ||
        usedStubUid(out, 'browser_click', CAP_STUB_SNAPSHOT_UIDS);
      return uidOk
        ? pass('Snapshotted, then acted on the uids it returned')
        : partial('Acted on the page without the uids the snapshot returned');
    },
  },
  'browser-eval': {
    kind: 'tool-chain',
    maxToolRounds: 8,
    toolIds: ['browser_screenshot', 'browser_eval'],
    emitOnly: true,
    verdict: (out) => {
      const shot = hasTool(out.toolCalls, 'browser_screenshot');
      const evaluated = hasTool(out.toolCalls, 'browser_eval');
      if (shot && evaluated) return pass('Screenshot plus eval for the computed style');
      if (evaluated) return partial('Evaluated the page without a screenshot');
      if (shot) return partial('Screenshot only — no computed style read');
      return fail('No screenshot or eval call');
    },
  },

  'agents-sub-agent-control': {
    kind: 'tool-chain',
    maxToolRounds: 8,
    toolIds: ['list_sub_agents', 'get_sub_agent_status', 'cancel_sub_agent'],
    emitOnly: true,
    verdict: (out) => {
      const listed = hasAnyTool(out.toolCalls, ['list_sub_agents', 'get_sub_agent_status']);
      const cancelled = hasTool(out.toolCalls, 'cancel_sub_agent');
      if (!listed && !cancelled) return fail('No sub-agent tools called');
      if (listed && cancelled) {
        return usedStubId(out, 'cancel_sub_agent', [CAP_STUB_SUB_AGENT_ID])
          ? pass('Listed sub-agents, then cancelled the one that was running')
          : partial('Cancelled without using the id the listing returned');
      }
      if (listed) return partial('Inspected sub-agents but never cancelled');
      return partial('Cancelled without checking what was running');
    },
  },

  'knowledge-recall': {
    kind: 'tool-call',
    maxToolRounds: 6,
    toolIds: ['recall_history'],
    emitOnly: true,
    verdict: (out) => {
      if (hasAnyTool(out.toolCalls, ['recall_history'])) {
        return pass('Looked the earlier turn up instead of guessing');
      }
      return /don'?t (have|recall)|no (record|history)|cannot (find|recall)/i.test(
        out.contentText || out.text,
      )
        ? partial('Admitted it could not recall, but never called a recall tool')
        : fail('Answered from thin air without calling a recall tool');
    },
  },
};
