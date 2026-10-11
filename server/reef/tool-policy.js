/** Reef agents edit source; the host owns commands, Git, checks, and exports. */
export const REEF_TOOLS = new Set(['read_file', 'read_file_range', 'list_directory', 'find_files', 'search_in_file', 'grep', 'save_file', 'replace_text_in_file', 'make_directory']);
export function reefToolAllowed(name, phase = 'build') {
  return REEF_TOOLS.has(name) && (phase === 'build' || ['read_file', 'read_file_range', 'list_directory', 'find_files', 'search_in_file', 'grep'].includes(name));
}
export function reefProtectedPath(args) {
  return Object.entries(args).some(([key, value]) => /path|file|directory/i.test(key) && typeof value === 'string' &&
    /(^|[\\/])(\.git|\.npmrc|node_modules|\.env[^\\/]*|reef-host)([\\/]|$)/i.test(value));
}
