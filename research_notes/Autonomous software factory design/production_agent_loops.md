# Production Autonomous Coding Agents: Build/Verify Loop Architecture (as of Nov 2026)

## Q1. Devin / Cognition: planning, self-verification, and the "Don't Build Multi-Agents" argument (and how it evolved by 2026)

### Takeaway
Cognition's June 2025 position: default to a single-threaded linear agent because parallel subagents make conflicting implicit decisions; use a context-compression model when history overflows. By April 2026 they had refined this rather than reversed it. Writes stay single-threaded, and other agents add judgment but not edits: a clean-context reviewer (Devin Review), a "Smart Friend" escalation model, and a manager/child "map-reduce-and-manage" pattern. Verification now runs in the same agent: Devin writes its own test plan grounded in source code, drives the app with computer use and returns video/screenshot proof. A separate reviewer loops "until the diff comes back clean", with no published round cap.

### Cited Findings
**"Don't Build Multi-Agents" (Walden Yan, June 12, 2025)**
- Two principles: (1) "Share context, and share full agent traces, not just individual messages"; (2) "Actions carry implicit decisions, and conflicting decisions carry bad results." — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Flappy Bird example: parent splits into "background + pipes" and "bird" subtasks. One subagent builds a Super Mario-style background, the other a mismatched bird, and the combiner can't reconcile them. Passing the original task to each subagent doesn't fix this, because real tasks carry multi-turn context that shapes interpretation. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Recommended alternative: a single-threaded linear agent. For tasks that overflow context, add a separate LLM that compresses history into key details, events and decisions. Cognition says this is hard to do well and has fine-tuned a smaller model for it. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Calls Claude Code's (2025) subagents a "purposefully simple approach": they don't run in parallel with the main agent, and they answer narrow questions rather than write code. That keeps investigative work out of the main agent's history. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Argues agents can't yet resolve disagreements through long-context discussion the way human engineers do, so dispersed decision-making is fragile in 2025. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)

**"Multi-Agents: What's Actually Working" (Walden Yan, April 22, 2026)**
- Core rule still holds for parallel-writer swarms, which have seen little meaningful adoption. Working patterns keep writes single-threaded and let other agents contribute intelligence. Unstructured swarms are called "mostly a distraction". — [Cognition](https://cognition.com/blog/multi-agents-working)
- Devin Review catches about 2 bugs per Devin-written PR on average, about 58% of them severe. Coder and reviewer iterate until most bugs are resolved before a human opens the PR. No round count is given. — [Cognition](https://cognition.com/blog/multi-agents-working)
- Reviewer gets clean context: it starts without the coder's history, reads only the diff, and can question assumptions the coder accepted. The rationale is "context rot" in long contexts. — [Cognition](https://cognition.com/blog/multi-agents-working)
- Anti-ping-pong mechanism: a "communication bridge" lets the coder filter reviewer findings using the user's instructions. This prevents loops and out-of-scope work. — [Cognition](https://cognition.com/blog/multi-agents-working)
- "Smart Friend" pattern: a fast small primary model (SWE-1.5, about 950 tok/s) escalates to a stronger model (Sonnet 4.5 for planning).
  - The primary's weakness set the quality ceiling.
  - Best results came when both models were strong.
  - Share a fork of the primary's full context.
  - The smart model should tell the primary to read files it never read rather than guess.
  - — [Cognition](https://cognition.com/blog/multi-agents-working)
- Manager/child Devins coordinate over an internal MCP. Failures: managers too prescriptive, children assumed shared state, and children didn't report to siblings by default. Recommended: "map-reduce-and-manage". — [Cognition](https://cognition.com/blog/multi-agents-working)
- Devin usage in Cognition's largest enterprise segment grew about 8x over six months. Managing many agents became the bottleneck. — [Cognition](https://cognition.com/blog/multi-agents-working)
- "Devin can now Manage Devins" (March 19, 2026): each managed Devin is a full Devin in its own isolated VM. — search summary of [Cognition](https://cognition.com/blog/devin-can-now-manage-devins) (not fetched directly)

**Self-verification ("Verifying Agentic Development at Scale", Ido Pesok, May 29, 2026)**
- Same agent verifies. Devin writes a test plan grounded in source code, spins up the app, clicks through it and confirms its changes work. No separate verifier agent is described. Cognition is experimenting with routing the test phase to different models. — [Cognition](https://cognition.com/blog/testing-development)
- Design rules:
  - Annotate expected behavior before each action.
  - Mark each assertion passed, failed or untested, so Devin "will lie less about its findings".
  - Move repeated steps such as login into deterministic scripts saved as repo "testing skills".
  - Save environment setup as a YAML blueprint/snapshot.
  - Return a labelled-screenshot report plus a chaptered video.
  - — [Cognition](https://cognition.com/blog/testing-development)
- Test-mode failure modes:
  - Over-testing unrelated parts of the product.
  - Getting lost in setup before reaching the feature.
  - Missing the core behavior the PR was meant to change.
  - Hallucinating app paths that don't exist.
  - Screenshot timing problems (missing toasts).
  - "Cheating" by running JS to trigger states instead of clicking through the UI.
  - Flaky login flows.
  - — [Cognition](https://cognition.com/blog/testing-development)
- Numbers:
  - Test mode is billed at 1/5 of normal usage cost.
  - Test runs approved per day more than doubled in a couple of months.
  - Engineers run 10–20 Devins in parallel, each with its own dev server.
  - — [Cognition](https://cognition.com/blog/testing-development)
- Devin 2.2 (Feb 24, 2026) added computer use, self-verification and auto-fix. — search summary of [Cognition](https://cognition.ai/blog/introducing-devin-2-2)
- 2025 performance review (Nov 14, 2025): 67% of Devin PRs merged, up from 34% a year earlier. This is vendor-reported. A third party notes the denominator covers only PRs Devin actually opened. — [Cognition](https://cognition.com/blog/devin-annual-performance-review-2025) (headline via search; full text not read); critique via [agentmarketcap](https://agentmarketcap.ai/blog/2026/04/07/devin-67-percent-pr-merge-rate-autonomous-coding-agent-performance)
- Independent tracker: 70.4% of Devin PRs merged (58,822 of 83,590, Aug 24 – Oct 18, 2026). — [amplifying.ai](https://amplifying.ai/coding-agents/devin) (via search snippet)

### Inferences
- Cognition's 2026 stance amounts to "one writer, many critics". Reviewers, escalation models and testers are allowed, but only one agent edits a given workstream. That is a direct design rule for a builder/tester split.
- They split context deliberately: reviewers get clean context (diff only), while escalation/advisor models get the full context fork. A tester agent fits the "clean context" bucket.
- Their main defence against ping-pong is scope filtering: the coder uses the user's intent to discard out-of-scope reviewer findings. They don't publish a fixed round cap.

### Gaps
- No published cap on Devin↔Devin Review rounds, and no cost per review cycle.
- The 67% merge-rate methodology was not verified from the full primary text.
- The "Devin Bots" (Nov 2026, weeks-long team management) architecture is only reported second-hand ([The New Stack](https://thenewstack.io/cognition-devin-bots-management/)). Its conflict handling is undocumented.

---

## Q2. Anthropic: Building effective agents, long-running harnesses, the multi-agent research system, Claude Code subagents/agent teams, the C compiler, and the 3-agent harness

### Takeaway
Anthropic's guidance moved through three steps:
- **2024:** simple loops, with an evaluator-optimizer only when criteria are clear.
- **Nov 2025:** initializer + coding agent with a JSON feature list, a progress file, one feature per session and browser E2E self-testing.
- **Feb 2026:** 16 parallel agents with no orchestrator, coordinated by git lock files and an extremely good test oracle.
- **Mar 2026:** planner/generator/evaluator with negotiated "sprint contracts". Separate evaluation is justified because a skeptical evaluator is easier to tune than a self-critical generator. It is worth its cost only at the edge of model capability, and was cut back to a single end-of-run pass with Opus 4.6.

### Cited Findings
**Building effective agents (Dec 19, 2024)** — note: recalled from the known source text, not re-fetched this session
- Evaluator-optimizer is recommended when there are clear evaluation criteria and iterative refinement gives measurable value. Two good-fit signals:
  - Responses demonstrably improve when a human articulates feedback.
  - The LLM can itself provide such feedback.
  - — [Anthropic](https://www.anthropic.com/research/building-effective-agents)
- Agents should include stopping conditions, such as a maximum number of iterations. Coding is a good agent domain because solutions are verifiable through automated tests, and agents can iterate using test results as feedback. — [Anthropic](https://www.anthropic.com/research/building-effective-agents)

**Effective harnesses for long-running agents (Nov 2025)**
- Problem: even Opus 4.5 on the Agent SDK fell short of a production-quality web app from a high-level prompt. Two failures:
  - It tried to one-shot the app, ran out of context mid-feature and left undocumented partial work.
  - Later sessions saw some progress and declared the project finished.
  - — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- An initializer agent (first session only) creates `init.sh`, `claude-progress.txt`, a feature list and an initial git commit. The coding agent runs every later session. Both share the same system prompt, tools and harness and differ only in the initial user prompt. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Feature list: more than 200 features for the claude.ai clone, all initially failing. Each has category, description, test steps and a `passes` field.
  - Coding agents may only flip `passes`.
  - Removing or editing tests is declared unacceptable.
  - JSON was chosen because the model overwrote it less often than Markdown.
  - — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Session startup routine:
  1. `pwd`, then read the git log and progress file.
  2. Read the feature list and pick the highest-priority failing feature.
  3. Run `init.sh` and a basic E2E smoke check to catch bugs left by the previous session.
  4. Implement one feature.
  5. Commit and update notes.
  - — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Verification is done by the builder itself. Claude marked features done after only unit tests or curl. Prompting it to test as a human user with browser automation (Puppeteer MCP) "made a large difference". The agent couldn't see browser-native alert modals, so features depending on them stayed buggier. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Open question flagged by the authors: whether one general agent or specialized testing/QA/cleanup agents does better. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Harness design for long-running application development (Prithvi Rajasekaran, Mar 24, 2026)**
- Problems:
  - "Context anxiety": wrapping up early near the perceived context limit.
  - Self-evaluation: agents confidently praise mediocre work, especially subjective design.
  - — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Resets vs compaction: Sonnet 4.5 had strong context anxiety, so resets with structured handoff artifacts were essential. Opus 4.5 largely removed the behavior, so resets were dropped. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Frontend GAN-style loop:
  - The evaluator uses Playwright MCP on the live page.
  - Four criteria (design quality, originality, craft, functionality), calibrated with few-shot scored examples.
  - The loop ran 5–15 iterations per generation, with full runs up to 4 hours.
  - — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Full-stack: planner expands a 1–4 sentence prompt into a product spec. The generator works in sprints and self-evaluates before QA. The evaluator tests the running app with Playwright. Each criterion has a hard threshold, and failing any one fails the sprint. Threshold values were not published. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Sprint contracts: before coding, the generator proposes what it will build and how success will be verified, and the evaluator reviews until they agree. Agents communicate via files. Sprint 3 alone had 27 criteria. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Cost:
  - Solo Opus 4.5 run: 20 min, $9, and the core feature was broken.
  - Full harness: 6 hr, $200 (more than 20x), with a much more functional result.
  - Opus 4.6 DAW example: 3 hr 50 min, $124.70.
  - — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- With Opus 4.6, they removed sprints and moved the evaluator to a single end-of-run pass. They kept the planner, because without it the generator under-scoped. Quote: "The evaluator is not a fixed yes-or-no decision". It is worth it only when the task is beyond what the model does reliably solo. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Principle: tuning a standalone evaluator to be skeptical is more tractable than making a generator self-critical. Re-examine the harness with each new model and remove components that are no longer load-bearing. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)

**Building a C compiler with a team of parallel Claudes (Nicholas Carlini, Feb 5, 2026)**
- Scale:
  - 16 parallel Opus 4.6 agents with no active human intervention.
  - Nearly 2,000 Claude Code sessions over about 2 weeks.
  - About 2B input and 140M output tokens; just under $20,000.
  - About 100k-line Rust compiler that builds Linux 6.9 (x86/ARM/RISC-V), QEMU, FFmpeg, SQLite, Postgres and Redis.
  - About 99% pass on most suites, including the GCC torture tests.
  - — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Harness: a bash `while true` loop re-runs Claude with `AGENT_PROMPT.md` in a fresh Docker container per agent. A bare repo is mounted at `/upstream`; each agent clones, works and pushes. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Coordination: an agent claims a task by writing a file to `current_tasks/`, and git sync forces the loser to pick another. There is no orchestrator and no inter-agent messaging. Merge conflicts are frequent, but Claude resolves them. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Tests as oracle:
  - High-quality suites plus custom verifiers.
  - Harness output kept terse to avoid context pollution: few lines, `ERROR` on the same line for grep, precomputed summaries.
  - A `--fast` option runs a 1%/10% deterministic per-agent random sample to counter "time blindness".
  - For the kernel, GCC is a known-good oracle: compile most files with GCC and a subset with Claude's compiler, then delta-debug failing file pairs. This let agents work on different bugs in parallel.
  - — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Regressions: new features frequently broke existing ones, so a stricter CI pipeline was added late in the project. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Specialized agents: deduplication, performance, codegen efficiency, a Rust-design critic and documentation. Agents kept extensive READMEs/progress files because each started cold. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Limits:
  - The 16-bit real-mode code was too big (over 60kb vs a 32k limit), so it calls GCC for that phase.
  - The assembler and linker are buggy, and the demo used GCC's.
  - Codegen is worse than GCC -O0.
  - — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)

**Multi-agent research system (June 13, 2025)**
- Multi-agent (Opus 4 lead + Sonnet 4 subagents) beat single-agent Opus 4 by 90.2% on an internal research eval. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Token use:
  - Agents use about 4x the tokens of chat; multi-agent systems about 15x.
  - Token usage alone explains 80% of BrowseComp variance (three factors together explain 95%).
  - — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Poor fits for multi-agent: coding (fewer truly parallel steps), tasks where all agents need shared context, and tasks with many inter-agent dependencies. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Long tasks:
  - The lead saves its plan to memory once context passes 200k tokens.
  - When context runs low, it spawns fresh subagents and hands off via memory.
  - Evaluation is a single LLM-as-judge call producing 0–1 scores plus pass/fail; starting with about 20 queries was enough.
  - — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Operations and quality: "minor system failures can be catastrophic for agents" (error compounding). Rainbow deployments avoid disrupting running agents. Synchronous subagent waits block steering. Rewriting tool descriptions cut task time by 40%. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)

**Claude Code agent teams (docs, current Nov 2026; experimental)**
- Structure: a team lead plus teammates, each with its own context, a shared task list with dependencies, and JSON-file mailboxes. Task claiming uses file locking. Teammates don't inherit the lead's history, only the spawn prompt plus CLAUDE.md, MCP servers and skills. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Quality gates via hooks: `TaskCompleted` (exit 2 blocks completion and sends feedback), `TeammateIdle` (exit 2 keeps the teammate working) and `TaskCreated`. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Guidance:
  - Start with 3–5 teammates and 5–6 tasks per teammate.
  - "Three focused teammates often outperform five scattered ones".
  - Each teammate should own different files.
  - Use a single session or subagents for sequential, same-file or dependency-heavy work.
  - Start with research and review before parallel implementation.
  - — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Known failures: the lead implements tasks itself instead of waiting, the lead stops early, teammates stop on errors instead of recovering, and task status lags and blocks dependents. Token cost scales linearly with teammates. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)

### Inferences
- Across Anthropic's posts, external structure beats prompting for long runs:
  - a machine-readable feature/test list where the agent may only flip status;
  - a progress log plus git;
  - an E2E smoke check at session start;
  - terse, grep-able test output.
- Anthropic splits verification across three mechanisms by task type:
  - the builder self-tests E2E (long-running harness);
  - deterministic test suites/CI are the oracle (compiler);
  - a separate skeptical evaluator scores against pre-agreed criteria (3-agent harness).
- Sprint contracts are the main anti-ping-pong device: builder and tester agree "done" criteria before code is written, so review is checking, not renegotiation. Explicit iteration bounds (5–15 rounds, hard per-criterion thresholds) cap the loop.
- The $9 vs $200 data point puts a price on separate evaluation (more than 20x cost). It is justified only when solo output is broken, which argues for making the evaluator conditional.

### Gaps
- Building effective agents was not re-fetched this session; wording is from known text.
- No published pass-threshold values or average evaluator round counts for the 3-agent full-stack harness.
- No success-rate statistics across many runs for any of these harnesses; all are single-project case studies.

---

## Q3. OpenAI Codex, GitHub Copilot coding agent, Google Jules, Cursor, Factory, Kiro, OpenHands (Augment and Amazon Q not covered)

### Takeaway
Most vendor loops combine four elements:
1. The builder runs tests, linters and the app itself in a sandbox before declaring done.
2. Deterministic gates (linters with remediation text, CI, CodeQL) enforce constraints mechanically.
3. A separate AI reviewer/critic gives an independent check, usually with clean context.
4. Human review is optional or last.

At scale (Cursor, Factory), the systems that work are hierarchical: planner → isolated workers → validator/judge, with fresh contexts per task and shared artifacts on disk. Flat peer agents with locks failed. Factory publishes the most concrete loop numbers: 2–4 validation rounds per milestone and 37% of runtime on validation.

### Cited Findings
**OpenAI — Harness engineering (Ryan Lopopolo, Feb 11, 2026)**
- Team and output:
  - 3 engineers growing to 7, over about 5 months from an empty repo (late Aug 2025).
  - About 1M lines with "0 lines of manually-written code".
  - About 1,500 PRs merged, 3.5 PRs per engineer per day.
  - Estimated one-tenth the time of hand-writing.
  - — [OpenAI](https://openai.com/index/harness-engineering/)
- Verification by the builder: Codex runs the app per git worktree and drives it via Chrome DevTools. An ephemeral observability stack (LogQL/PromQL) is queryable by agents. Agents review their own changes locally and in the cloud in a "Ralph Wiggum Loop". — [OpenAI](https://openai.com/index/harness-engineering/)
- Merge philosophy: minimal blocking gates, short-lived PRs, and flaky tests rerun rather than blocking, because corrections are cheap and waiting is expensive. Agents often squash-merge their own PRs; human review is optional. Single runs have exceeded 6 hours, often overnight. — [OpenAI](https://openai.com/index/harness-engineering/)
- AGENTS.md is about 100 lines and works as a table of contents ("a map, not a 1,000-page instruction manual"). A structured `docs/` holds plans with progress and decision logs, a tech-debt tracker and quality grades. Linters/CI check that docs are current. — [OpenAI](https://openai.com/index/harness-engineering/)
- Entropy control:
  - Humans spent Fridays (20% of the week) cleaning "AI slop", which didn't scale.
  - Replaced by "golden principles" as mechanical rules, recurring background Codex cleanup PRs (most reviewable in under a minute, auto-mergeable) and a doc-gardening agent.
  - Custom linters include remediation instructions in their error messages.
  - — [OpenAI](https://openai.com/index/harness-engineering/)
- Codex cloud (launch, May 2025): each task runs in its own sandbox preloaded with the repo. The agent cites terminal logs and test outputs as verifiable evidence and explicitly reports test failures or uncertainty. AGENTS.md tells it how to run tests. — [OpenAI](https://openai.com/index/introducing-codex/)

**GitHub Copilot coding (cloud) agent**
- Since Oct 2025, it automatically runs CodeQL, Advisory DB/dependency checks and secret scanning on its own code, with no GHAS license needed. — [GitHub changelog](https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-automatically-validates-code-security-and-quality/)
- Feb 2026: the agent reviews its own changes with Copilot code review before opening the PR and iterates, so a human is requested only afterward. — [GitHub blog](https://github.blog/2026/02/whats-new-with-github-copilot-coding-agent/) (via search summary)
- Mar 2026: it automatically runs the project's tests and linter and tries to fix problems before requesting review. Validation tools are configurable. — [GitHub changelog](https://github.blog/changelog/2026-03-18-configure-copilot-coding-agents-validation-tools/) (via search summary)
- Apr 2026: validation tools are 20% faster. — [GitHub changelog](https://github.blog/changelog/2026-04-10-copilot-cloud-agents-validation-tools-are-now-20-faster)

**Google Jules**
- A critic agent was added Aug 2025 ("critic-augmented generation"): an internal adversarial reviewer flags bugs, edge cases and inefficiency, and Jules revises. — [Jules changelog](https://jules.google/docs/changelog/2025-08-083)
- Accounts conflict on looping. Google said v1 is a single pass over the final output; Heise reported a repeat-until-satisfied loop. — [Google Developers Blog](https://developers.googleblog.com/en/meet-jules-sharpest-critic-and-most-valuable-ally/) vs [heise](https://heise.de/-10519952)
- Jan 26, 2026: a Planning Critic reviews plans before any code runs. — [Jules changelog](https://jules.google/docs/changelog/2026-01-26-1)

**Cursor — Scaling long-running autonomous coding (Wilson Lin, Jan 14, 2026)**
- What failed:
  - Flat peer agents with locks: 20 agents ran at the throughput of 2–3, and crashes while holding locks made the system brittle.
  - Optimistic concurrency helped, but agents without hierarchy became risk-averse, avoided hard tasks and churned.
  - — [Cursor](https://cursor.com/blog/scaling-agents)
- What worked:
  - Planners explore and create tasks, recursively via sub-planners.
  - Workers grind on one task, don't coordinate with each other and push when done.
  - A judge decides whether to continue at the end of each cycle, and the next iteration starts fresh to counter drift and tunnel vision.
  - — [Cursor](https://cursor.com/blog/scaling-agents)
- Removed: an integrator/quality-control role created more bottlenecks than it solved, since workers can handle conflicts themselves. Structure should be moderate. "Prompts matter most". — [Cursor](https://cursor.com/blog/scaling-agents)
- Models: GPT-5.2 was best for extended autonomous work. Opus 4.5 "tended to stop early and take shortcuts". GPT-5.2 was a better planner than GPT-5.1-Codex, so models are picked per role. — [Cursor](https://cursor.com/blog/scaling-agents)
- Numbers:
  - Browser: close to 1 week, more than 1M LoC across about 1,000 files.
  - Solid→React migration: 3 weeks, +266K/−193K. It passed CI but "still needs careful review".
  - Other projects: Java LSP 7.4K commits/550K LoC; Win7 emulator 14.6K commits/1.2M LoC; Excel 12K commits/1.6M LoC.
  - "Trillions" of tokens in total.
  - — [Cursor](https://cursor.com/blog/scaling-agents)

**Cursor — Towards self-driving codebases (Wilson Lin, Feb 5, 2026)**
- Evolution:
  1. A single agent declared false success.
  2. Self-coordination with a shared lock file failed.
  3. Planner/executor/workers/judge worked but was rigid, bottlenecked by the slowest worker.
  4. A continuous executor without a judge showed pathologies: sleeping, doing work itself, premature completion.
  5. Final design: root planner, recursive subplanners and workers, with both judge and integrator removed. It peaked at about 1,000 commits/hour.
  - — [Cursor](https://cursor.com/blog/self-driving-codebases)
- Workers finish on their own repo copy and submit one handoff (changes, notes, concerns, findings) that flows up to planners, who re-plan. — [Cursor](https://cursor.com/blog/self-driving-codebases)
- Error tolerance: requiring 100% correctness per commit serialized and stalled the system, with agents piling onto the same fixes. They accept a small, steady error rate and recommend a final reconciliation/"green branch" pass. — [Cursor](https://cursor.com/blog/self-driving-codebases)
- Numbers: about 10M tool calls in one week, several hundred agents per machine and thousands overall. Disk I/O from parallel compiles was the bottleneck. Splitting the monorepo into crates improved throughput several times over. — [Cursor](https://cursor.com/blog/self-driving-codebases)
- Prompt rules:
  - "Constraints beat instructions", e.g. no TODOs and no partial implementations.
  - Give concrete ranges ("20–100 tasks").
  - Avoid checkbox prompting, which narrows focus.
  - Vague specs led to obscure features.
  - — [Cursor](https://cursor.com/blog/self-driving-codebases)

**Factory — How Missions Work (Theo Luan, Apr 10, 2026)**
- Roles:
  - The orchestrator plans and writes a validation contract of behavioral assertions before any features, so the contract isn't shaped by the implementation.
  - Workers write tests before code, but "the final judgment on correctness is not their call".
  - Scrutiny validators review the code and the trajectory.
  - User-testing validators run black-box tests against the contract.
  - Validators never implement fixes.
  - — [Factory](https://factory.com/news/missions-architecture)
- Loop: validators report to the orchestrator, which creates fix features, then the milestone re-validates. No explicit cap, but every milestone converged in 2–4 validation rounds. If blocked, the mission halts and returns control to the user. — [Factory](https://factory.com/news/missions-architecture)
- Context: each feature gets a fresh worker context. Continuity comes from shared artifacts (validation-contract.md, features.json, services.yaml, AGENTS.md, knowledge base). Workers run serially, in order. — [Factory](https://factory.com/news/missions-architecture)
- Slack-clone mission numbers:
  - 16.5 h runtime: orchestration 2.3%, implementation 60.5%, validation 37.2%.
  - 185 runs: 63 workers, 27 validators.
  - 38.8k LoC (52.5% tests), 89.25% statement coverage.
  - 81 issues surfaced (65 blocking); 21 of 61 features (34.4%) were fix features.
  - Median turns: implementation 51 (p90 123), validation 30 (p90 37).
  - 778.5M tokens, of which 744.9M were cache reads.
  - — [Factory](https://factory.com/news/missions-architecture)
- Longest mission: reportedly 16 days. Factory's launch post admits that long plans accumulate errors, that the orchestrator sometimes scopes too broadly, and that workers get stuck on edge cases. — search summaries of [Factory missions](https://factory.ai/news/missions) / [AI Engineer talk](https://www.ai.engineer/talks/ow1we5PzK-o-production-multi-agent-architecture) (not fetched directly)

**Amazon Kiro**
- Spec-driven:
  - EARS requirements are checked for contradictions and gaps with automated reasoning before coding.
  - Properties are extracted from requirements and turned into property-based tests, with the agent writing the generators.
  - Each property traces to a requirement.
  - Kiro says PBT "is not formal verification". It is IDE-only.
  - — [Kiro docs](https://kiro.dev/docs/specs/correctness/), [Kiro blog](https://kiro.dev/blog/property-based-testing/)

**OpenHands**
- A trained critic model (Qwen2.5-Coder-32B fine-tuned on SWE-Gym rollouts) ranks multiple rollouts (inference-time scaling), which gave SOTA on SWE-bench Verified in 2025. — [OpenHands](https://openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model)
- March 2026: critic-guided selection reached 73.8% Best@8 vs 57.9% random on the mixed-outcome subset, and enabled cheaper early stopping. Training on "code survival" beat training on PR merges. — [OpenHands](https://openhands.dev/blog/20260305-learning-to-verify-ai-generated-code); [arXiv 2603.03800](https://arxiv.org/pdf/2603.03800) (via search summary)
- May 2026: the critic is in OpenHands Cloud with an iterative-refinement option that retries tasks scoring below a threshold. — [OpenHands](https://openhands.dev/blog/20260506-the-verification-stack) (via search summary)

### Inferences
- Common pattern across vendors:
  - The builder must run tests, linters and the app itself (Codex, Copilot, Devin, Anthropic harness).
  - An independent check comes from a clean-context reviewer/critic (Devin Review, Copilot code review, Jules critic, Factory validators) or a trained scorer (OpenHands).
  - Deterministic gates (CodeQL, CI, linters) sit underneath both.
- Factory is the clearest "software factory" reference design:
  - the contract is written before implementation by a third party (the orchestrator);
  - validators cannot fix;
  - fixes go back through the planner as new features rather than direct builder↔tester chat.
- Both Factory and Cursor route fixes through the planner rather than through direct builder↔tester messaging. That avoids unbounded peer ping-pong and keeps one owner of scope.
- Cursor's and OpenAI's data argue against blocking on perfection. Cheap corrections, rerunning flakes and accepting a small error rate plus a reconciliation pass beat strict per-commit gates at high throughput.

### Gaps
- Augment Code and Amazon Q Developer agent: not researched this session (tool budget). No findings recorded.
- No Codex cloud success-rate or cost-per-task numbers found.
- Copilot self-review loop round limits are undocumented.
- Factory's per-mission cost in $ was not published.

---

## Q4. Where verification lives, and how review rounds are bounded / nitpicking avoided

### Takeaway
No vendor publishes a hard "max N review rounds" for production code review. Rounds are bounded indirectly by:
- pre-agreed acceptance criteria (sprint contracts, validation contracts, feature lists with immutable tests);
- severity/scope filters on reviewer output;
- per-criterion hard thresholds;
- routing fixes through a planner;
- escalation to a human when blocked.

Observed convergence: 2–4 rounds (Factory), 5–15 iterations for subjective design (Anthropic).

### Cited Findings
- Builder self-tests before declaring done:
  - Anthropic long-running harness: browser E2E, `passes` only flipped after testing. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  - Copilot: runs tests/linter/CodeQL before requesting review. — [GitHub changelog](https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-automatically-validates-code-security-and-quality/)
  - Codex: runs the app via DevTools. — [OpenAI](https://openai.com/index/harness-engineering/)
  - Devin: test mode with an assertion list. — [Cognition](https://cognition.com/blog/testing-development)
- Separate reviewer/evaluator, with stated rationale:
  - "tuning a standalone evaluator to be skeptical" is more tractable than a self-critical generator. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  - An implementer's prior reasoning biases self-evaluation ("adversarial context"). — [Factory](https://factory.com/news/missions-architecture)
  - Clean-context review avoids context rot. — [Cognition](https://cognition.com/blog/multi-agents-working)
- Deterministic gates:
  - Strict CI was added once regressions appeared (C compiler). — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
  - Custom linters with remediation text, plus structural tests. — [OpenAI](https://openai.com/index/harness-engineering/)
  - Hooks (`TaskCompleted` exit 2) block task completion. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Round bounding:
  - Contract negotiated before coding (27 criteria for one sprint); 5–15 iterations for design. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  - 2–4 validation rounds per milestone; validators can't fix; blocked missions halt to the user. — [Factory](https://factory.com/news/missions-architecture)
  - The coder filters reviewer findings by user intent to stop loops and out-of-scope work. — [Cognition](https://cognition.com/blog/multi-agents-working)
  - Stopping conditions such as max iterations. — [Anthropic](https://www.anthropic.com/research/building-effective-agents)
  - Retry only if the critic score is below a threshold. — [OpenHands](https://openhands.dev/blog/20260506-the-verification-stack)
- Anti-gaming of tests:
  - Agents forbidden to edit or remove tests; may only flip `passes`. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  - The contract is written before the implementation, so it isn't shaped by it. — [Factory](https://factory.com/news/missions-architecture)
  - Devin "cheating" via JS-triggered states is named as a failure mode. — [Cognition](https://cognition.com/blog/testing-development)
- Too much gating hurts throughput:
  - Removing the integrator/judge helped. — [Cursor](https://cursor.com/blog/self-driving-codebases)
  - Minimal blocking gates; flakes rerun. — [OpenAI](https://openai.com/index/harness-engineering/)
  - Make the evaluator conditional on task difficulty. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Long-running context management:
  - Fresh context per feature plus on-disk artifacts: features.json, progress files, validation-contract.md, AGENTS.md/READMEs. — [Factory](https://factory.com/news/missions-architecture); [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents); [Anthropic C compiler](https://www.anthropic.com/engineering/building-c-compiler)
  - Periodic fresh restarts. — [Cursor](https://cursor.com/blog/scaling-agents)
  - A compression model. — [Cognition 2025](https://cognition.com/blog/dont-build-multi-agents)
  - Resets were needed for Sonnet 4.5 but not for Opus 4.5+. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)

### Inferences
- A defensible synthesis for an autonomous build loop:
  1. A planner writes acceptance criteria/tests before the builder starts, or builder and tester agree a contract up front.
  2. The builder must self-run the deterministic checks and E2E before handoff.
  3. One clean-context validator judges against the contract only, with severity tags; non-blocking findings don't trigger another round.
  4. Validators don't fix. Failures become new fix tasks via the planner.
  5. Cap rounds at about 3–4 (Factory's observed convergence), then escalate to a human or halt.
  6. State lives in files plus git, not in conversation.
- The validation share of runtime (Factory 37%) and the evaluator cost multiplier (Anthropic more than 20x vs solo) are the main budget numbers to plan against.

### Gaps
- No vendor publishes nitpick-rate data or reviewer false-positive rates, except Cognition's "about 58% of found bugs severe".
- No controlled comparison of same-agent vs separate-agent verification on identical tasks found. Anthropic's $9 vs $200 is one anecdote, and the configurations differed in more than just the evaluator.
