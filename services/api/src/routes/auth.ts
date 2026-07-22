import { Hono } from "hono";
import { config } from "../config.js";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";
import { hashPassword, hashSessionToken, verifyPassword } from "../lib/crypto.js";
import { requireUser } from "../middleware/auth.js";
import { clientKey, rateLimit } from "../middleware/rateLimit.js";

export const authRoutes = new Hono();

function setSessionCookie(token: string): string {
  const maxAge = 60 * 60 * 24 * 14;
  const secure = config.secureCookies ? "; Secure" : "";
  return `rg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

authRoutes.post("/register", async (c) => {
  if (!rateLimit(clientKey(c, "register"), 20, 60_000)) return c.json({ error: "too many requests" }, 429);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const displayName = String(body.display_name ?? email.split("@")[0] ?? "用户").trim();
  if (!email.includes("@") || password.length < 8) {
    return c.json({ error: "邮箱无效或密码过短（≥8）" }, 400);
  }
  const db = getDb();
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return c.json({ error: "邮箱已注册" }, 409);
  const userId = id("usr");
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at)
       VALUES (?, ?, ?, ?, 'user', ?)`
    ).run(userId, email, hashPassword(password), displayName, ts);
    db.prepare(
      `INSERT INTO credit_accounts (user_id, balance, pending_earnings, lifetime_spent, lifetime_earned)
       VALUES (?, 0, 0, 0, 0)`
    ).run(userId);
  });
  const token = id("sess");
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(hashSessionToken(token), userId, new Date(Date.now() + 14 * 864e5).toISOString(), ts);
  c.header("set-cookie", setSessionCookie(token));
  return c.json({
    user: { id: userId, email, display_name: displayName, role: "user" }
  });
});

authRoutes.post("/login", async (c) => {
  if (!rateLimit(clientKey(c, "login"), 30, 60_000)) return c.json({ error: "too many requests" }, 429);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const db = getDb();
  const user = db
    .prepare(`SELECT id, email, password_hash, display_name, role FROM users WHERE email = ?`)
    .get(email) as
    | {
        id: string;
        email: string;
        password_hash: string;
        display_name: string;
        role: "user" | "admin";
      }
    | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: "邮箱或密码错误" }, 401);
  }
  const token = id("sess");
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(
    hashSessionToken(token),
    user.id,
    new Date(Date.now() + 14 * 864e5).toISOString(),
    nowIso()
  );
  c.header("set-cookie", setSessionCookie(token));
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role
    }
  });
});

authRoutes.post("/logout", async (c) => {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)rg_session=([^;]+)/);
  if (m?.[1]) {
    getDb()
      .prepare("DELETE FROM sessions WHERE token = ?")
      .run(hashSessionToken(decodeURIComponent(m[1])));
  }
  c.header(
    "set-cookie",
    `rg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? "; Secure" : ""}`
  );
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  try {
    const user = requireUser(c);
    const account = getDb()
      .prepare(
        `SELECT balance, pending_earnings, lifetime_spent, lifetime_earned
         FROM credit_accounts WHERE user_id = ?`
      )
      .get(user.id);
    return c.json({ user, account });
  } catch {
    return c.json({ user: null, account: null });
  }
});
