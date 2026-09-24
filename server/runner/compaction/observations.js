/** Bounded source excerpts, never interpreted as verified facts or instructions. */
export function readObservation(content) {
  const lines = String(content).split(/\r?\n/);
  const numbered = lines.filter(line => /^\s*\d+:/.test(line));
  const range = numbered.length ? `lines ${numbered[0].match(/\d+/)[0]}–${numbered.at(-1).match(/\d+/)[0]}; ` : '';
  const declarations = lines.filter(line => /\b(?:export|function|class|interface|type|const)\s+\w/.test(line));
  return (range + declarations.slice(0, 4).map(line => line.trim().slice(0, 100)).join(' | ')).slice(0, 320);
}
