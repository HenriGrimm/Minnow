/**
 * Code map icons. Folders get a glyph from a keyword table (or a two-letter monogram),
 * packages from a category table, files a language tag, symbols a kind badge. People can
 * override a folder's icon; overrides are kept per repo in this browser.
 */

/** Uicons glyph class (`fi-rr-*`) or a short text monogram. */
export type CodeMapIcon = { kind: 'glyph'; cls: string } | { kind: 'mono'; text: string };

const MODULE_RULES: Array<[RegExp, string]> = [
  [/^(tests?|__tests__|spec|specs|e2e|fixtures|testing|mocks?|__mocks__)$/, 'fi-rr-flask'],
  [/^(ui|views?|pages?|screens?|components?|widgets?|layouts?|templates?|frontend)$/, 'fi-rr-browser'],
  [/^(api|apis|routes?|router|endpoints?|handlers?|controllers?|http|rest|graphql|rpc)$/, 'fi-rr-api'],
  [/^(db|database|schemas?|models?|migrations?|stores?|storage|persistence|repositor(y|ies)|sql|data)$/, 'fi-rr-database'],
  [/^(state|redux|contexts?|signals|session|sessions)$/, 'fi-rr-layers'],
  [/^(scripts?|bin|cli|cmd|tasks?|tooling)$/, 'fi-rr-terminal'],
  [/^(terminal|pty|console|process(es)?|runner|runtime)$/, 'fi-rr-terminal'],
  [/^(config|configs|settings|conf|env|preferences)$/, 'fi-rr-settings'],
  [/^(auth|security|permissions?|crypto|secrets?|sandbox)$/, 'fi-rr-shield-check'],
  [/^(lib|libs|utils?|helpers?|common|shared|core|internal|pkg|support)$/, 'fi-rr-box-open'],
  [/^(chat|messages?|messaging|conversations?|inbox|email|mail|composer)$/, 'fi-rr-comment'],
  [/^(agents?|ai|llm|inference|providers?|generations?|completions?|prompts?)$/, 'fi-rr-microchip'],
  [/^(workers?|jobs?|queues?|cron|scheduler|background|daemon)$/, 'fi-rr-gears'],
  [/^(styles?|css|themes?|design|appearance)$/, 'fi-rr-palette'],
  [/^(assets|static|public|images?|icons?|fonts?|media)$/, 'fi-rr-picture'],
  [/^(docs?|documentation|manual|wiki|guides?)$/, 'fi-rr-book-alt'],
  [/^(i18n|l10n|locales?|translations?|lang)$/, 'fi-rr-language'],
  [/^(git|vcs|scm|worktrees?|branches)$/, 'fi-rr-code-branch'],
  [/^(search|index|indexer|query|queries|code)$/, 'fi-rr-search'],
  [/^(plugins?|extensions?|addons?|integrations?|mcp|connectors?)$/, 'fi-rr-plug'],
  [/^(network|net|sockets?|ws|websockets?|transport|sync|server|servers|backend)$/, 'fi-rr-network'],
  [/^(notifications?|alerts?|events?|webhooks?)$/, 'fi-rr-bell'],
  [/^(electron|desktop|native|shell|platform|os|window|windows)$/, 'fi-rr-window-maximize'],
  [/^(mobile|ios|android)$/, 'fi-rr-mobile-notch'],
  [/^(browser|web|www|client|cdp)$/, 'fi-rr-globe'],
  [/^(analytics|metrics|stats|telemetry|benchmarks?|perf|evals?|diagnostics|usage)$/, 'fi-rr-chart-histogram'],
  [/^(users?|accounts?|profiles?|teams?)$/, 'fi-rr-users'],
  [/^(calendar|schedule)$/, 'fi-rr-calendar'],
  [/^(audio|voice|video|stt|tts|speech)$/, 'fi-rr-microphone'],
  [/^(brain|memory|knowledge|rag|embeddings?|vectors?|synthesis)$/, 'fi-rr-brain'],
  [/^(orchestrat(e|or|ion)|workflows?|pipelines?|boards?|plans?)$/, 'fi-rr-sitemap'],
  [/^(skills?|commands?|actions?)$/, 'fi-rr-magic-wand'],
  [/^(markdown|md|editor|text|files?|documents?)$/, 'fi-rr-document'],
  [/^(issues?|tickets?|todos?)$/, 'fi-rr-list-check'],
];

const PACKAGE_RULES: Array<[RegExp, string]> = [
  [/^(better-sqlite3|sqlite3?|pg|postgres|mysql2?|mongodb|mongoose|redis|ioredis|prisma|@prisma\/.+|drizzle-orm|knex|typeorm|sequelize|sqlalchemy|psycopg2?|kysely)$/, 'fi-rr-database'],
  [/^(react|react-dom|vue|svelte|solid-js|preact|@angular\/.+|lit|next|nuxt|astro)$/, 'fi-rr-browser'],
  [/^(electron|electron-.+|tauri|@tauri-apps\/.+)$/, 'fi-rr-window-maximize'],
  [/^(node-pty|@lydell\/node-pty|xterm|@xterm\/.+|execa|cross-spawn)$/, 'fi-rr-terminal'],
  [/^(express|fastify|koa|hono|axios|undici|got|node-fetch|ky|requests|httpx|flask|fastapi|django|aiohttp)$/, 'fi-rr-api'],
  [/^(openai|@anthropic-ai\/.+|anthropic|langchain|@langchain\/.+|ai|@ai-sdk\/.+|ollama|transformers|torch|tensorflow|@huggingface\/.+|llama-cpp.*)$/, 'fi-rr-microchip'],
  [/^(vitest|jest|mocha|chai|playwright|@playwright\/.+|pytest|happy-dom|jsdom|cypress|sinon|@testing-library\/.+)$/, 'fi-rr-flask'],
  [/^(marked|markdown-it|remark|remark-.+|unified|rehype|rehype-.+|highlight\.js|shiki|dompurify|katex|mermaid)$/, 'fi-rr-document'],
  [/^(vite|esbuild|webpack|rollup|typescript|tsx|@babel\/.+|babel|swc|@swc\/.+)$/, 'fi-rr-tools'],
  [/^(zod|yup|ajv|joi|pydantic|valibot)$/, 'fi-rr-shield-check'],
  [/^(simple-git|isomorphic-git|nodegit|@octokit\/.+)$/, 'fi-rr-code-branch'],
  [/^(ws|socket\.io|socket\.io-client|@modelcontextprotocol\/.+)$/, 'fi-rr-network'],
  [/^(sharp|jimp|pillow|canvas|@napi-rs\/canvas)$/, 'fi-rr-picture'],
  [/^(chokidar|fs-extra|glob|fast-glob|globby|tar|archiver|adm-zip)$/, 'fi-rr-folder'],
];

/** Glyphs offered in the "Change icon" picker. */
export const PICKER_GLYPHS: readonly string[] = [
  ...new Set([...MODULE_RULES.map(([, cls]) => cls), 'fi-rr-cube', 'fi-rr-folder', 'fi-rr-bolt']),
];

const LANGUAGE_TAGS: Record<string, string> = {
  ts: 'TS', tsx: 'TSX', mts: 'TS', cts: 'TS', js: 'JS', jsx: 'JSX', mjs: 'JS', cjs: 'JS',
  py: 'PY', go: 'GO', rs: 'RS', java: 'JV', kt: 'KT', swift: 'SW', rb: 'RB', php: 'PHP',
  c: 'C', h: 'H', cpp: 'C++', cc: 'C++', hpp: 'H++', cs: 'C#', lua: 'LUA', gd: 'GD',
  css: 'CSS', scss: 'CSS', html: 'HTM', vue: 'VUE', svelte: 'SV', md: 'MD', json: 'JSN',
  sh: 'SH', ps1: 'PS', sql: 'SQL', yaml: 'YML', yml: 'YML', toml: 'TML', dart: 'DRT',
};

/** Short text for a symbol kind badge. */
const KIND_BADGES: Record<string, string> = {
  function: 'fn', method: 'm', constructor: 'new', class: 'C', interface: 'I', struct: 'S',
  enum: 'E', enummember: 'e', type: 'T', typeparameter: 'T', variable: 'v', constant: 'k',
  property: 'p', field: 'p', module: 'M', namespace: 'N', package: 'P', object: 'o',
  event: 'ev', operator: 'op', key: 'k', string: 's', number: '#', boolean: 'b', array: '[]',
};

/** Split a folder or package name into words for keyword matching. */
function nameWords(name: string): string[] {
  const lower = name.toLowerCase();
  return [lower, ...lower.split(/[-_.\s/@]+/).filter(Boolean)];
}

/** Two-letter monogram from a name: initials of its first two words, else its first two letters. */
export function monogram(name: string): string {
  const words = name
    .replace(/^@[^/]+\//, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_.\s/]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) {
    const w = words[0]!;
    return (w[0]!.toUpperCase() + (w[1] ?? '').toLowerCase()).trim();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Icon for a folder module from its name (whole name first, then each word). */
export function moduleIcon(name: string): CodeMapIcon {
  for (const word of nameWords(name)) {
    for (const [re, cls] of MODULE_RULES) {
      if (re.test(word)) return { kind: 'glyph', cls };
    }
  }
  return { kind: 'mono', text: monogram(name) };
}

/** Icon for a third-party package from its category. */
export function packageIcon(name: string): CodeMapIcon {
  const lower = name.toLowerCase();
  for (const [re, cls] of PACKAGE_RULES) {
    if (re.test(lower)) return { kind: 'glyph', cls };
  }
  return { kind: 'mono', text: monogram(name) };
}

/** Language tag for a file name (e.g. `TS`), or `''` when unknown. */
export function languageTag(fileName: string): string {
  const m = /\.([a-z0-9+]+)$/i.exec(fileName);
  if (!m) return '';
  return LANGUAGE_TAGS[m[1]!.toLowerCase()] ?? m[1]!.slice(0, 3).toUpperCase();
}

/** Badge text for a symbol kind. */
export function kindBadge(kind: string): string {
  return KIND_BADGES[kind.toLowerCase().replace(/[^a-z]/g, '')] ?? kind.slice(0, 2).toLowerCase();
}

// ── Overrides ────────────────────────────────────────────────────────────────

const OVERRIDE_KEY_PREFIX = 'minnow.codeMap.icons.';

function readOverrides(repo: string): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(OVERRIDE_KEY_PREFIX + repo);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && /^fi-rr-[a-z0-9-]+$/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Icon for a folder path, honouring a saved override. */
export function folderIcon(repo: string, path: string, name: string): CodeMapIcon {
  const override = readOverrides(repo)[path];
  if (override) return { kind: 'glyph', cls: override };
  return moduleIcon(name);
}

/** Save (or clear, with `null`) the icon override for a folder path. */
export function setFolderIconOverride(repo: string, path: string, cls: string | null): void {
  try {
    const overrides = readOverrides(repo);
    if (cls) overrides[path] = cls;
    else delete overrides[path];
    globalThis.localStorage?.setItem(OVERRIDE_KEY_PREFIX + repo, JSON.stringify(overrides));
  } catch {
    // Storage blocked: the override lasts until reload.
  }
}

/** Whether a folder path has a saved icon override. */
export function hasFolderIconOverride(repo: string, path: string): boolean {
  return Boolean(readOverrides(repo)[path]);
}

/** Icon element (`<i>` glyph or monogram `<span>`) for a tile. */
export function renderIcon(icon: CodeMapIcon): HTMLElement {
  if (icon.kind === 'glyph') {
    const el = document.createElement('i');
    el.className = `fi ${icon.cls}`;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  const el = document.createElement('span');
  el.className = 'code-map-mono';
  el.textContent = icon.text;
  el.setAttribute('aria-hidden', 'true');
  return el;
}
