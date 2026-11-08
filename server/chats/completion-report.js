/** A bounded, self-contained task handoff; never includes tool arguments or reasoning. */
export function completionReport(result = {}, finalText = '', limit = 12000) {
  const sections = [];
  const add = value => { if (typeof value === 'string' && value.trim() && !sections.includes(value.trim())) sections.push(value.trim()); };
  let structured;
  try { structured = JSON.parse(finalText); } catch {}
  // A prose fallback can store the entire JSON final as its summary.
  if (!structured || result.summary !== finalText) add(result.summary);
  for (const key of ['evidence', 'blockers', 'needs']) {
    if (Array.isArray(result[key])) for (const value of result[key].slice(0, 40)) add(value);
  }
  if (structured && typeof structured === 'object') {
    add(structured.summary);
    if (Array.isArray(structured.findings)) for (const finding of structured.findings.slice(0, 40)) {
      if (!finding || typeof finding !== 'object') continue;
      add([finding.severity, finding.title, finding.detail,
        Array.isArray(finding.paths) ? finding.paths.filter(p => typeof p === 'string').join(', ') : '']
        .filter(value => typeof value === 'string' && value).join('\n'));
    }
    if (Array.isArray(structured.artifacts)) for (const artifact of structured.artifacts.slice(0, 20)) {
      if (artifact && typeof artifact.ref === 'string') add([artifact.label, artifact.ref].filter(v => typeof v === 'string').join(': '));
    }
    for (const key of ['evidence', 'blockers', 'needs']) {
      if (Array.isArray(structured[key])) for (const value of structured[key].slice(0, 40)) add(value);
    }
  } else add(finalText);
  const text = sections.join('\n\n');
  const suffix = '\n[Report excerpted; open the linked child for the remaining evidence.]';
  return text.length > limit ? text.slice(0, Math.max(0, limit - suffix.length)) + suffix : text;
}
