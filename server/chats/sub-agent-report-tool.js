import { DEFAULT_REPORT_TOOL_NAME, resolveTurnTools } from '../runner/run-turn.js';
import { SUB_AGENT_COMPLETION_GUIDANCE } from '../sub-agents/reporting.js';

/** Keep delegated task completion distinct from the board reviewer verdict. */
export function withSubAgentReportTool(tools) {
  return resolveTurnTools(tools).map(tool => tool.function.name === DEFAULT_REPORT_TOOL_NAME ? {
    ...tool,
    function: { ...tool.function, description: `Report this sub-agent assignment's completion. ${SUB_AGENT_COMPLETION_GUIDANCE}`,
      parameters: { ...tool.function.parameters, properties: { ...tool.function.parameters.properties,
        outcome: { ...tool.function.parameters.properties.outcome, description: SUB_AGENT_COMPLETION_GUIDANCE },
      } },
    },
  } : tool);
}
