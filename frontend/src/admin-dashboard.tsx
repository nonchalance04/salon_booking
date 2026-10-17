// import { WaitingQueue } from "./waiting-queue";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ConfirmedServices } from "./confirmed-services";
export type AppointmentFilters = {
  from?: string;
  to?: string;
  status?: string;
  staffId?: string;
  search?: string;
  attention?: string;
};
type Window = {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};
type Dashboard = {
  timeZone: string;
  appointments: { status: string; count: number }[];
  finalizedCommissions: string;
  commissionCount: number;
  attention: { pendingFees: number; unsettled: number; reconciliation: number };
  scheduling: {
    until: string;
    closures: Window[];
    absences: (Window & {
      staffId: string;
      staff: { firstName: string; lastName: string };
    })[];
  };
};
type Collections = {
  totals: {
    currency: string;
    captured: string;
    netCashMovement: string;
  }[];
};
const money = (value: string, currency = "PHP") =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(
    Number(value),
  );
export function AdminDashboard({ onSettlement }: {
  onSettlement: (code: string) => void;
}) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [collections, setCollections] = useState<Collections | null>(null);
  const [date, setDate] = useState("");
  const [updated, setUpdated] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  async function load() {
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const salon = await api<{ timeZone: string }>("/salon");
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: salon.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const query = new URLSearchParams({ from: today, to: today });
      const [dashboard, totals] = await Promise.all([
        api<Dashboard>(`/reports/dashboard?${query}`),
        api<Collections>(`/reports/collections?${query}`),
      ]);
      if (attempt !== generation.current) return;
      setData(dashboard);
      setCollections(totals);
      setDate(today);
      setUpdated(
        new Intl.DateTimeFormat("en-PH", {
          timeZone: salon.timeZone,
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date()),
      );
    } catch (err) {
      if (attempt === generation.current) {
        setError(
          err instanceof Error ? err.message : "Unable to load the dashboard.",
        );
        setData(null);
        setCollections(null);
      }
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, []);
  const format = (value: string) =>
    new Intl.DateTimeFormat("en-PH", {
      timeZone: data?.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  return (
    <section aria-label="Admin dashboard" aria-busy={busy}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">DAILY OVERVIEW</p>
          {/* <p className="muted">
            {data
              ? `${date} · ${data.timeZone} · Updated ${updated}`
              : "Today’s appointments and priorities"}
          </p> */}
        </div>
        {/* <button disabled={busy} onClick={() => void load()}>
          {busy ? "Refreshing…" : "Refresh dashboard"}
        </button> */}
      </div>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>
      )}
      {busy && !data && (
        <p role="status" className="admin-loading">
          Loading salon activity…
        </p>
      )}
      {data && (
        <>
          <h3>What needs attention</h3>
          <p className="muted">
            Pending fees, unsettled services, and reconciliation include all dates.
          </p>
          <div className="admin-action-grid">
            <div className="admin-action-card">
              <span>Today’s appointments</span>
              <strong>
                {data.appointments.reduce((total, row) => total + row.count, 0)}
              </strong>
              <small>All booking statuses</small>
            </div>
            <div className="admin-action-card">
              <span>Pending appointment fees</span>
              <strong>{data.attention.pendingFees}</strong>
              <small>Active payment holds</small>
            </div>
            <div className="admin-action-card">
              <span>Unsettled services</span>
              <strong>{data.attention.unsettled}</strong>
              <small>Confirmed bookings whose start time has passed</small>
            </div>
            <div className={`admin-action-card${data.attention.reconciliation ? " needs-attention" : ""}`}>
              <span>Payment reconciliation</span>
              <strong>{data.attention.reconciliation}</strong>
              <small>Successful captures requiring review</small>
            </div>
          </div>
        </>
      )}
      {/* <WaitingQueue onSelect={onSettlement} /> */}
      <ConfirmedServices admin onSelect={onSettlement} />
      {data && collections && (
        <>
          <section aria-label="Today’s financial summary">
            <div className="section-heading">
              <div>
                <h3>Today’s financial summary</h3>
                <p className="muted">
                  Collections use capture time; commissions use finalization time.
                </p>
              </div>
            </div>
            <div className="admin-action-grid admin-financial-cards">
              {(collections.totals.length
                ? collections.totals
                : [
                    {
                      currency: "PHP",
                      captured: "0",
                      netCashMovement: "0",
                    },
                  ]
              ).map((total) => (
                <Fragment key={total.currency}>
                  <div className="admin-action-card">
                    <span>Collections · {total.currency}</span>
                    <strong>{money(total.captured, total.currency)}</strong>
                    <small>Captured today</small>
                  </div>
                  <div className="admin-action-card">
                    <span>Net collections · {total.currency}</span>
                    <strong>
                      {money(total.netCashMovement, total.currency)}
                    </strong>
                    <small>Includes recorded payment adjustments</small>
                  </div>
                </Fragment>
              ))}
              <div className="admin-action-card">
                <span>Finalized commissions · PHP</span>
                <strong>{money(data.finalizedCommissions)}</strong>
                <small>{data.commissionCount} records finalized today</small>
              </div>
            </div>
            <p className="muted admin-note">
              Net collections reflect recorded payment adjustments. Commissions
              are shown separately and are not deducted here. Carried booking
              credits are not new collections.
            </p>
          </section>
          {/* <div className="admin-panel">
            <div className="section-heading">
              <div>
                <h3>Scheduling · next 7 days</h3>
                <p className="muted">
                  Closures and staff absences through{" "}
                  {format(data.scheduling.until)}. Up to 20 of each are shown.
                </p>
              </div>
            </div>
            <div className="admin-scheduling-grid">
              <section>
                <div className="section-heading">
                  <h4>Salon closures</h4>
                </div>
                {data.scheduling.closures.length ? (
                  data.scheduling.closures.map((row) => (
                    <article key={row.id} className="admin-schedule-item">
                      <strong>{row.reason || "Salon closed"}</strong>
                      <p>
                        {format(row.startsAt)} – {format(row.endsAt)}
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="muted">No upcoming salon closures.</p>
                )}
              </section>
              <section>
                <div className="section-heading">
                  <h4>Staff absences</h4>
                </div>
                {data.scheduling.absences.length ? (
                  data.scheduling.absences.map((row) => (
                    <article key={row.id} className="admin-schedule-item">
                      <strong>
                        {row.staff.firstName} {row.staff.lastName}
                      </strong>
                      <p>
                        {format(row.startsAt)} – {format(row.endsAt)}
                      </p>
                      <small>{row.reason || "Scheduled time off"}</small>
                    </article>
                  ))
                ) : (
                  <p className="muted">No upcoming staff absences.</p>
                )}
              </section>
            </div>
            <p className="admin-note muted">
              Configuration changes that would invalidate reservations are
              blocked. Affected bookings are listed with the conflict in configuration.
            </p>
          </div> */}
        </>
      )}
    </section>
  );
}
