import { WaitingQueue } from "./waiting-queue";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ConfirmedServices } from "./confirmed-services";
import type { Section } from "./configuration.fields";
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
    refunded: string;
    netCashMovement: string;
  }[];
};
const money = (value: string, currency = "PHP") =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(
    Number(value),
  );
export function AdminDashboard({
  onAppointments,
  onPayments,
  onSettlement,
  onReport,
  onConfiguration,
}: {
  onAppointments: (filters: AppointmentFilters) => void;
  onPayments: () => void;
  onSettlement: (code: string) => void;
  onReport: (kind: string) => void;
  onConfiguration: (section: Section) => void;
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
    <section aria-labelledby="admin-dashboard-title" aria-busy={busy}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">DAILY OVERVIEW</p>
          <h2 id="admin-dashboard-title">Your salon, at a glance</h2>
          <p className="muted">
            {data
              ? `${date} · ${data.timeZone} · Updated ${updated}`
              : "Today’s appointments and priorities"}
          </p>
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
      <WaitingQueue onSelect={onSettlement} />
      <ConfirmedServices admin onSelect={onSettlement} />
      {data && collections && (
        <>
          <h3>What needs attention</h3>
          <p className="muted">
            Open a card to review its records. Pending fees, unsettled services,
            and reconciliation include all dates.
          </p>
          <div className="admin-action-grid">
            <button
              className="admin-action-card"
              onClick={() => onAppointments({ from: date, to: date })}
            >
              <span>Today’s appointments</span>
              <strong>
                {data.appointments.reduce((total, row) => total + row.count, 0)}
              </strong>
              <small>All booking statuses · View appointments →</small>
            </button>
            <button
              className="admin-action-card"
              onClick={() => onAppointments({ attention: "pending-fees" })}
            >
              <span>Pending appointment fees</span>
              <strong>{data.attention.pendingFees}</strong>
              <small>Active payment holds · Review fees →</small>
            </button>
            <button
              className="admin-action-card"
              onClick={() => onAppointments({ attention: "unsettled" })}
            >
              <span>Unsettled services</span>
              <strong>{data.attention.unsettled}</strong>
              <small>Confirmed bookings whose start time has passed →</small>
            </button>
            <button
              className={`admin-action-card${data.attention.reconciliation ? " needs-attention" : ""}`}
              onClick={onPayments}
            >
              <span>Payment reconciliation</span>
              <strong>{data.attention.reconciliation}</strong>
              <small>Successful captures requiring review →</small>
            </button>
          </div>
          <div className="admin-panel">
            <div className="section-heading">
              <div>
                <h3>Today’s financial summary</h3>
                <p className="muted">
                  Collections use capture time; refunds use refund time;
                  commissions use finalization time.
                </p>
              </div>
              <button onClick={() => onReport("payments")}>
                View financial reports
              </button>
            </div>
            {(collections.totals.length
              ? collections.totals
              : [
                  {
                    currency: "PHP",
                    captured: "0",
                    refunded: "0",
                    netCashMovement: "0",
                  },
                ]
            ).map((total) => (
              <div className="admin-finance-grid" key={total.currency}>
                <div>
                  <small>Collections · {total.currency}</small>
                  <strong>{money(total.captured, total.currency)}</strong>
                </div>
                <div>
                  <small>Refunds · {total.currency}</small>
                  <strong>{money(total.refunded, total.currency)}</strong>
                </div>
                <div>
                  <small>Net collections · {total.currency}</small>
                  <strong>
                    {money(total.netCashMovement, total.currency)}
                  </strong>
                </div>
              </div>
            ))}
            <button
              className="admin-commission"
              onClick={() => onReport("commissions")}
            >
              <span>
                Finalized commissions{" "}
                <small>{data.commissionCount} records · PHP</small>
              </span>
              <strong>{money(data.finalizedCommissions)}</strong>
              <span aria-hidden="true">→</span>
            </button>
            <p className="muted admin-note">
              Net collections are collections minus refunds. Commissions are
              shown separately and are not deducted here. Carried booking
              credits are not new collections.
            </p>
          </div>
          <div className="admin-panel">
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
                  <button onClick={() => onConfiguration("closures")}>
                    Manage closures
                  </button>
                </div>
                {data.scheduling.closures.length ? (
                  data.scheduling.closures.map((row) => (
                    <article key={row.id} className="admin-schedule-item">
                      <strong>{row.reason || "Salon closed"}</strong>
                      <p>
                        {format(row.startsAt)} – {format(row.endsAt)}
                      </p>
                      <button
                        onClick={() =>
                          onAppointments({
                            from: new Intl.DateTimeFormat("en-CA", {
                              timeZone: data.timeZone,
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                            }).format(new Date(row.startsAt)),
                            to: new Intl.DateTimeFormat("en-CA", {
                              timeZone: data.timeZone,
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                            }).format(new Date(row.endsAt)),
                          })
                        }
                      >
                        Review bookings on these dates
                      </button>
                    </article>
                  ))
                ) : (
                  <p className="muted">No upcoming salon closures.</p>
                )}
              </section>
              <section>
                <div className="section-heading">
                  <h4>Staff absences</h4>
                  <button onClick={() => onConfiguration("unavailability")}>
                    Manage time off
                  </button>
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
                      <p>
                        <button
                          onClick={() =>
                            onAppointments({
                              staffId: row.staffId,
                              from: new Intl.DateTimeFormat("en-CA", {
                                timeZone: data.timeZone,
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                              }).format(new Date(row.startsAt)),
                              to: new Intl.DateTimeFormat("en-CA", {
                                timeZone: data.timeZone,
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                              }).format(new Date(row.endsAt)),
                            })
                          }
                        >
                          Review stylist bookings on these dates
                        </button>
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="muted">No upcoming staff absences.</p>
                )}
              </section>
            </div>
            <p className="admin-note muted">
              Configuration changes that would invalidate reservations are
              blocked. Review the affected bookings listed with the conflict
              before retrying a change.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
