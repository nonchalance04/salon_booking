# PayMongo payment setup: step-by-step guide

Checked against the application code and official PayMongo documentation on
October 6, 2026. Follow Steps 1–12 for local sandbox setup and validation, then
Step 14 when preparing a production deployment. This document does not itself
configure an account, enable live charging, or prove merchant acceptance.

The system already implements **GCash through PayMongo Hosted Checkout for the
appointment fee in PHP**. Service settlement remains the separate Cashier workflow.
Enabling additional payment methods would require an implementation change.
No PayMongo npm package, frontend public key, database model, or new migration is
required just to enable the existing integration.

## Understand the three payment modes

| Setting | What it does | PayMongo credentials needed? |
| --- | --- | --- |
| `PAYMENT_PROVIDER=disabled` | Disables online checkout; staff manual recording remains separate | No |
| `PAYMENT_PROVIDER=test` | Runs this application's local simulator | No; uses `PAYMENT_TEST_SECRET` |
| `PAYMENT_PROVIDER=paymongo` with `sk_test_...` | Calls PayMongo's real API in sandbox mode | Yes |
| `PAYMENT_PROVIDER=paymongo` with `sk_live_...` | Processes real payments in production | Yes |

PayMongo Hosted Checkout test sessions use a Secret Test key and simulate payment
before going live. [Official test-mode documentation](https://docs.paymongo.com/docs/payment-channels-testing).

## Values you will collect

| Value | Where it comes from | Where to put it |
| --- | --- | --- |
| Secret Test API key, `sk_test_...` | PayMongo Developers/API Keys | `PAYMONGO_SECRET_KEY` in `backend/.env` |
| Webhook endpoint signing secret | The registered PayMongo webhook endpoint | `PAYMONGO_WEBHOOK_SECRET` in `backend/.env` |
| Public HTTPS tunnel origin | ngrok's forwarding output | Prefix of the webhook URL registered with PayMongo |
| Frontend return URL | Your frontend's `/booking-confirmed` page | `PAYMONGO_RETURN_URL` in `backend/.env` |

The API secret authenticates your server's requests to PayMongo. The webhook
secret verifies PayMongo's incoming callbacks. They are different values; do not
substitute the API secret, JWT secret, ngrok authtoken, or simulator secret for the
webhook signing secret.

## How the URLs connect

```text
Customer browser -> http://127.0.0.1:5173/availability
Frontend /api requests -> Vite proxy -> API port 3000
API -> PayMongo -> hosted GCash checkout opens in another browser tab
PayMongo webhook -> https://YOUR_TUNNEL/api/payments/provider/events -> API
Customer return -> http://127.0.0.1:5173/booking-confirmed
```

The callback is a server-to-server POST; the return URL is a browser destination.
Returning to the application does not prove payment. The backend verifies provider
payment details before recording a successful capture and confirming an eligible
hold. PayMongo documents the checkout completion event in its
[Hosted Checkout quick start](https://docs.paymongo.com/docs/payment-channels-hosted-checkout-quick-start).

## Files to edit

| File | Action |
| --- | --- |
| `backend/.env` | Required: configure database, authentication, PayMongo test key, endpoint signing secret, and return URL |
| `backend/.env.example` | Reference/template only; copy only if `.env` does not exist; never insert actual keys here |
| `frontend/vite.config.ts` | No change for backend 3000/frontend 5173; proxy defaults to backend 3000 |
| `backend/src/config/env.schema.ts` | Read for validation rules; no change required |
| `backend/src/modules/payments/paymongo-provider.ts` | Existing integration; no change required to test |
| `backend/src/modules/payments/payments.routes.ts` | Existing `/api/payments/provider/events` callback; no change required |
| `backend/prisma/schema.prisma` | Existing database models; no change required |

Keep actual keys in ignored `backend/.env`. Do not create `VITE_PAYMONGO_SECRET_KEY`
or put merchant/signing secrets in frontend files. This hosted integration does
not require a frontend PayMongo public key.

## 1. Prepare the application

Run on the computer where the browser and development servers will run:

```bash
cd /home/nonchalance/salon_project
nvm use
cd backend
npm ci
cd ../frontend
npm ci
```

Node.js 24 and PostgreSQL are required. If dependencies are already installed,
installation is optional. Create `backend/.env` from `.env.example` only if absent.
Use an existing initialized development database, or initialize a fresh one using
Steps 1–5 of the [system setup guide](SETUP_AND_TESTING.md). Do not re-seed a database containing
appointments just to test PayMongo. Have an active Admin/Cashier login available.

Initially keep `PAYMENT_PROVIDER=disabled` while acquiring webhook configuration.
Start the backend:

```bash
cd /home/nonchalance/salon_project/backend
npm run dev
```

Open `http://127.0.0.1:3000/api/health` and `/api/ready`; expect HTTP 200 for
both. Readiness should return `{"status":"ready"}`. Sign into the frontend once
to verify your staff credentials before testing payments.

## 2. Obtain the merchant test key

1. Create or sign into your merchant account at the
   [PayMongo dashboard](https://dashboard.paymongo.com/). Complete the account's
   displayed setup steps. Keep credentials in your local environment, not a chat.
2. Select the test environment where the dashboard offers a mode selector.
3. Open Settings → Developers / API Keys and copy the Secret Test key beginning
   `sk_test_`. Dashboard wording may differ.
4. Confirm the account can use GCash in test Hosted Checkout. Follow any account
   activation/access requirements displayed by PayMongo.
5. Copy the **Secret Test** key, not a `pk_test_...` public key. Keep it ready for
   Step 5. If GCash is unavailable, resolve the account's method eligibility with
   PayMongo; enabling unrelated methods in the dashboard will not change this
   application's GCash-only request.

Official references:
[Hosted Checkout quick start](https://docs.paymongo.com/docs/payment-channels-hosted-checkout-quick-start),
[Hosted Checkout testing](https://docs.paymongo.com/docs/payment-channels-testing).

## 3. Expose the API through HTTPS

PayMongo cannot deliver callbacks to your computer's localhost address. Use a
public HTTPS staging API or a development tunnel. Example with ngrok:

1. Install ngrok using its [official Linux instructions](https://ngrok.com/download/linux).
2. Authenticate it locally:

   ```bash
   ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
   ```

3. In a separate terminal, start:

   ```bash
   ngrok http 3000
   ```

4. Copy the HTTPS forwarding origin shown, e.g. `https://YOUR_HOST.ngrok-free.app`.
5. Check `https://YOUR_HOST.ngrok-free.app/api/health` reaches the API.
6. Keep the tunnel running. For API-only tunneling with a local frontend return
   URL, forward to port 3000. Ensure
   the webhook path is reachable without browser login/interstitial challenges.

Use your assigned host, not the literal example. If the tunnel host changes,
update the registered PayMongo webhook endpoint. The tunnel origin does not need
adding to TRUSTED_ORIGINS: the callback authenticates a provider signature.

If customers open the salon or return from PayMongo on the **public ngrok host**,
run `ngrok http 5173` instead, with both Vite and the backend running. Vite serves
`/booking-confirmed` and proxies `/api` (including provider webhooks) to port 3000.
Add the public hostname to Vite `server.allowedHosts`, add its HTTPS origin to
backend `TRUSTED_ORIGINS`, and use that same origin for `PUBLIC_SITE_URL` and
`PAYMONGO_RETURN_URL` (with `/booking-confirmed` appended for the latter). Start booking
on that public origin so the appointment session cookie is available on return.
An API-only tunnel to port 3000 returns 404 for `/booking-confirmed`.

## 4. Register the test webhook

1. Open PayMongo Settings → Webhooks or Developers → Webhooks; the dashboard
   grouping can differ. Select the test environment.
2. Add/enable an endpoint for test payments at:

   ```text
   https://YOUR_HOST.ngrok-free.app/api/payments/provider/events
   ```

3. Subscribe to `checkout_session.payment.paid`.
4. Save it and copy that endpoint's signing secret. This is different from the
   API Secret Test key and the local simulator PAYMENT_TEST_SECRET.
5. Keep the endpoint enabled and in the same test environment as the API key.

Register this endpoint once and reuse it for bookings. Use the exact event
`checkout_session.payment.paid`; a Payment Link or generic payment event is not
a substitute for this integration's checkout event. A browser GET to the callback
path may return 404 because it is a POST route; verify actual signed delivery in
Step 9. Never disable signature verification to make a test pass.

See [PayMongo webhook setup](https://docs.paymongo.com/docs/developer-tools-webhook-setup-management).

## 5. Edit backend/.env

Preserve your existing database/JWT/staff credentials. Set these entries exactly,
replacing placeholders with actual local values:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
SALON_TIMEZONE=Asia/Manila
TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
COOKIE_SAME_SITE=lax
PAYMENT_PROVIDER=paymongo
PAYMONGO_SECRET_KEY=sk_test_YOUR_ACTUAL_KEY
PAYMONGO_WEBHOOK_SECRET=YOUR_ACTUAL_ENDPOINT_SIGNING_SECRET
PAYMONGO_RETURN_URL=http://127.0.0.1:5173/booking-confirmed
```

Edit existing entries rather than appending duplicate names. Leave
`PAYMENT_TEST_SECRET` blank or unused; PayMongo sandbox still uses
`PAYMENT_PROVIDER=paymongo`, not `test`. Do not include a trailing slash after
`/booking-confirmed`. The full configuration must retain valid `DATABASE_URL` and
`JWT_SECRET` values from your system setup.

The return URL is the frontend, not the API tunnel. It must use a configured
trusted origin and the exact `/booking-confirmed` path, without query parameters,
fragment, or guest token. Keep DATABASE_URL and JWT_SECRET valid; JWT_SECRET needs
at least 32 characters. PAYMENT_TEST_SECRET is unused with provider `paymongo`.
Use a test key: development rejects live keys. Never edit `.env.example` with
actual credentials.

If using a different API port, change PORT and launch Vite with
`API_PROXY_TARGET=http://127.0.0.1:YOUR_PORT npm run dev`; tunnel that same API port.
No Vite source edit is needed. If using a different frontend origin, update
TRUSTED_ORIGINS and PAYMONGO_RETURN_URL together. For a remote browser, localhost
refers to that browser's computer; use an appropriately served HTTPS frontend.

## 6. Restart and verify configuration

Stop the old API/worker with Ctrl+C. Run these in separate terminals:

```bash
cd /home/nonchalance/salon_project/backend
npm run dev
```

```bash
cd /home/nonchalance/salon_project/backend
npm run worker:holds
```

```bash
cd /home/nonchalance/salon_project/frontend
npm run dev
```

Leave the HTTPS tunnel running as a fourth process. Open
`http://127.0.0.1:3000/api/payments/options`. Expect:

```json
{"onlineAvailable":true,"testMode":false,"provider":"paymongo","sandbox":true}
```

`testMode:false` means the application's simulator is off; `sandbox:true` means
PayMongo test mode. If API startup fails, fix the named environment variables
rather than weakening validation in env.schema.ts.

## 7. Create a fresh guest booking

1. Open `http://127.0.0.1:5173/availability`.
2. Select service/staff and an available future date/time within policy limits.
3. Enter development customer contact details.
4. Click Reserve a temporary hold.
5. Record booking code, fee, and hold deadline. Save the private booking link in
   a private local note and keep the booking tab open.
6. Confirm the page displays the PayMongo sandbox notice, not simulator buttons.

The unchanged seed uses PHP 100.00 and a 10-minute hold. Follow the actual displayed
fee/deadline if policy differs. Complete payment well before expiration.

## 8. Create and complete the merchant checkout

1. Click Pay with GCash. Expect a pending attempt and checkout link.
2. Click Continue to GCash on PayMongo. It opens in the current tab.
3. Verify the hosted fee matches the booking and GCash is offered.
4. Follow the test e-wallet flow. PayMongo documents Authorize/Fail options on
   its test e-wallet page; choose success/Authorize when presented. Hosted UI
   wording may vary. A real GCash account is not required for the documented
   test e-wallet flow. [Testing reference](https://docs.paymongo.com/docs/payment-acceptance-testing)
5. Complete success. Record the test merchant session `cs_...` and captured
   payment `pay_...` identifiers privately where available.
6. Return to `/booking-confirmed` in the checkout tab. Checkout establishes a two-hour
   HttpOnly appointment session, so the booking restores on the same browser.
   Pending payments are verified automatically; only a confirmed booking shows
   the Booking Confirmed page. Cancelled/failed checkout never implies success.
   If the session expired or cookies were cleared, use your private
   link, or OTP verification. A verified successful PayMongo payment automatically issues its e-receipt.
   Use Download E-Receipt to preview it, then Print / Save as PDF.

## 9. Prove webhook delivery independently

Before clicking Check payment status, inspect the actual event delivery in the
merchant dashboard or tunnel request inspector:

1. Find the `checkout_session.payment.paid` event for this session.
2. Verify it was delivered to the exact registered callback URL.
3. Verify the application's response is HTTP 200 with `{"received":true}`.
4. On the restored booking page click Refresh status if available (this reads the local booking,
   unlike Check payment status, which explicitly queries PayMongo).
5. Expect CONFIRMED and one SUCCEEDED payment for the fee.

If delivery failed, record webhook validation as failed even if Check payment
status later confirms the booking. That button is a separate recovery path.
Inspect endpoint secret, environment mode, raw body/header forwarding, and host
clock. The app allows five minutes of signature timestamp difference.

## 10. Validate staff receipt and persisted financial identity

1. Open the frontend root in another tab and sign in as Admin/Cashier.
2. Admin: select Appointment fees. Cashier: use the displayed payment workspace.
3. Find booking by code; verify CONFIRMED and one successful fee payment.
4. Click Issue receipt for PHP ….
5. Refresh the private guest booking; expand Receipt … and verify amount,
   currency PHP, method GCash, booking, customer, and paid time.
6. Admin: uncheck Show only payments requiring reconciliation and refresh the list.
   Expect the normal capture without review required.

Optional read-only database validation in your PostgreSQL client (replace code):

```sql
SELECT a."bookingCode", a.status, a."confirmedAt",
       p.id, p.provider, p.method, p.status AS "paymentStatus", p.amount,
       p.currency, p."externalReference", p."satisfiesObligation",
       p."reconciliationStatus", p.metadata->>'checkoutReference' AS "sessionId",
       r."receiptNumber"
FROM "Appointment" a
JOIN "Payment" p ON p."appointmentId" = a.id
LEFT JOIN "Receipt" r ON r."paymentId" = p.id
WHERE a."bookingCode" = 'REPLACE_WITH_BOOKING_CODE';
```

Expect one successful `paymongo`/`GCASH` capture, `pay_...` external reference,
`cs_...` session metadata, correct Decimal amount/PHP, obligation satisfied,
reconciliation NONE, confirmed timestamp, and one receipt after staff issuance.
There may be other historical failed/pending attempts; count successful captures,
not every attempt. Notification delivery is Phase 9; queued events are sufficient.

## 11. Validate repeat and failure behavior

- Refresh/read status repeatedly: one successful capture and the same receipt.
- If dashboard offers event resend, resend the successful delivery. Expect another
  HTTP 200 acknowledgement with no duplicate payment, confirmation, or receipt.
  If unavailable, mark merchant resend unexecuted; automated tests cover duplicates.
- On a separate booking, choose Fail/cancel or abandon the test checkout. Expect
  no successful capture or confirmation. The app need not label an abandoned
  checkout FAILED; it can remain pending until hold expiration.
- On another booking, leave checkout unpaid until hold expires with the worker
  running. Expect EXPIRED booking and reusable interval, subject to other bookings.
  The worker attempts gateway expiration. If sandbox permits a late capture,
  expect reconciliation and no restoration; if gateway blocks it, record that fact.

Do not manually record the same online capture as another GCash collection.
Ambiguous checkout creation is handled through Admin's Recover an uncertain
PayMongo checkout with matching attempt UUID/session ID. Do not blindly create
another session after a lost response.

## 12. Pass criteria and troubleshooting

Pass requires a real merchant test checkout, correct fee/method, paid merchant
record, signed callback HTTP 200, one local successful capture, CONFIRMED booking,
correct financial identity, and a staff-issued receipt. Record duplicate/failure/
expiry checks as passed, failed, or unexecuted separately. UI simulator results do
not prove real merchant acceptance.

| Problem | Action |
| --- | --- |
| Online unavailable | Verify PAYMENT_PROVIDER, restart API, reload page |
| No GCash / checkout unavailable | Check merchant access/method eligibility and test key; inspect API error; preserve any uncertain attempt |
| Webhook 404 | Check `/api/payments/provider/events`, tunnel API port, and current HTTPS host |
| Webhook 401 | Check endpoint secret/mode, preserved signature/body, and synchronized clock |
| Webhook 400 | Provider payload/session validation failed; preserve sanitized merchant evidence for adapter investigation |
| Webhook 503 | Check outbound merchant API access/test key; allow provider retry and inspect server/tunnel results |
| Paid but pending | Check callback first; then use Check payment status as a separately recorded recovery test |
| Expired booking after success | Compare verification/deadline timing; use Admin reconciliation; no released reservation is restored |
| Guest access lost after reload | Reopen saved private link |
| No receipt | Staff must issue provider receipt explicitly |

Store sanitized acceptance notes: date, booking code, fee, merchant IDs, event type,
HTTP status, local statuses, receipt number, and results. Exclude keys/signing
secrets/guest tokens/private links from shared evidence. Stop the tunnel and test
processes afterward. To disable online mode, edit backend/.env to
PAYMENT_PROVIDER=disabled and restart API/worker. If stopping the tunnel permanently,
disable its obsolete test endpoint in the merchant dashboard.

## 13. Run the application's regression checks

From the initialized development checkout:

```bash
cd /home/nonchalance/salon_project/backend
npm run check
```

For a focused provider/payment check:

```bash
node --import tsx --test tests/paymongo.test.ts tests/payments.test.ts
```

For database integration tests, use the separate local test role with CREATEDB
from the system setup guide. Replace and URL-encode its password:

```bash
export TEST_DATABASE_ADMIN_URL='postgresql://salon_test:YOUR_TEST_PASSWORD@127.0.0.1:5432/postgres'
npm run test:db
unset TEST_DATABASE_ADMIN_URL
```

Then build the frontend:

```bash
cd /home/nonchalance/salon_project/frontend
npm run build
```

Expected: commands exit successfully and tests report no failures. Automated
provider tests use controlled fixtures; they do not demonstrate that your merchant
account, public callback, or actual checkout works. Retain the Step 9 evidence.

## 14. Prepare production payment configuration

Perform this section on the intended production deployment after sandbox acceptance.
It is a configuration procedure; this guide has not deployed or enabled it for you.

1. Finish merchant activation and confirm GCash shows **Active** in Settings →
   Payment Methods. PayMongo requires an activated account and active intended
   methods for launch. Follow its
   [go-live checklist](https://docs.paymongo.com/docs/payment-channels-go-live-checklist).
2. Complete the project's [deployment runbook](DEPLOYMENT.md): production database,
   migrations, Admin bootstrap, real salon configuration, built frontend, supervised
   API/workers, and HTTPS. Do not seed production with development fixtures.
3. Choose your real frontend origin, for example `https://salon.example.com`.
   Serve frontend and `/api` on that same site using the configured reverse proxy.
4. Register a **live-mode** webhook endpoint:

   ```text
   https://salon.example.com/api/payments/provider/events
   ```

   Subscribe to `checkout_session.payment.paid`. Copy this live endpoint's signing
   secret; do not reuse the test endpoint secret by assumption.
5. Obtain your `sk_live_...` API secret. Update the deployment's secure environment
   file (the supplied systemd runbook uses `/etc/salon/salon.env`):

   ```dotenv
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   TRUSTED_ORIGINS=https://salon.example.com
   COOKIE_SAME_SITE=lax
   PAYMENT_PROVIDER=paymongo
   PAYMONGO_SECRET_KEY=sk_live_YOUR_ACTUAL_LIVE_KEY
   PAYMONGO_WEBHOOK_SECRET=YOUR_LIVE_ENDPOINT_SIGNING_SECRET
   PAYMONGO_RETURN_URL=https://salon.example.com/booking-confirmed
   ```

   Replace the example domain and values. Preserve the production database/JWT
   settings. Set notification providers to `disabled` or configured real providers;
   `test` notification modes are rejected in production.
6. Restart the API and workers through your process supervisor. For the supplied
   installed systemd services:

   ```bash
   sudo systemctl restart salon@server salon@hold-worker salon@notification-worker
   ```

7. Check production `/api/ready` and `/api/payments/options`. Expected payment
   options are:

   ```json
   {"onlineAvailable":true,"testMode":false,"provider":"paymongo","sandbox":false}
   ```

8. Carry out a salon-authorized real appointment-fee transaction, knowing it moves
   real money. Verify merchant payment, signed callback, a single local capture,
   confirmation within the hold deadline, and staff-issued receipt. Do not change
   the fee arbitrarily to force a test; use the configured booking policy.
9. Reconcile that transaction with the merchant dashboard and preserve operational
   records. Follow the salon's approved merchant reconciliation procedure for
   payment discrepancies; the application provides review only.
10. Monitor callback failures, uncertain checkout attempts, late captures, worker
    health, and receipts using [Operations](OPERATIONS.md). Use a stable production
    domain rather than the temporary development tunnel.

The app enforces test keys outside production and live keys in production. Merely
replacing `sk_test_` with `sk_live_` is not a valid migration: keys are issued by
PayMongo, and environment, webhook mode/secret, HTTPS origins, and return URL must
all match.

## 15. Keep an acceptance record

| Check | Expected | Result / evidence |
| --- | --- | --- |
| Configuration | Provider paymongo, correct sandbox/live mode | NOT RUN |
| Checkout | GCash offered; appointment fee and PHP match | NOT RUN |
| Merchant capture | Correct session and successful payment | NOT RUN |
| Webhook | Signed paid event, HTTP 200, received true | NOT RUN |
| Local result | One successful fee capture; eligible booking CONFIRMED | NOT RUN |
| Receipt | Staff-issued receipt has correct fee and identity | NOT RUN |
| Duplicate event | No duplicate capture or receipt | NOT RUN |
| Failure/abandonment | No false confirmation | NOT RUN |
| Expiration | Hold released; late capture does not restore it | NOT RUN |
| Recovery | Explicit status check recorded separately from webhook success | NOT RUN |

Record date, environment, booking code, merchant references, expected/actual result,
and any retest. Use PASS, FAIL, BLOCKED, or NOT RUN. Do not put API keys, signing
secrets, raw callback payloads, or private guest links in shared evidence.
