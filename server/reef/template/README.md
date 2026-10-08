# Reef utility

Install Node 24, run `npm ci --ignore-scripts`, then `npm run build`.

The frontend lives in `src/`; optional local backend operations live in `backend.mjs`.
Use relative `api/` URLs in the frontend. Files are supplied by the user through
browser file inputs. Backend persistence belongs in the provided `dataDir`.

Tests belong in `test/*.test.mjs`. `reef.scenarios.json` contains browser scenarios:
an array of objects with a name and steps. Steps support `fill` (selector, value),
`click` (selector), `select` (selector, value), `file` (selector, value relative to
`test/fixtures`), and `text` (selector, contains).
Every scenario must exercise an interaction and assert a visible result.

Reef supplies its runtime and export wrapper. Do not change files in `reef-host/`.
Runtime dependencies must be pure JavaScript or WASM. Native modules, executables,
external services, and credentials are not supported by this template.
