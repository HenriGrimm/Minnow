/** Parse a plan markdown document into a task graph. */
import { boardPlanTypeError } from './plan-format.js';

/** Bullet fields a task must carry. */
const REQUIRED_FIELDS = /** @type {const} */ (['Build', 'Test', 'Accept', 'Touches']);

/**
 * Parse a plan document.
 *
 * @param {string} markdown
 * @returns {import('./types').TaskGraph | import('./types').ParseError[]}
 */
export function parsePlan(markdown) {
  try {
    const typeError = boardPlanTypeError(markdown);
    if (typeError) return [{ line: 1, column: 1, message: typeError, hint: 'Choose the matching planning format before board execution.' }];
    return parseUnsafe(markdown);
  } catch (error) {
    return [
      {
        line: 1,
        column: 1,
        message: `plan could not be read: ${error && error.message ? error.message : String(error)}`,
        hint: 'the document is not a plan; regenerate it from the Planner schema',
      },
    ];
  }
}

/**
 * Did a parse fail?
 *
 * @param {import('./types').TaskGraph | import('./types').ParseError[]} result
 * @returns {boolean}
 */
export function isParseErrors(result) {
  return Array.isArray(result);
}

/**
 * Render errors for a human — used by the `save_file` guard and the REST 400.
 *
 * @param {import('./types').ParseError[]} errors
 * @returns {string}
 */
export function formatParseErrors(errors) {
  return errors
    .map((e) => `line ${e.line}:${e.column} — ${e.message}\n    hint: ${e.hint}`)
    .join('\n');
}

/**
 * @param {string} markdown
 * @returns {import('./types').TaskGraph | import('./types').ParseError[]}
 */
function parseUnsafe(markdown) {
  /** @type {import('./types').ParseError[]} */
  const errors = [];
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const frontMatter = readFrontMatter(lines, errors);
  const body = readBody(lines, frontMatter.endLine, errors);

  if (errors.length > 0) return sortErrors(errors);

  crossCheckTodos(frontMatter, body, errors);
  resolveDependencies(body, errors);
  detectCycles(body, errors);

  if (errors.length > 0) return sortErrors(errors);

  return {
    name: frontMatter.name,
    overview: frontMatter.overview,
    isProject: frontMatter.isProject,
    title: body.title,
    waves: body.waves,
    tasks: body.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      wave: task.wave,
      dependsOn: task.dependsOn,
      touches: task.touches,
      build: task.build,
      test: task.test,
      accept: task.accept,
      line: task.line,
    })),
  };
}


/**
 * @param {string[]} lines
 * @param {import('./types').ParseError[]} errors
 */
function readFrontMatter(lines, errors) {
  const result = {
    name: '',
    overview: '',
    isProject: false,
    /** @type {Array<{ id: string, content: string, status: string, line: number }>} */
    todos: [],
    endLine: 0,
  };

  if (lines[0]?.trim() !== '---') {
    errors.push({
      line: 1,
      column: 1,
      message: 'plan is missing YAML front matter',
      hint: 'start the file with a --- fence containing name, overview, todos, and isProject',
    });
    return result;
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    errors.push({
      line: 1,
      column: 1,
      message: 'front matter is never closed',
      hint: 'add a closing --- fence',
    });
    return result;
  }
  result.endLine = close + 1;

  let inTodos = false;
  /** @type {{ id: string, content: string, status: string, line: number } | null} */
  let current = null;

  for (let i = 1; i < close; i += 1) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    const indented = /^\s/.test(raw);

    if (!indented) {
      inTodos = false;
      current = null;
      const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
      if (!match) {
        errors.push({
          line: i + 1,
          column: 1,
          message: `front matter line is not \`key: value\`: ${truncate(raw)}`,
          hint: 'front matter holds name, overview, todos, and isProject',
        });
        continue;
      }
      const [, key, value] = match;
      if (key === 'todos') {
        inTodos = true;
        continue;
      }
      if (key === 'name') result.name = unquote(value);
      else if (key === 'overview') result.overview = unquote(value);
      else if (key === 'isProject') result.isProject = unquote(value) === 'true';
      continue;
    }

    if (!inTodos) continue;

    const entry = /^\s*-\s*id\s*:\s*(.+)$/.exec(raw);
    if (entry) {
      current = { id: unquote(entry[1]), content: '', status: '', line: i + 1 };
      result.todos.push(current);
      continue;
    }
    const field = /^\s*(content|status)\s*:\s*(.*)$/.exec(raw);
    if (field && current) {
      if (field[1] === 'content') current.content = unquote(field[2]);
      else current.status = unquote(field[2]);
      continue;
    }
    if (!field) {
      errors.push({
        line: i + 1,
        column: 1,
        message: `todo entry is not \`- id:\` / \`content:\` / \`status:\`: ${truncate(raw)}`,
        hint: 'each todo is `- id: W1-A` then indented content and status lines',
      });
    }
  }

  if (!result.name) {
    errors.push({
      line: 1,
      column: 1,
      message: 'front matter has no `name`',
      hint: 'add `name: <plan-kebab-name>`',
    });
  }
  if (result.todos.length === 0) {
    errors.push({
      line: 1,
      column: 1,
      message: 'front matter has no `todos` entries',
      hint: 'the todos list must enumerate every task id in the plan',
    });
  }
  for (const todo of result.todos) {
    if (!todo.id) {
      errors.push({
        line: todo.line,
        column: 1,
        message: 'todo has an empty id',
        hint: 'the id must match a `#### Task <id>:` heading exactly',
      });
    }
  }

  return result;
}


/**
 * @param {string[]} lines
 * @param {number} from
 * @param {import('./types').ParseError[]} errors
 */
function readBody(lines, from, errors) {
  const body = {
    title: '',
    /** @type {import('./types').WaveRef[]} */
    waves: [],
    /** @type {any[]} */
    tasks: [],
  };

  let inWaveBreakdown = false;
  let sawWaveBreakdown = false;
  let currentWave = 0;
  /** @type {any} */
  let task = null;
  /** @type {string | null} */
  let field = null;

  const finishField = () => {
    if (task && field) task[field] = String(task[field] ?? '').trim();
    field = null;
  };

  for (let i = from; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = i + 1;
    const trimmed = raw.trim();

    if (!body.title) {
      const title = /^#\s+(.+)$/.exec(raw);
      if (title) {
        body.title = title[1].trim();
        continue;
      }
    }

    if (/^##\s+/.test(raw)) {
      finishField();
      task = null;
      inWaveBreakdown = /^##\s+Wave\s+Breakdown\s*$/i.test(raw.trim());
      if (inWaveBreakdown) sawWaveBreakdown = true;
      continue;
    }

    if (/^###\s+/.test(raw)) {
      finishField();
      task = null;
      if (!inWaveBreakdown) continue;
      const wave = /^###\s+Wave\s+(\d+)\s*(?:[—–-]\s*(.*))?$/.exec(trimmed);
      if (!wave) {
        errors.push({
          line,
          column: 1,
          message: `wave heading is malformed: ${truncate(trimmed)}`,
          hint: 'use `### Wave 1 — Name`',
        });
        continue;
      }
      currentWave = Number(wave[1]);
      body.waves.push({ n: currentWave, name: (wave[2] ?? '').trim() });
      continue;
    }

    if (/^####\s+/.test(raw)) {
      finishField();
      task = null;
      if (!inWaveBreakdown) continue;
      const heading = /^####\s+Task\s+([^:]+?)\s*:\s*(.*)$/.exec(trimmed);
      if (!heading) {
        errors.push({
          line,
          column: 1,
          message: `task heading is malformed: ${truncate(trimmed)}`,
          hint: 'use `#### Task W1-A: Title`',
        });
        continue;
      }
      if (currentWave === 0) {
        errors.push({
          line,
          column: 1,
          message: `task ${heading[1]} appears before any \`### Wave N\` heading`,
          hint: 'every task belongs to a wave',
        });
      }
      task = {
        id: heading[1].trim(),
        title: heading[2].trim(),
        wave: currentWave || 1,
        build: '',
        test: '',
        accept: '',
        touchesRaw: '',
        dependsRaw: '',
        dependsDeclared: false,
        dependsOn: [],
        touches: [],
        line,
      };
      body.tasks.push(task);
      continue;
    }

    if (!task) continue;

    const matched = matchTaskField(raw);
    if (matched) {
      finishField();
      const label = matched.label;
      if (label === 'Build') field = 'build';
      else if (label === 'Test') field = 'test';
      else if (label === 'Accept') field = 'accept';
      else if (label === 'Touches') field = 'touchesRaw';
      else if (label === 'Depends on') {
        field = 'dependsRaw';
        task.dependsDeclared = true;
      } else {
        field = null;
        continue;
      }
      task[field] = matched.value;
      continue;
    }

    if (field && trimmed.length > 0) {
      task[field] = `${task[field]}\n${trimmed}`;
      continue;
    }
    if (trimmed.length === 0) finishField();
  }
  finishField();

  if (!sawWaveBreakdown) {
    errors.push({
      line: 1,
      column: 1,
      message: 'plan has no `## Wave Breakdown` section',
      hint: 'the scheduler reads tasks only from that section',
    });
    return body;
  }
  if (body.tasks.length === 0) {
    errors.push({
      line: 1,
      column: 1,
      message: 'plan declares no tasks',
      hint: 'add at least one `#### Task W1-A: Title` under a wave heading',
    });
    return body;
  }

  validateTasks(body, errors);
  return body;
}

/**
 * @param {{ tasks: any[] }} body
 * @param {import('./types').ParseError[]} errors
 */
function validateTasks(body, errors) {
  /** @type {Map<string, number>} */
  const seen = new Map();

  for (const task of body.tasks) {
    if (!task.id) {
      errors.push({
        line: task.line,
        column: 1,
        message: 'task heading has an empty id',
        hint: 'use `#### Task W1-A: Title`',
      });
    } else if (seen.has(task.id)) {
      errors.push({
        line: task.line,
        column: 1,
        message: `duplicate task id ${task.id}, first declared on line ${seen.get(task.id)}`,
        hint: 'task ids must be unique across the whole plan',
      });
    } else {
      seen.set(task.id, task.line);
    }

    if (!task.title) {
      errors.push({
        line: task.line,
        column: 1,
        message: `task ${task.id} has no title`,
        hint: 'use `#### Task W1-A: Title`',
      });
    }

    for (const label of REQUIRED_FIELDS) {
      const key = label === 'Touches' ? 'touchesRaw' : label.toLowerCase();
      if (!String(task[key] ?? '').trim()) {
        errors.push({
          line: task.line,
          column: 1,
          message: `task ${task.id} has no **${label}:**`,
          hint:
            label === 'Touches'
              ? 'declare the files this task may write, as comma-separated globs'
              : `every task carries Build, Test, Accept, and Touches — no exceptions`,
        });
      }
    }

    task.dependsOn = splitList(task.dependsRaw);
    task.touches = splitList(task.touchesRaw);

    for (const glob of task.touches) {
      const problem = globProblem(glob);
      if (problem) {
        errors.push({
          line: task.line,
          column: 1,
          message: `task ${task.id} declares an invalid glob \`${glob}\`: ${problem}`,
          hint: 'touches are repo-relative globs, e.g. `src/ui/**`, `server/orchestrator/*.js`',
        });
      }
    }
  }
}

// ── Cross-checks ─────────────────────────────────────────────────────────────

/**
 * The front-matter `todos` and the `#### Task` headings must each account for the other.
 * @param {{ todos: Array<{ id: string, line: number }> }} frontMatter
 * @param {{ tasks: any[] }} body
 * @param {import('./types').ParseError[]} errors
 */
function crossCheckTodos(frontMatter, body, errors) {
  const taskIds = new Map(body.tasks.map((t) => [normaliseId(t.id), t]));
  const todoIds = new Map(frontMatter.todos.map((t) => [normaliseId(t.id), t]));

  for (const todo of frontMatter.todos) {
    if (!taskIds.has(normaliseId(todo.id))) {
      errors.push({
        line: todo.line,
        column: 1,
        message: `todo \`${todo.id}\` has no matching \`#### Task ${todo.id}:\` heading`,
        hint: 'every todo id names a task in the Wave Breakdown, and vice versa',
      });
    }
  }
  for (const task of body.tasks) {
    if (!todoIds.has(normaliseId(task.id))) {
      errors.push({
        line: task.line,
        column: 1,
        message: `task ${task.id} has no matching entry in the front-matter todos list`,
        hint: 'add `- id: ' + task.id + '` to the todos list',
      });
    }
  }
}

/**
 * @param {{ tasks: any[] }} body
 * @param {import('./types').ParseError[]} errors
 */
function resolveDependencies(body, errors) {
  const byId = new Map(body.tasks.map((t) => [normaliseId(t.id), t.id]));
  for (const task of body.tasks) {
    /** @type {string[]} */
    const resolved = [];
    for (const declared of task.dependsOn) {
      const actual = byId.get(normaliseId(declared));
      if (!actual) {
        errors.push({
          line: task.line,
          column: 1,
          message: `task ${task.id} depends on \`${declared}\`, which is not a task in this plan`,
          hint: 'only reference task ids declared under the Wave Breakdown',
        });
        continue;
      }
      if (actual === task.id) {
        errors.push({
          line: task.line,
          column: 1,
          message: `task ${task.id} depends on itself`,
          hint: 'remove the self-reference',
        });
        continue;
      }
      if (!resolved.includes(actual)) resolved.push(actual);
    }
    task.dependsOn = resolved;
  }
}

/**
 * Cycles must be impossible downstream — `plan()` assumes an acyclic graph and would simply never schedule a cycle, which is a deadlock.
 * @param {{ tasks: any[] }} body
 * @param {import('./types').ParseError[]} errors
 */
function detectCycles(body, errors) {
  const byId = new Map(body.tasks.map((t) => [t.id, t]));
  /** @type {Map<string, number>} */
  const colour = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @type {Set<string>} */
  const reported = new Set();

  /** @param {string} id */
  const visit = (id) => {
    colour.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const mark = colour.get(dep) ?? 0;
      if (mark === 1) {
        const cycle = stack.slice(stack.indexOf(dep)).concat(dep);
        const key = [...cycle].sort().join('>');
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({
            line: byId.get(id)?.line ?? 1,
            column: 1,
            message: `dependency cycle: ${cycle.join(' → ')}`,
            hint: 'break the cycle; the scheduler cannot start any task in it',
          });
        }
      } else if (mark === 0 && byId.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    colour.set(id, 2);
  };

  for (const task of body.tasks) {
    if ((colour.get(task.id) ?? 0) === 0) visit(task.id);
  }
}


/**
 * Recognised task-field labels (case-insensitive).
 * @param {string} raw
 * @returns {{ label: string, value: string } | null}
 */
function matchTaskField(raw) {
  const patterns = [
    /^\s*[-*]\s+\*\*(Build|Test|Accept|Touches|Depends\s+on):?\*\*:?\s*(.*)$/i,
    /^\s*[-*]\s+(Build|Test|Accept|Touches|Depends\s+on):\s*(.*)$/i,
    /^\s*\*\*(Build|Test|Accept|Touches|Depends\s+on):?\*\*:?\s*(.*)$/i,
    /^\s*(Build|Test|Accept|Touches|Depends\s+on):\s*(.*)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const label = /^depends\s+on$/i.test(match[1]) ? 'Depends on' : titleCaseLabel(match[1]);
    return { label, value: match[2] ?? '' };
  }
  return null;
}

/**
 * @param {string} label
 * @returns {string}
 */
function titleCaseLabel(label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Peel wrapping markup and trailing sentence punctuation so LLM/placeholder spellings (`none.`, `(none)`, `` `none` ``, `**nothing**`).
 * @param {string} part
 * @returns {string}
 */
function normalizeListToken(part) {
  let token = String(part ?? '')
    .trim()
    .replace(/^[-*]\s+/, '')
    .trim();
  let previous = '';
  while (token && token !== previous) {
    previous = token;
    if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      token = token.slice(2, -2).trim();
      continue;
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      token = token.slice(1, -1).trim();
      continue;
    }
    if (
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2) ||
      (token.startsWith('"') && token.endsWith('"') && token.length >= 2)
    ) {
      token = token.slice(1, -1).trim();
      continue;
    }
    if (
      (token.startsWith('(') && token.endsWith(')') && token.length >= 2) ||
      (token.startsWith('[') && token.endsWith(']') && token.length >= 2)
    ) {
      token = token.slice(1, -1).trim();
      continue;
    }
    token = token.replace(/[.,;:!?]+$/g, '').trim();
  }
  return token;
}

/**
 * Split a comma-separated bullet value.
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((part) => normalizeListToken(part))
    .filter((part) => part.length > 0 && !/^(none|nothing|n\/a|na|-|—|–)$/i.test(part));
}

/**
 * @param {string} glob
 * @returns {string | null} the problem, or null when the syntax is usable
 */
function globProblem(glob) {
  if (glob.length === 0) return 'the pattern is empty';
  if (/^[/\\]/.test(glob) || /^[A-Za-z]:[/\\]/.test(glob)) return 'globs are repo-relative';
  if (glob.split(/[/\\]/).includes('..')) return 'globs may not escape the repo with `..`';
  if (countOf(glob, '[') !== countOf(glob, ']')) return 'unbalanced [ ]';

  if (/[{}]/.test(glob)) {
    return 'brace expansion is not supported — write one glob per alternative';
  }
  if (glob.startsWith('!')) return 'negated globs are not supported — declare what the task writes';
  if (/\s/.test(glob)) return 'a glob may not contain whitespace — it looks like prose, not a path';
  if (/[()]/.test(glob)) return 'a glob may not contain parentheses — it looks like prose, not a path';
  return null;
}

/**
 * @param {string} text
 * @param {string} char
 * @returns {number}
 */
function countOf(text, char) {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/**
 * Ids are compared case-insensitively so `w1-a` in the todos matches `#### Task W1-A:` — the declared casing is what the graph keeps.
 * @param {string} id
 * @returns {string}
 */
function normaliseId(id) {
  return String(id ?? '').trim().toLowerCase();
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const trimmed = String(value ?? '').trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const clean = String(text ?? '').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

/**
 * Errors come out in document order, so a reader fixes the first problem first.
 *
 * @param {import('./types').ParseError[]} errors
 * @returns {import('./types').ParseError[]}
 */
function sortErrors(errors) {
  return errors
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.line - b.e.line || a.e.column - b.e.column || a.i - b.i)
    .map((entry) => entry.e);
}
