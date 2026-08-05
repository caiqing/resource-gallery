import { getDb, id, nowIso } from "./db/client.js";
import { hashPassword } from "./lib/crypto.js";
import { config } from "./config.js";
import { TOPIC_DEFINITIONS } from "./lib/topics.js";

function upsertUser(email: string, password: string, displayName: string, role: "user" | "admin") {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const userId = id("usr");
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, email, hashPassword(password), displayName, role, ts);
  db.prepare(
    `INSERT INTO credit_accounts (user_id, balance, pending_earnings, lifetime_spent, lifetime_earned)
     VALUES (?, ?, 0, 0, 0)`
  ).run(userId, role === "user" ? 50 : 0);
  if (role === "user") {
    db.prepare(
      `INSERT INTO ledger_entries (id, user_id, order_id, entry_type, amount, balance_after, note, created_at)
       VALUES (?, ?, NULL, 'opening_grant', 50, 50, '测试账户开户赠送', ?)`
    ).run(id("led"), userId, ts);
  }
  return userId;
}

export function seed() {
  const db = getDb();
  for (const topic of TOPIC_DEFINITIONS) {
    db.prepare(
      `INSERT INTO topics (id, name, description) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`
    ).run(topic.id, topic.name, topic.description);
  }

  for (const tier of [
    ["free", "免费", 0],
    ["standard", "标准", 12],
    ["premium", "精品", 18]
  ] as const) {
    db.prepare(
      `INSERT OR IGNORE INTO price_tiers (id, label, credits) VALUES (?, ?, ?)`
    ).run(tier[0], tier[1], tier[2]);
  }

  const share = db.prepare(`SELECT COUNT(*) AS c FROM revenue_share_configs`).get() as { c: number };
  if (share.c === 0) {
    db.prepare(
      `INSERT INTO revenue_share_configs (id, version, author_share_bps, platform_share_bps, effective_at, created_at)
       VALUES (?, 1, 7000, 3000, ?, ?)`
    ).run(id("rsc"), nowIso(), nowIso());
  }

  let adminId: string | null = null;
  let userId: string | null = null;
  if (config.seedUsers) {
    adminId = upsertUser(
      config.seedAdminEmail,
      config.seedAdminPassword,
      "Gallery 运营",
      "admin"
    );
  }
  if (config.seedTestUser) {
    userId = upsertUser(
      config.seedUserEmail,
      config.seedUserPassword,
      "青木",
      "user"
    );

    const account = db
      .prepare(`SELECT balance FROM credit_accounts WHERE user_id = ?`)
      .get(userId) as { balance: number };
    const ledger = db
      .prepare(`SELECT COUNT(*) AS count FROM ledger_entries WHERE user_id = ?`)
      .get(userId) as { count: number };
    if (ledger.count === 0 && account.balance !== 0) {
      db.prepare(
        `INSERT INTO ledger_entries (id, user_id, order_id, entry_type, amount, balance_after, note, created_at)
         VALUES (?, ?, NULL, 'opening_grant', ?, ?, '测试账户开户赠送', ?)`
      ).run(id("led"), userId, account.balance, account.balance, nowIso());
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        seedUsers: config.seedUsers,
        seedTestUser: config.seedTestUser,
        admin: config.seedUsers ? config.seedAdminEmail : null,
        user: config.seedTestUser ? config.seedUserEmail : null,
        adminId,
        userId
      },
      null,
      2
    )
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed.ts")) {
  seed();
}
