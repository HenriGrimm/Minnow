# MIN-31 — Priority signal icons

## Plan

1. Use the existing Uicons cellular signal family: four bars for urgent, three for high, two for medium, one for low; a neutral dash for no priority.
2. Route list rows through the shared priority chip renderer used by issue detail. Add the same priority chip to board cards.
3. Show the shared glyphs in new-issue properties and priority menus, including inline and filter menus.
4. Preserve the text labels, taxonomy colors, native keyboard editing, and stored custom icons. Priorities without a known or stored glyph use a neutral dash.
5. Run existing taxonomy/icon, new-issue, list, detail, and interaction tests. This visual mapping needs no new source-mirroring tests.

## Scope

The change uses glyphs already included in Minnow's installed Uicons fonts. It adds no assets, theme tokens, or persistence fields.
