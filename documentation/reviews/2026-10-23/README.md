# Minnow full review, 2026-10-23

Start with the [comprehensive report](COMPREHENSIVE-REPORT.md). It synthesizes the section reviews, separates confirmed defects from risks/proposals, and orders the work against the user-confirmed chat-driven product direction.

Follow-up: [prioritized remediation plan](../../plans/minnow-review-remediation-2026-10-23.md), with six phases, work packages, dependencies and acceptance gates. Reef placement remains undecided; confirmed Reef repairs stay in scope.

## Product brief and section reports

| Report | Coverage |
|---|---|
| [00. Review brief](00-review-brief.md) | Agreed product direction, evidence standards, priority definitions and scope. |
| [01. Chat engine and tools](01-chat-engine-and-tools.md) | Runner, transcripts, context, sessions, modes, tool policy, steering and recovery. |
| [02. Code workspace and runtime tools](02-code-workspace-and-runtime-tools.md) | Projects, files/editor/LSP, terminals, dev servers, preview/browser and worktree scope. |
| [03. Issues, Dashboard and planning](03-issues-dashboard-and-planning.md) | Capture, planning, dispatch, work ownership, review and status continuity. |
| [04. Orchestration, Git and delivery](04-orchestration-git-and-delivery.md) | Boards, checkpoints, tests, worktrees, merge approval, PR review and remote identity. |
| [05. Models, providers and routing](05-models-providers-and-routing.md) | Transports, CLIs, pools, quota, runtime admission, downloads, configuration and usage. |
| [06. Brain, memory and context](06-brain-memory-and-context.md) | Knowledge storage/retrieval/synthesis, proposals, indexing, attachments and injection. |
| [07. Extensions and assistant services](07-extensions-and-assistant-services.md) | Skills, plugins, MCP, prompts, voice, notifications and webhooks. |
| [08. Security, storage and devices](08-security-storage-and-devices.md) | Authentication, network boundaries, encryption, backups, restore, remote access and IPC. |
| [09. Scheduler, desktop and operations](09-scheduler-desktop-and-operations.md) | Headless execution, job supervision, cancellation, Electron, packaging and updates. |
| [10. Reef and product placement](10-reef-and-product-placement.md) | Generated-app lifecycle and verification, preview/export, isolation and product boundaries. |
| [11. Onboarding, navigation, settings and UX](11-onboarding-navigation-settings-and-ux.md) | Chat-first hierarchy, discovery, accessibility/themes, responsive and phone flows. |
| [12. Quality, performance, documentation and hidden surfaces](12-quality-performance-documentation-and-hidden-surfaces.md) | Tests/CI, maintainability, bundles/startup, documentation accuracy and gated code. |

## Evidence and limitations

The [verification ledger](evidence/root-verification-ledger.md) records primary-reviewer checks and independent reproductions. [Live observations](evidence/live-observations.md) explain screenshot provenance, the deterministic stub and browser-tool limitations. Section reports include exact runnable evidence commands and scoped test results.

This is a read-only application review. Only reports/evidence were added. No source repair, commit, remote Git mutation or publication is part of the deliverable. The full test suite and all supported native/provider/hardware paths were not exercised. An upstream logging defect caused a possible synthetic diagnostic write outside the requested scratch profile; one synthetic fixture cleanup was rejected by automatic policy. Both are disclosed in the comprehensive report and evidence ledger.
