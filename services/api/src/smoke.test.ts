import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
process.env.DOWNLOAD_SIGNING_SECRET ??= randomBytes(32).toString("hex");
const { makeDownloadToken, verifyDownloadToken } = await import("./lib/crypto.js");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixtureRoot = join(root, "../../packages/export-schema/fixtures");
const fixtures = ["valid-basic.zip", "valid-design.zip", "valid-product.zip"].map((name) =>
  join(fixtureRoot, name)
);
const taskUpdateFixture = join(fixtureRoot, "valid-basic-update.zip");
const invalidFixture = join(fixtureRoot, "invalid-all-video.zip");
const seedAdminEmail = "smoke-admin@gallery.local";
const seedAdminPassword = randomBytes(24).toString("hex");
const seedUserEmail = "smoke-user@gallery.local";
const seedUserPassword = randomBytes(24).toString("hex");

type Client = { cookie: string };

async function waitHealth(port: number, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server startup is retried for a bounded interval.
    }
    await sleep(200);
  }
  throw new Error("api not healthy");
}

describe("M0-M4 acceptance smoke", () => {
  let child: ChildProcess | undefined;
  const port = 8799;
  const dbPath = join(root, "data/smoke.db");
  const blobRoot = join(root, "data/smoke-blobs");
  const uploadRoot = join(root, "data/smoke-uploads");
  const anonymous: Client = { cookie: "" };
  const admin: Client = { cookie: "" };
  const user: Client = { cookie: "" };
  const secondUser: Client = { cookie: "" };
  const listingIds: string[] = [];
  let firstShareSlug = "";

  before(async () => {
    for (const fixture of [...fixtures, taskUpdateFixture, invalidFixture]) {
      if (!existsSync(fixture)) throw new Error(`missing fixture ${fixture}; build fixtures first`);
    }
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(uploadRoot, { recursive: true, force: true });
    child = spawn(process.execPath, ["--import", "tsx", join(here, "index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: "./data/smoke.db",
        BLOB_ROOT: "./data/smoke-blobs",
        UPLOAD_ROOT: "./data/smoke-uploads",
        SESSION_SECRET: randomBytes(32).toString("hex"),
        DOWNLOAD_SIGNING_SECRET: randomBytes(32).toString("hex"),
        SEED_USERS: "true",
        SEED_TEST_USER: "true",
        SEED_ADMIN_EMAIL: seedAdminEmail,
        SEED_ADMIN_PASSWORD: seedAdminPassword,
        SEED_USER_EMAIL: seedUserEmail,
        SEED_USER_PASSWORD: seedUserPassword,
        CORS_ORIGIN: "http://127.0.0.1:5173",
        WEB_ORIGIN: "http://127.0.0.1:5173"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitHealth(port);
  });

  after(() => {
    child?.kill("SIGTERM");
  });

  async function api(client: Client, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (client.cookie) headers.set("cookie", client.cookie);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const match = cookie.match(/^rg_session=[^;]+/);
      if (match) client.cookie = match[0];
    }
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async function login(client: Client, email: string, password: string) {
    const result = await api(client, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
  }

  async function importFixture(path: string) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)]), path.split("/").at(-1));
    return api(admin, "/api/admin/import-jobs", { method: "POST", body: form });
  }

  it("serves health and rejects anonymous member/admin operations", async () => {
    const health = await api(anonymous, "/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal((await api(anonymous, "/api/me/likes")).response.status, 401);
    assert.equal((await api(anonymous, "/api/admin/listings")).response.status, 401);
  });

  it("enforces the registered-user 403 matrix", async () => {
    await login(user, seedUserEmail, seedUserPassword);
    const form = new FormData();
    form.append("file", new Blob([readFileSync(fixtures[0])]), "valid-basic.zip");
    assert.equal(
      (await api(user, "/api/admin/import-jobs", { method: "POST", body: form })).response.status,
      403
    );
    assert.equal(
      (await api(user, "/api/admin/listings/not-real/publish", { method: "POST" })).response.status,
      403
    );
  });

  it("imports and publishes three independent v1 packages", async () => {
    await login(admin, seedAdminEmail, seedAdminPassword);
    for (const fixture of fixtures) {
      const imported = await importFixture(fixture);
      assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
      assert.equal(imported.data.job.status, "succeeded", JSON.stringify(imported.data));
      const listingId = String(imported.data.job.listing_id);
      listingIds.push(listingId);
      if (fixture.endsWith("valid-basic.zip")) {
        const updated = await importFixture(taskUpdateFixture);
        assert.equal(updated.data.job.status, "succeeded", JSON.stringify(updated.data));
        assert.equal(updated.data.job.listing_id, listingId);
        const updatedListing = await api(admin, `/api/admin/listings/${listingId}`);
        assert.equal(updatedListing.data.listing.source_run_id, "run_fixture_001_update");
        assert.equal(updatedListing.data.listing.summary, "Agent 评测清单夹具（更新）");
      }
      if (fixture.endsWith("valid-product.zip")) {
        const adminListing = await api(admin, `/api/admin/listings/${listingId}`);
        assert.ok(
          adminListing.data.files.some((file: any) => file.kind === "video" && file.stripped === 1)
        );
      }
      const published = await api(admin, `/api/admin/listings/${listingId}/publish`, { method: "POST" });
      assert.equal(published.response.status, 200, JSON.stringify(published.data));
    }
    assert.equal(new Set(listingIds).size, 3);

    const duplicate = await importFixture(fixtures[0]);
    assert.equal(duplicate.data.job.status, "failed");
    const invalid = await importFixture(invalidFixture);
    assert.equal(invalid.data.job.status, "failed");
    assert.equal(existsSync(uploadRoot) ? (await import("node:fs")).readdirSync(uploadRoot).length : 0, 0);
  });

  it("supports search, topic filters and pagination", async () => {
    const search = await api(anonymous, "/api/listings?q=夹具&limit=2&page=1");
    assert.equal(search.response.status, 200);
    assert.equal(search.data.listings.length, 2);
    assert.equal(search.data.pagination.total, 3);
    assert.equal(search.data.pagination.pages, 2);
    const second = await api(anonymous, "/api/listings?q=夹具&limit=2&page=2");
    assert.equal(second.data.listings.length, 1);
    const topic = await api(anonymous, "/api/listings?topic=ai-eng");
    assert.ok(topic.data.listings.some((listing: any) => listingIds.includes(listing.id)));
    const mixedPublic = await api(anonymous, `/api/listings/${listingIds[2]}`);
    assert.equal(mixedPublic.data.files.some((file: any) => file.kind === "video"), false);
    const fallbackCover = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingIds[1]}/cover`
    );
    assert.equal(fallbackCover.status, 200);
    assert.equal(fallbackCover.headers.get("content-type"), "image/png");
    assert.ok((await fallbackCover.arrayBuffer()).byteLength > 100);
  });

  it("keeps likes idempotent and exposes day/week/all ranks", async () => {
    const liked = await api(user, `/api/me/likes/${listingIds[0]}`, { method: "POST" });
    assert.equal(liked.data.liked, true);
    for (const period of ["day", "week", "all"]) {
      const rank = await api(anonymous, `/api/rank?metric=likes&period=${period}`);
      const row = rank.data.items.find((item: any) => item.id === listingIds[0]);
      assert.equal(row.rank_count, 1);
    }
    const unliked = await api(user, `/api/me/likes/${listingIds[0]}`, { method: "POST" });
    assert.equal(unliked.data.liked, false);
    const detail = await api(anonymous, `/api/listings/${listingIds[0]}`);
    assert.equal(detail.data.listing.like_count, 0);
  });

  it("reconciles ledger, preserves share snapshots and prevents double charging", async () => {
    const beforeMe = await api(user, "/api/auth/me");
    const beforeBalance = beforeMe.data.account.balance;
    const first = await api(user, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" });
    assert.equal(first.response.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.price, 12);
    const again = await api(user, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" });
    assert.equal(again.data.alreadyOwned, true);
    const afterRepeat = await api(user, "/api/auth/me");
    assert.equal(afterRepeat.data.account.balance, beforeBalance - 12);

    const share = await api(admin, "/api/admin/revenue-share", {
      method: "POST",
      body: JSON.stringify({ author_share_bps: 6000, platform_share_bps: 4000 })
    });
    assert.equal(share.response.status, 200, JSON.stringify(share.data));
    const second = await api(user, `/api/me/listings/${listingIds[1]}/checkout`, { method: "POST" });
    assert.equal(second.response.status, 200, JSON.stringify(second.data));

    const orders = await api(admin, "/api/admin/orders");
    const firstOrder = orders.data.orders.find((order: any) => order.listing_id === listingIds[0]);
    const secondOrder = orders.data.orders.find((order: any) => order.listing_id === listingIds[1]);
    assert.equal(firstOrder.author_share_bps, 7000);
    assert.equal(secondOrder.author_share_bps, 6000);

    const author = await api(admin, "/api/auth/me");
    assert.equal(author.data.account.pending_earnings, 15);
    const ledger = await api(user, "/api/me/ledger");
    assert.equal(
      ledger.data.entries.reduce((sum: number, entry: any) => sum + entry.amount, 0),
      (await api(user, "/api/auth/me")).data.account.balance
    );
  });

  it("handles free downloads and concurrent checkout without duplicate orders", async () => {
    const freePatch = await api(admin, `/api/admin/listings/${listingIds[2]}`, {
      method: "PATCH",
      body: JSON.stringify({ price_tier: "free" })
    });
    assert.equal(freePatch.response.status, 200, JSON.stringify(freePatch.data));
    const balance = (await api(user, "/api/auth/me")).data.account.balance;
    const free = await api(user, `/api/me/listings/${listingIds[2]}/checkout`, { method: "POST" });
    assert.equal(free.data.free, true);
    assert.equal((await api(user, "/api/auth/me")).data.account.balance, balance);
    const freeToken = await api(user, `/api/me/listings/${listingIds[2]}/download-token`, { method: "POST" });
    assert.equal((await fetch(`http://127.0.0.1:${port}${freeToken.data.url}`)).status, 200);

    const registered = await api(secondUser, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com", password: "password123", display_name: "第二位用户" })
    });
    assert.equal(registered.response.status, 200, JSON.stringify(registered.data));
    await api(admin, "/api/admin/credits/grant", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com", amount: 50, note: "并发验收" })
    });
    assert.equal(
      (await api(secondUser, `/api/me/likes/${listingIds[0]}`, { method: "POST" })).data.liked,
      true
    );
    const results = await Promise.all([
      api(secondUser, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" }),
      api(secondUser, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" })
    ]);
    assert.ok(results.every((result) => result.response.status === 200));
    assert.equal(results.filter((result) => result.data.alreadyOwned === true).length, 1);
    assert.equal((await api(secondUser, "/api/auth/me")).data.account.balance, 38);
    const secondToken = await api(secondUser, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" });
    assert.equal((await fetch(`http://127.0.0.1:${port}${secondToken.data.url}`)).status, 200);

    for (const period of ["day", "week", "all"]) {
      const downloadRank = await api(anonymous, `/api/rank?metric=downloads&period=${period}`);
      assert.ok(downloadRank.data.items.some((item: any) => Number(item.rank_count) >= 1));
    }
  });

  it("serves signed downloads, expires tokens and preserves purchased access after takedown", async () => {
    const token = await api(user, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" });
    assert.equal(token.response.status, 200);
    const download = await fetch(`http://127.0.0.1:${port}${token.data.url}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    const bad = await fetch(`http://127.0.0.1:${port}/api/downloads/${listingIds[0]}?token=nope`);
    assert.equal(bad.status, 403);
    assert.equal(verifyDownloadToken(makeDownloadToken("listing", "user", -1)), null);

    const takenDown = await api(admin, `/api/admin/listings/${listingIds[0]}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "taken_down" })
    });
    assert.equal(takenDown.response.status, 200, JSON.stringify(takenDown.data));
    assert.equal((await api(anonymous, `/api/listings/${listingIds[0]}`)).response.status, 404);
    const ownedToken = await api(user, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" });
    assert.equal(ownedToken.response.status, 200, JSON.stringify(ownedToken.data));
    assert.equal((await fetch(`http://127.0.0.1:${port}${ownedToken.data.url}`)).status, 200);
    assert.equal(
      (await api(admin, `/api/admin/listings/${listingIds[0]}/publish`, { method: "POST" })).response.status,
      409
    );
  });

  it("renders OG share metadata without exposing a download", async () => {
    const shared = await api(user, `/api/me/listings/${listingIds[1]}/share`, { method: "POST" });
    assert.equal(shared.response.status, 200, JSON.stringify(shared.data));
    firstShareSlug = shared.data.slug;
    assert.equal(shared.data.public_path, `/s/${firstShareSlug}`);
    const page = await fetch(`http://127.0.0.1:${port}/s/${firstShareSlug}`);
    const body = await page.text();
    assert.equal(page.status, 200);
    assert.match(body, /property="og:title"/);
    assert.match(body, /property="og:image"/);
    const publicShare = await api(anonymous, `/api/share/${firstShareSlug}`);
    assert.equal(publicShare.response.status, 200);
    assert.equal("storage_path" in publicShare.data.share, false);
  });

  it("supports profile, reports, governance and auditable admin changes", async () => {
    const profile = await api(user, "/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ display_name: "青木更新" })
    });
    assert.equal(profile.data.user.display_name, "青木更新");
    const report = await api(user, `/api/me/listings/${listingIds[1]}/report`, {
      method: "POST",
      body: JSON.stringify({ reason: "copyright", detail: "授权范围待复核" })
    });
    assert.equal(report.response.status, 200, JSON.stringify(report.data));
    const reports = await api(admin, "/api/admin/reports?status=open");
    assert.ok(reports.data.reports.some((item: any) => item.id === report.data.id));
    const resolved = await api(admin, `/api/admin/reports/${report.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved", resolution: "已复核并下架", take_down: true })
    });
    assert.equal(resolved.response.status, 200, JSON.stringify(resolved.data));
    assert.equal((await api(anonymous, `/api/listings/${listingIds[1]}`)).response.status, 404);

    const users = await api(admin, "/api/admin/users");
    assert.ok(users.data.users.some((item: any) => item.email === "second@example.com"));
    const audits = await api(admin, "/api/admin/audit-logs");
    for (const action of ["import.succeeded", "listing.publish", "credits.grant", "revenue_share.create", "report.resolve"]) {
      assert.ok(audits.data.logs.some((item: any) => item.action === action), action);
    }
  });

  it("enforces download token rate limiting", async () => {
    const responses = [];
    for (let index = 0; index < 35; index++) {
      responses.push(
        await api(secondUser, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" })
      );
    }
    assert.ok(responses.some((result) => result.response.status === 429));
  });

  it("keeps database-level ledger and entitlement invariants", () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const mismatches = db
      .prepare(
        `SELECT a.user_id, a.balance, COALESCE(SUM(l.amount), 0) AS ledger_sum
         FROM credit_accounts a LEFT JOIN ledger_entries l ON l.user_id = a.user_id
         GROUP BY a.user_id HAVING a.balance != COALESCE(SUM(l.amount), 0)`
      )
      .all();
    assert.deepEqual(mismatches, []);
    const duplicates = db
      .prepare(
        `SELECT buyer_user_id, listing_id, COUNT(*) AS count FROM orders
         GROUP BY buyer_user_id, listing_id HAVING COUNT(*) > 1`
      )
      .all();
    assert.deepEqual(duplicates, []);
    db.close();
  });
});
