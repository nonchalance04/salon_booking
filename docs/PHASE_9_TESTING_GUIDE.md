> Updated email policy: paid bookings send one combined payment, confirmation and
> arrival-reminder email. Older instructions below expecting separate email payment
> notices/reminders are superseded by EMAIL_SMS_SETUP.md and the notification
> integration tests. Reminder-scanner tests now apply to full-policy SMS only.

# Phase 9 — Notification delivery and reminders: testing guide

For account creation, sender verification, environment configuration, and real
delivery setup, start with the [email and SMS setup guide](EMAIL_SMS_SETUP.md).

Prepared 2026-10-05. Run the sections in order. This is a repeatable test procedure
and report template; unchecked scenarios below are not claims of completed testing.

## 1. What counts as working?

Phase 9 has two acceptance levels:

1. **Local implementation acceptance:** events enter the queue, the worker processes
   them, reminders obey appointment state, retries are bounded, and competing or
   crashed workers cannot corrupt queue or business records. No provider account is needed.
2. **Live delivery acceptance:** an enabled provider accepts a message and the intended
   test recipient receives the correct message. This requires provider credentials
   and sender setup. Local test delivery alone does not satisfy this level.

The `test` provider sends no email or SMS. It validates/renders the message, logs its
queue ID and channel, and marks it SENT. For live providers, SENT means **provider
acceptance**, not confirmed receipt by an inbox or handset. There is currently no
notification dashboard or delivery-receipt webhook; inspect the database and logs.

Previously recorded evidence, from 2026-10-04: 41 unit/API tests, 94 database results,
both production builds, and compiled-worker test delivery/shutdown passed. See
[the verification report](PHASE_9_VERIFICATION.md). These are historical results;
record your own run in section 14.

## 2. Prepare the environment

### 2.1 Choose your databases

Use a development database containing only test salon/customer data for browser
and SQL scenarios. Any SQL INSERT/UPDATE in this guide is for that database only.
Use a separate local/CI PostgreSQL server or dedicated test server for automated
integration tests, with a role allowed to CREATE DATABASE. Those tests create,
migrate, seed and drop their own random databases.

The temporary port 55439 mentioned in the old verification report is not a running
service you can assume exists. Use your actual running PostgreSQL host and port.

Requirements: Node.js 24, npm, PostgreSQL (the prior run used version 18), and either
`psql` or a PostgreSQL SQL editor such as pgAdmin. A provider account is optional.

### 2.2 Prepare the backend

```bash
cd /home/nonchalance/salon_project
nvm use
cd backend
```

If dependencies are absent, run `npm ci`. Preserve an existing `.env`; copy
`.env.example` to `.env` only when creating the file for the first time.

In `backend/.env`, retain your development DATABASE_URL, JWT_SECRET and trusted
frontend origins. Set:

```dotenv
NODE_ENV=development
SALON_TIMEZONE=Asia/Manila
NOTIFICATION_EMAIL_PROVIDER=test
NOTIFICATION_SMS_PROVIDER=test
NOTIFICATION_REMINDER_HOURS=0
NOTIFICATION_POLL_MS=5000
NOTIFICATION_LEASE_MS=60000
NOTIFICATION_TIMEOUT_MS=10000
NOTIFICATION_MAX_ATTEMPTS=5
NOTIFICATION_RETRY_BASE_MS=60000
```

Starting with reminders off makes the first event counts easier to inspect.
No Gmail/PhilSMS credentials are needed for test providers. Remove invalid stale values
from optional provider variables if startup validation reports them.

For the browser confirmation scenario, you can use the existing test payment
provider: set `PAYMENT_PROVIDER=test` and `PAYMENT_TEST_SECRET` to a separate random
secret of at least 32 characters. Generate one locally with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the value into `.env` without sharing it in your report. This simulates a fee;
it does not collect real money. Alternatively use the existing staff manual fee
workflow on test data.

```bash
npm run db:validate
npm run db:generate
npm run db:migrate
npm run build
```

For a **new empty development database**, configure the seed Admin/Cashier variables
and run `npm run db:seed` once. Do not re-seed an established database with bookings.
Use existing test credentials/configuration there. The seed refuses to rewrite
configuration after appointments exist.

**Expected:** each command exits successfully. There is no Phase 9 migration.

### 2.3 Open the SQL connection

Connect the SQL editor to the same development database as backend DATABASE_URL.
With psql, use your own connection URL:

```bash
psql 'postgresql://USER:PASSWORD@localhost:5432/YOUR_DEVELOPMENT_DATABASE'
```

Replace placeholders. Omit Prisma's `?schema=public` parameter from psql URLs.
Do not paste credentials into screenshots or reports. In the SQL session, run:

```sql
SELECT current_database(), current_user, now();
SET TIME ZONE 'Asia/Manila';
```

**Expected:** the selected database is your test development database. The time-zone
setting affects display in this SQL session only. Stored instants remain unchanged.

### 2.4 Start the application in separate terminals

| Terminal | Commands | Purpose |
| --- | --- | --- |
| A | `cd /home/nonchalance/salon_project/backend` then `npm run dev` | API |
| B | `cd /home/nonchalance/salon_project/frontend` then `npm run dev` | Browser UI |
| C | `cd /home/nonchalance/salon_project/backend` then `npm run worker:holds` | Existing hold cleanup |
| D | Leave stopped initially | Notification worker |

Install frontend dependencies with `npm ci` first if needed. Open the frontend URL
printed by Vite, normally `http://127.0.0.1:5173`. Use the trusted origin configured
for the API. Do not start duplicate API processes on the same port.

Changes to `.env` require restarting the relevant processes. Existing exported
shell variables override dotenv values; check for overrides if the worker uses
unexpected providers. Never print the full environment to diagnose this.

## 3. Run the automated checks

### 3.1 Notification unit tests (no database/provider needed)

From the backend directory:

```bash
node --import tsx --test tests/notifications.test.ts
```

**Expected:** 5 tests pass, 0 failures. These test provider request formatting,
Gmail SMTP lifecycle, MIME encoding and stable Message-ID, SMS normalization, error classification, all message
variants, and configuration restrictions. HTTP calls are mocked.

### 3.2 Notification database tests

Use the dedicated test server, not the browser application's database server in
production. Export its admin connection explicitly; the tests do not read this
value from `.env`:

```bash
export TEST_DATABASE_ADMIN_URL='postgresql://USER:PASSWORD@localhost:5432/postgres'
node --import tsx --test tests/integration/notifications.test.ts
```

**Expected:** 10 tests pass, 0 failures/skips. Tests provision and clean up their own
random database. A connection failure or missing CREATEDB privilege is a setup
failure, not a passing notification test.

| Test group | What it proves |
| --- | --- |
| Concurrent claims | One live owner; future and disabled-channel rows stay unclaimed |
| Retry/backoff | Bounded attempts, sanitized errors, unchanged appointment/payment |
| Permanent errors/timeouts | Invalid input stops; hung requests abort and retry |
| Abandoned leases | Expired claims recover; repeated crashes eventually fail |
| Late worker results | Old success/failure cannot overwrite a newer completed attempt |
| Crash after acceptance | Recovery reuses the stable queue identity |
| Reminder scans | Confirmed/future-only eligibility and one row per schedule revision |
| Obsolete reminders | Cancellation, changed revision and past starts suppress delivery |
| Appointment locks | Scans skip busy appointments; disabled reminder creation is off |
| Pagination | Existing reminder rows do not block later eligible appointments |

### 3.3 Full regression and builds

```bash
npm run check
npm run test:db
cd /home/nonchalance/salon_project/frontend
npm run build
cd /home/nonchalance/salon_project
git diff --check
```

The TEST_DATABASE_ADMIN_URL export must still be present in the shell running
`test:db`. At guide preparation, expected totals are 41 unit/API tests and 94 database
results. Future added tests can legitimately increase these counts. Require no
failures or unexpected skips and successful builds; save the summary output.

## 4. Verify a booking creates notifications before delivery

1. Keep terminal D stopped. Confirm no other notification worker is connected to
   this development database.
2. In the customer UI, select an available service, staff option, date and time.
3. Enter test contact data: a valid email such as `phase9@example.test` and a valid
   Philippine mobile format such as `09171234567`. This number is illustrative;
   use only a phone you control when testing live SMS later.
4. Click **Reserve a temporary hold**. Save the booking code and retain the private
   guest-access link locally. Do not include the guest token in your report.
5. Query the queue with the booking code substituted below.

```sql
SELECT a."bookingCode", a.status AS appointment_status,
       q.id, q."eventType", q.channel, q.status AS notification_status,
       q."attemptCount", q."scheduledAt", q."sentAt", q."lastError"
FROM "Appointment" a
LEFT JOIN "NotificationQueue" q ON q."appointmentId" = a.id
WHERE a."bookingCode" = 'REPLACE_WITH_BOOKING_CODE'
ORDER BY q."createdAt", q.id;
```

**Expected before payment:** appointment is PENDING_PAYMENT and no notification
rows exist for hold creation. The LEFT JOIN displays one row with null queue fields.

6. Before the hold expires, click **Open test payment**, then **Simulate successful
   payment**. Refresh status if needed. If using staff manual fee recording instead,
   use **Find booking** and **Record received appointment fee** on this test booking.
7. Run the SQL query again.

**Expected after timely fee confirmation:** appointment is CONFIRMED; one
PAYMENT_RECEIVED and one BOOKING_CONFIRMED row are PENDING, with attemptCount 0 and
sentAt null. Reminders are still off. Payment confirmation works while the worker
is stopped, proving that external delivery is not required for booking success.

## 5. Verify the worker drains queued messages

In terminal D:

```bash
cd /home/nonchalance/salon_project/backend
npm run worker:notifications
```

1. Find the startup log `notification_worker_started`; enabledChannels should contain
   EMAIL and SMS.
2. Within a few seconds, find `notification_test_accepted` for each queued ID.
3. Repeat the section 4 SQL query.
4. Wait at least two poll cycles (about 10–15 seconds) and query again.

**Expected:** both rows become SENT, attemptCount is 1, sentAt is set, and lastError
is null. IDs and counts stay unchanged on subsequent polling. Fast test delivery
may make PROCESSING too brief to observe. No email arrives: this is correct for
`test`. Logs contain queue IDs/channels, not recipient addresses, message bodies,
provider credentials or guest tokens.

## 6. Verify channel routing and disabled channels

1. Stop terminal D with Ctrl+C.
2. Create and confirm a second test booking with **no email**, using a valid mobile
   number. Use a separate free appointment slot.
3. Set NOTIFICATION_SMS_PROVIDER=disabled; leave EMAIL=test. Restart terminal D.
4. Query that booking using section 4 SQL and wait two poll cycles.

**Expected:** its notification channel is SMS; rows stay PENDING with attemptCount
0. The worker does not reroute SMS to email or consume attempts for a disabled channel.

5. Stop D, restore SMS=test, restart, and query again.

**Expected:** the SMS rows become SENT with attemptCount 1. If the email field was
provided, the existing rule chooses EMAIL even when SMS is enabled. An email delivery
failure does not automatically trigger SMS fallback.

## 7. Verify reminders and deduplication

### 7.1 Create an eligible reminder

1. Stop D. Set both notification providers to disabled temporarily.
2. Set NOTIFICATION_REMINDER_HOURS=24. If your valid appointment slots are farther
   away due to salon lead-time rules, use a larger window up to 168 hours and record
   the value. Do not alter booking policies merely to force this test.
3. Use a CONFIRMED test appointment starting in the future and within that window.
   Create and confirm another if needed. A PENDING_PAYMENT hold is not eligible.
4. Start D with both providers disabled. Reminder creation still runs.
5. After a poll cycle, inspect:

```sql
SELECT a."bookingCode", a.status, a."startAt", a."rescheduleCount",
       q.id, q.status AS reminder_status, q."attemptCount",
       q.payload->>'startAt' AS reminder_start,
       q.payload->>'rescheduleCount' AS reminder_revision,
       q."lastError"
FROM "Appointment" a
LEFT JOIN "NotificationQueue" q
  ON q."appointmentId" = a.id AND q."eventType" = 'APPOINTMENT_REMINDER'
WHERE a."bookingCode" = 'REPLACE_WITH_BOOKING_CODE'
ORDER BY q."createdAt";
```

**Expected:** exactly one reminder for the current startAt/rescheduleCount. It is
PENDING, attemptCount 0. The JSON time is UTC; the SQL time may display +08:00.
They must represent the same instant, not have identical strings.

6. Leave D running for 15 seconds. Run the following duplicate query:

```sql
SELECT "appointmentId", payload->>'startAt' AS start_at,
       payload->>'rescheduleCount' AS revision, count(*)
FROM "NotificationQueue"
WHERE "eventType" = 'APPOINTMENT_REMINDER'
GROUP BY "appointmentId", payload->>'startAt', payload->>'rescheduleCount'
HAVING count(*) > 1;
```

**Expected:** no rows. Repeat after restarting D; still no duplicates.

7. Stop D, set EMAIL=test and SMS=test, and restart. Inspect again.

**Expected:** the reminder becomes SENT once. No additional reminder is created for
that same schedule revision, even after restart. A booking confirmed less than
24 hours ahead gets a reminder on the next scan; the implementation uses an upcoming
window, not an exact 24-hour trigger.

### 7.2 Check ineligible cases

Use separate appointments: a pending hold, cancelled visit, past visit, and a
confirmed visit outside the configured window. Observe that the worker creates
no new reminders for those states. Use section 3.2 for deterministic coverage of
all statuses, including EXPIRED, NO_SHOW and COMPLETED, without waiting for real time.

Setting reminder hours to 0 stops **new reminder creation**. It does not cancel
already queued reminder rows; existing rows may still deliver if eligible.

## 8. Verify cancellation and rescheduling suppress old reminders

### 8.1 Cancellation

1. Use a confirmed appointment that is still eligible for customer cancellation
   under its stored booking policy and falls within your reminder window. If needed,
   increase the window up to 168 hours so cancellation remains allowed.
2. With both providers disabled, run D until a PENDING reminder exists. Stop D.
3. Open that booking's private guest link and choose **Cancel appointment**, then
   **Confirm cancellation**.
4. Confirm the appointment now shows CANCELLED.
5. Set EMAIL=test and SMS=test, start D, and run the reminder query in section 7.

**Expected:** the old reminder becomes FAILED with REMINDER_OBSOLETE and sentAt
remains null. This is an intentional suppression result, not a provider outage.
The BOOKING_CANCELLED event should deliver normally. No new reminder is created.

### 8.2 Rescheduling

1. Repeat the disabled-provider setup with a different confirmed appointment eligible
   for rescheduling. Wait for its old reminder, then stop D.
2. In its guest view, choose **Reschedule or change services**, choose a valid new
   time, and click **Confirm appointment changes**. Keep the new time inside the
   reminder window to test both old and new reminders.
3. Start D with both providers=test and inspect the appointment's queue rows.

**Expected:** old reminder is FAILED/REMINDER_OBSOLETE; a new reminder for the updated
startAt/rescheduleCount becomes SENT; BOOKING_RESCHEDULED becomes SENT. Repeated
polls do not add further copies. If the new visit is outside the window, its new
reminder appears only when it later enters the window.

If policy cutoffs block the UI action, record that prerequisite and use another
eligible visit. The integration suite covers these suppression paths independently.
An appointment change after the worker's final eligibility check cannot recall an
external message already in progress.

## 9. Check other event wording without sending messages

The test provider deliberately does not print content. To preview a single queued
message locally, stop D, set the queue UUID below, and run this from `backend/`:

```bash
NOTIFICATION_PREVIEW_ID='REPLACE_WITH_QUEUE_UUID' node --import tsx --input-type=module <<'JS'
import { prisma, disconnectDatabase } from './src/database/prisma.ts';
import { env } from './src/config/env.ts';
import { renderNotification } from './src/modules/notifications/templates.ts';
try {
  const row = await prisma.notificationQueue.findUniqueOrThrow({
    where: { id: process.env.NOTIFICATION_PREVIEW_ID }
  });
  const message = renderNotification(row, env.SALON_TIMEZONE);
  console.log(JSON.stringify({ subject: message.subject, text: message.text }, null, 2));
} finally {
  await disconnectDatabase();
}
JS
```

This only reads and renders; it neither changes queue status nor calls a provider.
Check these variants using your existing workflow fixtures or the automated template
tests. Do not fabricate real payment records just to produce notifications.

| Event/condition | Expected content |
| --- | --- |
| BOOKING_CONFIRMED | Confirmation and booking code; date appears only when present in the stored payload |
| BOOKING_RESCHEDULED | Rescheduled date/time from the payload |
| BOOKING_CANCELLED | Cancellation acknowledgement |
| NO_SHOW_RECOVERY_CREATED, pending fee | Explicitly says payment is still required to confirm |
| PAYMENT_RECEIVED, reconciliationRequired=true | Says salon review is needed and payment does not confirm a reservation |
| APPOINTMENT_COMPLETED, no-service closure | Says no services were performed and no service payment collected |
| APPOINTMENT_REMINDER | Correct appointment date/time and Asia/Manila label |

No template should contain a guest token/hash or internal payment ID. The booking
code is informational; it alone does not grant guest access. Preview output includes
that code, so redact it if publishing your test report.

## 10. Check failure handling and recovery

### 10.1 Manual permanent-failure example

Keep live providers disabled and use a development database. Stop D. Insert a
standalone invalid queue fixture, using this exact unique booking marker:

```sql
INSERT INTO "NotificationQueue"
  (id, "eventType", channel, recipient, payload, status, "scheduledAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'BOOKING_CONFIRMED', 'EMAIL', 'phase9@example.test',
   '{"schemaVersion":999,"bookingCode":"PHASE9-INVALID-PAYLOAD"}'::jsonb,
   'PENDING', now(), now())
RETURNING id;
```

Start D with EMAIL=test. Query only this fixture:

```sql
SELECT id, status, "attemptCount", "sentAt", "lastError"
FROM "NotificationQueue"
WHERE payload->>'bookingCode' = 'PHASE9-INVALID-PAYLOAD';
```

**Expected:** FAILED, attemptCount 1, sentAt null, lastError INVALID_PAYLOAD. After
several polls it is still FAILED with no further attempts and no test-accepted log.
This fixture has no appointment/payment relationship and changes no booking state.

### 10.2 Transient failure, timeout, crashes and stale results

Use deterministic integration tests for these timing-sensitive cases. The stock
`test` provider always succeeds for valid input; there is no `.env` switch that
makes it fail. Do not use fake live credentials as a substitute for a retry test:
a provider may correctly classify them as a permanent error.

From backend with TEST_DATABASE_ADMIN_URL set:

```bash
node --import tsx --test --test-name-pattern='bounded backoff|permanent payload|abandoned leases|late success|crash after' tests/integration/notifications.test.ts
```

**Expected:** the five selected tests pass; unmatched tests may be reported as
skipped/omitted because of the filter. Run the unfiltered suite in section 3.2 for
full acceptance.

Review the test output for each guarantee:

1. Transient failures go PROCESSING → PENDING, lastError is controlled, and
   scheduledAt moves into the future. Attempts stop at the configured limit.
2. A hung provider receives an abort signal; the row records PROVIDER_TIMEOUT.
3. An abandoned PROCESSING lease becomes claimable after expiration and increments
   attemptCount. A live lease cannot be claimed by another worker.
4. Old worker success and failure cannot overwrite a newer completed attempt.
5. Recovery after external acceptance reuses the queue ID. This does **not** prove
   exactly-once real-world delivery; provider idempotency has its own limits.
6. The booking and payment records remain unchanged despite notification failure.

Default retries wait approximately 60, 120, 240 and 480 seconds between attempts,
plus polling delay; attempt 5 fails terminally. Do not wait for these defaults to
manually prove race conditions: the integration tests use controlled providers and
shortened/simulated timing.

## 11. Check two workers and shutdown

### 11.1 Competing workers

1. Stop all notification workers and create/confirm another test booking so it has
   pending notifications. Keep reminders off for simple counts.
2. Start `npm run worker:notifications` in two separate backend terminals with the
   same development database and test providers.
3. Query the new booking's queue after a few seconds.

**Expected:** each row has one ID, SENT, attemptCount 1. Its acceptance log appears
in one worker, not both, when there is no crash or timeout. The two workers may split
jobs or one may process all of them; either result is valid. The automated competing
claims test is the decisive check if the manual batch drains too quickly to overlap.

### 11.2 Compiled process and graceful exit

1. Stop both development workers.
2. From backend, run `npm run build`, then `node dist/src/notification-worker.js`.
3. Confirm startup and processing of a newly queued test event.
4. Press Ctrl+C. Immediately run `echo $?` in that same shell.

**Expected:** the worker handles SIGINT, finishes any current attempt, disconnects,
and exits with code 0. The provider timeout is 10 seconds by default; the shutdown
safety limit is 25 seconds. It should not hang indefinitely.

For SIGTERM specifically, use another terminal to identify the compiled worker:

```bash
pgrep -af 'node dist/src/notification-worker.js'
```

Verify the correct test-worker PID, then run `kill -TERM REPLACE_WITH_PID`.
Check its original terminal's exit status. Do not signal unrelated API/worker PIDs.

## 12. Optional live email/SMS acceptance

Complete this only after provider account and sender setup. Use a separate, clean
QA database with your own recipient contact data. Enabling a channel will process
**all due queued messages for that channel**, including old ones; do not switch a
shared synthetic backlog to live delivery. A row already SENT by a test provider
will not be sent again—create a new QA booking/event instead of resetting it.

### 12.1 Gmail email

1. Follow [Gmail setup](EMAIL_SMS_SETUP.md#5-set-up-gmail-email) to enable
   Google 2-Step Verification and create an App Password.
2. Set these in the QA backend `.env`:

```dotenv
NOTIFICATION_EMAIL_PROVIDER=gmail
GMAIL_USER=your-salon@gmail.com
GMAIL_APP_PASSWORD=YOUR_16_LETTER_APP_PASSWORD
NOTIFICATION_EMAIL_FROM=your-salon@gmail.com
NOTIFICATION_SMS_PROVIDER=disabled
```

3. Restart the notification worker. Create/confirm one QA booking using an inbox you
   control. Keep payment simulation enabled if appropriate; no real payment is needed.
4. Observe queue status and Gmail's Sent folder.
5. Open the received email, including spam/junk folders if needed.

**Pass:** correct inbox, subject, booking code and wording; queue SENT with sentAt;
no duplicate during ordinary polling. Record receipt time and redacted evidence.
Gmail does not guarantee deduplication even though Message-ID is stable. A timeout
or crash after acceptance may duplicate a message during retry. Inspect recipient
receipt and sender evidence before manually retrying uncertain deliveries.

### 12.2 PhilSMS SMS

1. Configure an API token and approved sender with available SMS credits.
   Use the [PhilSMS dashboard](https://dashboard.philsms.com/) token.
   The adapter uses `https://dashboard.philsms.com/api/v3/sms/send`; the older
   portal does not accept dashboard tokens.
2. Set:

```dotenv
NOTIFICATION_EMAIL_PROVIDER=disabled
NOTIFICATION_SMS_PROVIDER=philsms
PHILSMS_API_TOKEN=YOUR_PRIVATE_API_TOKEN
PHILSMS_SENDER_ID=YourSalon
```

3. Restart the worker. Make a new QA booking **without email**, using a mobile number
   you control. Confirm it and inspect queue and PhilSMS message records.
4. Read the SMS on the handset. Check the booking code and any reminder time.

**Pass:** intended handset receives the correct text and PhilSMS shows an appropriate
result. SENT in the application alone is insufficient. Provider delivery status may
later become failed/undelivered; this app does not currently synchronize those later
changes back into NotificationQueue.

Record blocked sender/account setup as BLOCKED, not PASS. No live delivery was run
as part of preparing this guide.

## 13. Troubleshooting and cleanup

| Symptom | Check/action |
| --- | --- |
| No email/SMS, queue SENT | With test providers this is expected; with live providers inspect provider status and recipient evidence |
| Queue PENDING, attemptCount 0 | Worker running, correct database, enabled channel, scheduledAt due; exported environment overrides |
| Payment confirmed but nothing processed | API does not start the notification worker; start the separate process |
| No notification for temporary hold | Expected: confirmation/payment events begin after timely successful fee confirmation |
| No reminder | CONFIRMED, future start, inside window, reminder hours > 0; existing row for same revision may already be SENT or FAILED |
| Old reminder FAILED/REMINDER_OBSOLETE | Expected after state/time/revision changes; use a currently eligible booking |
| INVALID_RECIPIENT | Valid email or supported phone format; `0` and other dummy phone values are not valid SMS recipients |
| INVALID_PAYLOAD | Unsupported schema or malformed fields; inspect only the affected test fixture |
| PROVIDER_HTTP_400/401/403/422 | Inspect credentials, sender and provider validation; these are terminal in the adapter, not normal transient retries |
| PROVIDER_HTTP_429/5xx | Retryable provider/rate-limit problem; wait for scheduledAt and inspect attempt limit |
| PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT | Connectivity, malformed provider response or timeout; raw provider errors are intentionally not logged |
| ATTEMPTS_EXHAUSTED | Last permitted attempt was abandoned or limit already reached; investigate before a deliberate retry |
| notification_reminder_scan_failed | Check database connectivity/migrations; the worker still attempts already queued delivery |
| notification_worker_failed | Queue database/processing failure; check database and process configuration |
| Invalid environment configuration | Fix the named variables; test providers are rejected in production; lease must exceed timeout by more than one second |
| Automated tests cannot connect | Correct TEST_DATABASE_ADMIN_URL, reachable server and CREATEDB privilege; `.env` does not supply that test variable |
| pg concurrent-query deprecation | Existing tracked warning A08; record separately from actual test failures |

After testing:

1. Stop extra test notification processes with Ctrl+C; leave only intentionally
   configured processes running.
2. Restore your intended notification settings. Leave live providers disabled until
   live acceptance is complete; restore the desired reminder window (default 24).
3. Restart processes after configuration changes. Keep real secrets out of Git.
4. Preserve report evidence. Do not delete referenced business records or blindly
   reset SENT/FAILED rows. Disposable automated databases normally remove themselves;
   clean up an interrupted run only after identifying its exact test database.
5. Keep unfinished live acceptance in [A09](ACCEPTANCE_BACKLOG.md). Do not mark prior
   deferred browser/printing checks passed merely because these tests pass.

## 14. Test execution report template

Copy this section into a dated report, for example `PHASE_9_TEST_RESULTS_YYYY-MM-DD.md`.
Fill actual results instead of marking all rows passed in advance.

- Tester:
- Test date/time (Asia/Manila):
- Code revision / working-tree description:
- Node/PostgreSQL versions:
- Environment and database name (no credentials):
- Provider modes (EMAIL / SMS):
- Reminder window / poll / lease / timeout / max attempts:
- Commands executed and saved log locations:

| ID | Scenario | Expected | Actual/evidence | Result |
| --- | --- | --- | --- | --- |
| T01 | Notification unit tests | 5 pass | | Not run |
| T02 | Notification DB tests | 10 pass | | Not run |
| T03 | Full regression/builds | 41 unit/API, 94 DB, builds pass at guide date | | Not run |
| T04 | Unpaid hold | No hold-created notification | | Not run |
| T05 | Confirmation with worker stopped | Two PENDING events; booking confirmed | | Not run |
| T06 | Test worker delivery | SENT once; attempt 1; safe logs | | Not run |
| T07 | Channel disabled/enabled | Pending without attempts, then sent | | Not run |
| T08 | Eligible reminder | One per schedule revision | | Not run |
| T09 | Repeated scans/restarts | No duplicate reminders | | Not run |
| T10 | Ineligible appointment | No new reminder | | Not run |
| T11 | Cancellation | Old reminder obsolete; cancellation event sent | | Not run |
| T12 | Reschedule | Old obsolete; new reminder if eligible | | Not run |
| T13 | Message preview | Correct variants/timezone, no tokens | | Not run |
| T14 | Invalid payload | FAILED once, no delivery | | Not run |
| T15 | Retries/timeouts | Bounded retries and safe errors | | Not run |
| T16 | Crash/stale-worker recovery | New generation protected | | Not run |
| T17 | Two workers | One live owner per attempt | | Not run |
| T18 | Compiled worker shutdown | Test delivery and exit 0 | | Not run |
| T19 | Live email | Actual inbox receipt | | Not run |
| T20 | Live SMS | Actual handset receipt | | Not run |

Allowed results: PASS, FAIL, BLOCKED, NOT RUN. For each failure record the queue ID,
controlled error code, redacted booking code, steps, expected/actual behavior, fix,
and retest result. Do not include guest links, raw provider responses or secrets.

### Acceptance decision

- Local Phase 9 acceptance: PASS / FAIL / BLOCKED
- Live email acceptance: PASS / FAIL / BLOCKED / NOT RUN
- Live SMS acceptance: PASS / FAIL / BLOCKED / NOT RUN
- Open defects / dependencies:
- Follow-up owner/date:

Local acceptance requires successful automated checks and applicable manual paths.
Live delivery remains a separate open requirement until intended recipients receive
verified messages. This testing task does not authorize Phase 10 implementation.
