import { useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { api } from "./api";
import { selectService } from "./service-selection";
import { menuCategories, serviceMenuCategory } from "./service-categories";
import { groupServiceVariants } from "./service-variants";
import { ServiceFamilyOption } from "./service-family-option";
import { ServiceCategoryPicker } from "./service-category-picker";
import { AppointmentView, BookingForm, type BookingPlan } from "./booking";
import { money, type CatalogService, type Salon } from "./public-site";

import { ProfessionalPicker, type BookingStaff as Staff } from "./professional-picker";
type Selection = { key: number; serviceId: string; staffId: string };
type Slot = { startAt: string; endAt: string; services: { sequenceNo: number; serviceName: string; staffName: string; startAt: string; endAt: string }[] };
type Result = { timeZone: string; slots: Slot[] };
const steps = ["Services", "Professional", "Date & Time", "Information"];
const message = (error: unknown) => error instanceof Error ? error.message : "Please try again.";

export function PublicBooking({ salon }: { salon: Salon | null }) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [services, setServices] = useState<CatalogService[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [timeZone, setTimeZone] = useState("");
  const [selections, setSelections] = useState<Selection[]>([]);
  const [date, setDate] = useState("");
  const [month, setMonth] = useState("");
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [error, setError] = useState("");
  const [booked, setBooked] = useState<Parameters<typeof AppointmentView>[0] | null>(null);
  const generation = useRef(0);
  const key = useRef(0);
  async function load() {
    setLoading(true); setError("");
    try {
      const [catalog, people] = await Promise.all([api<{ services: CatalogService[] }>("/services"), api<{ timeZone: string; staff: Staff[] }>("/availability/staff")]);
      setServices(catalog.services); setStaff(people.staff); setTimeZone(people.timeZone);
      const today = Temporal.Now.zonedDateTimeISO(people.timeZone).toPlainDate().toString(); setDate(today); setMonth(today.slice(0, 7));
      const serviceId = new URLSearchParams(window.location.search).get("service");
      const initialService = catalog.services.find(s => s.id === serviceId) ?? catalog.services[0];
      setActiveCategory(initialService ? serviceMenuCategory(initialService) : "");
      setSelections(catalog.services.some(s => s.id === serviceId) ? [{ key: key.current++, serviceId: serviceId!, staffId: "" }] : []);
    } catch (err) { setError(message(err)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, []);
  useEffect(() => { titleRef.current?.focus(); }, [step]);
  function invalidate() { generation.current++; setResult(null); setSlot(null); setBusy(false); setError(""); }
  const planServices = (): BookingPlan["services"] => selections.map(s => s.staffId ? { serviceId: s.serviceId, assignmentMode: "SPECIFIC", staffId: s.staffId } : { serviceId: s.serviceId, assignmentMode: "ANY_AVAILABLE" });
  const format = (instant: string) => new Intl.DateTimeFormat("en-PH", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
  async function search() {
    const attempt = ++generation.current; setBusy(true); setError(""); setResult(null); setSlot(null);
    try { const response = await api<Result>("/availability", { method: "POST", body: JSON.stringify({ date, services: planServices() }) });
      if (attempt !== generation.current) return;
      setResult(response);
    } catch (err) { if (attempt === generation.current) setError(message(err)); }
    finally { if (attempt === generation.current) setBusy(false); }
  }
  const today = timeZone ? Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate().toString() : "";
  const first = month ? Temporal.PlainDate.from(`${month}-01`) : null;
  const total = selections.reduce((sum, row) => sum + Math.round(Number(services.find(s => s.id === row.serviceId)?.price || 0) * 100), 0) / 100;
  const duration = selections.reduce((sum, row) => sum + (services.find(s => s.id === row.serviceId)?.durationMinutes || 0), 0);
  const availableCategories = [...new Set(services.map(serviceMenuCategory))];
  const categories = [...menuCategories.filter(category => availableCategories.includes(category)), ...availableCategories.filter(category => !menuCategories.some(label => label === category))];
  const serviceFamilies = groupServiceVariants(services.filter(service => serviceMenuCategory(service) === activeCategory));
  const visibleFamilies = serviceFamilies.filter(family => `${family.name} ${family.options.map(({ service }) => `${service.name} ${service.description || ""}`).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (booked) return <section className="container page-section confirmation"><AppointmentView initial={booked.initial} token={booked.token} salon={salon} /></section>;
  return <section className="container booking-shell"><div className="booking-top"><button onClick={() => step ? setStep(step - 1) : window.location.assign("/")} disabled={bookingBusy}>← Back</button><a className="icon-button" href="/" aria-label="Close booking">×</a></div>
    {loading ? <p role="status">Loading salon services…</p> : !timeZone ? <><p className="error" role="alert">{error}</p><button onClick={() => void load()}>Retry</button></> : !services.length ? <p className="empty-state">No services are available yet.</p> : <fieldset disabled={bookingBusy} className="booking-selection booking-grid"><div className="booking-main">
      <nav className="booking-steps" aria-label="Booking progress">{steps.map((label, i) => <button key={label} disabled={i > step} aria-current={i === step ? "step" : undefined} className={step === i ? "current" : i < step ? "complete" : ""} onClick={() => setStep(i)}><span className="step-number" aria-hidden="true">{i < step ? "✓" : i + 1}</span><span>{label}</span></button>)}</nav>
      <p className="booking-kicker">A LITTLE TIME FOR YOU · STEP {step + 1} OF 4</p><h1 ref={titleRef} tabIndex={-1} className="booking-title">{["Select Services", "Select Professional", "Select Date and Time", "Customer Information"][step]}</h1><p className="booking-intro">{["Choose up to one service per category. Combine a haircut, hair color, and a hair treatment in one visit.", "A familiar face or someone new. Choose who takes care of you.", "Make room for a little self-care. Find a time that works for you.", "Just a few details and you’re ready to reserve your visit."][step]}</p>
      {error && <p role="alert" className="error">{error}</p>}
      {step === 0 && <><ServiceCategoryPicker categories={categories} active={activeCategory} onSelect={setActiveCategory} /><label className="booking-search"><span>Search services</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find your next feel-good service…" /></label><div className="service-list-heading"><h2>{activeCategory}</h2><span>{visibleFamilies.length} services</span></div><div className="picker-list">{visibleFamilies.map(family => <ServiceFamilyOption key={family.key} family={family} selectedIds={selections.map(row => row.serviceId)} onRemove={service => { invalidate(); setSelections(rows => rows.filter(row => row.serviceId !== service.id)); }} onSelect={service => { invalidate(); const selectionKey = key.current++; setSelections(rows => selectService(rows, service, services, selectionKey)); }} />)}</div>{!visibleFamilies.length && <p className="empty-state">No services match “{query}” in {activeCategory}. Try another search or category.</p>}<p className="booking-tip">Selecting another service in the same category replaces your previous choice. Use the minus (-) button or Remove in your summary to clear a selection.</p></>}
      {step === 1 && <ProfessionalPicker selections={selections} staff={staff} services={services} onSelect={(rowKey, staffId) => { invalidate(); setSelections(rows => rows.map(row => row.key === rowKey ? { ...row, staffId } : row)); }} />}
      {step === 2 && <><p className="timezone-note">All dates and times are in {timeZone}.</p><div className="calendar"><div className="calendar-heading"><h2>{first?.toLocaleString("en", { month: "long", year: "numeric" })}</h2><div><button aria-label="Previous month" disabled={month <= today.slice(0, 7)} onClick={() => setMonth(first!.subtract({ months: 1 }).toString().slice(0, 7))}>‹</button><button aria-label="Next month" onClick={() => setMonth(first!.add({ months: 1 }).toString().slice(0, 7))}>›</button></div></div><div className="calendar-grid">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <span key={d}>{d}</span>)}{Array.from({ length: (first?.dayOfWeek || 0) % 7 }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: first?.daysInMonth || 0 }, (_, i) => { const day = first!.add({ days: i }).toString(); return <button key={day} className={`calendar-day ${date === day ? "selected" : ""}`} aria-label={day} aria-pressed={date === day} disabled={day < today} onClick={() => { invalidate(); setDate(day); }}>{i + 1}</button>; })}</div></div><button className="button button--dark" disabled={busy || !date} onClick={() => void search()}>{busy ? "Finding times…" : "Find available times"}</button>
        {result && <section className="availability-results"><h2>Available times</h2><p className="muted">Availability is checked again when you reserve your visit.</p>{!result.slots.length ? <p role="status">No times match this visit. Try another date or professional.</p> : <div className="time-options" role="group" aria-label="Available appointment times">{result.slots.map(s => <button type="button" className={`time-slot ${slot?.startAt === s.startAt ? "selected" : ""}`} key={s.startAt} aria-pressed={slot?.startAt === s.startAt} onClick={() => setSlot(s)}>{format(s.startAt)}</button>)}</div>}</section>}
      </>}
      {step === 3 && slot && <><p className="muted">Your appointment begins with a temporary hold. Pay the appointment fee to confirm it.</p><BookingForm plan={{ date, startAt: slot.startAt, services: planServices() }} onBusy={setBookingBusy} onBooked={response => setBooked({ initial: response.appointment, token: response.guestToken })} /></>}
    </div><aside className="booking-summary" aria-label="Appointment summary"><div className="summary-brand"><span className="summary-monogram" aria-hidden="true">C</span><div><p className="booking-kicker">YOUR APPOINTMENT</p><h2>{salon?.profile?.name || "Clique Salon"}</h2></div></div>{salon?.profile?.address && <p className="muted">⌖ {salon.profile.address}</p>}<div className="summary-items">{!selections.length && <div className="summary-empty"><span aria-hidden="true">✧</span><h3>A moment, just for you.</h3><p className="muted">Choose your services to start building your perfect visit.</p></div>}{selections.map((row, i) => { const service = services.find(s => s.id === row.serviceId); const person = staff.find(s => s.id === row.staffId); return <div className="summary-item" key={row.key}><div className="card-actions"><strong>{i + 1}. {service?.name}</strong><span>{money(service?.price || "0")}</span></div><p className="muted">{service?.durationMinutes} min · {person ? `${person.firstName} ${person.lastName}` : "Any available professional"}</p>{step === 0 && <div className="summary-actions"><button aria-label={`Remove service ${i + 1}`} onClick={() => { invalidate(); setSelections(rows => rows.filter(s => s.key !== row.key)); }}>Remove</button><button disabled={i === 0} aria-label={`Move service ${i + 1} earlier`} onClick={() => { invalidate(); setSelections(rows => { const next = [...rows]; [next[i - 1], next[i]] = [next[i]!, next[i - 1]!]; return next; }); }}>Move earlier</button></div>}</div>; })}</div>{step >= 2 && date && <div className="summary-schedule"><p className="booking-kicker">YOUR VISIT</p><p>{Temporal.PlainDate.from(date).toLocaleString("en", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</p><small>{timeZone}</small>{slot && <><p>{format(slot.startAt)} – {format(slot.endAt)}</p><ol>{slot.services.map(s => <li key={s.sequenceNo}>{s.serviceName} · {s.staffName}<br />{format(s.startAt)} – {format(s.endAt)}</li>)}</ol></>}</div>}<div className="summary-meta" aria-live="polite"><span>{selections.length} {selections.length === 1 ? "service" : "services"}</span><span>{duration} min total</span></div><div className="card-actions summary-total"><strong>Service total</strong><strong>{money(total)}</strong></div><p className="muted">The appointment fee is separate from service charges. Final prices and assignments are confirmed when the hold is created.</p>{step < 3 && <button className="button button--dark" disabled={!selections.length || (step === 2 && !slot)} onClick={() => setStep(step + 1)}>{["Choose professional", "Choose date & time", "Enter your details"][step]} <span aria-hidden="true">→</span></button>}{!selections.length && <p className="summary-hint">Select a service to continue</p>}<a className="booking-help" href="/help">Need a hand? Visit the salon guide ↗</a></aside></fieldset>}
  </section>;
}

