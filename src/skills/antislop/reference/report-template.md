# Antislop audit — <scope>

- Started / finalized: <UTC>; resumed sessions: <UTC list or none>
- Mode: <Full or Diff (base..head) or Auto> / <Solo or Multi> / <Report or Issues>
- Scope and provenance: <repos, paths, commits, dirty state>
- Status: <in progress / finalized with scope limits / finalized>
- Artifacts: <report and probe directory; confirm it is git-ignored>
- Exclusions: <paths and reasons>

## Executive summary

<Top 1–3 fixes in order and why first; top 1–3 guardrails; confirmed counts by severity; key gaps.>

## Pattern census

| Pattern | Hits (product / test) | Files | Precision (sample) | Hotspots | Existing guard | Proposed guardrail and ratchet |
| --- | --- | --- | --- | --- | --- | --- |
| … | … | … | … | … | … | … |

<In Diff mode, report base vs head counts for changed files and new occurrences.>

## Coverage ledger

| Slice | Repo and paths (count if measured) | Lenses | Progress / depth | Checks and evidence | Gaps / next batch |
| --- | --- | --- | --- | --- | --- |
| S01 | … | … | Pending / In progress / Swept / Verified / Blocked | … | … |

<Distinguish scan-only from manually traced paths. Map representative flows and alternate entry points. Reconcile this ledger against intake.>

## Confirmed findings

### AS-001 — <concrete symptom> [<priority>, <reproduced or source-confirmed>, <open / needs recheck / fixed / not rechecked>]

- Diff classification (Diff mode): <Introduced / Worsened / Pre-existing>
- Slice and references: <slice IDs and repo-relative path:line locations>
- Impact and trigger: <affected user/invariant and conditions>
- Evidence: <steps and result, or traced path and relevant guards>
- Probe: <artifact path, asserting correct behavior and marked expected-to-fail; or none>
- Fix: <smallest credible correction>
- Prevention: <architecture/API, deterministic check, or why no rule is warranted>
- Acceptance: <observable regression criterion>

## Potential findings and rejected signals

<Unverified risks, missing evidence, next checks and conditional fixes. List meaningful rejected signals and why.>

## Verification log

| Session / phase / slice | Command or scenario | Result and environment | Artifacts / limitations |
| --- | --- | --- | --- |
| … | … | Passed / Failed / Not run (reason) | … |

## Grouped follow-up

| Fix package | Finding IDs | Order / dependencies | Issue ID or disposition |
| --- | --- | --- | --- |
| … | … | … | … |

## Proposed changes (Auto mode)

<Per package: findings, files expected to change, fix approach, regression test, guardrail, risks, rough size. Unverified risks listed separately. User decision and time.>

## Implementation log (Auto mode)

| Package | Files changed | Tests added | Checks and results | Status |
| --- | --- | --- | --- | --- |
| … | … | … | … | Done / Blocked (reason) / Not approved |

## Remaining coverage and resume point

<Unreviewed slices/lenses and blockers; last completed phase and exact next action for `/antislop resume`. Mark none only after reconciliation.>
