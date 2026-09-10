const DEFAULT_SUB_AGENT_SUMMARY_SCHEMA = "minnow.sub-agent.v1";
const VALID_SEVERITIES = /* @__PURE__ */ new Set(["info", "warn", "blocker"]);
const VALID_ARTIFACT_KINDS = /* @__PURE__ */ new Set(["path", "url", "note"]);
const SUB_AGENT_SUMMARY_SCHEMA_PRESETS = {
  "minnow.sub-agent.v1": {
    id: "minnow.sub-agent.v1",
    label: "Standard (summary + findings + artifacts)",
    maxFindings: 20,
    maxArtifacts: 20,
    maxSummaryChars: 2e3,
    maxDetailChars: 4e3,
    requireFindings: false
  },
  "minnow.sub-agent.lite": {
    id: "minnow.sub-agent.lite",
    label: "Lite (summary + artifacts only)",
    maxFindings: 0,
    maxArtifacts: 20,
    maxSummaryChars: 1200,
    maxDetailChars: 0,
    requireFindings: false
  },
  "minnow.sub-agent.explore": {
    id: "minnow.sub-agent.explore",
    label: "Explore (findings-heavy)",
    maxFindings: 30,
    maxArtifacts: 10,
    maxSummaryChars: 1500,
    maxDetailChars: 6e3,
    requireFindings: false
  },
  "minnow.pr-review.v1": {
    id: "minnow.pr-review.v1",
    label: "PR review (verdict + findings)",
    maxFindings: 40,
    maxArtifacts: 20,
    maxSummaryChars: 2e3,
    maxDetailChars: 6e3,
    requireFindings: false
  },
  "minnow.super-plan.review.v1": {
    id: "minnow.super-plan.review.v1",
    label: "Super Plan review (findings required)",
    maxFindings: 40,
    maxArtifacts: 20,
    maxSummaryChars: 2e3,
    maxDetailChars: 6e3,
    requireFindings: true
  }
};
function resolveSummarySchemaPreset(schemaId) {
  const key = (schemaId ?? "").trim() || DEFAULT_SUB_AGENT_SUMMARY_SCHEMA;
  return SUB_AGENT_SUMMARY_SCHEMA_PRESETS[key] ?? SUB_AGENT_SUMMARY_SCHEMA_PRESETS[DEFAULT_SUB_AGENT_SUMMARY_SCHEMA];
}
function listSummarySchemaPresetIds() {
  return Object.keys(SUB_AGENT_SUMMARY_SCHEMA_PRESETS);
}
function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function readString(value, maxLen) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}
function validateStructuredOutcomeForPreset(raw, preset) {
  if (!isPlainObject(raw)) return null;
  const summary = readString(raw.summary, preset.maxSummaryChars);
  if (!summary) return null;
  const findingsRaw = raw.findings;
  const artifactsRaw = raw.artifacts;
  if (!Array.isArray(findingsRaw) || !Array.isArray(artifactsRaw)) return null;
  if (findingsRaw.length > preset.maxFindings) return null;
  if (artifactsRaw.length > preset.maxArtifacts) return null;
  if (preset.maxFindings === 0 && findingsRaw.length > 0) return null;
  const findings = [];
  for (const item of findingsRaw) {
    if (!isPlainObject(item)) return null;
    const title = readString(item.title, 240);
    const detail = readString(item.detail, preset.maxDetailChars);
    if (!title || !detail) return null;
    const finding = {
      title,
      detail
    };
    if (typeof item.id === "string" && item.id.trim()) {
      finding.id = item.id.trim().slice(0, 64);
    }
    if (typeof item.severity === "string" && VALID_SEVERITIES.has(item.severity)) {
      finding.severity = item.severity;
    }
    if (Array.isArray(item.paths)) {
      const paths = item.paths.filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => p.trim().slice(0, 512)).slice(0, 16);
      if (paths.length) finding.paths = paths;
    }
    findings.push(finding);
  }
  if (preset.requireFindings && findings.length === 0) return null;
  const artifacts = [];
  for (const item of artifactsRaw) {
    if (!isPlainObject(item)) return null;
    const kind = typeof item.kind === "string" ? item.kind : "";
    if (!VALID_ARTIFACT_KINDS.has(kind)) return null;
    const label = readString(item.label, 240);
    const ref = readString(item.ref, 1024);
    if (!label || !ref) return null;
    const artifact = {
      kind,
      label,
      ref
    };
    if (typeof item.mime === "string" && item.mime.trim()) {
      artifact.mime = item.mime.trim().slice(0, 128);
    }
    artifacts.push(artifact);
  }
  return { summary, findings, artifacts };
}
export {
  DEFAULT_SUB_AGENT_SUMMARY_SCHEMA,
  SUB_AGENT_SUMMARY_SCHEMA_PRESETS,
  listSummarySchemaPresetIds,
  resolveSummarySchemaPreset,
  validateStructuredOutcomeForPreset
};
