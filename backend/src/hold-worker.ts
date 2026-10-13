import { createAppointmentChangesService } from "./modules/appointments/appointment-changes.service.js";
import { pruneAppointmentAccess } from "./modules/appointments/appointment-otp.service.js";
import { prisma, disconnectDatabase } from "./database/prisma.js";
import { env } from "./config/env.js";
import { createAppointmentsService } from "./modules/appointments/appointments.service.js";
import { createPaymentsService } from "./modules/payments/payments.service.js";
import { configuredPaymentProvider } from "./modules/payments/provider-config.js";
const service = createAppointmentsService(prisma, env.SALON_TIMEZONE);
const payments = createPaymentsService(prisma, configuredPaymentProvider(env), env.SALON_TIMEZONE);
const changes = createAppointmentChangesService(prisma, env.SALON_TIMEZONE);
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
let nextAccessCleanup = 0;
async function tick() {
  if (Date.now() >= nextAccessCleanup) {
    nextAccessCleanup = Date.now() + 3600000;
    try { await pruneAppointmentAccess(prisma); }
    catch { console.error(JSON.stringify({ level: "error", event: "appointment_access_cleanup_failed" })); }
  }
  try { await service.expireHolds(); }
  catch { console.error(JSON.stringify({ level: "error", event: "hold_expiration_failed" })); }
  try { await changes.markOverdueNoShows(); }
  catch { console.error(JSON.stringify({ level: "error", event: "automatic_no_show_failed" })); }
  try { await payments.synchronizeExpired(1); }
  catch { console.error(JSON.stringify({ level: "error", event: "payment_cleanup_failed" })); }
  if (!stopping) timer = setTimeout(startTick, 5000);
}
function startTick() { running = tick(); }
async function stop() {
  if (stopping) return;
  stopping = true; clearTimeout(timer);
  const timeout = setTimeout(() => process.exit(1), 25_000); timeout.unref();
  try { await running; await disconnectDatabase(); }
  catch { process.exitCode = 1; }
  finally { clearTimeout(timeout); }
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
startTick();
