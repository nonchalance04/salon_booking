import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { chatbotHistory } from "./chatbot-history";
import { readChatSession, saveChatSession, type ChatReply } from "./chatbot-session";
import "./chatbot.css";

const price = (value: string) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(Number(value));
const topics = [
  { icon: "✧", title: "Find my service", detail: "A little guidance for your next visit", question: "Help me choose a service" },
  { icon: "☷", title: "Services & prices", detail: "Explore treatments and pricing", question: "Services and prices" },
  { icon: "◷", title: "Plan my visit", detail: "Opening hours and booking help", question: "Opening hours" },
];

export function Chatbot({ embedded = false, compact = false, active = true }: { embedded?: boolean; compact?: boolean; active?: boolean } = {}) {
  const [savedSession] = useState(readChatSession);
  const [history, setHistory] = useState(savedSession.history);
  const [message, setMessage] = useState(savedSession.draft);
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveChatSession({ history, draft: message || pending });
  }, [history, message, pending]);

  useEffect(() => {
    const region = transcript.current;
    if (active && region) region.scrollTo({ top: region.scrollHeight, behavior: "instant" });
  }, [active, history, pending, error]);
  useEffect(() => {
    if (active && !busy && (history.length > 0 || error)) input.current?.focus({ preventScroll: true });
  }, [active, busy, history.length, error]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(input.current.scrollHeight, 120)}px`;
    }
  }, [message, active]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(""); setPending(trimmed); setMessage("");
    try {
      const reply = await api<ChatReply>("/chatbot", { method: "POST", body: JSON.stringify({ message: trimmed, history: chatbotHistory(history) }) });
      setHistory(h => [...h.slice(-19), { question: trimmed, reply }]);
      setPending("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally { submitting.current = false; setBusy(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void ask(message); }
  function reset() {
    setHistory([]); setPending(""); setMessage(""); setError(""); input.current?.focus();
  }
  return <section className={`salon-guide chat-page${compact ? " chat-page--compact" : embedded ? " container" : " workspace-main"}`} aria-label={compact ? "Salon recommendations" : undefined} aria-labelledby={compact ? undefined : "chat-title"}>
    {!embedded && !compact && <a className="wordmark" href="/">CLIQUE<span>SALON</span></a>}
    {!compact && <div className="chat-page-heading"><div><p className="eyebrow">A LITTLE GUIDANCE, JUST FOR YOU</p><h1 id="chat-title">Your next good hair day<br />starts here.</h1><p>Explore services, plan your visit, or find a little beauty inspiration.</p></div><a className="chat-book-link" href="/availability">Book a visit <span aria-hidden="true">↗</span></a></div>}
    <div className="chat-layout">
      {!compact && <aside className="chat-sidebar" aria-label="Salon guide shortcuts">
        <div className="chat-sidebar-intro"><span className="chat-emblem" aria-hidden="true">✧</span><h2>Let’s find your<br />kind of care.</h2><p>From a fresh look to a moment of calm. We’ll help you get started.</p></div>
        <p className="chat-label">EXPLORE WITH US</p>
        <div className="chat-topics">{topics.map(topic => <button key={topic.title} disabled={busy} onClick={() => void ask(topic.question)}><span className="chat-topic-icon" aria-hidden="true">{topic.icon}</span><span><strong>{topic.title}</strong><small>{topic.detail}</small></span><span aria-hidden="true">↗</span></button>)}</div>
        <div className="chat-visit"><p className="chat-label">ALREADY HAVE AN APPOINTMENT?</p><a href="/appointment">Manage your booking <span aria-hidden="true">↗</span></a><p>View, reschedule, or cancel your visit.</p></div>
      </aside>}
      <div className="chat-panel">
        <div className="chat-panel-heading"><div className="chat-assistant-identity"><span className="chat-avatar" aria-hidden="true">✧</span><div><strong>Clique salon guide</strong><small>AI-assisted service guidance</small></div></div><button className="chat-reset" onClick={reset} disabled={busy || (!history.length && !pending)} aria-label="Start a new conversation"><span aria-hidden="true">＋</span> New chat</button></div>
        <div className="chat-transcript" ref={transcript} role="log" aria-label="Conversation" aria-live="polite" tabIndex={0}>
          <div className="chat-welcome"><span className="chat-welcome-icon" aria-hidden="true">✧</span><p className="chat-label">WELCOME TO YOUR SALON GUIDE</p><h2>What can we help you with?</h2><p>Tell us what you have in mind. A new look, a specific concern, or simply some time for yourself.</p></div>
          {history.length === 0 && !pending && <div className="chat-starters">{["Help me choose a service", "How to book", "Booking policies"].map(q => <button key={q} onClick={() => void ask(q)} disabled={busy}>{q} <span aria-hidden="true">↗</span></button>)}</div>}
          {history.map((h, i) => <div className="chat-turn" key={i}>
            <div className="chat-user-message"><span className="chat-message-label">YOU</span><p>{h.question}</p></div>
            <div className="chat-assistant-message"><span className="chat-message-label">{h.reply.mode === "gemini" ? "CLIQUE · AI-ASSISTED" : "CLIQUE · SALON GUIDE"}</span>
              {h.reply.notice && <p className="chat-notice">{h.reply.notice}</p>}
              <p className="chat-answer">{h.reply.answer}</p>
              {h.reply.recommendations?.map(service => <article className="chat-recommendation" key={service.id}><p className="chat-label">A LITTLE SOMETHING FOR YOU</p><h3>{service.name}</h3><p>{service.reason}</p>{service.description && <p className="chat-service-description">{service.description}</p>}<div className="chat-service-meta"><strong>{price(service.price)}</strong><span>~ {service.durationMinutes} min</span></div><a href={service.href}>Book this service <span aria-hidden="true">↗</span></a></article>)}
              {h.reply.links.length > 0 && <div className="chat-reply-links">{h.reply.links.map(l => <a key={l.href} href={l.href}>{l.label} <span aria-hidden="true">↗</span></a>)}</div>}
            </div>
          </div>)}
          {pending && <div className="chat-user-message"><span className="chat-message-label">YOU</span><p>{pending}</p></div>}
          {busy && <div className="chat-thinking" role="status"><span aria-hidden="true"><i /><i /><i /></span> Finding a little guidance…</div>}
          {error && <div className="chat-error" role="alert"><strong>We couldn’t get a reply.</strong><p>{error}</p><button onClick={() => void ask(pending)} disabled={busy}>Try again</button></div>}
        </div>
        <div className="chat-composer-area"><form onSubmit={submit} className="chat-composer"><label className="sr-only" htmlFor="chat-question">Your question</label><textarea ref={input} id="chat-question" rows={1} value={message} onChange={e => setMessage(e.target.value)} placeholder="How can we help?" required maxLength={1000} disabled={busy} aria-describedby="chat-input-hint" onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) void ask(message); } }} /><button type="submit" aria-label="Send message" disabled={busy || !message.trim()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v15" /></svg></button></form><div className="chat-composer-hint" id="chat-input-hint"><span>Enter to send · Shift + Enter for a new line</span><span>{message.length} / 1,000</span></div></div>
      </div>
    </div>
    <details className="chat-privacy"><summary>About this guide & your privacy</summary><p>AI-assisted answers may ask follow-up questions before recommending a service. When AI consultation is enabled, your messages and recent conversation are sent to Google Gemini. Your conversation and unsent message are saved in this browser tab as you move between pages or refresh. Use New chat to clear them, or close this tab to end the session. Keep appointment references, guest tokens, verification codes and payment details private.</p></details>
  </section>;
}
