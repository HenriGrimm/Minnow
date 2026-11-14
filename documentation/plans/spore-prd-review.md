# Spore PRD Review

**Date:** November 13, 2026  
**Reviewed version:** 1.0  
**Corrected version:** [Spore PRD 1.1](spore-prd.md)  
**Execution document:** [Spore implementation plan](spore-implementation-plan.md)

The original PRD described the intended breadth, but several promises lacked an implementable contract or conflicted under failure. Version 1.1 resolves the product-contract gaps below and adds explicit validation. The complete launch still includes all required personal and business app capabilities. No finding is resolved by moving a required feature to a later release.

The review covers the PRD end to end, the shared runner boundary, current Reef extraction notes, existing updater/recovery descriptions, and the limitations of existing native-execution evidence. Minnow source was inspected at HEAD `920890e58bd0007022f6212f4c2f9d406753aa77`, with unrelated working changes present. This review changes planning documents only. It is not a security audit of an implemented Spore service, a platform certification, or evidence that the launch requirements already pass.

## Findings and corrections

Severity describes the consequence of implementing the original ambiguity. All listed findings require work before launch. "Corrected" below means the specification has a defined resolution; implementation proof remains outstanding in the referenced tasks.

| ID | Severity | Gap or contradiction in version 1.0 | Correction in version 1.1 | Implementation and proof |
| --- | --- | --- | --- | --- |
| RF-01 | High | The opening exempted decisions awaiting resolution from launch requirements, creating an escape from the all-at-launch commitment | Decisions are blockers, not exemptions; launch requires the complete requirement set | SP-002, SP-063, SP-064 |
| RF-02 | Critical | Thirty days of daily backups did not establish a 15-minute recovery-point objective, particularly for database/object consistency | DATA-09 requires a journal/incremental mechanism and a consistent recoverable set | SP-005, SP-037, SP-038; AT-27 |
| RF-03 | Critical | Restore could resurrect deleted data, replay offline writes, or resend emails/payments | DATA-13 introduces recovery epochs, fencing, outbox reconciliation, and quarantine of stale work | SP-026, SP-035, SP-038; AT-27 |
| RF-04 | High | Unlimited offline absence had no tombstone, schema, or sync-history retention boundary | DATA-14 defines a sync window and safe resnapshot path that preserves pending edits | SP-035, SP-036, SP-038; AT-28 |
| RF-05 | Critical | Full per-app packaging and free shared-runtime fixes lacked a design that preserved OS signatures and avoided paid rebuilds | PKG-09 separates the signed host from signed app bundles; REL-13 defines compatibility/support policy | SP-004, SP-043, SP-045, SP-061; AT-29 |
| RF-06 | High | Unlimited local apps and capped cloud source storage could leave an installed app impossible to maintain after archival | APP-11 requires a private source capsule, last-copy protection, and authorized rehydration | SP-012, SP-040; AT-26 |
| RF-07 | High | Preview activity consumed the same production hosting pool, allowing a build to exhaust a live app's quota | Section 12 isolates preview spending under build/test authorization | SP-022, SP-034, SP-049; AT-31 |
| RF-08 | Critical | Hard spending promises had no contract for parallel reservations and delayed vendor measurements | BILL-09 requires transactional reservations, bounded exposure, reconciliation, and platform ownership of unauthorized excess | SP-010, SP-048, SP-049; AT-38 |
| RF-09 | High | Continuous availability was not reconciled with exclusive migrations or one failed platform package | Principle 2 and REL-14 distinguish building from activation, bound maintenance, and prevent silent partial publication | SP-036, SP-041, SP-045, SP-046; AT-37 |
| RF-10 | Critical | A generated backend with unrestricted database credentials could bypass every UI/chat access rule | AUTH-08 requires a trusted policy/data broker, including field, aggregate, join, file, and job access | SP-014, SP-024, SP-025, SP-058; AT-32 |
| RF-11 | High | "Optional advanced local execution" was neither excluded nor assigned a launch contract; managed setup and sandbox failure were unspecified | BUILD-09 makes local execution optional to the user but launch-required, with managed tooling and consented fallback | SP-003, SP-019, SP-061; AT-36 |
| RF-12 | High | Private previews, installer sharing, custom domains, and download grants lacked explicit origin/ownership boundaries | APP-12, HOST-11, and PKG-10 define invitations, expiring grants, origin separation, device linking, and domain reassignment | SP-016, SP-022, SP-033, SP-040; AT-34/35 |
| RF-13 | High | A common chat surface could combine operational data with private developer history or pretend to accept work while offline | CHAT-09 separates contexts and adds honest unavailable/draft behavior | SP-052, SP-054; AT-12/33 |
| RF-14 | High | "Retries do not duplicate external actions" was unachievable for providers lacking idempotency or reconciliation | AUTH-09 introduces uncertain outcomes, safe retry contracts, and explicit schedule semantics | SP-026, SP-027, SP-028, SP-029, SP-030, SP-031, SP-032; AT-30 |
| RF-15 | High | OAuth, identity linking, revocation timing, and email abuse were broad labels without executable boundaries | AUTH-10 adds identity-linking safeguards, bounded revocation, verified senders, bounce/complaint processing, and inference abuse limits | SP-015, SP-027, SP-031, SP-034; AT-16/33 |
| RF-16 | High | Voluntary cancellation and failed-payment grace were conflated; in-flight work at expiry was undefined | BILL-05 gives separate state transitions and a bounded cutoff policy | SP-048, SP-050; AT-18/40 |
| RF-17 | High | The paying business, app owner, end user, included hosting slot, archive action, and transfer authority were insufficiently separated | APP-12 and BILL-10 define distinct lifecycles and billing responsibility | SP-013, SP-040, SP-047, SP-050; AT-34 |
| RF-18 | High | Serving independently of the control plane conflicted with immediate revocation and live entitlement checks | ARCH-10 defines bounded policy caches and explicit fail-closed behavior; AUTH-10 defines a measurable healthy-connectivity bound | SP-014, SP-034, SP-059; AT-33 |
| RF-19 | Critical | A historical Node runtime could not be assumed portable to an isolated desktop runtime and Worker backend | ARCH-09 requires one application/data contract and parity tests; SEC-13 remains a platform proof obligation | SP-003, SP-007, SP-024, SP-044; AT-32/36 |
| RF-20 | Medium | Model fallback, voice processing, and generated assets could change privacy or cost behavior without corresponding authority | BUILD-13 binds auxiliary inference and fallback to consent, rate versions, and regression evidence | SP-010, SP-052, SP-053, SP-060; AT-39 |
| RF-21 | High | The web builder and PWA were promised but had no install handoff, browser-storage, or service-worker activation requirements | UX-09 and REL-13 define device handoff and cache/version behavior | SP-016, SP-046, SP-051, SP-062; AT-35 |
| RF-22 | High | A 90% generation success threshold could be read as permission to leave 10% of launch requirements failing | Section 18.1 separates probabilistic generation performance from mandatory end-to-end and platform gates | SP-060, SP-061, SP-062, SP-063; all AT scenarios |
| RF-23 | High | Product/pricing/download pages, legal/vendor review, account email, and production cutover were implied rather than assigned | OPS-09/10 define customer acquisition, evidence binding, go/no-go, and operational ownership | SP-056, SP-057, SP-059, SP-063, SP-064; AT-40 |
| RF-24 | High | Protocol support, runtime security support, technical log retention, and source retention had no funded/time-bounded policy | REL-13, DATA-15, and D-11 define proposed windows, compatibility, and pre-launch decisions | SP-002, SP-006, SP-037, SP-040, SP-045, SP-057; AT-26/28/29 |

## Remaining empirical and business decisions

The following are not resolved by writing requirements. They are explicit stop conditions for dependent work in the implementation plan:

1. **Runtime and sandbox feasibility.** Demonstrate the same meaningful app against local and hosted adapters, plus containment of generated code and build tools on each promised OS. Existing Minnow/native-provider probes are not certification of a bundled Spore sandbox.
2. **Signed host and bundle delivery.** Demonstrate two separately branded apps, host-only patching, signed bundle updates, signature preservation, and failure recovery on every target. A failed proof requires an architecture revision preserving the product promises, not an undocumented fallback.
3. **Consistent recovery.** Demonstrate the selected backend can restore database, files, policy/revocation state, sync cursor, and effect receipts within the stated recovery objectives. Provider feature names are not evidence.
4. **Commercial and operational viability.** Validate model/build/hosting/support costs, rate cards, supported-platform maintenance, and the contribution-margin target. The USD 20 and quota defaults remain hypotheses until this is done.
5. **Provider and distribution readiness.** Complete production identity/connector approvals, signing eligibility, service contracts, region/retention choices, and dependency/license review. A vendor rejecting a required integration requires a compatible alternative or an explicit product-owner scope decision; it cannot be quietly removed.

## Scope and delivery discipline

The revised PRD keeps native mobile store distribution and app resale outside the defined product boundary. Desktop delivery, responsive web/PWA, local execution, hosted backends, business permissions, synchronization, integrations, commerce, and support remain part of the single launch. No issue is waived because a feature is difficult or because a prototype can be demonstrated without it.

All 147 numbered requirements map to implementation tasks in the [coverage matrix](spore-requirement-coverage.csv). Non-numbered platform, performance, economic, retention, decision, and launch-gate obligations are also assigned in the implementation plan. Mapping proves planning coverage, not implemented behavior; task and gate status remains unstarted until evidence is produced.
