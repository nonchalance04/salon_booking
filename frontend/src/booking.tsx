import { PhoneInput } from "./phone-input";
import { philippinePhoneNumber } from "./phone-number";
import { AppointmentOtp } from "./appointment-otp";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { AppointmentManagement } from "./appointment-management";
import { FeePaymentControls, FeePaymentHistory, type FeePayment } from "./payments";
import { BookingConfirmation } from "./booking-confirmation";
import type { Salon } from "./public-site";
export type BookingPlan = { date: string; startAt: string; services: ({ serviceId: string; assignmentMode: "ANY_AVAILABLE" } | { serviceId: string; assignmentMode: "SPECIFIC"; staffId: string })[] };
export type Appointment = {
  checkedInAt: string | null; checkedInByUser?: { firstName: string; lastName: string } | null;
  rescheduleCount: number; cancelledAt: string | null; noShowAt: string | null; noShowGraceExpiresAt: string | null;
  recoveryAppointment: { bookingCode: string } | null; carriedAppointmentFeePaymentId: string | null;
  bookingPolicyVersion: { maxReschedules: number; rescheduleCutoffHours: number; cancellationCutoffHours: number; noShowGraceHours: number };
  payments: FeePayment[];
  bookingCode: string; status: string; startAt: string; endAt: string; holdExpiresAt: string | null;
  appointmentFeeAmount: string; serverTime: string; timeZone: string;
  customer: { firstName: string; lastName: string };
  appointmentServices: { id: string; serviceId: string; staffId: string; sequenceNo: number; serviceNameSnapshot: string; priceSnapshot: string; scheduledStartAt: string; scheduledEndAt: string; staff: { firstName: string; lastName: string } }[];
};
type BookingResult = { appointment: Appointment; guestToken: string };
const message = (error: unknown) => error instanceof Error ? error.message : "Please try again.";
export function BookingForm({ plan, onBusy, onBooked }: { plan: BookingPlan; onBusy: (busy: boolean) => void; onBooked: (result: BookingResult) => void }) {
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const data = new FormData(event.currentTarget);
    sending.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const email = String(data.get("email")).trim();
      const result = await api<BookingResult>("/appointments", { method: "POST", body: JSON.stringify({ ...plan,
        customer: { firstName: String(data.get("firstName")).trim(), lastName: String(data.get("lastName")).trim(), phone: philippinePhoneNumber(String(data.get("phone"))), ...(email ? { email } : {}) },
      }) });
      onBooked(result);
    } catch (err) { setError(message(err)); }
    finally { sending.current = false; setBusy(false); onBusy(false); }
  }
  return <form className="account-form" onSubmit={submit}><h3>Your contact details</h3>
    <fieldset disabled={busy}><div className="form-grid">
      <label>First name<input name="firstName" required maxLength={100} autoComplete="given-name" /></label>
      <label>Last name<input name="lastName" required maxLength={100} autoComplete="family-name" /></label>
      <label>Phone<PhoneInput name="phone" /></label>
      <label>Email (optional)<input name="email" type="email" maxLength={254} autoComplete="email" /></label>
    </div></fieldset>
    <p>Submitting reserves a temporary hold. Your booking is confirmed only after appointment-fee payment.</p>
    <p className="muted">Availability, fees, and Any Available staff assignments are checked again when you submit.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? "Reserving your visit…" : "Reserve a temporary hold"}</button>
  </form>;
}
export function AppointmentView({ initial, token: initialToken, salon = null }: { initial: Appointment; token: string; salon?: Salon | null }) {
  const [appointment, setAppointment] = useState(initial);
  const [token, setToken] = useState(initialToken);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [managing, setManaging] = useState(false);
  // Monotonic elapsed time avoids relying on the customer's wall clock.
  const clock = useRef({ received: performance.now(), server: Date.parse(initial.serverTime) });
  const refreshBusy = useRef(false);
  const activeCode = useRef(appointment.bookingCode); activeCode.current = appointment.bookingCode;
  async function refresh() {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    try {
      const response = await api<{ appointment: Appointment }>("/appointments/access", { method: "POST", body: JSON.stringify({ bookingCode: appointment.bookingCode, token }) });
      if (response.appointment.bookingCode !== activeCode.current) return;
      clock.current = { received: performance.now(), server: Date.parse(response.appointment.serverTime) };
      setAppointment(response.appointment); setError("");
    } catch (err) { setError(message(err)); }
    finally { refreshBusy.current = false; }
  }
  useEffect(() => {
    const tick = () => setRemaining(appointment.holdExpiresAt ? Math.max(0, Math.ceil((Date.parse(appointment.holdExpiresAt) - clock.current.server - (performance.now() - clock.current.received)) / 1000)) : 0);
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [appointment]);
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [appointment.bookingCode, token]);
  const format = (value: string) => new Intl.DateTimeFormat(undefined, { timeZone: appointment.timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const date = (value: string) => new Intl.DateTimeFormat("en-PH", { timeZone: appointment.timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(value));
  const time = (value: string) => new Intl.DateTimeFormat("en-PH", { timeZone: appointment.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
  const money = (value: string | number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(Number(value));
  const serviceTotal = appointment.appointmentServices.reduce((sum, service) => sum + Math.round(Number(service.priceSnapshot) * 100), 0) / 100;
  if (appointment.status === "CONFIRMED" && !managing) return <BookingConfirmation key={appointment.bookingCode} appointment={appointment} salon={salon} token={token} onManage={() => setManaging(true)} />;
  return <section className="visit-summary reservation" aria-label="Your booking">
    <header className="reservation-header">
      <div><p className="booking-kicker">BOOKING REFERENCE</p><h2>{appointment.bookingCode}</h2><p className="muted">Booked for {appointment.customer.firstName} {appointment.customer.lastName}</p></div>
      <span className={`reservation-status reservation-status--${appointment.status.toLowerCase()}`}>{appointment.status.replaceAll("_", " ")}</span>
    </header>
    {appointment.status === "CONFIRMED" && <p role="status" className="reservation-notice reservation-notice--success">✓ Your appointment is confirmed. We look forward to seeing you.</p>}
    {appointment.status === "EXPIRED" && <p className="reservation-notice">This hold has expired and the time is released. <a href="/availability">Find another time →</a></p>}
    <div className="reservation-grid"><div className="reservation-main">
      <section className="reservation-card" aria-label="Visit details"><p className="booking-kicker">YOUR VISIT</p><h3>{date(appointment.startAt)}</h3><p className="reservation-time">{time(appointment.startAt)} – {time(appointment.endAt)}</p><p className="muted reservation-timezone">All times are in {appointment.timeZone}.</p>
        <ol className="reservation-services">{appointment.appointmentServices.map(service => <li key={service.sequenceNo}><div className="reservation-service-heading"><strong>{service.serviceNameSnapshot}</strong><strong>{money(service.priceSnapshot)}</strong></div><p className="muted">{service.staff.firstName} {service.staff.lastName}</p><p className="reservation-service-time">{format(service.scheduledStartAt)} – {time(service.scheduledEndAt)}</p></li>)}</ol>
        <div className="reservation-total"><span>Service total</span><strong>{money(serviceTotal)}</strong></div><p className="muted reservation-footnote">Service charges are separate from the appointment fee.</p>
      </section>
      <div className="reservation-card reservation-management"><AppointmentManagement key={appointment.bookingCode} appointment={appointment} token={token} onChange={(updated, newToken) => {
        clock.current = { received: performance.now(), server: Date.parse(updated.serverTime) };
        setAppointment(updated); if (newToken) setToken(newToken);
      }} /></div>
    </div><aside className="reservation-sidebar" aria-label="Payment and booking access">
      {appointment.status === "PENDING_PAYMENT" && <section className="reservation-card reservation-payment"><p className="booking-kicker">COMPLETE YOUR RESERVATION</p><h3>Confirm your visit</h3><p className="muted">Pay the appointment fee before your temporary hold expires.</p>
        <div className="reservation-hold" role="status"><span>Temporary hold</span><strong>{remaining > 0 ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "Time elapsed"}</strong><span>{remaining > 0 ? "remaining to complete payment" : "Refresh to check the latest status."}</span></div>
        <div className="reservation-fee"><span>Appointment fee</span><strong>{money(appointment.appointmentFeeAmount)}</strong></div><p className="muted reservation-footnote">Separate from your service charges.</p>
        <FeePaymentControls bookingCode={appointment.bookingCode} token={token} onChange={refresh} pending={appointment.payments?.find(p => p.status === "PENDING")} />
      </section>}
      {!!appointment.payments?.length && <div className="reservation-card reservation-history"><FeePaymentHistory payments={appointment.payments} /></div>}
    </aside></div>
    <footer className="reservation-footer"><p className="muted">Check the latest booking and payment updates.</p><button type="button" onClick={() => void refresh()}>Refresh status ↻</button></footer>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;

}
function readGuestCredentials() {
    if (window.location.pathname === "/a" && /^[A-Za-z0-9_-]{43}$/.test(window.location.hash.slice(1))) {
      const token = window.location.hash.slice(1);
      window.history.replaceState(null, "", "/appointment");
      return { bookingCode: "", token };
    }
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Fragments never go to the server. Remove it from the current history entry
    // after reading; keep the token in component memory, not browser storage.
    if (params.has("code") || params.has("token")) window.history.replaceState(null, "", "/appointment");
    return { bookingCode: params.get("code") ?? "", token: params.get("token") ?? "" };
}
export function GuestAppointment({ embedded = false, salon = null }: { embedded?: boolean; salon?: Salon | null } = {}) {
  const [credentials, setCredentials] = useState(readGuestCredentials);
  const [result, setResult] = useState<Appointment | null>(null);
  const [token, setToken] = useState(credentials.token);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    const expired = () => { requestGeneration.current++; setResult(null); setToken(""); setCredentials({ bookingCode: "", token: "" }); setError("Your session expired. Verify your email or phone number again."); };
    window.addEventListener("guest-session-expired", expired);
    return () => window.removeEventListener("guest-session-expired", expired);
  }, []);
  async function retrieve(bookingCode: string, accessToken: string) {
    const generation = ++requestGeneration.current;
    setBusy(true); setError(""); setResult(null);
    try { const response = await api<{ appointment: Appointment }>(bookingCode ? "/appointments/access" : "/appointments/link", { method: "POST", body: JSON.stringify(bookingCode ? { bookingCode, token: accessToken } : { token: accessToken }) });
      if (generation === requestGeneration.current) { setToken(accessToken); setResult(response.appointment); }
    }
    catch (err) { if (generation === requestGeneration.current) setError(message(err)); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  }
  useEffect(() => {
    const changed = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      if (!params.has("code") && !params.has("token")) return;
      requestGeneration.current++;
      setResult(null); setToken(""); setError(""); setBusy(false);
      setCredentials(readGuestCredentials());
    };
    window.addEventListener("hashchange", changed);
    return () => { window.removeEventListener("hashchange", changed); requestGeneration.current++; };
  }, []);
  useEffect(() => { if (credentials.token) void retrieve(credentials.bookingCode, credentials.token); }, [credentials]);
  return <div className={embedded ? "guest-appointment container page-section" : "workspace"}>{!embedded && <header><a className="wordmark" href="/availability">CLIQUE<span>SALON</span></a><a href="/availability">Find a salon time</a><a href="/help">Salon help</a></header>}
    <section className={embedded ? `manage-panel${result ? " reservation-page" : ""}` : "workspace-main availability-page"}>{!result && <><p className="eyebrow">YOUR VISIT</p><h1 className="section-title">Your appointment</h1></>}
      {result ? <><AppointmentView key={result.bookingCode} initial={result} token={token} salon={salon} />
        {!token && <button type="button" onClick={() => { void api("/appointments/otp/logout", { method: "POST" }).then(() => { window.location.assign("/"); }).catch(err => setError(message(err))); }}>Back to home</button>}
      </> : <>
        {(!credentials.token || Boolean(error)) && <AppointmentOtp onVerified={appointment => { requestGeneration.current++; setToken(""); setResult(appointment); setError(""); }} />}
        {busy && <p role="status">Loading your appointment…</p>}
        <p className="muted">After PayMongo checkout, your appointment restores automatically on this browser. If your session has expired, verify your email or phone number above.</p>
      </>}{error && <p role="alert" className="error">{error}</p>}
    </section></div>;
}
