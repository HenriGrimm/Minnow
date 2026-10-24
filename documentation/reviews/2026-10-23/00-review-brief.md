# Minnow comprehensive review brief

Date: 2026-10-23 (America/Los_Angeles). Baseline commit: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`.

## User-confirmed product direction

Minnow is a complete, local-first development workspace for solo builders. **Chat-driven building is the center. Code is the central workspace and mainly a chat.** The editor, terminal, previews, diffs, models, issues, boards and knowledge support the journey from a described goal to a working, understandable, reviewable result. Direct code editing remains useful, but is not the default measure of product success.

The user is unsure where Reef belongs. It works well inside Minnow but feels out of place; a separate app is a possibility, not a decided requirement. Evaluate implementation quality separately from product placement. Current code registers Reef as released; supplied AGENTS guidance describes the removal of a Reef composer mode, not a ban on the current app.

User instructions in this conversation take precedence over older editor-centric descriptions in PRODUCT.md. No changes to product source or product documents are part of this review.

## Review contract

Inspect each vertical's code, logic, workflows, UX where relevant, boundaries, failure recovery, tests and integration with the shared workspace. Preserve strong existing design. Separate verified defects from design assessments, risks and hypotheses. Recommendations are review proposals, not shipped behavior or implementation commitments.

Each section report contains:

1. Scope and files sampled, with unreviewed boundaries explicitly named.
2. A short assessment against the chat-driven product direction.
3. Good: concrete strengths and why they matter.
4. Bad: numbered findings with priority, evidence (path and verified lines), trigger, impact, confidence, and recommendation.
5. Improvements: prioritized concrete changes, distinguishing repair from product/design proposals.
6. Checks actually run and their outcomes. Distinguish tests, source inspection and live observation.
7. Cross-vertical dependencies and unresolved questions.

Priority: P0 = critical loss/exposure or core path broadly unusable; P1 = high-impact defect or major workflow barrier; P2 = material friction/limited defect; P3 = polish. Product decisions use D instead of bug priority. A failed test is not automatically a confirmed product bug; inspect its cause. Missing tests do not prove broken behavior. Use only evidence available in this checkout; no unsupported comparisons or whole-product quality scores.

## Safety and coordination

Review only. Agents may write their assigned report files, run scoped checks against scratch data, and add report evidence. No source edits, dependency installs, commits, PRs, external messages, credential reads, or changes to the live ~/.minnow profile. Do not run broad builds concurrently. Use a task-specific temporary MINNOW_HOME for any server, CLI or runtime tests. Keep generated evidence free of tokens and secrets. Other agents share this checkout; never reset their files.

## Coverage plan

- Chat engine, transcript, context, modes, tools, permissions and session lifecycle.
- Code workspace, project selection, files/editor/LSP, terminal, preview/browser and dev servers.
- Dashboard, Issues, plans, orchestrator/sub-agents, worktrees, Source Control and delivery.
- Models, providers, native CLI transports, pools/routing, usage and local runtimes.
- Brain, memory, synthesis, indexing, attachments and project/manual retrieval.
- Skills, plugins, MCP, prompts, voice, notifications and webhooks.
- Runtime/security, persistence/backups, remote devices and process boundaries.
- Scheduler, headless CLI, Electron, packaging and release/update lifecycle.
- Reef, generated-app lifecycle and its product placement.
- Onboarding, navigation, settings, responsive/accessibility/theme behavior and chat-first UX.
- Tests/CI, build/performance budgets, documentation accuracy and maintainability.
- Cross-surface synthesis and realistic user journeys.

Reports are bounded source and workflow reviews, not a claim that every line or every supported platform has been exhaustively tested.
