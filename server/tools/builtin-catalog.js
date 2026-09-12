import { defaultAskQuestionTool } from '../runner/ask-question-tool.js';

const ASK_QUESTION_TOOL_DESCRIPTION = defaultAskQuestionTool().function.description;

// ── Schema ───────────────────────────────────────────────────────────────────

/** Builds a function schema; `name` matches the executor entry point. */
/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} properties
 * @param {string[]} [required]
 * @returns {import('../../src/tools/definitions').OpenAIFunctionDefinition}
 */
function toolSchema(name, description, properties, required) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        ...(required && required.length > 0 ? { required } : {}),
      },
    },
  };
}

/** Per-call opt-out of automatic result-size caps (pagination args still apply). */
const FULL_RESULT_PROPERTY = {
  type: 'boolean',
  description:
    'If true, skip automatic result-size caps for this call. Pagination (head_limit, offset, line ranges, read_command_log max_bytes) still applies.',
};

/** @param {Record<string, unknown>} properties */
function withFullResult(properties) {
  return { ...properties, full_result: FULL_RESULT_PROPERTY };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** @type {import('../../src/tools/definitions').ToolDefinition[]} */
export const BUILT_IN_TOOLS = [
  {
    id: 'get_datetime',
    label: 'Date & time',
    description: 'Returns the current date and time in ISO 8601 format.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'get_datetime',
      'Get the current date and time as an ISO 8601 string.',
      {},
    ),
  },
  {
    id: 'calculate',
    label: 'Calculate',
    description: 'Evaluates a safe math expression using JavaScript Math.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'calculate',
      'Evaluate a mathematical expression (numbers, + - * / % parentheses, Math functions).',
      {
        expression: {
          type: 'string',
          description: 'Math expression to evaluate, e.g. "(2 + 3) * 4"',
        },
      },
      ['expression'],
    ),
  },
  {
    id: 'web_search',
    label: 'Web search',
    description:
      'Search the web using the provider selected in Settings (Brave, Tavily, or DuckDuckGo).',
    category: 'web',
    serverRequired: false,
    requiresKey: false,
    definition: toolSchema(
      'web_search',
      'Search the web for up-to-date information. Provider is configured in Settings → Tools (Brave API, Tavily API, or DuckDuckGo via local server).',
      {
        query: { type: 'string', description: 'Search query' },
        deep_read: {
          type: 'boolean',
          description:
            'Also fetch the top 3 results and return the passages most relevant to the query. Slower, but usually avoids a follow-up fetch_web_content call.',
        },
        api_key: {
          type: 'string',
          description: 'Optional Brave Search API key (overrides saved key when Brave is selected)',
        },
      },
      ['query'],
    ),
  },
  {
    id: 'wikipedia_search',
    label: 'Wikipedia',
    description: 'Search Wikipedia summaries via the public REST API.',
    category: 'web',
    serverRequired: false,
    definition: toolSchema(
      'wikipedia_search',
      'Search Wikipedia and return article summaries.',
      {
        query: { type: 'string', description: 'Topic or search terms' },
      },
      ['query'],
    ),
  },
  {
    id: 'fetch_web_content',
    label: 'Fetch page',
    description:
      'Fetches a URL and returns the main content as plain text (about 48KB max unless max_bytes or full_result). Uses in-app HTTP fetch when Minnow is running locally; browser path is CORS-limited.',
    category: 'web',
    serverRequired: false,
    definition: toolSchema(
      'fetch_web_content',
      'Fetch a web page URL and return its main text content — navigation, sidebars, footers, cookie banners, and reference lists are dropped, and <main>/<article> is preferred when present. Returns up to ~48KB by default (ceiling ~128KB via max_bytes or full_result). Prefer rag_web_content when you know what you are looking for on the page.',
      withFullResult({
        url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
        max_bytes: {
          type: 'number',
          description: 'Bytes of page text to return (default 49152, max 131072)',
        },
      }),
      ['url'],
    ),
  },
  {
    id: 'rag_web_content',
    label: 'Web RAG',
    description: 'Fetches a page and returns sentences and paragraphs most relevant to a query.',
    category: 'web',
    serverRequired: false,
    definition: toolSchema(
      'rag_web_content',
      'Fetch a web page and return up to 16 query-relevant excerpts (sentences and paragraphs) from a deeper page extract (~128KB unless full_result is true).',
      withFullResult({
        url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
        query: { type: 'string', description: 'What to extract from the page' },
      }),
      ['url', 'query'],
    ),
  },
  {
    id: 'read_clipboard',
    label: 'Read clipboard',
    description: 'Reads plain text from the system clipboard (requires permission).',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'read_clipboard',
      'Read plain text from the clipboard. Long clipboard contents are truncated to the result budget unless full_result is true.',
      withFullResult({}),
    ),
  },
  {
    id: 'write_clipboard',
    label: 'Write clipboard',
    description: 'Writes plain text to the system clipboard.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'write_clipboard',
      'Write plain text to the clipboard.',
      {
        text: { type: 'string', description: 'Text to copy to the clipboard' },
      },
      ['text'],
    ),
  },
  {
    id: 'get_system_info',
    label: 'System info',
    description: 'Returns browser, screen, and device information from the client.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'get_system_info',
      'Get browser user agent, screen size, and related client environment info.',
      {},
    ),
  },
  {
    id: 'ask_question',
    label: 'Ask question',
    description:
      'Show one or more multiple-choice questions at the bottom of the chat and wait until the user submits answers or cancels.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'ask_question',
      ASK_QUESTION_TOOL_DESCRIPTION,
      {
        title: { type: 'string' },
        questions: {
          type: 'array',
          items: { type: 'object' },
        },
      },
      ['questions'],
    ),
  },
  {
    id: 'set_chat_mode',
    label: 'Set chat mode',
    description:
      'Switch the active chat operating mode (General, Build, Plan, Orchestrate, Debug) after the user chooses a handoff option.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'set_chat_mode',
      'Set the active chat operating mode. Use only after the user selects a mode switch (never auto-switch without consent).',
      {
        mode_id: {
          type: 'string',
          enum: ['general', 'build', 'plan', 'orchestrate', 'debug'],
          description: 'Target operating mode for the active chat',
        },
      },
      ['mode_id'],
    ),
  },
  {
    id: 'create_chat_with_mode',
    label: 'Create chat with mode',
    description:
      'Create a new chat with a preset operating mode, optional Orchestrate plan path, and optional seed user message.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'create_chat_with_mode',
      'Create and activate a new chat with the given mode. For Orchestrate handoff, pass plan_path and optional initial_user_message (e.g. Execute plan at documentation/plans/foo.md).',
      {
        mode_id: {
          type: 'string',
          enum: ['general', 'build', 'plan', 'orchestrate', 'debug'],
          description: 'Operating mode for the new chat',
        },
        plan_path: {
          type: 'string',
          description:
            'Workspace-relative plan path for Orchestrate (documentation/plans/*.md)',
        },
        initial_user_message: {
          type: 'string',
          description: 'Optional first user message seeded into the new chat history',
        },
      },
      ['mode_id'],
    ),
  },
  {
    id: 'launch_minnow_app',
    label: 'Launch Minnow app',
    description:
      'Open or foreground a Minnow app (Code, Chat, Research, Issues, Models, Brain, Scheduler, Settings).',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'launch_minnow_app',
      'Launch or foreground a Minnow app. Use for repo work (code), research (research), issues (issues), models, brain, scheduler, settings, or chat. Pass seed to prefill input. Bench/experts only when enabled in Settings → Apps.',
      {
        app_id: {
          type: 'string',
          enum: ['code', 'chat', 'research', 'experts', 'bench', 'issues', 'settings'],
          description: 'Minnow app to open',
        },
        seed: {
          type: 'string',
          description:
            'Optional seed text (workspace path or task for code; query for research; message for chat)',
        },
        settings_section: {
          type: 'string',
          description:
            'When app_id is settings: legacy area slug (e.g. memory, tools) or category slug (e.g. agents)',
        },
        settings_query: {
          type: 'string',
          description:
            'When app_id is settings: free-text setting name to resolve via search (e.g. "turn off memory", "temperature") — opens and highlights the control without changing its value',
        },
      },
      ['app_id'],
    ),
  },
  {
    id: 'propose_mode_switch',
    label: 'Propose mode switch',
    description:
      'Show standard mode-handoff multiple-choice cards (plan complete, wrong mode).',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'propose_mode_switch',
      'Ask the user a standard mode-handoff question via the ask_question UI. Situations: plan_complete, implement_in_wrong_mode, plan_in_build.',
      {
        situation: {
          type: 'string',
          enum: [
            'plan_complete',
            'implement_in_wrong_mode',
            'plan_in_build',
          ],
          description: 'Which handoff preset to show',
        },
        plan_path: {
          type: 'string',
          description: 'Plan file path when situation is plan_complete',
        },
      },
      ['situation'],
    ),
  },

// ── Files ────────────────────────────────────────────────────────────────────

  {
    id: 'list_directory',
    label: 'List directory',
    description: 'Lists files and folders in a directory under the project.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'list_directory',
      'List entries in a directory (names and file/directory type).',
      {
        path: {
          type: 'string',
          description: 'Relative path from project root, or "." for root',
        },
      },
      ['path'],
    ),
  },
  {
    id: 'read_file',
    label: 'Read file',
    description: 'Reads text content of a file (truncates very large files).',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'read_file',
      'Read a UTF-8 text file from the project. PDF, Excel (.xlsx/.xls), Word, PowerPoint, and OpenDocument files are extracted to plain text automatically (same as read_document) — do not treat ZIP/PK bytes as file contents. Large text files are truncated (~128k chars by default) with line counts and a pointer to read_file_range for the remainder — prefer read_file_range when you know you only need part of a file. Pass full_result: true to skip the automatic size cap.',
      withFullResult({
        path: { type: 'string', description: 'Relative file path' },
      }),
      ['path'],
    ),
  },
  {
    id: 'read_document',
    label: 'Read document',
    description: 'Extracts plain text from PDF and office documents in the workspace.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'read_document',
      'Extract plain text from a PDF or office document (Excel, Word, PowerPoint, OpenDocument, RTF). Prefer this over read_file for spreadsheets and office files. Prefer path for files already in the workspace; use content (base64 bytes) only for attachment-style payloads. Spreadsheets return a sheet manifest plus the first 200 rows of each sheet — pass sheet to read one, and start_row/max_rows to page. Large extracts are truncated (~128k chars) unless full_result is true.',
      withFullResult({
        path: {
          type: 'string',
          description: 'Workspace-relative path to the document (preferred for project files)',
        },
        filename: {
          type: 'string',
          description:
            'Filename hint when using content (e.g. report.pdf). Ignored when path is set.',
        },
        content: {
          type: 'string',
          description: 'Base64-encoded file bytes (use when the file is not on disk in the workspace)',
        },
        sheet: {
          type: 'string',
          description: 'Spreadsheets: sheet name or 1-based index to return (default: every sheet)',
        },
        start_row: {
          type: 'number',
          description: 'Spreadsheets: 1-based first data row to return (default 1)',
        },
        max_rows: {
          type: 'number',
          description: 'Spreadsheets: rows per sheet to return (default 200)',
        },
      }),
    ),
  },
  {
    id: 'read_file_range',
    label: 'Read file lines',
    description: 'Reads a line range from a text file (1-based line numbers).',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'read_file_range',
      'Read a range of lines from a text file (inclusive, 1-based). For PDF/Excel/Word, line numbers refer to the extracted text, not the binary file. Line bounds always apply; pass full_result: true to skip the extra character cap on the numbered slice.',
      withFullResult({
        path: { type: 'string', description: 'Relative file path' },
        start_line: { type: 'integer', description: 'First line number (1-based)' },
        end_line: { type: 'integer', description: 'Last line number (inclusive)' },
      }),
      ['path', 'start_line', 'end_line'],
    ),
  },
  {
    id: 'save_file',
    label: 'Save file',
    description: 'Creates or overwrites a file with the given content.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'save_file',
      'Write content to a file (creates or overwrites). When overwriting an existing file, line endings are auto-adjusted to match the file (CRLF vs LF) — agents can use \\n safely.',
      {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      ['path', 'content'],
    ),
  },
  {
    id: 'append_file',
    label: 'Append file',
    description: 'Appends text to the end of a file.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'append_file',
      'Append text to the end of a file. Line endings in the appended text are auto-adjusted to match an existing file.',
      {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Text to append' },
      },
      ['path', 'content'],
    ),
  },
  {
    id: 'insert_at_line',
    label: 'Insert at line',
    description: 'Inserts text at a specific line in a file.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'insert_at_line',
      'Insert lines in a file (1-based). Prefer after_text or before_text anchors over line_number — line numbers from an earlier read go stale after edits in the same turn.',
      {
        path: { type: 'string', description: 'Relative file path' },
        line_number: {
          type: 'integer',
          description: 'Line index to insert before (1-based). Fallback when no anchor is given.',
        },
        after_text: {
          type: 'string',
          description:
            'Insert after the line containing this exact text (resolved at execution time). Prefer over line_number.',
        },
        before_text: {
          type: 'string',
          description:
            'Insert before the line containing this exact text (resolved at execution time). Prefer over line_number.',
        },
        content: { type: 'string', description: 'Text to insert (may include newlines)' },
      },
      ['path', 'content'],
    ),
  },
  {
    id: 'replace_text_in_file',
    label: 'Replace in file',
    description: 'Replaces occurrences of text in a file.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'replace_text_in_file',
      'Replace all occurrences of search text with replacement text in a file. Matching tolerates line-ending differences (CRLF vs LF) and trailing-whitespace drift on each line. Pass expected_count to abort (no write) when the match count differs — a guard against an over-broad search rewriting more sites than intended.',
      {
        path: { type: 'string', description: 'Relative file path' },
        search: { type: 'string', description: 'Text to find' },
        replace: { type: 'string', description: 'Replacement text' },
        expected_count: {
          type: 'integer',
          description:
            'Optional: expected number of occurrences. If the actual count differs, the edit is refused and the real count is reported.',
        },
      },
      ['path', 'search', 'replace'],
    ),
  },
  {
    id: 'search_in_file',
    label: 'Search in file',
    description: 'Finds lines matching a pattern in a file.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'search_in_file',
      'Search for lines matching a regex pattern in a file.',
      withFullResult({
        path: { type: 'string', description: 'Relative file path' },
        pattern: { type: 'string', description: 'Regular expression pattern' },
      }),
      ['path', 'pattern'],
    ),
  },
  {
    id: 'grep',
    label: 'Grep / Search workspace',
    description:
      'Search file contents under a directory (ripgrep-style). Respects .gitignore. Results paginate (default 500 lines).',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'grep',
      'Search file contents (ripgrep-style). Workspace-relative path:line:snippet; respects .gitignore. Paginate with offset (default 500 lines, 128k chars max unless full_result). Prefer files_with_matches or count before content mode.',
      withFullResult({
        pattern: { type: 'string', description: 'Regex or literal pattern' },
        path: { type: 'string', description: 'Directory or file (default workspace root)' },
        glob: { type: 'string', description: 'Glob filter (e.g. *.ts)' },
        case_insensitive: { type: 'boolean' },
        literal: { type: 'boolean', description: 'Treat pattern as literal text' },
        context: { type: 'number', description: 'Context lines (0-5)' },
        head_limit: { type: 'number', description: 'Max output lines per page (max 2000 when result caps are on)' },
        offset: { type: 'number', description: 'Match-line offset for pagination' },
        output_mode: {
          type: 'string',
          enum: ['content', 'count', 'files_with_matches', 'grouped'],
          description: 'content (default), grouped, count, or files_with_matches',
        },
      }),
      ['pattern'],
    ),
  },
  {
    id: 'make_directory',
    label: 'Make directory',
    description: 'Creates a directory (and parents if needed).',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'make_directory',
      'Create a directory, including parent directories if needed.',
      {
        path: { type: 'string', description: 'Relative directory path' },
      },
      ['path'],
    ),
  },
  {
    id: 'move_file',
    label: 'Move / rename',
    description: 'Moves or renames a file or directory.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'move_file',
      'Move or rename a file or directory.',
      {
        source: { type: 'string', description: 'Source relative path' },
        destination: { type: 'string', description: 'Destination relative path' },
      },
      ['source', 'destination'],
    ),
  },
  {
    id: 'copy_file',
    label: 'Copy file',
    description: 'Copies a file to a new path.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'copy_file',
      'Copy a file to a new path.',
      {
        source: { type: 'string', description: 'Source relative path' },
        destination: { type: 'string', description: 'Destination relative path' },
      },
      ['source', 'destination'],
    ),
  },
  {
    id: 'delete_path',
    label: 'Delete path',
    description: 'Deletes a file or directory.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'delete_path',
      'Delete a file or directory (recursive for directories).',
      {
        path: { type: 'string', description: 'Relative path to delete' },
      },
      ['path'],
    ),
  },
  {
    id: 'find_files',
    label: 'Find files',
    description: 'Recursively finds files matching a glob-style pattern.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'find_files',
      'Find files under a directory matching a glob-style pattern. Results cap at 2000 paths unless full_result is true.',
      withFullResult({
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts"' },
        path: {
          type: 'string',
          description: 'Root directory to search (default ".")',
        },
      }),
      ['pattern'],
    ),
  },
  {
    id: 'get_file_metadata',
    label: 'File metadata',
    description: 'Returns size, modification time, and type for a path.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'get_file_metadata',
      'Get file or directory metadata (size, mtime, is directory). Text files include line_ending: CRLF | LF | mixed | none.',
      {
        path: { type: 'string', description: 'Relative path' },
      },
      ['path'],
    ),
  },
  {
    id: 'create_pdf',
    label: 'Create PDF',
    description: 'Creates a PDF file from a title and plain-text body.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'create_pdf',
      'Create a PDF document in the workspace. Use \\n\\n between paragraphs. Path must end with .pdf.',
      {
        path: { type: 'string', description: 'Relative output path ending in .pdf' },
        title: { type: 'string', description: 'Optional document title' },
        body: {
          type: 'string',
          description: 'Plain-text body (use blank lines between paragraphs)',
        },
      },
      ['path', 'body'],
    ),
  },
  {
    id: 'create_spreadsheet',
    label: 'Create spreadsheet',
    description: 'Creates an Excel .xlsx workbook from sheet data.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'create_spreadsheet',
      'Create an Excel .xlsx spreadsheet. Each sheet has a name and rows (array of cell arrays). Path must end with .xlsx.',
      {
        path: { type: 'string', description: 'Relative output path ending in .xlsx' },
        sheets: {
          type: 'array',
          description:
            'Workbook sheets: [{ name?: string, rows: (string|number|boolean|null)[][] }]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet tab name (default Sheet1, Sheet2, …)' },
              rows: {
                type: 'array',
                description: 'Rows of cell values (first row is often headers)',
                items: {
                  type: 'array',
                  items: {},
                },
              },
            },
            required: ['rows'],
          },
        },
      },
      ['path', 'sheets'],
    ),
  },
  {
    id: 'create_word_document',
    label: 'Create Word document',
    description: 'Creates a Word .docx file from structured sections.',
    category: 'files',
    serverRequired: true,
    definition: toolSchema(
      'create_word_document',
      'Create a Word .docx document from headings and paragraphs. Path must end with .docx.',
      {
        path: { type: 'string', description: 'Relative output path ending in .docx' },
        title: { type: 'string', description: 'Optional document title' },
        sections: {
          type: 'array',
          description: 'Document blocks in order',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['heading', 'paragraph'],
                description: 'Block type (default paragraph)',
              },
              text: { type: 'string', description: 'Block text' },
              level: {
                type: 'integer',
                description: 'Heading level 1–6 when type is heading',
              },
            },
            required: ['text'],
          },
        },
      },
      ['path', 'sections'],
    ),
  },

// ── Git ──────────────────────────────────────────────────────────────────────

  {
    id: 'git_status',
    label: 'Git status',
    description: 'Shows porcelain git status for the repository.',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_status',
      'Show git working tree status (porcelain format).',
      {},
    ),
  },
  {
    id: 'git_diff',
    label: 'Git diff',
    description: 'Shows git diff for staged or unstaged changes (truncates large patches).',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_diff',
      'Show git diff for changes. Large patches are truncated with a --numstat summary, complete per-file hunks that fit, and a footer listing omitted files — use path= to fetch one file at a time, or pass full_result: true to skip the automatic size cap. Prefer path= or staged=true for overview-sized calls instead of a repo-wide diff.',
      withFullResult({
        path: { type: 'string', description: 'Optional file path to limit diff (recommended for large changes)' },
        staged: {
          type: 'boolean',
          description: 'If true, diff staged (--cached) changes',
        },
      }),
    ),
  },
  {
    id: 'git_log',
    label: 'Git log',
    description: 'Shows recent commit history on one line each.',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_log',
      'Show recent git commits (oneline).',
      {
        count: {
          type: 'integer',
          description: 'Number of commits to show (default 10)',
        },
      },
    ),
  },
  {
    id: 'git_add',
    label: 'Git add',
    description: 'Stages files for commit.',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_add',
      'Stage files for commit.',
      {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to stage, or ["." ] for all',
        },
      },
      ['paths'],
    ),
  },
  {
    id: 'git_commit',
    label: 'Git commit',
    description: 'Creates a commit with the given message.',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_commit',
      'Create a git commit with a message.',
      {
        message: { type: 'string', description: 'Commit message' },
      },
      ['message'],
    ),
  },
  {
    id: 'git_checkout',
    label: 'Git checkout',
    description: 'Checks out a branch, optionally creating it.',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_checkout',
      'Checkout a git branch.',
      {
        branch: { type: 'string', description: 'Branch name' },
        create: {
          type: 'boolean',
          description: 'If true, create branch with -b before checkout',
        },
      },
      ['branch'],
    ),
  },
  {
    id: 'git_branch',
    label: 'Git branch',
    description: 'Lists branches (most recently committed first); optionally includes remotes.',
    category: 'git',
    serverRequired: true,
    definition: toolSchema(
      'git_branch',
      'List git branches, most recent commit first. The current branch is marked with *. Pass all=true to include remote-tracking branches.',
      {
        all: {
          type: 'boolean',
          description: 'If true, include remote-tracking branches (git branch --all)',
        },
      },
    ),
  },

// ── Code ─────────────────────────────────────────────────────────────────────

  {
    id: 'execute_command',
    label: 'Run command',
    description:
      'Runs a shell command in the project directory. Blocking runs time out after 30s by default; pass timeout_ms for long suites. Use background for dev servers and long-running processes.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'execute_command',
      'Shell command → stdout/stderr. Blocking 30s default; timeout_ms for longer. background + read_command_log for detached; stop + run_id to end. Output over the budget (~128k chars by default) keeps the head and the tail and elides the middle. For a noisy build or test run, set tail_lines (the failure is at the end) or max_output_chars rather than spending the whole budget.',
      withFullResult({
        command: { type: 'string' },
        background: { type: 'boolean' },
        block_until_ms: { type: 'number' },
        timeout_ms: { type: 'number' },
        cwd: { type: 'string' },
        stop: { type: 'boolean' },
        run_id: { type: 'string' },
        tail_lines: {
          type: 'number',
          description: 'Keep only the last N lines of stdout/stderr (combine with head_lines)',
        },
        head_lines: {
          type: 'number',
          description: 'Keep only the first N lines of stdout/stderr',
        },
        max_output_chars: {
          type: 'number',
          description: 'Lower the character budget for this call (min 500; cannot exceed the configured budget)',
        },
      }),
      ['command'],
    ),
  },
  {
    id: 'read_command_log',
    label: 'Read command log',
    description: 'Tail stdout/stderr for a background or recent agent command run.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'read_command_log',
      'Read the log tail for a command run started with execute_command (background: true) or start_background_command. found:false = unknown run_id (not finished). Pass full_result to use the hard byte ceiling instead of the default 64KB tail.',
      withFullResult({
        run_id: { type: 'string', description: 'runId from the start response' },
        max_bytes: {
          type: 'number',
          description: 'Max bytes to read from the log file (default 65536; always honored when set)',
        },
      }),
      ['run_id'],
    ),
  },
  {
    id: 'list_running_commands',
    label: 'List running commands',
    description: 'List active agent shell runs still in the server registry.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'list_running_commands',
      'List non-finished agent command runs (use when run_id was lost). Optional chat_id filters to one chat. orphaned:true = prior server process (readable, not stoppable).',
      {
        chat_id: {
          type: 'string',
          description:
            'Optional chat id to filter by. Omit it unless you have a real id — a placeholder like "current" matches nothing and returns an empty list.',
        },
      },
      [],
    ),
  },
  {
    id: 'stop_command',
    label: 'Stop command',
    description: 'Stop a running agent shell command by run_id.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'stop_command',
      'Stop an active agent command run (background or blocking still in registry).',
      {
        run_id: { type: 'string', description: 'runId from execute_command or list_running_commands' },
      },
      ['run_id'],
    ),
  },
  {
    id: 'start_background_command',
    label: 'Start background command',
    description:
      'Starts a long-running shell command (dev server) with no timeout; returns runId and log path.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'start_background_command',
      'Start a detached background command in the workspace. Use for dev servers (npm run dev, vite, etc.). Do not prefix command with cd; set cwd instead.',
      {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: {
          type: 'string',
          description:
            'Working directory relative to workspace root (e.g. . or apps/web). Default .',
        },
        register_dev_server: {
          type: 'boolean',
          description:
            'When true and startup.md exists, register this run as the workspace dev server for hub status',
        },
      },
      ['command'],
    ),
  },
  {
    id: 'stop_background_command',
    label: 'Stop background command',
    description: 'Stops a background command started with start_background_command.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'stop_background_command',
      'Stop a background command by run_id.',
      {
        run_id: { type: 'string', description: 'runId from start_background_command' },
      },
      ['run_id'],
    ),
  },
  {
    id: 'manage_dev_servers',
    label: 'Manage dev servers',
    description: 'Add, configure, and control workspace dev servers in the Dev Servers registry.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'manage_dev_servers',
      'Registry CRUD + start/stop/restart. Prefer over ad-hoc shells for named servers. startup.md rows: edit file for command/cwd/health; update only port/network/autoStart/worktree. With healthUrl, start may return status starting until the health probe passes (background reconcile; default ~45s timeout).',
      {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete', 'start', 'stop', 'restart'],
        },
        id: { type: 'string', description: 'Server id (default primary for lifecycle)' },
        name: { type: 'string' },
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Relative to workspace root' },
        port: { type: 'number' },
        network: { type: 'string', enum: ['local', 'lan'] },
        healthUrl: { type: 'string' },
        autoStart: { type: 'boolean' },
        worktreeRoot: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      ['action'],
    ),
  },
  {
    id: 'run_javascript',
    label: 'Run JavaScript',
    description: 'Runs JavaScript via Node and returns output.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'run_javascript',
      'Run JavaScript code with Node.js and return output. Large stdout/stderr is truncated unless full_result is true.',
      withFullResult({
        code: { type: 'string', description: 'JavaScript source to execute' },
      }),
      ['code'],
    ),
  },
  {
    id: 'run_python',
    label: 'Run Python',
    description: 'Runs Python code and returns output.',
    category: 'code',
    serverRequired: true,
    definition: toolSchema(
      'run_python',
      'Run Python code and return output. Large stdout/stderr is truncated unless full_result is true.',
      withFullResult({
        code: { type: 'string', description: 'Python source to execute' },
      }),
      ['code'],
    ),
  },

// ── Agents ───────────────────────────────────────────────────────────────────

  {
    id: 'spawn_sub_agent',
    label: 'Spawn sub-agent',
    description:
      'Starts an isolated sub-agent with its own model, tools, and context. By default returns immediately; the summary is delivered automatically when the run finishes.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'spawn_sub_agent',
      'Spawn a sub-agent of the given type to complete a task in isolation.',
      {
        type: {
          type: 'string',
          description:
            'Sub-agent type id (e.g. researcher, explore, generalPurpose, shell, debugger)',
        },
        task: { type: 'string', description: 'Task description for the sub-agent' },
        wait: {
          type: 'boolean',
          description:
            'If true, block until the sub-agent finishes and return the aggregate JSON in this tool result. Default false — you do not need to poll; completion is pushed as a new turn.',
        },
        category: {
          type: 'string',
          enum: ['build', 'fix', 'test', 'research'],
          description: 'Work category when spawned from a leftover V1 board task chat',
        },
        board_task_id: {
          type: 'string',
          description: 'Linked leftover board task id (e.g. W1-A)',
        },
      },
      ['type', 'task'],
    ),
  },
  {
    id: 'todo_write',
    label: 'Updating todo list',
    description:
      'Replace the build progress checklist with an ordered list of steps (max 20). Keep exactly one item in_progress.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'todo_write',
      'Update the visible build progress checklist. Pass the full ordered list each call (replace-all). Use 3–8 concrete steps; mark completed items as you finish.',
      {
        todos: {
          type: 'array',
          description: 'Full replacement checklist (empty clears the list)',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Step description (max 140 chars)' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Step status',
              },
            },
            required: ['text', 'status'],
          },
        },
      },
      ['todos'],
    ),
  },
  {
    id: 'issue_add',
    label: 'Issue add',
    description: 'Create an issue in the Issues app (works from any chat).',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_add',
      'File a new issue in the Issues tracker.',
      {
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'Markdown body' },
        type: { type: 'string', description: 'Issue type id (default task)' },
        priority: { type: 'string', description: 'Priority id (default none)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels' },
        issue_id: { type: 'string', description: 'Optional stable id (MIN-12)' },
        parent_id: { type: 'string', description: 'Parent issue id for a sub-issue' },
        project_id: { type: 'string', description: 'Project id' },
      },
      ['title'],
    ),
  },
  {
    id: 'issue_search',
    label: 'Issue search',
    description: 'Query open issues with field selection and paging.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_search',
      'Search open issues with filters, field selection, and paging. Closed (done/canceled) issues are omitted unless you pass include_done, or filter by a closed status.',
      {
        query: { type: 'string', description: 'Substring over id, title, description, labels' },
        status: { type: 'string', description: 'Status id filter (a closed status also returns closed issues)' },
        assignee: { type: 'string', description: 'Assignee id filter' },
        label: { type: 'string', description: 'Label filter' },
        parent_id: { type: 'string', description: 'Parent issue id filter' },
        project_id: { type: 'string', description: 'Project id filter' },
        scope: { type: 'string', description: 'current_workspace (default) or all' },
        include_done: {
          type: 'boolean',
          description: 'Also return closed (done/canceled) issues. Default false.',
        },
        hide_done: { type: 'boolean', description: 'Omit closed issues (the default); pass false to include them' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields to return (default id, title, status, priority, type, updatedAt)',
        },
        limit: { type: 'number', description: 'Page size (max 100)' },
        offset: { type: 'number', description: 'Page offset' },
      },
      [],
    ),
  },
  {
    id: 'issue_comment',
    label: 'Issue comment',
    description: 'Append a comment to an issue timeline.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_comment',
      'Append a markdown comment to an issue timeline.',
      {
        issue_id: { type: 'string', description: 'Issue id (KEY-n)' },
        body: { type: 'string', description: 'Comment body' },
        author: { type: 'string', description: 'Optional author label' },
      },
      ['issue_id', 'body'],
    ),
  },
  {
    id: 'issue_assign',
    label: 'Issue assign',
    description: 'Set the accountable human or queue a work agent.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_assign',
      'Set assignee and/or queue a work agent (does not start a run).',
      {
        issue_id: { type: 'string', description: 'Issue id (KEY-n)' },
        assignee: { type: 'string', description: "Human assignee id ('me' locally)" },
        assignee_label: { type: 'string', description: 'Assignee display name' },
        agent: { type: 'string', description: 'Work agent id to queue' },
        clear_agent: { type: 'boolean', description: 'Clear queued agent' },
      },
      ['issue_id'],
    ),
  },
  {
    id: 'issue_unlink',
    label: 'Issue unlink',
    description: 'Remove a link that issue_link added.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_unlink',
      'Remove a code ref, git link, chat link, or issue relation.',
      {
        issue_id: { type: 'string', description: 'Issue id (KEY-n)' },
        path: { type: 'string', description: 'Code ref path to remove' },
        ref: { type: 'string', description: 'Git ref to remove' },
        target_issue_id: { type: 'string', description: 'Related issue id to remove' },
        chat_id: { type: 'string', description: 'Linked chat id to remove' },
      },
      ['issue_id'],
    ),
  },
  {
    id: 'issue_move',
    label: 'Issue move',
    description: 'Set status and manual rank in one call.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_move',
      'Set issue status and rank in one call.',
      {
        issue_id: { type: 'string', description: 'Issue id (KEY-n)' },
        status: { type: 'string', description: 'Destination status id' },
        before_issue_id: { type: 'string', description: 'Place above this issue' },
        after_issue_id: { type: 'string', description: 'Place below this issue' },
        to_top: { type: 'boolean', description: 'Place at column top' },
      },
      ['issue_id'],
    ),
  },
  {
    id: 'issue_update',
    label: 'Issue update',
    description: 'Update an issue status, priority, title, or notes.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_update',
      'Patch one issue by issue_id.',
      {
        issue_id: { type: 'string', description: 'Issue id (KEY-n) or legacy bug id' },
        title: { type: 'string' },
        description: { type: 'string' },
        type: {
          type: 'string',
          description: 'Issue type id from Settings → Issues',
        },
        status: {
          type: 'string',
          description: 'Status id from Settings → Issues',
        },
        priority: {
          type: 'string',
          description: 'Priority id from Settings → Issues',
        },
        labels: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        plan_path: { type: 'string', description: 'Workspace-relative plan path' },
      },
      ['issue_id'],
    ),
  },
  {
    id: 'issue_get_state',
    label: 'Issue get state',
    description: 'Return a page of open issues from the snapshot (current workspace by default).',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_get_state',
      'Read the issues store header (version, next id, project key) plus one page of open issues. Returns compact rows by default — ask for fields like description or comments only when you need them, and page with limit/offset. Closed (done/canceled) issues are omitted unless you pass include_done or filter by a closed status. Use issue_search when you have a query to filter by.',
      {
        workspace_scope: {
          type: 'string',
          enum: ['current_workspace', 'all'],
          description: 'Workspace filter (default current_workspace)',
        },
        status: {
          type: 'string',
          description: 'Optional status filter, or "all" (a closed status also returns closed issues)',
        },
        include_done: {
          type: 'boolean',
          description: 'Also return closed (done/canceled) issues. Default false.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields to return (default id, title, status, priority, type, updatedAt)',
        },
        limit: { type: 'number', description: 'Page size (default 25, max 100)' },
        offset: { type: 'number', description: 'Page offset' },
      },
      [],
    ),
  },
  {
    id: 'issue_link',
    label: 'Issue link',
    description: 'Append code refs, git links, chat id, and/or related issues (append-only).',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_link',
      'Append code refs, git links, chat id, and/or issue_refs to an issue.',
      {
        issue_id: { type: 'string', description: 'Issue id (KEY-n)' },
        code_refs: {
          type: 'array',
          description: 'File/line refs',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              start_line: { type: 'number' },
              end_line: { type: 'number' },
              snippet: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
        git_links: {
          type: 'array',
          description: 'Git/GitHub links',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['commit', 'branch', 'pr', 'github-issue'] },
              ref: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
        chat_id: { type: 'string', description: 'Chat id' },
        issue_refs: {
          type: 'array',
          description: 'Related issue ids or { issue_id, kind?, note? }',
          items: {
            oneOf: [
              { type: 'string', description: 'Target issue id' },
              {
                type: 'object',
                properties: {
                  issue_id: { type: 'string' },
                  kind: {
                    type: 'string',
                    enum: [
                      'related',
                      'blocks',
                      'blocked-by',
                      'duplicate-of',
                      'parent',
                      'sub-issue',
                    ],
                  },
                  note: { type: 'string' },
                },
              },
            ],
          },
        },
      },
      ['issue_id'],
    ),
  },
  {
    id: 'issue_delete',
    label: 'Issue delete',
    description: 'Permanently remove one or more issues from the Issues tracker.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'issue_delete',
      'Delete issue(s) by issue_id (KEY-n or legacy bug id). Supports bulk delete via issue_ids.',
      {
        issue_id: {
          type: 'string',
          description: 'Single issue id to delete (KEY-n or legacy bug id)',
        },
        issue_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional bulk delete — array of issue ids',
        },
      },
      [],
    ),
  },
  {
    id: 'cancel_sub_agent',
    label: 'Cancel sub-agent',
    description: 'Cancels a running or queued sub-agent by run id.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'cancel_sub_agent',
      'Cancel a sub-agent run by run_id.',
      {
        run_id: { type: 'string', description: 'Run id returned from spawn_sub_agent' },
        reason: { type: 'string', description: 'Optional cancellation reason' },
      },
      ['run_id'],
    ),
  },
  {
    id: 'list_sub_agents',
    label: 'List sub-agents',
    description:
      'Lists sub-agent runs for this chat session (queued, running, or finished), including prior parent turns.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'list_sub_agents',
      'Return run ids, types, status, and short task previews for this chat session.',
      {},
      [],
    ),
  },
  {
    id: 'get_sub_agent_status',
    label: 'Get sub-agent status',
    description:
      'Reads live status, summary (when complete), tool counts, and a short preview of the latest transcript for one run id.',
    category: 'agents',
    serverRequired: false,
    definition: toolSchema(
      'get_sub_agent_status',
      'Inspect one sub-agent run in this chat session (any parent turn).',
      {
        run_id: { type: 'string', description: 'Run id from spawn_sub_agent or list_sub_agents' },
      },
      ['run_id'],
    ),
  },

// ── Browser ──────────────────────────────────────────────────────────────────

  {
    id: 'browser_reserve_tab',
    label: 'Browser reserve tab',
    description: 'Reserve an isolated headless browser tab for this agent run.',
    category: 'browser',
    serverRequired: true,
    definition: toolSchema(
      'browser_reserve_tab',
      'Reserve an isolated agent browser tab. The returned tab_id is stable and must be passed to every later browser call. Agent tabs never appear in the user preview pane.',
      {
        surface: { type: 'string', enum: ['agent'], description: 'Use the isolated agent browser.' },
        url: { type: 'string', description: 'Optional absolute http(s) URL to open after reserving' },
        width: { type: 'number', description: 'Optional viewport width in CSS pixels (200–4000)' },
        height: { type: 'number', description: 'Optional viewport height in CSS pixels (200–4000)' },
      },
    ),
  },
  {
    id: 'browser_release_tab',
    label: 'Browser release tab',
    description: 'Release an owned agent browser tab for user inspection or reassignment.',
    category: 'browser',
    serverRequired: true,
    definition: toolSchema(
      'browser_release_tab',
      'Release an agent browser tab without closing it. The user can keep inspecting or reassigning the released tab.',
      {
        surface: { type: 'string', enum: ['agent'], description: 'Use the isolated agent browser.' },
        tab_id: { type: 'string', description: 'Owned agent tab id from browser_reserve_tab' },
      },
      ['tab_id'],
    ),
  },

  {
    id: 'browser_list',
    label: 'Browser list tabs',
    description: 'Lists browser tabs on the selected surface.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_list',
      'List browser tabs. surface="agent" (default) lists only tabs owned by this agent; surface="user" lists built-in preview tabs.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
      },
    ),
  },
  {
    id: 'browser_navigate',
    label: 'Browser navigate',
    description: 'Navigate an explicitly targeted browser tab (allowlist enforced).',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_navigate',
      'Navigate a browser tab. surface="agent" (default) uses the isolated headless browser; surface="user" targets a visible preview tab. Always pass tab_id.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Explicit tab id from browser_reserve_tab or browser_list' },
        url: { type: 'string', description: 'URL to navigate to' },
      },
      ['tab_id', 'url'],
    ),
  },
  {
    id: 'request_browser_origin_access',
    label: 'Request browser origin access',
    description:
      'Apply browser allowlist approval after ask_question, or show ask_question if decision omitted.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'request_browser_origin_access',
      [
        'Apply browser navigation allowlist approval for browser_navigate.',
        'Preferred flow: call ask_question first (options once / persist / deny), then call this tool with decision "once" or "persist".',
        'If decision is omitted and the origin is blocked, the client shows the same ask_question cards.',
      ].join(' '),
      {
        url: { type: 'string', description: 'Full http(s) URL the agent wants to open' },
        decision: {
          type: 'string',
          enum: ['once', 'persist'],
          description:
            'User choice from ask_question (once = single navigation, persist = add origin pattern). Omit to prompt via ask_question.',
        },
      },
      ['url'],
    ),
  },
  {
    id: 'browser_new_tab',
    label: 'Browser new tab',
    description: 'Open a tab on the selected browser surface.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_new_tab',
      'Open a tab. surface="agent" (default) is an alias for browser_reserve_tab; surface="user" opens a visible preview tab.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        url: {
          type: 'string',
          description: 'Optional http(s) URL or workspace path to load in the new tab',
        },
      },
    ),
  },
  {
    id: 'browser_switch_tab',
    label: 'Browser switch tab',
    description: 'Select or validate a browser tab by id.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_switch_tab',
      'For surface="user", switch the visible preview tab. For surface="agent" (default), validate and describe an owned tab without changing the viewer.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Preview tab id from browser_list' },
      },
      ['tab_id'],
    ),
  },
  {
    id: 'browser_close_tab',
    label: 'Browser close tab',
    description: 'Close an explicitly targeted browser tab.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_close_tab',
      'Close a tab on surface="agent" (default) or surface="user". Closing an agent tab requires current ownership.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Preview tab id from browser_list' },
      },
      ['tab_id'],
    ),
  },
  {
    id: 'browser_snapshot',
    label: 'Browser snapshot',
    description: 'Page snapshot with [uid] markers for click/fill.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_snapshot',
      'Capture an accessibility snapshot of an explicit tab (required before click/fill).',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Explicit tab id' },
      },
      ['tab_id'],
    ),
  },
  {
    id: 'browser_click',
    label: 'Browser click',
    description: 'Click an element by snapshot uid.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_click',
      'Click an element identified by uid from browser_snapshot.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Explicit tab id' },
        uid: { type: 'number', description: 'Element uid from snapshot' },
      },
      ['tab_id', 'uid'],
    ),
  },
  {
    id: 'browser_fill',
    label: 'Browser fill',
    description: 'Fill an input by snapshot uid.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_fill',
      'Fill an input identified by uid from browser_snapshot.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Explicit tab id' },
        uid: { type: 'number', description: 'Element uid from snapshot' },
        value: { type: 'string', description: 'Text to enter' },
      },
      ['tab_id', 'uid', 'value'],
    ),
  },
  {
    id: 'browser_eval',
    label: 'Browser eval',
    description: 'Evaluate JavaScript in the page context.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_eval',
      'Run JavaScript in an explicit browser tab. surface="agent" (default) uses the isolated headless browser; surface="user" uses the visible preview page.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Explicit tab id' },
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
      },
      ['tab_id', 'expression'],
    ),
  },
  {
    id: 'browser_screenshot',
    label: 'Browser screenshot',
    description: 'Capture a PNG screenshot of an explicit browser tab.',
    category: 'browser',
    serverRequired: false,
    definition: toolSchema(
      'browser_screenshot',
      'Capture a PNG screenshot of an explicit browser tab. On a vision model the PNG is attached as image input — inspect that image; do not fetch the file URL.',
      {
        surface: { type: 'string', enum: ['agent', 'user'], description: 'Browser surface. Defaults to agent. "user" is the user\'s own visible preview tab: only when they ask for it, never as a fallback.' },
        tab_id: { type: 'string', description: 'Explicit tab id' },
      },
      ['tab_id'],
    ),
  },
  {
    id: 'load_impeccable_context',
    label: 'Load Impeccable context',
    description:
      'Load PRODUCT.md, DESIGN.md, and optional .impeccable/design.json from the workspace as JSON.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'load_impeccable_context',
      'Returns JSON with product, design, hasDesignJson, and designJson (null until sidecar exists). Use before UI edits (not a workspace-relative node path).',
      {},
      [],
    ),
  },
  {
    id: 'load_aesthetics_reference',
    label: 'Load frontend aesthetics reference',
    description:
      'Load the bundled frontend-aesthetics reference (visual hierarchy, density, color, type, motion, specificity ladder).',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'load_aesthetics_reference',
      'Returns the frozen frontend-aesthetics reference markdown. Call once per session before proposing visual/UI changes.',
      {},
      [],
    ),
  },
  {
    id: 'run_impeccable',
    label: 'Run Impeccable',
    description:
      'Run Impeccable CLI/script runner only (detect, live) — not harness commands (teach, audit, shape, …).',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'run_impeccable',
      'Run the bundled Impeccable CLI (detect, live) or live script in the active workspace (60s timeout). detect scans local UI source (src/ui, src/styles, index.html when present) — not the whole repo and not http(s) URLs. Pass target as a file or folder to narrow further. Use /impeccable <cmd> for teach, audit, shape, craft, polish, and other harness commands.',
      {
        command: {
          type: 'string',
          description: 'CLI/script sub-command only: detect or live',
        },
        target: {
          type: 'string',
          description:
            'Optional local file or folder (space-separated list ok). Omitted detect uses UI roots (src/ui, src/styles, index.html) or conventional source dirs — not "." and not URLs.',
        },
      },
      ['command'],
    ),
  },
  {
    id: 'recall_chat_context',
    label: 'Recall chat context',
    description:
      'Search archived turns for the active chat via Brain (browser-side).',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'recall_chat_context',
      'Recall facts from archived chat turns stored in the Brain wiki for the active chat. Returns verbatim source quotes and page paths. Use when you need a decision or detail from earlier in a long conversation that is no longer in the live context.',
      {
        query: {
          type: 'string',
          description: 'Natural-language recall query',
        },
        topK: {
          type: 'number',
          description: 'Max facts to return (default 5)',
        },
        scope: {
          type: 'string',
          enum: ['chat', 'workspace'],
          description:
            'Retrieve scope: chat (default, active chat only) or workspace (all archived chats in workspace)',
        },
      },
      ['query'],
    ),
  },
  {
    id: 'recall_turn_full',
    label: 'Recall turn full',
    description: 'Reassemble one original chat turn verbatim (browser-side).',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'recall_turn_full',
      'Reassemble the verbatim text of a prior user turn (0-based index) from chat runs or history. Tool results in that turn are elided by default and the text is windowed — a tool-heavy turn replayed in full re-injects its whole tool history. Prefer recall_chat_context when you only need a fact.',
      {
        turnIndex: {
          type: 'number',
          description: '0-based user turn index to recall',
        },
        include_tool_results: {
          type: 'boolean',
          description: 'Include tool result bodies verbatim (default false — they are the bulk of a turn)',
        },
        max_chars: {
          type: 'number',
          description: 'Characters to return in this slice (default 12000, max 120000)',
        },
        offset_chars: {
          type: 'number',
          description: 'Character offset to start from, for paging a long turn',
        },
      },
      ['turnIndex'],
    ),
  },
  {
    id: 'brain_search',
    label: 'Brain search',
    description:
      'Semantic/hybrid search over the Brain wiki (workspace-scoped). Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'brain_search',
      'Search the Brain wiki for relevant pages using keyword and optional semantic hybrid retrieval. Use for fuzzy prose lookup (why, decisions, domain model, gotchas). Scoped to the active workspace plus global pages.',
      {
        query: {
          type: 'string',
          description: 'Natural-language search query',
        },
        limit: {
          type: 'number',
          description: 'Max pages to return (default 8, max 20)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag filter',
        },
      },
      ['query'],
    ),
  },
  {
    id: 'brain_read_page',
    label: 'Brain read page',
    description: 'Read a Brain wiki page by relative path. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'brain_read_page',
      'Read one wiki page from ~/.minnow/brain/pages. Use the full relative path from brain_search (e.g. minnow/architecture.md, facts/api-preference.md) or a matched page id.',
      {
        path: {
          type: 'string',
          description:
            'Relative path under pages/ from brain_search (e.g. minnow/architecture.md) or a page id',
        },
      },
      ['path'],
    ),
  },
  {
    id: 'brain_list',
    label: 'Brain list pages',
    description: 'List the Brain wiki page tree. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'brain_list',
      'Return the nested tree of wiki pages (metadata only) under ~/.minnow/brain/pages/.',
      {},
    ),
  },
  {
    id: 'minnow_docs_search',
    label: 'Minnow docs search',
    description: 'Search the official shipped Minnow user manual. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'minnow_docs_search',
      'Search official Minnow user manual pages (`documentation/manual/`). Use for Minnow setup, apps, modes, tools, settings, and troubleshooting — not repo architecture (`context.md`). Results include source paths for citations.',
      {
        query: {
          type: 'string',
          description: 'Natural-language documentation query',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 8, max 20)',
        },
        section: {
          type: 'string',
          description: 'Optional exact catalog section such as Get started or Apps',
        },
      },
      ['query'],
    ),
  },
  {
    id: 'minnow_docs_read',
    label: 'Minnow docs read',
    description: 'Read a user manual page from the shipped Minnow wiki. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'minnow_docs_read',
      'Read one user manual page from a path returned by minnow_docs_search or minnow_docs_list. Cite the returned Source path when answering.',
      {
        path: {
          type: 'string',
          description: 'Allowlisted path such as documentation/manual/get-started/install.md',
        },
      },
      ['path'],
    ),
  },
  {
    id: 'minnow_docs_list',
    label: 'Minnow docs list',
    description: 'List the shipped Minnow user manual catalog. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'minnow_docs_list',
      'List user manual metadata (`documentation/manual/`), optionally restricted to a path prefix.',
      {
        prefix: {
          type: 'string',
          description: 'Optional path prefix such as documentation/manual/get-started/',
        },
      },
    ),
  },
  {
    id: 'brain_write_page',
    label: 'Brain write page',
    description: 'Create or update a Brain wiki page. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'brain_write_page',
      'Create or update a wiki page (YAML frontmatter + markdown body). Use for durable knowledge: decisions, domain model, conventions, gotchas. Paths are sandboxed under ~/.minnow/brain/pages/.',
      {
        path: {
          type: 'string',
          description: 'Relative path under pages/ ending in .md',
        },
        title: {
          type: 'string',
          description: 'Page title',
        },
        body: {
          type: 'string',
          description: 'Markdown body (may include [[wikilinks]])',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for retrieval',
        },
        summary: {
          type: 'string',
          description: 'Optional one-line summary for the catalog',
        },
      },
      ['path', 'title', 'body'],
    ),
  },
  {
    id: 'brain_append_log',
    label: 'Brain append log',
    description: 'Append a changelog entry to brain log.md. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'brain_append_log',
      'Append a timestamped line to ~/.minnow/brain/log.md (wiki changelog).',
      {
        entry: {
          type: 'string',
          description: 'Changelog note to append',
        },
      },
      ['entry'],
    ),
  },
  {
    id: 'brain_ingest_source',
    label: 'Brain ingest source',
    description: 'Ingest a non-code source into the Brain wiki. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'brain_ingest_source',
      'Store raw source text under ~/.minnow/brain/sources/ and synthesize one or more wiki pages from it.',
      {
        content: {
          type: 'string',
          description: 'Raw source text to ingest',
        },
        filename: {
          type: 'string',
          description: 'Optional original filename hint',
        },
        title: {
          type: 'string',
          description: 'Optional source title for synthesis',
        },
      },
      ['content'],
    ),
  },
  {
    id: 'manage_brain',
    label: 'Manage brain',
    description:
      'Delete or clear Brain wiki data (pages, archives, proposals, code index, sources). Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'manage_brain',
      'Destructive Brain ops. Requires user approval; confirmed: true.',
      {
        action: {
          type: 'string',
          enum: [
            'delete_page',
            'clear_wiki',
            'delete_archive',
            'clear_proposals',
            'clear_code_index',
            'clear_sources',
          ],
        },
        path: { type: 'string' },
        chatId: { type: 'string' },
        workspaceKey: { type: 'string' },
        scope: {
          type: 'string',
          enum: ['pending', 'all'],
        },
        all: { type: 'boolean' },
        archive: { type: 'boolean' },
        confirmed: { type: 'boolean' },
      },
      ['action'],
    ),
  },
  {
    id: 'search_settings',
    label: 'Search settings',
    description:
      'Search the Minnow Settings catalog by label or keyword. Returns field keys, types, and sensitivity — never secret values.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'search_settings',
      'Find settings fields before reading or changing them. Use when the user mentions a setting but you are unsure of the canonical key.',
      {
        query: {
          type: 'string',
          description: 'Search text (matches label, key, keywords)',
        },
        category: {
          type: 'string',
          description: 'Optional filter: general, appearance, models, agents, integrations, advanced',
        },
        area: {
          type: 'string',
          description: 'Optional settings section id filter (e.g. search, tools, general)',
        },
      },
      ['query'],
    ),
  },
  {
    id: 'read_diagnostics',
    label: 'Read diagnostics',
    description:
      'Read recent local errors and health probes from ~/.minnow/logs (redacted). Debug mode helper — no telemetry.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'read_diagnostics',
      'Return grouped recent errors and subsystem health from local diagnostics logs. Use when the user asks why something failed. Output is redacted (no secrets or home paths).',
      {
        format: {
          type: 'string',
          enum: ['summary', 'report'],
          description: 'summary = JSON health + errors; report = markdown bundle',
        },
        source: {
          type: 'string',
          enum: ['all', 'renderer', 'server', 'electron'],
          description: 'Filter errors by capture source',
        },
        maxLines: {
          type: 'number',
          description: 'Max error groups to include (default 50)',
        },
      },
    ),
  },
  {
    id: 'get_settings',
    label: 'Get settings',
    description:
      'Read current settings values by key or filter. Secret fields return [redacted] / configured flags only.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'get_settings',
      'Read settings values. Provide keys OR category/area filters (mutually exclusive). Browser-only fields may require the Settings UI.',
      {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical settings keys from search_settings',
        },
        category: {
          type: 'string',
          description: 'Read all server-backed fields in a category',
        },
        area: {
          type: 'string',
          description: 'Read all server-backed fields in a settings section',
        },
      },
    ),
  },
  {
    id: 'update_settings',
    label: 'Update settings',
    description:
      'Change Minnow Settings after user approval. Batch multiple keys in one call. Secret/dangerous fields require confirmed: true.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'update_settings',
      'Apply settings changes. Always search_settings or get_settings first for unfamiliar keys. Summarize intended changes in chat before calling.',
      {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: {},
            },
            required: ['key', 'value'],
          },
          description: 'List of { key, value } patches',
        },
        confirmed: {
          type: 'boolean',
          description: 'Required true after approval for secret or dangerous fields',
        },
      },
      ['changes'],
    ),
  },
  {
    id: 'get_appearance',
    label: 'Get appearance',
    description:
      'Read current Minnow appearance: theme family/mode, custom colors, and fonts.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'get_appearance',
      'Return JSON snapshot of browser-local appearance (theme, customColors, fonts). Desktop mode only.',
      {},
      [],
    ),
  },
  {
    id: 'update_appearance',
    label: 'Update appearance',
    description:
      'Change theme, custom color tokens, or fonts after user approval. Desktop mode only.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'update_appearance',
      'Batch patch appearance. All fields optional. Call get_appearance first. Summarize intended changes in chat before calling.',
      {
        patch: {
          type: 'object',
          description: 'Appearance patch object',
          properties: {
            theme: {
              type: 'object',
              properties: {
                family: {
                  type: 'string',
                  enum: ['swamp', 'desert', 'ocean', 'coral', 'mono', 'matrix', 'human', 'mint'],
                },
                mode: { type: 'string', enum: ['dark', 'light', 'system'] },
              },
            },
            customColors: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                advanced: { type: 'boolean' },
                seeds: {
                  type: 'object',
                  properties: {
                    bg: { type: 'string' },
                    fg: { type: 'string' },
                    accent: { type: 'string' },
                    danger: { type: 'string' },
                  },
                },
                tokens: { type: 'object', additionalProperties: { type: 'string' } },
                replaceTokens: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
            fonts: {
              type: 'object',
              properties: {
                ui: {},
                mono: {},
              },
            },
          },
        },
      },
      ['patch'],
    ),
  },
  {
    id: 'upload_appearance_asset',
    label: 'Upload appearance asset',
    description:
      'Import a workspace font into browser appearance storage. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: false,
    definition: toolSchema(
      'upload_appearance_asset',
      'Read a workspace file and store it in IndexedDB for custom fonts. Follow with update_appearance to apply the font to a slot.',
      {
        kind: { type: 'string', enum: ['font'] },
        path: { type: 'string', description: 'Workspace-relative file path' },
        slot: { type: 'string', enum: ['ui', 'mono'], description: 'Font slot when kind is font' },
        familyName: { type: 'string', description: 'CSS font-family name for uploaded fonts' },
      },
      ['kind', 'path'],
    ),
  },
  {
    id: 'save_memory',
    label: 'Save memory',
    description:
      'Persist a discrete fact to pages/facts/ (alias for brain_write_page). Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'save_memory',
      'Save a durable fact under ~/.minnow/brain/pages/facts/ for retrieval in later sessions. Alias for writing a facts/ wiki page. Use when the user asks you to remember something, or when you learn a stable preference, convention, or project fact. Do not save secrets, one-off task state, or ephemeral details.',
      {
        title: {
          type: 'string',
          description: 'Short label for the memory (e.g. "Preferred test runner")',
        },
        body: {
          type: 'string',
          description: 'Full note text to store',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for retrieval (e.g. ["testing", "preferences"])',
        },
      },
      ['title', 'body'],
    ),
  },
  {
    id: 'repo_map',
    label: 'Repo map',
    description:
      'Token-budgeted signature map of the indexed workspace codebase. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'repo_map',
      'Ranked signatures (path:line, no bodies) for the workspace. Pass focus to get one file or feature; without it you get the global top of the ranking.',
      {
        focus: {
          type: 'string',
          description: 'File path or feature/symbol substring. Almost always worth passing.',
        },
        token_budget: {
          type: 'number',
          description: 'Result size cap (default 4000)',
        },
      },
    ),
  },
  {
    id: 'find_symbol',
    label: 'Find symbol',
    description: 'Search the code index for a symbol definition. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'find_symbol',
      'Where is this symbol defined? Ranked definitions by name, as path:line + signature. Names only — grep for strings, repo_map focus for a file.',
      {
        query: {
          type: 'string',
          description: 'Symbol name',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10)',
        },
      },
      ['query'],
    ),
  },
  {
    id: 'who_calls',
    label: 'Who calls',
    description: 'List incoming call edges for a symbol. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'who_calls',
      'Every call site of a symbol, from the call graph — exact, unlike grep, which also matches imports, docs and same-named functions elsewhere. Use before changing a signature.',
      {
        symbol: {
          type: 'string',
          description: 'Symbol name (qualified when ambiguous)',
        },
      },
      ['symbol'],
    ),
  },
  {
    id: 'read_symbol',
    label: 'Read symbol',
    description: 'Read the current source span for a symbol. Requires Minnow running locally.',
    category: 'utility',
    serverRequired: true,
    definition: toolSchema(
      'read_symbol',
      'Read a definition from disk by name — the exact span, without guessing an end line as read_file_range would.',
      {
        symbol: {
          type: 'string',
          description: 'Symbol name (qualified when ambiguous)',
        },
      },
      ['symbol'],
    ),
  },

// ── LSP ──────────────────────────────────────────────────────────────────────

  {
    id: 'get_lsp_diagnostics',
    label: 'LSP diagnostics',
    description: 'Formatted language-server diagnostics for a project file.',
    category: 'lsp',
    serverRequired: true,
    definition: toolSchema(
      'get_lsp_diagnostics',
      'Type and lint errors for one file from its language server. Run after editing a file, before building.',
      {
        path: {
          type: 'string',
          description: 'Project-relative file path (e.g. src/main.ts)',
        },
      },
      ['path'],
    ),
  },
];

// ── Lookup ───────────────────────────────────────────────────────────────────

/** Look up a catalog entry by stable tool id. */
/** @param {string} id */
export function getToolById(id) {
  return BUILT_IN_TOOLS.find((tool) => tool.id === id);
}
