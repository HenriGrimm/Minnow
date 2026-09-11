## Your stage: Interface polish

The plan at `{{planPath}}` has passed review. Its interface work now gets a designer's pass, so builders produce screens that feel finished rather than merely functional.

Read the spec, the plan, and the existing UI code it touches (components, styles, tokens, similar screens). Then revise **only the interface-facing parts of the plan**:

- Every screen and component task states its loading, empty, error and success states, and what the user sees in each.
- Keyboard and screen-reader behaviour, focus order and contrast are specified where they matter.
- Layout at narrow and wide sizes is described; existing design tokens and components are reused by name instead of new one-off styles.
- Copy is specific: button labels, empty-state text, error messages.
- UI tasks have a **Test** a builder can run (a component test, or a browser check with what to look for).

Keep the task ids, dependencies, front matter and format intact — the board parses this file. Do not add implementation code. Save the revised plan to the same path with `save_file`.

Call `report_outcome` with a `summary` and a `changes` list of what you improved.
