/** Read the explicit plan type; unmarked documents retain the legacy board format. */
export function readPlanType(markdown) {
  const frontMatter = String(markdown).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontMatter === undefined) return 'orchestrate';
  const fields = frontMatter.split(/\r?\n/).filter((line) => /^planType\s*:/.test(line));
  if (fields.length === 0) return 'orchestrate';
  if (fields.length !== 1) return 'invalid';
  const value = fields[0].replace(/^planType\s*:\s*/, '').trim();
  const scalar = value.match(/^(?:"(build|orchestrate)"|'(build|orchestrate)'|(build|orchestrate))(?:\s+#.*)?$/);
  return scalar ? scalar[1] || scalar[2] || scalar[3] : 'invalid';
}

/** Board intake must never interpret a single-chat plan as a task graph. */
export function boardPlanTypeError(markdown) {
  const type = readPlanType(markdown);
  if (type === 'build') return 'This is a Build plan. Open it in a Build chat, or revise it into an Orchestrate plan before creating a board.';
  if (type === 'invalid') return 'Invalid planType. Use build or orchestrate, or omit it for the legacy Orchestrate format.';
  return null;
}
