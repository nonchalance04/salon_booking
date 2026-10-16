# Decisions

This document records important architectural decisions.

## 2026-10-03 — Phase 2 authentication implementation

Implements the existing authentication architecture without adding models or
changing scheduling/financial rules:

- Retain the existing eight-hour HS256 JWT lifetime. Store tokens in a host-only
  HttpOnly cookie scoped to `/api`; production uses Secure. Default SameSite is
  Lax, with explicit configuration for deployment topology.
- Require explicit HTTPS trusted origins in production. Development defaults
  allow only the two local Vite origins. Reject unsafe requests without a trusted
  Origin or, only when Origin is absent, a validated trusted Referer.
- Use bcrypt cost 12. New passwords require 12 characters and at most 72 UTF-8
  bytes; login still accepts existing shorter passwords without changing them.
- Normalize account emails to lowercase in application writes and login.
- Recheck active status and current database role on protected requests. Do not
  add refresh tokens, persistent sessions, or a token revocation model. Logout
  clears the browser cookie; password changes do not revoke issued tokens.
- Use same-origin frontend `/api` requests, with Vite proxying in development and
  a documented HTTPS reverse proxy for deployment.
- Audit Admin account changes in the same transaction, without storing password
  material. Deactivate accounts instead of deleting historical references.

## 2026-10-03 — Phase 3 configuration and reservation protection

- Use the shared transaction advisory-lock key `739021` for salon coordination.
  Salon-wide configuration writes take it exclusively; staff-specific writes take
  it shared, then lock affected Staff rows in sorted UUID order. Future reservation
  writers must use this same coordination key and ordered Staff-lock protocol.
- Recheck the acting Admin under a User row share lock inside each write transaction.
  Validate affected ACTIVE service reservations on CONFIRMED appointments and live
  PENDING_PAYMENT holds using fresh post-lock database time and the full reserved
  interval, including buffers. Reject and roll back both mutation and audit on conflict.
- Interpret weekly schedules with `SALON_TIMEZONE` (default `Asia/Manila`) and
  Temporal local-date arithmetic. Union adjacent/overlapping schedule windows.
  This supplies configuration validation; availability/assignment remains Phase 4.
- Force UTC PostgreSQL sessions in the shared application/seed pool factory.
  The installed Prisma pg adapter's timestamp conversion otherwise depends on
  session timezone. Read the fresh clock as numeric epoch milliseconds to avoid
  raw timestamptz conversion errors. Preserve existing historical data unchanged.
- Policies are create-only versions, numbered under exclusive salon coordination.
  Null effective time activates at fresh database time; explicit times must be
  prospective. Activation follows `effectiveFrom`, with no new model or flag.
- Services, staff, qualifications, hours, and schedules use active-state changes.
  Unreferenced closure/unavailability periods may be removed with their prior
  values retained in the transaction's audit record. Schedule/absence staff and
  qualification staff/service identities are immutable on edit.
- Config API updates use full replacement PUT payloads with strict validation.
  Public reads omit internal reasons, commission rates, user identities, and audits.


## 2026-10-03 — Phase 4 advisory availability

- Add a read-only POST availability search for ordered service/staff selections,
  plus a public qualified-staff catalog and `/availability` customer page. No new
  entities, migrations, holds, customer records, or appointment writes.
- For the small-salon MVP, advisory searches use shared salon coordination and
  acquire all existing Staff locks in ascending order, then reload active inputs
  and evaluate fresh database time. This favors coherent results over maximum
  read concurrency. Booking must still perform its own Phase 5 locking/revalidation.
- Validate the complete sequence before resolving assignments. Every interval is
  fixed by duration plus buffer independently of staff choice, and intervals are
  sequential/nonoverlapping. Nonempty per-service candidate sets therefore prove
  complete-plan feasibility without exponential backtracking. Rank candidates by
  existing target-date pending/confirmed workload, then staff ID ascending.
- Clip workload to the salon-local day. Completed reservations block overlaps until
  their original reserved end but are excluded from the specified workload metric.
  Pending-payment holds remain active at deadline equality, and expire logically
  after it even before cleanup.
- Interpret advance-booking days as salon-local calendar days, consistent with
  salon-local policy interpretation; lead minutes, service durations, and buffers
  use elapsed minutes. Cache converted weekly windows within each search.
- The advisory request accepts 1–20 ordered selections and one date. Enumerate
  starts at one-minute cadence and allow optional exact `startAt` checks so the
  presentation cadence does not become a new reservation rule. Disable response
  caching and clear client results after inputs change.

## 2026-10-03 — Phase 5 booking, holds, and private guest access

- Reuse the Phase 4 planning engine and a shared data loader inside the booking
  transaction. AppointmentService rows remain the reservation authority; no
  schema or migration change is required.
- Retain small-salon coordination: SHARED salon lock, all existing Staff rows in
  ascending ID order, then transaction-specific Appointment locks for expiration.
  Detect newly discovered staff and restart instead of extending a held lock set
  out of order. Limit transaction restarts to three attempts.
- Select the effective fixed-fee policy after locks using database wall-clock time.
  Recheck immediately before mutation and before completion. A policy activation
  during the transaction rolls back all snapshots/customer/audit writes and retries;
  crossed booking/hold deadlines fail without partial records. Hold expiration that
  changes deterministic assignment during a wait also causes a complete retry.
- Issue an independent 96-bit random booking reference and 256-bit guest token.
  Store only the token's SHA-256 hash. Token-authenticated retrieval uses POST JSON
  with trusted browser origins and uncached responses; a code alone grants no access.
  Private UI links use fragments, removed from the current history entry on load;
  the frontend stores credentials in component memory, not browser storage.
- Keep hold cleanup in a separate process, polling bounded batches using the
  database clock. Reload status and deadline after the shared coordination,
  ordered Staff locks, and Appointment lock. Expiration preserves historical rows
  and audits its status transition exactly once. Logical expiration remains
  independent of worker availability.
- Use the existing notification vocabulary as specified: there is no event for
  unpaid hold creation or expiration. Those transitions write audit records only.
  BOOKING_CONFIRMED/PAYMENT_RECEIVED must be enqueued atomically by Phase 6 after
  verified payment; never send a confirmation notification for a temporary hold.

## 2026-10-03 — Phase 6 appointment-fee processing

- Use the existing Payment, Receipt, AuditLog, and NotificationQueue entities.
  The PaymentProvider boundary creates attempts and authenticates captured results
  outside reservation transactions. No provider call holds a database lock.
- Default online payment to disabled. The explicit development/test adapter uses
  raw-body HMAC verification and a clearly labeled guest simulator. Both environment
  parsing and adapter construction reject test payments in production.
- Follow ARCHITECTURE Section 23's authorized Admin/Cashier manual workflow.
  Manual recording requires the original collection reference and the exact
  snapshotted fee in PHP. It records received funds rather than initiating payment.
- Serialize confirmation against expiration with shared salon coordination,
  sorted Staff locks, and Appointment/Payment locks. Refresh the database clock
  after waits and before finalization; restart if a later write crosses the hold
  deadline. Never use a provider timestamp to restore released reservations.
- Match payment identity, provider reference, appointment, amount, currency, and
  captured status. Preserve separate captures with reconciliation REQUIRED while
  only one successful payment satisfies the booking obligation. Duplicate event
  delivery produces no new receipt, audit transition, or outbox event.
- Issue manual-payment receipts atomically with the capture. Provider receipts
  are issued idempotently by an authenticated Admin/Cashier later, because the
  existing Receipt requires issuedByUserId. No fabricated system user or schema
  change is introduced. Snapshots use decimal strings and immutable issued data.
- Enqueue PAYMENT_RECEIVED for each distinct capture, and BOOKING_CONFIRMED only
  for a successful timely confirmation. Prefer the customer's email when supplied,
  otherwise SMS. Delivery is Phase 9. No guest credentials enter queue payloads.
- Provide bounded Admin reconciliation browsing and authorized receipt issuance;
  no refund execution or post-finalization financial corrections are introduced.
- GCash merchant access was reported available. The gateway was subsequently
  identified as PayMongo on 2026-10-04; see the integration decision below.

## 2026-10-04 — PayMongo GCash Hosted Checkout

- Integrate PayMongo Hosted Checkout V2 with GCash only, using server-side Basic
  authentication and exact integer centavos. No fee pass-through or business-rule
  changes. API calls use fixed official HTTPS endpoints, bounded timeouts, and
  redacted errors. Accept checkout navigation only on checkout.paymongo.com.
- Originally keep the private guest page open and launch checkout through a separate-tab link
  (superseded by the same-tab checkout decision on 2026-10-16 below).
  Return to the configured trusted frontend /appointment URL without guest tokens.
  A return redirect never confirms payment. Token-authenticated status checks can
  retrieve merchant-side capture state through the same confirmation service.
- Verify raw-body Paymongo-Signature HMAC using the configured test/live mode and
  a five-minute timestamp tolerance. Retrieve the merchant session server-to-server
  before accepting paid capture details. Store captured pay_ identity in the unique
  externalReference and session identity/creation state in existing Payment metadata.
- Do not assume undocumented provider create idempotency. Persist a creation claim
  before the network call, reuse known pending sessions, and refuse blind repeated
  creation after uncertain responses. Signed events can recover a lost response;
  Admin recovery verifies the merchant session and its internal association and is
  audited. No new model or migration is required.
- Do not assume an undocumented configurable checkout expiry field. After releasing
  expired holds, the worker retrieves and expires one provider session per cycle,
  outside DB locks. Failed/in-progress expiration is retried; late captures remain
  successful financial records requiring reconciliation.
- Enforce test PayMongo keys outside production and live keys in production. Online
  payment remains disabled by default. Merchant sandbox and live acceptance are
  external verification dependencies, not claims made by mocked adapter tests.


## 2026-10-04 — Phase 7 appointment changes and no-show recovery

- The user reported Phase 6 testing complete and explicitly authorized Phase 7,
  with payment-error analysis deferred to future follow-up. This records user
  acceptance; it does not fabricate independently observed merchant evidence.
- Reuse existing entities and the shared salon/all-Staff/Appointment lock protocol.
  Recovery also locks source Payment rows before fresh time/credit evaluation.
  Rescheduling and recovery retain the original governing policy and repeat
  time-sensitive eligibility and planning checks before committing.
- Identify retained service occurrences by AppointmentService ID, supporting
  repeated instances of the same service with different historical snapshots.
  Reuse the availability engine with per-occurrence name/duration/buffer overrides.
  Added occurrences must be active even when the same inactive service is retained.
- Temporarily mark current service rows REMOVED inside the transaction to permit
  arbitrary sequence changes under the existing partial unique index. Reactivate
  retained rows without repricing or changing their commission snapshot; permanently
  removed rows keep their previous schedule/outcome and removal time. Write lossless
  versioned before/after history with explicit fields and no guest credentials.
- No-show marking is Admin-only, once the appointment start has arrived and before
  service outcomes are recorded. Grace is calculated from the missed start. Retrying
  cancellation/no-show marking is idempotent; ordinary changes consume the existing
  reschedule allowance and recovery uniqueness is enforced under locks and by the DB.
- A successful, unrefunded, unused original appointment-fee obligation in PHP that
  satisfies the governing amount can be carried once. Reference that Payment from
  the replacement; never create a second collection. Otherwise create a normal hold.
  Recovery issues independent guest credentials and preserves the original NO_SHOW
  appointment. Recovery history belongs to the original and identifies the replacement.
- Audit and applicable notification records commit with each change. No-show marking
  has no approved notification event; recovery queues its event plus confirmation
  only when credit confirms it. Provider calls and delivery stay outside this phase.

## 2026-10-04 — Phase 8 settlement and deferred acceptance

- The user authorized Phase 8 and asked to retain manual browser acceptance and
  similar review items for correction after implementing the remaining phases.
  `ACCEPTANCE_BACKLOG.md` tracks that work; deferred checks are never reported as
  passed. This instruction does not automatically authorize Phase 9 implementation.
- Reuse existing AppointmentService, Payment, Receipt and CommissionRecord models.
  Settlement uses shared salon coordination, ordered Staff locks, then Appointment
  serialization, matching appointment-change workflows. No migrations are needed.
- Cashiers initially record outcomes; Admins correct already recorded outcomes.
  Only Cashiers finalize service payment or no-service closure. Live account/role
  validation occurs inside each transaction as well as at the HTTP boundary.
- The outcome screen uses the stored priceSnapshot as actualChargedAmount for
  PERFORMED and zero for NOT_PERFORMED. No discretionary price-editing or discount
  workflow is introduced. Historical commission rates remain unchanged.
- Require the complete active-service set and a revision of the reviewed appointment
  and outcomes. Concurrent corrections invalidate a Cashier's prior review, even
  when the resulting total is unchanged. Finalization timestamps are set only when
  payment/closure commits; completed outcomes cannot be edited.
- Manual service payments use stable idempotency keys and original collection
  references in the existing manual-provider namespace. Matching retries return the
  original result; conflicting identities and second collections are rejected.
- Allocate only successful, unrefunded PHP appointment-fee obligations, including
  explicitly carried source payments. Reconciliation captures are excluded. Decimal
  proportional allocation, deterministic remainder assignment, and ROUND_HALF_UP
  commissions commit with the full service charge, immutable itemized receipt,
  completion, audits, and notification outbox. Appointment fees are not deducted
  from the service charge or collected again.
- All-NOT_PERFORMED closure is idempotent and generates only operational completion,
  finalized outcomes, audit, and completion outbox records. No-service closure never
  creates a service payment, receipt, fee allocation, or commission.

## Phase 9 — Independent notification delivery (2026-10-04)

- Reuse NotificationQueue without schema changes. Atomically claim one due row using
  PostgreSQL `FOR UPDATE SKIP LOCKED`, the database clock, updatedAt lease time, and
  attemptCount generation. Recover expired leases; exhaust bounded attempts even
  when every attempt crashes. Conditional completion/failure rejects stale generations.
- Providers execute outside transactions and never mutate bookings or payments.
  Timeouts abort transport; bounded exponential retries persist controlled error
  codes without provider bodies or contact data. SENT means acceptance by the provider.
- Add independently selectable email/SMS boundaries, non-production test delivery,
  optional Resend email and Twilio Messaging Service SMS adapters. The user has no
  selected accounts yet; both channels default disabled and retain unattempted work.
  Credentials, domain/sender registration, and live acceptance remain deployment tasks.
- Use queue ID for Resend idempotency (provider window: 24 hours). Twilio has no
  assumed send idempotency. Crash-after-acceptance delivery remains at least once.
- Default reminder window is 24 hours, configurable from 0 (off) to 168. Queue only
  future CONFIRMED appointments; deduplicate by appointment/startAt/rescheduleCount
  under the appointment row lock, including previously SENT/FAILED reminders.
  Recheck current schedule before send; obsolete reminders end FAILED with a specific
  code because the existing enum has no suppressed/cancelled state. External delivery
  cannot be recalled if an appointment changes after that pre-send check.
- Preserve existing email-otherwise-SMS selection. Normalize Philippine local mobile
  numbers only at delivery; do not rewrite historical contacts. Plain-text templates
  distinguish pending recovery, reconciliation payments, and no-service closure.
  Never reconstruct guest tokens or include private credentials in a message.

## Phase 10 — Reports and customer assistance (2026-10-04)

- Reports read existing historical records; no accounting, chat-history, or other
  entities/migrations are added. Report services enforce current user access and use
  repeatable-read transactions for internally consistent summaries and pagination.
- Admin receives appointment, payment-attempt, receipt, commission, audit and dashboard
  reads. Cashier receives aggregate collection summaries only; no commission, audit,
  or general report access. Audit output recursively omits credential fields and
  provider metadata. Private guest-token hashes never enter appointment reports.
- Date filters are inclusive salon-local calendar dates, converted to half-open UTC
  intervals, at most 366 days. Each report labels its date basis: scheduled start,
  payment-attempt creation, receipt issuance, commission finalization, or audit creation.
- Collections aggregate Payment once, without joining carried credits or one-to-many
  relations. Captures include SUCCEEDED and REFUNDED rows by paidAt; refunds use
  refundedAt. Net cash movement is captures less period refunds, not profit/revenue.
  Successful applied/unapplied and reconciliation-required amounts describe current
  status of captures in the period; reconciliation is a subset, never added again.
  Amounts remain Decimal until formatted, grouped by currency. Current payment status
  is not an as-of historical ledger. No refund workflow is introduced.
- Customer assistance initially uses a deterministic guided conversation, current
  public configuration services and fixed policy explanations. It routes customers
  to authoritative availability and guest-management screens, makes no mutations,
  and stores no chat history. The UI identifies this as a guided assistant. An external
  AI provider remains an optional choice discussed with the user, not configured or
  required for this implementation. No provider costs or credentials are introduced.

## 2026-10-05 — Phase 11 local release preparation

- User authorized Phase 11 and selected local preparation because no hosting target
  is selected. Live deployment and provider/salon acceptance remain pending.
- Provide an adaptable single-server Linux baseline: Caddy serves built frontend
  assets and same-origin API; systemd supervises the API and two existing workers.
  This adds no distributed infrastructure or new persistence models.
- First production Admin is created through a local operator command on an empty
  User table, using existing account validation, bcrypt and transactional SYSTEM
  audit. Production development seeding remains forbidden.
- Readiness and liveness are separate; readiness safely checks DB/User-table access.
  Default API binding is loopback, configurable through validated HOST.
- Backup restoration targets an explicitly named empty database, verifies the archive
  checksum, preserves transactions and refuses destructive replacement. Recovery
  requires payment/message reconciliation before re-enabling providers.
- Acceptance fixes receipt wrapping/print isolation and same-tab private-link
  navigation. Scheduling, payment and historical-data rules are unchanged.

## 2026-10-08 — Replace Twilio SMS with PhilSMS

- User selected PhilSMS. Replace the SMS adapter with provider `philsms`, token
  `PHILSMS_API_TOKEN` and approved `PHILSMS_SENDER_ID`. Disabled remains the default.
- Use bearer authentication and JSON at https://app.philsms.com/api/v3/sms/send
  following https://app.philsms.com/developers/documentation. Confirm account
  compatibility before activation; the newer dashboard API was not publicly
  available for verification.
- Accept Philippine mobile destinations, normalize local 09/international +639,
  and select Unicode mode for non-ASCII text.
- Preserve queue history, routing, templates, reminders and retries. No migration
  or dependency added. Require a success envelope; declared provider errors are
  terminal and sanitized. Transient HTTP/malformed responses use bounded retries.
- SENT means acceptance, not handset delivery. No idempotency guarantee assumed.
  Earlier Phase 9/11 reports describe historical Twilio verification. PhilSMS
  live acceptance awaits credentials, sender approval and handset testing.

## 2026-10-08 — Correct PhilSMS portal for the configured account

- User confirmed their token belongs to dashboard.philsms.com. Read-only balance
  and SMS history returned success on its v3 API, while the older app.philsms.com
  returned Unauthenticated for the same token. The dashboard SMS route advertises
  POST support through OPTIONS.
- Change the adapter endpoint to https://dashboard.philsms.com/api/v3/sms/send.
  Keep bearer authentication, payload, routing, retry rules and queue history.
  No live SMS was sent during diagnosis; existing FAILED rows are not reset.

## Automatic cashier payment references — 2026-10-09

- At the user's request, cashier appointment-fee and service-payment forms no
  longer require a typed collection or transaction reference for any method.
- The server derives `SALON-FEE-<idempotency UUID>` or
  `SALON-SERVICE-<idempotency UUID>` when the request omits a reference. Separate
  namespaces prevent fee/service collisions; retries retain the same reference,
  payment, and receipt. Existing identity and amount conflict checks still apply.
- These identifiers are salon collection references. Online provider transaction
  identities continue to come from the provider integration. Staff still verify
  that money was received before recording a manual payment.
- Store the generated reference in the existing manual-provider reference field
  and immutable receipt snapshot. Historical values are preserved, and the API
  still accepts validated explicit references for compatibility with older clients.
  This supersedes the earlier requirement to type an original collection reference.

## 2026-10-10 — TextBee appointment OTP access

TextBee is an optional SMS transport for appointment access and existing SMS notifications. OTPs authorize only the matched appointment; they do not establish payment success. The backend stores keyed OTP digests, enforces database-backed rate limits and single-use consumption, and grants a two-hour opaque HttpOnly session. Original guest links continue working without rotation. Unknown details and send failures have a neutral response. The gateway's queue acceptance is not delivery. See `TEXTBEE_SETUP.md` for activation and operating limits.

## 2026-10-10 — Reduce SMS usage

Default notification SMS policy is minimal. Worker coalesces the normal customer outcome into the confirmation SMS, using current confirmed appointment state and verified fee payment. Redundant outbox jobs are retained as SKIPPED rather than deleted or sent. Public access links use deterministic purpose-separated HMAC tokens, stored only as appointment-scoped hashes; the frontend removes the fragment before API use. Combined messages are bounded to one 160-character ASCII segment. Minimal SMS errors/reclaimed claims require investigation rather than automatic resend. Customer-reachable PUBLIC_SITE_URL must be explicitly configured.

## 2026-10-10 — Gemini consultation and Markdown guidance

- User authorized Gemini chatbot implementation using their supplied
  `salon_chatbot_guidelines.md`. Preserve it verbatim in `backend/knowledge` and
  read it for each AI answer; the production build packages the same document.
- Use native-fetch Gemini Generate Content with validated structured output,
  configurable model/key, a bounded request deadline, and guided fallback. No
  extra SDK or database migration is required.
- Carry bounded conversation context in the request and browser memory only.
  Recommend active, positive-price services by validated ID, and resolve cards
  from the current database after generation. Booking links are generated by the
  application. Model output has no domain mutation tools.
- Appointment retrieval uses the existing secure management screen; the guideline
  example asking for an appointment reference inside chat does not apply.
- Default to guided mode until credentials and a model ID are configured. Provider
  fixtures verify follow-ups, card rendering, booking links, fallback, and reset;
  live Gemini quality/access acceptance remains pending credentials.


## 2026-10-11 — Replace Resend email with Gmail SMTP

At the user's request, Gmail SMTP replaces Resend as the live email provider.
`NOTIFICATION_EMAIL_PROVIDER=gmail` requires `GMAIL_USER`, a 16-letter
`GMAIL_APP_PASSWORD`, and matching `NOTIFICATION_EMAIL_FROM`. Resend configuration
is no longer accepted. Disabled/test modes remain available.

Nodemailer composes MIME text and manages verified TLS SMTP connections to
`smtp.gmail.com:465`. Each attempt owns its connection so the worker deadline can
close it. SMTP/authentication errors are mapped to controlled codes; raw responses
and credentials are never persisted. 4xx failures retry; 5xx failures stop.

Booking events, routing and outbox retries retain their existing rules. Stable
Message-ID is for investigation, not provider idempotency. Unlike the superseded
Resend implementation, Gmail cannot promise deduplication after acceptance followed
by a timeout/crash. Live inbox acceptance requires salon credentials and a controlled
booking; automated tests do not send real email. See EMAIL_SMS_SETUP.md.


## 2026-10-11 — Appointment verification channel choice

At the user's request, Your Appointment supports email through Gmail in addition
to TextBee SMS. Customers select a configured channel and enter the corresponding
contact recorded on the booking. Availability is global, not booking-specific,
and unknown/mismatched contacts receive neutral responses.

`APPOINTMENT_EMAIL_OTP_PROVIDER=gmail` independently enables email OTP using the
Gmail credentials and existing `APPOINTMENT_OTP_SECRET`. API sends are direct.
Existing five-minute expiry, five guesses, IP/contact limits and two-hour HttpOnly
sessions remain. Identity cooldown and invalidation now use booking identity across
channels, preventing method switching from bypassing limits or leaving multiple
valid codes. No database migration is required. Legacy phone-only request bodies
continue to select SMS.


## 2026-10-11 — One email for paid booking confirmation and reminder

At the user's request, successful appointment-fee payment sends one combined
email containing payment acknowledgement, confirmation, appointment date/time,
booking reference and arrival reminder. Separate email reminders are no longer
enqueued; previously queued email reminders are marked SKIPPED at delivery.
The payment transaction retains its SKIPPED payment record. Legacy pending payment
emails are suppressed only when the same appointment, recipient and payment ID
have a confirmation record and no reconciliation is required. Standalone/review
payments and cancellation/reschedule/completion notices retain their meaning.
Full-policy SMS reminders remain supported. No history is deleted or re-sent.

## 2026-10-13 — Staff-recorded customer check-in (step 2)

Record arrival independently of service completion using Appointment.checkedInAt and checkedInByUserId. Only active Cashier/Admin accounts can confirm physical arrival on the scheduled salon date. Use the existing appointment/staff locking protocol, server timestamps, strict request validation and one transactional audit record; duplicate check-ins preserve the first actor/time. Protect checked-in visits from no-show marking and customer schedule changes. Automatic marking stays disabled until step 3; no correction action or waiting queue is introduced in this step.

## 2026-10-13 — Automatic no-show after arrival grace (step 3)

Re-enable the hold worker's automatic NO_SHOW processing at scheduled start plus 15 minutes. Exclude checked-in visits, completion records and recorded active service outcomes before batch selection and revalidate under the existing staff/appointment locking protocol with fresh database time. Keep original policy recovery deadlines and write a SYSTEM audit atomically. Competing check-in and marking use the same appointment locks; a late check-in cannot restore a released reservation. The correction workflow and dedicated waiting queue remain steps 4 and 5.

## 2026-10-13 — Audited no-show correction (step 4)

Introduce an Admin-only exception to the terminal NO_SHOW rule for an unresolved same-day visit that has not ended. Require a reason and explicit physical presence. Recheck original service intervals and buffers against current staff qualifications, operating/schedule coverage, closures, time off and blocking reservations under the existing locks. Reject any linked replacement to protect recovery history and carried fees. Restore CONFIRMED and check in atomically with BOOKING_NO_SHOW_CORRECTED, preserving previous no-show timestamps in the audit. No schedule extension or financial changes. Historical/ended visits require a new booking rather than reactivation; a dedicated waiting queue remains step 5.

## 2026-10-13 — Checked-in waiting queue (step 5)

Add an authenticated read-only queue for Cashier/Admin using existing arrival and service-outcome fields, without adding a new service-start lifecycle. Include checked-in confirmed unresolved appointments across all dates, oldest arrival first, with bounded search/pagination and scheduled-end review flags. Use server time for elapsed arrival duration; do not infer a service start from arrival or fabricate service outcomes. Refresh on a 30-second visible-screen cadence, focus, manual requests and local arrival events. Reuse the service workspace to review/resolve visits. No database migration or automatic queue mutations are needed.

## 2026-10-13 — Staff skills management

Add an editable Service category and a per-staff grouped checkbox editor. Keep StaffService as the sole qualification authority, including commission rates. Save the complete selected service set in one transaction under existing salon/staff locks; deactivate omitted qualifications, reuse existing records when re-enabled, audit changed records, and reject the entire save if it would invalidate blocking reservations. Categories do not automatically qualify staff for other services in the same category.

## 2026-10-14 — Independent menu booking categories

Use Hair Services, Hair Color & Styling, Hair Treatments, Nail Services, and Spa & Relaxation as independent booking categories. Customers may combine one service from each category in a single appointment. Preserve one-service-per-category validation for direct booking, availability, rescheduling, and recovery requests. Split legacy Hair/Nails classifications using approved menu descriptions, preserve custom classifications and historical appointment snapshots, and seed the same categories for new databases. Staff qualifications remain specific to individual service IDs.


## 2026-10-13 — Personalized confirmation SMS

Use the customer-requested greeting and full confirmation wording, including the customer name, full appointment date, start–end time range in the salon timezone, and booking code as the reference number. This supersedes the earlier one-segment ASCII limit: submit the complete message in one provider request and allow provider SMS segmentation. Every SMS policy checks current confirmed appointment state and verified fee payment before sending the fee-received claim. Existing suppression, duplicate prevention, OTP and retry policies remain in place.


## 2026-10-14 — Cashier payment-only workspace

At the user's request, restrict the cashier UI and backend mutation permissions to payment processing and receipts. Replace the cashier dashboard/navigation with a payment-ready visit list, booking-code payment/receipt lookup, and service collection. Move initial outcome recording, outcome corrections, customer arrival recording, and no-service closure to Admin; enforce roles in services as well as HTTP routes. Preserve current payment collection, Decimal amounts, idempotency, historical receipts, and commission calculations. Cashiers may read payment-related booking details and existing collection APIs; hiding reports does not remove read access. No database migration is required.


## 2026-10-16 — Cashier customer check-in

At the user’s request, extend customer arrival recording to active Cashiers as well as Admins, superseding the arrival restriction in the 2026-10-14 payment-only workspace decision. Add a separate cashier list for today’s confirmed visits awaiting service, using server time and the salon timezone with search and pagination. Keep payment-ready filtering separate. Reuse the existing transactional check-in, account and appointment locks, first-arrival preservation, and actor-specific audit. Service outcomes, no-service closure, and no-show corrections remain Admin-only. No database migration is required.

Cashiers can acknowledge customers at the front desk without waiting for an Admin. Recording physical arrival protects present customers from automatic no-show marking and makes them visible in the checked-in waiting queue for staff follow-up. Arrival does not record treatment, completion, or payment.


## 2026-10-16 — Display only operational payment capabilities

Remove unsupported payment-return terminology and metrics from the dashboard, collection tables, payment help, cancellation copy and guided chatbot responses. Keep collected-fee wording explicit: cancellation releases the reservation and leaves the collected fee unchanged. Retain existing database enum values, historical fields, provider validation and financial calculations for compatibility and data integrity. Historical returned-payment states use a readable display label; no transaction state is rewritten and no money movement feature is introduced.

## 2026-10-16 — Restore bookings after hosted checkout

At the user's request, show a booking confirmation layout after returning from PayMongo. Successful checkout creation establishes a two-hour appointment-scoped HttpOnly session using the existing guest-session model and validated private-token/session access. Only hashes are persisted; credentials never enter provider URLs or browser storage. The trusted `/appointment` return URL restores this session even when OTP delivery is disabled. Existing merchant verification and appointment status remain authoritative: returning from checkout does not confirm payment. Confirmed bookings show actual customer, service, staff, salon-local schedule and payment details, with separate service charges and appointment-fee amounts. Receipt download uses the existing issued receipt and browser Save as PDF; provider receipts still require authorized staff issuance. No schema or financial-rule changes.

## 2026-10-16 — Open hosted checkout in the current tab

At the user's request, Continue to GCash on PayMongo navigates the current tab. The existing HttpOnly appointment session restores access when PayMongo returns to `/appointment`. The checkout link retains a no-referrer policy; payment verification and confirmation rules are unchanged.

## 2026-10-16 — Dedicated booking confirmation return URL

At the user's request, PayMongo returns to `/booking-confirmed` on the trusted frontend origin. This route restores the existing appointment session and displays the confirmation layout only for a confirmed booking; pending or unsuccessful payments retain their actual state. The legacy `/appointment` return path remains accepted for existing configurations and checkout sessions.

## 2026-10-16 — Automatically issue customer PayMongo e-receipts

The user explicitly selected automatic issuance after verified PayMongo payment. This supersedes the staff-only provider receipt rule above. Receipt.issuedByUserId is nullable for system issuance, preserving staff-issued history. The existing payment transaction issues one immutable fee receipt and SYSTEM audit; paymentId uniqueness and payment locks make callbacks and customer recovery idempotent. The authorized customer-receipt endpoint can issue a missing receipt for legacy successful PayMongo payments only. Fee snapshots include salon contact, salon timezone, booked schedule and historical staff/service names, while stating that service charges are separate. The customer preview and print/PDF layout follows the website's gold, cream and charcoal styling. No fabricated staff identity or payment is created.


## 2026-10-16 — Cashier outcome management and no-show correction

At the user’s request, active Cashiers may record and correct service outcomes before finalization and restore eligible no-shows through the existing late-arrival correction workflow. This supersedes earlier Admin-only restrictions for those two operations. Enforce account activity in services and preserve revision checks, transaction locks, original-interval availability checks, physical-presence confirmation, reasons, and audit attribution to the actual actor role. Show confirmed visits with pending outcomes in the cashier desk and expose no-show correction through booking-code lookup. No-service closure, commission details, no-show marking and other Admin permissions remain unchanged. No database migration is required.
