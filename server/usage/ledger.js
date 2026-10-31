const TOKEN_LEDGER_ENTRY_CAP = 200;
import { hasMeasurableUsage, usageTokenCounts } from "../runner/usage-pricing.js";
const EMPTY_LEDGER_TOTALS = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  completionCount: 0
};
function emptyLedger() {
  return {
    entries: [],
    totals: { ...EMPTY_LEDGER_TOTALS },
    bySource: {}
  };
}
function sourceKey(source) {
  switch (source.kind) {
    case "main": {
      const mode = source.modeId.trim() || "unknown";
      const agent = source.workAgentId?.trim();
      return agent ? `main:${mode}:${agent}` : `main:${mode}`;
    }
    case "sub-agent":
      return `sub-agent:${source.subAgentType.trim() || "unknown"}`;
    case "title":
      return "title";
    case "utility":
      return `utility:${source.task.trim() || "unknown"}`;
    case "reef-widget":
      return "reef-widget";
    case "orchestrate-board":
      return "orchestrate-board";
    case "work-agent":
      return `work-agent:${source.workAgentId.trim() || "unknown"}`;
    default:
      return "unknown";
  }
}
function formatSourceLabel(source) {
  switch (source.kind) {
    case "main": {
      const mode = source.modeId.trim() || "main";
      const agent = source.workAgentId?.trim();
      return agent ? `Main (${mode}) \xB7 ${agent}` : `Main (${mode})`;
    }
    case "sub-agent":
      return `Sub-agent (${source.subAgentType})`;
    case "title":
      return "Chat title";
    case "utility":
      return source.task === "followup-task" ? "Follow-up task" : "Utility task";
    case "reef-widget":
      return "Legacy widget (Reef)";
    case "orchestrate-board":
      return "Orchestrate board";
    case "work-agent":
      return `Work agent (${source.workAgentId})`;
    default:
      return "Unknown";
  }
}
function formatUsd(amount) {
  if (amount == null || !Number.isFinite(amount)) return "$0.00";
  if (amount > 0 && amount < 0.01) return "< $0.01";
  return `$${amount.toFixed(4)}`;
}
function addTotals(base, usage, costUsd) {
  const counts = usageTokenCounts(usage);
  return {
    promptTokens: base.promptTokens + counts.promptTokens,
    completionTokens: base.completionTokens + counts.completionTokens,
    totalTokens: base.totalTokens + counts.totalTokens,
    costUsd: base.costUsd + (costUsd ?? 0),
    completionCount: base.completionCount + 1
  };
}
function mergeTotals(base, usage, costUsd) {
  return addTotals(base, usage, costUsd);
}
function ensureTokenLedger(chat) {
  if (!chat.tokenLedger || typeof chat.tokenLedger !== "object") {
    chat.tokenLedger = emptyLedger();
    return chat.tokenLedger;
  }
  const ledger = chat.tokenLedger;
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  if (!ledger.totals || typeof ledger.totals !== "object") {
    ledger.totals = { ...EMPTY_LEDGER_TOTALS };
  }
  if (!ledger.bySource || typeof ledger.bySource !== "object") {
    ledger.bySource = {};
  }
  return ledger;
}
function resetTokenLedger(chat) {
  chat.tokenLedger = emptyLedger();
}
function isRetiredUsageKind(kind) {
  return kind === "reef-widget";
}
function recordTokenUsage(chat, input) {
  if (!hasMeasurableUsage(input.usage)) return null;
  if (isRetiredUsageKind(input.source.kind)) return null;
  const ledger = ensureTokenLedger(chat);
  const key = sourceKey(input.source);
  const entry = {
    id: input.id ?? globalThis.crypto.randomUUID(),
    at: input.at ?? Date.now(),
    source: input.source,
    providerId: input.providerId,
    modelId: input.modelId,
    usage: { ...input.usage },
    ...input.stats && Object.keys(input.stats).length > 0 ? { stats: { ...input.stats } } : {},
    costUsd: input.costUsd
  };
  ledger.entries.push(entry);
  if (ledger.entries.length > TOKEN_LEDGER_ENTRY_CAP) {
    ledger.entries.splice(0, ledger.entries.length - TOKEN_LEDGER_ENTRY_CAP);
  }
  ledger.totals = mergeTotals(ledger.totals, input.usage, input.costUsd);
  const prevSource = ledger.bySource[key] ?? { ...EMPTY_LEDGER_TOTALS };
  ledger.bySource[key] = mergeTotals(prevSource, input.usage, input.costUsd);
  return entry;
}
function sumSessionLedgerTotals(chats) {
  let acc = { ...EMPTY_LEDGER_TOTALS };
  for (const chat of chats) {
    const ledger = chat.tokenLedger;
    if (!ledger?.totals) continue;
    const t = ledger.totals;
    acc = {
      promptTokens: acc.promptTokens + (t.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (t.completionTokens ?? 0),
      totalTokens: acc.totalTokens + (t.totalTokens ?? 0),
      costUsd: acc.costUsd + (t.costUsd ?? 0),
      completionCount: acc.completionCount + (t.completionCount ?? 0)
    };
  }
  return acc;
}
function mergeSessionBySource(chats) {
  const out = {};
  for (const chat of chats) {
    const bySource = chat.tokenLedger?.bySource;
    if (!bySource) continue;
    for (const [key, totals] of Object.entries(bySource)) {
      const prev = out[key] ?? { ...EMPTY_LEDGER_TOTALS };
      out[key] = {
        promptTokens: prev.promptTokens + totals.promptTokens,
        completionTokens: prev.completionTokens + totals.completionTokens,
        totalTokens: prev.totalTokens + totals.totalTokens,
        costUsd: prev.costUsd + totals.costUsd,
        completionCount: prev.completionCount + totals.completionCount
      };
    }
  }
  return out;
}
export {
  TOKEN_LEDGER_ENTRY_CAP,
  EMPTY_LEDGER_TOTALS,
  emptyLedger,
  ensureTokenLedger,
  formatSourceLabel,
  formatUsd,
  mergeSessionBySource,
  mergeTotals,
  recordTokenUsage,
  resetTokenLedger,
  sourceKey,
  sumSessionLedgerTotals
};
