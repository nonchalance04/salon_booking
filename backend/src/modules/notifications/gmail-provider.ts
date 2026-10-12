import { createHash } from "node:crypto";
import SMTPConnection from "nodemailer/lib/smtp-connection/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import { NotificationFailure, type NotificationProvider } from "./notification-provider.js";

type Connection = Pick<SMTPConnection, "connect" | "login" | "send" | "close"> & {
  on(event: "error" | "end", listener: (error?: unknown) => void): unknown;
};
type ConnectionFactory = (options: SMTPConnection.Options) => Connection;

function smtpFailure(error: unknown): NotificationFailure {
  const value = error as { code?: string; responseCode?: number } | null;
  const status = value?.responseCode;
  // Never retain SMTP responses: they can contain credentials or customer data.
  if (typeof status === "number" && status >= 400 && status <= 599) {
    return new NotificationFailure(`GMAIL_SMTP_${status}`, status < 500);
  }
  if (value?.code === "EAUTH") return new NotificationFailure("GMAIL_AUTH_FAILED", false);
  if (value?.code === "ETIMEDOUT") return new NotificationFailure("PROVIDER_TIMEOUT");
  return new NotificationFailure("PROVIDER_UNAVAILABLE");
}

export function createGmailProvider(
  user: string, password: string, from: string, timeoutMs: number,
  createConnection: ConnectionFactory = options => new SMTPConnection(options),
): NotificationProvider {
  return { async send(message, signal) {
    if (message.channel !== "EMAIL") throw new NotificationFailure("CHANNEL_MISMATCH", false);
    if (!z.email().safeParse(message.recipient).success) throw new NotificationFailure("INVALID_RECIPIENT", false);
    if (signal.aborted) throw new NotificationFailure("PROVIDER_TIMEOUT");

    // MailComposer handles MIME encoding and header escaping, including Unicode.
    // A stable Message-ID aids investigation; Gmail does not promise deduplication.
    const id = createHash("sha256").update(message.id).digest("hex");
    const content = await new MailComposer({
      from: { name: "", address: from }, to: [{ name: "", address: message.recipient }],
      subject: message.subject, text: message.text, html: message.html,
      messageId: `<${id}@${from.split("@")[1]}>`,
      disableFileAccess: true, disableUrlAccess: true,
    }).compile().build();
    if (signal.aborted) throw new NotificationFailure("PROVIDER_TIMEOUT");

    await new Promise<void>((resolve, reject) => {
      // Own one connection per attempt so abort closes the actual SMTP socket.
      const connection = createConnection({
        host: "smtp.gmail.com", port: 465, secure: true,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
        connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
        logger: false, debug: false,
      });
      let finished = false;
      const finish = (error?: NotificationFailure) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        connection.close();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new NotificationFailure("PROVIDER_TIMEOUT"));
      const timer = setTimeout(abort, timeoutMs);
      connection.on("error", error => finish(smtpFailure(error)));
      connection.on("end", () => finish(new NotificationFailure("PROVIDER_UNAVAILABLE")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        connection.connect(() => {
          if (finished) return;
          connection.login({ user, pass: password }, error => {
            if (finished) return;
            if (error) { finish(smtpFailure(error)); return; }
            connection.send({ from, to: [message.recipient] }, content, (error, info) => {
              if (finished) return;
              if (error) { finish(smtpFailure(error)); return; }
              if (!info?.accepted?.includes(message.recipient) || info.rejected?.length) {
                finish(new NotificationFailure("PROVIDER_REJECTED", false)); return;
              }
              finish();
            });
          });
        });
      } catch (error) { finish(smtpFailure(error)); }
    });
  } };
}
