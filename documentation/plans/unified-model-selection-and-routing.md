# Unified model selection and routing

**Status:** proposed implementation plan; no product changes implemented  
**Register:** product  
**Date:** 2026-10-18

## Goal

Give users one place to select a conversation's model: the composer. New independent chats start with the last model explicitly selected in any composer, shared across projects and app restarts. The top bar contains system controls, including a Models popover; the sidebar contains project work surfaces.

Model routing remains available for auxiliary work. Model pools become global. Issues and Dashboard expose explicit launch pickers, onboarding introduces routing, and sub-agents inherit their parent model unless the user configures a routing override.

This document records the planning discussion and its latest corrections. It is an implementation specification, not documentation of shipped behavior. Update the manual and architecture reference only when the corresponding behavior ships.

## Decisions and scope

### Agreed behavior

- Remove the top-bar default-model selector entirely.
- Make the composer authoritative for the foreground chat model.
- Remove work-agent provider/model configuration. Keep work-agent prompts, tool permissions, and other non-model behavior.
- Remember the last explicit composer selection globally, across projects and restarts.
- Existing chats retain their own bindings. Opening an old chat does not change the remembered selection.
- Move Models out of the project app rail and into the top bar. Clicking its icon opens a compact popover with routing controls and links to full model management.
- Share model pools across all workspaces.
- Keep Orchestrator boards' current model selection and board-specific binding behavior.
- Add optional routing setup during onboarding.
- Add consistent model pickers to issue and Dashboard chat launches, initially following the remembered chat selection.
- Stop the current foreground generation when the user changes its composer model; the new selection applies to subsequent turns.
- Capture bindings for queued/background work and sub-agent runs, so unrelated selection changes do not redirect them.
- Default sub-agents to the parent chat model, with an optional fixed model/pool in Routing.
- Show sub-agent inheritance/override information and the actual model used.
- Support setup before a project/chat exists, and consistent remembered selection across windows.

### Deferred by the latest discussion

The earlier proposal for agents to select models per sub-agent launch is deferred. Do not add model/provider arguments to the public `spawn_sub_agent` tool, an agent-facing model recommendation catalog, automatic cheap-model selection, or persisted natural-language model preferences in this change.

In particular, “be token efficient” does not authorize automatic model switching. “Use DeepSeek Flash for your sub-agents” must not silently change routing or create a new conversation-level model policy. A later feature can implement those instructions with a dedicated design. Existing internal APIs that accept bindings can remain where trusted product flows need them; they are not a new agent-facing feature.

This supersedes the earlier discussion of persisting conversational sub-agent model preferences across reload and compaction. For this release, users set fixed alternatives through Routing.

### Implementation choices used by this plan

- Issue/Dashboard model overrides apply to their dispatch and do not update the globally remembered composer choice.
- Provide one basic Sub-agents routing setting, plus existing per-type overrides under advanced controls. Precedence is per-type override, general sub-agent override, then parent binding.
- Keep the current default-model persistence endpoint/file as a compatibility seam initially; change its internal meaning and remove its user-facing default-model terminology.
- Preserve existing sampler/thinking settings unless they conflict with model capabilities. This is not a sampler redesign.
- Full Models remains a released, routable management surface. Moving its launcher does not hide the app or remove deep links.

## 1. Selection and inheritance contract

### Binding identity

Use an explicit provider/model pair throughout runtime code. A model ID alone is ambiguous when multiple providers expose it. Preserve synthetic identities for My Models (`minnow-library`) and pools (`minnow-router`); runtime serve aliases and a pool's chosen member are resolved execution details.

The remembered selection stores the selected model or pool, never a temporary loaded-server alias or the member selected by a pool. Switching reasoning effort alone does not update the remembered model.

### Resolution table

| Source of work | Binding when created/admitted | Effect on remembered choice |
|---|---|---|
| New independent chat | Explicit launch binding, otherwise remembered composer selection | None |
| Composer model selection | Selected provider/model or pool | Updates remembered choice |
| Existing chat opened/resumed | Its saved binding | None |
| Issue → new chat | Issue launch override, otherwise remembered selection | None |
| Dashboard → new chat(s) | Dispatch override, otherwise remembered selection | None |
| Add issues to an existing chat | Existing chat binding | None |
| Background work owned by a chat | Dedicated task routing, otherwise originating chat binding | None |
| Standalone background work | Dedicated task routing, otherwise remembered selection | None |
| Sub-agent | Per-type routing override, then general sub-agent routing, then captured parent binding | None |
| Scheduled job | Saved job binding, otherwise remembered selection at run admission | None |
| Orchestrator board | Existing board selection and explicit board/attempt rules | None |
| New unbound board | Explicit creation binding, otherwise remembered selection, captured into the board | None |
| Explicit CLI model/provider | Initialize the CLI run's chat binding from the arguments | None |

Auxiliary routing includes the existing utility, editor assistance, and goal evaluation settings. Each role keeps its own established meaning of “follow chat/task”; the shared resolver must receive an explicit originating context rather than consulting whichever chat is foreground later.

An explicitly pinned binding that is unavailable must produce a clear unavailable/error state. Do not replace it with the first catalog row or current global selection. Existing configured failover chains and pool failover remain valid execution policies; their actual choices do not rewrite the selection preference.

### Lifecycle rules

1. Resolve and persist a new chat's complete binding before asynchronous worktree setup, task queueing, or generation starts.
2. An issue/Dashboard dispatch snapshots its model once for all new chats in that dispatch. A queue retry uses that snapshot.
3. Unpinned scheduled jobs snapshot the remembered choice once at run admission; later retries within that run retain it. A future scheduled occurrence resolves again.
4. A sub-agent captures routing and the parent binding when its run is created, before waiting for capacity. Routing edits apply to later launches.
5. Inheriting a pool means inheriting the pool binding, not permanently pinning the parent pool's last resolved member. Existing pool strategy, admission, and failover still operate.
6. Composer model changes use the existing stop path. Preserve its established child-cancellation semantics; never mutate a child's captured model or automatically relaunch it with the new model.
7. Reopening, catalog refresh, loading/unloading, routing edits, board runs, and background completions never update the remembered choice.
8. Onboarding's initial model pick and upgrade migration may seed the preference. These are explicit initialization paths, not general runtime writers.
9. An empty setup offers model/provider setup. A missing previously selected model stays visible as unavailable, with a picker action.

## 2. Shared model state and persistence

### Current implementation seams

- [`src/ui/default-model.ts`](../../src/ui/default-model.ts) persists the global selection and falls back to `#modelSelect`.
- [`src/ui/chat-model-ui.ts`](../../src/ui/chat-model-ui.ts) changes the active chat independently of that preference.
- [`src/ui/sidebar.ts`](../../src/ui/sidebar.ts) handles global changes, new chat creation, ephemeral reuse, and router-default synchronization.
- [`src/state/sessions.ts`](../../src/state/sessions.ts) has additional creation paths and a `defaultRouterId` override.
- [`src/state/background-chat.ts`](../../src/state/background-chat.ts) reads the global DOM select directly.
- [`src/api/models.ts`](../../src/api/models.ts), picker helpers, boards, utility clients, and resume paths also read that element.
- [`server/config/middleware.js`](../../server/config/middleware.js) owns `GET/PUT /api/config/default-model`; `default-model.json` is already in the backup catalog.

### Implementation

- Introduce a DOM-independent model-selection service in a shared state/model layer, with typed reads, writes, initialization, and subscriptions. UI code calls this service; server/headless consumers use equivalent shared binding rules without importing browser modules.
- Keep catalog state separate from selected binding state. A catalog refresh can update names, capabilities, and availability without modifying a saved choice.
- Add an explicit `remember` intent to the composer selection path, or a dedicated composer-selection operation. General programmatic binding writes must not remember automatically.
- Centralize independent-chat initialization so sidebar New chat, keyboard shortcuts, app entry points, ephemeral reuse, issues, and Dashboard use the same precedence.
- Remove `defaultRouterId` as a competing new-chat default. A pool is selected and remembered exactly like a concrete model.
- Replace direct `#modelSelect` reads in behavior code with selection/catalog APIs. A hidden native select may temporarily remain as a picker adapter, but runtime correctness must not depend on it or a mounted chat DOM.
- Refresh reasoning defaults and context/capability displays when a chat model changes, retaining existing per-model defaults and supported-option checks.
- Keep stable library/pool selection identity separate from the resolved generation transport binding. Audit turn-start mutations that currently copy resolved bindings back onto chats.

### Persistence and cross-window ordering

Initially reuse `default-model.json` and `/api/config/default-model`, with browser storage as a cache and legacy migration source. New internal names should describe a remembered chat selection. Endpoint compatibility avoids unnecessary backup/path migration.

Add a server-owned revision to reads and acknowledged writes, using serialized atomic writes. Treat the last accepted explicit selection write as authoritative across windows. Keep request ordering within each window, discard older read responses, and never allow an older acknowledgement to overwrite a newer local pending selection. Preserve compatibility with existing `{ value }` callers during migration.

Broadcast confirmed revisions to other renderers through an existing suitable app event mechanism; use focus-time revalidation and a bounded conditional refresh if a shared event path is unavailable. A browser `storage` event alone is insufficient across origins/ports. New-chat/dispatch admission must refresh the remembered preference when it cannot establish cache freshness; capture once and avoid a later global read during setup.

Receiving a preference update changes future launches and unmodified “follow last selected” picker previews. It does not change another window's existing chat or an explicit launch-picker override. Surface failed saves with retry while retaining the current chat's selection.

### Upgrade behavior

- Seed from the existing server preference first; fall back to the legacy browser key only when the server has no value.
- If neither exists, seed from a uniquely resolvable legacy pool default for the current setup, or leave selection empty. Do not arbitrarily choose between conflicting project defaults.
- Preserve provider-qualified identities and unavailable selections. Infer providers for legacy bare IDs only when existing compatibility logic can resolve them unambiguously.
- Preserve all nonempty existing chat bindings. Fill genuinely unbound chats through normal initialization before a send, then save the binding.
- Do not infer the preference from the most recently opened chat, transcripts, timestamps, background runs, or resolved pool telemetry.

## 3. Remove work-agent model configuration

The requested removal concerns provider/model configuration. Work agents remain useful for prompts, tool permissions, context policy, sampler/thinking behavior, and mode defaults.

### Implementation surfaces

- Client types and registry: [`src/agents/work-agent-types.ts`](../../src/agents/work-agent-types.ts), [`work-agent-registry.ts`](../../src/agents/work-agent-registry.ts), metadata/pack parsers and schemas.
- Binding resolution: [`src/agents/resolve-work-agent-binding.ts`](../../src/agents/resolve-work-agent-binding.ts), [`src/chat/run-turn-chat.ts`](../../src/chat/run-turn-chat.ts), [`src/headless/resolve-model-binding.ts`](../../src/headless/resolve-model-binding.ts).
- Server persistence and API: [`server/work-agents/registry.js`](../../server/work-agents/registry.js), [`routes.js`](../../server/work-agents/routes.js), and their validation/schema consumers.
- Editing/routing: work-agent editor surfaces and [`src/settings/model-routing-catalog.ts`](../../src/settings/model-routing-catalog.ts).

### Required behavior

- Remove model/provider controls and routing rows for work agents. Changing an agent or composer mode never changes the chat model.
- Resolve foreground generations from the chat binding. Remove provider/model precedence from agent metadata and saved overrides.
- Tolerate legacy saved/pack fields on read, but ignore them for execution. Stop emitting/writing them; remove them on an explicit save or a versioned, recoverable migration.
- Do not rewrite existing chat bindings to match old agent defaults. Historical execution metadata remains intact.
- Preserve explicit CLI selections by applying them to the run's chat before shared resolution.
- Audit the dedicated `/ui-designer` foreground model override: design turns run in the chat and must obey its visible model. Remove that competing foreground routing control while preserving design prompts/tools and unrelated image-generation configuration.
- Keep board-specific model and explicit attempt selection outside this removal. Trace board callers of shared resolvers so deleting work-agent defaults cannot discard legitimate board bindings.

Acceptance invariant: for a concrete-model chat, selecting an agent, changing mode, or invoking a foreground skill cannot silently replace the composer model. For pools, show the selected pool and existing resolved-member feedback.

## 4. Global model pools

This is a storage and scheduler migration, not only a picker change.

### Current ownership

[`server/model-routers/store.js`](../../server/model-routers/store.js) caches one store/scheduler per workspace and writes `~/.minnow/model-routers/<sha256-workspace-path>.json`. Each file mixes pool definitions, `defaultRouterId`, revisions, sticky assignments, and evaluator decisions. [`src/models/routers.ts`](../../src/models/routers.ts) similarly caches configuration by workspace and writes `minnow.routers:<workspace>` browser keys.

### Target ownership

- One global pool catalog for the Minnow home, available with or without a workspace.
- One shared scheduler/admission owner per server runtime, with provider/model capacity accounting across workspaces.
- Sticky assignments, explicit chat overrides, evaluator decisions, and telemetry retain conversation/run identity. Sharing definitions must not merge independent conversations' state.
- Workspace/file-tool context remains request-specific. Global pool lookup must not replace the originating workspace for model execution, callbacks, tools, or local load requests.
- Use versioned files under the existing `model-routers/` directory, such as `global-v2.json` for definitions/migration aliases and a separate runtime-state file for durable assignments/decisions. Final filenames can follow surrounding conventions.
- Keep definitions revisioned independently of routine assignment writes, preventing generation activity from producing editor conflicts.

### Migration

1. Before accepting pool configuration edits/generations, run a serialized, idempotent server migration. Retain the legacy source files and a migration manifest until the new catalog and runtime state have both been durably committed.
2. Scan all legacy workspace files, including workspaces not currently open. Validate each source and report corrupt inputs without replacing them with empty configuration.
3. Import distinct definitions. Deduplicate only genuinely equivalent definitions, accounting for entry identity needed by assignments. Preserve entry order, strategy, tiers, evaluator, pause flags, and concurrency settings.
4. Resolve colliding IDs deterministically. Keep an unambiguous existing ID when possible; otherwise generate a stable valid global ID. Same-name/different-definition pools remain separate with distinguishable display names. Never merge by name alone.
5. Record aliases from `(legacy workspace digest, old pool ID)` to global IDs, plus entry-ID mappings when deduplication requires them.
6. Remap assignments/decisions through those aliases. Preserve explicit overrides and evaluator outcomes. Build new scheduler keys from canonical pool IDs and the actual chat/run identity.
7. Resolve references in chats, board journals/snapshots, schedules, sub-agent routing, and the remembered selection. Use repository APIs or a central compatibility resolver; do not hand-edit event journals or transcript history.
8. A lazy compatibility resolver must work for unopened legacy chats/boards using their own workspace identity. Canonicalize bindings when saved. Aliases remain available while old references can still load.
9. The existing global remembered pool string may lack its source workspace. Map it only when uniquely resolvable or supported by reliable source context. Ambiguous cases show a choice rather than selecting the wrong pool.
10. Do not promote every legacy `defaultRouterId` to an active default. Preserve definitions, use the remembered-selection migration rules above, and retire independent pool-default controls.
11. Crash recovery resumes from the manifest without double importing or losing state. New writes use the global catalog only after migration commits. Preserve unmigrated sources if an input needs repair.

The existing `model-routers` backup root covers nested files, but verify catalog/restore behavior and restore from a backup that contains only legacy workspace files. Use scratch Minnow homes for every migration/restore test.

### Runtime and UI changes

- Replace `getRouterWorkspace()` configuration ownership in store/routes/generation with global ownership; retain explicit execution context separately.
- Replace workspace-keyed client catalog caches with one global revisioned cache. Workspace changes no longer reload a different pool list or write remembered selection.
- Saving/editing a pool never selects it for chats or updates the remembered preference. Remove this coupling from `saveRouterConfig()`.
- Keep current priority, balance, Auto evaluation, failover, library load coordination, and per-chat overrides. Deleting/disabling a referenced pool produces an unavailable state for future work.
- Preserve running attempts on their admitted binding and existing queue validation/cancellation behavior. A global edit must not silently retarget an unrelated active chat.
- Apply capacity accounting across all workspaces. Audit conflicting concurrency limits for the same provider/model across enabled pools: use a deterministic shared admission limit rather than whichever queue happens to be first. Recommended initial rule: the lowest enabled configured limit for that resource, with the effective shared limit visible in pool management.
- Isolate parent and sub-agent pool assignment identities. A child's available-capacity preference must not overwrite the parent's sticky assignment; keep activity attribution to the owning conversation separately.
- Clearly label pool management as shared across projects. Availability and live activity must work from the workspace picker as well as Code.

## 5. Top-bar Models popover and navigation

### Placement and structure

Replace the default-model chip in [`src/os/menubar.ts`](../../src/os/menubar.ts) with an icon button labelled **Models**. Remove Models from `RAIL_PRIMARY_APP_IDS` in [`src/os/app-preferences.ts`](../../src/os/app-preferences.ts). Keep its app registry entry released/core, its routes, command-palette discovery, and full management UI.

Recommended compact contents:

```text
Models                                  Shared across projects

Routing
  Sub-agents                       Follow parent       [picker]
  Utility tasks                    Follow task         [picker]
  Editor assistance                Follow chat         [picker]
  Goal evaluation                  Follow chat         [picker]

Advanced sub-agent routing                                  >
Model pools                                                 >
Providers & connections                                     >
Local models                               1 running        >

Manage models…                                              >
```

The initial popover is a quick configuration surface. Full discovery/downloads, provider credentials, runtime logs, sampler detail, voice setup, and usage inspection remain in Models. Local model status is read-only here; avoid adding destructive stop-all controls to this change.

### Component and lifecycle requirements

- Use a reusable routing form/controller shared with onboarding and full settings. Do not reparent singleton Settings DOM into the popover: simultaneous windows and onboarding need independent mounts.
- Split routing data loading from the current assumption that `getActiveChat()` exists. Global settings can load without a chat; parent previews are optional display context.
- Use the existing searchable model picker/catalog, including provider labels, pools, unavailable saved choices, and unloaded loadable library models.
- Reuse autosave/retry conventions for quick settings. Preserve edits while opening a nested picker; prevent stale loads/saves from painting after unmount.
- Integrate with [`src/ui/shell-overlay-state.ts`](../../src/ui/shell-overlay-state.ts) so opening another system popover closes this one and trigger state stays correct.
- Support outside dismissal, Escape, focus restoration, labelled controls, keyboard operation, nested picker focus, responsive positioning, and reduced motion. Treat the form as a labelled non-modal dialog/popover, not a menu whose rows contain arbitrary form fields.
- Preserve the current workspace, foreground app, editor selection, composer draft, and transcript when opening/closing the popover.
- “Manage models…” and section links close the popover before opening the full Models destination. Preserve existing return/navigation semantics and deep links.
- Remove the editable Chat model row from full Routing as well. Foreground chat selection belongs in the composer.
- Explain which settings are shared without adding scope badges to every task. The more detailed inheritance explanation is reserved for sub-agents.

Use `--mn-*` tokens and existing popover/picker primitives. Keep heavy Models modules lazy so the shell does not eagerly import model management.

## 6. Issue and Dashboard launch pickers

### Shared launch state

Build one reusable launch-model picker/state abstraction:

- `follow-last-selected`: display the latest remembered choice while the launch UI is idle.
- `explicit`: display the chosen model/pool, unaffected by later preference broadcasts.
- A reset action returns to following the remembered choice. Suggested label: **Use last selected chat model**.
- At submission, resolve either state to an explicit provider/model pair and freeze it for that dispatch.
- A dismissed/cancelled launch does not change the remembered model. Completed dispatches reset temporary picker overrides for the next launch; do not create hidden per-project launch defaults.

Show the selected model beside mode/run-target controls before launch. Use one picker implementation in single/bulk flows and expose a way to change it from row/context-menu launch paths. Do not add a mandatory confirmation step when users accept the displayed choice.

### Issues

Extend [`src/chat/issues/workspace-chat.ts`](../../src/chat/issues/workspace-chat.ts) to accept a typed launch options/binding value. Pass the frozen pair into `ensureBackgroundChat()` before asynchronous worktree setup.

Wire issue detail actions and row/context menus in [`src/ui/issues-detail.ts`](../../src/ui/issues-detail.ts) and [`src/ui/issues-row-menu.ts`](../../src/ui/issues-row-menu.ts), plus other callers found by a complete call-site search. Keep Build/Plan/Debug policy, issue linking, status transitions, and worktree setup unchanged.

Retries that reuse a pending issue setup chat retain its stored model; they do not overwrite it with a new global value. An intentional change requires an explicit model change on that pending chat or creation of a new dispatch. Adding an issue to an existing conversation keeps that conversation's model.

Issue description expansion is a utility task, distinct from sending an issue to a chat. It follows utility routing and an explicit initiating context; its completion cannot modify launch selection.

### Dashboard

[`src/ui/home-page.ts`](../../src/ui/home-page.ts) already has `sendModel`, a send-options menu, and binding capture through [`src/home/flow-actions.ts`](../../src/home/flow-actions.ts). Replace the DOM-derived menu with the shared picker. Replace **Model router default** and other default-model copy with **Use last selected chat model** and the effective label.

Persist each dispatched group's model in its existing run metadata before queueing, keeping provider identity and pool/library identity intact. Apply the same choice to single-card launch paths and all newly created groups in a bulk dispatch. Retries and existing-chat additions keep their stored bindings.

Goal-to-task drafting remains a utility generation; launching the resulting chats uses the visible dispatch picker. Plan approval → board launch must continue forwarding the captured chat/board binding and must not reread the global preference.

## 7. Sub-agent routing and visibility

### Configuration

Expose one basic setting: **Sub-agents → Follow parent chat** or a fixed model/pool. Store the general override in the existing `sub-agents.json` configuration, adding a version-compatible optional default binding. An unset field means inherit; a fixed override must contain a complete provider/model pair.

Keep existing per-type provider/model fields for advanced routing. Their UI offers **Use sub-agent routing** plus an optional fixed pair. Retain existing configured per-type choices during upgrade and indicate when they supersede the general setting. Fresh installations have no sub-agent model overrides.

Precedence:

1. Existing explicit product-owned binding for a trusted internal flow, where required by that flow's contract.
2. Per-type routing override.
3. General sub-agent routing override.
4. Parent chat's selected binding, including a pool.

Ordinary agent tool launches start at step 2. Do not expose step 1 as tool arguments in this change. Avoid independently filling a missing provider from one source and model from another; normalize legacy partial pairs deliberately before execution.

### Runtime

- Extend [`src/agents/resolve-sub-agent-binding.ts`](../../src/agents/resolve-sub-agent-binding.ts) and its server counterpart/consumers with the same pure precedence rules.
- Update config defaults, read/write validators, TypeScript declarations, and both browser and headless launch paths.
- Audit [`src/agents/orchestrator.ts`](../../src/agents/orchestrator.ts), [`server/sub-agents/middleware.js`](../../server/sub-agents/middleware.js), and [`server/sub-agents/effector-runner.js`](../../server/sub-agents/effector-runner.js). Resolution cannot be browser-only, and an effector must not reread newer type routing to override a queued run's captured pair.
- Persist the selected binding and a compact source marker with the run, using the existing durable run/event mechanism. Preserve these values through retries, reconnects, restart, and transcript restoration.
- Missing parent binding without a routing override is a setup error for an ordinary child launch, not a reason to borrow an unrelated foreground chat. Parentless product flows must provide their explicit context.
- A configured but unavailable override reports its cause rather than silently ignoring the setting. Existing configured execution failover remains separate.
- Preserve run-scoped tool/mode permissions, context policies, structured outcomes, cancellation, and local-model admission behavior.
- Keep the public `spawn_sub_agent` schema and prompt guidance aligned with inheritance/routing. Remove copy suggesting the agent can freely name a model if any exists.

### Display

Limit detailed provenance labels to sub-agent routing and run details:

- **Following parent · Model X**
- **Sub-agent routing · Model Y**
- **Type override · Model Z**
- For a pool: show the selected pool and the actual resolved model separately once known.

Use existing cards/drawer metadata rather than adding another status rail. Legacy runs without provenance can show their recorded model with an unknown source; do not infer historical inheritance from today's settings. The same selected/actual model information should be available in existing sub-agent status/list payloads where practical, without introducing selection tools.

## 8. Onboarding routing step

Add a skippable **Model routing** step after initial provider/model setup, once those branches have a usable binding. Register it in [`src/onboarding/steps/registry.ts`](../../src/onboarding/steps/registry.ts), add its ID to [`src/onboarding/types.ts`](../../src/onboarding/types.ts), and update persisted-step validation/count/resume handling.

Requirements:

- Reuse the routing form/controller from the Models popover with onboarding-specific explanatory text and commit behavior.
- Introduce the purpose plainly: **Choose separate models for supporting tasks, or let them follow the model you are using.**
- Show sub-agents, utilities, editor assistance, and goal evaluation. Advanced per-type routing stays optional; pool/provider links may open the corresponding setup surface only with correct return handling.
- Start fresh installations with inheritance. Existing settings are read and preserved; rendering a step never resets them.
- Stage edits and commit only dirty fields through existing configuration APIs. Navigation/skip must not overwrite persisted settings with empty placeholders. Report partial failures and allow retry without advancing as if all writes succeeded.
- Only show applicable setup when a usable model/provider exists. A user who skips model setup can finish onboarding and reach Models later; routing cannot become a blocking empty step.
- Work without an active project or chat. Show **Follow parent chat** as a rule, using the initial chosen model only as an illustrative preview, never by fabricating a chat.
- Cover managed/local, cloud, and CLI branches, including branches that establish the initial model without mounting the regular model-pick step.
- Preserve completed onboarding status on upgrade. Do not reopen onboarding for existing users solely because a step was added. Resuming older in-progress state resolves step IDs safely.
- Keep the initial onboarding model as the first remembered chat choice. Configuring a utility/sub-agent model does not replace it.

## 9. Background, Scheduler, headless, and board audit

Removing a shell control must not remove model availability from non-chat flows.

Audit at least:

| Area | Existing seams | Required result |
|---|---|---|
| Background chats | `src/state/background-chat.ts`, `src/chat/messaging.ts` | Explicit origin/binding, independent of mounted DOM |
| Utility generations | title clients, composer expansion, issue expansion, `src/home/plan-goal.ts`, commit/release drafting | Dedicated role or captured originating context; global remembered choice only for independent work |
| Resume/retry | `src/chat/generation-resume.ts`, `incomplete-tool-resume.ts`, fork/regenerate paths | Keep recorded run/chat selection; no late global substitution |
| Scheduler | `server/scheduler/resolve-job-model.js` | Replace current active-chat lookup with server-side remembered preference for unpinned jobs |
| Headless | `src/headless/resolve-model-binding.ts`, CLI initialization and tool dispatch | CLI → chat binding; no work-agent model override; no DOM dependency |
| Board UI | `src/orchestrator/board-model-bind.ts`, `board-header-v2.ts`, board creation | Keep board picker and captured binding; seed only genuinely unbound boards |
| Board execution | `server/orchestrator/model-binding.js`, explicit attempt/planner paths | Preserve legitimate board model controls independently of work-agent defaults |
| Models/local loading | `src/api/models.ts`, library request binding, pool library serve | Load/unload without altering remembered choice; retain stable identities |

The table is an audit checklist, not an assertion that every path currently shares identical resolution. Search all `modelSelect`, default-binding helpers, `defaultRouterId`, and work-agent model fields before declaring the migration complete. Include hidden-app callers in compatibility checks without expanding their release availability.

## 10. Delivery sequence

Each phase should include its focused tests. Keep compatibility adapters until dependent phases have moved; do not ship an intermediate state that removes the only usable selector or breaks background runs.

### Phase A — shared selection state

- [ ] Add typed DOM-independent selection/catalog interfaces and remembered preference subscriptions.
- [ ] Implement server revision/write ordering, browser cache migration, and cross-window refresh.
- [ ] Wire composer writes and independent-chat initialization.
- [ ] Convert runtime `#modelSelect` readers and remove competing router-default precedence.
- [ ] Verify existing chats, provider-qualified IDs, ephemeral reuse, and library/pool identity.

### Phase B — authoritative foreground binding

- [ ] Remove work-agent model/provider controls, persistence writes, and execution precedence.
- [ ] Remove competing foreground UI Designer model override.
- [ ] Retain legacy read compatibility, prompts/tools, and board/CLI explicit bindings.
- [ ] Remove the editable Chat model row from Routing.

### Phase C — global pools

- [ ] Implement global store, migration manifest/aliases, and crash-safe import.
- [ ] Migrate definitions, assignments, decisions, and reference resolution.
- [ ] Switch client cache and pool API ownership to global scope.
- [ ] Remove pool-save/default-selection coupling.
- [ ] Verify cross-workspace admission, assignment isolation, existing board references, and backup restore.

### Phase D — shared routing and sub-agents

- [ ] Extract mount-independent routing data/controller/form components.
- [ ] Add general sub-agent routing and advanced per-type inheritance.
- [ ] Capture and persist selected bindings/source at run creation on all launch paths.
- [ ] Add sub-agent model/source display and selected-versus-actual pool display.
- [ ] Keep agent-selected per-run models and natural-language preference persistence deferred.

### Phase E — issue/Dashboard launch controls

- [ ] Add shared follow-last-selected/explicit picker state.
- [ ] Wire issue detail, row/context menus, and all applicable batch launch paths.
- [ ] Replace Dashboard's DOM-derived menu/default wording and cover single-card starts.
- [ ] Persist dispatch snapshots before setup/queueing and retain them on retry.
- [ ] Verify existing-chat additions and plan-to-board handoff.

### Phase F — shell and onboarding

- [ ] Replace menubar default chip with Models popover and remove Models from project rail.
- [ ] Preserve management routes/shortcuts and add popover dismissal/focus/lazy-loading behavior.
- [ ] Add skippable routing onboarding for every provider branch and safe old-state resume.
- [ ] Verify workspace-picker access, multi-window behavior, narrow layouts, and keyboard navigation.

### Phase G — documentation and release validation

- [ ] Update architecture/storage/API ownership in `documentation/context.md` after implementation.
- [ ] Update manual Models, chat model selection, onboarding/connect-a-model, configuration, Scheduler, and applicable issue/Dashboard/sub-agent pages to describe shipped behavior.
- [ ] Refresh product-wiki generated content/inventories through their documented generator where affected; do not hand-edit generated catalogs.
- [ ] Add release migration notes for removed agent model settings and shared pools.
- [ ] Complete automated and manual acceptance checks below.

## 11. Validation plan

### Focused automated coverage

| Contract | Required cases |
|---|---|
| Remembered selection | Composer writes globally; reopen/background/load/routing/board changes do not; restart and legacy migration; failed save; cross-window stale read/ack ordering |
| Chat initialization | New/ephemeral/programmatic entry points; explicit override precedence; provider collisions; unavailable remembered value; no active chat/DOM |
| Work-agent removal | Legacy agent/pack fields ignored; mode/agent switches retain chat model; explicit CLI and board bindings preserved; UI design follows composer |
| Pool migration | Multiple projects; same ID/different definition; same name; equivalent definitions; entry mappings; unopened references; ambiguous global legacy reference; corrupt source; interrupted migration; rerun; legacy-only restore |
| Global pool runtime | Same catalog across workspace headers; shared FIFO/capacity accounting; conflicting limits deterministic; parent/child isolation; sticky/override/Auto decisions survive restart; library loads/failover unchanged |
| Launch pickers | Follow preference until explicit override; freeze bulk dispatch once; asynchronous setup race; queued work/retry retain pair; reset/cancel; unavailable model; add to existing chat |
| Sub-agent routing | Type → general → parent; full-pair validation; unavailable explicit setting; browser/headless parity; queue/retry/restart capture; pool inheritance; accurate source/actual labels |
| Onboarding | All provider branches; skipped model setup; no workspace/chat; fresh inheritance; preserve existing settings; commit failure; partial save retry; skip/back; old in-progress resume; completed users stay complete |
| Popover/navigation | Exclusive shell overlay; nested picker dismissal; focus return; unmount races; full Models links; Models absent from project rail but released/routable; shortcut remains usable |
| Background/Scheduler | Origin captured before awaits; standalone global fallback; unpinned job admission; pinned job stability; headless operation without DOM |

Extend existing suites rather than writing tests that merely assert the presence of source strings. Relevant current suites include `test/ui/default-model-persistence.test.mts`, model-select/composer tests, `test/settings/model-routing-catalog.test.mts`, `test/ui/settings-agent-routing-reset.test.mts`, `test/ui/issues-workspace.test.mts`, `test/model-routers/`, `test/sub-agents/`, `test/onboarding/`, `test/headless/`, `test/scheduler/`, and `test/orchestrator/`. Replace menubar-default-chip tests with the new behavior rather than retaining obsolete expectations.

New test files under `test/` are auto-discovered. Run the discovery coverage check and typecheck, then affected suites via the repository runner/scoped scripts. Before merge run the required full checks, including `npm test`, product-wiki validation, a production build, performance budgets, and the headless bundle check where imports change. Attribute unrelated baseline failures accurately rather than silently changing their fixtures.

Use `MINNOW_HOME` scratch directories for every persistence/migration/backup test. Never migrate or restore the developer's live profile for testing.

### Manual acceptance scenarios

1. Select Model A in a composer; create chats in two projects and after restart. Both start on A. Open an old Model B chat; another new chat still starts on A.
2. In two windows, select A then B and wait for acknowledgements. Both new-chat paths follow B. Existing chats and an explicit issue launch override stay unchanged.
3. Change a streaming chat from A to B. The foreground turn stops cleanly, the next turn uses B, and already-created child runs keep their captured binding/cancellation outcome.
4. Launch an issue with C while the remembered choice is A. During worktree setup, select B elsewhere. The issue chat uses C; future independent chats use B.
5. Bulk-dispatch Dashboard groups with a pool, queue some, and restart. All retain that pool. Add an issue to an existing concrete-model chat; its model stays intact.
6. Create/edit a pool in one workspace and use it from another and from onboarding/system controls. Run simultaneous work across workspaces and verify shared admission without assignment crossover.
7. Upgrade scratch profiles with conflicting project pool IDs and old boards/schedules. Verify correct original meanings and actionable disambiguation where source identity is missing.
8. Use a work agent/foreground skill with an old stored model override. The chat uses the composer binding. A board with its own model remains on the board model.
9. Spawn sub-agents on parent A; configure general routing B and a type override C. Verify newly launched runs use B/C, queued earlier runs keep A, and run details explain the source.
10. Complete and skip routing onboarding for managed, external local, cloud, and CLI setup without a workspace. Reopen Models later and verify the same settings and inherited defaults.
11. Disable/remove a selected provider/pool and refresh catalogs. Existing choices remain visibly unavailable; unrelated models are never silently selected.
12. Open/close the Models popover entirely by keyboard, use nested pickers and full-management links, and confirm drafts, editor state, workspace, and focus are preserved across wide/narrow layouts.

## 12. Completion criteria

- The composer is the sole foreground chat-model selector and truthfully represents the selected binding.
- There is no visible default-model selector or work-agent model/provider configuration.
- The global remembered choice has one intentional writer path plus explicit onboarding/migration initialization.
- Every launch/run follows the documented precedence without depending on foreground DOM or later global reads.
- Pools are shared across workspaces, with durable compatibility for existing references and shared admission accounting.
- Boards keep their current model controls and captured selections.
- Issues and Dashboard expose visible launch choices that default to the last composer-selected model.
- Sub-agent routing offers parent inheritance and fixed user-configured overrides, with recorded model/source visibility.
- Autonomous sub-agent model selection and conversational model preference persistence remain deferred.
- Routing onboarding, full Models, and the top-bar popover edit the same underlying settings and work without an active chat.
- Documentation, focused regression coverage, migration/restore checks, and required build/performance checks match the shipped implementation.
