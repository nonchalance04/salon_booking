# Admin workspace

The Admin dashboard links to live appointment and payment workflows.

- Today's appointments use the salon's configured calendar date and include all stored statuses.
- Pending appointment fees count `PENDING_PAYMENT` bookings with a live hold across all dates. Expired holds are excluded even before the cleanup worker updates their stored status.
- Unsettled services count `CONFIRMED` bookings whose scheduled start has passed, across all dates. The normal settlement service still validates outcomes and eligibility.
- Payment reconciliation counts successful captures with reconciliation status `REQUIRED`, across all dates. The card opens the existing reconciliation queue.
- Collections use capture time, and finalized commissions use finalization time. Net collections reflect recorded payment adjustments. Carried credits do not create new collections.
- Scheduling shows closures and staff absences overlapping the next seven days, with up to 20 entries of each kind. Review links show bookings on the affected salon dates; these are review lists, not assertions that every booking conflicts.

Appointment filtering runs on the server before cursor pagination. Filters cover inclusive salon dates, status, assigned stylist, customer name or booking code, active payment holds, and unsettled services. Clearing filters restores the full booking list. Appointment details link to fee review and settlement/receipts without requiring another code entry.

Configuration conflicts continue to be rejected by the existing reservation protection rules. The conflict list now links to the affected booking.

Rescheduling retains the existing customer private-link workflow and original policy checks. This UI update does not add an Admin override or expose private guest credentials.

## Confirmed services

The Admin dashboard and service-outcome workspace automatically list confirmed,
unfinalized bookings across all dates. Choose **Review services** to open the
selected appointment without entering its booking code. The shared list refreshes
every 30 seconds while visible and on tab focus, supports customer-name or booking
code search, and uses bounded pagination. Cashiers see the same confirmed bookings
with **Process payment** actions. Existing role restrictions still govern saving
outcomes, corrections and payment finalization.


### Edit a staff member’s customer profile

Open **Salon Management → Staff / Stylists → Edit public profile** on the staff member’s card. Edit their professional title, bio, HTTPS profile-photo URL, and comma-separated languages. Add up to eight portfolio items (title, HTTPS image URL, caption) and ten client testimonials (display name, rating, text). Use testimonials with the client’s permission. Save public profile publishes the details to newly loaded booking pages. Cancel discards edits; removal of an item takes effect when saved. Clear the photo URL to restore the illustrated avatar.

Names and active status are still edited through the basic staff editor. Qualifications determine bookable services. Completed-appointment and distinct-client counts are calculated from completed visits with performed services and cannot be typed into the editor. Existing staff start with empty profile content, not sample reviews or statistics.
