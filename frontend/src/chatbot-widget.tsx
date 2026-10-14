import { useLayoutEffect, useRef, useState } from "react";
import { Chatbot } from "./chatbot";

export function ChatbotWidget() {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const panel = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (open) {
      panel.current?.show();
      const field = panel.current?.querySelector<HTMLTextAreaElement>("textarea");
      if (field && !field.disabled) field.focus({ preventScroll: true });
      else panel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    } else {
      panel.current?.close();
    }
  }, [open]);

  function close() {
    setOpen(false);
    launcher.current?.focus({ preventScroll: true });
  }

  return <>
    <dialog ref={panel} id="salon-chat-widget" className="chat-widget" aria-label="Chat with the salon guide" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <div className="chat-widget-toolbar"><a href="/help">Open full salon guide ↗</a><button type="button" aria-label="Close salon guide" onClick={close}>×</button></div>
      {started && <Chatbot compact active={open} />}
    </dialog>
    <button ref={launcher} type="button" className="chat-launcher" aria-label={open ? "Close salon guide" : "Chat for service recommendations"} aria-expanded={open} aria-controls="salon-chat-widget" aria-haspopup="dialog" onClick={() => { if (open) close(); else { setStarted(true); setOpen(true); } }}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5a10 10 0 0 1 20 0Z" /><path d="M7 10h8M7 14h5" /></svg>
      <span>Ask your salon guide</span>
    </button>
  </>;
}
