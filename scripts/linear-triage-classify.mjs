import fs from 'fs';
import path from 'path';

const AGENT_TOOLS = path.join(
  process.env.USERPROFILE ?? '',
  '.cursor/projects/c-Users-dukky-Documents-Development-Minnow/agent-tools',
);

const files = [
  '0bd4a1f3-7231-4fe6-9ab8-58137f90b2e1.txt',
  'df3f5b70-c47f-4b56-8933-9e6b9fa92920.txt',
].map((f) => path.join(AGENT_TOOLS, f));

const VALID_LABELS = new Set([
  'Bug',
  'Feature',
  'Improvement',
  'chat',
  'orchestrate',
  'editor',
  'browser',
  'files',
  'tools',
  'modes',
  'plan',
  'skills',
  'streaming',
  'onboarding',
  'benchmark',
  'bug-tracker',
  'Source Control',
  'polish',
]);

function text(issue) {
  return `${issue.title} ${issue.description ?? ''}`.toLowerCase();
}

function hasAny(t, words) {
  return words.some((w) => t.includes(w));
}

// ── Classify type ────────────────────────────────────────────────────────────

function classifyType(t, title) {
  const bugWords = [
    'broken',
    ' bug',
    'bug ',
    'fix two',
    'fix ',
    ' error',
    'crash',
    'wont',
    "won't",
    "can't",
    'cant ',
    'does not',
    'do not stop',
    'failed',
    'failure',
    'not working',
    'no working',
    'disapear',
    'blows up',
    'loop indefinitely',
    'not open',
    'not load',
    'not show',
    'not start',
    'not stop',
    'bounces',
    'snaps',
    'snapping',
    'hidden',
    'blocking input',
    'overload',
    'upstream http',
  ];
  const featureWords = [
    'add ',
    'new ',
    'build out',
    'build ',
    'implement',
    'integration',
    ' app',
    'dashboard',
    'system',
    'epic',
    'world-class',
    'session engine',
    'multi-model',
    'determinism',
    'linear support',
    'task tracking',
    'onboarding system',
    'multiple editor',
    'dev tools',
    'todo list',
    'questionnaire',
    'build spec',
    'clean worktrees',
    'autopilot settings',
    'finish dashboard',
    'code app overview',
    'expose ',
    'full git',
    'full linear',
    'phase 0',
    'phase 1',
    'phase 2',
    'phase 3',
    'phase 4',
    'phase 5',
    'phase 6',
    'phase 7',
    'min-b',
    'studio ',
  ];

  if (hasAny(t, bugWords) && !title.startsWith('phase ') && !lt.includes('ui improvements')) return 'Bug';
  if (title.startsWith('Phase ') || title.startsWith('MIN-B') || title.includes('Studio ') || hasAny(t, featureWords)) {
    return 'Feature';
  }
  if (lt === 'ui improvements' || lt.includes('orchestrator bugs') || lt.includes('console improvements')) {
    return 'Improvement';
  }
  if (hasAny(t, ['improve', 'polish', 'enhance', 'rework', 'overhaul', 'trim', 'scope', 'better', 'upgrade', 'umbrella'])) {
    return 'Improvement';
  }
  return 'Improvement';
}

// ── Classify areas ───────────────────────────────────────────────────────────

function classifyAreas(t, title) {
  const areas = [];
  const lt = title.toLowerCase();

  if (lt.includes('studio')) {
    return ['browser', 'editor', 'polish'];
  }
  if (lt.includes('brain') || lt.includes('min-b')) {
    return ['tools'];
  }
  if (lt.includes('open workspace') || lt.includes('onboarding') || lt.includes('first open')) {
    return ['onboarding'];
  }
  if (lt.includes('email') || lt.includes('calendar') || lt.includes('scheduler') || lt.includes('productivity')) {
    return ['tools'];
  }
  if (lt.includes('voice') || lt.includes('tts') || lt.includes('stt')) {
    return ['tools'];
  }
  if (lt.includes('model') || lt.includes('provider') || lt.includes('llama') || lt.includes('embedding')) {
    return ['streaming'];
  }
  if (lt.includes('settings')) {
    return ['polish'];
  }
  if (lt.includes('expert')) {
    return ['modes'];
  }
  if (lt.includes('research')) {
    return ['modes'];
  }
  if (lt.includes('console') || lt.includes('terminal') || lt.includes('shell') || lt.includes('dev server')) {
    return ['files', 'tools'];
  }
  if (lt.includes('git ') || lt.startsWith('git') || lt.includes('worktree') || lt.includes('.gitignore')) {
    return ['Source Control'];
  }

  const rules = [
    ['orchestrate', ['orchestrator', 'orchestrate', 'board', 'kanban', 'autopilot', 'task card', 'wave', 'quarantine', 'merge-fixer', 'integration branch', 'sub-agent', 'subagent']],
    ['chat', ['chat', 'composer', 'message', 'steering', 'queue', 'replay', 'slash', 'thinking display', 'hub', 'desktop chat', 'notification']],
    ['editor', ['editor', 'codemirror', 'autocomplete', 'quick edit', 'unsaved', 'file viewer', 'inline intent']],
    ['browser', ['browser', 'preview', 'devtools', 'webcontents', 'html', 'in-app browser']],
    ['files', ['file explorer', 'file tree', 'terminal', 'scope terminal', 'scope file']],
    ['Source Control', ['commit message', 'git diff', 'git-setup', 'source control']],
    ['tools', ['tool call', 'parallel tool', 'save_file', 'write_file', 'lsp', 'tool schema', 'tool turn', 'max tool', 'grep context']],
    ['modes', ['mode switch', 'mode icon', 'general mode', 'plan mode', 'debug mode', 'build mode']],
    ['plan', ['planning', 'questionnaire', 'build spec', 'super plan']],
    ['skills', ['skill', 'impeccable', 'handoff', 'matt pocock', 'git-commit', '/command', 'slash command']],
    ['streaming', ['streaming', 'sse', 'token estim', 'context window', 'anthropic', 'kimi', 'minimax', 'glm']],
    ['onboarding', ['onboarding', 'first-run', 'first open', 'setup system', 'searxng', 'electron launch', 'install process']],
    ['benchmark', ['benchmark', 'swe-bench', 'bench app', 'evals']],
    ['bug-tracker', ['bug tracker', 'bug reporting']],
    ['polish', ['light mode', 'font issue', 'scroll', 'selecting text', 'ui improvement', 'hard to read', 'hard to see', 'minimize window']],
  ];

  for (const [label, words] of rules) {
    if (hasAny(t, words) || hasAny(lt, words)) areas.push(label);
  }

  const priorityOrder = [
    'benchmark',
    'bug-tracker',
    'onboarding',
    'plan',
    'skills',
    'orchestrate',
    'browser',
    'editor',
    'files',
    'Source Control',
    'tools',
    'streaming',
    'modes',
    'chat',
    'polish',
  ];
  const picked = [];
  for (const label of priorityOrder) {
    if (areas.includes(label)) picked.push(label);
  }
  if (picked.length === 0) {
    if (lt.includes('orchestr')) picked.push('orchestrate');
    else if (lt.includes('chat')) picked.push('chat');
    else picked.push('polish');
  }
  return picked.slice(0, 3);
}

// ── Classify priority ────────────────────────────────────────────────────────

function classifyPriority(issue, type, areas) {
  const status = issue.status;
  const t = text(issue);
  const title = issue.title.toLowerCase();

  if (status === 'Canceled' || status === 'Duplicate') return 4;
  if (status === 'Done') return 4;

  const urgentWords = [
    'security hardening',
    'loop indefinitely',
    'random crash',
    'board is broken',
    'does nothing',
    'not stop chats',
    'mass-quarantine',
    'p0 security',
    'email security',
    'data loss',
  ];
  const highWords = [
    'session engine',
    'in progress',
    'self-healing afk',
    'sqlite mail',
    'settings page rebuild',
    'file viewer broken',
    'autocomplete and quick edit',
    'stop orchestrator',
    'provider error',
    'upstream http',
  ];

  let base = 3;
  if (hasAny(t, urgentWords)) base = 1;
  else if (status === 'In Progress' || status === 'Todo') base = 2;
  else if (hasAny(t, highWords)) base = 2;
  else if (type === 'Bug') base = 2;
  else if (title.startsWith('phase ') || title.startsWith('min-b')) base = 3;
  else if (areas.includes('polish') && type === 'Improvement') base = 4;

  return base;
}

// ── Apply ────────────────────────────────────────────────────────────────────

function mergeLabels(existing, type, areas) {
  const out = new Set();
  for (const l of existing ?? []) {
    const name = typeof l === 'string' ? l : l.name;
    if (VALID_LABELS.has(name) && !['Bug', 'Feature', 'Improvement'].includes(name)) {
      out.add(name);
    }
  }
  out.add(type);
  for (const a of areas) out.add(a);
  return [...out].sort();
}

let all = [];
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error('missing', f);
    continue;
  }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  all = all.concat(d.issues ?? []);
}

const byId = new Map();
for (const i of all) byId.set(i.id, i);
all = [...byId.values()];

const updates = all.map((issue) => {
  const t = text(issue);
  const type = classifyType(t, issue.title.toLowerCase());
  const areas = classifyAreas(t, issue.title.toLowerCase());
  const priority = classifyPriority(issue, type, areas);
  const existingLabels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  const labels = mergeLabels(existingLabels, type, areas);
  const existingPri = issue.priority?.value ?? 0;
  const needsPri = existingPri === 0 || (issue.status !== 'Done' && existingPri !== priority);
  const needsLabels =
    existingLabels.length === 0 ||
    !existingLabels.some((l) => ['Bug', 'Feature', 'Improvement'].includes(l)) ||
    labels.length !== new Set([...existingLabels, ...labels]).size;

  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    existingPri,
    priority,
    existingLabels,
    labels,
    needsUpdate: true,
  };
});

const need = updates;
console.log(JSON.stringify({ total: all.length, toUpdate: need.length }, null, 2));
fs.writeFileSync(
  path.join(AGENT_TOOLS, 'linear-triage-updates.json'),
  JSON.stringify(need, null, 2),
);
