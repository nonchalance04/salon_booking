# Cashier workflow

Cashiers land on **Check-in & payments**, with two separate searchable, paginated
lists that refresh every 30 seconds while visible and when returning to the tab.

## Customer check-in

The **Customer check-in** list shows today's confirmed, uncompleted appointments
with active services and no recorded/finalized active service outcomes. Dates use
the salon timezone. Search by customer name or booking code, choose **Check in
customer**, and choose **Confirm arrival** only when the customer is physically
present. Already checked-in visits show the arrival time and recording staff.

Check-in lets the cashier acknowledge arrival at the front desk without waiting
for an Admin. It protects present customers from automatic no-show marking and
puts them in the staff waiting queue for follow-up. The server records arrival
time and the authenticated cashier in the audit history. Repeated check-ins keep
the original arrival and actor. Arrival leaves the appointment CONFIRMED; it does
not record service performance, completion, or payment. Other-date and NO_SHOW
visits cannot use ordinary check-in; eligible no-show corrections remain Admin-only.

## Service payments

**Ready for payment** shows confirmed, uncompleted visits across all dates only
when all active outcomes are recorded and a positive performed-service charge is
due. Admins record and correct service outcomes and close no-service visits.

1. Choose **Process payment** and review the customer, services and fee history.
2. Review the itemized performed-service charge. Appointment fees remain separate
   and are never deducted from the service payment.
3. Select the received payment method. Cash requires sufficient tendered money
   and calculates change in whole centavos. GCash prompts verification against
   the salon's received transaction. All methods generate a salon payment reference
   automatically and require confirmation that the money was received.
4. Finalize, print the generated receipt, then choose **Finish & return to appointments**.
   The lists refresh after settlement. Use the expandable booking-code lookup for
   payment review and existing receipts; it cannot bypass settlement prerequisites.

The manual appointment-fee API keeps its existing fee recording and receipt workflow;
the separate cashier fee menu remains removed.
It also generates the salon reference automatically for every payment method.
Existing collection APIs provide permitted date-range summaries by original payment
method. Totals cover the salon. Collections use `paidAt`, and appointment counts
use scheduled `startAt`. Net movement includes recorded payment adjustments.
Carried fee credits are not new collections. Cash tendered and change are a checkout
aid and are not persisted as separate financial transactions. Drawer opening floats,
counted cash, cash withdrawals and saved shift-closing discrepancies remain future
features.

## Validation

- Backend unit suite: `cd backend && npm test`.
- Reporting and settlement integration tests require a disposable PostgreSQL
  server: set `TEST_DATABASE_ADMIN_URL`, then run
  `node --import tsx --test tests/integration/appointments.test.ts tests/integration/reports.test.ts tests/integration/settlement.test.ts`.
  These check salon date boundaries, pagination, privacy, authorization, exact
  method totals, full settlement, duplicate protection and atomic receipts.
- Frontend money tests: `cd frontend && npm test`.
- Type checking/build: `cd backend && npm run typecheck`; `cd frontend && npm run build`.
- Browser check: as a Cashier find a confirmed visit for today, confirm physical
  arrival, and verify the arrival time and recording staff appear. As an Admin,
  verify the visit appears in the waiting queue.
- Payment browser check: as an Admin record outcomes for a confirmed booking, then as a Cashier verify insufficient
  cash disables finalization, verify PHP 1,000 tendered for PHP 780.30 produces
  PHP 219.70 change, finalize in a test environment, and check the receipt and
  refreshed queue/collection totals. An existing PHP 100 appointment fee must
  remain separate, producing PHP 880.30 total collections in this example.
