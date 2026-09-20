# Minnow board plan parser contract

Source of truth: `server/orchestrator/core/parse-plan.js`. This reference records the parser's actual behavior; rerun the validator after changing a plan.

| Source | Contract |
|---|---|
| `parse-plan.js:12–48` | `parsePlan(markdown)` returns a task graph or an array of parse errors. `isParseErrors` distinguishes them; `formatParseErrors` prints `line:column`, message, and hint. |
| `parse-plan.js:96–218` | The first line opens `---` front matter, which must close. Recognized top-level keys are `name`, `overview`, `todos`, and `isProject`. Each todo starts with `- id:` and may carry indented `content:` and `status:`. `name` and at least one todo are required. |
| `parse-plan.js:227–379` | The parser reads task headings only inside `## Wave Breakdown`. Wave headings match `### Wave N — Name` (hyphen and en dash also work). Task headings match `#### Task <id>: <Title>` and must follow a wave heading. Other level-two sections end task parsing until another Wave Breakdown heading. |
| `parse-plan.js:331–354` | Nonblank lines following a field continue that field until another recognized field, heading, or blank line. Nested Build lists therefore become part of Build. |
| `parse-plan.js:385–454` | Task ids and titles must be non-empty; task ids must be unique. Build, Test, Accept, and Touches must each have content. Touches is split into globs and validated. |
| `parse-plan.js:457–483` | Every front-matter todo must match a task heading and every task must have a todo. The error points to the unmatched todo or task line. |
| `parse-plan.js:487–566` | Dependencies resolve to declared task ids. Unknown ids and self-references fail. Cycles fail with `dependency cycle: A → B → A`. |
| `parse-plan.js:569–587` | `matchTaskField` recognizes `- **Build:**`, `- Build:`, `**Build:**`, and `Build:` (also `*` bullets and case variations). The same forms apply to Test, Accept, Touches, and Depends on. Prefer `- **Label:**` consistently. |
| `parse-plan.js:600–648` | `normalizeListToken` strips surrounding bold, backticks, quotes, parentheses, or brackets and trailing sentence punctuation. `splitList` separates comma or newline entries. For dependencies, `none`, `nothing`, `n/a`, `na`, `-`, `—`, and `–` become empty lists. |
| `parse-plan.js:651–669` | `globProblem` rejects absolute paths, a `..` path segment, brace expansion, leading negation, whitespace, parentheses, and unbalanced square brackets. Use repo-relative paths. |
| `parse-plan.js:682–684` | `normaliseId` trims and lowercases ids for matching. A todo `w1-a` matches `#### Task W1-A:`, but identical spelling is easier to review. |

Additional intake checks live in `server/super-plan/artifacts.js:181–199`: at least 160 non-whitespace characters, a `# Title` as the first heading, and at least two `##` sections. That function calls `findImplementationCode` from `server/super-plan/no-code-guard.js:52–71`. The guard rejects known implementation-language fences anywhere and other unapproved fence languages outside a `**Test:**` section.

The validator imports these checks and the real parser. Its graph output is the final check that the expected tasks, dependencies, and touches survived parsing.
