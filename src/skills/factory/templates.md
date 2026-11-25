# Factory templates

File formats for the run folder and task bodies for sub-agents. Replace `<…>`.

---

## `factory/progress.json`

The lead owns the structure. A feature's `passes` turns true only after the lead re-ran its checks and the gates.

```json
{
  "version": 1,
  "branch": "<current thread worktree branch>",
  "source": "<plan path, issue id, or 'goal'>",
  "features": [
    {
      "id": "F1",
      "title": "<short imperative title>",
      "acceptance": ["<observable behaviour>", "<observable behaviour>"],
      "checks": ["<command that runs this feature's checks>"],
      "checkPaths": ["factory/checks/F1/", "<or test files in the project's test tree>"],
      "dependsOn": [],
      "passes": false,
      "preSatisfied": false,
      "attempts": 0,
      "status": "todo",
      "notes": ""
    }
  ],
  "reviews": [
    { "afterFeature": "F5", "commit": "<sha>", "blocking": 0, "followUps": 3 }
  ]
}
```

`status` is one of `todo`, `building`, `passed`, `split`, `deferred`, `dropped`. Keep active features in `features`. Move split and dropped entries to the decision log with their replacement IDs or reason. Only verified features receive `passes: true`.

---

## `factory/factory.json`

Shared with the Maintenance factory; keep it repo-generic, not run-specific.

```json
{
  "version": 1,
  "gates": [
    { "name": "typecheck", "command": "<e.g. npx tsc --noEmit>", "cwd": "." },
    { "name": "unit", "command": "<fast unit test command>", "cwd": "." },
    { "name": "migrations", "command": "<command that exits non-zero when there is more than one migration head>", "cwd": "backend" }
  ],
  "full": [{ "name": "all tests", "command": "<full suite>", "cwd": "." }],
  "hotFiles": ["<migrations dir>", "<lockfile>", "<generated snapshot>"],
  "baselineFailures": []
}
```

`hotFiles` are files every feature tends to collide on. The lead fixes them directly after each feature (merge migration heads, regenerate snapshots) instead of sending them back to a builder.

---

## `factory/decisions.md`

Append only. Newest last.

```markdown
# Decisions

## D1 — <short title>
- **When:** spec | contract | F3 attempt 2 | review after F5 | finish
- **Problem:** <the ambiguity, contradiction or failure, with evidence>
- **Decision:** <what the factory will do>
- **Why:** <reasoning in one or two sentences>
- **Effect:** <features or checks changed, scope added or removed>

## Follow-ups
- <non-blocking review finding or deferred work, with file/line>
```

---

## Builder (writer sub-agent task)

```text
Role: Builder for one feature of an unattended factory run. You are the only agent writing code right now. Nobody will answer questions: decide and report.

Repository: <workspace path>   Branch: <branch> (already checked out; do not switch branches or create worktrees)
Spec: factory/spec.md (read the sections relevant to this feature)
Feature: <id> — <title>

Acceptance:
- <criterion>

Checks for this feature (frozen; you may not edit these paths: <checkPaths>):
- <command>

Gates (must pass when you finish):
- <name>: <command> (cwd <cwd>)

Context:
- <locked decisions, conventions, files likely involved, notes from earlier attempts>

Rules:
- Implement only this feature. Follow the repo's conventions (AGENTS.md / context docs).
- Run the feature's checks and every gate yourself, and iterate until they pass.
- Do not modify, skip, delete or weaken any check or test you were not asked to change. If a check looks wrong, say so in your report instead.
- Do not commit. The lead verifies and commits.
- If something outside your control blocks you (missing service, credential, tool), stub it behind the real interface and report it.

Return:
## Result: PASS | FAIL
## What changed (files and why)
## Commands run (each with exit code and the key output lines)
## Concerns (wrong checks, risky shortcuts, stubs, follow-ups)
```

## Builder retry

```text
<Builder task, unchanged>

Previous attempt for this feature failed the lead's verification. The current tree contains that attempt's changes.

Failing output:
<exact command and its output, trimmed to the relevant lines>

Fix the cause shown above. Do not start over unless the previous approach cannot work; if you change approach, say why in your report.
```

---

## Reviewer (read-only sub-agent task)

```text
Role: Reviewer at a factory checkpoint. Read only: do not edit files or run commands that change the tree.

Repository: <workspace path>   Diff: git diff <previous checkpoint sha>..HEAD
Spec: factory/spec.md   Progress: factory/progress.json

Find defects in this diff that matter to users of the software. For each finding give:
- Severity: BLOCKING or FOLLOW-UP
- Evidence: for BLOCKING, either a command you ran that fails (with output) or the exact factory/spec.md line the code violates, plus the code location
- Fix: one sentence

Rules:
- BLOCKING requires that evidence. Style, naming, refactors, extra hardening, speculative edge cases and anything outside factory/spec.md are FOLLOW-UP.
- Report at most 5 BLOCKING findings, most severe first.

Return:
## Blocking
## Follow-ups
## Checked (what you read and ran)
```

---

## `factory/REPORT.md`

```markdown
# Factory report — <name>

**Branch:** <current thread worktree branch> · **Source:** <plan/goal> · **Features:** <passed>/<total> passed, <dropped> dropped

## What was built
<short description, by area>

## How to run it
<prerequisites, required local configuration, and exact install, start and test commands; for a plugin include how to load it in the host>

## Verification
<gates and full suite results on the final commit, browser walkthrough>

## Decisions and deviations
<one line per decision in decisions.md, linked by id>

## Dropped or deferred
<feature, reason>

## Next steps
<manual setup, merge or release steps, review follow-ups, and recorded stubs. Say when no user action is required.>
```
