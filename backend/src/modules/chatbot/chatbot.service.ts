import type { createConfigurationService } from "../configuration/configuration.service.js";
type Configuration = ReturnType<typeof createConfigurationService>;
export type ChatbotSource = { [K in "publicSalon" | "publicServices" | "publicPolicy"]: () => Promise<Awaited<ReturnType<Configuration[K]>>> };
export function chatbotTopic(message: string) {
  const text = message.toLowerCase();
  if (/\b(cancel|cancellation)\b/.test(text)) return "cancel";
  if (/\b(reschedule|rescheduling|change|move)\b/.test(text)) return "reschedule";
  if (/\b(available|availability|slot|today|tomorrow)\b/.test(text)) return "availability";
  if (/\b(service|services|price|prices|cost|haircut|color|colour|treatment)\b/.test(text)) return "services";
  if (/\b(hour|hours|open|opening|close|closing|address|location|contact|phone|email)\b/.test(text)) return "salon";
  if (/\b(policy|policies|fee|fees|payment|pay|hold|late|no.show)\b/.test(text)) return "policy";
  if (/\b(book|booking|appointment|appointments)\b/.test(text)) return "booking";
  return "help";
}
// Read-only guidance. No generated availability, private appointment lookup, or mutations.
export function createChatbotService(source: ChatbotSource) {
  return { async answer(message: string) {
    const topic = chatbotTopic(message);
    const links = [{ label: "Find a time and book", href: "/availability" }, { label: "Manage my appointment", href: "/appointment" }];
    let answer: string;
    switch (topic) {
      case "services": {
        const services = (await source.publicServices()).filter(s => s.price.gt(0));
        answer = services.length ? services.map(s => `${s.name}: PHP ${s.price.toFixed(2)}, ${s.durationMinutes} minutes.${s.description ? ` ${s.description}` : ""}`).join("\n") : "No services are currently listed. Please contact the salon.";
        break;
      }
      case "salon": {
        const salon = await source.publicSalon();
        const details = salon.profile ? [salon.profile.name, salon.profile.address, salon.profile.phone, salon.profile.email].filter(Boolean).join(" · ") : "Salon contact information has not been configured.";
        const hours = salon.hours.map(h => `${h.dayOfWeek}: ${h.openTime.toISOString().slice(11, 16)}–${h.closeTime.toISOString().slice(11, 16)}`).join("\n");
        const closures = salon.closures.map(c => `${c.startsAt.toLocaleString("en-PH", { timeZone: salon.timeZone })}–${c.endsAt.toLocaleString("en-PH", { timeZone: salon.timeZone })}`).join("\n");
        answer = `${details}\nHours (${salon.timeZone}):\n${hours || "No opening hours are listed."}${closures ? `\nUpcoming closures:\n${closures}` : ""}\nOpening hours do not guarantee an available appointment. Use Find a time to check.`;
        break;
      }
      case "policy": {
        const p = await source.publicPolicy();
        answer = p ? `Current policy for new bookings (version ${p.version}): appointment fee ${p.appointmentFeeType === "FIXED" ? `PHP ${p.appointmentFeeAmount.toFixed(2)}` : `${p.appointmentFeeAmount.toString()}%`}; payment hold ${p.bookingHoldMinutes} minutes; book at least ${p.minimumBookingLeadMinutes} minutes ahead and up to ${p.advanceBookingDays} days ahead. Up to ${p.maxReschedules} reschedules, at least ${p.rescheduleCutoffHours} hours before the appointment. Cancellation cutoff: ${p.cancellationCutoffHours} hours before the appointment. No-show recovery grace: ${p.noShowGraceHours} hours. Existing appointments retain their original policy. The appointment fee is separate from the post-service charge. Late payments require salon review and do not restore expired reservations.` : "Booking policies are not configured yet. Please contact the salon.";
        break;
      }
      case "cancel": answer = "Open Manage my appointment using your booking code and secure guest token. Only eligible confirmed appointments can be cancelled, at or before the cancellation cutoff in that appointment’s original policy. After the cutoff, contact the salon. Cancellation releases the reservation. The collected appointment fee remains unchanged."; break;
      case "reschedule": answer = "Open Manage my appointment using your booking code and secure guest token. An eligible confirmed appointment may be rescheduled within its original policy’s cutoff and reschedule limit. Choose services, staff and a new time; the backend checks the complete plan. Your current reservation remains if the change fails."; break;
      case "availability": answer = "Use Find a time and book to select your services, staff preference and date. That screen requests live availability from the salon’s scheduling service. Suggested times remain subject to revalidation when you book; this chat cannot confirm or reserve a time."; break;
      case "booking": answer = "Choose Find a time and book, select services and staff preferences, then choose an available date and time. Enter your contact details and submit. Keep the booking code and secure guest token privately. Pay the appointment fee before the hold expires; a booking is confirmed only after the backend verifies timely payment. Use Manage my appointment to view its status."; break;
      default: answer = "I can help with services and prices, opening hours and contact details, booking policies, booking, rescheduling or cancellation. Choose a topic or ask a salon question. For other questions, contact the salon. Please keep passwords, payment details and guest tokens out of chat.";
    }
    return { mode: "guided", topic, answer, links };
  } };
}
