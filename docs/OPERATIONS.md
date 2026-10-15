# Salon operating instructions

Use the deployed HTTPS address supplied by the operator. All displayed appointment
and report dates follow salon time. Each person uses their own Admin/Cashier account.
Staff profiles do not provide login accounts.

## Customer booking and changes

1. Open `/availability`, select services in visit order, staff preference and date.
2. Choose a time and submit contact details. A temporary hold is not confirmation.
3. Keep your booking code. To reopen appointment details, use Your appointment and verify the phone number used when booking; SMS appointment links also open details automatically.
4. Pay the appointment fee through the configured checkout or salon collection
   procedure before the hold expires. Refresh and verify CONFIRMED.
5. Use the private link to reschedule or cancel while eligible under the booking's
   original policy. A failed change leaves the existing reservation intact.
6. For a missed visit, follow the recovery option if offered. Save the replacement's
   new link. Eligible fee credit transfers once; no second collection is recorded.

An expired hold cannot be restored by a late online payment. Contact the salon for
reconciliation. The guided assistant at `/help` explains services/policies and links
to booking; the availability screen remains authoritative for available times.

## Cashier

- **Appointment fees:** find the booking code, verify money actually received, and
  record its original transaction/cash collection reference. After an uncertain
  response, refresh or retry the same reference; do not invent a new collection.
- **Service settlement:** find the booking and mark each service performed/not
  performed. Review the full performed-service charge; the fee is separate.
  Verify collection and finalize once. Partial/split settlement is unavailable.
- If all services were not performed, finalize no-service closure. No fake zero
  payment, service receipt or commission is created; existing fee history remains.
- Use receipt controls for each stored receipt. Confirm the correct receipt and
  printer/page size in the print dialog. Report a printing/layout issue before
  issuing an incorrect receipt.
- **Collections:** select inclusive salon-local dates. Net cash movement reflects
  recorded payment adjustments and is not profit. Review applied/unapplied and reconciliation values.
- A stale-review error requires Refresh appointment and a new review. Ask an Admin
  to correct saved outcomes before finalization. Finalized outcomes cannot be edited.

## Admin

Development seed skills are configured in `backend/prisma/seed.ts` under `staffFixtures`. Set each person's `serviceNames` to exact service catalog names and `commissionRate` to a decimal fraction (for example `"0.4000"` for 40%). An empty list gives no qualifications. Mildred's initial list contains Manicure, Pedicure, Manicure & Pedicure, Gel Polish, and Nail Art. Other staff retain the previous all-service development defaults until their actual skills are specified; replace `allServiceNames` with their individual lists. Reseeding re-enables listed qualifications and deactivates unlisted ones without deleting records. The seed refuses production and databases containing appointments; use Manage skills for an existing salon database.

- Manage accounts and deactivate access when no longer needed. Configure real salon
  profile, catalog, staff, qualifications, commissions, hours, schedules and policies.
- Policies apply prospectively. Historical bookings keep their governing policy and
  transactional snapshots. Deactivate referenced records rather than deleting them.
- Review appointments and mark no-show only after the start and salon procedure.
  Do not use no-show as a general cancellation override.
- Review/correct saved outcomes before finalization. Cashiers perform settlement.
- Inspect finalized commissions, historical receipts, payment reconciliation and
  authorized reports/audits. Carried credit is not a second payment.
- Reconcile actual merchant captures with the source transaction identity. Never
  manually record an already captured online payment as a new collection.

## Failures and daily close

If a submission times out, refresh the booking/payment/settlement state first.
Preserve the original reference and contact the operator with the booking code,
time, action, safe error message and request ID if shown. Never send private tokens,
passwords, API keys or full customer records in an ordinary incident report.

At daily close, compare Cashier collection totals with cash and merchant records.
Admin reviews required reconciliation and commissions. The operator reviews worker
health, notification failures and backups using DEPLOYMENT.md. A provider status of
SENT means provider acceptance; it does not guarantee inbox or handset delivery.

## Salon acceptance and release sign-off

Run representative guest/Admin/Cashier visits using approved test data. Confirm
service names/prices/durations, hours, policy wording, receipt content, commission
rates, accessibility on actual devices, printer output and provider delivery.
Record reviewer, date, environment, results and unresolved issues in
ACCEPTANCE_BACKLOG.md. The salon owner approves opening real bookings only after
release gates are satisfied. Local developer tests do not substitute for that sign-off.

Automatic no-show marking runs in the hold worker (`npm run start:holds`, or `npm run worker:holds` during development). Apply the check-in migration and deploy/restart the API and frontend first so staff can record arrivals, then restart the updated worker. It checks roughly every five seconds and processes up to 100 overdue eligible appointments per pass. Only CONFIRMED appointments without check-in, completion or recorded active service outcomes become NO_SHOW at/after scheduled start plus 15 minutes. Recovery policy and fee history are preserved. Monitor `automatic_no_show_failed` errors; failed transactions retry on subsequent worker passes. After downtime the worker catches up overdue eligible visits. Before enabling it against existing data, review unresolved appointments whose arrivals were never recorded.

Customer check-in: after applying database migrations and restarting the backend, Cashier/Admin can use Confirmed services → Check in customer → Confirm arrival. Admin can also check in from Appointments → View details. Verify the customer name and booking code and confirm physical arrival. Check-in is available only on the scheduled salon date; arrival time and recording staff are shown after saving. It records arrival separately from service outcomes and leaves the appointment confirmed. Repeated confirmation does not change the original time/staff. Checked-in visits cannot be manually marked no-show or changed through customer workflows. Record arrival promptly: missing check-in can still lead to automatic no-show marking. Use the dedicated checked-in waiting queue to review unresolved arrivals. If automatic marking has already committed, ordinary check-in cannot restore the appointment; an Admin can use the correction action described below when eligible.

Admin no-show correction: open Appointments → select a NO_SHOW booking → Correct no-show / late arrival. Enter the reason, confirm the customer is physically present, and select Restore and check in. The system checks original staff availability including buffers before restoring and checking in the visit. It rejects ended visits, visits on another date, existing replacement bookings, recorded service activity, and unavailable staff time. Restoration keeps original prices, staff, times, fee history and policy. Review the BOOKING_NO_SHOW_CORRECTED audit record for the previous no-show timestamps, reason and correcting account. If rejected, arrange a new available booking; restoration never extends the original slot.

Checked-in waiting queue: available on the Cashier dashboard/appointments screen and Admin dashboard/appointments screen. Oldest check-ins appear first across all dates. Search by customer or booking code; use Review services to open the existing workspace. The queue displays arrival, recording staff, assigned services/stylists, and elapsed minutes since check-in using server time. Refreshes every 30 seconds while visible and when the screen regains focus; manual refresh and retry are available. Check-ins/corrections on the same screen refresh it immediately. Visits past scheduled end are flagged Needs review and remain visible until resolved. Service start is not tracked separately: confirm with the stylist before assuming the customer is still waiting. Recording an active service outcome removes the appointment from this queue; settlement remains available through Confirmed services.
