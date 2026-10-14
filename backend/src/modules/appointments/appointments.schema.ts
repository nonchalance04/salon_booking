import { z } from "zod";
import { availabilitySchema } from "../availability/availability.schema.js";

export const bookingSchema = availabilitySchema.extend({
  startAt: z.iso.datetime({ offset: true }),
  customer: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(5).max(32).regex(/^\+?[0-9 ()-]+$/),
    email: z.email().max(254).transform(value => value.toLowerCase()).optional(),
  }).strict(),
}).strict();
export const guestAccessSchema = z.object({
  bookingCode: z.string().regex(/^SL-(?:[A-Z0-9]{6}|[A-F0-9]{24})$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type BookingInput = z.infer<typeof bookingSchema>;

const changeSelection = z.object({
  serviceId: z.uuid(), appointmentServiceId: z.uuid().optional(),
  assignmentMode: z.enum(["SPECIFIC", "ANY_AVAILABLE"]), staffId: z.uuid().optional(),
}).strict().refine(s => s.assignmentMode === "SPECIFIC" ? Boolean(s.staffId) : !s.staffId, "Select staff only for a specific assignment.");
export const changeSearchSchema = guestAccessSchema.extend({
  date: z.iso.date(), services: z.array(changeSelection).min(1).max(20),
  recovery: z.boolean(),
}).strict().refine(input => {
  const ids = input.services.flatMap(s => s.appointmentServiceId ? [s.appointmentServiceId] : []);
  return new Set(ids).size === ids.length && (!input.recovery || ids.length === 0);
}, "Retained services must be unique and cannot be used for a new recovery booking.");
export const changeSchema = changeSearchSchema.safeExtend({ startAt: z.iso.datetime({ offset: true }), reason: z.string().trim().max(1000).optional() });
export const cancellationSchema = guestAccessSchema.extend({ reason: z.string().trim().max(1000).optional() }).strict();
export type ChangeInput = z.infer<typeof changeSchema>;
export type ChangeSearch = z.infer<typeof changeSearchSchema>;

export const appointmentListQuery = z.object({
  cursor: z.uuid().optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  status: z.enum(["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"]).optional(),
  attention: z.enum(["pending-fees", "unsettled"]).optional(),
  staffId: z.uuid().optional(), search: z.string().trim().max(100).optional(),
}).strict().refine(q => !q.from || !q.to || q.from <= q.to, "The end date must follow the start date.");
export type AppointmentListQuery = z.infer<typeof appointmentListQuery>;

export const noShowCorrectionSchema = z.object({
  bookingCode: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
  customerPresent: z.literal(true),
}).strict();
export type NoShowCorrectionInput = z.infer<typeof noShowCorrectionSchema>;
