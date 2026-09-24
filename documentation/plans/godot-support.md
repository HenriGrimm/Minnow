---
name: First-class Godot support
overview: Make a Godot project a complete Minnow Code workspace for GDScript, scenes, play/debug, tests, exports, and agent-assisted changes while Godot remains the scene editor and runtime.
isProject: true
---

# First-class Godot support

**Research and repo review:** 2026-09-23. **Status:** proposal; no implementation has started. **Decision:** defer the Godot editor companion/addon. The working definition of “full support” for the current plan is a usable daily loop for Godot 4 projects: open a project, edit and navigate GDScript/resources, run a scene, debug, inspect saved project structure, validate agent changes, run tests, and export. Godot itself remains the visual 2D/3D editor and source of truth for importing and serializing resources. Godot 4.6 is the primary validation target; decide the older-version support matrix during the first milestone.

## Evidence and opportunity

| Signal | Evidence | Product implication |
| --- | --- | --- |
| Godot already offers editor protocols and CLI entry points | Official [external-editor guide](https://docs.godotengine.org/en/4.6/tutorials/editor/external_editor.html) documents LSP and DAP; [CLI reference](https://docs.godotengine.org/en/4.6/tutorials/editor/command_line_tutorial.html) documents `--path`, `--scene`, `--lsp-port`, `--dap-port`, `--import`, `--check-only`, headless runs, and exports. | Integrate with an installed Godot binary and its protocols. Probe the installed version and flags instead of assuming a port or a binary name. |
| External-editor baseline is already broad | Official [Godot Tools for VS Code](https://github.com/godotengine/godot-vscode-plugin) supports GDScript completion/diagnostics, resource links, scene preview, and a debugger with run targets, breakpoints, stack, variables, and live scene tree. | “Full support” needs more than `.gd` highlighting and a Run button. Use this feature set as a parity checklist, without importing VS Code extension code wholesale. |
| Developers want a short edit → play → inspect loop | [Run-from-editor discussion](https://github.com/godotengine/godot-vscode-plugin/discussions/618), [external editor guide](https://docs.godotengine.org/en/4.6/tutorials/editor/external_editor.html), and the plugin’s [reload FAQ](https://github.com/godotengine/godot-vscode-plugin) describe launching scenes and synchronizing external file edits. | Put play current/main scene, stop, logs, and reload status in the Code workspace. Make Godot’s external-change settings discoverable. |
| Connections and previews can be fragile | A [confirmed completion-reconnection report](https://github.com/godotengine/godot-vscode-plugin/issues/978) and a [scene-preview failure report](https://github.com/godotengine/godot-vscode-plugin/issues/646) illustrate failure modes; they are examples, not prevalence estimates. | Show connection state, reconnect cleanly, and make a scene outline fail with an explicit error rather than an empty pane. |
| Scene-aware AI is desired but error-prone | A [developer request for reliable Godot agents](https://www.reddit.com/r/aigamedev/comments/1p2uwp9/how_to_make_ai_agents_work_reliably_with_godot/) describes trouble with scenes, signals, and editor actions. This is anecdotal user research. | Give agents structured, read-only saved-scene context; validate changes with Godot before claiming success. Defer live editor mutations. |
| Godot projects have special file rules | Official [TSCN format](https://docs.godotengine.org/en/4.6/engine_details/file_formats/tscn.html), [UID reference](https://docs.godotengine.org/en/4.6/classes/class_resourceuid.html), and [VCS guide](https://docs.godotengine.org/en/4.6/tutorials/best_practices/version_control_systems.html). | Keep `.godot/` cache out of indexes and Git suggestions; keep source `.uid` files; treat `res://` references, resource IDs, and scene ownership as first-class. |
| C# requires its own lane | Godot’s [C# setup guide](https://docs.godotengine.org/en/4.6/tutorials/scripting/c_sharp/c_sharp_basics.html) requires the .NET edition and builds; the older official [C# VS Code extension](https://github.com/godotengine/godot-csharp-vscode) explicitly excludes Godot 4. | Detect .NET projects and provide build/run support, then select a maintained C# LSP/debugger integration after a compatibility and license spike. GDScript DAP does not imply C# debugging. |
| Test and export tools exist | Godot’s [CLI](https://docs.godotengine.org/en/4.6/tutorials/editor/command_line_tutorial.html) and [export guide](https://docs.godotengine.org/en/4.6/tutorials/export/exporting_projects.html); [GdUnit4](https://github.com/godot-gdunit-labs/gdUnit4) and [GUT](https://github.com/bitwes/Gut) supply optional project test runners. | Surface the engine’s checks and export presets; discover an existing test framework rather than installing one or treating `--check-only` as a project-wide test. |

The evidence is a mix of official capabilities, an established extension, and individual user reports. It identifies workflows and failure modes, not market size or priority by vote count. The first release should prioritize the edit/play/debug loop because it is both the clearest user request and the shortest path through existing Minnow infrastructure.

## Current Minnow fit

- The Code file viewer uses CodeMirror and lazy language loading in [`src/ui/editor-language.ts`](../../src/ui/editor-language.ts). There is no Godot language mapping in [`src/lsp/language-id.ts`](../../src/lsp/language-id.ts) or the corresponding `guessLanguageId` in [`server/lsp/manager.js`](../../server/lsp/manager.js).
- The LSP manager currently spawns **stdio child processes** and ties lifecycle to a child process. Godot’s GDScript LSP is a **local TCP service** owned by a Godot editor process. Extend the transport/lifecycle model; adding a row to [`src/lsp/defaults.json`](../../src/lsp/defaults.json) alone cannot work.
- The file viewer already supports text and images, but no Godot scene/resource outline or `res://` navigation. The image preview is not a game viewport. Existing browser preview targets web content; it should not be presented as a native Godot preview.
- Brain Code’s default include globs contain `.cs` but omit `.gd`; its exclusions omit `.godot/` in [`server/brain/code/config.js`](../../server/brain/code/config.js). File-tree filtered search also traverses `.godot/` today via [`src/ui/file-tree-filter.ts`](../../src/ui/file-tree-filter.ts).
- Terminal, [`server/dev-server/manager.js`](../../server/dev-server/manager.js), and server tool execution can host process/log plumbing, but a Godot game has different lifecycle and no HTTP port. Use a dedicated Godot run adapter with shared process primitives rather than calling it a dev server.
- Workspace paths are request scoped and several roots can be open simultaneously. Every Godot process, LSP/DAP socket, tool call, and UI state must be keyed by resolved project root, not the global default workspace. Worktrees should remain independent and must not fight over fixed ports.
- No Godot executable was found on this review machine, so this is a source and documentation plan. Protocol flags, operating-system launches, and scene serialization still need hands-on validation with real installations.

## Architecture and boundaries

Create a small `server/godot/` integration service with a workspace-scoped project descriptor: `project.godot` root, detected Godot version/edition, executable path, optional .NET SDK, editor/process state, selected connection mode, and feature availability. The service exposes narrow authenticated `/api/godot/*` actions to the Code UI and dedicated `godot_*` agent tools only when a valid Godot project is open. Keep this an adapter on the shared Code/chat/tool spine; do not create a separate app or session store.

1. **Project resolution:** recognize `project.godot` at the workspace root or a chosen nested project, with explicit selection if more than one is found. Store an override per workspace. Never infer that any folder containing `.gd` is a project.
2. **Executable resolution:** explicit per-workspace path → configured app path → platform discovery/PATH; probe `--version` and editor/.NET capability. Never download or bundle Godot silently. Use argv spawning, not shell-assembled command strings. Report missing binary/SDK with a direct fix.
3. **Editor ownership:** connect to a running project editor when configured, or launch a managed editor/headless LSP instance. Record which process Minnow owns and stop only that process. Use loopback sockets, configurable or allocated ports, bounded retries, and socket/protocol handshakes. A stray Godot instance on a common port is not proof it owns this project.
4. **File/resource ownership:** Godot imports and writes its cache; Minnow edits source files and presents source diffs. Respect Godot’s external-change reload behavior. For generated/UID-bearing scene changes, prefer Godot-backed operations or validated text changes with atomic write, fresh-file precondition, and `--import`/scene load check. Never rewrite binary `.scn`/`.res` as text.
5. **Version compatibility:** prefer documented Godot 4 APIs, with capability probes and clear degradation. GDScript, C#, and GDExtension are separate language lanes. The initial target is GDScript; C# and C++ have their own acceptance criteria.

### Capability boundary without an addon

| Available through files, CLI, LSP, or DAP | Requires a live editor bridge; deferred |
| --- | --- |
| Project/engine detection; GDScript syntax, completion, diagnostics, and navigation; open Godot editor; play/stop a saved main or selected scene; GDScript breakpoints/stack/variables through DAP; logs; saved `.tscn`/`.tres` outlines and `res://` links; headless import/script checks; project test runners; exports; C# build/run. | Reading Godot's unsaved scene state or current node selection; clicking a node in Godot to seed a Minnow task; editing the live scene through Godot's undo history; automatic bidirectional scene focus or inspector updates. |

“Current scene” without an addon means the saved scene file selected in Minnow, not whichever scene tab is active in Godot. A DAP-provided live scene tree may be possible and remains a protocol spike; it does not supply general editor selection. Do not represent a parsed saved scene as live editor state. Agents may propose ordinary `.tscn` text diffs with review and Godot validation, but structured live node/property mutations are outside the current delivery scope.

## Delivery sequence

### 0. Compatibility spike and contract

Produce two tiny fixtures (GDScript 2D/3D scene project and .NET project) and a validation matrix on Windows, macOS, and Linux. Confirm Godot 4.6 and one earlier 4.x release: executable discovery, owned/editor-attached LSP, DAP, script reload, CLI error/exit behavior, current-scene launch, and `.uid`/resource round-trips. Decide the supported versions, explicit install prerequisites, and whether headless LSP is stable enough for default use. Do not build UI around unverified protocol assumptions.

**Exit:** documented capability matrix and a repeatable smoke script with no workspace mutation beyond disposable fixtures.

### 1. Godot project and GDScript editing (first usable slice)

- Add project detection and an unobtrusive Code project status/quick actions entry: version, engine path, connection state, **Open in Godot**, **Play main scene**, **Play current scene**, **Stop**. Keep the control absent for other projects.
- Add `.gd` syntax, comments/indentation, GDScript snippets, `.gdshader` and readable `.tscn`/`.tres`/`project.godot` highlighting. Select and test a CodeMirror-compatible grammar; check upstream license and bundle impact. Add icons/file types only where the existing tree uses them.
- Add `.gd` LSP `languageId` on client and server. Refactor LSP connection creation to support stdio or a `127.0.0.1` TCP stream, with project-scoped lifecycle, startup/reconnect/cancel handling, socket identity checks, diagnostics, completion, hover, navigation, symbols, and format only if Godot advertises it. Do not assume one documented/default port works across installations.
- Add `.gd` to Brain Code indexing, exclude `.godot/` from project/code indexes and filtered tree search, and ensure resource/cache files do not flood agent context. Update fresh Godot project Git guidance to ignore `.godot/` without replacing existing user ignore rules. Keep `.gd.uid` and authored source assets visible/trackable.
- Provide a `res://` link resolver for project-local source files and source references in diagnostics, with URI/path traversal checks.

**Exit:** opening a real Godot project gives syntax, LSP navigation/completion/diagnostics, stable reconnection after restarting Godot, and clickable `res://` links; another open workspace’s server is unaffected.

### 2. Play and debug loop

- Add a Godot run controller with main/current/selected-scene targets, save-before-run policy, stop/restart, stdout/stderr, clickable errors, timestamps, and a state badge. Use `--path`/`--scene` as verified in the spike. Separate the Godot editor process from a game process; never kill a user-owned editor on Stop or workspace switch.
- Add a DAP client/panel for GDScript: launch/attach, breakpoints persisted per project, pause/continue/step, call stack, locals/watch, exception events, and source navigation. Integrate into Code’s right pane/terminal layout without moving the file viewer DOM to a new app. Show a precise unavailable state when the adapter is off.
- Add a read-only live scene tree/inspector only if the DAP surface proves stable in the spike. It should have refresh and clear empty/error states; do not equate a serialized `.tscn` outline with live runtime state.
- Document the Godot **Auto Reload Scripts on External Change**, **Save on Focus Loss**, and related settings needed for a smooth two-editor workflow.

**Exit:** change a script in Minnow, run a selected scene, hit a breakpoint, inspect a variable, stop, and repeat without manual port editing or stale processes on each supported OS.

### 3. Scene/resource intelligence and agent verification

- Build a read-only, version-aware `.tscn`/`.tres` parser/outline: node hierarchy, attached scripts, external/subresources, signals, `res://` and UID references. Report incomplete/unknown syntax instead of fabricating a graph. Link outline nodes back to file lines and Godot.
- Expose bounded `godot_project_info`, `godot_scene_outline`, `godot_validate`, `godot_run_scene`, and `godot_test` tools through the normal tool catalog, permissions, and workspace path boundary. Give tools structured outputs with project, scene, source file/line, command, exit status, and truncated logs. Reuse chat change review for diffs; no duplicate agent loop.
- Validation ladder: static file/reference checks → targeted script `--check-only` where applicable → `--headless --path … --import` in a disposable/controlled context → scene/runtime smoke check when requested. Distinguish warnings, import failures, parse errors, and runtime failures. Do not claim a scene is valid from `--check-only` alone.
- Keep scene changes as reviewable source-file diffs. Use fresh-file conflict checks and Godot round-trip validation for `.tscn`/`.tres` edits; report UID/ownership uncertainty explicitly. Do not expose structured live node/property mutation tools in this scope.

**Exit:** an agent can locate the owning saved scene, make a reviewable script/source change, run the right Godot validation, and report the actual engine error with a source link.

### 4. C#, testing, exports, and advanced project types

- **C#:** detect `.csproj` plus Godot .NET edition and SDK; support `dotnet build` with diagnostics, Godot run, `.cs` language tooling via a maintained compatible server, and .NET debug launch/attach after a license/protocol spike. Reuse existing C# file/editor support where it works. Do not route C# through GDScript LSP/DAP.
- **Tests:** detect existing GUT or GdUnit4 in `addons/`, present the project’s runner and result summary, and keep raw logs/JUnit paths available. Do not auto-install frameworks. Allow a project-specific test command override for custom suites.
- **Export:** read preset names from `export_presets.cfg`, check installed export templates, run `--export-debug`/`--export-release` with explicit target/output and progress/logs. Respect confidential `.godot/export_credentials.cfg`; never put credentials in chat output or commits.
- **GDExtension/C++:** keep existing clangd/toolchain behavior and add project identification, build-command guidance, and Godot launch against the produced extension. Do not conflate this with first-release GDScript parity.

**Exit:** .NET project can build and run with useful errors, installed test suites can run, and an export preset produces a known artifact on a supported host. Debugger parity for C# is separately gated by the selected backend.

## Verification and release gates

- Unit/integration coverage for project resolution, executable selection, argv safety, TCP LSP framing/reconnection, root isolation, `.godot/` exclusions, `res://` normalization, scene parsing, run/stop ownership, and structured tool output. Use disposable Godot fixtures; avoid tests that merely restate implementation details.
- Real-engine smoke on Windows/macOS/Linux for the chosen support matrix: two simultaneous projects/worktrees, missing executable, a crashed/restarted Godot editor, occupied ports, unsaved edits, Unicode/space paths, asset import, and a malformed scene. Run `npx tsc --noEmit`, relevant suites, full `npm test`, and performance budgets when UI/language bundles change.
- Security review: bind sockets to loopback, confirm project identity before attach, enforce workspace root and symlink boundaries, never execute untrusted project scripts merely to display an outline, do not import/export automatically on folder open, and keep build/export logs free of secrets.
- Documentation: update `documentation/context.md` for service/API/storage design and the shipped manual only as each milestone lands. Keep unfinished capabilities in this plan, not in release docs.

## Open decisions for milestone 0

1. Target versions: Godot 4.6 plus which earlier 4.x releases receive tested support? Godot 3 has different cache/VCS conventions and should be a separate compatibility effort.
2. Default LSP ownership: attach to the user’s open editor or launch a managed headless Godot instance? Test reliability and resource cost before choosing; support both only if project identity and lifecycle are clear.
3. Game viewing: native game window first. Investigate an embedded capture/stream only after basic launch/debug is reliable; a browser `WebContentsView` cannot render a Godot desktop process.
4. Scene writes: current scope is saved-file diffs plus validation. Revisit a project-local Godot editor plugin and structured live writes only after the core loop ships and the user reopens that decision.
5. C# debugger backend: select a Godot 4 compatible .NET debugger with distributable licensing; otherwise ship build/run and state the debugging limitation plainly.

## Deferred: optional Godot editor companion

**Deferred by user:** no addon, pairing flow, in-editor dock, or editor IPC in the current delivery sequence. This section preserves the research for a future decision. If revisited, offer a small, opt-in Godot editor addon connected to the installed Minnow desktop app rather than packaging Minnow's Vite/Electron workspace, model host, or separate chat/session store inside Godot.

The addon has a concrete advantage over filesystem-only integration: Godot's [EditorInterface](https://docs.godotengine.org/en/4.6/classes/class_editorinterface.html) exposes the actively edited scene and play-current/main/custom actions; [EditorSelection](https://docs.godotengine.org/en/4.6/classes/class_editorselection.html) exposes selected nodes; [EditorPlugin](https://docs.godotengine.org/en/4.6/classes/class_editorplugin.html) emits scene-change/save events and can add a dock or menu action. A `.tscn` parser cannot see unsaved editor state or know which node the user means by “this one.” Conversely, the Godot addon should not duplicate Minnow's code editor, Git, issues, boards, provider management, or agent transcript.

Existing [Godot MCP Toolkit](https://github.com/NPGameDev/godot-mcp-toolkit), [Fennara](https://github.com/fennaraOfficial/fennara-godot-ai), and [Godot Asset Library AI assistants](https://godotengine.org/asset-library/asset?filter=Assistant) show that in-editor AI/agent tooling is available. They do not establish demand size or prove a new generic chat dock would win. Minnow's differentiated offering would be one task that can move between Godot's scene context and Minnow's code, diff, terminal, and validation workflow.

**Thin companion pilot:**

1. Install manually under `addons/minnow/`, enable in Godot's Plugins settings, and pair with a running local Minnow instance. Pairing uses a short-lived code initiated in Minnow, a loopback-only connection, a project-root identity check, and a revocable per-user credential stored outside the project/repository. No model API keys or Minnow host token in `plugin.cfg`, source files, or Godot project settings.
2. Add **Send selection/scene to Minnow** and **Open task in Minnow** actions, plus an optional compact dock showing connection state and the current task. Send a bounded snapshot of scene path, selected node paths/types, attached script/resource paths, and relevant editor errors only on explicit user action. Label unsaved scene state and distinguish it from the saved file. Do not stream the entire scene or silently run `@tool` scripts to answer a read request.
3. In Minnow, show the attached Godot context as a normal, reviewable composer attachment and route the task to the already open workspace. Return file/line and scene/node navigation to Godot where supported. Preserve the same conversation regardless of which app initiated it.
4. Measure the pilot: successful pairing, time from selected node to useful answer/change, handoff success, user confusion around unsaved state, and addon maintenance across supported Godot versions. Keep the addon optional if those benefits are marginal.

**Later, gated capability:** editor-backed add node/attach script/connect signal/property operations. Use Godot's [EditorUndoRedoManager](https://docs.godotengine.org/en/4.6/classes/class_editorundoredomanager.html), preview the exact action and target scene, enforce project scoping and explicit command allowlists, save/round-trip with Godot, and surface the resulting diff in Minnow. No arbitrary method invocation or unreviewed filesystem edits through the addon. Run and debug controls can use Godot's live editor APIs once ownership and sync behavior are verified.

**Go/no-go:** ship the companion publicly only if it makes scene-specific requests materially easier than opening Minnow beside Godot and remains reliable after scene switches, unsaved edits, editor restart, two open projects, and addon disable/re-enable. A focused handoff addon could be valuable even if scene mutation never ships.

**Recommended first PR:** milestone 0 fixture/probe plus project/executable detection tests. **Recommended first product slice:** milestone 1 with a clearly connected Godot editor and GDScript LSP. Run/debug and scene-aware agents follow once the protocol and process ownership contract is proven.
