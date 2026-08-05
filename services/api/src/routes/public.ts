import { Hono } from "hono";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { TOPIC_DEFINITIONS } from "../lib/topics.js";

export const publicRoutes = new Hono();
export const sharePageRoutes = new Hono();

function mapListing(row: any, tags: string[]) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    cover_path: row.cover_path,
    author_user_id: row.author_user_id,
    author_name: row.author_name,
    price_tier: row.price_tier,
    price_credits: row.price_credits,
    status: row.status,
    like_count: row.like_count,
    download_count: row.download_count,
    published_at: row.published_at,
    tags
  };
}

publicRoutes.get("/topics", (c) => {
  const rows = getDb().prepare("SELECT id, name, description FROM topics").all() as {
    id: string;
    name: string;
    description: string;
  }[];
  const byId = new Map(rows.map((topic) => [topic.id, topic]));
  return c.json({
    topics: TOPIC_DEFINITIONS.map((definition) => byId.get(definition.id) ?? definition)
  });
});

publicRoutes.get("/listings", (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const topic = c.req.query("topic");
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(48, Math.max(1, Number.parseInt(c.req.query("limit") ?? "24", 10) || 24));
  const db = getDb();
  let where = ` WHERE l.status = 'published'`;
  const params: (string | number)[] = [];
  if (topic) {
    where += ` AND EXISTS (
      SELECT 1 FROM listing_tags t WHERE t.listing_id = l.id AND t.topic_id = ?
    )`;
    params.push(topic);
  }
  if (q) {
    where += ` AND (
      l.title LIKE ? OR l.summary LIKE ? OR EXISTS (
        SELECT 1 FROM listing_tags t WHERE t.listing_id = l.id AND t.tag LIKE ?
      )
    )`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM listings l${where}`).get(...params) as {
      count: number;
    }
  ).count;
  const sql = `
    SELECT l.*, u.display_name AS author_name
    FROM listings l
    JOIN users u ON u.id = l.author_user_id
    ${where}
    ORDER BY COALESCE(l.published_at, l.created_at) DESC
    LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, (page - 1) * limit) as any[];
  const tagStmt = db.prepare(`SELECT tag FROM listing_tags WHERE listing_id = ?`);
  const listings = rows.map((r) =>
    mapListing(
      r,
      (tagStmt.all(r.id) as { tag: string }[]).map((t) => t.tag)
    )
  );
  return c.json({
    listings,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  });
});

publicRoutes.get("/listings/:id", (c) => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT l.*, u.display_name AS author_name
       FROM listings l JOIN users u ON u.id = l.author_user_id
       WHERE l.id = ? AND l.status IN ('published', 'unlisted')`
    )
    .get(c.req.param("id")) as any;
  if (!row) return c.json({ error: "not found" }, 404);
  const tags = (
    db.prepare(`SELECT tag, topic_id FROM listing_tags WHERE listing_id = ?`).all(row.id) as any[]
  ).map((t) => t.tag);
  const files = row.active_version_id
    ? db.prepare(
        `SELECT id, kind, filename, size_bytes,
                CASE WHEN preview_policy = 'public' THEN 1 ELSE 0 END AS is_previewable,
                included, duration_ms, mime_type, parent_asset_id
         FROM listing_assets
         WHERE version_id = ? AND stripped = 0 AND kind != 'subtitle'
           AND (included = 1 OR preview_policy = 'public')`
      ).all(row.active_version_id)
    : db.prepare(
        `SELECT id, kind, filename, size_bytes, is_previewable, included
         FROM listing_files
         WHERE listing_id = ? AND stripped = 0 AND included = 1`
      ).all(row.id);
  return c.json({ listing: mapListing(row, tags), files });
});

publicRoutes.get("/rank", (c) => {
  const metric = c.req.query("metric") === "downloads" ? "downloads" : "likes";
  const requestedPeriod = c.req.query("period");
  const period = requestedPeriod === "day" || requestedPeriod === "week" ? requestedPeriod : "all";
  const since =
    period === "day"
      ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      : period === "week"
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        : null;
  const eventTable = metric === "downloads" ? "download_events" : "likes";
  const eventAlias = metric === "downloads" ? "d" : "k";
  const eventJoin = since
    ? `LEFT JOIN ${eventTable} ${eventAlias} ON ${eventAlias}.listing_id = l.id AND ${eventAlias}.created_at >= ?`
    : `LEFT JOIN ${eventTable} ${eventAlias} ON ${eventAlias}.listing_id = l.id`;
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.title, l.cover_path, l.like_count, l.download_count, l.price_credits,
              u.display_name AS author_name, COUNT(${eventAlias}.listing_id) AS rank_count
       FROM listings l
       JOIN users u ON u.id = l.author_user_id
       ${eventJoin}
       WHERE l.status = 'published'
       GROUP BY l.id
       ORDER BY rank_count DESC, l.published_at DESC
       LIMIT 50`
    )
    .all(...(since ? [since] : []));
  const tagStmt = getDb().prepare(`SELECT tag FROM listing_tags WHERE listing_id = ?`);
  const items = (rows as any[]).map((row) => ({
    ...row,
    tags: (tagStmt.all(row.id) as { tag: string }[]).map((tag) => tag.tag)
  }));
  c.header("cache-control", "public, max-age=30, stale-while-revalidate=60");
  return c.json({ items, metric, period });
});

function getShare(slug: string) {
  return getDb()
    .prepare(
      `SELECT s.slug, l.id, l.title, l.summary, l.cover_path, l.price_credits, l.status
       FROM share_links s JOIN listings l ON l.id = s.listing_id
       WHERE s.slug = ?`
    )
    .get(slug) as any;
}

publicRoutes.get("/share/:slug", (c) => {
  const link = getShare(c.req.param("slug"));
  if (!link || !["published", "unlisted"].includes(link.status)) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({
    share: {
      slug: link.slug,
      listing_id: link.id,
      title: link.title,
      summary: link.summary,
      cover_path: link.cover_path,
      price_credits: link.price_credits
    }
  });
});

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

sharePageRoutes.get("/:slug", (c) => {
  const slug = c.req.param("slug");
  const link = getShare(slug);
  if (!link || !["published", "unlisted"].includes(link.status)) {
    return c.html("<!doctype html><meta charset=\"utf-8\"><title>资源不存在</title><h1>资源不存在</h1>", 404);
  }
  const origin = new URL(c.req.url).origin;
  const cover = `${origin}/api/downloads/${encodeURIComponent(link.id)}/cover`;
  const detail = `${config.webOrigin.replace(/\/$/, "")}/#/share/${encodeURIComponent(slug)}`;
  return c.html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(link.title)} · Resource Gallery</title>
<meta name="description" content="${html(link.summary)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Resource Gallery">
<meta property="og:title" content="${html(link.title)}"><meta property="og:description" content="${html(link.summary)}">
<meta property="og:url" content="${html(`${origin}/s/${encodeURIComponent(slug)}`)}">
<meta property="og:image" content="${html(cover)}"><meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${html(detail)}"></head>
<body><main><h1>${html(link.title)}</h1><p>${html(link.summary)}</p><a href="${html(detail)}">在 Resource Gallery 查看</a></main></body></html>`);
});
