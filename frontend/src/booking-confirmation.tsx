import type { Appointment } from "./booking";
import type { Salon } from "./public-site";
import { useEffect, useState } from "react";
import { ReceiptPreviewButton } from "./receipt";
import { api } from "./api";
import type { FeePayment } from "./payments";
import "./booking-confirmation.css";

export function BookingConfirmation({ appointment, salon, token, onManage }: { appointment: Appointment; salon: Salon | null; token: string; onManage: () => void }) {
  const payment = appointment.payments.find(p => p.status === "SUCCEEDED" && p.satisfiesObligation);
  const [generated, setGenerated] = useState<FeePayment["receipt"]>(null);
  const [receiptError, setReceiptError] = useState("");
  const [retry, setRetry] = useState(0);
  const receipt = payment?.receipt ?? generated;
  useEffect(() => {
    if (receipt?.receiptSnapshot || payment?.provider !== "paymongo") return;
    let active = true;
    setReceiptError("");
    void api<{ payment: FeePayment }>("/payments/customer-receipt", { method: "POST", body: JSON.stringify({ bookingCode: appointment.bookingCode, token, paymentId: payment.id }) })
      .then(result => { if (active) setGenerated(result.payment.receipt); })
      .catch(error => { if (active) setReceiptError(error instanceof Error ? error.message : "Unable to generate your receipt. Please try again."); });
    return () => { active = false; };
  }, [appointment.bookingCode, payment?.id, payment?.provider, receipt?.receiptSnapshot, token, retry]);
  const services = appointment.appointmentServices;
  const staff = [...new Set(services.map(s => `${s.staff.firstName} ${s.staff.lastName}`))];
  const date = new Intl.DateTimeFormat("en-PH", { timeZone: appointment.timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(appointment.startAt));
  const time = new Intl.DateTimeFormat("en-PH", { timeZone: appointment.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(appointment.startAt));
  const total = services.reduce((sum, s) => sum + Math.round(Number(s.priceSnapshot) * 100), 0) / 100;
  const money = (amount: string | number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(Number(amount));
  return <section className="booking-confirmed" aria-labelledby="booking-confirmed-title">
    <header className="booking-confirmed-heading"><h1 id="booking-confirmed-title" tabIndex={-1}>Booking Confirmed!</h1><p>Reference Number: <strong>{appointment.bookingCode}</strong></p></header>
    <div className="booking-confirmed-grid">
      <article className="booking-confirmed-details"><p className="booking-confirmed-label">Booking Details</p><span className="booking-confirmed-scissors" aria-hidden="true">✂</span>
        <h2>{appointment.customer.firstName} {appointment.customer.lastName}</h2>
        <dl className="booking-confirmed-facts"><div><dt>Hairdresser</dt><dd>{staff.join(", ")}</dd></div><div><dt>Services</dt><dd>{services.map(s => s.serviceNameSnapshot).join(", ")}</dd></div><div><dt>Payment</dt><dd>{payment?.method === "GCASH" ? "GCash" : payment?.method?.replaceAll("_", " ") || (appointment.carriedAppointmentFeePaymentId ? "Carried appointment-fee credit" : "Appointment fee paid")}</dd></div></dl>
        <dl className="booking-confirmed-totals"><div><dt>Date</dt><dd>{date}</dd></div><div><dt>Time</dt><dd>{time}</dd></div><div><dt>Service total</dt><dd>{money(total)}</dd></div></dl>
        <p className="booking-confirmed-note">{payment ? `Appointment fee paid: ${money(payment.amount)}. ` : ""}Service charges are separate. Times shown in {appointment.timeZone}.</p>
      </article>
      <aside className="booking-confirmed-sidebar"><div className="booking-confirmed-download">
        {receipt?.receiptSnapshot ? <ReceiptPreviewButton receipt={{ receiptNumber: receipt.receiptNumber, receiptSnapshot: receipt.receiptSnapshot }} label="↓ Download E-Receipt" className="booking-confirmed-receipt" /> : <button type="button" className="booking-confirmed-receipt" disabled>↓ Download E-Receipt</button>}
        <p className="booking-confirmed-note">{receipt?.receiptSnapshot ? "Preview your receipt, then print or save as PDF." : payment?.provider === "paymongo" ? "Generating your e-receipt…" : "Your e-receipt will be available once the salon issues it."}</p>
        {receiptError && <><p role="alert" className="error">{receiptError}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry e-receipt</button></>}
      </div><section className="booking-confirmed-contact"><h2>Contact Us</h2><p>Have a concern? Contact our team and we’ll be happy to assist you!</p>
        {salon?.profile?.email && <a href={`mailto:${salon.profile.email}`}>{salon.profile.email}</a>}
        {salon?.profile?.phone && <a href={`tel:${salon.profile.phone}`}>{salon.profile.phone}</a>}
        {salon?.profile?.address && <p>{salon.profile.address}</p>}
        <a className="booking-confirmed-help" href="/help">Visit the salon guide ↗</a>
      </section></aside>
    </div><div className="booking-confirmed-actions"><button type="button" onClick={onManage}>Manage appointment</button><a href="/">Back to home</a></div>
  </section>;
}
