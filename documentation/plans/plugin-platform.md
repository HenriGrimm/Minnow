# Plugin platform implementation

The extension unit is a versioned, locally installed package. It participates in Minnow's shared tool runtime rather than introducing a separate agent or session engine.

## Decisions

- API v1 manifest contributes multiple tools, self-contained panels, connection fields and namespaced skills.
- Native handlers are explicitly trusted local code in disposable workers, with deadlines and limits. The product does not claim OS-level sandboxing.
- Source stays in the workspace; immutable installed releases live in Minnow home. Explicit installation/reload validates and stages before switching the registry atomically.
- UI runs in opaque-origin frames with a narrowly scoped tool bridge. Per-tool permissions stay authoritative.
- Connection values use the existing encrypted secret store. Package metadata never contains credentials.
- The Settings Apps page becomes Plugins. Core application release gates stay unchanged.
- Agents author through plugin_inspect/plugin_manage and /build-plugin. Plan mode permits inspection and blocks management writes.
- Existing single-tool plugins remain compatible.

## Verification contract

Exercise the source → inspect → install → discover → execute → edit → reload flow. Check malformed packages, duplicate installs, path boundaries, encrypted connections, failed-update rollback, timeouts, cancellation, disable/remove revocation, skills, isolated panel messaging, normal tool permissions, browser settings flows, type checks and production build budgets.

The shipped user contract is documented in [Plugins](../manual/plugins.md).

## Validation performed (Windows, 2026-09-20)

- `npm run test:plugins`: 21 tests passed, covering package and legacy compatibility, HTTP lifecycle, live replacement, worker deadlines/cancellation, permissions, encrypted connections, and panel isolation.
- Targeted settings HTML/UI, skill probes, configuration API/migration and shared runner dispatch: 125 tests passed.
- `npm run test:skills`: 114 tests passed.
- `npm run test:settings`: 22 tests passed.
- `npm run test:product-wiki`: 13 tests passed.
- TypeScript, production build, bundle budgets and test coverage discovery passed.
- Impeccable checks on the new panel/settings modules and stylesheet passed.
- Browser check in an isolated Minnow home: reviewed and installed source, granted a tool permission, opened a themed panel, invoked its tool, and disabled the package; its panel was removed. Unauthenticated package API requests returned 401.
- A packaged runtime smoke check invoked a worker and validated arguments from inside an Electron ASAR archive.

The full `npm test` run was not green. Feature-related fixture/catalog assertions were corrected and passed on targeted reruns. Remaining failures included provider fixtures, Windows symlink privileges, CLI detection, sub-agent graph purity, boot-resume behavior, and unrelated UI tests/timeouts. The graph-purity and boot-resume failures were reproduced in a separate unchanged checkout at `2c5b572e`. A hung tool-indicator test process was terminated to let the full runner finish. These results do not establish a green cross-platform release gate or a signed-installer validation.

API v1 deliberately supports local trusted packages. Native handlers have user privileges; worker limits are reliability controls. Connections expose encrypted fields, not automatic OAuth provisioning. Panels are self-contained settings panels; they do not modify arbitrary host components. These boundaries are part of the published contract.
