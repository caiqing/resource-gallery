import { Hono } from "hono";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";
import { makeDownloadToken } from "../lib/crypto.js";
import { requireUser } from "../middleware/auth.js";
import { clientKey, rateLimit } from "../middleware/rateLimit.js";

export const meRoutes = new Hono();

meRoutes.use("*", async (c, next) => {
  try {
    requireUser(c);
    await next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHORIZED") return c.json({ error: "login required" }, 401);
    throw e;
  }
});

meRoutes.get("/likes", (c) => {
  const user = requireUser(c);
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.title, l.summary, l.cover_path, l.price_credits, l.like_count
       FROM likes k JOIN listings l ON l.id = k.listing_id
       WHERE k.user_id = ? AND l.status = 'published'
       ORDER BY k.created_at DESC`
    )
    .all(user.id);
  return c.json({ likes: rows });
});

meRoutes.patch("/profile", async (c) => {
  const user = requireUser(c);
  const body = await c.req.json().catch(() => ({}));
  const displayName = String(body.display_name ?? "").trim();
  if (displayName.length < 1 || displayName.length > 60) {
    return c.json({ error: "昵称长度须为 1–60 个字符" }, 400);
  }
  getDb().prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(displayName, user.id);
  return c.json({ user: { ...user, display_name: displayName } });
});

meRoutes.post("/likes/:listingId", (c) => {
  const user = requireUser(c);
  if (!rateLimit(clientKey(c, `like:${user.id}`), 60, 60_000)) return c.json({ error: "too many requests" }, 429);
  const listingId = c.req.param("listingId");
  const db = getDb();
  const listing = db
    .prepare(`SELECT id, status FROM listings WHERE id = ?`)
    .get(listingId) as { id: string; status: string } | undefined;
  if (!listing || listing.status !== "published") return c.json({ error: "not found" }, 404);
  const existing = db
    .prepare(`SELECT 1 FROM likes WHERE user_id = ? AND listing_id = ?`)
    .get(user.id, listingId);
  const liked = withTransaction(() => {
    if (existing) {
      db.prepare(`DELETE FROM likes WHERE user_id = ? AND listing_id = ?`).run(user.id, listingId);
      db.prepare(`UPDATE listings SET like_count = MAX(like_count - 1, 0) WHERE id = ?`).run(listingId);
      return false;
    }
    db.prepare(`INSERT INTO likes (user_id, listing_id, created_at) VALUES (?, ?, ?)`).run(
      user.id,
      listingId,
      nowIso()
    );
    db.prepare(`UPDATE listings SET like_count = like_count + 1 WHERE id = ?`).run(listingId);
    return true;
  });
  return c.json({ liked });
});

meRoutes.get("/entitlements", (c) => {
  const user = requireUser(c);
  const rows = getDb()
    .prepare(
      `SELECT e.listing_id, e.source, e.created_at, l.title, l.cover_path, l.price_credits
       FROM download_entitlements e
       JOIN listings l ON l.id = e.listing_id
       WHERE e.user_id = ?
       ORDER BY e.created_at DESC`
    )
    .all(user.id);
  return c.json({ entitlements: rows });
});

meRoutes.get("/ledger", (c) => {
  const user = requireUser(c);
  const rows = getDb()
    .prepare(
      `SELECT id, entry_type, amount, balance_after, note, created_at
       FROM ledger_entries WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 100`
    )
    .all(user.id);
  return c.json({ entries: rows });
});

meRoutes.post("/listings/:id/checkout", async (c) => {
  const user = requireUser(c);
  if (!rateLimit(clientKey(c, `checkout:${user.id}`), 30, 60_000)) return c.json({ error: "too many requests" }, 429);
  const listingId = c.req.param("id");
  const db = getDb();

  try {
    const result = withTransaction(() => {
      const listing = db
        .prepare(
          `SELECT id, title, price_credits, price_tier, status, author_user_id, download_count
           FROM listings WHERE id = ?`
        )
        .get(listingId) as any;
      if (!listing || listing.status !== "published") {
        throw new Error("NOT_FOUND");
      }

      const existing = db
        .prepare(
          `SELECT id FROM download_entitlements WHERE user_id = ? AND listing_id = ?`
        )
        .get(user.id, listingId);
      if (existing) {
        return { alreadyOwned: true as const, price: 0 };
      }

      // own listing free, no trade rank
      const isSelf = listing.author_user_id === user.id;
      const free = listing.price_credits === 0 || isSelf;

      if (free) {
        const entitlementId = id("ent");
        const ts = nowIso();
        db.prepare(
          `INSERT INTO download_entitlements (id, user_id, listing_id, source, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(entitlementId, user.id, listingId, isSelf ? "self" : "free", ts);
        if (!isSelf) {
          db.prepare(
            `INSERT INTO download_events (id, user_id, listing_id, entitlement_id, source, created_at)
             VALUES (?, ?, ?, ?, 'free', ?)`
          ).run(id("dle"), user.id, listingId, entitlementId, ts);
          db.prepare(`UPDATE listings SET download_count = download_count + 1 WHERE id = ?`).run(listingId);
        }
        return { alreadyOwned: false as const, price: 0, free: true as const };
      }

      const account = db
        .prepare(`SELECT balance, lifetime_spent FROM credit_accounts WHERE user_id = ?`)
        .get(user.id) as { balance: number; lifetime_spent: number };
      if (account.balance < listing.price_credits) throw new Error("INSUFFICIENT");

      const share = db
        .prepare(
          `SELECT author_share_bps, platform_share_bps FROM revenue_share_configs
           ORDER BY version DESC LIMIT 1`
        )
        .get() as { author_share_bps: number; platform_share_bps: number };

      const authorCredits = Math.floor(
        (listing.price_credits * share.author_share_bps) / 10000
      );
      const platformCredits = listing.price_credits - authorCredits;
      const orderId = id("ord");
      const ts = nowIso();
      const newBalance = account.balance - listing.price_credits;

      db.prepare(
        `UPDATE credit_accounts
         SET balance = ?, lifetime_spent = lifetime_spent + ?
         WHERE user_id = ?`
      ).run(newBalance, listing.price_credits, user.id);

      db.prepare(
        `INSERT INTO orders (
          id, buyer_user_id, listing_id, price_credits, price_tier,
          author_share_bps, platform_share_bps, author_credits, platform_credits, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orderId,
        user.id,
        listingId,
        listing.price_credits,
        listing.price_tier,
        share.author_share_bps,
        share.platform_share_bps,
        authorCredits,
        platformCredits,
        ts
      );

      db.prepare(
        `INSERT INTO ledger_entries (
          id, user_id, order_id, entry_type, amount, balance_after, note, created_at
        ) VALUES (?, ?, ?, 'purchase', ?, ?, ?, ?)`
      ).run(
        id("led"),
        user.id,
        orderId,
        -listing.price_credits,
        newBalance,
        `获取《${listing.title}》`,
        ts
      );

      db.prepare(
        `UPDATE credit_accounts
         SET pending_earnings = pending_earnings + ?, lifetime_earned = lifetime_earned + ?
         WHERE user_id = ?`
      ).run(authorCredits, authorCredits, listing.author_user_id);

      const entitlementId = id("ent");
      db.prepare(
        `INSERT INTO download_entitlements (id, user_id, listing_id, source, created_at)
         VALUES (?, ?, ?, 'purchase', ?)`
      ).run(entitlementId, user.id, listingId, ts);

      db.prepare(
        `INSERT INTO download_events (id, user_id, listing_id, entitlement_id, source, created_at)
         VALUES (?, ?, ?, ?, 'purchase', ?)`
      ).run(id("dle"), user.id, listingId, entitlementId, ts);

      db.prepare(
        `UPDATE listings SET download_count = download_count + 1 WHERE id = ?`
      ).run(listingId);

      return {
        alreadyOwned: false as const,
        price: listing.price_credits,
        free: false as const,
        orderId,
        balance: newBalance
      };
    });

    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return c.json({ error: "not found" }, 404);
    if (msg === "INSUFFICIENT") return c.json({ error: "余额不足" }, 402);
    throw e;
  }
});

meRoutes.post("/listings/:id/download-token", (c) => {
  const user = requireUser(c);
  if (!rateLimit(clientKey(c, `download-token:${user.id}`), 30, 60_000)) {
    return c.json({ error: "too many requests" }, 429);
  }
  const listingId = c.req.param("id");
  const db = getDb();
  const listing = db
    .prepare(`SELECT id, status, price_credits, author_user_id, active_version_id FROM listings WHERE id = ?`)
    .get(listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);

  const ent = db
    .prepare(`SELECT id FROM download_entitlements WHERE user_id = ? AND listing_id = ?`)
    .get(user.id, listingId);
  const adminAccess = user.role === "admin";
  const free =
    listing.status === "published" &&
    (listing.price_credits === 0 || listing.author_user_id === user.id);
  if (!ent && !free && !adminAccess) return c.json({ error: "no entitlement" }, 403);

  if (!ent && free) {
    withTransaction(() => {
      const isSelf = listing.author_user_id === user.id;
      const entitlementId = id("ent");
      const ts = nowIso();
      db.prepare(
        `INSERT INTO download_entitlements (id, user_id, listing_id, source, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(entitlementId, user.id, listingId, isSelf ? "self" : "free", ts);
      if (!isSelf) {
        db.prepare(
          `INSERT INTO download_events (id, user_id, listing_id, entitlement_id, source, created_at)
           VALUES (?, ?, ?, ?, 'free', ?)`
        ).run(id("dle"), user.id, listingId, entitlementId, ts);
        db.prepare(`UPDATE listings SET download_count = download_count + 1 WHERE id = ?`).run(listingId);
      }
    });
  }

  const token = makeDownloadToken(listingId, user.id);
  const requestedFile = String(c.req.query("file") || "").trim();
  if (requestedFile) {
    const file = listing.active_version_id
      ? db
          .prepare(
            `SELECT filename FROM listing_assets
             WHERE version_id = ?
               AND stripped = 0
               AND included = 1
               AND kind NOT IN ('poster', 'preview_audio', 'preview_video')
               AND filename = ?`
          )
          .get(listing.active_version_id, requestedFile) as { filename: string } | undefined
      : db
          .prepare(
            `SELECT filename FROM listing_files
             WHERE listing_id = ? AND stripped = 0 AND included = 1 AND filename = ?`
          )
          .get(listingId, requestedFile) as { filename: string } | undefined;
    if (!file) return c.json({ error: "file not found" }, 404);
  }
  const qs = new URLSearchParams({ token });
  if (requestedFile) qs.set("file", requestedFile);
  return c.json({
    token,
    expires_in_sec: 300,
    url: `/api/downloads/${listingId}?${qs.toString()}`
  });
});

meRoutes.post("/listings/:id/share", (c) => {
  const user = requireUser(c);
  const listingId = c.req.param("id");
  const db = getDb();
  const listing = db
    .prepare(`SELECT id, status FROM listings WHERE id = ?`)
    .get(listingId) as any;
  if (!listing || !["published", "unlisted"].includes(listing.status)) {
    return c.json({ error: "not found" }, 404);
  }
  const existing = db
    .prepare(`SELECT slug FROM share_links WHERE listing_id = ?`)
    .get(listingId) as { slug: string } | undefined;
  if (existing) {
    return c.json({
      slug: existing.slug,
      path: `/share/${existing.slug}`,
      public_path: `/s/${existing.slug}`
    });
  }
  const slug = id("s").slice(2, 10);
  db.prepare(
    `INSERT INTO share_links (id, listing_id, slug, created_at) VALUES (?, ?, ?, ?)`
  ).run(id("shr"), listingId, slug, nowIso());
  return c.json({ slug, path: `/share/${slug}`, public_path: `/s/${slug}`, by: user.id });
});

meRoutes.post("/listings/:id/report", async (c) => {
  const user = requireUser(c);
  if (!rateLimit(clientKey(c, `report:${user.id}`), 10, 60_000)) {
    return c.json({ error: "too many requests" }, 429);
  }
  const listingId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim();
  const detail = String(body.detail ?? "").trim();
  if (!["copyright", "unsafe", "misleading", "other"].includes(reason)) {
    return c.json({ error: "invalid reason" }, 400);
  }
  const db = getDb();
  const listing = db
    .prepare(`SELECT id FROM listings WHERE id = ? AND status IN ('published', 'unlisted')`)
    .get(listingId);
  if (!listing) return c.json({ error: "not found" }, 404);
  try {
    const reportId = id("rpt");
    const ts = nowIso();
    db.prepare(
      `INSERT INTO reports (id, reporter_user_id, listing_id, reason, detail, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(reportId, user.id, listingId, reason, detail.slice(0, 1000), ts, ts);
    return c.json({ id: reportId, status: "open" });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "已提交待处理举报" }, 409);
    }
    throw error;
  }
});
