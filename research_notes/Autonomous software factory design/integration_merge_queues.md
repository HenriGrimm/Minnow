# Integration of many concurrent changes: merge queues, semantic conflicts, and multi-agent integration

Context: research for a system where many AI agents finish tasks in parallel worktrees. Today each finished task is rebased onto the integration tip and the exact rebased SHA must be re-tested by a slow (5–15 min) LLM tester, so concurrent merges keep invalidating tests (re-test livelock). Parallel tasks also each add an Alembic migration, and multiple heads appear only after integration. Research date: 2026-11-24. The claims below are dated where the source gives a date.

---

## Q1. How merge queues and merge trains work (Bors, GitHub, GitLab, Uber SubmitQueue, Zuul, Chromium CQ, Google TAP, Meta): what is tested per change versus per batch, and how they avoid re-running everything on every upstream change

### Takeaway
Every serious system replaces "rebase, then re-test against whatever tip exists now" with a queue. A change is tested once against a predicted future tip: the base plus every change ahead of it. That result is thrown away only when a change ahead actually fails (Zuul, GitHub, GitLab), or when a dependency-aware analyzer says the changes interact (Uber). Throughput comes from speculation, batching with bisection on failure, and pruning independent changes. It does not come from re-testing on each upstream push. Systems that cannot afford full pre-merge testing (Google TAP) split the work: cheap presubmit checks, then periodic postsubmit testing with automated culprit-finding and revert.

### Cited Findings

**Bors / the "Not Rocket Science Rule" (NRSR)**
- The NRSR says to keep a branch automatically guaranteed to always pass the full test suite. Graydon Hoare credits the phrase to Ben Elliston and applied it to Rust with the `bors` bot (~2013). Homu reimplemented it, and Bors-NG later served as a GitHub app. Bors itself was reported deprecated in 2023. — [eluvk NRSR notes](https://eluvk.github.io/readings/nrsr.html); [Graphite: Bors, TAP and merge queues](https://graphite.com/blog/bors-google-tap-merge-queue); [Lean Zulip archive, 2023](https://leanprover-community.github.io/archive/stream/113488-general/topic/bors.20going.20away.3F.html)
- Bors-NG exists to prevent "merge skew": patches that pass review and CI but break once merged into a changed main. — [Aviator: What's a bors](https://www.aviator.co/blog/what-is-bors/) (search-snippet level)
- "Bors-style" queueing means batch, then bisect. Waiting changes are stacked onto main and the stack tip is tested. If it passes, the whole batch fast-forwards. If it fails, the batch is binary-bisected to find the culprit. — [Gas Town architecture doc](https://raw.githubusercontent.com/gastownhall/gastown/main/docs/design/architecture.md)

**Jane Street (2014): scaling the NRSR**
- The naive serial queue costs at least `m × n` minutes for n requests at m minutes each. Their full tree build took "two hours and up", and some changes waited up to 24 hours. — [Jane Street, "Making never break the build scale", 2014-07-06](https://blog.janestreet.com/making-never-break-the-build-scale/)
- Techniques they tried:
  - Simple speculation: test requests in parallel, and the first success becomes the tip. The other successes still need a re-test against the new tip, which is the same livelock this system has.
  - Merging speculation: batch several requests and release the batch if it passes. On failure, test requests individually.
  - A faster incremental build system (Jenga).
- The largest win came from cutting the number of integrations. Features stay on their own branches until fully reviewed and then integrate once, which dropped main-repo requests from "hundreds…a week" to about 30–40. — [Jane Street](https://blog.janestreet.com/making-never-break-the-build-scale/)
- The author argues these are constant-factor fixes. He proposes hierarchical integration (Linux "lieutenant" model): subsystem queues batch work before it passes the central build-bot once. — [Jane Street](https://blog.janestreet.com/making-never-break-the-build-scale/)

**Zuul (OpenStack): speculative gating**
- A dependent pipeline tests each change on top of every change ahead of it in the queue. The jobs for C merge A+B+C and then test. This keeps the guarantee that each change is tested exactly as it would merge. — [Zuul docs: Project Gating](https://zuul-ci.org/docs/zuul/latest/gating.html)
- If C fails, Zuul merges A and B and ejects C. D and E were tested assuming C would merge, so they are restarted: D against the branch tip, E on top of D. Best case, the whole window merges in parallel. Worst case is serial. — [Zuul docs](https://zuul-ci.org/docs/zuul/latest/gating.html)
- The window works like TCP congestion control. It starts at 20 changes, grows by 1 per successful merge, and halves on each failure, with a floor and an optional ceiling. Each project queue keeps its own window, so one project's flaky tests do not shrink another's. — [Zuul docs](https://zuul-ci.org/docs/zuul/latest/gating.html)
- Cross-repo `Depends-On:` footers form a DAG. In dependent pipelines dependencies are serialized, so if B fails, A is ejected with it. Zuul freezes branch heads per queue item so every job on that item sees a consistent multi-repo state. — [Zuul docs](https://zuul-ci.org/docs/zuul/latest/gating.html)

**GitLab merge trains**
- Each MR's pipeline tests target + every MR ahead + itself, so the third MR runs A+B+C. Pipelines run in parallel, and an MR merges only after its own pipeline passes and all earlier MRs have merged. The default is 20 parallel pipelines per train, and the queue length is unlimited. — [GitLab docs: Merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)
- On failure the MR is removed. Pipelines behind it are cancelled and restarted without it (C re-runs as A+C). An MR is also dropped if it becomes unmergeable mid-run because of a conflict, a draft status, or a source-branch update. — [GitLab docs](https://docs.gitlab.com/ci/pipelines/merge_trains/)
- "Merge immediately" cancels every train pipeline and restarts all of them, which the docs warn is expensive. An experimental skip-without-restart option exists, but the skipped change is never verified against the other queued changes. — [GitLab docs](https://docs.gitlab.com/ci/pipelines/merge_trains/)

**GitHub merge queue**
- Each queued PR gets a temporary branch (`main/pr-2`) built from the latest base plus the PRs ahead of it. The group merges when the required checks pass on it. — [GitHub Docs: Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- Knobs:
  - Build concurrency: 1–100 `merge_group` dispatches at once.
  - Min/max group size: 1–100. This controls when merges land, not how CI builds are combined.
  - Wait time for the minimum group size.
  - Status-check timeout.
  - "Only merge non-failing PRs". With this off, a PR that failed can still merge if a later PR's build, which contains it, passes. That tolerates flakes but can let failures slip through. — [GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- A failure, timeout, or removal causes the temporary branches behind it to be rebuilt without that PR. A "jump to front" also rebuilds every in-progress group. The docs page does not describe a bisection algorithm. — [GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- Practical pitfalls:
  - Stale jobs on self-hosted runners keep consuming queue concurrency after a failure. — [GitHub community discussion #69342](https://www.Github.com/orgs/community/discussions/69342)
  - Third-party queues add separate bisection concurrency. Trunk.io (2026-01-07) lets failure-isolation bisection run at higher concurrency than the main queue. — [Trunk changelog, 2026-01-07](https://docs.trunk.io/changelog/2026-01-07-merge-queue-independent-concurrency-for-batch-bisection)

**Uber SubmitQueue (EuroSys 2019, plus ICSE 2025 follow-ups)**
- Before SubmitQueue, Uber's iOS mainline was green only 52% of the time (one-week view). Builds take about 30–60 min in isolation. Over 9 months of iOS/Android data, there was about a 40% chance of a conflict problem with 16 concurrent, potentially conflicting changes. — [the morning paper summary of "Keeping Master Green at Scale", 2019-04-18](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)
- A single serial queue at a hypothetical 1,000 changes/day and 30 min per build would leave the last change waiting more than 20 days. — [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)
- The speculation engine builds a binary speculation tree: each change is built both assuming the change ahead succeeds and assuming it fails. Each edge carries a probability. A planner periodically runs the highest-value builds and aborts builds that are no longer scheduled. — [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)
- The conflict analyzer uses build-system targets with Merkle-style input hashes. Two changes conflict only if they affect a shared target. Independent changes turn the tree into a graph and are built and committed concurrently without waiting on each other. — [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/); [Uber: Bypassing large diffs in SubmitQueue](https://eng.uber.com/blog/bypassing-large-diffs-in-submitqueue/)
- The success-prediction model is logistic regression over about 100 hand-picked features, with 97% reported accuracy. Positive signals are prior successful speculations, test plans, and initial tests passed. Negative signals are failed speculations and resubmission count. — [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)
- Results:
  - Turnaround is within 1.2× of a perfect oracle, with n changes per hour and n workers.
  - Mainlines stayed green for more than a year.
  - Uber considered "speculate-all" optimistic execution and rejected it for high failure rates, since one failure aborts many builds.
  - Batching was rejected because it reintroduces hard-to-resolve conflicts. — [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/); [Uber research page](https://eng.uber.com/research/keeping-master-green-at-scale)
- A known limitation is commit-in-submission-order, which leaves small changes stuck behind large conflicting ones. Later work addressed it:
  - Bypassing large diffs gave a 74% improvement in land wait time. — [Uber: Bypassing large diffs](https://eng.uber.com/blog/bypassing-large-diffs-in-submitqueue/)
  - "CI at Scale: Lean, Green, and Fast" (ICSE-SEIP 2025, arXiv 2501.03440) added an ML build-time predictor and a speculation threshold so only the most likely builds run. Reported results: about 53% less CI resource use, about 44% less CPU, and about 37% lower P95 wait, across the Go, iOS, and Android monorepos. — [arXiv 2501.03440](https://arxiv.org/abs/2501.03440); [Uber: Slashing CI costs (June 2025)](https://www.uber.com/en-UG/blog/slashing-ci-costs-at-uber)

**Chromium Commit Queue (LUCI CV)**
- Modes:
  - Dry run (CQ+1) runs the normal tryjob set and reports without submitting.
  - Full run (CQ+2) runs the same set and submits if there are no new regressions.
  - Mega CQ runs a much larger set for risky CLs.
- Builders are selected per CL by `location_regexp` path filters in `commit-queue.cfg`, which is path-based test selection. The skip-tryjobs option is meant only for reverts that green the tree. — [Chromium docs: CQ](https://chromium.googlesource.com/chromium/src/+/main/docs/infra/cq.md)
- The legacy CQ daemon was replaced by LUCI Change Verifier. — [Chromium infra CQ doc](https://chromium.googlesource.com/infra/infra/+show/518fec930e9fb93c0e8c6c49e2b27c907028ec38/doc/users/services/commit_queue/index.md)

**Google TAP (presubmit and postsubmit)**
- TAP runs presubmit tests relevant to a change before submit. Postsubmit runs periodically in "Testing Cycles" over ranges of already-submitted commits, scheduled when build capacity allows, because not every test can run on every change. — [SafeRevert (ICST 2024)](https://hackthology.com/saferevert-when-can-breaking-changes-be-automatically-reverted.html); [Taming Google-Scale Continuous Testing (ICSE-SEIP 2017)](https://research.google/pubs/taming-google-scale-continuous-testing/)
- It can take 1–2 hours for a test broken by a change to start failing in TAP Postsubmit. — [Google research search result on TAP postsubmit](https://research.google/pubs/what-breaks-google/) (search-snippet level; not verified in full text)
- Flake-Aware Culprit Finding (FACF) is a noisy binary search over the commit range. Per-test accuracy was 99.54%, but per-change accuracy only 77.37% (28-day window). — [SafeRevert](https://hackthology.com/saferevert-when-can-breaking-changes-be-automatically-reverted.html)

**Meta**
- Engineers submit stacks of diffs, each standing alone and building on the previous one. "Ship It" makes Phabricator start landing them, and deployment starts after landing. — [Meta developers blog, 2022-11-15](https://developers.facebook.com/blog/post/2022/11/15/meta-developers-workflow-exploring-tools-used-to-code/)

### Inferences
- In every system above, a test result is tied to a speculative stack position (base + changes ahead), not to "the current tip at the time I finished". The test is re-run only when an assumption fails. The current system's "rebase onto tip, re-test the exact SHA, lose the race, repeat" is the naive serial queue Jane Street and Uber describe. Under concurrency it degrades toward livelock: m × n time at best, and unbounded with continual arrivals.
- With a 5–15 min LLM tester, Zuul-style speculation would let k finished tasks be tested in parallel on stacked prefixes. Wasted work then occurs only when an earlier task fails, and AIMD windowing (halve on failure) limits that waste when failure rates are high.
- Uber's conflict analyzer is the most direct fix for "every upstream merge invalidates my test". If the commits that landed between a task's tested base and the current tip touch a disjoint set of files, modules, or targets, treat the earlier result as valid and fast-forward or merge without re-testing. Uber found this independence common enough to build its scaling story on it.
- Batch + bisect (Bors, Gas Town) cuts LLM-tester calls when the failure rate is low (one test for N changes). When failures are frequent it costs O(log N) extra slow tests, so it should be adaptive, as Zuul's window is.

### Gaps
- I could not fetch the full EuroSys 2019 PDF (too large). Numbers come from the morning paper summary and Uber's pages. I did not verify Uber changes-per-day or speculation builds-per-change figures.
- GitHub's docs do not specify its bisection algorithm for failed groups. I found no first-party GitHub queue latency numbers.
- I did not verify Chromium CQ tryjob-result reuse rules, CQ throughput, or latency.
- I did not retrieve Google TAP scale numbers (tests/day, presubmit latency) from the 2017 paper's full text.
- I found no first-party Meta description of its land pipeline, conflict handling at land time, or a Meta merge queue.

---

## Q2. Optimistic merge with post-merge verification and auto-revert/bisect, versus strict pre-merge testing: who does which, and the tradeoffs

### Takeaway
There is a spectrum:
- Strict pre-merge gating on the exact combined state: Bors/NRSR, Zuul, GitLab and GitHub queues, Uber, Jane Street.
- Cheap presubmit plus periodic postsubmit with automated culprit-finding and auto-revert, for tests too expensive to run per change: Google TAP.
- Optimistic merge that tolerates a steady error rate, plus a final reconciliation pass: Cursor's multi-agent experiments.

Pre-merge gating buys an always-green trunk at the cost of latency and wasted speculation. Post-merge verification buys throughput at the cost of a broken-trunk window, culprit-finding noise from flaky tests, and wrong reverts.

### Cited Findings
- At Google, naively reverting every blamed change would wrongly revert roughly 20–130 changes per day, out of about 300–500 reverted daily. A baseline policy (revert only if blamed by ≥10 tests) had a 1.5% bad-revert rate and 26.3% recall. SafeRevert's XGBoost model reached 0.5% bad reverts and 55.7% recall (about 2.1× recall) under safety criteria of <1% bad-revert rate and ≤5 bad reverts/day. (ICST 2024 Industry Track, published 2024-05-27.) — [SafeRevert](https://hackthology.com/saferevert-when-can-breaking-changes-be-automatically-reverted.html)
- Culprit-finding is unreliable with flaky tests: 77.37% per-change accuracy for FACF. — [SafeRevert](https://hackthology.com/saferevert-when-can-breaking-changes-be-automatically-reverted.html); [Flake Aware Culprit Finding (Google)](https://research.google/pubs/pub52048/)
- Google also researches speculative testing with transition prediction, which predicts which tests will change pass/fail status in order to prioritize postsubmit work. — [Speculative Testing at Google with Transition Prediction](https://research.google/pubs/speculative-testing-at-google-with-transition-prediction/) (title/abstract level)
- Uber rejected optimistic "speculate-all" execution because one failure aborts many builds, and chose model-pruned speculation. — [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)
- GitHub's "only merge non-failing PRs = off" is a halfway point. A failed PR can still land if the later group containing it passes, which tolerates flakes but may let real failures slip through. — [GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- Cursor (2026-02-05): requiring 100% correctness before every commit caused serialization, and "a single small error" could stall the system. They accepted a small, steady error rate that other agents fix quickly, then produced a final green branch through snapshots and a quick fixup pass. Peak throughput was about 1,000 commits/hour over one week. — [Cursor: Self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- Anthropic's C-compiler experiment (Feb 2026) began with agents pushing straight to the shared upstream. Late in the project new features often broke existing ones, and the fix was a CI pipeline with stricter enforcement so new commits could not break existing code. — [Anthropic Engineering: Building a C compiler with parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)

### Inferences
- A hybrid suits this system's cost profile. Gate the exact integrated SHA with fast, deterministic checks: build, unit tests, migration-graph lint, typecheck. Run the slow LLM tester either (a) once per task, on the task branch at its fork point, to judge whether the change does what was asked, or (b) post-merge over batches, with bisect and auto-revert. The LLM tester judges a property of the change that rarely changes when unrelated commits land underneath it. Re-running it on every rebase pays the highest cost for the least information.
- If post-merge LLM testing is used, Google's data says auto-revert needs a confidence threshold. Naive blame-and-revert is wrong often enough to churn trunk, and an LLM tester's nondeterminism behaves like test flakiness.
- Cursor's and Anthropic's experience suggests that agent swarms without a pre-merge gate converge only with a strong test suite plus a final reconciliation/green pass. Strict gating appears when regressions start compounding.

### Gaps
- I found no published data on LLM-as-tester flakiness rates, or on using LLM judges inside merge queues.
- I found no first-party numbers for Meta's revert or bisect tooling.

---

## Q3. Detecting semantic conflicts: building and testing the combined state, ownership and locking, dependency-aware analyzers, generated-file and migration conflicts, and serializing hot files

### Takeaway
A clean textual merge does not mean a correct merge. Build and test conflicts are rarer than textual ones but harder to catch, and the only general detector is building and testing the combined state. Dependency-aware analysis (Uber's target hashes) decides when the combined state must be re-tested. For generated and ordered artifacts such as migrations, lockfiles, and snapshots, the robust patterns are:
1. Turn the hidden semantic conflict into a textual one (django-linear-migrations' `max_migration.txt`).
2. Derive ordering at integration time rather than hardcoding it (alembic-git-revisions).
3. Lint the combined state, for example fail if there is more than one Alembic head.
4. Regenerate the artifact deterministically after rebase instead of merging its text.

### Cited Findings

**Empirical rates of semantic (higher-order) conflicts**
- Wiese et al. (MSR 2017): about 1 in 6 merge commits hits a textual conflict. Across the sampled projects, build failures appeared in 0.1%, 4%, and 10% of merge commits and test failures in 4%, 28%, and 3%. The sample was small. — [MSR 2017 paper](https://soft.vub.ac.be/~wmuylaer/repository/2017msr.pdf) (figures from search summary; not verified in full text)
- Shen, Gulzar, He, Meng (ACM TOSEM 2022) studied 208 Java repos and 538 conflicts and classified them as textual, build, or test. Build and test conflicts are harder, and existing tools focus mainly on textual conflicts. — [TOSEM 2022 PDF](https://people.cs.vt.edu/~gulzar/assets/pdf/tosem22_merge.pdf)
- Bucond, a static build-conflict detector, reports 57 patterns covering 97% of build conflicts in its experiments. — [NSF PAR record](https://par.nsf.gov/servlets/purl/10515782) (search-summary level)
- AI agents specifically: in the AIDev-pop dataset (33,596 agent PRs, 2,807 repos), 40.2% of repos had co-active agent PR pairs, and those pairs covered 79.4% of agent PRs. Replayed 3-way merges showed textual conflicts in 41.7% of cross-agent pairs and 19.8% of intra-agent pairs. 84.4% of conflicted files were source code rather than manifests, and about 42% of conflicts were structural (modify/delete, add/add). The paper measures textual conflicts only. — [arXiv 2607.04697, July 2026](https://arxiv.org/abs/2607.04697)

**Dependency-aware conflict analysis**
- Uber: changes conflict if they affect a shared build target, computed from Merkle-style target hashes. Disjoint-package changes are independent and verified without waiting on each other. — [Uber: Bypassing large diffs](https://eng.uber.com/blog/bypassing-large-diffs-in-submitqueue/); [the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)
- Chromium selects tryjobs by path regex per CL, a coarse version of the same idea. — [Chromium CQ docs](https://chromium.googlesource.com/chromium/src/+/main/docs/infra/cq.md)

**Ownership and locking**
- Anthropic's C compiler: agents claimed tasks by writing a lock file to `current_tasks/`. Git's push synchronization forced a second claimant to pick another task, and the agent deleted its lock after pushing. Merge conflicts were "frequent" and Claude resolved them itself. — [Anthropic Engineering](https://www.anthropic.com/engineering/building-c-compiler)
- The same project showed that when all 16 agents worked on one monolithic target (compiling the Linux kernel), they hit the same bug and overwrote each other's fixes. The fix was to partition the problem: GCC compiled a random subset of files as an oracle, so each agent could own different failing files, and delta debugging found file pairs that failed only together. — [Anthropic Engineering](https://www.anthropic.com/engineering/building-c-compiler)
- Cursor found shared-lock coordination failed. 20 agents slowed to the throughput of 1–3 because of lock contention. — [Cursor: Self-driving codebases](https://cursor.com/blog/self-driving-codebases)
- Claude Code agent teams (experimental, behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) use file locking for task claiming only. Third-party guides say two teammates editing the same file silently overwrite each other rather than conflicting, and recommend per-teammate file/directory ownership or worktrees. — [Claude Code docs: Agent teams](https://code.claude.com/docs/en/agent-teams); [DEV: what the docs don't tell you](https://dev.to/mathieu_kessler_8712ec765/claude-code-agent-teams-what-the-docs-dont-tell-you-1iae) (third-party)

**Migration conflicts: Alembic**
- Two revisions sharing a parent create a branchpoint. `alembic heads` lists each head, and `alembic branches --verbose` shows the branchpoint. `alembic merge` (or `merge heads`) creates an empty migration whose `down_revision` is a tuple of heads (the "diamond"). During an upgrade across multiple heads, `alembic_version` holds one row per head. — [Alembic docs: Working with Branches](https://alembic.sqlalchemy.org/en/latest/branches.html)
- The failure mode matches this system exactly. Each branch passes CI alone. Once both land, Alembic errors with "Multiple head revisions are present". The root cause is that a hardcoded `down_revision` is a guess about merge order. Drawbacks of the usual fixes:
  - Merge migrations leave empty-file clutter and need an extra commit.
  - Rebasing and hand-editing `down_revision` breaks again when the head moves mid-rebase. — [Mergify blog, Julien Danjou, 2026-06-02](https://mergify.com/blog/alembic-multiple-heads-git-revisions)
- Mergify's approach (vendor, Apache-2.0 lib `alembic-git-revisions`) derives `down_revision` at runtime from `git log --reverse --diff-filter=A` on the versions directory, which gives a linear chain by first-add order. A precomputed `revision_chain.json` covers git-less builds and needs a full clone. They report no multiple-heads errors since running it in production from February 2026. — [Mergify blog](https://mergify.com/blog/alembic-multiple-heads-git-revisions)

**Migration conflicts: Django**
- Django refuses to run when an app's migration graph has more than one leaf ("Conflicting migrations detected"). `makemigrations --check` fails in that state, and the official fix is `makemigrations --merge`. — [Django ticket #29720](https://code.djangoproject.com/ticket/29720); [Django ticket #35264](https://code.djangoproject.com/ticket/35264)
- `django-linear-migrations` keeps a `max_migration.txt` per app that records the latest migration. Two branches that each add a migration both edit that one file, so git raises a textual conflict at merge or rebase time. This forces linear ordering before integration instead of failing CI on main afterwards. A `rebase-migration` command fixes the conflict. Its motivation: merge migrations can leave environments applying migrations in different orders. — [Adam Johnson, 2020-12-10](https://adamj.eu/tech/2020/12/10/introducing-django-linear-migrations/)
- In rebase-based workflows, a two-parent merge migration is argued to be inconsistent. Rebasing and renumbering is suggested instead. — [django-migraid known issues](https://ahmedshehab.github.io/django-migraid/known-issues/) (third-party)
- `makemigrations --check` connects to the database, which is awkward in DB-less CI (open feature request). — [Django ticket #35963](https://code.djangoproject.com/ticket/35963)

### Inferences
- **Alembic in this system:** the multiple-heads problem is a semantic conflict that only the combined state reveals, but it is cheap to detect deterministically. Practical options, in rough order of robustness:
  1. A sentinel file like `max_migration.txt`, for example `migrations/HEAD` holding the current head revision id, updated whenever a task adds a migration. Two migration-adding tasks then textually conflict at rebase time, before any test runs.
  2. An integrator step that, on rebase, rewrites the new migration's `down_revision` to the current single head. This is mechanical and safe when the migrations touch disjoint tables. Alternatively, derive order from git as in alembic-git-revisions.
  3. A hard gate on the integrated SHA that runs `alembic heads` and requires exactly one head, plus `alembic upgrade head` on a scratch DB.
  4. Last resort: auto-generate `alembic merge heads`.
- **Hot files** (migrations directory, lockfiles, OpenAPI snapshots, route registries, barrel/index files): serialize tasks that touch them through a per-resource lane, using the same idea as Zuul's per-project queues. Or regenerate them deterministically after rebase (`npm install`/`uv lock`, snapshot regeneration) instead of text-merging. The arXiv agent-PR data shows add/add and modify/delete structural conflicts are common for agents (about 42%).
- **Ownership:** Anthropic's lock-file claims and the GCC-oracle partitioning show that agents work best when the task graph gives each agent disjoint files. Planner-assigned file and target ownership prevents conflicts upstream, which is cheaper than detecting them. Cursor's experience shows fine-grained runtime locks scale poorly.

### Gaps
- I did not find first-party docs for OpenAPI-snapshot or lockfile conflict tooling in merge queues, such as lockfile auto-regeneration bots or `git merge` drivers for lockfiles. The recommendations above are inferences, not sourced practice.
- I did not verify the exact Wiese et al. and Bucond figures against full text.
- I found no study of semantic or test conflict rates specific to AI-agent PRs. The arXiv study measures textual conflicts only.

---

## Q4. Stacked diffs and trunk-based development with feature flags as an alternative to long-lived branches

### Takeaway
Meta-style stacked diffs keep each unit small and independently landable, which reduces the size of each integration and therefore its conflict surface. Jane Street's experience points the opposite way on frequency: integrating fewer, larger, fully reviewed features cut queue load. The common thread is minimizing the product of integration frequency and conflict surface. I found little primary data on feature flags as an integration strategy in this session.

### Cited Findings
- At Meta, each diff in a stack stands alone and builds on the previous one, and "Ship It" lands the stack. — [Meta developers blog, 2022-11-15](https://developers.facebook.com/blog/post/2022/11/15/meta-developers-workflow-exploring-tools-used-to-code/)
- Meta open-sourced the Sapling SCM, plus ReviewStack for stacked review. — [Engineering at Meta: Sapling, 2022-11-15](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)
- Meta has also written about branching inside a Sapling monorepo. — [Engineering at Meta, 2025-10-16](https://engineering.fb.com/2025/10/16/developer-tools/branching-in-a-sapling-monorepo/) (title only; not read)
- Stacking means rebasing small diffs more often, and it gets complicated when main or an earlier diff changes. — [The Pragmatic Engineer: Stacked diffs](https://newsletter.pragmaticengineer.com/p/stacked-diffs?r=nw9bj)
- Landing each diff individually is not always possible if an intermediate state would break main. — [Gearflow blog](https://gearflow.com/blog/making-a-version-of-stacked-diffs-work-for-a-github-org) (third-party)
- Jane Street cut main-repo integrations from hundreds per week to about 30–40 by having features integrate once when fully reviewed, and proposed hierarchical (subsystem-level) integration for larger scale. — [Jane Street, 2014](https://blog.janestreet.com/making-never-break-the-build-scale/)

### Inferences
- For agents, a stack maps naturally to a decomposed plan. Dependent subtasks stack, as in Zuul's `Depends-On:`, so the queue tests the child on top of the parent instead of rebasing it after the parent lands.
- Hierarchical integration fits an orchestrator with sub-boards. Each feature or epic integrates its own tasks on a feature branch with cheap gates, and only the epic passes through the expensive LLM-tester gate onto main. That divides the number of slow tests by the epic size.
- Feature flags would let agents merge incomplete work dark, which shrinks long-lived divergence. Flag-guarded code still conflicts textually and semantically on shared files, though, and migrations cannot be flagged off. Schema changes still need the ordering discipline from Q3.

### Gaps
- I did not retrieve primary sources on trunk-based development with feature flags (trunkbaseddevelopment.com, Google or Facebook flag systems), or quantitative comparisons with long-lived branches.
- I found no first-party Meta data on stack landing conflict rates or land latency.

---

## Q5. How multi-agent coding systems handle integration (Gas Town Refinery, Cursor, Anthropic's parallel-Claude C compiler, Claude Code agent teams, Devin/Factory)

### Takeaway
Agent systems have independently rediscovered the same designs:
- A dedicated serial integrator or merge queue (Gas Town's Refinery: Bors-style batch-then-bisect).
- A central integrator role that later became a bottleneck and was removed in favor of tolerating a steady error rate plus a final green pass (Cursor).
- Lock-file task claims, git push races and agent-resolved conflicts, made safe by a strong test suite and CI (Anthropic).
- File and directory ownership with worktrees (Claude Code agent teams guidance).

None of the published systems re-run a slow LLM tester on every rebased SHA.

### Cited Findings

**Gas Town (Steve Yegge, released around Jan 2026)**
- The Refinery is a persistent per-rig agent that owns the merge queue and verification. Batch-then-bisect is "a core capability, not a pluggable strategy", while gates such as test and lint are pluggable. Waiting MRs are rebased as a stack onto main and tested at the stack tip. On pass, all of them fast-forward. On fail, the stack is binary-bisected. — [Gas Town architecture.md](https://raw.githubusercontent.com/gastownhall/gastown/main/docs/design/architecture.md)
- Roadmap phases:
  - Phase 1: parallel gates per MR (in progress).
  - Phase 2: batch-then-bisect.
  - Phase 3: "pre-verification", where polecats (worker agents) run tests before submitting an MR.
  - So per-change pre-testing comes in addition to, not instead of, batch tests at integration. — [Gas Town architecture.md](https://raw.githubusercontent.com/gastownhall/gastown/main/docs/design/architecture.md)
- A polecat pushes its branch, marks the MR ready (`bd update --mr-ready`), tears down its worktree, and goes idle. The Witness only watches for stuck agents. The doc does not specify how rebase conflicts are handled or whether they return to polecats. — [Gas Town architecture.md](https://raw.githubusercontent.com/gastownhall/gastown/main/docs/design/architecture.md)
- The README describes the Refinery as Bors-style bisecting. A commentator notes that 20 agents pushing to main at once is "a recipe for disaster". — [Gas Town README](https://raw.githubusercontent.com/gastownhall/gastown/main/README.md); [ascii.co.uk news, 2026-01-02](https://ascii.co.uk/news/article/news-20260102-190a5f9f/steve-yegge-releases-gas-town-multi-agent-orchestrator-for-c)

**Cursor long-running agents (Wilson Lin)**
- Jan 2026: flat peer agents and dynamic locking failed. A planner/worker/judge hierarchy worked. Workers do not coordinate with each other, and a judge decides at the end of each cycle whether to continue, with fresh resets to fight drift. Secondary coverage reports a browser of more than 1M lines built in about a week (not verified first-party). — [Cursor: Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents); [the-decoder](https://the-decoder.com/cursors-agent-swarm-suggests-cheaper-models-can-handle-most-coding-when-frontier-models-plan-the-work/)
- Feb 2026, integration specifics:
  - Workers ran in their own repo copies and handed results to their planner.
  - An integrator role for pushing, rebasing, conflict resolution, and merging from hundreds of workers was added and then removed as a bottleneck.
  - Shared locks gave 20 agents the throughput of 1–3.
  - Requiring 100% correctness per commit serialized everything, so they accepted a steady small error rate, overlapping edits ("moments of turbulence"), and a final green-branch fixup pass.
  - Peak was about 1,000 commits/hour, runs of several hundred agents per machine, and thousands overall. Disk I/O from concurrent compiles became a bottleneck. — [Cursor: Self-driving codebases, 2026-02-05](https://cursor.com/blog/self-driving-codebases)

**Anthropic: parallel Claudes build a C compiler (Nicholas Carlini, Feb 2026)**
- 16 Claude Opus 4.6 agents, each in its own Docker container, cloned a shared bare upstream repo. There was no orchestrator agent and no inter-agent messaging.
- Task claims were text files in `current_tasks/`, and git sync made a second claimant choose another task. When done, an agent pulled, merged, pushed, and deleted its lock. Merge conflicts were frequent and resolved by Claude.
- Results: about 2,000 sessions over about 2 weeks, about $20k in API cost, about 2B input and 140M output tokens, and a 100k-line Rust compiler that builds Linux 6.9 on x86/ARM/RISC-V. — [Anthropic Engineering](https://www.anthropic.com/engineering/building-c-compiler)
- Regression control came from the test harness and verifiers. Late in the project, a CI pipeline with stricter enforcement stopped new commits breaking existing code.
- A `--fast` mode ran a deterministic-per-agent random 1% or 10% test sample, varied across VMs so the fleet covered everything collectively. That is distributed test sampling in place of full re-runs. — [Anthropic Engineering](https://www.anthropic.com/engineering/building-c-compiler)

**Claude Code agent teams**
- Experimental and off by default. Task claiming uses file locking to prevent claim races. — [Claude Code docs: Agent teams](https://code.claude.com/docs/en/agent-teams)
- Community guidance: same-file edits by teammates cause silent overwrites. Assign directory ownership or use worktrees. — [DEV Community](https://dev.to/mathieu_kessler_8712ec765/claude-code-agent-teams-what-the-docs-dont-tell-you-1iae); [morphllm guide](https://www.morphllm.com/claude-code-agent-teams) (third-party)

### Inferences
- No published agent system gates on the exact rebased SHA with a slow LLM tester. The most rigorous one (Gas Town) uses deterministic gates on a batched stack and plans per-MR pre-verification before submit. That splits the expensive "is this change right" check from the cheap "does the combined tree still build and pass" check.
- Cursor and Anthropic both show that integration throughput, not agent count, is the binding constraint. A single integrator or lock becomes the bottleneck, so integration has to be pipelined (speculative or batched) and conflict-avoiding (partitioned ownership), not just serialized.
- Anthropic's distributed sampled test runs are a cheap way to keep fleet-wide coverage high without each agent running the full suite on each rebase.
- Proposed design for this system, synthesizing the above:
  1. The LLM tester validates the task at its own fork-point SHA, once.
  2. The integrator rebases, runs fast deterministic gates on the stacked or batched candidate (build, typecheck, unit tests, `alembic heads == 1`, upgrade on scratch DB), and lands without re-running the LLM tester when the intervening commits are disjoint by file or module (Uber-style independence).
  3. The LLM tester is re-run only when an overlap is detected, or as a batched post-merge sweep with bisect and auto-revert at a confidence threshold.
  4. Migration-adding tasks are serialized through a single lane, or the head-sentinel file forces textual conflicts.

### Gaps
- I found no first-party technical description of Devin (Cognition) or Factory parallel-session integration: merge strategy, conflict handling, or queueing. I did not search them separately because of the tool budget, so treat this as unknown.
- Gas Town's handling of rebase conflicts, its queue ordering and priority, and its failure reporting are not specified in the architecture doc.
- I did not verify the Cursor browser 1M-LOC claim first-party. The commit-rate and agent-count numbers come from Cursor's Feb 2026 post.
