import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function createGuestCredentials() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: tokenHash(token), bookingCode: `SL-${randomInt(36 ** 6).toString(36).toUpperCase().padStart(6, "0")}` };
}
export function validGuestToken(token: string, hash: string) {
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function validGuestAccess(
  db: Pick<import("../../../generated/prisma/client.js").Prisma.TransactionClient, "appointmentGuestSession">,
  token: string,
  row: { bookingCode: string; guestAccessTokenHash: string } | null,
) {
  if (validGuestToken(token, row?.guestAccessTokenHash ?? "0".repeat(64))) return Boolean(row);
  if (!row || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const session = await db.appointmentGuestSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { appointment: { select: { bookingCode: true } } }
  });
  return Boolean(session && session.expiresAt > new Date() && session.appointment.bookingCode === row.bookingCode);
}
