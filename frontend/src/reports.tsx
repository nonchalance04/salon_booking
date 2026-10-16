import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { ReceiptPrintButton } from "./receipt";
import "./reports.css";
import { paymentStatusLabel, visibleReportEntries } from "./payment-presentation";
type Collections = { timeZone: string; basis: string; totals: { currency: string; captured: string; netCashMovement: string; successfulApplied: string; successfulUnapplied: string; reconciliationRequired: string }[]; methodTotals: Record<string, unknown>[]; typeTotals: Record<string, unknown>[]; breakdown: Record<string, unknown>[] };
type Report = { rows: Record<string, unknown>[]; total: number; page: number; pageSize: number; dateBasis: string; timeZone: string };
const reportLabels: Record<string, string> = {
  serviceNameSnapshot: "Service Name",
  priceSnapshot: "Price",
  recoveryOfAppointmentId: "Original Booking ID",
  carriedAppointmentFeePaymentId: "Transferred Booking Fee Payment ID",
};
const label = (key: string) => reportLabels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, s => s.toUpperCase());
function Value({ value }: { value: unknown }) {
  if (value == null) return <>—</>;
  if (Array.isArray(value)) return <ul>{value.map((item, i) => <li key={i}><Value value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="report-details">{visibleReportEntries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{label(key)}</dt><dd><Value value={item} /></dd></div>)}</dl>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  return <>{paymentStatusLabel(String(value))}</>;
}
const numericColumn = (key: string) => /(?:amount|price|captured|netCashMovement|successfulApplied|successfulUnapplied|reconciliationRequired|commissionBase|allocatedAppointmentFee|total|count|rate)$/i.test(key);
function columnWidth(key: string, rows: Record<string, unknown>[]) {
  if (rows.some(row => row[key] !== null && typeof row[key] === "object")) return 280;
  if (/Id$|Number$/.test(key)) return 220;
  if (/At$/.test(key)) return 200;
  if (numericColumn(key)) return 130;
  if (/Time$/.test(key)) return 120;
  if (["method", "provider", "currency", "actorType", "entityType"].includes(key)) return 130;
  if (key === "status") return 150;
  return 170;
}
function DataTable({ rows, renderCell, title = "Report records" }: { rows: Record<string, unknown>[]; renderCell?: (column: string, row: Record<string, unknown>) => ReactNode; title?: string }) {
  if (!rows.length) return <p className="report-empty">No records in this period.</p>;
  const columns = visibleReportEntries(rows[0]).map(([key]) => key).filter(k => k !== "id");
  const widths = columns.map(column => columnWidth(column, rows));
  const style = { "--report-table-width": `${widths.reduce((sum, width) => sum + width, 0)}px` } as CSSProperties;
  return <div className="table-wrap report-table-wrap" role="region" aria-label={`${title} table`} tabIndex={0}>
    <table className="report-table" style={style} role="table">
      <caption className="sr-only">{title}</caption>
      <colgroup>{columns.map((column, i) => <col key={column} style={{ width: widths[i] }} />)}</colgroup>
      <thead role="rowgroup"><tr role="row">{columns.map(column => <th key={column} scope="col" role="columnheader" className={numericColumn(column) ? "report-numeric" : undefined}>{label(column)}</th>)}</tr></thead>
      <tbody role="rowgroup">{rows.map((row, i) => <tr key={String(row.id ?? i)} role="row">{columns.map(column => <td key={column} role="cell" data-label={label(column)} className={[numericColumn(column) ? "report-numeric" : "", row[column] !== null && typeof row[column] === "object" ? "report-detail-cell" : ""].filter(Boolean).join(" ")}>
        <div className="report-cell-value">{renderCell?.(column, row) ?? (typeof row[column] === "object" && row[column] !== null ? <details className="report-cell-details"><summary>View details<span className="sr-only">: {label(column)}, record {i + 1}</span></summary><Value value={row[column]} /></details> : <Value value={row[column]} />)}</div>
      </td>)}</tr>)}</tbody>
    </table>
  </div>;
}
function receiptCell(column: string, row: Record<string, unknown>) {
  const snapshot = row.receiptSnapshot;
  if (column !== "receiptSnapshot") return undefined;
  if (typeof row.receiptNumber !== "string" || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return <>—</>;
  return <ReceiptPrintButton label="Print / Save PDF" receipt={{ receiptNumber: row.receiptNumber, receiptSnapshot: snapshot as Record<string, unknown> }} />;
}
export function Reports({ admin, initialKind = "appointments" }: { admin: boolean; initialKind?: string }) {
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [kind, setKind] = useState(initialKind); const [collections, setCollections] = useState<Collections | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  // Initialize using the configured salon timezone, rather than the browser's date.
  useEffect(() => { let active = true; void api<{ timeZone: string }>("/salon").then(salon => {
    if (!active) return; const today = new Intl.DateTimeFormat("en-CA", { timeZone: salon.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    setFrom(today); setTo(today);
  }).catch(err => { if (active) setError(err instanceof Error ? err.message : "Unable to load salon date."); }); return () => { active = false; }; }, []);
  const load = useCallback(async (page = 1) => {
    setBusy(true); setError(""); setReport(null); setCollections(null);
    const query = new URLSearchParams({ from, to, page: String(page), pageSize: "25" });
    try {
      if (admin) {
        const result = await api<Report>(`/reports/${kind}?${query}`);
        if (kind === "payments") {
          const timeFormat = new Intl.DateTimeFormat("en-PH", { timeZone: result.timeZone, hour: "numeric", minute: "2-digit", hour12: true });
          result.rows = result.rows.map(({ appointment, ...payment }) => ({
            bookingCode: appointment && typeof appointment === "object" && "bookingCode" in appointment ? appointment.bookingCode : null,
            ...Object.fromEntries(visibleReportEntries(payment).filter(([key]) => !["currency", "satisfiesObligation", "reconciliationStatus"].includes(key)).map(([key, value]) => {
              if (key === "createdAt" || key === "paidAt") {
                return [key === "createdAt" ? "createdTime" : "paidTime", value == null ? null : timeFormat.format(new Date(String(value)))];
              }
              return [key, value];
            })),
          }));
        }
        if (kind === "receipts" || kind === "appointments") {
          const dateTimeFormat = new Intl.DateTimeFormat("en-PH", { timeZone: result.timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
          const dateColumns = kind === "receipts" ? ["issuedAt"] : ["startAt", "endAt"];
          result.rows = result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
            key, dateColumns.includes(key) && value != null ? dateTimeFormat.format(new Date(String(value))) : value,
          ])));
        }
        setReport(result);
      } else setCollections(await api<Collections>(`/reports/collections?${query}`));
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load reports."); }
    finally { setBusy(false); }
  }, [admin, from, to, kind]);
  useEffect(() => {
    if (admin && from && to && to >= from) void load();
  }, [admin, from, to, load]);
  function submit(e: FormEvent) { e.preventDefault(); void load(); }
  function clear() { setCollections(null); setReport(null); }
  return <section className="reports"><h2>{admin ? "Reports" : "Collection summary"}</h2><p>Choose up to 366 days in salon time. Reports use historical transactions and stored service values.</p>
    <form className="account-form" onSubmit={submit}><div className="form-grid"><label>From<input type="date" required value={from} disabled={busy} onChange={e => { setFrom(e.target.value); clear(); }} /></label><label>Through<input type="date" required value={to} min={from} disabled={busy} onChange={e => { setTo(e.target.value); clear(); }} /></label>
    {/* {admin && <label>Report<select value={kind} disabled={busy} onChange={e => { setKind(e.target.value); clear(); }}>{["appointments", "payments", "receipts", "commissions", "audit"].map(k => <option key={k} value={k}>{label(k)}</option>)}</select></label>} */}</div>{!admin && <button className="primary" disabled={busy}>{busy ? "Loading…" : "Run report"}</button>}</form>
    {admin && busy && <p role="status">Loading…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {collections && <><h3>Collections</h3><p>{collections.basis} Timezone: {collections.timeZone}.</p><DataTable rows={collections.totals} title="Collections" /><p>Successful applied and unapplied amounts describe current payment status. Reconciliation required is a subset, not an additional collection.</p><h3>Cash, GCash & other collections</h3><DataTable rows={collections.methodTotals} title="Collections by method" /><h3>Appointment fees & service payment captures</h3><DataTable rows={collections.typeTotals} title="Collections by payment type" /><details><summary>Collection breakdown by payment type and method</summary><DataTable rows={collections.breakdown} title="Collection breakdown" /></details></>}
    {report && <><h3>{label(kind)}</h3><p>{report.total} records · Date basis: {report.dateBasis}. Timestamps in details use ISO format with UTC offsets.</p>{kind === "receipts" && <p>Use Print / Save PDF to open the formatted receipt, then choose Save as PDF in the print destination.</p>}<DataTable rows={report.rows} title={label(kind)} renderCell={kind === "receipts" ? receiptCell : undefined} /><div className="actions report-pagination"><button disabled={busy || report.page <= 1} onClick={() => void load(report.page - 1)}>Previous</button><span>Page {report.page} of {Math.max(1, Math.ceil(report.total / report.pageSize))}</span><button disabled={busy || report.page * report.pageSize >= report.total} onClick={() => void load(report.page + 1)}>Next</button></div></>}
  </section>;
}
