---
name: project-memory-rework
planType: build
overview: Replace the global, auto-injected Brain notes with project-scoped memory that agents search on demand, a small curated tool surface, and one rewritten save policy.
---

# Project memory rework

## Goal and scope

Brain notes stop being a global pile that is preloaded into every new chat. Memory becomes a small, curated store per project that agents consult when they need it:

- **Scope.** Every memory belongs to one project, keyed by Git repository identity, so linked worktrees, board slots and sub-agent checkouts share it. A separate, small user scope holds preferences the user states for every project. No other notes are visible to agents.
- **No injection.** Nothing from memory is added to system prompts, first turns, sub-agent prompts or replays. Agents call `memory_search` and `memory_read` when the task calls for it.
- **Four tools.** `memory_search`, `memory_read`, `memory_save` and `memory_forget` replace the agent-facing wiki tools.
- **One policy.** A single guidance block replaces the mandatory end-of-task capture instructions scattered across modes, work agents, skills and sub-agents.
- **No automatic writes.** Background memory synthesis is removed.

The existing corpus is not migrated. Pages outside the new memory folders remain browsable in the Brain app as legacy notes and are never returned to agents.

Non-goals: the code index and its per-checkout key, chat archive/capture pages, skill synthesis, the hidden Experts namespace and the Brain app's Graph, Ingest and Lint tools for legacy wiki pages.

## Review: why the current system misleads agents

Measured on the live store on 2026-11-20 (675 pages, ~1 MB):

- 671 pages sit outside `workspaces/`, so retrieval treats them as global. `save_memory` has no scope argument and always writes to `facts/` (`server/tools/memory-tools.js:31`, `server/brain/retrieve.js:24`). Tags such as `keylogic` do not scope anything.
- The workspace key is per checkout (`server/brain/paths.js:84`), so the few genuinely scoped pages are split between a repository and its worktrees.
- 671 pages are agent-authored; 14 were ever updated; 674 are still marked `current`, including pairs that contradict each other. Agents are told to save once per task (build, debug, plan, super-plan, builder, reviewer, tester, sub-agents, `/debug`, `/plan`) and never to update or retire.
- Retrieval always returns something. Automatic injection matches any title/tag word, and when no page matches, `retrieveMemoryBlock` falls back to recent or pinned pages (`server/engine/retrieve.js:136`). A nonsense query with an impossible tag returned eight unrelated notes. A Gitbox query ranked the only stale page first.
- Background synthesis writes pages without review at confidence ≥ 0.85 (`server/brain/synthesis.js:528`), and only for legacy renderer turns (`src/chat/run-turn-chat.ts:2055`).
- `brain_read_page` and `brain_list` ignore scope entirely, so even a scoped search can be bypassed.

What survives scrutiny is a small class of notes: user decisions and corrections that will recur, constraints and their reasons that code cannot show, and verified, non-obvious environment gotchas.

## How other systems handle memory

| System | Store and scope | How it reaches the agent | Writes |
|---|---|---|---|
| Codex | `AGENTS.md` for rules; optional generated memories in `~/.codex/memories` | Memories injected when enabled; per-chat `/memories` controls | Background extraction, off by default, skips short or active sessions, redacts secrets |
| Claude Code | `CLAUDE.md` for rules; auto memory per repository, shared across worktrees | First 200 lines / 25 KB of `MEMORY.md` index loaded; topic files read on demand | Agent writes; size limits force consolidation (one line per entry, merge or drop stale entries) |
| Cursor | Rules and `AGENTS.md` | Rules load per scope | Memories (per project, per person, approval for background writes) were removed in 2.1 in favour of Rules |
| Hermes Agent | Bounded `MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars) | Frozen snapshot at session start; separate on-demand `session_search` over history | `memory` tool add/patch/remove; writes fail at capacity rather than evicting; optional approval |
| T3 Code | No memory layer; passes provider configs through | `AGENTS.md` and docs are the durable record | Policy: rewrite or remove outdated guidance, never append another account |
| Anthropic memory tool | Client-side `/memories` directory | Model is told to view the directory before starting | `create`, `str_replace`, `delete` on files |

Lessons applied here:

1. **Scope by repository, not checkout, plus a separate user scope.** Claude Code and Hermes both separate project facts from user preferences. Nobody uses a shared global pool.
2. **Bound and curate.** Every system that kept memory caps its size and pushes the agent to update or remove entries. Unbounded append-only stores (Cursor Memories, Minnow today) degrade.
3. **Rules live in checked-in instructions.** Codex, Claude Code, Cursor and T3 Code all keep mandatory guidance in `AGENTS.md`/rules; memory is recall, not policy.
4. **Automatic generation is gated or gone.** Codex keeps it off by default; Cursor removed it.
5. **On-demand recall needs explicit triggers.** Hermes' `session_search` and Claude Code's topic files are read on demand, but both still preload a small index. Without injection, the guidance must say exactly when to search, and search must be cheap and precise.

## Decisions and constraints

- **Project key.** Resolve `git rev-parse --git-common-dir` from the effective workspace root, realpath it and hash it (lower-cased on Windows), with the principal checkout's folder name as the label. Non-Git folders and multi-repo folders use the canonical folder path. Cache per root. The code index keeps `brainWorkspaceKeyFromPath`.
- **Storage.** `brain/pages/memory/projects/<key>/<slug>.md` and `brain/pages/memory/user/<slug>.md`, so catalog, vectors, backup and the Brain app keep working. Frontmatter adds `kind`, `scope`, `projectKey`, `projectLabel`, `sourceChatId` and `supersedes`.
- **Record limits.** Title ≤ 100 characters, body ≤ 1,200 characters, optional `evidence` ≤ 300. Kinds: `decision`, `constraint`, `gotcha`, `preference`, `reference`. Caps: 150 project memories per project, 40 user memories. Writes over a limit fail with a message telling the agent to update or forget entries; nothing is evicted silently.
- **Duplicates.** `memory_save` without `id` refuses to create when a memory in the same scope has the same normalized title or cosine ≥ 0.85, and returns that memory's id so the agent updates it instead.
- **Secrets.** Reuse `containsSecretPatterns` (`server/brain/synthesis.js:69`) and reject the write.
- **Search.** Scope filter first; then require a specific query term in the title or body, or cosine ≥ 0.45 with the configured embedder. No recency fallback. Default 5 results, maximum 10. Results are compact (id, title, kind, scope, updated date, ≤ 160-character summary).
- **Tool names.** The new `memory_*` family replaces `save_memory`, `brain_search`, `brain_read_page`, `brain_list`, `brain_write_page`, `brain_append_log` and `brain_ingest_source` in agent catalogs and the MCP hub. `manage_brain` remains for user-requested destructive operations. The Brain app keeps its human-facing routes.
- **Who can write.** Ordinary chats get all four tools. Board attempts and spawned sub-agents get `memory_search` and `memory_read` only; sub-agents report memory-worthy findings to their parent. Scheduler jobs save only when their prompt asks.
- **Permissions.** `memory_search` and `memory_read` are read-only and parallel-safe. `memory_save` and `memory_forget` are classified like `save_memory` today, including the `/plan` clamp behaviour.
- **Prompt cache.** The guidance block is static text gated on tool availability. It contains no counts, titles or other changing data.
- **Legacy chats.** Stored `brain-notes` injection bodies are ignored on replay. The persisted fields stay parseable.

## Relevant files

- `server/brain/paths.js`, `server/brain/store.js`, `server/brain/retrieve.js`, `server/engine/retrieve.js`: storage and ranking.
- New `server/brain/memory/scope.js`, `server/brain/memory/store.js`, `server/tools/memory-tools.js` (rewritten): memory model and tools.
- `server/tools/builtin-catalog.js`, `server/runtime/tools-middleware.js`, `server/config/tool-ids.js`, `server/runner/lazy-tools.js`, `server/runner/tool-set.js`, `server/runner/parallel-tool-policy.js`, `src/tools/parallel-tool-policy.ts`, `src/tools/brain-tool-ids.ts`, `src/lib/permissions.mjs`, `server/mcp-hub/server.js`, `server/tools/code-tools.js`: tool wiring.
- `src/chat/prompts/compose-context.ts`, `src/chat/prompts/prompt-composer.ts`, `server/chats/preparation.js`, `src/headless/chat-preparation.ts`, `src/agents/sub-agent-prompt.ts`, `src/memory/client.ts`, `src/memory/config.ts`, `server/brain/routes.js`: injection paths.
- `src/ui/composer-brain-notes.ts`, `src/ui/settings-injection.ts`, `src/ui/settings-catalog.ts`, `src/ui/settings-search-index.ts`, `src/onboarding/steps/remaining.ts`, `src/chat/prompts/token-estimate.ts`, `src/chat/context-usage.ts`, `server/runner/injection-notice.js`, `src/ui/messages.ts`, `src/styles/composer-controls.css`, `src/styles/composer-overflow.css`: injection UI.
- `src/chat/prompts/memory/full.md`, `src/chat/prompts/memory/save.full.md`, `src/chat/prompts/modes/{build,debug,plan,super-plan,general,onboarding}.full.md`, `src/chat/prompts/work-agents/{builder,reviewer,tester}/knowledge-capture.full.md`, `src/skills/{debug,plan,onboarding}/SKILL.md`, `src/agents/prompts/sub-agents/{explore,researcher}.full.md`, `src/headless/runner.ts`, `server/super-plan/prompts/shared.md`: guidance.
- `server/brain/synthesis.js`, `server/brain/synthesis-routes.js`, `src/synthesis/client.ts`, `src/chat/run-turn-chat.ts`, `src/ui/brain/proposals-section.ts`: synthesis.
- `src/ui/brain/memories-section.ts`, `src/ui/brain/sections.ts`, `src/ui/memory-saved-toast.ts`, `src/ui/tool-call-presentation.ts`: Brain app and tool presentation.
- `server/workspace/project-move.js`: project moves.
- `documentation/context.md`, `documentation/manual/apps/brain.md`, `documentation/manual/concepts/context-and-memory.md`, `documentation/manual/reference/wiki-and-brain.md`: documentation.

## Implementation steps

### 1. Project memory scope and store
- [ ] Memories are stored and resolved per project and per user.
- Changes: Add `server/brain/memory/scope.js` and `server/brain/memory/store.js` on top of the existing page store.
- `resolveMemoryProject(root)` returns `{ key, label, root }` from the Git common directory (or canonical folder for non-Git and multi-repo folders), cached per root and safe under cancellation.
- Store functions: `listMemories(scope)`, `readMemory(id, scope)`, `createMemory`, `updateMemory` (revision-checked), `forgetMemory` (backup then delete). All reads refuse ids outside the current project and user scopes.
- Enforce title/body/evidence limits, kinds, per-scope caps, secret rejection and duplicate detection as specified above. Errors name the conflicting memory id.
- Rebind `memory/projects/<key>` in `server/workspace/project-move.js` alongside the existing Brain reassignment.
- Acceptance: a repository and two linked worktrees resolve to one key; two unrelated repositories never see each other's memories; over-limit, duplicate and secret writes fail with actionable messages and write nothing.
- Verify: New `test/brain/memory-store.test.mjs` with real Git scratch repositories, linked worktrees, a non-Git folder, a multi-repo folder and a moved project.

### 2. Memory search
- [ ] Search returns only relevant memories from the current project and user scopes.
- Changes: Add `searchMemories({ query, limit, kind, project })` reusing keyword scoring and the embedder from `server/engine/retrieve.js`, without the recency fallback or auto-inject token heuristics.
- Exclude memories whose id appears in another memory's `supersedes`. Rank project scope above user scope on ties. Return compact hits only.
- Remove `autoInject` handling from `server/engine/retrieve.js` and `/api/brain/retrieve` once step 4 lands.
- Acceptance: a nonsense query returns nothing; legacy pages and other projects never appear; a superseded memory never outranks its replacement; embeddings disabled still produces correct keyword results.
- Verify: Fixture corpus in `test/brain/memory-search.test.mjs` with cross-project distractors modelled on the review findings.

### 3. Agent tools
- [ ] Agents use `memory_search`, `memory_read`, `memory_save` and `memory_forget`, and no longer see the old wiki tools.
- Changes: Define the four tools in `server/tools/builtin-catalog.js` with the descriptions below, implement them in `server/tools/memory-tools.js`, and register them in `server/runtime/tools-middleware.js`.
- `memory_search`: "Search this project's memory (decisions, constraints, gotchas, user preferences). Returns short matches or nothing; read a match with memory_read before relying on it." Params: `query` (required), `limit`, `kind`.
- `memory_read`: "Read one memory in full, including its revision." Param: `id`.
- `memory_save`: "Save or update one durable memory for this project (or the user's cross-project preferences). Search first; pass id and expectedRevision to update instead of duplicating." Params: `title`, `body`, `kind`, `scope` (`project` default, `user`), `evidence`, `id`, `expectedRevision`, `supersedes`.
- `memory_forget`: "Delete a memory that is wrong or no longer applies." Params: `id`, `reason`.
- Remove the old wiki tools from agent catalogs, `server/config/tool-ids.js`, `src/tools/brain-tool-ids.ts`, `server/runner/tool-set.js` board roles, the MCP hub and benchmark capability probes. Board roles keep `memory_search` and `memory_read`. Spawned sub-agents get read-only memory tools.
- Update `src/lib/permissions.mjs`, both parallel-tool policies, the `brain & memory` lazy-tool family (rename to `memory`), CLI read-batch read-only hints, `src/ui/tool-call-presentation.ts` and `src/ui/memory-saved-toast.ts`. Filter `read_symbol` Brain anchors to the current project.
- Acceptance: lazy discovery and `select:` load the four tools; no agent catalog, MCP hub listing or board role exposes the removed names; permissions classify reads as read-only and writes as before.
- Verify: Update lazy-tools, tool-set, permissions, MCP hub, parallel-policy and tool-presentation suites; add tool-level tests for every error path.

### 4. Remove injection
- [ ] No memory content enters any prompt automatically.
- Changes: Delete memory retrieval from `buildComposeContext` (`src/chat/prompts/compose-context.ts:139`), `createChatPreparationAdapters().retrieveMemory` and `memoryEnabled` in `server/chats/preparation.js`, the replay in `src/headless/chat-preparation.ts`, and `appendSubAgentMemorySection` injection in `src/agents/sub-agent-prompt.ts`.
- Remove the `{{memory}}` block and `memory` info prompt usage in `src/chat/prompts/prompt-composer.ts`; ignore stored `brain-notes` replay bodies while keeping session fields parseable.
- Remove the composer Brain notes toggle and its CSS, the Settings → Injection row and search entries, the onboarding injection toggle, token-estimate and context-usage branches, and injection notices for `brain-notes`. Legacy transcript rows that recorded an injection still render.
- Ignore `features.memoryInjection` and `chat.brainNotesInjection`; stop writing them.
- Acceptance: composed prompts for ordinary, managed, headless, sub-agent and replayed legacy chats contain no retrieved memory text; Settings, onboarding and the composer show no Brain notes control.
- Verify: Update first-turn-injection, injection-replay, compose-context, preparation, runtime, composer-brain-notes (remove), settings-injection, settings-search-index, context-usage and transcript-export suites; add an assertion that a seeded memory never appears in any composed prompt.

### 5. Rewrite guidance
- [ ] One memory policy replaces every capture instruction.
- Changes: Replace `src/chat/prompts/memory/full.md` and `save.full.md` with a single `memory` tool-usage block, included only when memory tools are enabled. Its text:

  > **Project memory.** Memory holds what a fresh agent can't recover from this repository: decisions and their reasons, constraints, the user's preferences and corrections, and verified gotchas. It belongs to this project and all its worktrees, plus a few preferences the user applies everywhere. Nothing is preloaded.
  >
  > **Check memory** with `memory_search` and a specific query when the user refers to earlier work or a past decision; before choosing an approach in an area with design history (architecture, UX direction, data model, release or deployment); when an error, environment problem or tool behaviour looks like one seen before; and before asking the user a preference question. Skip it when the code answers the question. Read a match with `memory_read` before relying on it. The user's current message, the code and checked-in docs win over memory. When a memory is wrong, update or forget it.
  >
  > **Save** only when all of these hold: a fresh agent would do something wrong or lose significant time without it; it can't be learned quickly from the code, docs, git history or issues; the user said it or you verified it in this session; and it will still be true next week.
  >
  > Don't save task progress, what you changed, test results, branch, PR or merge state, review findings or TODOs (file an issue), anything the code or docs already say, guesses, dated audits, permissions granted for one task, secrets, or facts about another project.
  >
  > Search before saving. Update the memory that already covers the topic (`id` and `expectedRevision`); if yours contradicts it, rewrite it to the current truth instead of adding a second one. One idea per memory: a specific title, then the claim, why it holds and the evidence (file, command or issue), in a few lines.
  >
  > Use `scope: "user"` only for a preference the user states about how they work across projects. Rules that must always apply belong in `AGENTS.md` or project docs; suggest that to the user rather than saving a memory. Saving nothing is the normal outcome. When you save, say so in one line. Never claim a save the tool didn't confirm.

- Delete the knowledge-capture sections from the build, debug, plan and super-plan modes, the builder/reviewer/tester work agents, and the `/debug` and `/plan` skills. Plans are their own record; do not copy plan decisions into memory.
- Update the general and onboarding modes, the onboarding skill, explore and researcher sub-agent prompts, `server/super-plan/prompts/shared.md`, sub-agent rules (read-only; report findings to the parent) and the scheduler note in `src/headless/runner.ts` to the new tool names.
- Acceptance: `grep` finds no `save_memory`, `brain_search`, `brain_read_page`, `brain_write_page`, "Knowledge capture" or "make one save" instruction in prompts, skills or agent defaults; the block appears exactly once in a composed prompt when the tools are enabled and never otherwise.
- Verify: Prompt composition tests for build, debug, plan, a work agent, a sub-agent, a board attempt and a scheduler job; `npm run test:skills` for the edited skills.

### 6. Stop automatic memory writes
- [ ] Only explicit agent or user actions create memories.
- Changes: Remove the memory track from `/api/memory/synthesis/run` and `runMemorySynthesis` callers; keep skill synthesis. Remove memory proposals from the Brain app Proposals view and their settings rows. Leave stored proposals untouched.
- Acceptance: completing turns in legacy, managed and board chats creates no memory pages or memory proposals; skill proposals still work.
- Verify: Update `test/brain/synthesis-run-route.test.mjs` and the Proposals UI suite.

### 7. Brain app memories view
- [ ] Users can see, edit and forget the memories agents use.
- Changes: Rework `src/ui/brain/memories-section.ts` to list the active project's memories and user memories, grouped by kind, with edit (revision-checked), forget and a count against the cap. Label everything else in the tree as **Legacy notes — not used by agents**.
- Acceptance: memories saved by an agent appear under the right project immediately; edits and forgets are reflected in the next `memory_search`; legacy notes stay browsable.
- Verify: UI suite for the memories section plus a manual check at desktop and narrow widths in the Electron shell.

### 8. Documentation and release checks
- [ ] Shipped behaviour is documented and the full change passes checks.
- Changes: Update `documentation/context.md`, the Brain manual pages and `context-and-memory.md` to describe project and user memory, on-demand recall and the Brain app view; remove Brain notes injection from the manual. Run `npm run wiki:generate`.
- Acceptance: docs describe only shipped behaviour; product wiki hashes are current.
- Verify: `npm run test:brain`, `npm run test:memory`, `npm run test:skills`, `npm run test:product-wiki`, affected chat and runner suites, `npm run test:check-coverage` and `npx tsc --noEmit`.

## Acceptance checklist

- [ ] Agents can only search, read, save and forget memories in the current project and user scopes, and worktrees share their repository's memories.
- [ ] No memory text is injected into any prompt.
- [ ] One guidance block replaces every capture instruction, and no prompt mandates a save.
- [ ] Search returns nothing when nothing is relevant and never surfaces legacy or other-project notes.
- [ ] Saves are bounded, deduplicated and secret-checked; background synthesis no longer writes memories.
- [ ] Users can review and correct memories in the Brain app.
- [ ] Focused suites, coverage discovery, product wiki and typecheck pass.

## Evaluation after shipping

Run a fixed set of scripted tasks with and without seeded memories (a recorded user decision, a verified environment gotcha, and distractors from another project). Track whether the agent searched when the task called for it, whether it used the right memory, whether any other-project memory surfaced, how many saves routine tasks produced, and how often saves updated rather than created. Adjust the trigger wording in the guidance block from these results, not from intuition.

## Risks and open questions

- Without a preloaded index, weaker models may skip searching. The evaluation above decides whether a static "check memory before…" reminder in mode prompts is needed; a dynamic index would reintroduce injection and is out of scope.
- Hashing the Git common directory changes the key when a repository is moved outside Minnow's project-move flow. Those memories become unreachable until reassigned in the Brain app.
- Removing the old tool names breaks external MCP clients or scheduled job prompts that call them. The MCP hub change is user-visible and belongs in release notes.
- Experts (hidden) lose automatic memory injection with everyone else. Revisit if Experts ships.
