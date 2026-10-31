/** Shared, Node/browser-safe validation. Fixtures can never select a real executor. */
export function validateEvalToolFixtures(raw, allowedTools, deniedTools, knownTools) {
  const invalid = () => { throw new Error('Invalid or oversized eval toolFixtures'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 ||
      Object.keys(raw).some(key => !['version', 'steps'].includes(key)) || !Array.isArray(raw.steps) || raw.steps.length > 20) invalid();
  let bytes = 0;
  const clone = value => {
    let encoded;
    try { encoded = JSON.stringify(value); } catch { invalid(); }
    if (encoded === undefined || (bytes += encoded.length) > 256 * 1024 || encoded.length > 64000 || /"(?:__proto__|constructor|prototype)"\s*:/.test(encoded)) invalid();
    return JSON.parse(encoded);
  };
  return { version: 1, steps: raw.steps.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !['name', 'matchArgs', 'result'].includes(key)) ||
        !knownTools.has(step.name) || !allowedTools.includes(step.name) || deniedTools.includes(step.name) ||
        !step.matchArgs || typeof step.matchArgs !== 'object' || Array.isArray(step.matchArgs) || !Object.hasOwn(step, 'result')) invalid();
    return { name: step.name, matchArgs: clone(step.matchArgs), result: clone(step.result) };
  }) };
}
