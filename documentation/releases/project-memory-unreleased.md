# Project memory — unreleased

Memory belongs to one project and all its Git worktrees, plus a small user scope for cross-project preferences. Agents search it on demand; nothing is injected into prompts, including replays of older chats. Background synthesis proposes skills only.

Brain → Memories groups project and user memories by kind, with revision-checked editing, Forget and capacity counts. Existing wiki pages remain browsable as legacy notes; they are not migrated into agent memory.

**MCP and scheduled prompt compatibility:** the agent and MCP catalogs expose `memory_search`, `memory_read`, `memory_save` and `memory_forget`. The old `save_memory`, `brain_search`, `brain_read_page`, `brain_list`, `brain_write_page`, `brain_append_log` and `brain_ingest_source` names are no longer available. Update external clients and job prompts that name them. To update a memory, read its revision first and pass `id` and `expectedRevision` to `memory_save`.

Sub-agents and board attempts can search/read memory, but cannot save or forget it. Scheduled jobs save only when their prompt asks them to. Memory saves have size/capacity limits, duplicate checks and credential-pattern rejection; nothing is silently evicted.
