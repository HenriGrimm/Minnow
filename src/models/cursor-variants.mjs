/** Cursor lists effort, Thinking, and Fast combinations as separate model IDs. */
export function cursorVariantParts(modelId) {
  let id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return null;
  const fast = id.endsWith('-fast');
  if (fast) id = id.slice(0, -5);
  let thinking = id.endsWith('-thinking');
  if (thinking) id = id.slice(0, -9);
  const match = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/.exec(id);
  const effort = match?.[1] === 'extra-high' ? 'xhigh'
    : match?.[1] === 'none' ? 'off'
      : match?.[1] ?? null;
  if (match) id = id.slice(0, -match[0].length);
  if (id.endsWith('-thinking')) {
    thinking = true;
    id = id.slice(0, -9);
  }
  return { baseId: id, effort, thinking, fast };
}

export function cursorVariantFamilyKey(modelId) {
  const parts = cursorVariantParts(modelId);
  return parts ? `${parts.baseId}\u001f${parts.thinking ? 'thinking' : 'regular'}` : '';
}

/** Use only IDs advertised by this account; never manufacture a Cursor model ID. */
export function resolveCursorVariantId(selectedId, availableIds, { effort, fast } = {}) {
  const selected = cursorVariantParts(selectedId);
  if (!selected) return selectedId;
  const family = cursorVariantFamilyKey(selectedId);
  const variants = availableIds
    .filter(id => cursorVariantFamilyKey(id) === family)
    .map(id => ({ id, ...cursorVariantParts(id) }));
  if (variants.length === 0) return selectedId;
  const wantedEffort = effort && variants.some(row => row.effort === effort)
    ? effort : selected.effort;
  const sameEffort = variants.filter(row => row.effort === wantedEffort);
  const candidates = sameEffort.length ? sameEffort : variants;
  return candidates.find(row => row.fast === Boolean(fast))?.id
    ?? candidates.find(row => row.id === selectedId)?.id
    ?? candidates[0].id;
}

/** Advertise family effort levels through Minnow's ordinary reasoning control. */
export function cursorReasoningForModels(rows) {
  const families = new Map();
  for (const row of rows) {
    const key = cursorVariantFamilyKey(row.id);
    if (!key) continue;
    const levels = families.get(key) ?? new Set();
    const effort = cursorVariantParts(row.id)?.effort;
    if (effort) levels.add(effort);
    families.set(key, levels);
  }
  const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return rows.map(row => {
    const levels = families.get(cursorVariantFamilyKey(row.id)) ?? new Set();
    if (levels.size < 2) return row;
    const allowed_options = order.filter(level => levels.has(level));
    const own = cursorVariantParts(row.id)?.effort;
    const defaultLevel = own && levels.has(own) ? own
      : levels.has('medium') ? 'medium' : allowed_options[0];
    return { ...row, reasoning: { allowed_options, default: defaultLevel } };
  });
}
