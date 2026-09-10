/** Schemas for server-run agents. User-preview tools stay in the renderer. */
const surface = { type: 'string', enum: ['agent'], description: 'Use the isolated agent browser.' };
const tabId = { type: 'string', description: 'Owned tab_id returned by browser_reserve_tab. Never guess an id.' };
const url = { type: 'string', description: 'Absolute HTTP(S) URL; the browser origin allowlist still applies.' };
const target = { surface, tab_id: tabId };

function definition(name, description, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

const reserveProperties = {
  surface, url,
  width: { type: 'integer', minimum: 200, maximum: 4000, description: 'Viewport width in CSS pixels; default 1440.' },
  height: { type: 'integer', minimum: 200, maximum: 4000, description: 'Viewport height in CSS pixels; default 900.' },
};

export const AGENT_BROWSER_TOOL_DEFINITIONS = Object.freeze([
  definition('browser_reserve_tab', 'Reserve a private browser tab before browsing. Pass its tab_id to every later call. The browser works without a visible window.', reserveProperties),
  definition('browser_release_tab', 'Release an owned tab, leaving it open for user inspection or reassignment.', target, ['tab_id']),
  definition('browser_list', 'List only browser tabs assigned to this agent. Other agents and the user have independent tabs.', { surface }),
  definition('browser_navigate', 'Navigate an owned tab to an allowlisted URL. Reserve a tab first. External blocked origins require user approval; unattended agents cannot grant access.', { ...target, url }, ['tab_id', 'url']),
  definition('browser_new_tab', 'Create and reserve another private tab, like browser_reserve_tab.', reserveProperties),
  definition('browser_switch_tab', 'Inspect the selected owned tab. Does not switch the user’s viewer; all calls still require tab_id.', target, ['tab_id']),
  definition('browser_close_tab', 'Close an owned agent tab and release its browser resources.', target, ['tab_id']),
  definition('browser_snapshot', 'Read the owned page and actionable element uids. Refresh after navigation or interaction before using a uid.', target, ['tab_id']),
  definition('browser_click', 'Click an element from the latest snapshot of this owned tab.', { ...target, uid: { type: 'integer', minimum: 1 } }, ['tab_id', 'uid']),
  definition('browser_fill', 'Fill an element from the latest snapshot of this owned tab.', {
    ...target, uid: { type: 'integer', minimum: 1 }, value: { type: 'string' },
    clear: { type: 'boolean', description: 'Replace existing text; defaults to true.' },
    submit: { type: 'boolean', description: 'Press Enter after filling; defaults to false.' },
  }, ['tab_id', 'uid', 'value']),
  definition('browser_eval', 'Evaluate JavaScript in this owned page. Page access and user control restrictions still apply.', { ...target, expression: { type: 'string' } }, ['tab_id', 'expression']),
  definition('browser_screenshot', 'Capture the full viewport of this owned tab. Returns an image attachment, even with the viewer closed.', target, ['tab_id']),
]);

export const AGENT_BROWSER_TOOL_IDS = Object.freeze(AGENT_BROWSER_TOOL_DEFINITIONS.map((tool) => tool.function.name));
const definitions = new Map(AGENT_BROWSER_TOOL_DEFINITIONS.map((tool) => [tool.function.name, tool]));

/** Return a fresh schema so a caller cannot mutate other agents' definitions. */
export function agentBrowserToolDefinition(name) {
  const value = definitions.get(name);
  return value ? structuredClone(value) : null;
}
