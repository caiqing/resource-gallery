import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 32).toString("hex");
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
  } catch {
    return false;
  }
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", config.sessionSecret).update(token).digest("hex");
}

export function makeDownloadToken(listingId: string, userId: string, ttlMs = 5 * 60 * 1000): string {
  const exp = Date.now() + ttlMs;
  const payload = `${listingId}:${userId}`;
  const body = `${payload}.${exp}`;
  const sig = createHmac("sha256", config.downloadSigningSecret).update(body).digest("hex");
  return Buffer.from(`${body}.${sig}`).toString("base64url");
}

export function verifyDownloadToken(
  token: string
): { listingId: string; userId: string; exp: number } | null {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split(".");
    if (parts.length !== 3) return null;
    const [payload, expStr, sig] = parts;
    if (!payload || !expStr || !sig) return null;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return null;
    const body = `${payload}.${exp}`;
    const expected = createHmac("sha256", config.downloadSigningSecret).update(body).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const [listingId, userId] = payload.split(":");
    if (!listingId || !userId) return null;
    return { listingId, userId, exp };
  } catch {
    return null;
  }
}
