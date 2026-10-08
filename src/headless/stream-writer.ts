import type { TurnEvent } from '../../server/runner/run-turn.js';

/** Machine-readable stream keeps runner events separate from stderr diagnostics. */
export function createHeadlessJsonStreamWriter(write: (text: string) => void) {
  return (event: TurnEvent) => {
    // Timing samples are high-volume internal diagnostics, not transcript activity.
    if (event.type !== 'runner_timing') write(`${JSON.stringify(event)}\n`);
  };
}

/** Turn events contain cumulative text; emit each character once per round. */
export function createHeadlessStreamWriter(write: (text: string) => void) {
  let response = '', reasoning = '', section = '';
  function select(next: string) {
    if (section === next) return;
    write(`\n\n${next}:\n`); section = next;
  }
  return (event: TurnEvent) => {
    if (event.type === 'round_start') {
      response = ''; reasoning = ''; section = '';
      write(`\n\nAgent turn ${event.index + 1}\n`);
    } else if (event.type === 'delta' || event.type === 'thinking') {
      const previous = event.type === 'delta' ? response : reasoning;
      const delta = event.text.startsWith(previous) ? event.text.slice(previous.length) : event.text;
      if (delta) { select(event.type === 'delta' ? 'Response' : 'Thinking'); write(delta); }
      if (event.type === 'delta') response = event.text; else reasoning = event.text;
    } else if (event.type === 'loading_model') {
      select('Status'); write('Loading model…\n');
    } else if (event.type === 'tool_streaming') {
      select('Tools'); write(`Preparing ${event.name}…\n`);
    } else if (event.type === 'tool_call') {
      select('Tools');
      let target = '';
      try {
        const args = typeof event.arguments === 'string' ? JSON.parse(event.arguments) : event.arguments;
        if (args && typeof args.path === 'string') target = ` · ${args.path.slice(0, 200)}`;
      } catch {}
      write(`Running ${event.name}${target}\n`);
    } else if (event.type === 'tool_result') {
      select('Tools'); write(`${event.name}: ${event.isError || event.content.startsWith('Error:') ? 'failed' : 'finished'}\n`);
    } else if (event.type === 'response_restart') {
      response = ''; reasoning = ''; section = '';
      write(`\n\nResponse restarted: ${event.warning}\n`);
    } else if (event.type === 'round_end') {
      if (event.text !== response && event.text.startsWith(response)) {
        select('Response'); write(event.text.slice(response.length)); response = event.text;
      }
      write('\n');
    }
  };
}
