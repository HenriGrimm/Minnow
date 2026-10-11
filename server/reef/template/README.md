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

`icon.svg` is the app icon on the desktop, taskbar and window. Draw one that fits
this app: `viewBox="0 0 1024 1024"`, a background shape that fills the canvas
(a rounded square with `rx` about 220 works well), and one bold, simple symbol
that reads at 16 px. No text, no scripts, and no external images, fonts or
links; reference only the file's own `#ids`. Keep it under 100 KB.

Reef supplies its runtime and export wrapper. Do not change files in `reef-host/`.
Runtime dependencies must be pure JavaScript or WASM. Native modules, executables,
external services, and credentials are not supported by this template.
