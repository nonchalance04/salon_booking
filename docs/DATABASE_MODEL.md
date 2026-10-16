# Salon Booking and Appointment System

## Database Model v1.0

This document defines the authoritative database entities, relationships, constraints, historical-data requirements, concurrency requirements, and indexing strategy for the Salon Booking and Appointment System.

`SYSTEM_RULES.md` defines business behavior.  
`DATABASE_MODEL.md` defines how the data required by those rules is persisted.

If these documents conflict, `SYSTEM_RULES.md` takes precedence and this database model must be corrected.

---

# 1. Database Design Principles

The database must follow these principles:

1. PostgreSQL is the primary relational database.
2. Prisma ORM is used for application database access and migrations.
3. Custom PostgreSQL migration SQL may be used when required constraints cannot be represented safely through Prisma alone.
4. Transactional and financial history must be preserved.
5. Historical records must not be destroyed through cascade deletion.
6. Money must use PostgreSQL NUMERIC/DECIMAL through Prisma Decimal.
7. `AppointmentService` is the authoritative staff scheduling unit.
8. Current configuration must not overwrite historical transaction snapshots.
9. Guest customers do not require User accounts.
10. Staff/stylists do not require User accounts in the MVP.
11. Admin and Cashier authentication use `User`.
12. Availability slots are calculated dynamically and are not stored permanently.
13. Business-critical multi-record operations require database transactions.
14. Availability-changing workflows must share one compatible concurrency protocol.
15. The authoritative salon timezone for the MVP is `Asia/Manila`.

---

# 2. Time and Timezone Storage Convention

The salon timezone is:

`Asia/Manila`

## Absolute Instants

Absolute events must be stored using PostgreSQL:

`timestamptz`

Recommended precision:

`timestamptz(3)`

Examples:

- Appointment timestamps.
- AppointmentService scheduling timestamps.
- Booking hold expiration.
- Payment timestamps.
- Audit timestamps.
- Notification timestamps.
- Salon closures.
- Staff unavailability.
- Policy activation timestamps.

## Recurring Local Times

Recurring weekly schedules use local PostgreSQL `time without time zone`.

Examples:

- Salon opening time.
- Salon closing time.
- Staff recurring start time.
- Staff recurring end time.

These times are interpreted using `Asia/Manila`.

## Local Dates

Schedule effective dates use PostgreSQL `date`.

All application conversions must explicitly use `Asia/Manila`.

---

# 3. Entity Groups

The MVP contains 19 primary entities.

## Authentication

1. User

## Customer

2. Customer

## Salon Operations

3. Staff  
4. Service  
5. StaffService
6. SalonProfile

## Scheduling

7. SalonOperatingHour
8. SalonClosure
9. StaffSchedule
10. StaffUnavailability

## Policy

11. BookingPolicyVersion

## Booking

12. Appointment
13. AppointmentService
14. AppointmentRescheduleHistory

## Financial

15. Payment
16. Receipt
17. CommissionRecord

## Supporting

18. AuditLog
19. NotificationQueue

# 4. User

Represents authenticated system users.

Only ADMIN and CASHIER are required for the MVP.

## Fields

- `id`
  - UUID
  - Primary key

- `email`
  - String
  - Required
  - Unique

- `passwordHash`
  - String
  - Required

- `role`
  - UserRole
  - Required

- `firstName`
  - String
  - Required

- `lastName`
  - String
  - Required

- `isActive`
  - Boolean
  - Default true

- `lastLoginAt`
  - timestamptz
  - Nullable

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## UserRole

- ADMIN
- CASHIER

## Rules

Inactive users cannot authenticate.

Users referenced by historical records are deactivated rather than deleted.

---

# 5. Customer

Represents salon customers, including guests.

Customer does not require a User account.

## Fields

- `id`
  - UUID
  - Primary key

- `firstName`
  - String
  - Required

- `lastName`
  - String
  - Required

- `phone`
  - String
  - Required

- `email`
  - String
  - Nullable

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Rules

Phone and email are not globally unique.

Customer records referenced by appointments must not be hard-deleted.

---

# 6. Staff

Represents salon personnel who perform services.

## Fields

- `id`
  - UUID
  - Primary key

- `firstName`
  - String
  - Required

- `lastName`
  - String
  - Required

- `phone`
  - String
  - Nullable

- `publicProfile`
  - Nullable JSONB; existing staff start without a published profile.
  - Validated object containing `title`, `bio`, `photoUrl`, `languages`, `portfolio`, and `reviews`.
  - Images use HTTPS URLs. Portfolio entries contain title, image URL, and caption; testimonials contain display name, rating, and text.
  - Profile changes are admin-only and audited. Staff names, qualifications, and activity remain separately managed.
  - Completed-appointment and unique-client counts are derived from completed appointments with active, performed services; they are not editable profile fields.

- `isActive`
  - Boolean
  - Default true

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Rules

Inactive Staff:

- Cannot receive new bookings.
- Remain referenced by historical AppointmentService and CommissionRecord rows.
- Are deactivated rather than deleted.

---

# 7. Service

Represents salon service definitions.

`category` is a required String, defaults to `Other`, and is limited to 100 trimmed characters by the configuration API. It groups services in staff skill management without granting qualifications. The menu booking categories migration splits legacy Hair and Nails classifications using approved descriptions into Hair Services, Hair Color & Styling, Hair Treatments, and Nail Services; Spa & Relaxation remains separate. These categories also enforce one service per category in bookings. Custom classifications are preserved; unknown services remain available for Admin classification.

## Fields

- `id`
  - UUID
  - Primary key

- `name`
  - String
  - Required

- `description`
  - Text
  - Nullable

- `price`
  - Decimal(12,2)
  - Required

- `durationMinutes`
  - Integer
  - Required

- `bufferMinutes`
  - Integer
  - Nullable

- `isActive`
  - Boolean
  - Default true

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Validation

For active bookable services:

`price > 0`

`durationMinutes > 0`

If buffer exists:

`bufferMinutes >= 0`

Null means use BookingPolicyVersion default buffer.

Explicit zero means zero buffer.

## Rules

Current Service changes do not alter historical AppointmentService snapshots.

---

# 8. StaffService

Represents staff qualification to perform a service.

## Fields

- `id`
  - UUID
  - Primary key

- `staffId`
  - FK → Staff
  - Required

- `serviceId`
  - FK → Service
  - Required

- `commissionRate`
  - Decimal(5,4)
  - Required

- `isActive`
  - Boolean
  - Default true

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Commission Representation

Examples:

`0.4000 = 40%`

`0.6000 = 60%`

Valid:

`0 <= commissionRate <= 1`

## Constraint

Unique:

`(staffId, serviceId)`

## Rules

Inactive StaffService records cannot be used for new assignments.

The commission rate used by an AppointmentService is snapshotted.

---

# 9. SalonProfile

Represents the single salon's public identity and contact information.

The MVP supports one salon profile. `SalonProfile` is not a multi-branch or multi-tenant entity.

## Fields

- `id`
  - UUID
  - Primary key

- `name`
  - String
  - Required

- `phone`
  - String
  - Nullable

- `email`
  - String
  - Nullable

- `address`
  - String
  - Required

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Rules

The MVP supports exactly one `SalonProfile` record.

The single-profile invariant is enforced by application/bootstrap logic in the current MVP. No multi-branch relationship is introduced.

`SalonProfile` stores salon identity and contact information only.

Operating hours remain represented by `SalonOperatingHour`.

Temporary salon-wide closures remain represented by `SalonClosure`.

`SalonProfile` is not used as a parent foreign key for Staff, Service, Appointment, or other operational entities in the single-salon MVP.

Changing current salon profile information must not rewrite historical `Receipt.receiptSnapshot` data.

---

# 10. SalonOperatingHour

Defines normal weekly salon operating hours.

## Fields

- `id`
  - UUID

- `dayOfWeek`
  - DayOfWeek

- `openTime`
  - Local time

- `closeTime`
  - Local time

- `isActive`
  - Boolean
  - Default true

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## DayOfWeek

- MONDAY
- TUESDAY
- WEDNESDAY
- THURSDAY
- FRIDAY
- SATURDAY
- SUNDAY

## Validation

`openTime < closeTime`

Operating-hour changes participate in the availability concurrency protocol defined later in this document.

---

# 11. SalonClosure

Represents temporary salon-wide closures.

## Fields

- `id`
  - UUID

- `startsAt`
  - timestamptz

- `endsAt`
  - timestamptz

- `reason`
  - Text
  - Nullable

- `createdByUserId`
  - FK → User

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Validation

`startsAt < endsAt`

## Rules

A closure that conflicts with future blocking appointments must be rejected until affected appointments are resolved.

Closure creation/modification participates in the salon-wide availability coordination protocol.

---

# 12. StaffSchedule

Represents recurring staff working schedules.

## Fields

- `id`
  - UUID

- `staffId`
  - FK → Staff

- `dayOfWeek`
  - DayOfWeek

- `startTime`
  - Local time

- `endTime`
  - Local time

- `effectiveFrom`
  - Date
  - Nullable

- `effectiveTo`
  - Date
  - Nullable

- `isActive`
  - Boolean
  - Default true

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Validation

`startTime < endTime`

When both dates exist:

`effectiveFrom <= effectiveTo`

StaffSchedule changes participate in Staff-level availability locking.

---

# 13. StaffUnavailability

Represents temporary staff scheduling exceptions.

## Fields

- `id`
  - UUID

- `staffId`
  - FK → Staff

- `startsAt`
  - timestamptz

- `endsAt`
  - timestamptz

- `reason`
  - Text
  - Nullable

- `createdByUserId`
  - FK → User

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## Validation

`startsAt < endsAt`

## Rules

Creation/modification must reject changes that would invalidate future blocking appointments.

StaffUnavailability changes participate in Staff-level locking.

---

# 14. BookingPolicyVersion

Represents immutable booking-policy versions.

## Fields

- `id`
  - UUID

- `version`
  - Integer
  - Required
  - Unique

- `appointmentFeeType`
  - AppointmentFeeType

- `appointmentFeeAmount`
  - Decimal(12,2)

- `bookingHoldMinutes`
  - Integer

- `defaultBufferMinutes`
  - Integer

- `maxReschedules`
  - Integer

- `rescheduleCutoffHours`
  - Integer

- `cancellationCutoffHours`
  - Integer

- `noShowGraceHours`
  - Integer

- `advanceBookingDays`
  - Integer

- `minimumBookingLeadMinutes`
  - Integer

- `effectiveFrom`
  - timestamptz
  - Required
  - Unique

- `createdByUserId`
  - FK → User

- `createdAt`
  - timestamptz

## AppointmentFeeType

- FIXED
- PERCENTAGE

PERCENTAGE exists only for future schema compatibility and is not enabled by MVP application behavior.

## Policy Activation Rule

BookingPolicyVersion is immutable.

The policy governing a new independent appointment is:

> The policy with the latest `effectiveFrom` value where `effectiveFrom <= currentTime`.

`effectiveFrom` must be unique.

No `effectiveTo` mutation is required when a newer version becomes active.

Existing appointments continue referencing their original policy version.

## Initial MVP Values

- FIXED fee
- PHP 100
- Hold: 10 minutes
- Default buffer: 15 minutes
- Maximum reschedules: 2
- Reschedule cutoff: 4 hours
- Cancellation cutoff: 4 hours
- No-show grace: 72 hours
- Advance booking: 30 days
- Minimum lead time: 60 minutes

---

# 15. Appointment

Represents the overall customer booking.

## Fields

- `id`
  - UUID

- `bookingCode`
  - String
  - Unique

- `customerId`
  - FK → Customer

- `bookingPolicyVersionId`
  - FK → BookingPolicyVersion

- `status`
  - AppointmentStatus

- `startAt`
  - timestamptz

- `endAt`
  - timestamptz

- `appointmentFeeAmount`
  - Decimal(12,2)

- `holdExpiresAt`
  - timestamptz
  - Nullable

- `rescheduleCount`
  - Integer
  - Default 0

- `guestAccessTokenHash`
  - String
  - Required

- `confirmedAt`
  - timestamptz
  - Nullable

- `cancelledAt`
  - timestamptz
  - Nullable

- `noShowAt`
  - timestamptz
  - Nullable

- `noShowGraceExpiresAt`
  - timestamptz
  - Nullable

- `completedAt`
  - timestamptz
  - Nullable

- `completionType`
  - AppointmentCompletionType
  - Nullable

- `completedByUserId`
  - FK → User
  - Nullable

- `recoveryOfAppointmentId`
  - Self-reference → Appointment
  - Nullable
  - Unique

- `carriedAppointmentFeePaymentId`
  - FK → Payment
  - Nullable
  - Unique

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## AppointmentStatus

- PENDING_PAYMENT
- CONFIRMED
- COMPLETED
- CANCELLED
- NO_SHOW
- EXPIRED

## AppointmentCompletionType

- SERVICE_SETTLEMENT
- NO_SERVICE_CLOSURE

## Summary Rules

Only ACTIVE AppointmentService rows participate in appointment scheduling summaries.

`startAt`

= earliest ACTIVE AppointmentService `scheduledStartAt`

`endAt`

= scheduled end of the final ACTIVE AppointmentService, excluding trailing buffer.

A PENDING_PAYMENT or CONFIRMED Appointment must have at least one ACTIVE AppointmentService.

## Recovery Relationship

A recovery appointment references the NO_SHOW appointment through:

`recoveryOfAppointmentId`

Uniqueness prevents one source appointment from creating multiple direct recovery appointments.

## Carried Credit

`carriedAppointmentFeePaymentId`

identifies the successful original APPOINTMENT_FEE payment used to satisfy the recovery appointment's fee requirement.

Uniqueness prevents the same successful payment from being consumed by multiple recovery appointments.

The original Payment itself is not moved, copied, or rewritten.

---

# 16. AppointmentService

Represents one service belonging to an Appointment.

`AppointmentService` is the authoritative staff scheduling unit.

## Fields

- `id`
  - UUID

- `appointmentId`
  - FK → Appointment

- `serviceId`
  - FK → Service

- `staffId`
  - FK → Staff

- `assignmentMode`
  - StaffAssignmentMode

- `membershipStatus`
  - AppointmentServiceMembershipStatus
  - Default ACTIVE

- `sequenceNo`
  - Integer
  - Required

- `serviceNameSnapshot`
  - String

- `priceSnapshot`
  - Decimal(12,2)

- `durationMinutesSnapshot`
  - Integer

- `bufferMinutesSnapshot`
  - Integer

- `commissionRateSnapshot`
  - Decimal(5,4)

- `scheduledStartAt`
  - timestamptz

- `scheduledEndAt`
  - timestamptz

- `reservedUntilAt`
  - timestamptz

- `outcome`
  - AppointmentServiceOutcome
  - Default SCHEDULED

- `actualChargedAmount`
  - Decimal(12,2)
  - Nullable

- `outcomeFinalizedAt`
  - timestamptz
  - Nullable

- `outcomeFinalizedByUserId`
  - FK → User
  - Nullable

- `removedAt`
  - timestamptz
  - Nullable

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## StaffAssignmentMode

- SPECIFIC
- ANY_AVAILABLE

## AppointmentServiceMembershipStatus

- ACTIVE
- REMOVED

`REMOVED` represents a service removed through rescheduling.

It does not mean that the customer failed to receive a scheduled service.

`NOT_PERFORMED` must never be used to represent removal during rescheduling.

## AppointmentServiceOutcome

- SCHEDULED
- PERFORMED
- NOT_PERFORMED

## ACTIVE Membership Rules

Only ACTIVE AppointmentService rows participate in:

- Availability/conflict detection.
- Appointment start/end calculation.
- Current service ordering.
- Service-outcome finalization.
- Settlement calculations.
- Commission calculations.

## REMOVED Membership Rules

REMOVED AppointmentService rows:

- Remain in the database for history.
- Do not block staff.
- Do not participate in settlement.
- Do not receive new outcomes.
- Do not generate commission.
- Are not included in current Appointment start/end summaries.

`removedAt` is required when membership becomes REMOVED.

## Scheduling Validation

For ACTIVE rows:

`sequenceNo > 0`

`scheduledStartAt < scheduledEndAt`

`scheduledEndAt <= reservedUntilAt`

In addition, the stored interval must exactly match its snapshots:

`scheduledEndAt = scheduledStartAt + durationMinutesSnapshot`

`reservedUntilAt = scheduledEndAt + bufferMinutesSnapshot`

These equalities are mandatory when creating or rescheduling ACTIVE AppointmentService rows.

A 120-minute duration snapshot must therefore reserve exactly 120 minutes of service time before buffer is applied.

## Sequential Scheduling

ACTIVE AppointmentService rows are ordered by `sequenceNo`.

The active sequence is normalized transactionally into a deterministic ordered sequence.

For consecutive ACTIVE services:

`next.scheduledStartAt = previous.reservedUntilAt`

## Active Sequence Uniqueness

Two ACTIVE AppointmentService rows belonging to the same Appointment must not share the same `sequenceNo`.

Conceptual partial uniqueness:

`UNIQUE(appointmentId, sequenceNo) WHERE membershipStatus = ACTIVE`

This may require custom PostgreSQL migration SQL depending on the pinned Prisma version.

---

# 17. AppointmentRescheduleHistory

Preserves immutable rescheduling history.

## Fields

- `id`
  - UUID

- `appointmentId`
  - FK → Appointment

- `eventType`
  - RescheduleEventType

- `rescheduleNumber`
  - Integer

- `snapshotSchemaVersion`
  - Integer
  - Required

- `actorType`
  - ActorType

- `actorUserId`
  - FK → User
  - Nullable

- `actorCustomerId`
  - FK → Customer
  - Nullable

- `beforeSnapshot`
  - JSON

- `afterSnapshot`
  - JSON

- `reason`
  - Text
  - Nullable

- `createdAt`
  - timestamptz

## RescheduleEventType

- ORDINARY_RESCHEDULE
- NO_SHOW_RECOVERY_CREATED

## History Ownership

An ordinary reschedule history row belongs to the Appointment being modified.

A `NO_SHOW_RECOVERY_CREATED` history row belongs to the original NO_SHOW Appointment.

Its `afterSnapshot` must identify the newly created replacement Appointment.

## Mandatory Snapshot Contract

Every snapshot must include at least:

### Appointment Data

- Appointment ID.
- BookingPolicyVersion ID.
- Appointment status.
- startAt.
- endAt.
- appointmentFeeAmount.
- rescheduleCount.

### Every Relevant AppointmentService

- AppointmentService ID.
- Service ID.
- Staff ID.
- Assignment mode.
- Membership status.
- Sequence number.
- Service-name snapshot.
- Price snapshot.
- Duration snapshot.
- Buffer snapshot.
- Commission-rate snapshot.
- scheduledStartAt.
- scheduledEndAt.
- reservedUntilAt.
- Outcome where relevant.

Decimal values must be serialized losslessly, preferably as strings.

Timestamps must use unambiguous ISO-8601 values.

`snapshotSchemaVersion` permits safe future evolution of the JSON format.

## Constraints

Recommended uniqueness:

`(appointmentId, rescheduleNumber)`

for each counted reschedule/recovery event.

---

# 18. Payment

Represents real financial payment attempts and captures.

A Payment must never be created only to simulate a non-financial lifecycle event.

## Fields

- `id`
  - UUID

- `appointmentId`
  - FK → Appointment

- `type`
  - PaymentType

- `method`
  - PaymentMethod

- `provider`
  - String or enum

- `status`
  - PaymentStatus

- `amount`
  - Decimal(12,2)

- `currency`
  - Default PHP

- `idempotencyKey`
  - String
  - Required
  - Unique

- `externalReference`
  - String
  - Nullable

- `satisfiesObligation`
  - Boolean
  - Default false

- `recordedByUserId`
  - FK → User
  - Nullable

- `paidAt`
  - timestamptz
  - Nullable

- `failedAt`
  - timestamptz
  - Nullable

- `refundedAt`
  - timestamptz
  - Nullable

- `reconciliationStatus`
  - PaymentReconciliationStatus
  - Default NONE

- `reconciliationReason`
  - Text
  - Nullable

- `reconciledAt`
  - timestamptz
  - Nullable

- `reconciledByUserId`
  - FK → User
  - Nullable

- `metadata`
  - JSON
  - Nullable

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## PaymentType

- APPOINTMENT_FEE
- SERVICE_PAYMENT

## PaymentMethod

- CASH
- GCASH
- OTHER

## PaymentStatus

- PENDING
- SUCCEEDED
- FAILED
- EXPIRED
- REFUNDED

## PaymentReconciliationStatus

- NONE
- REQUIRED
- RESOLVED

## Payment Identity

Every Payment attempt requires a stable internal `idempotencyKey`.

An external provider reference is additional identity when available.

Recommended uniqueness:

`(provider, externalReference)`

when externalReference is non-null.

Duplicate provider callbacks for the same real transaction must resolve to the same Payment attempt.

A genuinely separate appointment-fee capture must be recorded separately rather than discarded.

## APPOINTMENT_FEE Obligation Satisfaction

One successful APPOINTMENT_FEE Payment may satisfy an Appointment's booking-fee obligation.

`satisfiesObligation = true`

identifies the successful payment recognized by the booking workflow.

A genuinely separate additional APPOINTMENT_FEE capture may still be stored as SUCCEEDED, but:

- `satisfiesObligation = false`
- `reconciliationStatus = REQUIRED`
- it must not confirm the Appointment a second time.

Conceptual partial uniqueness:

`UNIQUE(appointmentId, type)`

where:

- `type = APPOINTMENT_FEE`
- `status = SUCCEEDED`
- `satisfiesObligation = true`

## SERVICE_PAYMENT Success Rule

The MVP supports **only one successful SERVICE_PAYMENT per Appointment**.

This is stricter than the APPOINTMENT_FEE reconciliation behavior.

Conceptual partial uniqueness:

`UNIQUE(appointmentId)`

where:

- `type = SERVICE_PAYMENT`
- `status = SUCCEEDED`

This uniqueness does **not** depend on `satisfiesObligation`.

Before a SERVICE_PAYMENT attempt may transition to SUCCEEDED, the settlement workflow must verify that no successful SERVICE_PAYMENT already exists.

A second SERVICE_PAYMENT must not be recorded as another successful collection under the MVP settlement model.

Failed, pending, or expired service-payment attempts may still exist historically.

Supporting multiple genuine successful service-payment captures would require a future approved change to `SYSTEM_RULES.md`.

## Late Successful Appointment-Fee Payments

A late APPOINTMENT_FEE capture may remain:

`status = SUCCEEDED`

while:

`satisfiesObligation = false`

and:

`reconciliationStatus = REQUIRED`

The expired Appointment must not be automatically reconfirmed.

---

# 19. Receipt

Represents a receipt for a successful financial transaction.

## Fields

- `id`
  - UUID

- `paymentId`
  - FK → Payment
  - Unique

- `receiptNumber`
  - String
  - Unique

- `issuedByUserId`
  - Nullable FK → User; null identifies automatic system issuance for verified PayMongo appointment-fee captures.

- `receiptSnapshot`
  - JSON

- `issuedAt`
  - timestamptz

## Rules

A Payment has at most one Receipt.

No fake receipt is created for a zero-charge no-service closure.

Receipt history is immutable.

---

# 20. CommissionRecord

Represents finalized commission for one PERFORMED AppointmentService.

## Fields

- `id`
  - UUID

- `appointmentId`
  - FK → Appointment

- `appointmentServiceId`
  - FK → AppointmentService
  - Unique

- `staffId`
  - FK → Staff

- `sourcePaymentId`
  - FK → Payment

- `serviceAmount`
  - Decimal(12,2)

- `allocatedAppointmentFee`
  - Decimal(12,2)

- `commissionBase`
  - Decimal(12,2)

- `commissionRate`
  - Decimal(5,4)

- `commissionAmount`
  - Decimal(12,2)

- `finalizedByUserId`
  - FK → User

- `finalizedAt`
  - timestamptz

## Rules

CommissionRecord is created only when:

- AppointmentService is ACTIVE.
- Outcome = PERFORMED.
- The source SERVICE_PAYMENT is the single successful payment satisfying settlement.

No commission is created for:

- REMOVED services.
- NOT_PERFORMED services.
- No-service closures.

Formula:

`commissionBase = serviceAmount + allocatedAppointmentFee`

`commissionAmount = commissionBase × commissionRate`

---

# 21. AuditLog

Represents append-oriented system audit history.

## Fields

- `id`
  - UUID

- `actorType`
  - ActorType

- `actorUserId`
  - FK → User
  - Nullable

- `actorCustomerId`
  - FK → Customer
  - Nullable

- `action`
  - String

- `entityType`
  - String

- `entityId`
  - String

- `beforeData`
  - JSON
  - Nullable

- `afterData`
  - JSON
  - Nullable

- `ipAddress`
  - String
  - Nullable

- `userAgent`
  - Text
  - Nullable

- `createdAt`
  - timestamptz

## ActorType

- ADMIN
- CASHIER
- CUSTOMER
- SYSTEM

Important events include:

- Appointment creation.
- Rescheduling.
- Service removal.
- Cancellation.
- NO_SHOW marking.
- Recovery creation.
- Carried-credit consumption.
- Service outcome finalization.
- Settlement.
- No-service closure.
- Commission finalization.
- Payment reconciliation.
- Configuration modification.

Audit logs are not updated as mutable operational records.

---

# 22. NotificationQueue

Represents asynchronous notification delivery.

## Fields

- `id`
  - UUID

- `appointmentId`
  - FK → Appointment
  - Nullable

- `customerId`
  - FK → Customer
  - Nullable

- `eventType`
  - NotificationEventType

- `channel`
  - NotificationChannel

- `recipient`
  - String

- `payload`
  - JSON

- `status`
  - NotificationStatus

- `attemptCount`
  - Integer
  - Default 0

- `scheduledAt`
  - timestamptz

- `sentAt`
  - timestamptz
  - Nullable

- `lastError`
  - Text
  - Nullable

- `createdAt`
  - timestamptz

- `updatedAt`
  - timestamptz

## NotificationEventType

- BOOKING_CONFIRMED
- BOOKING_RESCHEDULED
- BOOKING_CANCELLED
- NO_SHOW_RECOVERY_CREATED
- PAYMENT_RECEIVED
- APPOINTMENT_COMPLETED
- APPOINTMENT_REMINDER

## NotificationChannel

- EMAIL
- SMS

## NotificationStatus

- PENDING
- PROCESSING
- SENT
- FAILED

---

# 23. Referential Delete Rules

Historical and transactional integrity uses restrictive foreign-key deletion behavior.

The default rule is:

`ON DELETE RESTRICT`

or the Prisma/PostgreSQL equivalent.

This applies particularly to relationships involving:

- Customer → Appointment.
- BookingPolicyVersion → Appointment.
- Appointment → AppointmentService.
- Appointment recovery ancestry.
- Carried appointment-fee Payment references.
- Appointment → Payment.
- Payment → Receipt.
- AppointmentService → CommissionRecord.
- Payment → CommissionRecord.
- Staff → AppointmentService.
- Service → AppointmentService.
- User → historical financial/audit operations.

Cascade deletion must not propagate into:

- Appointment.
- AppointmentService.
- AppointmentRescheduleHistory.
- Payment.
- Receipt.
- CommissionRecord.
- AuditLog.

Operational business records are normally deactivated rather than deleted.

---

# 24. Primary Relationships

Customer:

`1 → many Appointment`

BookingPolicyVersion:

`1 → many Appointment`

Appointment:

`1 → many AppointmentService`

Appointment:

`1 → many Payment`

Appointment:

`1 → many AppointmentRescheduleHistory`

Appointment:

`1 → many CommissionRecord`

Appointment:

`1 → many NotificationQueue`

Appointment:

`0..1 → 0..1 direct recovery Appointment`

Payment:

`0..1 → 0..1 Appointment carried-credit reference`

Staff:

`1 → many AppointmentService`

Service:

`1 → many AppointmentService`

Staff:

`many ↔ many Service through StaffService`

Staff:

`1 → many StaffSchedule`

Staff:

`1 → many StaffUnavailability`

Payment:

`1 → 0..1 Receipt`

AppointmentService:

`1 → 0..1 CommissionRecord`

---

# 25. Reservation Blocking

Conflict checks use ACTIVE AppointmentService rows only.

Relevant fields:

- staffId
- scheduledStartAt
- reservedUntilAt

Conflict exists when:

`newStart < existingReservedUntil`

AND

`newReservedUntil > existingStart`

The parent Appointment must also currently be blocking according to SYSTEM_RULES.md.

## Blocking States

### PENDING_PAYMENT

Blocks only while:

`currentTime <= holdExpiresAt`

### CONFIRMED

Blocks normally.

### COMPLETED

Original reserved intervals remain blocking until each original `reservedUntilAt` passes.

### CANCELLED

Does not block after successful cancellation.

### NO_SHOW

Does not block after NO_SHOW is recorded.

### EXPIRED

Does not block.

REMOVED AppointmentService rows never block.

---

# 26. Shared Availability and Reservation Concurrency Protocol

Every workflow that reads or changes booking availability must participate in one shared serialization protocol.

This includes:

- Availability-sensitive booking creation.
- Appointment-fee confirmation.
- Hold expiration.
- Ordinary rescheduling.
- No-show recovery.
- Salon operating-hour changes.
- Salon closure changes.
- Staff schedule changes.
- Staff unavailability changes.
- Availability-affecting staff/service qualification changes.

## Salon-Wide Coordination Modes

The implementation must provide one salon-wide transaction-level coordination mechanism supporting:

- SHARED mode for reservation workflows.
- EXCLUSIVE mode for salon-wide availability configuration writes.

The implementation may use PostgreSQL advisory transaction locks or another explicitly approved equivalent mechanism.

## Reservation Workflow Lock Order

Booking, appointment-fee confirmation, ordinary rescheduling, and no-show recovery must:

1. Acquire the salon-wide coordination lock in SHARED mode.
2. Determine all affected Staff IDs.
3. Acquire relevant Staff locks in ascending Staff ID order.
4. Acquire relevant Appointment/Payment row locks where required.
5. Evaluate fresh current time after the coordination and Staff locks are held.
6. Revalidate operating hours and salon closures.
7. Revalidate staff active status and qualification.
8. Revalidate StaffSchedule and StaffUnavailability.
9. Recheck blocking AppointmentService conflicts.
10. Recheck hold deadline and reservation ownership when applicable.
11. Perform the mutation.
12. Commit the transaction.

The SHARED salon-wide lock is mandatory for these reservation workflows.

They must not rely only on Staff locks.

## Appointment-Fee Confirmation

Appointment-fee confirmation must acquire:

1. Salon-wide SHARED coordination.
2. All Staff locks associated with the Appointment's ACTIVE AppointmentService rows, ordered by Staff ID.
3. The relevant Appointment/Payment row locks.

It must then freshly verify:

- Appointment remains PENDING_PAYMENT.
- Hold remains active.
- Appointment still owns its ACTIVE reservations.
- No conflicting reservation has become authoritative.

This prevents confirmation from racing against expiration or newly created reservations.

---

# 27. Availability-Affecting Configuration Concurrency

Configuration writes must use the same coordination mechanism as reservation readers.

## Salon-Wide Configuration Changes

Examples:

- SalonOperatingHour changes.
- SalonClosure creation/change.
- Other approved salon-wide availability configuration.

These operations must:

1. Acquire the salon-wide coordination lock in EXCLUSIVE mode.
2. Acquire affected Staff locks in ascending Staff ID order when Staff-specific validation is required.
3. Freshly query affected blocking appointments.
4. Reject the configuration change if unresolved appointments would become invalid.
5. Apply the change only when validation succeeds.
6. Commit.

Because reservation workflows hold the corresponding SHARED salon-wide coordination lock, an EXCLUSIVE configuration writer cannot independently validate and commit against the same scheduling state.

## Staff-Specific Configuration Changes

Examples:

- StaffSchedule.
- StaffUnavailability.
- Staff active status.
- StaffService qualification status.

They must:

1. Participate in the salon-wide coordination protocol.
2. Acquire the salon-wide coordination lock in SHARED mode unless the change is also salon-wide.
3. Acquire affected Staff locks in ascending Staff ID order.
4. Freshly check affected blocking appointments.
5. Reject changes that invalidate unresolved reservations.

## Universal Lock Ordering

When multiple coordination levels are required, the lock order is always:

1. Salon-wide coordination lock.
2. Staff locks ordered by Staff ID ascending.
3. Appointment/Payment or other transaction-specific row locks.

All participating workflows must use the same ordering to reduce deadlock risk.

---

# 28. Required Unique Constraints

At minimum:

- `User.email`
- `StaffService(staffId, serviceId)`
- `BookingPolicyVersion.version`
- `BookingPolicyVersion.effectiveFrom`
- `Appointment.bookingCode`
- `Appointment.recoveryOfAppointmentId` when non-null
- `Appointment.carriedAppointmentFeePaymentId` when non-null
- `Payment.idempotencyKey`
- `Payment(provider, externalReference)` when externalReference exists
- `Receipt.paymentId`
- `Receipt.receiptNumber`
- `CommissionRecord.appointmentServiceId`

Conditional uniqueness:

## ACTIVE Service Sequence

`UNIQUE(appointmentId, sequenceNo)`

where:

`membershipStatus = ACTIVE`

## Appointment-Fee Obligation

At most one successful obligation-satisfying APPOINTMENT_FEE:

`UNIQUE(appointmentId)`

where:

- `type = APPOINTMENT_FEE`
- `status = SUCCEEDED`
- `satisfiesObligation = true`

## Successful Service Payment

At most one successful SERVICE_PAYMENT per Appointment:

`UNIQUE(appointmentId)`

where:

- `type = SERVICE_PAYMENT`
- `status = SUCCEEDED`

These conditional constraints may require supported Prisma partial-index features or custom PostgreSQL migration SQL.

---

# 29. Required Indexes

Indexes should support actual application query patterns while avoiding unnecessary duplication.

## Appointment

- `(status)`
- `(customerId)`
- `(startAt)`
- `(holdExpiresAt)`
- `(bookingPolicyVersionId)`

## AppointmentService

- `(appointmentId, membershipStatus)`
- `(staffId, membershipStatus, scheduledStartAt)`
- `(staffId, membershipStatus, reservedUntilAt)`

## StaffSchedule

- `(staffId, dayOfWeek)`

## StaffUnavailability

- `(staffId, startsAt, endsAt)`

## SalonClosure

- `(startsAt, endsAt)`

## StaffService

- `(staffId, isActive)`
- `(serviceId, isActive)`

## AppointmentRescheduleHistory

- `(appointmentId, createdAt)`

## Payment

- `(appointmentId, type)`
- `(status)`
- `(reconciliationStatus)`

## CommissionRecord

- `(staffId, finalizedAt)`
- `(appointmentId)`

## NotificationQueue

- `(status, scheduledAt)`

## AuditLog

- `(entityType, entityId)`
- `(createdAt)`

Final index tuning should be based on actual query plans.

---

# 30. Database Checks

Database-level CHECK constraints should be added where appropriate.

## Service

- `price > 0`
- `durationMinutes > 0`
- `bufferMinutes >= 0` when non-null

## StaffService

- `commissionRate >= 0`
- `commissionRate <= 1`

## Scheduling

- SalonOperatingHour `openTime < closeTime`
- StaffSchedule `startTime < endTime`
- StaffUnavailability `startsAt < endsAt`
- SalonClosure `startsAt < endsAt`

## AppointmentService

For ACTIVE rows:

- `sequenceNo > 0`
- `scheduledStartAt < scheduledEndAt`
- `scheduledEndAt <= reservedUntilAt`
- `priceSnapshot > 0`
- `durationMinutesSnapshot > 0`
- `bufferMinutesSnapshot >= 0`
- `commissionRateSnapshot >= 0`
- `commissionRateSnapshot <= 1`

The following exact relationships are mandatory:

`scheduledEndAt = scheduledStartAt + durationMinutesSnapshot`

`reservedUntilAt = scheduledEndAt + bufferMinutesSnapshot`

These rules must always be enforced by application validation inside the relevant transaction.

Where practical and maintainable, database-level enforcement may also be added using approved PostgreSQL SQL.

Cross-row or aggregate business rules remain transaction/application responsibilities.

---

# 31. Rules Not Enforceable by Prisma Schema Alone

The following require application validation and transaction logic:

- Staff qualification.
- Active staff/service validation.
- Complete schedule coverage.
- Booking lead/cutoff calculations.
- Deterministic Any Available Staff assignment.
- Sequential AppointmentService adjacency.
- Exact duration/buffer timestamp derivation.
- At least one ACTIVE service for active bookings.
- Appointment start/end summary synchronization.
- Recovery eligibility.
- No-show grace.
- Recovery reschedule-count inheritance.
- Carried-credit eligibility.
- Carried payment sufficiency.
- Refund status validation.
- Prevention of recovery cycles.
- Service outcome finalization.
- Settlement amount calculations.
- Commission allocation.
- Commission rounding.
- Policy-version immutability after use.
- Finalized Payment/Commission/outcome immutability.
- Availability-affecting configuration race prevention.
- Shared/exclusive salon coordination.
- Fresh deadline evaluation after locking.

---

# 32. Custom PostgreSQL Migration SQL

Custom SQL is permitted and expected when required for database-level enforcement.

Potential uses include:

- CHECK constraints not represented directly by Prisma.
- Partial unique indexes.
- ACTIVE AppointmentService sequence uniqueness.
- Appointment-fee obligation uniqueness.
- Strict one-successful-SERVICE_PAYMENT uniqueness.
- Additional database immutability protections if later approved.

The pinned Prisma version must be determined before deciding whether a supported Prisma feature or custom SQL will implement a particular constraint.

Dynamic reservation blocking must not be implemented as an index predicate dependent on:

- another table's Appointment status, or
- the current clock time.

Dynamic blocking remains transaction/query logic.

---

# 33. Transaction Boundaries

## New Booking

Transaction includes:

1. Salon-wide SHARED coordination.
2. Relevant Staff locks.
3. Current-time evaluation.
4. Final availability validation.
5. Staff assignment.
6. Appointment creation.
7. ACTIVE AppointmentService creation.

## Appointment-Fee Confirmation

Transaction includes:

1. Salon-wide SHARED coordination.
2. Relevant Staff locks.
3. Appointment/Payment locking.
4. Fresh hold validation.
5. Reservation-ownership validation.
6. Payment idempotency validation.
7. Payment obligation designation.
8. Appointment confirmation.

## Hold Expiration

Hold expiration must use compatible coordination with confirmation.

Where a concurrent confirmation can exist, expiration must not independently finalize a contradictory result.

## Ordinary Rescheduling

Transaction includes:

1. Salon-wide SHARED coordination.
2. Relevant old/new Staff locks in ascending Staff ID order.
3. Existing Appointment validation.
4. Replacement schedule validation.
5. Existing ACTIVE AppointmentService rows retained/updated or marked REMOVED.
6. Added services created as ACTIVE.
7. Exact duration/buffer derivation.
8. Active sequence normalization.
9. Appointment summary update.
10. History creation.

## No-Show Recovery With Carried Credit

Transaction includes:

1. Salon-wide SHARED coordination.
2. Source Appointment validation.
3. Recovery uniqueness validation.
4. Source Payment validation.
5. Carried-credit uniqueness validation.
6. Relevant Staff locks.
7. Availability validation.
8. Replacement Appointment creation directly as CONFIRMED.
9. ACTIVE AppointmentService creation.
10. Exact duration/buffer derivation.
11. Carried-payment linkage.
12. History creation.
13. Audit entry.

## No-Show Recovery Without Credit

Uses normal PENDING_PAYMENT booking creation.

## Service Settlement

Transaction includes:

1. Appointment serialization.
2. Service-outcome validation.
3. Verification that no successful SERVICE_PAYMENT already exists.
4. Settlement amount validation.
5. Successful SERVICE_PAYMENT creation/update.
6. Receipt creation.
7. Commission calculations.
8. CommissionRecord creation.
9. Appointment COMPLETED transition.
10. Outcome finalization.

## No-Service Closure

Transaction includes:

1. Appointment serialization.
2. Verification all ACTIVE services are NOT_PERFORMED.
3. Appointment COMPLETED transition.
4. Outcome immutability.
5. Audit entry.

No fake Payment, Receipt, or CommissionRecord is created.

---

# 34. Historical Preservation Strategy

Historical transaction values use snapshots.

## Appointment

Preserves:

- BookingPolicyVersion.
- Appointment fee.

## AppointmentService

Preserves:

- Service identity.
- Service name.
- Price.
- Duration.
- Buffer.
- Commission rate.
- Original row identity even after removal.

## AppointmentRescheduleHistory

Preserves:

- Complete before/after state.

## Payment

Preserves:

- Every legitimate financial attempt/capture permitted by the authoritative system rules.
- Reconciliation state.

## Receipt

Preserves:

- Issued receipt contents.

## CommissionRecord

Preserves:

- All finalized commission inputs and outputs.

Changing current configuration must never rewrite historical financial or scheduling data.

---

# 35. Deletion Strategy

The application should prefer:

`deactivate`

over:

`delete`

for business entities used by history.

Historical transaction records should not be deleted through normal application workflows.

This includes:

- Appointment.
- AppointmentService.
- AppointmentRescheduleHistory.
- Payment.
- Receipt.
- CommissionRecord.
- AuditLog.

---

# 36. Data Not Stored as Permanent Availability Rows

Do not create permanent entities for:

- AvailabilitySlot.
- TimeSlot.
- CalendarSlot.

Availability is derived dynamically from:

SalonOperatingHour  
+ StaffSchedule  
− SalonClosure  
− StaffUnavailability  
− blocking ACTIVE AppointmentService reservations

---

# 37. Entities Explicitly Outside the MVP

Do not add entities for:

- Inventory.
- Payroll.
- Loyalty points.
- Membership.
- Staff login accounts.
- Detailed on-chair workflow.
- Chatbot conversation history.
- Expense accounting.
- Profit/loss accounting.
- Predictive staff scheduling.
- Customer marketing profiles.

These require a separately approved scope change.

---

# 38. Database Source of Truth

When `schema.prisma`, migrations, or implementation assumptions conflict with this document, this database specification controls unless an approved design change has been made.

When this document conflicts with `SYSTEM_RULES.md`, the System Rules control.

Approved database changes follow:

Business decision  
→ System Rules update if required  
→ Database Model update  
→ Prisma schema/migration  
→ Tests
## Appointment OTP access records

`AppointmentOtpChallenge` stores a UUID, optional appointment relation (null for unmatched requests), hashed identity, keyed code digest, attempt count, creation/expiry times and consumption time. `AppointmentGuestSession` stores only the random session token's SHA-256 hash, appointment relation and expiry. `AppointmentOtpRate` stores keyed rate-limit identities, counts and window expiries. These temporary access records are separate from historical transactional data and are pruned by the hold worker.

## Customer arrival tracking

Appointment has nullable `checkedInAt` (TIMESTAMPTZ(3)) and `checkedInByUserId` (UUID referencing User with restricted deletion). A database check requires both fields to be set together or both null. The named AppointmentCheckedInBy relation is independent of the completion actor. Existing appointments receive null arrival fields; historical arrival is not inferred from service completion.
