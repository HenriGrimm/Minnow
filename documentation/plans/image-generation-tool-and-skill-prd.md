---
name: image-generation-tool-and-skill-prd
overview: "Add a provider-independent image-generation tool and bundled agent skill, configured in Models settings. Ship OpenAI and OpenRouter generation/editing first, preserve workspace permissions and durable assets across all agent surfaces, then add Mistral and evaluate safely mediated native Codex/Cursor generation. Record the remaining provider roadmap without claiming unverified support."
todos:
  - id: W1-A
    content: "Wave 1: Image configuration and capability contract"
    status: pending
  - id: W1-B
    content: "Wave 1: Durable image jobs and safe asset storage"
    status: pending
  - id: W2-A
    content: "Wave 2: OpenAI Images adapter"
    status: pending
  - id: W2-B
    content: "Wave 2: OpenRouter Images adapter"
    status: pending
  - id: W3-A
    content: "Wave 3: Shared tools, permissions and execution"
    status: pending
  - id: W3-B
    content: "Wave 3: Models settings image binding"
    status: pending
  - id: W3-C
    content: "Wave 3: Durable previews and agent image results"
    status: pending
  - id: W3-D
    content: "Wave 3: Bundled image-generation skill"
    status: pending
  - id: W4-A
    content: "Wave 4: Mistral Conversations adapter"
    status: pending
  - id: W4-B
    content: "Wave 4: Native CLI compatibility gate"
    status: pending
  - id: W5-A
    content: "Wave 5: Cross-surface acceptance and shipped documentation"
    status: pending
isProject: true
---

# Image Generation Tool and Skill — PRD

**Date:** 2026-10-06
**Goal:** Let Minnow agents create and edit raster assets using an independently selected image provider/model, with one permission, storage, and result pipeline.
**Granularity:** medium
**Status:** Launch implementation is present in the worktree; release verification is incomplete. See [verification results and remaining gates](image-generation-release-verification.md). Wave 4 remains follow-on work; the task checklist below is not a claim of completed release acceptance.
**Delivery:** Release 1 is Waves 1–3 plus W5-A verification. Wave 4 is the follow-on milestone; W5-A verifies the final combined delivery as well.
**Scope assumption:** The user declined further clarification. This document records the full provider/CLI direction, with two API adapters at launch, Mistral next, and native CLI support behind an explicit feasibility gate. It does not promise every researched provider in the first release.

## Context

The user wants image generation available to Minnow agents as both a tool and a skill, with the provider selected in model settings. Code is the primary product surface: an agent should generate an asset, save it in the current project/worktree, and use it in the application it is building. This is not a new image-editor app.

The existing chat provider need not generate images. A local text model, Claude Code, Codex, Cursor, or a board Builder should request the same Minnow tool, which uses the configured image backend. Image understanding and image generation are separate capabilities.

The repository already has encrypted provider credentials, role-specific model routing, a server-owned built-in tool catalog, shared runner image attachments, tool permissions, skills, and workspace scoping. Reuse those systems instead of introducing a plugin-only production implementation or a parallel chat engine.

### Verified baseline

- `server/tools/builtin-catalog.js` owns `BUILT_IN_TOOLS`; `src/tools/definitions.ts` re-exports it.
- `server/runtime/tools-middleware.js` dispatches `SERVER_TOOL_HANDLERS` through `executeServerTool`, with workspace and abort context.
- `server/providers/store.js:getProviderRuntime` supplies profile, private secrets, auth headers, and paths server-side.
- `src/ui/settings-model-routing.ts:renderModelRoutingSection` and `saveRow` are existing routing UI integration points. Image binding must not inherit ordinary chat fallback or token sampler controls.
- `src/config/utility-model-meta.ts` demonstrates config-meta persistence; `server/config/validators.js:mergeConfigMeta` validates updates.
- `src/types.ts:ToolImageAttachment` and `src/ui/tool-messages.ts:renderToolResult` already support image results, but text and styling assume screenshots.
- `server/runner/tool-image-follow-up.js` currently sends at most two recent tool-image follow-ups and uses screenshot-specific wording.
- `scripts/generate-skills-manifest.mjs:main` discovers named `src/skills/*/SKILL.md` directories. Missing skill enable flags default to enabled.
- Codex `image_generation` is explicitly disabled in `server/generations/codex-app-server/manager.js` and `server/generations/agent-cli/invocation.js`.
- Cursor ACP `cursorPermissionAllowed` only accepts exposed Minnow tool permissions. Native image generation is not an integrated fallback.
- Tests are auto-discovered under `test/`; use `npm test`, `npm run test:check-coverage`, and `npm run build`.

## Product requirements

### Users and jobs

| User story | Observable success |
|---|---|
| As a developer, choose an image backend separately from my chat model. | Changing the image binding does not change the composer model; the next image job uses the new binding. |
| As an agent, generate a hero image or texture while building. | The result is a real workspace file with dimensions, MIME type, and provenance, not just an expiring URL. |
| As a developer, revise an image using a reference. | A new version is created without overwriting the input. |
| As a local-model user, use a remote image service explicitly. | Approval identifies the destination and reference files leaving the machine. |
| As a board or headless agent, use the same feature. | Outputs stay in the assigned worktree and permissions remain enforceable without a renderer. |
| As a user without image configuration, understand what to do. | A clear setup error points to Models → Routing → Image generation; no silent fallback or billable probe occurs. |

### FR-1 — Models configuration

Add an **Image generation** section within **Models → Routing**, also reachable through the existing Settings model-routing page. Do not create a new app.

Required controls:
- Enabled toggle, initially off.
- Provider connection selector using existing stored provider identities.
- Image adapter selector, inferred only for verified built-in services; explicit for a custom endpoint.
- Image model selector populated from an image-capable catalog, with validated manual IDs when discovery is unavailable.
- Default aspect ratio or dimensions, quality, format, and background only when supported.
- **Check connection** performs non-generative metadata validation only.
- **Generate test image** is explicitly billable and follows the same tool approval path, never an unguarded settings POST.
- Link to Providers for credentials; secrets never live in the image binding.
- Status: Not configured / Ready / Unavailable / Unsupported / Verification required. A missing catalog is not falsely labeled Ready.

Proposed config-meta key `imageGeneration`:
`{ enabled, providerId, adapterId, modelId, defaults, maxConcurrentJobs, timeoutSeconds }`.
Default concurrency is 1 and timeout is 600 seconds, bounded by validation. One global binding at launch; no hidden per-chat binding, automatic failover, or automatic cloud fallback. Jobs pin the binding at approval time. Changes during approval invalidate that approval; changes after submission affect only future jobs.

Keep image-only models out of normal chat pickers. A custom OpenAI-compatible chat URL does not imply Images API support. The image settings select/configure an adapter without rewriting the provider's chat API kind.

### FR-2 — Agent-facing contract

Add primary mutating tool `generate_image`:
- Required: `prompt` (bounded nonempty string).
- Optional: `operation: generate | edit` (default generate), `reference_paths`, `output_path`, `aspect_ratio`, `size`, `quality`, `format`, `background`.
- One output per call at launch; no bulk `n` parameter.
- Edit requires at least one readable reference and an edit-capable model.
- Arguments contain no credentials, arbitrary provider URLs, or automatic provider overrides.
- Reject unsupported parameters before any billable request. Do not silently drop a requested transparent background or edit input.

Add companion read-only tool `image_generation_info` with optional `job_id`:
- Without ID: effective configured binding, redacted readiness and model capabilities.
- With ID: job status/result for the caller's authorized workspace.
- Never exposes another workspace's job, secret headers, or provider-signed download URLs.

Result contract: `jobId`, `status`, `providerId`, `modelId`, `artifacts[]` with relative path, MIME, width, height, byte count, and SHA-256; optional actual usage/cost and structured error. Return compact text plus bounded image attachment metadata. Do not stringify full image payloads into tool text.

The tool normally waits for completion within its configured deadline. A canceled, timed-out, or interrupted call retains a stable job ID; `image_generation_info` can inspect it without submitting another paid request. No model-driven tight polling loop is required.

### FR-3 — Generation and editing

Launch supports text-to-image and reference-image editing where the selected backend supports them. Preserve requested purpose, composition, style, and output requirements. PNG is preferred when supported, but never rename another format to .png.

Default output: `assets/generated/<job-id>.<actual-extension>`.
Explicit output paths must remain inside the bound workspace/worktree. Existing files are never overwritten by this tool in v1; return a collision error and let the agent choose another name. References may not be modified. A follow-up edit creates a new asset, linked by parent artifact IDs/hashes in provenance.

Mask editing, batch variants, upscaling, seeds, and provider-specific advanced controls are post-launch capabilities, not assumed common options.

### FR-4 — Permissions and safety

- Default mutating permission: Ask. Full must be an explicit existing user permission choice; never grant it when enabling the skill or configuring a provider.
- Approval identifies operation, destination provider/model, output path, reference paths, and whether data leaves the machine; display known estimated price with provenance, or “Cost unavailable; provider charges may apply.”
- Plan-mode agents cannot generate/edit, even if output is under documentation/plans. They may inspect configuration/status and prepare prompts.
- Build/General/Debug and permitted Builder agents can use it through normal mode/role policy. Read-only reviewer roles do not gain mutation access.
- Headless/unattended runs must follow existing permission policy: no hanging interactive prompt and no implicit approval.
- Use realpath-aware containment for references and output parents, reject traversal, drive/UNC escapes and symlink escapes, including in worktrees. Do not rely on a string-prefix check or shell cwd guard.
- Resolve provider credentials on the server only. Redact errors/logs. Never forward auth headers to returned artifact URLs on unrelated hosts.
- Download provider artifacts through bounded, validated HTTP(S) retrieval; revalidate redirects, block unexpected private/link-local/metadata destinations. Explicit configured local backend addresses are a separate authorized case.
- Enforce byte and decoded-pixel limits before displaying/decompressing images. Accept only verified PNG/JPEG/WebP raster content at launch; reject HTML/SVG/executable payloads and MIME mismatches.
- Provider refusals/moderation errors are shown honestly, not retried on another provider to bypass them.

### FR-5 — Job lifecycle, durability and cancellation

State machine:
`queued → submitting → running → succeeded | failed | canceled | outcome_unknown`.

Persist intent before submission, provider request ID when available, status transitions, and output metadata. Use an internal request identity based on the runner execution/tool-call identity, not model-generated arguments. Replaying the same call returns its recorded state/result. An intentional new generation receives a new identity.

Never auto-resubmit a non-idempotent request after an ambiguous timeout, socket failure, or crash. Mark outcome_unknown unless status can be recovered using a known upstream ID. Status polling and safe downloads may retry with bounded backoff; generation POSTs may not blindly retry.

Cancel aborts local fetch/polling promptly and attempts upstream cancel only where documented. The UI explicitly warns that already accepted remote jobs may still complete or incur charges. A late success cannot resurrect a canceled visible job or silently write an unapproved output.

Store operational journals under `~/.minnow/image-generation/`, scoped by canonical workspace identity. Register this root with the backup catalog; exclude transient jobs/download caches from backups initially. Workspace output images remain ordinary project files. Default retain operational records for 30 days; cleanup must not delete workspace assets or active jobs. Do not store raw reference bytes or secrets in journals. The prompt can remain in the existing chat record; journal a prompt hash unless a user explicitly exports provenance.

Successful assets are written atomically with exclusive destination creation. A storage failure after paid generation retains a recoverable temporary artifact and job ID; recovering the download/write must not regenerate the image. Session deletion does not delete workspace assets.

### FR-6 — Display, inspection and usage

- Show a generated-image result within the existing tool card: preview, file path, provider/model, dimensions, and known usage/cost.
- Open asset and Copy path are user actions, not implicit navigation. Any clipboard acceptance test uses a real button click.
- Previews reopen from workspace assets after app restart; do not persist expiring provider URLs or per-boot auth tokens.
- Prefer the existing authenticated workspace file-serving path; no new executable preview origin.
- A vision-capable agent can receive a bounded thumbnail through existing tool-image follow-up handling. A text-only agent receives path/metadata and must not claim to have inspected pixels.
- Reuse context image limits; remove screenshot-only wording for generated artifacts without breaking browser screenshots.
- Store actual provider-reported image usage separately from chat token totals. Null/unknown cost is not zero. Do not count polling/repaint as additional generations or invent subscription-dollar costs.
- First release needs durable per-job usage in result cards; aggregate Usage & cost reporting is a later extension.

### FR-7 — Built-in skill

Create `src/skills/image-generation/SKILL.md`, named `image-generation`, user-invocable as **/image-generation**, discoverable to compatible agent runtimes.

Skill workflow:
1. Decide whether raster generation is appropriate. Use existing SVG/code-native assets for diagrams/UI structure where better; use the project's icon system for interface icons.
2. Inspect the project asset conventions and call `image_generation_info`.
3. If configuration is missing, direct the user to Models settings; do not invent credentials or silently use a native CLI generator.
4. Ask only for material missing constraints: subject, purpose, composition, size, transparency, and what must remain unchanged in edits.
5. Invoke `generate_image` through Minnow; respect approvals and Plan-mode restrictions.
6. Inspect the result only when vision is available; check actual path/format/dimensions regardless.
7. Use the saved path in the project only when the current task/mode authorizes edits. Report the asset and its limitations.
8. For iteration, refer to the prior saved file, preserve originals, and make new paid calls explicit.

No embedded API keys, shell-based API bypass, implicit install, or vendor-specific model name in the core skill. Disablement must remove the slash entry. Avoid collisions with a vendor's native `imagegen` skill by keeping the Minnow name explicit.

## Provider and CLI support matrix

“Supported” here describes a researched vendor capability, not an implemented Minnow adapter.

| Backend | Integration | Delivery |
|---|---|---|
| OpenAI | Direct Images generations/edits; existing provider credentials | Release 1 |
| OpenRouter | Dedicated Image API plus image model/endpoint capabilities; existing key | Release 1 |
| Mistral | Agents/Conversations image tool and Files download | Follow-on task W4-A |
| Google | Gemini/Imagen via Google APIs; Vertex generation verified, Developer API auth/schema still to reverify | Subsequent adapter |
| xAI | Imagine image generations/edits API | Subsequent adapter |
| Black Forest Labs | FLUX submit/poll/download API | Subsequent adapter |
| fal | Hosted image model endpoints and queued jobs | Subsequent adapter |
| Replicate | Hosted image model predictions; credential requirements vary by model | Subsequent adapter |
| Local image service | Explicit adapter and local endpoint; proposed ComfyUI route requires separate API research | Subsequent adapter; no automatic runtime installer |
| Anthropic / Claude Code | No native photo/illustration generation verified; can orchestrate Minnow tool | Supported as caller at launch |
| DeepSeek / Groq / Go / Zen | No image output route established in reviewed docs | Caller only; not advertised as image backend |
| GitHub Copilot connection | Image-generation endpoint not established | Caller if tools supported; no generation claim |
| LM Studio / Ollama | Do not infer image output from vision or OpenAI chat compatibility | Caller; custom backend only after explicit verification |
| Codex native | Vendor documentation describes native image generation using Codex usage; Minnow disables feature today | Gated W4-B evaluation, not enabled at launch |
| Cursor native | CLI changelog documents generation; billing and exact headless/ACP contract not verified | Gated W4-B evaluation, not enabled at launch |

All later adapters must implement the same request/result/capability contract and safety tests. Adding an adapter must not require changing the skill. Do not ship unsupported provider names as selectable working backends.

### Native CLI release gate

Native Codex/Cursor generation is an optional backend, not permission to bypass Minnow. Before enabling either, prove:
- An official, versioned headless/app-server/ACP invocation supports generation under the installed account.
- Minnow can approve the specific operation before it occurs and pin its prompt/references/output.
- Artifact bytes and status events can be captured without enabling unrelated native tools.
- Cancellation, usage semantics, isolation, replay, and reference uploads meet FR-4/5.
- The capability is discoverable and unavailable accounts/versions fail clearly.
- Existing login may be reused only through the vendor-supported CLI path; never extract subscription tokens to call private image endpoints.
- Native usage is labeled as subscription/native usage, not a free API or an unlimited allowance.

W4-B produces a measured go/no-go report. Enabling a native backend requires a follow-up implementation plan based on verified protocol details; simply removing `image_generation = false` is not acceptable.

## Non-goals

No standalone studio/gallery, canvas editor, mask painter, video/audio generation, batch factory, model-weight installer, implicit paid fallback, global workspace-wide asset rewrites, external reference URLs as tool arguments, or automatic publication. No guarantee of copyright ownership, model availability, or fixed provider prices.

## Architecture / Key Files

Existing files below were inspected or located in this session. CREATE entries are proposed new files, not claims about the current tree.

| File | Role | Action |
|------|------|--------|
| `server/config/home.js`, `server/config/validators.js` | Defaults and config-meta validation | MODIFY |
| `src/config/image-generation-meta.ts` | Image settings client | CREATE |
| `server/image-generation/contracts.js`, `contracts.d.ts`, `config.js` | Shared normalization, capability contract, binding | CREATE |
| `server/image-generation/jobs.js`, `assets.js` | Durable lifecycle and safe output handling | CREATE |
| `server/image-generation/adapters/openai.js`, `openrouter.js`, `mistral.js` | Vendor protocol boundaries | CREATE |
| `server/providers/store.js` | Reuse getProviderRuntime | REUSE |
| `server/runtime/path-access.js` | Reuse workspace context/path enforcement | REUSE |
| `server/backup/catalog.js` | Operational storage classification | MODIFY |
| `server/tools/image-generation.js` | Shared tool handlers | CREATE |
| `server/tools/builtin-catalog.js`, `server/runtime/tools-middleware.js` | Tool schema and dispatch | MODIFY |
| `server/runner/tool-set.js`, `src/chat/modes/tool-groups.ts` | Agent/mode exposure | MODIFY |
| `server/tools/plan-write-guard.js`, `src/chat/modes/plan-write-guard.ts` | Explicit Plan mutation denial | MODIFY |
| `src/settings/model-routing-catalog.ts`, `src/ui/settings-model-routing.ts` | Image binding entry point | MODIFY |
| `src/ui/settings-image-generation.ts` | Capability-aware settings controls | CREATE |
| `src/types.ts`, `src/ui/tool-messages.ts` | Image result semantics | MODIFY |
| `server/runner/tool-image-follow-up.js` | Model-visible preview contract | MODIFY |
| `src/skills/image-generation/SKILL.md` | Minnow skill | CREATE |
| `scripts/generate-skills-manifest.mjs`, `src/skills/builtin-manifest.json` | Existing skill discovery/generated inventory | REUSE / REGENERATE |
| `server/generations/codex-app-server/manager.js`, `server/generations/agent-cli/invocation.js`, `server/generations/agent-cli/cursor-acp.js` | Native CLI isolation evidence | READ |
| `documentation/manual/apps/models.md`, `documentation/context.md` | Shipped usage and architecture | MODIFY AT RELEASE |

### Proposed internal symbols

- `normalizeImageGenerationConfig`, `validateImageRequest`, `normalizeImageCapabilities`.
- `resolveImageGenerationBinding`: enabled, configured, supported, existing provider; no chat fallback.
- `ImageGenerationConfig`, `ImageCapabilities`, `ImageRequest`, `ImageJob`, `ImageArtifact`, `ImageProviderAdapter` declaration types.
- Adapter interface: `describeModels`, `generate`, optional `edit`, `getStatus`, `cancel`; each accepts abort context and returns normalized data. Unsupported operations are explicit.
- `createImageJob`, `transitionImageJob`, `getImageJob`, `recoverImageJobs`, `cleanupImageJobs`.
- `validateImageReference`, `downloadImageArtifact`, `writeImageArtifact`, `resolveImageArtifact`.
- `toolGenerateImage`, `toolImageGenerationInfo`, `registerImageAdapter`, `getImageAdapter`.
- `loadImageGenerationConfig`, `saveImageGenerationConfig`, `renderImageGenerationSettings`.

## Wave Breakdown

Waves describe delivery stages, not implicit scheduler barriers. Dependencies below are authoritative. Commands in Test fields are requirements for future Builders, not claims of execution in this planning session.

### Wave 1 — Configuration and durable foundations

#### Task W1-A: Image configuration and capability contract
- **Build:** Add contracts.js/contracts.d.ts/config.js and src/config/image-generation-meta.ts with the proposed config, request, and capability symbols. Extend DEFAULT_META in server/config/home.js and mergeConfigMeta in server/config/validators.js with strict bounds, disabled defaults, merge/reset behavior, and server-side binding resolution via getProviderRuntime. Create server/image-generation/adapter-registry.js with registerImageAdapter/getImageAdapter; initially no adapters. Define the job/adapter interfaces W1-B and Wave 2 consume. Preserve existing provider credentials and chat routing. Scope: configuration and declarations, about 5–8 small modules including tests.
- **Test:** Add test/image-generation/config.test.mjs; run `node --test --test-force-exit test/image-generation/config.test.mjs`. Assert old profiles remain disabled, invalid limits fail, unknown providers/adapters cannot resolve, partial patches preserve unrelated settings, and no secret enters client config. Run `npx tsc --noEmit`.
- **Accept:** A valid saved binding resolves independently of the chat model; unconfigured or unsupported bindings cannot make a request.
- **Touches:** server/image-generation/contracts.*, server/image-generation/config.js, server/image-generation/adapter-registry.js, server/config/home.js, server/config/validators.js, src/config/image-generation-meta.ts, test/image-generation/config.test.mjs

#### Task W1-B: Durable image jobs and safe asset storage
- **Build:** Implement jobs.js and assets.js using W1-A types and the existing runtime/path-access.js context. Add the job/provenance functions, request-identity deduplication, restart recovery, atomic non-overwriting output, download validation, safe reference loading, cleanup, and abort propagation from FR-4/5. Add a bounded thumbnail helper only if existing project image utilities can support it; document any needed dependency rather than adding a heavy renderer runtime. Register operational storage in server/backup/catalog.js. Scope: server storage/validation and isolated tests.
- **Test:** Add test/image-generation/jobs.test.mjs and assets.test.mjs; run `node --test --test-force-exit test/image-generation/jobs.test.mjs test/image-generation/assets.test.mjs`. Assert same execution identity produces one submission, crash-after-submit becomes unknown without replay, symlink/traversal/collision attacks fail, HTML masquerading as PNG fails, redirects cannot reach metadata services, abort cleans partial files, and successful assets survive journal cleanup. Run `npm run test:backup`.
- **Accept:** One logical job yields at most one submitted generation and one safe, durable workspace artifact, including after interruption.
- **Touches:** server/image-generation/jobs.js, server/image-generation/assets.js, server/image-generation/thumbnails.js, server/backup/catalog.js, test/image-generation/jobs.test.mjs, test/image-generation/assets.test.mjs
- **Depends on:** W1-A

### Wave 2 — Launch API adapters

#### Task W2-A: OpenAI Images adapter
- **Build:** Add createOpenAIImageAdapter in server/image-generation/adapters/openai.js. Use documented direct Images generations and multipart edits, existing server credentials, bounded response decoding, and aborts; prefer built-in fetch/FormData rather than a new SDK dependency. Provide a versioned capability table/catalog for confirmed models without guessing output capability from chat model names. Reject unsupported controls; normalize request IDs, outputs, refusals, and actual usage. Do not use Codex login tokens. Scope: one adapter plus fixture tests; W3-A owns production registration.
- **Test:** Add test/image-generation/openai.test.mjs; run `node --test --test-force-exit test/image-generation/openai.test.mjs`. Fake upstream asserts endpoint/auth, reference multipart bytes, transparent-format validation, base64 results, 401/429/moderation handling, cancellation, and no automatic POST retry.
- **Accept:** Fake-provider generation and edit each produce a normalized artifact with only documented parameters sent upstream.
- **Touches:** server/image-generation/adapters/openai.js, test/image-generation/openai.test.mjs
- **Depends on:** W1-A

#### Task W2-B: OpenRouter Images adapter
- **Build:** Add createOpenRouterImageAdapter in server/image-generation/adapters/openrouter.js. Use the dedicated Image API, image-model capability discovery and endpoint descriptors. Do not route new implementation through generic chat completions. Normalize parameter differences, output/usage fields and endpoint selection, with bounded metadata caching and stale-state labeling. Keep the selected service explicit; provider-internal routing must be disclosed where returned. Scope: one adapter plus tests; W3-A owns registration.
- **Test:** Add test/image-generation/openrouter.test.mjs; run `node --test --test-force-exit test/image-generation/openrouter.test.mjs`. Assert capability-driven fields, refresh failures, unsupported parameter rejection before POST, missing usage stays null, actual reported costs survive normalization, and artifact credentials never leak.
- **Accept:** Two differently capable fake catalog models produce valid requests or clear preflight errors without changing the tool schema.
- **Touches:** server/image-generation/adapters/openrouter.js, test/image-generation/openrouter.test.mjs
- **Depends on:** W1-A

### Wave 3 — Shared agent and user experience

#### Task W3-A: Shared tools, permissions and execution
- **Build:** Create server/tools/image-generation.js with toolGenerateImage/toolImageGenerationInfo and server/image-generation/service.js with executeImageGeneration/describeImageGeneration. Register launch adapters in a new bootstrap.js. Wire BUILT_IN_TOOLS, SERVER_TOOL_HANDLERS/executeServerTool, image-specific permission descriptions, default Ask, headless/Builder exposure and explicit Plan denial in both guards. Propagate trusted execution identity and abort signal through shared runner tool dispatch; never derive approval identity from model args. Add metadata-only action to image_generation_info for settings catalog retrieval without generation. Reuse existing permission infrastructure; prevent direct routes/CLI bridges bypassing mode and Off checks. Scope: narrow image branches across shared tool/policy seams; no general runner refactor.
- **Test:** Add test/image-generation/tool.test.mjs and permissions.test.mjs; run `node --test --test-force-exit test/image-generation/tool.test.mjs test/image-generation/permissions.test.mjs`, `npm run test:engine`, and `npx tsc --noEmit`. Assert Ask denial makes zero provider calls, Full is explicit, Off and Plan deny, headless cannot hang for approval, changed binding needs new approval, stopped jobs cannot write late output, and info cannot read another workspace's job.
- **Accept:** The same permission-gated tool produces a durable asset for chat and headless callers while Plan and denied calls produce none.
- **Touches:** server/tools/image-generation.js, server/image-generation/service.js, server/image-generation/bootstrap.js, server/tools/builtin-catalog.js, server/runtime/tools-middleware.js, server/runner/**, src/chat/modes/tool-groups.ts, src/chat/modes/plan-write-guard.ts, server/tools/plan-write-guard.js, src/tools/describe-invocation.ts, src/tools/permission-gate.ts, src/config/defaults.ts, src/agents/defaults/**, test/image-generation/tool.test.mjs, test/image-generation/permissions.test.mjs
- **Depends on:** W1-A, W1-B, W2-A, W2-B

#### Task W3-B: Models settings image binding
- **Build:** Add renderImageGenerationSettings in src/ui/settings-image-generation.ts; integrate with renderModelRoutingSection and loadModelRoutingCatalog without applying chat fallback chains, token samplers, or reasoning controls. Use W1-A config helpers and W3-A read-only capabilities. Handle save failures honestly: acknowledge saved state only after success; keep unsaved edits and Retry. Add a settings-search entry through the existing registry generator path, not a manual generated-manifest edit. Use existing form rows, --mn-* tokens, and Uicons; keyboard labels, focus and narrow layouts must work. No visual redesign or new app.
- **Test:** Add test/ui/settings-image-generation.test.mts using existing happy-dom patterns. Run `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --test --test-force-exit test/ui/settings-image-generation.test.mts` and `npx tsc --noEmit`. Assert persistence/reload, no chat-binding changes, disabled/unknown provider states, unsupported options hidden, catalog errors, settings search destination, and metadata checks cause zero generation calls. A real click on Generate test image must enter ordinary approval.
- **Accept:** Selecting and saving a provider/model in Models controls the next image tool call without changing the chat model.
- **Touches:** src/ui/settings-image-generation.ts, src/ui/settings-model-routing.ts, src/settings/model-routing-catalog.ts, src/styles/settings-routing.css, src/settings/**, scripts/generate-settings-registry.mjs, server/settings/registry-manifest.json, test/ui/settings-image-generation.test.mts
- **Depends on:** W1-A, W3-A

#### Task W3-C: Durable previews and agent image results
- **Build:** Extend ToolImageAttachment with backward-compatible optional generated-artifact metadata, update renderToolResult and toolImageFollowUpFromAttachments for neutral image wording and durable workspace references. Add renderGeneratedImageResult in src/ui/generated-image-result.ts for Open asset/Copy path and job metadata; use existing authenticated file serving and path-opening affordances. Keep thumbnails bounded, vision follow-ups ephemeral, old screenshots intact, and missing/deleted assets explicit. Ensure persistent history contains no signed provider URL/auth token. If session normalization needs adjustment, include a targeted migration/passthrough change. Scope: result rendering and shared attachment compatibility, not a new gallery.
- **Test:** Add test/ui/generated-image-result.test.mts and test/image-generation/image-follow-up.test.mjs. Run the UI file with the tsx/test-loader command used in W3-B and the JS file with `node --test --test-force-exit`; run `npm run test:attachments`. Assert restart reconstruction, missing file state, non-vision metadata-only output, context image limits, screenshot regressions, and no duplicate usage on rerender. Browser Copy path verification must click the real app button first.
- **Accept:** A saved generated image remains visible after history reload and is inspectable only by vision-capable agents.
- **Touches:** src/types.ts, src/ui/tool-messages.ts, src/ui/generated-image-result.ts, src/styles/generated-image-result.css, server/runner/tool-image-follow-up.js, server/runner/tool-image-follow-up.d.ts, src/state/session-schema/**, test/ui/generated-image-result.test.mts, test/image-generation/image-follow-up.test.mjs
- **Depends on:** W3-A

#### Task W3-D: Bundled image-generation skill
- **Build:** Add src/skills/image-generation/SKILL.md with FR-7 instructions and examples for generation/editing. Use name image-generation, a concise label and discoverable description. Regenerate src/skills/builtin-manifest.json via the existing main generator; do not edit vendored external skills. Include setup failure, no-vision, Plan mode, reference upload, budget uncertainty, and no-native-bypass instructions. Scope: skill and discovery tests only.
- **Test:** Add test/skills/image-generation.test.mjs; run `node --test --test-force-exit test/skills/image-generation.test.mjs` and `npm run test:skills`. Assert frontmatter/discovery, enable/disable behavior, referenced tool names exist, no hardcoded credentials/models, and examples map to valid schemas. Manually exercise slash discovery in chat and skill exposure through each supported CLI bridge; record blocked cases.
- **Accept:** /image-generation is discoverable and directs agents to the configured Minnow tools without bypassing permissions.
- **Touches:** src/skills/image-generation/**, src/skills/builtin-manifest.json, test/skills/image-generation.test.mjs
- **Depends on:** W3-A

### Wave 4 — Follow-on provider and native CLI evaluation

#### Task W4-A: Mistral Conversations adapter
- **Build:** Add createMistralImageAdapter in server/image-generation/adapters/mistral.js and register it in bootstrap.js. Use the officially documented Agents/Conversations image_generation tool and Files download. Reverify current schema first; specify server-side agent lifecycle, avoid creating an unbounded agent per request, and preserve cancellation/unknown outcomes. Advertise only confirmed capabilities; do not promise reference editing or direct Images API compatibility. Scope: adapter and registration; no skill changes.
- **Test:** Add test/image-generation/mistral.test.mjs; run `node --test --test-force-exit test/image-generation/mistral.test.mjs`. Verify agent/conversation request fixture, authenticated file download, no unbounded agent creation, no-file/refusal outcomes, unsupported edit preflight and no duplicate paid retries.
- **Accept:** A Mistral-backed request uses the same Minnow tool and result shape while unavailable features are rejected before submission.
- **Touches:** server/image-generation/adapters/mistral.js, server/image-generation/bootstrap.js, test/image-generation/mistral.test.mjs
- **Depends on:** W3-A

#### Task W4-B: Native CLI compatibility gate
- **Build:** Inspect the installed Codex app-server and Cursor headless/ACP versions against current official docs. Add read-only capability probes as probeCodexImageGeneration and probeCursorImageGeneration in a new server/image-generation/native-capabilities.js; report version/auth/protocol requirements without submitting a generation. Read the existing isolation code, do not remove its deny rules. Write documentation/plans/image-generation-native-cli-findings.md recording the full native gate and a go/no-go verdict per CLI. Live paid generation is optional and requires explicit user authorization, otherwise mark it unverified. A no-go result is acceptable; no native backend becomes selectable from this task.
- **Test:** Add test/image-generation/native-capabilities.test.mjs; run `node --test --test-force-exit test/image-generation/native-capabilities.test.mjs`. Assert missing/old versions, unauthenticated states, unknown capabilities, and native permission attempts remain denied. Document test evidence and remaining requirements in the findings file.
- **Accept:** Each native CLI has an evidence-backed readiness verdict, with no broadened permissions or misleading selectable backend.
- **Touches:** server/image-generation/native-capabilities.js, test/image-generation/native-capabilities.test.mjs, documentation/plans/image-generation-native-cli-findings.md
- **Depends on:** W3-A

### Wave 5 — Acceptance and documentation

#### Task W5-A: Cross-surface acceptance and shipped documentation
- **Build:** Add test/image-generation/end-to-end.test.mjs using the real tool runtime with fake image HTTP endpoints and temporary workspace/home. Cover UI-independent dispatch, configuration, job persistence, native CLI calls through Minnow's exposed tools, board worktree isolation, cancellation and replay. Update documentation/manual/apps/models.md and create documentation/manual/extend/image-generation.md only for implemented features; update documentation/context.md with architecture/storage. Record remaining provider/native work in documentation/ROADMAP.md and the release verification report, not as shipped manual claims.
- **Test:** Run `node --test --test-force-exit test/image-generation/end-to-end.test.mjs`, `npm run test:check-coverage`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run headless:build`, and `npm run check:performance-budgets`. Record baseline failures rather than claiming all tests passed. Manually test settings → approval → image → file use → restart, then repeat with a text-only chat model and available Claude/Codex/Cursor bridges. Paid provider smoke tests require opt-in and are reported separately from fixture coverage.
- **Accept:** The end-to-end acceptance matrix below passes for supported surfaces/providers, and unavailable native/provider paths remain clearly unavailable.
- **Touches:** test/image-generation/end-to-end.test.mjs, test/image-generation/fixtures/**, documentation/manual/apps/models.md, documentation/manual/extend/image-generation.md, documentation/context.md, documentation/ROADMAP.md, documentation/plans/image-generation-release-verification.md
- **Depends on:** W3-A, W3-B, W3-C, W3-D, W4-A, W4-B

## Verification Checklist

- [ ] Provider selection persists across restart and never changes chat model selection.
- [ ] Check connection makes no paid generation call.
- [ ] OpenAI and OpenRouter generate and edit using fake documented protocol fixtures.
- [ ] Mistral only exposes capabilities actually verified for its adapter.
- [ ] Claude Code, Codex and Cursor callers can use the exposed Minnow tool; native bypass remains blocked.
- [ ] Full/Ask/Off and Plan/role policy are identical across renderer, headless and board execution.
- [ ] Concurrent worktrees cannot see or write each other's image references, jobs or outputs.
- [ ] Existing files and reference images are never overwritten.
- [ ] Cancellation, timeout and crash-after-submit never trigger silent paid regeneration.
- [ ] Generated artifacts survive restart; journals contain no secrets or raw reference payloads.
- [ ] Unsupported options fail before submission; non-vision agents do not claim visual inspection.
- [ ] Per-job usage is accurate when provided and clearly unknown otherwise.
- [ ] Skill discovery, disablement and invocation work without native vendor skill collisions.
- [ ] Path, redirect, MIME, byte-size and pixel-size safety tests pass.
- [ ] Settings and result cards work with keyboard navigation, narrow windows and existing light/dark themes.
- [ ] `npm run test:check-coverage`, `npx tsc --noEmit`, `npm test`, `npm run build`, and `npm run headless:build` pass, or separately documented pre-existing failures have owners.
- [ ] No live charge, account entitlement, billing claim or CLI capability is presented as tested without evidence.

## Success metrics and release gates

No new remote analytics. Measure using local jobs and test reports:
- Zero duplicate paid submissions in interruption/replay fixtures.
- Zero unapproved network submissions or out-of-workspace writes in safety fixtures.
- 100% successful fake-provider jobs result in valid saved artifacts plus compact tool results.
- Every supported surface reaches the same image service and selected binding.
- Provider response failures, permission denials and invalid inputs have distinct actionable messages.
- Vendor latency is reported, not a fabricated generation SLA; settings/catalog work must remain responsive while a job is running.

## Risks and decisions

- **Native versus API:** API integration is more consistent and easier to mediate; native CLI usage may save separate API setup but is version/account dependent. Start with APIs; retain native isolation until proven.
- **Plugin versus core:** Plugins are useful prototypes, but the requested Models integration and cross-agent consistency justify a core service for this PRD.
- **Catalog churn:** Store model IDs and capability evidence; reverify vendor contracts at implementation. Never hardcode “latest” pricing or assume all models support transparency/editing.
- **Ambiguous charges:** Exactly-once remote execution cannot be guaranteed across all network failures. Minnow guarantees no blind resubmission and reports outcome_unknown.
- **Persistence:** Large files live in the workspace; operational storage has explicit retention and backup exclusion. Deleting chat history must not delete project assets.
- **Provider coverage:** Google/xAI/BFL/fal/Replicate/local adapters are documented expansion targets, not work silently bundled into this launch plan.
- **Native gate outcome:** A failed gate does not block API support; it blocks claiming a native backend. W5-A's dependency waits for a verdict, not a positive verdict.

## Notes for Build Agents

Use existing JS server/TS client conventions. New names above are proposals; existing symbols were checked in this session. Revalidate baselines before editing.

The Planner did not run code, generate images, change permissions, or test live credentials. Vendor documentation establishes support, not account entitlement. Two guessed navigation paths (src/skills/registry.ts and src/ui/settings-models.ts) did not exist; use the verified discovery/routing files listed above.

Tests use temporary homes/workspaces and fake providers by default. Do not modify the live ~/.minnow profile or spend credits as part of ordinary CI. No private subscription endpoints or credential extraction.

Shared runner Touches in W3-A are intentionally broad because execution identity/abort propagation spans existing tool adapters; W3-C depends on it to avoid concurrent edits. W3-B owns settings registry regeneration; W3-D owns skill manifest regeneration. New packages, new preview routes, or expanded API scopes require a scoped plan update rather than improvisation.

No product UI mockups are required for this PRD: the design intent is reuse of existing settings rows and tool cards, not visual redesign. PRODUCT.md and DESIGN.md were read directly because this planning environment does not permit running the Impeccable loader.

### Research references

Official pages were retrieved during the conversation; facts are time-sensitive. Reverify exact schemas/model IDs when implementing. Context7 /websites/developers_openai_api additionally confirmed multipart edits and Images endpoints.

- OpenAI Images: https://developers.openai.com/api/docs/guides/image-generation
- OpenAI edit reference: https://developers.openai.com/api/reference/resources/images/methods/edit
- OpenRouter unified Images API: https://openrouter.ai/blog/announcements/image-api
- Mistral image tool: https://docs.mistral.ai/studio/agents/agent-tools/image_generation
- Google Vertex images: https://cloud.google.com/vertex-ai/generative-ai/docs/image/overview
- xAI Imagine: https://docs.x.ai/docs/guides/image-generation
- BFL submit/poll: https://docs.bfl.ai/quick_start/generating_images
- fal model APIs: https://docs.fal.ai/model-apis/quickstart
- Replicate image catalog: https://replicate.com/collections/text-to-image
- Codex native images: https://developers.openai.com/codex/image-generation
- Cursor CLI evidence: https://cursor.com/docs/cli/changelog
- Claude image limitations: https://support.claude.com/en/articles/9002504-can-claude-produce-images

The Gemini Developer API page could not be fetched in the earlier investigation; Vertex evidence is not a substitute for verifying that separate adapter. CLI/native billing and availability remain subject to the explicit gate.
