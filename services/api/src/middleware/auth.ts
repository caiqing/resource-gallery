import type { Context, Next } from "hono";
import { getDb } from "../db/client.js";
import { hashSessionToken } from "../lib/crypto.js";

export type AuthUser = {
  id: string;
  email: string;
  display_name: string;
  role: "user" | "admin";
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser | null;
  }
}

export function readSessionToken(c: Context): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)rg_session=([^;]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

export async function authMiddleware(c: Context, next: Next) {
  const token = readSessionToken(c);
  if (!token) {
    c.set("user", null);
    await next();
    return;
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(hashSessionToken(token)) as
    | (AuthUser & { expires_at: string })
    | undefined;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    c.set("user", null);
  } else {
    c.set("user", {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      role: row.role
    });
  }
  await next();
}

export function requireUser(c: Context): AuthUser {
  const user = c.get("user");
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}

export function requireAdmin(c: Context): AuthUser {
  const user = requireUser(c);
  if (user.role !== "admin") throw new Error("FORBIDDEN");
  return user;
}
