import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import SMTPConnection from "nodemailer/lib/smtp-connection/index.js";
import { createGmailProvider } from "../src/modules/notifications/gmail-provider.js";
import { NotificationFailure, type NotificationMessage } from "../src/modules/notifications/notification-provider.js";
import { parseEnv } from "../src/config/env.schema.js";
import { configuredNotificationProviders } from "../src/modules/notifications/provider-config.js";

const user = "salon@gmail.com";
const password = "abcdefghijklmnop";
const message: NotificationMessage = { id: "queue-id", channel: "EMAIL", recipient: "guest@example.test", subject: "Booking confirmed", text: "Appointment confirmed — ₱100.00" };
class FakeConnection extends EventEmitter {
  closed = 0;
  content = "";
  envelope?: SMTPConnection.Envelope;
  auth?: SMTPConnection.AuthenticationType;
  connect: SMTPConnection["connect"] = callback => callback?.();
  login: SMTPConnection["login"] = (auth, callback) => { this.auth = auth; callback(null); };
  send: SMTPConnection["send"] = (envelope, content, callback) => {
    this.envelope = envelope; this.content = content.toString();
    callback(null, { accepted: [message.recipient], rejected: [], response: "250 accepted", envelopeTime: 1, messageTime: 1, messageSize: 1 });
  };
  close() { this.closed++; this.emit("end"); }
}
function fixture(connection = new FakeConnection(), timeoutMs = 1000) {
  let options: SMTPConnection.Options | undefined;
  let calls = 0;
  const provider = createGmailProvider(user, password, user, timeoutMs, value => { options = value; calls++; return connection; });
  return { provider, connection, get options() { return options!; }, get calls() { return calls; } };
}
test("Gmail sends HTML with a plain-text alternative", async () => {
  const f = fixture();
  await f.provider.send({ ...message, html: "<h1>CLIQUE</h1><p>Booking confirmed</p>" }, new AbortController().signal);
  assert.match(f.connection.content, /Content-Type: multipart\/alternative/);
  assert.match(f.connection.content, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(f.connection.content, /Content-Type: text\/html; charset=utf-8/);
  assert.match(f.connection.content, /<h1>CLIQUE<\/h1>/);
});
test("Gmail sends MIME text to one recipient over verified TLS and closes each connection", async () => {
  const f = fixture();
  await f.provider.send(message, new AbortController().signal);
  assert.equal(f.options.host, "smtp.gmail.com");
  assert.equal(f.options.port, 465); assert.equal(f.options.secure, true);
  assert.equal(f.options.tls?.rejectUnauthorized, true);
  assert.equal(f.options.debug, false); assert.equal(f.options.logger, false);
  assert.deepEqual(f.connection.auth, { user, pass: password });
  assert.deepEqual(f.connection.envelope, { from: user, to: [message.recipient] });
  assert.match(f.connection.content, /Subject: Booking confirmed/);
  assert.match(f.connection.content, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(f.connection.content, /Appointment confirmed =E2=80=94 =E2=82=B1100.00/);
  assert.ok(!f.connection.content.includes(password));
  const messageId = f.connection.content.match(/Message-ID: (.*)/i)?.[1];
  await f.provider.send(message, new AbortController().signal);
  assert.equal(f.connection.content.match(/Message-ID: (.*)/i)?.[1], messageId);
  assert.equal(f.connection.closed, 2);
});
test("Gmail rejects wrong channels, invalid recipients and pre-aborted sends before connecting", async () => {
  const f = fixture();
  await assert.rejects(f.provider.send({ ...message, channel: "SMS" }, new AbortController().signal), /CHANNEL_MISMATCH/);
  for (const recipient of ["bad", "a@example.com,b@example.com", "a@example.com\r\nBcc: b@example.com"]) {
    await assert.rejects(f.provider.send({ ...message, recipient }, new AbortController().signal), /INVALID_RECIPIENT/);
  }
  await assert.rejects(f.provider.send(message, AbortSignal.abort()), /PROVIDER_TIMEOUT/);
  assert.equal(f.calls, 0);
});
test("Gmail sanitizes authentication, SMTP and network failures and classifies retries", async () => {
  for (const [details, code, retryable] of [
    [{ code: "EAUTH" }, "GMAIL_AUTH_FAILED", false],
    [{ code: "EAUTH", responseCode: 454 }, "GMAIL_SMTP_454", true],
    [{ responseCode: 535 }, "GMAIL_SMTP_535", false],
    [{ responseCode: 550 }, "GMAIL_SMTP_550", false],
    [{ responseCode: 421 }, "GMAIL_SMTP_421", true],
    [{ code: "ETIMEDOUT" }, "PROVIDER_TIMEOUT", true],
    [{ code: "ECONNECTION" }, "PROVIDER_UNAVAILABLE", true],
  ] as const) {
    const f = fixture();
    f.connection.login = (_auth, callback) => callback(Object.assign(new Error("private password recipient"), details));
    await assert.rejects(f.provider.send(message, new AbortController().signal), (error: NotificationFailure) => {
      assert.equal(error.message, code); assert.equal(error.retryable, retryable); return true;
    });
    assert.equal(f.connection.closed, 1);
  }
});
test("Gmail handles connection errors, early disconnect and rejected SMTP recipients", async () => {
  const f = fixture();
  f.connection.connect = () => { f.connection.emit("error", new Error("private")); };
  await assert.rejects(f.provider.send(message, new AbortController().signal), /PROVIDER_UNAVAILABLE/);
  f.connection.connect = () => { f.connection.emit("end"); };
  await assert.rejects(f.provider.send(message, new AbortController().signal), /PROVIDER_UNAVAILABLE/);
  f.connection.connect = callback => callback?.();
  f.connection.send = (_envelope, _content, callback) => callback(null, { accepted: [], rejected: [message.recipient] } as unknown as SMTPConnection.SentMessageInfo);
  await assert.rejects(f.provider.send(message, new AbortController().signal), /PROVIDER_REJECTED/);
});
test("Gmail abort closes the connection and prevents late connect/login callbacks from sending", async () => {
  for (const stage of ["connect", "login"] as const) {
    const f = fixture(); const controller = new AbortController();
    let late!: () => void; let sends = 0;
    if (stage === "connect") f.connection.connect = callback => { late = () => callback?.(); controller.abort(); };
    else f.connection.login = (_auth, callback) => { late = () => callback(null); controller.abort(); };
    f.connection.send = () => { sends++; };
    await assert.rejects(f.provider.send(message, controller.signal), /PROVIDER_TIMEOUT/);
    late();
    assert.equal(sends, 0); assert.equal(f.connection.closed, 1);
  }
});
test("Gmail enforces a total deadline even with an unresponsive SMTP server", async () => {
  const f = fixture(new FakeConnection(), 20);
  f.connection.send = () => {};
  await assert.rejects(f.provider.send(message, new AbortController().signal), /PROVIDER_TIMEOUT/);
  assert.equal(f.connection.closed, 1);
});
test("Gmail configuration normalizes App Password spacing, requires matching sender and wires EMAIL", () => {
  const base = { DATABASE_URL: "postgresql://localhost/test", JWT_SECRET: "a".repeat(32), NOTIFICATION_EMAIL_PROVIDER: "gmail", GMAIL_USER: user, GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop", NOTIFICATION_EMAIL_FROM: user };
  const env = parseEnv(base);
  assert.equal(env.GMAIL_APP_PASSWORD, password);
  assert.deepEqual(Object.keys(configuredNotificationProviders(env)), ["EMAIL"]);
  assert.equal(parseEnv({ ...base, NODE_ENV: "production", TRUSTED_ORIGINS: "https://salon.test" }).NOTIFICATION_EMAIL_PROVIDER, "gmail");
  for (const bad of [{ GMAIL_USER: "" }, { GMAIL_USER: "bad" }, { GMAIL_APP_PASSWORD: "" }, { GMAIL_APP_PASSWORD: "short" }, { GMAIL_APP_PASSWORD: "abcdefghijklmnop\n" }, { NOTIFICATION_EMAIL_FROM: "" }, { NOTIFICATION_EMAIL_FROM: "other@gmail.com" }, { NOTIFICATION_EMAIL_PROVIDER: "resend" }]) {
    assert.throws(() => parseEnv({ ...base, ...bad }), /Invalid environment/);
  }
  assert.deepEqual(Object.keys(configuredNotificationProviders(parseEnv({ ...base, NOTIFICATION_EMAIL_PROVIDER: "disabled" }))), []);
});

test("Gmail adapter completes a real SMTP conversation and disconnects when acceptance stalls", async () => {
  for (const stall of [false, true]) {
    let received = "";
    let disconnected!: Promise<unknown>;
    const server = createServer(socket => {
      disconnected = once(socket, "close");
      socket.on("error", () => {});
      socket.write("220 localhost ESMTP\r\n");
      let pending = ""; let data = false;
      socket.on("data", chunk => {
        pending += chunk.toString();
        while (pending.includes("\r\n")) {
          const end = pending.indexOf("\r\n");
          const line = pending.slice(0, end); pending = pending.slice(end + 2);
          if (data) {
            if (line !== ".") { received += line + "\r\n"; continue; }
            data = false;
            if (!stall) socket.write("250 accepted\r\n");
          } else if (line.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH PLAIN")) socket.write("235 authenticated\r\n");
          else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
          else if (line === "DATA") { data = true; socket.write("354 send message\r\n"); }
          else socket.write("500 unexpected command\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const provider = createGmailProvider(user, password, user, 1000, options => new SMTPConnection({
        ...options, host: "127.0.0.1", port: address.port, secure: false,
        ignoreTLS: true, allowInternalNetworkInterfaces: true,
      }));
      if (stall) await assert.rejects(provider.send(message, new AbortController().signal), /PROVIDER_TIMEOUT/);
      else await provider.send(message, new AbortController().signal);
      await disconnected;
      assert.match(received, /Subject: Booking confirmed/);
      assert.match(received, /To: guest@example.test/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});


test("email OTP is opt-in, independent of routine email, and requires Gmail credentials and a separate OTP secret", () => {
  const base = { DATABASE_URL: "postgresql://localhost/test", JWT_SECRET: "a".repeat(32) };
  assert.equal(parseEnv(base).APPOINTMENT_EMAIL_OTP_PROVIDER, "disabled");
  const email = { ...base, APPOINTMENT_EMAIL_OTP_PROVIDER: "gmail", APPOINTMENT_OTP_SECRET: "b".repeat(32), GMAIL_USER: user, GMAIL_APP_PASSWORD: password, NOTIFICATION_EMAIL_FROM: user };
  assert.equal(parseEnv(email).NOTIFICATION_EMAIL_PROVIDER, "disabled");
  for (const bad of [{ APPOINTMENT_OTP_SECRET: "" }, { GMAIL_USER: "" }, { GMAIL_APP_PASSWORD: "" }, { NOTIFICATION_EMAIL_FROM: "other@gmail.com" }]) {
    assert.throws(() => parseEnv({ ...email, ...bad }), /Invalid environment/);
  }
});
