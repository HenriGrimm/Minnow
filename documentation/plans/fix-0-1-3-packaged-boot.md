# Fix v0.1.3 packaged boot (`fetch failed`)

**Status:** done  
**Area:** Electron packaged bootstrap, Impeccable asar vs extraResources

## Cause

Opening `Minnow-0.1.3-arm64.dmg` shows **Minnow failed to start / fetch failed**. `~/.minnow/logs/crash.jsonl` records `source: main`, `kind: bootstrap-failed`, `TypeError: fetch failed`.

That message is the **fallback**, not the first failure.

1. v0.1.3 moved the Impeccable skill payload to `extraResources` (`Resources/skills/impeccable/`) and excluded most of `src/skills/impeccable` from `app.asar` (SKILL.md, reference, scripts).
2. `harness-commands.json` is in that extraResources payload. It is **not** next to `harness-registry.mjs` inside the asar.
3. Packaged `startInProcessServer` imports `server/impeccable/command-aliases.js` → `src/skills/impeccable/harness-registry.mjs` → `import './harness-commands.json'`. Node throws `ERR_MODULE_NOT_FOUND`.
4. `whenServerTransportKnown()` swallows that error so workspace claim can HTTP-fallback.
5. Packaged claim then `fetch`es the leftover **dev** origin (`http://localhost:9473/api/workspace/open`). Nothing is listening → undici `TypeError: fetch failed`.
6. Since f8c1588b, claim failure **throws**, `createShellWindow` destroys the window, and `failBootstrap` exits. v0.1.1 only `console.warn`ed.

Confirmed by running the installed 0.1.3 binary as Node: `bootstrapMinnowRuntime()` succeeds; `startInProcessServer()` fails on the missing JSON.

## Todos

- [x] Reproduce from crash.jsonl + packaged asar listing + `ELECTRON_RUN_AS_NODE` import
- [x] Keep the harness command list on an asar-resident `.mjs` (JSON stays extraResources-only for skill install)
- [x] Validator: asar-included `src/` modules must not relative-import files excluded from `build.files`
- [x] Electron: await in-process server during bootstrap; packaged claim must not POST the leftover Vite port; crash dialog includes `error.cause`
- [x] Tests for validator, error text, claim transport, and registry import
- [x] Update `documentation/context.md`

## Non-goals

- Rebuilding / notarizing the 0.1.3 DMG in this change (needs an explicit package run after merge)
- Changing Impeccable extraResources layout for SKILL.md / reference / scripts
