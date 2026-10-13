function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

/** Inline styles and presentation tables keep the website's look in mail clients. */
export function renderEmailLayout(options: {
  title: string;
  text: string;
  bookingCode?: string;
  when?: string;
  verificationCode?: string;
}): string {
  const { title, text, bookingCode, when, verificationCode } = options;
  const detail = (label: string, value: string) =>
    `<tr><td style="padding:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#73756f;text-transform:uppercase;">${label}</td></tr><tr><td style="padding:0 0 20px;font-size:17px;font-weight:700;line-height:1.5;overflow-wrap:anywhere;">${escapeHtml(value)}</td></tr>`;
  const details =
    bookingCode || when
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px;background:#f3f3f1;border:1px solid #ddddd7;border-radius:16px;"><tr><td style="padding:22px 22px 2px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${bookingCode ? detail("Booking reference", bookingCode) : ""}${when ? detail("Appointment time", when) : ""}</table></td></tr></table>`
      : "";
  const code = verificationCode
    ? `<div style="margin-top:24px;padding:24px 12px;text-align:center;background:#f3f3f1;border:1px solid #ddddd7;border-radius:16px;"><p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#73756f;">YOUR VERIFICATION CODE</p><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:36px;line-height:1.3;font-weight:700;letter-spacing:6px;color:#292a28;">${escapeHtml(verificationCode)}</p></div>`
    : "";
  const paragraphs = text
    .split(/\n\n+/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.75;color:#5e6059;">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light" /><title>${escapeHtml(title)} | Clique Salon</title>
<style>@media only screen and (max-width:480px){.email-shell{padding:24px 12px!important}.email-content{padding:28px 22px!important}.email-title{font-size:28px!important}}</style></head>
<body style="margin:0;padding:0;background:#f3f3f1;color:#292a28;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;line-height:1px;color:#f3f3f1;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(title)}${bookingCode ? ` · Booking ${escapeHtml(bookingCode)}` : ""}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f3f3f1"><tr><td class="email-shell" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;text-align:left;">
<tr><td style="padding:0 8px 28px;"><div style="color:#d3ae30;font-size:43px;line-height:1;font-weight:900;letter-spacing:-2.8px;">CLIQUE</div><div style="margin-top:7px;color:#d3ae30;font-size:18px;line-height:1.2;font-weight:700;letter-spacing:-.55px;">salon and spa</div></td></tr>
<tr><td class="email-content" bgcolor="#ffffff" style="padding:40px;border:1px solid #ddddd7;border-top:4px solid #d3ae30;border-radius:20px;">
<p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;color:#987b1f;">A LITTLE TIME FOR YOURSELF</p>
<h1 class="email-title" style="margin:0 0 22px;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:-1px;color:#292a28;">${escapeHtml(title)}</h1>
${paragraphs}${details}${code}
</td></tr>
<tr><td style="padding:24px 16px;text-align:center;"><p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#73756f;">Your beauty. Our passion.</p><p style="margin:0;font-size:11px;line-height:1.6;color:#73756f;">Clique Salon &amp; Spa · Appointment updates</p></td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
