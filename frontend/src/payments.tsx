import { createPaymentKey } from "./payment-key";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ReceiptView } from "./receipt";
import { api } from "./api";
import { startPaymentSync } from "./payment-sync";
import { paymentStatusLabel } from "./payment-presentation";
const message = (error: unknown) => error instanceof Error ? error.message : "Please try again.";
export type FeePayment = { id: string; amount: string; status: string; method?: string; provider?: string; satisfiesObligation?: boolean; reconciliationStatus: string; receipt: { receiptNumber: string; receiptSnapshot?: Record<string, unknown> } | null };
export function FeePaymentControls({ bookingCode, token, onChange, pending }: { bookingCode: string; token: string; onChange: () => Promise<void>; pending?: FeePayment }) {
  const [options, setOptions] = useState<{ onlineAvailable: boolean; testMode: boolean; sandbox: boolean } | null>(null);
  const [payment, setPayment] = useState<FeePayment | null>(pending ?? null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const key = useRef("");
  if (!key.current) key.current = createPaymentKey();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = useRef(onChange); changed.current = onChange;
  useEffect(() => { if (pending) setPayment(pending); }, [pending?.id, pending?.status]);
  useEffect(() => { api<{ onlineAvailable: boolean; testMode: boolean; sandbox: boolean }>("/payments/options").then(setOptions).catch(err => setError(message(err))); }, []);
  useEffect(() => {
    if (!options?.onlineAvailable || options.testMode || payment?.status !== "PENDING") return;
    return startPaymentSync(checkPayment);
  }, [bookingCode, token, options?.onlineAvailable, options?.testMode, payment?.id, payment?.status]);
  async function checkout() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ payment: FeePayment; checkoutUrl: string | null }>("/payments/checkout", { method: "POST", body: JSON.stringify({ bookingCode, token, idempotencyKey: key.current }) });
      setPayment(result.payment);
      setCheckoutUrl(result.checkoutUrl);
      await onChange();
    } catch (err) { setError(message(err)); }
    finally { sending.current = false; setBusy(false); }
  }
  async function simulate(outcome: "SUCCEEDED" | "FAILED") {
    if (!payment || sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      await api("/payments/test-capture", { method: "POST", body: JSON.stringify({ bookingCode, token, paymentId: payment.id, outcome }) });
      if (outcome === "FAILED") { key.current = createPaymentKey(); setPayment(null); setError("Test payment failed. You can try again while the hold is active."); }
      await onChange();
    } catch (err) { setError(message(err)); }
    finally { sending.current = false; setBusy(false); }
  }
  async function checkPayment() {
    if (!payment || sending.current) return true;
    sending.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ payment: FeePayment }>("/payments/status", { method: "POST", body: JSON.stringify({ bookingCode, token, paymentId: payment.id }) });
      await changed.current();
      setPayment(result.payment);
      return result.payment.status === "PENDING";
    } catch (err) { setError(message(err)); return true; }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className="fee-payment">
    {options?.onlineAvailable ? <>
      {options.testMode && <p role="note"><strong>Development payment simulator — no real money is collected.</strong></p>}
      {(!payment || !options.testMode) && !checkoutUrl ? <button type="button" className="primary" disabled={busy} onClick={() => void checkout()}>{busy ? "Opening payment…" : options.testMode ? "Open test payment" : "Pay with GCash"}</button> : options.testMode && <div className="actions"><button type="button" disabled={busy} onClick={() => void simulate("SUCCEEDED")}>Simulate successful payment</button><button type="button" disabled={busy} onClick={() => void simulate("FAILED")}>Simulate failed payment</button></div>}
      {options.sandbox && <p role="note">PayMongo sandbox — no real money is collected.</p>}
      {checkoutUrl && <p><a className="payment-link" href={checkoutUrl} rel="noreferrer">Continue to GCash on PayMongo →</a></p>}
      {!options.testMode && <p>Complete payment in this tab. When PayMongo returns you to the salon, your booking restores automatically on this browser and confirms after payment is verified.</p>}
      {!options.testMode && payment?.status === "PENDING" && <p role="status">Waiting for payment confirmation… Status updates automatically when you return to the salon.</p>}
      {!options.testMode && payment && <button type="button" disabled={busy} onClick={() => void checkPayment()}>Check payment status</button>}
    </> : options && <p>Contact the salon to pay the appointment fee before your hold expires. Online payment is not configured.</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
export function FeePaymentHistory({ payments }: { payments: FeePayment[] }) {
  return payments.length ? <section aria-label="Appointment-fee payments"><h3>Appointment-fee payments</h3>{payments.map(p => <div key={p.id} className="payment-record">
    <p>PHP {p.amount} · {paymentStatusLabel(p.status)}{p.reconciliationStatus === "REQUIRED" && " · Salon review required"}</p>
    {p.reconciliationStatus === "REQUIRED" && <p>This payment was not applied to the booking fee. Contact the salon for reconciliation.</p>}
    {p.receipt && <details><summary>Receipt {p.receipt.receiptNumber}</summary>{p.receipt.receiptSnapshot && <ReceiptView receipt={{ receiptNumber: p.receipt.receiptNumber, receiptSnapshot: p.receipt.receiptSnapshot }} />}</details>}
  </div>)}</section> : null;
}
type StaffBooking = { bookingCode: string; status: string; appointmentFeeAmount: string; customer: { firstName: string; lastName: string }; payments: FeePayment[] };
type ReviewPayment = FeePayment & { provider: string; method: string; externalReference: string | null; reconciliationReason: string | null; appointment: { bookingCode: string; status: string } };
export function PaymentsWorkspace({ admin, initialCode }: { admin: boolean; initialCode?: string }) {
  const [booking, setBooking] = useState<StaffBooking | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const key = useRef("");
  if (!key.current) key.current = createPaymentKey();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<ReviewPayment[]>([]);
  const [onlyReview, setOnlyReview] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  async function lookup(code: string) { setBooking((await api<{ appointment: StaffBooking }>("/payments/lookup", { method: "POST", body: JSON.stringify({ bookingCode: code }) })).appointment); }
  async function loadReview(next?: string, filter = onlyReview) {
    const result = await api<{ payments: ReviewPayment[]; nextCursor: string | null }>(`/payments?reconciliationOnly=${filter}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
    setReview(old => next ? [...old, ...result.payments] : result.payments); setCursor(result.nextCursor);
  }
  useEffect(() => { if (admin) void loadReview(undefined, onlyReview).catch(err => setError(message(err))); }, [admin, onlyReview]);
  useEffect(() => { if (initialCode) void act(() => lookup(initialCode)); }, [initialCode]);
  async function act(work: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (err) { setError(message(err)); }
    finally { sending.current = false; setBusy(false); }
  }
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!booking) return;
    const data = new FormData(event.currentTarget);
    await act(async () => {
      const { payment } = await api<{ payment: FeePayment & { appointment: { status: string } } }>("/payments/manual", { method: "POST", body: JSON.stringify({ bookingCode: booking.bookingCode,
        amount: booking.appointmentFeeAmount, currency: "PHP", method: String(data.get("method")), idempotencyKey: key.current }) });
      key.current = createPaymentKey();
      setNotice(`Payment recorded${payment.reconciliationStatus === "REQUIRED" ? " for reconciliation" : ""}. Booking status: ${payment.appointment.status.replaceAll("_", " ")}.`);
      await lookup(booking.bookingCode); if (admin) await loadReview();
    });
  }
  return <section className="payments-workspace"><h2>Appointment-fee payments</h2><p>Record money already received. A salon payment reference is generated automatically and included on the receipt.</p>
    <form className="account-form" onSubmit={event => { event.preventDefault(); const code = String(new FormData(event.currentTarget).get("code")).trim(); void act(async () => { await lookup(code); key.current = createPaymentKey(); }); }}>
      <label>Booking code<input name="code" required maxLength={100} defaultValue={initialCode} /></label><button disabled={busy}>Find booking</button>
    </form>
    {booking && <div className="account-form"><h3>{booking.bookingCode} · {booking.customer.firstName} {booking.customer.lastName}</h3><p>Status: {booking.status} · Appointment fee: PHP {booking.appointmentFeeAmount}</p>
      {booking.status !== "PENDING_PAYMENT" && <p>Recording a separate capture here will flag it for reconciliation and will not restore or confirm the booking.</p>}
      <form onSubmit={event => void record(event)} key={booking.bookingCode}><fieldset disabled={busy}><label>Payment method<select name="method"><option value="CASH">Cash</option><option value="GCASH">GCash</option><option value="OTHER">Other</option></select></label>
        <label className="checkbox"><input type="checkbox" required /> I have verified receipt of PHP {booking.appointmentFeeAmount}.</label>
        <button className="primary" disabled={busy}>Record received appointment fee</button></fieldset></form>
      <FeePaymentHistory payments={booking.payments} />
      {admin && booking.payments.filter(p => p.status === "PENDING").map(p => <p key={p.id}>Pending payment attempt: <code>{p.id}</code></p>)}
      {booking.payments.filter(p => p.status === "SUCCEEDED" && !p.receipt).map(p => <button key={p.id} disabled={busy} onClick={() => void act(async () => { await api("/payments/receipts", { method: "POST", body: JSON.stringify({ paymentId: p.id }) }); await lookup(booking.bookingCode); setNotice("Receipt issued."); if (admin) await loadReview(); })}>Issue receipt for PHP {p.amount}</button>)}
    </div>}
    {notice && <p role="status" className="success">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}
    {admin && <section><h3>Payment reconciliation</h3>
      <details><summary>Recover an uncertain PayMongo checkout</summary><p>Use the payment attempt ID and checkout session ID from the matching PayMongo dashboard record. Recovery verifies the merchant record before applying it.</p>
        <form className="account-form" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void act(async () => {
          await api("/payments/recover-checkout", { method: "POST", body: JSON.stringify({ paymentId: String(data.get("paymentId")).trim(), checkoutReference: String(data.get("checkoutReference")).trim() }) });
          setNotice("PayMongo checkout verified. Refresh the booking to view its current payment status."); await loadReview();
        }); }}><label>Payment attempt ID<input name="paymentId" required /></label><label>PayMongo checkout session ID<input name="checkoutReference" required pattern="cs_[A-Za-z0-9]+" /></label><button disabled={busy}>Verify and recover checkout</button></form>
      </details><p>Review late or additional captures with the salon’s payment records. Contact the salon administrator about payment discrepancies.</p>
      <label className="checkbox"><input type="checkbox" checked={onlyReview} onChange={event => setOnlyReview(event.target.checked)} /> Show only payments requiring reconciliation</label>
      <button disabled={busy} onClick={() => void act(() => loadReview())}>Refresh payments</button>
      <div className="table-wrap"><table><thead><tr><th>Booking</th><th>Payment</th><th>Reference</th><th>Review</th></tr></thead><tbody>{review.map(p => <tr key={p.id}><td><button disabled={busy} onClick={() => void act(() => lookup(p.appointment.bookingCode))}>{p.appointment.bookingCode}</button><br />{p.appointment.status}</td><td>PHP {p.amount}<br />{paymentStatusLabel(p.status)} · {p.provider}</td><td>{p.externalReference ?? "Pending"}</td><td>{p.reconciliationReason?.replaceAll("_", " ") ?? p.reconciliationStatus}</td></tr>)}</tbody></table></div>
      {!review.length && <p>No matching payments.</p>}{cursor && <button disabled={busy} onClick={() => void act(() => loadReview(cursor))}>Load more</button>}
    </section>}
  </section>;
}
