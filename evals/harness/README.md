# Minnow harness evaluation

This measures the **shared `server/runner/run-turn.js` loop**, not the older
`minnow run` CLI loop. Model requests run on the coordinator; actual Minnow
file/git/command tools execute in each benchmark container. The evaluator owns
task isolation and grading. An agent saying “done” never counts as a pass.

## Setup

Requires Node 22+, `npm ci`, uv, Git, and a running Linux Docker engine. From the
repository root:

```sh
npm run eval:harness:setup
npm run eval:harness:doctor
npm run eval:harness:runtime
npm run test:harness
```

The Python environment is locked in `uv.lock`. Dataset downloads, runtime
archives and trajectories are ignored by Git. Runtime builds install the
repository's npm lockfile, not a published Minnow package. Rebuild the runtime
after changing tool/server code. Docker must support the task images; the
runtime uses Node 22 and Debian Bookworm-built native dependencies. Unsupported
libc/architecture combinations fail setup rather than count as model failures.

## Profiles and scope

| Profile | Prompt | Tools | Discovery |
|---|---|---|---|
| `build` | Shipped composer, full profile, Build/default Builder | Ten existing server file/shell/git tools | Production lazy discovery |
| `minimal` | One sentence | Existing `execute_command` | Off |

Both use the same production loop, compaction and behavioral recovery. Minimal
is a **Minnow prompt/tool ablation**, not a reproduction of DeepSeek's shell,
no-compaction policy or model adapter. The Build profile is an isolated coding
subset, not full desktop parity: Brain, UI, skills, LSP, subagents, personal
rules, repo-map injection and persistent background-command handles are absent.
The shipped prompt is preserved even where it mentions optional capabilities;
the recorded manifest and tool schemas make those limitations reviewable.
Each tool call uses a fresh worker. Foreground file/git/shell tools use their
real implementations; background handles are rejected explicitly. Worker startup
overhead is included in elapsed time. Requests use OpenAI Chat Completions;
native Anthropic/Responses transports and constrained decoding are not covered.
SSE is buffered by the host transport, so do not use these runs for TTFT or UI
streaming benchmarks.

## Model configuration

Set `MINNOW_EVAL_API_URL` to the **complete** Chat Completions endpoint and
`MINNOW_EVAL_API_KEY` to its key. Credentials remain on the coordinator and
are not copied to the task container or written in manifests.

PowerShell example (use your own endpoint and credentials):

```powershell
$env:MINNOW_EVAL_API_URL = 'http://127.0.0.1:1234/v1/chat/completions'
# For an authenticated endpoint, set MINNOW_EVAL_API_KEY in your environment.
npm run eval:harness:campaign -- --model YOUR_MODEL_ID --name pilot-001
```

Campaign generation makes **no model calls**. It prints the two commands to run.
The default pilot selects the same deterministic 20 DeepSWE v1.1 tasks and 10
Terminal-Bench 2.1 tasks for both profiles, with three attempts each (180 runs).
`--smoke --attempts 1` selects five tasks from each dataset (20 runs).
Start with the local `fix-sum` task before any paid pilot:

```sh
uv run --project evals/harness harbor run -p evals/harness/tasks/fix-sum -a evals.harness.agent:MinnowAgent -m YOUR_MODEL_ID -n 1 --ak profile=build
```

Adjust `--context-window`, `--max-tokens`, `--max-steps`, `--timeout`, and
`--reasoning-effort` to match the actual served model. Defaults are 131072 context,
16384 output, 500 steps and 1800 seconds; these are pilot budgets, not DeepSeek's
published settings. Provider-specific reasoning values pass through unchanged.
Use a distinct campaign name and held-out seed when validating improvements.
No automatic error retries are enabled. Harbor's grader, environment and dataset
revisions must remain fixed across comparisons.

## Other benchmarks and baselines

The custom agent works with Harbor task directories, so SWE-bench and Aider
Polyglot task adaptations can use the same `-a evals.harness.agent:MinnowAgent`
entry. They are not downloaded by setup. Adapted tasks are not automatically
comparable with the original leaderboards' retry/editing rules.

Add `--baseline-model PROVIDER/MODEL` to campaign generation to also write a
Terminus-2 baseline config for the identical selected tasks (270 pilot runs total).
It uses Harbor/LiteLLM credentials rather than `MINNOW_EVAL_API_KEY`; configure
the same model endpoint and verify context settings before running. Its context
management remains the reference harness's own policy. You can also run
Harbor's `mini-swe-agent` over the exact paths in `selection.json`. Their
credentials and network requirements differ; do not loosen task network policy
to make a baseline work. DeepSeek's official `dsh-minimal` reproduction uses a
separate Pier adapter and SDK artifact; this integration does **not** claim to
implement that baseline. Follow the pinned setup in
[their evaluation instructions](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/evaluation/README.md)
for a publishable DeepSeek comparison. Never compare a subset result to their
full-suite headline score.

## Results

```sh
npm run eval:harness:report -- evals/harness/jobs
```

Produces `trials.csv`, `paired.json` and `summary.json`: pass rate (all trials), grading errors,
ungraded trials and cost per success when cost is available. Missing costs stay
null. Token totals, calls, tool errors, compactions and runtime are in the CSV.
For a conservative API budget estimate, supply `--input-per-million RATE
--output-per-million RATE --project-runs 180`; cached input is priced at the full
input rate and missing usage is reported as incomplete coverage.
The adapter records full `events.jsonl`, model request bodies, composed prompt,
tool schemas, budgets, revision, runtime hash and final transcript per trial.
These files may contain task code and are private by default. It does not upload
results. Inspect paired task outcomes, not just aggregate pass rates. Repeated
attempts estimate variability; they are not pass@k selection.

`test:harness` runs offline: fake inference drives the actual production loop
through the Python/Node bridge and a real file edit in an owned temporary
workspace. It also checks failure replay, tool discovery, profile separation,
budget validation, forced compaction with a standing user constraint, deterministic
selection and reporting. Docker smoke runs are
separate; passing the offline tests does not establish container compatibility.

## Settings controls

When running Minnow from source, open **Settings → Advanced → Harness benchmarks**.
The panel checks Node, Git, uv and Linux Docker; installs the evaluator and pinned datasets;
builds the runtime; and runs Build/minimal comparisons with a saved Chat Completions provider.
Model IDs have suggestions when the provider exposes a model catalog. Adjust the context
window to match the model you loaded. The default small trial uses ten tasks, one attempt
per profile (20 trials); the pilot uses 30 tasks. Run limits are under a disclosure.

Setup makes no model calls. **Start comparison** begins billable provider requests.
Only one operation can run at a time. Keep Minnow open; navigation and page reloads are
safe. **Stop** terminates the coordinator process tree; inspect Docker Desktop for task
containers left after cancellation. A server restart labels unfinished records interrupted
and never resumes paid work automatically.

Private run records live under `artifacts/gui-runs/`; each comparison has isolated configs,
jobs, transcripts and reports under `artifacts/gui-…/`. The panel shows verifier pass counts,
errors, ungraded trials and reported cost (unknown cost stays unknown). Interrupted runs
can have partial results on disk; use the report command above on that run's `jobs/` folder.
Saved provider headers stay on the host and are not returned to the browser or task containers.
The panel requires the source checkout and its external tools; packaged builds show an
unavailable state. Optional Terminus baselines and custom campaign settings remain CLI options.
