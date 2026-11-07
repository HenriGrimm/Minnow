/** Synthetic only: stable long prose, code and reasoning, with no profile data. */
export function longChatHistory(count) {
  const prose = 'Deterministic transcript fixture paragraph. '.repeat(48);
  const code = '```ts\n' + 'const value = "fixture";\n'.repeat(48) + '```';
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Message ${index}\n${prose}\n${code}`,
    ...(index % 2 ? { thinking: ['Synthetic reasoning. '.repeat(48)], usage: { total_tokens: index + 1 } } : {}),
  }));
}
