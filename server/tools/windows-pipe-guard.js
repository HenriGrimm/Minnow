/**
 * Guard against Unix-only pipe targets when agents run commands through cmd.exe on Windows.
 */

/** Detect `| binary` segments (tight list — sort/find exist on Windows). No `g` flag: `.exec()` with /g sticks lastIndex and skips the next call. */
const PIPE_TO_UNIX_BINARY = /\|\s*(tail|head|wc|less|sed|awk|grep)\b/i;

/**
 * Suggest alternatives when a pipe targets a Unix-only binary under cmd.exe.
 * @param {string} command Raw shell command.
 * @returns {string | null} Hint message, or null when allowed.
 */
export function assessUnixPipeOnWindows(command) {
  if (process.platform !== 'win32') return null;
  if (typeof command !== 'string' || !command.trim()) return null;

  const text = command.trim();
  const match = PIPE_TO_UNIX_BINARY.exec(text);
  if (match) {
    const binary = match[1].toLowerCase();
    const alternative = binary === 'grep'
      ? 'use the `grep` tool for searching'
      : binary === 'tail' || binary === 'head'
        ? 'use `tail_lines` or `head_lines` on execute_command'
        : 'use a Windows-native command or an available tool';
    return `Error: \`${binary}\` isn't available under cmd.exe — ${alternative}.`;
  }
  return null;
}
