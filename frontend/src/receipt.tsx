import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./receipt.css";

export type Receipt = { receiptNumber: string; receiptSnapshot: Record<string, unknown> };
const value = (input: unknown) => typeof input === "string" ? input : "";
const object = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const methodName = (method: string) => ({ CASH: "Cash", GCASH: "GCash", OTHER: "Other" })[method] || method.replaceAll("_", " ");

export function ReceiptContent({ receipt }: { receipt: Receipt }) {
  const r = receipt.receiptSnapshot;
  const salon = object(r.salon);
  const currency = value(r.currency) || "PHP";
  const paidAt = value(r.paidAt);
  const date = new Date(paidAt);
  const paidOn = paidAt && !Number.isNaN(date.getTime())
    ? `${new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(date)} (Asia/Manila)` : paidAt;
  const services = Array.isArray(r.services) ? r.services.map(object) : [];
  const type = r.type === "APPOINTMENT_FEE" ? "Appointment fee" : r.type === "SERVICE_PAYMENT" ? "Service payment" : value(r.type).replaceAll("_", " ");
  return <>
    <header className="receipt-header"><div className="receipt-brand"><span>CLIQUE</span><small>salon and spa</small></div><span className="receipt-label">Payment receipt</span></header>
    <div className="receipt-salon"><strong>{value(salon.name) || "Clique Salon & Spa"}</strong>{value(salon.address) && <p>{value(salon.address)}</p>}{value(salon.phone) && <p>{value(salon.phone)}</p>}</div>
    <div className="receipt-heading"><div><p className="receipt-eyebrow">A LITTLE TIME FOR YOURSELF</p><h3>Thank you for your visit.</h3><p>{type}</p></div></div>
    <dl className="receipt-details"><div><dt>Receipt number</dt><dd>{receipt.receiptNumber}</dd></div><div><dt>Booking reference</dt><dd>{value(r.bookingCode)}</dd></div><div><dt>Customer</dt><dd>{value(r.customerName)}</dd></div><div><dt>Paid on</dt><dd>{paidOn || "—"}</dd></div></dl>
    {services.length > 0 && <table className="receipt-services"><thead><tr><th scope="col">Performed service</th><th scope="col">Amount ({currency})</th></tr></thead><tbody>{services.map((service, i) => <tr key={i}><td>{value(service.name)}</td><td>{value(service.amount)}</td></tr>)}</tbody></table>}
    <div className="receipt-total"><span>Total paid</span><strong>{currency} {value(r.amount)}</strong></div>
    <dl className="receipt-payment"><div><dt>Payment method</dt><dd>{methodName(value(r.method)) || "—"}</dd></div><div><dt>Payment reference</dt><dd>{value(r.externalReference) || "—"}</dd></div></dl>
    <footer className="receipt-footer"><p>Your beauty. Our passion.</p><small>Keep this receipt for your records.</small></footer>
  </>;
}

export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done, { once: true });
    window.print();
    return () => window.removeEventListener("afterprint", done);
  }, [printing]);
  return <><article className="salon-receipt" aria-label={`Receipt ${receipt.receiptNumber}`}><ReceiptContent receipt={receipt} /><div className="receipt-actions"><button type="button" className="receipt-print" onClick={() => setPrinting(true)}>Print receipt</button></div></article>{printing && createPortal(<div className="receipt-print-root"><article className="salon-receipt"><ReceiptContent receipt={receipt} /></article></div>, document.body)}</>;
}
