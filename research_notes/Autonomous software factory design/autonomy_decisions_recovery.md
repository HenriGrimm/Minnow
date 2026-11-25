# Autonomous decision-making, re-planning, stuck detection and cost bounding in unattended agent systems

Research date: 2026-11-24. Note: most primary sources found are dated Nov 2024 to Aug 2026. METR stopped actively updating its time-horizon page on 2026-09-08, so nothing newer than that from METR exists. Motivating problem: a self-contradictory task spec (Build needs backend work, but the allowed files are frontend-only) makes builder and tester ping-pong until the repair budget runs out.

## 1. Agents making and recording decisions instead of asking (decision logs, spec ownership, clarify steps)

### Takeaway
Shipped systems settle ambiguity in one of three ways:
- **Before building:** a planner or contract step that pins down what "done" means before code is written (Anthropic sprint contracts, Spec Kit clarify/analyze, Claude Code agent-team plan approval).
- **During building:** durable written notes that later sessions read and inherit (progress files, failed-approach docs, handoff "deviations").
- **By authority:** one role with final say (planner, lead, or "CEO") that owns the spec.

None of the sources describes an agent-written ADR system as such. The closest equivalents are structured "Clarifications" sections, progress files, and handoff notes that carry deviations.

### Cited Findings
**Anthropic sprint contracts (Mar 24, 2026)**
- Before each sprint, the generator proposed what it would build and how success would be checked. The evaluator reviewed the proposal, and the two iterated until they agreed. The stated goal was agreeing on "what 'done' looked like" before any code was written. The agents communicated through files. — [Anthropic, Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- The contracts were granular: sprint 3 alone had 27 criteria. Full-stack grading had hard thresholds per criterion, so falling below any one failed the sprint. — [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- In the updated harness, the contract step was dropped, and per-sprint evaluation was replaced by a single final pass. The planner was kept, because without it the generator under-scoped. — [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)

**Claude Code agent teams (experimental, disabled by default)**
- One session acts as lead and coordinates through a shared task list. Teammates can be required to plan first. They send a plan-approval request to the lead, which approves it or rejects it with feedback. A rejected teammate stays in plan mode, revises, and resubmits.
- The docs say the lead makes approval decisions autonomously, so no human sits in this loop.
- Source: [Claude Code docs, agent teams](https://code.claude.com/docs/en/agent-teams)

**Cursor handoffs and spec quality (Feb 5, 2026)**
- Worker handoffs to planners carry "notes, concerns, deviations, findings." Planners receive them as follow-up messages, so even planners that have finished keep updating. — [Cursor, Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- Spec quality decided the outcome:
  - Vague instructions sent agents after obscure features.
  - A poor initial spec produced an architecture unfit for a full browser.
  - Dependency rules had to be stated explicitly.
  - Cursor's warning: agents "will follow instructions to the end, good or bad."
  - Source: [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- Cursor's prompting lessons: "Constraints are more effective than instructions." Give concrete ranges, for example "Generate 20-100 tasks." — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)

**Anthropic C compiler run (Feb 5, 2026)**
- With no orchestrator, the durable decision record is the repo itself. The prompt required extensive READMEs and progress files, updated frequently. When stuck, Claude kept a running doc of failed approaches and remaining tasks. — [Anthropic, Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)

**Anthropic long-running harness (feature list)**
- An initializer agent creates `init.sh`, `claude-progress.txt`, and a JSON feature list, often 200+ items, all initially failing. Coding agents may flip only the pass/fail field, not rewrite the items.
- JSON was reportedly chosen because models rewrite Markdown more readily.
- The core design is from Anthropic. The JSON and edit-rights details come from secondary summaries. — [Anthropic, Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents); [Duyet summary](https://duyet.github.io/obsidian-public/tldr/effective-harnesses-long-running-agents); [Towards AI](https://pub.towardsai.net/anthropics-long-running-agents-keep-their-task-list-in-json-not-markdown-because-the-model-897951907cbc)

**Spec Kit clarify and analyze**
- `/speckit.analyze` is a read-only consistency check across spec.md, plan.md and tasks.md. It flags:
  - unresolved "NEEDS CLARIFICATION" placeholders, as medium-severity ambiguities;
  - terminology drift between documents.
- Its docs advise not running implement until all critical issues are resolved. — [Spec Kit analyze docs (Mintlify mirror)](https://www.mintlify.com/github/spec-kit/commands/analyze)
- `/speckit.clarify` scans the spec against a fixed taxonomy (scope, data model, non-functional attributes, edge cases), marking each category Clear, Partial, or Missing. It asks a bounded number of questions and records each answer under `## Clarifications` / `### Session YYYY-MM-DD`.
  - These details come from community mirrors, not the official repo. — [tessl registry copy](https://tessl.io/registry/skills/github/unoplatform/uno/speckit-clarify); [skills.sh copy](https://www.skills.sh/h3y6e/speckit-skills/speckit-clarify)

**MAST: authority and clarification as failure points (multi-agent failure study)**
- Giving the ChatDev "CEO" the final say, plus clearer role specs, raised task success by 9.4%. — [MAST, arXiv 2503.13657](https://arxiv.org/html/2503.13657)
- "Fail to ask for clarification" (FM-2.2) appears in 6.8% of annotated failures. — [MAST](https://arxiv.org/html/2503.13657)

**Magentic-One task ledger**
- The ledger records given facts, facts to look up, facts to derive, and "educated guesses," and guesses are refreshed as information arrives. This is effectively an assumptions log that the orchestrator owns. — [Magentic-One, arXiv 2411.04468](https://arxiv.org/html/2411.04468v1)

**StrongDM Software Factory (Feb 2026)**
- Specs plus "scenarios" drive agents that converge without human review. Success is scored as "satisfaction": the fraction of trajectories through the scenarios that likely satisfy the user.
- Critics note the judge is also an LLM, which makes the check circular. — [Simon Willison, Feb 7 2026](https://simonwillison.net/2026/feb/7/software-factory/); [Stanford Law CodeX blog](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/)

**Gas Town (Steve Yegge, launched Jan 2026)**
- A "Mayor" coordinator, roughly a persistent Claude Code session, breaks the human's intent into tasks for "Polecat" workers running in isolated git worktrees. — [Rutigliano write-up](https://daviderutigliano.github.io/portfolio-website/posts/2026/01/gas-town-the-industrial-revolution-of-vibe-coding/); [dehora.net](https://dehora.net/journal/2026/2/initial-thoughts-on-welcome-to-gas-town)
- Yegge later said Gas Town "fell apart at the seams" with Opus 4.7. The model developed a "just two more things" tic of endlessly refining instead of finishing. — [Simon Willison, Aug 4 2026](https://simonwillison.net/2026/Aug/4/steve-yegge/)

### Inferences
- The orchestrator's ping-pong is the textbook case for a pre-build contract step. The builder and the tester share one source of truth for "done." When they disagree about scope, that disagreement is a spec defect to resolve once, by an owner, not a code defect to retry.
- The Anthropic sprint-contract pattern maps directly onto this: the builder proposes "I will touch backend file X because Build requires it," and the tester agrees or rejects before any code is written.
- MAST's CEO-final-say result and the Claude Code lead approval both support giving one role (planner or lead) write authority over the spec, including the allowed files. Its decisions should be appended to a durable log, as Spec Kit's Clarifications section does, so later attempts inherit them rather than re-litigate them.
- Making the spec's machine-checkable parts (allowed files, acceptance items) structured data that workers cannot edit, while the planner can, mirrors Anthropic's JSON feature list, where coders flip only the status field.

### Gaps
- No primary-source detail was found on how Devin, Factory (Droids), or Kiro decide without asking. The searches did not reach them within budget.
- No source was found describing agents writing formal ADRs autonomously.
- Yegge's original Gas Town post and repo role definitions (Witness, Deacon, Refinery) were not retrieved. The Witness is described only in unverified forum summaries.
- Official github/spec-kit templates were not checked. The clarify details come from mirrors.

## 2. Hierarchical re-planning (orchestrator re-decomposes or rewrites a failing task)

### Takeaway
The best-documented mechanism is Magentic-One's two-loop design:
- An inner loop asks five questions on every step, including "are we looping?" and "are we making progress?", and maintains a stall counter.
- When the counter exceeds 2, the orchestrator reflects, rewrites its facts, guesses and plan, resets all agents' contexts, and restarts.

ADaPT shows that decomposing a task only after it fails beats decomposing everything up front. Cursor found that recursive planners with fresh-start cycles beat flat or integrator-based structures.

### Cited Findings
**Magentic-One (Microsoft, Nov 2024)**
- The progress ledger asks five questions each iteration:
  1. Is the request satisfied?
  2. Is the team looping or repeating itself?
  3. Is forward progress being made?
  4. Which agent should speak next?
  5. What instruction should that agent get?
- The stall counter increments on a detected loop or a lack of progress. The threshold was 2 in the experiments.
- When the counter exceeds the threshold, the orchestrator runs a reflection step covering what went wrong, what it learned, and what it would change. It then updates the task ledger, revises the plan, and starts a new inner loop.
- All agents clear their contexts whenever the plan is updated. The plan is a hint, not a script.
- Source: [Magentic-One, arXiv 2411.04468](https://arxiv.org/html/2411.04468v1)
- Termination comes on completion or on configurable limits (maximum attempts, time). The orchestrator then reports a final answer or its "best educated guess," so it never just gives up. — [Magentic-One](https://arxiv.org/html/2411.04468v1)
- Ablation on GAIA validation with GPT-4o: removing the ledgers cut performance by 31%. — [Magentic-One](https://arxiv.org/html/2411.04468v1)

**Microsoft Agent Framework (successor to the AutoGen Magentic orchestration)**
- Exposes maximum coordination rounds, maximum consecutive stalls before replanning, and maximum plan resets. The docs example uses `max_stall_count=3`. — [Microsoft Learn, Magentic orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)
- One third-party write-up says the counter is "leaky": a productive round subtracts 1 rather than resetting it. This is unverified against the source code. — [startdebugging.net, Oct 2026](https://startdebugging.net/2026/10/what-is-magentic-orchestration-in-microsoft-agent-framework/)

**ADaPT (NAACL Findings 2024)**
- Decomposes a sub-task recursively only when the executor fails at it ("as-needed"), rather than planning everything up front.
- Reported gains over baselines of up to 28.3, 27 and 33 points on ALFWorld, WebShop and TextCraft.
- Source: [ADaPT, arXiv 2311.05772](https://arxiv.org/pdf/2311.05772); [ACL Anthology](https://aclanthology.org/2024.findings-naacl.264)

**Plan-and-Act (ICML 2025)**
- A Planner produces a high-level plan and an Executor turns steps into actions. The Planner regenerates the plan after each environment change, using the Executor's feedback.
- Results on WebArena-Lite (165 tasks) differ by paper version: 53.94% in one, 57.58% in a later one.
- Source: [Plan-and-Act, arXiv 2503.09572](https://arxiv.org/html/2503.09572v3); [PMLR](https://proceedings.mlr.press/v267/erdogan25a.html)

**Cursor architecture evolution (Jan 14 and Feb 5, 2026)**
- Failed: a single agent with "keep going" (declared success early); equal peers sharing a locked state file; planner/executor/workers/judge (bottlenecked by the slowest worker); and a "continuous executor" overloaded with roles.
- Final design: a root planner delegates to recursive subplanners and workers, and workers hand results back to the requesting planner. — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- In the January design, a judge decides at the end of each cycle whether to continue, and the next iteration starts fresh to fight "drift and tunnel vision." — [Cursor, Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents)
- Without hierarchy, agents avoided hard tasks, made small safe changes, and "churned" without progress. A dedicated integrator role created more bottlenecks than it solved. — [Cursor, scaling-agents](https://cursor.com/blog/scaling-agents)
- Open problem: planners should wake when their tasks complete. — [Cursor, scaling-agents](https://cursor.com/blog/scaling-agents)

**Anthropic C compiler: re-decomposition via an oracle**
- When all 16 agents hit the same kernel-build bug and overwrote each other, the fix was to compile most kernel files with GCC and only the rest with Claude's compiler. Different agents could then fix different bugs.
- Delta debugging later isolated file pairs that failed only together.
- Source: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler)

### Inferences
- Re-planning should be triggered by a stall signal, not by exhausting the repair budget. Magentic-One escalates to the planner after more than 2 non-progress iterations. It does not spend N repair attempts at the worker level first.
- On a re-plan, the planner should rewrite the task (amend the allowed files, split off the backend part as a sibling task, or drop the requirement and record why) and reset worker context. This is ADaPT's "decompose on failure" plus Magentic-One's "reset on plan change."
- Magentic-One's "best educated guess" termination is a model for never needing the user: when limits hit, finish with the best partial result plus a logged rationale rather than blocking.

### Gaps
- No primary LangGraph supervisor or HTN-style replanning documentation was retrieved within budget.
- No public numbers were found on how often re-planning succeeds versus loops again in production coding systems.

## 3. Loop, oscillation and stuck detection; budget policies; cut scope or retry

### Takeaway
Detectors in practice are cheap and syntactic: identical action/observation repeats, repeated errors, monologues, and A-B-A-B alternation (OpenHands, with explicit thresholds). They are backed by LLM self-assessment ("are we looping?") at the orchestrator level (Magentic-One). "Step repetition" and "unaware of termination conditions" are among the most common real multi-agent failures (15.7% and 12.4% in MAST).

### Cited Findings
**OpenHands SDK stuck detector (on by default)**
- Five patterns, with default thresholds:
  - the same action producing the same observation 4+ times;
  - the same action erroring 3+ times;
  - 3+ consecutive agent messages with no progress (monologue);
  - two action/observation pairs alternating in ping-pong for 6+ cycles;
  - repeated context-window errors (no numeric threshold given).
- Status can be checked with `conversation.stuck_detector.is_stuck()`.
- Source: [OpenHands SDK docs, agent stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
- A GitHub issue asks to make the thresholds configurable, because the defaults break legitimate polling (4 and 3 as above). — [OpenHands software-agent-sdk issue #762](https://github.com/OpenHands/software-agent-sdk/issues/762)

**MAST failure prevalence** (1,600+ annotated traces, 7 multi-agent frameworks, kappa 0.88)

| Category | Failure mode | Share |
|---|---|---|
| System design, sum about 44% (my sum) | Step repetition | 15.7% |
| | Unaware of termination conditions | 12.4% |
| | Disobey task specification | 11.8% |
| Inter-agent misalignment, sum about 32% | Reasoning-action mismatch | 13.2% |
| | Task derailment | 7.4% |
| | Fail to ask for clarification | 6.8% |
| Verification, sum about 23.5% | Incorrect verification | 9.1% |
| | No or incomplete verification | 8.2% |
| | Premature termination | 6.2% |

- Adding a high-level task-objective verification step raised ChatDev success by 15.6%, the largest reported gain. Prompt-only fixes gave "limited and inconsistent" results. — [MAST, arXiv 2503.13657](https://arxiv.org/html/2503.13657)

**Magentic-One**
- Top error codes from its own log analysis were "persistent-inefficient-actions" (repeating unproductive actions without adapting) and "insufficient-verification-steps." — [Magentic-One](https://arxiv.org/html/2411.04468v1)

**Cursor**
- Requiring 100% correctness before every commit serialized the system. Cursor instead accepted a small, steady error rate plus a final "green" fixup pass. — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- "Agents occasionally run for far too long" remains an open problem. — [Cursor, scaling-agents](https://cursor.com/blog/scaling-agents)

**Anthropic harness evaluator behavior**
- Claude as QA found real issues, then "talked itself into" approving the work, and tested superficially. The fix was to tune the QA prompt against human-judged logs. — [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)

**Anthropic C compiler**
- Regressions (new features breaking old ones) were controlled by a CI gate that new commits could not break.
- A `--fast` mode runs a deterministic per-agent 1% or 10% sample, to counter "time blindness."
- Test output is kept tiny, with "ERROR" and the reason on one greppable line, to avoid context pollution.
- Source: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler)

**Opus 4.7 failure (Gas Town)**
- A model-specific failure that turns into a stuck state: a never-finishing "just two more things" refinement loop. — [Simon Willison, Aug 4 2026](https://simonwillison.net/2026/Aug/4/steve-yegge/)

### Inferences
- The builder/tester loop is exactly OpenHands' "alternating pattern": state A (code added) → fail "out of scope" → state B (code removed) → fail "missing." A detector can catch this cheaply:
  - hash the diff or the set of touched files per attempt, plus the failure reason;
  - flag when attempt n matches attempt n-2 (A-B-A) and the two failure reasons cite different spec clauses.
- That signal should go to a spec-conflict resolver (the planner), not to another repair attempt. Six cycles is OpenHands' threshold for generic actions. For whole build/test attempts, which are far more expensive, firing on the first A-B-A repetition seems warranted.
- MAST's numbers suggest most of the orchestrator's budget waste comes from system design (repetition, termination awareness) rather than model weakness, so detector-plus-replan is likely higher-leverage than better builder prompts.
- Cursor's "accept a small error rate plus a final green pass" is a cut-scope policy. It implies a task can be marked done-with-known-deviation and handed to a later fixup task rather than retried to exhaustion.

### Gaps
- No published data was found on the false-positive rates of stuck detectors, or on the dollar savings from early loop termination.
- No source gave an empirical rule for when to cut scope versus retry. Current practice is threshold-based (Magentic-One more than 2 stalls; Microsoft Agent Framework max plan resets; OpenHands 3 to 6 repeats).

## 4. Long-horizon autonomy data (METR, multi-day runs, spec vs capability failures)

### Takeaway
By early 2026, frontier models' 50% time horizons on METR's suite were in the 12 to 16+ hour range, which METR says is about the reliable ceiling of its tasks. METR stopped updating the page in September 2026.

Real multi-day runs (Anthropic's 2-week C compiler, Cursor's week-long browser and 3-week migration) succeed with heavy harnessing. They still report regressions, drift, and spec-caused misdirection. MAST argues design and coordination, not base-model capability, explain most multi-agent failures.

### Cited Findings
**METR time horizons**
- METR's page notes a GPT-5 agent at about "2 hours and 17 minutes" (50% horizon). — [METR, Task-Completion Time Horizons](https://metr.org/time-horizons/)
- Latest models added: Opus 4.6 and GPT-5.3-Codex (Feb 20, 2026), GPT-5.4 (Apr 10), Gemini 3.1 Pro (Apr 15), and Claude Mythos Preview (early, May 8). — [METR, Task-Completion Time Horizons](https://metr.org/time-horizons/)
- On Sep 8, 2026 METR "clarified that this page is no longer actively updated." It warns that measurements above 16 hours are unreliable with its task suite. — [METR, Task-Completion Time Horizons](https://metr.org/time-horizons/)
- Time Horizon 1.1 (Jan 2026): the post-2023 doubling time is 131 days (165 under TH1), and 88.6 days for models since 2024. — [METR, Time Horizon 1.1](https://metr.org/blog/2026-01-29-time-horizon-1-1/)
- Reported 50% horizons, from secondary sources:
  - Opus 4.6 at about 14.5 hours, with other reports at about 12 hours;
  - Mythos Preview at 16 hours or more.
  - Sources: [OfficeChai](https://officechai.com/ai/exponential-progress-claude-opus-4-6-has-50-time-horizon-of-14-5-hours-on-metr-time-horizons-benchmark); [LessWrong](https://www.lesswrong.com/posts/EYb2K9acKfyG2bome/metr-time-horizons-now-10x-year)
- A March 2026 modelling fix lowered recent models' 50% horizons by up to 20%. — [METR note, 2026-03-20](https://metr.org/notes/2026-03-20-impact-of-modelling-assumptions-on-time-horizon-results/)

**Anthropic C compiler (Carlini, Feb 5, 2026)**
- 16 parallel Opus 4.6 agents ran about 2,000 Claude Code sessions over two weeks, with no orchestrator. Agents claimed tasks via lock files in `current_tasks/`, coordinated through git, and a `while true` loop relaunched fresh sessions.
- Output: about 100k lines of Rust that builds Linux 6.9 (x86, ARM, RISC-V), QEMU, FFmpeg, SQLite, Postgres and Redis, with a 99% pass rate on most suites, including the GCC torture tests.
- Limits: no 16-bit x86 backend, no native assembler or linker, slower output than GCC -O0, and new features frequently broke existing ones. The author reads that last point as "nearly reached" the model's ceiling.
- Source: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler)

**Cursor long runs (Jan to Feb 2026)**
- Browser built from scratch: about a week, hundreds of concurrent workers, 1M+ lines across about 1,000 files.
- Solid-to-React migration of Cursor's own codebase: 3 weeks, +266K/-193K lines.
- Ongoing projects: Java LSP (7.4K commits, 550K lines), Windows 7 emulator (14.6K commits, 1.2M lines), Excel (12K commits, 1.6M lines).
- "Trillions of tokens" in total. — [Cursor, scaling-agents](https://cursor.com/blog/scaling-agents)
- Peak of about 1,000 commits per hour and 10M tool calls in one week. — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- Per-model behavior: GPT-5.2 stayed focused over long autonomous work, while Opus 4.5 "tended to stop early and take shortcuts." Cursor now picks a model per role. — [Cursor, scaling-agents](https://cursor.com/blog/scaling-agents)

**Cursor SQLite-in-Rust test (Jul 2026, via The Decoder)**
- The upgraded swarm hit 100% on the test suite in every configuration. The old swarm "bogged down" in merge conflicts. — [The Decoder, Jul 26 2026](https://the-decoder.com/cursors-agent-swarm-suggests-cheaper-models-can-handle-most-coding-when-frontier-models-plan-the-work/)

**Anthropic harness capability shifts**
- Opus 4.6 ran coherently for 2+ hours without sprint decomposition.
- Opus 4.5 largely eliminated "context anxiety," the behavior of wrapping up early near the context limit.
- Sonnet 4.5 needed context resets. — [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)

**Spec versus capability**
- MAST conjectures that better base models "will be insufficient to address the full MAST," since failures stem from organizational design and coordination. Spec-adjacent modes (disobey task spec 11.8%, fail to clarify 6.8%, task derailment 7.4%) together account for about 26% of failures (my sum). — [MAST](https://arxiv.org/html/2503.13657)
- Cursor attributes major misdirection to spec quality: vague instructions, poor initial architecture spec, and unstated dependency rules. — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)

### Inferences
- With single-agent horizons now in the many-hours range, the binding constraint for an unattended orchestrator is more likely spec consistency and coordination than raw model capability. This supports investing in spec validation and conflict resolution over more repair attempts.
- Model behavior differs by role and version: one model stops early, another endlessly tinkers. Loop and stall detection should therefore be harness-level and model-agnostic.

### Gaps
- No source quantifies spec ambiguity versus capability failures specifically for software-building agent systems. MAST is the closest but covers mixed tasks with 2024-era models.
- No METR measurements after mid-2026 exist, since the page is no longer updated.
- Claude and Codex multi-day run reports beyond Anthropic and Cursor were not found within budget.

## 5. Cost and latency: reported spend and techniques that cut rework

### Takeaway
Reported autonomous-build costs range widely:
- about $125 to $200 for a 4 to 6 hour single-app harness run;
- about $20k for a 2-week, 16-agent compiler build;
- an aspirational $1,000 per engineer per day at StrongDM.

The levers that cut rework are mostly structural: settle "done" up front, give small, disjoint work units, keep test output terse, sample tests during iteration, accept a small error rate with a final fixup pass, and drop harness scaffolding as models improve.

### Cited Findings
**Run costs**

| Run | Agents and model | Duration | Cost | Tokens |
|---|---|---|---|---|
| Anthropic C compiler | 16 × Opus 4.6, about 2,000 sessions | 2 weeks | just under $20,000 | about 2B input, 140M output |
| Retro game maker, solo | Opus 4.5 | 20 min | $9 | n/a |
| Retro game maker, full harness | Opus 4.5 | 6 hr | $200 | n/a |
| Digital audio workstation (DAW), updated harness | Opus (version not stated) | 3 hr 50 min | $124.70 | n/a |

- Compiler run source: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler)
- The full harness cost more than 20x the solo run but produced a far better app. — [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)

**Other cost data**
- StrongDM's stated benchmark: under $1,000 of token spend today per human engineer means "room for improvement." No actual spend or outcome figures are published. — [StrongDM factory site](https://factory.strongdm.ai/); [Simon Willison](https://simonwillison.net/2026/feb/7/software-factory/)
- A secondary report gives Cursor follow-up costs of $1,339 for an Opus hybrid configuration versus $10,565 for GPT-5.5 alone. These figures come from a search-result summary; I could not see them in the Decoder article text I could access, so they are unverified. The headline claims cheaper models can do most coding when frontier models plan. — [The Decoder, Jul 26 2026](https://the-decoder.com/cursors-agent-swarm-suggests-cheaper-models-can-handle-most-coding-when-frontier-models-plan-the-work/)

**Rework-cutting techniques**
- *Smaller, disjoint units*
  - Lock-file task claiming, plus oracle-based partitioning so agents fix different bugs (C compiler).
  - "Generate 20-100 tasks" scoping (Cursor).
  - Sources: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler); [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- *Shared context and memory*
  - READMEs and progress files, plus failed-approach docs (C compiler).
  - Scratchpads rewritten rather than appended, and summaries at the context limit (Cursor).
  - Context reset on plan change (Magentic-One).
  - Sources: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler); [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases); [Magentic-One](https://arxiv.org/html/2411.04468v1)
- *Cheaper verification loops*
  - Terse greppable test output, plus `--fast` 1% or 10% sampled test runs (C compiler).
  - Per-sprint evaluation replaced by a single end-of-run evaluator, which is kept only when the task exceeds what the model does reliably solo (Anthropic harness).
  - Sources: [Anthropic, C compiler](https://www.anthropic.com/engineering/building-c-compiler); [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- *Throughput over per-commit perfection*
  - A small steady error rate, plus a final green pass. — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- *Model per role*
  - Cursor picks a model per role, and GPT-5.2 out-planned the coding-specialized GPT-5.1-Codex. — [Cursor, scaling-agents](https://cursor.com/blog/scaling-agents)
- *Infrastructure bottleneck*
  - Disk I/O from parallel compiles became the bottleneck, and restructuring raised throughput "multiple times." — [Cursor, self-driving codebases](https://cursor.com/blog/self-driving-codebases)

### Inferences
- A spec-contradiction loop burns the most expensive kind of iteration: full build plus test cycles. Even one avoided A-B-A oscillation per task likely saves more than a cheap pre-build consistency check costs.
- The C compiler token split (about 14:1 input to output) suggests most spend is context re-reading. Prompt caching and terse tool output should matter more than output-side savings. No source quantified caching savings directly.
- Anthropic's harness trend is to remove scaffolding as models improve while keeping the planner. This argues for keeping a planner or spec-owner layer, while gating expensive per-step verification on task difficulty.

### Gaps
- No primary-source dollar figures were found for Cursor's browser run, Devin, or Factory autonomous builds.
- No published measurement was found of prompt-caching savings in multi-agent coding runs.
- The cheaper-models-for-execution evidence (The Decoder, Jul 2026) could not be confirmed past the paywall, and the original Cursor post for that experiment was not located.
