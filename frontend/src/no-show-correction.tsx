import { useEffect, useState } from "react";
import { api } from "./api";

export function NoShowCorrection({ bookingCode, customerName, onCorrected, disabled, onNavigationStateChange }: {
  bookingCode: string; customerName: string; onCorrected: () => void; disabled: boolean;
  onNavigationStateChange?: (state: { busy: boolean; dirty: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [present, setPresent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onNavigationStateChange?.({ busy, dirty: open && Boolean(reason.trim() || present) }); }, [busy, open, reason, present, onNavigationStateChange]);
  async function correct() {
    setBusy(true); setError("");
    try {
      await api("/appointments/no-show/correct", { method: "POST", body: JSON.stringify({ bookingCode, reason, customerPresent: present }) });
      window.dispatchEvent(new Event("appointment-arrival-changed"));
      setOpen(false); onCorrected();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to correct this appointment."); }
    finally { setBusy(false); }
  }
  if (!open) return <button disabled={disabled} onClick={() => setOpen(true)}>Correct no-show / late arrival</button>;
  return <form className="admin-warning" onSubmit={event => { event.preventDefault(); void correct(); }}><fieldset disabled={disabled || busy}>
    <legend>Restore the original appointment</legend>
    <p>{customerName} · {bookingCode}</p>
    <p>This restores the original staff and times and checks the customer in now. Availability is checked again when you confirm. It cannot extend the visit or replace an existing recovery booking.</p>
    <label>Reason for correction<textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
    <label><input type="checkbox" required checked={present} onChange={event => setPresent(event.target.checked)} />I confirm this customer is physically present.</label>
    <div className="actions"><button disabled={!present || !reason.trim()}>Restore and check in</button><button type="button" onClick={() => setOpen(false)}>Keep no-show</button></div>
    <p>If the original visit has ended or its staff time is unavailable, arrange a new available booking.</p>
  </fieldset>{error && <p role="alert" className="error">{error}</p>}</form>;
}
