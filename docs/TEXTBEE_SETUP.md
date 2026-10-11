# TextBee appointment verification

Customers can enter their booking code and the phone number recorded on their appointment, receive a six-digit SMS code, and view/manage that appointment. Existing private links remain valid. PayMongo payment verification is independent.

## Configure the gateway

1. Create a TextBee account and verify its email address.
2. Install the TextBee Android app, grant its required permissions, and register a dedicated salon phone with an SMS-capable SIM.
3. Keep the device powered, online, and permitted to run in the background. Check the carrier plan permits the intended usage.
4. Copy the API key and device ID into the backend environment (never frontend Vite variables or source control):

```dotenv
APPOINTMENT_OTP_PROVIDER=textbee
NOTIFICATION_SMS_PROVIDER=textbee
NOTIFICATION_SMS_POLICY=minimal
PUBLIC_SITE_URL=https://YOUR-SALON-DOMAIN
TEXTBEE_API_KEY=<your-api-key>
TEXTBEE_DEVICE_ID=<24-character-device-id>
APPOINTMENT_OTP_SECRET=<separate-random-secret-at-least-32-characters>
```

Generate a secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

From `backend`, run `npm run db:migrate`, then `npm run build`. Deploy/restart the API and hold worker with the same configuration, and rebuild the frontend with `npm run build` in `frontend`. The migration creates only the OTP challenge, appointment session, and rate-limit tables. No existing appointment token is rotated.

Use a customer-reachable `PUBLIC_SITE_URL` with no path, also present in `TRUSTED_ORIGINS`. With `NOTIFICATION_SMS_POLICY=minimal` (the default), the worker sends one combined fee-paid/booking-confirmed SMS containing the appointment time and a private link. Separate routine payment, completion and SMS reminder jobs become `SKIPPED`. Cancellation, rescheduling and financial-review notices remain available. Set `NOTIFICATION_SMS_PROVIDER=disabled` if the gateway should send OTPs only. OTP sends happen directly in the API and do not require the notification worker; routine notifications do.

## Customer flow

Open `/appointment`, enter booking code and phone, request a code, and enter it. The code expires after five minutes. A successful verification creates a two-hour HttpOnly appointment cookie; production uses Secure cookies. Reloading restores the appointment. “Close appointment” revokes the session. Existing private links are a fallback when SMS is unavailable.

The code is generated and checked by this backend. TextBee only transports the SMS. Delivery acceptance is not proof of phone ownership or payment. Codes and API credentials are never returned to the browser or logged.

Limits: five guesses per challenge; 60-second resend cooldown; three requests per phone and per booking per 15 minutes; ten requests per IP per 15 minutes; thirty verification attempts per IP per 15 minutes. Repeated requests during cooldown also consume the request budget. Resending invalidates the older code. Limits are database-backed. The server uses Express's untrusted-proxy default, so it does not trust client-supplied forwarded IPs; behind a reverse proxy the IP limit is shared unless trusted-proxy configuration is deliberately added for that deployment.

Unknown/mismatched details and provider send failures return the same neutral response. Provider failures invalidate the challenge and log only its ID. No automatic OTP send retries occur after ambiguous transport failures. Keep an eye on TextBee delivery status and quota when customers report missing codes. SMS may be delayed beyond code expiry if the Android gateway is offline.

The hold worker prunes expired sessions/rate counters hourly and removes expired challenges after a day. Historical bookings and payments are untouched.

## Validation

Automated tests use a fake sender and disposable PostgreSQL database; they never contact TextBee. Before launch, explicitly test SMS delivery to a salon-controlled number, code expiry, incorrect codes, resending, browser reload, and logout with the configured phone.

Official API reference used: https://textbee.dev/docs/sending-sms/sending-sms

This integration posts to `https://api.textbee.dev/api/v1/gateway/send-sms` with an `x-api-key` header and `deviceId`, `recipients`, and `message` JSON fields. It validates the documented `data.success` and `data.smsBatchId` response. It uses the hosted service; custom/self-hosted API URLs are not configured.

For the full local setup and live acceptance procedure, including SMS channel selection, payment notices, OTPs, reminders and troubleshooting, follow [the step-by-step testing guide](TEXTBEE_TESTING_GUIDE.md).

## Minimal SMS policy

Private links use `/a#<token>`; the fragment is removed after opening. The raw access token is derived using a purpose-specific HMAC with the backend JWT secret and notification identity. Only its hash is stored, scoped to one appointment, expiring 30 days after its scheduled end at issuance. Existing private links and OTP access remain supported. Customers normally reopen the SMS link without another code.

The combined text is ASCII and limited to 160 characters. An excessively long public domain causes `SMS_LINK_TOO_LONG` rather than a split SMS. Configure a concise real domain. A missing public origin prevents the minimal-SMS worker from starting; an obsolete confirmation is skipped. Neither sends an unusable link.

Minimal SMS sends are not automatically retried after provider errors or a reclaimed in-flight claim. This limits duplicate sends at the cost of requiring manual investigation if delivery is uncertain. Email retry behavior is unchanged. Skipped jobs retain their history; sent messages are never resent by changing policy. Setting `NOTIFICATION_SMS_POLICY=all` restores legacy behavior for future jobs, so keep `minimal` for reduced SMS use.

Restart the API and notification worker after applying the `notification_skipped` migration and rebuilding. Do not start a worker against an unmigrated database.


Email verification is also available on Your Appointment. Enable
`APPOINTMENT_EMAIL_OTP_PROVIDER=gmail` with the Gmail credentials and shared
`APPOINTMENT_OTP_SECRET`; see EMAIL_SMS_SETUP.md section 12. Customers choose an
enabled method. The booking cooldown, request budget, code invalidation and session
behavior are shared across email and SMS.
