# Lazy tool loading

Implemented design for reducing tool-schema context in chat, board and sub-agent turns.

1. Resolve the caller's permitted catalog using existing mode, agent, plugin and MCP filters.
2. At the shared runner boundary, select core tools: `read_file`, `list_directory`, `grep`,
   `execute_command`, `save_file`, `replace_text_in_file`, and capability-backed `ask_question`.
   Keep the caller's injected report tool loaded as well.
3. If additional tools exist, inject `search_tools`. Rank permitted tools by exact name,
   name keywords and description keywords. Load up to five matches (three by default).
4. Return names only in the tool result. Append schemas to the next request's tool array,
   which also feeds constrained decoding and recalculated context reserves.
5. Reject unloaded calls before dispatch. A search and a dependent call in the same batch
   require a retry on the next request. Existing execution permissions remain authoritative.
6. Scope loaded state to one runner invocation. A new or resumed invocation starts fresh;
   old transcript content does not grant tool access. No schema state is persisted.
7. Persist `tools.json.lazyTools`, default true, with a searchable Settings toggle.
   Chat and background attempts snapshot it at start. The low-level `runTurn` API opts in
   with `lazyTools: true` so unrelated embeddings of the runner retain their contract.

Validation covers core/injected tools, discovery ranking and bounds, invalid arguments,
permission boundaries, per-turn isolation, request-to-request schema expansion,
execution, full-catalog fallback and configuration normalization. Type checking and
runner/settings suites check integration. The built-in catalog remains unchanged;
`search_tools` is a runner capability, not a server-dispatched catalog entry.

Tradeoffs: lexical search needs useful capability words; discovery adds round trips;
loaded schemas accumulate within a turn. The settings switch provides compatibility
for models that do not reliably use discovery. Browser runtime instructions still follow
the existing caller lifecycle; this feature reduces schemas, not all prompt material.
