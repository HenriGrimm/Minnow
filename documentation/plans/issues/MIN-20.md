# MIN-20 — CLI context windows

## Plan

1. Trace CLI catalog capacity through model discovery, capability probes, shared context budgeting, and native invocation.
2. Make Claude aliases inherit their resolved model capacity; retain known Cursor capacities when its discovery label omits the window.
3. Add an optional context window in Models → CLIs, persist only validated integer token counts (1,000–1,000,000), and let blank restore automatic discovery.
4. Pass Codex's documented `model_context_window` configuration. Request Claude extended Sonnet/Opus variants where necessary, keeping Haiku at its real ceiling. Cursor only permits lowering Minnow's budget below its advertised model ceiling.
5. Verify persistence, reset, model restrictions, capability propagation, stale-probe precedence, provider arguments, and the existing settings form.

## Vendor references

- [Claude model configuration](https://code.claude.com/docs/en/model-config): `[1m]` extended variants and `CLAUDE_CODE_DISABLE_1M_CONTEXT`; account availability remains authoritative.
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/): `model_context_window` declares the selected model's available tokens.
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters): model selection is supported; no native context-window flag is documented.

## Review scope

Automatic mode preserves installed-model discovery. Explicit settings do not grant account access or create model capacity. Runtime context metadata takes precedence over old saved capability probes, and a changed window replaces a waiting native process at the next generation.
