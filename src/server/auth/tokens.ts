import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Invite codes: 12 chars from an unambiguous alphabet, shown as XXXX-XXXX-XXXX (~60 bits).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateInviteCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
export const normalizeInviteCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
/**
 * Invite codes are stored as HMAC-SHA256 keyed with AUTH_SECRET, so a leaked database alone
 * can't be used to brute-force valid codes offline.
 */
export function hashInviteCode(code: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set in production");
    return sha256("invite:" + normalizeInviteCode(code));
  }
  return createHmac("sha256", secret).update("invite:" + normalizeInviteCode(code)).digest("hex");
}
