import { WaitingQueue } from "./waiting-queue";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { SettlementWorkspace } from "./settlement";
import { ConfirmedServices } from "./confirmed-services";

type Queue = {
  timeZone: string; page: number; pageSize: number; total: number; awaitingSettlement: number; completed: number;
  rows: { bookingCode: string; startAt: string; status: string; completionType: string | null;
    customer: { firstName: string; lastName: string };
    appointmentServices: { serviceNameSnapshot: string; outcome: string; staff: { firstName: string; lastName: string } }[] }[];
};
type Movement = { currency: string; captured: string; refunded: string; netCashMovement: string };
type Collections = {
  totals: (Movement & { reconciliationRequired: string })[];
  methodTotals: (Movement & { method: string })[];
  typeTotals: { currency: string; type: string; captured: string; count: number }[];
};
const money = (value: string, currency = "PHP") => new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(Number(value));

export function CashierDashboard({ admin = false, showOverview = true }: { admin?: boolean; showOverview?: boolean }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [collections, setCollections] = useState<Collections | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [date, setDate] = useState(""); const [zone, setZone] = useState("");
  const [page, setPage] = useState(1); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [updated, setUpdated] = useState("");
  const request = useRef(0);
  async function load(nextPage = page) { 
    const current = ++request.current;
    setBusy(true); setError("");
    try {
      const salon = await api<{ timeZone: string }>("/salon");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: salon.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      // Reset pagination when the salon day changes.
      const actualPage = date && today !== date ? 1 : nextPage;
      const query = new URLSearchParams({ from: today, to: today, page: String(actualPage), pageSize: "25" });
      const [q, c] = await Promise.all([api<Queue>(`/reports/cashier-queue?${query}`), api<Collections>(`/reports/collections?${query}`)]);
      if (current !== request.current) return;
      setQueue(q); setCollections(c); setDate(today); setZone(salon.timeZone); setPage(actualPage);
      setUpdated(new Intl.DateTimeFormat("en-PH", { timeZone: salon.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date()));
    } catch (err) { if (current === request.current) { setError(err instanceof Error ? err.message : "Unable to load today’s dashboard."); setQueue(null); setCollections(null); } }
    finally { if (current === request.current) setBusy(false); }
  }
  useEffect(() => { void load(1); return () => { request.current++; }; }, []);
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    if (code) setSelected(code);
  }
  return <section aria-labelledby="cashier-title">
    <div className="section-heading"><div><p className="eyebrow">{admin ? "SALON OVERVIEW" : "CASHIER DESK"}</p><h2 id="cashier-title">{showOverview ? "Today at the salon" : "Appointments"}</h2>
      <p className="muted">{date ? `${date} · ${zone} · Updated ${updated}` : "Loading salon day…"}</p></div>
      <button disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh today"}</button></div>
    {error && <p role="alert" className="error">{error} <button disabled={busy} onClick={() => void load()}>Retry</button></p>}
    {queue && collections && showOverview && <>
      <div className="cashier-metrics"><article><small>Awaiting settlement</small><strong>{queue.awaitingSettlement}</strong></article><article><small>Completed appointments</small><strong>{queue.completed}</strong></article>
        {collections.totals.length ? collections.totals.map(t => <article key={t.currency}><small>Net collections · {t.currency}</small><strong>{money(t.netCashMovement, t.currency)}</strong><small>Collected {money(t.captured, t.currency)} · Refunded {money(t.refunded, t.currency)}</small></article>) : <article><small>Net collections</small><strong>{money("0")}</strong><small>No collections today</small></article>}</div>
      <details className="cashier-collections"><summary>Today’s collection review</summary>
        <p>Payments captured today minus refunds issued today, across the salon. Appointment counts use today’s scheduled start. These are collection totals, not a cash-drawer balance.</p>
        <div className="cashier-metrics">{(collections.methodTotals.length ? collections.methodTotals : ["CASH", "GCASH", "OTHER"].map(method => ({ method, currency: "PHP", captured: "0", refunded: "0", netCashMovement: "0" }))).map(t => <article key={`${t.currency}-${t.method}`}><small>{t.method === "GCASH" ? "GCash" : t.method === "CASH" ? "Cash" : "Other"} · {t.currency}</small><strong>{money(t.netCashMovement, t.currency)}</strong><small>Collected {money(t.captured, t.currency)} · Refunded {money(t.refunded, t.currency)}</small></article>)}</div>
        {(collections.typeTotals.length ? collections.typeTotals : ["APPOINTMENT_FEE", "SERVICE_PAYMENT"].map(type => ({ type, currency: "PHP", captured: "0", count: 0 }))).map(t => <p key={`${t.currency}-${t.type}`}>{t.type === "APPOINTMENT_FEE" ? "Appointment fees" : "Service payments"}: <strong>{money(t.captured, t.currency)}</strong> · {t.count} captured transactions</p>)}
        {collections.totals.filter(t => Number(t.reconciliationRequired) > 0).map(t => <p role="status" className="error" key={t.currency}>{money(t.reconciliationRequired, t.currency)} of today’s captures require admin reconciliation. Included in collections above.</p>)}
      </details>
    </>}
    {selected ? <SettlementWorkspace key={selected} admin={admin} initialCode={selected} onFinalized={() => void load()} onBack={() => { setSelected(null); void load(); }} /> : <>
      <WaitingQueue onSelect={setSelected} />
      <ConfirmedServices admin={admin} onSelect={setSelected} />
      <details><summary>Find another booking by code</summary><form className="account-form cashier-search" onSubmit={search}><label>Find any booking by code<input name="code" required maxLength={100} placeholder="Enter booking code" /></label><button className="primary">Find appointment</button></form></details>
      <details className="today-activity"><summary>Today’s appointment activity and receipts</summary><h3>Today’s appointments</h3><p className="muted">Confirmed appointments awaiting settlement and completed appointments. Open a booking to review services and fee payment history.</p>
      {queue && (queue.rows.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Customer / booking</th><th>Services / staff</th><th>Status</th><th>Action</th></tr></thead><tbody>{queue.rows.map(row => <tr key={row.bookingCode}>
        <td>{new Intl.DateTimeFormat("en-PH", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(row.startAt))}</td>
        <td><strong>{row.customer.firstName} {row.customer.lastName}</strong><br /><small>{row.bookingCode}</small></td>
        <td>{row.appointmentServices.map((s, i) => <div key={i}>{s.serviceNameSnapshot}<br /><small>{s.staff.firstName} {s.staff.lastName} · {s.outcome.replaceAll("_", " ")}</small></div>)}</td>
        <td><span className={`badge ${row.status === "COMPLETED" ? "active" : ""}`}>{row.status === "COMPLETED" ? row.completionType === "NO_SERVICE_CLOSURE" ? "Closed without services" : "Completed" : "Awaiting settlement"}</span></td>
        <td><button onClick={() => setSelected(row.bookingCode)}>{row.status === "COMPLETED" ? "View receipt / details" : "Settle appointment"}</button></td>
      </tr>)}</tbody></table></div> : <p>No appointments on this page.</p>)}
      {queue && <div className="actions cashier-pagination"><button disabled={busy || page <= 1} onClick={() => void load(page - 1)}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil(queue.total / queue.pageSize))}</span><button disabled={busy || page * queue.pageSize >= queue.total} onClick={() => void load(page + 1)}>Next</button></div>}</details>
    </>}
  </section>;
}
