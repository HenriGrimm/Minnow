# GitLab repository provider integration

Engineering proposal, 2026-10-21. Planning only; implementation has not started.

## Agreed scope

First additional provider: GitLab.com and self-hosted GitLab. First public release includes the full Minnow integration: account setup, repository setup, merge requests, agent review and delivery, issue import and two-way sync, pipelines, releases, and Scheduler issue automation. Implementation is incremental; the release boundary includes all of these areas.

Full integration means the repository workflows Minnow exposes today, expressed using GitLab's native semantics. GitLab administration, runner provisioning, deployment management, a full package browser, multiplayer, and other repository providers are outside this change. Existing local commands and GitHub `act` execution remain available; emulating GitLab Runner locally is separate work.

## Findings in the current tree

| Area | Current implementation and required seam |
|---|---|
| Git and clone | `server/git/git-ops.js`, `server/workspace/clone.js`, and `src/lib/remote-repository.mjs` already use Git rather than a hosting API. Preserve their credentials, workspace boundaries, and checkout locks. |
| Hosting operations | `server/git/forge-ops.js` recognizes some GitLab hostnames but gates operations on GitHub and `gh`. Its PR models, run models, and request throttling are GitHub-shaped. |
| Client contract | `src/state/forge-api.ts` exposes a single `supported` boolean and GitHub-oriented fields. Separate support, authentication, permissions, and individual capabilities. |
| Identity and links | `src/lib/git-remote-url.ts` assumes owner/repo and GitHub web paths. Server parsing preserves nested paths but guesses provider from hostname and drops port information. |
| Accounts | `server/git/github-auth.js`, `src/ui/github-account.ts`, and onboarding target github.com. Repository-aware GitHub operations already support some enterprise hosts. |
| Issues | `src/types.ts`, `src/state/issues-github*.ts`, `src/issues/github-*.ts`, and `server/git/forge-issue-ops.js` persist GitHub identities and sync watermarks. Metadata carries Minnow taxonomy and timeline in an issue-body transport. |
| Delivery | `server/worktree/worktree-ops.js` and `src/chat/issues/git-actions.ts` also create PRs or probe `gh` directly. Changing Source Control alone does not cover delivery. |
| Pipelines and releases | `workflow-ops.js`, `release-ops.js`, `release-draft-context.js`, and `action-common.js` use GitHub REST endpoints and workflows. Agent actions share these through `action-service.js` and `action-tools.js`. |
| Automation | `server/scheduler/github-watch*.js` uses GitHub-only config, repository keys, ledgers, remote matching, comments, and PR publication. Preserve its durable state machine. |

## Architecture decisions

### One server-side forge contract

Retain `/api/git`, existing worktree APIs, shared action services, tool policy, issue storage, review storage, and Scheduler runtime. Route hosting operations through built-in GitHub and GitLab adapters. This is core repository support and needs the same workspace, persistence, and delivery behavior in every surface.

Proposed organization under `server/git/forge/`: repository target resolution, provider registry, capability/result contracts, shared request coordination, and `providers/github.js` / `providers/gitlab.js`. Existing exported operations can delegate during migration; avoid a wholesale rename of every client operation.

Use `gh` for GitHub and `glab` for GitLab. Prefer structured API responses through authenticated CLI requests; use native CLI commands where their behavior is appropriate. Pass explicit host and project targets, argv arrays, and structured input files/stdin. Keep credentials owned by the CLI. The [GitLab CLI API command](https://docs.gitlab.com/cli/api/) supports authenticated requests and explicit host selection.

### Repository and resource identity

- Resolve a target containing provider, instance web/API base URLs, full project path, stable provider project ID when available, selected remote, and fetch/push URLs. Retain SSH authority separately from web/API authority.
- Support nested groups, SSH aliases, custom ports, and instance base paths. Provide an explicit host/provider mapping where a hostname or SSH alias is ambiguous; do not infer GitHub from a dotted hostname.
- Use provider + instance + stable project identity for new persisted resource keys. Keep connection/account identity separate from resource identity; scope caches to effective credentials as well as the resource.
- Preserve provider path casing until resolved by the provider. Do not lowercase every repository path generically.
- Separate provider-global IDs from project-visible issue/MR numbers. GitLab's MR API addresses project-scoped IIDs; opaque resource IDs must also accommodate release tags. See the [merge request API](https://docs.gitlab.com/api/merge_requests/).
- Capture targets before asynchronous work. A workspace, remote, account, or branch change must not redirect a pending mutation. Fork delivery specifies source project/branch and target project/branch separately.
- Server-resolved web URLs take precedence over reconstructed links. Make commit, issue, MR, pipeline, and release links provider-specific.

### Capabilities and shared models

Replace coarse readiness with independent states for installation, connection, authentication, repository resolution, and operation permissions. Retain a compatibility `supported` value only while existing callers migrate.

Capabilities cover MR reads/create/checkout/edit/close/ready/merge, allowed merge behavior and auto-merge, approvals, CI reads/logs/retry/cancel/manual jobs/dispatch, issue operations and deletion, releases, assets, and release-note generation. Unknown permissions remain unknown until resolved; a successful account lookup does not imply write access.

Shared results carry canonical identity, provider terminology, operation outcome, pagination/completeness, and normalized errors. Preserve native states alongside normalized display states. Missing statistics are unknown, not zero. Model mergeability and check states such as blocked/manual/unknown without treating them as success. Add explicit head SHA to review context; do not derive it from provider commit ordering.

Scope request coalescing, cache invalidation, and cooldowns by provider, instance, effective credential identity, project, and operation. Preserve retry timing when present. Never replay an uncertain create/dispatch/upload automatically; reconcile the remote result first.

## Required behavior by area

### Accounts and project setup

Expose repository hosting connections in Settings and reuse the connection component from onboarding. Detect existing `glab` installation and effective login, support GitLab.com browser/device sign-in, and accept existing self-hosted CLI authentication. Include a self-hosted setup path for OAuth application configuration or token login through the terminal/stdin, without returning tokens to the renderer.

Self-hosted OAuth has instance configuration prerequisites; device flow also has a server-version prerequisite. Follow [GitLab authentication documentation](https://docs.gitlab.com/cli/authentication/) rather than reusing GitHub's fixed verification URL or device-code parser. Preserve the user's Git credential helpers and SSH configuration. Keep Git transport authentication and API authentication distinct in errors.

Generalize `/git-setup` and board preflight to create/connect a GitLab project and push through the existing authorized workflow. Do not change an existing remote or add a global preferred provider silently. Custom instance mappings are explicit and validated before authenticated requests; credentials stay scoped to the configured authority, including downloads and redirects.

### Merge requests, review, and delivery

Provide open/closed/merged/all lists, search, current-branch matching, detail, description, changes, commits, reviews/approvals, and CI. Support create, draft/ready, checkout, close, and the merge behavior the target project permits. Do not translate GitHub's rebase merge flag blindly into GitLab's rebase/merge operations.

Reuse the existing reviewer and review result UI. Scope review identity to provider/instance/project/MR/head SHA; preserve existing GitHub records with a compatibility lookup. Show incomplete or unavailable diffs explicitly and prevent a partial fetch from appearing to be a complete review.

Issues, chat/worktree delivery, boards, and Source Control use the same creation service. Fork checkouts and pushes use explicit remotes and existing mutation locks. Reconcile an existing MR before retrying uncertain creation. Display native `Merge requests` / `!n` terminology and provider-aware error recovery. Repository permissions and protected branches remain authoritative.

### Issue import and two-way sync

Introduce a provider-neutral remote issue link with provider, instance, project ID/path, issue ID/IID, URL, and current sync watermarks. Initially permit one active mirror per local card; ordinary related links may reference other providers. Switching a workspace remote does not retarget linked cards or backfill them into a new provider.

Preserve current sync behavior: manual import/discovery, parent-first sync, title/body/labels/open-state mirroring, Minnow taxonomy/project/parent/timeline metadata, debounced edits including `issue_*` writes, quiet background checks, local-only fields, and latest-change conflict rules. GitLab label operations must preserve unrelated remote labels. Batched reads may have provider-specific implementations and concurrency limits; callers receive completeness information.

Keep Minnow's current timeline metadata transport for parity. Native GitLab notes support explicit comments and watcher progress; importing and reconciling all native conversations into the local timeline is separate scope and must not happen implicitly. Cover metadata round trips, unknown/future blocks, Markdown rendering, parent lookup outside discovery limits, body limits, and partial failures.

Settings expose sync mode/auto per workspace repository binding, with a deliberate migration of existing GitHub preferences. Imported issues identify GitLab as their source. Linked deletion distinguishes local removal from remote deletion and respects GitLab permissions. Disabling sync or changing workspaces stops queued work; auth/network errors retain pending changes without marking the local backend offline.

### Pipelines and release automation shortcut

Reuse Actions' list/inspector and add a GitLab pipeline configuration form. Support pipeline history/detail, branch/SHA/source, stages/jobs, logs, retry/cancel, manual-job actions, and dispatch against a selected remote branch/tag. Include retried jobs and child/downstream pipelines in the model without treating missing data as an empty success. See [pipelines](https://docs.gitlab.com/api/pipelines/) and [jobs](https://docs.gitlab.com/api/jobs/).

Represent GitLab CI configuration as a provider-native dispatch target rather than a list of GitHub workflow files. Use GitLab-resolved configuration/schema where available for ref-specific inputs, includes, and rules. Do not infer complete runnable configuration from a local YAML parse. Preserve schema provenance and show when validation depends on the server. Treat runtime variables as distinct from typed pipeline inputs and avoid persisting secret values in saved presets.

Version-gate newer input features; the pipeline API documents inputs as generally available from GitLab 18.1. Record a tested minimum GitLab and `glab` version in implementation package P0; do not claim every self-hosted version works.

Generalize the release-workflow shortcut to a repository-scoped release execution target. For GitLab it stores the pipeline configuration/reference policy and nonsecret inputs, opens the same provider-aware dispatch form, and links to the accepted pipeline. Preserve GitHub workflow mappings through compatibility reads. A timeout after dispatch is an unknown outcome requiring reconciliation, not permission to dispatch again.

### Releases and assets

Support list/detail/create/edit/delete, existing or explicitly created tags, description preview, AI draft writing, release assets, and the pipeline shortcut. GitLab release resources are addressed by tag; its [release API](https://docs.gitlab.com/api/releases/) and [asset-link API](https://docs.gitlab.com/api/releases/links/) differ from GitHub release IDs and binary assets.

Use a local persisted draft for unpublished GitLab work. Save draft performs no remote publication or tag creation. Publish explicitly creates the release against the captured target SHA/tag. Validate existing tags and detect competing releases before publishing. Do not model an upcoming release as a private draft or present GitHub-specific latest/prerelease controls as native GitLab flags.

For uploaded binaries, propose Generic Package storage plus a release asset link, following [GitLab's documented release asset approach](https://docs.gitlab.com/user/project/releases/release_fields/). Track uploaded objects separately from release links and reconcile partial success. Removing a link does not silently delete package bytes; cleanup is a separate explicit operation. Support external asset links and authenticated downloads without forwarding credentials to unrelated origins. Capability errors explain disabled package registries or insufficient permissions.

Reuse the utility generation flow for draft writing, full commit messages, annotated tags, exact base/target SHAs, cancellation, Undo, and explicit Save. Implement range collection with completeness checks; provider-side compare limits cannot silently omit commits. Provider-native automatic notes are a separate capability from Minnow's AI writer.

### Scheduler and agent workflows

Generalize watcher configuration to a repository issue watcher with provider/instance/project identity and the existing `minnow` label default. Reuse the current claim/planning/starting/board/publishing/complete/blocked state machine and shared headless Plan runner. One repository remains serialized across watcher jobs.

For GitLab, discover labeled issues with pagination, post deduplicated progress notes, prepare the fetched default branch, run the existing board, and publish an MR only after its existing tests and delivery gates pass. Reconcile notes/MRs by persisted markers, source/target identities, and branch. Validate both fetch and push destinations before planning and again before publication. A remote or account change blocks safely rather than publishing elsewhere.

Preserve active GitHub jobs, ledgers, locks, deterministic IDs, boards, retry ownership, and resume behavior. Existing jobs must continue without duplicate claims/publication. No new scheduler service, webhook ingress, or requirement to keep a renderer open. User-configured GitLab-side pipeline schedules are separate from Minnow Scheduler jobs.

Update repo-aware agent guidance and setup/fix-CI skills for `gh` versus `glab`; include the resolved target in context. Share adapter operations with agent tools and retain existing mode/permission enforcement. Do not infer mutations are allowed because a provider capability exists.

## Persistence and migration contract

- Keep `IssuesState.version` at its compatibility floor; use `schemaRevision` for the change. Update both client/server parsing, merging, normalization, serialization, and tool writes together. Never reset unfamiliar records to empty.
- Read legacy `issue.github` as a GitHub binding, preserving every watermark. Keep its compatibility projection while supported readers need it. Never write a GitLab link into `issue.github`; prove supported rollback does not cause wrong-provider writes.
- Resolve missing legacy GitHub host data from a trusted recorded URL/binding where possible. If identity is ambiguous, retain it and ask for reattachment when used rather than guessing from the current remote. Preserve old PR review keys and release-workflow preferences through explicit compatibility lookups.
- Interpret legacy `githubWatch` jobs with their existing github.com semantics. Keep existing ledger locations and keys readable; migrate lazily/atomically with no active-job rekeying. Key new GitLab ledgers/locks by canonical repository identity. A later provider-neutral rewrite must preserve resume identity.
- Proposed new nonsecret storage: `~/.minnow/forge/config.json` for instance mappings and `forge/release-drafts/` for local release drafts, with atomic writes, revisions, and locks. Reuse existing config/workspace stores if their contracts fit before adding a store. No copied CLI credential files or tokens.
- Add any new home entries to `server/backup/catalog.js`; classify configuration and drafts explicitly and cover restore. Existing Scheduler state remains under its existing backup category. CLI credentials remain external to Minnow backups.

## Implementation work packages

All package paths below describe intended touch areas, not permission for unrelated refactors. Select exact new filenames during P0. Shared files make this an ordered implementation; integration requires reviewing overlaps before splitting work.

| Package | Dependencies | Deliverable and main touch areas | Acceptance evidence |
|---|---|---|---|
| P0: Provider compatibility fixtures | None | Inventory current operation/tool contracts; select/test GitLab and `glab` minimum versions; prove custom-host auth, MR merge semantics, CI inputs/schema, release publishing/assets, and metadata round trips using scratch fixtures. `test/server/`, `test/scheduler/`, provider contract notes. | Recorded version matrix and captured sanitized response fixtures; uncertain API mappings resolved before UI promises. |
| P1: Shared forge and GitHub extraction | P0 | Target identity/resolver, capabilities/errors/request coordination, GitHub adapter; `server/git/forge-ops.js`, `gh-requests.js`, `middleware.js`, `src/state/forge-api.ts`, `src/lib/git-remote-url.ts`. | Existing GitHub behavior passes; nested/custom/fork identities and stale-request tests; all mutations use captured targets. |
| P2: GitLab connections and setup | P1 | `glab` process/auth adapter, mappings and connection service, Settings/onboarding, setup skill and preflight. `server/git/github-auth.js` compatibility, `src/ui/github-account.ts`, onboarding/settings, `src/skills/git-setup/`. | Existing login reused; hosted and self-hosted connection paths work; cancellation/env-token/network errors; no leaked token or changed Git helper. |
| P3: MRs and delivery | P2 | GitLab MR adapter, Source Control inspector, review IDs/head SHA, link parsing, issue/worktree/board publication and provider-aware recovery. `src/ui/scc-pulls.ts`, `scc-pr-detail.ts`, `src/chat/review/`, `src/chat/issues/`, `server/worktree/worktree-ops.js`. | Create/review/checkout/ready/merge/close including fork cases; uncertain-create reconciliation; provider/host collisions cannot mix reviews. |
| P4: Issues and migration | P3 | Generic issue binding and sync adapter; all parsers/mergers/tool writes and provider-aware sync UI/settings. `src/types.ts`, `src/state/issues-github*.ts`, `src/issues/github-*.ts`, `server/git/forge-issue-ops.js`, shared issue state code. | Legacy round trips and rollback tests; full metadata sync; parents/races/cooldowns/partial batches; remote changes never move a mirror. |
| P5: Pipelines | P3 | Pipeline/job models and adapter, dispatch schema/forms, logs/manual actions, shared action tools. `server/git/workflow-ops.js`, `action-service.js`, `action-tools.js`, `src/state/actions-api.ts`, `src/ui/scc-actions.ts`, `scc-checks.ts`, dispatch form. | Ref-specific inputs/variables, dispatch reconciliation, pagination, logs, retry/cancel/manual jobs, lower-version capability states. |
| P6: Releases | P5 | Native tag/asset adapter, persisted local drafts, draft range collection, AI writer reuse, release pipeline shortcut. `server/git/release-ops.js`, `release-draft-context.js`, `src/ui/scc-releases.ts`, `scc-release-workflow.ts`, `src/state/release-workflow.ts`, backup catalog. | Save stays local; explicit publish targets exact SHA; binary/link partial failures reconcile; full-history draft generation; GitHub release regressions pass. |
| P7: Scheduler automation | P4, P5, P6 | Generic watcher effects/config with legacy GitHub compatibility, GitLab notes/MR publication, editor and run display. `server/scheduler/github-watch*.js`, Scheduler config/runtime, `src/ui/scheduler/`, headless packaging. | Restart at each durable transition; no duplicate notes/MRs/claims; failed tests prevent publication; active GitHub jobs resume unchanged. |
| P8: Release qualification | P7 | Complete prompt/skill/terminology audit, accessibility/async lifecycle review, user docs for shipped behavior, architecture/storage docs, source inventory and packaging. | End-to-end scenarios below, full regression/build gates, manual hosted/self-hosted smoke records, capability/version matrix. |

Intermediate packages may merge with incomplete GitLab entry points gated by an internal feature flag; they do not constitute the requested full release. Only expose production support after P8. Keep GitHub available throughout.

## Verification and release gates

1. Contract fixtures exercise both adapters through the same operations, with provider-specific states, permissions, pagination, complete/partial results, 401/403/404/429, timeout, cancellation, and account changes.
2. Migration fixtures cover pre-change Issues JSON, state merging across windows, `issue_*` writes, review records, saved release workflows, active watcher jobs/ledgers, repeated migration, and supported rollback. Include same path/number on two hosts.
3. Local fake CLI/API fixtures exercise real argv/stdin/body-file handling and response parsing, plus uncertain mutation reconciliation. Do not test only adapter helper functions.
4. UI contracts cover native terms, disabled/unknown capabilities, draft preservation, workspace/branch/host changes, polling, disposal, keyboard use, and recovery. Existing local Git features work without a connected forge account.
5. Headless scenario: labeled GitLab issue -> Plan runner -> board -> passing tests -> push -> one MR -> one set of progress notes; repeat with restart and failed tests. Run the same GitHub regression scenario.
6. Manual scratch-repository scenarios on GitLab.com and a tested self-hosted instance: connect/create or clone; issue import and bidirectional metadata sync; agent edits; MR review/merge; pipelines/logs/manual action; local release draft -> publish with assets; Scheduler restart recovery. Record versions and actual passes separately from fixtures.
7. At implementation completion: `npm run test:check-coverage`, `npx tsc --noEmit`, affected suites, `npm test`, `npm run build`, `npm run headless:build`, `npm run check:performance-budgets`, and backup/restore coverage for added storage. Report unrelated baseline failures explicitly.
8. Update `documentation/context.md` only for implemented architecture/storage, and manual/README only when full GitLab support is released. Product direction belongs in `documentation/ROADMAP.md`; this file is the engineering proposal.

## Remaining implementation investigations

P0 owns these bounded investigations; none reduces the agreed release scope:

- Tested minimum versions and permitted feature fallbacks for self-hosted GitLab and `glab`, including custom instance base paths and trusted CA handling.
- Effective project permissions and merge policies on Free versus higher tiers; represent unavailable approval features without requiring a paid tier for the core workflow.
- Authoritative dispatch schema for CI includes/components and nondefault project CI configuration; show unknown schemas honestly where the server does not expose one.
- Generic Package upload behavior and cleanup ownership when the registry is disabled or a publish sequence partially succeeds.
- Rollback guarantees across shipped issue parsers that may drop unfamiliar fields; compatibility fixtures must establish the supported downgrade behavior before enabling GitLab mirroring.

No release dates or live-provider verification are claimed by this plan.
