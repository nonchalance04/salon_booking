import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client.js";

const text = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(2000).nullable();
const integer = z.number().int().min(0).max(2_147_483_647);
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).refine(v => new Prisma.Decimal(v).greaterThanOrEqualTo(0));
const positiveMoney = money.refine(v => new Prisma.Decimal(v).greaterThan(0));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);
const date = z.iso.date().nullable();
const instant = z.iso.datetime({ offset: true, precision: 3 });
// Accept explicit-offset timestamps with or without fractional seconds.
const timestamp = z.union([instant, z.iso.datetime({ offset: true })]).transform(v => new Date(v));
export const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export const profileSchema = z.object({
  name: text, address: z.string().trim().min(1).max(2000),
  phone: z.string().trim().max(50).nullable(), email: z.email().nullable(),
}).strict();
export const serviceSchema = z.object({
  name: text, description: optionalText, price: positiveMoney,
  category: z.string().trim().min(1).max(100).optional(),
  durationMinutes: integer.min(1), bufferMinutes: integer.nullable(), isActive: z.boolean(),
}).strict();
export const staffSchema = z.object({ firstName: text, lastName: text, phone: z.string().trim().max(50).nullable(), isActive: z.boolean() }).strict();
export const staffUpdateSchema = staffSchema.extend({ lastName: z.string().trim().max(200).default("") });
export const qualificationSchema = z.object({
  staffId: z.uuid(), serviceId: z.uuid(), isActive: z.boolean(),
  commissionRate: z.string().regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/),
}).strict();
export const staffSkillsSchema = z.object({
  services: z.array(qualificationSchema.pick({ serviceId: true, commissionRate: true })).max(500),
}).strict().refine(input => new Set(input.services.map(row => row.serviceId)).size === input.services.length,
  "Select each service only once.");
export type StaffSkillsInput = z.infer<typeof staffSkillsSchema>;
export const hoursSchema = z.object({ dayOfWeek: z.enum(days), openTime: time, closeTime: time, isActive: z.boolean() }).strict()
  .refine(v => v.openTime.padEnd(8, ":00") < v.closeTime.padEnd(8, ":00"), "Opening must precede closing.");
export const scheduleSchema = z.object({
  staffId: z.uuid(), dayOfWeek: z.enum(days), startTime: time, endTime: time,
  effectiveFrom: date, effectiveTo: date, isActive: z.boolean(),
}).strict().refine(v => v.startTime.padEnd(8, ":00") < v.endTime.padEnd(8, ":00"), "Start must precede end.")
  .refine(v => !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, "Invalid effective date range.");
const intervalFields = { startsAt: timestamp, endsAt: timestamp, reason: optionalText };
export const closureSchema = z.object(intervalFields).strict().refine(v => v.startsAt < v.endsAt, "Start must precede end.");
export const unavailabilitySchema = z.object({ ...intervalFields, staffId: z.uuid() }).strict().refine(v => v.startsAt < v.endsAt, "Start must precede end.");
export const policySchema = z.object({
  appointmentFeeType: z.literal("FIXED"), appointmentFeeAmount: money,
  bookingHoldMinutes: integer.min(1), defaultBufferMinutes: integer, maxReschedules: integer,
  rescheduleCutoffHours: integer, cancellationCutoffHours: integer, noShowGraceHours: integer,
  advanceBookingDays: integer.min(1), minimumBookingLeadMinutes: integer,
  effectiveFrom: timestamp.nullable(),
}).strict();
export const recordId = z.object({ id: z.uuid() });
export type ProfileInput = z.infer<typeof profileSchema>;
export type ServiceInput = z.infer<typeof serviceSchema>;
export type StaffInput = z.infer<typeof staffSchema>;
export type QualificationInput = z.infer<typeof qualificationSchema>;
export type HoursInput = z.infer<typeof hoursSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type ClosureInput = z.infer<typeof closureSchema>;
export type UnavailabilityInput = z.infer<typeof unavailabilitySchema>;
export type PolicyInput = z.infer<typeof policySchema>;

const imageUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use an HTTPS image URL without credentials.");
export const staffPublicProfileSchema = z.object({
  title: z.string().trim().min(1).max(100),
  bio: z.string().trim().max(2000),
  photoUrl: imageUrl.nullable(),
  languages: z.array(z.string().trim().min(1).max(40)).max(10),
  portfolio: z.array(z.object({ title: z.string().trim().min(1).max(100), imageUrl, caption: z.string().trim().max(300) }).strict()).max(8),
  reviews: z.array(z.object({ author: z.string().trim().min(1).max(100), rating: z.number().int().min(1).max(5), text: z.string().trim().min(1).max(1000) }).strict()).max(10),
}).strict();
export type StaffPublicProfileInput = z.infer<typeof staffPublicProfileSchema>;
