import { WaitingQueue } from "./waiting-queue";
import { NoShowCorrection } from "./no-show-correction";
import { AppointmentCheckIn } from "./appointment-check-in";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Appointment } from "./booking";
import type { AppointmentFilters } from "./admin-dashboard";

type Selection = {
  key: number;
  serviceId: string;
  appointmentServiceId?: string;
  staffId: string;
  label: string;
};
type Catalog = { id: string; name: string; price: string };
type Staff = {
  id: string;
  firstName: string;
  lastName: string;
  serviceIds: string[];
};
type Slot = {
  startAt: string;
  endAt: string;
  services: { serviceName: string; staffName: string }[];
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Please try again.";
export function AppointmentManagement({
  appointment,
  token,
  onChange,
}: {
  appointment: Appointment;
  token: string;
  onChange: (appointment: Appointment, token?: string) => void;
}) {
  const recovery = appointment.status === "NO_SHOW";
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [services, setServices] = useState<Catalog[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rows, setRows] = useState<Selection[]>([]);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [startAt, setStartAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(0);
  const generation = useRef(0);
  const policy = appointment.bookingPolicyVersion;
  const now = Date.parse(appointment.serverTime);
  const canChange =
    !appointment.checkedInAt &&
    appointment.rescheduleCount < policy.maxReschedules &&
    (recovery
      ? !appointment.recoveryAppointment &&
        now <=
          Date.parse(appointment.startAt) + policy.noShowGraceHours * 3_600_000
      : appointment.status === "CONFIRMED" &&
        now <=
          Date.parse(appointment.startAt) -
            policy.rescheduleCutoffHours * 3_600_000);
  const canCancel =
    !appointment.checkedInAt &&
    appointment.status === "CONFIRMED" &&
    now <=
      Date.parse(appointment.startAt) -
        policy.cancellationCutoffHours * 3_600_000;
  const format = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: appointment.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  function invalidate() {
    generation.current++;
    setSlots(null);
    setStartAt("");
  }
  async function open() {
    setBusy(true);
    setError("");
    try {
      const [catalog, people] = await Promise.all([
        api<{ services: Catalog[] }>("/services"),
        api<{ staff: Staff[] }>("/availability/staff"),
      ]);
      setServices(catalog.services);
      setStaff(people.staff);
      setRows(
        appointment.appointmentServices
          .filter(
            (s) =>
              !recovery || catalog.services.some((c) => c.id === s.serviceId),
          )
          .map((s) => ({
            key: key.current++,
            serviceId: s.serviceId,
            ...(recovery ? {} : { appointmentServiceId: s.id }),
            staffId: s.staffId,
            label: s.serviceNameSnapshot,
          })),
      );
      setEditing(true);
      invalidate();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const body = () => ({
    bookingCode: appointment.bookingCode,
    token,
    recovery,
    date,
    services: rows.map((row) => ({
      serviceId: row.serviceId,
      ...(row.appointmentServiceId
        ? { appointmentServiceId: row.appointmentServiceId }
        : {}),
      ...(row.staffId
        ? { assignmentMode: "SPECIFIC", staffId: row.staffId }
        : { assignmentMode: "ANY_AVAILABLE" }),
    })),
  });
  async function search() {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setSlots(null);
    setStartAt("");
    try {
      const result = await api<{ slots: Slot[] }>(
        "/appointments/change-options",
        { method: "POST", body: JSON.stringify(body()) },
      );
      if (generation.current === request) setSlots(result.slots);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        appointment: Appointment;
        guestToken?: string;
      }>("/appointments/change", {
        method: "POST",
        body: JSON.stringify({ ...body(), startAt, reason }),
      });
      setEditing(false);
      invalidate();
      onChange(result.appointment, result.guestToken);
    } catch (err) {
      setError(message(err));
      invalidate();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await api("/appointments/cancel", {
        method: "POST",
        body: JSON.stringify({
          bookingCode: appointment.bookingCode,
          token,
          reason,
        }),
      });
      const result = await api<{ appointment: Appointment }>(
        "/appointments/access",
        {
          method: "POST",
          body: JSON.stringify({ bookingCode: appointment.bookingCode, token }),
        },
      );
      setConfirmCancel(false);
      setEditing(false);
      onChange(result.appointment);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Manage appointment">
      <h3>Manage your appointment</h3>
      <p>
        {appointment.rescheduleCount} of {policy.maxReschedules} allowed changes
        used.
      </p>
      {appointment.carriedAppointmentFeePaymentId && (
        <p>
          Appointment fee satisfied by credit from the missed booking. No
          additional appointment-fee payment is due.
        </p>
      )}
      {appointment.recoveryAppointment && (
        <p>
          Replacement booking: {appointment.recoveryAppointment.bookingCode}.
          Verify your phone number on Your appointment to manage the replacement
          booking.
        </p>
      )}
      {canChange && !editing && (
        <button disabled={busy} onClick={() => void open()}>
          {recovery
            ? "Request a recovery booking"
            : "Reschedule or change services"}
        </button>
      )}
      {canCancel && (
        <button disabled={busy} onClick={() => setConfirmCancel(true)}>
          Cancel appointment
        </button>
      )}
      {!canChange && !canCancel && !appointment.recoveryAppointment && (
        <p>
          No customer changes are currently available. Please contact the salon
          for assistance.
        </p>
      )}
      {confirmCancel && (
        <fieldset disabled={busy}>
          <legend>Confirm cancellation</legend>
          <p>
            This releases your reserved time. The collected appointment fee
            remains unchanged.
          </p>
          <button onClick={() => void cancel()}>Confirm cancellation</button>
          <button onClick={() => setConfirmCancel(false)}>
            Keep appointment
          </button>
        </fieldset>
      )}
      {editing && (
        <form
          className="account-form"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <fieldset disabled={busy}>
            <legend>
              {recovery ? "Replacement visit" : "Replacement schedule"}
            </legend>
            <p>
              {recovery
                ? "The original policy applies. An eligible unused appointment fee is carried automatically; otherwise the new booking requires payment."
                : "Retained services keep their booked prices and durations. Added services use current values."}
            </p>
            {rows.map((row, index) => (
              <fieldset key={row.key}>
                <legend>Service {index + 1}</legend>
                {row.appointmentServiceId ? (
                  <p>{row.label} · retained booked service</p>
                ) : (
                  <label>
                    Service
                    <select
                      value={row.serviceId}
                      onChange={(e) => {
                        invalidate();
                        setRows((items) =>
                          items.map((r) =>
                            r.key === row.key
                              ? { ...r, serviceId: e.target.value, staffId: "" }
                              : r,
                          ),
                        );
                      }}
                    >
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · PHP {s.price}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Staff
                  <select
                    value={row.staffId}
                    onChange={(e) => {
                      invalidate();
                      setRows((items) =>
                        items.map((r) =>
                          r.key === row.key
                            ? { ...r, staffId: e.target.value }
                            : r,
                        ),
                      );
                    }}
                  >
                    <option value="">Any available staff</option>
                    {row.staffId &&
                      !staff.some(
                        (s) =>
                          s.id === row.staffId &&
                          s.serviceIds.includes(row.serviceId),
                      ) && (
                        <option value={row.staffId}>
                          Previous staff (availability will be checked)
                        </option>
                      )}
                    {staff
                      .filter((s) => s.serviceIds.includes(row.serviceId))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.firstName} {s.lastName}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    invalidate();
                    setRows((items) => {
                      const copy = [...items];
                      [copy[index - 1], copy[index]] = [
                        copy[index]!,
                        copy[index - 1]!,
                      ];
                      return copy;
                    });
                  }}
                >
                  Move earlier
                </button>
                <button
                  type="button"
                  onClick={() => {
                    invalidate();
                    setRows((items) => items.filter((r) => r.key !== row.key));
                  }}
                >
                  Remove service {index + 1}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={!services.length || rows.length >= 20}
              onClick={() => {
                invalidate();
                setRows((items) => [
                  ...items,
                  {
                    key: key.current++,
                    serviceId: services[0]!.id,
                    staffId: "",
                    label: services[0]!.name,
                  },
                ]);
              }}
            >
              Add service
            </button>
            <label>
              Visit date ({appointment.timeZone})
              <input
                type="date"
                value={date}
                required
                onChange={(e) => {
                  invalidate();
                  setDate(e.target.value);
                }}
              />
            </label>
            <label>
              Reason (optional)
              <textarea
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button disabled={!rows.length}>Find available times</button>
            <button type="button" onClick={() => setEditing(false)}>
              Close changes
            </button>
            {slots &&
              (slots.length ? (
                <>
                  <label>
                    Available start
                    <select
                      value={startAt}
                      onChange={(e) => setStartAt(e.target.value)}
                    >
                      <option value="">Choose a time</option>
                      {slots.map((s) => (
                        <option key={s.startAt} value={s.startAt}>
                          {format(s.startAt)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {startAt && (
                    <>
                      <ol>
                        {slots
                          .find((s) => s.startAt === startAt)
                          ?.services.map((s, i) => (
                            <li key={i}>
                              {s.serviceName} with {s.staffName}
                            </li>
                          ))}
                      </ol>
                      <p>
                        Availability and eligibility are checked again when you
                        confirm.
                      </p>
                      <button type="button" onClick={() => void save()}>
                        {recovery
                          ? "Create replacement booking"
                          : "Confirm appointment changes"}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <p role="status">
                  No available times. Try another date or staff member.
                </p>
              ))}
          </fieldset>
        </form>
      )}
      {busy && <p role="status">Working…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
export function AdminAppointments({
  initialFilters = {},
  onPayment,
  onSettlement,
}: {
  initialFilters?: AppointmentFilters;
  onPayment?: (code: string) => void;
  onSettlement?: (code: string) => void;
}) {
  const [rows, setRows] = useState<Appointment[]>([]);
  const [filters, setFilters] = useState<AppointmentFilters>(initialFilters);
  const [staff, setStaff] = useState<
    { id: string; firstName: string; lastName: string }[]
  >([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zone, setZone] = useState("");
  const generation = useRef(0);
  async function load(next?: string, queryFilters = filters) {
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    const query = new URLSearchParams(
      Object.entries(queryFilters).filter(([, value]) => Boolean(value)) as [
        string,
        string,
      ][],
    );
    if (next) query.set("cursor", next);
    try {
      const result = await api<{
        appointments: Appointment[];
        nextCursor: string | null;
      }>(`/appointments?${query}`);
      if (attempt !== generation.current) return;
      setRows((previous) =>
        next ? [...previous, ...result.appointments] : result.appointments,
      );
      setCursor(result.nextCursor);
    } catch (err) {
      if (attempt === generation.current) setError(message(err));
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    void Promise.all([
      api<{ staff: { id: string; firstName: string; lastName: string }[] }>(
        "/configuration",
      ),
      api<{ timeZone: string }>("/salon"),
    ])
      .then(([catalog, salon]) => {
        setStaff(catalog.staff);
        setZone(salon.timeZone);
      })
      .catch((err) => setError(message(err)));
    return () => {
      generation.current++;
    };
  }, []);
  async function mark(code: string) {
    setBusy(true);
    setError("");
    try {
      await api("/appointments/no-show", {
        method: "POST",
        body: JSON.stringify({ bookingCode: code }),
      });
      setMarking(null);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const current = rows.find((row) => row.bookingCode === selected);
  const format = (row: Appointment) =>
    new Intl.DateTimeFormat("en-PH", {
      timeZone: row.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(row.startAt));
  return (
    <section aria-labelledby="appointments-title">
      <div className="section-heading">
        <div>
          <h2 id="appointments-title">Appointments</h2>
          <p className="muted">
            Filter all bookings{zone ? ` in ${zone}` : ""}. Open a booking to
            review details and available actions.
          </p>
        </div>
        {/* <button disabled={busy} onClick={() => void load()}>
          Refresh appointments
        </button> */}
      </div>
      {onSettlement && <WaitingQueue onSelect={onSettlement} />}
      <form
        className="account-form admin-appointment-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = Object.fromEntries(
            ["from", "to", "status", "staffId", "search", "attention"]
              .map((key) => [key, String(form.get(key) ?? "").trim()])
              .filter(([, value]) => value),
          ) as AppointmentFilters;
          setFilters(next);
          setRows([]);
          setSelected(null);
          setCursor(null);
          void load(undefined, next);
        }}
        key={JSON.stringify(initialFilters)}
      >
        <fieldset disabled={busy}>
          <div className="form-grid">
            <label>
              From date
              <input
                name="from"
                type="date"
                defaultValue={initialFilters.from}
              />
            </label>
            <label>
              Through date
              <input name="to" type="date" defaultValue={initialFilters.to} />
            </label>
            <label>
              Status
              <select name="status" defaultValue={initialFilters.status ?? ""}>
                <option value="">All statuses</option>
                {[
                  "PENDING_PAYMENT",
                  "CONFIRMED",
                  "COMPLETED",
                  "CANCELLED",
                  "NO_SHOW",
                  "EXPIRED",
                ].map((status) => (
                  <option value={status} key={status}>
                    {status.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Stylist
              <select
                name="staffId"
                defaultValue={initialFilters.staffId ?? ""}
              >
                <option value="">All stylists</option>
                {staff.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.firstName} {person.lastName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Customer or booking code
              <input
                name="search"
                maxLength={100}
                defaultValue={initialFilters.search}
                placeholder="Search name or booking code"
              />
            </label>
            {/* <label>
              Needs attention
              <select
                name="attention"
                defaultValue={initialFilters.attention ?? ""}
              >
                <option value="">All bookings</option>
                <option value="pending-fees">Active payment holds</option>
                <option value="unsettled">Unsettled services</option>
              </select>
            </label> */}
          </div>
          <div className="actions">
            <button className="primary">Apply filters</button>
            <button
              type="button"
              onClick={(event) => {
                event.currentTarget.form?.reset();
                const form = event.currentTarget.form;
                if (form) {
                  for (const element of Array.from(form.elements))
                    if (
                      element instanceof HTMLInputElement ||
                      element instanceof HTMLSelectElement
                    )
                      element.value = "";
                }
                setFilters({});
                setRows([]);
                setSelected(null);
                setCursor(null);
                void load(undefined, {});
              }}
            >
              Clear filters
            </button>
          </div>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          <button disabled={busy} onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {busy && <p role="status">Loading appointments…</p>}
      {!busy && !error && !rows.length && (
        <p className="empty-state" role="status">
          No appointments match these filters.
        </p>
      )}
      {!!rows.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scheduled start</th>
                <th>Customer / booking</th>
                <th>Services / stylist</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bookingCode}>
                  <td>{format(row)}</td>
                  <td>
                    <strong>
                      {row.customer.firstName} {row.customer.lastName}
                    </strong>
                    <br />
                    <small>{row.bookingCode}</small>
                  </td>
                  <td>
                    {row.appointmentServices.map((service) => (
                      <div key={service.id}>
                        {service.serviceNameSnapshot}
                        <br />
                        <small>
                          {service.staff.firstName} {service.staff.lastName}
                        </small>
                      </div>
                    ))}
                  </td>
                  <td>
                    <span
                      className={`badge status-${row.status.toLowerCase()}`}
                    >
                      {row.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td>
                    <button
                      disabled={busy}
                      aria-expanded={selected === row.bookingCode}
                      onClick={() =>
                        setSelected(
                          selected === row.bookingCode ? null : row.bookingCode,
                        )
                      }
                    >
                      View details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button
          disabled={busy}
          className="admin-load-more"
          onClick={() => void load(cursor)}
        >
          Load more matching appointments
        </button>
      )}
      {current && (
        <article className="admin-panel" aria-label="Selected appointment">
          <div className="section-heading">
            <div>
              <h3>
                {current.customer.firstName} {current.customer.lastName}
              </h3>
              <p>
                {current.bookingCode} · {format(current)}
              </p>
            </div>
            <button
              onClick={() => {
                setSelected(null);
                setMarking(null);
              }}
            >
              Close details
            </button>
          </div>
          <p>
            <span className={`badge status-${current.status.toLowerCase()}`}>
              {current.status.replaceAll("_", " ")}
            </span>
          </p>
          <ol>
            {current.appointmentServices.map((service) => (
              <li key={service.id}>
                {service.serviceNameSnapshot} · {service.staff.firstName}{" "}
                {service.staff.lastName} · PHP {service.priceSnapshot}
              </li>
            ))}
          </ol>
          <p>
            Appointment fee: PHP {current.appointmentFeeAmount}
            {current.carriedAppointmentFeePaymentId ? " · carried credit" : ""}
          </p>
          {current.status === "PENDING_PAYMENT" && current.holdExpiresAt && (
            <p>
              Payment hold{" "}
              {Date.parse(current.holdExpiresAt) <
              Date.parse(current.serverTime)
                ? "expired"
                : "expires"}{" "}
              at{" "}
              {new Intl.DateTimeFormat("en-PH", {
                timeZone: current.timeZone,
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(current.holdExpiresAt))}
              .
            </p>
          )}
          {current.status === "CONFIRMED" && (
            <AppointmentCheckIn
              bookingCode={current.bookingCode}
              customerName={`${current.customer.firstName} ${current.customer.lastName}`}
              startAt={current.startAt}
              checkedInAt={current.checkedInAt}
              checkedInByUser={current.checkedInByUser}
              timeZone={current.timeZone}
              disabled={busy}
              onCheckedIn={() => {
                setMarking(null);
                void load();
              }}
            />
          )}
          <div className="actions">
            {onPayment && (
              <button
                disabled={busy}
                onClick={() => onPayment(current.bookingCode)}
              >
                Review appointment fee
              </button>
            )}
            {onSettlement &&
              ["CONFIRMED", "COMPLETED"].includes(current.status) && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => onSettlement(current.bookingCode)}
                >
                  {current.status === "COMPLETED"
                    ? "View settlement / receipt"
                    : "Settle services"}
                </button>
              )}
            {current.status === "CONFIRMED" &&
              !current.checkedInAt &&
              Date.parse(current.startAt) <= Date.parse(current.serverTime) && (
                <button
                  disabled={busy}
                  onClick={() => setMarking(current.bookingCode)}
                >
                  Mark no-show
                </button>
              )}
          </div>
          {current.status === "NO_SHOW" && !current.recoveryAppointment && (
            <NoShowCorrection
              key={current.bookingCode}
              bookingCode={current.bookingCode}
              customerName={`${current.customer.firstName} ${current.customer.lastName}`}
              disabled={busy}
              onCorrected={() => void load()}
            />
          )}
          {current.status === "CONFIRMED" && (
            <p className="admin-note muted">
              Rescheduling follows the booking’s original policy. Changes used:{" "}
              {current.rescheduleCount} /{" "}
              {current.bookingPolicyVersion.maxReschedules}.
            </p>
          )}
          {marking === current.bookingCode && !current.checkedInAt && (
            <div className="admin-warning">
              <p>
                Confirm the customer failed to appear according to salon
                procedure. This releases the reservation and preserves the
                missed visit.
              </p>
              <div className="actions">
                <button
                  disabled={busy}
                  onClick={() => void mark(current.bookingCode)}
                >
                  Confirm no-show
                </button>
                <button disabled={busy} onClick={() => setMarking(null)}>
                  Keep confirmed
                </button>
              </div>
            </div>
          )}
        </article>
      )}
    </section>
  );
}
