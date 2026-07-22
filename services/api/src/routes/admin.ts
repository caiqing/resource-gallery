import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";
import { processImportJob } from "../lib/import.js";
import { requireAdmin } from "../middleware/auth.js";

export const adminRoutes = new Hono();

adminRoutes.use("*", async (c, next) => {
  try {
    requireAdmin(c);
    await next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHORIZED") return c.json({ error: "login required" }, 401);
    if (msg === "FORBIDDEN") return c.json({ error: "admin only" }, 403);
    throw e;
  }
});

adminRoutes.get("/overview", (c) => {
  const db = getDb();
  const published = db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'published'`).get() as { c: number };
  const draft = db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'draft'`).get() as { c: number };
  const jobs = db.prepare(`SELECT COUNT(*) AS c FROM import_jobs`).get() as { c: number };
  const users = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  const openReports = db.prepare(`SELECT COUNT(*) AS c FROM reports WHERE status = 'open'`).get() as { c: number };
  const failedImports = db.prepare(`SELECT COUNT(*) AS c FROM import_jobs WHERE status = 'failed'`).get() as { c: number };
  return c.json({
    published: published.c,
    draft: draft.c,
    import_jobs: jobs.c,
    users: users.c,
    open_reports: openReports.c,
    failed_imports: failedImports.c
  });
});

adminRoutes.get("/import-jobs", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT id, filename, status, message, listing_id, source_task_id, source_run_id, created_at, finished_at
       FROM import_jobs ORDER BY created_at DESC LIMIT 100`
    )
    .all();
  return c.json({ jobs: rows });
});

adminRoutes.post("/import-jobs", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === "string") {
    return c.json({ error: "需要上传 zip 文件字段 file" }, 400);
  }
  const ab = await file.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.byteLength > config.maxPackageBytes) {
    return c.json({ error: "包体积超限" }, 400);
  }
  if (!String(file.name || "").toLowerCase().endsWith(".zip")) {
    return c.json({ error: "仅接受 .zip" }, 400);
  }

  const jobId = id("job");
  const uploadPath = join(config.uploadRoot, `${jobId}.zip`);
  mkdirSync(config.uploadRoot, { recursive: true });
  writeFileSync(uploadPath, buf);

  getDb()
    .prepare(
      `INSERT INTO import_jobs (
        id, admin_user_id, filename, status, message, created_at
      ) VALUES (?, ?, ?, 'pending', '', ?)`
    )
    .run(jobId, admin.id, file.name || `${jobId}.zip`, nowIso());

  try {
    // Inline execution keeps the MVP deterministic; ImportJob still exposes explicit lifecycle state.
    await processImportJob(jobId, uploadPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "import failed";
    const ts = nowIso();
    getDb().prepare(
      `UPDATE import_jobs SET status = 'failed', message = ?, finished_at = ? WHERE id = ?`
    ).run(message.slice(0, 1000), ts, jobId);
    getDb().prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'import.failed', 'import_job', ?, ?, ?)`
    ).run(id("aud"), admin.id, jobId, JSON.stringify({ message }), ts);
  } finally {
    rmSync(uploadPath, { force: true });
  }

  const job = getDb().prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId);
  return c.json({ job });
});

adminRoutes.get("/listings", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.title, l.status, l.price_tier, l.price_credits, l.source_task_id, l.source_run_id, l.updated_at
       FROM listings l
       ORDER BY l.updated_at DESC
       LIMIT 200`
    )
    .all();
  return c.json({ listings: rows });
});

adminRoutes.get("/listings/:id", (c) => {
  const db = getDb();
  const listing = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(c.req.param("id"));
  if (!listing) return c.json({ error: "not found" }, 404);
  const files = db
    .prepare(`SELECT * FROM listing_files WHERE listing_id = ? ORDER BY stripped ASC, filename`)
    .all(c.req.param("id"));
  const tags = db
    .prepare(`SELECT tag, topic_id FROM listing_tags WHERE listing_id = ?`)
    .all(c.req.param("id"));
  return c.json({ listing, files, tags });
});

adminRoutes.patch("/listings/:id", async (c) => {
  const admin = requireAdmin(c);
  const listingId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const listing = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);

  const title = body.title != null ? String(body.title).trim() : listing.title;
  const summary = body.summary != null ? String(body.summary).trim() : listing.summary;
  if (!title || title.length > 120 || summary.length > 1000) {
    return c.json({ error: "标题或摘要长度无效" }, 400);
  }
  const priceTier = body.price_tier != null ? String(body.price_tier) : listing.price_tier;
  const tier = db.prepare(`SELECT credits FROM price_tiers WHERE id = ?`).get(priceTier) as
    | { credits: number }
    | undefined;
  if (!tier) return c.json({ error: "invalid price tier" }, 400);
  const priceCredits = tier.credits;
  const status = body.status != null ? String(body.status) : listing.status;
  if (!["draft", "published", "unlisted", "taken_down"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const transitions: Record<string, string[]> = {
    draft: ["draft"],
    published: ["published", "unlisted", "taken_down"],
    unlisted: ["unlisted", "taken_down"],
    taken_down: ["taken_down", "draft"]
  };
  if (!transitions[listing.status]?.includes(status)) {
    return c.json({ error: `invalid transition ${listing.status} -> ${status}` }, 409);
  }

  const ts = nowIso();
  const publishedAt =
    status === "published"
      ? listing.published_at ?? ts
      : listing.published_at;

  withTransaction(() => {
    db.prepare(
      `UPDATE listings
       SET title = ?, summary = ?, price_tier = ?, price_credits = ?, status = ?, published_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(title, summary, priceTier, priceCredits, status, publishedAt, ts, listingId);

    if (Array.isArray(body.included_file_ids)) {
      const ids = new Set(body.included_file_ids.map(String));
      const files = db
        .prepare(`SELECT id, stripped FROM listing_files WHERE listing_id = ?`)
        .all(listingId) as { id: string; stripped: number }[];
      for (const file of files) {
        db.prepare(`UPDATE listing_files SET included = ? WHERE id = ?`).run(
          !file.stripped && ids.has(file.id) ? 1 : 0,
          file.id
        );
      }
    }

    if (Array.isArray(body.tags)) {
      db.prepare(`DELETE FROM listing_tags WHERE listing_id = ?`).run(listingId);
      const tags = [
        ...new Set<string>(
          (body.tags as unknown[]).map((tag) => String(tag).trim()).filter(Boolean)
        )
      ].slice(0, 20);
      for (const tag of tags) {
        db.prepare(
          `INSERT OR IGNORE INTO listing_tags (listing_id, tag, topic_id) VALUES (?, ?, ?)`
        ).run(listingId, tag, body.topic_id ?? null);
      }
    }

    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'listing.update', 'listing', ?, ?, ?)`
    ).run(
      id("aud"),
      admin.id,
      listingId,
      JSON.stringify({ from_status: listing.status, status, price_tier: priceTier }),
      ts
    );
  });

  const next = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(listingId);
  return c.json({ listing: next });
});

adminRoutes.post("/listings/:id/publish", async (c) => {
  const admin = requireAdmin(c);
  const listingId = c.req.param("id");
  const db = getDb();
  const listing = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);
  if (!["draft", "unlisted", "published"].includes(listing.status)) {
    return c.json({ error: `invalid transition ${listing.status} -> published` }, 409);
  }
  const usable = db
    .prepare(
      `SELECT COUNT(*) AS c FROM listing_files WHERE listing_id = ? AND stripped = 0 AND included = 1`
    )
    .get(listingId) as { c: number };
  if (usable.c === 0) return c.json({ error: "无可用文件，无法发布" }, 400);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(
      `UPDATE listings SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
    ).run(ts, ts, listingId);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'listing.publish', 'listing', ?, ?, ?)`
    ).run(id("aud"), admin.id, listingId, JSON.stringify({ from_status: listing.status }), ts);
  });
  return c.json({ ok: true });
});

adminRoutes.post("/credits/grant", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").toLowerCase();
  const amount = Number(body.amount ?? 0);
  if (!email || !Number.isFinite(amount) || amount === 0) {
    return c.json({ error: "email/amount invalid" }, 400);
  }
  const db = getDb();
  const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as
    | { id: string }
    | undefined;
  if (!user) return c.json({ error: "user not found" }, 404);
  const account = db
    .prepare(`SELECT balance FROM credit_accounts WHERE user_id = ?`)
    .get(user.id) as { balance: number };
  const next = account.balance + amount;
  if (next < 0) return c.json({ error: "余额将为负" }, 400);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(`UPDATE credit_accounts SET balance = ? WHERE user_id = ?`).run(next, user.id);
    db.prepare(
      `INSERT INTO ledger_entries (id, user_id, order_id, entry_type, amount, balance_after, note, created_at)
       VALUES (?, ?, NULL, 'grant', ?, ?, ?, ?)`
    ).run(id("led"), user.id, amount, next, String(body.note ?? "admin grant"), ts);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'credits.grant', 'user', ?, ?, ?)`
    ).run(id("aud"), admin.id, user.id, JSON.stringify({ amount }), ts);
  });
  return c.json({ balance: next });
});

adminRoutes.get("/price-tiers", (c) => {
  return c.json({
    tiers: getDb().prepare(`SELECT id, label, credits FROM price_tiers ORDER BY credits`).all()
  });
});

adminRoutes.patch("/price-tiers/:id", async (c) => {
  const admin = requireAdmin(c);
  const tierId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const credits = Number(body.credits);
  const label = String(body.label ?? "").trim();
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 100000 || !label || label.length > 40) {
    return c.json({ error: "invalid tier" }, 400);
  }
  const db = getDb();
  const current = db.prepare(`SELECT id FROM price_tiers WHERE id = ?`).get(tierId);
  if (!current) return c.json({ error: "not found" }, 404);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(`UPDATE price_tiers SET label = ?, credits = ? WHERE id = ?`).run(label, credits, tierId);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'price_tier.update', 'config', ?, ?, ?)`
    ).run(id("aud"), admin.id, tierId, JSON.stringify({ label, credits }), ts);
  });
  return c.json({ id: tierId, label, credits });
});

adminRoutes.get("/users", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at,
              a.balance, a.pending_earnings, a.lifetime_spent, a.lifetime_earned,
              (SELECT COUNT(*) FROM orders o WHERE o.buyer_user_id = u.id) AS order_count
       FROM users u JOIN credit_accounts a ON a.user_id = u.id
       ORDER BY u.created_at DESC LIMIT 200`
    )
    .all();
  return c.json({ users: rows });
});

adminRoutes.get("/orders", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT o.*, b.email AS buyer_email, l.title AS listing_title, a.email AS author_email
       FROM orders o
       JOIN users b ON b.id = o.buyer_user_id
       JOIN listings l ON l.id = o.listing_id
       JOIN users a ON a.id = l.author_user_id
       ORDER BY o.created_at DESC LIMIT 200`
    )
    .all();
  return c.json({ orders: rows });
});

adminRoutes.get("/audit-logs", (c) => {
  const action = String(c.req.query("action") ?? "").trim();
  const rows = action
    ? getDb()
        .prepare(
          `SELECT a.*, u.email AS actor_email FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE a.action = ? ORDER BY a.created_at DESC LIMIT 200`
        )
        .all(action)
    : getDb()
        .prepare(
          `SELECT a.*, u.email AS actor_email FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
           ORDER BY a.created_at DESC LIMIT 200`
        )
        .all();
  return c.json({ logs: rows });
});

adminRoutes.get("/reports", (c) => {
  const status = String(c.req.query("status") ?? "open");
  if (!["open", "resolved", "dismissed", "all"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const where = status === "all" ? "" : "WHERE r.status = ?";
  const rows = getDb()
    .prepare(
      `SELECT r.*, l.title AS listing_title, u.email AS reporter_email
       FROM reports r
       JOIN listings l ON l.id = r.listing_id
       JOIN users u ON u.id = r.reporter_user_id
       ${where}
       ORDER BY r.created_at DESC LIMIT 200`
    )
    .all(...(status === "all" ? [] : [status]));
  return c.json({ reports: rows });
});

adminRoutes.patch("/reports/:id", async (c) => {
  const admin = requireAdmin(c);
  const reportId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status ?? "resolved");
  const resolution = String(body.resolution ?? "").trim().slice(0, 1000);
  const takeDown = body.take_down === true;
  if (!["resolved", "dismissed"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const db = getDb();
  const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(reportId) as any;
  if (!report) return c.json({ error: "not found" }, 404);
  if (report.status !== "open") return c.json({ error: "report already handled" }, 409);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(`UPDATE reports SET status = ?, resolution = ?, updated_at = ? WHERE id = ?`).run(
      status,
      resolution,
      ts,
      reportId
    );
    if (takeDown) {
      db.prepare(
        `UPDATE listings SET status = 'taken_down', updated_at = ?
         WHERE id = ? AND status IN ('published', 'unlisted')`
      ).run(ts, report.listing_id);
    }
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'report.resolve', 'report', ?, ?, ?)`
    ).run(
      id("aud"),
      admin.id,
      reportId,
      JSON.stringify({ status, take_down: takeDown, listing_id: report.listing_id, resolution }),
      ts
    );
  });
  return c.json({ id: reportId, status, take_down: takeDown });
});

adminRoutes.get("/revenue-share", (c) => {
  return c.json({
    configs: getDb()
      .prepare(
        `SELECT id, version, author_share_bps, platform_share_bps, effective_at
         FROM revenue_share_configs ORDER BY version DESC`
      )
      .all()
  });
});

adminRoutes.post("/revenue-share", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  const author = Number(body.author_share_bps ?? 7000);
  const platform = Number(body.platform_share_bps ?? 3000);
  if (
    !Number.isSafeInteger(author) ||
    !Number.isSafeInteger(platform) ||
    author < 0 ||
    platform < 0 ||
    author + platform !== 10000
  ) {
    return c.json({ error: "bps 必须为非负整数且之和为 10000" }, 400);
  }
  const db = getDb();
  const latest = db
    .prepare(`SELECT MAX(version) AS v FROM revenue_share_configs`)
    .get() as { v: number | null };
  const version = (latest.v ?? 0) + 1;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO revenue_share_configs (id, version, author_share_bps, platform_share_bps, effective_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id("rsc"), version, author, platform, ts, ts);
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'revenue_share.create', 'config', ?, ?, ?)`
  ).run(id("aud"), admin.id, String(version), JSON.stringify({ author, platform }), ts);
  return c.json({ version, author_share_bps: author, platform_share_bps: platform });
});
