export type Section = "profile" | "services" | "staff" | "qualifications" | "hours" | "schedules" | "closures" | "unavailability" | "policies";
export type Field = { key: string; label: string; type?: "text" | "email" | "money" | "number" | "percent" | "time" | "date" | "datetime" | "active" | "staff" | "service" | "day"; optional?: boolean; initial?: string | boolean; min?: number };
const active: Field = { key: "isActive", label: "Active", type: "active", initial: true };
const staff: Field = { key: "staffId", label: "Staff member", type: "staff" };
const day: Field = { key: "dayOfWeek", label: "Day of week", type: "day", initial: "MONDAY" };
const range: Field[] = [{ key: "startsAt", label: "Starts at", type: "datetime" }, { key: "endsAt", label: "Ends at", type: "datetime" }, { key: "reason", label: "Reason", optional: true }];
export const definitions: Record<Section, { title: string; singular: string; description: string; fields: Field[] }> = {
  profile: { title: "Salon profile", singular: "salon profile", description: "The salon’s public name, address, and contact details.", fields: [
    { key: "name", label: "Salon name" }, { key: "address", label: "Address" }, { key: "phone", label: "Phone", optional: true }, { key: "email", label: "Email", type: "email", optional: true },
  ] },
  services: { title: "Services", singular: "service", description: "Manage your service menu. Existing bookings keep their original prices and durations.", fields: [
    { key: "name", label: "Service name" }, { key: "category", label: "Booking category (e.g. Hair Services, Hair Treatments)", initial: "Other" }, { key: "description", label: "Description", optional: true }, { key: "price", label: "Price (PHP)", type: "money", min: .01 },
    { key: "durationMinutes", label: "Duration (minutes)", type: "number", min: 1 }, { key: "bufferMinutes", label: "Buffer (minutes; blank uses booking policy)", type: "number", optional: true }, active,
  ] },
  staff: { title: "Staff", singular: "staff member", description: "Manage staff and their skills. Use Manage skills to choose exactly which services each person can perform.", fields: [
    { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" }, { key: "phone", label: "Phone", optional: true }, active,
  ] },
  qualifications: { title: "Qualifications", singular: "qualification", description: "Choose each staff member’s services and commission rate.", fields: [staff,
    { key: "serviceId", label: "Service", type: "service" }, { key: "commissionRate", label: "Commission (%)", type: "percent", initial: "40" }, active,
  ] },
  hours: { title: "Opening hours", singular: "opening period", description: "Add weekly opening periods. Separate periods can represent a break in the day.", fields: [day,
    { key: "openTime", label: "Opens at", type: "time", initial: "08:00" }, { key: "closeTime", label: "Closes at", type: "time", initial: "22:00" }, active,
  ] },
  schedules: { title: "Staff schedules", singular: "staff schedule", description: "Set recurring shifts and optional inclusive start and end dates.", fields: [staff, day,
    { key: "startTime", label: "Starts at", type: "time", initial: "08:00" }, { key: "endTime", label: "Ends at", type: "time", initial: "22:00" },
    { key: "effectiveFrom", label: "Effective from", type: "date", optional: true }, { key: "effectiveTo", label: "Effective through", type: "date", optional: true }, active,
  ] },
  closures: { title: "Salon closures", singular: "salon closure", description: "Set temporary closures. Changes that conflict with reservations are rejected.", fields: range },
  unavailability: { title: "Staff time off", singular: "unavailable period", description: "Record temporary staff absences without changing recurring shifts.", fields: [staff, ...range] },
  policies: { title: "Booking policies", singular: "policy version", description: "Publish a new version for future bookings. Existing appointments keep their original policy.", fields: [
    { key: "appointmentFeeAmount", label: "Fixed appointment fee (PHP)", type: "money", initial: "100.00" },
    { key: "bookingHoldMinutes", label: "Payment hold (minutes)", type: "number", min: 1, initial: "10" },
    { key: "defaultBufferMinutes", label: "Default buffer (minutes)", type: "number", initial: "15" },
    { key: "maxReschedules", label: "Maximum reschedules", type: "number", initial: "2" },
    { key: "rescheduleCutoffHours", label: "Reschedule cutoff (hours)", type: "number", initial: "4" },
    { key: "cancellationCutoffHours", label: "Cancellation cutoff (hours)", type: "number", initial: "4" },
    { key: "noShowGraceHours", label: "No-show recovery window (hours)", type: "number", initial: "72" },
    { key: "advanceBookingDays", label: "Advance booking limit (days)", type: "number", min: 1, initial: "30" },
    { key: "minimumBookingLeadMinutes", label: "Minimum booking lead (minutes)", type: "number", initial: "60" },
    { key: "effectiveFrom", label: "Effective at (blank activates immediately)", type: "datetime", optional: true },
  ] },
};
export const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
