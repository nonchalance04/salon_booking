# Deferred acceptance and final review

Updated 2026-10-05. Phase 11 was authorized; the user selected local preparation with no hosting target. The user requested that manual browser acceptance and similar
outstanding checks be tracked for review and correction after implementing the
remaining phases. Items remain open until every check in their scope has evidence. See `PHASE_11_VERIFICATION.md` for completed local checks. Automated
business-critical verification continues within each implementation phase.

Use this checklist during Phase 11/final review. Record the date, environment,
observed result, sanitized evidence, and any fix/retest beside each item. Add newly
identified acceptance gaps here as later phases are implemented.

| ID | Scope | Deferred check | Evidence / instructions | Status |
| --- | --- | --- | --- | --- |
| A01 | Phase 7 | Customer reschedule/cancel, cutoff/conflict errors, retained/new/removed snapshots, Admin no-show and recovery with/without credit, narrow screens | `PHASE_7_VERIFICATION.md`, Manual browser acceptance | Partial: reschedule/cancel and both recovery paths observed; retained-price check passed. Remaining multi-service UI/conflict/device permutations open. |
| A02 | Phase 8 | Cashier initial outcomes, Admin corrections, refresh after stale review, both completion paths, immutability, role-specific UI | `PHASE_8_VERIFICATION.md`, Manual browser acceptance | Partial: settlement, no-service closure, immutable controls and Admin corrections observed. Stale-review browser scenario remains open; API regression passes. |
| A03 | Phase 8 | Itemized receipt preview/printing, one selected receipt per print, long service names, page breaks and mobile layouts; historical receipt content | `PHASE_8_VERIFICATION.md`, Manual browser acceptance | Partial: long-name/mobile wrapping fixed and verified; selected-receipt print isolation implemented. Native print preview, multiple-page and physical printing remain open. |
| A04 | Payments | Independently observed PayMongo merchant sandbox checkout, signed webhook, duplicate/failure/expiry behavior and receipt reconciliation | `PAYMONGO_SANDBOX_VALIDATION.md`; user reported Phase 6 testing complete, but merchant evidence was not independently observed here | Open evidence review; investigate payment errors if reported |
| A05 | All phases | Integrated guest/Admin/Cashier workflows, responsive/accessibility checks, keyboard/focus, errors and recovery, realistic concurrency/load | Phase 11 roadmap; previous browser smoke checks are not full acceptance | Partial: representative integrated workflows and 20-request booking/10-request settlement bursts pass. Broader device/accessibility and sustained load acceptance remain open. |
| A06 | CI | Observe the complete CI workflow running on GitHub | Local suites pass; remote run has not been observed | Open |
| A07 | Deployment | Production payment/notification providers, HTTPS/cookies/origins, workers, migration process, logs, backups and restore, operating instructions, salon sign-off | Phase 11 roadmap; Phase 9 worker and optional adapters implemented locally | Partial: local deployment scripts/runbooks, bootstrap, unit validation and 20-table restore drill pass. Host/domain, real process supervision/HTTPS, off-host backups and salon sign-off remain open. |
| A08 | Technical follow-up | Review the pg client concurrent-query deprecation warning before upgrading to pg 9 | Seen during passing database suites with current Prisma/pg adapter; no failed test or current data-integrity issue established | Reviewed: warning originates in Prisma transaction runtime/pg adapter; keep current lockfile and reassess before pg 9. |
| A09 | Phase 9 | Select/configure provider accounts, configure a Gmail App Password and Philippine SMS sender, observe real recipient delivery and failure handling, confirm message wording/timezone and reminder timing with salon | `PHASE_9_VERIFICATION.md`; Gmail/PhilSMS adapters are locally tested, live delivery disabled by default; test SENT is simulated acceptance | Open |
| A10 | Phase 10 | Admin reports/dashboard/audit, Cashier collections and denied private reports, empty/paginated periods, historical receipt details, narrow screens/keyboard; guided chat wording, current policies and booking links | `PHASE_10_VERIFICATION.md`; guided assistant currently uses no external AI provider | Partial: Admin receipts/dashboard/audit pagination, Cashier collections and guided policy response observed; automated role checks pass. Broader empty-period/device/keyboard acceptance remains open. |

New feature work and changes to frozen business rules still require their own
scope/authorization. A failed acceptance check should be corrected and rerun before
release. Do not mark an open item complete solely because its related build passes.
