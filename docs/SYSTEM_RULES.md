# Salon Booking and Appointment System

## System Rules v1.0

This document defines the authoritative business rules for the Salon Booking and Appointment System.

Application code must conform to these rules unless a later approved version explicitly changes them.

The rules in this document represent the MVP behavior. Configurable values may be changed later through approved booking-policy versions without requiring the overall architecture to be redesigned.

---

# 1. System Actors

The system has three external actors:

1. Customer / Guest
2. Admin
3. Cashier

Salon staff/stylists are operational entities but do not have user accounts or dashboards in the current MVP.

---

# 2. Customer / Guest Rules

A customer may use the booking system without creating an account.

A customer may:

- Browse active salon services.
- View service prices and durations.
- Select one or more services. Customer booking and availability APIs enforce one service per category and no duplicate services, including rescheduling and no-show recovery requests. The approved booking categories are Hair Services, Hair Color & Styling, Hair Treatments, Nail Services, and Spa & Relaxation. Customers may combine one service from each, including a haircut, color, and treatment in one appointment. Variants within a category remain mutually exclusive. Categories are compared after trimming whitespace and ignoring case. The booking UI replaces the previous choice when another service in the same category is selected.
- Choose a specific qualified staff member for each service.
- Choose Any Available Staff for each service.
- Select an available appointment date and starting time.
- Enter customer/contact information.
- Pay the required appointment fee.
- Receive booking confirmation.
- Retrieve and view an appointment securely.
- Reschedule an eligible appointment.
- Change date and time during rescheduling.
- Change selected services during rescheduling.
- Change assigned staff during rescheduling.
- Cancel an eligible appointment.
- Request an allowed no-show recovery booking.
- Receive booking-related notifications.

A customer may not:

- Modify salon services.
- Modify staff records.
- Modify staff schedules.
- Override availability rules.
- Override booking policies.
- Record service payments.
- Modify service outcomes.
- Modify commission information.

---

# 3. Admin Rules

An Admin may:

- Manage services.
- Manage staff.
- Assign services that staff members are qualified to perform.
- Manage salon operating hours.
- Manage salon closures.
- Manage staff schedules.
- Manage staff unavailable periods.
- View appointments.
- Mark eligible appointments as NO_SHOW.
- Record and correct service outcomes before final post-service settlement or no-service closure.
- Record customer arrival.
- Finalize eligible zero-charge no-service closures.
- Manage booking policies.
- View payments.
- View receipts.
- View commission records.
- View reports and analytics.
- Manage Admin and Cashier user accounts.
- View audit logs.

Administrative override functionality for rescheduling, cancellation, or post-settlement financial corrections is outside the initial MVP unless explicitly added later.

Administrative actions must never bypass data-integrity, authorization, scheduling, or concurrency rules.

---

# 4. Cashier Rules

A Cashier may:

- View appointments relevant to customer arrival and post-service settlement.
- Record physical customer arrival for eligible confirmed appointments.
- Record and correct service outcomes before finalization.
- Correct eligible no-shows with a reason and confirmation of physical presence.
- View booked services.
- View customer information required for payment processing.
- View the appointment-fee payment status.
- Record the final service payment when a positive service amount is due.
- Select the payment method used.
- Generate and print receipts for successful financial payments.
- View permitted collection summaries.

A Cashier may not:

- Finalize no-service closures.
- Manage services.
- Manage staff.
- Manage staff schedules.
- Change customer booking information.
- Reschedule appointments.
- Cancel appointments.
- Mark appointments as NO_SHOW.
- Modify booking policies.
- Manually override commission formulas or finalized commission values.

---

# 5. Service Rules

Each service contains at least:

- Name.
- Description.
- Current price.
- Duration.
- Optional service-specific buffer time.
- Active/inactive status.

For the MVP, an active bookable service must have a price greater than PHP 0.

Zero-priced or complimentary bookable services are not supported in the initial MVP.

Inactive services must not be available for new bookings.

Historical appointments must preserve the service details that existed when the AppointmentService was created.

Changes to the current service name, price, duration, or buffer must not automatically modify historical AppointmentService snapshots.

---

# 6. Staff Qualification Rules

A staff member may perform only services for which they are qualified.

Staff-service qualifications are explicitly configured by the Admin.

Admins can manage a staff member's qualifications together using service checkboxes grouped by the Service category (for example Hair Services or Nail Services). Categories organize the list and do not grant eligibility: each service must be individually selected. Staff may qualify for services in multiple categories; staff with no active qualifications cannot receive new assignments.

Saving skills updates qualifications in one audited transaction, retaining deactivated records and reusing them when re-enabled. Removing a qualification needed by an existing blocking reservation is rejected together with all other changes in that save. Existing appointment commission snapshots remain unchanged.

Before assigning a staff member to a service, the system must verify that:

1. The staff member is active.
2. The service is active for newly added services.
3. The staff member has an active qualification for the service.
4. The staff member is scheduled to work.
5. The staff member is not unavailable.
6. The staff member has no conflicting reservation during the required interval.

Existing historical appointments retain their stored service and staff information even if the current Service, Staff, or StaffService record later becomes inactive.

---

# 7. Staff Selection

Staff selection applies to each AppointmentService rather than to the appointment as a whole.

For every selected service, the customer may choose:

- Specific Staff
- Any Available Staff

## Specific Staff

If a customer selects a specific staff member, the system must validate that staff member against all qualification and availability rules for that AppointmentService interval.

## Any Available Staff

If Any Available Staff is selected, the system must find a qualified and available staff member for that AppointmentService.

For the MVP, staff assignment must use a deterministic strategy.

The required strategy is:

1. Determine all active staff qualified for the service.
2. Remove staff who cannot cover the entire required interval.
3. Remove staff with unavailability.
4. Remove staff with conflicting reservations.
5. Compare remaining staff using their reserved workload for the target salon-local date.
6. Workload is measured as the total reserved minutes from blocking PENDING_PAYMENT and CONFIRMED AppointmentService intervals for that date.
7. Prefer the staff member with the lowest reserved workload.
8. If workload is equal, use staff ID ascending as the deterministic tie-breaker.

For appointments containing multiple services, assignment must find a feasible combination across the complete sequential service plan rather than permanently committing to an earlier staff choice that makes a later service impossible.

A bounded combination/backtracking search may be used for the small number of services and staff expected in the salon MVP.

The system must not use AI to make authoritative staff-availability decisions.

---

# 8. Salon Availability Rules

A booking may be offered only when all relevant availability conditions pass.

The system must consider:

- Salon operating hours.
- Salon closures.
- Staff schedule.
- Staff unavailability.
- Staff-service qualification.
- Full service duration.
- Service buffer time.
- Existing blocking reservations.
- Active temporary booking holds.
- Booking lead time.
- Advance-booking limit.

A failure of any required condition makes the staff member unavailable for that requested interval.

Availability shown to a customer is advisory until the reservation is successfully created transactionally.

Available appointment starts are offered at 15-minute intervals in the salon's
local time (for example, 9:00 AM, 9:15 AM, 9:30 AM, and 9:45 AM). Round up to the
next interval when opening hours or booking lead time fall between these starts.
Each offered start must still satisfy the full service duration and preparation
buffer rules. Exact-time validation remains supported for existing schedules;
the displayed interval does not replace staff reservation conflict checks.

---

# 9. Full-Duration Scheduling Rule

Availability must be checked against the complete reserved staff interval, not only the service start time.

Example:

Service duration: 120 minutes  
Buffer: 15 minutes  
Requested start: 10:00 AM

The service itself occupies:

10:00 AM through 12:00 PM.

The assigned staff member remains reserved through:

12:15 PM.

Another appointment assigned to the same staff member must not overlap the reserved interval.

---

# 10. AppointmentService Scheduling Rule

`AppointmentService` is the authoritative staff scheduling unit.

Each AppointmentService must store its own:

- Assigned staff member.
- Scheduled start time.
- Scheduled end time.
- Reserved-until time including buffer.

Staff conflicts must be checked against AppointmentService reservation intervals.

The overall Appointment may store summary start/end timestamps, but those values must not replace AppointmentService intervals for availability calculations.

For the MVP:

- `Appointment.startAt` is the earliest AppointmentService scheduled start.
- `Appointment.endAt` is the scheduled end of the final service, excluding its trailing staff buffer.
- Individual staff buffers remain represented through `AppointmentService.reservedUntilAt`.

---

# 11. Overlap Rule

Two staff reservations conflict when:

`newStart < existingReservedEnd`

AND

`newReservedEnd > existingStart`

Adjacent reservations are permitted only when the previous staff reservation, including buffer time, has already ended.

Example:

Existing staff reservation:

10:00 AM–11:15 AM

A new appointment starting at exactly 11:15 AM may be valid.

A new appointment starting before 11:15 AM conflicts.

---

# 12. Parallel Booking Rule

Different staff members may serve different customers at the same time.

Example:

10:00 AM

Anna → Customer A  
John → Customer B

This is valid if both staff members are independently qualified and available.

The same staff member must never be assigned to overlapping reservation intervals.

Parallel appointments between different customers are supported.

---

# 13. Multi-Service Booking

One appointment may contain multiple AppointmentService records.

For the MVP, services belonging to the same customer appointment are scheduled sequentially.

Concurrent services for the same customer are intentionally outside the initial MVP because customer-level service compatibility rules would otherwise be required.

Each selected service has its own:

- Sequence number.
- Staff assignment.
- Service snapshots.
- Scheduled start.
- Scheduled end.
- Reserved-until timestamp.

For sequential scheduling:

1. The first service begins at the appointment start selected by the customer.
2. The next service begins after the previous service's reserved interval ends.
3. Therefore, the previous service's buffer is included before the customer's next service begins.
4. The same or a different qualified staff member may perform the next service.

Example:

Haircut  
9:00 AM–10:00 AM  
Buffer until 10:15 AM

Hair Coloring  
10:15 AM–12:15 PM  
Buffer until 12:30 PM

Different customers may still be served concurrently by other available staff.

Each service must be represented separately using AppointmentService.

---

# 14. Appointment Lifecycle

The appointment statuses are:

- PENDING_PAYMENT
- CONFIRMED
- COMPLETED
- CANCELLED
- NO_SHOW
- EXPIRED

## Normal Successful Flow

PENDING_PAYMENT  
→ CONFIRMED  
→ COMPLETED

## Payment Hold Expiration

PENDING_PAYMENT  
→ EXPIRED

## Cancellation

CONFIRMED  
→ CANCELLED

subject to cancellation policy.

## No-Show

CONFIRMED  
→ NO_SHOW

## Standard Completion With Performed Services

When at least one AppointmentService is PERFORMED, an appointment becomes COMPLETED only after:

1. All service outcomes have been finalized.
2. At least one AppointmentService is PERFORMED.
3. The full required SERVICE_PAYMENT has successfully settled.
4. Required commission records have been finalized.

## Zero-Charge No-Service Completion

When every AppointmentService is finalized as NOT_PERFORMED, the appointment may still be validly closed as COMPLETED through the no-service closure workflow defined in Section 27.

In that case:

- No SERVICE_PAYMENT is required.
- No zero-value Payment record is created merely to force lifecycle completion.
- No commission records are created.
- The existing appointment-fee payment remains historically unchanged.
- The closure is audit logged.
- Finalized service outcomes become immutable.

Therefore, COMPLETED means the appointment's operational and financial handling is closed, not necessarily that one or more services were successfully performed.

`RESCHEDULED` is not an appointment status.

Ordinary rescheduling updates the existing eligible appointment and records reschedule history.

A no-show recovery is handled differently and is defined in Section 24.

---

# 15. Temporary Booking Hold

When the customer enters the appointment-fee payment process, the reservation enters:

`PENDING_PAYMENT`

The default MVP value is:

`bookingHoldMinutes = 10`

While:

- the appointment remains PENDING_PAYMENT, and
- the current system time has not passed `holdExpiresAt`,

its AppointmentService intervals block the relevant staff.

If appointment-fee payment is successfully processed while the hold is still active:

PENDING_PAYMENT  
→ CONFIRMED

If the hold expires first:

PENDING_PAYMENT  
→ EXPIRED

Expired reservations no longer block availability even if an asynchronous expiration job has not yet updated the stored appointment status.

Availability calculations must therefore consider both status and `holdExpiresAt`.

---

# 16. Booking Concurrency

The availability previously displayed to a customer is not proof that the slot is still available during final booking submission.

Booking creation must use transaction/concurrency protection.

The backend must:

1. Begin the required database transaction and locking strategy.
2. Revalidate salon operating rules.
3. Revalidate staff qualification.
4. Revalidate staff schedules.
5. Revalidate staff unavailability.
6. Recheck blocking AppointmentService intervals.
7. Resolve Any Available Staff assignments.
8. Create the Appointment and all AppointmentService records only if the complete reservation is still valid.
9. Commit the transaction.

If another reservation obtains any required staff interval first, the later request must fail safely with a conflict response.

Double booking must never be accepted simply because multiple customers previously saw the same availability result.

---

# 17. Appointment Fee

The MVP uses a configurable fixed appointment fee.

Initial MVP configuration:

- Fee type: FIXED
- Amount: PHP 100

The amount must come from the applicable BookingPolicyVersion rather than being hardcoded throughout the application.

The database design may allow future percentage-based fee policies, but percentage fee calculation is outside the first MVP.

The appointment fee is separate from the post-service charge.

---

# 18. Payment Types

The system supports two primary payment types:

1. APPOINTMENT_FEE
2. SERVICE_PAYMENT

Appointment-fee payment is used to confirm the booking.

SERVICE_PAYMENT is used after services have been performed.

Payment status and Appointment status remain separate concepts.

---

# 19. Payment Status and Idempotency

Payment statuses include:

- PENDING
- SUCCEEDED
- FAILED
- EXPIRED
- REFUNDED

A successful payment event must be processed idempotently.

Repeated callbacks or repeated manual requests for the same transaction must not create duplicate:

- Successful payments.
- Receipts.
- Appointment confirmations.
- Commission records.
- Collection totals.

External references and/or internal idempotency keys must be used where applicable.

---

# 20. Payment Timing, Hold Expiration, and Late Success

For reservation safety, system-side processing while the booking hold is still active is authoritative for automatic appointment confirmation.

A payment provider's earlier payment timestamp by itself must not restore an appointment after the system has already released the reservation.

Appointment-fee success processing must transactionally lock/reload the Appointment and verify:

1. Appointment status is still PENDING_PAYMENT.
2. Current system time is not later than `holdExpiresAt`.
3. Required AppointmentService reservations are still owned by that appointment.

Only then may the appointment transition to CONFIRMED.

If the hold has already expired:

- The Appointment remains or becomes EXPIRED.
- The reservation must not automatically be restored.
- Existing reservations belonging to another customer must never be displaced.
- A late successful payment must still be recorded accurately as a successful financial transaction.
- The transaction must be flagged for administrative reconciliation.
- The system may subsequently refund the payment or resolve it manually according to salon procedure.
- No automatic appointment confirmation or commission calculation occurs from the late payment.

Payment-provider checkout expiration should be configured as closely as practical to the system booking-hold deadline to minimize this situation.

Expiration processing and payment-success processing must use compatible locking/transaction rules so they cannot independently finalize contradictory appointment states.

---

# 21. Payment Provider Boundary

External payment providers must be accessed through an application abstraction.

Core booking logic must not depend directly on provider-specific APIs.

The application should support:

- An online payment provider such as GCash when credentials/API access are available.
- Manual/local payment recording where appropriate.

Failure or unavailability of an external provider must be handled without corrupting booking records.

External payment services must not be allowed to bypass authoritative reservation validation.

---

# 22. Ordinary Rescheduling Rules

An eligible CONFIRMED appointment may be rescheduled.

A customer may request changes to:

- Appointment date.
- Appointment start time.
- Selected services.
- Assigned staff.

Rescheduling must revalidate the proposed replacement schedule almost as if it were a new booking.

The system must:

1. Load and lock the existing appointment where required.
2. Verify that it is eligible for ordinary rescheduling.
3. Check the maximum reschedule count.
4. Check the reschedule cutoff.
5. Apply proposed service/staff/date/time changes.
6. Rebuild the sequential AppointmentService schedule.
7. Revalidate staff qualification.
8. Revalidate availability.
9. Recheck conflicts.
10. Ignore the appointment's own current AppointmentService intervals only for purposes of testing its proposed replacement schedule.
11. Ensure all conflicts from other appointments are still enforced.
12. Atomically replace/update the active schedule only if the new schedule succeeds.
13. Increment the reschedule count.
14. Save complete reschedule history.

The original reservation must remain valid until the replacement schedule has been completely validated.

If the proposed reschedule fails, the original booking remains unchanged.

---

# 23. Rescheduling Snapshots

Rescheduling must preserve historical transactional values correctly.

## Retained Services

If an existing AppointmentService remains part of the appointment:

- Its original service name snapshot remains.
- Its original price snapshot remains.
- Its original duration snapshot remains.
- Its original buffer snapshot remains.
- Its original commission-rate snapshot remains.

Date/time and staff assignment may change if requested and valid.

## Added Services

A newly added service must use current active values at the time of rescheduling:

- Current service name.
- Current price.
- Current duration.
- Current applicable buffer.
- Current applicable commission rate.

Those values become new snapshots.

Inactive services cannot be newly added.

## Removed Services

Removed services must no longer appear in the active AppointmentService schedule.

Their previous state must remain recoverable through reschedule history.

## Inactive Retained Services

A service that became inactive after the original booking may remain as a retained booked service during a date/time-only reschedule.

However, if the customer removes it, it cannot be added again while inactive.

If a staff assignment must change, the newly assigned staff member must have an active qualification for the retained service.

---

# Customer Arrival / Check-In

An active Admin or Cashier may record arrival for a CONFIRMED, uncompleted appointment on its scheduled salon-local date. Early arrival on that date is allowed; check-in on another date or after recorded active service outcomes is rejected. Staff must confirm the customer is physically present.

Check-in records `checkedInAt` using server/database time and `checkedInByUserId` using the authenticated account. These fields are recorded atomically with a BOOKING_CHECKED_IN audit event. Repeated or concurrent check-ins preserve the first arrival and first actor and do not duplicate audit events. Clients cannot supply the timestamp or actor.

Check-in leaves status CONFIRMED and does not record service performance, completion, payment, or a new reservation interval. Checked-in appointments cannot be marked NO_SHOW or changed/cancelled through customer workflows. Staff views show arrival time and the recording staff member. An Admin can correct eligible no-shows through the audited correction workflow below; the checked-in waiting queue below supports staff follow-up. Automatic no-show marking uses this arrival record to protect present customers.

---

# 24. No-Show and No-Show Recovery

An Admin may mark a CONFIRMED appointment NO_SHOW when the customer fails to appear according to salon procedure.

The hold worker automatically marks an appointment NO_SHOW once 15 minutes have elapsed from its scheduled start, only when status is CONFIRMED, there is no check-in, no completion record, and no recorded active service outcome or finalized outcome timestamp. Removed service rows do not establish activity for the current visit. Eligibility is inclusive at the deadline and is revalidated against database time under the same locks used for check-in and settlement. Checked-in customers remain protected even while waiting for a stylist.

Automatic marking sets noShowAt, uses the original appointment policy to calculate the recovery deadline from the scheduled start, releases availability through the NO_SHOW status, and writes one SYSTEM BOOKING_NO_SHOW audit event atomically. Repeated/competing workers do not duplicate the transition or audit. The worker checks roughly every five seconds while running, processes up to 100 eligible appointments per pass, and catches up overdue eligible appointments after downtime. This is not an exact-time scheduler.

If check-in commits first, automatic marking skips the visit. If automatic marking commits first, ordinary check-in rejects the NO_SHOW visit; it does not restore a released reservation. An eligible Admin correction can restore and check in the customer as described below. Staff must record physical arrival promptly; forgetting check-in can still result in a no-show when no service activity is recorded.

The MVP default is:

`noShowGraceHours = 72`

The grace deadline is calculated from the original appointment start time, not from the time the Admin eventually marks the appointment NO_SHOW.

A NO_SHOW appointment remains a historical record of the missed occurrence unless an Admin corrects the classification under the exception below. The original audit event always remains.

Ordinary customer recovery must not transition it back to CONFIRMED. The Admin correction exception below may restore a mistakenly marked no-show or an eligible late arrival.

If no-show recovery is allowed:

1. The customer may request one replacement booking within the grace period.
2. The ordinary reschedule cutoff does not apply because the original appointment has already been missed.
3. The maximum-reschedule policy still applies.
4. The replacement increments the effective reschedule count.
5. The original Appointment remains NO_SHOW permanently.
6. A new Appointment is created and linked to the original as its no-show recovery/replacement.
7. The replacement uses the original appointment's BookingPolicyVersion.
8. Availability, qualification, scheduling, and concurrency rules are fully revalidated.
9. The missed AppointmentService intervals remain historical and do not block future availability.
10. Only one no-show recovery appointment may be created from the same NO_SHOW appointment.

## Staff No-Show Correction / Late Arrival

An active Admin or Cashier may restore an unresolved NO_SHOW to CONFIRMED only with a nonblank reason and explicit confirmation that the customer is physically present. The visit must be on the current salon date and its original end time must not have passed. It must have active services, no linked replacement booking (including cancelled/expired replacements), no check-in, no completion record and no recorded active service outcomes.

Under the same salon/staff/appointment locks as booking and recovery, verify the full original active service intervals including buffers against current operating hours, staff schedules, active staff and qualifications, closures, unavailability and blocking reservations (including live payment holds). Existing service snapshots are retained; this action does not move or extend the visit. If any original interval is unavailable or the visit has ended, reject restoration and arrange a new available booking.

Restoration sets CONFIRMED and records check-in at fresh database time by the correcting staff member, preventing immediate automatic no-show marking. Clear the current noShowAt and recovery deadline fields, and preserve their previous values, the original no-show event, correcting staff member and reason in the audit history. Write BOOKING_NO_SHOW_CORRECTED atomically with restoration. No payment, refund, fee credit, reschedule count or policy changes occur. Concurrent duplicate corrections cannot create duplicate restoration audit events. Ordinary check-in and customer recovery cannot perform this exception.

## No-Show Recovery With Valid Carried Appointment-Fee Credit

A previously collected appointment fee may be carried forward only when:

- The original APPOINTMENT_FEE payment is SUCCEEDED.
- That payment has not been refunded.
- The amount satisfies the appointment-fee requirement of the BookingPolicyVersion governing the replacement.
- The payment has not already been carried forward to another replacement.
- The no-show recovery is otherwise eligible.

When those conditions are satisfied:

1. The replacement appointment and all AppointmentService records are validated using normal scheduling and concurrency rules.
2. Creation of the replacement and application of the carried credit occur atomically.
3. The new replacement Appointment is created directly as `CONFIRMED`.
4. No new APPOINTMENT_FEE collection is created.
5. No duplicate successful Payment record is created merely to represent the carried credit.
6. The original successful payment remains attached to its original financial transaction history.
7. The replacement Appointment stores an explicit reference to the source appointment/payment or equivalent credit-allocation record defined by the database design.
8. The credit is marked as consumed for that recovery so it cannot be reused.
9. The audit log records that the replacement was confirmed using carried appointment-fee credit.

This workflow does not create a temporary PENDING_PAYMENT hold because no additional appointment-fee payment is required.

## No-Show Recovery Without Valid Carried Credit

If valid carried credit is not available:

1. The replacement booking follows the normal booking flow.
2. It is created as PENDING_PAYMENT.
3. A normal booking hold applies.
4. The required APPOINTMENT_FEE must be successfully paid within the hold period.
5. Successful timely payment transitions the replacement to CONFIRMED.
6. Hold expiration transitions it to EXPIRED.

The system must never create a PENDING_PAYMENT recovery that is waiting for a payment the business rules have already considered satisfied.

---

# 25. Cancellation Rules

Cancellation eligibility is governed by the BookingPolicyVersion attached to the appointment.

A customer may cancel a CONFIRMED appointment when:

`currentTime <= appointment.startAt - cancellationCutoff`

At exactly the cutoff boundary, cancellation is allowed.

After the cutoff has passed, direct customer cancellation is denied and the customer may be instructed to contact the salon.

For the first MVP:

- Automated appointment-fee refunds are not required.
- Cancelling an appointment releases its future AppointmentService reservation intervals immediately.
- Historical appointment/service data remains preserved.

---

# 26. Service Outcomes

The MVP does not implement detailed on-chair workflow states such as:

- STARTED
- PAUSED
- IN_PROGRESS

Each AppointmentService uses a final operational outcome:

- SCHEDULED
- PERFORMED
- NOT_PERFORMED

Before post-service settlement or no-service closure, an active Admin or Cashier records final service outcomes.

An active Admin or Cashier may correct those outcomes before finalization.

A CONFIRMED appointment may contain:

- One or more PERFORMED services, or
- All NOT_PERFORMED services.

A mixture of PERFORMED and NOT_PERFORMED services is allowed.

After either:

- successful full SERVICE_PAYMENT settlement, or
- successful zero-charge no-service closure,

the service outcomes become immutable in the MVP.

Post-finalization correction, void, refund, or financial-adjustment workflows are outside the first MVP and require a later explicitly designed process.

---

# 27. Post-Service Settlement and No-Service Closure

The initial MVP supports two valid post-appointment closure paths.

## Path A — Performed-Service Settlement

This path applies when at least one AppointmentService is PERFORMED.

For each appointment:

- Only one successful SERVICE_PAYMENT is supported.
- It must settle the entire charge for all PERFORMED services.
- Partial payments are not supported.
- Split-tender payments are not supported.
- Installments are not supported.
- Multiple successful SERVICE_PAYMENT settlements are not supported.

The amount due is:

`sum(actual charge for all PERFORMED AppointmentService records)`

NOT_PERFORMED services are excluded from the amount due.

Because active bookable services must have a positive price in the MVP, an appointment with at least one PERFORMED service must have a positive SERVICE_PAYMENT amount.

Before accepting settlement, the system must verify:

1. The appointment is CONFIRMED.
2. All service outcomes have been finalized.
3. At least one AppointmentService is PERFORMED.
4. No successful SERVICE_PAYMENT already exists.
5. The submitted amount equals the full required service-payment amount.

Successful settlement transactionally:

1. Records SERVICE_PAYMENT as SUCCEEDED.
2. Creates the applicable receipt.
3. Finalizes commission records.
4. Transitions the Appointment to COMPLETED.
5. Makes service outcomes immutable.
6. Creates required audit entries.
7. Queues applicable notifications.

Repeated manual submissions must be idempotent and must not create duplicate collections.

## Path B — Zero-Charge No-Service Closure

This path applies only when **every AppointmentService is finalized as NOT_PERFORMED**.

Examples may include:

- Customer attended but declined all scheduled services.
- Salon and customer mutually decided not to proceed after arrival.
- Services could not be performed, but the customer should not be classified as NO_SHOW.

Before closing the appointment, the system must verify:

1. The appointment is CONFIRMED.
2. Every AppointmentService is NOT_PERFORMED.
3. No AppointmentService is PERFORMED.
4. No successful SERVICE_PAYMENT exists.
5. The closure has not already been finalized.

An Admin may then finalize a no-service closure.

The no-service closure transactionally:

1. Does not create a SERVICE_PAYMENT.
2. Does not create a fake PHP 0 payment.
3. Does not create post-service commission records.
4. Does not allocate the appointment fee into commissions.
5. Transitions the Appointment to COMPLETED.
6. Makes all service outcomes immutable.
7. Records the no-service closure in AuditLog.
8. Queues any applicable completion notification.

The previously collected APPOINTMENT_FEE remains historically unchanged and is not automatically refunded.

No additional service-payment receipt is generated because no service-payment financial transaction occurred.

If the business later requires refunds or credits for such situations, that must be introduced through a separate approved adjustment/refund workflow.

Payment correction, partial refund, payment reversal, and post-finalization editing remain outside the first MVP.

---

# 28. Commission Rules

Final commission must not be calculated when the appointment is initially booked.

Commission is finalized only during successful full SERVICE_PAYMENT settlement.

The commission rate is sourced from the applicable StaffService configuration when an AppointmentService is created.

That rate is stored as `commissionRateSnapshot`.

For retained AppointmentServices during ordinary rescheduling, the original commission-rate snapshot remains unchanged.

Newly added AppointmentServices use the current applicable StaffService rate at the time they are added.

The commission formula is:

Commission Base  
= Actual Performed Service Amount  
+ Allocated Eligible Appointment Fee

Commission Amount  
= Commission Base × Commission Rate

Only PERFORMED AppointmentService records are eligible for commission.

## Eligible Appointment Fee

The amount eligible for allocation is the successfully collected appointment fee that has not been refunded.

For an approved no-show recovery booking, a properly carried-forward original appointment fee may be treated as the eligible appointment fee for the replacement booking.

If no eligible appointment fee exists:

`Allocated Appointment Fee = PHP 0`

## Appointment-Fee Allocation

The eligible appointment fee is allocated proportionally according to each PERFORMED AppointmentService's service value.

Example:

Appointment Fee = PHP 100

Anna performed service value = PHP 500  
John performed service value = PHP 1,000

Total performed service value = PHP 1,500.

Anna receives one-third of the appointment-fee allocation.

John receives two-thirds.

The allocation must never exceed the actual eligible appointment fee.

## All Services NOT_PERFORMED

If every AppointmentService is NOT_PERFORMED:

- The appointment may use the zero-charge no-service closure defined in Section 27.
- No SERVICE_PAYMENT is created.
- No CommissionRecord is created.
- No appointment-fee allocation is performed.
- The original appointment-fee payment remains historical and is not automatically treated as staff commission.

## Zero-Priced Performed Services

Zero-priced active bookable services are not supported in the MVP.

Therefore a PERFORMED AppointmentService must have a positive `priceSnapshot`.

If historical or corrupted data produces a PERFORMED AppointmentService with a non-positive charge, settlement must fail validation and require administrative data correction before finalization.

## Precision and Rounding

All intermediate money calculations must use Decimal arithmetic.

Money values are finalized to two decimal places using ROUND_HALF_UP behavior.

For proportional fee allocation:

1. Calculate each exact proportional share at Decimal precision.
2. Round each allocation to two decimal places.
3. Compare the rounded total with the exact eligible appointment-fee amount.
4. If a cent-level remainder exists, assign the remainder deterministically to the eligible AppointmentService with the highest performed service amount.
5. If multiple services have the same highest amount, use the lowest sequence number.
6. If still tied, use AppointmentService ID ascending.

The final sum of all allocated appointment-fee amounts must exactly equal the eligible appointment fee.

Commission amounts are also rounded to two decimal places using ROUND_HALF_UP.

Historical CommissionRecord data must preserve:

- Staff member.
- Appointment.
- AppointmentService.
- Performed service amount.
- Allocated appointment-fee amount.
- Commission base.
- Commission rate.
- Final commission amount.
- Finalization timestamp.

Changing a current commission rate must never modify previously finalized commission records.

---

# 29. Booking Policy Versioning and Precedence

Important booking policies must be versioned.

Policy values may include:

- Appointment fee type.
- Appointment fee amount.
- Booking hold minutes.
- Default buffer minutes.
- Maximum reschedules.
- Reschedule cutoff hours.
- Cancellation cutoff hours.
- No-show grace hours.
- Advance-booking limit.
- Minimum booking lead time.

Every Appointment references the BookingPolicyVersion that governs it.

That policy version remains authoritative throughout the appointment lifecycle for:

- Appointment fee.
- Booking hold behavior.
- Reschedule limits.
- Reschedule cutoff.
- Cancellation cutoff.
- No-show recovery.
- Advance/lead rules where relevant to replacement scheduling.
- Default buffer fallback.

Ordinary rescheduling does not change the Appointment's BookingPolicyVersion.

A no-show recovery Appointment uses the same BookingPolicyVersion as the original NO_SHOW appointment.

New independent appointments use the currently effective BookingPolicyVersion.

Once a policy version has been used by an appointment, it must be treated as immutable.

A policy change requires creation of a new BookingPolicyVersion.

---

# 30. MVP Booking Policy Defaults and Time Boundaries

The initial configurable MVP defaults are:

- Appointment fee type: FIXED
- Appointment fee amount: PHP 100
- Booking hold: 10 minutes
- Default buffer: 15 minutes
- Maximum ordinary/recovery reschedules: 2
- Reschedule cutoff: 4 hours
- Cancellation cutoff: 4 hours
- No-show grace: 72 hours
- Advance-booking limit: 30 days
- Minimum booking lead time: 60 minutes

These are configuration values and may be changed through later policy versions.

## Buffer Precedence

If a service has an explicit buffer value, use that value.

If the service buffer is absent/null, use the BookingPolicyVersion default buffer.

An explicit service buffer of zero means zero and must not be replaced by the default.

## Booking Lead Time

A requested appointment is valid only when:

`appointment.startAt >= currentTime + minimumBookingLeadTime`

Equality is allowed.

Past appointments cannot be booked.

## Advance Booking

A requested appointment is valid only when:

`appointment.startAt <= currentTime + advanceBookingLimit`

Equality is allowed.

## Reschedule Cutoff

Ordinary rescheduling is allowed when:

`currentTime <= appointment.startAt - rescheduleCutoff`

Equality is allowed.

## Cancellation Cutoff

Cancellation is allowed when:

`currentTime <= appointment.startAt - cancellationCutoff`

Equality is allowed.

## No-Show Grace

The grace window expires:

`original appointment.startAt + noShowGraceHours`

The default 72-hour period is an elapsed-time duration, not three separate calendar dates.

All calculations must use the salon's configured timezone correctly.

---

# 31. Configuration Changes and Existing Reservations

Admin configuration changes must not silently invalidate existing active reservations.

The following may affect appointments:

- Salon operating hours.
- Salon closures.
- Staff schedules.
- Staff unavailability.
- Staff active status.
- Service active status.
- StaffService qualification status.

For the MVP, if a proposed configuration change would make an existing future blocking appointment invalid, the system must:

1. Detect the affected PENDING_PAYMENT or CONFIRMED appointments.
2. Reject the conflicting configuration change.
3. Return or display the affected appointments to the Admin.

The MVP does not automatically cancel or reschedule those appointments.

The Admin must first ensure the affected appointments are resolved through supported workflows before applying the conflicting configuration change.

Non-conflicting changes apply prospectively to subsequent availability calculations.

Historical appointments are never rewritten because configuration changed later.

---

# 32. Reservation Blocking by Appointment State

Availability must apply these blocking rules.

## PENDING_PAYMENT

Blocks AppointmentService intervals only while:

`currentTime <= holdExpiresAt`

After hold expiration, it no longer blocks even if the stored Appointment status has not yet been updated to EXPIRED.

## CONFIRMED

Blocks all AppointmentService reserved intervals.

## COMPLETED

Does not free a scheduled interval early.

If an appointment is completed before its originally reserved time has fully elapsed, its AppointmentService reservation remains blocking until each original `reservedUntilAt`.

This applies to both:

- normal performed-service completion, and
- zero-charge no-service closure.

## CANCELLED

No longer blocks future reservation intervals after cancellation succeeds.

## NO_SHOW

Once NO_SHOW is recorded, its future remaining reservation intervals no longer block availability.

The historical AppointmentService data remains stored.

## EXPIRED

Does not block availability.

## Rescheduling

During replacement validation:

- The appointment's own existing AppointmentService intervals may be excluded from self-conflict checking.
- All reservations from other appointments remain blocking.
- The old reservation remains authoritative until the replacement schedule commits successfully.

Booking creation and rescheduling must use compatible concurrency protection.

---

# 33. Historical Data Rules

Transactional history must not depend solely on mutable current configuration.

The system must preserve historical values needed to explain a transaction, including:

- Service names.
- Service prices.
- Service durations.
- Buffer durations.
- Commission rates.
- Appointment fees.
- Booking-policy version.
- Previous reschedule state.
- Carried appointment-fee credit source where applicable.

Referenced business records should normally be deactivated rather than deleted when deletion would break historical relationships.

Historical Payment, Receipt, AppointmentService, and CommissionRecord data must not be changed merely because current configuration changes.

---

# 34. Notification Rules

Notification processing must not determine whether the primary booking or settlement transaction succeeds.

Correct flow:

Primary transaction succeeds  
→ Notification is queued  
→ Notification provider attempts delivery

A temporary email/SMS failure must not invalidate a successful booking or payment transaction.

Potential notification events include:

- Booking confirmed.
- Booking rescheduled.
- Booking cancelled.
- No-show recovery created.
- Payment received.
- Appointment completed with no services performed.
- Appointment reminder.

Notification delivery may retry independently.

---

# 35. AI Chatbot Rules

The chatbot may:

- Answer frequently asked salon questions.
- Explain services.
- Explain service prices.
- Explain opening hours.
- Explain appointment policies.
- Explain how to book.
- Explain how to reschedule or cancel.
- Direct customers to booking functionality.
- Request authoritative data through application APIs.

The chatbot may not:

- Directly manipulate PostgreSQL.
- Bypass the booking service.
- Override availability rules.
- Override salon policies.
- Confirm unavailable appointments.
- Bypass payment requirements.
- Invent availability.

The application backend remains the authoritative source for booking and availability decisions.

---

# 36. Money Rules

Persisted monetary values must use PostgreSQL NUMERIC/DECIMAL-compatible values through Prisma Decimal.

Floating-point arithmetic must not be used for authoritative persisted financial calculations.

This applies especially to:

- Service prices.
- Appointment fees.
- Payments.
- Commission bases.
- Commission rates.
- Fee allocations.
- Commission amounts.

Unless another explicit rule applies, finalized PHP money values use two decimal places and ROUND_HALF_UP.

---

# 37. Date and Time Rules

Application timestamps must be stored consistently.

The salon's configured timezone is authoritative for salon scheduling and policy interpretation.

It must be respected when:

- Generating availability.
- Displaying appointment times.
- Applying lead-time rules.
- Applying advance-booking rules.
- Applying reschedule cutoffs.
- Applying cancellation cutoffs.
- Applying hold expiration.
- Determining no-show grace.
- Calculating staff workload by salon-local date.
- Sending reminders.

Timezone conversions must never alter the intended salon-local scheduled appointment time.

---

# 38. Transaction Rules

Database transactions must be used whenever an operation modifies multiple related records whose consistency must be guaranteed.

Critical operations include:

- Appointment creation.
- Any Available Staff assignment.
- Appointment rescheduling.
- No-show recovery creation.
- Carried appointment-fee credit consumption.
- Appointment-fee confirmation.
- Hold expiration when concurrency matters.
- Service-payment settlement.
- Zero-charge no-service closure.
- Receipt creation where coupled to settlement.
- Commission finalization.

Partial completion of these operations must not leave inconsistent transactional data.

External side effects such as SMS/email sending must not occur inside the critical transaction when they can safely be queued afterward.

---

# 39. Authorization Rule

All protected application operations must be authorized on the backend.

Frontend visibility is not a security mechanism.

Examples:

- Admin-only operations must be enforced by the API.
- Service-payment settlement requires an active Cashier. Arrival recording requires an active Admin or Cashier. Outcome recording and no-show correction require an active Admin or Cashier. No-service closure requires an active Admin.
- Customer/Guest appointment-management requests must verify secure appointment access.
- No-show marking must require authorized Admin access.

---

# 40. Guest Appointment Security

Knowing only a booking reference must not automatically grant permission to modify an appointment.

Guest appointment management must use an unguessable secure token or another approved verification mechanism.

Sensitive guest access tokens should not be stored in plaintext where avoidable.

A safe token hash or equivalent secure representation should be persisted.

Guest authorization must be revalidated for protected actions such as:

- Viewing sensitive booking information.
- Rescheduling.
- Cancelling.
- Requesting no-show recovery.

---

# 41. Source of Truth and Future Rule Changes

When code, assumptions, or implementation suggestions conflict with this document, this document controls intended business behavior until an approved specification change is made.

System rules may be changed in the future.

Approved changes must follow:

Decision  
→ Specification update  
→ Impact assessment  
→ Implementation change  
→ Regression testing

Minor compatible clarifications may produce a new minor version such as:

v1.0 → v1.1

Major behavioral changes may produce a major version such as:

v1.x → v2.0

Historical transactions must continue to preserve the policy, pricing, commission, payment-credit, and scheduling information applicable when they occurred.

## Appointment access by SMS OTP

A customer may regain access using the booking code and phone number already recorded on that appointment. A valid single-use OTP grants a two-hour session restricted to that appointment, including its existing customer management actions. OTP verification does not confirm payment or change appointment status. Existing private links remain usable. Codes expire in five minutes and allow five guesses; sending and verification are rate-limited. Changing the phone number through OTP recovery is not supported.

## Minimal appointment SMS (2026-10-10)

One normal paid booking sends one combined fee-payment/confirmation SMS with the appointment time and private access link. Routine standalone payment, completion and SMS reminder notices are suppressed at delivery with a retained SKIPPED record. OTP remains on-demand recovery. Schedule changes, cancellations and payments requiring reconciliation can generate separate exceptional notices. Email channel selection and delivery remain unchanged.


## One automatic SMS per booking (2026-10-13)

With `NOTIFICATION_SMS_POLICY=single`, only the combined paid-booking confirmation may send SMS. Changes, cancellations, recovery, financial-review, completion, payment and reminder notices are skipped. A prior sent, in-flight or failed SMS attempt for the booking prevents another automatic SMS; uncertain delivery is never retried automatically. Explicit customer requests for OTP verification remain separate. Email behavior is unchanged.


## Simple booking confirmation SMS (2026-10-13)

Booking confirmation SMS greets the customer by full name and contains fee-paid confirmation, the full appointment date, start–end time range in the salon timezone, and the booking code as the reference number, followed by reference-retention and arrival guidance. It contains no links and creates no new guest access session. Existing links and on-demand OTP access remain valid. The longer customer-requested template may span multiple SMS segments; the former 160-character limit no longer applies. All SMS confirmation policies verify current confirmed appointment state and a successful appointment-fee payment before sending this wording.

## Checked-in Waiting Queue (step 5)

Active Cashier and Admin accounts can read the dedicated waiting queue. It includes CONFIRMED appointments with a check-in, no completion record, at least one active service, and no active service with a recorded/finalized outcome. Removed historical service rows do not exclude the current visit. A visit leaves this queue once an active outcome is recorded, its status changes, or completion is recorded.

Include all dates so old unresolved arrivals remain visible. Sort by oldest check-in then appointment ID, with bounded pagination and customer/booking search. Display the original scheduled start, arrival time, recording staff, service snapshots, assigned stylist, and server-calculated elapsed minutes since check-in. Flag visits past their scheduled end for staff review; do not cancel or reclassify them automatically. No separate service-start record exists, so queue membership means no outcomes have been recorded rather than proof that treatment has not begun.

The queue refreshes every 30 seconds while visible, on focus, after local arrival changes, and on manual refresh. Reviewing a queue entry opens the existing service workspace. Queue reads do not change appointment status, staff assignments, payments or service outcomes.


## Cashier check-in and payment workspace (updated 2026-10-16)

The cashier workspace handles customer check-in, service outcomes, eligible no-show corrections, service-payment collection and payment receipts. It lists confirmed, uncompleted visits across all dates, including pending outcomes; service collection requires every active outcome to be recorded and at least one positive performed-service charge. Booking-code lookup remains available for payment review and receipts; it cannot bypass settlement prerequisites. Cashiers may record arrival through the same validated, audited check-in workflow as Admins. A separate customer check-in list shows today’s confirmed, uncompleted visits with active services and no recorded/finalized active outcomes, including already checked-in visits. Cashiers may record and correct service outcomes before finalization and correct eligible no-shows through the validated, audited restoration workflow. The confirmed-services list includes visits with pending outcomes, and booking-code lookup opens no-shows for review and correction. Cashiers cannot finalize no-service closures, including through direct API calls; Admins close visits with no performed services. Existing payment amounts, receipt history, commission formulas, and transaction/concurrency rules remain authoritative. Manual appointment-fee payment APIs remain authorized payment operations; the separate cashier fee menu remains removed.


## Automatic customer e-receipts (updated 2026-10-16)

Verified successful PayMongo appointment-fee captures automatically issue one immutable e-receipt in the same transaction as payment settlement. System issuance has no staff issuer and records a SYSTEM receipt-issuance audit. Pending, failed, expired and returned payments cannot create a new e-receipt. Existing receipts are reused without rewriting their issuer or snapshots. Authorized customer access may idempotently issue a missing receipt for an already verified successful PayMongo capture from before this feature. The receipt states the actual fee paid, provider payment reference, customer, salon and booked schedule; scheduled service charges remain separate. Customers can preview and print/save the e-receipt after restoring their authorized appointment session. Manual and service-payment staff issuance rules remain unchanged.
