# Facebook Page and Messenger implementation guide

Prepared October 15, 2026. This is an implementation plan; Messenger integration is not yet implemented. Meta dashboard labels and access requirements can vary by app. Follow the requirements displayed for the selected app.

## Intended result

Customers message the salon's Facebook Page, receive answers about services, prices, hours and policies, and follow a link to the existing website to book and pay. Appointment changes stay on the secure website. Staff can take over a conversation in Meta Business Suite.

Flow: Facebook Messenger → HTTPS webhook → durable message queue → existing chatbot service → Messenger Send API. Booking links lead to the existing booking flow.

## 1. Prepare the Page and public website — owner and developer

1. Confirm the owner can manage the Page, authorize its connection, and grant messaging access.
2. Record the Page URL and numeric Page ID. Use a test Page for initial development where possible.
3. Deploy the frontend and backend using [DEPLOYMENT.md](DEPLOYMENT.md). Use stable HTTPS URLs for production. A temporary HTTPS tunnel is suitable for development only.
4. Verify the public booking flow works on a phone: choose services, choose a time, submit, complete a provider test payment, and open the private appointment link.
5. Verify the salon's services, prices, hours, contact details and policies in the admin workspace.

Completion check: both the public website and API are reachable from outside the developer's computer.

## 2. Add the booking link to Facebook — owner

1. Add `https://YOUR-SALON-DOMAIN/booking` to the Page's website information and a pinned booking post.
2. If the Page offers an appropriate action button that accepts an external URL, point it at the booking page.
3. Until the bot is ready, use a welcome reply such as: “Welcome to [Salon name]! View services and book here: [booking URL]. For help from our team, leave your question here.”
4. Open every link from Facebook on a phone and complete a test booking.

Completion check: customers can reach the existing booking website from the Page before Messenger development is complete.

## 3. Create the Meta app — owner with developer

1. Sign in to [Meta for Developers](https://developers.facebook.com/apps/) using an authorized account.
2. Create an app using the available Messenger/business messaging setup. Associate the business portfolio if requested.
3. Add or configure Messenger for Facebook Pages and connect the salon's Page.
4. Add authorized developer/tester accounts for development testing.
5. Record the App ID, app secret and Page ID. Generate a Page access token using an account with the necessary Page messaging access.
6. Check the app's permission/access requirements. Sending Page messages requires `pages_messaging`. Programmatic Page webhook subscriptions also require appropriate metadata-management access; request only the permissions the chosen setup needs.

Reference: [Meta's Messenger API collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api). The collection documents Page token requirements and Send API usage.

## 4. Add integration configuration — developer

Implement and validate these proposed backend settings; they do not exist as a complete Messenger configuration today:

```dotenv
MESSENGER_ENABLED=false
META_APP_SECRET=server-side-secret
META_PAGE_ID=salon-page-id
META_PAGE_ACCESS_TOKEN=server-side-page-token
META_WEBHOOK_VERIFY_TOKEN=independent-random-secret
META_GRAPH_API_VERSION=explicit-supported-version
PUBLIC_SITE_URL=https://YOUR-SALON-DOMAIN
```

1. Add settings to the backend's environment schema and relevant configuration types.
2. Add placeholder examples to `backend/.env.example` and `deploy/production.env.example`.
3. Require complete, valid configuration when Messenger is enabled. Require an HTTPS public site URL for production.
4. Keep secrets in the hosting secret store. Do not put them in frontend `VITE_` variables, source control, screenshots, or logs.
5. Choose a supported Graph API version from the app dashboard and pin it explicitly.

The webhook verification token is a secret we choose; it is different from the Page access token and app secret.

## 5. Reuse the existing chatbot — developer

1. Extract the service-selection code from `backend/src/modules/chatbot/chatbot.routes.ts` into a shared factory.
2. Have the website route and Messenger worker use that factory. Preserve guided/Gemini selection and existing fallbacks.
3. Call `service.answer(message, history)` directly from the backend worker rather than making an HTTP request back to `/api/chatbot`.
4. Add a response formatter for Messenger. Render service recommendations using the returned service names, current prices and durations; these are separate from the AI answer.
5. Convert relative recommendation URLs such as `/booking?service=...` into absolute URLs using the trusted `PUBLIC_SITE_URL`. Allow only the application's intended link paths.
6. Include a booking link for booking/availability requests. Direct appointment management to `/appointment` without inserting private appointment tokens into chat.

Keep current boundaries: the chatbot does not inspect private appointments, reserve slots, accept payments, confirm bookings, or change records. The website and existing backend rules perform those operations.

## 6. Build the webhook receiver — developer

Suggested module: `backend/src/modules/messenger/`, with thin routes, validation, signature verification, ingestion service, API client and worker logic. Register routes through `backend/src/app/routes.ts`.

Implement `GET /api/integrations/messenger/webhook`:

1. Read `hub.mode`, `hub.verify_token` and `hub.challenge`.
2. Require subscribe mode and the configured verification token.
3. Return the challenge verbatim as a plain-text HTTP 200 response when valid; reject invalid requests.

Implement `POST` at the same path:

1. Verify `X-Hub-Signature-256` with HMAC-SHA256 over the exact raw request bytes using the app secret. Reject missing, malformed or invalid signatures using a timing-safe comparison.
2. Reuse `req.rawBody`, already captured in `backend/src/app/app.ts`. Do not reconstruct the signed body with `JSON.stringify`.
3. Validate the envelope, iterate all entries/events, and accept only the configured Page.
4. Ignore message echoes, delivery/read receipts and unsupported events. Explicitly handle supported postbacks and unsupported attachments.
5. Persist accepted messages with a unique `(pageId, messageId)` constraint, then acknowledge quickly with HTTP 200. Duplicate accepted deliveries should also receive HTTP 200.
6. Return a retryable server error if durable persistence fails. Do not acknowledge work that exists only in memory or an unawaited promise.

The GET verification token checks setup ownership; POST signature verification authenticates event deliveries. Both are required.

## 7. Add processing, conversation context and staff takeover — developer

1. Create durable inbox/outbox records and a worker using the repository's service/transaction conventions. Add database migrations and update database documentation.
2. Key conversations by Page ID and sender's Page-scoped ID. Keep each customer's context separate and serialize processing within a conversation.
3. Keep bounded history compatible with the current chatbot schema: at most six user/model pairs, valid alternating roles, and the existing text limits. Define a short retention period, document it, and implement expiry/deletion.
4. Apply message-length, per-sender and global processing limits before calling the chatbot. Website HTTP limits do not automatically cover this worker.
5. Send replies through `POST https://graph.facebook.com/{VERSION}/{PAGE-ID}/messages` using the Page token. Use the sender's Page-scoped ID as the recipient and `messaging_type: RESPONSE` for these replies.
6. Split text to fit the current Send API limits. Retry transient errors/rate limits with bounded backoff; surface revoked tokens and permission failures to the operator.
7. Track pending/sent/failed outbound replies. Deduplication prevents ordinary webhook retries from generating another answer, but an ambiguous network failure during sending can still cause uncertainty; avoid blindly resending indefinitely.
8. Implement “staff”, “human”, or “talk to someone” as a conversation pause. Recheck pause state immediately before any send. Staff reply in Business Suite and explicitly resume the bot through an authenticated control. Provide a global bot-disable switch.
9. Test coexistence with manual Page replies and any other inbox tools. Pause automation on detectable staff activity, and configure Meta's available conversation-routing controls as needed. A customer's handoff request alone does not prevent all simultaneous staff/bot replies.

Ordinary automated responses operate within Meta's standard 24-hour messaging window. Track the last eligible customer interaction and recheck it before sending queued replies. Keep appointment reminders on the existing email/SMS channels for this initial release. See [Meta's Send API requirements](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api).

## 8. Configure and subscribe the webhook — developer with owner

1. Deploy the receiver and worker with the new settings configured.
2. In the app's Messenger/webhook setup, enter `https://YOUR-API-DOMAIN/api/integrations/messenger/webhook` and the verification token.
3. Complete verification and subscribe to messages and messaging postbacks for this implementation.
4. Ensure the app is subscribed to the salon Page itself; verifying a callback URL alone is insufficient.
5. Enable processing in the test environment and send a message from an authorized test account.
6. Check receipt, durable processing, reply delivery and the booking link.

Completion check: one inbound test message produces one appropriate Messenger response.

## 9. Test before requesting public access — developer and owner

| Test | Expected result |
| --- | --- |
| Opening hours, prices, booking policy | Correct current salon information |
| Concern-based service question | Appropriate guidance/recommendation when Gemini is enabled |
| Book or check availability | Link to website; no unverified slot promise |
| Cancel, reschedule, payment status | Secure website handoff |
| Repeated webhook event | One processing record; no ordinary duplicate reply |
| Invalid signature, wrong Page | No processing or reply |
| Echo, receipt, unsupported attachment | No reply loop; controlled handling |
| Multiple customers and rapid messages | Isolated history and ordered processing |
| AI outage or timeout | Existing guided fallback |
| Worker restart after acknowledgement | Persisted job is recovered |
| Staff takeover while reply is queued | Queued bot reply is suppressed |
| Expired messaging window | Automated send is blocked |
| Revoked Page token or throttling | Visible failure or bounded retry |
| Mobile booking/payment | Existing booking rules and payment checks still hold |

Add unit/API tests for verification, event validation, formatting and pause behavior, plus database tests for deduplication, queue recovery and conversation isolation. From `backend`, run `npm run check` and `npm run test:db` against the designated test database. Run the relevant frontend checks if adding staff controls there. Exercise payment flows with test credentials.

## 10. Complete Meta access requirements and launch — owner with developer

1. Add the app's required public details, privacy policy and data-deletion instructions. Explain Messenger data retention and any AI processing used.
2. Follow the dashboard's App Review, Advanced Access and business-verification requirements for the app's permissions. Do not assume a successful role-account test permits all customers.
3. Supply the requested demonstration and review instructions: customer message, bot reply, booking link, and staff takeover.
4. After required approvals, enable the app's production/live configuration and test with a real account without an app role.
5. Remove overlapping welcome/FAQ automations that would duplicate the new bot's replies; keep the intended greeting.
6. Have staff practice pause, manual response and resume. Monitor failures, queue age, send errors and takeover behavior without logging secrets or full private conversations.
7. If problems occur, disable Messenger processing, suppress queued sends, and use manual Business Suite replies while the booking website remains available.

Launch is complete when an ordinary customer can ask a question, receive a correct response, follow a working booking link, and reach salon staff when requested.

## Troubleshooting

- Callback verification fails: check public HTTPS reachability, exact path, verification token and plain-text challenge response.
- Callback verifies but messages do not arrive: check Page subscription, event subscriptions, Page/app pairing and test-account access.
- Events arrive but replies fail: check Page token, permissions, recipient Page-scoped ID and messaging window.
- Duplicate replies: check durable uniqueness, worker concurrency, Page automations and other connected bots.
- Website chatbot works but Messenger fails: check worker configuration, absolute booking links and Messenger-specific formatting/limits.

Meta's developer documentation could not be fetched reliably during preparation. API credential and messaging-window details were checked against Meta's published Postman collection; confirm current dashboard requirements and webhook/API documentation during implementation.
