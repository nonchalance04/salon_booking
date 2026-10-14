import type { renderEmailLayout } from "./email-layout.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Initial email layout: a plain white page with readable text and details. */
export function renderSimpleEmailLayout(options: Parameters<typeof renderEmailLayout>[0] & { appointmentUrl?: string }): string {
  const { title, text, bookingCode, when, verificationCode, appointmentUrl } = options;
  const paragraphs = text.split(/\n\n+/).map(paragraph =>
    `<p style="margin:0 0 16px;">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`,
  ).join("");
  const detail = (label: string, value: string) =>
    `<p style="margin:0 0 12px;"><strong>${label}:</strong><br />${escapeHtml(value)}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(title)} | Clique Salon</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#292a28;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:24px 20px;">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<div style="max-width:600px;overflow-wrap:anywhere;">
<p style="margin:0 0 24px;font-weight:700;">Clique Salon &amp; Spa</p>
<h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;">${escapeHtml(title)}</h1>
${paragraphs}
${bookingCode ? detail("Booking reference", bookingCode) : ""}
${when ? detail("Appointment time", when) : ""}
${appointmentUrl ? `<p style="margin:24px 0 8px;"><a href="${escapeHtml(appointmentUrl)}" style="color:#203c34;font-weight:700;text-decoration:underline;">Your Appointment</a></p><p style="margin:0 0 16px;">View and manage your appointment details. Verify your email or phone number to access your appointment.</p>` : ""}
${verificationCode ? `<p style="margin:24px 0 8px;">Your verification code:</p><p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:4px;">${escapeHtml(verificationCode)}</p>` : ""}
</div><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
