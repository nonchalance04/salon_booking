import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { cashChange } from "./cashier-money";
import { ConfirmedServices } from "./confirmed-services";
import { ReceiptView, type Receipt } from "./receipt";
type Outcome = "SCHEDULED" | "PERFORMED" | "NOT_PERFORMED";
type Appointment = { bookingCode: string; status: string; revision: string; completionType: string | null; customer: { firstName: string; lastName: string }; eligibleAppointmentFee: string; carriedFee: boolean; amountDue: string;
  services: { id: string; name: string; staff: string; price: string; outcome: Outcome; actualChargedAmount: string | null }[];
  payments: { id: string; type: string; status: string; amount: string; receipt: Receipt | null }[];
  commissions?: { appointmentServiceId: string; serviceAmount: string; allocatedAppointmentFee: string; commissionBase: string; commissionRate: string; commissionAmount: string }[] };
export function SettlementWorkspace({ admin, initialCode, onFinalized, onBack }: { admin: boolean; initialCode?: string; onFinalized?: () => void; onBack?: () => void }) {
  const [row, setRow] = useState<Appointment | null>(null); const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const key = useRef(crypto.randomUUID());
  const sending = useRef(false);
  const [method, setMethod] = useState("CASH"); const [tendered, setTendered] = useState("");
  function accept(appointment: Appointment) { setRow(appointment); setTendered(""); setOutcomes(Object.fromEntries(appointment.services.map(s => [s.id, s.outcome]))); }
  async function act(fn: () => Promise<void>) { if (sending.current) return; sending.current = true; setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { sending.current = false; setBusy(false); } }
  async function lookup(code: string) { accept((await api<{ appointment: Appointment }>("/settlement/lookup", { method: "POST", body: JSON.stringify({ bookingCode: code }) })).appointment); }
  useEffect(() => { if (initialCode) void act(() => lookup(initialCode)); }, [initialCode]);
  async function save(event: FormEvent) { event.preventDefault(); if (!row) return; await act(async () => {
    accept((await api<{ appointment: Appointment }>("/settlement/outcomes", { method: "POST", body: JSON.stringify({ bookingCode: row.bookingCode, revision: row.revision, services: row.services.map(s => ({ id: s.id, outcome: outcomes[s.id] })) }) })).appointment);
    setNotice("Service outcomes saved. Review before finalizing.");
  }); }
  const ready = row?.services.every(s => s.outcome !== "SCHEDULED");
  const performed = row?.services.some(s => s.outcome === "PERFORMED");
  const dirty = row?.services.some(s => outcomes[s.id] !== s.outcome);
  const change = row ? cashChange(tendered, row.amountDue) : null;
  return <section><h2>{admin ? "Service outcomes & commissions" : "Process service payment"}</h2><p>{admin ? "Record or correct service outcomes before payment, and close visits with no performed services." : "Review the recorded services, collect the full amount due, and issue a receipt."}</p>
    {onBack && <button disabled={busy} onClick={onBack}>← Back to {admin ? "appointments" : "payments"}</button>}
    {!initialCode && !row && <><ConfirmedServices admin={admin} disabled={busy} onSelect={code => void act(async () => { await lookup(code); key.current = crypto.randomUUID(); })} /><details><summary>Find another booking by code</summary><form className="account-form" onSubmit={event => { event.preventDefault(); const code = String(new FormData(event.currentTarget).get("code")).trim(); void act(async () => { setRow(null); await lookup(code); key.current = crypto.randomUUID(); }); }}><label>Booking code<input name="code" required maxLength={100} /></label><button disabled={busy}>Find appointment</button></form></details></>}
    {error && <p role="alert" className="error">{error} {initialCode && !row && <button disabled={busy} onClick={() => void act(() => lookup(initialCode))}>Retry appointment</button>}</p>}{notice && <p role="status" className="success">{notice}</p>}
    {!initialCode && row && <button disabled={busy} onClick={() => { setRow(null); setError(""); setNotice(""); }}>← Back to {admin ? "appointments" : "payments"}</button>}
    {row && <div className="account-form"><h3>{row.bookingCode} · {row.customer.firstName} {row.customer.lastName}</h3><p>{row.status} {row.completionType?.replaceAll("_", " ")}</p><button disabled={busy} onClick={() => void act(() => lookup(row.bookingCode))}>Refresh appointment</button>
      {!admin && <ol className="settlement-steps" aria-label="Settlement progress"><li aria-current={!ready || dirty ? "step" : undefined}>1. Review services</li><li aria-current={ready && !dirty && row.status === "CONFIRMED" ? "step" : undefined}>2. Collect payment</li><li aria-current={row.status === "COMPLETED" ? "step" : undefined}>3. Receipt & finish</li></ol>}
      <p>Verified eligible appointment fee: PHP {row.eligibleAppointmentFee}{row.carriedFee ? " (carried from original booking)" : ""}. The service charge is collected separately; this fee is not deducted from the service amount due.</p>
      {!admin && Number(row.eligibleAppointmentFee) === 0 && <p className="muted">No eligible appointment-fee payment is available. Check the payment history below and ask an Admin about disputed or missing payments.</p>}
      {admin && <form onSubmit={event => void save(event)}><fieldset disabled={busy || row.status !== "CONFIRMED"}><legend>Service outcomes</legend>{row.services.map(s => <label key={s.id}>{s.name} · {s.staff} · PHP {s.price}<select aria-label={`Outcome for ${s.name}`} value={outcomes[s.id]} onChange={event => setOutcomes({ ...outcomes, [s.id]: event.target.value as Outcome })}><option value="SCHEDULED" disabled>Select outcome</option><option value="PERFORMED">Performed</option><option value="NOT_PERFORMED">Not performed</option></select></label>)}
        {row.status === "CONFIRMED" && <button disabled={busy || !dirty || Object.values(outcomes).some(o => o === "SCHEDULED")}>Save outcomes</button>}</fieldset></form>}
      {!admin && <><h4>Recorded services</h4><ul>{row.services.map(s => <li key={s.id}>{s.name} · {s.staff} · {s.outcome.replaceAll("_", " ")}</li>)}</ul>{row.status === "CONFIRMED" && (!ready ? <p role="status">Awaiting Admin service outcomes. Refresh after an Admin records all services.</p> : !performed && <p role="status">No service payment is due. Ask an Admin to close this visit.</p>)}</>}
      {row.status === "CONFIRMED" && !admin && ready && !dirty && performed && <form key={row.bookingCode} onSubmit={event => {
        event.preventDefault();
        if (method === "CASH" && change === null) { setError("Enter cash tendered covering the full service amount."); return; }
        if (!window.confirm(`Finalize service payment of PHP ${row.amountDue}? Outcomes and commissions will become final.`)) return;
        void act(async () => { accept((await api<{ appointment: Appointment }>("/settlement/pay", { method: "POST", body: JSON.stringify({ bookingCode: row.bookingCode, revision: row.revision, idempotencyKey: key.current, amount: row.amountDue, currency: "PHP", method }) })).appointment); key.current = crypto.randomUUID(); setNotice(`Service payment settled and receipt issued.${method === "CASH" ? ` Change to return: PHP ${change}.` : ""}`); onFinalized?.(); });
      }}><fieldset disabled={busy}><legend>Review performed services</legend><ul>{row.services.filter(s => s.outcome === "PERFORMED").map(s => <li key={s.id}>{s.name} · PHP {s.actualChargedAmount}</li>)}</ul><p><strong>Full service amount due: PHP {row.amountDue}</strong></p><label>Method<select name="method" value={method} onChange={event => { setMethod(event.target.value); setTendered(""); }}><option value="CASH">Cash</option><option value="GCASH">GCash</option><option value="OTHER">Other</option></select></label>
      {method === "CASH" && <><label>Cash tendered (PHP)<input inputMode="decimal" required value={tendered} onChange={event => setTendered(event.target.value)} maxLength={13} placeholder="0.00" /></label><p role="status">{change === null ? "Enter sufficient cash with up to two decimal places." : `Change to return: PHP ${change}`}</p></>}
      {method === "GCASH" && <p>Verify the received transaction in the salon’s GCash or provider records before finalizing.</p>}
      <p>A salon payment reference will be generated automatically and included on your receipt.</p><label className="checkbox"><input type="checkbox" required /> I have verified receipt of PHP {row.amountDue}.</label><button className="primary" disabled={method === "CASH" && change === null}>Finalize received service payment</button></fieldset></form>}
      {row.status === "CONFIRMED" && admin && ready && !dirty && !performed && <button disabled={busy} onClick={() => {
        if (!window.confirm("Close this appointment with all services not performed? The appointment fee is retained and outcomes become final.")) return;
        void act(async () => { accept((await api<{ appointment: Appointment }>("/settlement/close", { method: "POST", body: JSON.stringify({ bookingCode: row.bookingCode, revision: row.revision }) })).appointment); setNotice("Appointment closed with no performed services."); onFinalized?.(); });
      }}>Finalize no-service closure</button>}
      {admin && row.commissions && row.commissions.length > 0 && <div className="table-wrap"><h3>Final commissions</h3><table><thead><tr><th>Service</th><th>Service amount</th><th>Fee allocation</th><th>Base</th><th>Rate</th><th>Commission</th></tr></thead><tbody>{row.commissions.map(c => <tr key={c.appointmentServiceId}><td>{row.services.find(s => s.id === c.appointmentServiceId)?.name}</td><td>{c.serviceAmount}</td><td>{c.allocatedAppointmentFee}</td><td>{c.commissionBase}</td><td>{c.commissionRate}</td><td>{c.commissionAmount}</td></tr>)}</tbody></table></div>}
      {row.payments.map(p => <div key={p.id}><p>{p.type.replaceAll("_", " ")} · {p.status} · PHP {p.amount}</p>{p.receipt && <div id={p.receipt.receiptNumber}><ReceiptView receipt={p.receipt} /></div>}</div>)}
      {row.status === "COMPLETED" && onBack && <button className="primary" disabled={busy} onClick={onBack}>Finish & return to payments</button>}
    </div>}
  </section>;
}
