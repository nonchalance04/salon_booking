import { PhoneInput } from "./phone-input";
import { philippinePhoneNumber } from "./phone-number";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import type { Appointment } from "./booking";

export function AppointmentOtp({ onVerified }: { onVerified: (appointment: Appointment) => void }) {
  const verified = useRef(onVerified); verified.current = onVerified;
  const [channels, setChannels] = useState<Array<"SMS" | "EMAIL">>([]);
  const [channel, setChannel] = useState<"SMS" | "EMAIL">("SMS");
  const [email, setEmail] = useState("");
  const [bookingCode, setBookingCode] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const sending = useRef(false);
  useEffect(() => {
    let active = true;
    // Restoring checkout access must also work when OTP delivery is disabled.
    void (async () => {
      try {
        const result = await api<{ appointment: Appointment }>("/appointments/otp/session");
        if (active) verified.current(result.appointment);
        return;
      } catch (err) {
        if (active && !(err instanceof ApiError && err.status === 401)) setError("Could not restore your visit. You can request a new code below.");
      }
      try {
        const options = await api<{ available: boolean; channels: Array<"SMS" | "EMAIL"> }>("/appointments/otp/options");
        if (!active) return;
        setChannels(options.channels);
        if (options.channels.length) setChannel(options.channels[0]!);
        else setError("Appointment verification is unavailable. Try again later or contact the salon.");
      } catch { if (active) setError("Appointment verification is unavailable. Try again later or contact the salon."); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    if (sending.current || cooldown) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ challengeId: string; message: string; retryAfterSeconds: number }>("/appointments/otp/request", {
        method: "POST", body: JSON.stringify({ bookingCode: bookingCode.trim().toUpperCase(), channel, ...(channel === "EMAIL" ? { email: email.trim() } : { phone: philippinePhoneNumber(phone) }) }),
      });
      setChallengeId(result.challengeId); setCode(""); setNotice(result.message); setCooldown(result.retryAfterSeconds);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { sending.current = false; setBusy(false); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ appointment: Appointment }>("/appointments/otp/verify", {
        method: "POST", body: JSON.stringify({ challengeId, code }),
      });
      verified.current(result.appointment);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section className="account-form" aria-label="Verify appointment">
    {channels.length > 0 && <><h3>Find your appointment</h3>
      <p>Enter your booking code and choose how to receive your verification code. Use the email address or phone number you provided when booking.</p>
      <form onSubmit={requestCode}><fieldset disabled={busy || Boolean(challengeId)}>
        <label>Booking code<input required value={bookingCode} onChange={e => setBookingCode(e.target.value)} autoCapitalize="characters" maxLength={100} /></label>
        <label>Verification method<select value={channel} onChange={e => setChannel(e.target.value as "SMS" | "EMAIL")}>
          {channels.includes("SMS") && <option value="SMS">SMS</option>}
          {channels.includes("EMAIL") && <option value="EMAIL">Email</option>}
        </select></label>
        {channel === "EMAIL"
          ? <label>Email address<input type="email" required autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
          : <label>Phone number<PhoneInput value={phone} onChange={setPhone} /></label>}
        <p className="muted">{channel === "EMAIL" ? "Email verification requires an email address saved on your booking. Check your inbox and spam folder for the code." : "We’ll send the code by SMS to the phone number saved on your booking."}</p>
        {!challengeId && <button className="primary" disabled={busy || cooldown > 0}>{busy ? "Requesting code…" : cooldown ? `Wait ${cooldown}s` : `Send code by ${channel === "EMAIL" ? "email" : "SMS"}`}</button>}
      </fieldset></form>
      {notice && <p role="status">{notice}</p>}
      {challengeId && <form onSubmit={verify}>
        <label>Verification code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></label>
        <button className="primary" disabled={busy}>{busy ? "Please wait…" : "Verify and view appointment"}</button>
        <button type="button" disabled={busy || cooldown > 0} onClick={() => void requestCode()}>{cooldown ? `Resend in ${cooldown}s` : "Resend code"}</button>
        <button type="button" disabled={busy} onClick={() => { setChallengeId(""); setNotice(""); setCode(""); setError(""); }}>Change booking details or method</button>
        <p className="muted">Your appointment stays accessible on this browser for two hours. Use “Back to home” to end your appointment session when finished on a shared device.</p>
      </form>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
