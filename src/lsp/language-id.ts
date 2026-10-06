/**
 * Map project-relative paths to LSP languageId (matches server/lsp/manager.js didOpen).
 */

export function languageIdForPath(relativePath: string): string {
  const ext = relativePath.includes('.')
    ? relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()
    : '';
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.htm': 'html',
    '.py': 'python',
    '.pyi': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.fake': 'fake',
    '.gd': 'gdscript',
    '.gdshader': 'gdshader',
    '.tscn': 'gdscene',
    '.tres': 'gdresource',
  };
  return map[ext] ?? 'plaintext';
}
