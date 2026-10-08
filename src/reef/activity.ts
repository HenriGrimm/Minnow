import type { ReefAgentTool, ReefRun, ReefRunState } from './types';

export interface ReefActivity {
  /** Short stage name, announced to screen readers when it changes. */
  stage: string;
  /** What the agent is doing right now, in plain words. */
  headline: string;
  /** The model's latest words, a command, or the last log line. */
  detail: string;
  /** Basenames of files written or edited, oldest first. */
  files: string[];
  tools: number;
}

const STAGE_NAMES: Partial<Record<ReefRunState, string>> = {
  queued: 'In line', scaffolding: 'Setting up', planning: 'Planning', building: 'Building', repairing: 'Fixing',
  installing: 'Installing', checking: 'Testing', promoting: 'Saving',
};
const STAGE_HEADLINES: Partial<Record<ReefRunState, string>> = {
  queued: 'Waiting for the current build', scaffolding: 'Preparing the project', planning: 'Sketching the plan',
  building: 'Writing your app', repairing: 'Fixing what broke', installing: 'Installing packages',
  checking: 'Testing your app', promoting: 'Saving this version',
};
const SNAGS: Partial<Record<ReefRunState, string>> = {
  planning: 'Planning hit a snag', building: 'Writing hit a snag', repairing: 'The fix didn’t hold',
  installing: 'Packages wouldn’t install', checking: 'Your app didn’t pass its checks', promoting: 'Saving hit a snag',
};
const WRITES = new Set(['save_file', 'append_file', 'insert_at_line']);
const EDITS = new Set(['replace_text_in_file']);
const MUTATIONS = new Set([...WRITES, ...EDITS, 'move_file', 'delete_path']);
const LOOKS = new Set(['list_directory', 'glob', 'grep', 'search_files', 'find_files', 'repo_map', 'code_search']);

const findLast = <T>(items: T[] | undefined, match: (item: T) => boolean) => {
  for (let index = (items?.length ?? 0) - 1; index >= 0; index--) if (match(items![index])) return items![index];
  return undefined;
};
const basename = (path: unknown) => typeof path === 'string' ? path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path : '';

/** Strip markdown and ANSI noise, then keep the tail from a word boundary. */
export function tailText(text: string, max = 120) {
  const plain = text.replace(/\u001b\[[0-9;]*[A-Za-z]|␛\[[0-9;]*[A-Za-z]/g, '').replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[`*_#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(-max), space = cut.indexOf(' ');
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`;
}

function lastLine(log: string) {
  const lines = log.split(/\r?\n/).map(line => tailText(line, 120)).filter(Boolean);
  return lines.at(-1) ?? '';
}

function describeTool(tool: ReefAgentTool) {
  const file = basename(tool.args.path);
  if (WRITES.has(tool.name)) return { headline: file ? `Writing ${file}` : 'Writing a file', detail: '' };
  if (EDITS.has(tool.name)) return { headline: file ? `Editing ${file}` : 'Editing a file', detail: '' };
  if (tool.name === 'read_file' || tool.name === 'read_files') return { headline: file ? `Reading ${file}` : 'Reading the code', detail: '' };
  if (tool.name === 'move_file') return { headline: file ? `Moving ${file}` : 'Moving a file', detail: '' };
  if (tool.name === 'delete_path') return { headline: file ? `Tidying up ${file}` : 'Tidying up', detail: '' };
  if (tool.name === 'execute_command' || tool.name === 'start_background_command') {
    return { headline: 'Running a command', detail: typeof tool.args.command === 'string' ? tailText(tool.args.command, 90) : '' };
  }
  if (LOOKS.has(tool.name)) return { headline: 'Looking around the project', detail: '' };
  return { headline: `Using ${tool.name.replace(/_/g, ' ')}`, detail: '' };
}

/** While a round streams, hold back the word still being typed so the caption reads in whole words. */
const spoken = (text: string, complete?: boolean) => complete ? text : text.replace(/\S+$/, '');

/** Plain-language summary of a run for the build view. Pure, so it is cheap to call per snapshot. */
export function describeReefActivity(run: ReefRun | undefined): ReefActivity {
  const files: string[] = [];
  let tools = 0;
  for (const session of run?.agentSessions ?? []) for (const round of session.rounds) for (const tool of round.tools) {
    tools++;
    const file = MUTATIONS.has(tool.name) ? basename(tool.args.path) : '';
    if (file) { const seen = files.indexOf(file); if (seen >= 0) files.splice(seen, 1); files.push(file); }
  }
  const base = { files, tools };
  const state = run?.state ?? 'queued';
  if (state === 'ready') return { ...base, stage: 'Done', headline: 'Your app is ready', detail: 'Run it from the top, or ask for a change.' };
  if (state === 'cancelled') return { ...base, stage: 'Cancelled', headline: 'Build cancelled', detail: 'Resume to pick up where it stopped.' };
  if (state === 'interrupted') return { ...base, stage: 'Paused', headline: 'Build paused', detail: 'Resume to pick up where it stopped.' };
  if (state === 'failed') {
    const stage = run?.failedStage ?? 'building';
    return { ...base, stage: `Stopped while ${(STAGE_NAMES[stage] ?? 'building').toLowerCase()}`, headline: SNAGS[stage] ?? 'This build hit a snag', detail: 'Retry and the agent picks up from the saved work.' };
  }
  const stage = STAGE_NAMES[state] ?? 'Working';
  const fallback = { ...base, stage, headline: STAGE_HEADLINES[state] ?? 'Working', detail: run?.log ? lastLine(run.log) : '' };
  if (!['planning', 'building', 'repairing'].includes(state)) return fallback;
  const session = findLast(run?.agentSessions, item => item.state === 'running');
  const round = session?.rounds.at(-1);
  if (!session || !round) return { ...fallback, detail: '' };
  if (session.activity === 'loading') return { ...base, stage, headline: 'Waking the model', detail: '' };
  if (session.activity === 'thinking') return { ...base, stage, headline: 'Thinking it through', detail: tailText(spoken(round.reasoning, round.complete)) };
  if (session.activity === 'tools') {
    const tool = findLast(round.tools, item => item.result === undefined) ?? round.tools.at(-1);
    if (tool) return { ...base, stage, ...describeTool(tool) };
    return { ...base, stage, headline: session.currentTool ? `Using ${session.currentTool.replace(/_/g, ' ')}` : 'Getting to work', detail: '' };
  }
  return { ...base, stage, headline: session.phase === 'plan' ? 'Sketching the plan' : state === 'repairing' ? 'Working out the fix' : 'Working it out', detail: tailText(spoken(round.text || round.reasoning, round.complete)) };
}
