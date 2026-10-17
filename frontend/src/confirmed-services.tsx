import { AppointmentCheckIn } from "./appointment-check-in";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./api";

type ConfirmedBookings = {
  timeZone: string;
  page: number;
  pageSize: number;
  total: number;
  rows: {
    bookingCode: string;
    startAt: string;
    checkedInAt: string | null;
    checkedInByUser: { firstName: string; lastName: string } | null;
    customer: { firstName: string; lastName: string };
    appointmentServices: {
      id: string;
      serviceNameSnapshot: string;
      priceSnapshot: string;
      outcome: string;
      staff: { firstName: string; lastName: string };
    }[];
  }[];
};

export function ConfirmedServices({
  admin,
  onSelect,
  disabled = false,
  arrivalOnly = false,
  manageOutcomes = false,
}: {
  admin: boolean;
  onSelect: (code: string) => void;
  disabled?: boolean;
  arrivalOnly?: boolean;
  manageOutcomes?: boolean;
}) {
  const heading = useId();
  const [data, setData] = useState<ConfirmedBookings | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const query = new URLSearchParams({
      page: String(page),
      pageSize: "5",
      search,
    });
    if (arrivalOnly) query.set("arrivalToday", "true");
    else if (!admin && !manageOutcomes) query.set("paymentReady", "true");
    void api<ConfirmedBookings>(`/reports/confirmed-services?${query}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (page > lastPage) {
          setData(null);
          setPage(lastPage);
          return;
        }
        setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load confirmed services.",
          );
          setData(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [page, search, refresh, admin, arrivalOnly, manageOutcomes]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible")
        setRefresh((value) => value + 1);
    };
    const timer = window.setInterval(update, 30000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    setData(null);
    setPage(1);
    setSearch(draft.trim());
    setRefresh((value) => value + 1);
  }
  return (
    <section
      className="confirmed-services dashboard-list"
      aria-labelledby={heading}
    >
      <div className="section-heading">
        <div>
          <h3 id={heading}>
            {arrivalOnly
              ? "Customer check-in"
              : admin || manageOutcomes
                ? "Confirmed services"
                : "Ready for payment"}
          </h3>
          <p className="muted">
            {arrivalOnly
              ? "Confirm physical arrival for today’s appointments. Checked-in customers are protected from automatic no-show marking and appear in the waiting queue. Refreshes every 30 seconds."
              : `Select a customer to ${admin || manageOutcomes ? "review their services" : "process their service payment"}. Includes all appointment dates and refreshes every 30 seconds.`}
          </p>
        </div>
        {/* <button
          disabled={busy || disabled}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {busy ? "Refreshing…" : "Refresh services"}
        </button> */}
      </div>
      <form className="cashier-search" onSubmit={submit}>
        <label>
          Search customer or booking code
          <input
            type="search"
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Customer name or booking code"
          />
        </label>
        <button disabled={disabled}>Search</button>
        {search && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setDraft("");
              setSearch("");
              setPage(1);
              setData(null);
            }}
          >
            Clear search
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          <button onClick={() => setRefresh((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      {busy && !data && <p role="status">Loading confirmed services…</p>}
      {data && (
        <>
          <p>
            {data.total} confirmed {data.total === 1 ? "booking" : "bookings"} ·{" "}
            {data.timeZone}
          </p>
          {data.rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Appointment</th>
                    <th>Customer</th>
                    <th>Services / staff</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.bookingCode}>
                      <td data-label="Appointment">
                        {new Intl.DateTimeFormat("en-PH", {
                          timeZone: data.timeZone,
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(row.startAt))}
                        <br />
                        <small>{row.bookingCode}</small>
                      </td>
                      <td data-label="Customer">
                        <strong>
                          {row.customer.firstName} {row.customer.lastName}
                        </strong>
                        <br />
                        <span className="badge active">Confirmed</span>
                      </td>
                      <td data-label="Services / staff">
                        {row.appointmentServices.map((service) => (
                          <div key={service.id}>
                            {service.serviceNameSnapshot} · PHP{" "}
                            {service.priceSnapshot}
                            <br />
                            <small>
                              {service.staff.firstName} {service.staff.lastName}{" "}
                              · {service.outcome.replaceAll("_", " ")}
                            </small>
                          </div>
                        ))}
                      </td>
                      <td data-label="Action">
                        {(admin || arrivalOnly) && (
                          <AppointmentCheckIn
                            bookingCode={row.bookingCode}
                            customerName={`${row.customer.firstName} ${row.customer.lastName}`}
                            startAt={row.startAt}
                            checkedInAt={row.checkedInAt}
                            checkedInByUser={row.checkedInByUser}
                            timeZone={data.timeZone}
                            disabled={disabled || busy}
                            onCheckedIn={() => setRefresh((value) => value + 1)}
                          />
                        )}
                        {!arrivalOnly && (
                          <button
                            disabled={disabled || busy}
                            onClick={() => onSelect(row.bookingCode)}
                          >
                            {admin || manageOutcomes ? "Review services" : "Process payment"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>
              {search
                ? "No confirmed bookings match your search."
                : arrivalOnly
                  ? "No confirmed visits awaiting service today."
                  : admin || manageOutcomes
                    ? "No confirmed services awaiting settlement."
                    : "No visits ready for payment. Record all service outcomes before collection."}
            </p>
          )}
          <div className="actions cashier-pagination">
            <button
              disabled={disabled || busy || page === 1}
              onClick={() => {
                setData(null);
                setPage((value) => value - 1);
              }}
            >
              Previous
            </button>
            <span>
              Page {page} of{" "}
              {Math.max(1, Math.ceil(data.total / data.pageSize))}
            </span>
            <button
              disabled={disabled || busy || page * data.pageSize >= data.total}
              onClick={() => {
                setData(null);
                setPage((value) => value + 1);
              }}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
