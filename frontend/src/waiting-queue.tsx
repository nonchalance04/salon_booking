import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./api";

type Waiting = {
  timeZone: string;
  serverTime: string;
  page: number;
  pageSize: number;
  total: number;
  rows: {
    bookingCode: string;
    startAt: string;
    endAt: string;
    checkedInAt: string;
    minutesSinceCheckIn: number;
    needsReview: boolean;
    checkedInByUser: { firstName: string; lastName: string } | null;
    customer: { firstName: string; lastName: string };
    appointmentServices: {
      id: string;
      serviceNameSnapshot: string;
      staff: { firstName: string; lastName: string };
    }[];
  }[];
};

export function WaitingQueue({
  onSelect,
}: {
  onSelect: (code: string) => void;
}) {
  const heading = useId();
  const [data, setData] = useState<Waiting | null>(null);
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
      pageSize: "25",
      search,
    });
    void api<Waiting>(`/reports/waiting-queue?${query}`, {
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
          setData(null);
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load waiting customers.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [page, search, refresh]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible")
        setRefresh((value) => value + 1);
    };
    const timer = window.setInterval(update, 30000);
    window.addEventListener("focus", update);
    window.addEventListener("appointment-arrival-changed", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("appointment-arrival-changed", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const format = (value: string) =>
    new Intl.DateTimeFormat("en-PH", {
      timeZone: data?.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  function submit(event: FormEvent) {
    event.preventDefault();
    setData(null);
    setPage(1);
    setSearch(draft.trim());
    setRefresh((value) => value + 1);
  }
  return (
    <section
      className="admin-panel dashboard-list dashboard-list-waiting"
      aria-labelledby={heading}
    >
      <div className="section-heading">
        <div>
          <h3 id={heading}>Checked-in waiting queue</h3>
          <p className="muted">
            Oldest check-in first, across all dates. These visits have no
            recorded service outcomes. Service start is not tracked separately,
            so confirm with the stylist before treating a customer as still
            waiting.
          </p>
        </div>
        {/* <button
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {busy ? "Refreshing…" : "Refresh waiting queue"}
        </button> */}
      </div>
      <form className="cashier-search" onSubmit={submit}>
        <label>
          Find waiting customer or booking
          <input
            type="search"
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button>Search</button>
        {search && (
          <button
            type="button"
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
      {busy && !data && <p role="status">Loading waiting customers…</p>}
      {data && (
        <>
          <p>
            {data.total} checked-in{" "}
            {data.total === 1 ? "customer" : "customers"} · Updated{" "}
            {format(data.serverTime)} · Refreshes every 30 seconds
          </p>
          {data.rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer / booking</th>
                    <th>Appointment</th>
                    <th>Arrival</th>
                    <th>Since check-in</th>
                    <th>Services / stylist</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.bookingCode}>
                      <td data-label="Customer / booking">
                        <strong>
                          {row.customer.firstName} {row.customer.lastName}
                        </strong>
                        <br />
                        <small>{row.bookingCode}</small>
                      </td>
                      <td data-label="Appointment">
                        {format(row.startAt)}
                        <br />
                        {row.needsReview && (
                          <span className="error">
                            Needs review: scheduled visit has ended
                          </span>
                        )}
                      </td>
                      <td data-label="Arrival">
                        {format(row.checkedInAt)}
                        {row.checkedInByUser && (
                          <>
                            <br />
                            <small>
                              By {row.checkedInByUser.firstName}{" "}
                              {row.checkedInByUser.lastName}
                            </small>
                          </>
                        )}
                      </td>
                      <td data-label="Since check-in">
                        {row.minutesSinceCheckIn} min
                      </td>
                      <td data-label="Services / stylist">
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
                      <td data-label="Action">
                        <button
                          disabled={busy}
                          onClick={() => onSelect(row.bookingCode)}
                        >
                          Review services
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p role="status">
              {search
                ? "No waiting customers match your search."
                : "No checked-in customers awaiting service outcomes."}
            </p>
          )}
          <div className="actions cashier-pagination">
            <button
              disabled={busy || page <= 1}
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
              disabled={busy || page * data.pageSize >= data.total}
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
