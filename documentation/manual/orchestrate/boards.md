# Run a plan with Orchestrate

Use a board when a change can be split into tasks with their own checks and checkout boundaries. Open a Git workspace before starting.

## Prepare and start the board

1. Make a plan under `documentation/plans/`. Describe what each task must **Build**, how to **Test** it, what to **Accept**, which files it **Touches**, and what it **Depends on**. Assign a dependency if one task needs files or behavior from another. For a greenfield plan, make scaffolding a prerequisite of the work that uses it.
2. Put existing reference files under **Inputs** using backticked workspace-relative paths. Include any fixture, spec, or screenshot that a separate checkout needs to reproduce a check.
3. Open **Boards** from the workspace sidebar or use **Open boards** in the command palette. Pick the plan. If parsing fails, use **Repair** and review the validation error and suggested changes.
4. Check the starting branch, model, and **Concurrency**, then select **Start**. Set concurrency to 1 to run tasks sequentially.

Here is a one-task starting point. Replace its paths and checks with ones that exist in your project. Keep each task ID in both `todos` and the task heading.

```markdown
---
name: forecast-labels
overview: Show readable labels on the forecast card.
todos:
  - id: W1-A
    content: Add labels and a fallback
    status: pending
isProject: true
---

# Forecast labels

## Wave Breakdown

### Wave 1 — Labels

#### Task W1-A: Add labels and a fallback
- **Build:** Map forecast codes to labels and add a fallback for unknown codes.
- **Test:** Run `node --test test/forecast.test.mjs`.
- **Accept:** Code 0 shows Clear sky. Unknown codes show Conditions unavailable.
- **Touches:** src/forecast.js, test/forecast.test.mjs
- **Depends on:**
```

## Watch work and resolve a hold

Open a task's **Activity** to see builder and tester attempts. Use **Spec** to compare the work with its instructions and **Files** to inspect planned or merged changes. Open **Needs attention** for a missing prerequisite, exhausted retries, or an integration error. Resolve the named condition and choose **Check again** when offered. The board can retry some prerequisites automatically.

Choose **Pause** to hold live work at the next model or tool boundary, then **Resume** to continue those attempts. Choose **Stop** to end attempts and hold automatic recovery until you start again. Recovery keeps failed checkouts available for inspection and can wait for provider capacity without spending a repair attempt.

## Decide whether the result is ready

Read the task checks and the final integration report. A required check passes when the tester demonstrates it against the tested commit. A missing environment or capability leaves the result blocked. **Completed with waivers** identifies requirements skipped with explicit approval. Review the integration branch and final checks before pushing or opening a PR.

See [Board work agents](agents.md) for how to read attempt results and choose a recovery action.
