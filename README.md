# Salon Booking and Appointment System

Repository for the Salon Booking and Appointment System.

For a complete walkthrough, see the [step-by-step setup and testing guide](docs/SETUP_AND_TESTING.md),
including database creation, local configuration, automated checks, and guest/Admin/Cashier acceptance tests.

For notification providers, follow the [email and SMS setup guide](docs/EMAIL_SMS_SETUP.md)
for Gmail email, PhilSMS SMS, worker startup, reminders, and delivery verification.

The backend foundation uses Node.js, TypeScript, Express, PostgreSQL, Prisma, and
Zod. Admin/Cashier authentication and Admin account management are implemented.
The React/TypeScript/Vite frontend provides login, session restoration, role-aware
workspaces, account management, Admin salon configuration, and public availability
selection, booking submission, temporary holds, secure guest access, appointment-fee
payments, confirmation, receipts, Admin reconciliation, and Phase 7 appointment
changes/no-show recovery. The user reported Phase 6 testing complete and authorized
Phase 7; future payment diagnostics remain separately scoped. Phase 8 service
outcomes, settlement, receipts, and commissions are implemented. Phase 9 adds an
independent notification worker, reminders, and optional Gmail/PhilSMS adapters.
Phase 10 adds authorized reports, dashboards, audit viewing, Cashier collection
summaries and a guided salon assistant.

See [the roadmap](docs/ROADMAP.md) for phases and
[Phase 10 verification](docs/PHASE_10_VERIFICATION.md) and the
[acceptance backlog](docs/ACCEPTANCE_BACKLOG.md) for current evidence and deferred checks.

## Local backend setup

Requirements: Node.js 24 (`.nvmrc`), npm, and PostgreSQL. Database tests have been
verified with PostgreSQL 18. Use a dedicated development database.

```bash
nvm use
cd backend
npm ci
cp .env.example .env
```

Edit `backend/.env`: provide your development `DATABASE_URL`, a random `JWT_SECRET`
of at least 32 characters, and your own development Admin/Cashier seed credentials.
Do not overwrite an existing `.env` when repeating setup. Generate a secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Run from `backend/`:

```bash
npm run db:validate
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

`db:migrate` applies checked-in migrations; it does not reset the database. All
Prisma commands explicitly use `prisma7.config.ts`. Seeding is for development
only, rejects production mode, and refuses to rewrite configuration once an
appointment exists. Re-seeding refreshes fixture credentials/configuration.

`GET http://localhost:3000/api/health` reports application liveness, not database
readiness. `PORT` can override the default port.

## Build and validation

Run from `backend/`:

```bash
npm run check
npm start
```

`check` validates/generates Prisma, type-checks application/seed/test code, runs
API/configuration tests, and compiles the backend. `start` runs the compiled
`dist/src/server.js`; build before starting. Environment validation is required
at startup. Generated code, compiled output, and secrets are ignored by Git.

## PostgreSQL integration tests

Use a dedicated local/CI PostgreSQL server and a role with `CREATEDB` permission.
Set `TEST_DATABASE_ADMIN_URL` explicitly in your shell; tests do not load `.env`
or fall back to `DATABASE_URL`.

```bash
export TEST_DATABASE_ADMIN_URL='postgresql://USER:PASSWORD@localhost:5432/postgres'
npm run db:generate
npm run test:db
```

The suite creates a uniquely named `salon_test_*` database, applies migrations,
seeds development fixtures, tests constraints/transactions, and drops only its
own database afterward. Do not point it at a production server. An interrupted
test process can leave its disposable database behind for manual cleanup.

GitHub Actions runs backend checks and database tests against a disposable
PostgreSQL service, plus the frontend production build. No production credentials are needed.

## Frontend and authentication

The public frontend now uses the customer design from `frontend2/`, integrated
with the existing booking and payment APIs. Open `/` for the customer homepage
and `/staff` for the Admin/Cashier sign-in and workspace. The runnable application
remains `frontend/`; see [design integration](docs/FRONTEND_DESIGN_INTEGRATION.md)
for routes, adaptations and verification.

With the backend running on port 3000, open another terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/staff` and use the Admin/Cashier credentials you supplied
when seeding. The Vite server proxies `/api` to `http://127.0.0.1:3000` without
rewriting the browser Origin. Run `npm run build` in `frontend/` for production
assets. For production, serve the frontend over HTTPS and reverse-proxy `/api`
to the backend on the same site.

Backend `TRUSTED_ORIGINS` contains exact comma-separated browser origins, with no
paths or trailing slashes. Its development default is
`http://localhost:5173,http://127.0.0.1:5173`. Production requires explicit HTTPS
origins and `NODE_ENV=production`; cookies then use `Secure`. `COOKIE_SAME_SITE`
defaults to `lax`; `none` requires production HTTPS. The frontend currently uses
same-origin `/api` requests. A separate frontend/API host deployment would also
need a frontend API-base configuration and an appropriate cookie topology.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `POST /api/auth/login` | Trusted browser origin | Email/password login; sets an 8-hour HttpOnly cookie |
| `POST /api/auth/logout` | Trusted browser origin | Clears the session cookie; safe when already signed out |
| `GET /api/auth/me` | Active authenticated account | Returns current profile and database role |
| `GET /api/users` | Admin | Lists safe account fields |
| `POST /api/users` | Admin + trusted origin | Creates an Admin/Cashier account |
| `PATCH /api/users/:id` | Admin + trusted origin | Edits account fields, password, role, or active status |

Account creation requires `email`, `password`, `firstName`, `lastName`, and `role`;
`isActive` defaults to true. Updates accept a nonempty subset of those fields.
Passwords for new accounts and password changes require at least 12 characters
and at most 72 UTF-8 bytes to avoid bcrypt truncation. Emails are normalized to
lowercase. No delete route or public registration is provided.

State-changing requests require an exact trusted `Origin`, or a trusted `Referer`
when Origin is absent. This includes login and logout. Protected requests verify
the JWT and load the database account, so role changes and deactivation affect
existing tokens. Account mutations and redacted audit records commit atomically.
Passwords and hashes never appear in API responses or audit payloads.

Logout clears the browser cookie. This bounded stateless JWT design does not
revoke copies of an already issued token or invalidate them upon password change;
deactivation blocks access immediately. No refresh-token/session-store feature was added.

## Salon configuration (Phase 3)

Sign in as Admin and open **Salon management**. Use its tabs to manage the salon
profile, service prices/durations/buffers, staff, qualifications and commission
rates, opening hours, recurring staff schedules, closures, time off, and booking
policies. **Accounts** retains the Phase 2 login-account controls. Staff records
are separate from login accounts.

Set backend `SALON_TIMEZONE` to the salon's IANA timezone (default `Asia/Manila`).
The UI labels and interprets all calendar fields in this timezone, independently
of the browser's timezone. Schedule effective dates are inclusive. A blank service
buffer inherits the booking policy; zero explicitly means no buffer.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/salon` | Public | Public profile, active hours, future/ongoing closure intervals |
| `GET /api/services` | Public | Active service catalog; does not promise available times |
| `GET /api/configuration` | Admin | Coherent configuration snapshot and salon timezone |
| `PUT /api/configuration/profile` | Admin + trusted origin | Save singleton salon profile |
| `POST /api/configuration/{section}` | Admin + trusted origin | Create configuration record |
| `PUT /api/configuration/{section}/:id` | Admin + trusted origin | Replace editable configuration fields |
| `POST /api/configuration/policies` | Admin + trusted origin | Publish a new immutable policy version |
| `DELETE /api/configuration/{closures,unavailability}/:id` | Admin + trusted origin | Remove an unreferenced period with an audit record |

Editable sections are `services`, `staff`, `qualifications`, `hours`, `schedules`,
`closures`, and `unavailability`. POST/PUT bodies must supply all schema fields;
nullable fields use explicit `null`. Unknown fields are rejected. See
`backend/src/modules/configuration/configuration.schema.ts` for exact field names.
Money is a decimal string (for example `"150.00"`); API commission rates are strings
from `"0"` to `"1"` with up to four decimals. The UI uses percentages. Weekly times
use `HH:mm[:ss]`, effective dates use `YYYY-MM-DD`, and timestamps require an
explicit UTC offset. Policy `effectiveFrom: null` means the fresh database time;
explicit activation times must be in the future. Existing versions cannot be edited.

Configuration writes and audit records commit atomically. Changes that invalidate
protected reservations return HTTP 409 `RESERVATION_CONFLICT`, with affected
booking codes and intervals in `error.details.appointments`. The UI displays them.
Referenced entities use deactivation; past booking snapshots remain unchanged.

Application and seed database sessions explicitly use UTC for correct Prisma
instant storage. Salon-local interpretation remains controlled by `SALON_TIMEZONE`.
If data was previously written with non-UTC database sessions, review the stored
instants before using that data operationally; Phase 3 does not rewrite history.

After updating dependencies, run `npm ci` in both applications and rebuild the
backend. No new migration is required for Phase 3. To use a different backend port
in development, set frontend `API_PROXY_TARGET` (default `http://127.0.0.1:3000`)
and include the actual frontend origin in backend `TRUSTED_ORIGINS`.

## Customer availability (Phase 4)

Open `/availability` in the frontend, or use **Find an available salon time** on
the login page. No account is needed. Choose ordered services, specific qualified
staff or Any Available, and a salon-local date. Search, browse starting times by
hour, and select a time to preview the complete visit. Editing the selection
clears previous results. The search itself does not reserve a slot; the Phase 5
contact form below the selected visit submits the booking.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/availability/staff` | Public | Active staff names/IDs and active bookable service qualifications |
| `POST /api/availability` | Public, read-only | Validate an ordered plan and return advisory candidate times |

Search body (one local date, 1–20 ordered selections per request):

```json
{
  "date": "2026-10-10",
  "services": [
    { "serviceId": "SERVICE_UUID", "assignmentMode": "ANY_AVAILABLE" },
    { "serviceId": "OTHER_SERVICE_UUID", "assignmentMode": "SPECIFIC", "staffId": "STAFF_UUID" }
  ]
}
```

Replace placeholders with catalog UUIDs. Optional `startAt` accepts an explicit-offset
ISO timestamp on the requested salon date to check an exact starting instant.
Without it, the API enumerates minute-spaced starting times. The cadence and
20-selection request limit bound this advisory interface; no slots are persisted.
Responses contain `timeZone`, `generatedAt`, `policyVersion`, inclusive `earliest`
and `latest` bounds, `advisory: true`, and `slots` with assigned staff and per-service
start/end/reserved-until times. A valid search with no feasible plan returns an empty
array; inactive/missing services return 400, missing policy returns 503, and lock
contention returns retryable 409. Responses disable caching.

Searches acquire shared salon coordination and ordered locks on existing staff,
then reload configuration, select the currently effective policy, and read a fresh
database clock. Lead minutes are elapsed time; advance-booking days use salon-local
calendar arithmetic. Durations and buffers are elapsed minutes. Workload counts
only blocking pending/confirmed reserved minutes clipped to the selected local date;
completed reservations still prevent overlaps but do not contribute to assignment
workload. Staff ID ascending breaks workload ties.

These are advisory reads. The booking endpoint below freshly revalidates and
reserves the complete plan transactionally. No new migration is required.

## Booking and guest access (Phase 5)

At `/availability`, select a time, enter contact details, and choose **Reserve a
temporary hold**. The result shows the actual assigned staff, snapshotted service
prices, fixed appointment fee, hold countdown, and private appointment link.
The appointment remains `PENDING_PAYMENT` until a verified appointment-fee payment
confirms it. Unpaid holds expire normally. See Phase 6 payment setup below.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `POST /api/appointments` | Public + trusted browser origin | Transactionally creates customer, appointment, service reservations, and audit; returns 201 |
| `POST /api/appointments/access` | Private guest token + trusted browser origin | Returns safe appointment/contact details and effective hold status |

Booking uses the availability body with **required** `startAt`, plus `customer`:

```json
{
  "date": "2026-10-10",
  "startAt": "2026-10-10T09:00:00+08:00",
  "services": [{ "serviceId": "SERVICE_UUID", "assignmentMode": "ANY_AVAILABLE" }],
  "customer": {
    "firstName": "Sample",
    "lastName": "Guest",
    "phone": "+639171234567",
    "email": "guest@example.test"
  }
}
```

Email is optional. The response is `{ appointment, guestToken }`; `appointment`
includes `bookingCode`, `serverTime`, `timeZone`, `holdExpiresAt`, fee, contact
information, and ordered service snapshots. Access accepts `{ bookingCode, token }`
in the JSON body. Codes alone never authorize private reads. Wrong credentials
and missing appointments return the same 404; invalid input returns 400, stale
availability returns 409, and unsupported/missing policy returns 503.

Save the private link shown after booking. `/appointment#code=...&token=...` carries
the token in a fragment, which the browser never sends to the web server. The page
removes that fragment from its current history entry and retains credentials only
in component memory. Reloading the page requires reopening the saved private link
or re-entering the code and token. Tokens are 256-bit random values; only SHA-256
hashes are persisted. Guest responses are uncached; raw tokens and hashes are
excluded from audit records and operational logging. The app does not send a
confirmation notification for an unpaid hold.

Run the hold cleanup worker in a separate backend terminal:

```bash
npm run worker:holds
```

After building, production uses `npm run start:holds` alongside `npm start`.
Both use the same backend environment configuration. The worker checks up to 100
expired holds every five seconds, locks salon/Staff/Appointment in the common
order, reloads status and fresh database time, and atomically records `EXPIRED`
plus an audit entry. Multiple instances are safe. Historical service rows remain.
Availability and guest reads recognize expired holds even if the worker is down.
SIGTERM/SIGINT stops polling and drains current work before database shutdown,
with a bounded shutdown deadline.

Booking locks all existing staff in ascending ID order for the small-salon MVP.
It reloads the full plan and effective policy, and rolls back/restarts with a new
complete lock set if fresh staff or a newly effective policy is discovered.
Three attempts bound retries; contention returns a retryable 409. Before commit,
fresh time rechecks policy activation, lead time, and hold deadline. Monetary
snapshots use database Decimals. The countdown uses server time and elapsed browser
time, refreshes status every 15 seconds, and never authorizes a reservation itself.

No new model or migration was added. Audit transitions are transactional. The
approved notification events have no hold-created/hold-expired event; confirmation
and payment outbox entries are created with the Phase 6 payment transactions.

## Appointment-fee payment and confirmation (Phase 6)

For setup, browser scenarios, PayMongo sandbox acceptance, expected results, and
troubleshooting, follow the [Phase 6 testing guide](docs/PHASE_6_TESTING_GUIDE.md).

Admins and Cashiers can open **Appointment fees**, find a booking by code, and
record money already received. Enter the original GCash transaction or cash
collection reference and confirm the amount. Reuse that reference when retrying
an uncertain submission. Manual recording is an authorized assertion of receipt;
it does not query GCash or move money.

Timely payment confirms the booking once. Late and additional captures remain
successful financial records flagged for reconciliation, without restoring a
released reservation. Admins can review these records and browse all fee payments.
This phase provides a reconciliation view; financial correction workflows are
not added.

Manual captures issue an immutable receipt in the same transaction. Provider
captures can have a receipt issued afterward by an Admin/Cashier using **Find
booking** and **Issue receipt**. The existing Receipt model requires a real staff
issuer, so callbacks do not invent a system user. Guests see payment status,
confirmation, reconciliation notices, and issued receipt details in their private
booking view. Notification events are queued atomically; actual delivery is Phase 9.

Online payment defaults to disabled. To exercise the local simulator, set these
backend variables and restart the API:

```dotenv
PAYMENT_PROVIDER=test
PAYMENT_TEST_SECRET=<separate-random-secret-at-least-32-characters>
```

The guest booking screen then labels the development simulator explicitly. It can
simulate failure and success without collecting money. Production startup rejects
the test provider. Keep `PAYMENT_PROVIDER=disabled` until merchant configuration and acceptance checks
are complete. See the PayMongo setup below.

PayMongo is the selected GCash gateway. Its adapter is implemented; real merchant
sandbox/live acceptance has not been run because credentials and a reachable
webhook endpoint are not configured in this workspace.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/payments/options` | Public | Enabled online mode and explicit test-mode flag |
| `POST /api/payments/checkout` | Guest token + trusted origin | Create/reuse a provider fee attempt; body includes bookingCode, token, UUID idempotencyKey |
| `POST /api/payments/test-capture` | Guest token + trusted origin; test provider only | Simulate SUCCEEDED/FAILED for paymentId |
| `POST /api/payments/provider/events` | Authenticated provider event | Raw-body signature verification, then normal transactional processing |
| `POST /api/payments/status` | Guest token + trusted origin | Verify the current merchant-side state of a paymentId |
| `POST /api/payments/recover-checkout` | Admin + trusted origin | Verify and recover an uncertain paymentId using its PayMongo checkoutReference |
| `POST /api/payments/lookup` | Admin/Cashier + trusted origin | Payment-relevant booking details by bookingCode |
| `POST /api/payments/manual` | Admin/Cashier + trusted origin | Exact decimal amount, PHP currency, method, externalReference, UUID idempotencyKey |
| `POST /api/payments/receipts` | Admin/Cashier + trusted origin | Idempotent receipt issuance for successful fee paymentId |
| `GET /api/payments` | Admin | Bounded payment/reconciliation list; reconciliationOnly=true by default, optional cursor |

The test callback uses `X-Payment-Signature`: lowercase hex HMAC-SHA256 of the exact
UTF-8 JSON body with `PAYMENT_TEST_SECRET`. Its strict event fields are `paymentId`,
`appointmentId`, `reference`, decimal-string `amount`, `currency: "PHP"`, `status`
(PENDING/SUCCEEDED/FAILED/EXPIRED), and nullable `paidAt` (required for success).
A provider-paid timestamp cannot revive an expired hold. Never use this test event
format as an assumed contract for a real GCash gateway.

Payment transactions take shared salon coordination, ordered Staff locks, then
Appointment/Payment locks; authorization and fresh time are checked after waits.
Required reservations must still be owned. Confirmation, receipts where applicable,
audit, and notification writes commit together. A deadline crossed during later
writes rolls the transaction back and retries as a reconciliation case. Separate
captures are preserved, while the same provider transaction/manual reference
cannot duplicate collection totals. No models or migrations were added.

## PayMongo GCash setup

Follow the [detailed PayMongo setup and testing guide](docs/PAYMONGO_SANDBOX_VALIDATION.md)
for exact files to edit, HTTPS tunnel setup, webhook verification, and pass criteria.

The integration follows PayMongo's [Hosted Checkout V2](https://docs.paymongo.com/reference/create_checkout_sessions_2)
and [webhook signature verification](https://docs.paymongo.com/docs/developer-tools-webhook-setup-management).
It sends GCash as the only payment method, the fixed fee in integer centavos, and
internal payment/appointment IDs. Guest tokens and contact details are not sent in
checkout metadata or return URLs. The salon does not pass gateway fees on to the
customer or change the snapshotted appointment fee.

1. Enable GCash on the PayMongo merchant account and obtain its **test secret key**.
2. Register an HTTPS webhook endpoint at
   `https://YOUR_API_HOST/api/payments/provider/events` for
   `checkout_session.payment.paid`. Obtain that endpoint's signing secret.
3. Set backend variables locally (never commit secret values):

   ```dotenv
   PAYMENT_PROVIDER=paymongo
   PAYMONGO_SECRET_KEY=sk_test_YOUR_KEY
   PAYMONGO_WEBHOOK_SECRET=YOUR_WEBHOOK_SIGNING_SECRET
   PAYMONGO_RETURN_URL=http://localhost:5173/booking-confirmed
   ```

   The return URL must use a configured `TRUSTED_ORIGINS` frontend origin and the
   `/booking-confirmed` path without query parameters or fragments (legacy `/appointment` is also accepted). Development
   permits local HTTP; production requires HTTPS and `sk_live_...`. Development
   rejects live keys, and production rejects test keys/providers.
4. Restart the API and hold worker. Create a booking, choose **Pay with GCash**,
   then **Continue to GCash on PayMongo**. Checkout opens in the current tab.
   The existing HttpOnly appointment session restores booking access on return;
   the private guest token is never sent to PayMongo. Confirmation requires verified payment.
5. Complete PayMongo's sandbox flow, return to the salon, and check
   payment status. Confirm the webhook receives HTTP 200, one capture is stored,
   and the booking confirms once. Repeat the callback, try cancellation/failure,
   and test success after the hold expires before enabling live payments.

The handler verifies the exact raw body with `Paymongo-Signature` and the configured
mode's `te`/`li` HMAC, with a five-minute request timestamp tolerance. It then retrieves
the checkout session from the merchant API and validates its session, internal IDs,
capture ID, GCash source, amount, currency, mode, and paid status. Responses contain
only an acknowledgement. A failed API retrieval returns a retryable server error;
no unverified payment is committed. Keep the host clock synchronized.

Checkout creation is durably claimed once per pending PayMongo attempt. Known
sessions are reused across retries and browser keys. The current API documentation
does not establish a checkout creation idempotency guarantee, so an ambiguous
network failure is not retried as another create request. In **Appointment fees**,
an Admin can find the pending payment attempt ID, locate its matching
`reference_number` in PayMongo, and use **Recover an uncertain PayMongo checkout**
with the `cs_...` session ID. Recovery queries the merchant API, validates the
association, and audits the action. A verified callback also recovers a session
whose create response was lost. Never manually record that same online capture as
another cash/GCash collection.

The hold worker releases expired reservations first, then handles one expired
provider attempt per polling cycle: retrieve its state, expire an unpaid checkout
through PayMongo's expire endpoint, and persist the verified result. Provider calls
run outside database locks and failures are retried fairly. The provider may refuse
expiration while a payment is in progress; a subsequent capture is recorded for
reconciliation. Provider checkout shutdown is best effort; the database hold
deadline always governs confirmation. No unsupported expiry field is sent.

Stored PayMongo `Payment.externalReference` is the captured `pay_...` identity;
its `cs_...` session and checkout URL use the existing metadata field. The worker
and signed webhook never restore released reservations. The test adapter is a
separate local simulator, not a PayMongo sandbox certification.

## Request and error conventions

Use `validateRequest(schema)` with a Zod object containing the relevant `body`,
`params`, and `query` fields. Controllers consume the parsed data from
`res.locals.validated`; business logic belongs in services. `ApiError` carries a
safe public status/code/message and optional structured details. Central error handling returns
`{ "error": { "code": "...", "message": "..." } }` without internal traces.
Operational failure logs include a generated request ID and omit request bodies,
credentials, URLs, and raw errors. Business audit records for account and configuration changes are transactional
and separate from operational logging.

## Governing documents

- `AGENTS.md`: repository engineering instructions.
- `docs/SYSTEM_RULES.md`: business behavior.
- `docs/DATABASE_MODEL.md`: entities, relationships, constraints, and concurrency.
- `docs/ARCHITECTURE.md`: architectural boundaries.
- `docs/ROADMAP.md`: phase sequence; stop after the requested phase.
- `docs/DECISIONS.md`: approved architectural decisions.

## Appointment changes and no-show recovery (Phase 7)

Open the saved private appointment link to use **Manage your appointment**. Eligible
confirmed bookings can be rescheduled or cancelled under their original policy.
Choose a new date, retain/remove/reorder booked services, add active services, and
select specific or Any Available staff. Search results account for retained duration
and buffer snapshots and exclude only that appointment's existing reservation.
Submitting revalidates eligibility and the complete schedule atomically.

Cancellation releases the reservation without deleting history or changing
the collected fee. Retained services keep their original financial snapshots;
removed rows remain historical. A failed change leaves the original schedule intact.

Admins use **Appointments** in their workspace to inspect bookings and mark a missed
confirmed appointment as a no-show once its start has arrived, according to salon
procedure. Cashiers cannot perform these actions. Customer overrides are not added.

The original private link offers one eligible recovery booking within the grace
period measured from the missed start. Recovery inherits the original policy and
increments the effective change count. Valid unused fee credit confirms the new
booking directly; otherwise it receives a normal payment hold. The old appointment
remains NO_SHOW. Save the replacement's new private link, which uses its own token.

New API endpoints (all below `/api`):

- `POST /appointments/change-options`: guest credentials, date, services, recovery flag.
- `POST /appointments/change`: same fields plus exact `startAt` and optional reason.
- `POST /appointments/cancel`: guest credentials and optional reason.
- `GET /appointments?cursor=UUID`: Admin-only bounded appointment browsing.
- `POST /appointments/no-show`: Admin-only marking by booking code.

A retained selection supplies its `appointmentServiceId`, `serviceId`, assignment
mode, and specific `staffId` when applicable. Added/recovery selections omit
`appointmentServiceId`. Credentials remain in JSON request bodies; private links use
fragments. Notification events are queued transactionally; delivery is Phase 9.

## Phase 8 service settlement

Cashiers use **Service settlement** to find a booking, record every active service
as performed/not performed, review the full charge, and finalize a verified manual
collection. The original transaction/cash reference must identify that collection;
retry an uncertain request using the same reference. The appointment fee is separate
from the service charge. No split/partial payment or discretionary price adjustment
is supported. Admins use **Outcomes & commissions** to correct recorded outcomes
before completion and inspect finalized commissions. Completed outcomes are immutable.

All-not-performed appointments use **Finalize no-service closure**. This retains
fee history without generating a service payment, service receipt, or commissions.
The workspace displays stored receipts with a print action.

Authenticated, trusted-origin POST APIs:

- `/api/settlement/lookup`: `{ bookingCode }` returns reviewed `revision`, active
  services, fee/payment/receipt details and amount due; commission details are Admin-only.
- `/api/settlement/outcomes`: `{ bookingCode, revision, services: [{ id, outcome }] }`.
  Submit each active occurrence exactly once; outcomes are PERFORMED or NOT_PERFORMED.
- `/api/settlement/pay`: `{ bookingCode, revision, idempotencyKey, amount, currency,
  method, externalReference }`. Cashier-only; amount is an exact two-decimal string,
  currency is PHP, method is CASH/GCASH/OTHER, and idempotencyKey is a UUID.
- `/api/settlement/close`: `{ bookingCode, revision }`. Cashier-only, all services
  NOT_PERFORMED; retrying the same completed no-service closure is safe.

See [Phase 8 verification](docs/PHASE_8_VERIFICATION.md) and the
[deferred acceptance checklist](docs/ACCEPTANCE_BACKLOG.md). Browser/printing and
other open checks are retained for final review as requested; automated checks run
within each phase. Phase 11 acceptance and local release preparation are documented below.

## Phase 9 — Notifications and reminders

Use the [step-by-step Phase 9 testing guide](docs/PHASE_9_TESTING_GUIDE.md) to verify
local delivery, reminders, failure recovery and optional live providers, and record
the results using its checklist.

Run a separate notification process from `backend/` alongside the API and hold worker:

```bash
npm run worker:notifications
# After npm run build, use the compiled process:
npm run start:notifications
```

Delivery defaults to disabled for both channels. Existing events and due reminders
remain PENDING without consuming attempts on disabled channels. To simulate delivery
locally, set `NOTIFICATION_EMAIL_PROVIDER=test` and/or `NOTIFICATION_SMS_PROVIDER=test`.
Test delivery sends nothing, logs only queue ID/channel, and marks the attempt SENT.
Test providers are rejected in production. Use a development database for simulation.

Optional live adapters (neither account is configured by this repository):

| Channel | Configuration | Setup |
| --- | --- | --- |
| Email | `NOTIFICATION_EMAIL_PROVIDER=gmail`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `NOTIFICATION_EMAIL_FROM` | Enable Google 2-Step Verification and an App Password; FROM must match GMAIL_USER |
| SMS | `NOTIFICATION_SMS_PROVIDER=philsms`, `PHILSMS_API_TOKEN`, `PHILSMS_SENDER_ID` | Configure an API token and approved sender for the PhilSMS dashboard v3 API |

Messages use plain text and the event's stored booking code. Reminder times use
`SALON_TIMEZONE`. Guest tokens, hashes, internal payment IDs, and customer names are
excluded. Philippine `09XXXXXXXXX` numbers become `+639XXXXXXXXX`; the PhilSMS adapter accepts Philippine mobile numbers only and sends digits without `+`. Email remains the preferred channel
when an email address was supplied; there is no automatic channel fallback.

Paid email bookings receive one combined payment, confirmation and arrival-reminder
email. Separate email reminder records are skipped, and no new email reminders are
queued. Payment exceptions requiring review retain separate notices.

For SMS with `NOTIFICATION_SMS_POLICY=all`, `NOTIFICATION_REMINDER_HOURS` defaults
to 24 (0 disables reminders). For bookings without email, a scan queues
one reminder for each confirmed appointment schedule revision in the upcoming
window, including bookings confirmed within that window. Repeated/concurrent scans
do not duplicate it. Rescheduling permits a new reminder; old reminders are checked
against current status/start/revision immediately before delivery. Obsolete or past
reminders finish FAILED with `REMINDER_OBSOLETE`, without contacting the provider.
A change after the pre-send check cannot recall an external message already underway.

The worker claims one due row at a time with `FOR UPDATE SKIP LOCKED`. Defaults:
5-second polling, 60-second processing lease, 10-second provider timeout, and at most
5 attempts. Retry delays start at 60 seconds and double, capped at one hour. These
settings have bounded environment validation; the lease must exceed the timeout.
Permanent validation/provider failures stop immediately. Retryable HTTP/network
failures retry independently; an abandoned final attempt ends FAILED. Only the
current PROCESSING attempt generation can persist results. Shutdown stops new claims
and waits for the active attempt before disconnecting.

`SENT` means provider acceptance, not verified inbox/handset receipt. Delivery is at
least once. Gmail uses a stable Message-ID derived from the queue ID, but SMTP does
not guarantee deduplication. Gmail and PhilSMS have no assumed idempotency guarantee.
A crash after acceptance can therefore duplicate external delivery. Keep provider
and template configuration stable while retrying a queue item.

Inspect queue status and controlled `lastError` codes through authorized database
operations; no public queue/admin retry endpoint is introduced. Never blindly reset
SENT or uncertain FAILED attempts. Diagnose provider configuration and review delivery
history before a deliberate operational retry. Logs exclude message bodies, recipient
addresses, credentials, and raw provider errors. A reminder-scan error does not stop
already queued deliveries. Configure process supervision for both workers in deployment.

Provider references: [Google App Passwords](https://support.google.com/accounts/answer/185833),
[Nodemailer Gmail guide](https://nodemailer.com/guides/using-gmail),
[PhilSMS dashboard](https://dashboard.philsms.com/).
Use a token from this dashboard; sending uses its `/api/v3/sms/send` endpoint.
Tokens from the older `app.philsms.com` portal are not interchangeable.
See [Phase 9 verification](docs/PHASE_9_VERIFICATION.md) for local evidence and remaining
live-delivery acceptance.

## Phase 10 reports and salon guidance

- Admin: open **Reports & audit** for date-filtered collections, dashboard counts,
  appointments, payment attempts, historical receipts, finalized commissions and audits.
- Cashier: open **Collections** for aggregate payment summaries. Admin report endpoints
  remain forbidden to Cashiers even if a browser or stale token claims Admin access.
- Guest: open `/help` (also linked from booking and guest appointment screens) for
  services/prices, opening information, current policies and booking/change guidance.
  Guided mode works without an external AI account. Optional Gemini consultation
  uses the salon Markdown guidelines and temporary conversation context to ask
  follow-ups and recommend bookable services. It does not perform bookings or
  persist chat history. See [Gemini setup](docs/GEMINI_CHATBOT_SETUP.md).
- APIs: `GET /api/reports/collections`, Admin `GET /api/reports/dashboard` and
  `/api/reports/{appointments,payments,receipts,commissions,audit}`. Supply `from` and
  `to` as inclusive salon-local `YYYY-MM-DD` dates (at most 366 days), plus optional
  `page` and `pageSize` (maximum 100). `POST /api/chatbot` accepts `{ "message": "Opening hours" }`
  and optional bounded `history` pairs with `role` (`user`/`model`) and `text`.
- Collection captures use payment `paidAt`. Net cash movement reflects historical
  payment adjustments and is not profit. Applied/unapplied and reconciliation columns describe current status;
  reconciliation is a subset. Carried credits never generate new collections. Payment
  detail reports instead filter by attempt creation, so a delayed capture can appear
  in a different period. Every report states its date basis.

See [Phase 10 verification](docs/PHASE_10_VERIFICATION.md) for checks and limitations.

## Phase 11 — local release preparation

Local checks now include 48 unit/API tests and 100 database results. Representative
browser workflows and a complete local backup/restore comparison pass. No hosting
target is selected; live deployment, provider/printer acceptance, remote CI and salon
sign-off remain pending. See [verification](docs/PHASE_11_VERIFICATION.md),
[deployment/recovery](docs/DEPLOYMENT.md), [salon operations](docs/OPERATIONS.md) and
[remaining acceptance](docs/ACCEPTANCE_BACKLOG.md).

- `HOST=127.0.0.1` binds the API locally by default; a container host can explicitly
  select `0.0.0.0`. Keep the public endpoint behind HTTPS.
- `/api/ready` checks database/User-table access; `/api/health` remains liveness.
- `npm run admin:bootstrap` in a built backend creates the first Admin on an empty
  User table using securely injected `BOOTSTRAP_ADMIN_*` values. See the runbook;
  never use the development seed in production.
- `bash deploy/package-release.sh /absolute/path/new-release.tgz` builds a release
  archive without `.env`, dependencies or development fixture data.
- `deploy/backup.sh` and `deploy/restore.sh` use protected libpq credentials and
  refuse backup overwrite/nonempty restore targets. Test recovery before release.


### Appointment verification by email or SMS

Your Appointment offers the enabled verification methods. SMS uses
`APPOINTMENT_OTP_PROVIDER=textbee`; email uses `APPOINTMENT_EMAIL_OTP_PROVIDER=gmail`
with Gmail credentials and the shared `APPOINTMENT_OTP_SECRET`. These settings are
independent of routine notification providers. The API sends OTP directly; no
notification worker is needed for verification. See
[setup instructions](docs/EMAIL_SMS_SETUP.md#12-let-customers-verify-appointment-access-by-email-or-sms).
